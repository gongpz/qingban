/* ==================== 音频压缩转换模块 ==================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var panel=$('panel-audio');
if(!panel) return;

/* ---------- 格式配置 ---------- */
var FMT_LABEL={mp3:'MP3',flac:'FLAC',wav:'WAV',aac:'AAC',ogg:'OGG'};
var FMT_EXT={mp3:'mp3',flac:'flac',wav:'wav',aac:'aac',ogg:'ogg'};
var MP3_RATES=[8000,11025,12000,16000,22050,24000,32000,44100,48000];
var BR_MP3={1:[32,40,48,56,64,80,96,112,128,160,192,224,256,320],2:[8,16,24,32,40,48,56,64,80,96,112,128,144,160]};
var BR_AAC=[48,64,80,96,112,128,160,192,224,256,320];
var BR_OPUS=[16,24,32,40,48,56,64,80,96,128,160,192,256];
var FMT_NOTE={
  mp3:'兼容性最好，适合大多数场景。',
  flac:'无损压缩，可完全还原波形。',
  wav:'体积最大，适合再编辑。',
  aac:'同码率下通常优于 MP3，Apple 常用。',
  ogg:'开源免费，语音与音乐都表现优秀。'
};
var state={fmt:'mp3',brIdx:10,depth:'16',level:5,rate:0,ch:0,norm:false,nameMode:'suffix'};
var items=[],uid=0,running=false,prepRunning=false,audioEl=null,playingId=-1;

/* ---------- 小工具 ---------- */
function fmtDur(s){
  if(!isFinite(s)||s<0) return '—';
  s=Math.round(s);
  var m=Math.floor(s/60),ss=s%60;
  if(m>=60){var h=Math.floor(m/60);return h+':'+String(m%60).padStart(2,'0')+':'+String(ss).padStart(2,'0');}
  return m+':'+String(ss).padStart(2,'0');
}
function rateLabel(r){return r?(r/1000).toFixed(r%1000?1:0)+' kHz':'保持原样';}
function chLabel(c){return c?(c===1?'单声道':'立体声'):'保持原声道';}
function guessRate(){
  if(state.rate) return state.rate;
  if(items.length&&items[0].srcRate) return items[0].srcRate;
  return 44100;
}
function brList(){
  if(state.fmt==='mp3') return guessRate()>=32000?BR_MP3[1]:BR_MP3[2];
  if(state.fmt==='aac') return BR_AAC;
  if(state.fmt==='ogg') return BR_OPUS;
  return [];
}
function nearest(list,v){
  var best=list[0],bd=1e9;
  for(var i=0;i<list.length;i++){var d=Math.abs(list[i]-v);if(d<bd){bd=d;best=list[i];}}
  return best;
}
function curBr(){var l=brList();return l.length?l[Math.min(state.brIdx,l.length-1)]:0;}
function clampBr(){
  var l=brList();
  if(!l.length) return;
  if(state.brIdx>=l.length) state.brIdx=l.length-1;
  if(state.brIdx<0) state.brIdx=0;
}
/* 实际写入编码器的码率（按真实采样率修正） */
function pickBitrate(fmt,rate){
  if(fmt==='mp3'){var l=rate>=32000?BR_MP3[1]:BR_MP3[2];return nearest(l,curBr());}
  if(fmt==='aac') return nearest(BR_AAC,curBr());
  if(fmt==='ogg') return nearest(BR_OPUS,curBr());
  return 0;
}
function mp3ValidRate(r){
  if(MP3_RATES.indexOf(r)>=0) return r;
  return nearest(MP3_RATES,r);
}

