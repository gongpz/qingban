/*!
 * flac-encoder.js  ——  纯 JavaScript 实现的 FLAC 无损音频编码器
 * ===========================================================================
 *
 *  一句话说明
 *  ----------
 *  经典脚本（无 import / export / require），浏览器 <script> 直接引入即可用，
 *  同时兼容 CommonJS（Node）。把 Float32Array 音频编码成完整的 .flac 文件字节流。
 *
 *  API
 *  ---
 *    globalThis.FlacEncoder = {
 *      encode(channels, sampleRate, opts) -> Uint8Array
 *    }
 *
 *    channels   : Float32Array[]（也可以是 number[]）。长度一致，取值 -1..1。
 *                 channels.length 即声道数，支持 1~8。
 *                 内部 PCM 值 = round(sample * 2^(bitDepth-1))，再钳位。
 *                 声道顺序按 FLAC 约定：1=单声道；2=左/右；
 *                 4=前左/前右/后左/后右；6=前左/前右/中置/LFE/后左/后右；
 *                 8=前左/前右/中置/LFE/后左/后右/侧左/侧右。
 *    sampleRate : 采样率 Hz，8000~192000（格式上限为 20bit，即 1048575）。
 *    opts       : {
 *                    bitDepth   : 16 | 24     默认 16
 *                    blockSize  : 16..65535   默认 4096，建议 1024~16384
 *                    maxLpcOrder: 0..32       默认 8，建议 0~8（0 = 关闭 LPC）
 *                    compression: 0..8        默认 5
 *                 }
 *    返回       : Uint8Array，完整 .flac 文件（含 "fLaC" 标记、STREAMINFO、
 *                 VORBIS_COMMENT、所有音频帧）。
 *
 *  额外辅助函数（非必需，仅为测试/调用方便提供）：
 *    FlacEncoder.pcmFromFloat(channels, bitDepth) -> Int32Array[]
 *        把 Float32Array[] 按 encode 内部完全相同的规则量化成整数 PCM，
 *        方便调用方自行写 WAV 或做逐样本比对。
 *    FlacEncoder.version : 版本号字符串
 *
 *  典型用法
 *  --------
 *    // 浏览器
 *    <script src="flac-encoder.js"></script>
 *    var flac = FlacEncoder.encode([leftFloat32, rightFloat32], 44100, {bitDepth:16});
 *    var blob = new Blob([flac], {type: 'audio/flac'});
 *    var a = document.createElement('a');
 *    a.href = URL.createObjectURL(blob); a.download = 'out.flac'; a.click();
 *
 *    // Node
 *    var FlacEncoder = require('./flac-encoder.js');
 *    fs.writeFileSync('out.flac', FlacEncoder.encode(chans, 48000, {bitDepth:24}));
 *
 *  实现要点 / 生成的文件结构
 *  -------------------------
 *    fLaC
 *    ├─ STREAMINFO   (min/max block size、min/max frame size、采样率、声道数、
 *    │                位深、总样本数、未编码 PCM 的 MD5 —— 真实计算)
 *    ├─ VORBIS_COMMENT (vendor = "FlacEncoder-JS")
 *    └─ 帧序列       (blocking strategy = fixed；UTF-8 帧号；CRC-8 + CRC-16)
 *         每个子帧按代价最优自动选 CONSTANT / VERBATIM / FIXED(0..4) / LPC(1..32)
 *         残差使用分区 Rice 编码（4bit / 5bit 参数自适应，含 partition order 搜索）
 *         立体声逐帧在 independent / left-side / side-right / mid-side 之间择优
 *
 *  无损保证
 *  --------
 *    残差一旦超出 32bit 有符号可表示范围（RFC 9639 §9.2.7.3），该候选被丢弃，
 *    因此输出永远可被任何合规 FLAC 解码器逐样本精确还原。
 *
 *  已知限制
 *  --------
 *    * 不写 SEEKTABLE / PADDING / PICTURE 等元数据；不写 tags。
 *    * 3/5/7 声道按 FLAC 默认顺序走 independent 编码（不额外写
 *      WAVEFORMATEXTENSIBLE_CHANNEL_MASK 标签）。
 *    * 逐帧固定块长（fixed blocking strategy），最后一帧允许更短。
 *    * 未实现 escaped partition（Rice 参数溢出时直接用更大参数，代价是略差）。
 *
 *  ===========================================================================
 */

