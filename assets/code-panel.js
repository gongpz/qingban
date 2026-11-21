/* ==================== 二维码 / 条形码模块 ==================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var panel=$('panel-code');
if(!panel) return;
var hasCT=(typeof CodeTools!=='undefined');
var hasQR=hasCT&&CodeTools.qr&&CodeTools.qr.encode;
var hasBar=hasCT&&CodeTools.barcode&&CodeTools.barcode.encode;

/* ================== 标签页 ================== */
var tabs=document.querySelectorAll('#codeTabs .code-tab');
var panes={qr:$('codeQr'),bar:$('codeBar'),dec:$('codeDec')};
var curTab='qr';
tabs.forEach(function(t){
  t.addEventListener('click',function(){
    curTab=t.dataset.tab;
    tabs.forEach(function(x){x.classList.toggle('on',x===t);});
    Object.keys(panes).forEach(function(k){panes[k].classList.toggle('hidden',k!==curTab);});
    if(curTab==='qr') renderQR();
    if(curTab==='bar') renderBar();
  });
});

/* ================== 二维码：内容构建 ================== */
var qrState={
  type:'text',ecl:'M',size:512,margin:4,
  dot:'square',finder:'square',
  fg:'#2b2013',bg:'#ffffff',
  grad:false,fg2:'#f5a623',gradDir:'diag',transparent:false,
  logo:null,logoName:'',logoSize:20,logoShape:'square',logoPad:true
};
var qrValues={
  text:{text:'轻办 · 本地工具'},
  url:{url:'https://'},
  wifi:{ssid:'',pwd:'',enc:'WPA',hidden:false},
  vcard:{name:'',org:'',title:'',tel:'',email:'',url:'',addr:''},
  sms:{tel:'',msg:''},
  tel:{tel:''}
};
var QFIELDS={
  text:[{k:'text',label:'文本内容',type:'textarea',ph:'输入要编码的文字、链接或任意内容…'}],
  url:[{k:'url',label:'网址',type:'text',ph:'https://example.com'}],
  wifi:[
    {k:'ssid',label:'WiFi 名称（SSID）',type:'text',ph:'MyWiFi'},
    {k:'pwd',label:'密码',type:'text',ph:'留空表示无密码'},
    {k:'enc',label:'加密方式',type:'select',opts:[['WPA','WPA/WPA2/WPA3'],['WEP','WEP'],['nopass','无密码']]},
    {k:'hidden',label:'隐藏网络',type:'check'}
  ],
  vcard:[
    {k:'name',label:'姓名',type:'text',ph:'张三'},
    {k:'org',label:'公司 / 组织',type:'text',ph:'轻办工作室'},
    {k:'title',label:'职位',type:'text',ph:'设计师'},
    {k:'tel',label:'电话',type:'text',ph:'13800000000'},
    {k:'email',label:'邮箱',type:'text',ph:'name@example.com'},
    {k:'url',label:'网站',type:'text',ph:'https://example.com'},
    {k:'addr',label:'地址',type:'text',ph:'浙江省杭州市…'}
  ],
  sms:[
    {k:'tel',label:'收件号码',type:'text',ph:'13800000000'},
    {k:'msg',label:'短信内容',type:'textarea',ph:'您好，我想咨询…'}
  ],
  tel:[{k:'tel',label:'电话号码',type:'text',ph:'13800000000'}]
};
function escWifi(s){return String(s==null?'':s).replace(/([\\;,":])/g,'\\$1');}
function escV(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}
function buildPayload(){
  var t=qrState.type,v=qrValues[t];
  if(t==='text') return v.text||'';
  if(t==='url'){
    var u=(v.url||'').trim();
    if(!u) return '';
    if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) u='https://'+u;
    return u;
  }
  if(t==='wifi'){
    if(!(v.ssid||'').trim()) return '';
    var s='WIFI:T:'+(v.enc==='nopass'?'nopass':v.enc)+';S:'+escWifi(v.ssid)+';';
    if(v.enc!=='nopass'&&v.pwd) s+='P:'+escWifi(v.pwd)+';';
    if(v.hidden) s+='H:true;';
    return s+';';
  }
  if(t==='vcard'){
    var lines=['BEGIN:VCARD','VERSION:3.0'];
    var name=(v.name||'').trim();
    if(name) lines.push('FN:'+escV(name));
    if(name) lines.push('N:'+escV(name)+';;;;');
    if((v.org||'').trim()) lines.push('ORG:'+escV(v.org));
    if((v.title||'').trim()) lines.push('TITLE:'+escV(v.title));
    if((v.tel||'').trim()) lines.push('TEL;TYPE=CELL:'+escV(v.tel));
    if((v.email||'').trim()) lines.push('EMAIL:'+escV(v.email));
    if((v.url||'').trim()) lines.push('URL:'+escV(v.url));
    if((v.addr||'').trim()) lines.push('ADR:;;'+escV(v.addr)+';;;;');
    lines.push('END:VCARD');
    if(lines.length<=3) return '';
    return lines.join('\n');
  }
  if(t==='sms'){
    var tel=(v.tel||'').trim(),msg=v.msg||'';
    if(!tel&&!msg) return '';
    return 'SMSTO:'+tel+':'+msg;
  }
  if(t==='tel'){
    var tp=(v.tel||'').trim();
    return tp?'tel:'+tp:'';
  }
  return '';
}
function renderFields(){
  var box=$('qrFields'),fields=QFIELDS[qrState.type];
  box.innerHTML='';
  fields.forEach(function(f){
    var d=document.createElement('div');d.className='field';
    var id='qf_'+f.k;
    if(f.type==='check'){
      d.innerHTML='<label class="chk"><input type="checkbox" id="'+id+'"><span><b>'+f.label+'</b></span></label>';
    }else if(f.type==='select'){
      var opts=f.opts.map(function(o){return '<option value="'+o[0]+'">'+o[1]+'</option>';}).join('');
      d.innerHTML='<label>'+f.label+'</label><select class="input" id="'+id+'">'+opts+'</select>';
    }else if(f.type==='textarea'){
      d.innerHTML='<label>'+f.label+'</label><textarea class="input" id="'+id+'" style="min-height:76px" placeholder="'+(f.ph||'')+'"></textarea>';
    }else{
      d.innerHTML='<label>'+f.label+'</label><input class="input" type="text" id="'+id+'" placeholder="'+(f.ph||'')+'">';
    }
    box.appendChild(d);
    var el=d.querySelector('#'+id);
    var val=qrValues[qrState.type][f.k];
    if(f.type==='check') el.checked=!!val;
    else el.value=val==null?'':val;
    var h=function(){
      qrValues[qrState.type][f.k]=f.type==='check'?el.checked:el.value;
      scheduleQR();
    };
    el.addEventListener(f.type==='select'||f.type==='check'?'change':'input',h);
  });
}
document.querySelectorAll('#qrTypeChips .type-chip').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#qrTypeChips .type-chip').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    qrState.type=b.dataset.type;
    renderFields();renderQR();
  });
});
document.querySelectorAll('#qrEclSeg button').forEach(function(b){
  b.addEventListener('click',function(){
    setSeg('#qrEclSeg',b.dataset.v);
    qrState.ecl=b.dataset.v;
    var map={L:'L 级容错 7%：容量最大，适合清晰印刷。',M:'M 级容错 15%：通用选择。',Q:'Q 级容错 25%：适合印刷磨损。',H:'H 级容错 30%：带 Logo 必须选它。'};
    $('qrEclHint').textContent=map[qrState.ecl];
    if(qrState.logo&&qrState.ecl!=='H') toast('带 Logo 建议使用 H 级纠错',false);
    renderQR();
  });
});
function setSeg(sel,val){
  document.querySelectorAll(sel+' button').forEach(function(x){x.classList.toggle('on',x.dataset.v===val);});
}
$('qrSize').addEventListener('input',function(){
  qrState.size=+this.value;
  $('qrSizeVal').textContent=qrState.size+' px';
  this.style.setProperty('--p',((qrState.size-128)/(2048-128)*100)+'%');
  renderQR();
});
$('qrMargin').addEventListener('input',function(){
  qrState.margin=+this.value;
  $('qrMarginVal').textContent=qrState.margin;
  this.style.setProperty('--p',(qrState.margin/8*100)+'%');
  renderQR();
});
$('qrFg').addEventListener('input',function(){qrState.fg=this.value;renderQR();});
$('qrBg').addEventListener('input',function(){qrState.bg=this.value;renderQR();});
$('qrFg2').addEventListener('input',function(){qrState.fg2=this.value;renderQR();});
$('qrGrad').addEventListener('change',function(){qrState.grad=this.checked;renderQR();});
$('qrTransparent').addEventListener('change',function(){qrState.transparent=this.checked;renderQR();});
$('qrGradDir').querySelectorAll('button').forEach(function(b){
  b.addEventListener('click',function(){setSeg('#qrGradDir',b.dataset.v);qrState.gradDir=b.dataset.v;renderQR();});
});
document.querySelectorAll('#qrSwatches .code-swatch').forEach(function(s){
  s.addEventListener('click',function(){
    qrState.fg=s.dataset.fg;qrState.bg=s.dataset.bg;
    if(s.dataset.fg2) qrState.fg2=s.dataset.fg2;
    syncQrControls();
    renderQR();
  });
});
document.querySelectorAll('#qrDotSeg button').forEach(function(b){
  b.addEventListener('click',function(){setSeg('#qrDotSeg',b.dataset.v);qrState.dot=b.dataset.v;renderQR();});
});
document.querySelectorAll('#qrFinderSeg button').forEach(function(b){
  b.addEventListener('click',function(){setSeg('#qrFinderSeg',b.dataset.v);qrState.finder=b.dataset.v;renderQR();});
});
document.querySelectorAll('#qrLogoShape button').forEach(function(b){
  b.addEventListener('click',function(){setSeg('#qrLogoShape',b.dataset.v);qrState.logoShape=b.dataset.v;renderQR();});
});
$('qrLogoSize').addEventListener('input',function(){
  qrState.logoSize=+this.value;
  $('qrLogoSizeVal').textContent=qrState.logoSize+'%';
  this.style.setProperty('--p',((qrState.logoSize-14)/(30-14)*100)+'%');
  renderQR();
});
$('qrLogoPad').addEventListener('change',function(){qrState.logoPad=this.checked;renderQR();});
document.querySelectorAll('#qrPresets button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#qrPresets button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    applyQrPreset(b.dataset.preset);
  });
});
function applyQrPreset(name){
  if(name==='classic'){qrState.dot='square';qrState.finder='square';qrState.fg='#2b2013';qrState.bg='#ffffff';qrState.grad=false;qrState.transparent=false;}
  else if(name==='dot'){qrState.dot='dot';qrState.finder='circle';qrState.fg='#e8890c';qrState.fg2='#c97407';qrState.bg='#ffffff';qrState.grad=false;qrState.transparent=false;}
  else if(name==='grad'){qrState.dot='round';qrState.finder='round';qrState.fg='#e8890c';qrState.fg2='#7c3aed';qrState.bg='#ffffff';qrState.grad=true;qrState.gradDir='diag';qrState.transparent=false;}
  else if(name==='invert'){qrState.dot='square';qrState.finder='square';qrState.fg='#ffffff';qrState.bg='#12192a';qrState.grad=false;qrState.transparent=false;}
  syncQrControls();
  renderQR();
}
function syncQrControls(){
  $('qrFg').value=qrState.fg;
  $('qrBg').value=qrState.bg;
  $('qrFg2').value=qrState.fg2;
  $('qrGrad').checked=qrState.grad;
  $('qrTransparent').checked=qrState.transparent;
  $('qrLogoSize').value=qrState.logoSize;
  $('qrLogoSizeVal').textContent=qrState.logoSize+'%';
  $('qrLogoSize').style.setProperty('--p',((qrState.logoSize-14)/(30-14)*100)+'%');
  $('qrLogoPad').checked=qrState.logoPad;
  setSeg('#qrDotSeg',qrState.dot);
  setSeg('#qrFinderSeg',qrState.finder);
  setSeg('#qrLogoShape',qrState.logoShape);
  setSeg('#qrGradDir',qrState.gradDir);
}
$('qrLogoPick').addEventListener('click',function(){$('qrLogoInput').click();});
$('qrLogoInput').addEventListener('change',function(){
  var f=this.files&&this.files[0];
  if(!f) return;
  var r=new FileReader();
  r.onload=function(){
    var img=new Image();
    img.onload=function(){
      qrState.logo=img;qrState.logoName=f.name;
      $('qrLogoName').textContent=f.name;
      $('qrLogoClear').style.display='';
      if(qrState.ecl!=='H'){
        qrState.ecl='H';
        setSeg('#qrEclSeg','H');
        $('qrEclHint').textContent='已自动切换为 H 级（30%），保证 Logo 遮挡后仍可扫码。';
      }
      renderQR();
    };
    img.src=r.result;
  };
  r.readAsDataURL(f);
  this.value='';
});
$('qrLogoClear').addEventListener('click',function(){
  qrState.logo=null;qrState.logoName='';
  $('qrLogoName').textContent='未选择';
  this.style.display='none';
  renderQR();
});