/* ---------- 采样率嗅探（避免 decodeAudioData 重采样） ---------- */
function seqIndex(b,arr,from){
  var n=arr.length;from=from||0;
  outer:for(var i=from;i<=b.length-n;i++){
    for(var j=0;j<n;j++){ if(b[i+j]!==arr[j]) continue outer; }
    return i;
  }
  return -1;
}
function rdU32(b,o){return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;}
function sniffRate(b){
  try{
    if(b.length>12&&b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46&&b[8]===0x57&&b[9]===0x41&&b[10]===0x56&&b[11]===0x45){
      var p=12;
      while(p+8<=b.length&&p<200000){
        var id=String.fromCharCode(b[p],b[p+1],b[p+2],b[p+3]);
        var sz=rdU32(b,p+4);
        if(id==='fmt '&&p+16<=b.length) return rdU32(b,p+12);
        if(sz<=0||sz>1e7) break;
        p+=8+sz+(sz&1);
      }
    }
    if(b.length>42&&b[0]===0x66&&b[1]===0x4C&&b[2]===0x61&&b[3]===0x43){
      return ((b[18]<<12)|(b[19]<<8)|(b[20]>>4))>>>0;
    }
    if(b.length>40&&b[0]===0x4F&&b[1]===0x67&&b[2]===0x67&&b[3]===0x53){
      if(seqIndex(b,[79,112,117,115,72,101,97,100])>=0) return 48000;      /* OpusHead */
      var vi=seqIndex(b,[1,118,111,114,98,105,115]);
      if(vi>=0&&vi+16<b.length) return rdU32(b,vi+12);                      /* Vorbis id */
    }
    var off=0;
    if(b.length>10&&b[0]===0x49&&b[1]===0x44&&b[2]===0x33){
      off=10+(((b[6]&0x7F)<<21)|((b[7]&0x7F)<<14)|((b[8]&0x7F)<<7)|(b[9]&0x7F));
    }
    var adtsRates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
    var limit=Math.min(b.length-4,off+65536);
    for(var i=off;i<limit;i++){
      if(b[i]!==0xFF) continue;
      if((b[i+1]&0xF0)===0xF0&&(b[i+1]&0x06)===0){                          /* ADTS AAC */
        var si=(b[i+2]>>2)&0x0F;
        if(si<adtsRates.length) return adtsRates[si];
      }
      if((b[i+1]&0xE0)===0xE0){                                            /* MP3 */
        var ver=(b[i+1]>>3)&3,layer=(b[i+1]>>1)&3;
        if(ver===1||layer===0) continue;
        var brI=(b[i+2]>>4)&0x0F,srI=(b[i+2]>>2)&3;
        if(brI===0x0F||srI===3) continue;
        var base=[44100,48000,32000][srI];
        if(ver===2) base/=2; else if(ver===0) base/=4;
        return base;
      }
    }
    var mi=seqIndex(b,[109,100,104,100]);                                  /* MP4 mdhd */
    if(mi>=0&&mi+28<b.length){
      var v=b[mi+4];
      var ts=v===1?rdU32(b,mi+24):rdU32(b,mi+16);
      if(ts>=8000&&ts<=192000) return ts;
    }
  }catch(e){}
  return 0;
}

