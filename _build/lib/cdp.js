/* 极简 CDP 驱动（Node，无第三方依赖）：启动无头 Edge、开本地 http 服务、执行页面 JS */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function freePort(start) {
  // 顺序探测一个可用端口（不做 bind 检测，端口冲突时靠重试）
  return start;
}

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

/* 静态文件服务：root 下的文件按 URL 提供，允许跨域 */
function serve(root, port) {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let p = path.join(root, u === '/' ? '/video-test.html' : u);
    if (!p.startsWith(path.resolve(root))) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, buf) => {
      if (e) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function launch(opts) {
  opts = opts || {};
  const port = opts.port || 9333;
  const profile = opts.profile || path.join(__dirname, '..', 'edge-profile-video');
  const args = [
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--window-size=1280,900',
    'about:blank'
  ].concat(opts.edgeArgs || []);
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) { }
    await sleep(300);
  }
  if (!target) { try { proc.kill(); } catch (e) { } throw new Error('无法连接 Edge 调试端口 ' + port); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let idSeq = 0;
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
  async function evaluate(expression, awaitPromise) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: awaitPromise !== false, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error('页面 JS 异常：' + (ex && (ex.description || ex.value) || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  const consoleErrors = () => events.filter(e =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  ).map(e => e.method === 'Log.entryAdded' ? e.params.entry.text :
    (e.method === 'Runtime.exceptionThrown' ? (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text) :
      (e.params.args || []).map(a => a.value || a.description).join(' ')));

  async function goto(url, waitMs) {
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      await sleep(150);
      try {
        const st = await evaluate('document.readyState', false);
        if (st === 'complete') break;
      } catch (e) { }
    }
    if (waitMs) await sleep(waitMs);
  }

  async function close() {
    try { ws.close(); } catch (e) { }
    try { proc.kill(); } catch (e) { }
    await sleep(300);
  }
  return { send, evaluate, goto, close, consoleErrors, events, proc, port };
}

module.exports = { launch, serve, sleep, EDGE, getJSON };
