#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flac-check.py —— FlacEncoder-JS 输出的 FLAC 逐样本无损校验
===============================================================================

依赖：
    pip install soundfile numpy

用法：
    python flac-check.py            # 校验 out/manifest.json 里登记的全部用例
    python flac-check.py --no-deep  # 只做 soundfile 比对，跳过内置解析器

校验内容（两条完全独立的路径）：

  A. 内置 FLAC 解析器（纯 Python 实现，不依赖任何音频库）
     - "fLaC" 标记、元数据块链、STREAMINFO 各字段
     - 逐帧：帧同步码、保留位、blocking strategy、块长/采样率/声道/位深编码、
       UTF-8 帧号、帧头 CRC-8、帧尾 CRC-16
     - 逐子帧：CONSTANT / VERBATIM / FIXED(0..4) / LPC(1..32)、wasted bits、
       分区 Rice（4bit / 5bit 参数，含 escaped partition）
     - 还原声道间去相关（independent / left-side / side-right / mid-side）
     - 用解码出的 PCM 重算 MD5，与 STREAMINFO 中记录的值比对
     - 与 .raw（编码器内部实际量化的整数 PCM）逐样本精确比对

  B. soundfile（libsndfile 背后的 libFLAC 解码器）
     - 解码后与 .raw 逐样本精确比对；24bit 同时用 int32 与 float64 两种读法

任何一处不一致都会以非 0 退出码结束。
===============================================================================
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# ============================================================================
# CRC 表
# ============================================================================

def _mk_crc8():
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if (c & 0x80) else ((c << 1) & 0xFF)
        t.append(c)
    return t


def _mk_crc16():
    t = []
    for i in range(256):
        c = i << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x8005) & 0xFFFF if (c & 0x8000) else ((c << 1) & 0xFFFF)
        t.append(c)
    return t


CRC8 = _mk_crc8()
CRC16 = _mk_crc16()


def crc8(data, start, end):
    c = 0
    for i in range(start, end):
        c = CRC8[c ^ data[i]]
    return c


def crc16(data, start, end):
    c = 0
    for i in range(start, end):
        c = ((c << 8) & 0xFFFF) ^ CRC16[((c >> 8) ^ data[i]) & 0xFF]
    return c


# ============================================================================
# 位读取器
# ============================================================================

class BitReader(object):
    __slots__ = ('d', 'p', 'b')

    def __init__(self, data, bitpos=0):
        self.d = data
        self.p = bitpos >> 3
        self.b = bitpos & 7

    def read(self, n):
        v = 0
        d, p, b = self.d, self.p, self.b
        while n > 0:
            take = 8 - b
            if take > n:
                take = n
            v = (v << take) | ((d[p] >> (8 - b - take)) & ((1 << take) - 1))
            b += take
            if b == 8:
                b = 0
                p += 1
            n -= take
        self.p, self.b = p, b
        return v

    def sread(self, n):
        v = self.read(n)
        if v >= (1 << (n - 1)):
            v -= (1 << n)
        return v

    def unary(self):
        """数 0 的个数，直到遇到 1（逐字节加速）"""
        c = 0
        d, p, b = self.d, self.p, self.b
        while True:
            rem = d[p] & ((1 << (8 - b)) - 1)
            if rem:
                z = 8 - b - rem.bit_length()
                b += z + 1
                if b >= 8:
                    b -= 8
                    p += 1
                self.p, self.b = p, b
                return c + z
            c += 8 - b
            p += 1
            b = 0

    def bitpos(self):
        return self.p * 8 + self.b


class FlacError(Exception):
    pass


# ============================================================================
# 常量表
# ============================================================================

BS_TAB = {1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608,
          8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192,
          14: 16384, 15: 32768}
SR_TAB = {1: 88200, 2: 176400, 3: 192000, 4: 8000, 5: 16000, 6: 22050,
          7: 24000, 8: 32000, 9: 44100, 10: 48000, 11: 96000}
BPS_TAB = {1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32}


# ============================================================================
# FLAC 解码器
# ============================================================================

