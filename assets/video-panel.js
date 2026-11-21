/* ==================== 视频压缩转换模块 ==================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var panel=$('panel-video');
if(!panel) return;

var FMT_LABEL={mp4:'MP4',webm:'WebM'};
var FMT_NOTE={
  mp4:'MP4（H.264 + AAC）兼容性最好。',
  webm:'体积更小，适合网页与开源环境。'
};
var BR_LIST=[0,800,1200,1800,2500,3500,5000,8000];
var state={fmt:'mp4',res:0,brIdx:0,fps:0,audio:'keep',nameMode:'suffix'};
var items=[],uid=0,running=false,prepRunning=false,cancelled=false;
var support=null;

/* ---------- 工具 ---------- */
function fmtDur(s){
  if(!isFinite(s)||s<0) return '—';
  s=Math.round(s);
  var m=Math.floor(s/60),ss=s%60;
  if(m>=60){var h=Math.floor(m/60);return h+':'+String(m%60).padStart(2,'0')+':'+String(ss).padStart(2,'0');}
  return m+':'+String(ss).padStart(2,'0');
}
function bitrateLabel(v){
  if(!v) return '自动';
  return v>=1000?(v/1000).toFixed(v%1000?1:0)+' Mbps':v+' kbps';
}
function resLabel(r){return r?r+'p':'原尺寸';}
function curBr(){return BR_LIST[Math.min(state.brIdx,BR_LIST.length-1)];}
function targetSize(it){
  if(!state.res||!it.width||!it.height) return null;
  var w=it.width,h=it.height,res=state.res;
  var scale=1;
  if(w>=h) scale=Math.min(1,res/h);
  else scale=Math.min(1,res/w);
  if(scale>=1) return null;
  var tw=Math.round(w*scale/2)*2,th=Math.round(h*scale/2)*2;
  return {w:Math.max(2,tw),h:Math.max(2,th)};
}
function outName(it){
  var base=it.name.replace(/\.[^.]+$/,'');
  var ext=state.fmt;
  var suffix='';
  if(state.nameMode==='suffix') suffix='_压缩';
  else if(state.nameMode==='fmt') suffix='_'+ext.toUpperCase();
  return base+suffix+'.'+ext;
}
function audioOpts(){
  if(state.audio==='drop') return {audio:'drop'};
  var br=128;
  if(state.audio==='keep192') br=192;
  if(state.audio==='keep96') br=96;
  if(state.audio==='keep64') br=64;
  return {audio:'keep',audioBitrate:br};
}
function convertOpts(it){
  var o={format:state.fmt,fps:state.fps,keyframeInterval:2};
  var ts=targetSize(it);
  if(ts){o.maxWidth=ts.w;o.maxHeight=ts.h;}
  var br=curBr();
  if(br) o.videoBitrate=br;
  var a=audioOpts();
  o.audio=a.audio;
  if(a.audioBitrate) o.audioBitrate=a.audioBitrate;
  return o;
}

