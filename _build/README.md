# 轻办 · 构建说明（拆分版）

本目录是**源码拆分 + 可重复构建 + 自动化测试**工作区。
应用由 `qb.base.html`（原始版本快照）与下列片段合并生成，不要直接手改生成的 `index.html` / `assets/`（下次构建会被覆盖）。

产物：

| 产物 | 说明 |
|---|---|
| `../qb-拆分版/index.html` + `assets/` | **唯一发布版本（拆分版）**：库与面板脚本放在 `assets/`，`index.html` 约 1 MB，整个文件夹一起拷贝即可 |
| `../qb.html` | 可选单文件版，仅当运行 `node integrate.js --single` 时生成（默认不生成） |

GitHub 仓库 `gongpz/qingban` 的根目录就是拆分版的 `index.html` + `assets/`（GitHub Pages：
https://gongpz.github.io/qingban/ ），`_build/` 为同一份源码。

## 目录

| 路径 | 说明 |
|---|---|
| `qb.base.html` | 改动前的原始 qb.html 快照（构建基底） |
| `panel-add.css` | 新增面板的样式（追加到主 `<style>` 末尾） |
| `panel-add.html` | 音频 / 二维码条码面板 HTML |
| `video-panel.html` | 视频面板 HTML |
| `audio-panel.js` | 音频压缩转换面板逻辑 |
| `video-panel.js` | 视频压缩转换面板逻辑 |
| `code-panel.js` | 二维码 / 条形码面板逻辑 |
| `flac-encoder.js` | 纯 JS FLAC 无损编码器（`FlacEncoder.encode`） |
| `audio-encoders.js` | WAV / MP3(lamejs) / AAC(ADTS) / Ogg-Opus 编码器（`AudioEnc`） |
| `video-engine.js` | 视频转码引擎（`VideoEngine`：解封装 + WebCodecs 编解码 + 封装，内含 mp4box/muxer） |
| `code-tools.js` | 二维码/条码生成 + 解码（`CodeTools`，内含 jsQR） |
| `lib/lame.min.js` | lamejs 1.2.1（MP3 编码） |
| `lib/mp4box.all.min.js` | mp4box.js（MP4/MOV 解封装，已内联进 video-engine.js，此处留档） |
| `lib/mp4-muxer.js` / `lib/webm-muxer.js` | MP4 / WebM 封装库（同上） |
| `lib/jsQR.min.js` | jsQR 1.4.0（二维码解码，已内联进 code-tools.js，此处留档） |
| `lib/wma-ape-decoders.js` | WMA / APE 解码器（Emscripten WASM，已转为 classic script） |
| `lib/wmaape/` | 上述解码器的上游原始包（含 LICENSE / LICENSE.ffmpeg） |
| `integrate.js` | 构建脚本：从 `qb.base.html` 生成单文件版与拆分版（Node） |
| `run-tests.js` + `inpage-tests.js` | 无头 Edge/CDP 自动化测试（74 项断言 + 截图） |
| `responsive.js` | 多视口宽度横向溢出检查 + 响应式截图 |
| `samples/` | 视频测试样本（MP4 / WebM / 竖屏 / HEVC），可删除 |
| `shots/` | 自动化测试截取的界面截图 |

## 重新构建

```powershell
$node = "C:\Users\Mask\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node integrate.js            # 只生成 ../qb-拆分版/index.html + assets/
& $node integrate.js --single   # 额外生成单文件版 ../qb.html（可选）
& $node run-tests.js "E:\AI工作\轻办排版\qb-拆分版\index.html"   # 无头 Edge 回归（74 项）
```

`integrate.js` 总是从 `qb.base.html` 重新合并，可安全重复执行（幂等）。
插入点：
1. 主样式表末尾（`</style></head>` 前）
2. 顶栏 `theme-btn` 前（3 个导航按钮）
3. 页脚前（3 个面板）
4. `var panels={...}` 映射中加入 `audio` / `video` / `code`
5. `</body>` 前：库 + 3 个面板脚本（拆分版写入 `assets/` 并用 `<script src>` 引用）

## 发布到 GitHub（gongpz/qingban）

仓库根目录 = 拆分版成品（`index.html` + `assets/`）+ `_build/` 源码。本机若没有系统 Git，
可用内置的便携版：`_build\tools\mingit\cmd\git.exe`（已在 `.gitignore` 中排除，不推送）。

