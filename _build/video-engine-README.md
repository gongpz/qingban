# VideoEngine 1.1.0 —— 单文件离线视频压缩 / 转码引擎（含 HEVC 软解）

纯前端、WebCodecs、无服务器、`file://` 可用。`video-engine.js` 是 **classic script**（无 import/export/require/顶层 await），加载后挂到 `globalThis.VideoEngine`。内部已内联：

* mp4box.js / mp4-muxer / webm-muxer（UMD，同一 IIFE，不污染全局）
* **@hevcjs/core 1.9.1 的 wasm 解码器**（`hevc-decode.wasm` 以 base64 内联，运行时用 `WebAssembly.instantiate` + `instantiateWasm` 直接编译，**不发起任何网络 / 文件请求**，也不需要 Worker）

> 不修改 `qb.html`，产物都在 `_build/` 下。

## 文件

| 文件 | 说明 |
| --- | --- |
| `video-engine.js` | **交付模块**（约 886 KB，含全部依赖 + HEVC wasm） |
| `src/video-engine.src.js` | 引擎源码（库/wasm 以 3 个标记注入） |
| `build-engine.js` | 构建：内联库与 wasm、语法约束自检、体积检查 |
| `video-test.html` / `video-test.js` | 原有 128 项回归自测（H.264/VP8/VP9/AV1、MP4/WebM/MKV/MOV、音频、旋转、取消、降级） |
| `run-video-tests.js` | 上述套件的 CDP 驱动（http + file:// 冒烟） |
| `hevc-test.html` / `hevc-test.js` | HEVC 软解专项自测（31 项，file:// + 本地 File 输入） |
| `run-hevc-tests.js` | HEVC 套件驱动（CDP `DOM.setFileInputFiles` 注入真实文件） |
| `gen-samples.js` | 生成 H.264/VP9/VP8/AV1/MKV/AAC44/单声道样本 |
| `patch-hevc-samples.js` | 由公开 HEVC 样本派生竖屏 90° / `hvc1.1.6.H120.90` 变体 |
| `lib/` | 第三方库 + LICENSE（mp4box、mp4-muxer、webm-muxer、hevcjs）+ 测试基础设施 |
| `samples/` | 测试样本（普通样本每个 < 3 MB；HEVC 1080p 样本 5.25 MB） |
| `video-test-report.json` / `hevc-test-report.json` | 最近一次机器可读报告 |

## 用法（API 与 1.0.0 完全一致）

```html
<script src="video-engine.js"></script>
<script>
  VideoEngine.support().then(function (caps) {
    // caps.decode.hevc         —— 原生 HEVC 解码（本机 false）
    // caps.decode.hevcSoftware —— 内置 wasm 软解是否随包提供（true，扩展字段）
  });

  VideoEngine.probe(file).then(function (info) { /* container/duration/width/height/fps/rotation/... */ });

  VideoEngine.convert(file, {
    format: 'mp4',              // 'mp4' | 'webm'
    maxWidth: 1280, maxHeight: 720,   // 等比缩放，0/undefined = 原尺寸
    fps: 30,                    // 0 = 保持原帧率
    videoBitrate: 2500,         // kbps；不传按分辨率自动
    audio: 'keep',              // 'keep' | 'drop'
    audioBitrate: 128,          // kbps
    keyframeInterval: 2         // 秒
  }, {
    onProgress: function (p) {},
    onLog: function (msg) {},
    isCancelled: function () { return false; }
  }).then(function (r) {
    // r.data: Uint8Array
    // r.meta: {format,width,height,fps,duration,videoCodec,audioCodec,bitrate,size,notes}
  }).catch(function (e) { /* 取消时 e.message === '已取消' */ });
</script>
```

输入支持 `File` / `Blob` / `ArrayBuffer` / `Uint8Array`。

### `support()` 形态

```js
{
  webcodecs: boolean,
  decode: { h264, vp8, vp9, av1, hevc, hevcSoftware },
  encode: { h264, vp9, av1, vp8 },   // vp8 为扩展字段（WebM 回退）
  audioEncode: { aac, opus },
  containers: { mp4, webm }
}
```