/* ---------- 队列渲染 ---------- */
function itemStatusTxt(it){
  if(it.err) return ['fail','失败'];
  if(it.result) return ['done','已完成'];
  if(it.working) return ['work','转码中'];
  return ['ready','待转码'];
}
function renderList(){
  var list=$('vdList');
  $('vdCount').textContent=items.length+' 个文件';
  if(!items.length){
    list.innerHTML='<div class="empty" style="border:0">还没有添加视频文件</div>';
  }else{
    list.innerHTML='';
    items.forEach(function(it){
      var row=document.createElement('div');
      row.className='item au-item';row.dataset.id=it.id;
      var hasSoftHevc = (typeof VideoEngine !== 'undefined' && VideoEngine.hevcSoftware) || (support && support.decode && support.decode.hevcSoftware);
      var hevcSoft = it.vcodec && /^(HVC1|HEV1)$/.test(it.vcodec) && !(support && support.decode && support.decode.hevc) && !!hasSoftHevc;
      var meta1='<span>'+fmtDur(it.dur)+'</span><span class="sep">·</span><span>'+(it.width?it.width+'×'+it.height:'—')+'</span>'+
        '<span class="sep">·</span><span>'+(it.fps?Math.round(it.fps)+' fps':'—')+'</span>'+
        '<span class="sep">·</span><span>'+(it.vcodec||'—')+(hevcSoft?'<span class="au-tag" title="系统没有 HEVC 解码器，将使用内置软解（较慢）">软解</span>':'')+'</span>'+
        '<span class="sep">·</span><span>'+fmtSize(it.size)+'</span>';
      var meta2='';
      if(it.err){
        meta2='<span class="status-err">'+esc(it.err)+'</span>';
      }else if(it.result){
        var d=it.size-it.result.size,pct=it.size?Math.round(d/it.size*100):0;
        var notes=(it.result.meta&&it.result.meta.notes)||'';
        if(typeof notes!=='string') notes=notes.join('；');
        meta2='<span style="color:var(--ok)"'+(notes?' title="'+esc(notes)+'"':'')+'>'+esc(it.result.name)+'</span><span class="au-arrow">→</span><span>'+fmtSize(it.result.size)+'</span><span class="au-delta '+(d>=0?'down':'up')+'">'+(d>=0?'-':'+')+Math.abs(pct)+'%</span>'+
          (it.result.meta&&it.result.meta.width?' <span style="color:var(--muted)">'+it.result.meta.width+'×'+it.result.meta.height+'</span>':'');
      }else if(it.working){
        meta2='<span class="status-work" id="vdw_'+it.id+'">'+esc(it.stage||'转码中')+'</span>';
      }else if(it.probing){
        meta2='<span class="status-work">读取信息…</span>';
      }else{
        meta2='<span class="status-wait">等待转码</span>';
      }
      row.innerHTML=
        '<div class="thumb au-thumb" style="width:56px;height:40px;flex:0 0 56px;padding:0"><canvas width="56" height="40"></canvas></div>'+
        '<div class="item-main">'+
          '<div class="item-name" title="'+esc(it.name)+'">'+esc(it.name)+'</div>'+
          '<div class="item-line">'+meta1+'</div>'+
          '<div class="item-line">'+meta2+'</div>'+
        '</div>'+
        '<div class="item-actions">'+
          '<button class="au-conv" data-act="conv" title="'+(it.result?'重新转码':'转码此文件')+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 11-2.5-6"/><path d="M20.5 4.5V10H15"/></svg></button>'+
          '<button class="au-play" data-act="play" title="预览"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>'+
          (it.result?'<button class="icon-btn dl" data-act="dl" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 18v2h16v-2"/></svg></button>':'')+
          '<button class="icon-btn del" data-act="del" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
        '</div>'+
        '<div class="mini-bar"><i style="width:'+Math.round((it.progress||0)*100)+'%"></i></div>';
      var cv=row.querySelector('canvas');
      if(it.thumb) cv.getContext('2d').drawImage(it.thumb,0,0,56,40);
      else{
        var g=cv.getContext('2d');g.fillStyle='rgba(245,166,35,.18)';g.fillRect(0,cv.height/2-1,cv.width,2);
      }
      row.querySelector('[data-act=conv]').addEventListener('click',function(ev){ev.stopPropagation();convertItem(it);});
      row.querySelector('[data-act=play]').addEventListener('click',function(ev){ev.stopPropagation();previewItem(it);});
      var dl=row.querySelector('[data-act=dl]');
      if(dl) dl.addEventListener('click',function(ev){ev.stopPropagation();downloadBytes(it.result.data,it.result.name);});
      row.querySelector('[data-act=del]').addEventListener('click',function(ev){ev.stopPropagation();removeItem(it);});
      list.appendChild(row);
    });
  }
  updateStats();updateButtons();
}
function updateBar(it){
  var row=$('vdList').querySelector('.item[data-id="'+it.id+'"]');
  if(!row) return;
  var bar=row.querySelector('.mini-bar i');
  if(bar) bar.style.width=Math.round((it.progress||0)*100)+'%';
  var w=$('vdw_'+it.id);
  if(w&&it.stage) w.textContent=it.stage;
}
function updateStats(){
  var done=items.filter(function(i){return i.result;});
  var tin=0,tout=0;
  items.forEach(function(i){tin+=i.size;});
  done.forEach(function(i){tout+=i.result.size;});
  $('vdSumTotal').textContent=items.length;
  $('vdSumDone').textContent=done.length;
  $('vdSumIn').textContent=fmtSize(tin);
  $('vdSumOut').textContent=done.length?fmtSize(tout):'0 B';
}
function updateButtons(){
  var has=items.length>0,done=items.some(function(i){return i.result;});
  $('vdStart').disabled=!has||running;
  $('vdStop').disabled=!running;
  $('vdZip').disabled=!done||running;
  $('vdClearAll').disabled=!has||running;
  $('vdStart').textContent=running?'转码中…':'开始转码';
}
function addFiles(files){
  var added=0;
  for(var i=0;i<files.length;i++){
    var f=files[i];
    if(!f) continue;
    var ext=(f.name.split('.').pop()||'').toLowerCase();
    if(!/^(mp4|mov|m4v|webm|mkv|avi|flv|wmv|3gp)$/.test(ext)&&f.type.indexOf('video')<0){
      toast('已跳过非视频文件：'+f.name,true);continue;
    }
    if(items.some(function(x){return x.name===f.name&&x.size===f.size;})) continue;
    items.push({id:++uid,file:f,name:f.name,size:f.size,progress:0,stage:'等待读取'});
    added++;
  }
  if(added){
    renderList();prepareAll();
    toast('已添加 '+added+' 个视频文件');
  }
}
function removeItem(it){
  if(running) return;
  items=items.filter(function(x){return x.id!==it.id;});
  renderList();
}

