#!/usr/bin/env node
/*!
 * code-tools-test.js —— CodeTools 模块的 Node 测试脚本（可直接运行）
 *
 *     node code-tools-test.js            # 全部测试
 *     node code-tools-test.js --quick    # 跳过 1000x1000 性能与降质用例
 *
 * 覆盖内容
 *   1. QR 编码：API/参数校验/边界长度/异常输入
 *   2. QR 参考矩阵逐比特校验：35 组用例的矩阵 SHA-256 与
 *      qrcodegen(Nayuki) + python-qrcode 两个独立实现逐格对齐后的结果一致
 *      （对齐脚本与原始数据见 lib/dev/check_qr.py、lib/dev/js-qr.json）
 *   3. QR 解码回环：35 组内容 × 放大 3~8 倍 / 灰底 / 反色 / 4 模块静区
 *   4. 条形码编码：6 种制式的结构、校验位、非法输入
 *   5. 条形码解码回环：模块宽 1~6、条高 40~260、静区 0~10、反色、带可读文本、
 *      0/90/180/270 旋转
 *   6. 降质解码：高斯模糊 / 高斯噪声 / JPEG 风格（1/2 降采样 + 双线性回放）
 *   7. 性能：1000×1000 图像解码 < 1.5s
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUICK = process.argv.indexOf('--quick') >= 0;

/* ---------------------------------------------------------------- 加载模块 */
let CodeTools;
try {
  CodeTools = require(path.join(__dirname, 'code-tools.js'));
} catch (e) {
  CodeTools = globalThis.CodeTools;
}
if (!CodeTools) {
  console.error('无法加载 code-tools.js');
  process.exit(2);
}

/* ---------------------------------------------------------------- 测试框架 */
let pass = 0, fail = 0;
const failures = [];
let sectionName = '';

function section(name) {
  sectionName = name;
  console.log('\n== ' + name);
}

function ok(cond, name, detail) {
  if (cond) {
    pass++;
    return true;
  }
  fail++;
  const msg = sectionName + ' / ' + name + (detail ? '  [' + detail + ']' : '');
  failures.push(msg);
  console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : ''));
  return false;
}

function eq(actual, expected, name) {
  return ok(actual === expected, name,
    actual === expected ? '' : '期望 ' + JSON.stringify(expected) + '，得到 ' + JSON.stringify(actual));
}

function summary() {
  const total = pass + fail;
  console.log('\n' + '='.repeat(64));
  console.log('总计 %d 项：通过 %d，失败 %d', total, pass, fail);
  if (fail) {
    console.log('\n失败明细：');
    failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
  }
  console.log('='.repeat(64));
  return fail === 0;
}

/* ---------------------------------------------------------------- 图像工具 */
function cloneImage(img) {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

function grayOf(img) {
  return CodeTools.util.grayFromRGBA(img.data, img.width, img.height);
}

function fromGray(gray, w, h) {
  return { data: CodeTools.util.rgbaFromGray(gray, w, h), width: w, height: h };
}

/* 顺时针旋转 90/180/270 度（RGBA） */
function rotateImage(img, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return img;
  const w = img.width, h = img.height, src = img.data;
  if (deg === 180) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4, di = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
      }
    }
    return { data: out, width: w, height: h };
  }
  const nw = h, nh = w;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; } else { nx = y; ny = w - 1 - x; }
      const si = (y * w + x) * 4, di = (ny * nw + nx) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

/* 可分离高斯模糊 [1,2,1]/4，passes 次 */
function blurImage(img, passes) {
  let g = grayOf(img);
  const w = img.width, h = img.height;
  for (let p = 0; p < (passes || 1); p++) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = g[y * w + (x > 0 ? x - 1 : 0)];
        const b = g[y * w + x];
        const c = g[y * w + (x + 1 < w ? x + 1 : w - 1)];
        tmp[y * w + x] = (a + 2 * b + c) / 4;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = tmp[(y > 0 ? y - 1 : 0) * w + x];
        const b = tmp[y * w + x];
        const c = tmp[(y + 1 < h ? y + 1 : h - 1) * w + x];
        out[y * w + x] = (a + 2 * b + c) / 4;
      }
    }
    for (let i = 0; i < g.length; i++) g[i] = out[i] | 0;
  }
  return fromGray(g, w, h);
}

/* 高斯噪声（Box-Muller，固定种子，保证可复现） */
function noiseImage(img, sigma, seed) {
  const g = grayOf(img);
  let s = (seed === undefined ? 12345 : seed) | 0;
  function rnd() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < g.length; i++) {
    const u1 = Math.max(1e-6, rnd()), u2 = rnd();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    let v = g[i] + n * sigma;
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    g[i] = v | 0;
  }
  return fromGray(g, img.width, img.height);
}

/* JPEG 风格劣化：1/2 降采样（箱式）+ 双线性回放 + 轻微振铃 */
function jpegishImage(img, factor, seed) {
  const g = grayOf(img);
  const w = img.width, h = img.height;
  const sw = Math.max(1, Math.round(w / factor)), sh = Math.max(1, Math.round(h / factor));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0, cnt = 0;
      const x0 = Math.floor(x * w / sw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / sw));
      const y0 = Math.floor(y * h / sh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / sh));
      for (let yy = y0; yy < Math.min(y1, h); yy++) {
        for (let xx = x0; xx < Math.min(x1, w); xx++) { sum += g[yy * w + xx]; cnt++; }
      }
      small[y * sw + x] = cnt ? sum / cnt : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) * sh / h - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * sw / w - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));
      const v00 = small[y0 * sw + x0], v10 = small[y0 * sw + x1];
      const v01 = small[y1 * sw + x0], v11 = small[y1 * sw + x1];
      let v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      v = Math.round(v);
      if (v < 0) v = 0; else if (v > 255) v = 255;
      out[y * w + x] = v;
    }
  }
  return fromGray(out, w, h);
}

