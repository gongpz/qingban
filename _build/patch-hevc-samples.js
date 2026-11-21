/* 由公开 HEVC 样本生成变体：竖屏 90°（含 AAC）、hvc1.1.6.H120.90 标记 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'samples');

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
function childBoxes(buf, box) { return readBoxes(buf, box.start + box.hdr, box.end); }
function findPath(buf, startBox, names) {
  let box = startBox;
  for (const n of names) {
    const kids = childBoxes(buf, box);
    box = kids.find(b => b.type === n);
    if (!box) return null;
  }
  return box;
}
function patchMatrix(buf, matrix) {
  const moov = readBoxes(buf, 0, buf.length).find(b => b.type === 'moov');
  if (!moov) throw new Error('no moov');
  const traks = childBoxes(buf, moov).filter(b => b.type === 'trak');
  let count = 0;
  for (const trak of traks) {
    const tkhd = childBoxes(buf, trak).find(b => b.type === 'tkhd');
    if (!tkhd) continue;
    const payload = tkhd.start + tkhd.hdr;
    const version = buf[payload];
    const widthOff = payload + (version === 1 ? 92 : 80);
    const w = buf.readUInt32BE(widthOff) / 65536;
    const h = buf.readUInt32BE(widthOff + 4) / 65536;
    if (w <= 0 || h <= 0) continue;
    const matrixOff = payload + (version === 1 ? 52 : 40);
    for (let i = 0; i < 9; i++) buf.writeInt32BE(matrix[i], matrixOff + i * 4);
    count++;
  }
  return count;
}
const M90 = [0, 1 << 16, 0, -(1 << 16), 0, 0, 0, 0, 1 << 30];

function patchToHvc1High(buf) {
  const moov = readBoxes(buf, 0, buf.length).find(b => b.type === 'moov');
  const traks = childBoxes(buf, moov).filter(b => b.type === 'trak');
  let patchedType = 0, patchedTier = 0;
  for (const trak of traks) {
    const stbl = findPath(buf, trak, ['mdia', 'minf', 'stbl']);
    if (!stbl) continue;
    const stsd = childBoxes(buf, stbl).find(b => b.type === 'stsd');
    if (!stsd) continue;
    const entryCount = buf.readUInt32BE(stsd.start + stsd.hdr + 4);
    let p = stsd.start + stsd.hdr + 8;
    for (let i = 0; i < entryCount; i++) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      if (type === 'hev1' || type === 'hev2' || type === 'hvc1') {
        if (type !== 'hvc1') { buf.write('hvc1', p + 4, 'latin1'); patchedType++; }
        // 在 sample entry 内找 hvcC（VisualSampleEntry 固定头 78 字节）
        const kids = readBoxes(buf, p + 8 + 78, p + size);
        const hvcC = kids.find(b => b.type === 'hvcC');
        if (hvcC) {
          // payload[1] bit5 = general_tier_flag
          const tierOff = hvcC.start + hvcC.hdr + 1;
          buf[tierOff] = buf[tierOff] | 0x20;
          patchedTier++;
        }
      }
      p += size;
    }
  }
  return { patchedType, patchedTier };
}

const src720 = fs.readFileSync(path.join(OUT, 'hevc-720p.mp4'));
const portrait = Buffer.from(src720);
patchMatrix(portrait, M90);
fs.writeFileSync(path.join(OUT, 'hevc-portrait-rot90.mp4'), portrait);

const src1080 = fs.readFileSync(path.join(OUT, 'hevc-1080-5mb.mp4'));
const hvc1 = Buffer.from(src1080);
const info = patchToHvc1High(hvc1);
fs.writeFileSync(path.join(OUT, 'hevc-1080-hvc1-H120.mp4'), hvc1);

console.log('portrait-rot90 写入; hvc1 patch:', JSON.stringify(info));
