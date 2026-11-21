/* 响应式检查：不同视口宽度下，新面板是否横向溢出 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = 'E:\\AI工作\\轻办排版\\qb.html';
const OUT = 'E:\\AI工作\\轻办排版\\_build\\shots';
const PORT = 9340;
const PROFILE = 'E:\\AI工作\\轻办排版\\_build\\edge-profile8';
fs.mkdirSync(OUT, { recursive: true });

function getJSON(u) { return new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { try { const l = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(300); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async (expr, ap = true) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: ap, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  const url = 'file:///' + FILE.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  await send('Page.navigate', { url });
  await sleep(2000);

  for (const [w, h] of [[1600, 1000], [1440, 900], [1280, 800], [1024, 768], [820, 900], [480, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(300);
    const overflow = await ev('({doc: document.documentElement.scrollWidth, win: window.innerWidth})');
    for (const [name, js] of [['audio', "document.querySelector('.fn-btn[data-panel=audio]').click()"], ['code', "document.querySelector('.fn-btn[data-panel=code]').click();document.querySelector('#codeTabs [data-tab=qr]').click()"]]) {
      await ev('(()=>{' + js + ';return 1;})()', false);
      await sleep(500);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'resp-' + name + '-' + w + '.png'), Buffer.from(shot.data, 'base64'));
    }
    console.log(w + 'x' + h, 'scrollWidth=' + overflow.doc, 'innerWidth=' + overflow.win, overflow.doc > overflow.win + 1 ? 'OVERFLOW!' : 'ok');
  }
  ws.close(); edge.kill(); process.exit(0);
})().catch(e => { console.log('FAIL', e.stack); process.exit(1); });
