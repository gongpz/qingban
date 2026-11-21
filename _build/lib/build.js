/* build-code-tools.js —— 组装单文件模块 code-tools.js
 *
 *   node lib/build.js            # 生成 ../code-tools.js
 *   node lib/build.js --check    # 只检查语法与体积，不写文件
 *
 * 组成：head.js(文档/版权) + jsQR.min.js(内联) + tables.js + util.js +
 *       qr.js + barcode.js + api.js，整体包在 UMD 外套里。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, '..', 'code-tools.js');

function read(f) {
  return fs.readFileSync(path.join(SRC, f), 'utf8');
}

function stripSourceMap(code) {
  return code.replace(/\/\/#\s*sourceMappingURL=[^\n]*/g, '')
             .replace(/^\/\*\*[\s\S]*?Minified by jsDelivr[\s\S]*?\*\/\s*/, '');
}

const jsqrRaw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jsQR.min.js'), 'utf8');
const jsqr = stripSourceMap(jsqrRaw).trim();

const head = read('head.js');
const parts = ['tables.js', 'util.js', 'qr.js', 'barcode.js', 'api.js'].map(read);

const out = [
  head,
  '(function (root, factory) {',
  "  'use strict';",
  '  var api = factory();',
  "  if (typeof module === 'object' && module && module.exports) { module.exports = api; }",
  '  if (root) { root.CodeTools = api; }',
  "  if (typeof define === 'function' && define.amd) { define(function () { return api; }); }",
  "})(typeof globalThis !== 'undefined' ? globalThis :",
  "   (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this))",
  '   , function () {',
  "  'use strict';",
  '',
  '  // ===================== jsQR v1.4.0 (Apache-2.0) 内联开始 =====================',
  '  var jsQR = (function () {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  jsqr,
  '    ;',
  '    return module.exports;',
  '  })();',
  '  // ===================== jsQR v1.4.0 内联结束 ==============================',
  '',
  parts.join('\n'),
  '',
  '  return CodeTools;',
  '});',
  ''
].join('\n');

fs.writeFileSync(OUT, out, 'utf8');

// ---- 自检：语法 + 体积 ----
let ok = true;
try {
  new Function(out);
} catch (e) {
  ok = false;
  console.error('语法检查失败:', e.message);
}
const size = Buffer.byteLength(out, 'utf8');
const lines = out.split('\n').length;
console.log('生成 %s', OUT);
console.log('体积 %s KB (%d 字节)，%d 行，语法 %s', (size / 1024).toFixed(1), size, lines, ok ? 'OK' : 'FAIL');
if (size > 400 * 1024) {
  console.error('警告：体积超过 400KB');
  ok = false;
}
process.exit(ok ? 0 : 1);
