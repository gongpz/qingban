/* 生成测试样本：无头 Edge 里用 WebCodecs 编码 H.264+AAC / VP9+Opus / VP8 / AV1，
   再用字节级补丁造出竖屏（tkhd matrix）、MOV（ftyp qt）、M4V 样本 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launch, serve } = require('./lib/cdp.js');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'samples');
fs.mkdirSync(OUT, { recursive: true });

/* ---- MP4 盒遍历 ---- */
function readBoxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) { size = end - p; }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, hdr, size, end: p + size });
    p += size;
  }
  return out;
}
function findPath(buf, pathArr) {
  let start = 0, end = buf.length, node = null;
  for (let i = 0; i < pathArr.length; i++) {
    const boxes = readBoxes(buf, start, end);
    node = boxes.find(b => b.type === pathArr[i]);
    if (!node) return null;
    start = node.start + node.hdr; end = node.end;
  }
  return node;
}
function patchTkhdMatrix(buf, matrix) {
  const moov = findPath(buf, ['moov']);
  if (!moov) throw new Error('no moov');
  const traks = readBoxes(buf, moov.start + moov.hdr, moov.end).filter(b => b.type === 'trak');
  let patched = 0;
  for (const trak of traks) {
    const tkhd = readBoxes(buf, trak.start + trak.hdr, trak.end).find(b => b.type === 'tkhd');
    if (!tkhd) continue;
    const payload = tkhd.start + tkhd.hdr;
    const version = buf[payload];
    const widthOff = payload + (version === 1 ? 92 : 80);
    const width = buf.readUInt32BE(widthOff) / 65536;
    const height = buf.readUInt32BE(widthOff + 4) / 65536;
    if (width <= 0 || height <= 0) continue; // 音频轨
    const matrixOff = payload + (version === 1 ? 52 : 40);
    for (let i = 0; i < 9; i++) buf.writeInt32BE(matrix[i], matrixOff + i * 4);
    patched++;
  }
  if (!patched) throw new Error('no video tkhd');
  return patched;
}
function patchBrand(buf, brand) {
  const ftyp = findPath(buf, ['ftyp']);
  if (!ftyp) throw new Error('no ftyp');
  buf.write(brand.slice(0, 4).padEnd(4, ' '), ftyp.start + 8, 'latin1');
}

/* tkhd matrix：a,b,c,d 用 16.16，u,v,w 用 2.30 */
const M90 = [0, 1 << 16, 0, -(1 << 16), 0, 0, 0, 0, 1 << 30];
const M180 = [-(1 << 16), 0, 0, 0, -(1 << 16), 0, 0, 0, 1 << 30];

const KINDS = [
  { kind: 'mp4', file: 'h264-aac.mp4' },
  { kind: 'webm', file: 'vp9-opus.webm' },
  { kind: 'av1', file: 'av1.webm' },
  { kind: 'vp8', file: 'vp8.webm' },
  { kind: 'mkv', file: 'matroska.mkv' },
  { kind: 'aac44', file: 'aac44.mp4' },
  { kind: 'mono', file: 'mono-opus.webm' }
];

(async () => {
  const srv = await serve(ROOT, 9472);
  const b = await launch({ port: 9442, profile: path.join(ROOT, 'edge-profile-video') });
  try {
    await b.goto('http://127.0.0.1:9472/lib/_gen.html');
    console.log('页面 UA: ' + await b.evaluate('navigator.userAgent', false));
    const results = {};
    for (const item of KINDS) {
      const t0 = Date.now();
      const r = await b.evaluate('window.genSample(' + JSON.stringify(item.kind) + ')');
      const buf = Buffer.from(r.b64, 'base64');
      const file = path.join(OUT, item.file);
      fs.writeFileSync(file, buf);
      results[item.kind] = { file: item.file, size: buf.length, vChunks: r.vChunks, aChunks: r.aChunks, ms: Date.now() - t0 };
      console.log(item.kind.toUpperCase() + ' -> ' + item.file + ' ' + buf.length + ' bytes (' +
        (buf.length / 1024).toFixed(0) + ' KB), ' + JSON.stringify({ v: r.vChunks, a: r.aChunks, ms: Date.now() - t0 }));
    }

    const src = fs.readFileSync(path.join(OUT, 'h264-aac.mp4'));
    const rot = Buffer.from(src);
    patchTkhdMatrix(rot, M90);
    fs.writeFileSync(path.join(OUT, 'portrait-rot90.mp4'), rot);
    const rot180 = Buffer.from(src);
    patchTkhdMatrix(rot180, M180);
    fs.writeFileSync(path.join(OUT, 'rot180.mp4'), rot180);
    const mov = Buffer.from(src);
    patchBrand(mov, 'qt  ');
    fs.writeFileSync(path.join(OUT, 'h264-aac.mov'), mov);
    const m4v = Buffer.from(src);
    patchBrand(m4v, 'M4V ');
    fs.writeFileSync(path.join(OUT, 'h264-aac.m4v'), m4v);
    console.log('变体样本：portrait-rot90.mp4 / rot180.mp4 / h264-aac.mov / h264-aac.m4v');
    fs.writeFileSync(path.join(OUT, 'gen-report.json'), JSON.stringify(results, null, 2));
    console.log('控制台错误: ' + JSON.stringify(b.consoleErrors()));
  } finally {
    await b.close();
    srv.close();
  }
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