var lastModel=null,lastText='';
function scheduleQR(){
  clearTimeout(scheduleQR._t);
  scheduleQR._t=setTimeout(renderQR,140);
}
function isFinder(x,y,n){
  return (x<7&&y<7)||(x>=n-7&&y<7)||(x<7&&y>=n-7);
}
function rrPath(g,x,y,w,h,r){
  r=Math.min(r,w/2,h/2);
  g.beginPath();
  g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);
  g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();
}
function fillRR(g,x,y,w,h,r){rrPath(g,x,y,w,h,r);g.fill();}
function fillCircle(g,cx,cy,r){g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.fill();}
function drawDiamond(g,cx,cy,r){
  g.beginPath();g.moveTo(cx,cy-r);g.lineTo(cx+r,cy);g.lineTo(cx,cy+r);g.lineTo(cx-r,cy);g.closePath();g.fill();
}
function qrFill(g,dim){
  if(!qrState.grad) return qrState.fg;
  var grd;
  if(qrState.gradDir==='h') grd=g.createLinearGradient(0,0,dim,0);
  else if(qrState.gradDir==='v') grd=g.createLinearGradient(0,0,0,dim);
  else grd=g.createLinearGradient(0,0,dim,dim);
  grd.addColorStop(0,qrState.fg);
  grd.addColorStop(1,qrState.fg2);
  return grd;
}
function drawFinder(g,mx,my,ms,style,fill){
  var s=7*ms;
  g.fillStyle=fill;g.strokeStyle=fill;
  if(style==='circle'){
    g.lineWidth=ms;
    g.beginPath();g.arc(mx+s/2,my+s/2,3*ms,0,Math.PI*2);g.stroke();
    g.beginPath();g.arc(mx+s/2,my+s/2,1.5*ms,0,Math.PI*2);g.fill();
  }else if(style==='round'){
    g.lineWidth=ms;
    rrPath(g,mx+ms/2,my+ms/2,s-ms,s-ms,ms*1.7);g.stroke();
    fillRR(g,mx+2*ms,my+2*ms,3*ms,3*ms,ms*0.9);
  }else{
    g.fillRect(mx,my,s,ms);g.fillRect(mx,my+6*ms,s,ms);
    g.fillRect(mx,my,ms,s);g.fillRect(mx+6*ms,my,ms,s);
    g.fillRect(mx+2*ms,my+2*ms,3*ms,3*ms);
  }
  g.lineWidth=1;
}
function renderQR(){
  var canvas=$('qrCanvas'),errBox=$('qrErr');
  var text=buildPayload();
  lastText=text;
  var bytes=text?new TextEncoder().encode(text).length:0;
  $('qrBytes').textContent=bytes;
  $('qrCapHint').textContent='当前 '+bytes+' 字节 · 单码上限约 2953 字节';
  if(!hasQR){
    errBox.classList.remove('hidden');
    errBox.textContent='二维码编码器未加载';
    return;
  }
  if(!text){
    lastModel=null;
    canvas.width=200;canvas.height=200;
    var g0=canvas.getContext('2d');
    g0.clearRect(0,0,200,200);
    if(!qrState.transparent){g0.fillStyle=qrState.bg;g0.fillRect(0,0,200,200);}
    errBox.classList.remove('hidden');errBox.textContent='输入内容后自动生成二维码';
    $('qrVersion').textContent='—';$('qrModules').textContent='—';$('qrEclOut').textContent='—';
    return;
  }
  var model;
  try{
    model=CodeTools.qr.encode(text,{ecl:qrState.ecl,mask:-1});
  }catch(e){
    lastModel=null;
    errBox.classList.remove('hidden');
    errBox.textContent='内容太长，无法生成二维码（'+(e.message||'超出容量')+'），请缩短内容或降低纠错等级。';
    $('qrVersion').textContent='—';
    return;
  }
  errBox.classList.add('hidden');
  lastModel=model;
  var n=model.size,margin=qrState.margin,total=n+margin*2;
  var ms=Math.max(1,Math.floor(qrState.size/total));
  var dim=ms*total;
  canvas.width=dim;canvas.height=dim;
  var g=canvas.getContext('2d');
  g.setTransform(1,0,0,1,0,0);
  g.imageSmoothingEnabled=false;
  g.clearRect(0,0,dim,dim);
  if(!qrState.transparent){g.fillStyle=qrState.bg;g.fillRect(0,0,dim,dim);}
  var fill=qrFill(g,dim);
  var style=qrState.dot;
  for(var y=0;y<n;y++){
    for(var x=0;x<n;x++){
      if(!model.matrix[y*n+x]) continue;
      if(isFinder(x,y,n)) continue;
      var px=(margin+x)*ms,py=(margin+y)*ms;
      g.fillStyle=fill;
      if(style==='square') g.fillRect(px,py,ms,ms);
      else if(style==='round') fillRR(g,px+ms*0.04,py+ms*0.04,ms*0.92,ms*0.92,ms*0.36);
      else if(style==='dot') fillCircle(g,px+ms/2,py+ms/2,ms*0.47);
      else drawDiamond(g,px+ms/2,py+ms/2,ms*0.53);
    }
  }
  [[0,0],[n-7,0],[0,n-7]].forEach(function(p){
    drawFinder(g,(margin+p[0])*ms,(margin+p[1])*ms,ms,qrState.finder,fill);
  });
  if(qrState.logo){
    var lw=Math.round(dim*qrState.logoSize/100);
    var lx=Math.round((dim-lw)/2),ly=lx;
    var pad=Math.max(ms,Math.round(lw*0.075));
    if(qrState.logoPad){
      var boxW=lw+pad*2;
      g.fillStyle=qrState.transparent?'#ffffff':qrState.bg;
      if(qrState.logoShape==='circle') fillCircle(g,lx+lw/2,ly+lw/2,boxW/2);
      else fillRR(g,lx-pad,ly-pad,boxW,boxW,Math.round(ms*1.8));
    }
    if(qrState.logoShape==='circle'){
      g.save();
      g.beginPath();g.arc(lx+lw/2,ly+lw/2,lw/2,0,Math.PI*2);g.clip();
      g.drawImage(qrState.logo,lx,ly,lw,lw);
      g.restore();
    }else{
      g.drawImage(qrState.logo,lx,ly,lw,lw);
    }
  }
  $('qrVersion').textContent='V'+model.version;
  $('qrModules').textContent=model.size+'×'+model.size;
  $('qrEclOut').textContent=model.ecl||qrState.ecl;
}
function qrSVGText(){
  if(!lastModel) return null;
  var m=lastModel,n=m.size,margin=qrState.margin,ms=10,total=n+margin*2,dim=total*ms;
  var shapes=[];
  var style=qrState.dot;
  for(var y=0;y<n;y++){
    for(var x=0;x<n;x++){
      if(!m.matrix[y*n+x]) continue;
      if(isFinder(x,y,n)) continue;
      var px=(margin+x)*ms,py=(margin+y)*ms;
      if(style==='square') shapes.push('<rect x="'+px+'" y="'+py+'" width="'+ms+'" height="'+ms+'"/>');
      else if(style==='round') shapes.push('<rect x="'+(px+ms*0.04)+'" y="'+(py+ms*0.04)+'" width="'+(ms*0.92)+'" height="'+(ms*0.92)+'" rx="'+(ms*0.36)+'"/>');
      else if(style==='dot') shapes.push('<circle cx="'+(px+ms/2)+'" cy="'+(py+ms/2)+'" r="'+(ms*0.47)+'"/>');
      else{
        var cx=px+ms/2,cy=py+ms/2,r=ms*0.53;
        shapes.push('<polygon points="'+cx+','+(cy-r)+' '+(cx+r)+','+cy+' '+cx+','+(cy+r)+' '+(cx-r)+','+cy+'"/>');
      }
    }
  }
  function finderSVG(mx,my,st,fill){
    var s=7*ms;
    if(st==='circle'){
      return '<circle cx="'+(mx+s/2)+'" cy="'+(my+s/2)+'" r="'+(3*ms)+'" fill="none" stroke="'+fill+'" stroke-width="'+ms+'"/>'+
             '<circle cx="'+(mx+s/2)+'" cy="'+(my+s/2)+'" r="'+(1.5*ms)+'"/>';
    }
    if(st==='round'){
      return '<rect x="'+(mx+ms/2)+'" y="'+(my+ms/2)+'" width="'+(s-ms)+'" height="'+(s-ms)+'" rx="'+(ms*1.7)+'" fill="none" stroke="'+fill+'" stroke-width="'+ms+'"/>'+
             '<rect x="'+(mx+2*ms)+'" y="'+(my+2*ms)+'" width="'+(3*ms)+'" height="'+(3*ms)+'" rx="'+(ms*0.9)+'"/>';
    }
    return '<rect x="'+mx+'" y="'+my+'" width="'+s+'" height="'+ms+'"/>'+
           '<rect x="'+mx+'" y="'+(my+6*ms)+'" width="'+s+'" height="'+ms+'"/>'+
           '<rect x="'+mx+'" y="'+my+'" width="'+ms+'" height="'+s+'"/>'+
           '<rect x="'+(mx+6*ms)+'" y="'+my+'" width="'+ms+'" height="'+s+'"/>'+
           '<rect x="'+(mx+2*ms)+'" y="'+(my+2*ms)+'" width="'+(3*ms)+'" height="'+(3*ms)+'"/>';
  }
  var fillAttr=qrState.grad?'url(#qg)':qrState.fg;
  var finderParts=[[0,0],[n-7,0],[0,n-7]].map(function(p){
    return finderSVG((margin+p[0])*ms,(margin+p[1])*ms,qrState.finder,fillAttr);
  }).join('\n');
  var bgRect=qrState.transparent?'':'<rect width="100%" height="100%" fill="'+qrState.bg+'"/>';
  var defs='';
  if(qrState.grad){
    var x2=qrState.gradDir==='v'?0:dim, y2=qrState.gradDir==='h'?0:dim;
    defs='<defs><linearGradient id="qg" x1="0" y1="0" x2="'+x2+'" y2="'+y2+'" gradientUnits="userSpaceOnUse">'+
      '<stop offset="0" stop-color="'+qrState.fg+'"/><stop offset="1" stop-color="'+qrState.fg2+'"/></linearGradient></defs>';
  }
  var logo='';
  if(qrState.logo){
    var lw=dim*qrState.logoSize/100,lx=(dim-lw)/2,pad=Math.max(ms,lw*0.075);
    var boxW=lw+pad*2;
    if(qrState.logoPad){
      if(qrState.logoShape==='circle') logo+='<circle cx="'+(lx+lw/2)+'" cy="'+(lx+lw/2)+'" r="'+(boxW/2)+'" fill="'+(qrState.transparent?'#ffffff':qrState.bg)+'"/>';
      else logo+='<rect x="'+(lx-pad)+'" y="'+(lx-pad)+'" width="'+boxW+'" height="'+boxW+'" rx="'+(ms*1.8)+'" fill="'+(qrState.transparent?'#ffffff':qrState.bg)+'"/>';
    }
    if(qrState.logoShape==='circle'){
      logo+='<clipPath id="lclip"><circle cx="'+(lx+lw/2)+'" cy="'+(lx+lw/2)+'" r="'+(lw/2)+'"/></clipPath>'+
        '<image x="'+lx+'" y="'+lx+'" width="'+lw+'" height="'+lw+'" clip-path="url(#lclip)" xlink:href="'+qrState.logo.src+'"/>';
    }else{
      logo+='<image x="'+lx+'" y="'+lx+'" width="'+lw+'" height="'+lw+'" xlink:href="'+qrState.logo.src+'"/>';
    }
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="'+dim+'" height="'+dim+'" viewBox="0 0 '+dim+' '+dim+'">\n'+
    defs+bgRect+'\n'+
    '<g fill="'+fillAttr+'">\n'+shapes.join('\n')+'\n'+finderParts+'\n</g>\n'+logo+'\n</svg>';
}
function downloadBlob(blob,name){
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href);},3000);
}
function qrFileName(ext){
  var t=(lastText||'qrcode').split('\n')[0].replace(/[\\/:*?"<>|]/g,'_').slice(0,32);
  return (t||'qrcode')+'.'+ext;
}
$('qrDownloadPng').addEventListener('click',function(){
  if(!lastModel){toast('请先输入内容生成二维码',true);return;}
  $('qrCanvas').toBlob(function(b){ if(b) downloadBlob(b,qrFileName('png')); else toast('导出失败',true); },'image/png');
});
$('qrDownloadSvg').addEventListener('click',function(){
  var s=qrSVGText();
  if(!s){toast('请先输入内容生成二维码',true);return;}
  downloadBlob(new Blob([s],{type:'image/svg+xml;charset=utf-8'}),qrFileName('svg'));
});
$('qrCopy').addEventListener('click',function(){
  if(!lastModel){toast('请先输入内容生成二维码',true);return;}
  var canvas=$('qrCanvas');
  if(!navigator.clipboard||!window.ClipboardItem){toast('当前环境不支持复制图片，请用下载',true);return;}
  canvas.toBlob(function(b){
    if(!b) return;
    navigator.clipboard.write([new ClipboardItem({'image/png':b})]).then(function(){
      toast('二维码图片已复制到剪贴板');
    }).catch(function(){ toast('复制失败，请改用下载',true); });
  },'image/png');
});
$('qrPrint').addEventListener('click',function(){
  if(!lastModel){toast('请先输入内容生成二维码',true);return;}
  var url=$('qrCanvas').toDataURL('image/png');
  var w=window.open('','_blank');
  if(!w){toast('浏览器拦截了弹窗，请允许后重试',true);return;}
  w.document.write('<!DOCTYPE html><html><head><title>打印二维码</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff}img{width:80mm;height:80mm;image-rendering:pixelated}</style></head><body><img src="'+url+'"></body></html>');
  w.document.close();
  w.focus();
  setTimeout(function(){w.print();},300);
});

/* ================== 条形码 ================== */
var barState={
  type:'code128',barWidth:3,height:120,font:16,
  fg:'#2b2013',bg:'#ffffff',
  quiet:10,labelPos:'bottom',caption:'',border:'none',transparent:false
};
var lastBar=null;
var BAR_HINT={
  code128:'Code 128 支持全部 ASCII 字符，密度最高，物流与仓储常用。',
  code39:'Code 39 只支持数字、大写字母与少量符号，兼容老式扫描枪。',
  ean13:'EAN-13 为 13 位商品码，输入 12 位会自动补校验位。',
  ean8:'EAN-8 为 8 位短码，输入 7 位会自动补校验位。',
  upca:'UPC-A 为北美 12 位商品码，输入 11 位会自动补校验位。',
  itf14:'ITF-14 为 14 位箱码，常用于外箱包装。'
};
var BAR_PH={code128:'LIGHTWORK-2026',code39:'LIGHT2026',ean13:'690123456789',ean8:'6901234',upca:'01234567891',itf14:'1234567890123'};
document.querySelectorAll('#barTypeChips .type-chip').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#barTypeChips .type-chip').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    barState.type=b.dataset.type;
    $('barTypeHint').textContent=BAR_HINT[barState.type]||'';
    var el=$('barText');
    el.placeholder=BAR_PH[barState.type]||'';
    if(!el.dataset.touched) el.value=BAR_PH[barState.type]||'';
    renderBar();
  });
});
$('barText').addEventListener('input',function(){this.dataset.touched='1';renderBar();});
$('barBarWidth').addEventListener('input',function(){
  barState.barWidth=+this.value;
  $('barBarWidthVal').textContent=barState.barWidth+' px';
  this.style.setProperty('--p',((barState.barWidth-1)/5*100)+'%');
  renderBar();
});
$('barHeight').addEventListener('input',function(){
  barState.height=+this.value;
  $('barHeightVal').textContent=barState.height+' px';
  this.style.setProperty('--p',((barState.height-40)/220*100)+'%');
  renderBar();
});
$('barFont').addEventListener('input',function(){
  barState.font=+this.value;
  $('barFontVal').textContent=barState.font?barState.font+' px':'不显示';
  this.style.setProperty('--p',(barState.font/40*100)+'%');
  renderBar();
});
$('barQuiet').addEventListener('input',function(){
  barState.quiet=+this.value;
  $('barQuietVal').textContent=barState.quiet+' 模块';
  this.style.setProperty('--p',((barState.quiet-2)/18*100)+'%');
  renderBar();
});
document.querySelectorAll('#barLabelPos button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#barLabelPos button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    barState.labelPos=b.dataset.v;
    renderBar();
  });
});
$('barCaption').addEventListener('input',function(){barState.caption=this.value;renderBar();});
document.querySelectorAll('#barBorderSeg button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('#barBorderSeg button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');
    barState.border=b.dataset.v;
    renderBar();
  });
});
$('barTransparent').addEventListener('change',function(){barState.transparent=this.checked;renderBar();});
$('barFg').addEventListener('input',function(){barState.fg=this.value;renderBar();});
$('barBg').addEventListener('input',function(){barState.bg=this.value;renderBar();});
document.querySelectorAll('#barSwatches .code-swatch').forEach(function(s){
  s.addEventListener('click',function(){
    barState.fg=s.dataset.fg;barState.bg=s.dataset.bg;
    $('barFg').value=barState.fg;$('barBg').value=barState.bg;
    renderBar();
  });
});
function barLabel(){
  var cap=($('barCaption').value||'').trim();
  if(cap) return cap;
  return lastBar?(lastBar.text||$('barText').value):'';
}
function barMetrics(model){
  var bw=barState.barWidth,h=barState.height;
  var font=barState.labelPos==='none'?0:barState.font;
  var textH=font?Math.round(font*1.9):0;
  var vpad=Math.round((barState.font||16)*0.5)+8;
  var bpad=barState.border?10:0;
  var w=(model.modules.length+barState.quiet*2)*bw+bpad*2;
  var totalH=bpad*2+vpad*2+textH+h;
  return {
    bw:bw,h:h,font:font,textH:textH,vpad:vpad,bpad:bpad,
    w:w,totalH:totalH,
    barX0:bpad+barState.quiet*bw,
    barY:bpad+vpad+(barState.labelPos==='top'?textH:0)
  };
}
function renderBar(){
  var canvas=$('barCanvas'),err=$('barErr'),warn=$('barWarn');
  var data=$('barText').value;
  var hint=$('barTextHint');
  $('barTypeOut').textContent=barState.type.toUpperCase();
  if(!hasBar){
    err.classList.remove('hidden');err.textContent='条码编码器未加载';
    return;
  }
  var model=null,error='';
  try{
    model=CodeTools.barcode.encode(barState.type,data);
  }catch(e){
    error=e.message||'编码失败';
  }
  if(!model||model.valid===false){
    error=error||(model&&model.error)||'内容不符合该条码规则';
    warn.classList.remove('hidden');warn.textContent=error;
    lastBar=null;
    canvas.width=600;canvas.height=140;
    var g0=canvas.getContext('2d');
    g0.clearRect(0,0,600,140);
    if(!barState.transparent){g0.fillStyle=barState.bg;g0.fillRect(0,0,600,140);}
    err.classList.remove('hidden');err.textContent=error;
    $('barModulesOut').textContent='—';$('barTextOut').textContent='—';
    return;
  }
  warn.classList.add('hidden');
  err.classList.add('hidden');
  lastBar=model;
  var mt=barMetrics(model);
  canvas.width=mt.w;canvas.height=mt.totalH;
  var g=canvas.getContext('2d');
  g.setTransform(1,0,0,1,0,0);
  g.imageSmoothingEnabled=false;
  g.clearRect(0,0,mt.w,mt.totalH);
  if(!barState.transparent){g.fillStyle=barState.bg;g.fillRect(0,0,mt.w,mt.totalH);}
  if(barState.border==='frame'){
    g.strokeStyle='#c9d2e0';g.lineWidth=1;
    g.strokeRect(0.5,0.5,mt.w-1,mt.totalH-1);
  }else if(barState.border==='corner'){
    g.fillStyle=barState.fg;
    var L=Math.max(12,Math.round(mt.totalH*0.12)),T=3;
    g.fillRect(0,0,L,T);g.fillRect(0,0,T,L);
    g.fillRect(mt.w-L,0,L,T);g.fillRect(mt.w-T,0,T,L);
    g.fillRect(0,mt.totalH-T,L,T);g.fillRect(0,mt.totalH-L,T,L);
    g.fillRect(mt.w-L,mt.totalH-T,L,T);g.fillRect(mt.w-T,mt.totalH-L,T,L);
  }
  g.fillStyle=barState.fg;
  var mods=model.modules;
  for(var i=0;i<mods.length;i++){
    if(!mods[i]) continue;
    g.fillRect(mt.barX0+i*mt.bw,mt.barY,mt.bw,mt.h);
  }
  if(mt.font){
    var label=barLabel();
    g.fillStyle=barState.fg;
    g.font='600 '+mt.font+'px "SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';
    g.textAlign='center';g.textBaseline='top';
    var ty=barState.labelPos==='top'?(mt.bpad+mt.vpad):(mt.barY+mt.h+Math.round(mt.font*0.35));
    g.fillText(label,mt.w/2,ty);
  }
  $('barModulesOut').textContent=mods.length;
  $('barTextOut').textContent=model.text||data;
  hint.textContent=(model.text&&model.text!==data)?('已自动补全校验位：'+model.text):('共 '+mods.length+' 个模块');
}
function barSVGText(){
  if(!lastBar) return null;
  var m=lastBar,mt=barMetrics(m);
  var shapes=[];
  for(var i=0;i<m.modules.length;i++){
    if(!m.modules[i]) continue;
    shapes.push('<rect x="'+(mt.barX0+i*mt.bw)+'" y="'+mt.barY+'" width="'+mt.bw+'" height="'+mt.h+'"/>');
  }
  var text='';
  if(mt.font){
    var label=String(barLabel()).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});
    var ty=barState.labelPos==='top'?(mt.bpad+mt.vpad+mt.font*0.8):(mt.barY+mt.h+mt.font*0.9);
    text='<text x="'+(mt.w/2)+'" y="'+ty+'" text-anchor="middle" font-family="Consolas,monospace" font-size="'+mt.font+'" font-weight="600" fill="'+barState.fg+'">'+label+'</text>';
  }
  var bg=barState.transparent?'':'<rect width="100%" height="100%" fill="'+barState.bg+'"/>';
  var border='';
  if(barState.border==='frame'){
    border='<rect x="0.5" y="0.5" width="'+(mt.w-1)+'" height="'+(mt.totalH-1)+'" fill="none" stroke="#c9d2e0" stroke-width="1"/>';
  }else if(barState.border==='corner'){
    var Lc=Math.max(12,Math.round(mt.totalH*0.12)),Tc=3;
    border='<g fill="'+barState.fg+'">'+
      '<rect x="0" y="0" width="'+Lc+'" height="'+Tc+'"/><rect x="0" y="0" width="'+Tc+'" height="'+Lc+'"/>'+
      '<rect x="'+(mt.w-Lc)+'" y="0" width="'+Lc+'" height="'+Tc+'"/><rect x="'+(mt.w-Tc)+'" y="0" width="'+Tc+'" height="'+Lc+'"/>'+
      '<rect x="0" y="'+(mt.totalH-Tc)+'" width="'+Lc+'" height="'+Tc+'"/><rect x="0" y="'+(mt.totalH-Lc)+'" width="'+Tc+'" height="'+Lc+'"/>'+
      '<rect x="'+(mt.w-Lc)+'" y="'+(mt.totalH-Tc)+'" width="'+Lc+'" height="'+Tc+'"/><rect x="'+(mt.w-Tc)+'" y="'+(mt.totalH-Lc)+'" width="'+Tc+'" height="'+Lc+'"/>'+
      '</g>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<svg xmlns="http://www.w3.org/2000/svg" width="'+mt.w+'" height="'+mt.totalH+'" viewBox="0 0 '+mt.w+' '+mt.totalH+'">\n'+
    bg+'\n'+
    '<g fill="'+barState.fg+'">\n'+shapes.join('\n')+'\n</g>\n'+border+'\n'+text+'\n</svg>';
}
function barFileName(ext){
  var t=(lastBar&&lastBar.text)||$('barText').value||'barcode';
  return String(t).replace(/[\\/:*?"<>|]/g,'_').slice(0,40)+'.'+ext;
}
$('barDownloadPng').addEventListener('click',function(){
  if(!lastBar){toast('请先输入合法内容',true);return;}
  $('barCanvas').toBlob(function(b){ if(b) downloadBlob(b,barFileName('png')); else toast('导出失败',true); },'image/png');
});
$('barDownloadSvg').addEventListener('click',function(){
  var s=barSVGText();
  if(!s){toast('请先输入合法内容',true);return;}
  downloadBlob(new Blob([s],{type:'image/svg+xml;charset=utf-8'}),barFileName('svg'));
});
$('barCopy').addEventListener('click',function(){
  if(!lastBar){toast('请先输入合法内容',true);return;}
  if(!navigator.clipboard||!window.ClipboardItem){toast('当前环境不支持复制图片，请用下载',true);return;}
  $('barCanvas').toBlob(function(b){
    if(!b) return;
    navigator.clipboard.write([new ClipboardItem({'image/png':b})]).then(function(){toast('条码图片已复制');}).catch(function(){toast('复制失败，请改用下载',true);});
  },'image/png');
});

/* ================== 扫码识别 ================== */
var decState={file:null,imgData:null};
var MAXDIM=2200;
function drawToCanvas(img,w,h){
  var scale=1;
  if(Math.max(w,h)>MAXDIM) scale=MAXDIM/Math.max(w,h);
  var cw=Math.max(1,Math.round(w*scale)),ch=Math.max(1,Math.round(h*scale));
  var cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
  var g=cv.getContext('2d');
  g.fillStyle='#fff';g.fillRect(0,0,cw,ch);
  g.imageSmoothingEnabled=true;
  g.drawImage(img,0,0,cw,ch);
  return cv;
}
function validBarcodeResult(r){
  if(!r||!r.ok) return false;
  var t=String(r.type||'').toLowerCase();
  var txt=String(r.text||'');
  if(r.votes!=null&&r.votes<3) return false;
  if(t.indexOf('ean13')>=0) return /^\d{13}$/.test(txt);
  if(t.indexOf('ean8')>=0) return /^\d{8}$/.test(txt);
  if(t.indexOf('upc')>=0) return /^\d{12}$/.test(txt);
  if(t.indexOf('itf')>=0) return /^\d{14}$/.test(txt);
  if(t.indexOf('128')>=0||t.indexOf('39')>=0) return txt.length>=4&&(r.confidence==null||r.confidence>=70);
  return txt.length>=4&&(r.confidence==null||r.confidence>=70);
}
function decodeBase(imgData){
  var res=[];
  if(hasCT&&CodeTools.qr&&CodeTools.qr.decode){
    try{
      var q=CodeTools.qr.decode(imgData);
      if(q&&q.ok) res.push({kind:'qr',type:'二维码',text:q.text,version:q.version});
    }catch(e){}
  }
  if(hasCT&&CodeTools.barcode&&CodeTools.barcode.decode){
    try{
      var b=CodeTools.barcode.decode(imgData);
      if(b&&b.ok&&validBarcodeResult(b)) res.push({kind:'bar',type:(b.type||'条形码').toUpperCase(),text:b.text});
    }catch(e){}
  }
  return res;
}
function renderDecResults(list,ms){
  var box=$('decList');
  $('decCount').textContent=list.length;
  $('decTime').textContent=ms>=0?Math.round(ms)+' ms':'—';
  if(!list.length){
    box.innerHTML='<div class="dec-empty">没有识别到二维码或条形码<br>换一张更清晰、更靠近条码的图片试试</div>';
    return;
  }
  box.innerHTML='';
  list.forEach(function(r){
    var d=document.createElement('div');d.className='dec-card';
    d.innerHTML='<div class="dec-head"><span class="dec-type">'+esc(r.type)+'</span>'+
      (r.version?'<span class="mini-tag"><i></i>版本 V'+r.version+'</span>':'')+
      '<span class="mini-tag" style="margin-left:auto">'+esc(String(r.text).length)+' 字符</span></div>'+
      '<div class="dec-txt">'+esc(r.text)+'</div>'+
      '<div class="dec-act">'+
        '<button class="btn" data-a="copy" style="font-size:11px;padding:5px 10px">复制内容</button>'+
        (/^https?:\/\//i.test(r.text)?'<button class="btn" data-a="open" style="font-size:11px;padding:5px 10px">打开链接</button>':'')+
      '</div>';
    d.querySelector('[data-a=copy]').addEventListener('click',function(){
      copyText(r.text);
    });
    var op=d.querySelector('[data-a=open]');
    if(op) op.addEventListener('click',function(){window.open(r.text,'_blank','noopener');});
    box.appendChild(d);
  });
}
function copyText(t){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(function(){toast('已复制');},function(){fallbackCopy(t);});
  }else fallbackCopy(t);
}
function fallbackCopy(t){
  var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');toast('已复制');}catch(e){toast('复制失败',true);}
  ta.remove();
}
async function decodeFile(file){
  if(!file||!file.type||file.type.indexOf('image')<0){
    if(!file||!/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name||'')){toast('请选择图片文件',true);return;}
  }
  var t0=performance.now();
  var img;
  try{
    if(window.createImageBitmap){img=await createImageBitmap(file);}
    else{
      img=await new Promise(function(res,rej){var u=URL.createObjectURL(file);var i=new Image();i.onload=function(){res(i);};i.onerror=function(){URL.revokeObjectURL(u);rej(new Error('图片解码失败'));};i.src=u;});
    }
  }catch(e){toast('图片读取失败：'+(e.message||''),true);return;}
  var cv=drawToCanvas(img,img.naturalWidth||img.width,img.naturalHeight||img.height);
  decState.imgData=cv.getContext('2d').getImageData(0,0,cv.width,cv.height);
  var pm=$('decPreview');
  $('decImg').src=cv.toDataURL('image/png');
  pm.style.display='block';
  var res=decodeBase(decState.imgData);
  if(!res.length&&$('decInvert').checked){
    var inv=new ImageData(new Uint8ClampedArray(decState.imgData.data),decState.imgData.width,decState.imgData.height);
    for(var i=0;i<inv.data.length;i+=4){inv.data[i]=255-inv.data[i];inv.data[i+1]=255-inv.data[i+1];inv.data[i+2]=255-inv.data[i+2];}
    res=decodeBase(inv);
  }
  renderDecResults(res,performance.now()-t0);
  $('decAgain').disabled=false;
  if(res.length) toast('识别到 '+res.length+' 个码');
  else toast('未识别到二维码或条形码',true);
}
function pickDecImage(){
  $('decPicker').click();
}
$('decPick').addEventListener('click',pickDecImage);
$('decPickBtn2').addEventListener('click',function(ev){ev.stopPropagation();pickDecImage();});
$('decPicker').addEventListener('change',function(){
  if(this.files&&this.files[0]) decodeFile(this.files[0]);
  this.value='';
});
$('decAgain').addEventListener('click',function(){
  if(decState.imgData){
    var t0=performance.now();
    var res=decodeBase(decState.imgData);
    renderDecResults(res,performance.now()-t0);
  }
});
$('decPaste').addEventListener('click',function(){
  if(navigator.clipboard&&navigator.clipboard.read){
    navigator.clipboard.read().then(function(items){
      for(var i=0;i<items.length;i++){
        var types=items[i].types||[];
        for(var j=0;j<types.length;j++){
          if(types[j].indexOf('image')===0){
            items[i].getType(types[j]).then(function(blob){
              decodeFile(new File([blob],'clipboard.png',{type:blob.type}));
            });
            return;
          }
        }
      }
      toast('剪贴板里没有图片',true);
    }).catch(function(){toast('无法读取剪贴板，请直接 Ctrl+V 或选择文件',true);});
  }else{
    toast('请直接把截图 Ctrl+V 粘贴到页面',false);
  }
});
$('decDrop').addEventListener('click',pickDecImage);
['dragenter','dragover'].forEach(function(t){
  $('decDrop').addEventListener(t,function(e){e.preventDefault();$('decDrop').classList.add('over');});
});
['dragleave','drop'].forEach(function(t){
  $('decDrop').addEventListener(t,function(e){e.preventDefault();$('decDrop').classList.remove('over');});
});
$('decDrop').addEventListener('drop',function(e){
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]) decodeFile(e.dataTransfer.files[0]);
});
panel.addEventListener('dragover',function(e){e.preventDefault();});
panel.addEventListener('drop',function(e){
  if(e.target.closest&&e.target.closest('#decDrop')) return;
  e.preventDefault();
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]) decodeFile(e.dataTransfer.files[0]);
});
document.addEventListener('paste',function(e){
  if(curTab!=='dec'||!panel.classList.contains('active')) return;
  var items=(e.clipboardData&&e.clipboardData.items)||[];
  for(var i=0;i<items.length;i++){
    if(items[i].type&&items[i].type.indexOf('image')===0){
      var f=items[i].getAsFile();
      if(f){decodeFile(f);e.preventDefault();return;}
    }
  }
});
$('decClear').addEventListener('click',function(){
  decState.imgData=null;$('decPreview').style.display='none';
  $('decList').innerHTML='<div class="dec-empty">识别结果会显示在这里<br>支持二维码、Code 128、Code 39、EAN-13/8、UPC-A</div>';
  $('decCount').textContent='0';$('decTime').textContent='—';$('decAgain').disabled=true;
});
if(!hasQR||!hasBar){
  var cap=$('decCap');cap.style.display='block';
  cap.textContent='部分识别模块未加载：'+(!hasQR?'二维码 ':'')+(!hasBar?'条形码':'')+'生成不可用（解码仍可尝试）。';
}

/* ================== 初始化 ================== */
renderFields();
$('qrSize').style.setProperty('--p',((qrState.size-128)/(2048-128)*100)+'%');
$('qrMargin').style.setProperty('--p',(qrState.margin/8*100)+'%');
$('qrLogoSize').style.setProperty('--p',((qrState.logoSize-14)/(30-14)*100)+'%');
$('barBarWidth').style.setProperty('--p',((barState.barWidth-1)/5*100)+'%');
$('barHeight').style.setProperty('--p',((barState.height-40)/220*100)+'%');
$('barFont').style.setProperty('--p',(barState.font/40*100)+'%');
$('barQuiet').style.setProperty('--p',((barState.quiet-2)/18*100)+'%');
$('barTypeHint').textContent=BAR_HINT.code128;
syncQrControls();
renderQR();
renderBar();
window.CodePanel={renderQR:renderQR,renderBar:renderBar,setTab:function(k){var b=document.querySelector('#codeTabs [data-tab='+k+']');if(b)b.click();}};
})();