def _parse_metadata(data):
    if data[0:4] != b'fLaC':
        raise FlacError('缺少 fLaC 标记')
    pos = 4
    blocks = []
    while True:
        if pos + 4 > len(data):
            raise FlacError('元数据块截断')
        h = data[pos]
        last = h >> 7
        typ = h & 0x7F
        if typ == 127:
            raise FlacError('元数据类型 127 被禁止')
        ln = int.from_bytes(data[pos + 1:pos + 4], 'big')
        body = data[pos + 4:pos + 4 + ln]
        if len(body) != ln:
            raise FlacError('元数据块长度越界')
        blocks.append((typ, body))
        pos += 4 + ln
        if last:
            break
    if not blocks or blocks[0][0] != 0:
        raise FlacError('第一个元数据块必须是 STREAMINFO')
    if len(blocks[0][1]) != 34:
        raise FlacError('STREAMINFO 长度应为 34')
    return blocks, pos


def _parse_streaminfo(body):
    si = {}
    si['min_block'] = int.from_bytes(body[0:2], 'big')
    si['max_block'] = int.from_bytes(body[2:4], 'big')
    si['min_frame'] = int.from_bytes(body[4:7], 'big')
    si['max_frame'] = int.from_bytes(body[7:10], 'big')
    si['sample_rate'] = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4)
    si['channels'] = ((body[12] >> 1) & 0x07) + 1
    si['bps'] = (((body[12] & 0x01) << 4) | (body[13] >> 4)) + 1
    si['total'] = ((body[13] & 0x0F) << 32) | int.from_bytes(body[14:18], 'big')
    si['md5'] = bytes(body[18:34])
    return si


def _decode_subframe(br, bs, bps):
    """解一个子帧，返回 (样本数组, 类型描述串)"""
    if br.read(1) != 0:
        raise FlacError('子帧头首位必须为 0')
    stype = br.read(6)
    wasted = 0
    if br.read(1):
        wasted = br.unary() + 1
    bps -= wasted
    if bps <= 0:
        raise FlacError('子帧位深 <= 0')

    if stype == 0:                                   # CONSTANT
        out = np.full(bs, br.sread(bps), dtype=np.int64)
        kind = 'CONSTANT'
    elif stype == 1:                                 # VERBATIM
        out = np.array([br.sread(bps) for _ in range(bs)], dtype=np.int64)
        kind = 'VERBATIM'
    elif 8 <= stype <= 12:                           # FIXED
        order = stype - 8
        warm = [br.sread(bps) for _ in range(order)]
        res, po = _decode_residual(br, bs, order)
        out = _restore_fixed(warm, res, order, bs)
        kind = 'FIXED%d' % order
    elif stype >= 32:                                # LPC
        order = (stype & 0x1F) + 1
        warm = [br.sread(bps) for _ in range(order)]
        prec = br.read(4) + 1
        if prec == 16:
            raise FlacError('LPC 系数精度 16 被禁止')
        shift = br.sread(5)
        if shift < 0:
            raise FlacError('LPC shift 为负')
        coefs = [br.sread(prec) for _ in range(order)]
        res, po = _decode_residual(br, bs, order)
        out = _restore_lpc(warm, res, coefs, shift, order, bs)
        kind = 'LPC%d/prec%d' % (order, prec)
    else:
        raise FlacError('保留的子帧类型 %d' % stype)

    if wasted:
        out = out << wasted
    return out, kind


def _decode_residual(br, bs, order):
    method = br.read(2)
    if method > 1:
        raise FlacError('保留的残差编码方法 %d' % method)
    po = br.read(4)
    nparts = 1 << po
    if bs % nparts != 0:
        raise FlacError('块长不能被分区数整除')
    psize = bs // nparts
    if psize <= order:
        raise FlacError('分区样本数 <= 预测阶数')
    pb = 5 if method == 1 else 4
    esc = (1 << pb) - 1
    out = []
    for pi in range(nparts):
        cnt = psize - order if pi == 0 else psize
        k = br.read(pb)
        if k == esc:                                  # escaped partition
            raw = br.read(5)
            if raw == 0:
                out.extend([0] * cnt)
            else:
                out.extend(br.sread(raw) for _ in range(cnt))
        elif k == 0:
            for _ in range(cnt):
                u = br.unary()
                out.append((u >> 1) ^ -(u & 1))
        else:
            for _ in range(cnt):
                q = br.unary()
                u = (q << k) | br.read(k)
                out.append((u >> 1) ^ -(u & 1))
    if len(out) != bs - order:
        raise FlacError('残差样本数不正确')
    return out, po


