(async () => {
  const R = { checks: [], errors: [] };
  const ok = (name, cond, extra) => R.checks.push({ name, pass: !!cond, extra: extra === undefined ? '' : extra });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const q = s => document.querySelector(s);

  function mkChans(rate, dur, ch) {
    const n = Math.round(rate * dur), out = [];
    for (let c = 0; c < ch; c++) {
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) d[i] = 0.45 * Math.sin(2 * Math.PI * (440 + c * 13) * i / rate);
      out.push(d);
    }
    return out;
  }
  async function decodeDur(bytes) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let dur = null, err = null, sr = null, ch = null;
    const ctx = new AudioContext();
    try {
      const b = await ctx.decodeAudioData(ab);
      dur = b.duration; sr = b.sampleRate; ch = b.numberOfChannels;
    } catch (e) { err = String((e && e.message) || e); }
    try { await ctx.close(); } catch (e) { }
    return { dur, err, sr, ch };
  }

  try {
    /* ---------- 0. 六个面板回归 ---------- */
    for (const k of ['voucher', 'compress', 'convert', 'cdr', 'audio', 'video', 'code']) {
      document.querySelector(`.fn-btn[data-panel=${k}]`).click();
      await sleep(40);
      ok('面板切换 ' + k, document.querySelectorAll('.panel.active').length === 1 && document.getElementById('panel-' + k).classList.contains('active'));
    }

    /* ---------- 1. 导航与模块 ---------- */
    const navs = [...document.querySelectorAll('.fn-btn')].map(b => b.dataset.panel);
    ok('导航按钮包含 audio/code', navs.includes('audio') && navs.includes('code'), navs.join(','));

    q('.fn-btn[data-panel=audio]').click();
    await sleep(60);
    ok('音频面板可激活', $('panel-audio').classList.contains('active'));
    ok('同一时间只有一个面板', document.querySelectorAll('.panel.active').length === 1);

    q('.fn-btn[data-panel=code]').click();
    await sleep(60);
    ok('二维码面板可激活', $('panel-code').classList.contains('active'));

    R.modules = {
      lamejs: typeof lamejs, CodeTools: typeof CodeTools,
      FlacEncoder: typeof FlacEncoder, AudioEnc: typeof AudioEnc
    };
    ok('模块加载', R.modules.lamejs !== 'undefined' && R.modules.CodeTools === 'object' && R.modules.FlacEncoder === 'object' && R.modules.AudioEnc === 'object', JSON.stringify(R.modules));

    if (window.AudioEnc && AudioEnc.support) {
      R.support = await AudioEnc.support();
    }

    /* ---------- 2. 音频编码往返 ---------- */
    const chans = mkChans(44100, 1.0, 2);
    async function tryFmt(name, fn) {
      try {
        const t0 = performance.now();
        const bytes = await fn();
        const ms = Math.round(performance.now() - t0);
        const dec = await decodeDur(bytes);
        const rec = { size: bytes.length, ms, dec };
        R['enc_' + name] = rec;
        ok(name + ' 编码非空', bytes && bytes.length > 500, bytes && bytes.length);
        ok(name + ' 可被浏览器解码', !dec.err, dec.err || '');
        ok(name + ' 时长≈1s', dec.dur !== null && dec.dur > 0.92 && dec.dur < 1.12, dec.dur);
        return bytes;
      } catch (e) {
        R['enc_' + name] = { error: String(e && e.stack || e) };
        ok(name + ' 编码成功', false, String(e && e.message || e));
      }
    }
    const wavBytes = await tryFmt('wav', () => AudioEnc.wav(chans, 44100, { bitDepth: 16 }));
    if (wavBytes) {
      const dv = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
      R.wavHeader = {
        riff: String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]),
        ch: dv.getUint16(22, true), sr: dv.getUint32(24, true), bits: dv.getUint16(34, true),
        dataLen: dv.getUint32(40, true)
      };
      ok('WAV 头部正确', R.wavHeader.riff === 'RIFF' && R.wavHeader.sr === 44100 && R.wavHeader.ch === 2 && R.wavHeader.bits === 16 && R.wavHeader.dataLen === 44100 * 4, JSON.stringify(R.wavHeader));
    }
    const flacBytes = await tryFmt('flac', () => FlacEncoder.encode(chans, 44100, { bitDepth: 16, compression: 5 }));
    if (flacBytes && wavBytes) ok('FLAC 比 WAV 小', flacBytes.length < wavBytes.length * 0.85, Math.round(flacBytes.length / wavBytes.length * 100) + '%');
    await tryFmt('mp3', () => AudioEnc.mp3(chans, 44100, { bitrate: 128 }));
    await tryFmt('mp3mono', () => AudioEnc.mp3(mkChans(22050, 1.0, 1), 22050, { bitrate: 64 }));
    if (!R.support || R.support.aac !== false) await tryFmt('aac', () => AudioEnc.aac(chans, 44100, { bitrate: 128000 }));
    if (!R.support || R.support.opus !== false) await tryFmt('ogg', () => AudioEnc.oggOpus(chans, 44100, { bitrate: 96000 }));

    /* ---------- 3. 二维码 ---------- */
    q('.fn-btn[data-panel=code]').click();
    q('#codeTabs [data-tab=qr]').click();
    await sleep(80);
    const qrText = 'https://example.com/轻办?x=1&y=2';
    const ta = $('qf_text');
    ta.value = qrText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    let cv = $('qrCanvas');
    R.qr = { w: cv.width, h: cv.height, bytes: $('qrBytes').textContent, version: $('qrVersion').textContent };
    let id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let qd = CodeTools.qr.decode(id);
    R.qr.decoded = qd && qd.text;
    ok('二维码生成后能解回原文（方块）', !!(qd && qd.ok && qd.text === qrText));
    ok('二维码画布尺寸合理', cv.width >= 128 && cv.width <= 2048, cv.width);

    q('#qrDotSeg [data-v=dot]').click();
    await sleep(350);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    ok('圆点样式二维码仍可识别', !!(qd && qd.ok && qd.text === qrText), qd && qd.text);

    q('#qrDotSeg [data-v=square]').click();
    const svgBtn = $('qrDownloadSvg');
    ok('二维码 SVG 导出可用', !!svgBtn && !svgBtn.disabled);

    /* ---------- 3.2 新增外观控件 ---------- */
    q('#qrFinderSeg [data-v=circle]').click();
    q('#qrDotSeg [data-v=diamond]').click();
    await sleep(380);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    ok('圆形定位点 + 菱形码点仍可识别', !!(qd && qd.ok && qd.text === qrText), qd && qd.text);

    q('#qrFinderSeg [data-v=round]').click();
    q('#qrDotSeg [data-v=round]').click();
    await sleep(350);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    ok('圆角定位点 + 圆角码点仍可识别', !!(qd && qd.ok && qd.text === qrText), qd && qd.text);

    $('qrGrad').checked = true;
    $('qrGrad').dispatchEvent(new Event('change', { bubbles: true }));
    q('#qrGradDir [data-v=h]').click();
    await sleep(380);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    ok('渐变前景二维码仍可识别', !!(qd && qd.ok && qd.text === qrText), qd && qd.text);

    q('#qrPresets [data-preset=invert]').click();
    await sleep(380);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    ok('反色预设二维码仍可识别', !!(qd && qd.ok && qd.text === qrText), qd && qd.text);

    q('#qrPresets [data-preset=classic]').click();
    await sleep(300);
    ok('风格预设可恢复经典配色', $('qrFg').value === '#2b2013' && $('qrGrad').checked === false);

    // 透明背景开关
    $('qrTransparent').checked = true;
    $('qrTransparent').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    const alphaCorner = $('qrCanvas').getContext('2d').getImageData(2, 2, 1, 1).data[3];
    ok('透明背景生效（角落 alpha=0）', alphaCorner === 0, alphaCorner);
    $('qrTransparent').checked = false;
    $('qrTransparent').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);

    // WiFi 载荷
    q('#qrTypeChips [data-type=wifi]').click();
    await sleep(80);
    const ssid = $('qf_ssid'), pwd = $('qf_pwd');
    ssid.value = 'LightWork;5G'; ssid.dispatchEvent(new Event('input', { bubbles: true }));
    pwd.value = 'p@ss:word'; pwd.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    R.qrWifi = qd && qd.text;
    ok('WiFi 二维码载荷转义正确', !!(qd && qd.ok && qd.text === 'WIFI:T:WPA;S:LightWork\\;5G;P:p@ss\\:word;;'), qd && qd.text);

    /* ---------- 3.5 带 Logo 的二维码 ---------- */
    q('#qrTypeChips [data-type=text]').click();
    await sleep(80);
    const t2 = $('qf_text');
    t2.value = 'LIGHTWORK 轻办 logo test';
    t2.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const lc = document.createElement('canvas'); lc.width = 64; lc.height = 64;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8890c'; lg.beginPath(); lg.arc(32, 32, 29, 0, Math.PI * 2); lg.fill();
    lg.fillStyle = '#fff'; lg.font = 'bold 30px sans-serif'; lg.textAlign = 'center'; lg.textBaseline = 'middle'; lg.fillText('轻', 32, 34);
    const lb = await new Promise(r => lc.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([lb], 'logo.png', { type: 'image/png' }));
    const logoIn = $('qrLogoInput');
    logoIn.files = dt.files;
    logoIn.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(700);
    cv = $('qrCanvas');
    id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    qd = CodeTools.qr.decode(id);
    R.qrLogo = { text: qd && qd.text, ecl: $('qrEclOut').textContent };
    ok('带 Logo 的二维码仍可识别', !!(qd && qd.ok && qd.text === 'LIGHTWORK 轻办 logo test'), qd && qd.text);
    ok('加 Logo 后自动切到 H 级纠错', $('qrEclOut').textContent === 'H', R.qrLogo.ecl);

    /* ---------- 4. 条形码 ---------- */
    q('#codeTabs [data-tab=bar]').click();
    await sleep(80);
    q('#barTypeChips [data-type=ean13]').click();
    await sleep(60);
    const bIn = $('barText');
    bIn.value = '690123456789';
    bIn.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    let bcv = $('barCanvas');
    R.ean = { w: bcv.width, h: bcv.height, text: $('barTextOut').textContent };
    let bid = bcv.getContext('2d').getImageData(0, 0, bcv.width, bcv.height);
    let bd = CodeTools.barcode.decode(bid);
    R.ean.decoded = bd && bd.text;
    ok('EAN-13 自动补校验位并解回', !!(bd && bd.ok && bd.text === '6901234567892'), bd && bd.text);

    q('#barTypeChips [data-type=code128]').click();
    await sleep(60);
    bIn.value = 'LIGHTWORK-2026';
    bIn.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    bcv = $('barCanvas');
    bid = bcv.getContext('2d').getImageData(0, 0, bcv.width, bcv.height);
    bd = CodeTools.barcode.decode(bid);
    ok('Code128 可生成并解回', !!(bd && bd.ok && bd.text === 'LIGHTWORK-2026'), bd && bd.text);

    /* ---------- 4.1 新增外观控件 ---------- */
    q('#barLabelPos [data-v=top]').click();
    $('barCaption').value = '¥199.00';
    $('barCaption').dispatchEvent(new Event('input', { bubbles: true }));
    q('#barBorderSeg [data-v=frame]').click();
    $('barQuiet').value = '4';
    $('barQuiet').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(320);
    bcv = $('barCanvas');
    bid = bcv.getContext('2d').getImageData(0, 0, bcv.width, bcv.height);
    bd = CodeTools.barcode.decode(bid);
    ok('上方文字 + 浅灰细框 + 窄静区仍可识别', !!(bd && bd.ok && bd.text === 'LIGHTWORK-2026'), bd && bd.text);
    ok('自定义文字不影响编码内容', $('barTextOut').textContent === 'LIGHTWORK-2026', $('barTextOut').textContent);

    q('#barBorderSeg [data-v=corner]').click();
    await sleep(300);
    bcv = $('barCanvas');
    bid = bcv.getContext('2d').getImageData(0, 0, bcv.width, bcv.height);
    bd = CodeTools.barcode.decode(bid);
    ok('四角标外框仍可识别', !!(bd && bd.ok && bd.text === 'LIGHTWORK-2026'), bd && bd.text);

    q('#barBorderSeg [data-v=none]').click();
    $('barQuiet').value = '10';
    $('barQuiet').dispatchEvent(new Event('input', { bubbles: true }));
    q('#barLabelPos [data-v=bottom]').click();
    $('barCaption').value = '';
    $('barCaption').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);

    // 非法输入
    q('#barTypeChips [data-type=ean13]').click();
    await sleep(60);
    bIn.value = '12345';
    bIn.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    ok('非法 EAN 输入提示错误', $('barWarn').classList.contains('hidden') === false, $('barWarn').textContent);

    /* ---------- 5. 解码面板可用性 ---------- */
    q('#codeTabs [data-tab=dec]').click();
    await sleep(60);
    ok('扫码识别面板可打开', $('codeDec').classList.contains('hidden') === false);

    /* ---------- 6. 音频面板完整流程 ---------- */
    q('.fn-btn[data-panel=audio]').click();
    await sleep(80);
    const convSrc = AudioEnc.wav(mkChans(44100, 2.0, 2), 44100, { bitDepth: 16 });
    AudioPanel.addFiles([new File([convSrc], 'ui-test.wav', { type: 'audio/wav' })]);
    await sleep(900);
    const itA = AudioPanel.getItems()[0];
    R.uiDecode = itA ? { name: itA.name, decoded: !!itA.buffer, rate: itA.srcRate, dur: itA.dur, err: itA.err || '' } : null;
    ok('面板可添加并解码文件', !!(itA && itA.buffer && itA.srcRate === 44100), JSON.stringify(R.uiDecode));

    AudioPanel.state.fmt = 'mp3';
    AudioPanel.state.brIdx = 10;
    AudioPanel.state.ch = 1;
    $('auStart').click();
    for (let i = 0; i < 100; i++) { await sleep(200); const it = AudioPanel.getItems()[0]; if (it && (it.result || it.err)) break; }
    const it0 = AudioPanel.getItems()[0];
    R.uiResult = it0 && it0.result ? { name: it0.result.name, size: it0.result.size, fmt: it0.result.fmt } : null;
    await sleep(400);
    ok('UI 一键转换产出 MP3', !!(it0 && it0.result && it0.result.size > 5000), JSON.stringify(R.uiResult || (it0 && it0.err)));
    ok('转换后统计已更新', $('auSumDone').textContent === '1', $('auSumDone').textContent + '/' + $('auSumOut').textContent);
    ok('下载按钮已启用', $('auZip').disabled === false);

    /* ---------- 6.1 打包与图片导出 ---------- */
    if (it0 && it0.result) {
      const zipBytes = CDREngine.makeZipFromFiles([{ name: it0.result.name, data: it0.result.data }]);
      const zipOk = zipBytes && zipBytes[0] === 0x50 && zipBytes[1] === 0x4B && zipBytes[2] === 0x03 && zipBytes[3] === 0x04;
      ok('ZIP 打包结构有效', zipOk && zipBytes.length > it0.result.size, zipBytes && zipBytes.length);
    }
    const qrPngOK = await new Promise(res => $('qrCanvas').toBlob(b => res(!!b && b.size > 1000), 'image/png'));
    ok('二维码 PNG 导出可用', qrPngOK);
    const barPngOK = await new Promise(res => $('barCanvas').toBlob(b => res(!!b && b.size > 500), 'image/png'));
    ok('条码 PNG 导出可用', barPngOK);

    /* ---------- 6.2 单文件转换按钮 ---------- */
    ok('格式说明文案已更新', $('auFmtNote').textContent === '兼容性最好，适合大多数场景。', $('auFmtNote').textContent);
    AudioPanel.state.fmt = 'wav';
    const convBtn = document.querySelector('#auList .item [data-act=conv]');
    ok('队列行有转换 / 重新转换按钮', !!convBtn);
    if (convBtn) {
      convBtn.click();
      for (let i = 0; i < 100; i++) {
        await sleep(200);
        const it = AudioPanel.getItems()[0];
        if (it && it.result && it.result.fmt === 'wav') break;
      }
      const itC = AudioPanel.getItems()[0];
      ok('单文件按钮按当前格式重新转换', !!(itC && itC.result && itC.result.fmt === 'wav'), itC && itC.result && itC.result.name);
    }
    AudioPanel.state.fmt = 'mp3';

    /* ---------- 7. WMA 内置解码器（整链路） ---------- */
    if (window.__wmaB64) {
      const bin = atob(window.__wmaB64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      AudioPanel.addFiles([new File([u8], 'sample.wma', { type: 'audio/x-ms-wma' })]);
      let found = null;
      for (let i = 0; i < 120; i++) {
        await sleep(200);
        found = AudioPanel.getItems().find(x => x.name === 'sample.wma');
        if (found && (found.buffer || found.err)) break;
      }
      R.wma = found ? { rate: found.srcRate, dur: Math.round((found.dur || 0) * 100) / 100, err: found.err || '' } : null;
      ok('WMA 文件被内置解码器解码', !!(found && found.buffer && found.srcRate === 44100), JSON.stringify(R.wma));
    }

    /* ---------- 8. APE 内置解码器（整链路） ---------- */
    if (window.__apeB64) {
      const bin2 = atob(window.__apeB64);
      const u82 = new Uint8Array(bin2.length);
      for (let i = 0; i < bin2.length; i++) u82[i] = bin2.charCodeAt(i);
      AudioPanel.addFiles([new File([u82], 'sample.ape', { type: 'audio/x-ape' })]);
      let foundA = null;
      for (let i = 0; i < 200; i++) {
        await sleep(250);
        foundA = AudioPanel.getItems().find(x => x.name === 'sample.ape');
        if (foundA && (foundA.buffer || foundA.err)) break;
      }
      R.ape = foundA ? { rate: foundA.srcRate, dur: Math.round((foundA.dur || 0) * 100) / 100, err: foundA.err || '' } : null;
      ok('APE 文件被内置解码器解码', !!(foundA && foundA.buffer && foundA.srcRate === 44100), JSON.stringify(R.ape));
    }
    /* ---------- 9. 视频引擎与面板 ---------- */
    if (typeof VideoEngine !== 'undefined') {
      const vsup = await VideoEngine.support();
      R.vsup = vsup;
      ok('视频引擎可用（H.264 编码 + MP4/WebM）', !!(vsup.webcodecs && vsup.encode.h264 && vsup.containers.mp4), JSON.stringify(vsup.encode));

      // 用 canvas + MediaRecorder 现场生成一段 1 秒 WebM，避免依赖外部样本
      let vfile = null;
      try {
        if (window.MediaRecorder && HTMLCanvasElement.prototype.captureStream) {
          const c = document.createElement('canvas'); c.width = 320; c.height = 180;
          const g = c.getContext('2d');
          const stream = c.captureStream(30);
          const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
          const rec = new MediaRecorder(stream, { mimeType: mime });
          const chunks = [];
          rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
          const stopped = new Promise(r => { rec.onstop = r; });
          rec.start(100);
          const t0 = performance.now();
          await new Promise(res => {
            const draw = () => {
              const t = (performance.now() - t0) / 1000;
              g.fillStyle = '#122033'; g.fillRect(0, 0, 320, 180);
              g.fillStyle = '#e8890c'; g.fillRect((t * 140) % 300, 60, 60, 60);
              g.fillStyle = '#fff'; g.font = 'bold 18px sans-serif'; g.fillText('T=' + t.toFixed(1), 10, 28);
              if (t < 1.0) requestAnimationFrame(draw); else setTimeout(res, 120);
            };
            draw();
          });
          rec.stop();
          await stopped;
          const blob = new Blob(chunks, { type: 'video/webm' });
          vfile = new File([blob], 'ui-video.webm', { type: 'video/webm' });
          R.vgen = { size: vfile.size };
        }
      } catch (e) { R.vgen = { error: String(e && e.message || e) }; }

      if (vfile && vfile.size > 1000) {
        const vprobe = await VideoEngine.probe(vfile);
        R.vprobe = vprobe;
        ok('视频 probe 容器/尺寸正确', vprobe.container === 'webm' && vprobe.width === 320 && vprobe.height === 180, JSON.stringify({ c: vprobe.container, w: vprobe.width, h: vprobe.height, d: vprobe.duration }));
        const vconv = await VideoEngine.convert(vfile, { format: 'mp4', maxWidth: 320, maxHeight: 180, fps: 30, videoBitrate: 500, audio: 'drop' }, { onProgress: () => { } });
        R.vconv = { size: vconv.data.length, meta: vconv.meta };
        ok('视频转码产出 MP4', vconv.data.length > 1000 && vconv.meta.format === 'mp4', JSON.stringify(vconv.meta));
        const vo = await new Promise(res => {
          const b = new Blob([vconv.data], { type: 'video/mp4' });
          const u = URL.createObjectURL(b);
          const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = u;
          v.onloadedmetadata = () => { const r = { ok: true, w: v.videoWidth, h: v.videoHeight, d: v.duration }; URL.revokeObjectURL(u); res(r); };
          v.onerror = () => { URL.revokeObjectURL(u); res({ ok: false }); };
          setTimeout(() => res({ ok: false, t: 'timeout' }), 8000);
        });
        R.vplay = vo;
        ok('转码结果可被播放器解码', !!(vo.ok && vo.w === 320 && vo.h === 180), JSON.stringify(vo));

        // 面板流程
        q('.fn-btn[data-panel=video]').click();
        await sleep(80);
        VideoPanel.addFiles([new File([vfile], 'ui-panel.webm', { type: 'video/webm' })]);
        let vit = null;
        for (let i = 0; i < 50; i++) { await sleep(200); vit = VideoPanel.getItems().find(x => x.name === 'ui-panel.webm'); if (vit && (vit.probed || vit.err)) break; }
        ok('视频面板可添加并读取信息', !!(vit && vit.probed && vit.width === 320), JSON.stringify(vit && { w: vit.width, h: vit.height, err: vit.err || '' }));
        VideoPanel.state.fmt = 'mp4';
        VideoPanel.state.res = 0;
        $('vdStart').click();
        for (let i = 0; i < 100; i++) { await sleep(250); vit = VideoPanel.getItems().find(x => x.name === 'ui-panel.webm'); if (vit && (vit.result || vit.err)) break; }
        R.vui = vit && vit.result ? { name: vit.result.name, size: vit.result.size } : (vit && vit.err);
        ok('视频面板一键转码', !!(vit && vit.result && vit.result.size > 1000), JSON.stringify(R.vui));
        ok('视频汇总统计已更新', $('vdSumDone').textContent === '1', $('vdSumDone').textContent + '/' + $('vdSumOut').textContent);
      }

      /* ---------- 9.1 HEVC 软解兜底 ---------- */
      if (window.__hevcB64) {
        const binH = atob(window.__hevcB64);
        const u8H = new Uint8Array(binH.length);
        for (let i = 0; i < binH.length; i++) u8H[i] = binH.charCodeAt(i);
        const hf = new File([u8H], 'hevc-test.mp4', { type: 'video/mp4' });
        const hp = await VideoEngine.probe(hf);
        R.hevcProbe = { codec: hp.videoCodec, w: hp.width, h: hp.height, d: hp.duration };
        ok('HEVC 样本解封装正确', /^hvc1|^hev1/i.test(hp.videoCodec) && hp.width === 1280 && hp.duration > 9, JSON.stringify(R.hevcProbe));
        const th = performance.now();
        const hc = await VideoEngine.convert(hf, { format: 'mp4', maxWidth: 640, maxHeight: 360, fps: 30, videoBitrate: 800, audio: 'keep' }, { onProgress: () => { } });
        R.hevcConv = { ms: Math.round(performance.now() - th), size: hc.data.length, meta: hc.meta };
        ok('HEVC 软解转码成功', hc.data.length > 5000 && hc.meta.format === 'mp4', JSON.stringify({ size: hc.data.length, ms: R.hevcConv.ms }));
        ok('HEVC 结果时长正确', Math.abs((hc.meta.duration || 0) - 10) < 0.5, hc.meta.duration);
        ok('HEVC 软解备注存在', String(hc.meta.notes || '').indexOf('软解') >= 0, String(hc.meta.notes || '').slice(0, 60));
        const hplay = await new Promise(res => {
          const b = new Blob([hc.data], { type: 'video/mp4' });
          const u = URL.createObjectURL(b);
          const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = u;
          v.onloadedmetadata = () => { const r = { ok: true, w: v.videoWidth, h: v.videoHeight, d: v.duration }; URL.revokeObjectURL(u); res(r); };
          v.onerror = () => { URL.revokeObjectURL(u); res({ ok: false }); };
          setTimeout(() => res({ ok: false, t: 'timeout' }), 8000);
        });
        R.hevcPlay = hplay;
        ok('HEVC 转码结果可播放', !!(hplay.ok && hplay.w === 640), JSON.stringify(hplay));
      }
    } else {
      ok('视频引擎已加载', false, 'VideoEngine 未定义');
    }
  } catch (e) {
    R.errors.push(String(e && e.stack || e));
  }
  return R;
})()