/* ---------- 解码 / 重采样 / 声道处理 ---------- */
function getCtx(rate){
  var AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) throw new Error('当前浏览器不支持 Web Audio');
  try{
    if(rate&&rate>=8000&&rate<=96000) return new AC({sampleRate:rate});
  }catch(e){}
  return new AC();
}
function readBuffer(file,onProgress){
  return new Promise(function(res,rej){
    var fr=new FileReader();
    fr.onload=function(){res(fr.result);};
    fr.onerror=function(){rej(new Error('读取文件失败'));};
    fr.onprogress=function(e){ if(onProgress&&e.lengthComputable) onProgress(e.loaded/e.total*0.35); };
    fr.readAsArrayBuffer(file);
  });
}
function isAsf(u8){
  return u8.length>32&&u8[0]===0x30&&u8[1]===0x26&&u8[2]===0xB2&&u8[3]===0x75&&u8[4]===0x8E;
}
function isApe(u8){
  return u8.length>32&&u8[0]===0x4D&&u8[1]===0x41&&u8[2]===0x43&&u8[3]===0x20; /* 'MAC ' */
}
function makeBuffer(channelData,sampleRate){
  var OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  var c=new OAC(1,1,44100);
  var buf=c.createBuffer(channelData.length,channelData[0].length,sampleRate);
  for(var i=0;i<channelData.length;i++) buf.copyToChannel(channelData[i],i);
  return buf;
}
function decodeWithBuiltin(u8,kind){
  var fn=kind==='wma'?window.WmaDecode:window.ApeDecode;
  if(typeof fn!=='function') return Promise.reject(new Error('内置解码器未加载'));
  return Promise.resolve(fn(u8)).then(function(res){
    if(!res||!res.channelData||!res.channelData.length) throw new Error('解码结果为空');
    return {buffer:makeBuffer(res.channelData,res.sampleRate),srcRate:res.sampleRate};
  });
}
function decodeAudio(ab,name){
  var u8=new Uint8Array(ab);
  var nm=(name||'').toLowerCase();
  var sniff=sniffRate(u8);
  /* WMA / APE 浏览器内核不支持，改用内置 WASM 解码器（注意：decodeAudioData 会 detach 缓冲区） */
  if(isAsf(u8)||/\.wma$/.test(nm)){
    return decodeWithBuiltin(u8,'wma').catch(function(e){
      return decodeNative(ab,sniff);
    });
  }
  if(isApe(u8)||/\.ape$/.test(nm)){
    return decodeWithBuiltin(u8,'ape').catch(function(e){
      return decodeNative(ab,sniff);
    });
  }
  return decodeNative(ab,sniff);
}
function decodeNative(ab,sniff){
  var ctx;
  try{
    ctx=getCtx(sniff);
  }catch(e){
    return Promise.reject(e);
  }
  return ctx.decodeAudioData(ab).then(function(buf){
    try{ctx.close();}catch(e){}
    return {buffer:buf,srcRate:sniff||buf.sampleRate};
  },function(err){
    try{ctx.close();}catch(e){}
    throw err;
  });
}
function resampleBuffer(buffer,rate){
  if(rate>96000) rate=96000;
  var len=Math.max(1,Math.round(buffer.duration*rate));
  if(len>150000000) return Promise.reject(new Error('音频过长，无法重采样'));
  var OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  var ctx=new OAC({numberOfChannels:buffer.numberOfChannels,length:len,sampleRate:rate});
  var s=ctx.createBufferSource();s.buffer=buffer;s.connect(ctx.destination);s.start(0);
  return ctx.startRendering();
}
function fitChannels(buffer,targetCh){
  var n=buffer.numberOfChannels,src=[];
  for(var i=0;i<n;i++) src.push(buffer.getChannelData(i));
  var want=targetCh||n;
  if(want===n) return src;
  if(want===1){
    var out=new Float32Array(buffer.length);
    for(var i2=0;i2<buffer.length;i2++){
      var sum=0;
      for(var c=0;c<n;c++) sum+=src[c][i2];
      out[i2]=sum/n;
    }
    return [out];
  }
  if(want===2&&n===1) return [src[0],src[0]];
  var res=[];
  for(var k=0;k<want;k++) res.push(src[Math.min(k,n-1)]);
  return res;
}
function peakNormalize(chans){
  var peak=0,i,c;
  for(c=0;c<chans.length;c++){
    var d=chans[c];
    for(i=0;i<d.length;i++){var v=d[i]<0?-d[i]:d[i];if(v>peak)peak=v;}
  }
  if(peak<=0.0001||peak>=0.999) return;
  var g=0.891/peak;
  for(c=0;c<chans.length;c++) for(i=0;i<chans[c].length;i++) chans[c][i]*=g;
}

/* ---------- 输出参数 ---------- */
function targetRateFor(item,fmt){
  var r=state.rate||item.srcRate||44100;
  if(fmt==='mp3') return mp3ValidRate(r);
  if(fmt==='ogg') return 48000;
  if(fmt==='aac') return r>96000?96000:r;
  return r>192000?192000:r;
}
function outName(item){
  var base=item.name.replace(/\.[^.]+$/,'');
  var ext=FMT_EXT[state.fmt];
  var suffix='';
  if(state.nameMode==='suffix') suffix='_压缩';
  else if(state.nameMode==='fmt') suffix='_'+ext.toUpperCase();
  return base+suffix+'.'+ext;
}

/* ---------- 编码 ---------- */
function encode(chans,rate,onProgress){
  var fmt=state.fmt;
  if(fmt==='wav'){
    if(state.depth==='32f') return Promise.resolve(AudioEnc.wav(chans,rate,{float:true,bitDepth:32}));
    return Promise.resolve(AudioEnc.wav(chans,rate,{bitDepth:+state.depth}));
  }
  if(fmt==='flac'){
    if(typeof FlacEncoder==='undefined') return Promise.reject(new Error('FLAC 编码器未加载'));
    var depth=state.depth==='24'?24:16;
    return Promise.resolve(FlacEncoder.encode(chans,rate,{bitDepth:depth,compression:state.level}));
  }
  if(fmt==='mp3') return AudioEnc.mp3(chans,rate,{bitrate:pickBitrate('mp3',rate),onProgress:onProgress});
  if(fmt==='aac') return AudioEnc.aac(chans,rate,{bitrate:pickBitrate('aac',rate),onProgress:onProgress});
  if(fmt==='ogg') return AudioEnc.oggOpus(chans,rate,{bitrate:pickBitrate('ogg',rate),onProgress:onProgress});
  return Promise.reject(new Error('未知输出格式'));
}