def _restore_fixed(warm, res, order, bs):
    out = np.empty(bs, dtype=np.int64)
    for i in range(order):
        out[i] = warm[i]
    if order == 0:
        out[:] = res
    elif order == 1:
        for i in range(1, bs):
            out[i] = res[i - 1] + out[i - 1]
    elif order == 2:
        for i in range(2, bs):
            out[i] = res[i - 2] + 2 * out[i - 1] - out[i - 2]
    elif order == 3:
        for i in range(3, bs):
            out[i] = res[i - 3] + 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]
    elif order == 4:
        for i in range(4, bs):
            out[i] = (res[i - 4] + 4 * out[i - 1] - 6 * out[i - 2] +
                      4 * out[i - 3] - out[i - 4])
    else:
        raise FlacError('固定预测阶数 %d 非法' % order)
    return out


def _restore_lpc(warm, res, coefs, shift, order, bs):
    out = np.empty(bs, dtype=np.int64)
    for i in range(order):
        out[i] = warm[i]
    for i in range(order, bs):
        s = 0
        for j in range(order):
            s += coefs[j] * int(out[i - 1 - j])
        out[i] = res[i - order] + (s >> shift)
    return out


def decode_flac(data):
    """纯 Python 解码整条 FLAC 流，返回 (streaminfo, pcm[int64, (帧, 声道)], 统计)"""
    blocks, pos = _parse_metadata(data)
    si = _parse_streaminfo(blocks[0][1])

    nch = si['channels']
    fbps = si['bps']
    stats = {'frames': 0, 'crc8': 0, 'crc16': 0,
             'subframes': {}, 'chan_assign': {}}
    frames = []

    while pos < len(data):
        fstart = pos
        if pos + 5 > len(data):
            raise FlacError('帧头截断')
        if data[pos] != 0xFF or (data[pos + 1] & 0xFE) != 0xF8:
            raise FlacError('帧同步码错误 @%d' % pos)
        if data[pos + 1] & 0x02:
            raise FlacError('同步码后的保留位必须为 0')
        blocking = data[pos + 1] & 1
        if blocking != 0:
            raise FlacError('本编码器应输出定长块（blocking strategy=0）')

        bs_code = data[pos + 2] >> 4
        sr_code = data[pos + 2] & 0x0F
        ch_code = data[pos + 3] >> 4
        bps_code = (data[pos + 3] >> 1) & 0x07
        if data[pos + 3] & 1:
            raise FlacError('帧头第 4 字节最低位必须为 0')
        if sr_code == 0x0F:
            raise FlacError('采样率编码 0b1111 被禁止')

        q = pos + 4
        # UTF-8 变长帧号/样本号
        c = data[q]
        if c < 0x80:
            num = c
            q += 1
        else:
            ncont = 0
            m = 0x40
            while c & m:
                ncont += 1
                m >>= 1
            if ncont < 1 or ncont > 6:
                raise FlacError('UTF-8 帧号长度非法')
            mask = (1 << (7 - ncont)) - 1
            num = c & mask
            for _ in range(ncont):
                if (data[q] & 0xC0) != 0x80:
                    raise FlacError('UTF-8 帧号延续字节非法')
                num = (num << 6) | (data[q] & 0x3F)
                q += 1
            q += 1

        if bs_code == 6:
            bs = data[q] + 1
            q += 1
        elif bs_code == 7:
            bs = int.from_bytes(data[q:q + 2], 'big') + 1
            q += 2
        elif bs_code in BS_TAB:
            bs = BS_TAB[bs_code]
        else:
            raise FlacError('保留的 block size 编码 %d' % bs_code)

        if sr_code == 12:
            q += 1
        elif sr_code in (13, 14):
            q += 2

        # 帧头 CRC-8
        if crc8(data, fstart, q) != data[q]:
            raise FlacError('帧头 CRC-8 校验失败 @%d' % fstart)
        stats['crc8'] += 1
        q += 1

        # 子帧
        br = BitReader(data, q * 8)
        if ch_code == 0:
            nsub = 1
        elif ch_code <= 7:
            nsub = ch_code + 1
        else:
            nsub = 2
        if nsub != nch:
            raise FlacError('帧内子帧数 %d 与 STREAMINFO 声道数 %d 不一致' % (nsub, nch))
        stats['chan_assign'][ch_code] = stats['chan_assign'].get(ch_code, 0) + 1

        subs = []
        for ci in range(nsub):
            sbps = fbps
            if (ch_code == 8 and ci == 1) or (ch_code == 9 and ci == 0) or \
               (ch_code == 10 and ci == 1):
                sbps += 1
            sub, kind = _decode_subframe(br, bs, sbps)
            subs.append(sub)
            stats['subframes'][kind] = stats['subframes'].get(kind, 0) + 1

        # 子帧之后补 0 到字节边界
        body_end = (br.bitpos() + 7) // 8

        # 帧尾 CRC-16
        if body_end + 2 > len(data):
            raise FlacError('帧尾截断')
        got = (data[body_end] << 8) | data[body_end + 1]
        want = crc16(data, fstart, body_end)
        if got != want:
            raise FlacError('帧 CRC-16 校验失败 @%d (got %04x want %04x)' % (fstart, got, want))
        stats['crc16'] += 1
        pos = body_end + 2

        # 声道去相关
        if ch_code == 0:
            chans = subs
        elif ch_code == 1:
            chans = subs
        elif ch_code == 8:                 # left-side
            left, side = subs
            chans = [left, left - side]
        elif ch_code == 9:                 # side-right
            side, right = subs
            chans = [right + side, right]
        elif ch_code == 10:                # mid-side
            mid, side = subs
            mid2 = (mid << 1) | (side & 1)
            chans = [(mid2 + side) >> 1, (mid2 - side) >> 1]
        else:                              # independent
            chans = subs

        frames.append(np.stack(chans, axis=1))
        stats['frames'] += 1

    if not frames:
        raise FlacError('没有任何音频帧')
    pcm = np.concatenate(frames, axis=0)
    if si['total'] and pcm.shape[0] != si['total']:
        raise FlacError('解出 %d 个样本，STREAMINFO 记录 %d' % (pcm.shape[0], si['total']))
    lim = 1 << (fbps - 1)
    if pcm.size and (pcm.max() >= lim or pcm.min() < -lim):
        raise FlacError('解出的样本超出 %d bit 范围' % fbps)
    return si, pcm, stats