`decode.hevc` **只表示原生解码能力**（本机 Edge 152 为 false，如实上报）；`decode.hevcSoftware` 表示内置 wasm 软解可用。`VideoEngine.hevcSoftware === true` 是等价的顶层标志。转换时**原生优先**，原生不支持才自动走软解，`meta.notes` 会写明。

## HEVC 软解实现

* **触发条件**：`VideoDecoder.isConfigSupported({codec:'hvc1...'/'hev1...', description: hvcC})` 为 false，且文件为 MP4/WebM 中的 HEVC（含 `hvcC` 参数集）。
* **参数集**：解析 `hvcC` 得到 VPS/SPS/PPS 与 NAL 长度前缀；首帧和每个关键帧前拼上 Annex B 参数集（`00 00 00 01`），兼容 `hvc1` / `hev1` 以及流中途换参数集。
* **解码**：`HEVCDecoder.create` 等价的轻量封装（`feed` / `drain` / `flush`），逐样本喂入、逐帧取回；每帧检查取消、及时 `destroy()`。
* **帧转换**：`HEVCFrame{ y, cb, cr, width, height, chromaWidth, chromaHeight, bitDepth }` → **I420 `VideoFrame`**（直接填 plane，10bit 右移 2 位降到 8bit，不经过 RGBA），随后复用原有 Canvas 旋转/缩放 + VideoEncoder 编码链路。
* **时间戳**：按 `源首帧时间 + index * 1e6 / src.fps` 估算，`meta.notes` 注明；普通 HEVC 输出帧数 = 样本数时，时长误差 < 0.01s。
* **限制**：仅 4:2:0、8/10bit；4:2:2 / 4:4:4 在转换前明确报错（不会花屏）；wasm 在主线程运行，file:// 兼容（无 Worker）。
* **体积**：HEVC 新增 **496.2 KB**（glue 47.0 KB + wasm base64 449.2 KB；原始 wasm 336.9 KB），总计 886.4 KB。

## 实测支持矩阵（Edge 152 / Windows 11 / 无头）

| 能力 | 结果 |
| --- | --- |
| WebCodecs | ✅ |
| 原生解码 H.264 / VP8 / VP9 / AV1 | ✅ / ✅ / ✅ / ✅ |
| 原生解码 HEVC | ❌（本机无 HEVC 扩展/硬解，`support()` 如实返回 false） |
| **HEVC 软解（hvc1 / hev1）** | ✅ 8bit 4:2:0；10bit 可解并降为 8bit（未用 10bit 样本实测） |
| 编码 H.264 / VP9 / AV1 / VP8 | ✅ / ✅ / ✅ / ✅ |
| 编码 AAC / Opus | ✅ / ✅ |
| 封装 MP4 / WebM | ✅ / ✅ |

## 测试

```powershell
node build-engine.js        # 构建 + 语法/体积自检
node gen-samples.js         # 可选：重建普通样本
node patch-hevc-samples.js  # 可选：由 HEVC 源样本派生竖屏/H120 变体
node run-video-tests.js     # 128 项回归（http + file:// 冒烟）
node run-hevc-tests.js      # 31 项 HEVC 软解（file://，真实 File 输入）
```

最近一次结果：**回归 128 / 128 PASS**，**HEVC 31 / 31 PASS**，控制台无错误。

### HEVC 专项（file://，File 输入）

| 项目 | 结果 |
| --- | --- |
| probe 竖屏 HEVC（720×1280 / matrix 90 / hvc1 + AAC） | ✅ rotation=90，时长 10.023s，`mp4a.40.2 96kbps` |
| probe `hvc1.1.6.H120.90`（用户在用的 iPhone 编码串） | ✅ 1920×1080，编码串完全匹配 |
| probe `hev1.1.6.L63.90` | ✅ |
| hev1 640×360 → MP4（软解 + H.264） | ✅ 1.36 s，时长 10.000s，`<video>` 可播放，首帧非黑，进度单调到 1 |
| 竖屏 HEVC+AAC → MP4 720×1280 | ✅ 3.89 s，rotation=0，时长误差 0.008s，AAC 保留（RMS 0.194），`<video>` 720×1280、首帧非黑 |
| 1080p `hvc1.1.6.H120.90` → MP4 1920×1080（4 Mbps） | ✅ 7.9 s / 300 帧 → **37.8 fps 软解+编码**，**1.26× 实时** |
| **68s 1080p 视频预估** | **≈ 53.9 s**（按本机 1.26× 实时折算，CPU 不同会有差异；多次实测 52.8–53.9 s） |
| 取消（软解中） | ✅ 352 ms 内 reject `已取消`，随后转码仍可用 |
| 4:2:2 输入（构造 hvcC chroma=2） | ✅ 明确报错「HEVC 软解仅支持 4:2:0…4:2:2/4:4:4 不受支持」 |
| `meta.notes` | ✅ 含「HEVC 使用内置软解…时间戳按恒定帧率估算，转码较慢」 |

