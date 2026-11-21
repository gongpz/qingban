/* 构建轻办工具：始终从 _build/qb.base.html 重新构建，保证可重复执行
 * 默认只产出拆分版：E:\AI工作\轻办排版\qb-拆分版\index.html（库与面板脚本放 assets/）
 * 如需单文件版，运行：node integrate.js --single（输出 ../qb.html）
 */
const fs = require('fs');
const path = require('path');
const B = 'E:/AI工作/轻办排版/_build/';
const OUT = 'E:/AI工作/轻办排版/qb.html';
const BUILD_SINGLE = process.argv.includes('--single');
const OUT_SPLIT = 'E:/AI工作/轻办排版/qb-拆分版';

function read(p) { return fs.readFileSync(B + p, 'utf8'); }
function escScript(code) { return code.replace(/<\/script/gi, '<\\/script'); }

let html = read('qb.base.html').replace(/\r\n/g, '\n');

const css = read('panel-add.css');
const panels = read('panel-add.html');
const videoPanel = read('video-panel.html');
const audioJs = read('audio-panel.js');
const videoJs = read('video-panel.js');
const codeJs = read('code-panel.js');

const libs = [
  { file: 'lib/lame.min.js', id: 'lib-lamejs', label: 'lamejs · MP3 编码器（LGPL-3.0，见 https://github.com/zhuker/lamejs）' },
  { file: 'lib/wma-ape-decoders.js', id: 'lib-wmaape', label: 'WMA / APE 解码器（LGPL-2.1-or-later，内含 FFmpeg WASM 构建；见 @audio/decode-wma、@audio/decode-ape）' },
  { file: 'code-tools.js', id: 'lib-codetools', label: '二维码 / 条形码引擎（内含 jsQR，Apache-2.0）' },
  { file: 'flac-encoder.js', id: 'lib-flac', label: 'FLAC 无损编码器（纯 JS 实现）' },
  { file: 'audio-encoders.js', id: 'lib-audioenc', label: '音频编码器（WAV / MP3 / AAC / Opus）' },
  { file: 'video-engine.js', id: 'lib-video', label: '视频转码引擎（WebCodecs）', optional: true }
];
const panelsScripts = [
  { file: 'audio-panel.js', id: 'audio-panel-js' },
  { file: 'video-panel.js', id: 'video-panel-js' },
  { file: 'code-panel.js', id: 'code-panel-js' }
];

const licenseNote = `<!--
  第三方组件与许可证（均为本地内联，不发起网络请求）
  · lamejs 1.2.1 — LGPL-3.0 — https://github.com/zhuker/lamejs
  · jsQR 1.4.0 — Apache-2.0 — https://github.com/cozmo/jsQR
  · @audio/decode-wma 1.4.0 / @audio/decode-ape 1.0.0 — LGPL-2.1-or-later（内含 FFmpeg 精简构建的 WASM）
  · FFmpeg（libavcodec WMA/APE 解码）— LGPL-2.1-or-later — https://ffmpeg.org
  · mp4box.js — BSD-3-Clause — https://github.com/gpac/mp4box.js
  · mp4-muxer / webm-muxer — MIT — https://github.com/Vanilagy/mp4-muxer
  上述组件的完整许可证文本见 _build/lib 目录下的 LICENSE 文件。
-->
`;

function mustExist(p) {
  if (!fs.existsSync(B + p)) throw new Error('缺少文件：' + p);
}

/* ---------- 1. CSS ---------- */
const cssAnchor = '</style>\n</head>';
if (!html.includes(cssAnchor)) throw new Error('找不到 CSS 锚点');
html = html.replace(cssAnchor, function(){ return css.replace(/\n$/, '') + '\n</style>\n</head>'; });

/* ---------- 2. 导航按钮 ---------- */
const navAnchor = '    <button class="theme-btn" id="themeBtn" title="切换深浅色">';
if (!html.includes(navAnchor)) throw new Error('找不到导航锚点');
const navButtons = `    <button class="fn-btn" data-panel="audio">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14V9M8 18V6M12 16V8M16 20V4M20 13v-2"/></svg>
      音频压缩转换
    </button>
    <button class="fn-btn" data-panel="video">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg>
      视频压缩转换
    </button>
    <button class="fn-btn" data-panel="code">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h2.5v2.5H15zM21 15v.01M15 21v.01M18.5 21H21v-2.5"/></svg>
      二维码 / 条码
    </button>
`;
html = html.replace(navAnchor, function(){ return navButtons + navAnchor; });

/* ---------- 3. 面板 HTML ---------- */
const footAnchor = '  <div class="foot">© 2026 轻办';
if (!html.includes(footAnchor)) throw new Error('找不到面板锚点');
html = html.replace(footAnchor, function(){ return panels.replace(/\n$/, '') + '\n\n' + videoPanel.replace(/\n$/, '') + '\n\n' + footAnchor; });