/* ---------------------------------------------------------------- 参考数据 */

/* 与 python 参考实现一致的伪随机填充（见 lib/dev/gen_hash_map.js） */
const FILLER_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~/:?&=%';
function filler(n, seed) {
  let out = '';
  let x = (seed * 7919 + 13) | 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out += FILLER_ALPHA.charAt(x % FILLER_ALPHA.length);
  }
  return out;
}

/* 35 组 QR 用例：[名字, 文本或 {filler:[n,seed]}, ECL, minV, maxV, mask]
 * 矩阵哈希来自 qrcodegen(Nayuki) + python-qrcode 逐格一致的结果。 */
const QR_CASES = [
  ['alnum-short', 'HELLO WORLD', 'M'],
  ['url-short', 'https://example.com/', 'L'],
  ['url-long', 'https://example.com/path/to/page?query=1&lang=zh-CN&ref=qr#section-2', 'M'],
  ['chinese-short', '轻办排版', 'Q'],
  ['chinese-mid', '轻办排版·单文件离线 HTML 工具：二维码与条形码生成、解码模块。', 'H'],
  ['chinese-long', '二维码（QR Code）是一种矩阵式二维条码，1994 年由日本 Denso Wave 公司发明。它比一维条码能容纳更多信息，并且支持纠错：即使部分污损也能正确读取。本工具完全离线运行，不联网、不使用 canvas，也不依赖任何 DOM 接口。', 'Q'],
  ['digits', '1234567890', 'L'],
  ['digits-long', '0123456789012345678901234567890123456789', 'M'],
  ['vcard', 'BEGIN:VCARD\nVERSION:3.0\nN:张;三\nFN:张三\nORG:轻办科技\nTITLE:产品经理\nTEL;CELL:+86-138-0000-0000\nEMAIL:zhangsan@example.com\nURL:https://example.com\nEND:VCARD', 'M'],
  ['wifi', 'WIFI:T:WPA;S:MyOffice-5G;P:p@ssw0rd!;H:false;;', 'M'],
  ['empty', '', 'M'],
  ['emoji', '😀🎉 QR 测试 ✓', 'M'],
  ['japanese', 'こんにちは世界、これはテストです。', 'Q'],
  ['mixed-ascii', Array.from({ length: 120 }, (_, i) => String.fromCharCode(33 + (i % 94))).join(''), 'H'],
  ['ecl-L-long', { filler: [600, 1] }, 'L'],
  ['ecl-M-mid', { filler: [400, 2] }, 'M'],
  ['ecl-Q-long', { filler: [300, 3] }, 'Q'],
  ['ecl-H-mid', { filler: [180, 4] }, 'H'],
  ['v1-H-max', { filler: [7, 5] }, 'H', 1, 1],
  ['v1-L-max', { filler: [17, 6] }, 'L', 1, 1],
  ['v2-Q-max', { filler: [20, 7] }, 'Q', 2, 2],
  ['v9-H-max', { filler: [98, 8] }, 'H', 9, 9],
  ['v10-M-max', { filler: [213, 9] }, 'M', 10, 10],
  ['v26-Q-max', { filler: [751, 10] }, 'Q', 26, 26],
  ['v40-L-max', { filler: [2953, 11] }, 'L', 40, 40],
  ['mask-0', 'MASK TEST 0 / 掩码测试', 'M', 1, 40, 0],
  ['mask-1', 'MASK TEST 1 / 掩码测试', 'M', 1, 40, 1],
  ['mask-2', 'MASK TEST 2 / 掩码测试', 'M', 1, 40, 2],
  ['mask-3', 'MASK TEST 3 / 掩码测试', 'M', 1, 40, 3],
  ['mask-4', 'MASK TEST 4 / 掩码测试', 'M', 1, 40, 4],
  ['mask-5', 'MASK TEST 5 / 掩码测试', 'M', 1, 40, 5],
  ['mask-6', 'MASK TEST 6 / 掩码测试', 'M', 1, 40, 6],
  ['mask-7', 'MASK TEST 7 / 掩码测试', 'M', 1, 40, 7],
  ['force-min-v15', 'small', 'M', 15, 40],
  ['force-min-v7-versioninfo', { filler: [122, 12] }, 'M', 7, 7]
];

