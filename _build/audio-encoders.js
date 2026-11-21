/*!
 * audio-encoders.js — 纯前端离线音频编码模块（WAV / MP3 / AAC-ADTS / Ogg-Opus）
 * ---------------------------------------------------------------------------
 * 版本: 1.0.0        目标: 单文件 HTML 工具内联, file:// 直接可用, 无服务器依赖
 * 语法: 经典脚本(ES5 风格), 不使用 import/export/require, 不依赖 Node API
 *
 * ============================ API =========================================
 * 全局对象: globalThis.AudioEnc
 *
 *  WAV (同步返回 Uint8Array)
 *    AudioEnc.wav(channels, sampleRate, {bitDepth:16|24, float:false}) -> Uint8Array
 *        channels: Float32Array[]（建议取值 [-1, 1]），单/多声道
 *        bitDepth: 8|16|24|32（整数 PCM，默认 16）
 *        float: true -> 32bit IEEE float（format=3），忽略整数 bitDepth
 *
 *  MP3 (lamejs)
 *    AudioEnc.mp3(channels, sampleRate, {bitrate:128, vbr:false, onProgress}) -> Promise<Uint8Array>
 *        返回的 Uint8Array 带有 .meta 属性（见下）
 *    AudioEnc.mp3Meta(numChannels, sampleRate) -> {bitrates:[...], default, mpegVersion, ...}
 *
 *  AAC-LC (WebCodecs, 输出 ADTS 封装 .aac)
 *    AudioEnc.aac(channels, sampleRate, {bitrate:128, onProgress}) -> Promise<Uint8Array>
 *        内部自动修正到 Chromium 白名单：声道 {1,2}（>2 下混）、采样率 {44100,48000}
 *        （其余重采样到 48000）、比特率 {96,128,160,192}k（就近取值），实际参数见 .meta
 *
 *  Ogg Opus (WebCodecs + 自写 Ogg 封装)
 *    AudioEnc.oggOpus(channels, sampleRate, {bitrate:96, onProgress, frameDuration:20000}) -> Promise<Uint8Array>
 *
 *  能力探测
 *    AudioEnc.hasWebCodecs() -> boolean
 *    AudioEnc.support() -> Promise<{aac,opus,flac,mp3,webcodecs}>
 *
 *  附加工具
 *    AudioEnc.resample(channels, fromRate, toRate) -> Float32Array[]  (Catmull-Rom 三次插值)
 *    AudioEnc._internal.*  内部函数（供测试/调试，版本间可能变动）
 *
 *  比特率单位: mp3 用 kbps（128 = 128kbps）；aac / oggOpus 用 bps（128000 = 128kbps）。
 *  为防误用，aac/oggOpus 在收到 <1000 的值时会按 kbps 自动换算，mp3 收到 >=1000 的
 *  值时会按 bps 自动换算（即 mp3:128、aac:128、aac:128000 都能得到 128kbps）。
 *
 *  Uint8Array.meta 字段（mp3/aac/oggOpus 均附带）:
 *    {codec, container, sampleRate, channels, bitrate, bitrateRequested,
 *     bitrateAdjusted, sampleRateRequested, mpegVersion?, vbr?, frames?, duration?, notes:[]}
 *
 * ============================ 用法 ========================================
 *   <script src="lib/lame.min.js"></script>   <!-- 提供全局 lamejs，仅 MP3 需要 -->
 *   <script src="audio-encoders.js"></script>
 *   <script>
 *     var ctx = new AudioContext();
 *     // …解码得到 Float32Array[] 声道数据…
 *     AudioEnc.mp3(chans, ctx.sampleRate, {bitrate: 192, onProgress: function (p) {
 *       console.log('进度', Math.round(p * 100) + '%');
 *     }}).then(function (bytes) {
 *       var blob = new Blob([bytes], {type: 'audio/mpeg'});
 *       var a = document.createElement('a');
 *       a.href = URL.createObjectURL(blob); a.download = 'out.mp3'; a.click();
 *     }).catch(function (e) { alert(e.message); });
 *   </script>
 *
 * ======================== 浏览器支持矩阵 ==================================
 *  说明: Chromium 的 WebCodecs AudioEncoder 只有两条编码路径 —— 'opus'（全平台
 *  软件编码）与 'mp4a.40.2' AAC-LC（仅 Windows/macOS，走 Media Foundation）；
 *  flac / mp3 / pcm 的**编码**在 Chromium 中均不支持（只能解码，或被 AudioEncoder
 *  拒绝），因此本模块的 FLAC/MP3 不走 WebCodecs。
 *
 *  格式       条件                                           Chrome  Edge   Firefox  Safari
 *  WAV PCM    任意环境（纯 JS）                               ✅      ✅      ✅       ✅
 *  WAV float  任意环境（纯 JS）                               ✅      ✅      ✅       ✅
 *  MP3        lamejs 已加载（本模块不内置，需单独 <script>）  ✅      ✅      ✅       ✅
 *  MP3        WebCodecs 'mp3'（Chromium 不支持编码，仅探测）  ❌      ❌      ❌       ❌
 *  AAC-LC     AudioEncoder 'mp4a.40.2'：Windows/macOS 94+    ✅*     ✅*     ❌       ❌
 *             （参数白名单 44100/48000、1/2 声道、96-192k）
 *  Ogg Opus   AudioEncoder 'opus'（安全上下文）              94+     94+    130+*    16.4+
 *  * macOS 的 Chrome 对 AAC 的支持随系统版本变化，Safari 的 WebCodecs 实现较晚且对
 *    description / opus 配置支持不一；一律以 AudioEnc.support() 在目标环境上的
 *    实时探测结果为准（该函数永不抛异常）。
 *  安全上下文: https / http://localhost / file:// （file:// 下 WebCodecs 可用，
 *  Chrome 对 file:// 视作安全上下文；若个别版本不可用，support() 会返回 false）。
 *
 * ========================== 已知限制 ======================================
 *  1) MP3 的 VBR: lamejs 1.2.1 的简化封装只暴露 CBR 接口，vbr:true 会自动回退为
 *     CBR 并在 meta.vbr=false / meta.notes 中注明。
 *  2) MP3 采样率仅支持 MPEG-1/2/2.5 的 9 个合法值；其他采样率会就近重采样（meta 注明）。
 *     MPEG-1 合法比特率 32..320k，MPEG-2/2.5 合法比特率 8..160k；越界自动取最近合法值。
 *  3) MP3 为 CBR 且不含 LAME/Xing 标签（lamejs 简化 API 未暴露该能力），因此解码端会
 *     多出「编码器延迟 1105 样本 + 末帧填充（<1 帧）」的静音（实测：前导静音恰为 1105
 *     样本，各采样率一致）。折算时长：44100Hz 约 45ms、22050Hz 约 71ms、8000Hz 约 152ms。
 *     音频内容本身与输入等长（meta.duration 为输入真实时长；有效信号时长误差 < 1 帧）。
 *     若要严格 gapless，需要写入 LAME 标签，而 lamejs 1.2.1 的封装无法安全做到
 *     （需替换首帧，会丢掉 1152-delay 个真实样本），故本模块不做“凑时长”的破坏性处理。
 *  4) AAC/Opus 依赖 WebCodecs AudioEncoder；Node 下不存在，会以中文错误 reject。
 *  5) ADTS 封装做三层判定（与配置无关）：①每个 chunk 是否本来就是自洽 ADTS 帧 →
 *     直接拼接；②拼接后整体能否按 ADTS 帧长严格走完 → 整段透传；③否则视为裸 AAC 帧，
 *     按 AAC-LC 每帧 1024 样本逐帧加 7 字节头。这样可兼容 Chromium 各版本对
 *     aac:{format:'adts'} 的不同实现（含完全忽略该字段的版本）。SBR/HE-AAC 不在支持范围。
 *  6) Ogg Opus 的 OpusHead preSkip 固定 312（libopus 48kHz 下 6.5ms lookahead 的常规值），
 *     末页 granule 按实际输入样本数裁剪；仅支持 1/2 声道（mapping family 0），更多声道会
 *     下混为立体声并在 meta.notes 注明。
 *  7) 重采样为 Catmull-Rom 三次插值，增益平坦但大比例降采样（如 96k->48k）未做前置
 *     抗混叠滤波，极高频可能折叠。
 *  8) WAV 对 >2 声道使用普通 PCM fmt（非 WAVE_FORMAT_EXTENSIBLE），主流解码器均可读。
 *  9) 浮点转整数使用「取偶舍入（round-half-to-even）」，与 libsndfile/numpy 的 rint
 *     一致，便于逐采样比对。
 *
 * 授权: 随项目使用。依赖 lamejs (LGPL) 由使用方自行引入。
 * ---------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    var VERSION = '1.0.0';

    /* =====================================================================
     * 0. 常量表
     * ===================================================================== */

    /** AAC / ADTS 采样率索引表（96000..7350） */
    var ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

    /** MP3 合法采样率（MPEG-1 / MPEG-2 / MPEG-2.5） */
    var MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

    /** MPEG-1 合法比特率 kbps */
    var MP3_BITRATES_MPEG1 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

    /** MPEG-2 / MPEG-2.5 合法比特率 kbps */
    var MP3_BITRATES_MPEG2 = [8, 10, 12, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

    /** Opus 内部固定采样率 */
    var OPUS_RATE = 48000;

    /** Opus pre-skip（48kHz 样本数） */
    var OPUS_PRE_SKIP = 312;

    /** Opus 每帧时长（微秒），20ms */
    var OPUS_FRAME_US = 20000;

    /** Opus 每帧样本数（48kHz / 20ms） */
    var OPUS_FRAME_SAMPLES = 960;

    /** Ogg 单页最大载荷（字节），控制解码端缓冲 */
    var OGG_PAGE_MAX_PAYLOAD = 8192;

    /* =====================================================================
     * 1. 基础工具
     * ===================================================================== */

    function tagOf(v) {
        return Object.prototype.toString.call(v);
    }

    function isFloat32Array(a) {
        return tagOf(a) === '[object Float32Array]';
    }

    function isArrayLike(a) {
        return !!a && typeof a === 'object' && typeof a.length === 'number';
    }

    function toInt(v, name) {
        var n = Number(v);
        if (!isFinite(n)) {
            throw new Error(name + ' 必须是有限数字');
        }
        return Math.floor(n);
    }

    /** 让出主线程一次（微任务之后执行，交给渲染/输入事件） */
    function tick() {
        return new Promise(function (resolve) {
            if (typeof setTimeout === 'function') {
                setTimeout(resolve, 0);
            } else {
                resolve();
            }
        });
    }

    function safeCall(fn, arg) {
        if (typeof fn !== 'function') {
            return;
        }
        try {
            fn(arg);
        } catch (e) {
            /* 进度回调异常不影响编码 */
        }
    }

    /** UTF-8 编码（浏览器/Node 皆可；无 TextEncoder 时手工编码） */
    function utf8Encode(str) {
        str = String(str);
        if (typeof TextEncoder === 'function') {
            return new TextEncoder().encode(str);
        }
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                i++;
            } else {
                out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        }
        return new Uint8Array(out);
    }

    function writeStr(b, off, s) {
        for (var i = 0; i < s.length; i++) {
            b[off + i] = s.charCodeAt(i) & 0xff;
        }
    }

    function writeU16LE(b, off, v) {
        b[off] = v & 0xff;
        b[off + 1] = (v >>> 8) & 0xff;
    }

    function writeU32LE(b, off, v) {
        b[off] = v & 0xff;
        b[off + 1] = (v >>> 8) & 0xff;
        b[off + 2] = (v >>> 16) & 0xff;
        b[off + 3] = (v >>> 24) & 0xff;
    }

    /** 写 64 位小端（JS 数字安全范围内） */
    function writeU64LE(b, off, v) {
        var lo = v % 4294967296;
        var hi = Math.floor(v / 4294967296);
        writeU32LE(b, off, lo >>> 0);
        writeU32LE(b, off + 4, hi >>> 0);
    }

    function u8FromInt8(a) {
        var out = new Uint8Array(a.length);
        for (var i = 0; i < a.length; i++) {
            out[i] = a[i] & 0xff;
        }
        return out;
    }

    function u8FromBuffer(buf) {
        if (buf == null) {
            return null;
        }
        if (buf instanceof ArrayBuffer || tagOf(buf) === '[object ArrayBuffer]') {
            return new Uint8Array(buf);
        }
        if (buf.buffer) {
            return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
        }
        return new Uint8Array(buf);
    }

    function concatBytes(list, totalLen) {
        var total = totalLen || 0;
        var i;
        if (totalLen == null) {
            total = 0;
            for (i = 0; i < list.length; i++) {
                total += list[i].length;
            }
        }
        var out = new Uint8Array(total);
        var off = 0;
        for (i = 0; i < list.length; i++) {
            out.set(list[i], off);
            off += list[i].length;
        }
        return out;
    }

    /** 给 Uint8Array 附加 meta（不影响其作为二进制数据使用） */
    function withMeta(bytes, meta) {
        try {
            bytes.meta = meta;
        } catch (e) {
            /* 某些环境不允许扩展 TypedArray，忽略 */
        }
        return bytes;
    }

    /* =====================================================================
     * 2. 声道数据规整 / 采样格式转换
     * ===================================================================== */

    /**
     * 校验并规整声道数组：统一为 Float32Array[]，按最短长度截断。
     * 说明: 各声道长度不一致时以最短为准（避免越界），并在调用方 meta 中提示。
     */
    function normalizeChannels(channels) {
        if (!isArrayLike(channels) || channels.length === 0) {
            throw new Error('channels 必须是非空数组（Float32Array[]）');
        }
        var out = [];
        var min = Infinity;
        var i;
        for (i = 0; i < channels.length; i++) {
            var a = channels[i];
            if (!isArrayLike(a)) {
                throw new Error('channels[' + i + '] 不是有效的采样数组');
            }
            if (!isFloat32Array(a)) {
                var conv = new Float32Array(a.length);
                for (var k = 0; k < a.length; k++) {
                    conv[k] = a[k];
                }
                a = conv;
            }
            if (a.length < min) {
                min = a.length;
            }
            out.push(a);
        }
        if (!isFinite(min) || min <= 0) {
            throw new Error('音频数据为空（采样数为 0）');
        }
        min = Math.floor(min);
        for (i = 0; i < out.length; i++) {
            if (out[i].length !== min) {
                out[i] = typeof out[i].subarray === 'function' ? out[i].subarray(0, min) : out[i].slice(0, min);
            }
        }
        return out;
    }

    function clampInt(v, lo, hi) {
        if (v !== v) {
            return 0; /* NaN -> 0 */
        }
        if (v > hi) {
            return hi;
        }
        if (v < lo) {
            return lo;
        }
        return v;
    }

    /**
     * 四舍五入到最近整数，.5 时取偶数（round-half-to-even）。
     * 与 libsndfile/numpy 的 rint 行为一致，保证 PCM 逐采样比对可精确相等。
     */
    function roundHalfEven(v) {
        var f = Math.floor(v);
        var d = v - f;
        if (d > 0.5) {
            return f + 1;
        }
        if (d < 0.5) {
            return f;
        }
        return (f % 2 === 0) ? f : f + 1;
    }

    /**
     * 浮点 -> 16bit 整数（区间 [off, off+n)）
     * 公式: clamp(x * 2^15, -32768, 32767) 后取偶舍入。
     */
    function floatToInt16Range(src, off, n) {
        var out = new Int16Array(n);
        for (var i = 0; i < n; i++) {
            var v = src[off + i] * 32768;
            v = v !== v ? 0 : (v > 32767 ? 32767 : (v < -32768 ? -32768 : v));
            out[i] = roundHalfEven(v);
        }
        return out;
    }

    /** 浮点 -> 16bit 整数（整段） */
    function floatToInt16(src) {
        return floatToInt16Range(src, 0, src.length);
    }

    /**
     * 浮点 -> 24bit 整数（整段，返回 Int32Array，值域 [-8388608, 8388607]）
     * 公式: clamp(x * 2^23, ...) 后取偶舍入。
     */
    function floatToInt24(src) {
        var n = src.length;
        var out = new Int32Array(n);
        for (var i = 0; i < n; i++) {
            var v = src[i] * 8388608;
            v = v !== v ? 0 : (v > 8388607 ? 8388607 : (v < -8388608 ? -8388608 : v));
            out[i] = roundHalfEven(v);
        }
        return out;
    }

    /* =====================================================================
     * 3. 重采样（Catmull-Rom 三次插值）
     * ===================================================================== */

    function sampleAt(s, i, n) {
        if (i < 0) {
            return s[0];
        }
        if (i >= n) {
            return s[n - 1];
        }
        return s[i];
    }

    /** 单声道重采样（返回新 Float32Array） */
    function resampleMono(src, from, to) {
        var n = src.length;
        if (from === to || n === 0) {
            return src;
        }
        var outLen = Math.max(1, Math.round(n * to / from));
        var ratio = from / to;
        var out = new Float32Array(outLen);
        for (var i = 0; i < outLen; i++) {
            var pos = i * ratio;
            var i1 = Math.floor(pos);
            var t = pos - i1;
            var p0 = sampleAt(src, i1 - 1, n);
            var p1 = sampleAt(src, i1, n);
            var p2 = sampleAt(src, i1 + 1, n);
            var p3 = sampleAt(src, i1 + 2, n);
            /* Catmull-Rom: 0.5*[2p1 + (-p0+p2)t + (2p0-5p1+4p2-p3)t^2 + (-p0+3p1-3p2+p3)t^3] */
            out[i] = p1 + 0.5 * t * ((p2 - p0) + t * ((2 * p0 - 5 * p1 + 4 * p2 - p3) + t * (3 * (p1 - p2) + p3 - p0)));
        }
        return out;
    }

    /** 多声道重采样 */
    function resampleChannels(channels, fromRate, toRate) {
        var from = toInt(fromRate, 'fromRate');
        var to = toInt(toRate, 'toRate');
        if (!(from > 0) || !(to > 0)) {
            throw new Error('重采样率必须为正整数');
        }
        var out = [];
        for (var i = 0; i < channels.length; i++) {
            out.push(resampleMono(channels[i], from, to));
        }
        return out;
    }

    /* =====================================================================
     * 4. WAV（RIFF/WAVE）
     * ===================================================================== */

    var WAV_FORMAT_PCM = 1;
    var WAV_FORMAT_IEEE_FLOAT = 3;

    /**
     * 编码 RIFF/WAVE。
     * opts.bitDepth: 8|16|24|32（默认 16）；opts.float: true -> 32bit IEEE float。
     * 返回: Uint8Array（同步）
     */
    function wav(channels, sampleRate, opts) {
        opts = opts || {};
        var src = normalizeChannels(channels);
        var ch = src.length;
        var sr = toInt(sampleRate, 'sampleRate');
        if (!(sr > 0)) {
            throw new Error('sampleRate 必须是正整数');
        }
        var bits;
        var isFloat = false;
        if (opts.float === true) {
            isFloat = true;
            bits = opts.bitDepth === 64 ? 64 : 32;
            if (bits !== 32 && bits !== 64) {
                throw new Error('float 模式仅支持 32 或 64 位');
            }
        } else {
            bits = opts.bitDepth == null ? 16 : toInt(opts.bitDepth, 'bitDepth');
            if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
                throw new Error('bitDepth 仅支持 8/16/24/32（整数 PCM），浮点请用 {float:true}');
            }
        }
        var bytesPer = bits / 8;
        var frames = src[0].length; /* normalizeChannels 已保证各声道等长且为整数 */
        var blockAlign = ch * bytesPer;
        var dataLen = frames * blockAlign;
        var pad = dataLen % 2 === 1 ? 1 : 0; /* RIFF 块需偶数字节对齐 */
        var fmtSize = 16;
        var riffSize = 4 + (8 + fmtSize) + (8 + dataLen + pad);
        var total = 8 + riffSize;
        var out = new Uint8Array(total);
        var off = 0;
        var i;
        var c;

        writeStr(out, 0, 'RIFF');
        writeU32LE(out, 4, riffSize);
        writeStr(out, 8, 'WAVE');
        off = 12;
        writeStr(out, off, 'fmt ');
        writeU32LE(out, off + 4, fmtSize);
        writeU16LE(out, off + 8, isFloat ? WAV_FORMAT_IEEE_FLOAT : WAV_FORMAT_PCM);
        writeU16LE(out, off + 10, ch);
        writeU32LE(out, off + 12, sr);
        writeU32LE(out, off + 16, sr * blockAlign); /* byteRate */
        writeU16LE(out, off + 20, blockAlign);
        writeU16LE(out, off + 22, bits);
        off += 8 + fmtSize;
        writeStr(out, off, 'data');
        writeU32LE(out, off + 4, dataLen);
        off += 8;

        if (isFloat && bits === 32) {
            var dv = new DataView(out.buffer, off, dataLen);
            var p = 0;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    dv.setFloat32(p, src[c][i], true);
                    p += 4;
                }
            }
        } else if (isFloat && bits === 64) {
            var dv64 = new DataView(out.buffer, off, dataLen);
            var q = 0;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    dv64.setFloat64(q, src[c][i], true);
                    q += 8;
                }
            }
        } else if (bits === 8) {
            /* 8bit WAV 为无符号偏移二进制 */
            var o8 = off;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    var v8 = src[c][i] * 128;
                    v8 = v8 !== v8 ? 0 : (v8 > 127 ? 127 : (v8 < -128 ? -128 : v8));
                    out[o8++] = (roundHalfEven(v8) + 128) & 0xff;
                }
            }
        } else if (bits === 16) {
            var o16 = off;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    var v16 = src[c][i] * 32768;
                    v16 = v16 !== v16 ? 0 : (v16 > 32767 ? 32767 : (v16 < -32768 ? -32768 : v16));
                    var s16 = roundHalfEven(v16);
                    out[o16] = s16 & 0xff;
                    out[o16 + 1] = (s16 >> 8) & 0xff;
                    o16 += 2;
                }
            }
        } else if (bits === 24) {
            var o24 = off;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    var v24 = src[c][i] * 8388608;
                    v24 = v24 !== v24 ? 0 : (v24 > 8388607 ? 8388607 : (v24 < -8388608 ? -8388608 : v24));
                    var s24 = roundHalfEven(v24);
                    if (s24 < 0) {
                        s24 += 16777216;
                    }
                    out[o24] = s24 & 0xff;
                    out[o24 + 1] = (s24 >> 8) & 0xff;
                    out[o24 + 2] = (s24 >> 16) & 0xff;
                    o24 += 3;
                }
            }
        } else {
            /* 32bit 整数 PCM */
            var o32 = off;
            for (i = 0; i < frames; i++) {
                for (c = 0; c < ch; c++) {
                    var v32 = src[c][i] * 2147483648;
                    var s32 = v32 !== v32 ? 0 : (v32 > 2147483647 ? 2147483647 : (v32 < -2147483648 ? -2147483648 : v32));
                    s32 = roundHalfEven(s32);
                    out[o32] = s32 & 0xff;
                    out[o32 + 1] = (s32 >> 8) & 0xff;
                    out[o32 + 2] = (s32 >> 16) & 0xff;
                    out[o32 + 3] = (s32 >>> 24) & 0xff;
                    o32 += 4;
                }
            }
        }

        if (pad) {
            out[total - 1] = 0; /* 尾部填充字节 */
        }
        return out;
    }

    /* =====================================================================
     * 5. MP3（lamejs）
     * ===================================================================== */

    /** 由采样率判断 MPEG 版本 */
    function mpegVersion(sampleRate) {
        if (sampleRate >= 32000) {
            return 1;
        }
        if (sampleRate >= 16000) {
            return 2;
        }
        return 2.5;
    }

    /** 某 MPEG 版本的合法比特率表 */
    function mp3Bitrates(version) {
        return version === 1 ? MP3_BITRATES_MPEG1.slice() : MP3_BITRATES_MPEG2.slice();
    }

    /** 取最近合法值（并列时取较大值） */
    function nearestOf(list, wanted) {
        var best = list[0];
        var bestD = Math.abs(list[0] - wanted);
        for (var i = 1; i < list.length; i++) {
            var d = Math.abs(list[i] - wanted);
            if (d < bestD || (d === bestD && list[i] > best)) {
                best = list[i];
                bestD = d;
            }
        }
        return best;
    }

    /** 取最近的 MP3 合法采样率 */
    function nearestSampleRate(sr) {
        return nearestOf(MP3_SAMPLE_RATES, sr);
    }

    /**
     * 比特率单位自适应：小于 1000 视为 kbps（如 128 -> 128000 bps），
     * 否则视为 bps。WebCodecs 原生用 bps，而 UI/文档常用 kbps，两者都接受以免误用。
     */
    function bitrateToBps(v) {
        var n = Number(v);
        if (!isFinite(n) || n <= 0) {
            return null;
        }
        return n < 1000 ? Math.round(n * 1000) : Math.round(n);
    }

    function defaultMp3Bitrate(version) {
        return version === 1 ? 128 : 64;
    }

    /**
     * MP3 可选比特率信息（供 UI 显示）。
     * @return {object} {bitrates, default, mpegVersion, sampleRate, sampleRateSupported, max, min}
     */
    function mp3Meta(numChannels, sampleRate) {
        var sr = toInt(sampleRate, 'sampleRate');
        var supported = MP3_SAMPLE_RATES.indexOf(sr) >= 0;
        var useSr = supported ? sr : nearestSampleRate(sr);
        var ver = mpegVersion(useSr);
        var list = mp3Bitrates(ver);
        return {
            bitrates: list,
            default: defaultMp3Bitrate(ver),
            mpegVersion: ver,
            sampleRate: useSr,
            sampleRateRequested: sr,
            sampleRateSupported: supported,
            channels: Math.max(1, Math.min(2, toInt(numChannels || 1, 'numChannels'))),
            min: list[0],
            max: list[list.length - 1]
        };
    }

    function getLame() {
        var lame = global.lamejs;
        if (!lame || typeof lame.Mp3Encoder !== 'function') {
            return null;
        }
        return lame;
    }

    /**
     * MP3 编码（lamejs, 分块 1152 样本，逐块让出主线程）。
     * @return {Promise<Uint8Array>} 结果带 .meta
     */
    function mp3(channels, sampleRate, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var src;
            var sr;
            var notes = [];
            var meta;
            try {
                src = normalizeChannels(channels);
                sr = toInt(sampleRate, 'sampleRate');
                if (sr < 3000 || sr > 384000) {
                    throw new Error('sampleRate 超出支持范围（3000..384000）');
                }
            } catch (e) {
                reject(e);
                return;
            }

            var lame = getLame();
            if (!lame) {
                reject(new Error('未找到 lamejs：请在本模块之前加载 lib/lame.min.js（MP3 编码依赖该库）'));
                return;
            }

            /* --- 声道: 1/2 --- */
            var ch = src.length;
            var channelsRequested = ch;
            if (ch > 2) {
                /* 多于 2 声道：下混为立体声（取前两声道，保持左右关系不糊） */
                src = [src[0], src[1]];
                ch = 2;
                notes.push('输入 ' + channelsRequested + ' 声道，已下混为立体声（取前两声道）');
            }

            /* --- 采样率: MPEG-1/2/2.5 合法值 --- */
            var srRequested = sr;
            var srOk = MP3_SAMPLE_RATES.indexOf(sr) >= 0;
            if (!srOk) {
                var useSr = nearestSampleRate(sr);
                src = resampleChannels(src, sr, useSr);
                notes.push('采样率 ' + sr + 'Hz 不是 MP3 合法值，已重采样为 ' + useSr + 'Hz');
                sr = useSr;
            }

            /* --- 比特率: 与 MPEG 版本匹配（kbps；传入 >=1000 时按 bps 解释） --- */
            var ver = mpegVersion(sr);
            var legal = mp3Bitrates(ver);
            var requested = opts.bitrate == null ? defaultMp3Bitrate(ver) : toInt(opts.bitrate, 'bitrate');
            if (requested >= 1000) {
                requested = Math.round(requested / 1000); /* 兼容 bps 写法 */
            }
            var useBr = nearestOf(legal, requested);
            var adjusted = useBr !== requested;
            if (adjusted) {
                notes.push('比特率 ' + requested + 'k 不适用于 MPEG-' + (ver === 2.5 ? '2.5' : ver) +
                    '（合法 ' + legal[0] + '..' + legal[legal.length - 1] + 'k），已取最近合法值 ' + useBr + 'k');
            }
            if (opts.vbr) {
                notes.push('lamejs 1.2.1 无 VBR 接口，已回退为 CBR ' + useBr + 'k');
            }
            if (opts.maxBitrate != null || opts.minBitrate != null) {
                /* 兼容性：忽略纯 VBR 参数 */
            }

            var L = src[0];
            var R = ch === 2 ? src[1] : null;
            var total = L.length;
            var CHUNK = 1152;
            var pieces = [];
            var off = 0;
            var enc;

            meta = {
                codec: 'mp3',
                container: 'mpeg-audio',
                mpegVersion: ver,
                sampleRate: sr,
                sampleRateRequested: srRequested,
                channels: ch,
                channelsRequested: channelsRequested,
                bitrate: useBr,
                bitrateRequested: requested,
                bitrateAdjusted: adjusted,
                bitrates: legal,
                vbr: false,
                vbrRequested: !!opts.vbr,
                duration: total / sr,
                notes: notes
            };

            try {
                enc = new lame.Mp3Encoder(ch, sr, useBr);
            } catch (e) {
                reject(new Error('lamejs 初始化失败（' + ch + ' 声道 / ' + sr + 'Hz / ' + useBr + 'k）：' + (e && e.message)));
                return;
            }

            function step() {
                var guard = 0;
                try {
                    while (off < total && guard < 24) {
                        var n = Math.min(CHUNK, total - off);
                        var lb = floatToInt16Range(L, off, n);
                        var rb = R ? floatToInt16Range(R, off, n) : null;
                        var buf = rb ? enc.encodeBuffer(lb, rb) : enc.encodeBuffer(lb);
                        if (buf && buf.length) {
                            pieces.push(u8FromInt8(buf));
                        }
                        off += n;
                        guard++;
                        /* 每块（1152 样本）回调一次，进度条更平滑 */
                        safeCall(opts.onProgress, Math.min(0.99, total ? off / total * 0.99 : 1));
                    }
                } catch (e) {
                    reject(new Error('MP3 编码失败：' + (e && e.message)));
                    return;
                }
                if (off < total) {
                    tick().then(step);
                    return;
                }
                try {
                    var tail = enc.flush();
                    if (tail && tail.length) {
                        pieces.push(u8FromInt8(tail));
                    }
                } catch (e2) {
                    reject(new Error('MP3 收尾失败：' + (e2 && e2.message)));
                    return;
                }
                var out = concatBytes(pieces);
                if (!out.length) {
                    reject(new Error('MP3 编码结果为空'));
                    return;
                }
                /* 帧头合法性检查：0xFF Ex（MPEG-1/2 允许 0xFB/0xF3/0xF2/0xFA 等） */
                if (out[0] !== 0xff || (out[1] & 0xe0) !== 0xe0) {
                    reject(new Error('MP3 输出同步字异常，lamejs 可能不支持该参数组合'));
                    return;
                }
                meta.bytes = out.length;
                meta.samples = total;
                safeCall(opts.onProgress, 1);
                resolve(withMeta(out, meta));
            }

            step();
        });
    }

    /* =====================================================================
     * 6. WebCodecs 通用编码流程
     * ===================================================================== */

    function hasWebCodecs() {
        return typeof global.AudioEncoder === 'function' &&
            typeof global.AudioEncoder.isConfigSupported === 'function';
    }

    function webCodecsError(what) {
        return new Error('当前环境不支持 WebCodecs AudioEncoder，无法编码 ' + what +
            '。请使用 Chrome/Edge 94+（或支持 WebCodecs 的浏览器），并在安全上下文（https / localhost / file://）中打开。');
    }

    /** 复制一份编码配置（避免多个候选配置互相污染） */
    function cloneCfg(base) {
        var c = {
            codec: base.codec,
            sampleRate: base.sampleRate,
            numberOfChannels: base.numberOfChannels,
            bitrate: base.bitrate
        };
        if (base.opus) {
            c.opus = base.opus;
        }
        if (base.description) {
            c.description = base.description;
        }
        if (base.aac) {
            c.aac = base.aac;
        }
        return c;
    }

    /**
     * 通用 WebCodecs 音频编码：
     *  - 依次尝试 configs 中的配置变体（isConfigSupported + configure）
     *  - 按 frameSize 逐块喂入 f32-planar AudioData，定期让出主线程
     *  - 收集 EncodedAudioChunk 的原始字节
     * @param {object} spec {channels, sampleRate, frameSize, configs, onProgress, batch}
     * @return {Promise<{chunks:Uint8Array[], description:Uint8Array|null, frames:number, config:object}>}
     */
    function webCodecEncode(spec) {
        return new Promise(function (resolve, reject) {
            if (!hasWebCodecs()) {
                reject(spec.errorOnUnsupported || webCodecsError('音频'));
                return;
            }
            var AE = global.AudioEncoder;
            var variants = spec.configs || [];
            var idx = 0;
            var lastErr = null;
            var settled = false;

            function done(err, val) {
                if (settled) {
                    return;
                }
                settled = true;
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            }

            function attempt() {
                if (idx >= variants.length) {
                    done(lastErr || new Error('当前浏览器不支持所请求的音频编码配置'));
                    return;
                }
                var cfg = variants[idx++];
                AE.isConfigSupported(cfg).then(function (res) {
                    if (!res || !res.supported) {
                        lastErr = new Error('配置不受支持: ' + JSON.stringify({
                            codec: cfg.codec,
                            sampleRate: cfg.sampleRate,
                            numberOfChannels: cfg.numberOfChannels,
                            bitrate: cfg.bitrate
                        }));
                        attempt();
                        return;
                    }
                    run(cfg);
                }, function (e) {
                    lastErr = e;
                    attempt();
                });
            }

            function run(cfg) {
                var chunks = [];
                var description = null;
                var frames = 0;
                var enc;
                try {
                    enc = new AE({
                        output: function (chunk, metadata) {
                            var u = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(u);
                            chunks.push(u);
                            frames++;
                            if (metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
                                description = u8FromBuffer(metadata.decoderConfig.description);
                            }
                        },
                        error: function (e) {
                            done(e instanceof Error ? e : new Error('WebCodecs 编码器错误: ' + (e && e.message ? e.message : String(e))));
                        }
                    });
                    enc.configure(cfg);
                } catch (e) {
                    lastErr = e;
                    attempt();
                    return;
                }

                var total = spec.channels[0].length;
                var ch = spec.channels.length;
                var frameSize = spec.frameSize;
                var batch = spec.batch || 24;
                var off = 0;

                function pump() {
                    var guard = 0;
                    try {
                        while (off < total && guard < batch) {
                            var n = Math.min(frameSize, total - off);
                            var planar = new Float32Array(n * ch);
                            for (var c = 0; c < ch; c++) {
                                planar.set(spec.channels[c].subarray(off, off + n), c * n);
                            }
                            var ad = new global.AudioData({
                                format: 'f32-planar',
                                sampleRate: spec.sampleRate,
                                numberOfFrames: n,
                                numberOfChannels: ch,
                                timestamp: Math.round(off * 1e6 / spec.sampleRate),
                                data: planar
                            });
                            enc.encode(ad);
                            if (typeof ad.close === 'function') {
                                ad.close();
                            }
                            off += n;
                            guard++;
                            safeCall(spec.onProgress, total ? Math.min(0.97, off / total * 0.97) : 1);
                        }
                    } catch (e) {
                        done(e);
                        return;
                    }
                    if (off < total) {
                        tick().then(pump);
                        return;
                    }
                    enc.flush().then(function () {
                        if (typeof enc.close === 'function') {
                            enc.close();
                        }
                        safeCall(spec.onProgress, 1);
                        done(null, { chunks: chunks, description: description, frames: frames, config: cfg });
                    }, function (e) {
                        done(e);
                    });
                }

                pump();
            }

            attempt();
        });
    }

    /* =====================================================================
     * 7. AAC-LC（WebCodecs -> ADTS）
     * ===================================================================== */

    /** 采样率 -> ADTS 索引（找不到返回 -1） */
    function adtsSampleRateIndex(sampleRate) {
        return ADTS_SAMPLE_RATES.indexOf(sampleRate);
    }

    /** 声道数 -> ADTS/AAC channelConfiguration */
    function adtsChannelConfig(ch) {
        if (ch === 1) {
            return 1;
        }
        if (ch === 2) {
            return 2;
        }
        if (ch >= 3 && ch <= 6) {
            return ch;
        }
        if (ch === 8) {
            return 7;
        }
        throw new Error('AAC 不支持 ' + ch + ' 声道（支持 1..6 或 8）');
    }

    /**
     * 构造 AudioSpecificConfig（AAC-LC，2 字节）:
     *   audioObjectType(5) | samplingFrequencyIndex(4) | channelConfiguration(4) | 3bit 全 0
     * 例: 44100Hz 立体声 LC -> 0x12 0x10
     */
    function audioSpecificConfig(sampleRate, channels, audioObjectType) {
        var sfi = adtsSampleRateIndex(sampleRate);
        if (sfi < 0) {
            throw new Error('AAC 不支持采样率 ' + sampleRate + 'Hz（合法值: ' + ADTS_SAMPLE_RATES.join(', ') + '）');
        }
        var aot = audioObjectType == null ? 2 : audioObjectType;
        if (aot < 1 || aot > 31) {
            throw new Error('audioObjectType 非法');
        }
        var chc = adtsChannelConfig(channels);
        var v = ((aot & 0x1f) << 11) | ((sfi & 0x0f) << 7) | ((chc & 0x0f) << 3);
        return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
    }

    /** 从 AudioSpecificConfig 反解 {audioObjectType, sampleRateIndex, channelConfig} */
    function parseAudioSpecificConfig(asc) {
        if (!asc || asc.length < 2) {
            return null;
        }
        return {
            audioObjectType: (asc[0] >> 3) & 0x1f,
            sampleRateIndex: ((asc[0] & 0x07) << 1) | ((asc[1] >> 7) & 0x01),
            channelConfig: (asc[1] >> 3) & 0x0f
        };
    }

    /**
     * 把裸 AAC 帧（每帧 1024 样本）封装为 ADTS。
     * 7 字节头: syncword(12) | ID(1)=0(MPEG-4) | layer(2)=0 | protection_absent(1)=1
     *           profile(2) | sampling_frequency_index(4) | private(1) | channel_config(3)
     *           original(1) | home(1) | copyright_id(1) | copyright_start(1)
     *           aac_frame_length(13) | adts_buffer_fullness(11)=0x7FF | num_raw_blocks(2)=0
     */
    function adtsMux(frames, sampleRate, channels, profile) {
        var sfi = adtsSampleRateIndex(sampleRate);
        if (sfi < 0) {
            throw new Error('AAC 不支持采样率 ' + sampleRate + 'Hz');
        }
        var chc = adtsChannelConfig(channels);
        var prof = profile == null ? 1 : (profile & 0x03); /* profile = AOT-1 */
        var total = 0;
        var i;
        for (i = 0; i < frames.length; i++) {
            var fl = frames[i].length + 7;
            if (fl > 0x1fff) {
                throw new Error('AAC 单帧过大（' + fl + ' 字节），超出 ADTS 13bit 帧长上限');
            }
            total += fl;
        }
        var out = new Uint8Array(total);
        var off = 0;
        for (i = 0; i < frames.length; i++) {
            var fr = frames[i];
            var len = fr.length + 7;
            out[off] = 0xff;
            out[off + 1] = 0xf1; /* MPEG-4, layer 00, protection_absent=1 */
            out[off + 2] = ((prof & 0x03) << 6) | ((sfi & 0x0f) << 2) | ((chc >> 2) & 0x01);
            out[off + 3] = ((chc & 0x03) << 6) | ((len >> 11) & 0x03);
            out[off + 4] = (len >> 3) & 0xff;
            out[off + 5] = ((len & 0x07) << 5) | 0x1f; /* buffer fullness 高 5 位 = 0x1F */
            out[off + 6] = 0xfc; /* fullness 低 6 位 111111 + num_raw_blocks 00 */
            out.set(fr, off + 7);
            off += len;
        }
        return out;
    }

    /** Chromium（Media Foundation）AAC-LC 编码器接受的比特率白名单（bps） */
    var AAC_BITRATES = [96000, 128000, 160000, 192000];

    /** Chromium AAC-LC 编码器接受的采样率白名单 */
    var AAC_SAMPLE_RATES = [44100, 48000];

    /** 判断一个 chunk 是否是完整的 ADTS 帧（同步字 + layer=0 + 帧长自洽） */
    function isAdtsFrame(u8) {
        if (!u8 || u8.length < 7) {
            return false;
        }
        if (u8[0] !== 0xff || (u8[1] & 0xf0) !== 0xf0) {
            return false;
        }
        if ((u8[1] & 0x06) !== 0) {
            return false; /* layer 必须为 00 */
        }
        var len = ((u8[3] & 0x03) << 11) | (u8[4] << 3) | ((u8[5] >> 5) & 0x07);
        return len === u8.length;
    }

    /** 统计 ADTS 流中的帧数（同时用于校验帧长自洽） */
    function countAdtsFrames(u8) {
        var i = 0;
        var n = 0;
        while (i + 7 <= u8.length) {
            if (u8[i] !== 0xff || (u8[i + 1] & 0xf0) !== 0xf0) {
                return -1;
            }
            var len = ((u8[i + 3] & 0x03) << 11) | (u8[i + 4] << 3) | ((u8[i + 5] >> 5) & 0x07);
            if (len < 8 || i + len > u8.length) {
                return -1;
            }
            i += len;
            n++;
        }
        return i === u8.length ? n : -1;
    }

    /**
     * AAC-LC 编码（WebCodecs AudioEncoder 'mp4a.40.2'）输出 ADTS 封装 .aac。
     *
     * Chromium 的 AAC-LC 编码器（Windows/macOS，走 Media Foundation）参数白名单：
     *   numberOfChannels ∈ {1, 2, 6}
     *   sampleRate      ∈ {44100, 48000}
     *   bitrate         ∈ {96000, 128000, 160000, 192000}
     * 本函数会先自动修正输入（重采样 / 下混 / 就近取码率），再把实际参数写进 meta。
     *
     * 输出封装优先用 WebCodecs 原生 `aac:{format:'adts'}`（Chrome 支持，直接得到标准
     * ADTS 流）；若该配置不被支持，则退回自写 7 字节 ADTS 头逐帧封装。
     *
     * @return {Promise<Uint8Array>} 结果带 .meta
     */
    function aac(channels, sampleRate, opts) {
        opts = opts || {};
        return Promise.resolve().then(function () {
            if (!hasWebCodecs()) {
                throw webCodecsError('AAC-LC');
            }
            var src = normalizeChannels(channels);
            var srIn = toInt(sampleRate, 'sampleRate');
            var notes = [];
            var chReq = src.length;
            var ch = src.length;
            var inputSamples = src[0].length;

            /* --- 声道: 白名单 {1,2,6}，>2 一律下混为立体声 --- */
            if (ch > 2) {
                src = [src[0], src[1]];
                ch = 2;
                notes.push('输入 ' + chReq + ' 声道，已下混为立体声（WebCodecs AAC-LC 仅保证 1/2 声道）');
            }
            if (ch !== 1 && ch !== 2) {
                throw new Error('AAC-LC 仅支持 1 或 2 声道，收到 ' + ch);
            }

            /* --- 采样率: 白名单 {44100,48000}，其余重采样到 48000 --- */
            var sr = srIn;
            if (AAC_SAMPLE_RATES.indexOf(srIn) < 0) {
                sr = 48000;
                src = resampleChannels(src, srIn, 48000);
                notes.push('采样率 ' + srIn + 'Hz 不在 AAC-LC 白名单（44100/48000）中，已重采样为 48000Hz');
            }

            /* --- 比特率: 白名单就近（支持 kbps/bps 两种写法） --- */
            var brReq = bitrateToBps(opts.bitrate == null ? 128000 : opts.bitrate);
            if (brReq == null) {
                brReq = 128000;
            }
            var br = nearestOf(AAC_BITRATES, brReq);
            if (br !== brReq) {
                notes.push('比特率 ' + brReq + ' 不在 AAC-LC 白名单（' + AAC_BITRATES.join('/') +
                    '）中，已取最近合法值 ' + br);
            }

            var asc = audioSpecificConfig(sr, ch, 2);
            var base = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: br };
            var withDesc = cloneCfg(base);
            withDesc.description = asc.buffer;
            var withAdts = cloneCfg(base);
            withAdts.aac = { format: 'adts' };
            var withAdtsDesc = cloneCfg(withDesc);
            withAdtsDesc.aac = { format: 'adts' };
            /* 优先原生 ADTS 输出，其次 description，最后裸配置 */
            var configs = [withAdts, withAdtsDesc, withDesc, base];

            return webCodecEncode({
                channels: src,
                sampleRate: sr,
                frameSize: 1024,
                configs: configs,
                onProgress: opts.onProgress,
                batch: 32,
                errorOnUnsupported: webCodecsError('AAC-LC')
            }).then(function (res) {
                if (!res.chunks.length) {
                    throw new Error('AAC 编码器未返回任何数据（可能该平台的 AAC 编码器不可用）');
                }
                var cfgUsed = res.config;
                var wantAdts = !!(cfgUsed && cfgUsed.aac && cfgUsed.aac.format === 'adts');
                var profile = 1; /* AAC-LC: AOT=2 -> profile=1 */
                var ascUsed = asc;
                if (res.description && res.description.length >= 2) {
                    ascUsed = res.description;
                    var info = parseAudioSpecificConfig(res.description);
                    if (info && info.audioObjectType >= 1 && info.audioObjectType <= 4) {
                        profile = info.audioObjectType - 1;
                    } else if (info) {
                        notes.push('编码器返回 AOT=' + info.audioObjectType + '，ADTS profile 按 LC 写入');
                    }
                }

                var bytes;
                var frames;
                var nativeAdts = false;
                var chunks = res.chunks;

                /*
                 * 判定编码器输出到底是「ADTS 流」还是「裸 AAC 帧」，与配置无关地做三层判断：
                 *   1) 每个 chunk 都是自洽的 ADTS 帧（syncword + layer=0 + 帧长 == chunk 长度）
                 *   2) 拼接后整体能按 ADTS 帧长严格走完
                 *   3) 否则按裸帧处理，逐帧加 7 字节头
                 * 这样可以覆盖 Chromium 各版本对 aac:{format:'adts'} 的不同实现（含忽略该字段）。
                 */
                var allSingleFrames = chunks.length > 0;
                for (var i = 0; i < chunks.length; i++) {
                    if (!isAdtsFrame(chunks[i])) {
                        allSingleFrames = false;
                        break;
                    }
                }
                if (allSingleFrames) {
                    bytes = concatBytes(chunks);
                    frames = chunks.length;
                    nativeAdts = true;
                    if (!wantAdts) {
                        notes.push('编码器返回的已是完整 ADTS 帧，直接拼接（未二次封装）');
                    }
                } else {
                    var joined = concatBytes(chunks);
                    var cntJoined = countAdtsFrames(joined);
                    if (cntJoined > 0) {
                        bytes = joined;
                        frames = cntJoined;
                        nativeAdts = true;
                        if (!wantAdts) {
                            notes.push('编码器返回整体为 ADTS 流，直接透传（未二次封装）');
                        }
                    } else if (wantAdts) {
                        notes.push('请求了 aac:{format:"adts"} 但编码器返回裸帧，已自行封装 ADTS');
                    }
                }

                if (wantAdts && nativeAdts) {
                    notes.push('使用 WebCodecs 原生 ADTS 输出（未二次封装）');
                }
                if (!bytes) {
                    bytes = adtsMux(chunks, sr, ch, profile);
                    frames = chunks.length;
                }

                var meta = {
                    codec: 'aac',
                    container: 'adts',
                    audioObjectType: 2,
                    profile: profile,
                    sampleRate: sr,
                    sampleRateRequested: srIn,
                    channels: ch,
                    channelsRequested: chReq,
                    bitrate: br,
                    bitrateRequested: brReq,
                    bitrateAdjusted: br !== brReq,
                    bitrates: AAC_BITRATES.slice(),
                    resampled: sr !== srIn,
                    nativeAdts: nativeAdts,
                    frames: frames,
                    samples: frames * 1024,
                    duration: frames * 1024 / sr,
                    inputSamples: inputSamples,
                    inputDuration: inputSamples / srIn,
                    withDescription: !!(cfgUsed && !!cfgUsed.description),
                    asc: Array.prototype.slice.call(ascUsed),
                    notes: notes
                };
                return withMeta(bytes, meta);
            });
        });
    }

    /* =====================================================================
     * 8. Ogg 封装（CRC32 / 分页 / OpusHead / OpusTags）
     * ===================================================================== */

    /** Ogg CRC32 查找表：多项式 0x04C11DB7，非反射，初值 0，无终值异或 */
    var OGG_CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var r = i << 24;
            for (var j = 0; j < 8; j++) {
                r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
            }
            t[i] = r >>> 0;
        }
        return t;
    })();

    function crc32Ogg(bytes, start, end) {
        var s = start == null ? 0 : start;
        var e = end == null ? bytes.length : end;
        var crc = 0;
        for (var i = s; i < e; i++) {
            crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
        }
        return crc >>> 0;
    }

    /** OpusHead（19 字节） */
    function opusHead(channels, preSkip, inputSampleRate) {
        var b = new Uint8Array(19);
        writeStr(b, 0, 'OpusHead');
        b[8] = 1; /* version */
        b[9] = channels & 0xff;
        writeU16LE(b, 10, preSkip == null ? OPUS_PRE_SKIP : preSkip);
        writeU32LE(b, 12, inputSampleRate == null ? OPUS_RATE : inputSampleRate);
        writeU16LE(b, 16, 0); /* output gain (Q7.8) = 0 */
        b[18] = 0; /* channel mapping family 0 */
        return b;
    }

    /** OpusTags */
    function opusTags(vendor) {
        var v = utf8Encode(vendor == null ? 'AudioEnc' : vendor);
        var b = new Uint8Array(8 + 4 + v.length + 4);
        writeStr(b, 0, 'OpusTags');
        writeU32LE(b, 8, v.length);
        b.set(v, 12);
        writeU32LE(b, 12 + v.length, 0); /* user comment list length = 0 */
        return b;
    }

    /**
     * 组装一个 Ogg 页。
     * @param {number} headerType 0x02=BOS, 0x04=EOS, 0x01=continuation
     * @param {number} granule  granule position（48kHz 样本数）
     * @param {Uint8Array[]} packets 该页包含的完整包
     */
    function oggPage(headerType, granule, packets, serial, sequence) {
        var segs = [];
        var payload = 0;
        var i;
        var k;
        for (i = 0; i < packets.length; i++) {
            var p = packets[i];
            var n255 = Math.floor(p.length / 255);
            for (k = 0; k < n255; k++) {
                segs.push(255);
            }
            /* 长度恰为 255 的倍数时必须补 0 终止段，否则解码端会误认为包未结束 */
            segs.push(p.length % 255);
            payload += p.length;
        }
        if (segs.length > 255) {
            throw new Error('Ogg 单页段表超过 255（' + segs.length + '）');
        }
        /* 27 字节页头（含末尾 page_segments 字段）+ 段表 + 载荷 */
        var size = 27 + segs.length + payload;
        var b = new Uint8Array(size);
        writeStr(b, 0, 'OggS');
        b[4] = 0; /* version */
        b[5] = headerType & 0xff;
        writeU64LE(b, 6, granule);
        writeU32LE(b, 14, serial >>> 0);
        writeU32LE(b, 18, sequence >>> 0);
        writeU32LE(b, 22, 0); /* CRC 占位 */
        b[26] = segs.length;
        for (i = 0; i < segs.length; i++) {
            b[27 + i] = segs[i];
        }
        var off = 27 + segs.length;
        for (i = 0; i < packets.length; i++) {
            b.set(packets[i], off);
            off += packets[i].length;
        }
        writeU32LE(b, 22, crc32Ogg(b));
        return b;
    }

    /**
     * 把 Opus 包封装为 Ogg（OpusHead/OpusTags + 音频页 + EOS 末页）。
     * @param {Uint8Array[]} packets 每包一帧
     * @param {object} o {channels, inputSampleRate, preSkip, frameSamples, totalSamples, serial, vendor}
     */
    function buildOggOpus(packets, o) {
        o = o || {};
        if (!packets || !packets.length) {
            throw new Error('没有可封装的 Opus 帧');
        }
        var ch = o.channels || 1;
        var preSkip = o.preSkip == null ? OPUS_PRE_SKIP : o.preSkip;
        var inputRate = o.inputSampleRate == null ? OPUS_RATE : o.inputSampleRate;
        var frameSamples = o.frameSamples || OPUS_FRAME_SAMPLES;
        var totalSamples = o.totalSamples == null ? packets.length * frameSamples : o.totalSamples;
        var serial = o.serial == null ? 0x4f707553 : (o.serial >>> 0);
        var vendor = o.vendor == null ? 'AudioEnc' : o.vendor;
        var pages = [];
        var seq = 0;
        var cum = 0; /* 已入页样本数（不含 preSkip） */
        var cur = [];
        var curSegs = 0;
        var curBytes = 0;

        pages.push(oggPage(0x02, 0, [opusHead(ch, preSkip, inputRate)], serial, seq++));
        pages.push(oggPage(0x00, 0, [opusTags(vendor)], serial, seq++));

        function flushPage(isLast) {
            var g = isLast ? preSkip + totalSamples : preSkip + cum;
            if (isLast && !cur.length) {
                throw new Error('Ogg 末页没有数据');
            }
            pages.push(oggPage(isLast ? 0x04 : 0x00, g, cur, serial, seq++));
            cur = [];
            curSegs = 0;
            curBytes = 0;
        }

        for (var i = 0; i < packets.length; i++) {
            var p = packets[i];
            var segCount = Math.floor(p.length / 255) + 1;
            if (segCount > 255) {
                throw new Error('单个 Opus 包过大（' + p.length + ' 字节），单页无法封装');
            }
            if (cur.length && (curSegs + segCount > 255 || curBytes + p.length > OGG_PAGE_MAX_PAYLOAD)) {
                flushPage(false);
            }
            cur.push(p);
            curSegs += segCount;
            curBytes += p.length;
            cum += frameSamples;
        }
        flushPage(true);

        var total = 0;
        for (var j = 0; j < pages.length; j++) {
            total += pages[j].length;
        }
        return concatBytes(pages, total);
    }

    /* =====================================================================
     * 9. Ogg Opus 编码（WebCodecs 'opus'）
     * ===================================================================== */

    /**
     * Ogg Opus 编码。输入任意采样率，内部重采样至 48kHz 后编码。
     * @return {Promise<Uint8Array>} 结果带 .meta
     */
    function oggOpus(channels, sampleRate, opts) {
        opts = opts || {};
        return Promise.resolve().then(function () {
            if (!hasWebCodecs()) {
                throw webCodecsError('Opus');
            }
            var src = normalizeChannels(channels);
            var sr = toInt(sampleRate, 'sampleRate');
            if (!(sr > 0)) {
                throw new Error('sampleRate 必须是正整数');
            }
            var notes = [];
            var channelsRequested = src.length;
            var ch = src.length;
            if (ch > 2) {
                src = [src[0], src[1]];
                ch = 2;
                notes.push('输入 ' + channelsRequested + ' 声道，已下混为立体声（Opus mapping family 0 仅支持 1/2 声道）');
            }
            if (sr !== OPUS_RATE) {
                notes.push('采样率 ' + sr + 'Hz 已重采样为 48000Hz（Opus 内部固定 48kHz）');
                src = resampleChannels(src, sr, OPUS_RATE);
            }
            var total48 = src[0].length;
            var br = bitrateToBps(opts.bitrate == null ? 96000 : opts.bitrate);
            if (br == null) {
                br = 96000;
            }
            var brReq = br;
            if (br < 6000) {
                br = 6000;
            }
            if (br > 512000) {
                br = 512000;
            }
            /* frameDuration 必须是 2500 的整数倍且落在 [2500, 120000]（微秒） */
            var fd = opts.frameDuration == null ? OPUS_FRAME_US : toInt(opts.frameDuration, 'frameDuration');
            if (fd < 2500 || fd > 120000 || fd % 2500 !== 0) {
                notes.push('frameDuration=' + fd + 'us 非法（需为 2500 的整数倍且 ∈[2500,120000]），已回退为 20000us');
                fd = OPUS_FRAME_US;
            }
            var frameSamples = fd * OPUS_RATE / 1000000; /* 20ms -> 960 */
            if (frameSamples % 1 !== 0) {
                frameSamples = OPUS_FRAME_SAMPLES;
            }
            var base = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: ch, bitrate: br };
            var withFrame = cloneCfg(base);
            withFrame.opus = { frameDuration: fd };
            var configs = [withFrame, base];

            return webCodecEncode({
                channels: src,
                sampleRate: OPUS_RATE,
                frameSize: frameSamples,
                configs: configs,
                onProgress: opts.onProgress,
                batch: 32,
                errorOnUnsupported: webCodecsError('Ogg Opus')
            }).then(function (res) {
                if (!res.chunks.length) {
                    throw new Error('Opus 编码器未返回任何数据（可能该平台的 Opus 编码器不可用）');
                }
                var packets = res.chunks;
                var covered = packets.length * frameSamples;
                if (covered < total48) {
                    notes.push('编码器输出样本数（' + covered + '）少于输入（' + total48 + '），末尾可能被截断');
                }
                var bytes = buildOggOpus(packets, {
                    channels: ch,
                    inputSampleRate: sr,
                    preSkip: OPUS_PRE_SKIP,
                    frameSamples: frameSamples,
                    totalSamples: total48,
                    serial: opts.serial == null ? 0x4f707553 : opts.serial,
                    vendor: opts.vendor == null ? 'AudioEnc ' + VERSION : opts.vendor
                });
                var meta = {
                    codec: 'opus',
                    container: 'ogg',
                    sampleRate: OPUS_RATE,
                    sampleRateRequested: sr,
                    channels: ch,
                    channelsRequested: channelsRequested,
                    bitrate: br,
                    bitrateRequested: brReq,
                    preSkip: OPUS_PRE_SKIP,
                    frameDuration: fd,
                    frameSamples: frameSamples,
                    frames: packets.length,
                    samples: total48,
                    duration: total48 / OPUS_RATE,
                    inputDuration: total48 / OPUS_RATE,
                    resampled: sr !== OPUS_RATE,
                    serial: opts.serial == null ? 0x4f707553 : opts.serial,
                    withFrameDuration: !!(res.config && res.config.opus),
                    notes: notes
                };
                return withMeta(bytes, meta);
            });
        });
    }

    /* =====================================================================
     * 10. 能力探测
     * ===================================================================== */

    /**
     * 探测各格式可用性。
     * @return {Promise<{aac:boolean, opus:boolean, flac:boolean, mp3:boolean, webcodecs:boolean}>}
     */
    function support() {
        var result = {
            aac: false,
            opus: false,
            flac: false,
            mp3: !!getLame(),
            webcodecs: hasWebCodecs(),
            lamejs: !!getLame(),
            details: {}
        };
        if (!result.webcodecs) {
            return Promise.resolve(result);
        }
        var AE = global.AudioEncoder;
        var checks = [
            ['aac', { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 }],
            ['opus', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 }],
            ['flac', { codec: 'flac', sampleRate: 44100, numberOfChannels: 2, bitrate: 700000 }],
            ['mp3', { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 }]
        ];
        var chain = Promise.resolve();
        checks.forEach(function (pair) {
            chain = chain.then(function () {
                /* isConfigSupported 可能同步抛错（未知 codec / 参数越界），必须兜住 */
                var p;
                try {
                    p = AE.isConfigSupported(pair[1]);
                } catch (e) {
                    result.details[pair[0]] = { supported: false, error: e && e.message };
                    return;
                }
                return Promise.resolve(p).then(function (r) {
                    var ok = !!(r && r.supported);
                    result.details[pair[0]] = { supported: ok, config: pair[1] };
                    if (pair[0] === 'mp3') {
                        result.mp3 = result.mp3 || ok; /* lamejs 或 WebCodecs 任一可用 */
                    } else {
                        result[pair[0]] = ok;
                    }
                }, function (e) {
                    result.details[pair[0]] = { supported: false, error: e && e.message };
                });
            });
        });
        return chain.then(function () {
            return result;
        }, function () {
            return result; /* 探测过程绝不向外抛异常 */
        });
    }

    /* =====================================================================
     * 11. 导出
     * ===================================================================== */

    var AudioEnc = {
        version: VERSION,

        /* 编码器 */
        wav: wav,
        mp3: mp3,
        mp3Meta: mp3Meta,
        aac: aac,
        oggOpus: oggOpus,

        /* 能力探测 */
        hasWebCodecs: hasWebCodecs,
        support: support,

        /* 工具 */
        resample: resampleChannels,

        /* 常量（便于 UI 提示） */
        ADTS_SAMPLE_RATES: ADTS_SAMPLE_RATES.slice(),
        MP3_SAMPLE_RATES: MP3_SAMPLE_RATES.slice(),
        AAC_BITRATES: AAC_BITRATES.slice(),
        AAC_SAMPLE_RATES: AAC_SAMPLE_RATES.slice(),

        /**
         * 内部实现（测试/调试用；语义可能随版本变化，勿在业务代码中依赖）。
         * @private
         */
        _internal: {
            normalizeChannels: normalizeChannels,
            floatToInt16: floatToInt16,
            floatToInt16Range: floatToInt16Range,
            floatToInt24: floatToInt24,
            resampleChannels: resampleChannels,
            resampleMono: resampleMono,
            mpegVersion: mpegVersion,
            mp3Bitrates: mp3Bitrates,
            nearestOf: nearestOf,
            defaultMp3Bitrate: defaultMp3Bitrate,
            /* AAC */
            adtsSampleRateIndex: adtsSampleRateIndex,
            adtsChannelConfig: adtsChannelConfig,
            audioSpecificConfig: audioSpecificConfig,
            parseAudioSpecificConfig: parseAudioSpecificConfig,
            adtsMux: adtsMux,
            isAdtsFrame: isAdtsFrame,
            countAdtsFrames: countAdtsFrames,
            cloneCfg: cloneCfg,
            /* Ogg */
            crc32Ogg: crc32Ogg,
            oggPage: oggPage,
            opusHead: opusHead,
            opusTags: opusTags,
            buildOggOpus: buildOggOpus,
            /* 通用 */
            webCodecEncode: webCodecEncode,
            utf8Encode: utf8Encode,
            OPUS_PRE_SKIP: OPUS_PRE_SKIP,
            OPUS_FRAME_SAMPLES: OPUS_FRAME_SAMPLES,
            OGG_PAGE_MAX_PAYLOAD: OGG_PAGE_MAX_PAYLOAD
        }
    };

    global.AudioEnc = AudioEnc;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this)));
