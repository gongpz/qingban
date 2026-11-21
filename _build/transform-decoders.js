/* 把 @audio/decode-wma 与 @audio/decode-ape 的 ESM 模块转换为可内联的 classic script */
const fs = require('fs');
const B = 'E:/AI工作/轻办排版/_build/';

function toGlue(file, createName, globalName) {
  let s = fs.readFileSync(B + file, 'utf8');
  s = s.replace(/import\.meta\.url/g, '"inline://qb"');
  const tailRe = new RegExp('export\\s+default\\s+' + createName + '\\s*;?\\s*$');
  if (!tailRe.test(s)) throw new Error('未找到 glue 导出：' + file);
  s = s.replace(tailRe, '');
  if (/^\s*(import|export)\s/m.test(s)) throw new Error('glue 中仍存在 ESM 语法：' + file);
  return ';(function(){\n' + s + '\nwindow.' + globalName + '=' + createName + ';\n})();\n';
}

function toDecoder(file, importLine, createName, exposes) {
  let s = fs.readFileSync(B + file, 'utf8');
  const idx = s.indexOf(importLine);
  if (idx < 0) throw new Error('未找到 import：' + file);
  s = s.slice(0, idx) + s.slice(idx + importLine.length);
  s = s.replace(/export\s+default\s+/g, '');
  s = s.replace(/export\s+async\s+function\s+/g, 'async function ');
  s = s.replace(/export\s+function\s+/g, 'function ');
  s = s.replace(/export\s+const\s+/g, 'const ');
  if (/^\s*(import|export)\s/m.test(s)) throw new Error('decoder 中仍存在 ESM 语法：' + file);
  let epilogue = '';
  for (const k in exposes) epilogue += 'window.' + k + '=' + exposes[k] + ';\n';
  return ';(function(){\nvar ' + createName + ' = window.' + 'X_' + createName + ';\n' + s + '\n' + epilogue + '})();\n';
}

const wmaGlue = toGlue('lib/wmaape/decode-wma/package/src/wma.wasm.js', 'createWMA', 'X_createWMA');
const wmaDec = toDecoder('lib/wmaape/decode-wma/package/decode-wma.js', "import createWMA from './src/wma.wasm.js'", 'createWMA',
  { WmaDecode: 'decode', WmaDecoder: 'decoder', WmaDemux: 'demuxASF' });
const apeGlue = toGlue('lib/wmaape/decode-ape/package/src/ape.wasm.js', 'createApe', 'X_createApe');
const apeDec = toDecoder('lib/wmaape/decode-ape/package/decode-ape.js', "import createApe from './src/ape.wasm.js'", 'createApe',
  { ApeDecode: 'decode', ApeDecoder: 'decoder' });

const banner = `/*!
 * WMA / APE 解码器（内联，离线可用）
 * - @audio/decode-wma 1.4.0 / @audio/decode-ape 1.0.0
 * - 内含 FFmpeg 精简构建（libavcodec/ape、wmav1/wmav2/wmapro/wmalossless）编译的 WASM
 * - 许可证：LGPL-2.1-or-later（FFmpeg 部分），包装代码 MIT
 * - 完整许可见 _build/lib/wmaape/* /package/LICENSE 与 LICENSE.ffmpeg
 */
`;
fs.writeFileSync(B + 'lib/wma-ape-decoders.js', banner + wmaGlue + wmaDec + apeGlue + apeDec, 'utf8');
console.log('written', fs.statSync(B + 'lib/wma-ape-decoders.js').size, 'bytes');
