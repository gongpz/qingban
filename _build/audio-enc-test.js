#!/usr/bin/env node
/*!
 * audio-enc-test.js — AudioEnc（audio-encoders.js）的 Node 端测试脚本
 * ---------------------------------------------------------------------------
 * 运行:
 *   node audio-enc-test.js
 *   （可选环境变量 AUDIO_ENC_PYTHON 指定 Python 解释器路径）
 *
 * 做什么:
 *   1) 用 vm 造一个“伪造 window”的浏览器环境，先加载 lib/lame.min.js，再加载
 *      audio-encoders.js（与 file:// 下的加载顺序一致），取出 globalThis.AudioEnc。
 *   2) WAV: JS 侧校验 RIFF 头字段 + 用 Python soundfile 解码后与期望整数逐采样比对。
 *   3) MP3: JS 侧解析 MPEG 帧头（版本/比特率/采样率/声道/帧长）+ Python soundfile
 *      解码得到时长/采样率/声道/与 440Hz 正弦的相关度。
 *   4) AAC/OGG: Node 无 WebCodecs，故
 *        a. 结构自检——用已知帧驱动 muxer，逐字段校验 ADTS 头 / Ogg 页 CRC / 分页 /
 *           granule / OpusHead / OpusTags（JS 与 Python 两套独立实现交叉验证 CRC）。
 *        b. 全链路——注入伪 AudioEncoder（喂入 PyAV(libopus/ffmpeg) 真实编码出的裸帧），
 *           跑通 AudioEnc.aac / AudioEnc.oggOpus 的完整流程，再用 PyAV 解码比对时长与波形。
 *   5) 打印逐项结果表，失败则退出码 1。
 *
 * 依赖: Python + numpy + soundfile + PyAV（仅测试用；缺失时相关项标记 SKIP）。
 * 本脚本是测试工具，允许使用 Node API；被测模块自身不含任何 Node 依赖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

/* ======================================================================== */
/* 0. 环境与路径                                                            */
/* ======================================================================== */

const BUILD_DIR = __dirname;
const LIB_DIR = path.join(BUILD_DIR, 'lib');
const TMP_DIR = path.join(BUILD_DIR, 'tmp');
const MOD_PATH = path.join(BUILD_DIR, 'audio-encoders.js');
const LAME_PATH = path.join(LIB_DIR, 'lame.min.js');
const PROBE_PATH = path.join(TMP_DIR, '_audio_probe.py');

const PYTHON = process.env.AUDIO_ENC_PYTHON ||
    'C:\\Users\\Mask\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

/* Python 分析探针（运行时写入 tmp/_audio_probe.py；见文件头说明） */
const PROBE_PY = String.raw`# -*- coding: utf-8 -*-
"""音频测试分析探针（供 audio-enc-test.js 调用）。

子命令:
  pcmcheck <wav> <rawf32> <ch> <bits> <isfloat>
  stats    <file> <freq> <amp>
  aacref   <framesBin> <jsonOut> <adtsOut> <sr> <ch> <freq> <amp> <dur>
  opusref  <framesBin> <jsonOut> <sr> <ch> <freq> <amp> <dur>
  oggcheck <file>
  decode   <file> <freq> <amp>
  compare  <fileA> <fileB>
所有结果以一行 "##JSON##{...}" 输出。
"""
import sys
import os
import io
import json
import struct

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import numpy as np


def emit(obj):
    sys.stdout.write("##JSON##" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(msg):
    emit({"ok": False, "error": msg})
    sys.exit(0)


# ---------------------------------------------------------------- 基础工具
def ncc(a, b):
    a = a - a.mean()
    b = b - b.mean()
    den = float(np.sqrt(np.dot(a, a) * np.dot(b, b))) + 1e-20
    return float(np.dot(a, b) / den)


def corr_stats(x, sr, freq, amp):
    """x: 单声道 float64；返回与解析参考正弦的相关性（含整数 lag 搜索）"""
    n = len(x)
    t = np.arange(n) / float(sr)
    ref = amp * np.sin(2 * np.pi * freq * t)
    trim = max(1, min(int(0.05 * sr), n // 10))
    L = int(0.08 * sr)
    if n - 2 * (trim + L) < 200:
        L = max(0, (n - 2 * trim - 200) // 2)
    i0 = trim + L
    m = n - 2 * (trim + L)
    if m < 100:
        return {"corr0": None, "corrBest": None, "lag": None, "window": m, "note": "音频过短"}
    a = x[i0:i0 + m]
    best = (-2.0, 0)
    for lag in range(-L, L + 1):
        j0 = i0 + lag
        if j0 < 0 or j0 + m > n:
            continue
        c = ncc(a, ref[j0:j0 + m])
        if c > best[0]:
            best = (c, lag)
    c0 = ncc(a, ref[i0:i0 + m])
    return {"corr0": c0, "corrBest": best[0], "lag": int(best[1]), "window": int(m)}


def extend_stats(x, sr):
    """有效信号区间（相对峰值 5% 阈值），用于剔除编码器延迟/填充造成的静音。"""
    if not x.size:
        return {}
    peak = float(np.max(np.abs(x)))
    if peak <= 0:
        return {}
    idx = np.where(np.abs(x) > 0.05 * peak)[0]
    if not len(idx):
        return {}
    return {
        "signalStart": int(idx[0]),
        "signalEnd": int(idx[-1]),
        "signalDuration": float((idx[-1] - idx[0] + 1) / float(sr)),
        "signalFrames": int(idx[-1] - idx[0] + 1),
    }


def decode_any(path, prefer="soundfile"):
    """返回 (data[frames, ch] float64, sr, decoder, subtype)"""
    errs = []
    order = ["soundfile", "pyav"] if prefer == "soundfile" else ["pyav", "soundfile"]
    for how in order:
        try:
            if how == "soundfile":
                import soundfile as sf
                d, sr = sf.read(path, dtype="float64", always_2d=True)
                info = sf.info(path)
                return d, int(sr), "soundfile", info.subtype
            else:
                import av
                c = av.open(path)
                s = c.streams.audio[0]
                arrs = [f.to_ndarray() for f in c.decode(s)]
                if not arrs:
                    raise RuntimeError("no frames")
                d = np.concatenate(arrs, axis=1).T.astype(np.float64)
                return d, int(s.codec_context.sample_rate), "pyav", None
        except Exception as e:
            errs.append("%s: %s" % (how, e))
    raise RuntimeError("decode failed: " + " | ".join(errs))


def write_lp(path, blobs):
    with open(path, "wb") as f:
        for b in blobs:
            f.write(struct.pack("<I", len(b)))
            f.write(b)


def read_lp(path):
    data = open(path, "rb").read()
    out = []
    i = 0
    while i + 4 <= len(data):
        n = struct.unpack("<I", data[i:i + 4])[0]
        i += 4
        out.append(data[i:i + n])
        i += n
    return out


def sine(sr, ch, freq, amp, dur):
    n = int(round(sr * dur))
    t = np.arange(n) / float(sr)
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([x] * ch, axis=0)  # (ch, n) planar


# ---------------------------------------------------------------- 子命令
def cmd_pcmcheck(argv):
    wav_path, raw_path, ch, bits, isfloat = argv[0], argv[1], int(argv[2]), int(argv[3]), int(argv[4])
    src = np.fromfile(raw_path, dtype="<f4").reshape(-1, ch)
    res = {"rawFrames": int(src.shape[0]), "rawChannels": int(src.shape[1])}
    if isfloat:
        import soundfile as sf
        info = sf.info(wav_path)
        d, sr = sf.read(wav_path, dtype="float32", always_2d=True)
        exp = src.astype(np.float32)
        same = (d.shape == exp.shape) and bool(np.array_equal(d, exp))
        diff = float(np.max(np.abs(d.astype(np.float64) - exp.astype(np.float64)))) if d.shape == exp.shape else None
        res.update({"subtype": info.subtype, "exact": same, "maxAbsDiff": diff})
    elif bits == 16:
        import soundfile as sf
        info = sf.info(wav_path)
        d, sr = sf.read(wav_path, dtype="int16", always_2d=True)
        exp = np.clip(np.round(src.astype(np.float64) * 32768.0), -32768, 32767).astype(np.int16)
        same = (d.shape == exp.shape) and bool(np.array_equal(d, exp))
        diff = int(np.max(np.abs(d.astype(np.int32) - exp.astype(np.int32)))) if d.shape == exp.shape else None
        res.update({"subtype": info.subtype, "exact": same, "maxAbsDiff": diff, "scale": 32768})
    elif bits == 24:
        import soundfile as sf
        info = sf.info(wav_path)
        d, sr = sf.read(wav_path, dtype="int32", always_2d=True)
        e24 = np.clip(np.round(src.astype(np.float64) * 8388608.0), -8388608, 8388607).astype(np.int64)
        exp = (e24 << 8).astype(np.int32)  # libsndfile 把 24bit 左移 8 位写入 int32
        same = (d.shape == exp.shape) and bool(np.array_equal(d, exp))
        diff = int(np.max(np.abs(d.astype(np.int64) - exp.astype(np.int64)))) if d.shape == exp.shape else None
        res.update({"subtype": info.subtype, "exact": same, "maxAbsDiff": diff, "scale": 8388608})
    else:
        return fail("unsupported bits")
    import soundfile as sf
    info = sf.info(wav_path)
    res.update({
        "frames": int(info.frames),
        "channels": int(info.channels),
        "sampleRate": int(info.samplerate),
        "duration": float(info.duration),
        "format": info.format,
    })
    res["ok"] = True
    emit(res)


def cmd_stats(argv):
    path, freq, amp = argv[0], float(argv[1]), float(argv[2])
    try:
        d, sr, how, subtype = decode_any(path)
    except Exception as e:
        return fail(str(e))
    x = d.mean(axis=1)
    res = {
        "ok": True,
        "decoder": how,
        "subtype": subtype,
        "sampleRate": sr,
        "channels": int(d.shape[1]),
        "frames": int(d.shape[0]),
        "duration": float(d.shape[0] / float(sr)),
        "peak": float(np.max(np.abs(d))) if d.size else 0.0,
        "rms": float(np.sqrt(np.mean(x * x))) if x.size else 0.0,
    }
    res.update(extend_stats(x, sr))
    if freq > 0:
        res["corr"] = corr_stats(x, sr, freq, amp)
        # 分声道检查左右是否一致（立体声输入同信号时应一致）
        if d.shape[1] == 2:
            res["lrCorr"] = ncc(d[:, 0], d[:, 1])
    emit(res)


def parse_adts(d):
    i = 0
    frames = []
    while i + 7 <= len(d):
        if d[i] != 0xFF or (d[i + 1] & 0xF0) != 0xF0:
            raise RuntimeError("bad adts sync at %d" % i)
        prof = (d[i + 2] >> 6) & 0x3
        sfi = (d[i + 2] >> 2) & 0xF
        chc = ((d[i + 2] & 0x1) << 2) | ((d[i + 3] >> 6) & 0x3)
        flen = ((d[i + 3] & 0x3) << 11) | (d[i + 4] << 3) | ((d[i + 5] >> 5) & 0x7)
        prot = d[i + 1] & 0x1
        hdr = 7 if prot else 9
        frames.append({"profile": prof, "sfi": sfi, "chc": chc, "len": flen,
                       "payload": d[i + hdr:i + flen]})
        i += flen
    return frames


def cmd_aacref(argv):
    framesBin, jsonOut, adtsOut, sr, ch, freq, amp, dur = (
        argv[0], argv[1], argv[2], int(argv[3]), int(argv[4]), float(argv[5]), float(argv[6]), float(argv[7]))
    import av
    pcm = sine(sr, ch, freq, amp, dur)
    buf = io.BytesIO()
    out = av.open(buf, mode="w", format="adts")
    st = out.add_stream("aac", rate=sr)
    st.layout = "stereo" if ch == 2 else "mono"
    st.bit_rate = 128000
    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm), format="fltp", layout=st.layout)
    frame.sample_rate = sr
    frame.pts = 0
    for p in st.encode(frame):
        out.mux(p)
    for p in st.encode(None):
        out.mux(p)
    out.close()
    data = buf.getvalue()
    frames = parse_adts(data)
    open(adtsOut, "wb").write(data)
    write_lp(framesBin, [f["payload"] for f in frames])
    emit({"ok": True, "adtsBytes": len(data), "frameCount": len(frames),
          "lengths": [len(f["payload"]) for f in frames],
          "profile": frames[0]["profile"], "sfi": frames[0]["sfi"], "chc": frames[0]["chc"],
          "samples": len(frames) * 1024, "inputSamples": int(pcm.shape[1]),
          "sampleRate": sr, "channels": ch})
    _ = (jsonOut,)


def cmd_opusref(argv):
    framesBin, jsonOut, sr, ch, freq, amp, dur = (
        argv[0], argv[1], int(argv[2]), int(argv[3]), float(argv[4]), float(argv[5]), float(argv[6]))
    import av
    pcm = sine(sr, ch, freq, amp, dur)
    ost = None
    ob = io.BytesIO()
    oo = av.open(ob, mode="w", format="ogg")
    ost = oo.add_stream("libopus", rate=48000)
    ost.layout = "stereo" if ch == 2 else "mono"
    ost.bit_rate = 96000
    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm), format="fltp", layout=ost.layout)
    frame.sample_rate = 48000
    frame.pts = 0
    pkts = []
    for p in ost.encode(frame):
        pkts.append(bytes(p))
        oo.mux(p)
    for p in ost.encode(None):
        pkts.append(bytes(p))
        oo.mux(p)
    oo.close()
    write_lp(framesBin, pkts)
    emit({"ok": True, "packetCount": len(pkts), "lengths": [len(p) for p in pkts],
          "inputSamples": int(pcm.shape[1]), "sampleRate": 48000, "channels": ch,
          "oggBytes": len(ob.getvalue())})
    _ = jsonOut


def ogg_crc(page):
    crc = 0
    for b in page:
        crc ^= (b << 24) & 0xFFFFFFFF
        for _ in range(8):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
    return crc & 0xFFFFFFFF


def cmd_oggcheck(argv):
    data = open(argv[0], "rb").read()
    pages = []
    packets = []
    pending = b""  # 跨页未完成的包
    i = 0
    while i < len(data):
        if data[i:i + 4] != b"OggS":
            return fail("bad capture pattern at %d" % i)
        ver = data[i + 4]
        htype = data[i + 5]
        gran = struct.unpack("<Q", data[i + 6:i + 14])[0]
        serial = struct.unpack("<I", data[i + 14:i + 18])[0]
        seq = struct.unpack("<I", data[i + 18:i + 22])[0]
        crc_stored = struct.unpack("<I", data[i + 22:i + 26])[0]
        nseg = data[i + 26]
        seg = list(data[i + 27:i + 27 + nseg])
        body_len = sum(seg)
        total = 27 + nseg + body_len
        if i + total > len(data):
            return fail("truncated page seq=%d" % seq)
        page = bytearray(data[i:i + total])
        crc_page = bytearray(page)
        crc_page[22:26] = b"\x00\x00\x00\x00"
        crc_calc = ogg_crc(crc_page)
        if crc_calc != crc_stored:
            return fail("CRC mismatch page seq=%d stored=%08x calc=%08x" % (seq, crc_stored, crc_calc))
        body = data[i + 27 + nseg:i + total]
        j = 0
        page_pkts = []
        for s in seg:
            pending += body[j:j + s]
            j += s
            if s < 255:
                page_pkts.append(pending)
                pending = b""
        for pkt in page_pkts:
            packets.append(pkt)
        pages.append({"seq": seq, "type": htype, "granule": gran, "serial": serial,
                      "nseg": nseg, "bodyLen": body_len, "total": total, "crc": "%08x" % crc_stored,
                      "packets": [len(x) for x in page_pkts], "offset": i})
        i += total
    # 头部解析
    head = packets[0]
    tags = packets[1]
    h = {}
    if head[:8] == b"OpusHead":
        ver_, ch_ = head[8], head[9]
        preskip = struct.unpack("<H", head[10:12])[0]
        inrate = struct.unpack("<I", head[12:16])[0]
        gain = struct.unpack("<h", head[16:18])[0]
        fam = head[18]
        h = {"magic": "OpusHead", "version": ver_, "channels": ch_, "preSkip": preskip,
             "inputSampleRate": inrate, "gain": gain, "mappingFamily": fam, "len": len(head)}
    t = {}
    if tags[:8] == b"OpusTags":
        vlen = struct.unpack("<I", tags[8:12])[0]
        vendor = tags[12:12 + vlen].decode("utf-8", "replace")
        ncomments = struct.unpack("<I", tags[12 + vlen:16 + vlen])[0]
        t = {"magic": "OpusTags", "vendor": vendor, "comments": ncomments, "len": len(tags)}
    granules = [p["granule"] for p in pages]
    emit({"ok": True, "bytes": len(data), "pageCount": len(pages), "packetCount": len(packets),
          "pages": pages, "head": h, "tags": t,
          "granules": granules,
          "granuleMonotonic": all(granules[k] <= granules[k + 1] for k in range(len(granules) - 1)),
          "seqContiguous": [p["seq"] for p in pages] == list(range(len(pages))),
          "firstIsBos": pages[0]["type"] == 2,
          "lastIsEos": (pages[-1]["type"] & 4) == 4,
          "finalSamples": granules[-1] - (h.get("preSkip") or 0),
          "audioPacketBytes": sum(len(p) for p in packets[2:])})


def cmd_decode(argv):
    path, freq, amp = argv[0], float(argv[1]), float(argv[2])
    try:
        d, sr, how, subtype = decode_any(path, prefer="pyav")
    except Exception as e:
        return fail(str(e))
    x = d.mean(axis=1)
    res = {"ok": True, "decoder": how, "sampleRate": sr, "channels": int(d.shape[1]),
           "frames": int(d.shape[0]), "duration": float(d.shape[0] / float(sr)),
           "peak": float(np.max(np.abs(d))) if d.size else 0.0}
    res.update(extend_stats(x, sr))
    if freq > 0:
        res["corr"] = corr_stats(x, sr, freq, amp)
    emit(res)


def cmd_compare(argv):
    a, b = argv[0], argv[1]
    try:
        da, sra, _, _ = decode_any(a, prefer="pyav")
        db, srb, _, _ = decode_any(b, prefer="pyav")
    except Exception as e:
        return fail(str(e))
    n = min(len(da), len(db))
    diff = float(np.max(np.abs(da[:n] - db[:n]))) if n else None
    emit({"ok": True, "framesA": int(len(da)), "framesB": int(len(db)), "srA": sra, "srB": srb,
          "bitExact": bool(n == len(da) == len(db) and diff == 0.0),
          "maxAbsDiff": diff,
          "channelsA": int(da.shape[1]), "channelsB": int(db.shape[1])})


def main():
    if len(sys.argv) < 2:
        return fail("需要子命令")
    cmd = sys.argv[1]
    argv = sys.argv[2:]
    table = {
        "pcmcheck": cmd_pcmcheck, "stats": cmd_stats, "aacref": cmd_aacref,
        "opusref": cmd_opusref, "oggcheck": cmd_oggcheck, "decode": cmd_decode,
        "compare": cmd_compare,
    }
    if cmd not in table:
        return fail("未知子命令 " + cmd)
    try:
        table[cmd](argv)
    except Exception as e:
        import traceback
        return fail(type(e).__name__ + ": " + str(e) + " | " + traceback.format_exc().splitlines()[-1])


if __name__ == "__main__":
    main()
`;

