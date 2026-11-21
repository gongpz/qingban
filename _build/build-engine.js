/* 构建 video-engine.js：内联 mp4box / mp4-muxer / webm-muxer + HEVC 软解 glue & wasm(base64)，输出单文件 classic script */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LIB = path.join(ROOT, 'lib');
const SRC = path.join(ROOT, 'src', 'video-engine.src.js');
const OUT = path.join(ROOT, 'video-engine.js');
const MARKER = '/*__LIBRARIES__*/';
const HEVC_GLUE_MARKER = '/*__HEVC_GLUE__*/';
const HEVC_WASM_MARKER = '/*__HEVC_WASM__*/';

const libs = [
  { file: 'mp4box.all.min.js', name: 'mp4box.js 0.5.4', license: 'BSD-3-Clause' },
  { file: 'mp4-muxer.js', name: 'mp4-muxer 5.2.1', license: 'MIT' },
  { file: 'webm-muxer.js', name: 'webm-muxer 5.1.4', license: 'MIT' }
];
const HEVC_GLUE = path.join(LIB, 'hevc', 'core-1.9.1', 'package', 'dist', 'wasm', 'hevc-decode.js');
const HEVC_WASM = path.join(LIB, 'hevc', 'core-1.9.1', 'package', 'dist', 'wasm', 'hevc-decode.wasm');

function read(p) { return fs.readFileSync(p, 'utf8'); }

let src = read(SRC);
for (const m of [MARKER, HEVC_GLUE_MARKER, HEVC_WASM_MARKER]) {
  if (src.indexOf(m) < 0) throw new Error('源码中找不到注入标记 ' + m);
}

// 引擎自身代码的语法约束自检（不含第三方库 / wasm）
const engineOnly = src;
const forbidden = [
  { re: /^\s*import\s/m, msg: 'import 语句' },
  { re: /^\s*export\s/m, msg: 'export 语句' },
  { re: /\brequire\s*\(/, msg: 'require() 调用' },
  { re: /\?\./, msg: '可选链 (?.，ES2020)' },
  { re: /\?\?/, msg: '空值合并 (??，ES2020)' },
  { re: /\.flat\s*\(/, msg: 'Array.flat（ES2019）' },
  { re: /Object\.fromEntries/, msg: 'Object.fromEntries（ES2019）' },
  { re: /catch\s*\{\s*\}/, msg: '省略 catch 绑定（ES2019）' }
];
const syntaxProblems = forbidden.filter(f => f.re.test(engineOnly)).map(f => f.msg);

let libCode = '';
let libBytes = 0;
for (const l of libs) {
  const p = path.join(LIB, l.file);
  const code = read(p);
  libBytes += Buffer.byteLength(code, 'utf8');
  libCode += '\n/* ===== 内联第三方库：' + l.name + '（' + l.license + '）===== */\n' + code + '\n';
}

const hevcGlue = read(HEVC_GLUE);
const wasmBytes = fs.readFileSync(HEVC_WASM);
const wasmB64 = wasmBytes.toString('base64');
const hevcWasmCode = 'var HEVC_WASM_B64 = ' + JSON.stringify(wasmB64) + ';';

let bundle = src
  .replace(MARKER, libCode)
  .replace(HEVC_GLUE_MARKER, '/* ===== 内联 HEVC 软解：@hevcjs/core 1.9.1 hevc-decode.js（MIT）===== */\n' + hevcGlue)
  .replace(HEVC_WASM_MARKER, '/* ===== 内联 HEVC 软解：hevc-decode.wasm ' + wasmBytes.length + 'B base64（MIT）===== */\n' + hevcWasmCode);

fs.writeFileSync(OUT, bundle);

const bundleBytes = fs.statSync(OUT).size;
const engineBytes = Buffer.byteLength(src, 'utf8');
const hevcAdd = Buffer.byteLength(hevcGlue, 'utf8') + Buffer.byteLength(hevcWasmCode, 'utf8');
console.log('引擎源码：' + (engineBytes / 1024).toFixed(1) + ' KB');
console.log('第三方库：' + (libBytes / 1024).toFixed(1) + ' KB（' + libs.map(l => l.file + ' ' + (fs.statSync(path.join(LIB, l.file)).size / 1024).toFixed(1) + 'KB').join(', ') + '）');
console.log('HEVC 软解新增：' + (hevcAdd / 1024).toFixed(1) + ' KB（glue ' + (Buffer.byteLength(hevcGlue) / 1024).toFixed(1) + 'KB + wasm base64 ' + (Buffer.byteLength(wasmB64) / 1024).toFixed(1) + 'KB，原始 wasm ' + (wasmBytes.length / 1024).toFixed(1) + 'KB）');
console.log('产物：' + OUT + '  ' + (bundleBytes / 1024).toFixed(1) + ' KB');
if (syntaxProblems.length) {
  console.log('语法约束问题：' + syntaxProblems.join('；'));
  process.exitCode = 1;
} else {
  console.log('语法约束检查：通过（引擎自身代码无 import/export/require/ES2019+ 语法）');
}
if (hevcAdd > 700 * 1024) {
  console.log('HEVC 新增超标：' + hevcAdd + ' > 716800');
  process.exitCode = 1;
} else {
  console.log('HEVC 新增体积检查：通过（≤700 KB）');
}