# ============================================================================
# 参考 PCM
# ============================================================================

def read_raw(path, bit_depth, nch):
    """把 .raw（小端有符号、16bit=2字节 / 24bit=3字节）读成 (帧, 声道) 的 int32"""
    raw = open(path, 'rb').read()
    bps = bit_depth // 8
    expect = None
    if bit_depth == 16:
        v = np.frombuffer(raw, dtype='<i2').astype(np.int64)
    else:
        b = np.frombuffer(raw, dtype=np.uint8)
        if b.size % 3:
            raise ValueError('raw 长度不是 3 的倍数')
        b = b.reshape(-1, 3)
        v = (b[:, 0].astype(np.int64) |
             (b[:, 1].astype(np.int64) << 8) |
             (b[:, 2].astype(np.int64) << 16))
        v = np.where(v >= (1 << 23), v - (1 << 24), v)
    expect = nch
    if v.size % nch:
        raise ValueError('raw 样本数不是声道数的整数倍')
    return v.reshape(-1, nch)


def pcm_to_md5(pcm, bit_depth):
    """按 FLAC 规范算未编码 PCM 的 MD5（交错、小端、有符号、按字节对齐）"""
    import hashlib
    if bit_depth == 16:
        buf = pcm.astype('<i2').tobytes()
    else:
        i32 = pcm.astype('<i4')
        buf = i32.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    return hashlib.md5(buf).hexdigest()