### 回归套件关键数值（与 1.0.0 一致）

| 场景 | 结果 |
| --- | --- |
| 720p30 / 10s H.264+AAC → MP4 720p / 800kbps | 2.08 MB → 1.17 MB，0.95 s，时长 10.005s，AAC RMS 0.085 |
| MP4 → WebM（VP9+Opus） | 0.87 MB，1.0 s，时长 10.02s |
| WebM → MP4 | 1.07 MB，0.8 s，音频保留 |
| fps=24 / 90°/180° 旋转 / 取消 / AAC 降级 | ✅ |
| 真实样本（Big Buck Bunny 1MB）双向转码 | ✅ |
| file:// 离线冒烟 | ✅ `isSecureContext=true`，无网络 |
| 引擎体积 | **886.4 KB**（HEVC 新增 496.2 KB ≤ 700 KB） |

## 已知限制

1. **HEVC 软解只支持 4:2:0、8/10bit**；4:2:2 / 4:4:4 / 12bit 会明确报错。10bit 会降为 8bit 输出（颜色范围重新映射为简单右移，未做 BT.2020→BT.709 色彩变换）。
2. **HEVC 时间戳按恒定帧率估算**：VFR、含大量 suppressed picture 的流可能出现轻微时长/音画偏差；普通 iPhone 30fps 视频实测误差 < 0.01s。
3. **软解速度**：本机 1080p 约 1.26–1.29× 实时（37.8–38.6 fps）。68s 1080p 约 53–54s；4K 或低配 CPU 会明显更慢。wasm 在主线程运行，但每帧之间有 await，页面仍能刷新进度。
4. 其它 HEVC 输入限制：只处理第一条视频轨；HDR/色彩元数据不保留；`hev1` 若 hvcC 中缺少 VPS/SPS/PPS 会明确报错（无法软解）。
5. 原有非 HEVC 限制不变：Vorbis 仅尽力解码；MP4 整文件提取样本（内存 1–2× 文件）；只处理首条音视频轨；不保留字幕/章节/HDR；未补偿 edit list；WebM 旋转仅 `ProjectionPoseRoll`；缩放只缩小不放大。
6. 兼容性：需要支持 WebAssembly + WebCodecs 的 Chromium（Edge 152 实测）。

## 第三方库（均 MIT / BSD，无 GPL）

| 库 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| mp4box.js | 0.5.4 | BSD-3-Clause | MP4/MOV 解封装 |
| mp4-muxer | 5.2.1 | MIT | MP4 封装 |
| webm-muxer | 5.1.4 | MIT | WebM 封装 |
| @hevcjs/core（hevc-decode.wasm + glue） | 1.9.1 | MIT | HEVC 软件解码 |

LICENSE 原文见 `lib/LICENSE.*.txt`。HEVC 相关文件位于 `lib/hevc/core-1.9.1/package/dist/wasm/`。

## 测试样本来源

* 生成样本：`gen-samples.js`（无头 Edge + WebCodecs 编码 H.264/VP9/VP8/AV1 + AAC/Opus，再 mp4-muxer/webm-muxer 封装）。
* 真实世界样本：test-videos.co.uk 的 Big Buck Bunny 1MB H.264 MP4 / VP9 WebM / H.265 MP4（360p、1080p）。
* HEVC 变体：`patch-hevc-samples.js` 给 720p 样本写入 90° tkhd matrix（竖屏），给 1080p 样本改 `hev1`→`hvc1` 并置 High tier，得到与用户视频相同的 `hvc1.1.6.H120.90` 编码串。
