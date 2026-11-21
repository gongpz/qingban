/* 用无头 Edge + CDP 验证 qb.html：控制台错误、模块加载、音频编码往返、二维码/条码识别、截图 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = process.argv[2] ? require('path').resolve(process.argv[2]) : 'E:\\AI工作\\轻办排版\\qb.html';
const OUTDIR = 'E:\\AI工作\\轻办排版\\_build\\shots';
const PORT = 9333;
const PROFILE = 'E:\\AI工作\\轻办排版\\_build\\edge-profile';

fs.mkdirSync(OUTDIR, { recursive: true });

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--window-size=1600,1000',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) { }
    await sleep(300);
  }
  if (!target) { console.log('FAIL: 无法连接 Edge 调试端口'); edge.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let idSeq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  function send(method, params) {
    const id = ++idSeq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evaluate(expression, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) throw new Error('JS 异常：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const url = 'file:///' + FILE.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  await send('Page.navigate', { url });
  await sleep(2500);

  const tests = fs.readFileSync('E:\\AI工作\\轻办排版\\_build\\inpage-tests.js', 'utf8');
  const wmaPath = 'E:\\AI工作\\轻办排版\\_build\\samples\\large_superframe.wma';
  if (fs.existsSync(wmaPath)) {
    const b64 = fs.readFileSync(wmaPath).toString('base64');
    await evaluate('window.__wmaB64=' + JSON.stringify(b64) + ';true', false);
  }
  const apePath = 'E:\\AI工作\\轻办排版\\_build\\samples\\luckynight.ape';
  if (fs.existsSync(apePath)) {
    const b64a = fs.readFileSync(apePath).toString('base64');
    await evaluate('window.__apeB64=' + JSON.stringify(b64a) + ';true', false);
  }
  const hevcPath = 'E:\\AI工作\\轻办排版\\_build\\samples\\hevc-720p.mp4';
  if (fs.existsSync(hevcPath)) {
    const b64h = fs.readFileSync(hevcPath).toString('base64');
    await evaluate('window.__hevcB64=' + JSON.stringify(b64h) + ';true', false);
  }
  let result;
  try {
    result = await evaluate(tests);
  } catch (e) {
    console.log('FAIL: 页面测试脚本出错 ' + e.message);
  }

  // 解码面板：生成一张二维码图片并载入，截图识别结果
  try {
    await evaluate(`(async () => {
      document.querySelector('.fn-btn[data-panel=code]').click();
      document.querySelector('#codeTabs [data-tab=dec]').click();
      const m = CodeTools.qr.encode('https://example.com/轻办?from=decode', {ecl:'M'});
      const img = CodeTools.util.rasterizeQR(m, {scale:6, quietZone:4});
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      const idata = ctx.createImageData(img.width, img.height);
      idata.data.set(img.data);
      ctx.putImageData(idata, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'qr-test.png', {type:'image/png'}));
      const inp = document.getElementById('decPicker');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', {bubbles:true}));
      await new Promise(r => setTimeout(r, 1800));
      return document.getElementById('decCount').textContent;
    })()`);
  } catch (e) { console.log('解码面板演示失败：' + e.message); }

  // 截图
  // 截图前先切回浅色主题（profile 会记住上次选择）
  await evaluate("if(document.documentElement.getAttribute('data-theme')==='dark'){document.getElementById('themeBtn').click();}1", false);
  await sleep(300);

  const shots = [
    { name: 'orig-voucher', js: "document.querySelector('.fn-btn[data-panel=voucher]').click()" },
    { name: 'orig-compress', js: "document.querySelector('.fn-btn[data-panel=compress]').click()" },
    { name: 'orig-convert', js: "document.querySelector('.fn-btn[data-panel=convert]').click()" },
    { name: 'orig-cdr', js: "document.querySelector('.fn-btn[data-panel=cdr]').click()" },
    { name: 'audio', js: "document.querySelector('.fn-btn[data-panel=audio]').click()" },
    { name: 'video', js: "document.querySelector('.fn-btn[data-panel=video]').click()" },
    { name: 'code-qr', js: "document.querySelector('.fn-btn[data-panel=code]').click();document.querySelector('#codeTabs [data-tab=qr]').click();document.querySelector('#qrDotSeg [data-v=round]').click();document.querySelector('#qrFinderSeg [data-v=round]').click();document.querySelector('#qrPresets [data-preset=grad]').click()" },
    { name: 'code-bar', js: "document.querySelector('#codeTabs [data-tab=bar]').click();var b=document.getElementById('barText');b.value='6901234567892';b.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#barBorderSeg [data-v=frame]').click()" },
    { name: 'code-dec', js: "document.querySelector('#codeTabs [data-tab=dec]').click()" }
  ];
  for (const s of shots) {
    await evaluate('(()=>{' + s.js + ';return 1;})()', false);
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTDIR, s.name + '.png'), Buffer.from(shot.data, 'base64'));
  }

  // 深色主题截图
  await evaluate("document.getElementById('themeBtn').click();document.querySelector('.fn-btn[data-panel=audio]').click();1", false);
  await sleep(600);
  let shotDark = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, 'dark-audio.png'), Buffer.from(shotDark.data, 'base64'));
  await evaluate("document.querySelector('.fn-btn[data-panel=code]').click();document.querySelector('#codeTabs [data-tab=qr]').click();1", false);
  await sleep(600);
  shotDark = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, 'dark-code.png'), Buffer.from(shotDark.data, 'base64'));

  const errs = events.filter(e =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && ['error'].includes(e.params.entry.level)) ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  ).map(e => e.method === 'Log.entryAdded' ? e.params.entry.text : (e.method === 'Runtime.exceptionThrown' ? (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text) : e.params.args.map(a => a.value || a.description).join(' ')));

  console.log('===== 页面测试结果 =====');
  if (result && result.checks) {
    const fails = result.checks.filter(c => !c.pass);
    console.log('通过 ' + (result.checks.length - fails.length) + '/' + result.checks.length);
    if (fails.length) console.log('失败项：\n' + fails.map(f => ' - ' + f.name + ' :: ' + f.extra).join('\n'));
    if (result.errors && result.errors.length) console.log('测试脚本异常：\n' + result.errors.join('\n'));
    console.log('汇总：' + JSON.stringify({ support: result.support && { aac: result.support.aac, opus: result.support.opus }, wma: result.wma, ape: result.ape, qrLogo: result.qrLogo }));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('===== 控制台错误 =====');
  console.log(errs.length ? JSON.stringify(errs, null, 2) : '(无)');
  console.log('截图目录：' + OUTDIR);

  ws.close();
  edge.kill();
  process.exit(0);
})().catch(e => { console.log('FAIL: ' + e.stack); process.exit(1); });