# ============================================================================
# 主流程
# ============================================================================

class Report(object):
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.msgs = []

    def ok(self, name, detail=''):
        self.passed += 1
        self.msgs.append(('PASS', name, detail))

    def fail(self, name, detail):
        self.failed += 1
        self.msgs.append(('FAIL', name, detail))


def check_soundfile(path, ref, bit_depth, nch, sr):
    """用 soundfile（libsndfile + libFLAC）解码并逐样本比对"""
    import soundfile as sf
    info = sf.info(path)
    if info.channels != nch:
        return '声道数 %d != %d' % (info.channels, nch)
    if info.samplerate != sr:
        return '采样率 %d != %d' % (info.samplerate, sr)
    if info.frames != ref.shape[0]:
        return '样本数 %d != %d' % (info.frames, ref.shape[0])
    want_sub = {16: 'PCM_16', 24: 'PCM_24'}[bit_depth]
    if info.subtype != want_sub:
        return '子类型 %s != %s' % (info.subtype, want_sub)

    if bit_depth == 16:
        d, rate = sf.read(path, dtype='int16', always_2d=True)
        got = d.astype(np.int64)
        if not np.array_equal(got, ref):
            diff = int(np.abs(got - ref).max())
            return 'soundfile(int16) 样本不一致，最大误差 %d' % diff
    else:
        d32, rate = sf.read(path, dtype='int32', always_2d=True)
        # soundfile 把 24bit 左对齐到 int32（v<<8）
        if not np.all(d32 % 256 == 0):
            return 'soundfile(int32) 数值不是 256 的整数倍，缩放约定不符'
        got = (d32 >> 8).astype(np.int64)
        if not np.array_equal(got, ref):
            diff = int(np.abs(got - ref).max())
            return 'soundfile(int32) 样本不一致，最大误差 %d' % diff
        # 再用 float64 交叉验证一次
        df, _ = sf.read(path, dtype='float64', always_2d=True)
        if not np.array_equal(df, ref / float(1 << 23)):
            return 'soundfile(float64) 样本不一致'
    return None