/* ---------- 探测信息 + 首帧缩略图 ---------- */
function readVideoMeta(it){
  return new Promise(function(res,rej){
    var url=URL.createObjectURL(it.file);
    var v=document.createElement('video');
    v.preload='metadata';v.muted=true;v.playsInline=true;v.src=url;
    var done=false;
    function finish(err){
      if(done) return;
      done=true;
      URL.revokeObjectURL(url);
      if(err) rej(err); else res(v);
    }
    v.onloadedmetadata=function(){
      if(isFinite(v.duration)&&v.duration>0) it.dur=v.duration;
      if(v.videoWidth) it.width=v.videoWidth;
      if(v.videoHeight) it.height=v.videoHeight;
      try{
        var cv=document.createElement('canvas');cv.width=56;cv.height=40;
        v.onseeked=function(){
          try{
            var g=cv.getContext('2d');
            var ar=v.videoWidth/v.videoHeight;
            var dw=56,dh=Math.round(56/ar);
            if(dh>40){dh=40;dw=Math.round(40*ar);}
            g.fillStyle='#0b1120';g.fillRect(0,0,56,40);
            g.drawImage(v,(56-dw)/2,(40-dh)/2,dw,dh);
            it.thumb=cv;
          }catch(e){}
          finish(null);
        };
        v.currentTime=Math.min(0.2,Math.max(0.01,(v.duration||1)*0.1));
        setTimeout(function(){finish(null);},3000);
      }catch(e){finish(null);}
    };
    v.onerror=function(){finish(new Error('浏览器无法解码该视频'));};
  });
}
async function prepareAll(){
  if(prepRunning) return;
  prepRunning=true;
  for(;;){
    var it=null;
    for(var i=0;i<items.length;i++){
      if(!items[i].probed&&!items[i].probing&&!items[i].err&&!items[i].prepErr){it=items[i];break;}
    }
    if(!it) break;
    it.probing=true;renderList();
    try{
      var info=null;
      if(typeof VideoEngine!=='undefined'&&VideoEngine.probe){
        try{info=await VideoEngine.probe(it.file);}catch(e){info=null;}
      }
      it.probed=true;
      if(info){
        it.dur=info.duration||it.dur;
        it.width=info.width||it.width;
        it.height=info.height||it.height;
        it.fps=info.fps||0;
        it.vcodec=info.videoCodec?(String(info.videoCodec).split('.')[0].toUpperCase()):'';
        if(info.audioCodec) it.acodec=info.audioCodec;
        it.info=info;
      }
      await readVideoMeta(it);
      if(!it.width||!it.height) throw new Error('无法读取视频信息');
    }catch(err){
      it.err=err.message||'读取失败';
    }
    it.probing=false;
    renderList();
    await new Promise(function(r){setTimeout(r,10);});
  }
  prepRunning=false;
}

