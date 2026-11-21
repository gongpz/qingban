/*
 * VideoEngine 1.1.0 —— 纯前端视频压缩 / 转码引擎（WebCodecs + mp4box.js + mp4-muxer + webm-muxer + HEVC 软解）
 *
 * 设计约束：
 *  - classic script，挂到 globalThis.VideoEngine；无 import/export/require/顶层 await；
 *  - 引擎自身代码 ES2017 以内；第三方库（UMD 包）原样内联在同一个 IIFE 作用域里，不污染全局；
 *  - 不访问网络、不使用 Node API；file:// 下可直接运行；
 *  - 视频统一走 VideoDecoder -> Canvas2D(旋转+缩放) -> VideoEncoder；
 *    HEVC 在原生解码不可用时自动回退到内置 wasm 软解（@hevcjs/core），仍走同一条 Canvas/编码链路；
 *  - 音频单独走 AudioDecoder -> 重采样/声道混合 -> AudioEncoder；
 *  - 全程逐帧处理，任何时刻都不整体缓存 VideoFrame。
 *
 * 第三方库：
 *  - mp4box.js 0.5.4（BSD-3-Clause，Copyright (c) 2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato）
 *  - mp4-muxer 5.2.1（MIT，Copyright (c) 2023 Vanilagy）
 *  - webm-muxer 5.1.4（MIT，Copyright (c) 2022 Vanilagy）
 *  - @hevcjs/core 1.9.1 的 hevc-decode.wasm + Emscripten glue（MIT，Copyright (c) LID）
 *    wasm 以 base64 内联，运行时用 instantiateWasm 直接编译，不发起任何网络/文件请求。
 */
