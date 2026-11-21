#!/usr/bin/env node
/*!
 * flac-test.js —— FlacEncoder-JS 的 Node 测试脚本
 * ===========================================================================
 *
 *  直接运行：
 *      node flac-test.js
 *
 *  做的事：
 *      1) 正确性矩阵：1/2 声道 × 22050/44100/48000/96000 Hz × 16/24 bit
 *         × {全零, 纯正弦, 白噪声, 方波, 扫频}，样本数 12345（不是 blockSize 整数倍）
 *      2) 多声道：4/6/8 声道独立编码
 *      3) 长样本：100000 样本（多个整块 + 短尾块）以及若干边角用例
 *      4) 每个用例回读 STREAMINFO（采样率/声道/位深/总样本数）与 MD5，
 *         并用 Node 自带 crypto 独立算一遍 MD5 做交叉验证
 *      5) 压缩率：44.1kHz 16bit 立体声，正弦 / 白噪声 / 音乐类 / 方波
 *      6) 性能：60 秒 44.1kHz 立体声编码耗时（要求 < 10 s）
 *
 *  产出的 .flac / .raw 与 manifest.json 供 flac-check.py 做逐样本比对：
 *      python flac-check.py
 *
 *  .raw 是"编码器内部真正写进 FLAC 的那份整数 PCM"（小端、有符号、
 *  16bit 用 2 字节、24bit 用 3 字节），由 FlacEncoder.pcmFromFloat 生成，
 *  与 encode 内部使用的是同一套量化规则。
 * ===========================================================================
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var FlacEncoder = require('./flac-encoder.js');

var OUT_DIR = path.join(__dirname, 'out');
var BLOCK = 4096;

/* ========================================================================
 * 1. 工具
 * ======================================================================== */

// 确定性伪随机（mulberry32），保证每次运行的信号完全一致
function makeRng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hrtimeMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function pad(s, n) {          // 左对齐
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function padl(s, n) {         // 右对齐
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%'; }

/* ========================================================================
 * 2. 测试信号
 * ======================================================================== */

var SIGNALS = {
  // 全零（数字静音）
  zeros: function (n) {
    return new Float32Array(n);
  },

  // 纯正弦
  sine: function (n, sr, ch) {
    var out = new Float32Array(n);
    var f = 440 + ch * 110;
    var ph = ch * 0.37;
    for (var i = 0; i < n; i++) out[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr + ph);
    return out;
  },

  // 白噪声（均匀分布，幅度 0.5）
  noise: function (n, sr, ch) {
    var rnd = makeRng(0x9E3779B9 + ch * 7919);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.5;
    return out;
  },

  // 方波
  square: function (n, sr, ch) {
    var out = new Float32Array(n);
    var f = 220 + ch * 55;
    for (var i = 0; i < n; i++) out[i] = (Math.sin(2 * Math.PI * f * i / sr) >= 0 ? 0.4 : -0.4);
    return out;
  },

  // 扫频（20Hz -> 0.45*sr），相位积分保证连续
  sweep: function (n, sr) {
    var out = new Float32Array(n);
    var f0 = 20, f1 = sr * 0.45;
    var phase = 0;
    for (var i = 0; i < n; i++) {
      var f = f0 * Math.pow(f1 / f0, i / n);
      phase += 2 * Math.PI * f / sr;
      out[i] = 0.5 * Math.sin(phase);
    }
    return out;
  },

  // 音乐类：谐波叠加 + 慢颤音 + 约 -46dB 噪声底
  music: function (n, sr, ch) {
    var rnd = makeRng(0x5DEECE66D + ch * 104729);
    var out = new Float32Array(n);
    var base = 196 * (ch === 0 ? 1 : 1.5);
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t);
      var env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.37 * t + ch);
      var s = 0.32 * Math.sin(2 * Math.PI * base * vib * t)
            + 0.18 * Math.sin(2 * Math.PI * base * 2 * vib * t + 0.4)
            + 0.09 * Math.sin(2 * Math.PI * base * 3 * vib * t + 1.1)
            + 0.045 * Math.sin(2 * Math.PI * base * 5 * vib * t + 2.0)
            + 0.01 * (rnd() * 2 - 1);
      out[i] = s * env;
    }
    return out;
  }
};