/* ---------- 队列渲染 ---------- */
function waveOf(item,cv){
  if(!item.buffer||!cv) return;
  var w=cv.width,h=cv.height,g=cv.getContext('2d');
  g.clearRect(0,0,w,h);
  var data=item.buffer.getChannelData(0);
  var step=Math.max(1,Math.floor(data.length/w));
  g.fillStyle='#f5a623';
  for(var x=0;x<w;x++){
    var s=x*step,e=Math.min(data.length,s+step),mn=1,mx=-1;
    var istep=Math.max(1,Math.floor(step/40));
    for(var i=s;i<e;i+=istep){var v=data[i];if(v<mn)mn=v;if(v>mx)mx=v;}
    if(mx<mn) continue;
    var y1=(1-mx)/2*h,y2=(1-mn)/2*h;
    g.fillRect(x,y1,1,Math.max(1,y2-y1));
  }
}
function itemStatus(it){
  if(it.err) return ['fail','失败'];
  if(it.result) return ['done','已完成'];
  if(it.working) return ['work','转换中'];
  return ['ready','待转换'];
}
function renderList(){
  var list=$('auList');
  $('auCount').textContent=items.length+' 个文件';
  if(!items.length){
    list.innerHTML='<div class="empty" style="border:0">还没有添加音频文件</div>';
  }else{
    list.innerHTML='';
    items.forEach(function(it){
      var row=document.createElement('div');
      row.className='item au-item';row.dataset.id=it.id;
      var meta1='<span>'+fmtDur(it.dur)+'</span><span class="sep">·</span><span>'+(it.srcRate?rateLabel(it.srcRate):'—')+'</span><span class="sep">·</span><span>'+(it.srcCh?(it.srcCh===1?'单声道':'立体声'):'—')+'</span><span class="sep">·</span><span>'+fmtSize(it.size)+'</span>';
      var meta2='';
      if(it.err){
        meta2='<span class="status-err">'+esc(it.err)+'</span>';
      }else if(it.result){
        var d=it.size-it.result.size,pct=it.size?Math.round(d/it.size*100):0;
        meta2='<span style="color:var(--ok)">'+esc(it.result.name)+'</span><span class="au-arrow">→</span><span>'+fmtSize(it.result.size)+'</span><span class="au-delta '+(d>=0?'down':'up')+'">'+(d>=0?'-':'+')+Math.abs(pct)+'%</span>';
      }else if(it.working){
        meta2='<span class="status-work" id="auw_'+it.id+'">'+esc(it.stage||'转换中')+'</span>';
      }else if(it.decoding){
        meta2='<span class="status-work">解码中…</span>';
      }else{
        meta2='<span class="status-wait">等待转换</span>';
      }
      row.innerHTML=
        '<div class="thumb au-thumb" style="width:56px;height:40px;flex:0 0 56px;padding:0"><canvas width="56" height="40"></canvas></div>'+
        '<div class="item-main">'+
          '<div class="item-name" title="'+esc(it.name)+'">'+esc(it.name)+'</div>'+
          '<div class="item-line">'+meta1+'</div>'+
          '<div class="item-line">'+meta2+'</div>'+
        '</div>'+
        '<div class="item-actions">'+
          '<button class="au-conv" data-act="conv" title="'+(it.result?'重新转换':'转换此文件')+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 11-2.5-6"/><path d="M20.5 4.5V10H15"/></svg></button>'+
          '<button class="au-play" data-act="play" title="试听原文件"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>'+
          (it.result?'<button class="icon-btn dl" data-act="dl" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 18v2h16v-2"/></svg></button>':'')+
          '<button class="icon-btn del" data-act="del" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
        '</div>'+
        '<div class="mini-bar"><i style="width:'+Math.round((it.progress||0)*100)+'%"></i></div>';
      var cv=row.querySelector('canvas');
      if(it.buffer) waveOf(it,cv);
      else{
        var g=cv.getContext('2d');g.fillStyle='rgba(245,166,35,.18)';
        g.fillRect(0,cv.height/2-1,cv.width,2);
      }
      row.querySelector('[data-act=play]').addEventListener('click',function(ev){ev.stopPropagation();togglePlay(it);});
      row.querySelector('[data-act=conv]').addEventListener('click',function(ev){ev.stopPropagation();convertItem(it);});
      var dl=row.querySelector('[data-act=dl]');
      if(dl) dl.addEventListener('click',function(ev){ev.stopPropagation();downloadBytes(it.result.data,it.result.name);});
      row.querySelector('[data-act=del]').addEventListener('click',function(ev){ev.stopPropagation();removeItem(it);});
      list.appendChild(row);
    });
  }
  updateStats();updateButtons();
}
function updateBar(it){
  var row=$('auList').querySelector('.item[data-id="'+it.id+'"]');
  if(!row) return;
  var bar=row.querySelector('.mini-bar i');
  if(bar) bar.style.width=Math.round((it.progress||0)*100)+'%';
  var w=$('auw_'+it.id);
  if(w&&it.stage) w.textContent=it.stage;
}
function updateStats(){
  var done=items.filter(function(i){return i.result;});
  var tin=0,tout=0;
  items.forEach(function(i){tin+=i.size;});
  done.forEach(function(i){tout+=i.result.size;});
  $('auSumTotal').textContent=items.length;
  $('auSumDone').textContent=done.length;
  $('auSumIn').textContent=fmtSize(tin);
  $('auSumOut').textContent=done.length?fmtSize(tout):'0 B';
}
function updateButtons(){
  var has=items.length>0,done=items.some(function(i){return i.result;});
  $('auStart').disabled=!has||running;
  $('auZip').disabled=!done||running;
  $('auClearAll').disabled=!has||running;
  $('auStart').textContent=running?'转换中…':'开始转换';
}
function removeItem(it){
  if(running) return;
  if(playingId===it.id) stopPlay();
  items=items.filter(function(x){return x.id!==it.id;});
  renderList();
}
function addFiles(files){
  var added=0;
  for(var i=0;i<files.length;i++){
    var f=files[i];
    if(!f) continue;
    var ext=(f.name.split('.').pop()||'').toLowerCase();
    var okExt=/^(mp3|wav|flac|m4a|aac|ogg|oga|opus|wma|ape|aif|aiff|webm|caf|amr|mka|wv|mp2|ac3)$/;
    if(!okExt.test(ext)&&f.type.indexOf('audio')<0){ toast('已跳过非音频文件：'+f.name,true); continue; }
    var dup=items.some(function(x){return x.name===f.name&&x.size===f.size;});
    if(dup) continue;
    items.push({id:++uid,file:f,name:f.name,size:f.size,progress:0,stage:'等待解码'});
    added++;
  }
  if(added){
    renderList();
    toast('已添加 '+added+' 个音频文件');
    prepareAll();
  }
}
function decodeFailMessage(it,err){
  var ext=(it.name.split('.').pop()||'').toLowerCase();
  if(ext==='amr'||ext==='wv'||ext==='ac3'||ext==='aif'||ext==='aiff') return '当前浏览器内核不支持该编码';
  if((ext==='wma'||ext==='ape')&&(!window.WmaDecode&&!window.ApeDecode)) return '内置 WMA/APE 解码器未加载';
  var msg=(err&&err.message)||'';
  if(/Unable to decode|EncodingError|not supported|Unsupported/i.test(msg)) return '无法解码该音频（编码不受支持）';
  return '处理失败：'+(msg||'未知错误');
}
async function prepareAll(){
  if(prepRunning) return;
  prepRunning=true;
  for(;;){
    var it=null;
    for(var i=0;i<items.length;i++){
      if(!items[i].buffer&&!items[i].decoding&&!items[i].err){it=items[i];break;}
    }
    if(!it) break;
    it.decoding=true;
    try{
      var ab=await readBuffer(it.file,function(r){it.progress=r*0.6;updateBar(it);});
      var dec=await decodeAudio(ab,it.file.name);
      it.buffer=dec.buffer;it.srcRate=dec.srcRate;
      it.srcCh=dec.buffer.numberOfChannels;it.dur=dec.buffer.duration;
      it.progress=0;it.stage='就绪';
    }catch(err){
      it.err=decodeFailMessage(it,err);
    }
    it.decoding=false;
    renderList();
    await new Promise(function(r){setTimeout(r,10);});
  }
  prepRunning=false;
}