/* ---------- 预览 ---------- */
var previewEl=null;
function previewItem(it){
  if(it.result&&it.result.data){
    openPreview(new Blob([it.result.data],{type:it.result.meta&&it.result.meta.format==='webm'?'video/webm':'video/mp4'}),it.result.name);
    return;
  }
  openPreview(it.file,it.name);
}
function openPreview(src,name){
  var box=$('vdPreview');
  var url=(src instanceof Blob)?URL.createObjectURL(src):src;
  box.classList.add('open');
  $('vdPreviewVideo').src=url;
  $('vdPreviewName').textContent=name||'视频预览';
  $('vdPreviewVideo').play().catch(function(){});
  previewEl=url;
}
function closePreview(){
  var box=$('vdPreview');
  box.classList.remove('open');
  var v=$('vdPreviewVideo');
  v.pause();v.removeAttribute('src');v.load();
  if(previewEl){try{URL.revokeObjectURL(previewEl);}catch(e){}previewEl=null;}
}
$('vdPreviewClose').addEventListener('click',closePreview);
$('vdPreview').addEventListener('click',function(e){if(e.target===$('vdPreview')) closePreview();});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&$('vdPreview').classList.contains('open')) closePreview();});

/* ---------- 转码 ---------- */
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms||0);});};
function canRun(){
  if(typeof VideoEngine==='undefined'){toast('视频引擎未加载',true);return false;}
  if(support&&support.encode){
    if(state.fmt==='mp4'&&support.encode.h264===false){toast('当前浏览器不支持 H.264 编码，请改用 WebM',true);return false;}
    if(state.fmt==='webm'&&support.encode.vp9===false&&support.encode.vp8===false){toast('当前浏览器不支持 VP9/VP8 编码',true);return false;}
  }
  return true;
}
async function convertOne(it){
  it.working=true;it.err='';it.result=null;it.progress=0;it.stage='准备中';
  renderList();
  if(!it.probed){
    try{
      if(typeof VideoEngine!=='undefined'&&VideoEngine.probe){
        var info=await VideoEngine.probe(it.file);
        it.dur=info.duration;it.width=info.width;it.height=info.height;
        it.fps=info.fps;it.vcodec=String(info.videoCodec||'').split('.')[0].toUpperCase();it.probed=true;it.info=info;
      }
    }catch(e){}
  }
  var opts=convertOpts(it);
  var t0=performance.now();
  var hasSoftHevc2 = (typeof VideoEngine !== 'undefined' && VideoEngine.hevcSoftware) || (support && support.decode && support.decode.hevcSoftware);
  var softHevc = it.vcodec && /^(HVC1|HEV1)$/.test(it.vcodec) && !(support && support.decode && support.decode.hevc) && !!hasSoftHevc2;
  it.stage = softHevc ? 'HEVC 软解中（较慢）' : '解码 + 编码中';
  var res=await VideoEngine.convert(it.file,opts,{
    onProgress:function(p){
      it.progress=Math.max(0,Math.min(1,p));
      updateBar(it);
    },
    onLog:function(msg){
      if(msg&&/帧|frame|音频|audio|软解|HEVC/i.test(msg)) it.stage=String(msg).slice(0,40);
    },
    isCancelled:function(){return cancelled;}
  });
  var data=res.data||res;
  it.progress=1;
  it.result={
    data:data,
    name:outName(it),
    size:data.length,
    meta:res.meta||{},
    fmt:state.fmt,
    ms:Math.round(performance.now()-t0)
  };
  it.working=false;it.stage='已完成';
  renderList();
}
async function runList(list){
  running=true;cancelled=false;updateButtons();
  $('vdGlobalBar').style.width='0%';
  var done=0;
  for(var i=0;i<list.length;i++){
    if(cancelled) break;
    var it=list[i];
    try{
      await convertOne(it);
    }catch(err){
      it.working=false;
      it.err=(cancelled?'已取消':(err&&err.message)||'转码失败');
      it.stage='失败';
      renderList();
      if(cancelled) break;
    }
    done++;
    $('vdGlobalBar').style.width=Math.round(done/list.length*100)+'%';
    await sleep(30);
  }
  running=false;cancelled=false;updateButtons();
}
async function convertItem(it){
  if(running){toast('正在转码中，请稍候',true);return;}
  if(!canRun()) return;
  it.err='';it.result=null;
  await runList([it]);
  if(it.err) toast(it.err,true);
  else if(it.result) toast('已输出 '+it.result.name);
  renderList();
}
async function convertAll(){
  if(running) return;
  var pending=items.filter(function(i){return !i.result&&(!i.err||i.err==='已取消');});
  if(!pending.length){toast('没有待转码的文件',true);return;}
  if(!canRun()) return;
  await runList(pending);
  var ok=items.filter(function(x){return x.result;}).length;
  var fail=items.filter(function(x){return x.err;}).length;
  if(cancelled) toast('已取消转码',true);
  else toast('转码完成：成功 '+ok+' 个'+(fail?'，失败 '+fail+' 个':''),fail>0);
}
$('vdStop').addEventListener('click',function(){cancelled=true;});