/* ---------- 4. 面板映射 ---------- */
const mapOld = "var panels={voucher:'panel-voucher',compress:'panel-compress',convert:'panel-convert',cdr:'panel-cdr'};";
const mapNew = "var panels={voucher:'panel-voucher',compress:'panel-compress',convert:'panel-convert',cdr:'panel-cdr',audio:'panel-audio',video:'panel-video',code:'panel-code'};";
if (!html.includes(mapOld)) throw new Error('找不到面板映射');
html = html.replace(mapOld, function(){ return mapNew; });

/* ---------- 4.1 标题 ---------- */
const titleOld = '<title>轻办 · 文档 / 图片 / 凭证处理</title>';
const titleNew = '<title>轻办 · 文档 / 图片 / 音视频 / 二维码处理</title>';
if (html.includes(titleOld)) html = html.replace(titleOld, function () { return titleNew; });

/* ---------- 4.2 图片格式转换：精简说明文案 ---------- */
const TEXT_MAP = [
  ['PNG 无损输出，完整保留透明通道；转换不改变原始尺寸。', '无损输出，保留透明通道；不改变原始尺寸。'],
  ['WebP 支持透明且体积更小；转换不改变原始尺寸。', '支持透明且体积更小；转换不改变原始尺寸。'],
  ['ICO 会把原图居中裁切为正方形，再按下方尺寸输出。', '会把原图居中裁切为正方形，再输出。'],
  ['BMP 为 24 位无压缩位图，不支持透明；转换不改变原始尺寸。', '24位无压缩位图；转换不改变原始尺寸。'],
  ['JPG 不支持透明，透明区域按下方填充色处理；转换不改变原始尺寸。', '不支持透明，透明区域按下方填充色处理。']
];
for (const [from, to] of TEXT_MAP) {
  if (!html.includes(from)) throw new Error('找不到待替换文案：' + from);
  html = html.split(from).join(to);
}

/* ---------- 5. 单文件版（可选，仅 --single 时生成） ---------- */
const bodyAnchor = '</body>';
if (!html.includes(bodyAnchor)) throw new Error('找不到 body 锚点');
if (BUILD_SINGLE) {
  let libBlock = '\n' + licenseNote + '<!-- ==================== 新增功能内联库（本地离线，无网络请求） ==================== -->\n';
  for (const lib of libs) {
    if (!fs.existsSync(B + lib.file)) {
      if (lib.optional) { console.warn('跳过可选库：' + lib.file); continue; }
      mustExist(lib.file);
    }
    const code = escScript(read(lib.file));
    libBlock += `<script id="${lib.id}">\n/* ${lib.label} */\n${code}\n</script>\n`;
  }
  libBlock += `<script id="audio-panel-js">\n${escScript(audioJs)}</script>\n`;
  libBlock += `<script id="video-panel-js">\n${escScript(videoJs)}</script>\n`;
  libBlock += `<script id="code-panel-js">\n${escScript(codeJs)}</script>\n`;
  const singleHtml = html.replace(bodyAnchor, function(){ return libBlock + '\n</body>'; });
  fs.writeFileSync(OUT, singleHtml.replace(/\n/g, '\r\n'), 'utf8');
  console.log('单文件版：' + Buffer.byteLength(singleHtml, 'utf8') + ' 字节');
}

/* ---------- 6. 拆分版：库与面板脚本写入 assets/ ---------- */
fs.mkdirSync(path.join(OUT_SPLIT, 'assets'), { recursive: true });
let tagBlock = '\n' + licenseNote + '<!-- ==================== 新增功能（拆分版：脚本位于 assets/） ==================== -->\n';
for (const lib of libs) {
  if (!fs.existsSync(B + lib.file)) {
    if (lib.optional) { console.warn('跳过可选库：' + lib.file); continue; }
    mustExist(lib.file);
  }
  const code = read(lib.file);
  const name = path.basename(lib.file);
  fs.writeFileSync(path.join(OUT_SPLIT, 'assets', name), code, 'utf8');
  tagBlock += `<script src="assets/${name}" id="${lib.id}"></script>\n`;
}
for (const p of panelsScripts) {
  const code = read(p.file);
  const name = path.basename(p.file);
  fs.writeFileSync(path.join(OUT_SPLIT, 'assets', name), code, 'utf8');
  tagBlock += `<script src="assets/${name}" id="${p.id}"></script>\n`;
}
const splitHtml = html.replace(bodyAnchor, function(){ return tagBlock + '\n</body>'; });
fs.writeFileSync(path.join(OUT_SPLIT, 'index.html'), splitHtml.replace(/\n/g, '\r\n'), 'utf8');
console.log('拆分版：index.html ' + Buffer.byteLength(splitHtml, 'utf8') + ' 字节，assets 共 ' +
  fs.readdirSync(path.join(OUT_SPLIT, 'assets')).length + ' 个文件');
