/* 测量 qb.html 打开耗时与资源情况 */
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = 'E:\\AI工作\\轻办排版\\qb.html';
const PORT = 9350, PROFILE = 'E:\\AI工作\\轻办排版\\_build\\edge-perf';
function getJSON(u) { return new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { try { const l = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(300); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  const url = 'file:///' + FILE.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  const t0 = Date.now();
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) { try { if (await ev('document.readyState === "complete"')) break; } catch (e) { } await sleep(50); }
  const wall = Date.now() - t0;
  const nav = await ev('(()=>{const n=performance.getEntriesByType("navigation")[0]||{};return {dom:n.domContentLoadedEventEnd,load:n.loadEventEnd,duration:n.duration,transferSize:n.transferSize,encodedBodySize:n.encodedBodySize,decodedBodySize:n.decodedBodySize};})()');
  const mem = await ev('performance.memory ? {used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize} : null');
  console.log('wall(ms):', wall);
  console.log('navigation:', JSON.stringify(nav));
  console.log('heap:', JSON.stringify(mem));
  ws.close(); edge.kill(); process.exit(0);
})().catch(e => { console.log('FAIL', e.stack); process.exit(1); });