/* ---------- 试听（优先播放解码后的 PCM，WMA/APE 也能试听） ---------- */
var playCtx=null,playSrc=null;
function setPlayBtn(id,on){
  var row=$('auList').querySelector('.item[data-id="'+id+'"]');
  if(!row) return;
  var b=row.querySelector('[data-act=play]');
  if(!b) return;
  b.classList.toggle('on',on);
  b.innerHTML=on?'<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>':'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
}
function togglePlay(it){
  if(playingId===it.id){stopPlay();return;}
  stopPlay();
  var AC=window.AudioContext||window.webkitAudioContext;
  if(it.buffer&&AC){
    if(!playCtx) playCtx=new AC();
    if(playCtx.state==='suspended') playCtx.resume();
    var src=playCtx.createBufferSource();
    src.buffer=it.buffer;
    src.connect(playCtx.destination);
    src.onended=function(){ if(playingId===it.id) stopPlay(); };
    src.start();
    playSrc=src;playingId=it.id;setPlayBtn(it.id,true);
    return;
  }
  if(!audioEl) audioEl=new Audio();
  audioEl.src=URL.createObjectURL(it.file);
  audioEl.play().then(function(){
    playingId=it.id;setPlayBtn(it.id,true);
  }).catch(function(e){toast('无法播放：'+((e&&e.message)||'格式不支持'),true);});
  audioEl.onended=function(){stopPlay();};
}
function stopPlay(){
  if(playSrc){try{playSrc.stop();}catch(e){}try{playSrc.disconnect();}catch(e){}playSrc=null;}
  if(audioEl){audioEl.pause();try{URL.revokeObjectURL(audioEl.src);}catch(e){}audioEl.removeAttribute('src');}
  if(playingId>=0) setPlayBtn(playingId,false);
  playingId=-1;
}

