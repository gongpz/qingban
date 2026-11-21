/* 无头 Edge + CDP 驱动 video-test.html 的完整自测，输出 PASS/FAIL 摘要与 JSON 报告 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launch, serve } = require('./lib/cdp.js');

const ROOT = __dirname;
const PORT_HTTP = 9473;
const PORT_CDP = 9443;

(async () => {
  const srv = await serve(ROOT, PORT_HTTP);
  const b = await launch({ port: PORT_CDP, profile: path.join(ROOT, 'edge-profile-video') });
  let results = null;
  try {
    await b.goto('http://127.0.0.1:' + PORT_HTTP + '/video-test.html', 300);
    // 等待测试脚本就绪
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready = await b.evaluate('window.__videoTestReady === true', false);
        if (ready) break;
      } catch (e) { }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw new Error('测试页未就绪（video-test.js 未加载）');
    const ua = await b.evaluate('navigator.userAgent', false);
    console.log('浏览器: ' + ua + '\n');

    const t0 = Date.now();
    results = await b.evaluate('window.__runVideoTests()');
    console.log('总耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

    if (!results || !results.checks) throw new Error('未返回测试结果');
    const checks = results.checks;
    const failed = checks.filter(c => !c.pass);
    console.log('===== 测试结果：' + (checks.length - failed.length) + '/' + checks.length + ' 通过 =====');
    for (const c of checks) {
      console.log((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '   [' + c.detail + ']' : ''));
    }
    if (results.errors && results.errors.length) {
      console.log('\n===== 测试脚本异常 =====');
      results.errors.forEach(e => console.log(e));
    }
    console.log('\n===== 关键数值 =====');
    console.log(JSON.stringify({
      samples: results.samples,
      support: results.support,
      probe: results.probe,
      mp4mp4: results.mp4mp4 && { meta: results.mp4mp4.meta, probe: results.mp4mp4.probe, video: results.mp4mp4.video },
      mp4webm: results.mp4webm && { meta: results.mp4webm.meta, probe: results.mp4webm.probe, video: results.mp4webm.video },
      webmmp4: results.webmmp4 && { meta: results.webmmp4.meta, probe: results.webmmp4.probe, video: results.webmmp4.video },
      fps24: results.fps24,
      rotated: results.rotated && { meta: results.rotated.meta, probe: results.rotated.probe },
      cancel: results.cancel,
      timing: results.timing,
      totalMs: results.totalMs
    }, null, 2));

    const errs = b.consoleErrors();
    console.log('\n===== 控制台错误（http 阶段）=====');
    console.log(errs.length ? JSON.stringify(errs, null, 2) : '(无)');

    /* ---- file:// 离线冒烟（不依赖 http，验证单文件离线可用性）---- */
    let fileResult = null;
    try {
      const smokePath = path.join(ROOT, 'samples', 'vp8.webm');
      const b64 = fs.readFileSync(smokePath).toString('base64');
      const fileUrl = encodeURI('file:///' + path.join(ROOT, 'video-test.html').replace(/\\/g, '/'));
      await b.goto(fileUrl, 300);
      for (let i = 0; i < 40; i++) {
        try {
          if (await b.evaluate('window.__videoTestReady === true', false)) break;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 250));
      }
      await b.evaluate('window.__fileB64 = ' + JSON.stringify(b64) + '; true', false);
      fileResult = await b.evaluate(`(async () => {
        const bytes = Uint8Array.from(atob(window.__fileB64), c => c.charCodeAt(0));
        const p = await VideoEngine.probe(bytes);
        const r = await VideoEngine.convert(bytes, { format: 'mp4', maxWidth: 320, maxHeight: 180, videoBitrate: 300, audio: 'drop' }, {});
        const p2 = await VideoEngine.probe(r.data);
        return { secure: isSecureContext, probe: p, out: p2, size: r.data.length, notes: r.meta.notes,
                 videoEngine: typeof VideoEngine };
      })()`);
      const pass = fileResult.secure === true && fileResult.probe.container === 'webm' &&
        fileResult.out.container === 'mp4' && fileResult.out.width === 320 && fileResult.size > 1000;
      console.log('\n===== file:// 离线冒烟：' + (pass ? 'PASS' : 'FAIL') + ' =====');
      console.log(JSON.stringify({
        secureContext: fileResult.secure,
        global: fileResult.videoEngine,
        probe: { container: fileResult.probe.container, w: fileResult.probe.width, h: fileResult.probe.height, codec: fileResult.probe.videoCodec },
        output: { container: fileResult.out.container, w: fileResult.out.width, h: fileResult.out.height, codec: fileResult.out.videoCodec },
        size: fileResult.size, notes: fileResult.notes
      }, null, 2));
    } catch (e) {
      console.log('\n===== file:// 离线冒烟：FAIL =====');
      console.log(e.message);
    }

    fs.writeFileSync(path.join(ROOT, 'video-test-report.json'), JSON.stringify({
      when: new Date().toISOString(),
      ua,
      results,
      fileProtocol: fileResult,
      consoleErrors: errs
    }, null, 2));
    console.log('\n报告已写入 video-test-report.json');
    if (failed.length) process.exitCode = 1;
  } finally {
    await b.close();
    srv.close();
  }
})().catch(e => {
  console.error('FAIL: ' + (e && e.stack || e));
  process.exit(1);
});
