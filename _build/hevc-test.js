/* VideoEngine HEVC 软解测试套件（file:// 页面，File 输入，由 run-hevc-tests.js 通过 CDP 驱动） */
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
  function round(v, n) { var p = Math.pow(10, n || 3); return Math.round(v * p) / p; }

  function getFiles() {
    var inp = document.getElementById('hevcFile');
    var map = {};
    if (!inp || !inp.files) return map;
    for (var i = 0; i < inp.files.length; i++) map[inp.files[i].name] = inp.files[i];
    return map;
  }

  async function bytesOf(file) { return new Uint8Array(await file.arrayBuffer()); }

  function loadVideo(data, type) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([data], { type: type }));
      var v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        reject(new Error('video loadedmetadata 超时'));
      }, 12000);
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
        reject(new Error('video 加载失败 code=' + (v.error ? v.error.code : '?')));
      };
      v.src = url;
    });
  }

  function waitFrame(v) {
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (!done) { done = true; resolve(); } }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 900);
    });
  }

  async function frameStats(v, t) {
    if (Math.abs(v.currentTime - t) > 0.01) {
      await new Promise(function (resolve) {
        var done = false;
        function fin() { if (!done) { done = true; resolve(); } }
        v.addEventListener('seeked', fin, { once: true });
        v.currentTime = t;
        setTimeout(fin, 4000);
      });
    }
    await waitFrame(v);
    var c = document.createElement('canvas');
    c.width = v.videoWidth || 1;
    c.height = v.videoHeight || 1;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var nb = 0, total = 0;
    for (var i = 0; i < d.length; i += 4) {
      total++;
      if (d[i] + d[i + 1] + d[i + 2] > 24) nb++;
    }
    return { width: c.width, height: c.height, nonBlackRatio: total ? nb / total : 0 };
  }

  async function audioRms(data) {
    var src = await E._internal.readSource(data, true);
    if (!src.hasAudio || !src.audioSamples || !src.audioSamples.length) {
      return { error: '没有音频样本', hasAudio: src.hasAudio };
    }
    var cfg = {
      codec: src.audioCodec,
      sampleRate: src.audioSampleRate,
      numberOfChannels: src.audioChannels
    };
    if (src.audioDescription && src.audioDescription.length) cfg.description = src.audioDescription;
    if (String(src.audioCodec).indexOf('mp4a') === 0 && !cfg.description) {
      cfg.description = E._internal.makeAsc(cfg.sampleRate, cfg.numberOfChannels);
    }
    var support = await AudioDecoder.isConfigSupported(cfg);
    if (!support.supported) return { error: 'AudioDecoder 不支持 ' + src.audioCodec };
    var sum = 0, count = 0, err = null;
    var dec = new AudioDecoder({
      output: function (ad) {
        try {
          var a = new Float32Array(ad.numberOfFrames);
          ad.copyTo(a, { planeIndex: 0, format: 'f32-planar' });
          for (var i = 0; i < a.length; i++) { sum += a[i] * a[i]; count++; }
        } catch (e) { err = e; }
        try { ad.close(); } catch (e2) { }
      },
      error: function (e) { err = e; }
    });
    dec.configure(cfg);
    try {
      var limit = Math.min(src.audioSamples.length, 30);
      for (var i = 0; i < limit; i++) {
        var s = src.audioSamples[i];
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.ts, duration: s.dur || 20000, data: s.data }));
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

  function patchHvcCChroma(bytes, value) {
    var copy = new Uint8Array(bytes);
    for (var i = 0; i < copy.length - 8; i++) {
      if (copy[i] === 0x68 && copy[i + 1] === 0x76 && copy[i + 2] === 0x63 && copy[i + 3] === 0x43) {
        var payload = i + 4;
        copy[payload + 16] = (copy[payload + 16] & 0xFC) | (value & 3);
        return copy;
      }
    }
    return null;
  }

  function newHooks() {
    var progress = [];
    var hook = {
      progress: progress,
      onProgress: function (p) { progress.push(round(p, 4)); },
      onLog: function (m) { logLine('  [log] ' + m); },
      isCancelled: function () { return false; }
    };
    return hook;
  }

  function monoCheck(p) {
    var bad = 0;
    for (var i = 1; i < p.length; i++) if (p[i] < p[i - 1]) bad++;
    return { bad: bad, count: p.length, first: p.length ? p[0] : -1, last: p.length ? p[p.length - 1] : -1 };
  }

  window.__runHevcTests = async function () {
    var results = { checks: tests, errors: [], timing: {} };
    var t0 = Date.now();
    var files = getFiles();
    results.files = Object.keys(files).map(function (k) { return k + ':' + files[k].size; });
    logLine('文件：' + results.files.join(', '));

    if (!files['hevc-portrait-rot90.mp4'] || !files['hevc-1080-hvc1-H120.mp4'] || !files['hevc-360-1mb.mp4']) {
      ok('HEVC 样本就绪', false, JSON.stringify(results.files));
      return results;
    }

    /* ---- 1. support ---- */
    try {
      var caps = await E.support();
      results.support = caps;
      ok('support(): decode.hevc 原生能力如实上报', typeof caps.decode.hevc === 'boolean', String(caps.decode.hevc));
      ok('support(): decode.hevcSoftware = true', caps.decode.hevcSoftware === true);
      ok('VideoEngine.hevcSoftware = true', E.hevcSoftware === true);
    } catch (e) {
      results.errors.push('support: ' + e.stack);
      ok('support()', false, e.message);
    }

    /* ---- 2. probe ---- */
    var pPortrait, p120, pHev1;
    try {
      var t = Date.now();
      pPortrait = await E.probe(files['hevc-portrait-rot90.mp4']);
      p120 = await E.probe(files['hevc-1080-hvc1-H120.mp4']);
      pHev1 = await E.probe(files['hevc-360-1mb.mp4']);
      results.timing.probeMs = Date.now() - t;
      results.probe = { portrait: pPortrait, hvc1H120: p120, hev1: pHev1 };
      ok('probe(竖屏 HEVC) 容器 mp4', pPortrait.container === 'mp4', pPortrait.container);
      ok('probe(竖屏 HEVC) 旋转 90 / 720x1280', pPortrait.rotation === 90 && pPortrait.width === 720 && pPortrait.height === 1280,
        pPortrait.rotation + '° ' + pPortrait.width + 'x' + pPortrait.height);
      ok('probe(竖屏 HEVC) 编码 hvc1', /^hvc1\./.test(pPortrait.videoCodec), pPortrait.videoCodec);
      ok('probe(竖屏 HEVC) 时长≈10s', approx(pPortrait.duration, 10, 0.3), String(pPortrait.duration));
      ok('probe(竖屏 HEVC) 带 AAC 音频', pPortrait.hasAudio && /^mp4a\.40/.test(pPortrait.audioCodec),
        pPortrait.audioCodec + ' ' + pPortrait.audioBitrate + 'kbps');

      ok('probe(hvc1.1.6.H120.90) 编码串匹配 iPhone', /^hvc1\.1\.6\.H120\./.test(p120.videoCodec), p120.videoCodec);
      ok('probe(hvc1.1.6.H120.90) 1920x1080', p120.width === 1920 && p120.height === 1080,
        p120.width + 'x' + p120.height);
      ok('probe(hev1) 编码 hev1', /^hev1\./.test(pHev1.videoCodec), pHev1.videoCodec);
    } catch (e) {
      results.errors.push('probe: ' + e.stack);
      ok('probe HEVC', false, e.message);
    }

    /* ---- 3. hev1 360p 软解（快速冒烟） ---- */
    try {
      var hookA = newHooks();
      var tA = Date.now();
      var rA = await E.convert(files['hevc-360-1mb.mp4'], {
        format: 'mp4', maxWidth: 640, maxHeight: 360, videoBitrate: 700, audio: 'drop'
      }, hookA);
      results.timing.hev1Ms = Date.now() - tA;
      var pA = await E.probe(rA.data);
      results.hev1 = { meta: rA.meta, probe: pA, ms: results.timing.hev1Ms };
      ok('hev1→MP4 成功（软解）', pA.container === 'mp4' && pA.width === 640 && pA.height === 360,
        pA.container + ' ' + pA.width + 'x' + pA.height + ' ' + results.timing.hev1Ms + 'ms');
      ok('hev1→MP4 时长误差 <0.4s', approx(pA.duration, pHev1.duration, 0.4), pA.duration + ' vs ' + pHev1.duration);
      ok('hev1→MP4 notes 注明软解', rA.meta.notes.join('|').indexOf('软解') >= 0, rA.meta.notes.join(' | '));
      var monoA = monoCheck(hookA.progress);
      ok('hev1→MP4 进度单调且到 1', monoA.bad === 0 && monoA.last === 1, JSON.stringify(monoA));
      var ldA = await loadVideo(rA.data, 'video/mp4');
      try {
        var stA = await frameStats(ldA.video, 0.2);
        ok('hev1→MP4 <video> 可加载且首帧非黑', approx(ldA.video.duration, pHev1.duration, 0.4) && stA.nonBlackRatio > 0.02,
          'duration=' + round(ldA.video.duration) + ' nonBlack=' + round(stA.nonBlackRatio * 100, 1) + '%');
      } finally { URL.revokeObjectURL(ldA.url); }
    } catch (e) {
      results.errors.push('hev1: ' + e.stack);
      ok('hev1→MP4', false, e.message);
    }

    /* ---- 4. 竖屏 90° + AAC 保留 ---- */
    try {
      var hookB = newHooks();
      var tB = Date.now();
      var rB = await E.convert(files['hevc-portrait-rot90.mp4'], {
        format: 'mp4', maxWidth: 720, maxHeight: 1280, videoBitrate: 1200, audio: 'keep', audioBitrate: 96
      }, hookB);
      results.timing.portraitMs = Date.now() - tB;
      var pB = await E.probe(rB.data);
      var audioB = await audioRms(rB.data);
      results.portrait = { meta: rB.meta, probe: pB, audio: audioB, ms: results.timing.portraitMs };
      ok('竖屏 HEVC→MP4 720x1280 / rotation=0', pB.width === 720 && pB.height === 1280 && pB.rotation === 0,
        pB.width + 'x' + pB.height + ' rot=' + pB.rotation);
      ok('竖屏 HEVC→MP4 时长误差 <0.4s', approx(pB.duration, pPortrait.duration, 0.4), pB.duration + ' vs ' + pPortrait.duration);
      ok('竖屏 HEVC→MP4 AAC 保留且非静音', pB.hasAudio && !audioB.error && audioB.rms > 0.005,
        JSON.stringify({ hasAudio: pB.hasAudio, rms: round(audioB.rms, 4), err: audioB.error }));
      ok('竖屏 HEVC→MP4 meta.notes 含软解说明', rB.meta.notes.join('|').indexOf('软解') >= 0, rB.meta.notes.join(' | '));
      var monoB = monoCheck(hookB.progress);
      ok('竖屏 HEVC→MP4 进度单调且到 1', monoB.bad === 0 && monoB.last === 1, JSON.stringify(monoB));

      var ldB = await loadVideo(rB.data, 'video/mp4');
      try {
        var stB = await frameStats(ldB.video, 0.2);
        results.portrait.play = { w: ldB.video.videoWidth, h: ldB.video.videoHeight, dur: ldB.video.duration, nonBlack: stB.nonBlackRatio };
        ok('竖屏 HEVC→MP4 <video> 尺寸/时长/首帧', ldB.video.videoWidth === 720 && ldB.video.videoHeight === 1280 &&
          approx(ldB.video.duration, pPortrait.duration, 0.4) && stB.nonBlackRatio > 0.02,
          JSON.stringify(results.portrait.play));
      } finally { URL.revokeObjectURL(ldB.url); }
    } catch (e) {
      results.errors.push('portrait: ' + e.stack);
      ok('竖屏 HEVC→MP4', false, e.message);
    }

    /* ---- 5. 1080p hvc1.1.6.H120.90 速度（模拟 iPhone 1080x1920 像素量） ---- */
    try {
      var tC = Date.now();
      var rC = await E.convert(files['hevc-1080-hvc1-H120.mp4'], {
        format: 'mp4', maxWidth: 1920, maxHeight: 1080, videoBitrate: 4000, audio: 'drop'
      }, null);
      var msC = Date.now() - tC;
      var pC = await E.probe(rC.data);
      var frames = p120.fps * p120.duration;
      var speed = frames / (msC / 1000);
      results.hd = {
        ms: msC, meta: rC.meta, probe: pC, frames: Math.round(frames),
        decodeEncodeFps: round(speed, 2),
        realtimeFactor: round(p120.duration / (msC / 1000), 2),
        estimate68sSec: round(msC / 1000 * 68 / p120.duration, 1)
      };
      ok('1080p HEVC 软解→H.264 成功', pC.width === 1920 && pC.height === 1080 && /^avc1\./.test(pC.videoCodec),
        pC.width + 'x' + pC.height + ' ' + pC.videoCodec);
      ok('1080p 转码时长误差 <0.4s', approx(pC.duration, p120.duration, 0.4), pC.duration + ' vs ' + p120.duration);
      ok('1080p 软解速度 > 10 fps', speed > 10, round(speed, 2) + ' fps，' + results.hd.realtimeFactor + '× 实时，68s 预估 ' + results.hd.estimate68sSec + 's');
      var ldC = await loadVideo(rC.data, 'video/mp4');
      try {
        var stC = await frameStats(ldC.video, 0.2);
        ok('1080p 输出 <video> 可加载且首帧非黑', approx(ldC.video.duration, p120.duration, 0.4) && stC.nonBlackRatio > 0.02,
          'duration=' + round(ldC.video.duration) + ' nonBlack=' + round(stC.nonBlackRatio * 100, 1) + '%');
      } finally { URL.revokeObjectURL(ldC.url); }
    } catch (e) {
      results.errors.push('hd: ' + e.stack);
      ok('1080p HEVC 软解', false, e.message);
    }

    /* ---- 6. 取消 ---- */
    try {
      var cancelled = false;
      var tD = Date.now();
      var errD = null;
      setTimeout(function () { cancelled = true; }, 300);
      try {
        await E.convert(files['hevc-portrait-rot90.mp4'], {
          format: 'mp4', maxWidth: 720, maxHeight: 1280, videoBitrate: 1200, audio: 'keep'
        }, {
          onProgress: function () { },
          isCancelled: function () { return cancelled; }
        });
      } catch (e) { errD = e; }
      var msD = Date.now() - tD;
      results.cancel = { message: errD ? errD.message : '', ms: msD };
      ok('软解取消：reject 已取消', !!errD && errD.message === '已取消', errD ? errD.message : '未抛错');
      ok('软解取消：快速停止（<6s）', msD < 6000, msD + 'ms');

      var rE = await E.convert(files['hevc-360-1mb.mp4'], {
        format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'drop'
      }, {});
      ok('软解取消后再次转码可用', rE.data.length > 1000, rE.data.length + ' B');
    } catch (e) {
      results.errors.push('cancel: ' + e.stack);
      ok('软解取消', false, e.message);
    }

    /* ---- 7. 4:2:2 明确报错 ---- */
    try {
      var raw = await bytesOf(files['hevc-360-1mb.mp4']);
      var patched = patchHvcCChroma(raw, 2);
      ok('构造 4:2:2 hvcC 成功', !!patched, patched ? 'patched' : 'hvcC not found');
      if (patched) {
        var errF = null;
        try {
          await E.convert(patched, { format: 'mp4', maxWidth: 320, maxHeight: 180, audio: 'drop' }, {});
        } catch (e) { errF = e; }
        results.chroma422 = errF ? errF.message : '';
        ok('4:2:2 输入明确报错（不花屏）', !!errF && errF.message.indexOf('4:2:0') >= 0, errF ? errF.message : '未抛错');
      }
    } catch (e) {
      results.errors.push('422: ' + e.stack);
      ok('4:2:2 报错测试', false, e.message);
    }

    results.totalMs = Date.now() - t0;
    results.failed = tests.filter(function (x) { return !x.pass; }).length;
    logLine('---- 结束：' + (tests.length - results.failed) + '/' + tests.length + ' 通过，' + results.totalMs + 'ms ----');
    return results;
  };

  window.__hevcTestReady = true;
})();