/* ---------- 转换 ---------- */
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms||0);});};
async function convertOne(it){
  it.working=true;it.err='';it.result=null;it.progress=0;it.stage='解码中';
  renderList();
  var buf=it.buffer;
  if(!buf){
    while(it.decoding){await sleep(120);}
    if(it.buffer) buf=it.buffer;
    else{
      var ab=await readBuffer(it.file,function(r){it.progress=r*0.3;updateBar(it);});
      var dec=await decodeAudio(ab,it.file.name);
      buf=it.buffer=dec.buffer;it.srcRate=dec.srcRate;it.srcCh=buf.numberOfChannels;it.dur=buf.duration;
    }
  }
  it.progress=0.32;it.stage='重采样';updateBar(it);await sleep(0);
  var rate=targetRateFor(it,state.fmt);
  if(rate!==buf.sampleRate) buf=await resampleBuffer(buf,rate);
  it.progress=0.42;it.stage='混合声道';updateBar(it);await sleep(0);
  var chans=fitChannels(buf,state.ch);
  if(state.norm) peakNormalize(chans);
  it.progress=0.48;it.stage='编码中';updateBar(it);await sleep(0);
  var out=await encode(chans,buf.sampleRate,function(p){
    it.progress=0.48+p*0.5;updateBar(it);
  });
  var bytes=(out&&out.data)?out.data:out;
  it.progress=1;
  it.result={data:bytes,name:outName(it),size:bytes.length,rate:buf.sampleRate,ch:chans.length,fmt:state.fmt};
  it.working=false;it.stage='已完成';
  renderList();
}
function canEncode(){
  if(typeof AudioEnc==='undefined'){toast('音频编码模块未加载',true);return false;}
  if(state.fmt==='flac'&&typeof FlacEncoder==='undefined'){toast('FLAC 编码器未加载',true);return false;}
  return true;
}
async function runList(list){
  running=true;updateButtons();
  $('auGlobalBar').style.width='0%';
  var done=0;
  for(var i=0;i<list.length;i++){
    var it=list[i];
    try{
      await convertOne(it);
    }catch(err){
      it.working=false;it.err=decodeFailMessage(it,err);it.stage='失败';
      renderList();
    }
    done++;
    $('auGlobalBar').style.width=Math.round(done/list.length*100)+'%';
    await sleep(30);
  }
  running=false;updateButtons();
}
async function convertItem(it){
  if(running){toast('正在转换中，请稍候',true);return;}
  if(!canEncode()) return;
  it.err='';it.result=null;
  await runList([it]);
  if(it.err) toast(it.err,true);
  else toast('已输出 '+(it.result?it.result.name:'文件'));
  renderList();
}
async function convertAll(){
  if(running) return;
  var pending=items.filter(function(i){return !i.result&&!i.err;});
  if(!pending.length){toast('没有待转换的文件',true);return;}
  if(!canEncode()) return;
  await runList(pending);
  var ok=items.filter(function(x){return x.result;}).length;
  var fail=items.filter(function(x){return x.err;}).length;
  toast('转换完成：成功 '+ok+' 个'+(fail?'，失败 '+fail+' 个':''),fail>0);
}