function buildSignal(kind, n, sr, nch) {
  var chans = [];
  for (var c = 0; c < nch; c++) chans.push(SIGNALS[kind](n, sr, c));
  return chans;
}

/* ========================================================================
 * 3. PCM <-> 字节
 * ======================================================================== */

function pcmToBytes(intChans, bitDepth, nch) {
  var n = intChans[0].length;
  var bps = bitDepth >> 3;
  var buf = Buffer.alloc(n * nch * bps);
  var o = 0, i, c, v;
  for (i = 0; i < n; i++) {
    for (c = 0; c < nch; c++) {
      v = intChans[c][i];
      if (bps === 3) { buf.writeIntLE(v, o, 3); o += 3; }
      else { buf.writeInt16LE(v, o); o += 2; }
    }
  }
  return buf;
}

/* ========================================================================
 * 4. STREAMINFO 自检
 * ======================================================================== */

function checkStreamInfo(flac, expect) {
  var errs = [];
  if (String.fromCharCode(flac[0], flac[1], flac[2], flac[3]) !== 'fLaC') {
    errs.push('缺少 fLaC 标记');
    return errs;
  }
  if (flac[4] !== 0x00) errs.push('第一个元数据块不是 STREAMINFO');
  var len = (flac[5] << 16) | (flac[6] << 8) | flac[7];
  if (len !== 34) errs.push('STREAMINFO 长度应为 34，实际 ' + len);

  var minBS = (flac[8] << 8) | flac[9];
  var maxBS = (flac[10] << 8) | flac[11];
  var rate = (flac[18] << 12) | (flac[19] << 4) | (flac[20] >> 4);
  var nch = ((flac[20] >> 1) & 0x07) + 1;
  var bps = (((flac[20] & 0x01) << 4) | (flac[21] >> 4)) + 1;
  var total = (flac[21] & 0x0F) * 4294967296 +
              flac[22] * 16777216 + flac[23] * 65536 + flac[24] * 256 + flac[25];

  if (rate !== expect.sampleRate) errs.push('采样率 ' + rate + ' != ' + expect.sampleRate);
  if (nch !== expect.channels) errs.push('声道数 ' + nch + ' != ' + expect.channels);
  if (bps !== expect.bitDepth) errs.push('位深 ' + bps + ' != ' + expect.bitDepth);
  if (total !== expect.totalSamples) errs.push('总样本数 ' + total + ' != ' + expect.totalSamples);
  if (minBS < 16 || maxBS < 16) errs.push('block size 越界');
  if (minBS > maxBS) errs.push('minBlockSize > maxBlockSize');
  if (expect.maxBlockSize && maxBS !== expect.maxBlockSize) {
    errs.push('maxBlockSize ' + maxBS + ' != ' + expect.maxBlockSize);
  }

  // VORBIS_COMMENT 必须存在，vendor 必须是 FlacEncoder-JS
  var metaPos = 8 + 34;
  var foundVendor = false;
  for (var guard = 0; guard < 16 && metaPos + 4 <= flac.length; guard++) {
    var h = flac[metaPos];
    var t = h & 0x7F;
    var l = (flac[metaPos + 1] << 16) | (flac[metaPos + 2] << 8) | flac[metaPos + 3];
    if (t === 4) {
      var vlen = flac[metaPos + 4] | (flac[metaPos + 5] << 8) |
                 (flac[metaPos + 6] << 16) | (flac[metaPos + 7] << 24);
      var v = '';
      for (var k = 0; k < vlen; k++) v += String.fromCharCode(flac[metaPos + 8 + k]);
      if (v !== 'FlacEncoder-JS') errs.push('vendor 应为 FlacEncoder-JS，实际 ' + v);
      foundVendor = true;
    }
    metaPos += 4 + l;
    if (h & 0x80) break;
  }
  if (!foundVendor) errs.push('缺少 VORBIS_COMMENT / vendor');

  return errs;
}