/* ======================================================================== */
/* 1. 断言 / 结果收集                                                       */
/* ======================================================================== */

const results = [];
let current = null;

function assert(cond, msg) {
    if (!cond) {
        throw new Error(msg);
    }
}

function assertClose(actual, expected, tol, msg) {
    assert(Math.abs(actual - expected) <= tol,
        msg + '（实际 ' + actual + '，期望 ' + expected + ' ± ' + tol + '）');
}

function record(name, ok, detail, ms) {
    results.push({ name, ok, detail, ms: ms == null ? 0 : ms });
    const tag = ok === true ? 'PASS' : (ok === 'SKIP' ? 'SKIP' : 'FAIL');
    const pad = '                                        ';
    console.log('[' + String(results.length).padStart(2, ' ') + '] ' +
        (name + pad).slice(0, 40) + ' ' + tag + '  ' +
        String(ms == null ? 0 : ms).padStart(6, ' ') + 'ms  ' + (detail || ''));
}

async function T(name, fn) {
    const t0 = Date.now();
    current = name;
    try {
        const detail = await fn();
        record(name, true, detail, Date.now() - t0);
        return true;
    } catch (e) {
        if (e && e.skip) {
            record(name, 'SKIP', e.message, Date.now() - t0);
            return true;
        }
        record(name, false, (e && e.message ? e.message : String(e)).slice(0, 300), Date.now() - t0);
        return false;
    }
}

function skip(msg) {
    const e = new Error(msg);
    e.skip = true;
    return e;
}

/* ======================================================================== */
/* 2. Python 桥                                                             */
/* ======================================================================== */

function py(cmd, args) {
    let out;
    try {
        out = execFileSync(PYTHON, [PROBE_PATH, cmd].concat(args.map(String)), {
            encoding: 'utf8',
            maxBuffer: 128 * 1024 * 1024,
            env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
        });
    } catch (e) {
        const so = (e.stdout || '').toString();
        const se = (e.stderr || '').toString();
        const line = so.split(/\r?\n/).filter(l => l.indexOf('##JSON##') === 0).pop();
        if (line) {
            const obj = JSON.parse(line.slice(8));
            if (!obj.ok) {
                throw new Error('python ' + cmd + ' 失败: ' + obj.error);
            }
        }
        throw new Error('python ' + cmd + ' 执行失败: ' + (se || so || e.message).slice(-400));
    }
    const line = out.split(/\r?\n/).filter(l => l.indexOf('##JSON##') === 0).pop();
    if (!line) {
        throw new Error('python ' + cmd + ' 无 JSON 输出: ' + out.slice(0, 300));
    }
    const obj = JSON.parse(line.slice(8));
    if (!obj.ok) {
        throw new Error('python ' + cmd + ' 失败: ' + obj.error);
    }
    return obj;
}

function writeTmp(name, data) {
    const p = path.join(TMP_DIR, name);
    fs.writeFileSync(p, data);
    return p;
}

/* ======================================================================== */
/* 3. 浏览器沙箱（伪造 window + 真实 lame.min.js）                          */
/* ======================================================================== */

const MOD_SRC = fs.readFileSync(MOD_PATH, 'utf8');
const LAME_SRC = fs.readFileSync(LAME_PATH, 'utf8');

/**
 * 造一个最小浏览器环境:
 *   sandbox.window === sandbox（即 file:// 下的 window/globalThis 同体）
 * 先跑 lame.min.js（浏览器里是全局 script），再跑 audio-encoders.js。
 */
function loadSandbox(extraGlobals) {
    const sandbox = {
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        performance: { now: () => Date.now() }
    };
    if (extraGlobals) {
        Object.keys(extraGlobals).forEach(k => { sandbox[k] = extraGlobals[k]; });
    }
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(LAME_SRC, sandbox, { filename: 'lame.min.js' });
    vm.runInContext(MOD_SRC, sandbox, { filename: 'audio-encoders.js' });
    return sandbox;
}

/* ======================================================================== */
/* 4. 测试信号 / 二进制工具                                                 */
/* ======================================================================== */

function sine(channels, sampleRate, freq, amp, dur) {
    const n = Math.max(1, Math.round(sampleRate * dur));
    const out = [];
    for (let c = 0; c < channels; c++) {
        const a = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            a[i] = amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
        }
        out.push(a);
    }
    return out;
}

function noise(channels, n, seed) {
    let s = seed || 12345;
    const rnd = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff * 2 - 1;
    };
    const out = [];
    for (let c = 0; c < channels; c++) {
        const a = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            a[i] = rnd() * 0.3;
        }
        out.push(a);
    }
    return out;
}

/** 把多声道 Float32Array 交错写成裸 f32（供 Python 侧逐采样比对） */
function writeRawF32(file, channels) {
    const ch = channels.length;
    const n = channels[0].length;
    const buf = Buffer.alloc(n * ch * 4);
    let o = 0;
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) {
            buf.writeFloatLE(channels[c][i], o);
            o += 4;
        }
    }
    return writeTmp(file, buf);
}

/* ======================================================================== */
/* 5. 独立的格式解析器（测试侧，与模块实现互不共享代码）                     */
/* ======================================================================== */

/** WAV/RIFF 头校验（假定 44 字节标准头） */
function parseWav(buf) {
    assert(buf.toString('latin1', 0, 4) === 'RIFF', 'RIFF 标识缺失');
    const riffSize = buf.readUInt32LE(4);
    assert(buf.toString('latin1', 8, 12) === 'WAVE', 'WAVE 标识缺失');
    assert(buf.toString('latin1', 12, 16) === 'fmt ', 'fmt 块缺失');
    const fmtSize = buf.readUInt32LE(16);
    const audioFormat = buf.readUInt16LE(20);
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const byteRate = buf.readUInt32LE(28);
    const blockAlign = buf.readUInt16LE(32);
    const bits = buf.readUInt16LE(34);
    const dataTag = buf.toString('latin1', 36, 40);
    assert(dataTag === 'data', 'data 块缺失（偏移 36 处为 ' + JSON.stringify(dataTag) + '）');
    const dataLen = buf.readUInt32LE(40);
    return {
        riffSize, fmtSize, audioFormat, channels, sampleRate, byteRate, blockAlign, bits,
        dataLen, totalLen: buf.length, dataOffset: 44,
        pad: dataLen % 2 === 1 ? 1 : 0
    };
}