/* ---------- UI 绑定 ---------- */
function updateFormatUI(){
  var fmt=state.fmt;
  $('auFmtNote').textContent=FMT_NOTE[fmt];
  document.querySelectorAll('#auFmtGrid .fmt-chip').forEach(function(b){b.classList.toggle('on',b.dataset.fmt===fmt);});
  $('auBitrateField').classList.toggle('hidden',fmt==='wav'||fmt==='flac');
  $('auDepthField').classList.toggle('hidden',fmt==='mp3'||fmt==='aac'||fmt==='ogg');
  $('auLevelField').classList.toggle('hidden',fmt!=='flac');
  var depthSel=$('auDepth');
  if(fmt==='flac'){
    depthSel.innerHTML='<option value="16">16 bit（CD 标准）</option><option value="24">24 bit（高精度）</option>';
    if(state.depth==='32f') state.depth='16';
    depthSel.value=state.depth==='24'?'24':'16';
  }else if(fmt==='wav'){
    depthSel.innerHTML='<option value="16">16 bit PCM</option><option value="24">24 bit PCM</option><option value="32f">32 bit 浮点</option>';
    depthSel.value=state.depth;
  }
  clampBr();
  var l=brList();
  $('auBitrate').max=Math.max(1,l.length-1);
  $('auBitrate').value=state.brIdx;
  updateBrUI();
  updateOutBox();
}
function updateBrUI(){
  var l=brList();
  clampBr();
  var br=curBr();
  $('auBrVal').textContent=(l.length?br:'—')+(l.length?' kbps':'');
  var el=$('auBitrate');
  el.value=state.brIdx;
  el.style.setProperty('--p',l.length?(state.brIdx/Math.max(1,l.length-1)*100)+'%':'0%');
  var note='码率越低体积越小，语音可用 64 kbps。';
  if(state.fmt==='ogg') note='64–96 kbps 可接近 MP3 160 kbps 的听感。';
  if(state.fmt==='aac') note='建议 96–160 kbps；低于 96 kbps 金属感明显。';
  if(state.fmt==='mp3'&&br<=64) note='低码率更适合人声，音乐会丢失细节。';
  $('auBrHint').textContent=note;
  updateOutBox();
}
function updateOutBox(){
  var fmt=state.fmt,br=curBr();
  var spec=(fmt==='wav'||fmt==='flac')
    ? (state.depth==='32f'?'32 bit 浮点':state.depth+' bit')+(fmt==='flac'?' · 级别 '+state.level:'')
    : (br?br+' kbps':'—');
  $('auOutBox').innerHTML='<div class="au-out-fmt">'+FMT_LABEL[fmt]+'</div><div class="au-out-meta">'+spec+' · '+rateLabel(state.rate)+' · '+(state.ch?chLabel(state.ch):'保持原声道')+'</div>';
}
document.querySelectorAll('#auFmtGrid .fmt-chip').forEach(function(b){
  b.addEventListener('click',function(){
    if(b.disabled) return;
    state.fmt=b.dataset.fmt;
    clampBr();
    updateFormatUI();
    document.querySelectorAll('#auPreset button').forEach(function(x){x.classList.remove('on');});
  });
});
$('auBitrate').addEventListener('input',function(){
  state.brIdx=+this.value;updateBrUI();
});
$('auDepth').addEventListener('change',function(){state.depth=this.value;updateOutBox();});
$('auLevel').addEventListener('input',function(){
  state.level=+this.value;
  $('auLevelVal').textContent=state.level;
  this.style.setProperty('--p',(state.level/8*100)+'%');
  updateOutBox();
});
$('auSampleRate').addEventListener('change',function(){state.rate=+this.value;updateFormatUI();});
$('auChannels').addEventListener('change',function(){state.ch=+this.value;updateOutBox();});
$('auNormalize').addEventListener('change',function(){state.norm=this.checked;});
$('auNameMode').addEventListener('change',function(){state.nameMode=this.value;});
document.querySelectorAll('#auPreset button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#auPreset button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    var p=b.dataset.preset;
    state.fmt='mp3';
    if(p==='voice'){state.rate=22050;state.ch=1;state.brIdx=BR_MP3[2].indexOf(64);}
    if(p==='podcast'){state.rate=44100;state.ch=2;state.brIdx=BR_MP3[1].indexOf(96);}
    if(p==='music'){state.rate=0;state.ch=2;state.brIdx=BR_MP3[1].indexOf(192);}
    $('auSampleRate').value=String(state.rate);
    $('auChannels').value=String(state.ch);
    updateFormatUI();
  });
});