/* ---------- UI ---------- */
function updateFmtUI(){
  document.querySelectorAll('#vdFmtGrid .fmt-chip').forEach(function(b){b.classList.toggle('on',b.dataset.fmt===state.fmt);});
  $('vdFmtNote').textContent=FMT_NOTE[state.fmt];
  updateOutBox();
}
function updateBrUI(){
  var br=curBr();
  $('vdBrVal').textContent=br?bitrateLabel(br):'自动';
  var el=$('vdBitrate');
  el.value=state.brIdx;
  el.style.setProperty('--p',(state.brIdx/(BR_LIST.length-1)*100)+'%');
  var hint='自动按分辨率推荐，通常比原文件小 60–90%。';
  if(br>=5000) hint='高码率适合本地收藏或再剪辑，体积较大。';
  else if(br&&br<=1200) hint='低码率适合手机分享，运动画面可能出现块状。';
  $('vdBrHint').textContent=hint;
  updateOutBox();
}
function updateOutBox(){
  var spec=(state.fmt==='mp4'?'H.264':'VP9');
  var res=resLabel(state.res);
  var br=curBr();
  var fps=state.fps?state.fps+' fps':'原帧率';
  var audio=state.audio==='drop'?'无音轨':(state.audio==='keep'?'128':state.audio.replace('keep',''))+'k 音频';
  $('vdOutBox').innerHTML='<div class="au-out-fmt">'+FMT_LABEL[state.fmt]+'</div>'+
    '<div class="au-out-meta">'+spec+' · '+res+' · '+(br?bitrateLabel(br):'自动码率')+' · '+fps+' · '+audio+'</div>';
}
document.querySelectorAll('#vdFmtGrid .fmt-chip').forEach(function(b){
  b.addEventListener('click',function(){
    if(b.disabled) return;
    state.fmt=b.dataset.fmt;updateFmtUI();
  });
});
$('vdResolution').addEventListener('change',function(){state.res=+this.value;updateOutBox();});
$('vdBitrate').addEventListener('input',function(){state.brIdx=+this.value;updateBrUI();});
$('vdFps').addEventListener('change',function(){state.fps=+this.value;updateOutBox();});
$('vdAudio').addEventListener('change',function(){state.audio=this.value;updateOutBox();});
$('vdNameMode').addEventListener('change',function(){state.nameMode=this.value;});
document.querySelectorAll('#vdPreset button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#vdPreset button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    var p=b.dataset.preset;
    state.fmt='mp4';state.res=720;state.brIdx=BR_LIST.indexOf(2500);state.fps=30;state.audio='keep';
    if(p==='web'){state.res=1080;state.brIdx=BR_LIST.indexOf(3500);state.fps=30;}
    if(p==='small'){state.res=480;state.brIdx=BR_LIST.indexOf(800);state.fps=24;}
    if(p==='hd'){state.res=0;state.brIdx=BR_LIST.indexOf(8000);state.fps=0;}
    $('vdResolution').value=String(state.res);
    $('vdFps').value=String(state.fps);
    $('vdAudio').value=state.audio;
    updateFmtUI();updateBrUI();
  });
});

