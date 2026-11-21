/* VideoEngine 页面内测试套件：由 run-video-tests.js 通过 CDP 调用 window.__runVideoTests() */
(function () {
  'use strict';

  var E = window.VideoEngine;
  var tests = [];
  var logs = [];

  function logLine(s) {
    logs.push(s);
    var el = document.getElementById('log');
    if (el) el.textContent = logs.join('\n');
  }

  function ok(name, pass, detail) {
    tests.push({ name: name, pass: !!pass, detail: detail || '' });
    logLine((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  }

  function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

  async function fetchBytes(url) {
    var r = await fetch(url + '?t=' + Date.now());
    if (!r.ok) throw new Error('fetch 失败 ' + url + ' ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  function loadVideo(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        reject(new Error('video loadedmetadata 超时'));
      }, 10000);
      v.onloadedmetadata = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ video: v, url: url });
      };
      v.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        reject(new Error('video 加载失败 code=' + (v.error ? v.error.code : '?') +
          ' ' + (v.error ? v.error.message : '')));
      };
      v.src = url;
    });
  }

  function waitFrame(v) {
    return new Promise(function (resolve) {
      var finished = false;
      function fin() { if (!finished) { finished = true; resolve(); } }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(function () { fin(); });
      setTimeout(fin, 900);
    });
  }

  async function seekTo(v, t) {
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) {
      await waitFrame(v);
      return;
    }
    await new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('seek 超时'));
      }, 8000);
      v.addEventListener('seeked', function h() {
        v.removeEventListener('seeked', h);
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
      v.currentTime = t;
    });
    await waitFrame(v);
  }

  /* 分析一帧画面：非黑像素比例、左/右上方红色强度 */
  async function frameStats(v, t) {
    await seekTo(v, t);
    var c = document.createElement('canvas');
    c.width = v.videoWidth || 1;
    c.height = v.videoHeight || 1;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    var w = c.width, h = c.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    var nonBlack = 0, total = 0;
    var sumR = 0, sumG = 0, sumB = 0;
    for (var y = 0; y < h; y += 3) {
      for (var x = 0; x < w; x += 3) {
        var i = (y * w + x) * 4;
        var r = data[i], g = data[i + 1], b = data[i + 2];
        total++;
        if (r + g + b > 24) nonBlack++;
        sumR += r; sumG += g; sumB += b;
      }
    }
    function regionRed(x0, x1, y0, y1) {
      var rr = 0, gg = 0, bb = 0, n = 0;
      var xs = Math.floor(x0 * w), xe = Math.floor(x1 * w);
      var ys = Math.floor(y0 * h), ye = Math.floor(y1 * h);
      for (var yy = ys; yy < ye; yy += 2) {
        for (var xx = xs; xx < xe; xx += 2) {
          var ii = (yy * w + xx) * 4;
          rr += data[ii]; gg += data[ii + 1]; bb += data[ii + 2]; n++;
        }
      }
      n = n || 1;
      return { r: rr / n, g: gg / n, b: bb / n };
    }
    return {
      width: w, height: h,
      nonBlackRatio: total ? nonBlack / total : 0,
      avg: { r: sumR / total, g: sumG / total, b: sumB / total },
      topLeft: regionRed(0, 0.16, 0, 0.16),
      topRight: regionRed(0.84, 1, 0, 0.16),
      bottomLeft: regionRed(0, 0.16, 0.84, 1),
      bottomRight: regionRed(0.84, 1, 0.84, 1)
    };
  }

  function probeRow(p) {
    return [p.container, p.width + 'x' + p.height, p.rotation, p.videoCodec, p.audioCodec,
      'dur=' + p.duration, 'fps=' + p.fps, 'vb=' + p.videoBitrate, 'ab=' + p.audioBitrate].join(' ');
  }

  /* 深检查：解封装输出文件的音频并用 AudioDecoder 解码，计算 RMS 判断是否非静音 */
  async function audioRms(bytes) {
    var src = await E._internal.readSource(bytes, true);
    if (!src.hasAudio || !src.audioSamples || !src.audioSamples.length) {
      return { error: '没有音频样本', hasAudio: src.hasAudio, codec: src.audioCodec };
    }
    var cfg = {
      codec: src.audioCodec,
      sampleRate: src.audioSampleRate,
      numberOfChannels: src.audioChannels
    };
    if (src.audioDescription && src.audioDescription.length) cfg.description = src.audioDescription;
    if (src.audioCodec.indexOf('mp4a') === 0 && !cfg.description) cfg.description = E._internal.makeAsc(cfg.sampleRate, cfg.numberOfChannels);
    var support = await AudioDecoder.isConfigSupported(cfg);
    if (!support.supported) return { error: 'AudioDecoder 不支持 ' + src.audioCodec, cfg: cfg.codec };
    var sum = 0, count = 0, err = null;
    var dec = new AudioDecoder({
      output: function (ad) {
        try {
          var n = ad.numberOfFrames;
          var a = new Float32Array(n);
          ad.copyTo(a, { planeIndex: 0, format: 'f32-planar' });
          for (var i = 0; i < n; i++) { sum += a[i] * a[i]; count++; }
        } catch (e) { err = e; }
        try { ad.close(); } catch (e2) { }
      },
      error: function (e) { err = e; }
    });
    dec.configure(cfg);
    var limit = Math.min(src.audioSamples.length, 30);
    try {
      for (var i = 0; i < limit; i++) {
        var s = src.audioSamples[i];
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.ts, duration: s.dur || 20000, data: s.data }));
        if (dec.decodeQueueSize > 6) await new Promise(function (r) { setTimeout(r, 0); });
      }
      await dec.flush();
    } finally {
      try { dec.close(); } catch (e3) { }
    }
    if (err) return { error: String(err && err.message || err) };
    return {
      rms: Math.sqrt(count ? sum / count : 0),
      samples: count,
      codec: src.audioCodec,
      sampleRate: src.audioSampleRate,
      channels: src.audioChannels,
      bitrate: src.audioBitrateKbps
    };
  }

  function newHooks(collect) {
    var progress = [];
    return {
      progress: progress,
      onProgress: function (p) { progress.push(Math.round(p * 10000) / 10000); },
      onLog: function (m) { logLine('  [log] ' + m); },
      isCancelled: function () { return false; }
    };
  }

  function checkMonotonic(progress) {
    var bad = 0;
    for (var i = 1; i < progress.length; i++) if (progress[i] < progress[i - 1]) bad++;
    return { bad: bad, count: progress.length, last: progress.length ? progress[progress.length - 1] : -1, first: progress.length ? progress[0] : -1 };
  }

  async function loadAll() {
    var samples = {};
    samples.mp4 = await fetchBytes('/samples/h264-aac.mp4');
    samples.webm = await fetchBytes('/samples/vp9-opus.webm');
    samples.portrait = await fetchBytes('/samples/portrait-rot90.mp4');
    samples.rot180 = await fetchBytes('/samples/rot180.mp4');
    samples.mov = await fetchBytes('/samples/h264-aac.mov');
    samples.m4v = await fetchBytes('/samples/h264-aac.m4v');
    samples.av1 = await fetchBytes('/samples/av1.webm');
    samples.vp8 = await fetchBytes('/samples/vp8.webm');
    samples.mkv = await fetchBytes('/samples/matroska.mkv');
    samples.realMp4 = await fetchBytes('/samples/real-bbb-h264-1mb.mp4');
    samples.realWebm = await fetchBytes('/samples/real-bbb-vp9-1mb.webm');
    samples.aac44 = await fetchBytes('/samples/aac44.mp4');
    samples.mono = await fetchBytes('/samples/mono-opus.webm');
    return samples;
  }

  async function run() {
    var t0 = Date.now();
    var results = { checks: tests, support: null, samples: {}, errors: [], timing: {} };
    function section(name) { results.timing[name] = Date.now(); }

    try {
      var caps = await E.support();
      results.support = caps;
      ok('support(): WebCodecs 可用', caps.webcodecs, JSON.stringify(caps));
      ok('support(): 解码 H.264', caps.decode.h264);
      ok('support(): 解码 VP9', caps.decode.vp9);
      ok('support(): 容器 mp4 可用', caps.containers.mp4);
      ok('support(): 容器 webm 可用', caps.containers.webm);
      ok('support(): 编码 VP8（WebM 回退，扩展字段）', caps.encode.vp8 === true, JSON.stringify(caps.encode));
      ok('support(): 音频编码 AAC', caps.audioEncode.aac);
      ok('support(): 音频编码 Opus', caps.audioEncode.opus);
    } catch (e) {
      results.errors.push('support: ' + e.message);
      ok('support() 执行', false, e.message);
    }

    var samples;
    try {
      samples = await loadAll();
      results.samples = {
        mp4: samples.mp4.length, webm: samples.webm.length, portrait: samples.portrait.length
      };
      ok('样本加载', samples.mp4.length > 1000 && samples.webm.length > 1000 && samples.portrait.length > 1000,
        'mp4=' + samples.mp4.length + ' webm=' + samples.webm.length + ' portrait=' + samples.portrait.length);
    } catch (e) {
      results.errors.push('samples: ' + e.message);
      ok('样本加载', false, e.message);
      return results;
    }

    /* ---------- 1. probe ---------- */
    section('probeStart');
    var pMp4, pWebm, pPortrait;
    try {
      pMp4 = await E.probe(samples.mp4);
      results.probe = { mp4: pMp4 };
      ok('probe(MP4) 容器', pMp4.container === 'mp4', pMp4.container);
      ok('probe(MP4) 分辨率 1280x720', pMp4.width === 1280 && pMp4.height === 720, pMp4.width + 'x' + pMp4.height);
      ok('probe(MP4) 时长≈10s', approx(pMp4.duration, 10, 0.3), String(pMp4.duration));
      ok('probe(MP4) fps≈30', approx(pMp4.fps, 30, 0.5), String(pMp4.fps));
      ok('probe(MP4) 旋转 0', pMp4.rotation === 0, String(pMp4.rotation));
      ok('probe(MP4) 视频编码 avc1', /^avc1\./.test(pMp4.videoCodec), pMp4.videoCodec);
      ok('probe(MP4) 音频 AAC', /^mp4a\.40/.test(pMp4.audioCodec), pMp4.audioCodec);
      ok('probe(MP4) hasAudio', pMp4.hasAudio === true);
      ok('probe(MP4) 视频码率 > 0', pMp4.videoBitrate > 0, String(pMp4.videoBitrate));
      ok('probe(MP4) 音频码率 > 0', pMp4.audioBitrate > 0, String(pMp4.audioBitrate));
      ok('probe(MP4) size 正确', pMp4.size === samples.mp4.length, pMp4.size + ' vs ' + samples.mp4.length);
      logLine('  probe(MP4): ' + probeRow(pMp4));

      pWebm = await E.probe(samples.webm);
      results.probe.webm = pWebm;
      ok('probe(WebM) 容器', pWebm.container === 'webm', pWebm.container);
      ok('probe(WebM) 分辨率 1280x720', pWebm.width === 1280 && pWebm.height === 720, pWebm.width + 'x' + pWebm.height);
      ok('probe(WebM) 时长≈10s', approx(pWebm.duration, 10, 0.35), String(pWebm.duration));
      ok('probe(WebM) fps≈30', approx(pWebm.fps, 30, 1), String(pWebm.fps));
      ok('probe(WebM) 视频编码 VP9', /^vp09/.test(pWebm.videoCodec), pWebm.videoCodec);
      ok('probe(WebM) 音频 Opus', pWebm.audioCodec === 'opus', pWebm.audioCodec);
      ok('probe(WebM) hasAudio', pWebm.hasAudio === true);
      ok('probe(WebM) 视频码率 > 0', pWebm.videoBitrate > 0, String(pWebm.videoBitrate));
      ok('probe(WebM) 音频码率 > 0', pWebm.audioBitrate > 0, String(pWebm.audioBitrate));
      logLine('  probe(WebM): ' + probeRow(pWebm));

      pPortrait = await E.probe(samples.portrait);
      results.probe.portrait = pPortrait;
      ok('probe(竖屏) 旋转 90', pPortrait.rotation === 90, String(pPortrait.rotation));
      ok('probe(竖屏) 显示尺寸 720x1280', pPortrait.width === 720 && pPortrait.height === 1280,
        pPortrait.width + 'x' + pPortrait.height);
      ok('probe(竖屏) 视频编码 avc1', /^avc1\./.test(pPortrait.videoCodec), pPortrait.videoCodec);
      logLine('  probe(竖屏): ' + probeRow(pPortrait));

      var p180 = await E.probe(samples.rot180);
      results.probe.rot180 = p180;
      ok('probe(180°) rotation=180', p180.rotation === 180, String(p180.rotation));
      ok('probe(180°) 显示尺寸 1280x720', p180.width === 1280 && p180.height === 720, p180.width + 'x' + p180.height);

      var pMov = await E.probe(samples.mov);
      results.probe.mov = pMov;
      ok('probe(MOV) 容器 mov', pMov.container === 'mov', pMov.container);
      ok('probe(MOV) 1280x720 / avc1', pMov.width === 1280 && pMov.height === 720 && /^avc1\./.test(pMov.videoCodec),
        pMov.width + 'x' + pMov.height + ' ' + pMov.videoCodec);

      var pM4v = await E.probe(samples.m4v);
      results.probe.m4v = pM4v;
      ok('probe(M4V) 容器 mp4', pM4v.container === 'mp4', pM4v.container);

      var pAv1 = await E.probe(samples.av1);
      results.probe.av1 = pAv1;
      ok('probe(AV1/WebM) 视频编码 av01', /^av01\./.test(pAv1.videoCodec), pAv1.videoCodec);
      ok('probe(AV1/WebM) 320x180', pAv1.width === 320 && pAv1.height === 180, pAv1.width + 'x' + pAv1.height);
      ok('probe(AV1/WebM) 无音频', pAv1.hasAudio === false && pAv1.audioCodec === '', JSON.stringify({ hasAudio: pAv1.hasAudio, codec: pAv1.audioCodec }));

      var pVp8 = await E.probe(samples.vp8);
      results.probe.vp8 = pVp8;
      ok('probe(VP8/WebM) 视频编码 vp8', pVp8.videoCodec === 'vp8', pVp8.videoCodec);
      ok('probe(VP8/WebM) 640x360', pVp8.width === 640 && pVp8.height === 360, pVp8.width + 'x' + pVp8.height);

      var pMkv = await E.probe(samples.mkv);
      results.probe.mkv = pMkv;
      ok('probe(MKV) 容器 mkv', pMkv.container === 'mkv', pMkv.container);
      ok('probe(MKV) VP9 + Opus', /^vp09/.test(pMkv.videoCodec) && pMkv.audioCodec === 'opus',
        pMkv.videoCodec + ' / ' + pMkv.audioCodec);
      ok('probe(MKV) 640x360', pMkv.width === 640 && pMkv.height === 360, pMkv.width + 'x' + pMkv.height);
    } catch (e) {
      results.errors.push('probe: ' + e.stack);
      ok('probe 执行', false, e.message);
    }
    results.timing.probeMs = Date.now() - results.timing.probeStart;

    /* ---------- 2. MP4 -> MP4 720p ---------- */
    section('mp4mp4Start');
    var mp4Out = null;
    var hooks = newHooks();
    try {
      var t = Date.now();
      var r = await E.convert(samples.mp4, {
        format: 'mp4', maxWidth: 1280, maxHeight: 720,
        videoBitrate: 800, audioBitrate: 96, audio: 'keep', keyframeInterval: 2
      }, hooks);
      results.timing.mp4mp4Ms = Date.now() - t;
      mp4Out = r;
      results.mp4mp4 = { meta: r.meta };
      ok('MP4→MP4 返回 Uint8Array', r.data instanceof Uint8Array, r.data.length + ' B');
      ok('MP4→MP4 输出比输入小', r.data.length < samples.mp4.length,
        (r.data.length / 1048576).toFixed(2) + 'MB < ' + (samples.mp4.length / 1048576).toFixed(2) + 'MB');
      ok('MP4→MP4 耗时 ≤ 25s', results.timing.mp4mp4Ms <= 25000, results.timing.mp4mp4Ms + 'ms');

      var mp = await E.probe(r.data);
      results.mp4mp4.probe = mp;
      ok('MP4→MP4 probe 容器 mp4', mp.container === 'mp4', mp.container);
      ok('MP4→MP4 probe 1280x720', mp.width === 1280 && mp.height === 720, mp.width + 'x' + mp.height);
      ok('MP4→MP4 probe 时长误差 < 0.3s', approx(mp.duration, pMp4.duration, 0.3), mp.duration + ' vs ' + pMp4.duration);
      ok('MP4→MP4 probe 视频 avc1', /^avc1\./.test(mp.videoCodec), mp.videoCodec);
      ok('MP4→MP4 meta 编码与实际一致', r.meta.videoCodec === mp.videoCodec,
        r.meta.videoCodec + ' vs ' + mp.videoCodec);
      ok('MP4→MP4 probe 音频 mp4a', /^mp4a\./.test(mp.audioCodec), mp.audioCodec);
      ok('MP4→MP4 probe hasAudio', mp.hasAudio === true);
      ok('MP4→MP4 probe 音频码率 > 50kbps', mp.audioBitrate > 50, String(mp.audioBitrate));

      var ar = await audioRms(r.data);
      results.mp4mp4.audio = ar;
      ok('MP4→MP4 音频可解码且非静音', !ar.error && ar.samples > 0 && ar.rms > 0.005,
        ar.error || ('rms=' + ar.rms.toFixed(4) + ' samples=' + ar.samples + ' ch=' + ar.channels));

      var ld = await loadVideo(new Blob([r.data], { type: 'video/mp4' }));
      try {
        results.mp4mp4.video = { duration: ld.video.duration, w: ld.video.videoWidth, h: ld.video.videoHeight };
        ok('MP4→MP4 <video> loadedmetadata', true, 'duration=' + ld.video.duration.toFixed(3));
        ok('MP4→MP4 <video> 时长误差 < 0.3s', approx(ld.video.duration, pMp4.duration, 0.3),
          ld.video.duration.toFixed(3) + ' vs ' + pMp4.duration);
        ok('MP4→MP4 <video> 尺寸 1280x720', ld.video.videoWidth === 1280 && ld.video.videoHeight === 720,
          ld.video.videoWidth + 'x' + ld.video.videoHeight);
        var st = await frameStats(ld.video, 0.1);
        results.mp4mp4.frame = st;
        ok('MP4→MP4 首帧可解码（非黑像素>2%）', st.nonBlackRatio > 0.02, (st.nonBlackRatio * 100).toFixed(1) + '%');
      } finally {
        URL.revokeObjectURL(ld.url);
      }

      var mono = checkMonotonic(hooks.progress);
      ok('MP4→MP4 进度单调递增', mono.bad === 0, JSON.stringify(mono));
      ok('MP4→MP4 进度到 1', mono.last === 1, 'last=' + mono.last);
    } catch (e) {
      results.errors.push('mp4mp4: ' + e.stack);
      ok('MP4→MP4 转码', false, e.message);
    }
    results.timing.mp4mp4End = Date.now();

    /* ---------- 3. MP4 -> WebM ---------- */
    section('mp4webmStart');
    try {
      var t2 = Date.now();
      var r2 = await E.convert(samples.mp4, {
        format: 'webm', maxWidth: 854, maxHeight: 480,
        videoBitrate: 700, audioBitrate: 96, audio: 'keep'
      }, newHooks());
      results.timing.mp4webmMs = Date.now() - t2;
      results.mp4webm = { meta: r2.meta };
      ok('MP4→WebM 耗时记录', true, results.timing.mp4webmMs + 'ms');
      var wp = await E.probe(r2.data);
      results.mp4webm.probe = wp;
      ok('MP4→WebM probe 容器 webm', wp.container === 'webm', wp.container);
      ok('MP4→WebM probe 854x480', wp.width === 854 && wp.height === 480, wp.width + 'x' + wp.height);
      ok('MP4→WebM probe 时长误差 < 0.3s', approx(wp.duration, pMp4.duration, 0.3), wp.duration + ' vs ' + pMp4.duration);
      ok('MP4→WebM probe 视频 VP9/VP8', /^vp0?9|^vp8/.test(wp.videoCodec), wp.videoCodec);
      ok('MP4→WebM probe 音频 opus', wp.audioCodec === 'opus', wp.audioCodec);
      ok('MP4→WebM probe hasAudio', wp.hasAudio === true);
      ok('MP4→WebM probe 音频码率 > 50kbps', wp.audioBitrate > 50, String(wp.audioBitrate));

      var ar2 = await audioRms(r2.data);
      results.mp4webm.audio = ar2;
      ok('MP4→WebM 音频可解码且非静音', !ar2.error && ar2.samples > 0 && ar2.rms > 0.005,
        ar2.error || ('rms=' + ar2.rms.toFixed(4) + ' samples=' + ar2.samples + ' ch=' + ar2.channels));

      var ld2 = await loadVideo(new Blob([r2.data], { type: 'video/webm' }));
      try {
        results.mp4webm.video = { duration: ld2.video.duration, w: ld2.video.videoWidth, h: ld2.video.videoHeight };
        ok('MP4→WebM <video> 时长误差 < 0.3s', approx(ld2.video.duration, pMp4.duration, 0.3),
          ld2.video.duration.toFixed(3) + ' vs ' + pMp4.duration);
        ok('MP4→WebM <video> 尺寸 854x480', ld2.video.videoWidth === 854 && ld2.video.videoHeight === 480,
          ld2.video.videoWidth + 'x' + ld2.video.videoHeight);
        var st2 = await frameStats(ld2.video, 0.1);
        ok('MP4→WebM 首帧可解码', st2.nonBlackRatio > 0.02, (st2.nonBlackRatio * 100).toFixed(1) + '%');
      } finally {
        URL.revokeObjectURL(ld2.url);
      }
    } catch (e) {
      results.errors.push('mp4webm: ' + e.stack);
      ok('MP4→WebM 转码', false, e.message);
    }
    results.timing.mp4webmEnd = Date.now();

    /* ---------- 4. WebM -> MP4 ---------- */
    section('webmmp4Start');
    try {
      var t3 = Date.now();
      var r3 = await E.convert(samples.webm, {
        format: 'mp4', maxWidth: 854, maxHeight: 480,
        videoBitrate: 700, audioBitrate: 96, audio: 'keep'
      }, newHooks());
      results.timing.webmmp4Ms = Date.now() - t3;
      results.webmmp4 = { meta: r3.meta };
      var mp3 = await E.probe(r3.data);
      results.webmmp4.probe = mp3;
      ok('WebM→MP4 probe 容器 mp4', mp3.container === 'mp4', mp3.container);
      ok('WebM→MP4 probe 854x480', mp3.width === 854 && mp3.height === 480, mp3.width + 'x' + mp3.height);
      ok('WebM→MP4 probe 时长误差 < 0.35s', approx(mp3.duration, pWebm.duration, 0.35), mp3.duration + ' vs ' + pWebm.duration);
      ok('WebM→MP4 probe 视频 avc1', /^avc1\./.test(mp3.videoCodec), mp3.videoCodec);
      ok('WebM→MP4 probe 音频 mp4a', /^mp4a\./.test(mp3.audioCodec), mp3.audioCodec);
      var ld3 = await loadVideo(new Blob([r3.data], { type: 'video/mp4' }));
      try {
        results.webmmp4.video = { duration: ld3.video.duration, w: ld3.video.videoWidth, h: ld3.video.videoHeight };
        ok('WebM→MP4 <video> 时长误差 < 0.35s', approx(ld3.video.duration, pWebm.duration, 0.35),
          ld3.video.duration.toFixed(3) + ' vs ' + pWebm.duration);
        var st3 = await frameStats(ld3.video, 0.1);
        ok('WebM→MP4 首帧可解码', st3.nonBlackRatio > 0.02, (st3.nonBlackRatio * 100).toFixed(1) + '%');
      } finally {
        URL.revokeObjectURL(ld3.url);
      }
    } catch (e) {
      results.errors.push('webmmp4: ' + e.stack);
      ok('WebM→MP4 转码', false, e.message);
    }
    results.timing.webmmp4End = Date.now();

    /* ---------- 4b. 其它输入编码 / 容器 + 组长复现场景 ---------- */
    try {
      // AV1 -> MP4
      var ra = await E.convert(samples.av1, { format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'drop' }, newHooks());
      var pa = await E.probe(ra.data);
      results.av1mp4 = { meta: ra.meta, probe: pa };
      ok('AV1→MP4 输出 mp4 320x180', pa.container === 'mp4' && pa.width === 320 && pa.height === 180,
        pa.container + ' ' + pa.width + 'x' + pa.height);
      ok('AV1→MP4 时长误差 < 0.3s', approx(pa.duration, pAv1.duration, 0.3), pa.duration + ' vs ' + pAv1.duration);
      var lda = await loadVideo(new Blob([ra.data], { type: 'video/mp4' }));
      try {
        var sa = await frameStats(lda.video, 0.2);
        ok('AV1→MP4 可被 <video> 解码且首帧非黑', lda.video.duration > 0 && sa.nonBlackRatio > 0.02,
          'duration=' + lda.video.duration.toFixed(3) + ' nonBlack=' + (sa.nonBlackRatio * 100).toFixed(1) + '%');
      } finally { URL.revokeObjectURL(lda.url); }

      // VP8 -> MP4
      var rv = await E.convert(samples.vp8, { format: 'mp4', maxWidth: 640, maxHeight: 360, videoBitrate: 400, audio: 'drop' }, newHooks());
      var pv = await E.probe(rv.data);
      results.vp8mp4 = { meta: rv.meta, probe: pv };
      ok('VP8→MP4 输出 640x360 avc1', pv.width === 640 && pv.height === 360 && /^avc1\./.test(pv.videoCodec),
        pv.width + 'x' + pv.height + ' ' + pv.videoCodec);
      var ldv = await loadVideo(new Blob([rv.data], { type: 'video/mp4' }));
      try {
        var sv = await frameStats(ldv.video, 0.2);
        ok('VP8→MP4 可被 <video> 解码且首帧非黑', ldv.video.duration > 0 && sv.nonBlackRatio > 0.02,
          'duration=' + ldv.video.duration.toFixed(3) + ' nonBlack=' + (sv.nonBlackRatio * 100).toFixed(1) + '%');
      } finally { URL.revokeObjectURL(ldv.url); }

      // MKV -> MP4（含 Opus 音频）
      var rk = await E.convert(samples.mkv, { format: 'mp4', maxWidth: 640, maxHeight: 360, videoBitrate: 400, audio: 'keep', audioBitrate: 96 }, newHooks());
      var pk = await E.probe(rk.data);
      var ark = await audioRms(rk.data);
      results.mkvmp4 = { meta: rk.meta, probe: pk, audio: ark };
      ok('MKV→MP4 容器/尺寸正确', pk.container === 'mp4' && pk.width === 640 && pk.height === 360,
        pk.container + ' ' + pk.width + 'x' + pk.height);
      ok('MKV→MP4 保留音频且非静音', pk.hasAudio && !ark.error && ark.rms > 0.005,
        JSON.stringify({ hasAudio: pk.hasAudio, rms: ark.rms, err: ark.error }));

      // MOV -> MP4
      var rm = await E.convert(samples.mov, { format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'drop' }, newHooks());
      var pm = await E.probe(rm.data);
      results.movmp4 = { meta: rm.meta, probe: pm };
      ok('MOV→MP4 转码成功', pm.container === 'mp4' && pm.width === 320 && pm.height === 180,
        pm.container + ' ' + pm.width + 'x' + pm.height);

      // 组长复现场景：WebM→MP4 640x360 / fps=30 / 800kbps / 保留音频 96kbps
      var rr = await E.convert(samples.webm, {
        format: 'mp4', maxWidth: 640, maxHeight: 360, fps: 30,
        videoBitrate: 800, audio: 'keep', audioBitrate: 96
      }, newHooks());
      var pr = await E.probe(rr.data);
      var arr = await audioRms(rr.data);
      results.repro = { meta: rr.meta, probe: pr, audio: arr };
      ok('复现：WebM→MP4 640x360 成功', pr.container === 'mp4' && pr.width === 640 && pr.height === 360,
        pr.container + ' ' + pr.width + 'x' + pr.height);
      ok('复现：WebM→MP4 时长正确', approx(pr.duration, pWebm.duration, 0.35), pr.duration + ' vs ' + pWebm.duration);
      ok('复现：WebM→MP4 音频保留', pr.hasAudio && !arr.error && arr.rms > 0.005,
        JSON.stringify({ hasAudio: pr.hasAudio, rms: arr.rms, err: arr.error }));
      var ldr = await loadVideo(new Blob([rr.data], { type: 'video/mp4' }));
      try {
        ok('复现：WebM→MP4 <video> 可加载', ldr.video.duration > 0,
          'duration=' + ldr.video.duration.toFixed(3) + ' ' + ldr.video.videoWidth + 'x' + ldr.video.videoHeight);
      } finally { URL.revokeObjectURL(ldr.url); }
    } catch (e) {
      results.errors.push('codecs/containers: ' + e.stack);
      ok('其它编码/容器转换', false, e.message);
    }

    /* ---------- 4c. 真实世界编码器产出的样本（非本仓库 muxer 生成） ---------- */
    try {
      var rmp = await E.probe(samples.realMp4);
      results.realMp4 = { probe: rmp };
      ok('真实样本 H.264 MP4 probe', rmp.container === 'mp4' && rmp.width === 640 && rmp.height === 360 && /^avc1\./.test(rmp.videoCodec),
        probeRow(rmp));
      var rw = await E.convert(samples.realMp4, { format: 'webm', maxWidth: 640, maxHeight: 360, videoBitrate: 700, audio: 'keep' }, newHooks());
      var rwp = await E.probe(rw.data);
      results.realMp4.out = { meta: rw.meta, probe: rwp };
      ok('真实 H.264 MP4 → WebM 成功', rwp.container === 'webm' && rwp.width === 640 && rwp.height === 360,
        probeRow(rwp));
      var ldrm = await loadVideo(new Blob([rw.data], { type: 'video/webm' }));
      try {
        ok('真实 H.264 MP4 → WebM 可被 <video> 加载', approx(ldrm.video.duration, rmp.duration, 0.35),
          'duration=' + ldrm.video.duration.toFixed(3) + ' vs ' + rmp.duration);
      } finally { URL.revokeObjectURL(ldrm.url); }

      var rwm = await E.probe(samples.realWebm);
      results.realWebm = { probe: rwm };
      ok('真实样本 VP9 WebM probe', rwm.container === 'webm' && rwm.width === 640 && /^vp09/.test(rwm.videoCodec),
        probeRow(rwm));
      var rwmOut = await E.convert(samples.realWebm, { format: 'mp4', maxWidth: 640, maxHeight: 360, videoBitrate: 700, audio: 'keep' }, newHooks());
      var rwmp = await E.probe(rwmOut.data);
      results.realWebm.out = { meta: rwmOut.meta, probe: rwmp };
      ok('真实 VP9 WebM → MP4 成功', rwmp.container === 'mp4' && /^avc1\./.test(rwmp.videoCodec),
        probeRow(rwmp));
      var ldrw = await loadVideo(new Blob([rwmOut.data], { type: 'video/mp4' }));
      try {
        ok('真实 VP9 WebM → MP4 可被 <video> 加载', approx(ldrw.video.duration, rwm.duration, 0.35),
          'duration=' + ldrw.video.duration.toFixed(3) + ' vs ' + rwm.duration);
      } finally { URL.revokeObjectURL(ldrw.url); }
    } catch (e) {
      results.errors.push('realWorld: ' + e.stack);
      ok('真实世界样本', false, e.message);
    }

    /* ---------- 4d. 44.1kHz AAC / 单声道音频 ---------- */
    try {
      var p44 = await E.probe(samples.aac44);
      results.aac44 = { probe: p44 };
      ok('44.1kHz AAC MP4 probe', p44.container === 'mp4' && p44.hasAudio === true && p44.width === 320,
        probeRow(p44));
      var r44 = await E.convert(samples.aac44, {
        format: 'webm', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'keep', audioBitrate: 96
      }, newHooks());
      var p44o = await E.probe(r44.data);
      var a44 = await audioRms(r44.data);
      results.aac44.out = { meta: r44.meta, probe: p44o, audio: a44 };
      ok('44.1k AAC → WebM：重采样到 48k 且非静音',
        p44o.container === 'webm' && p44o.hasAudio && !a44.error && a44.rms > 0.005 && a44.sampleRate === 48000,
        JSON.stringify({ container: p44o.container, hasAudio: p44o.hasAudio, sr: a44.sampleRate, rms: a44.rms, err: a44.error }));

      var pMono = await E.probe(samples.mono);
      results.mono = { probe: pMono };
      ok('单声道 Opus WebM probe', pMono.hasAudio === true && pMono.audioCodec === 'opus', probeRow(pMono));
      var rMono = await E.convert(samples.mono, {
        format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'keep', audioBitrate: 96
      }, newHooks());
      var pMonoOut = await E.probe(rMono.data);
      var aMono = await audioRms(rMono.data);
      results.mono.mp4 = { meta: rMono.meta, probe: pMonoOut, audio: aMono };
      ok('单声道 Opus → MP4 AAC（可解码且非静音）',
        pMonoOut.hasAudio === true && !aMono.error && aMono.rms > 0.005 && (aMono.channels === 1 || aMono.channels === 2),
        JSON.stringify({ channels: aMono.channels, rms: aMono.rms, notes: rMono.meta.notes, err: aMono.error }));
      var rMonoWebm = await E.convert(samples.mono, {
        format: 'webm', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'keep'
      }, newHooks());
      var aMonoWebm = await audioRms(rMonoWebm.data);
      results.mono.webm = { meta: rMonoWebm.meta, audio: aMonoWebm };
      ok('单声道 → WebM 保持单声道且非静音',
        !aMonoWebm.error && aMonoWebm.channels === 1 && aMonoWebm.rms > 0.005,
        JSON.stringify({ channels: aMonoWebm.channels, rms: aMonoWebm.rms, err: aMonoWebm.error }));
    } catch (e) {
      results.errors.push('audio44/mono: ' + e.stack);
      ok('44.1kHz / 单声道音频', false, e.message);
    }

    /* ---------- 5. 帧率限制 24fps ---------- */
    section('fpsStart');
    try {
      var r4 = await E.convert(samples.mp4, {
        format: 'mp4', maxWidth: 854, maxHeight: 480,
        videoBitrate: 600, audio: 'drop', fps: 24
      }, newHooks());
      var fp = await E.probe(r4.data);
      results.fps24 = { meta: r4.meta, probe: fp };
      ok('fps=24 输出帧率≈24', approx(fp.fps, 24, 1.5), String(fp.fps));
      ok('fps=24 时长误差 < 0.35s', approx(fp.duration, pMp4.duration, 0.35), fp.duration + ' vs ' + pMp4.duration);
      ok('fps=24 音频按参数丢弃', fp.hasAudio === false && r4.meta.audioCodec === '',
        JSON.stringify({ hasAudio: fp.hasAudio, codec: r4.meta.audioCodec }));
      ok('fps=24 meta.notes 非空', r4.meta.notes.length > 0, JSON.stringify(r4.meta.notes));
    } catch (e) {
      results.errors.push('fps24: ' + e.stack);
      ok('fps=24 转码', false, e.message);
    }

    /* ---------- 5b. 奇数尺寸 / File 输入 / 未知格式 ---------- */
    try {
      var fileInput = new File([samples.mp4], 'input.mp4', { type: 'video/mp4' });
      var r8 = await E.convert(fileInput, {
        format: 'mp4', maxWidth: 641, maxHeight: 361, videoBitrate: 300, audio: 'drop'
      }, newHooks());
      var p8 = await E.probe(r8.data);
      results.odd = { probe: p8 };
      ok('File 输入可用', r8.data.length > 1000, r8.data.length + ' B');
      ok('输出宽高为偶数', p8.width % 2 === 0 && p8.height % 2 === 0, p8.width + 'x' + p8.height);
      ok('maxWidth 等比缩放生效', p8.width <= 642 && p8.height <= 362, p8.width + 'x' + p8.height);
    } catch (e) {
      results.errors.push('odd: ' + e.stack);
      ok('奇数尺寸 / File 输入', false, e.message);
    }
    try {
      await E.probe(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
      ok('probe 未知格式应抛错', false, '未抛错');
    } catch (e) {
      ok('probe 未知格式应抛错', /无法识别/.test(e.message), e.message);
    }

    /* ---------- 6. 竖屏旋转 ---------- */
    section('rotStart');
    try {
      var r5 = await E.convert(samples.portrait, {
        format: 'mp4', maxWidth: 720, maxHeight: 1280, videoBitrate: 700, audio: 'keep'
      }, newHooks());
      var rp = await E.probe(r5.data);
      results.rotated = { meta: r5.meta, probe: rp };
      ok('竖屏 输出 720x1280', rp.width === 720 && rp.height === 1280, rp.width + 'x' + rp.height);
      ok('竖屏 输出 rotation=0', rp.rotation === 0, String(rp.rotation));
      ok('竖屏 输出时长误差 < 0.3s', approx(rp.duration, pPortrait.duration, 0.3), rp.duration + ' vs ' + pPortrait.duration);
      var ld5 = await loadVideo(new Blob([r5.data], { type: 'video/mp4' }));
      try {
        ok('竖屏 <video> 尺寸 720x1280', ld5.video.videoWidth === 720 && ld5.video.videoHeight === 1280,
          ld5.video.videoWidth + 'x' + ld5.video.videoHeight);
        var st5 = await frameStats(ld5.video, 0.1);
        results.rotated.frame = st5;
        // 源画面左上角红块，顺时针 90° 后应出现在右上角
        var tl = st5.topLeft, tr = st5.topRight;
        ok('竖屏 画面实际旋转（红块在右上）', tr.r > tl.r + 40 && tr.r > 80,
          JSON.stringify({ topLeft: tl, topRight: tr }));
      } finally {
        URL.revokeObjectURL(ld5.url);
      }
    } catch (e) {
      results.errors.push('rotated: ' + e.stack);
      ok('竖屏 转码', false, e.message);
    }

    /* ---------- 6b. 180° 旋转画面方向 ---------- */
    try {
      var r180 = await E.convert(samples.rot180, {
        format: 'mp4', maxWidth: 480, maxHeight: 270, videoBitrate: 500, audio: 'drop'
      }, newHooks());
      var p180o = await E.probe(r180.data);
      results.rot180out = { meta: r180.meta, probe: p180o };
      ok('180° 输出尺寸 480x270', p180o.width === 480 && p180o.height === 270, p180o.width + 'x' + p180o.height);
      var ld180 = await loadVideo(new Blob([r180.data], { type: 'video/mp4' }));
      try {
        var st180 = await frameStats(ld180.video, 0.1);
        results.rot180out.frame = st180;
        ok('180° 画面实际旋转（红块在右下）',
          st180.bottomRight.r > st180.topLeft.r + 40 && st180.bottomRight.r > 80,
          JSON.stringify({ topLeft: st180.topLeft, bottomRight: st180.bottomRight }));
      } finally { URL.revokeObjectURL(ld180.url); }
    } catch (e) {
      results.errors.push('rot180: ' + e.stack);
      ok('180° 旋转转码', false, e.message);
    }

    /* ---------- 6c. 优雅降级 ---------- */
    var origAenc = AudioEncoder.isConfigSupported;
    try {
      AudioEncoder.isConfigSupported = function (cfg) {
        if (cfg && cfg.codec === 'mp4a.40.2') return Promise.resolve({ supported: false });
        return origAenc.call(AudioEncoder, cfg);
      };
      var rd = await E.convert(samples.mp4, { format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 250, audio: 'keep' }, newHooks());
      var pd = await E.probe(rd.data);
      results.degradeNoAac = { meta: rd.meta, probe: pd };
      ok('AAC 编码不可用 → 输出仅视频 MP4', pd.hasAudio === false && pd.width === 320,
        JSON.stringify({ hasAudio: pd.hasAudio, notes: rd.meta.notes }));
      ok('AAC 编码不可用 → notes 注明原因', rd.meta.notes.join('|').indexOf('AAC') >= 0, rd.meta.notes.join(' | '));
    } catch (e) {
      results.errors.push('degradeNoAac: ' + e.stack);
      ok('AAC 降级测试', false, e.message);
    } finally {
      AudioEncoder.isConfigSupported = origAenc;
    }

    var origAdec = AudioDecoder.isConfigSupported;
    try {
      AudioDecoder.isConfigSupported = function () { return Promise.resolve({ supported: false }); };
      var rd2 = await E.convert(samples.webm, { format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 250, audio: 'keep' }, newHooks());
      var pd2 = await E.probe(rd2.data);
      results.degradeNoDecode = { meta: rd2.meta, probe: pd2 };
      ok('音频解码不可用 → 视频照转、音频丢弃', pd2.hasAudio === false && rd2.data.length > 1000,
        JSON.stringify({ hasAudio: pd2.hasAudio, notes: rd2.meta.notes }));
      ok('音频解码不可用 → notes 注明原因', rd2.meta.notes.join('|').indexOf('无法解码') >= 0, rd2.meta.notes.join(' | '));
    } catch (e) {
      results.errors.push('degradeNoDecode: ' + e.stack);
      ok('音频解码降级测试', false, e.message);
    } finally {
      AudioDecoder.isConfigSupported = origAdec;
    }

    /* ---------- 7. 取消 ---------- */
    section('cancelStart');
    try {
      var cancelled = false;
      var cHooks = {
        onProgress: function () { },
        onLog: function () { },
        isCancelled: function () { return cancelled; }
      };
      setTimeout(function () { cancelled = true; }, 250);
      var threw = null;
      var t6 = Date.now();
      try {
        await E.convert(samples.mp4, {
          format: 'mp4', maxWidth: 1280, maxHeight: 720, videoBitrate: 2000, audio: 'keep'
        }, cHooks);
      } catch (ee) {
        threw = ee;
      }
      var cancelMs = Date.now() - t6;
      results.cancel = { message: threw ? threw.message : '', ms: cancelMs };
      ok('取消：convert 被 reject', !!threw, threw ? threw.message : '没有抛错');
      ok('取消：错误信息为「已取消」', !!threw && threw.message === '已取消', threw ? threw.message : '');
      ok('取消：快速停止（< 8s）', cancelMs < 8000, cancelMs + 'ms');

      // 取消后引擎仍可用
      var r7 = await E.convert(samples.mp4, { format: 'mp4', maxWidth: 320, maxHeight: 180, audio: 'drop', videoBitrate: 300 }, newHooks());
      ok('取消后再次转码可用', r7.data.length > 1000, r7.data.length + ' B');
    } catch (e) {
      results.errors.push('cancel: ' + e.stack);
      ok('取消测试', false, e.message);
    }

    results.totalMs = Date.now() - t0;
    results.failed = tests.filter(function (x) { return !x.pass; }).length;
    logLine('---- 结束：' + (tests.length - results.failed) + '/' + tests.length + ' 通过，' + results.totalMs + 'ms ----');
    return results;
  }

  window.__runVideoTests = run;
  window.__videoTestReady = true;
  logLine('VideoEngine ' + (E ? E.version : '(未加载)') + ' 就绪');
})();