def main():
    no_deep = '--no-deep' in sys.argv
    man_path = os.path.join(HERE, 'out', 'manifest.json')
    if not os.path.exists(man_path):
        print('找不到 %s，请先运行:  node flac-test.js' % man_path)
        return 2

    manifest = json.load(open(man_path, encoding='utf-8'))
    cases = manifest['cases']
    rep = Report()

    print('')
    print('=' * 70)
    print(' FlacEncoder-JS  逐样本无损校验 (flac-check.py)')
    print(' numpy %s / soundfile %s' % (np.__version__, _sf_version()))
    print(' 用例 %d 个' % len(cases))
    print('=' * 70)
    print('')

    total_frames = 0
    total_crc8 = 0
    total_crc16 = 0
    subframe_stats = {}
    assign_stats = {}

    for case in cases:
        name = case['name']
        bd = case['bitDepth']
        nch = case['channels']
        sr = case['sampleRate']
        try:
            ref = read_raw(case['raw'], bd, nch)
        except Exception as e:
            rep.fail(name, '读取参考 PCM 失败: %s' % e)
            continue
        if ref.shape[0] != case['frames']:
            rep.fail(name, '参考 PCM 样本数 %d != %d' % (ref.shape[0], case['frames']))
            continue

        msgs = []

        # ---------- A. 内置解析器 ----------
        if case.get('deep', True) and not no_deep:
            try:
                data = open(case['flac'], 'rb').read()
                si, pcm, stats = decode_flac(data)
                total_frames += stats['frames']
                total_crc8 += stats['crc8']
                total_crc16 += stats['crc16']
                for k, v in stats['subframes'].items():
                    if k:
                        subframe_stats[k] = subframe_stats.get(k, 0) + v
                for k, v in stats['chan_assign'].items():
                    assign_stats[k] = assign_stats.get(k, 0) + v

                if si['sample_rate'] != sr:
                    msgs.append('解析器: 采样率 %d != %d' % (si['sample_rate'], sr))
                if si['channels'] != nch:
                    msgs.append('解析器: 声道数 %d != %d' % (si['channels'], nch))
                if si['bps'] != bd:
                    msgs.append('解析器: 位深 %d != %d' % (si['bps'], bd))
                if si['total'] != case['frames']:
                    msgs.append('解析器: 总样本数 %d != %d' % (si['total'], case['frames']))
                if si['min_block'] > si['max_block']:
                    msgs.append('解析器: minBlockSize > maxBlockSize')
                if si['min_block'] < 16 or si['max_block'] < 16:
                    msgs.append('解析器: block size 越界')
                if pcm.shape != ref.shape:
                    msgs.append('解析器: 形状 %s != %s' % (pcm.shape, ref.shape))
                else:
                    bad = int(np.count_nonzero(pcm != ref))
                    if bad:
                        idx = np.argwhere(pcm != ref)[0]
                        msgs.append('解析器: %d 个样本不一致，首个 @%s got=%d want=%d' %
                                    (bad, tuple(idx), pcm[tuple(idx)], ref[tuple(idx)]))
                md5_got = pcm_to_md5(pcm, bd)
                if md5_got != si['md5'].hex():
                    msgs.append('解析器: 解码 PCM 的 MD5 %s != STREAMINFO %s' %
                                (md5_got, si['md5'].hex()))
                if md5_got != case['md5']:
                    msgs.append('解析器: MD5 与 manifest 记录不一致')
            except Exception as e:
                msgs.append('解析器异常: %s' % e)

        # ---------- B. soundfile ----------
        try:
            err = check_soundfile(case['flac'], ref, bd, nch, sr)
            if err:
                msgs.append(err)
        except Exception as e:
            msgs.append('soundfile 异常: %s' % e)

        if msgs:
            rep.fail(name, ' | '.join(msgs))
        else:
            rep.ok(name, '%d 样本 × %d 声道' % (ref.shape[0], nch))

    # ---------- 输出 ----------
    for status, name, detail in rep.msgs:
        if status == 'FAIL':
            print('  FAIL  %-28s %s' % (name, detail))
    if rep.failed:
        print('')
    print('  %-24s %s' % ('校验方式', '结果'))
    print('  ' + '-' * 60)
    print('  %-24s %d' % ('用例通过', rep.passed))
    print('  %-24s %d' % ('用例失败', rep.failed))
    if not no_deep:
        print('  %-24s %d' % ('检查的帧数', total_frames))
        print('  %-24s %d  全部正确' % ('帧头 CRC-8', total_crc8))
        print('  %-24s %d  全部正确' % ('帧尾 CRC-16', total_crc16))
        if subframe_stats:
            kinds = ', '.join('%s×%d' % (k, v) for k, v in sorted(subframe_stats.items(),
                                                                 key=lambda x: -x[1]))
            print('  %-24s %s' % ('子帧类型分布', kinds[:220]))
        if assign_stats:
            names = {0: 'mono', 1: 'LR独立', 2: '3ch独立', 3: '4ch独立', 4: '5ch独立',
                     5: '6ch独立', 6: '7ch独立', 7: '8ch独立',
                     8: 'left-side', 9: 'side-right', 10: 'mid-side'}
            txt = ', '.join('%s×%d' % (names.get(k, str(k)), v)
                            for k, v in sorted(assign_stats.items()))
            print('  %-24s %s' % ('声道分配', txt))
    print('')
    if rep.failed:
        print('  结论：存在失败项')
        return 1
    print('  结论：全部用例逐样本完全一致（误差 0）')
    return 0


def _sf_version():
    try:
        import soundfile
        return soundfile.__version__
    except Exception:
        return '(未安装)'


if __name__ == '__main__':
    sys.exit(main())