var drop=$('vdDrop'),picker=$('vdPicker');
drop.addEventListener('click',function(){picker.click();});
$('vdPickBtn').addEventListener('click',function(ev){ev.stopPropagation();picker.click();});
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
  if(e.target.closest&&e.target.closest('#vdDrop')) return;
  e.preventDefault();
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$('vdClearList').addEventListener('click',function(){if(!running){items=[];renderList();}});
$('vdClearAll').addEventListener('click',function(){if(!running){items=[];$('vdGlobalBar').style.width='0%';renderList();}});
$('vdStart').addEventListener('click',convertAll);
$('vdZip').addEventListener('click',function(){
  var ok=items.filter(function(i){return i.result;});
  if(!ok.length){toast('还没有可下载的文件',true);return;}
  if(typeof CDREngine==='undefined'||!CDREngine.makeZipFromFiles){toast('打包模块不可用',true);return;}
  var zip=CDREngine.makeZipFromFiles(ok.map(function(i){return {name:i.result.name,data:i.result.data};}));
  downloadBytes(zip,'视频转码_'+new Date().toISOString().slice(0,10)+'.zip');
  toast('已打包 '+ok.length+' 个文件');
});

/* ---------- 能力检测 ---------- */
function detectSupport(){
  if(typeof VideoEngine==='undefined'||!VideoEngine.support) return;
  VideoEngine.support().then(function(cap){
    support=cap;
    if(!cap) return;
    var bad=false;
    if(cap.encode&&cap.encode.h264===false){
      var m=document.querySelector('#vdFmtGrid [data-fmt=mp4]');
      if(m){m.classList.add('off');m.disabled=true;m.querySelector('span').textContent='当前内核不支持';}
      bad=true;
    }
    if(cap.encode&&cap.encode.vp9===false&&cap.encode.vp8===false){
      var w=document.querySelector('#vdFmtGrid [data-fmt=webm]');
      if(w){w.classList.add('off');w.disabled=true;w.querySelector('span').textContent='当前内核不支持';}
      bad=true;
    }
    if(bad){
      $('vdSupportNote').innerHTML='<strong>兼容性</strong>：当前浏览器缺少部分视频编码器（WebCodecs 需 Chrome/Edge 94+）。可用的输出格式已自动保留。';
      if(state.fmt==='mp4'&&cap.encode&&cap.encode.h264===false) state.fmt='webm';
      if(state.fmt==='webm'&&cap.encode&&cap.encode.vp9===false&&cap.encode.vp8===false) state.fmt='mp4';
      updateFmtUI();
    }
  }).catch(function(){});
}

updateFmtUI();updateBrUI();
$('vdBitrate').style.setProperty('--p','0%');
detectSupport();
renderList();
window.VideoPanel={getItems:function(){return items;},addFiles:addFiles,state:state,convertAll:convertAll};
})();