```powershell
$git  = "E:\AI工作\轻办排版\_build\tools\mingit\cmd\git.exe"
$repo = "E:\AI工作\轻办排版\_build\repo"     # 仓库克隆（首次：& $git clone git@github.com:gongpz/qingban.git $repo）

# 1) 同步成品
Copy-Item "E:\AI工作\轻办排版\qb-拆分版\index.html" "$repo\index.html" -Force
Remove-Item "$repo\assets" -Recurse -Force; Copy-Item "E:\AI工作\轻办排版\qb-拆分版\assets" "$repo\assets" -Recurse

# 2) 同步源码（排除 tools / samples / shots / original / repo）
Get-ChildItem "E:\AI工作\轻办排版\_build" -Force |
  Where-Object { $_.Name -notin @('tools','samples','shots','original','repo','__pycache__') -and $_.Name -notlike 'edge-*' } |
  ForEach-Object { Copy-Item $_.FullName "$repo\_build\$($_.Name)" -Recurse -Force }

# 3) 提交推送
cd $repo
& $git add -A
& $git commit -m "更新：<说明>"
& $git push origin main
```

## 第三方组件与许可证

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| lamejs | 1.2.1 | LGPL-3.0 | MP3 编码 |
| jsQR | 1.4.0 | Apache-2.0 | 二维码解码 |
| @audio/decode-wma | 1.4.0 | LGPL-2.1-or-later（含 FFmpeg WASM） | WMA 输入解码 |
| @audio/decode-ape | 1.0.0 | LGPL-2.1-or-later（含 FFmpeg WASM） | APE 输入解码 |
| FFmpeg（libavcodec） | — | LGPL-2.1-or-later | 上述两个解码器的内核 |
| mp4box.js | 0.5.x | BSD-3-Clause | MP4/MOV 解封装 |
| mp4-muxer | 5.x | MIT | MP4 封装 |
| @hevcjs/core | 1.9.1 | MIT | HEVC 软解（WASM，336.9 KB） |
| webm-muxer | 5.x | MIT | WebM 封装 |
| FLAC 编码器 | 自研 | 随 qb.html | 纯 JS 无损编码 |
| 二维码/条码引擎 | 自研 + jsQR | 随 qb.html | 生成 + 解码 |
| 视频引擎 | 自研 | 随 qb.html | 转码流水线 |

许可证原文见 `lib/wmaape/*/package/LICENSE*`、`lib/LICENSE.*.txt`、`lib/jsQR.LICENSE.txt`。
所有库均内联（或拆分版的本地 `assets/`），运行时不发起任何网络请求。

## 能力与限制

### 音频
- **输入**：MP3 / WAV / FLAC / AAC(ADTS、M4A) / OGG(Vorbis、Opus) / WebM / WMA / APE
- **输出**：MP3 / FLAC / WAV(16/24/32f) / AAC(ADTS，需 Chromium + 平台编码器) / OGG(Opus，需 Chromium 94+)
- **队列**：每行可直接「转换 / 重新转换」单个文件，也可整批转换、试听原文件、单独下载或打包 ZIP
- 不支持：AMR、AIFF、ALAC 输入；WMA / APE 输出（无可用编码器）
- MP3 解码总时长会比输入长 40–150 ms（LAME 编码器延迟 + 帧填充，属正常现象）

### 视频
- **输入**：MP4 / MOV / M4V（H.264、**HEVC/H.265**、VP8/VP9、AV1 视频；AAC、Opus、Vorbis 音频）、WebM / MKV
- **输出**：MP4（H.264 + AAC）或 WebM（VP9 + Opus）；可调分辨率（4K–360p）、码率、帧率（60/30/24/15 或保持）、音频码率或移除音轨
- 手机竖屏视频会按旋转矩阵实际转正；输出宽高自动取偶数；进度、取消、保留音轨均可用
- **HEVC 输入**：系统有解码器时走硬解；没有时自动用内置 libde265/hevcjs WASM 软解（8/10bit 4:2:0），1080p 约 1.3× 实时，68 秒视频约 1 分钟
- HEVC 编码、HDR、字幕、多音轨不在支持范围；10bit 软解直接降到 8bit，未做 BT.2020→BT.709 色彩变换
- 转码是纯 CPU/GPU 重编码，10 秒 720p 视频在 Edge 152 上约 1–2 秒（软件编码），长视频请分批处理

### 二维码 / 条形码
- **二维码外观**：码点方块/圆角/圆点/菱形、定位点方形/圆角/圆形、前景双色渐变（对角/水平/垂直）、透明背景、
  8 组配色与 2 组渐变预设、4 种风格预设、Logo 大小 / 方形圆形 / 白色衬底
- **条形码外观**：模块宽度、条码高度、静区宽度、文字大小与位置（上/下/不显示）、自定义标签文字、
  外框（无 / 浅灰细框 / 四角标）、透明背景、5 组配色
- 条码识别对清晰图片有效；拍照/透视变形的图片建议先裁剪
- 深色实线外框会干扰条码识别（已改为浅灰细框或四角标，二者均通过自解码验证）