/** MPEG Layer III 帧解析 */
const MP3_BR_TABLE = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
    '2.5': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1]
};
const MP3_SR_TABLE = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

function parseMp3(buf) {
    let i = 0;
    if (buf.toString('latin1', 0, 3) === 'ID3') {
        const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        i = 10 + sz;
    }
    const frames = [];
    while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
            assert(frames.length > 0, '首个帧同步字非法（offset ' + i + '）');
            break; /* 尾部残余（TAG 等） */
        }
        const verBits = (buf[i + 1] >> 3) & 3;
        const layerBits = (buf[i + 1] >> 1) & 3;
        const protBit = buf[i + 1] & 1;
        const brIdx = (buf[i + 2] >> 4) & 0xf;
        const srIdx = (buf[i + 2] >> 2) & 3;
        const pad = (buf[i + 2] >> 1) & 1;
        const mode = (buf[i + 3] >> 6) & 3;
        const ver = verBits === 3 ? 1 : (verBits === 2 ? 2 : '2.5');
        assert(verBits !== 1, '保留的 MPEG 版本位');
        assert(layerBits === 1, '不是 Layer III（layer bits=' + layerBits + '）');
        assert(brIdx > 0 && brIdx < 15, '非法比特率索引 ' + brIdx);
        assert(srIdx !== 3, '非法采样率索引');
        const bitrate = MP3_BR_TABLE[ver][brIdx];
        const sampleRate = MP3_SR_TABLE[ver][srIdx];
        const spf = ver === 1 ? 1152 : 576;
        const len = Math.floor((ver === 1 ? 144000 : 72000) * bitrate / sampleRate) + pad;
        assert(len > 4, '帧长非法');
        frames.push({
            offset: i, version: ver, layer: 3, bitrate, sampleRate, mode, padding: pad,
            length: len, spf, brIdx, srIdx, hasCrc: protBit === 0
        });
        i += len;
    }
    const totalSamples = frames.reduce((a, f) => a + f.spf, 0);
    return {
        frames, totalSamples,
        duration: totalSamples / frames[0].sampleRate,
        bytes: i,
        consistent: frames.every(f => f.version === frames[0].version &&
            f.sampleRate === frames[0].sampleRate && f.bitrate === frames[0].bitrate &&
            f.mode === frames[0].mode)
    };
}

/** ADTS（AAC）帧解析，逐字段返回 */
function parseAdts(buf) {
    const frames = [];
    let i = 0;
    while (i + 7 <= buf.length) {
        assert(buf[i] === 0xff && (buf[i + 1] & 0xf0) === 0xf0,
            'ADTS 同步字错误（offset ' + i + '）');
        const id = (buf[i + 1] >> 3) & 1;
        const layer = (buf[i + 1] >> 1) & 3;
        const protectionAbsent = buf[i + 1] & 1;
        const profile = (buf[i + 2] >> 6) & 3;
        const sfi = (buf[i + 2] >> 2) & 0xf;
        const priv = (buf[i + 2] >> 1) & 1;
        const chc = ((buf[i + 2] & 1) << 2) | ((buf[i + 3] >> 6) & 3);
        const original = (buf[i + 3] >> 5) & 1;
        const home = (buf[i + 3] >> 4) & 1;
        const copyrightId = (buf[i + 3] >> 3) & 1;
        const copyrightStart = (buf[i + 3] >> 2) & 1;
        const frameLen = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | ((buf[i + 5] >> 5) & 7);
        const fullness = ((buf[i + 5] & 0x1f) << 6) | ((buf[i + 6] >> 2) & 0x3f);
        const blocks = buf[i + 6] & 3;
        const hdrLen = protectionAbsent ? 7 : 9;
        frames.push({
            offset: i, id, layer, protectionAbsent, profile, sfi, priv, chc, original, home,
            copyrightId, copyrightStart, frameLen, fullness, blocks, hdrLen,
            payload: Buffer.from(buf.slice(i + hdrLen, i + frameLen))
        });
        i += frameLen;
    }
    assert(i === buf.length, 'ADTS 帧长累计与总长不一致（' + i + ' != ' + buf.length + '）');
    return frames;
}

/** Ogg CRC32：多项式 0x04C11DB7，非反射，逐位实现（与模块的查表实现互为独立校验） */
function oggCrcBitwise(buf) {
    let crc = 0;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc ^ (buf[i] << 24)) >>> 0;
        for (let k = 0; k < 8; k++) {
            crc = (crc & 0x80000000) ? (((crc << 1) ^ 0x04c11db7) >>> 0) : ((crc << 1) >>> 0);
        }
    }
    return crc >>> 0;
}

/** Ogg 页解析 + 包重组 + CRC 校验 */
function parseOgg(buf) {
    const pages = [];
    const packets = [];
    let pending = [];
    let i = 0;
    while (i < buf.length) {
        assert(buf.toString('latin1', i, i + 4) === 'OggS', 'OggS 捕获模式缺失（offset ' + i + '）');
        const version = buf[i + 4];
        const headerType = buf[i + 5];
        const granule = Number(buf.readBigUInt64LE(i + 6));
        const serial = buf.readUInt32LE(i + 14);
        const seq = buf.readUInt32LE(i + 18);
        const crcStored = buf.readUInt32LE(i + 22);
        const nseg = buf[i + 26];
        const segs = [];
        for (let k = 0; k < nseg; k++) {
            segs.push(buf[i + 27 + k]);
        }
        const bodyLen = segs.reduce((a, b) => a + b, 0);
        const total = 27 + nseg + bodyLen;
        assert(i + total <= buf.length, 'Ogg 页被截断（offset ' + i + '）');
        const page = Buffer.from(buf.slice(i, i + total));
        page.writeUInt32LE(0, 22);
        const crcCalc = oggCrcBitwise(page);
        assert(crcCalc === crcStored,
            'Ogg 页 CRC 不匹配 seq=' + seq + ' 存储 ' + crcStored.toString(16) + ' 计算 ' + crcCalc.toString(16));
        const body = buf.slice(i + 27 + nseg, i + total);
        const pagePackets = [];
        let off = 0;
        let acc = [];
        for (const s of segs) {
            acc.push(body.slice(off, off + s));
            off += s;
            if (s < 255) {
                pagePackets.push(Buffer.concat(acc));
                acc = [];
            }
        }
        for (const p of pagePackets) {
            packets.push(p);
        }
        pages.push({
            offset: i, version, headerType, granule, serial, seq, crcStored, nseg, segs,
            bodyLen, total, packets: pagePackets.map(p => p.length)
        });
        i += total;
    }
    return { pages, packets };
}

/* ======================================================================== */
/* 6. 伪 WebCodecs（把 PyAV 真实编码出的裸帧喂进模块，验证完整链路）          */
/* ======================================================================== */

/**
 * @param {object} o
 *   o.frames      {Buffer[]}          编码器将逐帧吐出的裸数据（真实 AAC/Opus 帧）
 *   o.adtsFrames  {Buffer[]}          可选：当配置带 aac:{format:'adts'} 时改吐的完整 ADTS 帧
 *   o.samplesPerFrame {number}        每帧对应的输入样本数（AAC 1024 / Opus 960）
 *   o.description {Uint8Array|null}   首帧 metadata.decoderConfig.description
 *   o.rejectDescription {boolean}     true 时 isConfigSupported 拒绝带 description 的配置
 *   o.rejectAdts  {boolean}           true 时拒绝带 aac:{format:'adts'} 的配置
 *   o.expect      {Float32Array[]}    期望收到的平面数据（用于校验 AudioData 布局）
 *   o.state       {object}            记录 configure/encode/flush 细节
 */
function makeFakeWebCodecs(o) {
    const st = o.state;
    st.configs = st.configs || [];
    st.frameSizes = st.frameSizes || [];
    st.timestamps = st.timestamps || [];
    st.dataErrors = st.dataErrors || [];
    st.encodedSamples = 0;
    st.flushed = false;

    let cfg = null;
    let list = null;
    let pendingSamples = 0;
    let idx = 0;
    let descSent = false;

    function FakeChunk(payload) {
        this._p = payload;
        this.byteLength = payload.length;
        this.type = 'key';
        this.timestamp = 0;
        this.duration = 0;
    }
    FakeChunk.prototype.copyTo = function (dest) {
        for (let i = 0; i < this._p.length; i++) {
            dest[i] = this._p[i];
        }
    };

    function FakeAudioData(init) {
        this.format = init.format;
        this.sampleRate = init.sampleRate;
        this.numberOfFrames = init.numberOfFrames;
        this.numberOfChannels = init.numberOfChannels;
        this.timestamp = init.timestamp;
        this.data = init.data;
        this.closed = false;
    }
    FakeAudioData.prototype.close = function () {
        this.closed = true;
    };
    FakeAudioData.prototype.copyTo = function () {
        throw new Error('伪 AudioData.copyTo 未被使用');
    };

    function currentList() {
        return list || o.frames;
    }

    function Encoder(init) {
        this._out = init.output;
        this._err = init.error;
        this.state = 'unconfigured';
        st.encoder = this;
    }
    Encoder.isConfigSupported = function (c) {
        st.configs.push({
            codec: c.codec, sampleRate: c.sampleRate,
            numberOfChannels: c.numberOfChannels, bitrate: c.bitrate,
            hasDescription: !!c.description,
            hasAac: !!c.aac, aacFormat: c.aac && c.aac.format,
            opus: c.opus ? JSON.parse(JSON.stringify(c.opus)) : null
        });
        if (o.rejectAdts && c.aac && c.aac.format === 'adts') {
            return Promise.resolve({ supported: false, config: c });
        }
        if (o.rejectDescription && c.description) {
            return Promise.resolve({ supported: false, config: c });
        }
        if (o.unsupported) {
            return Promise.resolve({ supported: false, config: c });
        }
        return Promise.resolve({ supported: true, config: c });
    };
    Encoder.prototype.configure = function (c) {
        if (o.rejectAdts && c.aac && c.aac.format === 'adts') {
            throw new Error('伪编码器: 不接受 aac:{format:"adts"}');
        }
        if (o.rejectDescription && c.description) {
            throw new Error('伪编码器: 不接受 description');
        }
        cfg = c;
        /* 原生 ADTS 模式下改用 ADTS 帧列表 */
        list = (o.adtsFrames && c.aac && c.aac.format === 'adts') ? o.adtsFrames : o.frames;
        st.configured = {
            codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels,
            bitrate: c.bitrate, hasDescription: !!c.description,
            hasAac: !!c.aac, aacFormat: c.aac && c.aac.format,
            opus: c.opus ? JSON.parse(JSON.stringify(c.opus)) : null,
            description: c.description ? Array.from(new Uint8Array(c.description)) : null
        };
        this.state = 'configured';
    };
    Encoder.prototype.encode = function (ad) {
        st.frameSizes.push(ad.numberOfFrames);
        st.timestamps.push(ad.timestamp);
        if (ad.format !== 'f32-planar') {
            st.dataErrors.push('AudioData.format 应为 f32-planar，实际 ' + ad.format);
        }
        if (ad.sampleRate !== cfg.sampleRate) {
            st.dataErrors.push('AudioData.sampleRate 与配置不一致');
        }
        /* 校验平面数据布局与内容（仅裸帧模式；ADTS 直通模式内容不重要） */
        if (o.expect && list === o.frames) {
            const base = st.encodedSamples;
            const ch = ad.numberOfChannels;
            outer:
            for (let c = 0; c < ch; c++) {
                for (let i = 0; i < ad.numberOfFrames; i++) {
                    const got = ad.data[c * ad.numberOfFrames + i];
                    const exp = o.expect[c][base + i];
                    if (!(Math.abs(got - exp) < 1e-7)) {
                        st.dataErrors.push('平面数据不匹配 ch' + c + ' i' + i + ' got=' + got + ' exp=' + exp);
                        break outer;
                    }
                }
            }
        }
        st.encodedSamples += ad.numberOfFrames;
        pendingSamples += ad.numberOfFrames;

        while (pendingSamples >= o.samplesPerFrame && idx < currentList().length) {
            pendingSamples -= o.samplesPerFrame;
            emitOne();
        }
    };
    Encoder.prototype.flush = function () {
        st.flushed = true;
        pendingSamples = 0;
        while (idx < currentList().length) {
            emitOne();
        }
        this.state = 'closed';
        return Promise.resolve();
    };
    Encoder.prototype.close = function () {
        this.state = 'closed';
    };

    function emitOne() {
        const payload = currentList()[idx++];
        const metadata = {};
        if (o.description && !descSent) {
            metadata.decoderConfig = {
                codec: cfg.codec,
                sampleRate: cfg.sampleRate,
                numberOfChannels: cfg.numberOfChannels,
                description: new Uint8Array(o.description).buffer
            };
            descSent = true;
        }
        st.emitted = (st.emitted || 0) + 1;
        const self = st.encoder;
        if (self && typeof self._out === 'function') {
            self._out(new FakeChunk(payload), metadata);
        }
    }

    return { Encoder, AudioData: FakeAudioData };
}