/* 拖放 / 选择 */
var drop=$('auDrop'),picker=$('auPicker');
drop.addEventListener('click',function(){picker.click();});
$('auPickBtn').addEventListener('click',function(ev){ev.stopPropagation();picker.click();});
picker.addEventListener('change',function(){addFiles(this.files);this.value='';});
['dragenter','dragover'].forEach(function(t){
  drop.addEventListener(t,function(e){e.preventDefault();drop.classList.add('over');});
});
['dragleave','drop'].forEach(function(t){
  drop.addEventListener(t,function(e){e.preventDefault();drop.classList.remove('over');});
});
drop.addEventListener('drop',function(e){
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
panel.addEventListener('dragover',function(e){e.preventDefault();});
panel.addEventListener('drop',function(e){
  if(e.target.closest&&e.target.closest('#auDrop')) return;
  e.preventDefault();
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$('auClearList').addEventListener('click',function(){
  if(running) return;
  stopPlay();items=[];renderList();
});
$('auClearAll').addEventListener('click',function(){
  if(running) return;
  stopPlay();items=[];$('auGlobalBar').style.width='0%';renderList();
});
$('auStart').addEventListener('click',convertAll);
$('auZip').addEventListener('click',function(){
  var ok=items.filter(function(i){return i.result;});
  if(!ok.length){toast('还没有可下载的文件',true);return;}
  if(typeof CDREngine==='undefined'||!CDREngine.makeZipFromFiles){toast('打包模块不可用',true);return;}
  var zip=CDREngine.makeZipFromFiles(ok.map(function(i){return {name:i.result.name,data:i.result.data};}));
  downloadBytes(zip,'音频转换_'+new Date().toISOString().slice(0,10)+'.zip');
  toast('已打包 '+ok.length+' 个文件');
});

/* 能力检测 */
function detectSupport(){
  if(typeof AudioEnc==='undefined'||!AudioEnc.support) return;
  AudioEnc.support().then(function(cap){
    if(!cap) return;
    var bad=false;
    if(cap.aac===false){
      var a=document.querySelector('#auFmtGrid [data-fmt=aac]');
      if(a){a.classList.add('off');a.disabled=true;a.querySelector('span').textContent='当前内核不支持';}
      bad=true;
    }
    if(cap.opus===false){
      var o=document.querySelector('#auFmtGrid [data-fmt=ogg]');
      if(o){o.classList.add('off');o.disabled=true;o.querySelector('span').textContent='当前内核不支持';}
      bad=true;
    }
    if(bad){
      $('auSupportNote').innerHTML='<strong>兼容性</strong>：AAC / OGG 依赖浏览器 WebCodecs（Chrome 94+ / Edge 94+）。当前环境部分格式不可选，MP3 / FLAC / WAV 始终可用。';
      if(state.fmt==='aac'||state.fmt==='ogg'){state.fmt='mp3';updateFormatUI();}
    }
  }).catch(function(){});
}

updateFormatUI();
$('auLevel').style.setProperty('--p',(state.level/8*100)+'%');
$('auBitrate').style.setProperty('--p','60%');
detectSupport();
renderList();
window.AudioPanel={getItems:function(){return items;},addFiles:addFiles,convertAll:convertAll,state:state};
})();