/* 逐比特参考：矩阵 SHA-256 前 32 位 + 期望版本 */
const QR_REF = {
  'alnum-short': ['f516d851861750f4deffb7514598d705', 1],
  'url-short': ['d8ae7b976467674881d9d9b48da4f151', 2],
  'url-long': ['e1fd526326dc77916771cb9b63ab3725', 5],
  'chinese-short': ['8c3159f768ebca31eb726a83bcf66c08', 2],
  'chinese-mid': ['14bf716eb8f9540b94484335696763a8', 9],
  'chinese-long': ['9d1b060753361e9db14faf123db1b382', 16],
  'digits': ['a5ae80eb5cee6b132ec7314abb7c6eab', 1],
  'digits-long': ['326ad940b034766ef829e7aee4d5bc64', 3],
  'vcard': ['598e813d554ce62be91d5ecd090d52d4', 9],
  'wifi': ['04771732bbaa6d442a5db9689fd0b241', 4],
  'empty': ['de2e48177b471e1c97705057a9ff44a4', 1],
  'emoji': ['c9fe83f945a8da2897ae12e1b6deda2b', 2],
  'japanese': ['6bbf6fbdee42bcb42e57041bef0b61f3', 5],
  'mixed-ascii': ['a312bbbd7ccdd5212581268a0e75e406', 11],
  'ecl-L-long': ['f9f7c750e0226c3902fab25eb43e37a5', 17],
  'ecl-M-mid': ['fdec06f9351184f4a44121bb1593e5d5', 15],
  'ecl-Q-long': ['e511bbb772596f6800d9dfb7bd0dc315', 16],
  'ecl-H-mid': ['76d0ab9ea37cd95da87079b28efc24b5', 14],
  'v1-H-max': ['ec38f3d02284913677069032de971d9b', 1],
  'v1-L-max': ['dfb4039bf8991fb22752ab3accdf9860', 1],
  'v2-Q-max': ['15ffd15270d2a7f8556f28d33bc3228c', 2],
  'v9-H-max': ['e76792add37c1218a58521ec4fe8d192', 9],
  'v10-M-max': ['c290ff400cd9a7c374ca6edc633f459a', 10],
  'v26-Q-max': ['08f5fe638ad811b81c8ac6454ac8832e', 26],
  'v40-L-max': ['be8861507c39a49e754a981c782175ec', 40],
  'mask-0': ['0337f930b301b6cf2c83c3e25c0201d6', 2],
  'mask-1': ['3daa81ceaf3569ca77ed65eb28c9e007', 2],
  'mask-2': ['f364de1a4d357102c98ef34c43bcc869', 2],
  'mask-3': ['f008b8e0ce6d38960c5c1862e9b2a5e0', 2],
  'mask-4': ['ae4686450144b70b1399044d8fe82067', 2],
  'mask-5': ['845e17c9d171dd53d0e607b058cfe9d7', 2],
  'mask-6': ['999ccc970d42c26e6622826f9ddb40d4', 2],
  'mask-7': ['08b6ec8d8e288fbab5455b3e701ed4dc', 2],
  'force-min-v15': ['4cbe76425f8889ab4c0979532f4b7ff2', 15],
  'force-min-v7-versioninfo': ['aa8eb83c9b57ed4f959129bb988259b0', 7]
};

function caseText(c) {
  const t = c[1];
  return (t && typeof t === 'object' && t.filler) ? filler(t.filler[0], t.filler[1]) : String(t);
}

function matrixHash(qr) {
  let s = '';
  for (let i = 0; i < qr.matrix.length; i++) s += qr.matrix[i] ? '1' : '0';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/* 统计解码耗时 */
const timings = [];
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  timings.push(ms);
  return { r: r, ms: ms };
}

/* =====================================================================
 * 1. 模块外观与 API
 * ===================================================================== */
section('1. 模块加载 / API 形状');
eq(typeof CodeTools, 'object', 'globalThis.CodeTools 存在');
eq(typeof CodeTools.version, 'string', 'CodeTools.version 存在');
eq(typeof CodeTools.qr.encode, 'function', 'qr.encode 是函数');
eq(typeof CodeTools.qr.decode, 'function', 'qr.decode 是函数');
eq(typeof CodeTools.barcode.encode, 'function', 'barcode.encode 是函数');
eq(typeof CodeTools.barcode.decode, 'function', 'barcode.decode 是函数');
eq(typeof CodeTools.util.grayFromRGBA, 'function', 'util.grayFromRGBA 是函数');
eq(CodeTools.barcode.types.join(','), 'code128,code39,ean13,ean8,upca,itf14', 'barcode.types 覆盖 6 种制式');