/** 读取 Python 写出的「4 字节长度前缀 + 数据」帧序列 */
function readLengthPrefixed(file) {
    const buf = fs.readFileSync(file);
    const out = [];
    let i = 0;
    while (i + 4 <= buf.length) {
        const n = buf.readUInt32LE(i);
        i += 4;
        out.push(Buffer.from(buf.slice(i, i + n)));
        i += n;
    }
    return out;
}

/**
 * MP3 解码结果的时长校验。
 * MP3 的 CBR 流没有 LAME/Xing gapless 标签（lamejs 1.2.1 未暴露该能力），因此解码端
 * 必然多出「编码器延迟 1105 样本 + 末帧填充（<1 帧）」的静音。这里用两条更严谨的判据：
 *   1) 解码样本数 == 输入样本数 + 编码器延迟(1105) + 末帧填充(0 < pad <= 每帧样本数)
 *   2) 有效信号（相对峰值 5%）的时长与输入时长偏差 < 50ms
 */
function verifyMp3Decode(r, c, info) {
    const spf = info.frames[0].spf;
    const inputSamples = Math.round(c.sr * c.dur);
    const extra = r.frames - inputSamples;
    assert(extra >= 0, '解码样本数不应少于输入（' + r.frames + ' < ' + inputSamples + '）');
    assert(extra <= 1105 + spf + 2,
        '解码样本数应为 输入+1105 编码器延迟+<1帧填充，实际多出 ' + extra + '（上限 ' + (1105 + spf + 2) + '）');
    /* 实测前导静音恰为 1105 样本（各采样率一致） */
    assert(r.signalStart != null, '缺少有效信号起点');
    assert(r.signalStart >= 1098 && r.signalStart <= 1112,
        '编码器延迟应约 1105 样本，实测首个有效样本位于 ' + r.signalStart);
    assert(r.signalDuration != null, '缺少有效信号区间统计');
    /* 核心判据：音频内容时长（有效信号区间）与输入一致，误差 < 50ms */
    assertClose(r.signalDuration, c.dur, 0.05, '有效信号时长应与输入一致（<50ms）');
    r._note = '解码总时长含编码器延迟 1105 样本（' + (1105 / c.sr * 1000).toFixed(1) + 'ms）+ 末帧填充';
}

/* ======================================================================== */
/* 7. 主流程                                                                */
/* ======================================================================== */

