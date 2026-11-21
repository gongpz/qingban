# lib/ —— 第三方库与测试基础设施

## video-engine.js 内联使用的库（仅这些参与交付体积）

| 文件 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| `mp4box.all.min.js` | mp4box.js 0.5.4 | BSD-3-Clause | https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js |
| `mp4-muxer.js` | mp4-muxer 5.2.1 | MIT | https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.js |
| `webm-muxer.js` | webm-muxer 5.1.4 | MIT | https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.js |
| `hevc/core-1.9.1/package/dist/wasm/hevc-decode.js` | @hevcjs/core 1.9.1 glue | MIT | https://registry.npmjs.org/@hevcjs%2Fcore |
| `hevc/core-1.9.1/package/dist/wasm/hevc-decode.wasm` | @hevcjs/core 1.9.1 wasm（336.9 KB） | MIT（Copyright (c) LID） | 同上 |
| `LICENSE.hevcjs.txt` | — | MIT | 同上 |
| `LICENSE.mp4box.txt` | — | BSD-3-Clause（Copyright (c) 2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato） | 同上 |
| `LICENSE.mp4-muxer.txt` | — | MIT（Copyright (c) 2023 Vanilagy） | 同上 |
| `LICENSE.webm-muxer.txt` | — | MIT（Copyright (c) 2022 Vanilagy） | 同上 |

`build-engine.js` 会把三个 muxer/demuxer 库、HEVC glue 与 **wasm 的 base64** 一起拼进 `video-engine.js` 的 IIFE 中（`HEVC_WASM_B64`），最终 HTML 只需要一个 `<script>`。HEVC wasm 运行时通过 `instantiateWasm` 直接编译，不 fetch 任何 URL，`file://` 下可用。

`hevc/libde265-1.0.0/`（LGPL-3.0）只是备选方案，**未参与交付**；交付使用 MIT 的 hevcjs。

## 测试基础设施（不参与交付体积）

* `cdp.js` —— 极简 CDP 驱动（启动无头 Edge、本地 http 静态服务、页面 JS 执行），零第三方依赖。
* `_gen.html` —— 测试样本生成页：用 WebCodecs 编码 H.264+AAC / VP9+Opus / VP8 / AV1，再用 mp4-muxer / webm-muxer 封装；由 `../gen-samples.js` 驱动。
`lib/` 下的其它文件（`jsQR.*`、`lame.min.js`、`wma-ape-decoders.js`、`build.js`、`gen_tables.py`、`qrcodegen.py`、`dev/`、`src/`、`wmaape/`）属于主页面其它功能，与本引擎无关。