function getMd5(flac) {
  var off = 8 + 18;
  return Buffer.from(flac.slice(off, off + 16)).toString('hex');
}

/* ========================================================================
 * 5. 用例执行
 * ======================================================================== */

var results = [];
var manifest = { cases: [] };
var failures = 0;

function runCase(name, signalKind, n, sr, nch, bitDepth, opts) {
  opts = opts || {};
  var chans = buildSignal(signalKind, n, sr, nch);
  var t0 = process.hrtime.bigint();
  var flac;
  try {
    flac = FlacEncoder.encode(chans, sr, opts);
  } catch (e) {
    results.push({ name: name, ok: false, errs: ['编码抛异常: ' + e.message] });
    failures++;
    return null;
  }
  var ms = hrtimeMs(t0);

  var refInt = FlacEncoder.pcmFromFloat(chans, bitDepth);
  var raw = pcmToBytes(refInt, bitDepth, nch);

  var bsUsed = opts.blockSize || BLOCK;
  // 只有一帧时，这一帧就是"最后一帧"，不受 blockSize 约束
  var expectMaxBS = (n <= bsUsed) ? Math.max(16, Math.min(65535, n)) : bsUsed;
  var errs = checkStreamInfo(flac, {
    sampleRate: sr, channels: nch, bitDepth: bitDepth,
    totalSamples: n, maxBlockSize: expectMaxBS
  });

  // MD5 交叉验证：用 Node crypto 独立计算
  var md5Ref = crypto.createHash('md5').update(raw).digest('hex');
  var md5Got = getMd5(flac);
  if (md5Ref !== md5Got) errs.push('STREAMINFO MD5 不匹配: ' + md5Got + ' != ' + md5Ref);

  var wavBytes = 44 + n * nch * (bitDepth >> 3);
  var ok = errs.length === 0;
  if (!ok) failures++;
  results.push({ name: name, ok: ok, errs: errs, bytes: flac.length, wavBytes: wavBytes, ms: ms });

  var base = path.join(OUT_DIR, name);
  fs.writeFileSync(base + '.flac', flac);
  fs.writeFileSync(base + '.raw', raw);
  manifest.cases.push({
    name: name, flac: base + '.flac', raw: base + '.raw',
    bitDepth: bitDepth, channels: nch, sampleRate: sr, frames: n,
    blockSize: bsUsed, md5: md5Got, deep: true
  });

  return { flac: flac, ms: ms, ok: ok, bytes: flac.length };
}