async function main() {
    console.log('============================================================');
    console.log(' AudioEnc 模块测试');
    console.log('============================================================');
    console.log(' Node      : ' + process.version);
    console.log(' 模块      : ' + MOD_PATH);
    console.log(' lamejs    : ' + LAME_PATH + ' (' + LAME_SRC.length + ' 字节)');
    console.log(' Python    : ' + PYTHON);
    console.log(' 临时目录  : ' + TMP_DIR);

    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(PROBE_PATH, PROBE_PY, 'utf8');

    let pyOk = true;
    try {
        const v = execFileSync(PYTHON, ['-c', 'import numpy,soundfile;print(numpy.__version__, soundfile.__version__, soundfile.__libsndfile_version__)'],
            { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }).trim();
        console.log(' numpy/sf  : ' + v);
        pyOk = true;
    } catch (e) {
        pyOk = false;
        console.log(' numpy/sf  : 不可用 -> ' + (e.message || '').slice(0, 120));
    }
    let avOk = true;
    try {
        const v = execFileSync(PYTHON, ['-c', 'import av;print(av.__version__)'],
            { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }).trim();
        console.log(' PyAV      : ' + v);
    } catch (e) {
        avOk = false;
        console.log(' PyAV      : 不可用 -> ' + (e.message || '').slice(0, 120));
    }
    console.log('------------------------------------------------------------');

    /* ---------------- 沙箱加载 ---------------- */
    let sandbox = null;
    let AE = null;

    await T('加载模块（伪造 window + lamejs）', () => {
        sandbox = loadSandbox();
        AE = sandbox.AudioEnc;
        assert(AE, 'globalThis.AudioEnc 未挂载');
        assert(sandbox.window === sandbox, '沙箱 window 伪造失败');
        assert(typeof sandbox.lamejs === 'function', 'lamejs 全局未就绪');
        assert(typeof sandbox.lamejs.Mp3Encoder === 'function', 'lamejs.Mp3Encoder 不可用');
        const api = ['wav', 'mp3', 'mp3Meta', 'aac', 'oggOpus', 'hasWebCodecs', 'support', 'resample'];
        api.forEach(k => assert(typeof AE[k] === 'function', '缺少 API: ' + k));
        return 'version=' + AE.version + ' lamejs.Mp3Encoder ✓';
    });

    await T('静态检查（经典脚本 / 无 Node 依赖）', () => {
        assert(!/^\s*(import|export)\s/m.test(MOD_SRC), '模块含 import/export 语句');
        assert(!/\brequire\s*\(/.test(MOD_SRC), '模块含 require()');
        assert(!/\bmodule\.exports\b/.test(MOD_SRC), '模块含 module.exports');
        assert(!/\bprocess\.(env|argv|nextTick)\b/.test(MOD_SRC), '模块引用 process');
        assert(!/\bBuffer\b/.test(MOD_SRC), '模块引用 Buffer');
        assert(!/\bnew\s+Function\b/.test(MOD_SRC), '模块使用 new Function（CSP 不友好）');
        const iife = /\(function\s*\(global\)/.test(MOD_SRC);
        assert(iife, '模块未按 IIFE 包装');
        return 'IIFE ✓ 无 import/require/Buffer/process/Function';
    });

    /* ---------------- T1: mp3Meta ---------------- */
    await T('mp3Meta 比特率表（MPEG 版本匹配）', () => {
        const m1 = AE.mp3Meta(2, 44100);
        assert(m1.mpegVersion === 1, '44100 应为 MPEG-1');
        assert(m1.bitrates.length === 14 && m1.bitrates[0] === 32 && m1.bitrates[13] === 320,
            'MPEG-1 比特率表应为 32..320');
        assert(m1.default === 128, 'MPEG-1 默认应为 128');
        const m2 = AE.mp3Meta(2, 22050);
        assert(m2.mpegVersion === 2, '22050 应为 MPEG-2');
        assert(m2.bitrates[0] === 8 && m2.bitrates[15] === 160 && m2.bitrates.length === 16,
            'MPEG-2 比特率表应为 8..160');
        assert(m2.default === 64, 'MPEG-2 默认应为 64');
        const m3 = AE.mp3Meta(1, 8000);
        assert(m3.mpegVersion === 2.5, '8000 应为 MPEG-2.5');
        assert(m3.bitrates[m3.bitrates.length - 1] === 160, 'MPEG-2.5 上限 160');
        const m4 = AE.mp3Meta(2, 44101);
        assert(m4.sampleRateSupported === false && m4.sampleRate === 44100, '非法采样率应就近到 44100');
        return 'MPEG1 14档 32-320k / MPEG2 16档 8-160k / MPEG2.5 ok';
    });

    /* ---------------- T2: WAV ---------------- */
    let wavCount = 0;
    await T('WAV 16bit 立体声（结构 + soundfile 逐采样）', () => {
        const ch = sine(2, 44100, 440, 0.9, 0.25);
        const u8 = AE.wav(ch, 44100, { bitDepth: 16 });
        const buf = Buffer.from(u8);
        const h = parseWav(buf);
        const frames = ch[0].length;
        assert(h.audioFormat === 1, '应为 PCM format=1');
        assert(h.channels === 2 && h.sampleRate === 44100, '声道/采样率错误');
        assert(h.bits === 16 && h.blockAlign === 4, 'bits/blockAlign 错误');
        assert(h.byteRate === 44100 * 4, 'byteRate 错误');
        assert(h.riffSize === buf.length - 8, 'RIFF 大小错误');
        assert(h.dataLen === frames * 4, 'data 长度错误');
        assert(buf.length === 44 + h.dataLen + h.pad, '总长应为 44+data');
        const wavPath = writeTmp('t16.wav', buf);
        const raw = writeRawF32('t16.f32', ch);
        if (!pyOk) throw skip('Python/soundfile 不可用');
        const r = py('pcmcheck', [wavPath, raw, 2, 16, 0]);
        assert(r.exact === true, 'PCM 逐采样不一致（最大差 ' + r.maxAbsDiff + '）');
        assert(r.frames === frames && r.channels === 2 && r.sampleRate === 44100, 'soundfile 读到的参数不符');
        assert(r.subtype === 'PCM_16', 'subtype 应为 PCM_16，实际 ' + r.subtype);
        wavCount++;
        return 'frames=' + frames + ' 逐采样精确一致 ✓';
    });

    await T('WAV 24bit 单声道 奇数帧（3字节+pad）', () => {
        /* 取奇数帧数，使 data 长度为奇数 -> 触发 RIFF pad 字节 */
        const n = 1001;
        const ch = [new Float32Array(n)];
        for (let i = 0; i < n; i++) ch[0][i] = 0.6 * Math.sin(i * 0.05);
        const u8 = AE.wav(ch, 48000, { bitDepth: 24 });
        const buf = Buffer.from(u8);
        const h = parseWav(buf);
        assert(h.bits === 24 && h.blockAlign === 3, '24bit/单声道 blockAlign 应为 3');
        assert(h.dataLen === n * 3, 'data 长度应为 frames*3');
        assert(h.dataLen % 2 === 1, '本用例应产生奇数 data 长度');
        assert(buf.length === 44 + h.dataLen + 1, '奇数长度应补 1 字节 pad，总长 ' + buf.length);
        assert(buf[buf.length - 1] === 0, 'pad 字节应为 0');
        assert(h.riffSize === buf.length - 8, 'RIFF 大小应包含 pad');
        /* 24bit 样本小端 3 字节抽查 */
        const s0 = buf.readIntLE(44, 3);
        assert(Math.abs(s0) <= 8388607, '24bit 取值越界');
        const wavPath = writeTmp('t24.wav', buf);
        const raw = writeRawF32('t24.f32', ch);
        if (!pyOk) throw skip('Python/soundfile 不可用');
        const r = py('pcmcheck', [wavPath, raw, 1, 24, 0]);
        assert(r.exact === true, '24bit PCM 逐采样不一致（最大差 ' + r.maxAbsDiff + '）');
        assert(r.frames === n, 'soundfile 帧数应为 ' + n + '，实际 ' + r.frames);
        assert(r.subtype === 'PCM_24', 'subtype 应为 PCM_24，实际 ' + r.subtype);
        wavCount++;
        return 'frames=' + n + ' pad=1 逐采样精确一致 ✓';
    });

    await T('WAV 32bit float（format=3）', () => {
        const n = 3000;
        const ch = [new Float32Array(n), new Float32Array(n)];
        for (let i = 0; i < n; i++) {
            ch[0][i] = 0.75 * Math.sin(i * 0.01);
            ch[1][i] = -0.25 * Math.cos(i * 0.013);
        }
        const u8 = AE.wav(ch, 44100, { float: true });
        const buf = Buffer.from(u8);
        const h = parseWav(buf);
        assert(h.audioFormat === 3, 'float 应为 IEEE_FLOAT format=3');
        assert(h.bits === 32 && h.blockAlign === 8, 'float32 blockAlign 应为 8');
        assert(h.dataLen === n * 8, 'data 长度错误');
        assert(buf.readFloatLE(44) === ch[0][0], '首个 float 采样应逐位一致');
        const wavPath = writeTmp('tf.wav', buf);
        const raw = writeRawF32('tf.f32', ch);
        if (!pyOk) throw skip('Python/soundfile 不可用');
        const r = py('pcmcheck', [wavPath, raw, 2, 32, 1]);
        assert(r.exact === true, 'float 逐采样不一致（最大差 ' + r.maxAbsDiff + '）');
        assert(r.subtype === 'FLOAT', 'subtype 应为 FLOAT，实际 ' + r.subtype);
        wavCount++;
        return 'frames=' + n + ' format=3 逐位一致 ✓';
    });

    await T('WAV 24bit 立体声 + 时钟精度（48k/0.1s）', () => {
        const ch = noise(2, 4800, 777);
        const u8 = AE.wav(ch, 48000, { bitDepth: 24 });
        const buf = Buffer.from(u8);
        const h = parseWav(buf);
        assert(h.blockAlign === 6 && h.dataLen === 4800 * 6, '24bit 立体声块对齐错误');
        if (!pyOk) throw skip('Python/soundfile 不可用');
        const wavPath = writeTmp('t24s.wav', buf);
        const raw = writeRawF32('t24s.f32', ch);
        const r = py('pcmcheck', [wavPath, raw, 2, 24, 0]);
        assert(r.exact === true, '噪声信号 24bit 逐采样不一致');
        assert(Math.abs(r.duration - 0.1) < 1e-6, '时长应为 0.1s');
        wavCount++;
        return '噪声 2ch/48k 24bit 精确一致，duration=' + r.duration.toFixed(6);
    });

    await T('WAV 边界：声道不等长 / 空数据 / 非法 bitDepth', () => {
        const a = new Float32Array(1000).fill(0.1);
        const b = new Float32Array(999).fill(-0.1);
        const u8 = AE.wav([a, b], 44100, { bitDepth: 16 });
        const h = parseWav(Buffer.from(u8));
        assert(h.dataLen === 999 * 4, '不等长声道应按最短截断为 999 帧，实际 dataLen=' + h.dataLen);
        let threw = false;
        try { AE.wav([], 44100, { bitDepth: 16 }); } catch (e) { threw = true; }
        assert(threw, '空声道数组应抛错');
        threw = false;
        try { AE.wav([a], 44100, { bitDepth: 20 }); } catch (e) { threw = true; }
        assert(threw, 'bitDepth=20 应抛错');
        return '不等长截断 999 帧、空数组/非法位深均抛错 ✓';
    });

    /* ---------------- T3: ADTS 结构自检（纯 muxer） ---------------- */
    await T('ADTS 封装结构自检（已知帧）', () => {
        const I = AE._internal;
        const payloads = [
            Buffer.alloc(100, 0xa1), Buffer.alloc(300, 0xb2),
            Buffer.alloc(17, 0xc3), Buffer.alloc(1, 0xd4)
        ];
        const u8 = I.adtsMux(payloads, 44100, 2, 1);
        const buf = Buffer.from(u8);
        const fr = parseAdts(buf);
        assert(fr.length === payloads.length, '帧数应为 ' + payloads.length);
        const expectTotal = payloads.reduce((a, p) => a + 7 + p.length, 0);
        assert(buf.length === expectTotal, '总长应为 Σ(7+payload)=' + expectTotal + '，实际 ' + buf.length);
        const sfi = I.adtsSampleRateIndex(44100);
        assert(sfi === 4, '44100 的 ADTS 采样率索引应为 4，实际 ' + sfi);
        fr.forEach((f, k) => {
            assert(f.id === 0, '第' + k + '帧 ID 应为 0（MPEG-4）');
            assert(f.layer === 0, '第' + k + '帧 layer 应为 00');
            assert(f.protectionAbsent === 1, '第' + k + '帧应无 CRC');
            assert(f.profile === 1, '第' + k + '帧 profile 应为 1（AAC-LC）');
            assert(f.sfi === sfi, '第' + k + '帧采样率索引错误');
            assert(f.chc === 2, '第' + k + '帧声道配置应为 2');
            assert(f.priv === 0 && f.original === 0 && f.home === 0, '第' + k + '帧保留位应为 0');
            assert(f.copyrightId === 0 && f.copyrightStart === 0, '第' + k + '帧版权位应为 0');
            assert(f.frameLen === 7 + payloads[k].length, '第' + k + '帧 frame_length 应为 7+payload');
            assert(f.fullness === 0x7ff, '第' + k + '帧 buffer_fullness 应为 0x7FF（VBR）');
            assert(f.blocks === 0, '第' + k + '帧 number_of_raw_data_blocks 应为 0');
            assert(f.hdrLen === 7, '第' + k + '帧头应为 7 字节');
            assert(f.payload.equals(payloads[k]), '第' + k + '帧载荷不一致');
        });
        /* 采样率索引表 96000..7350 全表 */
        const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        rates.forEach((r, idx) => assert(I.adtsSampleRateIndex(r) === idx, '采样率索引表错: ' + r));
        /* 声道配置 */
        assert(I.adtsChannelConfig(1) === 1 && I.adtsChannelConfig(2) === 2 && I.adtsChannelConfig(6) === 6,
            '声道配置映射错误');
        /* AudioSpecificConfig：44100/立体声/LC -> 0x12 0x10 */
        const asc = I.audioSpecificConfig(44100, 2, 2);
        assert(asc[0] === 0x12 && asc[1] === 0x10,
            'ASC 应为 0x1210，实际 0x' + asc[0].toString(16) + asc[1].toString(16));
        const asc8 = I.audioSpecificConfig(8000, 1, 2);
        const back = I.parseAudioSpecificConfig(asc8);
        assert(back.audioObjectType === 2 && back.sampleRateIndex === 11 && back.channelConfig === 1,
            'ASC 反解失败: ' + JSON.stringify(back));
        return '4 帧逐字段 ✓ CRC-free profile=1 fullness=0x7FF；ASC=0x1210 ✓';
    });

    /* ---------------- T4: MP3 编码 ---------------- */
    const mp3Cases = [
        { name: 'MP3 128k 44.1k 立体声', ch: 2, sr: 44100, br: 128, dur: 1.0, expBr: 128 },
        { name: 'MP3 320k 44.1k 立体声', ch: 2, sr: 44100, br: 320, dur: 1.0, expBr: 320 },
        { name: 'MP3 128k 44.1k 单声道', ch: 1, sr: 44100, br: 128, dur: 1.0, expBr: 128 },
        { name: 'MP3 128k 22.05k 立体声', ch: 2, sr: 22050, br: 128, dur: 1.0, expBr: 128 },
        { name: 'MP3 64k 8k 单声道', ch: 1, sr: 8000, br: 64, dur: 1.0, expBr: 64 }
    ];
    for (const c of mp3Cases) {
        await T(c.name, () => {
            const chans = sine(c.ch, c.sr, 440, 0.5, c.dur);
            const progress = [];
            const p = AE.mp3(chans, c.sr, { bitrate: c.br, onProgress: v => progress.push(v) });
            assert(p && typeof p.then === 'function', 'mp3 应返回 Promise');
            return p.then(u8 => {
                const buf = Buffer.from(u8);
                const meta = u8.meta;
                assert(meta, '结果缺少 .meta');
                assert(meta.bitrate === c.expBr, 'meta.bitrate 应为 ' + c.expBr + '，实际 ' + meta.bitrate);
                assert(meta.bitrateAdjusted === false, '合法组合不应触发降级');
                assert(meta.mpegVersion === (c.sr >= 32000 ? 1 : (c.sr >= 16000 ? 2 : 2.5)), 'meta.mpegVersion 错误');
                /* 帧头解析 */
                const info = parseMp3(buf);
                assert(info.frames.length > 5, '帧数过少: ' + info.frames.length);
                assert(info.consistent, '帧参数不一致');
                assert(info.frames[0].sampleRate === c.sr, '帧内采样率应为 ' + c.sr);
                assert(info.frames[0].bitrate === c.expBr, '帧内比特率应为 ' + c.expBr);
                assert(info.frames[0].mode === (c.ch === 1 ? 3 : (info.frames[0].mode)),
                    '单声道时 channel mode 应为 3');
                if (c.ch === 1) {
                    assert(info.frames[0].mode === 3, '单声道应为 mono mode');
                }
                /* 帧头推算时长 = 解码时长（含编码器延迟/填充），与输入之差受 1105 + 1 帧约束 */
                const extraHdr = info.totalSamples - Math.round(c.sr * c.dur);
                assert(extraHdr >= 0 && extraHdr <= 1105 + info.frames[0].spf + 2,
                    '帧头推算样本数应为 输入+1105+<1帧，实际多出 ' + extraHdr);
                assert(info.bytes === buf.length, '帧长累计应等于文件长度');
                /* 进度回调 */
                assert(progress.length > 2, 'onProgress 调用次数过少');
                for (let i = 1; i < progress.length; i++) {
                    assert(progress[i] >= progress[i - 1] - 1e-9, 'onProgress 非单调');
                }
                assertClose(progress[progress.length - 1], 1, 1e-9, 'onProgress 最终应为 1');
                assert(progress[0] >= 0 && progress[0] < 1, 'onProgress 起点异常');
                if (!pyOk) throw skip('Python/soundfile 不可用');
                const mp3Path = writeTmp('case_' + c.sr + '_' + c.br + '_' + c.ch + '.mp3', buf);
                const r = py('stats', [mp3Path, 440, 0.5]);
                assert(r.sampleRate === c.sr, 'soundfile 采样率应为 ' + c.sr + '，实际 ' + r.sampleRate);
                assert(r.channels === c.ch, 'soundfile 声道应为 ' + c.ch + '，实际 ' + r.channels);
                /* 解码总时长含 MP3 编码器延迟(1105)+末帧填充(<1帧)，按帧粒度给容差
                   （22050Hz 下 1105 样本本身即 50.1ms，无法做到绝对 <50ms） */
                const tol = 1105 / c.sr + info.frames[0].spf / c.sr + 0.002;
                assertClose(r.duration, c.dur, tol, '解码总时长（含编码器延迟）应在帧粒度容差内');
                const corr = r.corr || {};
                assert(corr.corrBest != null && corr.corrBest > 0.95,
                    '波形相关度应 >0.95，实际 ' + corr.corrBest);
                verifyMp3Decode(r, c, info);
                return r.decoder + ' 解出 ' + r.frames + ' 帧/' + r.sampleRate + 'Hz/' + r.channels +
                    'ch 总时长 ' + r.duration.toFixed(4) + 's（※含编码器延迟；有效信号 ' +
                    r.signalStart + '..' + r.signalEnd + ' = ' + r.signalDuration.toFixed(4) +
                    's, corr=' + corr.corrBest.toFixed(5) + '）头解析 ' + info.frames.length + ' 帧';
            });
        });
    }

    /* ---------------- T5: MP3 非法组合降级 ---------------- */
    await T('MP3 非法比特率降级（22050@320k→160k）', () => {
        const chans = sine(2, 22050, 440, 0.5, 0.5);
        return AE.mp3(chans, 22050, { bitrate: 320 }).then(u8 => {
            const meta = u8.meta;
            assert(meta.bitrate === 160, '应降级为 160k，实际 ' + meta.bitrate);
            assert(meta.bitrateAdjusted === true, 'bitrateAdjusted 应为 true');
            assert(meta.bitrates[15] === 160, 'MPEG-2 上限应为 160');
            assert(meta.notes.length > 0, '应在 notes 中记录降级原因');
            const info = parseMp3(Buffer.from(u8));
            assert(info.frames[0].bitrate === 160, '实际帧比特率应为 160');
            assert(info.frames[0].version === 2, '应为 MPEG-2');
            return '320k→' + meta.bitrate + 'k，notes=' + meta.notes[0];
        });
    });

    await T('MP3 越界比特率取最近合法值（999k→320k）+ bps 写法兼容', async () => {
        const u8 = await AE.mp3(sine(2, 44100, 440, 0.3, 0.3), 44100, { bitrate: 999 });
        assert(u8.meta.bitrate === 320, '应取 320k，实际 ' + u8.meta.bitrate);
        assert(u8.meta.bitrateAdjusted === true, '应标记降级');
        /* 单位自适应：传 128000（bps 写法）应等价于 128（kbps） */
        const u9 = await AE.mp3(sine(2, 44100, 440, 0.3, 0.3), 44100, { bitrate: 128000 });
        assert(u9.meta.bitrate === 128, '128000bps 应解释为 128kbps，实际 ' + u9.meta.bitrate);
        return '999k→320k；128000(bps)→128kbps ✓';
    });

    await T('MP3 非标采样率重采样（44101→44100）', () => {
        const n = 44101;
        const src = [new Float32Array(n), new Float32Array(n)];
        for (let i = 0; i < n; i++) {
            src[0][i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / 44101);
            src[1][i] = src[0][i];
        }
        return AE.mp3(src, 44101, { bitrate: 128 }).then(u8 => {
            const meta = u8.meta;
            assert(meta.sampleRate === 44100, '应收敛到 44100，实际 ' + meta.sampleRate);
            assert(meta.sampleRateRequested === 44101, '应记录原始采样率');
            assert(meta.notes.some(s => s.indexOf('重采样') >= 0), 'notes 应说明重采样');
            const info = parseMp3(Buffer.from(u8));
            assert(info.frames[0].sampleRate === 44100, '帧内采样率应为 44100');
            assertClose(info.duration, 1.0, 0.06, '重采样后时长应约 1s');
            return '44101→44100，时长 ' + info.duration.toFixed(4) + 's';
        });
    });

    await T('MP3 vbr:true 回退 CBR 并在 meta 注明', () => {
        return AE.mp3(sine(2, 44100, 440, 0.3, 0.3), 44100, { bitrate: 128, vbr: true }).then(u8 => {
            assert(u8.meta.vbr === false, 'lamejs 无 VBR，meta.vbr 应为 false');
            assert(u8.meta.vbrRequested === true, '应记录 vbrRequested');
            assert(u8.meta.notes.some(s => s.indexOf('VBR') >= 0), 'notes 应说明 VBR 回退');
            const info = parseMp3(Buffer.from(u8));
            assert(info.consistent && info.frames[0].bitrate === 128, '输出仍应为合法 CBR 128k');
            return 'CBR 128k 合法输出，notes 已注明 ✓';
        });
    });

    await T('MP3 编码不阻塞主线程（定时器可插入）', () => {
        let fired = 0;
        const timer = new Promise(resolve => setTimeout(() => { fired++; resolve(); }, 0));
        return AE.mp3(sine(2, 44100, 440, 0.3, 1.5), 44100, { bitrate: 128 }).then(u8 => {
            assert(u8.length > 0, '编码结果为空');
            return timer.then(() => {
                assert(fired >= 1, '编码期间定时器未执行：说明阻塞了主线程');
                return '长任务期间 setTimeout(0) 已触发 ' + fired + ' 次，分块让出 ✓';
            });
        });
    });

    /* ---------------- T6: AAC 全链路（伪 WebCodecs + 真实 AAC 帧） ---------------- */
    const aacRefCache = {};
    async function aacRef(sr, ch, dur) {
        const key = sr + '_' + ch + '_' + dur;
        if (aacRefCache[key]) {
            return aacRefCache[key];
        }
        if (!avOk) {
            throw skip('PyAV 不可用');
        }
        const bin = path.join(TMP_DIR, 'aac_ref_' + sr + '_' + ch + '.bin');
        const adts = path.join(TMP_DIR, 'aac_ref_' + sr + '_' + ch + '.aac');
        const r = py('aacref', [bin, path.join(TMP_DIR, 'aac_ref_' + sr + '_' + ch + '.json'),
            adts, sr, ch, 440, 0.5, dur]);
        const bytes = fs.readFileSync(adts);
        const ref = {
            frames: readLengthPrefixed(bin),
            adtsBytes: bytes,
            adtsFrames: parseAdts(bytes).map(f => Buffer.from(bytes.slice(f.offset, f.offset + f.frameLen))),
            info: r, adtsPath: adts, samples: r.inputSamples, sr, ch
        };
        assert(ref.frames.length === r.frameCount, '参考帧数量不符');
        aacRefCache[key] = ref;
        return ref;
    }

    /** 用伪编码器跑一次 aac()，返回 {u8, st, progress} */
    async function encodeAacViaFake(opt) {
        const st = {};
        const fake = makeFakeWebCodecs(Object.assign({ samplesPerFrame: 1024, state: st }, opt.fake || {}));
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        const progress = [];
        const u8 = await sb.AudioEnc.aac(opt.chans, opt.sr, {
            bitrate: opt.bitrate == null ? 128000 : opt.bitrate,
            onProgress: v => progress.push(v)
        });
        return { u8, st, progress, buf: Buffer.from(u8), meta: u8.meta };
    }

    await T('生成 AAC 参考流（PyAV，44.1k/48k × 单/双声道）', async () => {
        if (!avOk) throw skip('PyAV 不可用');
        const a = await aacRef(44100, 2, 0.5);
        const b = await aacRef(44100, 1, 0.5);
        const c = await aacRef(48000, 2, 0.5);
        assert(a.info.profile === 1, '参考流应为 AAC-LC（profile=1）');
        assert(a.info.sfi === 4 && a.info.chc === 2, '44.1k 立体声参考头字段不符');
        assert(b.info.chc === 1, '单声道参考 chc 应为 1');
        assert(c.info.sfi === 3, '48k 参考 sfi 应为 3');
        return '44.1k/2ch ' + a.frames.length + '帧; 44.1k/1ch ' + b.frames.length +
            '帧; 48k/2ch ' + c.frames.length + '帧';
    });

    await T('AAC 44.1k 立体声 128k（裸帧→自写 ADTS + 解码往返）', async () => {
        const ref = await aacRef(44100, 2, 0.5);
        const chans = sine(2, 44100, 440, 0.5, 0.5);
        const r = await encodeAacViaFake({
            chans, sr: 44100, bitrate: 128000,
            fake: {
                frames: ref.frames, adtsFrames: ref.adtsFrames, rejectAdts: true,
                description: new Uint8Array([0x12, 0x10]), expect: chans
            }
        });
        /* 编码器配置 */
        assert(r.st.configured.codec === 'mp4a.40.2', 'codec 应为 mp4a.40.2');
        assert(r.st.configured.sampleRate === 44100 && r.st.configured.numberOfChannels === 2,
            '采样率/声道配置错误');
        assert(r.st.configured.bitrate === 128000, 'bitrate 应为 128000');
        assert(r.st.configured.hasDescription, '应携带 AudioSpecificConfig description');
        assert(r.st.configured.description[0] === 0x12 && r.st.configured.description[1] === 0x10,
            'ASC 应为 0x1210，实际 ' + JSON.stringify(r.st.configured.description));
        /* 喂入数据 */
        assert(r.st.dataErrors.length === 0, 'AudioData 错误: ' + r.st.dataErrors[0]);
        assert(r.st.encodedSamples === chans[0].length, '喂入样本数应为 ' + chans[0].length);
        assert(r.st.frameSizes.every((n, i) => i === r.st.frameSizes.length - 1 ? n > 0 : n === 1024),
            '除末块外每块应为 1024 样本（末块 ' + r.st.frameSizes[r.st.frameSizes.length - 1] + '）');
        for (let i = 1; i < r.st.timestamps.length; i++) {
            assert(r.st.timestamps[i] > r.st.timestamps[i - 1], '时间戳应严格递增');
        }
        assert(Math.abs(r.progress[r.progress.length - 1] - 1) < 1e-9, 'onProgress 应到达 1');
        /* ADTS 结构 */
        const fr = parseAdts(r.buf);
        assert(fr.length === ref.frames.length, 'ADTS 帧数应为 ' + ref.frames.length + '，实际 ' + fr.length);
        fr.forEach((f, k) => {
            assert(f.frameLen === 7 + ref.frames[k].length, '第' + k + '帧长度不符');
            assert(f.payload.equals(ref.frames[k]), '第' + k + '帧载荷与真实 AAC 帧不一致');
            assert(f.profile === 1 && f.sfi === 4 && f.chc === 2 && f.id === 0 && f.layer === 0,
                '第' + k + '帧头字段不符');
            assert(f.fullness === 0x7ff && f.blocks === 0, '第' + k + '帧 fullness/blocks 不符');
        });
        assert(r.buf.length === ref.adtsBytes.length,
            'ADTS 总长应与参考流一致（' + ref.adtsBytes.length + '），实际 ' + r.buf.length);
        assert(r.meta.nativeAdts === false && r.meta.withDescription === true, 'meta 标志错误');
        assert(r.meta.sampleRate === 44100 && r.meta.channels === 2 && r.meta.bitrate === 128000, 'meta 参数错误');
        /* 解码往返 */
        const outPath = writeTmp('aac_44100_2.aac', r.buf);
        const dec = py('decode', [outPath, 440, 0.5]);
        assert(dec.sampleRate === 44100 && dec.channels === 2, '解码参数错误');
        assert(dec.frames === fr.length * 1024, '解码样本数应 = 帧数×1024');
        assert(dec.corr.corrBest > 0.95, '解码波形相关度应 >0.95，实际 ' + dec.corr.corrBest);
        const cmp = py('compare', [outPath, ref.adtsPath]);
        assert(cmp.bitExact === true,
            '与 ffmpeg 参考流解码结果应逐采样一致（maxDiff=' + cmp.maxAbsDiff + '）');
        return fr.length + ' 帧 / ' + r.buf.length + 'B（=参考）; 解码 ' + dec.frames +
            ' 样本 corr=' + dec.corr.corrBest.toFixed(5) + '; 与参考流逐采样一致 ✓';
    });

    await T('AAC 原生 aac:{format:"adts"} 直通（逐字节一致）', async () => {
        const ref = await aacRef(44100, 2, 0.5);
        const r = await encodeAacViaFake({
            chans: sine(2, 44100, 440, 0.5, 0.5), sr: 44100, bitrate: 128000,
            fake: { frames: ref.frames, adtsFrames: ref.adtsFrames }
        });
        assert(r.st.configured.hasAac && r.st.configured.aacFormat === 'adts',
            '应优先使用 aac:{format:"adts"} 配置');
        assert(r.meta.nativeAdts === true, 'meta.nativeAdts 应为 true');
        assert(r.buf.equals(ref.adtsBytes), '输出应与编码器给出的 ADTS 流逐字节一致（未二次封装）');
        assert(r.meta.frames === ref.frames.length, 'meta.frames 应由 ADTS 扫描得出');
        /* 变体：编码器把所有帧塞进一个 chunk（整体是 ADTS 流）也应透传 */
        const r2 = await encodeAacViaFake({
            chans: sine(2, 44100, 440, 0.5, 0.5), sr: 44100, bitrate: 128000,
            fake: { frames: ref.frames, adtsFrames: [ref.adtsBytes] }
        });
        assert(r2.meta.nativeAdts === true, '单个 ADTS 大 chunk 也应识别为原生 ADTS');
        assert(r2.meta.frames === ref.frames.length, 'meta.frames 应为扫描得到的 ' + ref.frames.length +
            '，实际 ' + r2.meta.frames);
        assert(r2.buf.equals(ref.adtsBytes), '单 chunk ADTS 流应逐字节透传');
        return '原生 ADTS 直通 ' + ref.frames.length + ' 帧 / ' + r.buf.length +
            ' 字节逐字节一致（含单 chunk 变体）✓';
    });

    await T('AAC 44.1k 单声道 128k（往返）', async () => {
        const ref = await aacRef(44100, 1, 0.5);
        const chans = sine(1, 44100, 440, 0.5, 0.5);
        const r = await encodeAacViaFake({
            chans, sr: 44100, bitrate: 128000,
            fake: {
                frames: ref.frames, adtsFrames: ref.adtsFrames, rejectAdts: true,
                description: new Uint8Array([0x12, 0x08]), expect: chans
            }
        });
        assert(r.st.configured.numberOfChannels === 1, 'numberOfChannels 应为 1');
        assert(r.st.dataErrors.length === 0, 'AudioData 错误: ' + r.st.dataErrors[0]);
        const fr = parseAdts(r.buf);
        fr.forEach((f, k) => {
            assert(f.chc === 1, '第' + k + '帧 channel_config 应为 1');
            assert(f.payload.equals(ref.frames[k]), '第' + k + '帧载荷不一致');
        });
        assert(r.meta.channels === 1, 'meta.channels 应为 1');
        const outPath = writeTmp('aac_44100_1.aac', r.buf);
        const dec = py('decode', [outPath, 440, 0.5]);
        assert(dec.channels === 1 && dec.sampleRate === 44100, '解码参数错误');
        assert(dec.corr.corrBest > 0.95, '相关度应 >0.95，实际 ' + dec.corr.corrBest);
        const cmp = py('compare', [outPath, ref.adtsPath]);
        assert(cmp.bitExact === true, '单声道应与参考流解码逐采样一致');
        return fr.length + ' 帧 / ' + dec.frames + ' 样本 / corr=' + dec.corr.corrBest.toFixed(5) + ' ✓';
    });

    await T('AAC 48k 立体声 128k（往返，sfi=3）', async () => {
        const ref = await aacRef(48000, 2, 0.5);
        const chans = sine(2, 48000, 440, 0.5, 0.5);
        const r = await encodeAacViaFake({
            chans, sr: 48000, bitrate: 128000,
            fake: {
                frames: ref.frames, adtsFrames: ref.adtsFrames, rejectAdts: true,
                description: new Uint8Array([0x11, 0x90]), expect: chans
            }
        });
        assert(r.st.configured.sampleRate === 48000, 'configure 采样率应为 48000');
        assert(r.st.configured.description[0] === 0x11 && r.st.configured.description[1] === 0x90,
            '48k 立体声 ASC 应为 0x1190，实际 ' + JSON.stringify(r.st.configured.description));
        const fr = parseAdts(r.buf);
        assert(fr[0].sfi === 3, 'ADTS 采样率索引应为 3（48000）');
        fr.forEach((f, k) => assert(f.payload.equals(ref.frames[k]), '第' + k + '帧载荷不一致'));
        assert(r.meta.sampleRate === 48000, 'meta.sampleRate 应为 48000');
        const outPath = writeTmp('aac_48000_2.aac', r.buf);
        const dec = py('decode', [outPath, 440, 0.5]);
        assert(dec.sampleRate === 48000 && dec.channels === 2, '解码参数错误');
        assert(dec.corr.corrBest > 0.95, '相关度应 >0.95');
        const cmp = py('compare', [outPath, ref.adtsPath]);
        assert(cmp.bitExact === true, '48k 应与参考流解码逐采样一致');
        return fr.length + ' 帧 / 解码 ' + dec.sampleRate + 'Hz ' + dec.frames +
            ' 样本 corr=' + dec.corr.corrBest.toFixed(5) + ' ✓';
    });

    await T('AAC 22050Hz 输入自动重采样到 48000', async () => {
        const ref = await aacRef(48000, 2, 0.5);
        const chans = sine(2, 22050, 440, 0.5, 0.5);
        const r = await encodeAacViaFake({
            chans, sr: 22050, bitrate: 128000,
            fake: { frames: ref.frames, adtsFrames: ref.adtsFrames, rejectAdts: true }
        });
        const meta = r.meta;
        assert(meta.sampleRate === 48000 && meta.sampleRateRequested === 22050,
            'meta 应记录实际 48000 / 原始 22050');
        assert(meta.resampled === true, 'meta.resampled 应为 true');
        assert(meta.notes.some(s => /重采样/.test(s)), 'notes 应说明重采样');
        assert(r.st.configured.sampleRate === 48000, 'configure 采样率应为 48000');
        const expect48 = Math.round(chans[0].length * 48000 / 22050);
        assert(r.st.encodedSamples === expect48,
            '喂入样本数应为重采样后 ' + expect48 + '，实际 ' + r.st.encodedSamples);
        const fr = parseAdts(r.buf);
        assert(fr[0].sfi === 3 && fr[0].chc === 2, 'ADTS 应为 48k/立体声');
        const dec = py('decode', [writeTmp('aac_resampled.aac', r.buf), 440, 0.5]);
        assert(dec.sampleRate === 48000, '解码采样率应为 48000');
        assert(dec.corr.corrBest > 0.95, '相关度应 >0.95，实际 ' + dec.corr.corrBest);
        return '22050→48000（' + expect48 + ' 样本），' + fr.length + ' 帧，corr=' +
            dec.corr.corrBest.toFixed(5) + ' ✓';
    });

    await T('AAC 比特率白名单（100k→96k，300k→192k）', async () => {
        assert(JSON.stringify(AE.AAC_BITRATES) === JSON.stringify([96000, 128000, 160000, 192000]),
            '导出的 AAC_BITRATES 应为 96/128/160/192k');
        assert(JSON.stringify(AE.AAC_SAMPLE_RATES) === JSON.stringify([44100, 48000]),
            '导出的 AAC_SAMPLE_RATES 应为 44100/48000');
        const ref = await aacRef(44100, 2, 0.5);
        const chans = sine(2, 44100, 440, 0.5, 0.2);
        const fake = { frames: ref.frames, adtsFrames: ref.adtsFrames, rejectAdts: true };
        const r1 = await encodeAacViaFake({ chans, sr: 44100, bitrate: 100000, fake });
        assert(r1.meta.bitrate === 96000, '100k 应取 96000，实际 ' + r1.meta.bitrate);
        assert(r1.meta.bitrateAdjusted === true && r1.st.configured.bitrate === 96000,
            '应标记并实际使用 96k');
        assert(r1.meta.notes.some(s => /白名单/.test(s)), 'notes 应说明白名单修正');
        const r2 = await encodeAacViaFake({ chans, sr: 44100, bitrate: 300000, fake });
        assert(r2.meta.bitrate === 192000, '300k 应取 192000，实际 ' + r2.meta.bitrate);
        const r3 = await encodeAacViaFake({ chans, sr: 44100, fake });
        assert(r3.meta.bitrate === 128000, '默认应为 128000');
        /* 单位自适应：传 128（kbps 写法）应等价于 128000（bps） */
        const r4 = await encodeAacViaFake({ chans, sr: 44100, bitrate: 128, fake });
        assert(r4.meta.bitrate === 128000, 'bitrate:128 应按 kbps 解释为 128000，实际 ' + r4.meta.bitrate);
        assert(r4.st.configured.bitrate === 128000, 'configure 的 bitrate 应为 128000');
        return '100k→96k / 300k→192k / 默认 128k / kbps 写法兼容 ✓';
    });

    await T('AAC 配置回退（aac 与 description 均被拒）', async () => {
        const ref = await aacRef(44100, 2, 0.5);
        const st = {};
        const fake = makeFakeWebCodecs({
            frames: ref.frames, adtsFrames: ref.adtsFrames, samplesPerFrame: 1024,
            state: st, rejectAdts: true, rejectDescription: true
        });
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        const u8 = await sb.AudioEnc.aac(sine(2, 44100, 440, 0.5, 0.3), 44100, { bitrate: 96000 });
        assert(st.configs.length === 4, '应依次尝试 4 种配置，实际 ' + st.configs.length);
        assert(st.configured.hasDescription === false && st.configured.hasAac === false,
            '最终应回退到裸配置');
        const fr = parseAdts(Buffer.from(u8));
        assert(fr.length > 5 && fr[0].profile === 1 && fr[0].fullness === 0x7ff,
            '回退路径仍应产出合法 ADTS');
        assert(u8.meta.nativeAdts === false && u8.meta.withDescription === false, 'meta 标志错误');
        return '4 种配置依次回退到裸配置，ADTS ' + fr.length + ' 帧合法 ✓';
    });

    /* ---------------- T7: Ogg 结构自检 ---------------- */
    await T('Ogg 封装结构自检（CRC/分页/lacing/granule）', () => {
        const I = AE._internal;
        const mk = (n, fill) => Buffer.alloc(n, fill);
        const pkts = [mk(255, 0x41), mk(510, 0x42), mk(100, 0x43), mk(300, 0x44)];
        const u8 = I.buildOggOpus(pkts, {
            channels: 2, inputSampleRate: 48000, preSkip: 312, frameSamples: 960,
            totalSamples: pkts.length * 960, serial: 0x1234, vendor: 'test-vendor'
        });
        const buf = Buffer.from(u8);
        const { pages, packets } = parseOgg(buf);
        assert(pages.length >= 3, '页数应 >=3（BOS/Tags/音频），实际 ' + pages.length);
        assert(pages[0].headerType === 2, '首页应为 BOS(0x02)');
        assert(pages[0].granule === 0, 'BOS 页 granule 应为 0');
        assert(pages[0].version === 0, 'Ogg 版本应为 0');
        assert(pages[pages.length - 1].headerType & 4, '末页应为 EOS(0x04)');
        for (let i = 0; i < pages.length; i++) {
            assert(pages[i].seq === i, '页序号应连续，页' + i + '为 ' + pages[i].seq);
            assert(pages[i].serial === 0x1234, 'serial 应一致');
            if (i > 0) {
                assert(pages[i].granule >= pages[i - 1].granule,
                    'granule 应单调不减（页' + i + ': ' + pages[i].granule + ' < ' + pages[i - 1].granule + '）');
            }
        }
        /* OpusHead */
        const head = packets[0];
        assert(head.toString('latin1', 0, 8) === 'OpusHead', 'OpusHead magic 错误');
        assert(head.length === 19, 'OpusHead 应为 19 字节');
        assert(head[8] === 1, 'OpusHead version 应为 1');
        assert(head[9] === 2, 'OpusHead 声道应为 2');
        assert(head.readUInt16LE(10) === 312, 'preSkip 应为 312');
        assert(head.readUInt32LE(12) === 48000, '输入采样率应为 48000');
        assert(head.readInt16LE(16) === 0, 'output gain 应为 0');
        assert(head[18] === 0, 'channel mapping family 应为 0');
        /* OpusTags */
        const tags = packets[1];
        assert(tags.toString('latin1', 0, 8) === 'OpusTags', 'OpusTags magic 错误');
        const vlen = tags.readUInt32LE(8);
        assert(tags.toString('utf8', 12, 12 + vlen) === 'test-vendor', 'vendor 字符串错误');
        assert(tags.readUInt32LE(12 + vlen) === 0, '用户注释数应为 0');
        /* 音频包完整还原 */
        const audio = packets.slice(2);
        assert(audio.length === pkts.length, '音频包数应为 ' + pkts.length + '，实际 ' + audio.length);
        audio.forEach((p, i) => assert(p.equals(pkts[i]), '第' + i + '个音频包内容不一致'));
        /* 255 倍数 lacing 规则：长度 255 的包应记为 [255, 0] */
        let found255 = false;
        pages.forEach(pg => {
            for (let k = 0; k < pg.segs.length - 1; k++) {
                if (pg.segs[k] === 255 && pg.segs[k + 1] === 0) found255 = true;
            }
        });
        assert(found255, '长度恰为 255 倍的包必须补 0 终止段（lacing 255 规则）');
        const totalSamples = pkts.length * 960;
        assert(pages[pages.length - 1].granule === 312 + totalSamples,
            '末页 granule 应为 preSkip+totalSamples=' + (312 + totalSamples) +
            '，实际 ' + pages[pages.length - 1].granule);
        /* CRC 与模块查表实现交叉验证 */
        const sample = buf.slice(pages[1].offset, pages[1].offset + pages[1].total);
        const zeroed = Buffer.from(sample);
        zeroed.writeUInt32LE(0, 22);
        assert(I.crc32Ogg(new Uint8Array(zeroed)) === pages[1].crcStored,
            '模块 crc32Ogg 与页内 CRC 不一致');
        assert(oggCrcBitwise(zeroed) === pages[1].crcStored,
            '独立逐位 CRC 实现与页内 CRC 不一致');
        if (!avOk) throw skip('PyAV 不可用');
        const p = writeTmp('synth.opus', buf);
        const r = py('oggcheck', [p]);
        assert(r.pageCount === pages.length, 'Python 解析页数不符');
        assert(r.packetCount === packets.length, 'Python 解析包数不符');
        assert(r.granuleMonotonic && r.seqContiguous, 'Python 侧 granule/序号检查失败');
        assert(r.firstIsBos && r.lastIsEos, 'Python 侧 BOS/EOS 检查失败');
        assert(r.finalSamples === totalSamples, 'Python 侧最终样本数应为 ' + totalSamples);
        return pages.length + ' 页 / ' + packets.length + ' 包 / CRC 双实现一致 / granule 末值 ' +
            pages[pages.length - 1].granule;
    });

    /* ---------------- T8: Ogg Opus 全链路 ---------------- */
    let opusRef = null;
    await T('生成 Opus 参考包（PyAV/libopus）', () => {
        if (!avOk) throw skip('PyAV 不可用');
        const bin = path.join(TMP_DIR, 'opus_ref_frames.bin');
        const r = py('opusref', [bin, path.join(TMP_DIR, 'opus_ref.json'), 48000, 2, 440, 0.5, 0.5]);
        opusRef = { packets: readLengthPrefixed(bin), info: r };
        assert(opusRef.packets.length === r.packetCount, '参考包数不符');
        return r.packetCount + ' 个 Opus 包 / 输入 ' + r.inputSamples + ' 样本';
    });

    await T('Ogg Opus 全链路（伪编码器 + 真实包，44.1k→48k）', () => {
        if (!opusRef) throw skip('缺少 Opus 参考包');
        const st = {};
        const fake = makeFakeWebCodecs({
            frames: opusRef.packets, samplesPerFrame: 960, description: null, state: st
        });
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        const mod = sb.AudioEnc;
        const chans = sine(2, 44100, 440, 0.5, 0.5);
        const progress = [];
        /* 用 kbps 写法 96 传入，模块应自动换算为 96000 bps */
        return mod.oggOpus(chans, 44100, { bitrate: 96, onProgress: v => progress.push(v) }).then(u8 => {
            const buf = Buffer.from(u8);
            const meta = u8.meta;
            assert(st.configured.bitrate === 96000,
                'bitrate:96（kbps 写法）应换算为 96000，实际 ' + st.configured.bitrate);
            assert(meta.bitrate === 96000, 'meta.bitrate 应为 96000');
            assert(st.configured.codec === 'opus', 'codec 应为 opus');
            assert(st.configured.sampleRate === 48000, 'Opus 配置采样率必须为 48000');
            assert(st.configured.numberOfChannels === 2, '声道数应为 2');
            assert(st.configured.opus && st.configured.opus.frameDuration === 20000,
                '应请求 20ms 帧（20000us），实际 ' + JSON.stringify(st.configured.opus));
            assert(st.dataErrors.length === 0, 'AudioData 布局错误: ' + st.dataErrors[0]);
            /* 44.1k -> 48k 重采样后样本数 */
            const expect48 = Math.round(chans[0].length * 48000 / 44100);
            assert(st.encodedSamples === expect48,
                '喂入样本数应为重采样后的 ' + expect48 + '，实际 ' + st.encodedSamples);
            assert(st.frameSizes.every((n, i) => i === st.frameSizes.length - 1 ? n > 0 : n === 960),
                '除末块外每块应为 960 样本（20ms@48k）');
            assert(meta.resampled === true && meta.sampleRateRequested === 44100, 'meta 应记录重采样');
            assert(meta.frameDuration === 20000 && meta.preSkip === 312, 'meta 帧长/preSkip 错误');
            assert(progress.length > 1 && Math.abs(progress[progress.length - 1] - 1) < 1e-9, '进度应到达 1');
            const { pages, packets } = parseOgg(buf);
            assert(pages[0].headerType === 2 && (pages[pages.length - 1].headerType & 4), 'BOS/EOS 标志错误');
            const head = packets[0];
            assert(head.readUInt16LE(10) === 312, 'preSkip 应为 312');
            assert(head.readUInt32LE(12) === 44100, 'OpusHead 应记录原始采样率 44100');
            assert(head[9] === 2, 'OpusHead 声道数应为 2');
            assert(packets.length === opusRef.packets.length + 2, '包数应为 音频包+2');
            for (let i = 2; i < packets.length; i++) {
                assert(packets[i].equals(opusRef.packets[i - 2]), '第' + (i - 2) + '个 Opus 包不一致');
            }
            assert(pages[pages.length - 1].granule === 312 + expect48,
                '末页 granule 应为 preSkip+样本数=' + (312 + expect48));
            if (!avOk) throw skip('PyAV 不可用，无法解码验证');
            const p = writeTmp('my_opus.opus', buf);
            const chk = py('oggcheck', [p]);
            assert(chk.ok, 'Python Ogg 检查失败');
            assert(chk.head.preSkip === 312 && chk.head.channels === 2 && chk.head.inputSampleRate === 44100,
                'Python 侧 OpusHead 字段不符: ' + JSON.stringify(chk.head));
            assert(chk.granuleMonotonic && chk.seqContiguous && chk.firstIsBos && chk.lastIsEos,
                'Python 侧结构检查失败');
            assert(chk.finalSamples === expect48, 'Python 侧最终样本数应为 ' + expect48 + '，实际 ' + chk.finalSamples);
            const dec = py('decode', [p, 440, 0.5]);
            assert(dec.sampleRate === 48000, '解码采样率应为 48000');
            assert(dec.channels === 2, '解码声道应为 2');
            assertClose(dec.frames, expect48, 960, '解码样本数应约等于 ' + expect48);
            assertClose(dec.duration, 0.5, 0.02, '时长应约 0.5s');
            const corr = dec.corr || {};
            assert(corr.corrBest > 0.95, '波形相关度应 >0.95，实际 ' + corr.corrBest);
            return pages.length + ' 页 / ' + packets.length + ' 包；granule=' + (312 + expect48) +
                '；PyAV 解码 ' + dec.frames + ' 样本/' + dec.duration.toFixed(4) + 's corr=' +
                corr.corrBest.toFixed(5) + ' lag=' + corr.lag;
        });
    });

    await T('Ogg Opus 48000Hz 输入（无需重采样 + frameDuration 校验）', async () => {
        if (!opusRef) throw skip('缺少 Opus 参考包');
        const st = {};
        const fake = makeFakeWebCodecs({ frames: opusRef.packets, samplesPerFrame: 960, state: st });
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        const chans = sine(2, 48000, 440, 0.5, 0.5);
        /* 故意传非法 frameDuration（非 2500 倍数），应回退到 20000 并记 note */
        const u8 = await sb.AudioEnc.oggOpus(chans, 48000, { bitrate: 96000, frameDuration: 1234 });
        const buf = Buffer.from(u8);
        const meta = u8.meta;
        assert(st.configured.sampleRate === 48000, 'Opus 配置采样率必须为 48000');
        assert(st.configured.opus && st.configured.opus.frameDuration === 20000,
            '非法 frameDuration 应回退为 20000us，实际 ' + JSON.stringify(st.configured.opus));
        assert(meta.frameDuration === 20000 && meta.resampled === false, 'meta.frameDuration/resampled 错误');
        assert(meta.notes.some(s => /frameDuration/.test(s)), 'notes 应说明 frameDuration 回退');
        assert(st.encodedSamples === 24000, '48k 输入 0.5s 应为 24000 样本，实际 ' + st.encodedSamples);
        const { pages, packets } = parseOgg(buf);
        assert(pages[0].headerType === 2 && (pages[pages.length - 1].headerType & 4), 'BOS/EOS 错误');
        assert(packets[0].readUInt32LE(12) === 48000, 'OpusHead 输入采样率应为 48000');
        assert(packets.length === opusRef.packets.length + 2, '包数错误');
        for (let i = 2; i < packets.length; i++) {
            assert(packets[i].equals(opusRef.packets[i - 2]), '第' + (i - 2) + '个 Opus 包不一致');
        }
        assert(pages[pages.length - 1].granule === 312 + 24000,
            '末页 granule 应为 24312，实际 ' + pages[pages.length - 1].granule);
        const p = writeTmp('opus_48000.opus', buf);
        const chk = py('oggcheck', [p]);
        assert(chk.finalSamples === 24000, 'Python 侧最终样本数应为 24000，实际 ' + chk.finalSamples);
        assert(chk.granuleMonotonic && chk.seqContiguous && chk.firstIsBos && chk.lastIsEos &&
            chk.head.preSkip === 312, 'Python 侧结构检查失败');
        const dec = py('decode', [p, 440, 0.5]);
        assert(dec.sampleRate === 48000 && dec.channels === 2, '解码参数错误');
        assertClose(dec.duration, 0.5, 0.02, '解码时长应约 0.5s');
        assert(dec.corr.corrBest > 0.95, '相关度应 >0.95，实际 ' + dec.corr.corrBest);
        return pages.length + ' 页 / ' + packets.length + ' 包；granule=24312；解码 ' +
            dec.frames + ' 样本 corr=' + dec.corr.corrBest.toFixed(5) + ' ✓';
    });

    await T('Ogg Opus 末页裁剪（granule 截断到实际输入长度）', () => {
        if (!opusRef) throw skip('缺少 Opus 参考包');
        const st = {};
        const fake = makeFakeWebCodecs({ frames: opusRef.packets, samplesPerFrame: 960, state: st });
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        /* 16kHz 输入 0.2s -> 9600 样本@48k，而参考包共 26*960=24960 样本，靠 granule 裁剪 */
        const chans = sine(2, 16000, 440, 0.5, 0.2);
        return sb.AudioEnc.oggOpus(chans, 16000, { bitrate: 96000 }).then(u8 => {
            const buf = Buffer.from(u8);
            const expect48 = Math.round(chans[0].length * 48000 / 16000);
            const { packets } = parseOgg(buf);
            const head = packets[0];
            assert(head.readUInt32LE(12) === 16000, 'OpusHead 应记录 16000');
            const chk = py('oggcheck', [writeTmp('trim.opus', buf)]);
            assert(chk.finalSamples === expect48,
                '最终样本数应为 ' + expect48 + '（裁剪后），实际 ' + chk.finalSamples);
            const dec = py('decode', [path.join(TMP_DIR, 'trim.opus'), 440, 0.5]);
            assertClose(dec.duration, 0.2, 0.02, '裁剪后时长应约 0.2s');
            return '16kHz→48kHz，granule 裁剪到 ' + chk.finalSamples + ' 样本，解码时长 ' +
                dec.duration.toFixed(4) + 's ✓';
        });
    });

    /* ---------------- T9: 错误路径与能力探测 ---------------- */
    await T('无 WebCodecs 时 aac/oggOpus 中文报错', () => {
        const sb = loadSandbox(); /* Node 下无 AudioEncoder */
        assert(sb.AudioEnc.hasWebCodecs() === false, 'Node 下 hasWebCodecs 应为 false');
        const chans = sine(1, 44100, 440, 0.3, 0.1);
        return sb.AudioEnc.aac(chans, 44100, {}).then(() => {
            throw new Error('aac 应被 reject');
        }, e => {
            /* 注意：错误对象由沙箱 realm 创建，不能依赖 instanceof Error */
            assert(e && typeof e.message === 'string', '应抛出带 message 的错误对象');
            assert(/WebCodecs/.test(e.message), '错误信息应提到 WebCodecs: ' + e.message);
            assert(/[^\x00-\xff]/.test(e.message), '错误信息应为中文');
            return sb.AudioEnc.oggOpus(chans, 44100, {}).then(() => {
                throw new Error('oggOpus 应被 reject');
            }, e2 => {
                assert(e2 && typeof e2.message === 'string', 'oggOpus 应抛出带 message 的错误');
                assert(/WebCodecs/.test(e2.message), 'oggOpus 错误信息应提到 WebCodecs');
                assert(/[^\x00-\xff]/.test(e2.message), 'oggOpus 错误信息应为中文');
                return 'aac/oggOpus 均中文 reject ✓';
            });
        });
    });

    await T('support() 能力探测（Node 无 WebCodecs）', () => {
        return AE.support().then(r => {
            assert(r.webcodecs === false, 'webcodecs 应为 false');
            assert(r.aac === false && r.opus === false && r.flac === false, 'AAC/Opus/FLAC 应为 false');
            assert(r.mp3 === true, '有 lamejs 时 mp3 应为 true');
            assert(r.lamejs === true, 'lamejs 标志应为 true');
            return JSON.stringify({ aac: r.aac, opus: r.opus, flac: r.flac, mp3: r.mp3, webcodecs: r.webcodecs });
        });
    });

    await T('WebCodecs 不受支持时 aac 抛中文错误', () => {
        const st = {};
        const fake = makeFakeWebCodecs({ frames: [Buffer.alloc(10)], samplesPerFrame: 1024, state: st, unsupported: true });
        const sb = loadSandbox({ AudioEncoder: fake.Encoder, AudioData: fake.AudioData });
        return sb.AudioEnc.aac(sine(1, 44100, 440, 0.3, 0.1), 44100, {}).then(() => {
            throw new Error('应 reject');
        }, e => {
            assert(/不支持|不受支持/.test(e.message), '错误信息应说明不支持: ' + e.message);
            return 'isConfigSupported 全 false -> 中文 reject ✓';
        });
    });

    /* ---------------- T10: 重采样 ---------------- */
    await T('重采样（44.1k→48k 三次插值精度）', () => {
        const n = 4410;
        const src = [new Float32Array(n)];
        for (let i = 0; i < n; i++) src[0][i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100);
        const out = AE.resample(src, 44100, 48000);
        const n2 = out[0].length;
        assert(n2 === Math.round(n * 48000 / 44100), '输出长度错误: ' + n2);
        let maxErr = 0;
        for (let i = 20; i < n2 - 20; i++) {
            const exp = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
            maxErr = Math.max(maxErr, Math.abs(out[0][i] - exp));
        }
        assert(maxErr < 2e-3, '重采样误差过大: ' + maxErr);
        /* 立体声 + 恒等 + 大比例降采样 */
        const st2 = AE.resample([src[0], src[0]], 44100, 48000);
        assert(st2.length === 2 && st2[1].length === n2, '立体声重采样错误');
        const same = AE.resample(src, 44100, 44100);
        assert(same[0] === src[0], '同采样率应原样返回');
        const down = AE.resample(src, 96000, 44100);
        assert(down[0].length === Math.round(n * 44100 / 96000), '降采样长度错误');
        return '48k 输出 ' + n2 + ' 样本，最大误差 ' + maxErr.toExponential(2) + ' ✓';
    });

    /* ---------------- 汇总 ---------------- */
    const pass = results.filter(r => r.ok === true).length;
    const fail = results.filter(r => r.ok === false).length;
    const skipped = results.filter(r => r.ok === 'SKIP').length;
    console.log('------------------------------------------------------------');
    console.log(' 合计 ' + results.length + ' 项: PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skipped);
    console.log(' WAV 实际写入 ' + wavCount + ' 个文件；产物目录 ' + TMP_DIR);
    if (fail > 0) {
        console.log(' 失败项:');
        results.filter(r => r.ok === false).forEach(r => console.log('   ✗ ' + r.name + ' :: ' + r.detail));
    }
    const report = {
        when: new Date().toISOString(),
        node: process.version,
        moduleVersion: AE && AE.version,
        results: results
    };
    fs.writeFileSync(path.join(TMP_DIR, 'test-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(' 报告已写出: ' + path.join(TMP_DIR, 'test-report.json'));
    console.log('============================================================');
    return fail === 0;
}

main().then(ok => {
    process.exitCode = ok ? 0 : 1;
}).catch(e => {
    console.error('测试脚本异常终止:', e && e.stack || e);
    process.exitCode = 1;
});