// 静态检查：不得依赖 DOM / canvas / require / 网络
try {
  const src = fs.readFileSync(path.join(__dirname, 'code-tools.js'), 'utf8');
  ok(!/document\s*\.\s*createElement/.test(src), '模块不含 DOM 调用');
  ok(!/\bnew\s+Image\s*\(/.test(src), '模块不含 new Image(');
  ok(!/\bXMLHttpRequest\b|\bfetch\s*\(/.test(src), '模块不含网络请求');
  // 用空上下文执行模块源码：等价于浏览器 <script> 直接引入（无 require/module/DOM）
  try {
    const vm = require('vm');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'code-tools.js' });
    const C2 = sandbox.CodeTools;
    ok(C2 && typeof C2 === 'object', '在无 require/module 的沙箱中挂载 globalThis.CodeTools');
    ok(C2 && C2.qr && C2.qr.encode('S', { ecl: 'L' }).size === 21, '沙箱内可正常调用 qr.encode');
    const img2 = C2.util.rasterizeQR(C2.qr.encode('SANDBOX', { ecl: 'L' }), { scale: 3 });
    const r2 = C2.qr.decode(img2);
    ok(r2.ok && r2.text === 'SANDBOX', '沙箱内可正常调用 qr.decode');
    ok(typeof C2.barcode.decode === 'function', '沙箱内 barcode.decode 可用');
  } catch (e) {
    ok(false, '浏览器沙箱加载', e.message);
  }
  ok(!/<canvas|getContext\s*\(/.test(src), '模块不使用 canvas');
  const kb = Buffer.byteLength(src, 'utf8') / 1024;
  console.log('  模块体积：%s KB', kb.toFixed(1));
  ok(kb < 400, '模块体积 < 400KB', kb.toFixed(1) + 'KB');
} catch (e) {
  console.log('  （跳过静态检查：' + e.message + '）');
}

/* =====================================================================
 * 2. QR 编码：结构 / 参数 / 边界 / 异常
 * ===================================================================== */
section('2. QR 编码结构与参数');
{
  const q = CodeTools.qr.encode('HELLO WORLD', { ecl: 'M' });
  eq(q.size, 21, 'short 文本 -> 版本 1 尺寸 21');
  eq(q.version, 1, '版本号 = 1');
  eq(q.ecl, 'M', 'ECL 回显 = M');
  ok(q.matrix instanceof Uint8Array, 'matrix 是 Uint8Array');
  eq(q.matrix.length, q.size * q.size, 'matrix 长度 = size²');
  ok(q.mask >= 0 && q.mask <= 7, '自动掩码落在 0..7', String(q.mask));

  const qH = CodeTools.qr.encode('x'.repeat(100), { ecl: 'H' });
  ok(qH.version > q.version, '同内容 ECL=H 需要更大版本', qH.version + ' > ' + q.version);

  // 四个纠错级别都能编码
  ['L', 'M', 'Q', 'H'].forEach(function (ecl) {
    const r = CodeTools.qr.encode('ECL-' + ecl, { ecl: ecl });
    eq(r.ecl, ecl, 'ECL=' + ecl + ' 回显正确');
    ok(r.size >= 21, 'ECL=' + ecl + ' 尺寸合理');
  });

  // 掩码强制
  for (let m = 0; m < 8; m++) {
    const r = CodeTools.qr.encode('MASK', { ecl: 'L', mask: m });
    eq(r.mask, m, '强制 mask=' + m);
  }

  // 版本范围
  const v10 = CodeTools.qr.encode('small', { ecl: 'M', minVersion: 10, maxVersion: 10 });
  eq(v10.version, 10, 'minVersion=maxVersion=10 生效');
  eq(v10.size, 57, '版本 10 尺寸 57');

  const v7 = CodeTools.qr.encode('abc', { ecl: 'L', minVersion: 7 });
  ok(v7.version >= 7, 'minVersion=7 时不会用更小版本');
  ok(v7.size >= 45, '版本 >= 7 含版本信息区');

  // 异常输入
  function throws(fn, name) {
    try { fn(); ok(false, name, '未抛异常'); } catch (e) { ok(true, name); }
  }
  throws(function () { CodeTools.qr.encode('x', { ecl: 'X' }); }, '非法 ECL 抛异常');
  throws(function () { CodeTools.qr.encode('x', { mask: 9 }); }, '非法 mask 抛异常');
  throws(function () { CodeTools.qr.encode('x', { minVersion: 0 }); }, '非法版本抛异常');
  throws(function () { CodeTools.qr.encode('x'.repeat(4000), { ecl: 'H' }); }, '超容量抛异常');

  // UTF-8 字节模式：中文每字 3 字节
  const cn1 = CodeTools.qr.encode('中', { ecl: 'L' });
  const en1 = CodeTools.qr.encode('abc', { ecl: 'L' });
  ok(cn1.version >= en1.version || cn1.size >= en1.size, 'UTF-8 中文按 3 字节计入容量');
}

/* =====================================================================
 * 3. QR 参考矩阵逐比特校验
 * ===================================================================== */
section('3. QR 参考矩阵逐比特校验（qrcodegen + python-qrcode）');
{
  let hashOk = 0;
  for (const c of QR_CASES) {
    const text = caseText(c);
    const opts = {
      ecl: c[2],
      minVersion: c[3] === undefined ? 1 : c[3],
      maxVersion: c[4] === undefined ? 40 : c[4],
      mask: c[5] === undefined ? -1 : c[5]
    };
    const qr = CodeTools.qr.encode(text, opts);
    const ref = QR_REF[c[0]];
    if (!ref) { ok(false, c[0], '缺少参考数据'); continue; }
    const h = matrixHash(qr);
    if (h === ref[0] && qr.version === ref[1]) {
      hashOk++;
    } else {
      ok(false, '矩阵一致 / ' + c[0],
        'hash ' + h + ' vs ' + ref[0] + ', v' + qr.version + ' vs v' + ref[1]);
    }
  }
  ok(hashOk === QR_CASES.length, '35 组用例矩阵与参考实现逐比特一致',
    hashOk + '/' + QR_CASES.length);
  console.log('  参考矩阵哈希一致：%d/%d 组', hashOk, QR_CASES.length);
}

/* =====================================================================
 * 4. QR 解码回环
 * ===================================================================== */
section('4. QR 解码回环（多倍率 / 灰底 / 反色 / 静区 4）');
{
  let roundOk = 0;
  const scaleSets = [3, 4, 5, 8];
  for (let i = 0; i < QR_CASES.length; i++) {
    const c = QR_CASES[i];
    const text = caseText(c);
    const qr = CodeTools.qr.encode(text, {
      ecl: c[2],
      minVersion: c[3] === undefined ? 1 : c[3],
      maxVersion: c[4] === undefined ? 40 : c[4],
      mask: c[5] === undefined ? -1 : c[5]
    });
    const scale = scaleSets[i % scaleSets.length];
    const variants = [
      { name: 'white', opts: { scale: scale, quietZone: 4 } },
      { name: 'gray', opts: { scale: Math.max(3, scale - 1), quietZone: 4, background: '#d0d0d0' } },
      { name: 'invert', opts: { scale: scale, quietZone: 4, invert: true } }
    ];
    for (const v of variants) {
      const img = CodeTools.util.rasterizeQR(qr, v.opts);
      const t = timed(function () { return CodeTools.qr.decode(img); });
      const r = t.r;
      const good = r.ok && r.text === text;
      if (good) roundOk++;
      else ok(false, c[0] + ' / ' + v.name,
        (r.ok ? '文本不一致: ' + JSON.stringify(String(r.text).slice(0, 40)) : r.error) +
        ' (' + img.width + 'x' + img.height + ')');
      if (!QUICK && i === 0 && v.name === 'white') {
        console.log('  首个用例解码耗时 ' + t.ms.toFixed(1) + ' ms（' + img.width + 'x' + img.height + '）');
      }
    }
  }
  const expected = QR_CASES.length * 3;
  ok(roundOk === expected, 'QR 回环全部通过', roundOk + '/' + expected);
  console.log('  QR 回环：%d/%d 组成功', roundOk, expected);
}

/* 缩放/退化鲁棒性：下采样后再解码 */
section('4b. QR 缩放与退化鲁棒性');
{
  const cases = [
    ['https://example.com/very/long/path?with=query&and=more', 'M', 0.5],
    ['轻办排版：二维码与条码工具', 'Q', 0.75],
    ['1234567890', 'L', 2]
  ];
  for (const [text, ecl, factor] of cases) {
    const qr = CodeTools.qr.encode(text, { ecl: ecl });
    const img = CodeTools.util.rasterizeQR(qr, { scale: 6, quietZone: 4 });
    const g = grayOf(img);
    const scaled = CodeTools.util.scaleGray(g, img.width, img.height, factor);
    const r = CodeTools.qr.decode(fromGray(scaled.data, scaled.width, scaled.height));
    ok(r.ok && r.text === text, '缩放 x' + factor + ' 后解码', r.ok ? '' : r.error);
  }
  // 轻度模糊 + 噪声
  const qr = CodeTools.qr.encode('BLUR & NOISE 模糊噪声测试', { ecl: 'Q' });
  const img = CodeTools.util.rasterizeQR(qr, { scale: 6, quietZone: 4 });
  let r = CodeTools.qr.decode(blurImage(img, 1));
  ok(r.ok && r.text === 'BLUR & NOISE 模糊噪声测试', '1 次高斯模糊后解码',
    r.ok ? '' : r.error);
  r = CodeTools.qr.decode(noiseImage(img, 18));
  ok(r.ok && r.text === 'BLUR & NOISE 模糊噪声测试', '高斯噪声 sigma=18 后解码', r.ok ? '' : r.error);
}

/* =====================================================================
 * 5. 条形码编码
 * ===================================================================== */
section('5. 条形码编码');
{
  const cases = [
    ['code128', 'ABC-1234', 'ABC-1234'],
    ['code128', '1234567890', '1234567890'],
    ['code39', 'CODE39-TEST', 'CODE39-TEST'],
    ['code39', 'abc 123', 'ABC 123'],
    ['ean13', '690123456789', '6901234567892'],
    ['ean13', '400638133393', '4006381333931'],
    ['ean8', '1234567', '12345670'],
    ['upca', '01234567890', '012345678905'],
    ['itf14', '1234567890123', '12345678901231']
  ];
  for (const [type, input, expected] of cases) {
    const b = CodeTools.barcode.encode(type, input);
    ok(b.valid === true, type + ' 编码成功', b.error || '');
    eq(b.text, expected, type + ' 人类可读文本（含自动校验位）');
    ok(b.modules instanceof Uint8Array && b.modules.length > 20, type + ' 模块数合理',
      b.modules ? String(b.modules.length) : 'n/a');
    let onlyBinary = true;
    for (let i = 0; i < b.modules.length; i++) {
      if (b.modules[i] !== 0 && b.modules[i] !== 1) { onlyBinary = false; break; }
    }
    ok(onlyBinary, type + ' 模块值只有 0/1');
  }

  // 模块长度符合规范
  eq(CodeTools.barcode.encode('ean13', '690123456789').modules.length, 95, 'EAN-13 = 95 模块');
  eq(CodeTools.barcode.encode('ean8', '1234567').modules.length, 67, 'EAN-8 = 67 模块');
  eq(CodeTools.barcode.encode('upca', '01234567890').modules.length, 95, 'UPC-A = 95 模块');
  eq(CodeTools.barcode.encode('itf14', '1234567890123').modules.length, 135, 'ITF-14 = 135 模块');
  eq(CodeTools.barcode.encode('code39', 'A').modules.length, 15 * 3 + 2, 'Code39 单字符 = 47 模块');

  // 别名
  eq(CodeTools.barcode.encode('Code-128', 'abc').text, 'abc', '类型别名 Code-128');
  eq(CodeTools.barcode.encode('EAN_13', '690123456789').text, '6901234567892', '类型别名 EAN_13');
  eq(CodeTools.barcode.encode('UPC-A', '01234567890').text, '012345678905', '类型别名 UPC-A');

  // 校验位 API
  eq(CodeTools.barcode.checkDigit('ean13', '690123456789'), 2, 'checkDigit(690123456789) = 2');
  eq(CodeTools.barcode.checkDigit('ean8', '1234567'), 0, 'checkDigit(1234567) = 0');
}

/* =====================================================================
 * 6. 条形码反例
 * ===================================================================== */
section('6. 条形码非法输入');
{
  const bad = [
    ['code128', '中文', 'code128 非 ASCII'],
    ['code128', '', 'code128 空串'],
    ['code39', 'ABC@', 'code39 非法字符'],
    ['code39', '', 'code39 空串'],
    ['ean13', '69012345678', 'ean13 位数不足'],
    ['ean13', '690123456789012', 'ean13 位数过多'],
    ['ean13', '6901234567890', 'ean13 校验位错误'],
    ['ean13', '69012X456789', 'ean13 含字母'],
    ['ean8', '123456', 'ean8 位数不足'],
    ['ean8', '12345678', 'ean8 校验位错误'],
    ['upca', '0123456789', 'upca 位数不足'],
    ['upca', '012345678901', 'upca 校验位错误'],
    ['itf14', '123456789012', 'itf14 位数不足'],
    ['itf14', '12345678901234', 'itf14 校验位错误'],
    ['qrcode', 'abc', '未知类型'],
    ['ean13', null, 'null 内容']
  ];
  for (const [type, data, name] of bad) {
    let b;
    try {
      b = CodeTools.barcode.encode(type, data);
    } catch (e) {
      ok(false, name, '抛异常: ' + e.message);
      continue;
    }
    ok(b.valid === false, name + ' -> valid:false', JSON.stringify(b.valid));
    ok(typeof b.error === 'string' && b.error.length > 0, name + ' -> 有中文错误信息', b.error);
    ok(b.modules.length === 0, name + ' -> modules 为空');
  }
}

/* =====================================================================
 * 7. 条形码解码回环
 * ===================================================================== */
section('7. 条形码解码回环（模块宽/条高/静区/反色/文本/旋转）');
{
  const dataSets = {
    code128: ['ABC-1234', '1234567890', 'AB12', 'ORDER-2024-0001'],
    code39: ['CODE39', 'ABC 123', 'HELLO-WORLD'],
    ean13: ['690123456789', '123456789012'],
    ean8: ['1234567', '9638507'],
    upca: ['01234567890', '03600029145'],
    itf14: ['1234567890123', '1001234500001']
  };
  const renders = [
    { moduleWidth: 1, height: 40, quietZone: 0 },
    { moduleWidth: 2, height: 80, quietZone: 0 },
    { moduleWidth: 2, height: 60, quietZone: 4, invert: true, showText: true },
    { moduleWidth: 3, height: 120, quietZone: 10 },
    { moduleWidth: 3, height: 120, quietZone: 10, showText: true },
    { moduleWidth: 4, height: 160, quietZone: 6, showText: true },
    { moduleWidth: 5, height: 260, quietZone: 8 },
    { moduleWidth: 6, height: 200, quietZone: 10, showText: true }
  ];
  let total = 0, good = 0;
  for (const type of Object.keys(dataSets)) {
    for (const input of dataSets[type]) {
      const b = CodeTools.barcode.encode(type, input);
      if (!b.valid) { ok(false, type + ' ' + input, '编码失败: ' + b.error); continue; }
      for (const opt of renders) {
        total++;
        const img = CodeTools.util.rasterizeBarcode(b, opt);
        const t = timed(function () { return CodeTools.barcode.decode(img); });
        const r = t.r;
        const matched = r.ok && (r.text === b.text || r.ean13 === b.text);
        if (matched) good++;
        else ok(false, type + ' ' + b.text + ' / ' + JSON.stringify(opt),
          r.ok ? '得到 ' + JSON.stringify(r.text) : r.error);
        if (!QUICK && total === 1) {
          console.log('  首个条码解码耗时 ' + t.ms.toFixed(1) + ' ms（' + img.width + 'x' + img.height + '）');
        }
      }
    }
  }
  ok(good === total, '条码回环全部通过', good + '/' + total);
  console.log('  条码回环：%d/%d 组成功', good, total);
}

/* 旋转 0/90/180/270 */
section('7b. 条形码旋转');
{
  const cases = [
    ['ean13', '690123456789'], ['code128', 'ROT-TEST-1'], ['code39', 'ROTATE'],
    ['itf14', '1234567890123'], ['ean8', '1234567'], ['upca', '03600029145']
  ];
  let total = 0, good = 0;
  for (const [type, input] of cases) {
    const b = CodeTools.barcode.encode(type, input);
    for (const deg of [0, 90, 180, 270]) {
      total++;
      const img = CodeTools.util.rasterizeBarcode(b, { moduleWidth: 3, height: 120, quietZone: 10 });
      const r = CodeTools.barcode.decode(rotateImage(img, deg));
      const matched = r.ok && (r.text === b.text || r.ean13 === b.text);
      const expectRot = deg === 0 ? 0 : (360 - deg) % 360;
      if (matched && r.rotation === expectRot) good++;
      else ok(false, type + ' 旋转 ' + deg + '°', r.ok ? '文本 ' + r.text + ' rot ' + r.rotation : r.error);
    }
  }
  ok(good === total, '4 个方向旋转均正确', good + '/' + total);
  console.log('  旋转解码：%d/%d', good, total);
}

/* =====================================================================
 * 8. 降质解码
 * ===================================================================== */
section('8. 条形码降质解码（模糊 / 噪声 / JPEG 风格）');
if (QUICK) {
  console.log('  （--quick 跳过）');
} else {
  const cases = [
    ['ean13', '690123456789'], ['code128', 'DEGRADE-OK'], ['code39', 'BLUR'],
    ['itf14', '1234567890123'], ['ean8', '9638507'], ['upca', '03600029145']
  ];
  const degraders = [
    ['模糊1', function (img) { return blurImage(img, 1); }],
    ['模糊2', function (img) { return blurImage(img, 2); }],
    ['噪声10', function (img) { return noiseImage(img, 10, 7); }],
    ['噪声25', function (img) { return noiseImage(img, 25, 11); }],
    ['JPEG风格x2', function (img) { return jpegishImage(img, 2); }],
    ['模糊+噪声', function (img) { return noiseImage(blurImage(img, 1), 12, 13); }]
  ];
  for (const [type, input] of cases) {
    const b = CodeTools.barcode.encode(type, input);
    const line = [];
    for (const [name, fn] of degraders) {
      const img = CodeTools.util.rasterizeBarcode(b, { moduleWidth: 3, height: 140, quietZone: 10 });
      const r = CodeTools.barcode.decode(fn(img));
      const matched = r.ok && (r.text === b.text || r.ean13 === b.text);
      line.push(name + (matched ? '✔' : '✘'));
      ok(matched, type + ' ' + name, r.ok ? '文本 ' + r.text : r.error);
    }
    console.log('  %s: %s', type, line.join(' '));
  }
}

/* =====================================================================
 * 8b. 误报回归：二维码图片喂给条码解码器必须 ok:false
 * ===================================================================== */
section('8b. 误报回归（QR 图 -> barcode.decode）');
{
  const qrTexts = [
    'https://example.com/whatever',
    '轻办排版：单文件离线工具',
    '1234567890',
    'BEGIN:VCARD\nVERSION:3.0\nFN:张三\nEND:VCARD'
  ];
  let falsePositives = 0;
  for (const text of qrTexts) {
    const qr = CodeTools.qr.encode(text, { ecl: 'M' });
    for (const opt of [
      { scale: 4, quietZone: 4 },
      { scale: 6, quietZone: 4 },
      { scale: 8, quietZone: 4 },
      { scale: 4, quietZone: 4, invert: true },
      { scale: 3, quietZone: 2, background: '#e0e0e0' }
    ]) {
      const img = CodeTools.util.rasterizeQR(qr, opt);
      const r = CodeTools.barcode.decode(img);
      if (r.ok) {
        falsePositives++;
        ok(false, 'QR 图不应被识别为条码',
          JSON.stringify({ text: r.text, type: r.type, votes: r.votes, confidence: r.confidence }));
      }
    }
  }
  ok(falsePositives === 0, '二维码图片全部返回 ok:false（无误报）', String(falsePositives));

  // 六种条码都必须能解出（同一张图的正向断言）
  const six = [
    ['code128', 'LIGHTWORK-2026'],
    ['code39', 'LIGHTWORK'],
    ['ean13', '690123456789'],
    ['ean8', '1234567'],
    ['upca', '01234567890'],
    ['itf14', '1234567890123']
  ];
  let decoded = 0;
  for (const [type, input] of six) {
    const b = CodeTools.barcode.encode(type, input);
    const img = CodeTools.util.rasterizeBarcode(b, { moduleWidth: 3, height: 120, quietZone: 10 });
    const r = CodeTools.barcode.decode(img);
    const matched = r.ok && (r.text === b.text || r.ean13 === b.text);
    if (matched) decoded++;
    ok(matched, type + ' 正例可解码', r.ok ? '文本 ' + r.text : r.error);
    if (matched && r.votes !== undefined) {
      ok(r.votes >= 3 && r.confidence >= 70, type + ' 置信度达标',
        'votes=' + r.votes + ' confidence=' + r.confidence);
    }
  }
  ok(decoded === 6, '六种条码全部可解码', decoded + '/6');
}

/* =====================================================================
 * 9. 性能
 * ===================================================================== */
section('9. 性能（1000x1000）');
if (QUICK) {
  console.log('  （--quick 跳过）');
} else {
  // 二维码：v22 左右 -> 放大到约 1000px
  const text = 'PERF-TEST ' + 'abcdefghij'.repeat(24);
  const qr = CodeTools.qr.encode(text, { ecl: 'M' });
  const scale = Math.max(1, Math.round(1000 / (qr.size + 8)));
  const qimg = CodeTools.util.rasterizeQR(qr, { scale: scale, quietZone: 4 });
  let t0 = process.hrtime.bigint();
  const qrRes = CodeTools.qr.decode(qimg);
  let qms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  QR：' + qimg.width + 'x' + qimg.height + '，版本 ' + qr.version +
    '，解码 ' + qms.toFixed(1) + ' ms，成功=' + qrRes.ok);
  ok(qrRes.ok && qrRes.text === text, '1000px 二维码解码正确');
  ok(qms < 1500, '1000px 二维码解码 < 1.5s', qms.toFixed(1) + 'ms');

  // 第二张：构造真正的 1000x1000 画布（居中放置）
  const canvas = { data: new Uint8ClampedArray(1000 * 1000 * 4), width: 1000, height: 1000 };
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = 255; canvas.data[i + 1] = 255; canvas.data[i + 2] = 255; canvas.data[i + 3] = 255;
  }
  const ox = ((1000 - qimg.width) >> 1), oy = ((1000 - qimg.height) >> 1);
  for (let y = 0; y < qimg.height; y++) {
    for (let x = 0; x < qimg.width; x++) {
      const si = (y * qimg.width + x) * 4;
      const di = ((y + oy) * 1000 + (x + ox)) * 4;
      if (di < 0 || di + 3 >= canvas.data.length) continue;
      canvas.data[di] = qimg.data[si];
      canvas.data[di + 1] = qimg.data[si + 1];
      canvas.data[di + 2] = qimg.data[si + 2];
    }
  }
  t0 = process.hrtime.bigint();
  const qrRes2 = CodeTools.qr.decode(canvas);
  qms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  QR 1000x1000 画布：解码 ' + qms.toFixed(1) + ' ms，成功=' + qrRes2.ok);
  ok(qrRes2.ok && qrRes2.text === text, '1000x1000 画布二维码解码正确');
  ok(qms < 1500, '1000x1000 画布二维码解码 < 1.5s', qms.toFixed(1) + 'ms');

  // 条形码：1000x1000
  const bc = CodeTools.barcode.encode('code128', 'PERF-1000X1000-TEST');
  const bimg = CodeTools.util.rasterizeBarcode(bc, { moduleWidth: 5, height: 800, quietZone: 20 });
  t0 = process.hrtime.bigint();
  const bres = CodeTools.barcode.decode(bimg);
  const bms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  条码：' + bimg.width + 'x' + bimg.height + '，解码 ' + bms.toFixed(1) +
    ' ms，成功=' + bres.ok + '，文本=' + bres.text);
  ok(bres.ok && bres.text === bc.text, '1000px 条码解码正确');
  ok(bms < 1500, '1000px 条码解码 < 1.5s', bms.toFixed(1) + 'ms');

  // 编码耗时
  const encTimes = [];
  for (let i = 0; i < 20; i++) {
    const s = process.hrtime.bigint();
    CodeTools.qr.encode('ENCODE-PERF-' + i, { ecl: 'M' });
    encTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  encTimes.sort(function (a, b) { return a - b; });
  console.log('  QR 编码（20 次）：中位 ' + encTimes[10].toFixed(2) +
    ' ms，最大 ' + encTimes[19].toFixed(2) + ' ms');
  ok(encTimes[19] < 200, 'QR 编码 < 200ms/次', encTimes[19].toFixed(1) + 'ms');
}

