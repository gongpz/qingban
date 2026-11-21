# 轻办 (Lightwork)

本地优先的文档 / 图片 / 音频 / 视频 / 二维码处理工具台。
纯前端、离线运行，所有处理都在浏览器里完成，文件不上传任何服务器。

## 功能

- **凭证排版打印**：把零散凭证图片 / PDF 等比缩放拼版到 A4，可批量、旋转、排序，直接打印或导出 PDF。
- **图片 / PDF 压缩**：批量压缩图片与 PDF，可调画质、最大边长、输出格式。
- **图片格式转换**：JPEG / PNG / WebP / GIF / BMP / ICO / AVIF 互转，支持透明通道与 ICO 多尺寸。
- **CDR 版本切换**：解析 CorelDRAW 文件内部版本标记，批量降级 / 平级改写。
- **音频压缩转换**：MP3 / WAV / FLAC / AAC / OGG / Opus 互转，支持 WMA / APE 输入（内置解码器）；
  可调码率、采样率、声道，整批转换、试听、打包下载。
- **视频压缩转换**：MP4 / MOV / M4V / WebM / MKV 输入，输出 MP4(H.264+AAC) 或 WebM(VP9+Opus)；
  可调分辨率、码率、帧率，支持 HEVC/H.265 输入（系统无解码器时自动使用内置 WASM 软解）。
- **二维码 / 条形码**：文本、网址、WiFi、名片、短信、电话生成二维码；Code 128 / Code 39 /
  EAN-13 / EAN-8 / UPC-A / ITF-14 条码；支持颜色、渐变、码点/定位点样式、Logo、透明背景，
  以及图片扫码识别。

## 本地使用

双击根目录的 `index.html` 即可，无需安装、无需联网。

> 目录结构：`index.html` + `assets/*.js`（视频引擎、二维码引擎、音频编码器等）。
> 整个文件夹需一起拷贝，不能只拿 `index.html`。

## 在线预览

GitHub Pages：https://gongpz.github.io/qingban/

## 目录

| 路径 | 说明 |
|---|---|
| `index.html` | 应用入口（由 `_build/integrate.js` 生成） |
| `assets/` | 运行时脚本：音频/视频/二维码引擎与三个面板逻辑 |
| `_build/` | 构建源码、第三方库、自动化测试脚本 |
| `_build/README.md` | 构建流程、重新构建、许可证与能力限制 |

## 重新构建

```powershell
cd _build
node integrate.js            # 只生成拆分版（index.html + assets/）
node integrate.js --single   # 额外生成单文件版 ../qb.html（默认关闭）
node run-tests.js "path/to/index.html"   # 无头 Edge 自动化回归
```

构建依赖 Node.js；回归测试需要本机安装 Microsoft Edge。

## 技术说明

- 纯前端、无后端：PDF 解析（PDF.js）、音频编码（lamejs / WebCodecs）、视频（WebCodecs + mp4box + muxer）、
  二维码（jsQR）等全部内联或随 `assets/` 本地加载。
- 不收集、不上传任何数据。
- 第三方组件及许可证见 `_build/README.md` 与 `_build/lib/LICENSE.*`。

© 2026 轻办 · 本地处理