(function (global) {
  'use strict';

/*__LIBRARIES__*/

/*__HEVC_GLUE__*/

/*__HEVC_WASM__*/

  var VERSION = '1.1.0';
  var MICRO = 1000000;

  /* =====================================================================
   * 0. 基础工具
   * ===================================================================== */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function even(v) { var n = Math.round(v / 2) * 2; return n < 2 ? 2 : n; }
  function hex2(v) {
    var s = (v & 255).toString(16);
    return s.length < 2 ? '0' + s : s;
  }
  function now() { return Date.now(); }
  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function err(message) {
    var e = new Error(message);
    return e;
  }

  function cancelError() {
    var e = new Error('已取消');
    e.name = 'AbortError';
    e.code = 'CANCELLED';
    return e;
  }

  function checkCancel(hooks) {
    if (hooks && typeof hooks.isCancelled === 'function') {
      var c = false;
      try { c = !!hooks.isCancelled(); } catch (e) { c = false; }
      if (c) throw cancelError();
    }
  }

  function log(hooks, msg) {
    if (!hooks || typeof hooks.onLog !== 'function') return;
    try { hooks.onLog(msg); } catch (e) { /* 忽略回调异常 */ }
  }

  /* 单调递增、限流的进度上报 */
  function makeProgress(hooks) {
    var last = -1;
    var lastAt = 0;
    return function (p, force) {
      if (!hooks || typeof hooks.onProgress !== 'function') return;
      p = clamp(p, 0, 1);
      if (p < last) p = last;
      var t = now();
      if (!force && p < 1 && t - lastAt < 60) return;
      lastAt = t;
      last = p;
      try { hooks.onProgress(p); } catch (e) { /* 忽略 */ }
    };
  }

  function closeQuietly(obj) {
    if (!obj) return;
    try { if (obj.state !== 'closed') obj.close(); } catch (e) { /* 忽略 */ }
  }

  /* 一对多唤醒器：等待事件（解码输出 / 状态变化） */
  function Signal() { this.waiters = []; }
  Signal.prototype.wait = function () {
    var self = this;
    return new Promise(function (resolve) { self.waiters.push(resolve); });
  };
  Signal.prototype.notify = function () {
    var list = this.waiters;
    this.waiters = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* 忽略 */ }
    }
  };

  function bytesToSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* 输入统一转 Uint8Array（File/Blob/ArrayBuffer/TypedArray 均可） */
  async function toBytes(input) {
    if (!input) throw err('没有输入文件');
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      var ab = await input.arrayBuffer();
      return new Uint8Array(ab);
    }
    throw err('不支持的输入类型（需要 File / Blob / ArrayBuffer / Uint8Array）');
  }

  /* =====================================================================
   * 1. 容器识别
   * ===================================================================== */

  function fourcc(b, off) {
    return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  }

  function detectContainer(b) {
    if (!b || b.length < 8) return 'unknown';
    // EBML (WebM / MKV)
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
      var dt = ebmlDocType(b);
      if (dt && dt.indexOf('webm') >= 0) return 'webm';
      return 'mkv';
    }
    // ISO BMFF
    var brand = '';
    if (b.length >= 12 && fourcc(b, 4) === 'ftyp') brand = fourcc(b, 8);
    if (brand === 'qt  ') return 'mov';
    if (brand) return 'mp4';
    // 有些 MOV 没有 ftyp，直接以 moov/mdat 开头
    if (b.length >= 8 && (fourcc(b, 4) === 'moov' || fourcc(b, 4) === 'mdat' || fourcc(b, 4) === 'wide')) return 'mov';
    return 'unknown';
  }

  /* 只读 EBML 头里的 DocType 字符串 */
  function ebmlDocType(b) {
    try {
      var id = ebmlId(b, 0);
      if (!id) return '';
      var sz = ebmlVint(b, id.length, false);
      if (!sz) return '';
      var end = Math.min(b.length, id.length + sz.length + sz.value);
      var p = id.length + sz.length;
      while (p < end) {
        var eid = ebmlId(b, p);
        if (!eid) break;
        var esz = ebmlVint(b, p + eid.length, false);
        if (!esz) break;
        var bs = p + eid.length + esz.length;
        var be = Math.min(end, bs + esz.value);
        if (eid.id === 0x4282) return utf8(b, bs, be);
        p = be;
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /* =====================================================================
   * 2. EBML / WebM / MKV 解封装（自实现）
   * ===================================================================== */

  var ID = {
    EBML: 0x1A45DFA3, DOCTYPE: 0x4282,
    SEGMENT: 0x18538067,
    INFO: 0x1549A966, TIMECODESCALE: 0x2AD7B1, DURATION: 0x4489,
    TRACKS: 0x1654AE6B, TRACKENTRY: 0xAE,
    TRACKNUMBER: 0xD7, TRACKUID: 0x73C5, TRACKTYPE: 0x83, CODECID: 0x86,
    CODECPRIVATE: 0x63A2, DEFAULTDURATION: 0x23E383, CODECDELAY: 0x56AA, SEEKPREROLL: 0x56BB,
    VIDEO: 0xE0, PIXELWIDTH: 0xB0, PIXELHEIGHT: 0xBA,
    DISPLAYWIDTH: 0x54B0, DISPLAYHEIGHT: 0x54BA, DISPLAYUNIT: 0x54B2,
    AUDIO: 0xE1, SAMPLINGFREQ: 0xB5, CHANNELS: 0x9F, BITDEPTH: 0x6264,
    CLUSTER: 0x1F43B675, TIMECODE: 0xE7, SIMPLEBLOCK: 0xA3,
    BLOCKGROUP: 0xA0, BLOCK: 0xA1, BLOCKDURATION: 0x9B, REFERENCEBLOCK: 0xFB,
    CUES: 0x1C53BB6B, TAGS: 0x1254C367, ATTACHMENTS: 0x1941A469, CHAPTERS: 0x1043A770,
    PROJECTION: 0x7670, POSE_ROLL: 0x7675,
    CONTENTENCODINGS: 0x6D80
  };

  function isTopLevelId(id) {
    return id === ID.SEGMENT || id === ID.CLUSTER || id === ID.CUES || id === ID.TAGS ||
      id === ID.ATTACHMENTS || id === ID.CHAPTERS || id === 0x1C53BB6B;
  }

  function ebmlId(b, off) {
    if (off + 1 > b.length) return null;
    var first = b[off];
    var len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 4 || off + len > b.length) return null;
    var v = first;
    for (var i = 1; i < len; i++) v = v * 256 + b[off + i];
    return { id: v, length: len };
  }

  /* size vint；keepMarker=true 时保留 marker 位（用于 Block 里的 track number） */
  function ebmlVint(b, off, keepMarker) {
    if (off + 1 > b.length) return null;
    var first = b[off];
    var len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || off + len > b.length) return null;
    var unknown = (first & (mask - 1)) === (mask - 1);
    var v = keepMarker ? first : (first & (mask - 1));
    for (var i = 1; i < len; i++) {
      v = v * 256 + b[off + i];
      if (b[off + i] !== 0xFF) unknown = false;
    }
    return { value: v, length: len, unknown: unknown };
  }

  function readUint(b, start, end) {
    var v = 0;
    for (var i = start; i < end && i < b.length; i++) {
      v = v * 256 + b[i];
      if (v > 9007199254740991) return v;
    }
    return v;
  }

  function readFloat(b, start, end) {
    var dv = new DataView(b.buffer, b.byteOffset + start, end - start);
    if (end - start === 4) return dv.getFloat32(0, false);
    if (end - start === 8) return dv.getFloat64(0, false);
    return 0;
  }

  function utf8(b, start, end) {
    start = Math.max(0, start); end = Math.min(b.length, end);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(b.subarray(start, end)); } catch (e) { /* 忽略 */ }
    }
    var s = '';
    for (var i = start; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  /* 遍历 EBML 子元素 */
  function eachEbmlChild(b, start, end, cb) {
    var p = start;
    var guard = 0;
    while (p < end && guard++ < 2000000) {
      var id = ebmlId(b, p);
      if (!id) break;
      var sz = ebmlVint(b, p + id.length, false);
      if (!sz) break;
      var bs = p + id.length + sz.length;
      if (bs > end) break;
      var be = sz.unknown ? end : Math.min(end, bs + sz.value);
      var stop = cb(id.id, bs, be);
      if (stop === false) break;
      if (be <= p) break;
      p = be;
    }
    return p;
  }

  /* 扫描 WebM/MKV，收集元数据与（可选）压缩样本 */
  function readWebM(b, needSamples, containerHint) {
    var meta = {
      container: containerHint === 'mkv' ? 'mkv' : 'webm',
      duration: 0, rotation: 0, fps: 0,
      codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0,
      width: 0, height: 0,
      videoCodec: '', videoDescription: null, videoTrackNumber: 0,
      videoHevc: null,
      audioCodec: '', audioDescription: null, audioTrackNumber: 0,
      audioSampleRate: 48000, audioChannels: 2,
      videoBitrateKbps: 0, audioBitrateKbps: 0, size: b.length,
      videoSamples: null, audioSamples: null,
      videoStartTs: 0, audioStartTs: 0,
      hasVideo: false, hasAudio: false
    };
    var timecodeScale = 1000000;
    var rawDuration = 0;
    var tracks = {};
    var trackStats = {};   // trackNumber -> {frames, count, bytes, firstTs, lastTs}
    var docType = '';

    function stat(num, frame, bytes) {
      var st = trackStats[num];
      if (!st) {
        st = trackStats[num] = { frames: [], count: 0, bytes: 0, firstTs: Infinity, lastTs: -1 };
      }
      st.count++;
      st.bytes += bytes;
      if (frame.ts < st.firstTs) st.firstTs = frame.ts;
      var endTs = frame.ts + (frame.dur || 0);
      if (endTs > st.lastTs) st.lastTs = endTs;
      if (needSamples) st.frames.push(frame);
    }

    function parseInfo(start, end) {
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TIMECODESCALE) timecodeScale = readUint(b, bs, be) || 1000000;
        else if (id === ID.DURATION) rawDuration = readFloat(b, bs, be);
      });
    }

    function parseTrackEntry(start, end) {
      var t = {
        number: 0, type: 0, codecId: '', codecPrivate: null,
        defaultDuration: 0, width: 0, height: 0,
        displayWidth: 0, displayHeight: 0, displayUnit: 0,
        sampleRate: 0, channels: 0, bitDepth: 0, roll: null
      };
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TRACKNUMBER) t.number = readUint(b, bs, be);
        else if (id === ID.TRACKTYPE) t.type = readUint(b, bs, be);
        else if (id === ID.CODECID) t.codecId = utf8(b, bs, be);
        else if (id === ID.CODECPRIVATE) t.codecPrivate = b.subarray(bs, be);
        else if (id === ID.DEFAULTDURATION) t.defaultDuration = readUint(b, bs, be);
        else if (id === ID.VIDEO) {
          eachEbmlChild(b, bs, be, function (vid, vbs, vbe) {
            if (vid === ID.PIXELWIDTH) t.width = readUint(b, vbs, vbe);
            else if (vid === ID.PIXELHEIGHT) t.height = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYWIDTH) t.displayWidth = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYHEIGHT) t.displayHeight = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYUNIT) t.displayUnit = readUint(b, vbs, vbe);
            else if (vid === ID.PROJECTION) {
              eachEbmlChild(b, vbs, vbe, function (pid, pbs, pbe) {
                if (pid === ID.POSE_ROLL) t.roll = readFloat(b, pbs, pbe);
              });
            }
          });
        } else if (id === ID.AUDIO) {
          eachEbmlChild(b, bs, be, function (aid, abs, abe) {
            if (aid === ID.SAMPLINGFREQ) t.sampleRate = readFloat(b, abs, abe);
            else if (aid === ID.CHANNELS) t.channels = readUint(b, abs, abe);
            else if (aid === ID.BITDEPTH) t.bitDepth = readUint(b, abs, abe);
          });
        }
      });
      if (t.number) tracks[t.number] = t;
    }

    function parseTracks(start, end) {
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TRACKENTRY) parseTrackEntry(bs, be);
      });
    }

    function pushFrame(trackNum, frame, bytes) {
      if (!trackNum) return;
      stat(trackNum, frame, bytes);
    }

    /* Block / SimpleBlock */
    function parseBlock(start, end, clusterTime, isKey, durOverrideUs) {
      var tn = ebmlVint(b, start, false);
      if (!tn) return;
      var p = start + tn.length;
      if (p + 3 > end) return;
      var rel = (b[p] << 8) | b[p + 1];
      if (rel & 0x8000) rel -= 0x10000;
      var flags = b[p + 2];
      p += 3;
      if (isKey === undefined) isKey = !!(flags & 0x80);
      var lacing = (flags & 0x06) >> 1;
      var pieces = [];
      var i, n, sizes, rest, sum, off, each;

      if (lacing === 0) {
        pieces.push({ off: p, len: end - p });
      } else if (lacing === 1) {           // Xiph lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        sizes = [];
        for (i = 0; i < n - 1; i++) {
          var s = 0, byte = 0, guard = 0;
          do {
            if (p >= end || guard++ > 100000) return;
            byte = b[p++]; s += byte;
          } while (byte === 255);
          sizes.push(s);
        }
        rest = end - p; sum = 0;
        for (i = 0; i < sizes.length; i++) sum += sizes[i];
        sizes.push(rest - sum);
        off = p;
        for (i = 0; i < n; i++) { pieces.push({ off: off, len: sizes[i] }); off += sizes[i]; }
      } else if (lacing === 2) {           // 固定 lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        each = Math.floor((end - p) / n);
        for (i = 0; i < n; i++) pieces.push({ off: p + i * each, len: each });
      } else {                              // EBML lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        var first = ebmlVint(b, p, false);
        if (!first) return;
        p += first.length;
        sizes = [first.value];
        for (i = 1; i < n - 1; i++) {
          var d = ebmlVint(b, p, false);
          if (!d) return;
          p += d.length;
          var bits = 7 * d.length;
          sizes.push(sizes[i - 1] + (d.value - (Math.pow(2, bits) - 1)));
        }
        rest = end - p; sum = 0;
        for (i = 0; i < sizes.length; i++) sum += sizes[i];
        sizes.push(Math.max(0, rest - sum));
        off = p;
        for (i = 0; i < n; i++) { pieces.push({ off: off, len: sizes[i] }); off += sizes[i]; }
      }

      var track = tracks[tn.value];
      var defDurUs = (track && track.defaultDuration ? track.defaultDuration / 1000 : 0);
      var durUs = durOverrideUs > 0 ? durOverrideUs : (defDurUs > 0 ? defDurUs : (track && track.type === 2 ? 20000 : 0));
      var baseTs = Math.round((clusterTime + rel) * timecodeScale / 1000);

      for (i = 0; i < pieces.length; i++) {
        var pc = pieces[i];
        if (pc.len <= 0 || pc.off < 0 || pc.off + pc.len > b.length) continue;
        pushFrame(tn.value, {
          ts: baseTs + Math.round(i * durUs),
          dur: durUs,
          key: isKey,
          data: needSamples ? b.subarray(pc.off, pc.off + pc.len) : null
        }, pc.len);
      }
    }

    function parseBlockGroup(start, end, clusterTime) {
      var blockRange = null;
      var blockDuration = 0;
      var hasReference = false;
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.BLOCK) blockRange = [bs, be];
        else if (id === ID.BLOCKDURATION) blockDuration = readUint(b, bs, be);
        else if (id === ID.REFERENCEBLOCK) hasReference = true;
      });
      if (!blockRange) return;
      var durUs = blockDuration > 0 ? Math.round(blockDuration * timecodeScale / 1000) : 0;
      parseBlock(blockRange[0], blockRange[1], clusterTime, !hasReference, durUs);
    }

    function parseCluster(start, end, unknownSize) {
      var pos = start;
      var clusterTime = 0;
      var guard = 0;
      while (pos < end && guard++ < 4000000) {
        var id = ebmlId(b, pos);
        if (!id) break;
        if (unknownSize && isTopLevelId(id.id)) return pos;
        var sz = ebmlVint(b, pos + id.length, false);
        if (!sz) break;
        var bs = pos + id.length + sz.length;
        if (bs > end) break;
        var be = sz.unknown ? end : Math.min(end, bs + sz.value);
        if (id.id === ID.TIMECODE) clusterTime = readUint(b, bs, be);
        else if (id.id === ID.SIMPLEBLOCK) parseBlock(bs, be, clusterTime, undefined, 0);
        else if (id.id === ID.BLOCKGROUP) parseBlockGroup(bs, be, clusterTime);
        if (be <= pos) break;
        pos = be;
      }
      return pos;
    }

    /* ---- EBML 头 ---- */
    var head = ebmlId(b, 0);
    if (!head || head.id !== ID.EBML) throw err('不是有效的 WebM/Matroska 文件');
    var hSize = ebmlVint(b, head.length, false);
    if (!hSize) throw err('WebM 头部损坏');
    var hEnd = Math.min(b.length, head.length + hSize.length + hSize.value);
    eachEbmlChild(b, head.length + hSize.length, hEnd, function (id, bs, be) {
      if (id === ID.DOCTYPE) docType = utf8(b, bs, be);
    });
    if (docType && docType.indexOf('webm') < 0) meta.container = 'mkv';

    /* ---- Segment ---- */
    var segStart = -1, segEnd = -1;
    var p = hEnd;
    while (p + 4 < b.length) {
      var id2 = ebmlId(b, p);
      if (!id2) break;
      var sz2 = ebmlVint(b, p + id2.length, false);
      if (!sz2) break;
      var bs2 = p + id2.length + sz2.length;
      if (id2.id === ID.SEGMENT) {
        segStart = bs2;
        segEnd = sz2.unknown ? b.length : Math.min(b.length, bs2 + sz2.value);
        break;
      }
      if (sz2.unknown) break;
      p = bs2 + sz2.value;
    }
    if (segStart < 0) throw err('WebM 文件中未找到 Segment');
    if (segEnd < segStart) segEnd = b.length;

    var sp = segStart, guard1 = 0;
    while (sp < segEnd && guard1++ < 1000000) {
      var sid = ebmlId(b, sp);
      if (!sid) break;
      var ssz = ebmlVint(b, sp + sid.length, false);
      if (!ssz) break;
      var sbs = sp + sid.length + ssz.length;
      if (sbs > segEnd) break;
      var sbe = ssz.unknown ? segEnd : Math.min(segEnd, sbs + ssz.value);
      if (sid.id === ID.INFO) {
        parseInfo(sbs, sbe);
      } else if (sid.id === ID.TRACKS) {
        parseTracks(sbs, sbe);
      } else if (sid.id === ID.CLUSTER) {
        sbe = parseCluster(sbs, ssz.unknown ? segEnd : sbe, !!ssz.unknown);
      }
      if (sbe <= sp) break;
      sp = sbe;
    }

    /* ---- 组装元数据 ---- */
    var trackNumbers = Object.keys(tracks);
    var vTrack = null, aTrack = null;
    for (var ti = 0; ti < trackNumbers.length; ti++) {
      var tr = tracks[trackNumbers[ti]];
      if (tr.type === 1 && !vTrack) vTrack = tr;
      else if (tr.type === 2 && !aTrack) aTrack = tr;
    }

    var totalDurationSec = rawDuration > 0 ? rawDuration * timecodeScale / 1e9 : 0;

    if (vTrack) {
      var vst = trackStats[vTrack.number];
      meta.hasVideo = true;
      meta.videoTrackNumber = vTrack.number;
      meta.codedWidth = vTrack.width;
      meta.codedHeight = vTrack.height;
      var dw0 = (vTrack.displayWidth > 0 && vTrack.displayUnit === 0) ? vTrack.displayWidth : vTrack.width;
      var dh0 = (vTrack.displayHeight > 0 && vTrack.displayUnit === 0) ? vTrack.displayHeight : vTrack.height;
      meta.displayWidth = dw0;
      meta.displayHeight = dh0;
      var roll = vTrack.roll;
      if (isNum(roll)) {
        var rr = ((Math.round(roll / 90) * 90) % 360 + 360) % 360;
        if (rr === 90 || rr === 180 || rr === 270) meta.rotation = rr;
      }
      var codecInfo = webmVideoCodec(vTrack);
      meta.videoCodec = codecInfo.codec;
      meta.videoDescription = codecInfo.description;
      meta.videoHevc = codecInfo.hevc || null;
      meta.fps = webmFps(vTrack, vst, totalDurationSec);

      if (vst && vst.count > 0) {
        meta.videoStartTs = isFinite(vst.firstTs) ? vst.firstTs : 0;
        var defDur = vTrack.defaultDuration ? vTrack.defaultDuration / 1000 : (meta.fps > 0 ? Math.round(1e6 / meta.fps) : 33333);
        var vframes = vst.frames;
        var vLastEnd = vst.lastTs;
        if (needSamples) {
          // 视频块没有 duration：用相邻时间戳差补全，保持 VFR 节奏
          for (var vi = 0; vi < vframes.length; vi++) {
            var cur = vframes[vi];
            if (!cur.dur) {
              if (vi + 1 < vframes.length) cur.dur = Math.max(1000, vframes[vi + 1].ts - cur.ts);
              else cur.dur = Math.max(1000, defDur);
            }
            if (cur.ts + cur.dur > vLastEnd) vLastEnd = cur.ts + cur.dur;
          }
          if (vLastEnd > meta.duration) meta.duration = vLastEnd;
          meta.videoSamples = vframes;
        } else {
          if (vLastEnd + defDur > meta.duration) meta.duration = vLastEnd + defDur;
        }
        if (meta.fps <= 0 && vst.count > 1) {
          var span = (vst.lastTs - vst.firstTs) / 1e6;
          meta.fps = span > 0 ? (vst.count - 1) / span : 30;
        }
        var vEndSec = Math.max(meta.duration, vLastEnd) / 1e6;
        meta.videoBitrateKbps = vEndSec > 0 ? Math.round(vst.bytes * 8 / vEndSec / 1000) : 0;
      }
    }

    if (aTrack) {
      var ast = trackStats[aTrack.number];
      meta.hasAudio = true;
      meta.audioTrackNumber = aTrack.number;
      meta.audioSampleRate = aTrack.sampleRate > 0 ? Math.round(aTrack.sampleRate) : 48000;
      meta.audioChannels = aTrack.channels > 0 ? aTrack.channels : 2;
      var aInfo = webmAudioCodec(aTrack);
      meta.audioCodec = aInfo.codec;
      meta.audioDescription = aInfo.description;
      if (ast && ast.count > 0) {
        meta.audioStartTs = isFinite(ast.firstTs) ? ast.firstTs : 0;
        var aframes = ast.frames;
        var aDefDur = aTrack.defaultDuration ? aTrack.defaultDuration / 1000 : 20000;
        var aLastEnd = ast.lastTs;
        if (needSamples) {
          for (var ai = 0; ai < aframes.length; ai++) {
            if (!aframes[ai].dur) aframes[ai].dur = aDefDur;
            if (aframes[ai].ts + aframes[ai].dur > aLastEnd) aLastEnd = aframes[ai].ts + aframes[ai].dur;
          }
          meta.audioSamples = aframes;
        }
        if (aLastEnd > meta.duration) meta.duration = aLastEnd;
        var aEndSec = aLastEnd / 1e6;
        meta.audioBitrateKbps = aEndSec > 0 ? Math.round(ast.bytes * 8 / aEndSec / 1000) : 0;
      }
    }

    if (totalDurationSec > 0) meta.duration = Math.max(meta.duration, totalDurationSec * 1e6);
    meta.duration = Math.round(meta.duration) / 1e6;
    meta.fps = meta.fps > 0 ? Math.round(meta.fps * 1000) / 1000 : 30;
    meta.width = meta.rotation % 180 ? meta.displayHeight : meta.displayWidth;
    meta.height = meta.rotation % 180 ? meta.displayWidth : meta.displayHeight;
    return meta;
  }

  function webmVideoCodec(t) {
    var cid = (t.codecId || '').toUpperCase();
    var desc = t.codecPrivate || null;
    if (cid === 'V_VP8') return { codec: 'vp8', description: null };
    if (cid === 'V_VP9') return { codec: vp9CodecFromVpcC(desc), description: null };
    if (cid === 'V_AV1') return { codec: av1CodecFromAv1C(desc), description: desc };
    if (cid === 'V_MPEG4/ISO/AVC') return { codec: 'avc1.42E01E', description: desc };
    if (cid === 'V_MPEGH/ISO/HEVC') return { codec: 'hvc1.1.6.L93.B0', description: desc, hevc: parseHvcC(desc) };
    return { codec: cid ? cid.toLowerCase() : '', description: desc };
  }

  function webmAudioCodec(t) {
    var cid = (t.codecId || '').toUpperCase();
    var desc = t.codecPrivate || null;
    if (cid === 'A_OPUS') return { codec: 'opus', description: desc || opusHead(t.channels || 2, 312, 48000) };
    if (cid === 'A_VORBIS') return { codec: 'vorbis', description: desc };
    if (cid === 'A_AAC') return { codec: 'mp4a.40.2', description: desc };
    if (cid === 'A_MPEG/L3') return { codec: 'mp3', description: null };
    if (cid === 'A_FLAC') return { codec: 'flac', description: desc };
    if (cid === 'A_PCM/INT/LIT') return { codec: 'pcm-s16', description: null };
    return { codec: '', description: desc };
  }

  function webmFps(track, st, totalSec) {
    if (track.defaultDuration > 0) return Math.round((1e9 / track.defaultDuration) * 1000) / 1000;
    if (st && st.count > 1) {
      var span = (st.lastTs - st.firstTs) / 1e6;
      if (span > 0) return Math.round(((st.count - 1) / span) * 1000) / 1000;
    }
    if (totalSec > 0 && st) return Math.round(st.count / totalSec * 1000) / 1000;
    return 30;
  }

  /* vpcC（WebM CodecPrivate = vpcC 负载）：version(1) flags(1) profile(1) level(1) bitDepth(4bit) chroma... */
  function vp9CodecFromVpcC(desc) {
    try {
      if (!desc || desc.length < 6) return 'vp09.00.10.08';
      var profile = desc[2], level = desc[3], bitDepth = desc[4] >> 4;
      if (bitDepth !== 8 && bitDepth !== 10 && bitDepth !== 12) bitDepth = 8;
      var p = profile < 10 ? '0' + profile : '' + profile;
      var l = level < 10 ? '0' + level : '' + level;
      var bd = bitDepth < 10 ? '0' + bitDepth : '' + bitDepth;
      return 'vp09.' + p + '.' + l + '.' + bd;
    } catch (e) { return 'vp09.00.10.08'; }
  }

  /* av1C（WebM CodecPrivate = av1C 负载）：marker/version(2) seq_profile(3)+level(5) tier(1) high_bitdepth(1)... */
  function av1CodecFromAv1C(desc) {
    try {
      if (!desc || desc.length < 4) return 'av01.0.04M.08';
      var b1 = desc[1], b2 = desc[2];
      var profile = b1 >> 5;
      var level = b1 & 0x1F;
      var tier = (b2 >> 7) & 1 ? 'H' : 'M';
      var highBit = (b2 >> 6) & 1, twelve = (b2 >> 5) & 1;
      var depth = highBit ? (twelve ? 12 : 10) : 8;
      var lv = level < 10 ? '0' + level : '' + level;
      var dd = depth < 10 ? '0' + depth : '' + depth;
      return 'av01.' + profile + '.' + lv + tier + '.' + dd;
    } catch (e) { return 'av01.0.04M.08'; }
  }

  /* =====================================================================
   * 3. MP4 / MOV / M4V 解封装（mp4box.js）
   * ===================================================================== */

  function readMp4(b, needSamples, containerHint) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function fail(e) {
        if (settled) return;
        settled = true;
        reject(e);
      }
      if (typeof MP4Box === 'undefined' || !MP4Box.createFile) {
        fail(err('mp4box 库未加载'));
        return;
      }
      try {
        if (typeof Log !== 'undefined' && Log.setLogLevel && Log.error) Log.setLogLevel(Log.error);
      } catch (e) { /* 忽略 */ }

      var mp4;
      try { mp4 = MP4Box.createFile(); } catch (e) { fail(err('mp4box 初始化失败：' + e.message)); return; }

      var videoSamples = [];
      var audioSamples = [];
      var meta = null;

      mp4.onError = function (e) { fail(err('MP4 解析失败：' + String(e))); };

      mp4.onReady = function (info) {
        try {
          meta = buildMp4Meta(mp4, info, containerHint);
          if (!needSamples) {
            settled = true;
            resolve(meta);
            return;
          }
          mp4.setExtractionOptions(meta.videoTrackId, 'v', { nbSamples: 64 });
          if (meta.audioTrackId) mp4.setExtractionOptions(meta.audioTrackId, 'a', { nbSamples: 64 });
          mp4.start();
        } catch (e) { fail(e); }
      };

      mp4.onSamples = function (id, user, samples) {
        try {
          var arr = user === 'v' ? videoSamples : audioSamples;
          var scale = user === 'v' ? meta.videoTimescale : meta.audioTimescale;
          for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            if (!s.data || !s.data.byteLength) continue;
            arr.push({
              ts: Math.round(s.cts * MICRO / (s.timescale || scale || 1000)),
              dur: Math.round((s.duration || 0) * MICRO / (s.timescale || scale || 1000)),
              key: !!s.is_sync,
              data: s.data
            });
          }
        } catch (e) { fail(e); }
      };

      try {
        var ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        ab.fileStart = 0;
        mp4.appendBuffer(ab);
        mp4.flush();
      } catch (e) {
        fail(err('MP4 解封装失败：' + (e && e.message ? e.message : e)));
        return;
      }

      if (settled) return;
      if (!meta) { fail(err('MP4 文件中未找到可用的视频轨道')); return; }
      if (!needSamples) { settled = true; resolve(meta); return; }

      var vStart = Infinity, aStart = Infinity;
      for (var vi = 0; vi < videoSamples.length; vi++) if (videoSamples[vi].ts < vStart) vStart = videoSamples[vi].ts;
      for (var ai = 0; ai < audioSamples.length; ai++) if (audioSamples[ai].ts < aStart) aStart = audioSamples[ai].ts;
      meta.videoStartTs = isFinite(vStart) ? vStart : 0;
      meta.audioStartTs = isFinite(aStart) ? aStart : 0;
      meta.videoSamples = videoSamples;
      meta.audioSamples = audioSamples;
      if (!videoSamples.length) { fail(err('MP4 视频轨道没有可解码的样本')); return; }
      settled = true;
      resolve(meta);
    });
  }

  function buildMp4Meta(mp4, info, containerHint) {
    var vT = info.videoTracks && info.videoTracks[0];
    if (!vT) throw err('文件中没有视频轨道');
    var aT = (info.audioTracks && info.audioTracks.length) ? info.audioTracks[0] : null;
    var trak = mp4.getTrackById(vT.id);
    if (!trak) throw err('无法读取视频轨道');
    var entry = trak.mdia.minf.stbl.stsd.entries[0];

    var codedW = vT.video && vT.video.width ? vT.video.width : (entry.width || 0);
    var codedH = vT.video && vT.video.height ? vT.video.height : (entry.height || 0);
    var dispW = vT.track_width > 0 ? vT.track_width : codedW;
    var dispH = vT.track_height > 0 ? vT.track_height : codedH;
    var rotation = rotationFromMatrix(vT.matrix);
    var fps = fpsFromStts(trak, vT);
    var durationSec = info.duration > 0 ? info.duration / 1000 : 0;
    if (!(durationSec > 0)) {
      var md = vT.movie_duration, mts = vT.movie_timescale;
      if (md > 0 && mts > 0) durationSec = md / mts;
    }
    var vInfo = mp4VideoCodec(entry, vT.codec);
    var meta = {
      container: containerHint === 'mov' ? 'mov' : 'mp4',
      duration: durationSec,
      rotation: rotation,
      fps: fps,
      codedWidth: codedW,
      codedHeight: codedH,
      displayWidth: dispW,
      displayHeight: dispH,
      width: rotation % 180 ? dispH : dispW,
      height: rotation % 180 ? dispW : dispH,
      videoCodec: vInfo.codec,
      videoDescription: vInfo.description,
      videoHevc: vInfo.hevc || null,
      videoTrackId: vT.id,
      videoTimescale: vT.timescale,
      videoBitrateKbps: vT.bitrate > 0 ? Math.round(vT.bitrate / 1000) : 0,
      audioCodec: '', audioDescription: null, audioTrackId: 0, audioTimescale: 0,
      audioSampleRate: 0, audioChannels: 0, audioBitrateKbps: 0,
      hasVideo: true, hasAudio: false,
      size: 0, videoSamples: null, audioSamples: null,
      videoStartTs: 0, audioStartTs: 0
    };

    if (aT) {
      var atrak = mp4.getTrackById(aT.id);
      var aentry = atrak ? atrak.mdia.minf.stbl.stsd.entries[0] : null;
      var aInfo = mp4AudioCodec(aentry, aT.codec);
      meta.hasAudio = true;
      meta.audioTrackId = aT.id;
      meta.audioTimescale = aT.timescale;
      meta.audioCodec = aInfo.codec;
      meta.audioDescription = aInfo.description;
      meta.audioSampleRate = aT.audio && aT.audio.sample_rate ? aT.audio.sample_rate : (aentry && aentry.samplerate ? aentry.samplerate : 48000);
      meta.audioChannels = aT.audio && aT.audio.channel_count ? aT.audio.channel_count : (aentry && aentry.channel_count ? aentry.channel_count : 2);
      meta.audioBitrateKbps = aT.bitrate > 0 ? Math.round(aT.bitrate / 1000) : 0;
      var aDur = (aT.movie_duration && aT.movie_timescale) ? aT.movie_duration / aT.movie_timescale : 0;
      if (aDur > durationSec) durationSec = aDur;
      if (aT.samples_duration > 0 && aT.timescale > 0) {
        var ad = aT.samples_duration / aT.timescale;
        if (ad > durationSec) durationSec = ad;
      }
      meta.duration = durationSec;
    }
    return meta;
  }

  function rotationFromMatrix(m) {
    if (!m || m.length < 9) return 0;
    function fx(v) {
      if (v > 2147483647) v -= 4294967296;
      return v / 65536;
    }
    var a = fx(m[0]), bb = fx(m[1]);
    if (!isNum(a) || !isNum(bb)) return 0;
    var deg = Math.atan2(bb, a) * 180 / Math.PI;
    var r = Math.round(deg / 90) * 90;
    r = ((r % 360) + 360) % 360;
    return (r === 90 || r === 180 || r === 270) ? r : 0;
  }

  function fpsFromStts(trak, vT) {
    try {
      var stts = trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stts;
      if (stts && stts.sample_counts && stts.sample_deltas) {
        var bestCount = 0, bestDelta = 0;
        for (var i = 0; i < stts.sample_counts.length; i++) {
          if (stts.sample_counts[i] > bestCount) {
            bestCount = stts.sample_counts[i];
            bestDelta = stts.sample_deltas[i];
          }
        }
        if (bestDelta > 0) return Math.round((vT.timescale / bestDelta) * 1000) / 1000;
      }
    } catch (e) { /* 忽略 */ }
    if (vT.nb_samples > 0 && vT.samples_duration > 0) {
      return Math.round((vT.nb_samples * vT.timescale / vT.samples_duration) * 1000) / 1000;
    }
    return 30;
  }

  /* 自带的 mp4box 兼容写入器：不依赖 mp4box 内部的 DataStream（不同打包方式暴露位置不同）。
     mp4box 的 box.write(stream) 只会用到下面这些方法。 */
  function BoxWriter() {
    this.buf = new ArrayBuffer(256);
    this.u8 = new Uint8Array(this.buf);
    this.pos = 0;
  }
  BoxWriter.prototype._ensure = function (n) {
    if (this.pos + n <= this.u8.length) return;
    var cap = this.u8.length;
    while (cap < this.pos + n) cap *= 2;
    var nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.u8.subarray(0, this.pos));
    this.buf = nb;
    this.u8 = new Uint8Array(nb);
  };
  BoxWriter.prototype.getPosition = function () { return this.pos; };
  BoxWriter.prototype.writeUint8 = function (v) {
    this._ensure(1);
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt8 = function (v) { this.writeUint8(v); };
  BoxWriter.prototype.writeUint16 = function (v) {
    this._ensure(2);
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt16 = function (v) { this.writeUint16(v & 0xFFFF); };
  BoxWriter.prototype.writeUint24 = function (v) {
    this._ensure(3);
    this.u8[this.pos++] = (v >>> 16) & 255;
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeUint32 = function (v) {
    this._ensure(4);
    this.u8[this.pos++] = Math.floor(v / 16777216) & 255;
    this.u8[this.pos++] = (v >>> 16) & 255;
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt32 = function (v) {
    if (v < 0) v += 4294967296;
    this.writeUint32(v);
  };
  BoxWriter.prototype.writeUint64 = function (v) {
    var hi = Math.floor(v / 4294967296);
    this.writeUint32(hi);
    this.writeUint32(v - hi * 4294967296);
  };
  BoxWriter.prototype.writeString = function (str, endian, length) {
    var n = length === undefined ? str.length : length;
    this._ensure(n);
    for (var i = 0; i < n; i++) this.u8[this.pos++] = i < str.length ? (str.charCodeAt(i) & 255) : 0;
  };
  BoxWriter.prototype.writeCString = function (str) {
    this.writeString(str, null, str.length);
    this.writeUint8(0);
  };
  BoxWriter.prototype.writeUint8Array = function (arr, length) {
    var n = length === undefined ? arr.length : length;
    this._ensure(n);
    this.u8.set(arr.subarray ? arr.subarray(0, n) : arr, this.pos);
    this.pos += n;
  };
  BoxWriter.prototype.writeInt32Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeInt32(arr[i]);
  };
  BoxWriter.prototype.writeUint32Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeUint32(arr[i]);
  };
  BoxWriter.prototype.writeUint16Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeUint16(arr[i]);
  };
  BoxWriter.prototype.adjustUint32 = function (position, value) {
    this.u8[position] = Math.floor(value / 16777216) & 255;
    this.u8[position + 1] = (value >>> 16) & 255;
    this.u8[position + 2] = (value >>> 8) & 255;
    this.u8[position + 3] = value & 255;
  };
  BoxWriter.prototype.bytes = function () { return this.u8.slice(0, this.pos); };

  function boxPayload(box) {
    var w = new BoxWriter();
    box.write(w);
    var all = w.bytes();
    if (all.length <= 8) return all;
    // box.write() 带 8 字节 box 头（FullBox 另含 4 字节 version/flags，属于记录内容）
    return all.slice(8);
  }

  /* 直接按 AVCConfigurationBox 字段重建 avcC，避免依赖 mp4box 的写盒实现 */
  function buildAvcCRecord(box) {
    var sps = box.SPS || [];
    var pps = box.PPS || [];
    var i, nalu;
    var total = 7;
    for (i = 0; i < sps.length; i++) total += 2 + (sps[i].nalu ? sps[i].nalu.length : 0);
    for (i = 0; i < pps.length; i++) total += 2 + (pps[i].nalu ? pps[i].nalu.length : 0);
    var out = new Uint8Array(total);
    var p = 0;
    out[p++] = 1;
    out[p++] = box.AVCProfileIndication || 0x42;
    out[p++] = box.profile_compatibility || 0;
    out[p++] = box.AVCLevelIndication || 0x1F;
    out[p++] = 0xFC | (isNum(box.lengthSizeMinusOne) ? (box.lengthSizeMinusOne & 3) : 3);
    out[p++] = 0xE0 | (sps.length & 31);
    for (i = 0; i < sps.length; i++) {
      nalu = sps[i].nalu;
      out[p++] = (nalu.length >> 8) & 255;
      out[p++] = nalu.length & 255;
      out.set(nalu, p); p += nalu.length;
    }
    out[p++] = pps.length & 255;
    for (i = 0; i < pps.length; i++) {
      nalu = pps[i].nalu;
      out[p++] = (nalu.length >> 8) & 255;
      out[p++] = nalu.length & 255;
      out.set(nalu, p); p += nalu.length;
    }
    return out;
  }

  function looksLikeAvcC(u8) {
    if (!u8 || u8.length < 7) return false;
    return u8[0] === 1 && (u8[4] & 3) === 3 && (u8[5] & 31) > 0;
  }

  function avcCDescription(entry) {
    var box = entry.avcC;
    if (box.SPS && box.SPS.length && box.PPS && box.PPS.length) {
      var built = buildAvcCRecord(box);
      if (looksLikeAvcC(built)) return built;
    }
    var payload = boxPayload(box);
    if (looksLikeAvcC(payload)) return payload;
    // 某些实现 write() 不含 box 头：尝试几种偏移
    for (var off = 0; off <= 12 && off < payload.length; off++) {
      if (looksLikeAvcC(payload.subarray(off))) return payload.slice(off);
    }
    return payload;
  }

  function mp4VideoCodec(entry, codecStr) {
    var codec = codecStr || entry.type;
    if (entry.avcC) {
      var avc = avcCDescription(entry);
      return { codec: codec.indexOf('.') >= 0 ? codec : 'avc1.42E01E', description: avc };
    }
    if (entry.hvcC) {
      var hvcDesc = boxPayload(entry.hvcC);
      return { codec: codec, description: hvcDesc, hevc: parseHvcC(hvcDesc) };
    }
    if (entry.av1C) return { codec: codec, description: boxPayload(entry.av1C) };
    if (entry.vpcC) return { codec: codec, description: null };
    return { codec: codec, description: null };
  }

  function findEsdsDesc(node, tag) {
    if (!node) return null;
    if (node.tag === tag && node.data) return node.data;
    var kids = node.descs || [];
    for (var i = 0; i < kids.length; i++) {
      var r = findEsdsDesc(kids[i], tag);
      if (r) return r;
    }
    return null;
  }

  function mp4AudioCodec(entry, codecStr) {
    if (!entry) return { codec: codecStr || '', description: null };
    var codec = codecStr || entry.type;
    if (entry.esds) {
      var data = findEsdsDesc(entry.esds.esd, 5);
      if (data && data.length >= 1) return { codec: codec, description: new Uint8Array(data) };
      return { codec: codec, description: null };
    }
    if (entry.dOps) {
      return { codec: 'opus', description: opusHeadFromDOps(entry.dOps) };
    }
    return { codec: codec, description: null };
  }

  /* dOps -> OpusHead（改大端为小端） */
  function opusHeadFromDOps(d) {
    var ch = d.OutputChannelCount || 2;
    var preSkip = d.PreSkip || 312;
    var rate = d.InputSampleRate || 48000;
    var gain = d.OutputGain || 0;
    var head = new Uint8Array(19);
    head.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    head[8] = 1;
    head[9] = ch;
    head[10] = preSkip & 255; head[11] = (preSkip >> 8) & 255;
    head[12] = rate & 255; head[13] = (rate >> 8) & 255; head[14] = (rate >> 16) & 255; head[15] = (rate >>> 24) & 255;
    head[16] = gain & 255; head[17] = (gain >> 8) & 255;
    head[18] = 0;
    return head;
  }

  function opusHead(channels, preSkip, inputRate) {
    var h = new Uint8Array(19);
    h.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    h[8] = 1;
    h[9] = channels;
    h[10] = preSkip & 255; h[11] = (preSkip >> 8) & 255;
    h[12] = inputRate & 255; h[13] = (inputRate >> 8) & 255;
    h[14] = (inputRate >> 16) & 255; h[15] = (inputRate >>> 24) & 255;
    h[16] = 0; h[17] = 0; h[18] = 0;
    return h;
  }

  /* MPEG-4 AudioSpecificConfig（AAC-LC），用于缺少 esds 的兜底 */
  function makeAsc(sampleRate, channels) {
    var rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    var idx = rates.indexOf(sampleRate);
    if (idx < 0) idx = 3;
    var ch = clamp(channels || 2, 1, 2);
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
  }

  async function readSource(b, needSamples) {
    var container = detectContainer(b);
    if (container === 'mp4' || container === 'mov') {
      var m = await readMp4(b, needSamples, container);
      m.size = b.length;
      return m;
    }
    if (container === 'webm' || container === 'mkv') {
      var w = readWebM(b, needSamples, container);
      w.size = b.length;
      return w;
    }
    throw err('无法识别的文件格式（支持 MP4 / MOV / M4V / WebM / MKV）');
  }

  /* =====================================================================
   * 4. 能力检测
   * ===================================================================== */

  var supportCache = null;

  async function checkVideoDecode(codec) {
    try {
      var r = await VideoDecoder.isConfigSupported({ codec: codec, codedWidth: 640, codedHeight: 360 });
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function checkVideoEncode(codec, w, h, bitrate, extra) {
    try {
      var cfg = { codec: codec, width: w, height: h, bitrate: bitrate, framerate: 30 };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) cfg[k] = extra[k];
      var r = await VideoEncoder.isConfigSupported(cfg);
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function checkAudioEncode(codec, sampleRate, channels, bitrate) {
    try {
      var r = await AudioEncoder.isConfigSupported({ codec: codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: bitrate });
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function detectSupport() {
    var hasWC = (typeof VideoDecoder !== 'undefined') && (typeof VideoEncoder !== 'undefined') &&
      (typeof EncodedVideoChunk !== 'undefined') && (typeof VideoFrame !== 'undefined');
    var out = {
      webcodecs: hasWC,
      // hevcSoftware 表示「内置 wasm 软解可用」（扩展字段）；hevc 仍只表示原生解码能力
      decode: { h264: false, vp8: false, vp9: false, av1: false, hevc: false, hevcSoftware: true },
      encode: { h264: false, vp9: false, av1: false, vp8: false },
      audioEncode: { aac: false, opus: false },
      containers: {
        mp4: typeof Mp4Muxer !== 'undefined' && !!(Mp4Muxer && Mp4Muxer.Muxer),
        webm: typeof WebMMuxer !== 'undefined' && !!(WebMMuxer && WebMMuxer.Muxer)
      }
    };
    if (!hasWC) return out;
    var dec = await Promise.all([
      checkVideoDecode('avc1.42001f'),
      checkVideoDecode('vp8'),
      checkVideoDecode('vp09.00.10.08'),
      checkVideoDecode('av01.0.04M.08'),
      checkVideoDecode('hvc1.1.6.L93.B0')
    ]);
    out.decode.h264 = dec[0]; out.decode.vp8 = dec[1]; out.decode.vp9 = dec[2];
    out.decode.av1 = dec[3]; out.decode.hevc = dec[4];
    var enc = await Promise.all([
      checkVideoEncode('avc1.420028', 1280, 720, 2500000, { avc: { format: 'avc' } }),
      checkVideoEncode('vp09.00.10.08', 1280, 720, 2500000),
      checkVideoEncode('av01.0.04M.08', 1280, 720, 2500000),
      checkVideoEncode('vp8', 1280, 720, 2500000)
    ]);
    out.encode.h264 = enc[0]; out.encode.vp9 = enc[1];
    out.encode.av1 = enc[2]; out.encode.vp8 = enc[3];
    var a = await Promise.all([
      checkAudioEncode('mp4a.40.2', 48000, 2, 128000),
      checkAudioEncode('opus', 48000, 2, 128000)
    ]);
    out.audioEncode.aac = a[0]; out.audioEncode.opus = a[1];
    return out;
  }

  function support() {
    if (!supportCache) supportCache = detectSupport();
    return supportCache;
  }

  /* =====================================================================
   * 5. probe
   * ===================================================================== */

  async function probe(input) {
    var b = await toBytes(input);
    var src = await readSource(b, false);
    return {
      container: src.container,
      duration: Math.round(src.duration * 1000) / 1000,
      width: src.width,
      height: src.height,
      fps: src.fps,
      rotation: src.rotation,
      videoCodec: src.videoCodec || '',
      audioCodec: src.audioCodec || '',
      hasAudio: !!src.hasAudio,
      videoBitrate: src.videoBitrateKbps || 0,
      audioBitrate: src.audioBitrateKbps || 0,
      size: b.length
    };
  }

  /* =====================================================================
   * 6. 音频重采样 / 声道混合
   * ===================================================================== */

  function Resampler(inRate, outRate, channels) {
    this.step = inRate / outRate;
    this.pos = 0;
    this.base = 0;
    this.ch = channels;
    this.bufs = [];
    for (var i = 0; i < channels; i++) this.bufs.push(new Float32Array(0));
  }

  Resampler.prototype.push = function (chans) {
    var ch = this.ch, i, c;
    var inLen = chans[0] ? chans[0].length : 0;
    var out = [];
    if (!inLen) {
      for (c = 0; c < ch; c++) out.push(new Float32Array(0));
      return out;
    }
    for (c = 0; c < ch; c++) {
      var nb = new Float32Array(this.bufs[c].length + inLen);
      nb.set(this.bufs[c]);
      nb.set(chans[c] || chans[0], this.bufs[c].length);
      this.bufs[c] = nb;
    }
    var len = this.bufs[0].length;
    var maxIndex = this.base + len - 1;
    var maxOut = Math.ceil(len / this.step) + 2;
    for (c = 0; c < ch; c++) out.push(new Float32Array(maxOut));
    var n = 0;
    while (this.pos + 1 <= maxIndex) {
      var i0 = Math.floor(this.pos);
      var frac = this.pos - i0;
      var a = i0 - this.base;
      for (c = 0; c < ch; c++) {
        var buf = this.bufs[c];
        out[c][n] = buf[a] * (1 - frac) + buf[a + 1] * frac;
      }
      n++;
      this.pos += this.step;
    }
    var keep = Math.floor(this.pos) - this.base - 1;
    if (keep > 0) {
      for (c = 0; c < ch; c++) this.bufs[c] = this.bufs[c].slice(keep);
      this.base += keep;
    }
    for (c = 0; c < ch; c++) out[c] = out[c].slice(0, n);
    return out;
  };

  function mixChannels(chans, outCh) {
    var inCh = chans.length;
    var n = chans[0].length;
    var i, c;
    if (inCh === outCh) return chans;
    var out = [];
    if (outCh === 1) {
      var mono = new Float32Array(n);
      for (c = 0; c < inCh; c++) {
        var src = chans[c];
        for (i = 0; i < n; i++) mono[i] += src[i] / inCh;
      }
      for (i = 0; i < n; i++) mono[i] = clamp(mono[i], -1, 1);
      return [mono];
    }
    if (outCh === 2) {
      if (inCh === 1) return [chans[0], chans[0].slice(0)];
      var L = new Float32Array(n), R = new Float32Array(n);
      if (inCh >= 6) {
        // 5.1: FL FR FC LFE BL BR
        for (i = 0; i < n; i++) {
          L[i] = clamp(chans[0][i] + 0.707 * chans[2][i] + 0.707 * chans[4][i] + 0.25 * chans[3][i], -1, 1);
          R[i] = clamp(chans[1][i] + 0.707 * chans[2][i] + 0.707 * chans[5][i] + 0.25 * chans[3][i], -1, 1);
        }
      } else {
        for (i = 0; i < n; i++) { L[i] = chans[0][i]; R[i] = chans[1][i]; }
      }
      return [L, R];
    }
    for (c = 0; c < outCh; c++) out.push(chans[Math.min(c, inCh - 1)]);
    return out;
  }

  /* =====================================================================
   * 7. 画布变换（旋转 + 等比缩放）
   * ===================================================================== */

  function makeCanvas(w, h) {
    var canvas, ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false });
    }
    if (!ctx) {
      if (typeof document === 'undefined') throw err('当前环境不支持 Canvas 2D');
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext('2d', { alpha: false });
    }
    if (!ctx) throw err('无法创建 2D 画布上下文');
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* 忽略 */ }
    return { canvas: canvas, ctx: ctx, width: w, height: h };
  }

  /* displayW/displayH：旋转前的显示尺寸（含 SAR）；rotation：0/90/180/270 顺时针 */
  function drawRotated(cv, frame, displayW, displayH, rotation) {
    var ctx = cv.ctx;
    var outW = cv.width, outH = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    var s = Math.min(outW / displayW, outH / displayH);
    var dw = displayW * s;
    var dh = displayH * s;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    if (rotation === 90) {
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame, -dh / 2, -dw / 2, dh, dw);
    } else if (rotation === 180) {
      ctx.rotate(Math.PI);
      ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    } else if (rotation === 270) {
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(frame, -dh / 2, -dw / 2, dh, dw);
    } else {
      ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
  }

  /* =====================================================================
   * 7.5 HEVC 软解（@hevcjs/core wasm，仅原生解码不可用时启用）
   * ===================================================================== */

  var hevcWasmBytes = null;
  var hevcModulePromise = null;
  var hevcModuleError = null;

  function base64ToBytes(b64) {
    if (typeof atob !== 'function') throw err('当前环境缺少 atob，无法解码内联 wasm');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hevcWasmBinary() {
    if (hevcWasmBytes) return hevcWasmBytes;
    if (typeof HEVC_WASM_B64 !== 'string' || !HEVC_WASM_B64) {
      throw err('HEVC 软解 wasm 未内联到引擎中');
    }
    hevcWasmBytes = base64ToBytes(HEVC_WASM_B64).buffer;
    return hevcWasmBytes;
  }

  /* 懒加载：编译 wasm + 初始化 Emscripten 模块（file:// 可用，无 fetch） */
  function createHevcModule() {
    if (hevcModulePromise) return hevcModulePromise;
    if (hevcModuleError) return Promise.reject(hevcModuleError);
    if (typeof HEVCDecoderModule !== 'function') {
      hevcModuleError = err('HEVC 软解模块未加载（HEVCDecoderModule 缺失）');
      return Promise.reject(hevcModuleError);
    }
    var initError = null;
    var timeoutError = null;
    var init = Promise.resolve().then(function () {
      return WebAssembly.compile(hevcWasmBinary());
    }).then(function (compiled) {
      return Promise.race([
        HEVCDecoderModule({
          instantiateWasm: function (imports, success) {
            WebAssembly.instantiate(compiled, imports).then(function (res) {
              // WebAssembly.instantiate(Module, imports) 直接返回 Instance
              try { success(res && res.exports ? res : res.instance); } catch (e) { initError = e; }
            }, function (e) { initError = e; });
          }
        }),
        new Promise(function (resolve, reject) {
          setTimeout(function () {
            timeoutError = err('HEVC 软解 wasm 初始化超时');
            reject(timeoutError);
          }, 20000);
        })
      ]);
    }).then(function (mod) {
      if (!mod) throw initError || err('HEVC 软解模块初始化失败');
      return mod;
    }).catch(function (e) {
      hevcModuleError = initError || timeoutError || e;
      hevcModulePromise = null;
      throw hevcModuleError;
    });
    hevcModulePromise = init;
    return init;
  }

  function parseHevcFrameLayout(spec) {
    var fields = String(spec || '').split(',');
    var out = {};
    for (var i = 0; i < fields.length; i++) {
      var s = fields[i];
      var idx = s.indexOf(':');
      if (idx < 0) continue;
      out[s.slice(0, idx)] = Number(s.slice(idx + 1));
    }
    if (!isNum(out._size) || !isNum(out.width) || !isNum(out.y)) {
      throw err('HEVC 软解 wasm 帧布局不兼容');
    }
    return out;
  }

  /* 直接基于 Emscripten 模块的轻量封装（等价于 @hevcjs/core 的 HEVCDecoder） */
  function HevcDecoderHandle(mod) {
    this.m = mod;
    var cw = mod.cwrap;
    this.layout = parseHevcFrameLayout(cw('hevc_frame_layout', 'string', [])());
    this.api = {
      create: cw('hevc_decoder_create', 'number', []),
      destroy: cw('hevc_decoder_destroy', null, ['number']),
      feed: cw('hevc_decoder_feed', 'number', ['number', 'number', 'number']),
      drain: cw('hevc_decoder_drain', 'number', ['number', 'number']),
      getDrainedFrame: cw('hevc_decoder_get_drained_frame', 'number', ['number', 'number', 'number']),
      flush: cw('hevc_decoder_flush', 'number', ['number']),
      getInfo: cw('hevc_decoder_get_info', 'number', ['number', 'number'])
    };
    this.dec = this.api.create();
    if (!this.dec) throw err('HEVC 软解器创建失败');
    this.destroyed = false;
  }

  HevcDecoderHandle.prototype._readFrame = function (framePtr) {
    var m = this.m, at = this.layout;
    var yPtr = m.getValue(framePtr + at.y, '*');
    var cbPtr = m.getValue(framePtr + at.cb, '*');
    var crPtr = m.getValue(framePtr + at.cr, '*');
    var width = m.getValue(framePtr + at.width, 'i32');
    var height = m.getValue(framePtr + at.height, 'i32');
    var strideY = m.getValue(framePtr + at.stride_y, 'i32');
    var strideC = m.getValue(framePtr + at.stride_c, 'i32');
    var cw = m.getValue(framePtr + at.chroma_width, 'i32');
    var ch = m.getValue(framePtr + at.chroma_height, 'i32');
    var bd = m.getValue(framePtr + at.bit_depth, 'i32');
    var poc = m.getValue(framePtr + at.poc, 'i32');
    var cvsId = m.getValue(framePtr + at.cvs_id, 'i32');
    var bps = m.getValue(framePtr + at.bytes_per_sample, 'i32');
    function plane(ptr, pw, ph, stride) {
      var out = new Uint16Array(pw * ph);
      var heap = bps === 1 ? m.HEAPU8 : m.HEAPU16;
      var base = bps === 1 ? ptr : ptr >> 1;
      for (var yy = 0; yy < ph; yy++) {
        out.set(heap.subarray(base + yy * stride, base + yy * stride + pw), yy * pw);
      }
      return out;
    }
    return {
      y: plane(yPtr, width, height, strideY),
      cb: plane(cbPtr, cw, ch, strideC),
      cr: plane(crPtr, cw, ch, strideC),
      width: width, height: height,
      chromaWidth: cw, chromaHeight: ch,
      bitDepth: bd, poc: poc, cvsId: cvsId
    };
  };

  HevcDecoderHandle.prototype.feed = function (u8) {
    var m = this.m;
    var ptr = m._malloc(u8.length);
    try {
      m.HEAPU8.set(u8, ptr);
      var ret = this.api.feed(this.dec, ptr, u8.length);
      if (ret !== 0) throw err('HEVC 软解 feed 失败（code ' + ret + '）');
    } finally {
      m._free(ptr);
    }
  };

  HevcDecoderHandle.prototype.drain = function () {
    var m = this.m;
    var countPtr = m._malloc(4);
    var frames = [];
    try {
      var ret = this.api.drain(this.dec, countPtr);
      if (ret !== 0) return frames;
      var count = m.getValue(countPtr, 'i32');
      var framePtr = m._malloc(this.layout._size);
      try {
        for (var i = 0; i < count; i++) {
          var r = this.api.getDrainedFrame(this.dec, i, framePtr);
          if (r === 0) frames.push(this._readFrame(framePtr));
        }
      } finally {
        m._free(framePtr);
      }
    } finally {
      m._free(countPtr);
    }
    return frames;
  };

  HevcDecoderHandle.prototype.flush = function () {
    var m = this.m;
    var frames = [];
    if (this.api.flush(this.dec) !== 0) return frames;
    var framePtr = m._malloc(this.layout._size);
    try {
      for (var i = 0; i < 100000; i++) {
        var r = this.api.getDrainedFrame(this.dec, i, framePtr);
        if (r !== 0) break;
        frames.push(this._readFrame(framePtr));
      }
    } finally {
      m._free(framePtr);
    }
    return frames;
  };

  HevcDecoderHandle.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.api.destroy(this.dec); } catch (e) { /* 忽略 */ }
    this.dec = 0;
  };

  /* hvcC（HEVCDecoderConfigurationRecord）解析：参数集 + NAL 长度前缀 + 色度/位深 */
  function parseHvcC(p) {
    if (!p || p.length < 23 || p[0] !== 1) return null;
    var numArrays = p[22];
    var off = 23;
    var vps = [], sps = [], pps = [];
    for (var a = 0; a < numArrays; a++) {
      if (off + 3 > p.length) break;
      var nalType = p[off] & 0x3F;
      var count = (p[off + 1] << 8) | p[off + 2];
      off += 3;
      var target = nalType === 32 ? vps : nalType === 33 ? sps : nalType === 34 ? pps : null;
      for (var n = 0; n < count; n++) {
        if (off + 2 > p.length) break;
        var len = (p[off] << 8) | p[off + 1];
        off += 2;
        if (len <= 0 || off + len > p.length) break;
        if (target) target.push(p.subarray(off, off + len));
        off += len;
      }
    }
    return {
      lengthSize: (p[21] & 3) + 1,
      chromaFormat: p[16] & 3,
      bitDepthLuma: (p[17] & 7) + 8,
      bitDepthChroma: (p[18] & 7) + 8,
      vps: vps, sps: sps, pps: pps
    };
  }

  function annexBFromNals(nals) {
    var total = 0, i;
    for (i = 0; i < nals.length; i++) total += 4 + nals[i].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (i = 0; i < nals.length; i++) {
      out[p++] = 0; out[p++] = 0; out[p++] = 0; out[p++] = 1;
      out.set(nals[i], p);
      p += nals[i].length;
    }
    return out;
  }

  function hevcParamAnnexB(hevc) {
    return annexBFromNals(hevc.vps.concat(hevc.sps, hevc.pps));
  }

  /* AVCC（4 字节长度前缀）-> Annex B（00 00 00 01 起始码） */
  function avccToAnnexB(data, lengthSize) {
    var nals = [];
    var p = 0;
    while (p + lengthSize <= data.length) {
      var len = 0;
      for (var i = 0; i < lengthSize; i++) len = len * 256 + data[p + i];
      p += lengthSize;
      if (len <= 0 || p + len > data.length) break;
      nals.push(data.subarray(p, p + len));
      p += len;
    }
    return annexBFromNals(nals);
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /* HEVCFrame（Y/Cb/Cr 平面，8/10bit，4:2:0）-> I420 VideoFrame（10bit 右移 2 位降到 8bit） */
  function hevcFrameToVideoFrame(f, tsUs, durUs) {
    var w = f.width | 0, h = f.height | 0;
    var cw = f.chromaWidth | 0, ch = f.chromaHeight | 0;
    var bd = f.bitDepth | 0;
    if (w <= 0 || h <= 0) throw err('HEVC 软解输出帧尺寸无效');
    if (cw !== ((w + 1) >> 1) || ch !== ((h + 1) >> 1)) {
      throw err('HEVC 软解仅支持 4:2:0（色度 ' + cw + 'x' + ch + ' 与亮度 ' + w + 'x' + h + ' 不匹配）');
    }
    if (bd !== 8 && bd !== 10) {
      throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + bd + 'bit）');
    }
    var shift = bd === 10 ? 2 : 0;
    var yN = w * h, cN = cw * ch;
    var data = new Uint8Array(yN + cN * 2);
    var i;
    for (i = 0; i < yN; i++) data[i] = (f.y[i] >> shift) & 255;
    for (i = 0; i < cN; i++) data[yN + i] = (f.cb[i] >> shift) & 255;
    for (i = 0; i < cN; i++) data[yN + cN + i] = (f.cr[i] >> shift) & 255;
    return new VideoFrame(data, {
      format: 'I420',
      codedWidth: w,
      codedHeight: h,
      timestamp: Math.max(0, Math.round(tsUs)),
      duration: Math.max(1000, Math.round(durUs)),
      layout: [
        { offset: 0, stride: w },
        { offset: yN, stride: cw },
        { offset: yN + cN, stride: cw }
      ],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    });
  }

  function isHevcCodec(codec) {
    return /^(hvc1|hev1|hvc2|hev2)(\.|$)/i.test(String(codec || ''));
  }

  /* =====================================================================
   * 8. 编码器选择
   * ===================================================================== */

  async function chooseVideoEncoder(format, outW, outH, fps, bitrate) {
    var candidates = [];
    if (format === 'mp4') {
      candidates = [
        { codec: 'avc1.420028', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.42001f', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.4d0028', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.640028', container: 'avc', avc: { format: 'avc' } }
      ];
    } else {
      candidates = [
        { codec: 'vp09.00.10.08', container: 'V_VP9' },
        { codec: 'vp8', container: 'V_VP8' }
      ];
    }
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var extra = c.avc ? { avc: c.avc } : null;
      var ok = await checkVideoEncode(c.codec, outW, outH, bitrate, extra);
      if (ok) return c;
    }
    throw err(format === 'mp4'
      ? '当前浏览器不支持 H.264 编码，无法输出 MP4'
      : '当前浏览器不支持 VP9 / VP8 编码，无法输出 WebM');
  }

  async function chooseAudioConfig(format, srcRate, srcCh, bitrateKbps) {
    var baseCh = clamp(srcCh || 2, 1, 2);
    var bitrate = clamp(bitrateKbps || 128, 32, 512) * 1000;
    var rates;
    var chanList = [baseCh];
    if (format === 'webm') {
      rates = [48000];
    } else {
      rates = srcRate === 44100 ? [44100, 48000] : [srcRate || 48000, 48000, 44100];
      // 部分平台的 AAC 编码器只支持立体声，单声道输入退化为立体声输出
      if (baseCh === 1) chanList.push(2);
    }
    var codec = format === 'webm' ? 'opus' : 'mp4a.40.2';
    for (var ci = 0; ci < chanList.length; ci++) {
      var channels = chanList[ci];
      for (var i = 0; i < rates.length; i++) {
        var rate = rates[i];
        if (!(rate >= 8000 && rate <= 96000)) continue;
        if (format === 'webm' && rate !== 48000) continue;
        if (await checkAudioEncode(codec, rate, channels, bitrate)) {
          return {
            codec: codec, sampleRate: rate, numberOfChannels: channels, bitrate: bitrate,
            containerCodec: format === 'webm' ? 'opus' : 'aac', upmixed: channels !== baseCh
          };
        }
      }
    }
    return null;
  }

  async function audioDecoderConfig(src) {
    if (!src.hasAudio || !src.audioCodec) return null;
    var cfg = {
      codec: src.audioCodec,
      sampleRate: src.audioSampleRate || 48000,
      numberOfChannels: src.audioChannels || 2
    };
    if (src.audioDescription && src.audioDescription.length) cfg.description = src.audioDescription;
    if (src.audioCodec.indexOf('mp4a') === 0 && !cfg.description) {
      cfg.description = makeAsc(cfg.sampleRate, cfg.numberOfChannels);
    }
    try {
      var r = await AudioDecoder.isConfigSupported(cfg);
      if (r && r.supported) return cfg;
    } catch (e) { /* 继续尝试无 description */ }
    if (cfg.description) {
      var cfg2 = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels };
      try {
        var r2 = await AudioDecoder.isConfigSupported(cfg2);
        if (r2 && r2.supported) return cfg2;
      } catch (e2) { /* 忽略 */ }
    }
    return null;
  }

  /* =====================================================================
   * 9. 视频转码
   * ===================================================================== */

  /* 创建视频编码器：统一 muxer 写入（DTS + composition offset）、实际编码串回读、错误收集 */
  function createVideoEncoder(ctx, state) {
    var frameDurUs = state.frameDurUs || Math.max(1000, Math.round(MICRO / ctx.targetFps));
    var enc = new VideoEncoder({
      output: function (chunk, meta) {
        try {
          if (ctx.format === 'mp4') {
            // mp4-muxer 的第三个参数是「显示时间戳 PTS」，DTS = timestamp - compositionTimeOffset。
            // 因此这里传 PTS，offset = PTS - DTS；DTS 按帧时长严格递增，B 帧乱序时也不会回退。
            var pts = Math.round(chunk.timestamp);
            var dts = Math.round(state.dtsUs);
            var offset = pts - dts;
            if (offset < state.minCompOffset) state.minCompOffset = offset;
            state.dtsUs += (chunk.duration && chunk.duration > 0 ? chunk.duration : frameDurUs);
            ctx.muxer.addVideoChunk(chunk, meta, pts, offset);
          } else {
            ctx.muxer.addVideoChunk(chunk, meta);
          }
          if (!state.actualCodec && ctx.format === 'mp4' && meta && meta.decoderConfig && meta.decoderConfig.description) {
            var d = new Uint8Array(meta.decoderConfig.description);
            if (d.length >= 4 && d[0] === 1) {
              state.actualCodec = 'avc1.' + hex2(d[1]) + hex2(d[2]) + hex2(d[3]);
            }
          }
        } catch (e) { state.error = e; }
      },
      error: function (e) { state.error = e; }
    });
    enc.configure(ctx.encoderConfig);
    return enc;
  }

  /* 视频帧公共处理：fps 网格丢帧 -> 旋转/缩放 -> VideoFrame -> 编码 -> 进度 + 背压 */
  function makeVideoFrameSink(ctx, enc, state) {
    var frameDurUs = state.frameDurUs || Math.max(1000, Math.round(MICRO / ctx.targetFps));
    var firstTs = ctx.src.videoStartTs || 0;
    var nextAcceptUs = -1;
    var lastKeyUs = -1e12;
    var outFrames = 0;
    var lastOutTs = -1;
    var videoEndUs = 0;
    return {
      push: async function (frame, ts, durHint) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var keep = true;
        if (ctx.limitFps) {
          // 网格采样：以首帧时间戳为 0 号槽位，只有越过槽位才保留一帧，
          // 平均帧率严格等于 targetFps，且总时长不变。
          if (nextAcceptUs < 0) nextAcceptUs = ts;
          var guardSlots = 0;
          while (nextAcceptUs + frameDurUs <= ts && guardSlots++ < 10000) {
            nextAcceptUs += frameDurUs;
          }
          keep = ts >= nextAcceptUs;
          if (keep) nextAcceptUs += frameDurUs;
        }
        if (!keep) return false;

        var outTs = ts - firstTs;
        if (outTs < 0) outTs = 0;
        if (outTs <= lastOutTs) outTs = lastOutTs + 1;
        var dur = ctx.limitFps ? frameDurUs : (durHint && durHint > 0 ? durHint : frameDurUs);

        drawRotated(ctx.canvas, frame, ctx.displayW, ctx.displayH, ctx.src.rotation);
        var vf = new VideoFrame(ctx.canvas.canvas, {
          timestamp: outTs,
          duration: Math.max(1000, dur),
          alpha: 'discard'
        });
        var keyFrame = outFrames === 0 || (outTs - lastKeyUs >= ctx.keyIntervalUs);
        if (keyFrame) lastKeyUs = outTs;
        enc.encode(vf, { keyFrame: keyFrame });
        vf.close();
        outFrames++;
        lastOutTs = outTs;
        videoEndUs = outTs + Math.max(1000, dur);
        ctx.progress(Math.min(0.985, (outTs + dur) / Math.max(1, ctx.totalUs)));

        var guard = 0;
        while (enc.encodeQueueSize > 4) {
          checkCancel(ctx.hooks);
          if (state.error) throw state.error;
          await sleep0();
          if (++guard > 100000) throw err('视频编码器长时间无响应');
        }
        return true;
      },
      end: function () {
        if (state.error) throw state.error;
        ctx.videoEndUs = videoEndUs;
        ctx.outFrames = outFrames;
        ctx.actualVideoCodec = state.actualCodec || '';
        if (state.minCompOffset < -2000) {
          ctx.notes.push('编码器输出 B 帧：已写入 composition time offset（ctts）');
        }
        if (!outFrames) throw err('视频解码没有产生任何帧');
      }
    };
  }

  async function encodeVideo(ctx) {
    var src = ctx.src;
    var samples = src.videoSamples;
    var state = {
      error: null, dtsUs: 0, minCompOffset: 0, actualCodec: '',
      frameDurUs: Math.max(1000, Math.round(MICRO / ctx.targetFps))
    };
    var queue = [];
    var signal = new Signal();
    var decodeError = null;
    var flushed = false;
    var sampleIdx = 0;
    var dec = null;
    var enc = null;

    log(ctx.hooks, '视频：' + samples.length + ' 帧样本，' + ctx.decoderConfig.codec +
      ' → ' + ctx.encoder.codec + '，输出 ' + ctx.outW + 'x' + ctx.outH + ' @ ' + Math.round(ctx.targetFps) + ' fps');

    dec = new VideoDecoder({
      output: function (frame) { queue.push(frame); signal.notify(); },
      error: function (e) { decodeError = e; signal.notify(); }
    });
    dec.configure(ctx.decoderConfig);

    enc = createVideoEncoder(ctx, state);
    var sink = makeVideoFrameSink(ctx, enc, state);

    try {
      while (true) {
        checkCancel(ctx.hooks);
        if (decodeError) throw decodeError;
        if (state.error) throw state.error;

        while (sampleIdx < samples.length && dec.decodeQueueSize < 6) {
          var s = samples[sampleIdx++];
          dec.decode(new EncodedVideoChunk({
            type: s.key ? 'key' : 'delta',
            timestamp: s.ts,
            duration: Math.max(1000, s.dur || state.frameDurUs),
            data: s.data
          }));
        }

        if (queue.length === 0) {
          if (sampleIdx >= samples.length && !flushed) {
            await dec.flush();
            flushed = true;
            continue;
          }
          if (flushed) break;
          await signal.wait();
          continue;
        }

        var frame = queue.shift();
        try {
          if (frame.timestamp >= 0) await sink.push(frame, frame.timestamp, frame.duration);
        } finally {
          frame.close();
        }
      }
      checkCancel(ctx.hooks);
      await enc.flush();
      sink.end();
    } finally {
      closeQuietly(dec);
      closeQuietly(enc);
    }

    if (decodeError) throw decodeError;
  }

  /* HEVC 软解路径：hvcC 参数集 + Annex B 喂给 wasm，输出 I420 VideoFrame 后复用同一套 Canvas/编码逻辑 */
  async function encodeVideoSoft(ctx) {
    var src = ctx.src;
    var hevc = src.videoHevc;
    var samples = src.videoSamples;
    var srcFps = src.fps > 0 ? src.fps : 30;
    var frameDurUs = Math.max(1000, Math.round(MICRO / srcFps));
    var firstTs = src.videoStartTs || 0;
    var state = {
      error: null, dtsUs: 0, minCompOffset: 0, actualCodec: '', frameDurUs: frameDurUs
    };
    var enc = null;
    var handle = null;
    var outIndex = 0;
    var tStart = now();

    if (!hevc || !hevc.vps.length || !hevc.sps.length || !hevc.pps.length) {
      throw err('HEVC 软解缺少参数集（hvcC 中的 VPS/SPS/PPS），无法解码');
    }
    if (hevc.chromaFormat !== 1) {
      throw err('HEVC 软解仅支持 4:2:0（当前 chroma_format_idc=' + hevc.chromaFormat + '）');
    }
    if (hevc.bitDepthLuma > 10 || hevc.bitDepthChroma > 10) {
      throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + hevc.bitDepthLuma + 'bit）');
    }

    log(ctx.hooks, '视频（HEVC 软解）：' + samples.length + ' 帧样本，' + src.videoCodec +
      ' → ' + ctx.encoder.codec + '，输出 ' + ctx.outW + 'x' + ctx.outH + ' @ ' + Math.round(ctx.targetFps) + ' fps');

    enc = createVideoEncoder(ctx, state);
    var sink = makeVideoFrameSink(ctx, enc, state);

    async function consume(frames) {
      for (var i = 0; i < frames.length; i++) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var f = frames[i];
        var ts = firstTs + outIndex * frameDurUs;
        outIndex++;
        var vf = hevcFrameToVideoFrame(f, ts, frameDurUs);
        try {
          await sink.push(vf, ts, frameDurUs);
        } finally {
          vf.close();
        }
      }
      frames.length = 0;
    }

    try {
      var mod = await createHevcModule();
      checkCancel(ctx.hooks);
      handle = new HevcDecoderHandle(mod);
      var params = hevcParamAnnexB(hevc);

      for (var i = 0; i < samples.length; i++) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var s = samples[i];
        var body = avccToAnnexB(s.data, hevc.lengthSize);
        // 首帧与每个关键帧前都补上 hvcC 参数集，兼容 hvc1/hev1 以及流中途换参数集的情况
        var payload = (i === 0 || s.key) ? concatBytes(params, body) : body;
        handle.feed(payload);
        await consume(handle.drain());
        ctx.progress(Math.min(0.985, ((s.ts + (s.dur || frameDurUs)) - firstTs) / Math.max(1, ctx.totalUs)));
        if ((i & 7) === 0) await sleep0();
      }

      await consume(handle.flush());
      checkCancel(ctx.hooks);
      await enc.flush();
      sink.end();
      log(ctx.hooks, 'HEVC 软解完成：' + outIndex + ' 帧，用时 ' +
        ((now() - tStart) / 1000).toFixed(1) + ' 秒');
    } finally {
      if (handle) handle.destroy();
      closeQuietly(enc);
    }
  }

  /* =====================================================================
   * 10. 音频转码
   * ===================================================================== */

  async function encodeAudio(ctx) {
    var src = ctx.src;
    var samples = src.audioSamples || [];
    var targetRate = ctx.audioRate;
    var targetCh = ctx.audioChannels;
    var chunkFrames = ctx.format === 'webm' ? 960 : 1024;
    var inRate = src.audioSampleRate || 48000;
    var resampler = inRate !== targetRate ? new Resampler(inRate, targetRate, targetCh) : null;
    var baseTsUs = Math.max(0, (src.audioStartTs || 0) - (src.videoStartTs || 0));
    var acc = [];
    var accFrames = 0;
    var outFrames = 0;
    var audioEndUs = 0;
    var raw = [];
    var rawFrames = 0;
    var rawMax = targetRate;      // 最多缓存 1 秒原始音频
    var signal = new Signal();
    var decodeError = null;
    var encodeError = null;
    var flushed = false;
    var sampleIdx = 0;
    var dec = null;
    var enc = null;
    var opusDesc = ctx.format === 'webm' ? opusHead(targetCh, 312, 48000) : null;
    var c;

    for (c = 0; c < targetCh; c++) acc.push(new Float32Array(0));

    function appendAcc(pieces) {
      var n = pieces[0] ? pieces[0].length : 0;
      if (!n) return;
      for (var i = 0; i < targetCh; i++) {
        var nb = new Float32Array(acc[i].length + n);
        nb.set(acc[i]);
        nb.set(pieces[i] || pieces[0], acc[i].length);
        acc[i] = nb;
      }
      accFrames += n;
    }

    async function emitChunk() {
      var data = new Float32Array(chunkFrames * targetCh);
      for (var i = 0; i < targetCh; i++) {
        data.set(acc[i].subarray(0, chunkFrames), i * chunkFrames);
        acc[i] = acc[i].slice(chunkFrames);
      }
      accFrames -= chunkFrames;
      var tsUs = baseTsUs + Math.round(outFrames * MICRO / targetRate);
      var ad = new AudioData({
        format: 'f32-planar',
        sampleRate: targetRate,
        numberOfFrames: chunkFrames,
        numberOfChannels: targetCh,
        timestamp: tsUs,
        data: data
      });
      enc.encode(ad);
      ad.close();
      outFrames += chunkFrames;
      audioEndUs = tsUs + Math.round(chunkFrames * MICRO / targetRate);
      var guard = 0;
      while (enc.encodeQueueSize > 6) {
        checkCancel(ctx.hooks);
        await sleep0();
        if (++guard > 100000) throw err('音频编码器长时间无响应');
      }
    }

    dec = new AudioDecoder({
      output: function (ad) {
        try {
          var n = ad.numberOfFrames, ch = ad.numberOfChannels, chans = [];
          for (var i = 0; i < ch; i++) {
            var a = new Float32Array(n);
            ad.copyTo(a, { planeIndex: i, format: 'f32-planar' });
            chans.push(a);
          }
          raw.push({ chans: chans, frames: n });
          rawFrames += n;
        } catch (e) { decodeError = e; }
        try { ad.close(); } catch (e2) { /* 忽略 */ }
        signal.notify();
      },
      error: function (e) { decodeError = e; signal.notify(); }
    });
    dec.configure(ctx.audioDecodeConfig);

    enc = new AudioEncoder({
      output: function (chunk, meta) {
        try {
          if (ctx.format === 'webm') {
            ctx.muxer.addAudioChunk(chunk, {
              decoderConfig: {
                codec: 'opus',
                sampleRate: targetRate,
                numberOfChannels: targetCh,
                description: opusDesc
              }
            });
          } else {
            var md = meta && meta.decoderConfig ? meta : {};
            if (!md.decoderConfig || !md.decoderConfig.description) {
              md = {
                decoderConfig: {
                  codec: 'mp4a.40.2',
                  sampleRate: targetRate,
                  numberOfChannels: targetCh,
                  description: makeAsc(targetRate, targetCh)
                }
              };
            }
            ctx.muxer.addAudioChunk(chunk, md);
          }
        } catch (e) { encodeError = e; }
      },
      error: function (e) { encodeError = e; }
    });
    enc.configure(ctx.audioEncoderConfig);

    log(ctx.hooks, '音频：' + (src.audioCodec || '?') + ' ' + inRate + 'Hz ' + (src.audioChannels || 2) + 'ch → ' +
      (ctx.format === 'webm' ? 'Opus' : 'AAC') + ' ' + targetRate + 'Hz ' + targetCh + 'ch ' +
      Math.round(ctx.audioEncoderConfig.bitrate / 1000) + 'kbps');

    try {
      while (true) {
        checkCancel(ctx.hooks);
        if (decodeError) throw decodeError;
        if (encodeError) throw encodeError;

        while (sampleIdx < samples.length && rawFrames < rawMax && dec.decodeQueueSize < 10) {
          var s = samples[sampleIdx++];
          dec.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: s.ts,
            duration: Math.max(1000, s.dur || 20000),
            data: s.data
          }));
        }

        if (raw.length === 0) {
          if (sampleIdx >= samples.length && !flushed) {
            await dec.flush();
            flushed = true;
            continue;
          }
          if (flushed) break;
          await signal.wait();
          continue;
        }

        var seg = raw.shift();
        rawFrames -= seg.frames;
        var mixed = mixChannels(seg.chans, targetCh);
        var pieces = resampler ? resampler.push(mixed) : mixed;
        appendAcc(pieces);
        while (accFrames >= chunkFrames) {
          checkCancel(ctx.hooks);
          await emitChunk();
        }
      }

      // 尾部不足一帧：补静音
      if (accFrames > 0) {
        var pad = [];
        for (c = 0; c < targetCh; c++) {
          var p = new Float32Array(chunkFrames);
          p.set(acc[c].subarray(0, Math.min(accFrames, chunkFrames)));
          pad.push(p);
        }
        acc = pad;
        accFrames = chunkFrames;
        checkCancel(ctx.hooks);
        await emitChunk();
      }

      checkCancel(ctx.hooks);
      await enc.flush();
    } finally {
      closeQuietly(dec);
      closeQuietly(enc);
    }

    if (decodeError) throw decodeError;
    if (encodeError) throw encodeError;
    ctx.audioEndUs = audioEndUs;
    ctx.audioOutFrames = outFrames;
  }

  /* =====================================================================
   * 11. convert
   * ===================================================================== */

  function planSize(src, opts) {
    var vw = src.rotation % 180 ? src.displayHeight : src.displayWidth;
    var vh = src.rotation % 180 ? src.displayWidth : src.displayHeight;
    if (!(vw > 0) || !(vh > 0)) {
      vw = src.rotation % 180 ? src.codedHeight : src.codedWidth;
      vh = src.rotation % 180 ? src.codedWidth : src.codedHeight;
    }
    var maxW = isNum(opts.maxWidth) && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 0;
    var maxH = isNum(opts.maxHeight) && opts.maxHeight > 0 ? Math.floor(opts.maxHeight) : 0;
    var scale = 1;
    if (maxW && vw > maxW) scale = Math.min(scale, maxW / vw);
    if (maxH && vh > maxH) scale = Math.min(scale, maxH / vh);
    return { width: even(vw * scale), height: even(vh * scale), srcDisplayW: vw, srcDisplayH: vh };
  }

  function autoBitrate(w, h, fps) {
    var kbps = Math.round(w * h * Math.min(fps || 30, 60) * 0.09 / 1000);
    return Math.round(clamp(kbps, 300, 20000));
  }

  async function convert(input, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    if (!opts.format) throw err('缺少输出格式 opts.format（mp4 / webm）');
    var format = opts.format;
    if (format !== 'mp4' && format !== 'webm') throw err('不支持的输出格式：' + opts.format);

    var t0 = now();
    var progress = makeProgress(hooks);
    progress(0, true);
    checkCancel(hooks);

    var bytes = await toBytes(input);
    log(hooks, '读取 ' + bytesToSize(bytes.length) + '，开始探测');
    var src = await readSource(bytes, true);
    checkCancel(hooks);

    if (!src.hasVideo) throw err('文件中没有视频轨道');
    if (!src.videoSamples || !src.videoSamples.length) throw err('视频轨道没有可解码的样本（解封装失败）');
    if (!src.videoCodec) throw err('无法识别视频编码');
    progress(0.01, true);

    var size = planSize(src, opts);
    var outW = size.width, outH = size.height;

    var limitFps = isNum(opts.fps) && opts.fps > 0;
    var targetFps = limitFps ? clamp(opts.fps, 1, 240) : (src.fps > 0 ? src.fps : 30);
    var limitByFps = limitFps && targetFps < src.fps - 0.001;

    var vKbps = isNum(opts.videoBitrate) && opts.videoBitrate > 0
      ? Math.round(opts.videoBitrate)
      : autoBitrate(outW, outH, targetFps);

    var keyIntervalSec = isNum(opts.keyframeInterval) && opts.keyframeInterval > 0 ? opts.keyframeInterval : 2;
    var notes = [];

    // 旋转/缩放说明
    if (src.rotation) notes.push('已按元数据旋转画面 ' + src.rotation + '°（输出无旋转矩阵）');
    if (outW !== size.srcDisplayW || outH !== size.srcDisplayH) {
      notes.push('输出尺寸 ' + outW + 'x' + outH + '（原 ' + size.srcDisplayW + 'x' + size.srcDisplayH + '）');
    }
    if (limitByFps) notes.push('帧率 ' + src.fps + ' → ' + targetFps + ' fps（按时间戳丢帧，时长不变）');

    var encoder = await chooseVideoEncoder(format, outW, outH, Math.round(targetFps), vKbps * 1000);
    var encoderConfig = {
      codec: encoder.codec,
      width: outW,
      height: outH,
      bitrate: clamp(vKbps * 1000, 50000, 60000000),
      framerate: Math.max(1, Math.round(targetFps)),
      latencyMode: 'quality',
      hardwareAcceleration: 'no-preference'
    };
    if (encoder.avc) encoderConfig.avc = encoder.avc;

    // ---- 音频规划 ----
    var audioActive = false;
    var audioDecodeCfg = null;
    var audioEncodeCfg = null;
    var audioDropReason = '';
    if (opts.audio === 'drop') {
      audioDropReason = '按参数丢弃音频';
    } else if (!src.hasAudio) {
      audioDropReason = '输入没有音频轨道';
    } else if (!src.audioSamples || !src.audioSamples.length) {
      audioDropReason = '输入音频轨道没有可用样本';
    } else {
      audioDecodeCfg = await audioDecoderConfig(src);
      if (!audioDecodeCfg) {
        audioDropReason = 'WebCodecs 无法解码输入音频编码 ' + (src.audioCodec || '未知');
      } else {
        var chosen = await chooseAudioConfig(format, src.audioSampleRate, src.audioChannels, opts.audioBitrate);
        if (!chosen) {
          audioDropReason = (format === 'mp4' ? 'AAC' : 'Opus') + ' 音频编码不可用';
        } else {
          audioActive = true;
          audioEncodeCfg = chosen;
          if (chosen.upmixed) notes.push('单声道音频已上混为立体声输出（平台 AAC 编码器不支持单声道）');
        }
      }
    }
    if (audioDropReason) {
      notes.push('音频已丢弃：' + audioDropReason);
      log(hooks, '音频已丢弃：' + audioDropReason);
    }

    // ---- 创建合成器 ----
    var muxer;
    if (format === 'mp4') {
      var mp4Opts = {
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: outW, height: outH, frameRate: Math.max(1, Math.round(targetFps)) },
        firstTimestampBehavior: 'offset',
        fastStart: 'in-memory'
      };
      if (audioActive) {
        mp4Opts.audio = {
          codec: 'aac',
          sampleRate: audioEncodeCfg.sampleRate,
          numberOfChannels: audioEncodeCfg.numberOfChannels
        };
      }
      muxer = new Mp4Muxer.Muxer(mp4Opts);
    } else {
      var webmOpts = {
        target: new WebMMuxer.ArrayBufferTarget(),
        video: {
          codec: encoder.container,
          width: outW,
          height: outH,
          frameRate: Math.max(1, Math.round(targetFps))
        },
        firstTimestampBehavior: 'offset'
      };
      if (audioActive) {
        webmOpts.audio = {
          codec: 'A_OPUS',
          sampleRate: audioEncodeCfg.sampleRate,
          numberOfChannels: audioEncodeCfg.numberOfChannels
        };
      }
      muxer = new WebMMuxer.Muxer(webmOpts);
    }

    var canvas = makeCanvas(outW, outH);
    var decoderConfig = {
      codec: src.videoCodec,
      codedWidth: src.codedWidth,
      codedHeight: src.codedHeight,
      optimizeForLatency: false
    };
    if (src.videoDescription && src.videoDescription.length) decoderConfig.description = src.videoDescription;

    // 原生 VideoDecoder 优先；HEVC 原生不可用时回退到内置 wasm 软解
    var vdecSupported = false;
    var softHevc = false;
    try {
      var vr = await VideoDecoder.isConfigSupported(decoderConfig);
      vdecSupported = !!(vr && vr.supported);
    } catch (e) { vdecSupported = false; }
    if (!vdecSupported && decoderConfig.description) {
      var cfg2 = { codec: decoderConfig.codec, codedWidth: decoderConfig.codedWidth, codedHeight: decoderConfig.codedHeight };
      try {
        var vr2 = await VideoDecoder.isConfigSupported(cfg2);
        if (vr2 && vr2.supported) { decoderConfig = cfg2; vdecSupported = true; }
      } catch (e2) { /* 忽略 */ }
    }
    if (!vdecSupported) {
      if (isHevcCodec(src.videoCodec)) {
        var hvc = src.videoHevc;
        if (!hvc || !hvc.vps.length || !hvc.sps.length || !hvc.pps.length) {
          throw err('当前浏览器无法解码 HEVC（' + src.videoCodec + '），且文件缺少 hvcC 参数集，无法软解');
        }
        if (hvc.chromaFormat !== 1) {
          throw err('HEVC 软解仅支持 4:2:0（当前 chroma_format_idc=' + hvc.chromaFormat + '），4:2:2/4:4:4 不受支持');
        }
        if (hvc.bitDepthLuma > 10 || hvc.bitDepthChroma > 10) {
          throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + hvc.bitDepthLuma + 'bit）');
        }
        softHevc = true;
        notes.push('HEVC 使用内置软解（@hevcjs/core wasm），时间戳按恒定帧率估算，转码较慢');
        if (hvc.bitDepthLuma > 8) notes.push('10bit HEVC 已降为 8bit 输出');
        log(hooks, '原生 HEVC 解码不可用，改用内置软解');
      } else {
        throw err('当前浏览器无法解码输入视频编码 ' + src.videoCodec + '（可能缺少解码器或描述信息）');
      }
    }

    var ctx = {
      src: src,
      format: format,
      hooks: hooks,
      progress: progress,
      muxer: muxer,
      encoder: encoder,
      encoderConfig: encoderConfig,
      decoderConfig: decoderConfig,
      canvas: canvas,
      outW: outW,
      outH: outH,
      displayW: size.srcDisplayW,
      displayH: size.srcDisplayH,
      targetFps: targetFps,
      limitFps: limitByFps,
      keyIntervalUs: keyIntervalSec * MICRO,
      totalUs: Math.max(1, src.duration * MICRO),
      videoEndUs: 0,
      audioEndUs: 0,
      notes: notes,
      actualVideoCodec: '',
      softHevc: softHevc,
      audioRate: audioActive ? audioEncodeCfg.sampleRate : 0,
      audioChannels: audioActive ? audioEncodeCfg.numberOfChannels : 0,
      audioDecodeConfig: audioDecodeCfg,
      audioEncoderConfig: audioEncodeCfg
    };

    log(hooks, '输出：' + format.toUpperCase() + ' ' + outW + 'x' + outH + '，' +
      Math.round(targetFps) + ' fps，视频 ' + vKbps + ' kbps');
    progress(0.02, true);

    try {
      if (ctx.softHevc) {
        await encodeVideoSoft(ctx);
      } else {
        await encodeVideo(ctx);
      }
      checkCancel(hooks);
      progress(0.99, true);

      if (audioActive) {
        await encodeAudio(ctx);
      }

      checkCancel(hooks);
      muxer.finalize();
      var outBuf = muxer.target.buffer;
      var data = outBuf instanceof Uint8Array ? outBuf : new Uint8Array(outBuf);
      progress(1, true);

      var durationSec = Math.max(ctx.videoEndUs, ctx.audioEndUs) / MICRO;
      if (!(durationSec > 0)) durationSec = src.duration;
      var elapsed = (now() - t0) / 1000;
      log(hooks, '完成：' + bytesToSize(data.length) + '，用时 ' + elapsed.toFixed(1) + ' 秒');

      var meta = {
        format: format,
        width: outW,
        height: outH,
        fps: Math.round(targetFps * 1000) / 1000,
        duration: Math.round(durationSec * 1000) / 1000,
        videoCodec: format === 'mp4'
          ? (ctx.actualVideoCodec || encoder.codec)
          : (encoder.container === 'V_VP9' ? 'vp09.00.10.08' : 'vp8'),
        audioCodec: audioActive ? (format === 'webm' ? 'opus' : 'mp4a.40.2') : '',
        bitrate: durationSec > 0 ? Math.round(data.length * 8 / durationSec / 1000) : 0,
        size: data.length,
        notes: notes
      };
      return { data: data, meta: meta };
    } catch (e) {
      throw e;
    }
  }

  /* =====================================================================
   * 12. 导出
   * ===================================================================== */

  var VideoEngine = {
    version: VERSION,
    support: support,
    probe: probe,
    convert: convert,
    /* HEVC wasm 软解是否随包提供（不代表原生解码能力） */
    hevcSoftware: true,
    /* 便于测试/调试，非稳定 API */
    _internal: {
      detectContainer: detectContainer,
      readSource: readSource,
      readWebM: readWebM,
      readMp4: readMp4,
      drawRotated: drawRotated,
      makeCanvas: makeCanvas,
      Resampler: Resampler,
      mixChannels: mixChannels,
      opusHead: opusHead,
      makeAsc: makeAsc,
      parseHvcC: parseHvcC,
      avccToAnnexB: avccToAnnexB,
      hevcFrameToVideoFrame: hevcFrameToVideoFrame,
      createHevcModule: createHevcModule,
      HevcDecoderHandle: HevcDecoderHandle,
      isHevcCodec: isHevcCodec
    }
  };

  try {
    Object.defineProperty(global, 'VideoEngine', { value: VideoEngine, writable: true, configurable: true, enumerable: true });
  } catch (e) {
    global.VideoEngine = VideoEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