/* =====================================================================
 * 10. util 辅助
 * ===================================================================== */
section('10. util 辅助');
{
  const img = CodeTools.util.rasterizeQR(CodeTools.qr.encode('UTIL', { ecl: 'L' }), { scale: 3 });
  const g = CodeTools.util.grayFromRGBA(img.data, img.width, img.height);
  eq(g.length, img.width * img.height, 'grayFromRGBA 长度 = w*h');
  eq(g[0], 255, '灰度静区为白');
  const back = CodeTools.util.rgbaFromGray(g, img.width, img.height);
  eq(back.length, img.width * img.height * 4, 'rgbaFromGray 长度 = w*h*4');

  const thr = CodeTools.util.otsuThreshold(g);
  ok(thr >= 0 && thr <= 255, 'otsuThreshold 返回 0..255', String(thr));

  const rot = CodeTools.util.rotateGray(g, img.width, img.height, 90);
  eq(rot.width, img.height, 'rotateGray 90° 宽高互换');
  eq(rot.height, img.width, 'rotateGray 90° 宽高互换（2）');

  const bytes = CodeTools.util.utf8Encode('中文✓');
  eq(bytes.length, 3 + 3 + 3, 'utf8Encode("中文✓") = 9 字节');
  eq(CodeTools.util.utf8Decode(bytes), '中文✓', 'utf8Decode 回环');

  // 空串 / 单字节 QR
  const empty = CodeTools.qr.encode('', { ecl: 'L' });
  const eimg = CodeTools.util.rasterizeQR(empty, { scale: 4 });
  const er = CodeTools.qr.decode(eimg);
  ok(er.ok && er.text === '', '空字符串二维码可解码');
}

/* =====================================================================
 * 汇总
 * ===================================================================== */
if (timings.length) {
  const sorted = timings.slice().sort(function (a, b) { return a - b; });
  console.log('\n解码耗时统计：样本 ' + sorted.length +
    '，中位 ' + sorted[sorted.length >> 1].toFixed(1) +
    ' ms，P90 ' + sorted[Math.floor(sorted.length * 0.9)].toFixed(1) +
    ' ms，最大 ' + sorted[sorted.length - 1].toFixed(1) + ' ms');
}
process.exit(summary() ? 0 : 1);