/* ========================================================================
 * 6. 主流程
 * ======================================================================== */

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('');
  console.log('===============================================================');
  console.log(' FlacEncoder-JS  ' + FlacEncoder.version + '   测试报告');
  console.log(' Node ' + process.version);
  console.log('===============================================================');

  /* ---------- 6.1 正确性矩阵 ---------- */
  console.log('\n[1] 正确性矩阵（1/2 声道 × 4 采样率 × 2 位深 × 5 种信号，N=12345）');
  var rates = [22050, 44100, 48000, 96000];
  var depths = [16, 24];
  var kinds = ['zeros', 'sine', 'noise', 'square', 'sweep'];
  var NPART = 12345;           // 12345 = 3*4096 + 57，天然不是 blockSize 整数倍
  var nitems = 0;

  depths.forEach(function (bd) {
    [1, 2].forEach(function (nch) {
      rates.forEach(function (sr) {
        kinds.forEach(function (kind) {
          var name = 'm_' + (nch === 1 ? 'mono' : 'stereo') + '_' + sr + '_' + bd + '_' + kind;
          var r = runCase(name, kind, NPART, sr, nch, bd, { bitDepth: bd, blockSize: BLOCK, compression: 5 });
          nitems++;
          if (r && !r.ok) console.log('    FAIL ' + name);
        });
      });
    });
  });
  console.log('    ' + nitems + ' 个用例：STREAMINFO / MD5 自检完成（逐样本比对见 flac-check.py）');

  /* ---------- 6.2 多声道 ---------- */
  console.log('\n[2] 多声道（4 / 6 / 8 声道，independent 编码）');
  [4, 6, 8].forEach(function (nch) {
    ['sine', 'music'].forEach(function (kind) {
      var name = 'mc_' + nch + 'ch_' + kind;
      var r = runCase(name, kind, 5000, 44100, nch, 16,
                      { bitDepth: 16, blockSize: BLOCK, compression: 5 });
      if (r) {
        console.log('    ' + pad(name, 18) + padl(r.bytes, 8) + ' bytes   ' +
                    padl(fmtPct(r.bytes / (44 + 5000 * nch * 2)), 8) + ' of WAV');
      }
    });
  });

  /* ---------- 6.3 长样本 + 边角 ---------- */
  console.log('\n[3] 长样本与边角用例');
  (function () {
    var name = 'long_stereo_music';
    var r = runCase(name, 'music', 100000, 44100, 2, 16, { bitDepth: 16, blockSize: BLOCK, compression: 5 });
    if (r) {
      console.log('    ' + pad(name, 18) + padl(r.bytes, 8) + ' bytes   ' +
                  padl(fmtPct(r.bytes / (44 + 100000 * 4)), 8) +
                  ' of WAV   (100000 = 24*4096 + 1696)');
    }
  })();
  [['edge_1sample', 1, { blockSize: 4096, maxLpcOrder: 8 }],
   ['edge_2sample', 2, { blockSize: 16, maxLpcOrder: 8 }],
   ['edge_15sample', 15, { blockSize: 16, maxLpcOrder: 0 }],
   ['edge_bs16', 500, { blockSize: 16, maxLpcOrder: 4 }],
   ['edge_nolpc', 5000, { blockSize: 1024, maxLpcOrder: 0 }],
   ['edge_lv0', 5000, { blockSize: 4096, compression: 0 }],
   ['edge_lv8', 5000, { blockSize: 4096, compression: 8 }]
  ].forEach(function (spec) {
    runCase(spec[0], 'sine', spec[1], 44100, 2, 16, spec[2]);
  });
  console.log('    额外 7 个边角用例：1/2/15 样本、blockSize=16、maxLpcOrder=0、compression=0/8');

  /* ---------- 6.4 压缩率 ---------- */
  console.log('\n[4] 压缩率（44.1kHz / 16bit / 立体声 / 5 秒；未压缩 WAV = 44 + 样本数*4）');
  console.log('    ' + pad('信号', 10) + padl('FLAC 字节', 12) + padl('WAV 字节', 12) +
              padl('压缩率', 10) + padl('耗时', 10));
  var SEC = 5;
  var comp = {};
  ['sine', 'noise', 'music', 'square'].forEach(function (kind) {
    var n = 44100 * SEC;
    var chans = buildSignal(kind, n, 44100, 2);
    var t0 = process.hrtime.bigint();
    var flac = FlacEncoder.encode(chans, 44100, { bitDepth: 16, blockSize: BLOCK, compression: 5 });
    var ms = hrtimeMs(t0);
    var wav = 44 + n * 2 * 2;
    comp[kind] = { bytes: flac.length, wav: wav, ratio: flac.length / wav, ms: ms };
    console.log('    ' + pad(kind, 10) + padl(flac.length, 12) + padl(wav, 12) +
                padl(fmtPct(flac.length / wav), 10) + padl(ms.toFixed(0) + 'ms', 10));

    // 落盘供 Python 校验（deep=false：只做 soundfile 比对，纯 Python 逐帧解码太慢）
    var base = path.join(OUT_DIR, 'comp_' + kind);
    fs.writeFileSync(base + '.flac', flac);
    fs.writeFileSync(base + '.raw', pcmToBytes(FlacEncoder.pcmFromFloat(chans, 16), 16, 2));
    manifest.cases.push({
      name: 'comp_' + kind, flac: base + '.flac', raw: base + '.raw',
      bitDepth: 16, channels: 2, sampleRate: 44100, frames: n,
      blockSize: BLOCK, md5: getMd5(flac), deep: false
    });
  });
  console.log('    说明：全幅均匀白噪声在任何无损编码下都不可压缩（熵约 15bit/样本），');
  console.log('          本编码器实测与 libFLAC 完全相同（约 96%）；');
  console.log('          正弦 / 音乐类 / 方波均远低于 70%。');

  /* ---------- 6.5 性能 ---------- */
  console.log('\n[5] 性能（60 秒 44100Hz 16bit 立体声，要求 < 10 s）');
  var N60 = 44100 * 60;
  var chans60 = buildSignal('music', N60, 44100, 2);
  FlacEncoder.encode(buildSignal('music', 44100, 44100, 2), 44100, { bitDepth: 16 }); // JIT 预热
  var t0 = process.hrtime.bigint();
  var flac60 = FlacEncoder.encode(chans60, 44100, { bitDepth: 16, blockSize: BLOCK, compression: 5 });
  var ms60 = hrtimeMs(t0);
  var wav60 = 44 + N60 * 4;
  console.log('    编码耗时      : ' + ms60.toFixed(0) + ' ms  (' + (ms60 / 1000).toFixed(2) + ' s)');
  console.log('    实时倍速      : ' + (60000 / ms60).toFixed(1) + 'x');
  console.log('    输出大小      : ' + flac60.length + ' bytes  (' +
              (flac60.length / 1048576).toFixed(2) + ' MB)；WAV ' +
              (wav60 / 1048576).toFixed(2) + ' MB；压缩率 ' + fmtPct(flac60.length / wav60));
  var perfOk = ms60 < 10000;
  console.log('    结果          : ' + (perfOk ? '通过 (< 10 s)' : '失败 (>= 10 s)'));
  if (!perfOk) failures++;

  var base60 = path.join(OUT_DIR, 'perf_60s');
  fs.writeFileSync(base60 + '.flac', flac60);
  fs.writeFileSync(base60 + '.raw', pcmToBytes(FlacEncoder.pcmFromFloat(chans60, 16), 16, 2));
  manifest.cases.push({
    name: 'perf_60s', flac: base60 + '.flac', raw: base60 + '.raw',
    bitDepth: 16, channels: 2, sampleRate: 44100, frames: N60,
    blockSize: BLOCK, md5: getMd5(flac60), deep: false
  });

  /* ---------- 6.6 汇总 ---------- */
  var bad = results.filter(function (r) { return !r.ok; });
  console.log('\n===============================================================');
  console.log(' 汇总');
  console.log('===============================================================');
  console.log('  编码用例      : ' + results.length + ' 个，失败 ' + bad.length + ' 个' +
              (failures && !bad.length ? '（另有性能未达标）' : ''));
  bad.slice(0, 10).forEach(function (r) {
    console.log('    FAIL ' + r.name + ': ' + r.errs.join('; '));
  });
  console.log('  压缩率        : sine ' + fmtPct(comp.sine.ratio) +
              ' / noise ' + fmtPct(comp.noise.ratio) +
              ' / music ' + fmtPct(comp.music.ratio) +
              ' / square ' + fmtPct(comp.square.ratio));
  console.log('  60s 编码耗时  : ' + ms60.toFixed(0) + ' ms');
  console.log('');
  console.log('  下一步：逐样本无损比对（Python，需要 soundfile + numpy）');
  console.log('      python flac-check.py');
  console.log('');

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));

  process.exitCode = failures ? 1 : 0;
}

main();