(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var VENDOR  = 'FlacEncoder-JS';

  /* =======================================================================
   * 1. CRC 查表
   *    CRC-8  : 多项式 x^8 + x^2 + x^1 + x^0 (0x07)，初值 0，帧头用
   *    CRC-16 : 多项式 x^16 + x^15 + x^2 + x^0 (0x8005)，初值 0，整帧用
   * ======================================================================= */

  var CRC8_TABLE = new Uint8Array(256);
  (function () {
    var i, j, c;
    for (i = 0; i < 256; i++) {
      c = i;
      for (j = 0; j < 8; j++) {
        c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
      }
      CRC8_TABLE[i] = c;
    }
  })();

  var CRC16_TABLE = new Uint16Array(256);
  (function () {
    var i, j, c;
    for (i = 0; i < 256; i++) {
      c = i << 8;
      for (j = 0; j < 8; j++) {
        c = (c & 0x8000) ? (((c << 1) ^ 0x8005) & 0xFFFF) : ((c << 1) & 0xFFFF);
      }
      CRC16_TABLE[i] = c;
    }
  })();

  /* =======================================================================
   * 2. MD5（RFC 1321）
   *    STREAMINFO 里存的是"未编码 PCM"的 MD5：所有声道交错、小端、有符号、
   *    每样本按位深向上取整到字节（16bit→2 字节，24bit→3 字节）。
   *    这个值算对了，flac -t 之类的工具才能通过。
   * ======================================================================= */

  var MD5_K = new Int32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ]);

  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  function md5New() {
    return {
      s0: 0x67452301 | 0,
      s1: 0xefcdab89 | 0,
      s2: 0x98badcfe | 0,
      s3: 0x10325476 | 0,
      buf: new Uint8Array(64),
      bufLen: 0,
      total: 0,              // 已喂入的字节数（Number，2^53 内精确）
      x: new Int32Array(16)
    };
  }

  function md5Block(m, p, off) {
    var X = m.x, i, a, b, c, d, f, g, tmp, sum;
    for (i = 0; i < 16; i++) {
      X[i] = p[off + i * 4] | (p[off + i * 4 + 1] << 8) |
             (p[off + i * 4 + 2] << 16) | (p[off + i * 4 + 3] << 24);
    }
    a = m.s0; b = m.s1; c = m.s2; d = m.s3;
    for (i = 0; i < 64; i++) {
      if (i < 16) {
        f = (b & c) | (~b & d); g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c); g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d; g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d); g = (7 * i) & 15;
      }
      sum = (a + f + MD5_K[i] + X[g]) | 0;
      tmp = d;
      d = c;
      c = b;
      b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) | 0;
      a = tmp;
    }
    m.s0 = (m.s0 + a) | 0;
    m.s1 = (m.s1 + b) | 0;
    m.s2 = (m.s2 + c) | 0;
    m.s3 = (m.s3 + d) | 0;
  }

  function md5Update(m, data, off, len) {
    m.total += len;
    if (m.bufLen > 0) {
      var need = 64 - m.bufLen;
      var take = len < need ? len : need;
      m.buf.set(data.subarray(off, off + take), m.bufLen);
      m.bufLen += take;
      off += take;
      len -= take;
      if (m.bufLen === 64) {
        md5Block(m, m.buf, 0);
        m.bufLen = 0;
      }
    }
    while (len >= 64) {
      md5Block(m, data, off);
      off += 64;
      len -= 64;
    }
    if (len > 0) {
      m.buf.set(data.subarray(off, off + len), 0);
      m.bufLen = len;
    }
  }

  // 返回 16 字节 Uint8Array
  function md5Final(m) {
    var bits = m.total * 8;
    var lo = bits % 4294967296;
    var hi = Math.floor(bits / 4294967296);
    var pad = new Uint8Array(128);
    var padLen = (m.bufLen < 56) ? (56 - m.bufLen) : (120 - m.bufLen);
    var i;
    pad[0] = 0x80;
    pad[padLen]     = lo & 0xFF;
    pad[padLen + 1] = (lo >>> 8) & 0xFF;
    pad[padLen + 2] = (lo >>> 16) & 0xFF;
    pad[padLen + 3] = (lo >>> 24) & 0xFF;
    pad[padLen + 4] = hi & 0xFF;
    pad[padLen + 5] = (hi >>> 8) & 0xFF;
    pad[padLen + 6] = (hi >>> 16) & 0xFF;
    pad[padLen + 7] = (hi >>> 24) & 0xFF;
    md5Update(m, pad, 0, padLen + 8);
    var out = new Uint8Array(16);
    var st = [m.s0, m.s1, m.s2, m.s3];
    for (i = 0; i < 4; i++) {
      out[i * 4]     = st[i] & 0xFF;
      out[i * 4 + 1] = (st[i] >>> 8) & 0xFF;
      out[i * 4 + 2] = (st[i] >>> 16) & 0xFF;
      out[i * 4 + 3] = (st[i] >>> 24) & 0xFF;
    }
    return out;
  }

  /* =======================================================================
   * 3. 位流写入器
   *    输出缓冲区按需倍增；acc/accN 是位累加器（accN 始终 <= 7）。
   * ======================================================================= */

  function ByteWriter(cap) {
    this.buf = new Uint8Array(cap || 262144);
    this.pos = 0;
    this.acc = 0;    // 只保留 accN 个有效低位
    this.accN = 0;
  }

  ByteWriter.prototype.ensure = function (n) {
    if (this.pos + n <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  };

  // 字节写入（要求 accN === 0）
  ByteWriter.prototype.writeByte = function (b) {
    if (this.pos >= this.buf.length) this.ensure(8);
    this.buf[this.pos++] = b & 0xFF;
  };

  /**
   * 写入 n 个比特（n = 0..32），v 取低 n 位，按大端顺序。
   * 说明：acc 最多 7 位，一次性最多拼 25 位 → 不超过 32 位，位运算安全；
   *       n > 25 时拆成两段写入。
   */
  ByteWriter.prototype.writeBits = function (v, n) {
    if (n <= 0) return;
    if (n > 25) {
      var hi = n - 24;
      this.writeBits(Math.floor(v / 16777216), hi);
      this.writeBits(v & 0xFFFFFF, 24);
      return;
    }
    var a = (this.acc << n) | (v & ((1 << n) - 1));
    var an = this.accN + n;
    if (this.pos + 8 > this.buf.length) this.ensure(16);
    while (an >= 8) {
      an -= 8;
      this.buf[this.pos++] = (a >>> an) & 0xFF;
    }
    this.acc = a & ((1 << an) - 1);
    this.accN = an;
  };

  // 连续写 n 个 0 比特（unary 商可能是几万位，必须批量写）
  ByteWriter.prototype.writeZeros = function (n) {
    if (n <= 0) return;
    if (this.accN !== 0) {
      var t = 8 - this.accN;
      if (t > n) t = n;
      this.writeBits(0, t);
      n -= t;
      if (n <= 0) return;
    }
    this.ensure(n + 8);
    var cnt = n >>> 3;
    var buf = this.buf, pos = this.pos;
    while (cnt-- > 0) buf[pos++] = 0;
    this.pos = pos;
    n &= 7;
    if (n > 0) this.writeBits(0, n);
  };

  // unary：n 个 0 后跟一个 1
  ByteWriter.prototype.writeUnary = function (n) {
    this.writeZeros(n);
    this.writeBits(1, 1);
  };

  // 补齐到字节边界
  ByteWriter.prototype.alignByte = function () {
    if (this.accN > 0) this.writeBits(0, 8 - this.accN);
  };

  /* =======================================================================
   * 4. 小工具
   * ======================================================================= */

  var LOG2E = 1.4426950408889634;

  function log2(x) { return Math.log(x) * LOG2E; }

  // 2^s 的倒数查表（s = 0..31，全是 2 的负幂，double 精确）
  var INV_POW2 = new Float64Array(33);
  (function () {
    for (var i = 0; i <= 32; i++) INV_POW2[i] = Math.pow(2, -i);
  })();

  // 有符号残差 -> 折半（zigzag / folded）无符号值
  function fold(v) { return v < 0 ? (-v * 2 - 1) : (v * 2); }

  // 残差绝对值上限：RFC 9639 要求 < 2^31；这里再保守一半，
  // 保证后面 u>>>k 等 32 位运算不会出问题。
  var MAX_RESID = 536870912; // 2^29

  /* =======================================================================
   * 5. 分析阶段用的临时缓冲
   *    全部按 blockSize 一次性分配并复用，避免每帧 new 出大量小对象。
   * ======================================================================= */

  function Scratch(blockSize, maxLpcOrder, maxPo) {
    this.work   = new Int32Array(blockSize);          // 当前子帧样本（已右移 wasted）
    this.diff   = new Int32Array(blockSize);          // 差分 / 残差
    this.resid  = new Int32Array(blockSize);          // LPC 残差
    this.zz     = new Int32Array(blockSize);          // 折半后的残差
    this.ps     = new Float64Array(blockSize + 1);    // 前缀和
    this.xn     = new Float64Array(blockSize);        // 归一化样本（自相关用）
    this.ac     = new Float64Array(maxLpcOrder + 2);  // 自相关
    this.lpcA   = new Float64Array(maxLpcOrder + 2);
    this.lpcTmp = new Float64Array(maxLpcOrder + 2);
    this.lpcErr = new Float64Array(maxLpcOrder + 2);
    this.lpcEst = new Float64Array(maxLpcOrder + 2);
    this.lpcCoef = new Float64Array((maxLpcOrder + 2) * (maxLpcOrder + 2));
    this.lpcQ   = new Int32Array(maxLpcOrder + 2);
    this.lpcQ2  = new Int32Array(maxLpcOrder + 2);
    this.lpcDelta = new Float64Array(maxLpcOrder + 2);
    this.lpcCand = new Float64Array(2 * 33 * 33);
    this.params = new Int32Array(512);   // 最多 2^8 个分区，留足余量
    this.plan   = [];       // 复用的 plan 对象池由调用方管理（这里简单 new）
  }

  /* =======================================================================
   * 6. 子帧分析
   *    对一段整数样本，逐一尝试 CONSTANT / VERBATIM / FIXED(0..4) / LPC(1..N)，
   *    返回比特数最小的方案（plan）。plan 里除了信息还带上精确的 Rice 参数，
   *    写阶段直接复用，保证"分析的代价 == 实际写出的比特数"。
   * ======================================================================= */

  function analyzeSubframe(samp, n, bpsIn, cfg, sc) {
    var i, j, o, p;

    /* ---- 6.1 wasted bits：所有样本共有的低位 0 个数 ---- */
    var ored = 0;
    for (i = 0; i < n; i++) ored |= samp[i];
    var wasted = 0;
    if (ored !== 0) {
      while ((ored & 1) === 0) { ored >>= 1; wasted++; }
    }
    if (wasted > bpsIn - 1) wasted = bpsIn - 1;   // 子帧位深必须 > 0
    var bpr = bpsIn - wasted;                     // 子帧实际位深

    var work = sc.work;
    if (wasted === 0) {
      for (i = 0; i < n; i++) work[i] = samp[i];
    } else {
      for (i = 0; i < n; i++) work[i] = samp[i] >> wasted;
    }

    var baseBits = 8 + (wasted > 0 ? wasted : 0);  // 子帧头 + wasted 的 unary

    /* ---- 6.2 CONSTANT ---- */
    var v0 = work[0], isConst = true;
    for (i = 1; i < n; i++) {
      if (work[i] !== v0) { isConst = false; break; }
    }
    if (isConst) {
      return {
        type: 0, order: 0, value: v0, wasted: wasted, bpsIn: bpsIn, bpsS: bpr,
        bits: baseBits + bpr, partOrder: 0, params: null, method: 0
      };
    }

    /* ---- 6.3 VERBATIM 作为兜底 ---- */
    var best = {
      type: 1, order: 0, wasted: wasted, bpsIn: bpsIn, bpsS: bpr,
      bits: baseBits + n * bpr, partOrder: 0, params: null, method: 0
    };

    var maxOrd = Math.min(4, cfg.maxFixedOrder, n - 1);
    if (maxOrd < 0) maxOrd = 0;

    /* ---- 6.4 FIXED 0..4 ---- */
    var d = sc.diff;
    for (i = 0; i < n; i++) d[i] = work[i];
    for (o = 0; o <= maxOrd; o++) {
      if (o > 0) {
        // 从尾部往前做一阶差分，原地得到 o 阶差分
        for (i = n - 1; i >= o; i--) d[i] = d[i] - d[i - 1];
      }
      if (n - o <= 0) break;
      var rz = riceAnalyze(d, o, n - o, n, o, cfg.maxPo, sc);
      var bits = baseBits + o * bpr + rz.bits;
      if (bits < best.bits) {
        best = {
          type: 2, order: o, wasted: wasted, bpsIn: bpsIn, bpsS: bpr,
          bits: bits, partOrder: rz.po, params: rz.params, method: rz.method
        };
      }
    }

    /* ---- 6.5 LPC ---- */
    var maxP = Math.min(cfg.maxLpcOrder, n - 1, 32);
    if (maxP > 0 && n > maxP + 1) {
      // 归一化到 -1..1 再做自相关，避免 24bit 时 sum(x^2) 超出 double 精度
      var invScale = 1 / Math.pow(2, bpr - 1);
      var xn = sc.xn;
      for (i = 0; i < n; i++) xn[i] = work[i] * invScale;

      var ac = sc.ac;
      for (j = 0; j <= maxP; j++) {
        var s = 0;
        for (i = j; i < n; i++) s += xn[i] * xn[i - j];
        ac[j] = s;
      }

      if (ac[0] > 1e-30) {
        var coefs = sc.lpcCoef, errs = sc.lpcErr;
        var variants = cfg.lpcVariants < 1 ? 1 : (cfg.lpcVariants > 2 ? 2 : cfg.lpcVariants);
        var stride = 33;
        var candBuf = sc.lpcCand;          // 每个候选的实数系数（按 stride 存放）
        var candV = [], candP = [], candE = [];
        var kVar, pBest, sh, j2, dj, errExtra, estEff, ms, sig2e;

        for (kVar = 0; kVar < variants; kVar++) {
          if (kVar === 1) {
            // 去偏自相关：r[k] * n/(n-k)，抵消有限窗长导致的三角窗加权。
            // 对纯音/强周期信号能显著提高系数精度；宽带信号最多少赚，不会变差
            //（候选之间按真实比特数择优）。
            for (j = 1; j <= maxP; j++) ac[j] *= n / (n - j);
          }

          levinson(ac, maxP, n, bpr, sc);

          for (p = 1; p <= maxP; p++) {
            var cSrc = coefs.subarray((p - 1) * maxP, (p - 1) * maxP + p);
            ms = maxFeasibleShift(cSrc, p, cfg.lpcPrecision, sc.lpcQ2);
            if (ms < 0) continue;

            // 关键：估计里必须计入"系数量化误差"。
            // 纯音这类高可预测信号，理论预测误差接近 0，此时量化误差反而主导，
            // 不建模就会错误地偏向高阶预测器。
            quantizeLpcAt(cSrc, p, cfg.lpcPrecision, sc.lpcQ2, ms);
            var invQ = INV_POW2[ms];
            var delta = sc.lpcDelta;
            for (j2 = 0; j2 < p; j2++) delta[j2] = cSrc[j2] - sc.lpcQ2[j2] * invQ;
            errExtra = 0;
            for (j2 = 0; j2 < p; j2++) {
              dj = delta[j2];
              if (dj === 0) continue;
              for (var k2 = 0; k2 < p; k2++) {
                errExtra += dj * delta[k2] * ac[k2 > j2 ? k2 - j2 : j2 - k2];
              }
            }
            if (!(errExtra > 0)) errExtra = 0;

            sig2e = (errs[p] + errExtra) / (n - p);
            if (!(sig2e > 1e-30)) sig2e = 1e-30;
            estEff = (n - p) * (0.5 * log2(sig2e) + 2.05) +
                     p * bpr + 17 + p * cfg.lpcPrecision;

            var ci2 = candE.length;
            for (j2 = 0; j2 < p; j2++) candBuf[ci2 * stride + j2] = cSrc[j2];
            candV.push(kVar); candP.push(p); candE.push(estEff);
          }
        }

        // 按估计取最好的 2~3 个候选做精确评估（完整残差 + Rice 代价）
        var nC = candE.length;
        if (nC > 0) {
          var idxs = [];
          for (j = 0; j < nC; j++) idxs.push(j);
          idxs.sort(function (x, y) { return candE[x] - candE[y]; });
          var take = Math.min(cfg.lpcEvals, nC);

          for (var ei = 0; ei < take; ei++) {
            var ci = idxs[ei];
            pBest = candP[ci];
            var cc = candBuf.subarray(ci * stride, ci * stride + pBest);

            var mxs = maxFeasibleShift(cc, pBest, cfg.lpcPrecision, sc.lpcQ2);
            if (mxs < 0) continue;

            // shift 越大系数分辨率越高，但舍入落点有偶然性；用一小段样本代理打分，
            // 在最大可行 shift 附近挑一个实际残差最小的（对纯音影响很大）。
            var bestSh = -1, bestProxy = Infinity;
            for (sh = mxs; sh >= 0 && sh >= mxs - 4; sh--) {
              if (!quantizeLpcAt(cc, pBest, cfg.lpcPrecision, sc.lpcQ2, sh)) continue;
              var proxy = proxyResidualCost(work, n, pBest, sc.lpcQ2, sh, LPC_PROXY_SAMPLES);
              if (proxy < bestProxy) { bestProxy = proxy; bestSh = sh; }
            }
            if (bestSh < 0) continue;
            if (!quantizeLpcAt(cc, pBest, cfg.lpcPrecision, sc.lpcQ, bestSh)) continue;

            var maxAbs = lpcResidual(work, n, pBest, sc.lpcQ, bestSh, sc.resid);
            if (maxAbs >= MAX_RESID) continue;      // 残差越界 → 丢弃该候选
            var rz2 = riceAnalyze(sc.resid, 0, n - pBest, n, pBest, cfg.maxPo, sc);
            var bt = baseBits + pBest * bpr + 4 + 5 + pBest * cfg.lpcPrecision + rz2.bits;
            if (bt < best.bits) {
              best = {
                type: 3, order: pBest, wasted: wasted, bpsIn: bpsIn, bpsS: bpr,
                bits: bt, partOrder: rz2.po, params: rz2.params, method: rz2.method,
                shift: bestSh, precision: cfg.lpcPrecision,
                coeffs: sc.lpcQ.slice(0, pBest)
              };
            }
          }
        }
      }
    }

    return best;
  }

  /**
   * Levinson-Durbin 递推：由自相关序列一次求出 1..maxP 每一阶的最优预测系数。
   * 结果写入 sc.lpcCoef（第 p 阶系数占 [ (p-1)*maxP, (p-1)*maxP+p )），
   * 预测误差写入 sc.lpcErr，估计比特数写入 sc.lpcEst。
   */
  function levinson(ac, maxP, n, bpr, sc) {
    var a = sc.lpcA, tmp = sc.lpcTmp, errs = sc.lpcErr, coefs = sc.lpcCoef, est = sc.lpcEst;
    var p, j, kk, sig2;
    var err = ac[0];
    errs[0] = err;
    for (p = 1; p <= maxP; p++) {
      kk = ac[p];
      for (j = 0; j < p - 1; j++) kk -= a[j] * ac[p - j - 1];
      if (err > 1e-30) kk /= err; else kk = 0;
      if (kk > 0.999999) kk = 0.999999;
      if (kk < -0.999999) kk = -0.999999;
      for (j = 0; j < p - 1; j++) tmp[j] = a[j] - kk * a[p - 2 - j];
      tmp[p - 1] = kk;
      for (j = 0; j < p; j++) a[j] = tmp[j];
      err = err * (1 - kk * kk);
      if (!(err > 1e-30)) err = 1e-30;
      errs[p] = err;
      for (j = 0; j < p; j++) coefs[(p - 1) * maxP + j] = a[j];

      // 粗略估算该阶需要的比特数（高斯熵 + 逐项开销），只用来挑候选阶
      sig2 = err / (n - p);
      if (!(sig2 > 1e-30)) sig2 = 1e-30;
      est[p] = (n - p) * (0.5 * log2(sig2) + 2.05) + p * bpr + 17 + p * 15;
    }
  }

  /**
   * 把实数 LPC 系数在指定 shift 下量化成 precision 位有符号整数。
   * 采用误差反馈舍入（把上一个系数的舍入误差带到下一个），比逐个四舍五入更准。
   * 任一系数超出 precision 位有符号范围则返回 false。
   */
  function quantizeLpcAt(lpc, order, precision, out, shift) {
    var maxq = (1 << (precision - 1)) - 1;
    var minq = -maxq - 1;
    var scale = Math.pow(2, shift);
    var errAcc = 0, i, q;
    for (i = 0; i < order; i++) {
      q = Math.round(lpc[i] * scale + errAcc);
      if (q > maxq || q < minq) return false;
      out[i] = q;
      errAcc += lpc[i] * scale - q;
    }
    return true;
  }

  // 求能容纳全部系数的最大 shift（shift 越大系数分辨率越高），无解返回 -1
  function maxFeasibleShift(lpc, order, precision, tmpQ) {
    for (var s = 15; s >= 0; s--) {
      if (quantizeLpcAt(lpc, order, precision, tmpQ, s)) return s;
    }
    return -1;
  }

  /**
   * 用前 limit 个样本给某个 (order, shift) 方案打个"便宜"的分，用来挑 shift。
   * 分数 = 平均折半残差，和 Rice 码长单调相关，但只有 O(limit*order) 的代价。
   */
  function proxyResidualCost(work, n, order, q, shift, limit) {
    var inv = INV_POW2[shift];
    var m = limit < (n - order) ? limit : (n - order);
    if (m <= 0) return Infinity;
    var s = 0, i, j, sum, r;
    for (i = 0; i < m; i++) {
      var idx = order + i;
      sum = 0;
      for (j = 0; j < order; j++) sum += q[j] * work[idx - 1 - j];
      r = work[idx] - Math.floor(sum * inv);
      s += r < 0 ? (-r * 2 - 1) : (r * 2);
    }
    return s / m;
  }

  /**
   * 用整数系数算 LPC 残差：resid[i] = work[order+i] - floor(sum/2^shift)。
   * 返回残差绝对值最大值（调用方据此判断是否越界）。
   */
  function lpcResidual(work, n, order, q, shift, out) {
    var inv = INV_POW2[shift];
    var maxAbs = 0, i, j, sum, pred, r, ar;
    for (i = order; i < n; i++) {
      sum = 0;
      for (j = 0; j < order; j++) sum += q[j] * work[i - 1 - j];
      pred = Math.floor(sum * inv);
      r = work[i] - pred;
      out[i - order] = r;
      ar = r < 0 ? -r : r;
      if (ar > maxAbs) maxAbs = ar;
    }
    return maxAbs;
  }

  /**
   * 分区 Rice 参数选择。
   *   src[start .. start+m-1]  残差（m = 块大小 - 预测阶数）
   *   n     块大小（含 warm-up）
   *   order 预测阶数（第一区要少 order 个样本）
   * 返回 {bits, po, params, method}
   */
  function riceAnalyze(src, start, m, n, order, maxPo, sc) {
    var i, p, k;
    var zz = sc.zz, ps = sc.ps;
    var s = 0;

    // 折半 + 前缀和（一次遍历）
    for (i = 0; i < m; i++) {
      var v = src[start + i];
      var u = v < 0 ? (-v * 2 - 1) : (v * 2);
      zz[i] = u;
      s += u;
      ps[i + 1] = s;
    }

    // 第一轮：用前缀和在 O(分区数) 内估算每个分区阶的总代价，挑最优 po
    var bestPo = 0, bestEst = Infinity;
    var poLimit = maxPo < 8 ? maxPo : 8;
    for (var po = 0; po <= poLimit; po++) {
      var nParts = 1 << po;
      if ((n % nParts) !== 0) continue;        // 规范要求整除
      var psize = n >> po;
      if (psize <= order) break;               // 每区样本数必须 > 阶数
      var est = 0, idx = 0;
      for (p = 0; p < nParts; p++) {
        var cnt = (p === 0) ? (psize - order) : psize;
        var sum = ps[idx + cnt] - ps[idx];
        var k0 = 0;
        if (cnt > 0 && sum > 0) {
          k0 = Math.floor(log2(sum / cnt));
          if (k0 < 0) k0 = 0;
          if (k0 > 30) k0 = 30;
        }
        est += cnt * (k0 + 1) + sum / (1 << k0) + 4;
        idx += cnt;
      }
      if (est < bestEst) { bestEst = est; bestPo = po; }
    }

    // 第二轮：对选中的 po 做精确参数选择（k 只可能在 log2(均值) 附近）
    var bn = 1 << bestPo;
    var bpsize = n >> bestPo;
    var params = sc.params;
    var total = 2 + 4;                         // method(2) + partition order(4)
    var maxK = 0;
    var idx2 = 0;
    for (p = 0; p < bn; p++) {
      var cnt2 = (p === 0) ? (bpsize - order) : bpsize;
      var sum2 = ps[idx2 + cnt2] - ps[idx2];
      var kc = 0;
      if (cnt2 > 0 && sum2 > 0) {
        kc = Math.floor(log2(sum2 / cnt2));
        if (kc < 0) kc = 0;
        if (kc > 30) kc = 30;
      }
      var lo = kc > 0 ? kc - 1 : 0;
      var hi = kc < 30 ? kc + 1 : 30;
      var bestK = kc, bestCost = Infinity;
      for (k = lo; k <= hi; k++) {
        var q = 0;
        for (i = 0; i < cnt2; i++) q += zz[idx2 + i] >> k;
        var c = q + cnt2 * (k + 1);
        if (c < bestCost) { bestCost = c; bestK = k; }
      }
      params[p] = bestK;
      total += bestCost;
      if (bestK > maxK) maxK = bestK;
      idx2 += cnt2;
    }

    var method = maxK > 14 ? 1 : 0;            // 参数放不下 4bit 就用 5bit
    total += bn * (method ? 5 : 4);

    return {
      bits: total,
      po: bestPo,
      method: method,
      params: params.slice(0, bn)
    };
  }

  /* =======================================================================
   * 7. 子帧写入
   * ======================================================================= */

  function writeSubframe(w, plan, samp, n, sc) {
    var i, p;
    var wasted = plan.wasted;
    var bpsS = plan.bpsS;
    var type = plan.type;
    var order = plan.order;
    var mask = (1 << bpsS) - 1;

    /* 子帧头：1 bit 0 + 6 bit 类型 + 1 bit wasted 标志 */
    w.writeBits(0, 1);
    if (type === 0)      w.writeBits(0x00, 6);                 // CONSTANT
    else if (type === 1) w.writeBits(0x01, 6);                 // VERBATIM
    else if (type === 2) w.writeBits(0x08 | order, 6);         // FIXED
    else                 w.writeBits(0x20 | (order - 1), 6);   // LPC
    if (wasted > 0) {
      w.writeBits(1, 1);
      w.writeUnary(wasted - 1);
    } else {
      w.writeBits(0, 1);
    }

    if (type === 0) {
      w.writeBits(plan.value & mask, bpsS);
      return;
    }

    if (type === 1) {
      if (wasted === 0) {
        for (i = 0; i < n; i++) w.writeBits(samp[i] & mask, bpsS);
      } else {
        for (i = 0; i < n; i++) w.writeBits((samp[i] >> wasted) & mask, bpsS);
      }
      return;
    }

    /* warm-up 样本原样写出 */
    if (wasted === 0) {
      for (i = 0; i < order; i++) w.writeBits(samp[i] & mask, bpsS);
    } else {
      for (i = 0; i < order; i++) w.writeBits((samp[i] >> wasted) & mask, bpsS);
    }

    var res, resOff;
    if (type === 2) {
      /* FIXED：重算差分 */
      var d = sc.diff;
      if (wasted === 0) {
        for (i = 0; i < n; i++) d[i] = samp[i];
      } else {
        for (i = 0; i < n; i++) d[i] = samp[i] >> wasted;
      }
      for (var o = 1; o <= order; o++) {
        for (i = n - 1; i >= o; i--) d[i] = d[i] - d[i - 1];
      }
      res = d;
      resOff = order;
    } else {
      /* LPC：写系数，再重算残差 */
      w.writeBits(plan.precision - 1, 4);
      w.writeBits(plan.shift, 5);
      var cmask = (1 << plan.precision) - 1;
      for (i = 0; i < order; i++) w.writeBits(plan.coeffs[i] & cmask, plan.precision);

      var work = sc.diff;
      if (wasted === 0) {
        for (i = 0; i < n; i++) work[i] = samp[i];
      } else {
        for (i = 0; i < n; i++) work[i] = samp[i] >> wasted;
      }
      lpcResidual(work, n, order, plan.coeffs, plan.shift, sc.resid);
      res = sc.resid;
      resOff = 0;
    }

    /* 残差：分区 Rice */
    var params = plan.params;
    var po = plan.partOrder;
    var method = plan.method;
    var paramBits = method ? 5 : 4;
    var nParts = 1 << po;
    var psize = n >> po;
    var idx = resOff;

    w.writeBits(method, 2);
    w.writeBits(po, 4);

    for (p = 0; p < nParts; p++) {
      var cnt = (p === 0) ? (psize - order) : psize;
      var k = params[p];
      w.writeBits(k, paramBits);
      if (k === 0) {
        for (i = 0; i < cnt; i++) {
          var v0 = res[idx + i];
          w.writeUnary(v0 < 0 ? (-v0 * 2 - 1) : (v0 * 2));
        }
      } else {
        var rmask = (1 << k) - 1;
        for (i = 0; i < cnt; i++) {
          var v = res[idx + i];
          var u = v < 0 ? (-v * 2 - 1) : (v * 2);
          var q = u >>> k;
          var r = u & rmask;
          // 常见情况：商很小，unary 1 和余数可以合并成一次写入
          if (q + 1 + k <= 25) {
            w.writeBits(((1 << k) | r) >>> 0, q + 1 + k);
          } else {
            w.writeZeros(q);
            w.writeBits(1, 1);
            w.writeBits(r, k);
          }
        }
      }
      idx += cnt;
    }
  }

  /* =======================================================================
   * 8. 帧头写入
   * ======================================================================= */

  // block size -> 4bit 编码
  function blockSizeCode(n) {
    if (n === 192) return { code: 1, extra: 0, bits: 0 };
    if (n === 576 || n === 1152 || n === 2304 || n === 4608) {
      return { code: Math.round(log2(n / 144)), extra: 0, bits: 0 };
    }
    if (n >= 256 && (n & (n - 1)) === 0 && n <= 32768) {
      return { code: Math.round(log2(n)), extra: 0, bits: 0 };
    }
    if (n <= 256) return { code: 6, extra: n - 1, bits: 8 };
    return { code: 7, extra: n - 1, bits: 16 };
  }

  // 采样率 -> 4bit 编码
  function sampleRateCode(sr) {
    switch (sr) {
      case 88200:  return { code: 1, extra: 0, bits: 0 };
      case 176400: return { code: 2, extra: 0, bits: 0 };
      case 192000: return { code: 3, extra: 0, bits: 0 };
      case 8000:   return { code: 4, extra: 0, bits: 0 };
      case 16000:  return { code: 5, extra: 0, bits: 0 };
      case 22050:  return { code: 6, extra: 0, bits: 0 };
      case 24000:  return { code: 7, extra: 0, bits: 0 };
      case 32000:  return { code: 8, extra: 0, bits: 0 };
      case 44100:  return { code: 9, extra: 0, bits: 0 };
      case 48000:  return { code: 10, extra: 0, bits: 0 };
      case 96000:  return { code: 11, extra: 0, bits: 0 };
      default: break;
    }
    if (sr > 0 && sr <= 65535) return { code: 13, extra: sr, bits: 16 };
    if (sr > 0 && sr <= 655350 && (sr % 10) === 0) {
      return { code: 14, extra: sr / 10, bits: 16 };
    }
    return { code: 0, extra: 0, bits: 0 };  // 回落到 STREAMINFO 里的采样率
  }

  // 帧号用 UTF-8 变长编码（FLAC 扩展版，最多 7 字节 / 36bit）
  function writeUtf8Number(w, v) {
    if (v < 0x80) {
      w.writeByte(v);
    } else if (v < 0x800) {
      w.writeByte(0xC0 | (v >> 6));
      w.writeByte(0x80 | (v & 0x3F));
    } else if (v < 0x10000) {
      w.writeByte(0xE0 | (v >> 12));
      w.writeByte(0x80 | ((v >> 6) & 0x3F));
      w.writeByte(0x80 | (v & 0x3F));
    } else if (v < 0x200000) {
      w.writeByte(0xF0 | (v >> 18));
      w.writeByte(0x80 | ((v >> 12) & 0x3F));
      w.writeByte(0x80 | ((v >> 6) & 0x3F));
      w.writeByte(0x80 | (v & 0x3F));
    } else if (v < 0x4000000) {
      w.writeByte(0xF8 | (v >> 24));
      w.writeByte(0x80 | ((v >> 18) & 0x3F));
      w.writeByte(0x80 | ((v >> 12) & 0x3F));
      w.writeByte(0x80 | ((v >> 6) & 0x3F));
      w.writeByte(0x80 | (v & 0x3F));
    } else {
      w.writeByte(0xFC | (v >> 30));
      w.writeByte(0x80 | ((v >> 24) & 0x3F));
      w.writeByte(0x80 | ((v >> 18) & 0x3F));
      w.writeByte(0x80 | ((v >> 12) & 0x3F));
      w.writeByte(0x80 | ((v >> 6) & 0x3F));
      w.writeByte(0x80 | (v & 0x3F));
    }
  }

  /**
   * 写帧头（必须字节对齐开始 / 结束）。
   * blocking strategy = 0（定长块），所以写的是帧号。
   */
  function writeFrameHeader(w, cfg, frameIdx, n, chanAssign, bps) {
    var startPos = w.pos;

    w.writeByte(0xFF);
    w.writeByte(0xF8);                 // 11111000: 同步码高 6 位 + 保留 0 + blocking 0

    var bs = blockSizeCode(n);
    var sr = sampleRateCode(cfg.sampleRate);

    w.writeByte((bs.code << 4) | sr.code);
    // 第 4 字节：channel assignment(4) + sample size(3) + 保留(1=0)
    var bpsCode = (bps === 16) ? 4 : 6;   // 0b100=16bit, 0b110=24bit
    w.writeByte((chanAssign << 4) | (bpsCode << 1));

    writeUtf8Number(w, frameIdx);

    if (bs.bits === 8) {
      w.writeByte(bs.extra & 0xFF);
    } else if (bs.bits === 16) {
      w.writeByte((bs.extra >> 8) & 0xFF);
      w.writeByte(bs.extra & 0xFF);
    }

    if (sr.bits === 8) {
      w.writeByte(sr.extra & 0xFF);
    } else if (sr.bits === 16) {
      w.writeByte((sr.extra >> 8) & 0xFF);
      w.writeByte(sr.extra & 0xFF);
    }

    // 帧头 CRC-8
    var crc = 0, i;
    for (i = startPos; i < w.pos; i++) crc = CRC8_TABLE[crc ^ w.buf[i]];
    w.writeByte(crc);
  }

  /* =======================================================================
   * 9. 主编码流程
   * ======================================================================= */

  // compression 等级 -> 具体策略
  var LEVEL_MAXPO       = [0, 1, 2, 3, 4, 5, 6, 6, 6];
  var LEVEL_MAXFIXED    = [1, 2, 3, 4, 4, 4, 4, 4, 4];
  var LEVEL_USE_LPC     = [0, 0, 0, 1, 1, 1, 1, 1, 1];
  var LEVEL_LPC_VARIANTS = [1, 1, 1, 1, 2, 2, 2, 2, 2];

  // 挑 LPC shift 时用于打分的前导样本数（越小越快，越大越准）
  var LPC_PROXY_SAMPLES = 1024;

  function buildCfg(opts) {
    opts = opts || {};

    var bitDepth = (opts.bitDepth === 24) ? 24 : 16;

    var blockSize = opts.blockSize === undefined ? 4096 : Math.round(opts.blockSize);
    if (!(blockSize >= 16)) blockSize = 4096;
    if (blockSize > 65535) blockSize = 65535;

    var maxLpcOrder = opts.maxLpcOrder === undefined ? 8 : Math.round(opts.maxLpcOrder);
    if (!(maxLpcOrder >= 0)) maxLpcOrder = 0;
    if (maxLpcOrder > 32) maxLpcOrder = 32;

    var level = opts.compression === undefined ? 5 : Math.round(opts.compression);
    if (!(level >= 0)) level = 0;
    if (level > 8) level = 8;

    var useLpc = LEVEL_USE_LPC[level] === 1 && maxLpcOrder > 0;

    return {
      bitDepth: bitDepth,
      blockSize: blockSize,
      maxLpcOrder: useLpc ? maxLpcOrder : 0,
      maxFixedOrder: Math.min(4, LEVEL_MAXFIXED[level]),
      maxPo: LEVEL_MAXPO[level],
      lpcCandidates: LEVEL_LPC_VARIANTS[level],
      lpcVariants: LEVEL_LPC_VARIANTS[level],
      lpcEvals: level >= 7 ? 3 : 2,
      lpcPrecision: 15,          // 4bit 字段存 precision-1，最大值 15
      sampleRate: 0,
      level: level
    };
  }

  // Float32 -> 整数 PCM（encode 内部与 pcmFromFloat 共用，保证逐位一致）
  function quantizeChannel(src, dst, off, n, scale, maxV, minV) {
    var i, v;
    for (i = 0; i < n; i++) {
      v = Math.round(src[off + i] * scale);
      if (v > maxV) v = maxV;
      else if (v < minV) v = minV;
      dst[i] = v;
    }
  }

  function pcmFromFloat(channels, bitDepth) {
    var nch = channels.length;
    var n = channels[0].length;
    var bd = bitDepth === 24 ? 24 : 16;
    var scale = bd === 16 ? 32768 : 8388608;
    var maxV = scale - 1;
    var minV = -scale;
    var out = [];
    for (var c = 0; c < nch; c++) {
      var dst = new Int32Array(n);
      quantizeChannel(channels[c], dst, 0, n, scale, maxV, minV);
      out.push(dst);
    }
    return out;
  }

  function encodeImpl(channels, sampleRate, opts) {
    /* ---------- 参数校验 ---------- */
    if (!channels || !channels.length) {
      throw new Error('FlacEncoder: channels 不能为空');
    }
    var nch = channels.length;
    if (nch > 8) throw new Error('FlacEncoder: 最多支持 8 声道，收到 ' + nch);

    var totalSamples = channels[0].length;
    for (var c = 1; c < nch; c++) {
      if (channels[c].length !== totalSamples) {
        throw new Error('FlacEncoder: 各声道样本数必须一致');
      }
    }
    if (!(sampleRate > 0)) throw new Error('FlacEncoder: sampleRate 必须 > 0');
    if (sampleRate >= 1048576) throw new Error('FlacEncoder: sampleRate 超出 20bit 可表示范围');
    if (totalSamples >= 68719476736) throw new Error('FlacEncoder: 样本数超出 36bit');
    if (totalSamples === 0) throw new Error('FlacEncoder: 样本数为 0');

    var cfg = buildCfg(opts);
    cfg.sampleRate = Math.round(sampleRate);

    var bps = cfg.bitDepth;
    var bytesPerSample = bps >> 3;             // 2 或 3
    var scale = bps === 16 ? 32768 : 8388608;
    var maxV = scale - 1;
    var minV = -scale;

    var blockSize = cfg.blockSize;
    if (blockSize > totalSamples) blockSize = Math.min(65535, totalSamples);

    var sc = new Scratch(blockSize, Math.max(8, cfg.maxLpcOrder), Math.max(6, cfg.maxPo));

    /* ---------- 每声道的整块样本缓冲 ---------- */
    var chSamp = [];
    for (c = 0; c < nch; c++) chSamp.push(new Int32Array(blockSize));
    var chMid = null, chSide = null;
    if (nch === 2) {
      chMid = new Int32Array(blockSize);
      chSide = new Int32Array(blockSize);
    }

    /* ---------- 1) 先算未编码 PCM 的 MD5（分块喂，避免构造超大中间数组） ---------- */
    var md5 = md5New();
    var mdChunkSamples = 4096;
    var mdBytes = new Uint8Array(mdChunkSamples * nch * bytesPerSample);
    var mdTmp = new Int32Array(mdChunkSamples);
    var off, cnt2, bi, k2, v2;

    for (off = 0; off < totalSamples; off += mdChunkSamples) {
      cnt2 = Math.min(mdChunkSamples, totalSamples - off);
      bi = 0;
      for (var si = 0; si < cnt2; si++) {
        for (c = 0; c < nch; c++) {
          v2 = Math.round(channels[c][off + si] * scale);
          if (v2 > maxV) v2 = maxV;
          else if (v2 < minV) v2 = minV;
          if (bytesPerSample === 3) {
            mdBytes[bi++] = v2 & 0xFF;
            mdBytes[bi++] = (v2 >> 8) & 0xFF;
            mdBytes[bi++] = (v2 >> 16) & 0xFF;
          } else {
            mdBytes[bi++] = v2 & 0xFF;
            mdBytes[bi++] = (v2 >> 8) & 0xFF;
          }
        }
      }
      md5Update(md5, mdBytes, 0, bi);
    }
    var md5Digest = md5Final(md5);

    /* ---------- 2) 输出缓冲 + 元数据 ---------- */
    var estBytes = 256 + Math.ceil(totalSamples * nch * bytesPerSample * 0.75) + 4096;
    var w = new ByteWriter(Math.max(262144, estBytes));

    // "fLaC"
    w.writeByte(0x66); w.writeByte(0x4C); w.writeByte(0x61); w.writeByte(0x43);

    // STREAMINFO 头（type 0，非最后块，长度 34）
    w.writeByte(0x00); w.writeByte(0x00); w.writeByte(0x00); w.writeByte(34);
    var siOff = w.pos;
    for (var z = 0; z < 34; z++) w.writeByte(0);

    // VORBIS_COMMENT（最后一块，type 4）
    var vendorBytes = new Uint8Array(VENDOR.length);
    for (var vi = 0; vi < VENDOR.length; vi++) vendorBytes[vi] = VENDOR.charCodeAt(vi) & 0xFF;
    var vcLen = 4 + vendorBytes.length + 4;
    w.writeByte(0x80 | 4);
    w.writeByte((vcLen >> 16) & 0xFF);
    w.writeByte((vcLen >> 8) & 0xFF);
    w.writeByte(vcLen & 0xFF);
    // vendor 长度（小端）
    w.writeByte(vendorBytes.length & 0xFF);
    w.writeByte((vendorBytes.length >> 8) & 0xFF);
    w.writeByte((vendorBytes.length >> 16) & 0xFF);
    w.writeByte((vendorBytes.length >> 24) & 0xFF);
    for (vi = 0; vi < vendorBytes.length; vi++) w.writeByte(vendorBytes[vi]);
    // 注释条数 = 0（小端）
    w.writeByte(0); w.writeByte(0); w.writeByte(0); w.writeByte(0);

    /* ---------- 3) 逐帧编码 ---------- */
    var minFrameSize = 0xFFFFFF;
    var maxFrameSize = 0;
    var frameIdx = 0;
    var frameStart, n, i, p;

    var plans = new Array(nch);
    var pbuf  = new Array(nch);
    var pbps  = new Array(nch);

    for (var s0 = 0; s0 < totalSamples; s0 += blockSize, frameIdx++) {
      n = Math.min(blockSize, totalSamples - s0);

      // 取本块样本并量化
      for (c = 0; c < nch; c++) {
        quantizeChannel(channels[c], chSamp[c], s0, n, scale, maxV, minV);
      }

      /* ----- 选择声道分配方式 ----- */
      var assign;
      if (nch === 1) {
        assign = 0;
        plans[0] = analyzeSubframe(chSamp[0], n, bps, cfg, sc);
        pbuf[0] = chSamp[0]; pbps[0] = bps;
      } else if (nch === 2) {
        var pL = analyzeSubframe(chSamp[0], n, bps, cfg, sc);
        var pR = analyzeSubframe(chSamp[1], n, bps, cfg, sc);
        // mid = (L+R)>>1, side = L-R
        var L = chSamp[0], R = chSamp[1], M = chMid, S = chSide;
        for (i = 0; i < n; i++) {
          var lv = L[i], rv = R[i];
          M[i] = (lv + rv) >> 1;
          S[i] = lv - rv;
        }
        var pM = analyzeSubframe(M, n, bps, cfg, sc);
        var pS = analyzeSubframe(S, n, bps + 1, cfg, sc);

        var cIndep = pL.bits + pR.bits;
        var cLS    = pL.bits + pS.bits;
        var cRS    = pS.bits + pR.bits;
        var cMS    = pM.bits + pS.bits;

        var minC = cIndep;
        assign = 1;
        plans[0] = pL; plans[1] = pR;
        pbuf[0] = L; pbuf[1] = R; pbps[0] = bps; pbps[1] = bps;

        if (cLS < minC) {
          minC = cLS; assign = 8;
          plans[0] = pL; plans[1] = pS;
          pbuf[0] = L; pbuf[1] = S; pbps[0] = bps; pbps[1] = bps + 1;
        }
        if (cRS < minC) {
          minC = cRS; assign = 9;
          plans[0] = pS; plans[1] = pR;
          pbuf[0] = S; pbuf[1] = R; pbps[0] = bps + 1; pbps[1] = bps;
        }
        if (cMS < minC) {
          minC = cMS; assign = 10;
          plans[0] = pM; plans[1] = pS;
          pbuf[0] = M; pbuf[1] = S; pbps[0] = bps; pbps[1] = bps + 1;
        }
      } else {
        // 3~8 声道：FLAC 只允许 independent
        assign = nch - 1;
        for (c = 0; c < nch; c++) {
          plans[c] = analyzeSubframe(chSamp[c], n, bps, cfg, sc);
          pbuf[c] = chSamp[c];
          pbps[c] = bps;
        }
      }

      /* ----- 写帧 ----- */
      frameStart = w.pos;
      writeFrameHeader(w, cfg, frameIdx, n, assign, bps);
      for (c = 0; c < nch; c++) {
        writeSubframe(w, plans[c], pbuf[c], n, sc);
      }
      w.alignByte();

      // 帧尾 CRC-16
      var crc = 0;
      for (i = frameStart; i < w.pos; i++) {
        crc = (crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ w.buf[i]) & 0xFF];
      }
      crc &= 0xFFFF;
      w.writeByte((crc >> 8) & 0xFF);
      w.writeByte(crc & 0xFF);

      var fLen = w.pos - frameStart;
      if (fLen < minFrameSize) minFrameSize = fLen;
      if (fLen > maxFrameSize) maxFrameSize = fLen;
    }

    /* ---------- 4) 回填 STREAMINFO ---------- */
    var minBlock, maxBlock;
    if (frameIdx <= 1) {
      // 只有一帧：它就是"最后一帧"，不参与 min/max 约束
      var only = totalSamples < 16 ? 16 : totalSamples;
      minBlock = only > 65535 ? 65535 : only;
      maxBlock = minBlock;
    } else {
      minBlock = blockSize > 65535 ? 65535 : blockSize;
      maxBlock = minBlock;
    }
    if (minBlock < 16) minBlock = 16;
    if (maxBlock < 16) maxBlock = 16;

    var b = w.buf;
    b[siOff]     = (minBlock >> 8) & 0xFF;
    b[siOff + 1] = minBlock & 0xFF;
    b[siOff + 2] = (maxBlock >> 8) & 0xFF;
    b[siOff + 3] = maxBlock & 0xFF;
    b[siOff + 4] = (minFrameSize >> 16) & 0xFF;
    b[siOff + 5] = (minFrameSize >> 8) & 0xFF;
    b[siOff + 6] = minFrameSize & 0xFF;
    b[siOff + 7] = (maxFrameSize >> 16) & 0xFF;
    b[siOff + 8] = (maxFrameSize >> 8) & 0xFF;
    b[siOff + 9] = maxFrameSize & 0xFF;

    var sr = cfg.sampleRate;
    b[siOff + 10] = (sr >> 12) & 0xFF;
    b[siOff + 11] = (sr >> 4) & 0xFF;
    b[siOff + 12] = ((sr & 0x0F) << 4) | (((nch - 1) & 0x07) << 1) | (((bps - 1) >> 4) & 0x01);
    b[siOff + 13] = (((bps - 1) & 0x0F) << 4) | ((totalSamples >= 4294967296 ? Math.floor(totalSamples / 4294967296) : 0) & 0x0F);
    b[siOff + 14] = (totalSamples >>> 24) & 0xFF;
    b[siOff + 15] = (totalSamples >>> 16) & 0xFF;
    b[siOff + 16] = (totalSamples >>> 8) & 0xFF;
    b[siOff + 17] = totalSamples & 0xFF;

    for (i = 0; i < 16; i++) b[siOff + 18 + i] = md5Digest[i];

    return w.buf.slice(0, w.pos);
  }

  /* =======================================================================
   * 10. 导出
   * ======================================================================= */

  var FlacEncoder = {
    version: VERSION,
    /** 主 API：编码成完整 .flac 文件字节流 */
    encode: function (channels, sampleRate, opts) {
      return encodeImpl(channels, sampleRate, opts);
    },
    /** 辅助 API：按 encode 的内部规则把 Float32 量化成整数 PCM */
    pcmFromFloat: pcmFromFloat
  };

  root.FlacEncoder = FlacEncoder;

  if (typeof module === 'object' && module && module.exports) {
    module.exports = FlacEncoder;
  }

})(typeof globalThis !== 'undefined' ? globalThis
  : typeof self !== 'undefined' ? self
  : typeof window !== 'undefined' ? window
  : this);
