/* 无头 Edge + file:// 驱动 HEVC 软解测试（File 输入，模拟 qb.html 实际使用方式） */
'use strict';
const fs = require('fs');
const path = require('path');
const { launch } = require('./lib/cdp.js');

const ROOT = __dirname;
const PORT = 9464;

const SAMPLE_FILES = [
  'hevc-portrait-rot90.mp4',
  'hevc-1080-hvc1-H120.mp4',
  'hevc-360-1mb.mp4'
];

(async () => {
  const b = await launch({ port: PORT, profile: path.join(ROOT, 'edge-profile-hevc') });
  let results = null;
  try {
    const fileUrl = encodeURI('file:///' + path.join(ROOT, 'hevc-test.html').replace(/\\/g, '/'));
    await b.goto(fileUrl, 400);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = await b.evaluate('window.__hevcTestReady === true', false); if (ready) break; } catch (e) { }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw new Error('HEVC 测试页未就绪');

    // 通过 CDP 把本地样本塞进 file input（file:// 页面无法 fetch 本地文件）
    await b.send('DOM.enable');
    const doc = await b.send('DOM.getDocument', { depth: -1 });
    const q = await b.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#hevcFile' });
    if (!q.nodeId) throw new Error('找不到 #hevcFile');
    await b.send('DOM.setFileInputFiles', {
      nodeId: q.nodeId,
      files: SAMPLE_FILES.map(f => path.join(ROOT, 'samples', f))
    });
    const fileCount = await b.evaluate("document.getElementById('hevcFile').files.length", false);
    console.log('已注入样本文件数: ' + fileCount);
    if (fileCount !== SAMPLE_FILES.length) throw new Error('样本注入失败，files=' + fileCount);

    const ua = await b.evaluate('navigator.userAgent', false);
    const secure = await b.evaluate('isSecureContext', false);
    console.log('浏览器: ' + ua);
    console.log('file:// 安全上下文: ' + secure + '\n');

    const t0 = Date.now();
    results = await b.evaluate('window.__runHevcTests()');
    console.log('总耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

    const checks = results.checks || [];
    const failed = checks.filter(c => !c.pass);
    console.log('===== HEVC 测试结果：' + (checks.length - failed.length) + '/' + checks.length + ' 通过 =====');
    for (const c of checks) {
      console.log((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '   [' + c.detail + ']' : ''));
    }
    if (results.errors && results.errors.length) {
      console.log('\n===== 测试脚本异常 =====');
      results.errors.forEach(e => console.log(e));
    }
    console.log('\n===== 关键数值 =====');
    console.log(JSON.stringify({
      files: results.files,
      support: results.support,
      probe: results.probe,
      hev1: results.hev1,
      portrait: results.portrait,
      hd: results.hd,
      cancel: results.cancel,
      chroma422: results.chroma422,
      timing: results.timing,
      totalMs: results.totalMs
    }, null, 2));

    const errs = b.consoleErrors();
    console.log('\n===== 控制台错误 =====');
    console.log(errs.length ? JSON.stringify(errs, null, 2) : '(无)');

    fs.writeFileSync(path.join(ROOT, 'hevc-test-report.json'), JSON.stringify({
      when: new Date().toISOString(),
      ua, secure, protocol: 'file://', results, consoleErrors: errs
    }, null, 2));
    console.log('\n报告已写入 hevc-test-report.json');
    if (failed.length) process.exitCode = 1;
  } finally {
    await b.close();
  }
})().catch(e => {
  console.error('FAIL: ' + (e && e.stack || e));
  process.exit(1);
});
