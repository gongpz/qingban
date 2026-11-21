/*
 * VideoEngine 1.1.0 —— 纯前端视频压缩 / 转码引擎（WebCodecs + mp4box.js + mp4-muxer + webm-muxer + HEVC 软解）
 *
 * 设计约束：
 *  - classic script，挂到 globalThis.VideoEngine；无 import/export/require/顶层 await；
 *  - 引擎自身代码 ES2017 以内；第三方库（UMD 包）原样内联在同一个 IIFE 作用域里，不污染全局；
 *  - 不访问网络、不使用 Node API；file:// 下可直接运行；
 *  - 视频统一走 VideoDecoder -> Canvas2D(旋转+缩放) -> VideoEncoder；
 *    HEVC 在原生解码不可用时自动回退到内置 wasm 软解（@hevcjs/core），仍走同一条 Canvas/编码链路；
 *  - 音频单独走 AudioDecoder -> 重采样/声道混合 -> AudioEncoder；
 *  - 全程逐帧处理，任何时刻都不整体缓存 VideoFrame。
 *
 * 第三方库：
 *  - mp4box.js 0.5.4（BSD-3-Clause，Copyright (c) 2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato）
 *  - mp4-muxer 5.2.1（MIT，Copyright (c) 2023 Vanilagy）
 *  - webm-muxer 5.1.4（MIT，Copyright (c) 2022 Vanilagy）
 *  - @hevcjs/core 1.9.1 的 hevc-decode.wasm + Emscripten glue（MIT，Copyright (c) LID）
 *    wasm 以 base64 内联，运行时用 instantiateWasm 直接编译，不发起任何网络/文件请求。
 */
(function (global) {
  'use strict';


/* ===== 内联第三方库：mp4box.js 0.5.4（BSD-3-Clause）===== */
/*! mp4box 19-03-2025 */

var Log=function(){var i=new Date,r=4;return{setLogLevel:function(t){r=t==this.debug?1:t==this.info?2:t==this.warn?3:(this.error,4)},debug:function(t,e){void 0===console.debug&&(console.debug=console.log),r<=1&&console.debug("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},log:function(t,e){this.debug(t.msg)},info:function(t,e){r<=2&&console.info("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},warn:function(t,e){r<=3&&console.warn("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},error:function(t,e){r<=4&&console.error("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)}}}();Log.getDurationString=function(t,e){var i;function r(t,e){for(var i=(""+t).split(".");i[0].length<e;)i[0]="0"+i[0];return i.join(".")}t<0?(i=!0,t=-t):i=!1;var s=t/(e||1),a=Math.floor(s/3600);s-=3600*a;t=Math.floor(s/60),e=1e3*(s-=60*t);return e-=1e3*(s=Math.floor(s)),e=Math.floor(e),(i?"-":"")+a+":"+r(t,2)+":"+r(s,2)+"."+r(e,3)},Log.printRanges=function(t){var e=t.length;if(0<e){for(var i="",r=0;r<e;r++)0<r&&(i+=","),i+="["+Log.getDurationString(t.start(r))+","+Log.getDurationString(t.end(r))+"]";return i}return"(empty)"},"undefined"!=typeof exports&&(exports.Log=Log);var MP4BoxStream=function(t){if(!(t instanceof ArrayBuffer))throw"Needs an array buffer";this.buffer=t,this.dataview=new DataView(t),this.position=0};MP4BoxStream.prototype.getPosition=function(){return this.position},MP4BoxStream.prototype.getEndPosition=function(){return this.buffer.byteLength},MP4BoxStream.prototype.getLength=function(){return this.buffer.byteLength},MP4BoxStream.prototype.seek=function(t){t=Math.max(0,Math.min(this.buffer.byteLength,t));return this.position=isNaN(t)||!isFinite(t)?0:t,!0},MP4BoxStream.prototype.isEos=function(){return this.getPosition()>=this.getEndPosition()},MP4BoxStream.prototype.readAnyInt=function(t,e){var i=0;if(this.position+t<=this.buffer.byteLength){switch(t){case 1:i=e?this.dataview.getInt8(this.position):this.dataview.getUint8(this.position);break;case 2:i=e?this.dataview.getInt16(this.position):this.dataview.getUint16(this.position);break;case 3:if(e)throw"No method for reading signed 24 bits values";i=this.dataview.getUint8(this.position)<<16,i|=this.dataview.getUint8(this.position+1)<<8,i|=this.dataview.getUint8(this.position+2);break;case 4:i=e?this.dataview.getInt32(this.position):this.dataview.getUint32(this.position);break;case 8:if(e)throw"No method for reading signed 64 bits values";i=this.dataview.getUint32(this.position)<<32,i|=this.dataview.getUint32(this.position+4);break;default:throw"readInt method not implemented for size: "+t}return this.position+=t,i}throw"Not enough bytes in buffer"},MP4BoxStream.prototype.readUint8=function(){return this.readAnyInt(1,!1)},MP4BoxStream.prototype.readUint16=function(){return this.readAnyInt(2,!1)},MP4BoxStream.prototype.readUint24=function(){return this.readAnyInt(3,!1)},MP4BoxStream.prototype.readUint32=function(){return this.readAnyInt(4,!1)},MP4BoxStream.prototype.readUint64=function(){return this.readAnyInt(8,!1)},MP4BoxStream.prototype.readString=function(t){if(this.position+t<=this.buffer.byteLength){for(var e="",i=0;i<t;i++)e+=String.fromCharCode(this.readUint8());return e}throw"Not enough bytes in buffer"},MP4BoxStream.prototype.readCString=function(){for(var t=[];;){var e=this.readUint8();if(0===e)break;t.push(e)}return String.fromCharCode.apply(null,t)},MP4BoxStream.prototype.readInt8=function(){return this.readAnyInt(1,!0)},MP4BoxStream.prototype.readInt16=function(){return this.readAnyInt(2,!0)},MP4BoxStream.prototype.readInt32=function(){return this.readAnyInt(4,!0)},MP4BoxStream.prototype.readInt64=function(){return this.readAnyInt(8,!1)},MP4BoxStream.prototype.readUint8Array=function(t){for(var e=new Uint8Array(t),i=0;i<t;i++)e[i]=this.readUint8();return e},MP4BoxStream.prototype.readInt16Array=function(t){for(var e=new Int16Array(t),i=0;i<t;i++)e[i]=this.readInt16();return e},MP4BoxStream.prototype.readUint16Array=function(t){for(var e=new Int16Array(t),i=0;i<t;i++)e[i]=this.readUint16();return e},MP4BoxStream.prototype.readUint32Array=function(t){for(var e=new Uint32Array(t),i=0;i<t;i++)e[i]=this.readUint32();return e},MP4BoxStream.prototype.readInt32Array=function(t){for(var e=new Int32Array(t),i=0;i<t;i++)e[i]=this.readInt32();return e},"undefined"!=typeof exports&&(exports.MP4BoxStream=MP4BoxStream);var DataStream=function(t,e,i){this._byteOffset=e||0,t instanceof ArrayBuffer?this.buffer=t:"object"==typeof t?(this.dataView=t,e&&(this._byteOffset+=e)):this.buffer=new ArrayBuffer(t||0),this.position=0,this.endianness=null==i?DataStream.LITTLE_ENDIAN:i};DataStream.prototype={},DataStream.prototype.getPosition=function(){return this.position},DataStream.prototype._realloc=function(t){if(this._dynamicSize){var e=this._byteOffset+this.position+t,i=this._buffer.byteLength;if(e<=i)e>this._byteLength&&(this._byteLength=e);else{for(i<1&&(i=1);i<e;)i*=2;var r=new ArrayBuffer(i),t=new Uint8Array(this._buffer);new Uint8Array(r,0,t.length).set(t),this.buffer=r,this._byteLength=e}}},DataStream.prototype._trimAlloc=function(){var t,e,i;this._byteLength!=this._buffer.byteLength&&(t=new ArrayBuffer(this._byteLength),e=new Uint8Array(t),i=new Uint8Array(this._buffer,0,e.length),e.set(i),this.buffer=t)},DataStream.BIG_ENDIAN=!1,DataStream.LITTLE_ENDIAN=!0,DataStream.prototype._byteLength=0,Object.defineProperty(DataStream.prototype,"byteLength",{get:function(){return this._byteLength-this._byteOffset}}),Object.defineProperty(DataStream.prototype,"buffer",{get:function(){return this._trimAlloc(),this._buffer},set:function(t){this._buffer=t,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._buffer.byteLength}}),Object.defineProperty(DataStream.prototype,"byteOffset",{get:function(){return this._byteOffset},set:function(t){this._byteOffset=t,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._buffer.byteLength}}),Object.defineProperty(DataStream.prototype,"dataView",{get:function(){return this._dataView},set:function(t){this._byteOffset=t.byteOffset,this._buffer=t.buffer,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._byteOffset+t.byteLength}}),DataStream.prototype.seek=function(t){t=Math.max(0,Math.min(this.byteLength,t));this.position=isNaN(t)||!isFinite(t)?0:t},DataStream.prototype.isEof=function(){return this.position>=this._byteLength},DataStream.prototype.mapUint8Array=function(t){this._realloc(+t);var e=new Uint8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=+t,e},DataStream.prototype.readInt32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Int32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt16Array=function(t,e){t=null==t?this.byteLength-this.position/2:t;var i=new Int16Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt8Array=function(t){t=null==t?this.byteLength-this.position:t;var e=new Int8Array(t);return DataStream.memcpy(e.buffer,0,this.buffer,this.byteOffset+this.position,t*e.BYTES_PER_ELEMENT),this.position+=e.byteLength,e},DataStream.prototype.readUint32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Uint32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readUint16Array=function(t,e){t=null==t?this.byteLength-this.position/2:t;var i=new Uint16Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readUint8Array=function(t){t=null==t?this.byteLength-this.position:t;var e=new Uint8Array(t);return DataStream.memcpy(e.buffer,0,this.buffer,this.byteOffset+this.position,t*e.BYTES_PER_ELEMENT),this.position+=e.byteLength,e},DataStream.prototype.readFloat64Array=function(t,e){t=null==t?this.byteLength-this.position/8:t;var i=new Float64Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readFloat32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Float32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt32=function(t){t=this._dataView.getInt32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readInt16=function(t){t=this._dataView.getInt16(this.position,null==t?this.endianness:t);return this.position+=2,t},DataStream.prototype.readInt8=function(){var t=this._dataView.getInt8(this.position);return this.position+=1,t},DataStream.prototype.readUint32=function(t){t=this._dataView.getUint32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readUint16=function(t){t=this._dataView.getUint16(this.position,null==t?this.endianness:t);return this.position+=2,t},DataStream.prototype.readUint8=function(){var t=this._dataView.getUint8(this.position);return this.position+=1,t},DataStream.prototype.readFloat32=function(t){t=this._dataView.getFloat32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readFloat64=function(t){t=this._dataView.getFloat64(this.position,null==t?this.endianness:t);return this.position+=8,t},DataStream.endianness=0<new Int8Array(new Int16Array([1]).buffer)[0],DataStream.memcpy=function(t,e,i,r,s){e=new Uint8Array(t,e,s),s=new Uint8Array(i,r,s);e.set(s)},DataStream.arrayToNative=function(t,e){return e==this.endianness?t:this.flipArrayEndianness(t)},DataStream.nativeToEndian=function(t,e){return this.endianness==e?t:this.flipArrayEndianness(t)},DataStream.flipArrayEndianness=function(t){for(var e=new Uint8Array(t.buffer,t.byteOffset,t.byteLength),i=0;i<t.byteLength;i+=t.BYTES_PER_ELEMENT)for(var r=i+t.BYTES_PER_ELEMENT-1,s=i;s<r;r--,s++){var a=e[s];e[s]=e[r],e[r]=a}return t},DataStream.prototype.failurePosition=0,String.fromCharCodeUint8=function(t){for(var e=[],i=0;i<t.length;i++)e[i]=t[i];return String.fromCharCode.apply(null,e)},DataStream.prototype.readString=function(t,e){return null==e||"ASCII"==e?String.fromCharCodeUint8.apply(null,[this.mapUint8Array(null==t?this.byteLength-this.position:t)]):new TextDecoder(e).decode(this.mapUint8Array(t))},DataStream.prototype.readCString=function(t){var e=this.byteLength-this.position,i=new Uint8Array(this._buffer,this._byteOffset+this.position),r=e;null!=t&&(r=Math.min(t,e));for(var s=0;s<r&&0!==i[s];s++);var a=String.fromCharCodeUint8.apply(null,[this.mapUint8Array(s)]);return null!=t?this.position+=r-s:s!=e&&(this.position+=1),a};var MAX_SIZE=Math.pow(2,32);DataStream.prototype.readInt64=function(){return this.readInt32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readUint64=function(){return this.readUint32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readInt64=function(){return this.readUint32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readUint24=function(){return(this.readUint8()<<16)+(this.readUint8()<<8)+this.readUint8()},"undefined"!=typeof exports&&(exports.DataStream=DataStream),DataStream.prototype.save=function(t){var e=new Blob([this.buffer]);if(!window.URL||!URL.createObjectURL)throw"DataStream.save: Can't create object URL.";var i=window.URL.createObjectURL(e),e=document.createElement("a");document.body.appendChild(e),e.setAttribute("href",i),e.setAttribute("download",t),e.setAttribute("target","_self"),e.click(),window.URL.revokeObjectURL(i)},DataStream.prototype._dynamicSize=!0,Object.defineProperty(DataStream.prototype,"dynamicSize",{get:function(){return this._dynamicSize},set:function(t){t||this._trimAlloc(),this._dynamicSize=t}}),DataStream.prototype.shift=function(t){var e=new ArrayBuffer(this._byteLength-t),i=new Uint8Array(e),r=new Uint8Array(this._buffer,t,i.length);i.set(r),this.buffer=e,this.position-=t},DataStream.prototype.writeInt32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Int32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeInt32(t[i],e)},DataStream.prototype.writeInt16Array=function(t,e){if(this._realloc(2*t.length),t instanceof Int16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt16Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeInt16(t[i],e)},DataStream.prototype.writeInt8Array=function(t){if(this._realloc(+t.length),t instanceof Int8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt8Array(t.length);else for(var e=0;e<t.length;e++)this.writeInt8(t[e])},DataStream.prototype.writeUint32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Uint32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeUint32(t[i],e)},DataStream.prototype.writeUint16Array=function(t,e){if(this._realloc(2*t.length),t instanceof Uint16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint16Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeUint16(t[i],e)},DataStream.prototype.writeUint8Array=function(t){if(this._realloc(+t.length),t instanceof Uint8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint8Array(t.length);else for(var e=0;e<t.length;e++)this.writeUint8(t[e])},DataStream.prototype.writeFloat64Array=function(t,e){if(this._realloc(8*t.length),t instanceof Float64Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat64Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeFloat64(t[i],e)},DataStream.prototype.writeFloat32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Float32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeFloat32(t[i],e)},DataStream.prototype.writeInt32=function(t,e){this._realloc(4),this._dataView.setInt32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeInt16=function(t,e){this._realloc(2),this._dataView.setInt16(this.position,t,null==e?this.endianness:e),this.position+=2},DataStream.prototype.writeInt8=function(t){this._realloc(1),this._dataView.setInt8(this.position,t),this.position+=1},DataStream.prototype.writeUint32=function(t,e){this._realloc(4),this._dataView.setUint32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeUint16=function(t,e){this._realloc(2),this._dataView.setUint16(this.position,t,null==e?this.endianness:e),this.position+=2},DataStream.prototype.writeUint8=function(t){this._realloc(1),this._dataView.setUint8(this.position,t),this.position+=1},DataStream.prototype.writeFloat32=function(t,e){this._realloc(4),this._dataView.setFloat32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeFloat64=function(t,e){this._realloc(8),this._dataView.setFloat64(this.position,t,null==e?this.endianness:e),this.position+=8},DataStream.prototype.writeUCS2String=function(t,e,i){null==i&&(i=t.length);for(var r=0;r<t.length&&r<i;r++)this.writeUint16(t.charCodeAt(r),e);for(;r<i;r++)this.writeUint16(0)},DataStream.prototype.writeString=function(t,e,i){var r=0;if(null==e||"ASCII"==e)if(null!=i){for(var s=Math.min(t.length,i),r=0;r<s;r++)this.writeUint8(t.charCodeAt(r));for(;r<i;r++)this.writeUint8(0)}else for(r=0;r<t.length;r++)this.writeUint8(t.charCodeAt(r));else this.writeUint8Array(new TextEncoder(e).encode(t.substring(0,i)))},DataStream.prototype.writeCString=function(t,e){var i=0;if(null!=e){for(var r=Math.min(t.length,e),i=0;i<r;i++)this.writeUint8(t.charCodeAt(i));for(;i<e;i++)this.writeUint8(0)}else{for(i=0;i<t.length;i++)this.writeUint8(t.charCodeAt(i));this.writeUint8(0)}},DataStream.prototype.writeStruct=function(t,e){for(var i=0;i<t.length;i+=2){var r=t[i+1];this.writeType(r,e[t[i]],e)}},DataStream.prototype.writeType=function(t,e,i){var r;if("function"==typeof t)return t(this,e);if("object"==typeof t&&!(t instanceof Array))return t.set(this,e,i);var s=null,a="ASCII",i=this.position;switch("string"==typeof t&&/:/.test(t)&&(t=(r=t.split(":"))[0],s=parseInt(r[1])),"string"==typeof t&&/,/.test(t)&&(t=(r=t.split(","))[0],a=parseInt(r[1])),t){case"uint8":this.writeUint8(e);break;case"int8":this.writeInt8(e);break;case"uint16":this.writeUint16(e,this.endianness);break;case"int16":this.writeInt16(e,this.endianness);break;case"uint32":this.writeUint32(e,this.endianness);break;case"int32":this.writeInt32(e,this.endianness);break;case"float32":this.writeFloat32(e,this.endianness);break;case"float64":this.writeFloat64(e,this.endianness);break;case"uint16be":this.writeUint16(e,DataStream.BIG_ENDIAN);break;case"int16be":this.writeInt16(e,DataStream.BIG_ENDIAN);break;case"uint32be":this.writeUint32(e,DataStream.BIG_ENDIAN);break;case"int32be":this.writeInt32(e,DataStream.BIG_ENDIAN);break;case"float32be":this.writeFloat32(e,DataStream.BIG_ENDIAN);break;case"float64be":this.writeFloat64(e,DataStream.BIG_ENDIAN);break;case"uint16le":this.writeUint16(e,DataStream.LITTLE_ENDIAN);break;case"int16le":this.writeInt16(e,DataStream.LITTLE_ENDIAN);break;case"uint32le":this.writeUint32(e,DataStream.LITTLE_ENDIAN);break;case"int32le":this.writeInt32(e,DataStream.LITTLE_ENDIAN);break;case"float32le":this.writeFloat32(e,DataStream.LITTLE_ENDIAN);break;case"float64le":this.writeFloat64(e,DataStream.LITTLE_ENDIAN);break;case"cstring":this.writeCString(e,s);break;case"string":this.writeString(e,a,s);break;case"u16string":this.writeUCS2String(e,this.endianness,s);break;case"u16stringle":this.writeUCS2String(e,DataStream.LITTLE_ENDIAN,s);break;case"u16stringbe":this.writeUCS2String(e,DataStream.BIG_ENDIAN,s);break;default:if(3==t.length){for(var n=t[1],o=0;o<e.length;o++)this.writeType(n,e[o]);break}this.writeStruct(t,e)}null!=s&&(this.position=i,this._realloc(s),this.position=i+s)},DataStream.prototype.writeUint64=function(t){var e=Math.floor(t/MAX_SIZE);this.writeUint32(e),this.writeUint32(4294967295&t)},DataStream.prototype.writeUint24=function(t){this.writeUint8((16711680&t)>>16),this.writeUint8((65280&t)>>8),this.writeUint8(255&t)},DataStream.prototype.adjustUint32=function(t,e){var i=this.position;this.seek(t),this.writeUint32(e),this.seek(i)},DataStream.prototype.mapInt32Array=function(t,e){this._realloc(4*t);var i=new Int32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i},DataStream.prototype.mapInt16Array=function(t,e){this._realloc(2*t);var i=new Int16Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=2*t,i},DataStream.prototype.mapInt8Array=function(t){this._realloc(+t);var e=new Int8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=+t,e},DataStream.prototype.mapUint32Array=function(t,e){this._realloc(4*t);var i=new Uint32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i},DataStream.prototype.mapUint16Array=function(t,e){this._realloc(2*t);var i=new Uint16Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=2*t,i},DataStream.prototype.mapFloat64Array=function(t,e){this._realloc(8*t);var i=new Float64Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=8*t,i},DataStream.prototype.mapFloat32Array=function(t,e){this._realloc(4*t);var i=new Float32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i};var MultiBufferStream=function(t){this.buffers=[],this.bufferIndex=-1,t&&(this.insertBuffer(t),this.bufferIndex=0)};MultiBufferStream.prototype=new DataStream(new ArrayBuffer,0,DataStream.BIG_ENDIAN),MultiBufferStream.prototype.initialized=function(){var t;return-1<this.bufferIndex||(0<this.buffers.length?0===(t=this.buffers[0]).fileStart?(this.buffer=t,this.bufferIndex=0,Log.debug("MultiBufferStream","Stream ready for parsing"),!0):(Log.warn("MultiBufferStream","The first buffer should have a fileStart of 0"),this.logBufferLevel(),!1):(Log.warn("MultiBufferStream","No buffer to start parsing from"),this.logBufferLevel(),!1))},ArrayBuffer.concat=function(t,e){Log.debug("ArrayBuffer","Trying to create a new buffer of size: "+(t.byteLength+e.byteLength));var i=new Uint8Array(t.byteLength+e.byteLength);return i.set(new Uint8Array(t),0),i.set(new Uint8Array(e),t.byteLength),i.buffer},MultiBufferStream.prototype.reduceBuffer=function(t,e,i){var r=new Uint8Array(i);return r.set(new Uint8Array(t,e,i)),r.buffer.fileStart=t.fileStart+e,r.buffer.usedBytes=0,r.buffer},MultiBufferStream.prototype.insertBuffer=function(t){for(var e=!0,i=0;i<this.buffers.length;i++){var r=this.buffers[i];if(t.fileStart<=r.fileStart){if(t.fileStart===r.fileStart){if(t.byteLength>r.byteLength){this.buffers.splice(i,1),i--;continue}Log.warn("MultiBufferStream","Buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+") already appended, ignoring")}else t.fileStart+t.byteLength<=r.fileStart||(t=this.reduceBuffer(t,0,r.fileStart-t.fileStart)),Log.debug("MultiBufferStream","Appending new buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+")"),this.buffers.splice(i,0,t),0===i&&(this.buffer=t);e=!1;break}if(t.fileStart<r.fileStart+r.byteLength){var s=r.fileStart+r.byteLength-t.fileStart,r=t.byteLength-s;if(!(0<r)){e=!1;break}t=this.reduceBuffer(t,s,r)}}e&&(Log.debug("MultiBufferStream","Appending new buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+")"),this.buffers.push(t),0===i&&(this.buffer=t))},MultiBufferStream.prototype.logBufferLevel=function(t){for(var e,i,r=[],s="",a=0,n=0,o=0;o<this.buffers.length;o++)e=this.buffers[o],0===o?(i={},r.push(i),i.start=e.fileStart,i.end=e.fileStart+e.byteLength,s+="["+i.start+"-"):i.end===e.fileStart?i.end=e.fileStart+e.byteLength:((i={}).start=e.fileStart,s+=r[r.length-1].end-1+"], ["+i.start+"-",i.end=e.fileStart+e.byteLength,r.push(i)),a+=e.usedBytes,n+=e.byteLength;0<r.length&&(s+=i.end-1+"]");t=t?Log.info:Log.debug;0===this.buffers.length?t("MultiBufferStream","No more buffer in memory"):t("MultiBufferStream",this.buffers.length+" stored buffer(s) ("+a+"/"+n+" bytes), continuous ranges: "+s)},MultiBufferStream.prototype.cleanBuffers=function(){for(var t,e=0;e<this.buffers.length;e++)(t=this.buffers[e]).usedBytes===t.byteLength&&(Log.debug("MultiBufferStream","Removing buffer #"+e),this.buffers.splice(e,1),e--)},MultiBufferStream.prototype.mergeNextBuffer=function(){var t;if(this.bufferIndex+1<this.buffers.length){if((t=this.buffers[this.bufferIndex+1]).fileStart!==this.buffer.fileStart+this.buffer.byteLength)return!1;var e=this.buffer.byteLength,i=this.buffer.usedBytes,r=this.buffer.fileStart;return this.buffers[this.bufferIndex]=ArrayBuffer.concat(this.buffer,t),this.buffer=this.buffers[this.bufferIndex],this.buffers.splice(this.bufferIndex+1,1),this.buffer.usedBytes=i,this.buffer.fileStart=r,Log.debug("ISOFile","Concatenating buffer for box parsing (length: "+e+"->"+this.buffer.byteLength+")"),!0}return!1},MultiBufferStream.prototype.findPosition=function(t,e,i){for(var r=null,s=-1,a=!0===t?0:this.bufferIndex;a<this.buffers.length&&(r=this.buffers[a]).fileStart<=e;)s=a,i&&(r.fileStart+r.byteLength<=e?r.usedBytes=r.byteLength:r.usedBytes=e-r.fileStart,this.logBufferLevel()),a++;return-1!==s&&(r=this.buffers[s]).fileStart+r.byteLength>=e?(Log.debug("MultiBufferStream","Found position in existing buffer #"+s),s):-1},MultiBufferStream.prototype.findEndContiguousBuf=function(t){var e,i,t=void 0!==t?t:this.bufferIndex,r=this.buffers[t];if(this.buffers.length>t+1)for(e=t+1;e<this.buffers.length&&(i=this.buffers[e]).fileStart===r.fileStart+r.byteLength;e++)r=i;return r.fileStart+r.byteLength},MultiBufferStream.prototype.getEndFilePositionAfter=function(t){var e=this.findPosition(!0,t,!1);return-1!==e?this.findEndContiguousBuf(e):t},MultiBufferStream.prototype.addUsedBytes=function(t){this.buffer.usedBytes+=t,this.logBufferLevel()},MultiBufferStream.prototype.setAllUsedBytes=function(){this.buffer.usedBytes=this.buffer.byteLength,this.logBufferLevel()},MultiBufferStream.prototype.seek=function(t,e,i){i=this.findPosition(e,t,i);return-1!==i?(this.buffer=this.buffers[i],this.bufferIndex=i,this.position=t-this.buffer.fileStart,Log.debug("MultiBufferStream","Repositioning parser at buffer position: "+this.position),!0):(Log.debug("MultiBufferStream","Position "+t+" not found in buffered data"),!1)},MultiBufferStream.prototype.getPosition=function(){if(-1===this.bufferIndex||null===this.buffers[this.bufferIndex])throw"Error accessing position in the MultiBufferStream";return this.buffers[this.bufferIndex].fileStart+this.position},MultiBufferStream.prototype.getLength=function(){return this.byteLength},MultiBufferStream.prototype.getEndPosition=function(){if(-1===this.bufferIndex||null===this.buffers[this.bufferIndex])throw"Error accessing position in the MultiBufferStream";return this.buffers[this.bufferIndex].fileStart+this.byteLength},"undefined"!=typeof exports&&(exports.MultiBufferStream=MultiBufferStream);var MPEG4DescriptorParser=function(){var s=[];s[3]="ES_Descriptor",s[4]="DecoderConfigDescriptor",s[5]="DecoderSpecificInfo",s[6]="SLConfigDescriptor",this.getDescriptorName=function(t){return s[t]};var r=this,a={};return this.parseOneDescriptor=function(t){var e,i=0,r=t.readUint8();for(e=t.readUint8(),0;128&e;)i=(i<<7)+(127&e),e=t.readUint8(),0;return i=(i<<7)+(127&e),Log.debug("MPEG4DescriptorParser","Found "+(s[r]||"Descriptor "+r)+", size "+i+" at position "+t.getPosition()),(r=new(s[r]?a[s[r]]:a.Descriptor)(i)).parse(t),r},a.Descriptor=function(t,e){this.tag=t,this.size=e,this.descs=[]},a.Descriptor.prototype.parse=function(t){this.data=t.readUint8Array(this.size)},a.Descriptor.prototype.findDescriptor=function(t){for(var e=0;e<this.descs.length;e++)if(this.descs[e].tag==t)return this.descs[e];return null},a.Descriptor.prototype.parseRemainingDescriptors=function(t){for(var e=t.position;t.position<e+this.size;){var i=r.parseOneDescriptor(t);this.descs.push(i)}},a.ES_Descriptor=function(t){a.Descriptor.call(this,3,t)},a.ES_Descriptor.prototype=new a.Descriptor,a.ES_Descriptor.prototype.parse=function(t){var e;this.ES_ID=t.readUint16(),this.flags=t.readUint8(),this.size-=3,128&this.flags?(this.dependsOn_ES_ID=t.readUint16(),this.size-=2):this.dependsOn_ES_ID=0,64&this.flags?(e=t.readUint8(),this.URL=t.readString(e),this.size-=e+1):this.URL="",32&this.flags?(this.OCR_ES_ID=t.readUint16(),this.size-=2):this.OCR_ES_ID=0,this.parseRemainingDescriptors(t)},a.ES_Descriptor.prototype.getOTI=function(t){var e=this.findDescriptor(4);return e?e.oti:0},a.ES_Descriptor.prototype.getAudioConfig=function(t){var e=this.findDescriptor(4);if(!e)return null;var i=e.findDescriptor(5);if(i&&i.data){e=(248&i.data[0])>>3;return 31===e&&2<=i.data.length&&(e=32+((7&i.data[0])<<3)+((224&i.data[1])>>5)),e}return null},a.DecoderConfigDescriptor=function(t){a.Descriptor.call(this,4,t)},a.DecoderConfigDescriptor.prototype=new a.Descriptor,a.DecoderConfigDescriptor.prototype.parse=function(t){this.oti=t.readUint8(),this.streamType=t.readUint8(),this.upStream=0!=(this.streamType>>1&1),this.streamType=this.streamType>>>2,this.bufferSize=t.readUint24(),this.maxBitrate=t.readUint32(),this.avgBitrate=t.readUint32(),this.size-=13,this.parseRemainingDescriptors(t)},a.DecoderSpecificInfo=function(t){a.Descriptor.call(this,5,t)},a.DecoderSpecificInfo.prototype=new a.Descriptor,a.SLConfigDescriptor=function(t){a.Descriptor.call(this,6,t)},a.SLConfigDescriptor.prototype=new a.Descriptor,this};"undefined"!=typeof exports&&(exports.MPEG4DescriptorParser=MPEG4DescriptorParser);var BoxParser={ERR_INVALID_DATA:-1,ERR_NOT_ENOUGH_DATA:0,OK:1,BASIC_BOXES:[{type:"mdat",name:"MediaDataBox"},{type:"idat",name:"ItemDataBox"},{type:"free",name:"FreeSpaceBox"},{type:"skip",name:"FreeSpaceBox"},{type:"meco",name:"AdditionalMetadataContainerBox"},{type:"strk",name:"SubTrackBox"}],FULL_BOXES:[{type:"hmhd",name:"HintMediaHeaderBox"},{type:"nmhd",name:"NullMediaHeaderBox"},{type:"iods",name:"ObjectDescriptorBox"},{type:"xml ",name:"XMLBox"},{type:"bxml",name:"BinaryXMLBox"},{type:"ipro",name:"ItemProtectionBox"},{type:"mere",name:"MetaboxRelationBox"}],CONTAINER_BOXES:[[{type:"moov",name:"CompressedMovieBox"},["trak","pssh"]],[{type:"trak",name:"TrackBox"}],[{type:"edts",name:"EditBox"}],[{type:"mdia",name:"MediaBox"}],[{type:"minf",name:"MediaInformationBox"}],[{type:"dinf",name:"DataInformationBox"}],[{type:"stbl",name:"SampleTableBox"},["sgpd","sbgp"]],[{type:"mvex",name:"MovieExtendsBox"},["trex"]],[{type:"moof",name:"CompressedMovieFragmentBox"},["traf"]],[{type:"traf",name:"TrackFragmentBox"},["trun","sgpd","sbgp"]],[{type:"vttc",name:"VTTCueBox"}],[{type:"tref",name:"TrackReferenceBox"}],[{type:"iref",name:"ItemReferenceBox"}],[{type:"mfra",name:"MovieFragmentRandomAccessBox"},["tfra"]],[{type:"meco",name:"AdditionalMetadataContainerBox"}],[{type:"hnti",name:"trackhintinformation"}],[{type:"hinf",name:"hintstatisticsbox"}],[{type:"strk",name:"SubTrackBox"}],[{type:"strd",name:"SubTrackDefinitionBox"}],[{type:"sinf",name:"ProtectionSchemeInfoBox"}],[{type:"rinf",name:"RestrictedSchemeInfoBox"}],[{type:"schi",name:"SchemeInformationBox"}],[{type:"trgr",name:"TrackGroupBox"}],[{type:"udta",name:"UserDataBox"},["kind"]],[{type:"iprp",name:"ItemPropertiesBox"},["ipma"]],[{type:"ipco",name:"ItemPropertyContainerBox"}],[{type:"grpl",name:"GroupsListBox"}],[{type:"j2kH",name:"J2KHeaderInfoBox"}],[{type:"etyp",name:"ExtendedTypeBox"},["tyco"]]],boxCodes:[],fullBoxCodes:[],containerBoxCodes:[],sampleEntryCodes:{},sampleGroupEntryCodes:[],trackGroupTypes:[],UUIDBoxes:{},UUIDs:[],initialize:function(){BoxParser.FullBox.prototype=new BoxParser.Box,BoxParser.ContainerBox.prototype=new BoxParser.Box,BoxParser.SampleEntry.prototype=new BoxParser.Box,BoxParser.TrackGroupTypeBox.prototype=new BoxParser.FullBox,BoxParser.BASIC_BOXES.forEach(function(t){BoxParser.createBoxCtor(t.type,t.name)}),BoxParser.FULL_BOXES.forEach(function(t){BoxParser.createFullBoxCtor(t.type,t.name)}),BoxParser.CONTAINER_BOXES.forEach(function(t){BoxParser.createContainerBoxCtor(t[0].type,t[0].name,null,t[1])})},Box:function(t,e,i,r){this.type=t,this.box_name=i,this.size=e,this.uuid=r},FullBox:function(t,e,i,r){BoxParser.Box.call(this,t,e,i,r),this.flags=0,this.version=0},ContainerBox:function(t,e,i,r){BoxParser.Box.call(this,t,e,i,r),this.boxes=[]},SampleEntry:function(t,e,i,r){BoxParser.ContainerBox.call(this,t,e),this.hdr_size=i,this.start=r},SampleGroupEntry:function(t){this.grouping_type=t},TrackGroupTypeBox:function(t,e){BoxParser.FullBox.call(this,t,e)},createBoxCtor:function(e,i,t){BoxParser.boxCodes.push(e),BoxParser[e+"Box"]=function(t){BoxParser.Box.call(this,e,t,i)},BoxParser[e+"Box"].prototype=new BoxParser.Box,t&&(BoxParser[e+"Box"].prototype.parse=t)},createFullBoxCtor:function(e,i,r){BoxParser[e+"Box"]=function(t){BoxParser.FullBox.call(this,e,t,i)},BoxParser[e+"Box"].prototype=new BoxParser.FullBox,BoxParser[e+"Box"].prototype.parse=function(t){this.parseFullHeader(t),r&&r.call(this,t)}},addSubBoxArrays:function(t){if(t)for(var e=(this.subBoxNames=t).length,i=0;i<e;i++)this[t[i]+"s"]=[]},createContainerBoxCtor:function(e,i,t,r){BoxParser[e+"Box"]=function(t){BoxParser.ContainerBox.call(this,e,t,i),BoxParser.addSubBoxArrays.call(this,r)},BoxParser[e+"Box"].prototype=new BoxParser.ContainerBox,t&&(BoxParser[e+"Box"].prototype.parse=t)},createMediaSampleEntryCtor:function(t,e,i){BoxParser.sampleEntryCodes[t]=[],BoxParser[t+"SampleEntry"]=function(t,e){BoxParser.SampleEntry.call(this,t,e),BoxParser.addSubBoxArrays.call(this,i)},BoxParser[t+"SampleEntry"].prototype=new BoxParser.SampleEntry,e&&(BoxParser[t+"SampleEntry"].prototype.parse=e)},createSampleEntryCtor:function(e,i,t,r){BoxParser.sampleEntryCodes[e].push(i),BoxParser[i+"SampleEntry"]=function(t){BoxParser[e+"SampleEntry"].call(this,i,t),BoxParser.addSubBoxArrays.call(this,r)},BoxParser[i+"SampleEntry"].prototype=new BoxParser[e+"SampleEntry"],t&&(BoxParser[i+"SampleEntry"].prototype.parse=t)},createEncryptedSampleEntryCtor:function(t,e,i){BoxParser.createSampleEntryCtor.call(this,t,e,i,["sinf"])},createSampleGroupCtor:function(e,t){BoxParser[e+"SampleGroupEntry"]=function(t){BoxParser.SampleGroupEntry.call(this,e,t)},BoxParser[e+"SampleGroupEntry"].prototype=new BoxParser.SampleGroupEntry,t&&(BoxParser[e+"SampleGroupEntry"].prototype.parse=t)},createTrackGroupCtor:function(e,t){BoxParser[e+"TrackGroupTypeBox"]=function(t){BoxParser.TrackGroupTypeBox.call(this,e,t)},BoxParser[e+"TrackGroupTypeBox"].prototype=new BoxParser.TrackGroupTypeBox,t&&(BoxParser[e+"TrackGroupTypeBox"].prototype.parse=t)},createUUIDBox:function(e,i,r,s,a){BoxParser.UUIDs.push(e),BoxParser.UUIDBoxes[e]=function(t){(r?BoxParser.FullBox:s?BoxParser.ContainerBox:BoxParser.Box).call(this,"uuid",t,i,e)},BoxParser.UUIDBoxes[e].prototype=new(r?BoxParser.FullBox:s?BoxParser.ContainerBox:BoxParser.Box),a&&(BoxParser.UUIDBoxes[e].prototype.parse=r?function(t){this.parseFullHeader(t),a&&a.call(this,t)}:a)}};function printPS(t){var e="<table class='inner-table'>";e+="<thead><tr><th>length</th><th>nalu_data</th></tr></thead>",e+="<tbody>";for(var i=0;i<t.length;i++){var r=t[i];e+="<tr>",e+="<td>"+r.length+"</td>",e+="<td>",e+=r.nalu.reduce(function(t,e){return t+e.toString(16).padStart(2,"0")},"0x"),e+="</td></tr>"}return e+="</tbody></table>"}function ColorPoint(t,e){this.x=t,this.y=e}function Pixel(t,e){this.bad_pixel_row=t,this.bad_pixel_column=e}BoxParser.initialize(),BoxParser.TKHD_FLAG_ENABLED=1,BoxParser.TKHD_FLAG_IN_MOVIE=2,BoxParser.TKHD_FLAG_IN_PREVIEW=4,BoxParser.TFHD_FLAG_BASE_DATA_OFFSET=1,BoxParser.TFHD_FLAG_SAMPLE_DESC=2,BoxParser.TFHD_FLAG_SAMPLE_DUR=8,BoxParser.TFHD_FLAG_SAMPLE_SIZE=16,BoxParser.TFHD_FLAG_SAMPLE_FLAGS=32,BoxParser.TFHD_FLAG_DUR_EMPTY=65536,BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF=131072,BoxParser.TRUN_FLAGS_DATA_OFFSET=1,BoxParser.TRUN_FLAGS_FIRST_FLAG=4,BoxParser.TRUN_FLAGS_DURATION=256,BoxParser.TRUN_FLAGS_SIZE=512,BoxParser.TRUN_FLAGS_FLAGS=1024,BoxParser.TRUN_FLAGS_CTS_OFFSET=2048,BoxParser.Box.prototype.add=function(t){return this.addBox(new BoxParser[t+"Box"])},BoxParser.Box.prototype.addBox=function(t){return this.boxes.push(t),this[t.type+"s"]?this[t.type+"s"].push(t):this[t.type]=t,t},BoxParser.Box.prototype.set=function(t,e){return this[t]=e,this},BoxParser.Box.prototype.addEntry=function(t,e){e=e||"entries";return this[e]||(this[e]=[]),this[e].push(t),this},"undefined"!=typeof exports&&(exports.BoxParser=BoxParser),BoxParser.parseUUID=function(t){return BoxParser.parseHex16(t)},BoxParser.parseHex16=function(t){for(var e="",i=0;i<16;i++){var r=t.readUint8().toString(16);e+=1===r.length?"0"+r:r}return e},BoxParser.parseOneBox=function(t,e,i){var r,s,a=t.getPosition(),n=0;if(t.getEndPosition()-a<8)return Log.debug("BoxParser","Not enough data in stream to parse the type and size of the box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};if(i&&i<8)return Log.debug("BoxParser","Not enough bytes left in the parent box to parse a new box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};var o=t.readUint32(),h=t.readString(4),d=h;if(Log.debug("BoxParser","Found box of type '"+h+"' and size "+o+" at position "+a),n=8,"uuid"==h){if(t.getEndPosition()-t.getPosition()<16||i-n<16)return t.seek(a),Log.debug("BoxParser","Not enough bytes left in the parent box to parse a UUID box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};n+=16,d=s=BoxParser.parseUUID(t)}if(1==o){if(t.getEndPosition()-t.getPosition()<8||i&&i-n<8)return t.seek(a),Log.warn("BoxParser",'Not enough data in stream to parse the extended size of the "'+h+'" box'),{code:BoxParser.ERR_NOT_ENOUGH_DATA};o=t.readUint64(),n+=8}else if(0===o)if(i)o=i;else if("mdat"!==h)return Log.error("BoxParser","Unlimited box size not supported for type: '"+h+"'"),r=new BoxParser.Box(h,o),{code:BoxParser.OK,box:r,size:r.size};return 0!==o&&o<n?(Log.error("BoxParser","Box of type "+h+" has an invalid size "+o+" (too small to be a box)"),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):0!==o&&i&&i<o?(Log.error("BoxParser","Box of type '"+h+"' has a size "+o+" greater than its container size "+i),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):0!==o&&a+o>t.getEndPosition()?(t.seek(a),Log.info("BoxParser","Not enough data in stream to parse the entire '"+h+"' box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):e?{code:BoxParser.OK,type:h,size:o,hdr_size:n,start:a}:(BoxParser[h+"Box"]?r=new BoxParser[h+"Box"](o):"uuid"!==h?(Log.warn("BoxParser","Unknown box type: '"+h+"'"),(r=new BoxParser.Box(h,o)).has_unparsed_data=!0):BoxParser.UUIDBoxes[s]?r=new BoxParser.UUIDBoxes[s](o):(Log.warn("BoxParser","Unknown uuid type: '"+s+"'"),(r=new BoxParser.Box(h,o)).uuid=s,r.has_unparsed_data=!0),r.hdr_size=n,r.start=a,r.write===BoxParser.Box.prototype.write&&"mdat"!==r.type&&(Log.info("BoxParser","'"+d+"' box writing not yet implemented, keeping unparsed data in memory for later write"),r.parseDataAndRewind(t)),r.parse(t),(a=t.getPosition()-(r.start+r.size))<0?(Log.warn("BoxParser","Parsing of box '"+d+"' did not read the entire indicated box data size (missing "+-a+" bytes), seeking forward"),t.seek(r.start+r.size)):0<a&&(Log.error("BoxParser","Parsing of box '"+d+"' read "+a+" more bytes than the indicated box data size, seeking backwards"),0!==r.size&&t.seek(r.start+r.size)),{code:BoxParser.OK,box:r,size:r.size})},BoxParser.Box.prototype.parse=function(t){"mdat"!=this.type?this.data=t.readUint8Array(this.size-this.hdr_size):0===this.size?t.seek(t.getEndPosition()):t.seek(this.start+this.size)},BoxParser.Box.prototype.parseDataAndRewind=function(t){this.data=t.readUint8Array(this.size-this.hdr_size),t.position-=this.size-this.hdr_size},BoxParser.FullBox.prototype.parseDataAndRewind=function(t){this.parseFullHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size),this.hdr_size-=4,t.position-=this.size-this.hdr_size},BoxParser.FullBox.prototype.parseFullHeader=function(t){this.version=t.readUint8(),this.flags=t.readUint24(),this.hdr_size+=4},BoxParser.FullBox.prototype.parse=function(t){this.parseFullHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size)},BoxParser.ContainerBox.prototype.parse=function(t){for(;t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;var e,i=e.box;this.boxes.push(i),this.subBoxNames&&-1!=this.subBoxNames.indexOf(i.type)?this[this.subBoxNames[this.subBoxNames.indexOf(i.type)]+"s"].push(i):this[e="uuid"!==i.type?i.type:i.uuid]?Log.warn("Box of type "+e+" already stored in field of this type"):this[e]=i}},BoxParser.Box.prototype.parseLanguage=function(t){this.language=t.readUint16();t=[];t[0]=this.language>>10&31,t[1]=this.language>>5&31,t[2]=31&this.language,this.languageString=String.fromCharCode(t[0]+96,t[1]+96,t[2]+96)},BoxParser.SAMPLE_ENTRY_TYPE_VISUAL="Visual",BoxParser.SAMPLE_ENTRY_TYPE_AUDIO="Audio",BoxParser.SAMPLE_ENTRY_TYPE_HINT="Hint",BoxParser.SAMPLE_ENTRY_TYPE_METADATA="Metadata",BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE="Subtitle",BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM="System",BoxParser.SAMPLE_ENTRY_TYPE_TEXT="Text",BoxParser.SampleEntry.prototype.parseHeader=function(t){t.readUint8Array(6),this.data_reference_index=t.readUint16(),this.hdr_size+=8},BoxParser.SampleEntry.prototype.parse=function(t){this.parseHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size)},BoxParser.SampleEntry.prototype.parseDataAndRewind=function(t){this.parseHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size),this.hdr_size-=8,t.position-=this.size-this.hdr_size},BoxParser.SampleEntry.prototype.parseFooter=function(t){BoxParser.ContainerBox.prototype.parse.call(this,t)},BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_HINT),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_TEXT),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,function(t){var e;this.parseHeader(t),t.readUint16(),t.readUint16(),t.readUint32Array(3),this.width=t.readUint16(),this.height=t.readUint16(),this.horizresolution=t.readUint32(),this.vertresolution=t.readUint32(),t.readUint32(),this.frame_count=t.readUint16(),e=Math.min(31,t.readUint8()),this.compressorname=t.readString(e),e<31&&t.readString(31-e),this.depth=t.readUint16(),t.readUint16(),this.parseFooter(t)}),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,function(t){this.parseHeader(t),t.readUint32Array(2),this.channel_count=t.readUint16(),this.samplesize=t.readUint16(),t.readUint16(),t.readUint16(),this.samplerate=t.readUint32()/65536,this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc4"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"av01"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dav1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hvc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hev1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hvt1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"lhe1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dvh1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dvhe"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvi1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvs1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvcN"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vp08"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vp09"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avs3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"j2ki"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"mjp2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"mjpg"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"uncv"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mp4a"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ac-3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ac-4"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ec-3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"Opus"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mha1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mha2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mhm1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mhm2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"fLaC"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"encv"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"enca"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"encu"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM,"encs"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_TEXT,"enct"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"encm"),BoxParser.createBoxCtor("a1lx","AV1LayeredImageIndexingProperty",function(t){var e=16*(1+(1&(1&t.readUint8())));this.layer_size=[];for(var i=0;i<3;i++)this.layer_size[i]=16==e?t.readUint16():t.readUint32()}),BoxParser.createBoxCtor("a1op","OperatingPointSelectorProperty",function(t){this.op_index=t.readUint8()}),BoxParser.createFullBoxCtor("auxC","AuxiliaryTypeProperty",function(t){this.aux_type=t.readCString();var e=this.size-this.hdr_size-(this.aux_type.length+1);this.aux_subtype=t.readUint8Array(e)}),BoxParser.createBoxCtor("av1C","AV1CodecConfigurationBox",function(t){var e=t.readUint8();if(1==(e>>7&1))if(this.version=127&e,1===this.version)if(e=t.readUint8(),this.seq_profile=e>>5&7,this.seq_level_idx_0=31&e,e=t.readUint8(),this.seq_tier_0=e>>7&1,this.high_bitdepth=e>>6&1,this.twelve_bit=e>>5&1,this.monochrome=e>>4&1,this.chroma_subsampling_x=e>>3&1,this.chroma_subsampling_y=e>>2&1,this.chroma_sample_position=3&e,e=t.readUint8(),this.reserved_1=e>>5&7,0===this.reserved_1){if(this.initial_presentation_delay_present=e>>4&1,1===this.initial_presentation_delay_present)this.initial_presentation_delay_minus_one=15&e;else if(this.reserved_2=15&e,0!==this.reserved_2)return void Log.error("av1C reserved_2 parsing problem");e=this.size-this.hdr_size-4;this.configOBUs=t.readUint8Array(e)}else Log.error("av1C reserved_1 parsing problem");else Log.error("av1C version "+this.version+" not supported");else Log.error("av1C marker problem")}),BoxParser.createBoxCtor("avcC","AVCConfigurationBox",function(t){var e,i;for(this.configurationVersion=t.readUint8(),this.AVCProfileIndication=t.readUint8(),this.profile_compatibility=t.readUint8(),this.AVCLevelIndication=t.readUint8(),this.lengthSizeMinusOne=3&t.readUint8(),this.nb_SPS_nalus=31&t.readUint8(),i=this.size-this.hdr_size-6,this.SPS=[],this.SPS.toString=function(){return printPS(this)},e=0;e<this.nb_SPS_nalus;e++)this.SPS[e]={},this.SPS[e].length=t.readUint16(),this.SPS[e].nalu=t.readUint8Array(this.SPS[e].length),i-=2+this.SPS[e].length;for(this.nb_PPS_nalus=t.readUint8(),i--,this.PPS=[],this.PPS.toString=function(){return printPS(this)},e=0;e<this.nb_PPS_nalus;e++)this.PPS[e]={},this.PPS[e].length=t.readUint16(),this.PPS[e].nalu=t.readUint8Array(this.PPS[e].length),i-=2+this.PPS[e].length;0<i&&(this.ext=t.readUint8Array(i))}),BoxParser.createBoxCtor("btrt","BitRateBox",function(t){this.bufferSizeDB=t.readUint32(),this.maxBitrate=t.readUint32(),this.avgBitrate=t.readUint32()}),BoxParser.createFullBoxCtor("ccst","CodingConstraintsBox",function(t){var e=t.readUint8();this.all_ref_pics_intra=128==(128&e),this.intra_pred_used=64==(64&e),this.max_ref_per_pic=(63&e)>>2,t.readUint24()}),BoxParser.createBoxCtor("cdef","ComponentDefinitionBox",function(t){var e;for(this.channel_count=t.readUint16(),this.channel_indexes=[],this.channel_types=[],this.channel_associations=[],e=0;e<this.channel_count;e++)this.channel_indexes.push(t.readUint16()),this.channel_types.push(t.readUint16()),this.channel_associations.push(t.readUint16())}),BoxParser.createBoxCtor("clap","CleanApertureBox",function(t){this.cleanApertureWidthN=t.readUint32(),this.cleanApertureWidthD=t.readUint32(),this.cleanApertureHeightN=t.readUint32(),this.cleanApertureHeightD=t.readUint32(),this.horizOffN=t.readUint32(),this.horizOffD=t.readUint32(),this.vertOffN=t.readUint32(),this.vertOffD=t.readUint32()}),BoxParser.createBoxCtor("clli","ContentLightLevelBox",function(t){this.max_content_light_level=t.readUint16(),this.max_pic_average_light_level=t.readUint16()}),BoxParser.createFullBoxCtor("cmex","CameraExtrinsicMatrixProperty",function(t){1&this.flags&&(this.pos_x=t.readInt32()),2&this.flags&&(this.pos_y=t.readInt32()),4&this.flags&&(this.pos_z=t.readInt32()),8&this.flags&&(0==this.version?16&this.flags?(this.quat_x=t.readInt32(),this.quat_y=t.readInt32(),this.quat_z=t.readInt32()):(this.quat_x=t.readInt16(),this.quat_y=t.readInt16(),this.quat_z=t.readInt16()):this.version),32&this.flags&&(this.id=t.readUint32())}),BoxParser.createFullBoxCtor("cmin","CameraIntrinsicMatrixProperty",function(t){this.focal_length_x=t.readInt32(),this.principal_point_x=t.readInt32(),this.principal_point_y=t.readInt32(),1&this.flags&&(this.focal_length_y=t.readInt32(),this.skew_factor=t.readInt32())}),BoxParser.createBoxCtor("cmpd","ComponentDefinitionBox",function(t){for(this.component_count=t.readUint32(),this.component_types=[],this.component_type_urls=[],i=0;i<this.component_count;i++){var e=t.readUint16();this.component_types.push(e),32768<=e&&this.component_type_urls.push(t.readCString())}}),BoxParser.createFullBoxCtor("co64","ChunkLargeOffsetBox",function(t){var e,i=t.readUint32();if(this.chunk_offsets=[],0===this.version)for(e=0;e<i;e++)this.chunk_offsets.push(t.readUint64())}),BoxParser.createFullBoxCtor("CoLL","ContentLightLevelBox",function(t){this.maxCLL=t.readUint16(),this.maxFALL=t.readUint16()}),BoxParser.createBoxCtor("colr","ColourInformationBox",function(t){var e;this.colour_type=t.readString(4),"nclx"===this.colour_type?(this.colour_primaries=t.readUint16(),this.transfer_characteristics=t.readUint16(),this.matrix_coefficients=t.readUint16(),e=t.readUint8(),this.full_range_flag=e>>7):"rICC"!==this.colour_type&&"prof"!==this.colour_type||(this.ICC_profile=t.readUint8Array(this.size-4))}),BoxParser.createFullBoxCtor("cprt","CopyrightBox",function(t){this.parseLanguage(t),this.notice=t.readCString()}),BoxParser.createFullBoxCtor("cslg","CompositionToDecodeBox",function(t){0===this.version&&(this.compositionToDTSShift=t.readInt32(),this.leastDecodeToDisplayDelta=t.readInt32(),this.greatestDecodeToDisplayDelta=t.readInt32(),this.compositionStartTime=t.readInt32(),this.compositionEndTime=t.readInt32())}),BoxParser.createFullBoxCtor("ctts","CompositionOffsetBox",function(t){var e,i=t.readUint32();if(this.sample_counts=[],this.sample_offsets=[],0===this.version)for(e=0;e<i;e++){this.sample_counts.push(t.readUint32());var r=t.readInt32();r<0&&Log.warn("BoxParser","ctts box uses negative values without using version 1"),this.sample_offsets.push(r)}else if(1==this.version)for(e=0;e<i;e++)this.sample_counts.push(t.readUint32()),this.sample_offsets.push(t.readInt32())}),BoxParser.createBoxCtor("dac3","AC3SpecificBox",function(t){var e=t.readUint8(),i=t.readUint8(),t=t.readUint8();this.fscod=e>>6,this.bsid=e>>1&31,this.bsmod=(1&e)<<2|i>>6&3,this.acmod=i>>3&7,this.lfeon=i>>2&1,this.bit_rate_code=3&i|t>>5&7}),BoxParser.createBoxCtor("dec3","EC3SpecificBox",function(t){var e=t.readUint16();this.data_rate=e>>3,this.num_ind_sub=7&e,this.ind_subs=[];for(var i=0;i<this.num_ind_sub+1;i++){var r={};this.ind_subs.push(r);var s=t.readUint8(),a=t.readUint8(),n=t.readUint8();r.fscod=s>>6,r.bsid=s>>1&31,r.bsmod=(1&s)<<4|a>>4&15,r.acmod=a>>1&7,r.lfeon=1&a,r.num_dep_sub=n>>1&15,0<r.num_dep_sub&&(r.chan_loc=(1&n)<<8|t.readUint8())}}),BoxParser.createFullBoxCtor("dfLa","FLACSpecificBox",function(t){for(var e=[],i=["STREAMINFO","PADDING","APPLICATION","SEEKTABLE","VORBIS_COMMENT","CUESHEET","PICTURE","RESERVED"];;){var r=t.readUint8(),s=Math.min(127&r,i.length-1);if(s?t.readUint8Array(t.readUint24()):(t.readUint8Array(13),this.samplerate=t.readUint32()>>12,t.readUint8Array(20)),e.push(i[s]),128&r)break}this.numMetadataBlocks=e.length+" ("+e.join(", ")+")"}),BoxParser.createBoxCtor("dimm","hintimmediateBytesSent",function(t){this.bytessent=t.readUint64()}),BoxParser.createBoxCtor("dmax","hintlongestpacket",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("dmed","hintmediaBytesSent",function(t){this.bytessent=t.readUint64()}),BoxParser.createBoxCtor("dOps","OpusSpecificBox",function(t){if(this.Version=t.readUint8(),this.OutputChannelCount=t.readUint8(),this.PreSkip=t.readUint16(),this.InputSampleRate=t.readUint32(),this.OutputGain=t.readInt16(),this.ChannelMappingFamily=t.readUint8(),0!==this.ChannelMappingFamily){this.StreamCount=t.readUint8(),this.CoupledCount=t.readUint8(),this.ChannelMapping=[];for(var e=0;e<this.OutputChannelCount;e++)this.ChannelMapping[e]=t.readUint8()}}),BoxParser.createFullBoxCtor("dref","DataReferenceBox",function(t){var e;this.entries=[];for(var i=t.readUint32(),r=0;r<i;r++){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;e=e.box,this.entries.push(e)}}),BoxParser.createBoxCtor("drep","hintrepeatedBytesSent",function(t){this.bytessent=t.readUint64()}),BoxParser.createFullBoxCtor("elng","ExtendedLanguageBox",function(t){this.extended_language=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("elst","EditListBox",function(t){this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.entries.push(r),1===this.version?(r.segment_duration=t.readUint64(),r.media_time=t.readInt64()):(r.segment_duration=t.readUint32(),r.media_time=t.readInt32()),r.media_rate_integer=t.readInt16(),r.media_rate_fraction=t.readInt16()}}),BoxParser.createFullBoxCtor("emsg","EventMessageBox",function(t){1==this.version?(this.timescale=t.readUint32(),this.presentation_time=t.readUint64(),this.event_duration=t.readUint32(),this.id=t.readUint32(),this.scheme_id_uri=t.readCString(),this.value=t.readCString()):(this.scheme_id_uri=t.readCString(),this.value=t.readCString(),this.timescale=t.readUint32(),this.presentation_time_delta=t.readUint32(),this.event_duration=t.readUint32(),this.id=t.readUint32());var e=this.size-this.hdr_size-(16+(this.scheme_id_uri.length+1)+(this.value.length+1));1==this.version&&(e-=4),this.message_data=t.readUint8Array(e)}),BoxParser.createEntityToGroupCtor=function(e,r){BoxParser[e+"Box"]=function(t){BoxParser.FullBox.call(this,e,t)},BoxParser[e+"Box"].prototype=new BoxParser.FullBox,BoxParser[e+"Box"].prototype.parse=function(t){if(this.parseFullHeader(t),r)r.call(this,t);else for(this.group_id=t.readUint32(),this.num_entities_in_group=t.readUint32(),this.entity_ids=[],i=0;i<this.num_entities_in_group;i++){var e=t.readUint32();this.entity_ids.push(e)}}},BoxParser.createEntityToGroupCtor("aebr"),BoxParser.createEntityToGroupCtor("afbr"),BoxParser.createEntityToGroupCtor("albc"),BoxParser.createEntityToGroupCtor("altr"),BoxParser.createEntityToGroupCtor("brst"),BoxParser.createEntityToGroupCtor("dobr"),BoxParser.createEntityToGroupCtor("eqiv"),BoxParser.createEntityToGroupCtor("favc"),BoxParser.createEntityToGroupCtor("fobr"),BoxParser.createEntityToGroupCtor("iaug"),BoxParser.createEntityToGroupCtor("pano"),BoxParser.createEntityToGroupCtor("slid"),BoxParser.createEntityToGroupCtor("ster"),BoxParser.createEntityToGroupCtor("tsyn"),BoxParser.createEntityToGroupCtor("wbbr"),BoxParser.createEntityToGroupCtor("prgr"),BoxParser.createEntityToGroupCtor("pymd",function(t){this.group_id=t.readUint32(),this.num_entities_in_group=t.readUint32(),this.entity_ids=[];for(var e=0;e<this.num_entities_in_group;e++){var i=t.readUint32();this.entity_ids.push(i)}for(this.tile_size_x=t.readUint16(),this.tile_size_y=t.readUint16(),this.layer_binning=[],this.tiles_in_layer_column_minus1=[],this.tiles_in_layer_row_minus1=[],e=0;e<this.num_entities_in_group;e++)this.layer_binning[e]=t.readUint16(),this.tiles_in_layer_row_minus1[e]=t.readUint16(),this.tiles_in_layer_column_minus1[e]=t.readUint16()}),BoxParser.createFullBoxCtor("esds","ElementaryStreamDescriptorBox",function(t){var e=t.readUint8Array(this.size-this.hdr_size);void 0!==MPEG4DescriptorParser&&(t=new MPEG4DescriptorParser,this.esd=t.parseOneDescriptor(new DataStream(e.buffer,0,DataStream.BIG_ENDIAN)))}),BoxParser.createBoxCtor("fiel","FieldHandlingBox",function(t){this.fieldCount=t.readUint8(),this.fieldOrdering=t.readUint8()}),BoxParser.createBoxCtor("frma","OriginalFormatBox",function(t){this.data_format=t.readString(4)}),BoxParser.createBoxCtor("ftyp","FileTypeBox",function(t){var e=this.size-this.hdr_size;this.major_brand=t.readString(4),this.minor_version=t.readUint32(),e-=8,this.compatible_brands=[];for(var i=0;4<=e;)this.compatible_brands[i]=t.readString(4),e-=4,i++}),BoxParser.createFullBoxCtor("hdlr","HandlerBox",function(t){0===this.version&&(t.readUint32(),this.handler=t.readString(4),t.readUint32Array(3),this.name=t.readString(this.size-this.hdr_size-20),"\0"===this.name[this.name.length-1]&&(this.name=this.name.slice(0,-1)))}),BoxParser.createBoxCtor("hvcC","HEVCConfigurationBox",function(t){var e,i;this.configurationVersion=t.readUint8(),i=t.readUint8(),this.general_profile_space=i>>6,this.general_tier_flag=(32&i)>>5,this.general_profile_idc=31&i,this.general_profile_compatibility=t.readUint32(),this.general_constraint_indicator=t.readUint8Array(6),this.general_level_idc=t.readUint8(),this.min_spatial_segmentation_idc=4095&t.readUint16(),this.parallelismType=3&t.readUint8(),this.chroma_format_idc=3&t.readUint8(),this.bit_depth_luma_minus8=7&t.readUint8(),this.bit_depth_chroma_minus8=7&t.readUint8(),this.avgFrameRate=t.readUint16(),i=t.readUint8(),this.constantFrameRate=i>>6,this.numTemporalLayers=(13&i)>>3,this.temporalIdNested=(4&i)>>2,this.lengthSizeMinusOne=3&i,this.nalu_arrays=[],this.nalu_arrays.toString=function(){var t="<table class='inner-table'>";t+="<thead><tr><th>completeness</th><th>nalu_type</th><th>nalu_data</th></tr></thead>",t+="<tbody>";for(var e=0;e<this.length;e++){var i=this[e];t+="<tr>",t+="<td rowspan='"+i.length+"'>"+i.completeness+"</td>",t+="<td rowspan='"+i.length+"'>"+i.nalu_type+"</td>";for(var r=0;r<i.length;r++)0!==r&&(t+="<tr>"),t+="<td>",t+=i[r].data.reduce(function(t,e){return t+e.toString(16).padStart(2,"0")},"0x"),t+="</td></tr>"}return t+="</tbody></table>"};for(var r=t.readUint8(),s=0;s<r;s++){var a=[];this.nalu_arrays.push(a),i=t.readUint8(),a.completeness=(128&i)>>7,a.nalu_type=63&i;for(var n=t.readUint16(),o=0;o<n;o++){var h={};a.push(h),e=t.readUint16(),h.data=t.readUint8Array(e)}}}),BoxParser.createFullBoxCtor("iinf","ItemInfoBox",function(t){var e;0===this.version?this.entry_count=t.readUint16():this.entry_count=t.readUint32(),this.item_infos=[];for(var i=0;i<this.entry_count;i++){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;"infe"!==e.box.type&&Log.error("BoxParser","Expected 'infe' box, got "+e.box.type),this.item_infos[i]=e.box}}),BoxParser.createFullBoxCtor("iloc","ItemLocationBox",function(t){var e=t.readUint8();this.offset_size=e>>4&15,this.length_size=15&e,e=t.readUint8(),this.base_offset_size=e>>4&15,1===this.version||2===this.version?this.index_size=15&e:this.index_size=0,this.items=[];var i=0;if(this.version<2)i=t.readUint16();else{if(2!==this.version)throw"version of iloc box not supported";i=t.readUint32()}for(var r=0;r<i;r++){var s={};if(this.items.push(s),this.version<2)s.item_ID=t.readUint16();else{if(2!==this.version)throw"version of iloc box not supported";s.item_ID=t.readUint32()}switch(1===this.version||2===this.version?s.construction_method=15&t.readUint16():s.construction_method=0,s.data_reference_index=t.readUint16(),this.base_offset_size){case 0:s.base_offset=0;break;case 4:s.base_offset=t.readUint32();break;case 8:s.base_offset=t.readUint64();break;default:throw"Error reading base offset size"}var a=t.readUint16();s.extents=[];for(var n=0;n<a;n++){var o={};if(s.extents.push(o),1===this.version||2===this.version)switch(this.index_size){case 0:o.extent_index=0;break;case 4:o.extent_index=t.readUint32();break;case 8:o.extent_index=t.readUint64();break;default:throw"Error reading extent index"}switch(this.offset_size){case 0:o.extent_offset=0;break;case 4:o.extent_offset=t.readUint32();break;case 8:o.extent_offset=t.readUint64();break;default:throw"Error reading extent index"}switch(this.length_size){case 0:o.extent_length=0;break;case 4:o.extent_length=t.readUint32();break;case 8:o.extent_length=t.readUint64();break;default:throw"Error reading extent index"}}}}),BoxParser.createBoxCtor("imir","ImageMirror",function(t){t=t.readUint8();this.reserved=t>>7,this.axis=1&t}),BoxParser.createFullBoxCtor("infe","ItemInfoEntry",function(t){return 0!==this.version&&1!==this.version||(this.item_ID=t.readUint16(),this.item_protection_index=t.readUint16(),this.item_name=t.readCString(),this.content_type=t.readCString(),this.content_encoding=t.readCString()),1===this.version?(this.extension_type=t.readString(4),Log.warn("BoxParser","Cannot parse extension type"),void t.seek(this.start+this.size)):void(2<=this.version&&(2===this.version?this.item_ID=t.readUint16():3===this.version&&(this.item_ID=t.readUint32()),this.item_protection_index=t.readUint16(),this.item_type=t.readString(4),this.item_name=t.readCString(),"mime"===this.item_type?(this.content_type=t.readCString(),this.content_encoding=t.readCString()):"uri "===this.item_type&&(this.item_uri_type=t.readCString())))}),BoxParser.createFullBoxCtor("ipma","ItemPropertyAssociationBox",function(t){var e,i;for(entry_count=t.readUint32(),this.associations=[],e=0;e<entry_count;e++){var r={};this.associations.push(r),this.version<1?r.id=t.readUint16():r.id=t.readUint32();var s=t.readUint8();for(r.props=[],i=0;i<s;i++){var a=t.readUint8(),n={};r.props.push(n),n.essential=(128&a)>>7==1,1&this.flags?n.property_index=(127&a)<<8|t.readUint8():n.property_index=127&a}}}),BoxParser.createFullBoxCtor("iref","ItemReferenceBox",function(t){var e;for(this.references=[];t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;(e=new(0===this.version?BoxParser.SingleItemTypeReferenceBox:BoxParser.SingleItemTypeReferenceBoxLarge)(e.type,e.size,e.hdr_size,e.start)).write===BoxParser.Box.prototype.write&&"mdat"!==e.type&&(Log.warn("BoxParser",e.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),e.parseDataAndRewind(t)),e.parse(t),this.references.push(e)}}),BoxParser.createBoxCtor("irot","ImageRotation",function(t){this.angle=3&t.readUint8()}),BoxParser.createFullBoxCtor("ispe","ImageSpatialExtentsProperty",function(t){this.image_width=t.readUint32(),this.image_height=t.readUint32()}),BoxParser.createFullBoxCtor("kind","KindBox",function(t){this.schemeURI=t.readCString(),this.value=t.readCString()}),BoxParser.createFullBoxCtor("leva","LevelAssignmentBox",function(t){var e=t.readUint8();this.levels=[];for(var i=0;i<e;i++){var r={};(this.levels[i]=r).track_ID=t.readUint32();var s=t.readUint8();switch(r.padding_flag=s>>7,r.assignment_type=127&s,r.assignment_type){case 0:r.grouping_type=t.readString(4);break;case 1:r.grouping_type=t.readString(4),r.grouping_type_parameter=t.readUint32();break;case 2:case 3:break;case 4:r.sub_track_id=t.readUint32();break;default:Log.warn("BoxParser","Unknown leva assignement type")}}}),BoxParser.createBoxCtor("lhvC","LHEVCConfigurationBox",function(t){var e;this.configurationVersion=t.readUint8(),this.min_spatial_segmentation_idc=4095&t.readUint16(),this.parallelismType=3&t.readUint8(),e=t.readUint8(),this.numTemporalLayers=(13&e)>>3,this.temporalIdNested=(4&e)>>2,this.lengthSizeMinusOne=3&e,this.nalu_arrays=[],this.nalu_arrays.toString=function(){var t="<table class='inner-table'>";t+="<thead><tr><th>completeness</th><th>nalu_type</th><th>nalu_data</th></tr></thead>",t+="<tbody>";for(var e=0;e<this.length;e++){var i=this[e];t+="<tr>",t+="<td rowspan='"+i.length+"'>"+i.completeness+"</td>",t+="<td rowspan='"+i.length+"'>"+i.nalu_type+"</td>";for(var r=0;r<i.length;r++)0!==r&&(t+="<tr>"),t+="<td>",t+=i[r].data.reduce(function(t,e){return t+e.toString(16).padStart(2,"0")},"0x"),t+="</td></tr>"}return t+="</tbody></table>"};for(var i=t.readUint8(),r=0;r<i;r++){var s=[];this.nalu_arrays.push(s),e=t.readUint8(),s.completeness=(128&e)>>7,s.nalu_type=63&e;for(var a=t.readUint16(),n=0;n<a;n++){var o={};s.push(o);var h=t.readUint16();o.data=t.readUint8Array(h)}}}),BoxParser.createBoxCtor("lsel","LayerSelectorProperty",function(t){this.layer_id=t.readUint16()}),BoxParser.createBoxCtor("maxr","hintmaxrate",function(t){this.period=t.readUint32(),this.bytes=t.readUint32()}),ColorPoint.prototype.toString=function(){return"("+this.x+","+this.y+")"},BoxParser.createBoxCtor("mdcv","MasteringDisplayColourVolumeBox",function(t){this.display_primaries=[],this.display_primaries[0]=new ColorPoint(t.readUint16(),t.readUint16()),this.display_primaries[1]=new ColorPoint(t.readUint16(),t.readUint16()),this.display_primaries[2]=new ColorPoint(t.readUint16(),t.readUint16()),this.white_point=new ColorPoint(t.readUint16(),t.readUint16()),this.max_display_mastering_luminance=t.readUint32(),this.min_display_mastering_luminance=t.readUint32()}),BoxParser.createFullBoxCtor("mdhd","MediaHeaderBox",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.timescale=t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.timescale=t.readUint32(),this.duration=t.readUint32()),this.parseLanguage(t),t.readUint16()}),BoxParser.createFullBoxCtor("mehd","MovieExtendsHeaderBox",function(t){1&this.flags&&(Log.warn("BoxParser","mehd box incorrectly uses flags set to 1, converting version to 1"),this.version=1),1==this.version?this.fragment_duration=t.readUint64():this.fragment_duration=t.readUint32()}),BoxParser.createFullBoxCtor("meta","MetaBox",function(t){this.boxes=[],BoxParser.ContainerBox.prototype.parse.call(this,t)}),BoxParser.createFullBoxCtor("mfhd","MovieFragmentHeaderBox",function(t){this.sequence_number=t.readUint32()}),BoxParser.createFullBoxCtor("mfro","MovieFragmentRandomAccessOffsetBox",function(t){this._size=t.readUint32()}),BoxParser.createFullBoxCtor("mskC","MaskConfigurationProperty",function(t){this.bits_per_pixel=t.readUint8()}),BoxParser.createFullBoxCtor("mvhd","MovieHeaderBox",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.timescale=t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.timescale=t.readUint32(),this.duration=t.readUint32()),this.rate=t.readUint32(),this.volume=t.readUint16()>>8,t.readUint16(),t.readUint32Array(2),this.matrix=t.readUint32Array(9),t.readUint32Array(6),this.next_track_id=t.readUint32()}),BoxParser.createBoxCtor("npck","hintPacketsSent",function(t){this.packetssent=t.readUint32()}),BoxParser.createBoxCtor("nump","hintPacketsSent",function(t){this.packetssent=t.readUint64()}),BoxParser.createFullBoxCtor("padb","PaddingBitsBox",function(t){var e=t.readUint32();this.padbits=[];for(var i=0;i<Math.floor((e+1)/2);i++)this.padbits=t.readUint8()}),BoxParser.createBoxCtor("pasp","PixelAspectRatioBox",function(t){this.hSpacing=t.readUint32(),this.vSpacing=t.readUint32()}),BoxParser.createBoxCtor("payl","CuePayloadBox",function(t){this.text=t.readString(this.size-this.hdr_size)}),BoxParser.createBoxCtor("payt","hintpayloadID",function(t){this.payloadID=t.readUint32();var e=t.readUint8();this.rtpmap_string=t.readString(e)}),BoxParser.createFullBoxCtor("pdin","ProgressiveDownloadInfoBox",function(t){var e=(this.size-this.hdr_size)/8;this.rate=[],this.initial_delay=[];for(var i=0;i<e;i++)this.rate[i]=t.readUint32(),this.initial_delay[i]=t.readUint32()}),BoxParser.createFullBoxCtor("pitm","PrimaryItemBox",function(t){0===this.version?this.item_id=t.readUint16():this.item_id=t.readUint32()}),BoxParser.createFullBoxCtor("pixi","PixelInformationProperty",function(t){var e;for(this.num_channels=t.readUint8(),this.bits_per_channels=[],e=0;e<this.num_channels;e++)this.bits_per_channels[e]=t.readUint8()}),BoxParser.createBoxCtor("pmax","hintlargestpacket",function(t){this.bytes=t.readUint32()}),BoxParser.createFullBoxCtor("prdi","ProgressiveDerivedImageItemInformationProperty",function(t){if(this.step_count=t.readUint16(),this.item_count=[],2&this.flags)for(var e=0;e<this.step_count;e++)this.item_count[e]=t.readUint16()}),BoxParser.createFullBoxCtor("prft","ProducerReferenceTimeBox",function(t){this.ref_track_id=t.readUint32(),this.ntp_timestamp=t.readUint64(),0===this.version?this.media_time=t.readUint32():this.media_time=t.readUint64()}),BoxParser.createFullBoxCtor("pssh","ProtectionSystemSpecificHeaderBox",function(t){if(this.system_id=BoxParser.parseHex16(t),0<this.version){var e=t.readUint32();this.kid=[];for(var i=0;i<e;i++)this.kid[i]=BoxParser.parseHex16(t)}var r=t.readUint32();0<r&&(this.data=t.readUint8Array(r))}),BoxParser.createFullBoxCtor("clef","TrackCleanApertureDimensionsBox",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createFullBoxCtor("enof","TrackEncodedPixelsDimensionsBox",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createFullBoxCtor("prof","TrackProductionApertureDimensionsBox",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createContainerBoxCtor("tapt","TrackApertureModeDimensionsBox",null,["clef","prof","enof"]),BoxParser.createBoxCtor("rtp ","rtpmoviehintinformation",function(t){this.descriptionformat=t.readString(4),this.sdptext=t.readString(this.size-this.hdr_size-4)}),BoxParser.createFullBoxCtor("saio","SampleAuxiliaryInformationOffsetsBox",function(t){1&this.flags&&(this.aux_info_type=t.readString(4),this.aux_info_type_parameter=t.readUint32());var e=t.readUint32();this.offset=[];for(var i=0;i<e;i++)0===this.version?this.offset[i]=t.readUint32():this.offset[i]=t.readUint64()}),BoxParser.createFullBoxCtor("saiz","SampleAuxiliaryInformationSizesBox",function(t){if(1&this.flags&&(this.aux_info_type=t.readString(4),this.aux_info_type_parameter=t.readUint32()),this.default_sample_info_size=t.readUint8(),this.sample_count=t.readUint32(),this.sample_info_size=[],0===this.default_sample_info_size)for(var e=0;e<this.sample_count;e++)this.sample_info_size[e]=t.readUint8()}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"mett",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"metx",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.namespace=t.readCString(),this.schema_location=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"sbtt",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"stpp",function(t){this.parseHeader(t),this.namespace=t.readCString(),this.schema_location=t.readCString(),this.auxiliary_mime_types=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"stxt",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"tx3g",function(t){this.parseHeader(t),this.displayFlags=t.readUint32(),this.horizontal_justification=t.readInt8(),this.vertical_justification=t.readInt8(),this.bg_color_rgba=t.readUint8Array(4),this.box_record=t.readInt16Array(4),this.style_record=t.readUint8Array(12),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"wvtt",function(t){this.parseHeader(t),this.parseFooter(t)}),BoxParser.createSampleGroupCtor("alst",function(t){var e,i=t.readUint16();for(this.first_output_sample=t.readUint16(),this.sample_offset=[],e=0;e<i;e++)this.sample_offset[e]=t.readUint32();var r=this.description_length-4-4*i;for(this.num_output_samples=[],this.num_total_samples=[],e=0;e<r/4;e++)this.num_output_samples[e]=t.readUint16(),this.num_total_samples[e]=t.readUint16()}),BoxParser.createSampleGroupCtor("avll",function(t){this.layerNumber=t.readUint8(),this.accurateStatisticsFlag=t.readUint8(),this.avgBitRate=t.readUint16(),this.avgFrameRate=t.readUint16()}),BoxParser.createSampleGroupCtor("avss",function(t){this.subSequenceIdentifier=t.readUint16(),this.layerNumber=t.readUint8();var e=t.readUint8();this.durationFlag=e>>7,this.avgRateFlag=e>>6&1,this.durationFlag&&(this.duration=t.readUint32()),this.avgRateFlag&&(this.accurateStatisticsFlag=t.readUint8(),this.avgBitRate=t.readUint16(),this.avgFrameRate=t.readUint16()),this.dependency=[];for(var i=t.readUint8(),r=0;r<i;r++){var s={};this.dependency.push(s),s.subSeqDirectionFlag=t.readUint8(),s.layerNumber=t.readUint8(),s.subSequenceIdentifier=t.readUint16()}}),BoxParser.createSampleGroupCtor("dtrt",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("mvif",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("prol",function(t){this.roll_distance=t.readInt16()}),BoxParser.createSampleGroupCtor("rap ",function(t){t=t.readUint8();this.num_leading_samples_known=t>>7,this.num_leading_samples=127&t}),BoxParser.createSampleGroupCtor("rash",function(t){if(this.operation_point_count=t.readUint16(),this.description_length!==2+(1===this.operation_point_count?2:6*this.operation_point_count)+9)Log.warn("BoxParser","Mismatch in "+this.grouping_type+" sample group length"),this.data=t.readUint8Array(this.description_length-2);else{if(1===this.operation_point_count)this.target_rate_share=t.readUint16();else{this.target_rate_share=[],this.available_bitrate=[];for(var e=0;e<this.operation_point_count;e++)this.available_bitrate[e]=t.readUint32(),this.target_rate_share[e]=t.readUint16()}this.maximum_bitrate=t.readUint32(),this.minimum_bitrate=t.readUint32(),this.discard_priority=t.readUint8()}}),BoxParser.createSampleGroupCtor("roll",function(t){this.roll_distance=t.readInt16()}),BoxParser.SampleGroupEntry.prototype.parse=function(t){Log.warn("BoxParser","Unknown Sample Group type: "+this.grouping_type),this.data=t.readUint8Array(this.description_length)},BoxParser.createSampleGroupCtor("scif",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("scnm",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("seig",function(t){this.reserved=t.readUint8();var e=t.readUint8();this.crypt_byte_block=e>>4,this.skip_byte_block=15&e,this.isProtected=t.readUint8(),this.Per_Sample_IV_Size=t.readUint8(),this.KID=BoxParser.parseHex16(t),this.constant_IV_size=0,this.constant_IV=0,1===this.isProtected&&0===this.Per_Sample_IV_Size&&(this.constant_IV_size=t.readUint8(),this.constant_IV=t.readUint8Array(this.constant_IV_size))}),BoxParser.createSampleGroupCtor("stsa",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("sync",function(t){t=t.readUint8();this.NAL_unit_type=63&t}),BoxParser.createSampleGroupCtor("tele",function(t){t=t.readUint8();this.level_independently_decodable=t>>7}),BoxParser.createSampleGroupCtor("tsas",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("tscl",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("vipr",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createFullBoxCtor("sbgp","SampleToGroupBox",function(t){this.grouping_type=t.readString(4),1===this.version?this.grouping_type_parameter=t.readUint32():this.grouping_type_parameter=0,this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.entries.push(r),r.sample_count=t.readInt32(),r.group_description_index=t.readInt32()}}),Pixel.prototype.toString=function(){return"[row: "+this.bad_pixel_row+", column: "+this.bad_pixel_column+"]"},BoxParser.createFullBoxCtor("sbpm","SensorBadPixelsMapBox",function(t){var e;for(this.component_count=t.readUint16(),this.component_index=[],e=0;e<this.component_count;e++)this.component_index.push(t.readUint16());var i=t.readUint8();for(this.correction_applied=128==(128&i),this.num_bad_rows=t.readUint32(),this.num_bad_cols=t.readUint32(),this.num_bad_pixels=t.readUint32(),this.bad_rows=[],this.bad_columns=[],this.bad_pixels=[],e=0;e<this.num_bad_rows;e++)this.bad_rows.push(t.readUint32());for(e=0;e<this.num_bad_cols;e++)this.bad_columns.push(t.readUint32());for(e=0;e<this.num_bad_pixels;e++){var r=t.readUint32(),s=t.readUint32();this.bad_pixels.push(new Pixel(r,s))}}),BoxParser.createFullBoxCtor("schm","SchemeTypeBox",function(t){this.scheme_type=t.readString(4),this.scheme_version=t.readUint32(),1&this.flags&&(this.scheme_uri=t.readString(this.size-this.hdr_size-8))}),BoxParser.createBoxCtor("sdp ","rtptracksdphintinformation",function(t){this.sdptext=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("sdtp","SampleDependencyTypeBox",function(t){var e,i=this.size-this.hdr_size;this.is_leading=[],this.sample_depends_on=[],this.sample_is_depended_on=[],this.sample_has_redundancy=[];for(var r=0;r<i;r++)e=t.readUint8(),this.is_leading[r]=e>>6,this.sample_depends_on[r]=e>>4&3,this.sample_is_depended_on[r]=e>>2&3,this.sample_has_redundancy[r]=3&e}),BoxParser.createFullBoxCtor("senc","SampleEncryptionBox"),BoxParser.createFullBoxCtor("sgpd","SampleGroupDescriptionBox",function(t){this.grouping_type=t.readString(4),Log.debug("BoxParser","Found Sample Groups of type "+this.grouping_type),1===this.version?this.default_length=t.readUint32():this.default_length=0,2<=this.version&&(this.default_group_description_index=t.readUint32()),this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r=new(BoxParser[this.grouping_type+"SampleGroupEntry"]?BoxParser[this.grouping_type+"SampleGroupEntry"]:BoxParser.SampleGroupEntry)(this.grouping_type);this.entries.push(r),1===this.version&&0===this.default_length?r.description_length=t.readUint32():r.description_length=this.default_length,r.write===BoxParser.SampleGroupEntry.prototype.write&&(Log.info("BoxParser","SampleGroup for type "+this.grouping_type+" writing not yet implemented, keeping unparsed data in memory for later write"),r.data=t.readUint8Array(r.description_length),t.position-=r.description_length),r.parse(t)}}),BoxParser.createFullBoxCtor("sidx","CompressedSegmentIndexBox",function(t){this.reference_ID=t.readUint32(),this.timescale=t.readUint32(),0===this.version?(this.earliest_presentation_time=t.readUint32(),this.first_offset=t.readUint32()):(this.earliest_presentation_time=t.readUint64(),this.first_offset=t.readUint64()),t.readUint16(),this.references=[];for(var e=t.readUint16(),i=0;i<e;i++){var r={};this.references.push(r);var s=t.readUint32();r.reference_type=s>>31&1,r.referenced_size=2147483647&s,r.subsegment_duration=t.readUint32(),s=t.readUint32(),r.starts_with_SAP=s>>31&1,r.SAP_type=s>>28&7,r.SAP_delta_time=268435455&s}}),BoxParser.SingleItemTypeReferenceBox=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.SingleItemTypeReferenceBox.prototype=new BoxParser.Box,BoxParser.SingleItemTypeReferenceBox.prototype.parse=function(t){this.from_item_ID=t.readUint16();var e=t.readUint16();this.references=[];for(var i=0;i<e;i++)this.references[i]={},this.references[i].to_item_ID=t.readUint16()},BoxParser.SingleItemTypeReferenceBoxLarge=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.SingleItemTypeReferenceBoxLarge.prototype=new BoxParser.Box,BoxParser.SingleItemTypeReferenceBoxLarge.prototype.parse=function(t){this.from_item_ID=t.readUint32();var e=t.readUint16();this.references=[];for(var i=0;i<e;i++)this.references[i]={},this.references[i].to_item_ID=t.readUint32()},BoxParser.createFullBoxCtor("SmDm","SMPTE2086MasteringDisplayMetadataBox",function(t){this.primaryRChromaticity_x=t.readUint16(),this.primaryRChromaticity_y=t.readUint16(),this.primaryGChromaticity_x=t.readUint16(),this.primaryGChromaticity_y=t.readUint16(),this.primaryBChromaticity_x=t.readUint16(),this.primaryBChromaticity_y=t.readUint16(),this.whitePointChromaticity_x=t.readUint16(),this.whitePointChromaticity_y=t.readUint16(),this.luminanceMax=t.readUint32(),this.luminanceMin=t.readUint32()}),BoxParser.createFullBoxCtor("smhd","SoundMediaHeaderBox",function(t){this.balance=t.readUint16(),t.readUint16()}),BoxParser.createFullBoxCtor("ssix","CompressedSubsegmentIndexBox",function(t){this.subsegments=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.subsegments.push(r),r.ranges=[];for(var s=t.readUint32(),a=0;a<s;a++){var n={};r.ranges.push(n),n.level=t.readUint8(),n.range_size=t.readUint24()}}}),BoxParser.createFullBoxCtor("stco","ChunkOffsetBox",function(t){var e=t.readUint32();if(this.chunk_offsets=[],0===this.version)for(var i=0;i<e;i++)this.chunk_offsets.push(t.readUint32())}),BoxParser.createFullBoxCtor("stdp","DegradationPriorityBox",function(t){var e=(this.size-this.hdr_size)/2;this.priority=[];for(var i=0;i<e;i++)this.priority[i]=t.readUint16()}),BoxParser.createFullBoxCtor("sthd","SubtitleMediaHeaderBox"),BoxParser.createFullBoxCtor("stri","SubTrackInformationBox",function(t){this.switch_group=t.readUint16(),this.alternate_group=t.readUint16(),this.sub_track_id=t.readUint32();var e=(this.size-this.hdr_size-8)/4;this.attribute_list=[];for(var i=0;i<e;i++)this.attribute_list[i]=t.readUint32()}),BoxParser.createFullBoxCtor("stsc","SampleToChunkBox",function(t){var e,i=t.readUint32();if(this.first_chunk=[],this.samples_per_chunk=[],this.sample_description_index=[],0===this.version)for(e=0;e<i;e++)this.first_chunk.push(t.readUint32()),this.samples_per_chunk.push(t.readUint32()),this.sample_description_index.push(t.readUint32())}),BoxParser.createFullBoxCtor("stsd","SampleDescriptionBox",function(t){var e,i,r,s;for(this.entries=[],r=t.readUint32(),e=1;e<=r;e++){if((i=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;BoxParser[i.type+"SampleEntry"]?((s=new BoxParser[i.type+"SampleEntry"](i.size)).hdr_size=i.hdr_size,s.start=i.start):(Log.warn("BoxParser","Unknown sample entry type: "+i.type),s=new BoxParser.SampleEntry(i.type,i.size,i.hdr_size,i.start)),s.write===BoxParser.SampleEntry.prototype.write&&(Log.info("BoxParser","SampleEntry "+s.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),s.parseDataAndRewind(t)),s.parse(t),this.entries.push(s)}}),BoxParser.createFullBoxCtor("stsg","SubTrackSampleGroupBox",function(t){this.grouping_type=t.readUint32();var e=t.readUint16();this.group_description_index=[];for(var i=0;i<e;i++)this.group_description_index[i]=t.readUint32()}),BoxParser.createFullBoxCtor("stsh","ShadowSyncSampleBox",function(t){var e,i=t.readUint32();if(this.shadowed_sample_numbers=[],this.sync_sample_numbers=[],0===this.version)for(e=0;e<i;e++)this.shadowed_sample_numbers.push(t.readUint32()),this.sync_sample_numbers.push(t.readUint32())}),BoxParser.createFullBoxCtor("stss","SyncSampleBox",function(t){var e,i=t.readUint32();if(0===this.version)for(this.sample_numbers=[],e=0;e<i;e++)this.sample_numbers.push(t.readUint32())}),BoxParser.createFullBoxCtor("stsz","SampleSizeBox",function(t){var e;if(this.sample_sizes=[],0===this.version)for(this.sample_size=t.readUint32(),this.sample_count=t.readUint32(),e=0;e<this.sample_count;e++)0===this.sample_size?this.sample_sizes.push(t.readUint32()):this.sample_sizes[e]=this.sample_size}),BoxParser.createFullBoxCtor("stts","TimeToSampleBox",function(t){var e,i,r=t.readUint32();if(this.sample_counts=[],this.sample_deltas=[],0===this.version)for(e=0;e<r;e++)this.sample_counts.push(t.readUint32()),(i=t.readInt32())<0&&(Log.warn("BoxParser","File uses negative stts sample delta, using value 1 instead, sync may be lost!"),i=1),this.sample_deltas.push(i)}),BoxParser.createFullBoxCtor("stvi","StereoVideoBox",function(t){var e=t.readUint32();this.single_view_allowed=3&e,this.stereo_scheme=t.readUint32();var i,e=t.readUint32();for(this.stereo_indication_type=t.readString(e),this.boxes=[];t.getPosition()<this.start+this.size;){if((i=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;i=i.box,this.boxes.push(i),this[i.type]=i}}),BoxParser.createBoxCtor("styp","SegmentTypeBox",function(t){BoxParser.ftypBox.prototype.parse.call(this,t)}),BoxParser.createFullBoxCtor("stz2","CompactSampleSizeBox",function(t){var e,i;if(this.sample_sizes=[],0===this.version)if(this.reserved=t.readUint24(),this.field_size=t.readUint8(),i=t.readUint32(),4===this.field_size)for(e=0;e<i;e+=2){var r=t.readUint8();this.sample_sizes[e]=r>>4&15,this.sample_sizes[e+1]=15&r}else if(8===this.field_size)for(e=0;e<i;e++)this.sample_sizes[e]=t.readUint8();else if(16===this.field_size)for(e=0;e<i;e++)this.sample_sizes[e]=t.readUint16();else Log.error("BoxParser","Error in length field in stz2 box")}),BoxParser.createFullBoxCtor("subs","SubSampleInformationBox",function(t){var e,i,r,s=t.readUint32();for(this.entries=[],e=0;e<s;e++){var a={};if((this.entries[e]=a).sample_delta=t.readUint32(),a.subsamples=[],0<(r=t.readUint16()))for(i=0;i<r;i++){var n={};a.subsamples.push(n),1==this.version?n.size=t.readUint32():n.size=t.readUint16(),n.priority=t.readUint8(),n.discardable=t.readUint8(),n.codec_specific_parameters=t.readUint32()}}}),BoxParser.createFullBoxCtor("tenc","TrackEncryptionBox",function(t){var e;t.readUint8(),0===this.version?t.readUint8():(e=t.readUint8(),this.default_crypt_byte_block=e>>4&15,this.default_skip_byte_block=15&e),this.default_isProtected=t.readUint8(),this.default_Per_Sample_IV_Size=t.readUint8(),this.default_KID=BoxParser.parseHex16(t),1===this.default_isProtected&&0===this.default_Per_Sample_IV_Size&&(this.default_constant_IV_size=t.readUint8(),this.default_constant_IV=t.readUint8Array(this.default_constant_IV_size))}),BoxParser.createFullBoxCtor("tfdt","TrackFragmentBaseMediaDecodeTimeBox",function(t){1==this.version?this.baseMediaDecodeTime=t.readUint64():this.baseMediaDecodeTime=t.readUint32()}),BoxParser.createFullBoxCtor("tfhd","TrackFragmentHeaderBox",function(t){var e=0;this.track_id=t.readUint32(),this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET?(this.base_data_offset=t.readUint64(),e+=8):this.base_data_offset=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC?(this.default_sample_description_index=t.readUint32(),e+=4):this.default_sample_description_index=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR?(this.default_sample_duration=t.readUint32(),e+=4):this.default_sample_duration=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE?(this.default_sample_size=t.readUint32(),e+=4):this.default_sample_size=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS?(this.default_sample_flags=t.readUint32(),e+=4):this.default_sample_flags=0}),BoxParser.createFullBoxCtor("tfra","TrackFragmentRandomAccessBox",function(t){this.track_ID=t.readUint32(),t.readUint24();var e=t.readUint8();this.length_size_of_traf_num=e>>4&3,this.length_size_of_trun_num=e>>2&3,this.length_size_of_sample_num=3&e,this.entries=[];for(var i=t.readUint32(),r=0;r<i;r++)1===this.version?(this.time=t.readUint64(),this.moof_offset=t.readUint64()):(this.time=t.readUint32(),this.moof_offset=t.readUint32()),this.traf_number=t["readUint"+8*(this.length_size_of_traf_num+1)](),this.trun_number=t["readUint"+8*(this.length_size_of_trun_num+1)](),this.sample_number=t["readUint"+8*(this.length_size_of_sample_num+1)]()}),BoxParser.createFullBoxCtor("tkhd","TrackHeaderBox",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.track_id=t.readUint32(),t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.track_id=t.readUint32(),t.readUint32(),this.duration=t.readUint32()),t.readUint32Array(2),this.layer=t.readInt16(),this.alternate_group=t.readInt16(),this.volume=t.readInt16()>>8,t.readUint16(),this.matrix=t.readInt32Array(9),this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createBoxCtor("tmax","hintmaxrelativetime",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("tmin","hintminrelativetime",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("totl","hintBytesSent",function(t){this.bytessent=t.readUint32()}),BoxParser.createBoxCtor("tpay","hintBytesSent",function(t){this.bytessent=t.readUint32()}),BoxParser.createBoxCtor("tpyl","hintBytesSent",function(t){this.bytessent=t.readUint64()}),BoxParser.TrackGroupTypeBox.prototype.parse=function(t){this.parseFullHeader(t),this.track_group_id=t.readUint32()},BoxParser.createTrackGroupCtor("msrc"),BoxParser.TrackReferenceTypeBox=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.TrackReferenceTypeBox.prototype=new BoxParser.Box,BoxParser.TrackReferenceTypeBox.prototype.parse=function(t){this.track_ids=t.readUint32Array((this.size-this.hdr_size)/4)},BoxParser.trefBox.prototype.parse=function(t){for(var e;t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;(e=new BoxParser.TrackReferenceTypeBox(e.type,e.size,e.hdr_size,e.start)).write===BoxParser.Box.prototype.write&&"mdat"!==e.type&&(Log.info("BoxParser","TrackReference "+e.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),e.parseDataAndRewind(t)),e.parse(t),this.boxes.push(e)}},BoxParser.createFullBoxCtor("trep","TrackExtensionPropertiesBox",function(t){for(this.track_ID=t.readUint32(),this.boxes=[];t.getPosition()<this.start+this.size;){if(ret=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start)),ret.code!==BoxParser.OK)return;box=ret.box,this.boxes.push(box)}}),BoxParser.createFullBoxCtor("trex","TrackExtendsBox",function(t){this.track_id=t.readUint32(),this.default_sample_description_index=t.readUint32(),this.default_sample_duration=t.readUint32(),this.default_sample_size=t.readUint32(),this.default_sample_flags=t.readUint32()}),BoxParser.createBoxCtor("trpy","hintBytesSent",function(t){this.bytessent=t.readUint64()}),BoxParser.createFullBoxCtor("trun","TrackRunBox",function(t){var e=0;if(this.sample_count=t.readUint32(),e+=4,this.size-this.hdr_size>e&&this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET?(this.data_offset=t.readInt32(),e+=4):this.data_offset=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG?(this.first_sample_flags=t.readUint32(),e+=4):this.first_sample_flags=0,this.sample_duration=[],this.sample_size=[],this.sample_flags=[],this.sample_composition_time_offset=[],this.size-this.hdr_size>e)for(var i=0;i<this.sample_count;i++)this.flags&BoxParser.TRUN_FLAGS_DURATION&&(this.sample_duration[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_SIZE&&(this.sample_size[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&(this.sample_flags[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(0===this.version?this.sample_composition_time_offset[i]=t.readUint32():this.sample_composition_time_offset[i]=t.readInt32())}),BoxParser.createFullBoxCtor("tsel","TrackSelectionBox",function(t){this.switch_group=t.readUint32();var e=(this.size-this.hdr_size-4)/4;this.attribute_list=[];for(var i=0;i<e;i++)this.attribute_list[i]=t.readUint32()}),BoxParser.createFullBoxCtor("txtC","TextConfigBox",function(t){this.config=t.readCString()}),BoxParser.createBoxCtor("tyco","TypeCombinationBox",function(t){var e=(this.size-this.hdr_size)/4;this.compatible_brands=[];for(var i=0;i<e;i++)this.compatible_brands[i]=t.readString(4)}),BoxParser.createFullBoxCtor("udes","UserDescriptionProperty",function(t){this.lang=t.readCString(),this.name=t.readCString(),this.description=t.readCString(),this.tags=t.readCString()}),BoxParser.createFullBoxCtor("uncC","UncompressedFrameConfigBox",function(t){var e;if(this.profile=t.readString(4),1!=this.version&&0==this.version){for(this.component_count=t.readUint32(),this.component_index=[],this.component_bit_depth_minus_one=[],this.component_format=[],this.component_align_size=[],e=0;e<this.component_count;e++)this.component_index.push(t.readUint16()),this.component_bit_depth_minus_one.push(t.readUint8()),this.component_format.push(t.readUint8()),this.component_align_size.push(t.readUint8());this.sampling_type=t.readUint8(),this.interleave_type=t.readUint8(),this.block_size=t.readUint8();var i=t.readUint8();this.component_little_endian=i>>7&1,this.block_pad_lsb=i>>6&1,this.block_little_endian=i>>5&1,this.block_reversed=i>>4&1,this.pad_unknown=i>>3&1,this.pixel_size=t.readUint32(),this.row_align_size=t.readUint32(),this.tile_align_size=t.readUint32(),this.num_tile_cols_minus_one=t.readUint32(),this.num_tile_rows_minus_one=t.readUint32()}}),BoxParser.createFullBoxCtor("url ","DataEntryUrlBox",function(t){1!==this.flags&&(this.location=t.readCString())}),BoxParser.createFullBoxCtor("urn ","DataEntryUrnBox",function(t){this.name=t.readCString(),0<this.size-this.hdr_size-this.name.length-1&&(this.location=t.readCString())}),BoxParser.createUUIDBox("a5d40b30e81411ddba2f0800200c9a66","LiveServerManifestBox",!0,!1,function(t){this.LiveServerManifest=t.readString(this.size-this.hdr_size).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}),BoxParser.createUUIDBox("d08a4f1810f34a82b6c832d8aba183d3","PiffProtectionSystemSpecificHeaderBox",!0,!1,function(t){this.system_id=BoxParser.parseHex16(t);var e=t.readUint32();0<e&&(this.data=t.readUint8Array(e))}),BoxParser.createUUIDBox("a2394f525a9b4f14a2446c427c648df4","PiffSampleEncryptionBox",!0,!1),BoxParser.createUUIDBox("8974dbce7be74c5184f97148f9882554","PiffTrackEncryptionBox",!0,!1,function(t){this.default_AlgorithmID=t.readUint24(),this.default_IV_size=t.readUint8(),this.default_KID=BoxParser.parseHex16(t)}),BoxParser.createUUIDBox("d4807ef2ca3946958e5426cb9e46a79f","TfrfBox",!0,!1,function(t){this.fragment_count=t.readUint8(),this.entries=[];for(var e=0;e<this.fragment_count;e++){var i={},r=0,s=0,s=1===this.version?(r=t.readUint64(),t.readUint64()):(r=t.readUint32(),t.readUint32());i.absolute_time=r,i.absolute_duration=s,this.entries.push(i)}}),BoxParser.createUUIDBox("6d1d9b0542d544e680e2141daff757b2","TfxdBox",!0,!1,function(t){1===this.version?(this.absolute_time=t.readUint64(),this.duration=t.readUint64()):(this.absolute_time=t.readUint32(),this.duration=t.readUint32())}),BoxParser.createFullBoxCtor("vmhd","VideoMediaHeaderBox",function(t){this.graphicsmode=t.readUint16(),this.opcolor=t.readUint16Array(3)}),BoxParser.createFullBoxCtor("vpcC","VPCodecConfigurationRecord",function(t){var e;1===this.version?(this.profile=t.readUint8(),this.level=t.readUint8(),e=t.readUint8(),this.bitDepth=e>>4,this.chromaSubsampling=e>>1&7,this.videoFullRangeFlag=1&e,this.colourPrimaries=t.readUint8(),this.transferCharacteristics=t.readUint8(),this.matrixCoefficients=t.readUint8()):(this.profile=t.readUint8(),this.level=t.readUint8(),e=t.readUint8(),this.bitDepth=e>>4&15,this.colorSpace=15&e,e=t.readUint8(),this.chromaSubsampling=e>>4&15,this.transferFunction=e>>1&7,this.videoFullRangeFlag=1&e),this.codecIntializationDataSize=t.readUint16(),this.codecIntializationData=t.readUint8Array(this.codecIntializationDataSize)}),BoxParser.createBoxCtor("vttC","WebVTTConfigurationBox",function(t){this.text=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("vvcC","VvcConfigurationBox",function(t){var e,i={held_bits:void 0,num_held_bits:0,stream_read_1_bytes:function(t){this.held_bits=t.readUint8(),this.num_held_bits=8},stream_read_2_bytes:function(t){this.held_bits=t.readUint16(),this.num_held_bits=16},extract_bits:function(t){var e=this.held_bits>>this.num_held_bits-t&(1<<t)-1;return this.num_held_bits-=t,e}};if(i.stream_read_1_bytes(t),i.extract_bits(5),this.lengthSizeMinusOne=i.extract_bits(2),this.ptl_present_flag=i.extract_bits(1),this.ptl_present_flag){if(i.stream_read_2_bytes(t),this.ols_idx=i.extract_bits(9),this.num_sublayers=i.extract_bits(3),this.constant_frame_rate=i.extract_bits(2),this.chroma_format_idc=i.extract_bits(2),i.stream_read_1_bytes(t),this.bit_depth_minus8=i.extract_bits(3),i.extract_bits(5),i.stream_read_2_bytes(t),i.extract_bits(2),this.num_bytes_constraint_info=i.extract_bits(6),this.general_profile_idc=i.extract_bits(7),this.general_tier_flag=i.extract_bits(1),this.general_level_idc=t.readUint8(),i.stream_read_1_bytes(t),this.ptl_frame_only_constraint_flag=i.extract_bits(1),this.ptl_multilayer_enabled_flag=i.extract_bits(1),this.general_constraint_info=new Uint8Array(this.num_bytes_constraint_info),this.num_bytes_constraint_info){for(o=0;o<this.num_bytes_constraint_info-1;o++){var r=i.extract_bits(6);i.stream_read_1_bytes(t);var s=i.extract_bits(2);this.general_constraint_info[o]=r<<2|s}this.general_constraint_info[this.num_bytes_constraint_info-1]=i.extract_bits(6)}else i.extract_bits(6);if(1<this.num_sublayers){for(i.stream_read_1_bytes(t),this.ptl_sublayer_present_mask=0,e=this.num_sublayers-2;0<=e;--e){var a=i.extract_bits(1);this.ptl_sublayer_present_mask|=a<<e}for(e=this.num_sublayers;e<=8&&1<this.num_sublayers;++e)i.extract_bits(1);for(this.sublayer_level_idc=[],e=this.num_sublayers-2;0<=e;--e)this.ptl_sublayer_present_mask&1<<e&&(this.sublayer_level_idc[e]=t.readUint8())}if(this.ptl_num_sub_profiles=t.readUint8(),this.general_sub_profile_idc=[],this.ptl_num_sub_profiles)for(o=0;o<this.ptl_num_sub_profiles;o++)this.general_sub_profile_idc.push(t.readUint32());this.max_picture_width=t.readUint16(),this.max_picture_height=t.readUint16(),this.avg_frame_rate=t.readUint16()}this.nalu_arrays=[];for(var n=t.readUint8(),o=0;o<n;o++){var h=[];this.nalu_arrays.push(h),i.stream_read_1_bytes(t),h.completeness=i.extract_bits(1),i.extract_bits(2),h.nalu_type=i.extract_bits(5);var d=1;for(13!=h.nalu_type&&12!=h.nalu_type&&(d=t.readUint16()),e=0;e<d;e++){var l=t.readUint16();h.push({data:t.readUint8Array(l),length:l})}}}),BoxParser.createFullBoxCtor("vvnC","VvcNALUConfigBox",function(t){var e=strm.readUint8();this.lengthSizeMinusOne=3&e}),BoxParser.SampleEntry.prototype.isVideo=function(){return!1},BoxParser.SampleEntry.prototype.isAudio=function(){return!1},BoxParser.SampleEntry.prototype.isSubtitle=function(){return!1},BoxParser.SampleEntry.prototype.isMetadata=function(){return!1},BoxParser.SampleEntry.prototype.isHint=function(){return!1},BoxParser.SampleEntry.prototype.getCodec=function(){return this.type.replace(".","")},BoxParser.SampleEntry.prototype.getWidth=function(){return""},BoxParser.SampleEntry.prototype.getHeight=function(){return""},BoxParser.SampleEntry.prototype.getChannelCount=function(){return""},BoxParser.SampleEntry.prototype.getSampleRate=function(){return""},BoxParser.SampleEntry.prototype.getSampleSize=function(){return""},BoxParser.VisualSampleEntry.prototype.isVideo=function(){return!0},BoxParser.VisualSampleEntry.prototype.getWidth=function(){return this.width},BoxParser.VisualSampleEntry.prototype.getHeight=function(){return this.height},BoxParser.AudioSampleEntry.prototype.isAudio=function(){return!0},BoxParser.AudioSampleEntry.prototype.getChannelCount=function(){return this.channel_count},BoxParser.AudioSampleEntry.prototype.getSampleRate=function(){return this.samplerate},BoxParser.AudioSampleEntry.prototype.getSampleSize=function(){return this.samplesize},BoxParser.SubtitleSampleEntry.prototype.isSubtitle=function(){return!0},BoxParser.MetadataSampleEntry.prototype.isMetadata=function(){return!0},BoxParser.decimalToHex=function(t,e){var i=Number(t).toString(16);for(e=null==e?e=2:e;i.length<e;)i="0"+i;return i},BoxParser.avc1SampleEntry.prototype.getCodec=BoxParser.avc2SampleEntry.prototype.getCodec=BoxParser.avc3SampleEntry.prototype.getCodec=BoxParser.avc4SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);return this.avcC?t+"."+BoxParser.decimalToHex(this.avcC.AVCProfileIndication)+BoxParser.decimalToHex(this.avcC.profile_compatibility)+BoxParser.decimalToHex(this.avcC.AVCLevelIndication):t},BoxParser.hev1SampleEntry.prototype.getCodec=BoxParser.hvc1SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.hvcC){switch(t+=".",this.hvcC.general_profile_space){case 0:t+="";break;case 1:t+="A";break;case 2:t+="B";break;case 3:t+="C"}t+=this.hvcC.general_profile_idc,t+=".";for(var e=this.hvcC.general_profile_compatibility,i=0,r=0;r<32&&(i|=1&e,31!=r);r++)i<<=1,e>>=1;t+=BoxParser.decimalToHex(i,0),t+=".",0===this.hvcC.general_tier_flag?t+="L":t+="H",t+=this.hvcC.general_level_idc;var s=!1,a="";for(r=5;0<=r;r--)(this.hvcC.general_constraint_indicator[r]||s)&&(a="."+BoxParser.decimalToHex(this.hvcC.general_constraint_indicator[r],0)+a,s=!0);t+=a}return t},BoxParser.vvc1SampleEntry.prototype.getCodec=BoxParser.vvi1SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.vvcC){t+="."+this.vvcC.general_profile_idc,this.vvcC.general_tier_flag?t+=".H":t+=".L",t+=this.vvcC.general_level_idc;var e="";if(this.vvcC.general_constraint_info){var i,r=[],s=0;for(s|=this.vvcC.ptl_frame_only_constraint<<7,s|=this.vvcC.ptl_multilayer_enabled<<6,h=0;h<this.vvcC.general_constraint_info.length;++h)s|=this.vvcC.general_constraint_info[h]>>2&63,r.push(s),s&&(i=h),s=this.vvcC.general_constraint_info[h]>>2&3;if(void 0===i)e=".CA";else{e=".C";for(var a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",n=0,o=0,h=0;h<=i;++h)for(n=n<<8|r[h],o+=8;5<=o;)e+=a[n>>o-5&31],n&=(1<<(o-=5))-1;o&&(e+=a[31&(n<<=5-o)])}}t+=e}return t},BoxParser.mp4aSampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.esds&&this.esds.esd){var e=this.esds.esd.getOTI(),i=this.esds.esd.getAudioConfig();return t+"."+BoxParser.decimalToHex(e)+(i?"."+i:"")}return t},BoxParser.stxtSampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);return this.mime_format?t+"."+this.mime_format:t},BoxParser.vp08SampleEntry.prototype.getCodec=BoxParser.vp09SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this),e=this.vpcC.level;0==e&&(e="00");var i=this.vpcC.bitDepth;return 8==i&&(i="08"),t+".0"+this.vpcC.profile+"."+e+"."+i},BoxParser.av01SampleEntry.prototype.getCodec=function(){var t,e=BoxParser.SampleEntry.prototype.getCodec.call(this),i=this.av1C.seq_level_idx_0;return i<10&&(i="0"+i),2===this.av1C.seq_profile&&1===this.av1C.high_bitdepth?t=1===this.av1C.twelve_bit?"12":"10":this.av1C.seq_profile<=2&&(t=1===this.av1C.high_bitdepth?"10":"08"),e+"."+this.av1C.seq_profile+"."+i+(this.av1C.seq_tier_0?"H":"M")+"."+t},BoxParser.Box.prototype.writeHeader=function(t,e){this.size+=8,this.size>MAX_SIZE&&(this.size+=8),"uuid"===this.type&&(this.size+=16),Log.debug("BoxWriter","Writing box "+this.type+" of size: "+this.size+" at position "+t.getPosition()+(e||"")),this.size>MAX_SIZE?t.writeUint32(1):(this.sizePosition=t.getPosition(),t.writeUint32(this.size)),t.writeString(this.type,null,4),"uuid"===this.type&&t.writeUint8Array(this.uuid),this.size>MAX_SIZE&&t.writeUint64(this.size)},BoxParser.FullBox.prototype.writeHeader=function(t){this.size+=4,BoxParser.Box.prototype.writeHeader.call(this,t," v="+this.version+" f="+this.flags),t.writeUint8(this.version),t.writeUint24(this.flags)},BoxParser.Box.prototype.write=function(t){"mdat"===this.type?this.data&&(this.size=this.data.length,this.writeHeader(t),t.writeUint8Array(this.data)):(this.size=this.data?this.data.length:0,this.writeHeader(t),this.data&&t.writeUint8Array(this.data))},BoxParser.ContainerBox.prototype.write=function(t){this.size=0,this.writeHeader(t);for(var e=0;e<this.boxes.length;e++)this.boxes[e]&&(this.boxes[e].write(t),this.size+=this.boxes[e].size);Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.TrackReferenceTypeBox.prototype.write=function(t){this.size=4*this.track_ids.length,this.writeHeader(t),t.writeUint32Array(this.track_ids)},BoxParser.avcCBox.prototype.write=function(t){var e;for(this.size=7,e=0;e<this.SPS.length;e++)this.size+=2+this.SPS[e].length;for(e=0;e<this.PPS.length;e++)this.size+=2+this.PPS[e].length;for(this.ext&&(this.size+=this.ext.length),this.writeHeader(t),t.writeUint8(this.configurationVersion),t.writeUint8(this.AVCProfileIndication),t.writeUint8(this.profile_compatibility),t.writeUint8(this.AVCLevelIndication),t.writeUint8(this.lengthSizeMinusOne+252),t.writeUint8(this.SPS.length+224),e=0;e<this.SPS.length;e++)t.writeUint16(this.SPS[e].length),t.writeUint8Array(this.SPS[e].nalu);for(t.writeUint8(this.PPS.length),e=0;e<this.PPS.length;e++)t.writeUint16(this.PPS[e].length),t.writeUint8Array(this.PPS[e].nalu);this.ext&&t.writeUint8Array(this.ext)},BoxParser.co64Box.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.chunk_offsets.length,this.writeHeader(t),t.writeUint32(this.chunk_offsets.length),e=0;e<this.chunk_offsets.length;e++)t.writeUint64(this.chunk_offsets[e])},BoxParser.cslgBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20,this.writeHeader(t),t.writeInt32(this.compositionToDTSShift),t.writeInt32(this.leastDecodeToDisplayDelta),t.writeInt32(this.greatestDecodeToDisplayDelta),t.writeInt32(this.compositionStartTime),t.writeInt32(this.compositionEndTime)},BoxParser.cttsBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(t),t.writeUint32(this.sample_counts.length),e=0;e<this.sample_counts.length;e++)t.writeUint32(this.sample_counts[e]),1===this.version?t.writeInt32(this.sample_offsets[e]):t.writeUint32(this.sample_offsets[e])},BoxParser.drefBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++)this.entries[e].write(t),this.size+=this.entries[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.elngBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=this.extended_language.length,this.writeHeader(t),t.writeString(this.extended_language)},BoxParser.elstBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+12*this.entries.length,this.writeHeader(t),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++){var i=this.entries[e];t.writeUint32(i.segment_duration),t.writeInt32(i.media_time),t.writeInt16(i.media_rate_integer),t.writeInt16(i.media_rate_fraction)}},BoxParser.emsgBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=16+this.message_data.length+(this.scheme_id_uri.length+1)+(this.value.length+1),this.writeHeader(t),t.writeCString(this.scheme_id_uri),t.writeCString(this.value),t.writeUint32(this.timescale),t.writeUint32(this.presentation_time_delta),t.writeUint32(this.event_duration),t.writeUint32(this.id),t.writeUint8Array(this.message_data)},BoxParser.ftypBox.prototype.write=function(t){this.size=8+4*this.compatible_brands.length,this.writeHeader(t),t.writeString(this.major_brand,null,4),t.writeUint32(this.minor_version);for(var e=0;e<this.compatible_brands.length;e++)t.writeString(this.compatible_brands[e],null,4)},BoxParser.hdlrBox.prototype.write=function(t){this.size=20+this.name.length+1,this.version=0,this.flags=0,this.writeHeader(t),t.writeUint32(0),t.writeString(this.handler,null,4),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeCString(this.name)},BoxParser.hvcCBox.prototype.write=function(t){var e,i;for(this.size=23,e=0;e<this.nalu_arrays.length;e++)for(this.size+=3,i=0;i<this.nalu_arrays[e].length;i++)this.size+=2+this.nalu_arrays[e][i].data.length;for(this.writeHeader(t),t.writeUint8(this.configurationVersion),t.writeUint8((this.general_profile_space<<6)+(this.general_tier_flag<<5)+this.general_profile_idc),t.writeUint32(this.general_profile_compatibility),t.writeUint8Array(this.general_constraint_indicator),t.writeUint8(this.general_level_idc),t.writeUint16(this.min_spatial_segmentation_idc+(15<<24)),t.writeUint8(this.parallelismType+252),t.writeUint8(this.chroma_format_idc+252),t.writeUint8(this.bit_depth_luma_minus8+248),t.writeUint8(this.bit_depth_chroma_minus8+248),t.writeUint16(this.avgFrameRate),t.writeUint8((this.constantFrameRate<<6)+(this.numTemporalLayers<<3)+(this.temporalIdNested<<2)+this.lengthSizeMinusOne),t.writeUint8(this.nalu_arrays.length),e=0;e<this.nalu_arrays.length;e++)for(t.writeUint8((this.nalu_arrays[e].completeness<<7)+this.nalu_arrays[e].nalu_type),t.writeUint16(this.nalu_arrays[e].length),i=0;i<this.nalu_arrays[e].length;i++)t.writeUint16(this.nalu_arrays[e][i].data.length),t.writeUint8Array(this.nalu_arrays[e][i].data)},BoxParser.kindBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=this.schemeURI.length+1+(this.value.length+1),this.writeHeader(t),t.writeCString(this.schemeURI),t.writeCString(this.value)},BoxParser.mdhdBox.prototype.write=function(t){this.size=20,this.flags=0,this.version=0,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.timescale),t.writeUint32(this.duration),t.writeUint16(this.language),t.writeUint16(0)},BoxParser.mehdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.fragment_duration)},BoxParser.mfhdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.sequence_number)},BoxParser.mvhdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=96,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.timescale),t.writeUint32(this.duration),t.writeUint32(this.rate),t.writeUint16(this.volume<<8),t.writeUint16(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32Array(this.matrix),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(this.next_track_id)},BoxParser.SampleEntry.prototype.writeHeader=function(t){this.size=8,BoxParser.Box.prototype.writeHeader.call(this,t),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint16(this.data_reference_index)},BoxParser.SampleEntry.prototype.writeFooter=function(t){for(var e=0;e<this.boxes.length;e++)this.boxes[e].write(t),this.size+=this.boxes[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.SampleEntry.prototype.write=function(t){this.writeHeader(t),t.writeUint8Array(this.data),this.size+=this.data.length,Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.VisualSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=70,t.writeUint16(0),t.writeUint16(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint16(this.width),t.writeUint16(this.height),t.writeUint32(this.horizresolution),t.writeUint32(this.vertresolution),t.writeUint32(0),t.writeUint16(this.frame_count),t.writeUint8(Math.min(31,this.compressorname.length)),t.writeString(this.compressorname,null,31),t.writeUint16(this.depth),t.writeInt16(-1),this.writeFooter(t)},BoxParser.AudioSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=20,t.writeUint32(0),t.writeUint32(0),t.writeUint16(this.channel_count),t.writeUint16(this.samplesize),t.writeUint16(0),t.writeUint16(0),t.writeUint32(this.samplerate<<16),this.writeFooter(t)},BoxParser.stppSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=this.namespace.length+1+this.schema_location.length+1+this.auxiliary_mime_types.length+1,t.writeCString(this.namespace),t.writeCString(this.schema_location),t.writeCString(this.auxiliary_mime_types),this.writeFooter(t)},BoxParser.SampleGroupEntry.prototype.write=function(t){t.writeUint8Array(this.data)},BoxParser.sbgpBox.prototype.write=function(t){this.version=1,this.flags=0,this.size=12+8*this.entries.length,this.writeHeader(t),t.writeString(this.grouping_type,null,4),t.writeUint32(this.grouping_type_parameter),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++){var i=this.entries[e];t.writeInt32(i.sample_count),t.writeInt32(i.group_description_index)}},BoxParser.sgpdBox.prototype.write=function(t){var e,i;for(this.flags=0,this.size=12,e=0;e<this.entries.length;e++)i=this.entries[e],1===this.version&&(0===this.default_length&&(this.size+=4),this.size+=i.data.length);for(this.writeHeader(t),t.writeString(this.grouping_type,null,4),1===this.version&&t.writeUint32(this.default_length),2<=this.version&&t.writeUint32(this.default_sample_description_index),t.writeUint32(this.entries.length),e=0;e<this.entries.length;e++)i=this.entries[e],1===this.version&&0===this.default_length&&t.writeUint32(i.description_length),i.write(t)},BoxParser.sidxBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20+12*this.references.length,this.writeHeader(t),t.writeUint32(this.reference_ID),t.writeUint32(this.timescale),t.writeUint32(this.earliest_presentation_time),t.writeUint32(this.first_offset),t.writeUint16(0),t.writeUint16(this.references.length);for(var e=0;e<this.references.length;e++){var i=this.references[e];t.writeUint32(i.reference_type<<31|i.referenced_size),t.writeUint32(i.subsegment_duration),t.writeUint32(i.starts_with_SAP<<31|i.SAP_type<<28|i.SAP_delta_time)}},BoxParser.smhdBox.prototype.write=function(t){this.version=0,this.flags=1,this.size=4,this.writeHeader(t),t.writeUint16(this.balance),t.writeUint16(0)},BoxParser.stcoBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+4*this.chunk_offsets.length,this.writeHeader(t),t.writeUint32(this.chunk_offsets.length),t.writeUint32Array(this.chunk_offsets)},BoxParser.stscBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+12*this.first_chunk.length,this.writeHeader(t),t.writeUint32(this.first_chunk.length),e=0;e<this.first_chunk.length;e++)t.writeUint32(this.first_chunk[e]),t.writeUint32(this.samples_per_chunk[e]),t.writeUint32(this.sample_description_index[e])},BoxParser.stsdBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=0,this.writeHeader(t),t.writeUint32(this.entries.length),this.size+=4,e=0;e<this.entries.length;e++)this.entries[e].write(t),this.size+=this.entries[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.stshBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.shadowed_sample_numbers.length,this.writeHeader(t),t.writeUint32(this.shadowed_sample_numbers.length),e=0;e<this.shadowed_sample_numbers.length;e++)t.writeUint32(this.shadowed_sample_numbers[e]),t.writeUint32(this.sync_sample_numbers[e])},BoxParser.stssBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+4*this.sample_numbers.length,this.writeHeader(t),t.writeUint32(this.sample_numbers.length),t.writeUint32Array(this.sample_numbers)},BoxParser.stszBox.prototype.write=function(t){var e,i=!0;if(this.version=0,(this.flags=0)<this.sample_sizes.length)for(e=0;e+1<this.sample_sizes.length;){if(this.sample_sizes[e+1]!==this.sample_sizes[0]){i=!1;break}e++}else i=!1;this.size=8,i||(this.size+=4*this.sample_sizes.length),this.writeHeader(t),i?t.writeUint32(this.sample_sizes[0]):t.writeUint32(0),t.writeUint32(this.sample_sizes.length),i||t.writeUint32Array(this.sample_sizes)},BoxParser.sttsBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(t),t.writeUint32(this.sample_counts.length),e=0;e<this.sample_counts.length;e++)t.writeUint32(this.sample_counts[e]),t.writeUint32(this.sample_deltas[e])},BoxParser.tfdtBox.prototype.write=function(t){var e=Math.pow(2,32)-1;this.version=this.baseMediaDecodeTime>e?1:0,this.flags=0,this.size=4,1===this.version&&(this.size+=4),this.writeHeader(t),1===this.version?t.writeUint64(this.baseMediaDecodeTime):t.writeUint32(this.baseMediaDecodeTime)},BoxParser.tfhdBox.prototype.write=function(t){this.version=0,this.size=4,this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET&&(this.size+=8),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS&&(this.size+=4),this.writeHeader(t),t.writeUint32(this.track_id),this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET&&t.writeUint64(this.base_data_offset),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC&&t.writeUint32(this.default_sample_description_index),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR&&t.writeUint32(this.default_sample_duration),this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE&&t.writeUint32(this.default_sample_size),this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS&&t.writeUint32(this.default_sample_flags)},BoxParser.tkhdBox.prototype.write=function(t){this.version=0,this.size=80,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.track_id),t.writeUint32(0),t.writeUint32(this.duration),t.writeUint32(0),t.writeUint32(0),t.writeInt16(this.layer),t.writeInt16(this.alternate_group),t.writeInt16(this.volume<<8),t.writeUint16(0),t.writeInt32Array(this.matrix),t.writeUint32(this.width),t.writeUint32(this.height)},BoxParser.trexBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20,this.writeHeader(t),t.writeUint32(this.track_id),t.writeUint32(this.default_sample_description_index),t.writeUint32(this.default_sample_duration),t.writeUint32(this.default_sample_size),t.writeUint32(this.default_sample_flags)},BoxParser.trunBox.prototype.write=function(t){this.version=0,this.size=4,this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET&&(this.size+=4),this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&(this.size+=4),this.flags&BoxParser.TRUN_FLAGS_DURATION&&(this.size+=4*this.sample_duration.length),this.flags&BoxParser.TRUN_FLAGS_SIZE&&(this.size+=4*this.sample_size.length),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&(this.size+=4*this.sample_flags.length),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(this.size+=4*this.sample_composition_time_offset.length),this.writeHeader(t),t.writeUint32(this.sample_count),this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET&&(this.data_offset_position=t.getPosition(),t.writeInt32(this.data_offset)),this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&t.writeUint32(this.first_sample_flags);for(var e=0;e<this.sample_count;e++)this.flags&BoxParser.TRUN_FLAGS_DURATION&&t.writeUint32(this.sample_duration[e]),this.flags&BoxParser.TRUN_FLAGS_SIZE&&t.writeUint32(this.sample_size[e]),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&t.writeUint32(this.sample_flags[e]),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(0===this.version?t.writeUint32(this.sample_composition_time_offset[e]):t.writeInt32(this.sample_composition_time_offset[e]))},BoxParser["url Box"].prototype.write=function(t){this.version=0,this.location?(this.flags=0,this.size=this.location.length+1):(this.flags=1,this.size=0),this.writeHeader(t),this.location&&t.writeCString(this.location)},BoxParser["urn Box"].prototype.write=function(t){this.version=0,this.flags=0,this.size=this.name.length+1+(this.location?this.location.length+1:0),this.writeHeader(t),t.writeCString(this.name),this.location&&t.writeCString(this.location)},BoxParser.vmhdBox.prototype.write=function(t){this.version=0,this.flags=1,this.size=8,this.writeHeader(t),t.writeUint16(this.graphicsmode),t.writeUint16Array(this.opcolor)},BoxParser.cttsBox.prototype.unpack=function(t){for(var e,i=0,r=0;r<this.sample_counts.length;r++)for(e=0;e<this.sample_counts[r];e++)t[i].pts=t[i].dts+this.sample_offsets[r],i++},BoxParser.sttsBox.prototype.unpack=function(t){for(var e,i=0,r=0;r<this.sample_counts.length;r++)for(e=0;e<this.sample_counts[r];e++)t[i].dts=0===i?0:t[i-1].dts+this.sample_deltas[r],i++},BoxParser.stcoBox.prototype.unpack=function(t){for(var e=0;e<this.chunk_offsets.length;e++)t[e].offset=this.chunk_offsets[e]},BoxParser.stscBox.prototype.unpack=function(t){for(var e,i,r=0,s=0,a=0;a<this.first_chunk.length;a++)for(e=0;e<(a+1<this.first_chunk.length?this.first_chunk[a+1]:1/0);e++)for(s++,i=0;i<this.samples_per_chunk[a];i++){if(!t[r])return;t[r].description_index=this.sample_description_index[a],t[r].chunk_index=s,r++}},BoxParser.stszBox.prototype.unpack=function(t){for(var e=0;e<this.sample_sizes.length;e++)t[e].size=this.sample_sizes[e]},BoxParser.DIFF_BOXES_PROP_NAMES=["boxes","entries","references","subsamples","items","item_infos","extents","associations","subsegments","ranges","seekLists","seekPoints","esd","levels"],BoxParser.DIFF_PRIMITIVE_ARRAY_PROP_NAMES=["compatible_brands","matrix","opcolor","sample_counts","sample_deltas","first_chunk","samples_per_chunk","sample_sizes","chunk_offsets","sample_offsets","sample_description_index","sample_duration"],BoxParser.boxEqualFields=function(t,e){if(t&&!e)return!1;for(var i in t)if(!(-1<BoxParser.DIFF_BOXES_PROP_NAMES.indexOf(i)||t[i]instanceof BoxParser.Box||e[i]instanceof BoxParser.Box||void 0===t[i]||void 0===e[i]||"function"==typeof t[i]||"function"==typeof e[i]||t.subBoxNames&&-1<t.subBoxNames.indexOf(i.slice(0,4))||e.subBoxNames&&-1<e.subBoxNames.indexOf(i.slice(0,4))||"data"===i||"start"===i||"size"===i||"creation_time"===i||"modification_time"===i||-1<BoxParser.DIFF_PRIMITIVE_ARRAY_PROP_NAMES.indexOf(i)||t[i]===e[i]))return!1;return!0},BoxParser.boxEqual=function(t,e){if(!BoxParser.boxEqualFields(t,e))return!1;for(var i=0;i<BoxParser.DIFF_BOXES_PROP_NAMES.length;i++){var r=BoxParser.DIFF_BOXES_PROP_NAMES[i];if(t[r]&&e[r]&&!BoxParser.boxEqual(t[r],e[r]))return!1}return!0};var VTTin4Parser=function(){};VTTin4Parser.prototype.parseSample=function(t){for(var e,i=new MP4BoxStream(t.buffer),r=[];!i.isEos();)(e=BoxParser.parseOneBox(i,!1)).code===BoxParser.OK&&"vttc"===e.box.type&&r.push(e.box);return r},VTTin4Parser.prototype.getText=function(t,e,i){function s(t,e,i){return i=i||"0",(t+="").length>=e?t:new Array(e-t.length+1).join(i)+t}function r(t){var e=Math.floor(t/3600),i=Math.floor((t-3600*e)/60),r=Math.floor(t-3600*e-60*i),t=Math.floor(1e3*(t-3600*e-60*i-r));return s(e,2)+":"+s(i,2)+":"+s(r,2)+"."+s(t,3)}for(var a=this.parseSample(i),n="",o=0;o<a.length;o++){var h=a[o];n+=r(t)+" --\x3e "+r(e)+"\r\n",n+=h.payl.text}return n};var XMLSubtitlein4Parser=function(){};XMLSubtitlein4Parser.prototype.parseSample=function(t){var e,i={resources:[]},r=new MP4BoxStream(t.data.buffer);if(t.subsamples&&0!==t.subsamples.length){if(i.documentString=r.readString(t.subsamples[0].size),1<t.subsamples.length)for(e=1;e<t.subsamples.length;e++)i.resources[e]=r.readUint8Array(t.subsamples[e].size)}else i.documentString=r.readString(t.data.length);return"undefined"!=typeof DOMParser&&(i.document=(new DOMParser).parseFromString(i.documentString,"application/xml")),i};var Textin4Parser=function(){};Textin4Parser.prototype.parseSample=function(t){return new MP4BoxStream(t.data.buffer).readString(t.data.length)},Textin4Parser.prototype.parseConfig=function(t){t=new MP4BoxStream(t.buffer);return t.readUint32(),t.readCString()},"undefined"!=typeof exports&&(exports.VTTin4Parser=VTTin4Parser,exports.XMLSubtitlein4Parser=XMLSubtitlein4Parser,exports.Textin4Parser=Textin4Parser);var ISOFile=function(t){this.stream=t||new MultiBufferStream,this.boxes=[],this.mdats=[],this.moofs=[],this.isProgressive=!1,this.moovStartFound=!1,this.onMoovStart=null,this.moovStartSent=!1,this.onReady=null,this.readySent=!1,this.onSegment=null,this.onSamples=null,this.onError=null,this.sampleListBuilt=!1,this.fragmentedTracks=[],this.extractedTracks=[],this.isFragmentationInitialized=!1,this.sampleProcessingStarted=!1,this.nextMoofNumber=0,this.itemListBuilt=!1,this.items=[],this.entity_groups=[],this.onSidx=null,this.sidxSent=!1};ISOFile.prototype.setSegmentOptions=function(t,e,i){var r,s=this.getTrackById(t);s&&(r={},this.fragmentedTracks.push(r),r.id=t,r.user=e,(r.trak=s).nextSample=0,r.segmentStream=null,r.nb_samples=1e3,r.rapAlignement=!0,i&&(i.nbSamples&&(r.nb_samples=i.nbSamples),i.rapAlignement&&(r.rapAlignement=i.rapAlignement)))},ISOFile.prototype.unsetSegmentOptions=function(t){for(var e=-1,i=0;i<this.fragmentedTracks.length;i++)this.fragmentedTracks[i].id==t&&(e=i);-1<e&&this.fragmentedTracks.splice(e,1)},ISOFile.prototype.setExtractionOptions=function(t,e,i){var r,s=this.getTrackById(t);s&&(r={},this.extractedTracks.push(r),r.id=t,r.user=e,(r.trak=s).nextSample=0,r.nb_samples=1e3,r.samples=[],i&&i.nbSamples&&(r.nb_samples=i.nbSamples))},ISOFile.prototype.unsetExtractionOptions=function(t){for(var e=-1,i=0;i<this.extractedTracks.length;i++)this.extractedTracks[i].id==t&&(e=i);-1<e&&this.extractedTracks.splice(e,1)},ISOFile.prototype.parse=function(){var t;if(!this.restoreParsePosition||this.restoreParsePosition())for(;;)if(this.hasIncompleteMdat&&this.hasIncompleteMdat()){if(!this.processIncompleteMdat())return}else if(this.saveParsePosition&&this.saveParsePosition(),(t=BoxParser.parseOneBox(this.stream,!1)).code===BoxParser.ERR_NOT_ENOUGH_DATA){if(!this.processIncompleteBox)return;if(!this.processIncompleteBox(t))return}else{var e,i="uuid"!==(e=t.box).type?e.type:e.uuid;switch(this.boxes.push(e),i){case"mdat":this.mdats.push(e);break;case"moof":this.moofs.push(e);break;case"moov":this.moovStartFound=!0,0===this.mdats.length&&(this.isProgressive=!0);default:void 0!==this[i]&&Log.warn("ISOFile","Duplicate Box of type: "+i+", overriding previous occurrence"),this[i]=e}this.updateUsedBytes&&this.updateUsedBytes(e,t)}},ISOFile.prototype.checkBuffer=function(t){if(null==t)throw"Buffer must be defined and non empty";if(void 0===t.fileStart)throw"Buffer must have a fileStart property";return 0===t.byteLength?(Log.warn("ISOFile","Ignoring empty buffer (fileStart: "+t.fileStart+")"),this.stream.logBufferLevel(),!1):(Log.info("ISOFile","Processing buffer (fileStart: "+t.fileStart+")"),t.usedBytes=0,this.stream.insertBuffer(t),this.stream.logBufferLevel(),!!this.stream.initialized()||(Log.warn("ISOFile","Not ready to start parsing"),!1))},ISOFile.prototype.appendBuffer=function(t,e){var i;if(this.checkBuffer(t))return this.parse(),this.moovStartFound&&!this.moovStartSent&&(this.moovStartSent=!0,this.onMoovStart&&this.onMoovStart()),this.moov?(this.sampleListBuilt||(this.buildSampleLists(),this.sampleListBuilt=!0),this.updateSampleLists(),this.onReady&&!this.readySent&&(this.readySent=!0,this.onReady(this.getInfo())),this.processSamples(e),this.nextSeekPosition?(i=this.nextSeekPosition,this.nextSeekPosition=void 0):i=this.nextParsePosition,this.stream.getEndFilePositionAfter&&(i=this.stream.getEndFilePositionAfter(i))):i=this.nextParsePosition||0,this.sidx&&this.onSidx&&!this.sidxSent&&(this.onSidx(this.sidx),this.sidxSent=!0),this.meta&&(this.flattenItemInfo&&!this.itemListBuilt&&(this.flattenItemInfo(),this.itemListBuilt=!0),this.processItems&&this.processItems(this.onItem)),this.stream.cleanBuffers&&(Log.info("ISOFile","Done processing buffer (fileStart: "+t.fileStart+") - next buffer to fetch should have a fileStart position of "+i),this.stream.logBufferLevel(),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0),Log.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize())),i},ISOFile.prototype.getInfo=function(){var t,e,i,r,s,a,n={},o=new Date("1904-01-01T00:00:00Z").getTime();if(this.moov)for(n.hasMoov=!0,n.duration=this.moov.mvhd.duration,n.timescale=this.moov.mvhd.timescale,n.isFragmented=null!=this.moov.mvex,n.isFragmented&&this.moov.mvex.mehd&&(n.fragment_duration=this.moov.mvex.mehd.fragment_duration),n.isProgressive=this.isProgressive,n.hasIOD=null!=this.moov.iods,n.brands=[],n.brands.push(this.ftyp.major_brand),n.brands=n.brands.concat(this.ftyp.compatible_brands),n.created=new Date(o+1e3*this.moov.mvhd.creation_time),n.modified=new Date(o+1e3*this.moov.mvhd.modification_time),n.tracks=[],n.audioTracks=[],n.videoTracks=[],n.subtitleTracks=[],n.metadataTracks=[],n.hintTracks=[],n.otherTracks=[],t=0;t<this.moov.traks.length;t++){if(a=(i=this.moov.traks[t]).mdia.minf.stbl.stsd.entries[0],r={},n.tracks.push(r),r.id=i.tkhd.track_id,r.name=i.mdia.hdlr.name,r.references=[],i.tref)for(e=0;e<i.tref.boxes.length;e++)s={},r.references.push(s),s.type=i.tref.boxes[e].type,s.track_ids=i.tref.boxes[e].track_ids;i.edts&&(r.edits=i.edts.elst.entries),r.created=new Date(o+1e3*i.tkhd.creation_time),r.modified=new Date(o+1e3*i.tkhd.modification_time),r.movie_duration=i.tkhd.duration,r.movie_timescale=n.timescale,r.layer=i.tkhd.layer,r.alternate_group=i.tkhd.alternate_group,r.volume=i.tkhd.volume,r.matrix=i.tkhd.matrix,r.track_width=i.tkhd.width/65536,r.track_height=i.tkhd.height/65536,r.timescale=i.mdia.mdhd.timescale,r.cts_shift=i.mdia.minf.stbl.cslg,r.duration=i.mdia.mdhd.duration,r.samples_duration=i.samples_duration,r.codec=a.getCodec(),r.kind=i.udta&&i.udta.kinds.length?i.udta.kinds[0]:{schemeURI:"",value:""},r.language=i.mdia.elng?i.mdia.elng.extended_language:i.mdia.mdhd.languageString,r.nb_samples=i.samples.length,r.size=i.samples_size,r.bitrate=8*r.size*r.timescale/r.samples_duration,a.isAudio()?(r.type="audio",n.audioTracks.push(r),r.audio={},r.audio.sample_rate=a.getSampleRate(),r.audio.channel_count=a.getChannelCount(),r.audio.sample_size=a.getSampleSize()):a.isVideo()?(r.type="video",n.videoTracks.push(r),r.video={},r.video.width=a.getWidth(),r.video.height=a.getHeight()):a.isSubtitle()?(r.type="subtitles",n.subtitleTracks.push(r)):a.isHint()?(r.type="metadata",n.hintTracks.push(r)):a.isMetadata()?(r.type="metadata",n.metadataTracks.push(r)):(r.type="metadata",n.otherTracks.push(r))}else n.hasMoov=!1;if(n.mime="",n.hasMoov&&n.tracks){for(n.videoTracks&&0<n.videoTracks.length?n.mime+='video/mp4; codecs="':n.audioTracks&&0<n.audioTracks.length?n.mime+='audio/mp4; codecs="':n.mime+='application/mp4; codecs="',t=0;t<n.tracks.length;t++)0!==t&&(n.mime+=","),n.mime+=n.tracks[t].codec;n.mime+='"; profiles="',n.mime+=this.ftyp.compatible_brands.join(),n.mime+='"'}return n},ISOFile.prototype.setNextSeekPositionFromSample=function(t){t&&(this.nextSeekPosition?this.nextSeekPosition=Math.min(t.offset+t.alreadyRead,this.nextSeekPosition):this.nextSeekPosition=t.offset+t.alreadyRead)},ISOFile.prototype.processSamples=function(t){var e;if(this.sampleProcessingStarted){if(this.isFragmentationInitialized&&null!==this.onSegment)for(e=0;e<this.fragmentedTracks.length;e++)for(var i=this.fragmentedTracks[e],r=i.trak;r.nextSample<r.samples.length&&this.sampleProcessingStarted;){Log.debug("ISOFile","Creating media fragment on track #"+i.id+" for sample "+r.nextSample);var s=this.createFragment(i.id,r.nextSample,i.segmentStream);if(!s)break;if(i.segmentStream=s,r.nextSample++,(r.nextSample%i.nb_samples==0||t||r.nextSample>=r.samples.length)&&(Log.info("ISOFile","Sending fragmented data on track #"+i.id+" for samples ["+Math.max(0,r.nextSample-i.nb_samples)+","+(r.nextSample-1)+"]"),Log.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize()),this.onSegment&&this.onSegment(i.id,i.user,i.segmentStream.buffer,r.nextSample,t||r.nextSample>=r.samples.length),i.segmentStream=null,i!==this.fragmentedTracks[e]))break}if(null!==this.onSamples)for(e=0;e<this.extractedTracks.length;e++){var a=this.extractedTracks[e];for(r=a.trak;r.nextSample<r.samples.length&&this.sampleProcessingStarted;){Log.debug("ISOFile","Exporting on track #"+a.id+" sample #"+r.nextSample);var n=this.getSample(r,r.nextSample);if(!n){this.setNextSeekPositionFromSample(r.samples[r.nextSample]);break}if(r.nextSample++,a.samples.push(n),(r.nextSample%a.nb_samples==0||r.nextSample>=r.samples.length)&&(Log.debug("ISOFile","Sending samples on track #"+a.id+" for sample "+r.nextSample),this.onSamples&&this.onSamples(a.id,a.user,a.samples),a.samples=[],a!==this.extractedTracks[e]))break}}}},ISOFile.prototype.getBox=function(t){t=this.getBoxes(t,!0);return t.length?t[0]:null},ISOFile.prototype.getBoxes=function(t,e){var i=[];return ISOFile._sweep.call(this,t,i,e),i},ISOFile._sweep=function(t,e,i){for(var r in this.type&&this.type==t&&e.push(this),this.boxes){if(e.length&&i)return;ISOFile._sweep.call(this.boxes[r],t,e,i)}},ISOFile.prototype.getTrackSamplesInfo=function(t){t=this.getTrackById(t);if(t)return t.samples},ISOFile.prototype.getTrackSample=function(t,e){t=this.getTrackById(t);return this.getSample(t,e)},ISOFile.prototype.releaseUsedSamples=function(t,e){var i=0,r=this.getTrackById(t);r.lastValidSample||(r.lastValidSample=0);for(var s=r.lastValidSample;s<e;s++)i+=this.releaseSample(r,s);Log.info("ISOFile","Track #"+t+" released samples up to "+e+" (released size: "+i+", remaining: "+this.samplesDataSize+")"),r.lastValidSample=e},ISOFile.prototype.start=function(){this.sampleProcessingStarted=!0,this.processSamples(!1)},ISOFile.prototype.stop=function(){this.sampleProcessingStarted=!1},ISOFile.prototype.flush=function(){Log.info("ISOFile","Flushing remaining samples"),this.updateSampleLists(),this.processSamples(!0),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0)},ISOFile.prototype.seekTrack=function(t,e,i){var r,s,a,n,o=0,h=0;if(0===i.samples.length)return Log.info("ISOFile","No sample in track, cannot seek! Using time "+Log.getDurationString(0,1)+" and offset: 0"),{offset:0,time:0};for(r=0;r<i.samples.length;r++){if(s=i.samples[r],0===r)h=0,n=s.timescale;else if(s.cts>t*s.timescale){h=r-1;break}e&&s.is_sync&&(o=r)}for(e&&(h=o),t=i.samples[h].cts,i.nextSample=h;i.samples[h].alreadyRead===i.samples[h].size&&i.samples[h+1];)h++;return a=i.samples[h].offset+i.samples[h].alreadyRead,Log.info("ISOFile","Seeking to "+(e?"RAP":"")+" sample #"+i.nextSample+" on track "+i.tkhd.track_id+", time "+Log.getDurationString(t,n)+" and offset: "+a),{offset:a,time:t/n}},ISOFile.prototype.getTrackDuration=function(t){return t.samples?((t=t.samples[t.samples.length-1]).cts+t.duration)/t.timescale:1/0},ISOFile.prototype.seek=function(t,e){var i,r,s=this.moov,a={offset:1/0,time:1/0};if(this.moov){for(r=0;r<s.traks.length;r++)i=s.traks[r],t>this.getTrackDuration(i)||((i=this.seekTrack(t,e,i)).offset<a.offset&&(a.offset=i.offset),i.time<a.time&&(a.time=i.time));return Log.info("ISOFile","Seeking at time "+Log.getDurationString(a.time,1)+" needs a buffer with a fileStart position of "+a.offset),a.offset===1/0?a={offset:this.nextParsePosition,time:0}:a.offset=this.stream.getEndFilePositionAfter(a.offset),Log.info("ISOFile","Adjusted seek position (after checking data already in buffer): "+a.offset),a}throw"Cannot seek: moov not received!"},ISOFile.prototype.equal=function(t){for(var e=0;e<this.boxes.length&&e<t.boxes.length;){var i=this.boxes[e],r=t.boxes[e];if(!BoxParser.boxEqual(i,r))return!1;e++}return!0},"undefined"!=typeof exports&&(exports.ISOFile=ISOFile),ISOFile.prototype.lastBoxStartPosition=0,ISOFile.prototype.parsingMdat=null,ISOFile.prototype.nextParsePosition=0,ISOFile.prototype.discardMdatData=!1,ISOFile.prototype.processIncompleteBox=function(t){var e;return"mdat"===t.type?(e=new BoxParser[t.type+"Box"](t.size),this.parsingMdat=e,this.boxes.push(e),this.mdats.push(e),e.start=t.start,e.hdr_size=t.hdr_size,this.stream.addUsedBytes(e.hdr_size),this.lastBoxStartPosition=e.start+e.size,this.stream.seek(e.start+e.size,!1,this.discardMdatData)?!(this.parsingMdat=null):(this.moovStartFound?this.nextParsePosition=this.stream.findEndContiguousBuf():this.nextParsePosition=e.start+e.size,!1)):("moov"===t.type&&(this.moovStartFound=!0,0===this.mdats.length&&(this.isProgressive=!0)),!!this.stream.mergeNextBuffer&&this.stream.mergeNextBuffer()?(this.nextParsePosition=this.stream.getEndPosition(),!0):(!t.type||this.moovStartFound?this.nextParsePosition=this.stream.getEndPosition():this.nextParsePosition=this.stream.getPosition()+t.size,!1))},ISOFile.prototype.hasIncompleteMdat=function(){return null!==this.parsingMdat},ISOFile.prototype.processIncompleteMdat=function(){var t=this.parsingMdat;return this.stream.seek(t.start+t.size,!1,this.discardMdatData)?(Log.debug("ISOFile","Found 'mdat' end in buffered data"),!(this.parsingMdat=null)):(this.nextParsePosition=this.stream.findEndContiguousBuf(),!1)},ISOFile.prototype.restoreParsePosition=function(){return this.stream.seek(this.lastBoxStartPosition,!0,this.discardMdatData)},ISOFile.prototype.saveParsePosition=function(){this.lastBoxStartPosition=this.stream.getPosition()},ISOFile.prototype.updateUsedBytes=function(t,e){this.stream.addUsedBytes&&("mdat"===t.type?(this.stream.addUsedBytes(t.hdr_size),this.discardMdatData&&this.stream.addUsedBytes(t.size-t.hdr_size)):this.stream.addUsedBytes(t.size))},ISOFile.prototype.add=BoxParser.Box.prototype.add,ISOFile.prototype.addBox=BoxParser.Box.prototype.addBox,ISOFile.prototype.init=function(t){var e=t||{},t=(this.add("ftyp").set("major_brand",e.brands&&e.brands[0]||"iso4").set("minor_version",0).set("compatible_brands",e.brands||["iso4"]),this.add("moov"));return t.add("mvhd").set("timescale",e.timescale||600).set("rate",e.rate||65536).set("creation_time",0).set("modification_time",0).set("duration",e.duration||0).set("volume",e.width?0:256).set("matrix",[65536,0,0,0,65536,0,0,0,1073741824]).set("next_track_id",1),t.add("mvex"),this},ISOFile.prototype.addTrack=function(t){this.moov||this.init(t);var e=t||{};e.width=e.width||320,e.height=e.height||320,e.id=e.id||this.moov.mvhd.next_track_id,e.type=e.type||"avc1";var i=this.moov.add("trak");this.moov.mvhd.next_track_id=e.id+1,i.add("tkhd").set("flags",BoxParser.TKHD_FLAG_ENABLED|BoxParser.TKHD_FLAG_IN_MOVIE|BoxParser.TKHD_FLAG_IN_PREVIEW).set("creation_time",0).set("modification_time",0).set("track_id",e.id).set("duration",e.duration||0).set("layer",e.layer||0).set("alternate_group",0).set("volume",1).set("matrix",[65536,0,0,0,65536,0,0,0,1073741824]).set("width",e.width<<16).set("height",e.height<<16);t=i.add("mdia");t.add("mdhd").set("creation_time",0).set("modification_time",0).set("timescale",e.timescale||1).set("duration",e.media_duration||0).set("language",e.language||"und"),t.add("hdlr").set("handler",e.hdlr||"vide").set("name",e.name||"Track created with MP4Box.js"),t.add("elng").set("extended_language",e.language||"fr-FR");var r=t.add("minf");if(void 0!==BoxParser[e.type+"SampleEntry"]){var s=new BoxParser[e.type+"SampleEntry"];s.data_reference_index=1;var a,n,o="";for(a in BoxParser.sampleEntryCodes)for(var h=BoxParser.sampleEntryCodes[a],d=0;d<h.length;d++)if(-1<h.indexOf(e.type)){o=a;break}switch(o){case"Visual":r.add("vmhd").set("graphicsmode",0).set("opcolor",[0,0,0]),s.set("width",e.width).set("height",e.height).set("horizresolution",72<<16).set("vertresolution",72<<16).set("frame_count",1).set("compressorname",e.type+" Compressor").set("depth",24),e.avcDecoderConfigRecord?((n=new BoxParser.avcCBox).parse(new MP4BoxStream(e.avcDecoderConfigRecord)),s.addBox(n)):e.hevcDecoderConfigRecord&&((n=new BoxParser.hvcCBox).parse(new MP4BoxStream(e.hevcDecoderConfigRecord)),s.addBox(n));break;case"Audio":r.add("smhd").set("balance",e.balance||0),s.set("channel_count",e.channel_count||2).set("samplesize",e.samplesize||16).set("samplerate",e.samplerate||65536);break;case"Hint":r.add("hmhd");break;case"Subtitle":r.add("sthd"),"stpp"===e.type&&s.set("namespace",e.namespace||"nonamespace").set("schema_location",e.schema_location||"").set("auxiliary_mime_types",e.auxiliary_mime_types||"");break;case"Metadata":case"System":default:r.add("nmhd")}e.description&&s.addBox(e.description),e.description_boxes&&e.description_boxes.forEach(function(t){s.addBox(t)}),r.add("dinf").add("dref").addEntry((new BoxParser["url Box"]).set("flags",1));t=r.add("stbl");return t.add("stsd").addEntry(s),t.add("stts").set("sample_counts",[]).set("sample_deltas",[]),t.add("stsc").set("first_chunk",[]).set("samples_per_chunk",[]).set("sample_description_index",[]),t.add("stco").set("chunk_offsets",[]),t.add("stsz").set("sample_sizes",[]),this.moov.mvex.add("trex").set("track_id",e.id).set("default_sample_description_index",e.default_sample_description_index||1).set("default_sample_duration",e.default_sample_duration||0).set("default_sample_size",e.default_sample_size||0).set("default_sample_flags",e.default_sample_flags||0),this.buildTrakSampleLists(i),e.id}},BoxParser.Box.prototype.computeSize=function(t){t=t||new DataStream;t.endianness=DataStream.BIG_ENDIAN,this.write(t)},ISOFile.prototype.addSample=function(t,e,i){var r=i||{},i={},t=this.getTrackById(t);if(null!==t){i.number=t.samples.length,i.track_id=t.tkhd.track_id,i.timescale=t.mdia.mdhd.timescale,i.description_index=r.sample_description_index?r.sample_description_index-1:0,i.description=t.mdia.minf.stbl.stsd.entries[i.description_index],i.data=e,i.size=e.byteLength,i.alreadyRead=i.size,i.duration=r.duration||1,i.cts=r.cts||0,i.dts=r.dts||0,i.is_sync=r.is_sync||!1,i.is_leading=r.is_leading||0,i.depends_on=r.depends_on||0,i.is_depended_on=r.is_depended_on||0,i.has_redundancy=r.has_redundancy||0,i.degradation_priority=r.degradation_priority||0,i.offset=0,i.subsamples=r.subsamples,t.samples.push(i),t.samples_size+=i.size,t.samples_duration+=i.duration,void 0===t.first_dts&&(t.first_dts=r.dts),this.processSamples();r=this.createSingleSampleMoof(i);return this.addBox(r),r.computeSize(),r.trafs[0].truns[0].data_offset=r.size+8,this.add("mdat").data=new Uint8Array(e),i}},ISOFile.prototype.createSingleSampleMoof=function(t){var e=0,e=t.is_sync?1<<25:65536,i=new BoxParser.moofBox;i.add("mfhd").set("sequence_number",this.nextMoofNumber),this.nextMoofNumber++;var r=i.add("traf"),s=this.getTrackById(t.track_id);return r.add("tfhd").set("track_id",t.track_id).set("flags",BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF),r.add("tfdt").set("baseMediaDecodeTime",t.dts-(s.first_dts||0)),r.add("trun").set("flags",BoxParser.TRUN_FLAGS_DATA_OFFSET|BoxParser.TRUN_FLAGS_DURATION|BoxParser.TRUN_FLAGS_SIZE|BoxParser.TRUN_FLAGS_FLAGS|BoxParser.TRUN_FLAGS_CTS_OFFSET).set("data_offset",0).set("first_sample_flags",0).set("sample_count",1).set("sample_duration",[t.duration]).set("sample_size",[t.size]).set("sample_flags",[e]).set("sample_composition_time_offset",[t.cts-t.dts]),i},ISOFile.prototype.lastMoofIndex=0,ISOFile.prototype.samplesDataSize=0,ISOFile.prototype.resetTables=function(){var t,e;for(this.initial_duration=this.moov.mvhd.duration,t=this.moov.mvhd.duration=0;t<this.moov.traks.length;t++){(e=this.moov.traks[t]).tkhd.duration=0,e.mdia.mdhd.duration=0,(e.mdia.minf.stbl.stco||e.mdia.minf.stbl.co64).chunk_offsets=[],(i=e.mdia.minf.stbl.stsc).first_chunk=[],i.samples_per_chunk=[],i.sample_description_index=[],(e.mdia.minf.stbl.stsz||e.mdia.minf.stbl.stz2).sample_sizes=[],(i=e.mdia.minf.stbl.stts).sample_counts=[],i.sample_deltas=[],(i=e.mdia.minf.stbl.ctts)&&(i.sample_counts=[],i.sample_offsets=[]),i=e.mdia.minf.stbl.stss;var i=e.mdia.minf.stbl.boxes.indexOf(i);-1!=i&&(e.mdia.minf.stbl.boxes[i]=null)}},ISOFile.initSampleGroups=function(t,e,i,r,s){var a,n,o,h;function d(t,e,i){this.grouping_type=t,this.grouping_type_parameter=e,this.sbgp=i,this.last_sample_in_run=-1,this.entry_index=-1}for(e&&(e.sample_groups_info=[]),t.sample_groups_info||(t.sample_groups_info=[]),n=0;n<i.length;n++){for(h=i[n].grouping_type+"/"+i[n].grouping_type_parameter,o=new d(i[n].grouping_type,i[n].grouping_type_parameter,i[n]),e&&(e.sample_groups_info[h]=o),t.sample_groups_info[h]||(t.sample_groups_info[h]=o),a=0;a<r.length;a++)r[a].grouping_type===i[n].grouping_type&&(o.description=r[a],o.description.used=!0);if(s)for(a=0;a<s.length;a++)s[a].grouping_type===i[n].grouping_type&&(o.fragment_description=s[a],o.fragment_description.used=!0,o.is_fragment=!0)}if(e){if(s)for(n=0;n<s.length;n++)!s[n].used&&2<=s[n].version&&(h=s[n].grouping_type+"/0",(o=new d(s[n].grouping_type,0)).is_fragment=!0,e.sample_groups_info[h]||(e.sample_groups_info[h]=o))}else for(n=0;n<r.length;n++)!r[n].used&&2<=r[n].version&&(h=r[n].grouping_type+"/0",o=new d(r[n].grouping_type,0),t.sample_groups_info[h]||(t.sample_groups_info[h]=o))},ISOFile.setSampleGroupProperties=function(t,e,i,r){var s,a,n;for(s in e.sample_groups=[],r)e.sample_groups[s]={},e.sample_groups[s].grouping_type=r[s].grouping_type,e.sample_groups[s].grouping_type_parameter=r[s].grouping_type_parameter,i>=r[s].last_sample_in_run&&(r[s].last_sample_in_run<0&&(r[s].last_sample_in_run=0),r[s].entry_index++,r[s].entry_index<=r[s].sbgp.entries.length-1&&(r[s].last_sample_in_run+=r[s].sbgp.entries[r[s].entry_index].sample_count)),r[s].entry_index<=r[s].sbgp.entries.length-1?e.sample_groups[s].group_description_index=r[s].sbgp.entries[r[s].entry_index].group_description_index:e.sample_groups[s].group_description_index=-1,0!==e.sample_groups[s].group_description_index&&(n=r[s].fragment_description||r[s].description,0<e.sample_groups[s].group_description_index?(a=65535<e.sample_groups[s].group_description_index?(e.sample_groups[s].group_description_index>>16)-1:e.sample_groups[s].group_description_index-1,n&&0<=a&&(e.sample_groups[s].description=n.entries[a])):n&&2<=n.version&&0<n.default_group_description_index&&(e.sample_groups[s].description=n.entries[n.default_group_description_index-1]))},ISOFile.process_sdtp=function(t,e,i){e&&(t?(e.is_leading=t.is_leading[i],e.depends_on=t.sample_depends_on[i],e.is_depended_on=t.sample_is_depended_on[i],e.has_redundancy=t.sample_has_redundancy[i]):(e.is_leading=0,e.depends_on=0,e.is_depended_on=0,e.has_redundancy=0))},ISOFile.prototype.buildSampleLists=function(){for(var t,e=0;e<this.moov.traks.length;e++)t=this.moov.traks[e],this.buildTrakSampleLists(t)},ISOFile.prototype.buildTrakSampleLists=function(t){var e,i,r,s,a,n,o,h,d,l,p,f,u,_,c,m,x,g,y,B,S,P,U,b;if(t.samples=[],t.samples_duration=0,t.samples_size=0,i=t.mdia.minf.stbl.stco||t.mdia.minf.stbl.co64,r=t.mdia.minf.stbl.stsc,s=t.mdia.minf.stbl.stsz||t.mdia.minf.stbl.stz2,a=t.mdia.minf.stbl.stts,n=t.mdia.minf.stbl.ctts,o=t.mdia.minf.stbl.stss,h=t.mdia.minf.stbl.stsd,d=t.mdia.minf.stbl.subs,f=t.mdia.minf.stbl.stdp,l=t.mdia.minf.stbl.sbgps,p=t.mdia.minf.stbl.sgpds,S=B=y=g=-1,b=U=P=0,ISOFile.initSampleGroups(t,null,l,p),void 0!==s){for(e=0;e<s.sample_sizes.length;e++){var v={};v.number=e,v.track_id=t.tkhd.track_id,v.timescale=t.mdia.mdhd.timescale,v.alreadyRead=0,(t.samples[e]=v).size=s.sample_sizes[e],t.samples_size+=v.size,0===e?(_=1,u=0,v.chunk_index=_,v.chunk_run_index=u,x=r.samples_per_chunk[u],m=0,c=u+1<r.first_chunk.length?r.first_chunk[u+1]-1:1/0):e<x?(v.chunk_index=_,v.chunk_run_index=u):(_++,m=0,(v.chunk_index=_)<=c||(c=++u+1<r.first_chunk.length?r.first_chunk[u+1]-1:1/0),v.chunk_run_index=u,x+=r.samples_per_chunk[u]),v.description_index=r.sample_description_index[v.chunk_run_index]-1,v.description=h.entries[v.description_index],v.offset=i.chunk_offsets[v.chunk_index-1]+m,m+=v.size,g<e&&(y++,g<0&&(g=0),g+=a.sample_counts[y]),0<e?(t.samples[e-1].duration=a.sample_deltas[y],t.samples_duration+=t.samples[e-1].duration,v.dts=t.samples[e-1].dts+t.samples[e-1].duration):v.dts=0,n?(B<=e&&(S++,B<0&&(B=0),B+=n.sample_counts[S]),v.cts=t.samples[e].dts+n.sample_offsets[S]):v.cts=v.dts,o?(e==o.sample_numbers[P]-1?(v.is_sync=!0,P++):(v.is_sync=!1,v.degradation_priority=0),d&&d.entries[U].sample_delta+b==e+1&&(v.subsamples=d.entries[U].subsamples,b+=d.entries[U].sample_delta,U++)):v.is_sync=!0,ISOFile.process_sdtp(t.mdia.minf.stbl.sdtp,v,v.number),v.degradation_priority=f?f.priority[e]:0,d&&d.entries[U].sample_delta+b==e&&(v.subsamples=d.entries[U].subsamples,b+=d.entries[U].sample_delta),(0<l.length||0<p.length)&&ISOFile.setSampleGroupProperties(t,v,e,t.sample_groups_info)}0<e&&(t.samples[e-1].duration=Math.max(t.mdia.mdhd.duration-t.samples[e-1].dts,0),t.samples_duration+=t.samples[e-1].duration)}},ISOFile.prototype.updateSampleLists=function(){var t,e,i,r,s,a,n,o,h,d,l,p;if(void 0!==this.moov)for(;this.lastMoofIndex<this.moofs.length;)if(n=this.moofs[this.lastMoofIndex],this.lastMoofIndex++,"moof"==n.type)for(o=n,t=0;t<o.trafs.length;t++){for(h=o.trafs[t],d=this.getTrackById(h.tfhd.track_id),l=this.getTrexById(h.tfhd.track_id),e=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC?h.tfhd.default_sample_description_index:l?l.default_sample_description_index:1,i=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR?h.tfhd.default_sample_duration:l?l.default_sample_duration:0,r=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE?h.tfhd.default_sample_size:l?l.default_sample_size:0,s=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS?h.tfhd.default_sample_flags:l?l.default_sample_flags:0,(h.sample_number=0)<h.sbgps.length&&ISOFile.initSampleGroups(d,h,h.sbgps,d.mdia.minf.stbl.sgpds,h.sgpds),y=0;y<h.truns.length;y++)for(var f=h.truns[y],u=0;u<f.sample_count;u++){(p={}).moof_number=this.lastMoofIndex,p.number_in_traf=h.sample_number,h.sample_number++,p.number=d.samples.length,h.first_sample_index=d.samples.length,d.samples.push(p),p.track_id=d.tkhd.track_id,p.timescale=d.mdia.mdhd.timescale,p.description_index=e-1,p.description=d.mdia.minf.stbl.stsd.entries[p.description_index],p.size=r,f.flags&BoxParser.TRUN_FLAGS_SIZE&&(p.size=f.sample_size[u]),d.samples_size+=p.size,p.duration=i,f.flags&BoxParser.TRUN_FLAGS_DURATION&&(p.duration=f.sample_duration[u]),d.samples_duration+=p.duration,d.first_traf_merged||0<u?p.dts=d.samples[d.samples.length-2].dts+d.samples[d.samples.length-2].duration:(h.tfdt?p.dts=h.tfdt.baseMediaDecodeTime:p.dts=0,d.first_traf_merged=!0),p.cts=p.dts,f.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(p.cts=p.dts+f.sample_composition_time_offset[u]),x=s,f.flags&BoxParser.TRUN_FLAGS_FLAGS?x=f.sample_flags[u]:0===u&&f.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&(x=f.first_sample_flags),p.is_sync=!(x>>16&1),p.is_leading=x>>26&3,p.depends_on=x>>24&3,p.is_depended_on=x>>22&3,p.has_redundancy=x>>20&3,p.degradation_priority=65535&x;var _=!!(h.tfhd.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET),c=!!(h.tfhd.flags&BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF),m=!!(f.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET),x=0,x=_?h.tfhd.base_data_offset:c||0===y?o.start:a;p.offset=0===y&&0===u?m?x+f.data_offset:x:a,a=p.offset+p.size,(0<h.sbgps.length||0<h.sgpds.length||0<d.mdia.minf.stbl.sbgps.length||0<d.mdia.minf.stbl.sgpds.length)&&ISOFile.setSampleGroupProperties(d,p,p.number_in_traf,h.sample_groups_info)}if(h.subs){d.has_fragment_subsamples=!0;for(var g=h.first_sample_index,y=0;y<h.subs.entries.length;y++)g+=h.subs.entries[y].sample_delta,(p=d.samples[g-1]).subsamples=h.subs.entries[y].subsamples}}},ISOFile.prototype.getSample=function(t,e){var i,r=t.samples[e];if(!this.moov)return null;if(r.data){if(r.alreadyRead==r.size)return r}else r.data=new Uint8Array(r.size),r.alreadyRead=0,this.samplesDataSize+=r.size,Log.debug("ISOFile","Allocating sample #"+e+" on track #"+t.tkhd.track_id+" of size "+r.size+" (total: "+this.samplesDataSize+")");for(;;){var s=this.stream.findPosition(!0,r.offset+r.alreadyRead,!1);if(!(-1<s))return null;s=(i=this.stream.buffers[s]).byteLength-(r.offset+r.alreadyRead-i.fileStart);if(r.size-r.alreadyRead<=s)return Log.debug("ISOFile","Getting sample #"+e+" data (alreadyRead: "+r.alreadyRead+" offset: "+(r.offset+r.alreadyRead-i.fileStart)+" read size: "+(r.size-r.alreadyRead)+" full size: "+r.size+")"),DataStream.memcpy(r.data.buffer,r.alreadyRead,i,r.offset+r.alreadyRead-i.fileStart,r.size-r.alreadyRead),i.usedBytes+=r.size-r.alreadyRead,this.stream.logBufferLevel(),r.alreadyRead=r.size,r;if(0==s)return null;Log.debug("ISOFile","Getting sample #"+e+" partial data (alreadyRead: "+r.alreadyRead+" offset: "+(r.offset+r.alreadyRead-i.fileStart)+" read size: "+s+" full size: "+r.size+")"),DataStream.memcpy(r.data.buffer,r.alreadyRead,i,r.offset+r.alreadyRead-i.fileStart,s),r.alreadyRead+=s,i.usedBytes+=s,this.stream.logBufferLevel()}},ISOFile.prototype.releaseSample=function(t,e){e=t.samples[e];return e.data?(this.samplesDataSize-=e.size,e.data=null,e.alreadyRead=0,e.size):0},ISOFile.prototype.getAllocatedSampleDataSize=function(){return this.samplesDataSize},ISOFile.prototype.getCodecs=function(){for(var t="",e=0;e<this.moov.traks.length;e++)0<e&&(t+=","),t+=this.moov.traks[e].mdia.minf.stbl.stsd.entries[0].getCodec();return t},ISOFile.prototype.getTrexById=function(t){var e;if(!this.moov||!this.moov.mvex)return null;for(e=0;e<this.moov.mvex.trexs.length;e++){var i=this.moov.mvex.trexs[e];if(i.track_id==t)return i}return null},ISOFile.prototype.getTrackById=function(t){if(void 0===this.moov)return null;for(var e=0;e<this.moov.traks.length;e++){var i=this.moov.traks[e];if(i.tkhd.track_id==t)return i}return null},ISOFile.prototype.itemsDataSize=0,ISOFile.prototype.flattenItemInfo=function(){var t=this.items,e=this.entity_groups,i=this.meta;if(null!=i&&void 0!==i.hdlr&&void 0!==i.iinf){for(d=0;d<i.iinf.item_infos.length;d++)(s={}).id=i.iinf.item_infos[d].item_ID,(t[s.id]=s).ref_to=[],s.name=i.iinf.item_infos[d].item_name,0<i.iinf.item_infos[d].protection_index&&(s.protection=i.ipro.protections[i.iinf.item_infos[d].protection_index-1]),i.iinf.item_infos[d].item_type?s.type=i.iinf.item_infos[d].item_type:s.type="mime",s.content_type=i.iinf.item_infos[d].content_type,s.content_encoding=i.iinf.item_infos[d].content_encoding,s.item_uri_type=i.iinf.item_infos[d].item_uri_type;if(i.grpl)for(d=0;d<i.grpl.boxes.length;d++)entity_group={},entity_group.id=i.grpl.boxes[d].group_id,entity_group.entity_ids=i.grpl.boxes[d].entity_ids,entity_group.type=i.grpl.boxes[d].type,e[entity_group.id]=entity_group;if(i.iloc)for(d=0;d<i.iloc.items.length;d++){var r=i.iloc.items[d],s=t[r.item_ID];switch(0!==r.data_reference_index&&(Log.warn("Item storage with reference to other files: not supported"),s.source=i.dinf.boxes[r.data_reference_index-1]),r.construction_method){case 0:case 1:break;case 2:Log.warn("Item storage with construction_method : not supported")}for(s.extents=[],n=s.size=0;n<r.extents.length;n++)s.extents[n]={},s.extents[n].offset=r.extents[n].extent_offset+r.base_offset,1==r.construction_method&&(s.extents[n].offset+=i.idat.start+i.idat.hdr_size),s.extents[n].length=r.extents[n].extent_length,s.extents[n].alreadyRead=0,s.size+=s.extents[n].length}if(i.pitm&&(t[i.pitm.item_id].primary=!0),i.iref)for(d=0;d<i.iref.references.length;d++)for(var a=i.iref.references[d],n=0;n<a.references.length;n++)t[a.from_item_ID].ref_to.push({type:a.type,id:a.references[n]});if(i.iprp)for(var o=0;o<i.iprp.ipmas.length;o++)for(var h=i.iprp.ipmas[o],d=0;d<h.associations.length;d++){var l=h.associations[d];if(s=(s=t[l.id])||e[l.id])for(void 0===s.properties&&(s.properties={},s.properties.boxes=[]),n=0;n<l.props.length;n++){var p=l.props[n];0<p.property_index&&p.property_index-1<i.iprp.ipco.boxes.length&&(p=i.iprp.ipco.boxes[p.property_index-1],s.properties[p.type]=p,s.properties.boxes.push(p))}}}},ISOFile.prototype.getItem=function(t){var e,i;if(!this.meta)return null;if(!(i=this.items[t]).data&&i.size)i.data=new Uint8Array(i.size),i.alreadyRead=0,this.itemsDataSize+=i.size,Log.debug("ISOFile","Allocating item #"+t+" of size "+i.size+" (total: "+this.itemsDataSize+")");else if(i.alreadyRead===i.size)return i;for(var r=0;r<i.extents.length;r++){var s=i.extents[r];if(s.alreadyRead!==s.length){var a=this.stream.findPosition(!0,s.offset+s.alreadyRead,!1);if(!(-1<a))return null;a=(e=this.stream.buffers[a]).byteLength-(s.offset+s.alreadyRead-e.fileStart);if(!(s.length-s.alreadyRead<=a))return Log.debug("ISOFile","Getting item #"+t+" extent #"+r+" partial data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-e.fileStart)+" read size: "+a+" full extent size: "+s.length+" full item size: "+i.size+")"),DataStream.memcpy(i.data.buffer,i.alreadyRead,e,s.offset+s.alreadyRead-e.fileStart,a),s.alreadyRead+=a,i.alreadyRead+=a,e.usedBytes+=a,this.stream.logBufferLevel(),null;Log.debug("ISOFile","Getting item #"+t+" extent #"+r+" data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-e.fileStart)+" read size: "+(s.length-s.alreadyRead)+" full extent size: "+s.length+" full item size: "+i.size+")"),DataStream.memcpy(i.data.buffer,i.alreadyRead,e,s.offset+s.alreadyRead-e.fileStart,s.length-s.alreadyRead),e.usedBytes+=s.length-s.alreadyRead,this.stream.logBufferLevel(),i.alreadyRead+=s.length-s.alreadyRead,s.alreadyRead=s.length}}return i.alreadyRead===i.size?i:null},ISOFile.prototype.releaseItem=function(t){var e=this.items[t];if(e.data){this.itemsDataSize-=e.size,e.data=null;for(var i=e.alreadyRead=0;i<e.extents.length;i++)e.extents[i].alreadyRead=0;return e.size}return 0},ISOFile.prototype.processItems=function(t){for(var e in this.items){var i=this.items[e];this.getItem(i.id),t&&!i.sent&&(t(i),i.sent=!0,i.data=null)}},ISOFile.prototype.hasItem=function(t){for(var e in this.items){var i=this.items[e];if(i.name===t)return i.id}return-1},ISOFile.prototype.getMetaHandler=function(){return this.meta?this.meta.hdlr.handler:null},ISOFile.prototype.getPrimaryItem=function(){return this.meta&&this.meta.pitm?this.getItem(this.meta.pitm.item_id):null},ISOFile.prototype.itemToFragmentedTrackFile=function(t){var e=t||{},i=null;if(null==(i=e.itemId?this.getItem(e.itemId):this.getPrimaryItem()))return null;t=new ISOFile;t.discardMdatData=!1;e={type:i.type,description_boxes:i.properties.boxes};i.properties.ispe&&(e.width=i.properties.ispe.image_width,e.height=i.properties.ispe.image_height);e=t.addTrack(e);return e?(t.addSample(e,i.data),t):null},ISOFile.prototype.write=function(t){for(var e=0;e<this.boxes.length;e++)this.boxes[e].write(t)},ISOFile.prototype.createFragment=function(t,e,i){var r=this.getTrackById(t),t=this.getSample(r,e);if(null==t)return this.setNextSeekPositionFromSample(r.samples[e]),null;e=i||new DataStream;e.endianness=DataStream.BIG_ENDIAN;i=this.createSingleSampleMoof(t);i.write(e),i.trafs[0].truns[0].data_offset=i.size+8,Log.debug("MP4Box","Adjusting data_offset with new value "+i.trafs[0].truns[0].data_offset),e.adjustUint32(i.trafs[0].truns[0].data_offset_position,i.trafs[0].truns[0].data_offset);i=new BoxParser.mdatBox;return i.data=t.data,i.write(e),e},ISOFile.writeInitializationSegment=function(t,e,i,r){var s;Log.debug("ISOFile","Generating initialization segment");var a=new DataStream;a.endianness=DataStream.BIG_ENDIAN,t.write(a);var n=e.add("mvex");for(i&&n.add("mehd").set("fragment_duration",i),s=0;s<e.traks.length;s++)n.add("trex").set("track_id",e.traks[s].tkhd.track_id).set("default_sample_description_index",1).set("default_sample_duration",r).set("default_sample_size",0).set("default_sample_flags",65536);return e.write(a),a.buffer},ISOFile.prototype.save=function(t){var e=new DataStream;e.endianness=DataStream.BIG_ENDIAN,this.write(e),e.save(t)},ISOFile.prototype.getBuffer=function(){var t=new DataStream;return t.endianness=DataStream.BIG_ENDIAN,this.write(t),t.buffer},ISOFile.prototype.initializeSegmentation=function(){var t,e,i,r;for(null===this.onSegment&&Log.warn("MP4Box","No segmentation callback set!"),this.isFragmentationInitialized||(this.isFragmentationInitialized=!0,this.nextMoofNumber=0,this.resetTables()),e=[],t=0;t<this.fragmentedTracks.length;t++){var s=new BoxParser.moovBox;s.mvhd=this.moov.mvhd,s.boxes.push(s.mvhd),i=this.getTrackById(this.fragmentedTracks[t].id),s.boxes.push(i),s.traks.push(i),(r={}).id=i.tkhd.track_id,r.user=this.fragmentedTracks[t].user,r.buffer=ISOFile.writeInitializationSegment(this.ftyp,s,this.moov.mvex&&this.moov.mvex.mehd?this.moov.mvex.mehd.fragment_duration:void 0,0<this.moov.traks[t].samples.length?this.moov.traks[t].samples[0].duration:0),e.push(r)}return e},BoxParser.Box.prototype.printHeader=function(t){this.size+=8,this.size>MAX_SIZE&&(this.size+=8),"uuid"===this.type&&(this.size+=16),t.log(t.indent+"size:"+this.size),t.log(t.indent+"type:"+this.type)},BoxParser.FullBox.prototype.printHeader=function(t){this.size+=4,BoxParser.Box.prototype.printHeader.call(this,t),t.log(t.indent+"version:"+this.version),t.log(t.indent+"flags:"+this.flags)},BoxParser.Box.prototype.print=function(t){this.printHeader(t)},BoxParser.ContainerBox.prototype.print=function(t){this.printHeader(t);for(var e,i=0;i<this.boxes.length;i++)this.boxes[i]&&(e=t.indent,t.indent+=" ",this.boxes[i].print(t),t.indent=e)},ISOFile.prototype.print=function(t){t.indent="";for(var e=0;e<this.boxes.length;e++)this.boxes[e]&&this.boxes[e].print(t)},BoxParser.mvhdBox.prototype.print=function(t){BoxParser.FullBox.prototype.printHeader.call(this,t),t.log(t.indent+"creation_time: "+this.creation_time),t.log(t.indent+"modification_time: "+this.modification_time),t.log(t.indent+"timescale: "+this.timescale),t.log(t.indent+"duration: "+this.duration),t.log(t.indent+"rate: "+this.rate),t.log(t.indent+"volume: "+(this.volume>>8)),t.log(t.indent+"matrix: "+this.matrix.join(", ")),t.log(t.indent+"next_track_id: "+this.next_track_id)},BoxParser.tkhdBox.prototype.print=function(t){BoxParser.FullBox.prototype.printHeader.call(this,t),t.log(t.indent+"creation_time: "+this.creation_time),t.log(t.indent+"modification_time: "+this.modification_time),t.log(t.indent+"track_id: "+this.track_id),t.log(t.indent+"duration: "+this.duration),t.log(t.indent+"volume: "+(this.volume>>8)),t.log(t.indent+"matrix: "+this.matrix.join(", ")),t.log(t.indent+"layer: "+this.layer),t.log(t.indent+"alternate_group: "+this.alternate_group),t.log(t.indent+"width: "+this.width),t.log(t.indent+"height: "+this.height)};var MP4Box={createFile:function(t,e){t=void 0===t||t,e=new ISOFile(e);return e.discardMdatData=!t,e}};"undefined"!=typeof exports&&(exports.createFile=MP4Box.createFile);
//# sourceMappingURL=mp4box.all.min.js.map

/* ===== 内联第三方库：mp4-muxer 5.2.1（MIT）===== */
"use strict";
var Mp4Muxer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __accessCheck = (obj, member, msg) => {
    if (!member.has(obj))
      throw TypeError("Cannot " + msg);
  };
  var __privateGet = (obj, member, getter) => {
    __accessCheck(obj, member, "read from private field");
    return getter ? getter.call(obj) : member.get(obj);
  };
  var __privateAdd = (obj, member, value) => {
    if (member.has(obj))
      throw TypeError("Cannot add the same private member more than once");
    member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  };
  var __privateSet = (obj, member, value, setter) => {
    __accessCheck(obj, member, "write to private field");
    setter ? setter.call(obj, value) : member.set(obj, value);
    return value;
  };
  var __privateWrapper = (obj, member, setter, getter) => ({
    set _(value) {
      __privateSet(obj, member, value, setter);
    },
    get _() {
      return __privateGet(obj, member, getter);
    }
  });
  var __privateMethod = (obj, member, method) => {
    __accessCheck(obj, member, "access private method");
    return method;
  };

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    ArrayBufferTarget: () => ArrayBufferTarget,
    FileSystemWritableFileStreamTarget: () => FileSystemWritableFileStreamTarget,
    Muxer: () => Muxer,
    StreamTarget: () => StreamTarget
  });

  // src/misc.ts
  var bytes = new Uint8Array(8);
  var view = new DataView(bytes.buffer);
  var u8 = (value) => {
    return [(value % 256 + 256) % 256];
  };
  var u16 = (value) => {
    view.setUint16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var i16 = (value) => {
    view.setInt16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var u24 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[1], bytes[2], bytes[3]];
  };
  var u32 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var i32 = (value) => {
    view.setInt32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var u64 = (value) => {
    view.setUint32(0, Math.floor(value / 2 ** 32), false);
    view.setUint32(4, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
  };
  var fixed_8_8 = (value) => {
    view.setInt16(0, 2 ** 8 * value, false);
    return [bytes[0], bytes[1]];
  };
  var fixed_16_16 = (value) => {
    view.setInt32(0, 2 ** 16 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var fixed_2_30 = (value) => {
    view.setInt32(0, 2 ** 30 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var ascii = (text, nullTerminated = false) => {
    let bytes2 = Array(text.length).fill(null).map((_, i) => text.charCodeAt(i));
    if (nullTerminated)
      bytes2.push(0);
    return bytes2;
  };
  var last = (arr) => {
    return arr && arr[arr.length - 1];
  };
  var lastPresentedSample = (samples) => {
    let result = void 0;
    for (let sample of samples) {
      if (!result || sample.presentationTimestamp > result.presentationTimestamp) {
        result = sample;
      }
    }
    return result;
  };
  var intoTimescale = (timeInSeconds, timescale, round = true) => {
    let value = timeInSeconds * timescale;
    return round ? Math.round(value) : value;
  };
  var rotationMatrix = (rotationInDegrees) => {
    let theta = rotationInDegrees * (Math.PI / 180);
    let cosTheta = Math.cos(theta);
    let sinTheta = Math.sin(theta);
    return [
      cosTheta,
      sinTheta,
      0,
      -sinTheta,
      cosTheta,
      0,
      0,
      0,
      1
    ];
  };
  var IDENTITY_MATRIX = rotationMatrix(0);
  var matrixToBytes = (matrix) => {
    return [
      fixed_16_16(matrix[0]),
      fixed_16_16(matrix[1]),
      fixed_2_30(matrix[2]),
      fixed_16_16(matrix[3]),
      fixed_16_16(matrix[4]),
      fixed_2_30(matrix[5]),
      fixed_16_16(matrix[6]),
      fixed_16_16(matrix[7]),
      fixed_2_30(matrix[8])
    ];
  };
  var deepClone = (x) => {
    if (!x)
      return x;
    if (typeof x !== "object")
      return x;
    if (Array.isArray(x))
      return x.map(deepClone);
    return Object.fromEntries(Object.entries(x).map(([key, value]) => [key, deepClone(value)]));
  };
  var isU32 = (value) => {
    return value >= 0 && value < 2 ** 32;
  };

  // src/box.ts
  var box = (type, contents, children) => ({
    type,
    contents: contents && new Uint8Array(contents.flat(10)),
    children
  });
  var fullBox = (type, version, flags, contents, children) => box(
    type,
    [u8(version), u24(flags), contents ?? []],
    children
  );
  var ftyp = (details) => {
    let minorVersion = 512;
    if (details.fragmented)
      return box("ftyp", [
        ascii("iso5"),
        // Major brand
        u32(minorVersion),
        // Minor version
        // Compatible brands
        ascii("iso5"),
        ascii("iso6"),
        ascii("mp41")
      ]);
    return box("ftyp", [
      ascii("isom"),
      // Major brand
      u32(minorVersion),
      // Minor version
      // Compatible brands
      ascii("isom"),
      details.holdsAvc ? ascii("avc1") : [],
      ascii("mp41")
    ]);
  };
  var mdat = (reserveLargeSize) => ({ type: "mdat", largeSize: reserveLargeSize });
  var free = (size) => ({ type: "free", size });
  var moov = (tracks, creationTime, fragmented = false) => box("moov", null, [
    mvhd(creationTime, tracks),
    ...tracks.map((x) => trak(x, creationTime)),
    fragmented ? mvex(tracks) : null
  ]);
  var mvhd = (creationTime, tracks) => {
    let duration = intoTimescale(Math.max(
      0,
      ...tracks.filter((x) => x.samples.length > 0).map((x) => {
        const lastSample = lastPresentedSample(x.samples);
        return lastSample.presentationTimestamp + lastSample.duration;
      })
    ), GLOBAL_TIMESCALE);
    let nextTrackId = Math.max(...tracks.map((x) => x.id)) + 1;
    let needsU64 = !isU32(creationTime) || !isU32(duration);
    let u32OrU64 = needsU64 ? u64 : u32;
    return fullBox("mvhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(GLOBAL_TIMESCALE),
      // Timescale
      u32OrU64(duration),
      // Duration
      fixed_16_16(1),
      // Preferred rate
      fixed_8_8(1),
      // Preferred volume
      Array(10).fill(0),
      // Reserved
      matrixToBytes(IDENTITY_MATRIX),
      // Matrix
      Array(24).fill(0),
      // Pre-defined
      u32(nextTrackId)
      // Next track ID
    ]);
  };
  var trak = (track, creationTime) => box("trak", null, [
    tkhd(track, creationTime),
    mdia(track, creationTime)
  ]);
  var tkhd = (track, creationTime) => {
    let lastSample = lastPresentedSample(track.samples);
    let durationInGlobalTimescale = intoTimescale(
      lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
      GLOBAL_TIMESCALE
    );
    let needsU64 = !isU32(creationTime) || !isU32(durationInGlobalTimescale);
    let u32OrU64 = needsU64 ? u64 : u32;
    let matrix;
    if (track.info.type === "video") {
      matrix = typeof track.info.rotation === "number" ? rotationMatrix(track.info.rotation) : track.info.rotation;
    } else {
      matrix = IDENTITY_MATRIX;
    }
    return fullBox("tkhd", +needsU64, 3, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(track.id),
      // Track ID
      u32(0),
      // Reserved
      u32OrU64(durationInGlobalTimescale),
      // Duration
      Array(8).fill(0),
      // Reserved
      u16(0),
      // Layer
      u16(0),
      // Alternate group
      fixed_8_8(track.info.type === "audio" ? 1 : 0),
      // Volume
      u16(0),
      // Reserved
      matrixToBytes(matrix),
      // Matrix
      fixed_16_16(track.info.type === "video" ? track.info.width : 0),
      // Track width
      fixed_16_16(track.info.type === "video" ? track.info.height : 0)
      // Track height
    ]);
  };
  var mdia = (track, creationTime) => box("mdia", null, [
    mdhd(track, creationTime),
    hdlr(track.info.type === "video" ? "vide" : "soun"),
    minf(track)
  ]);
  var mdhd = (track, creationTime) => {
    let lastSample = lastPresentedSample(track.samples);
    let localDuration = intoTimescale(
      lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
      track.timescale
    );
    let needsU64 = !isU32(creationTime) || !isU32(localDuration);
    let u32OrU64 = needsU64 ? u64 : u32;
    return fullBox("mdhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(track.timescale),
      // Timescale
      u32OrU64(localDuration),
      // Duration
      u16(21956),
      // Language ("und", undetermined)
      u16(0)
      // Quality
    ]);
  };
  var hdlr = (componentSubtype) => fullBox("hdlr", 0, 0, [
    ascii("mhlr"),
    // Component type
    ascii(componentSubtype),
    // Component subtype
    u32(0),
    // Component manufacturer
    u32(0),
    // Component flags
    u32(0),
    // Component flags mask
    ascii("mp4-muxer-hdlr", true)
    // Component name
  ]);
  var minf = (track) => box("minf", null, [
    track.info.type === "video" ? vmhd() : smhd(),
    dinf(),
    stbl(track)
  ]);
  var vmhd = () => fullBox("vmhd", 0, 1, [
    u16(0),
    // Graphics mode
    u16(0),
    // Opcolor R
    u16(0),
    // Opcolor G
    u16(0)
    // Opcolor B
  ]);
  var smhd = () => fullBox("smhd", 0, 0, [
    u16(0),
    // Balance
    u16(0)
    // Reserved
  ]);
  var dinf = () => box("dinf", null, [
    dref()
  ]);
  var dref = () => fullBox("dref", 0, 0, [
    u32(1)
    // Entry count
  ], [
    url()
  ]);
  var url = () => fullBox("url ", 0, 1);
  var stbl = (track) => {
    const needsCtts = track.compositionTimeOffsetTable.length > 1 || track.compositionTimeOffsetTable.some((x) => x.sampleCompositionTimeOffset !== 0);
    return box("stbl", null, [
      stsd(track),
      stts(track),
      stss(track),
      stsc(track),
      stsz(track),
      stco(track),
      needsCtts ? ctts(track) : null
    ]);
  };
  var stsd = (track) => fullBox("stsd", 0, 0, [
    u32(1)
    // Entry count
  ], [
    track.info.type === "video" ? videoSampleDescription(
      VIDEO_CODEC_TO_BOX_NAME[track.info.codec],
      track
    ) : soundSampleDescription(
      AUDIO_CODEC_TO_BOX_NAME[track.info.codec],
      track
    )
  ]);
  var videoSampleDescription = (compressionType, track) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1),
    // Data reference index
    u16(0),
    // Pre-defined
    u16(0),
    // Reserved
    Array(12).fill(0),
    // Pre-defined
    u16(track.info.width),
    // Width
    u16(track.info.height),
    // Height
    u32(4718592),
    // Horizontal resolution
    u32(4718592),
    // Vertical resolution
    u32(0),
    // Reserved
    u16(1),
    // Frame count
    Array(32).fill(0),
    // Compressor name
    u16(24),
    // Depth
    i16(65535)
    // Pre-defined
  ], [
    VIDEO_CODEC_TO_CONFIGURATION_BOX[track.info.codec](track),
    track.info.decoderConfig.colorSpace ? colr(track) : null
  ]);
  var COLOR_PRIMARIES_MAP = {
    "bt709": 1,
    // ITU-R BT.709
    "bt470bg": 5,
    // ITU-R BT.470BG
    "smpte170m": 6
    // ITU-R BT.601 525 - SMPTE 170M
  };
  var TRANSFER_CHARACTERISTICS_MAP = {
    "bt709": 1,
    // ITU-R BT.709
    "smpte170m": 6,
    // SMPTE 170M
    "iec61966-2-1": 13
    // IEC 61966-2-1
  };
  var MATRIX_COEFFICIENTS_MAP = {
    "rgb": 0,
    // Identity
    "bt709": 1,
    // ITU-R BT.709
    "bt470bg": 5,
    // ITU-R BT.470BG
    "smpte170m": 6
    // SMPTE 170M
  };
  var colr = (track) => box("colr", [
    ascii("nclx"),
    // Colour type
    u16(COLOR_PRIMARIES_MAP[track.info.decoderConfig.colorSpace.primaries]),
    // Colour primaries
    u16(TRANSFER_CHARACTERISTICS_MAP[track.info.decoderConfig.colorSpace.transfer]),
    // Transfer characteristics
    u16(MATRIX_COEFFICIENTS_MAP[track.info.decoderConfig.colorSpace.matrix]),
    // Matrix coefficients
    u8((track.info.decoderConfig.colorSpace.fullRange ? 1 : 0) << 7)
    // Full range flag
  ]);
  var avcC = (track) => track.info.decoderConfig && box("avcC", [
    // For AVC, description is an AVCDecoderConfigurationRecord, so nothing else to do here
    ...new Uint8Array(track.info.decoderConfig.description)
  ]);
  var hvcC = (track) => track.info.decoderConfig && box("hvcC", [
    // For HEVC, description is a HEVCDecoderConfigurationRecord, so nothing else to do here
    ...new Uint8Array(track.info.decoderConfig.description)
  ]);
  var vpcC = (track) => {
    if (!track.info.decoderConfig) {
      return null;
    }
    let decoderConfig = track.info.decoderConfig;
    if (!decoderConfig.colorSpace) {
      throw new Error(`'colorSpace' is required in the decoder config for VP9.`);
    }
    let parts = decoderConfig.codec.split(".");
    let profile = Number(parts[1]);
    let level = Number(parts[2]);
    let bitDepth = Number(parts[3]);
    let chromaSubsampling = 0;
    let thirdByte = (bitDepth << 4) + (chromaSubsampling << 1) + Number(decoderConfig.colorSpace.fullRange);
    let colourPrimaries = 2;
    let transferCharacteristics = 2;
    let matrixCoefficients = 2;
    return fullBox("vpcC", 1, 0, [
      u8(profile),
      // Profile
      u8(level),
      // Level
      u8(thirdByte),
      // Bit depth, chroma subsampling, full range
      u8(colourPrimaries),
      // Colour primaries
      u8(transferCharacteristics),
      // Transfer characteristics
      u8(matrixCoefficients),
      // Matrix coefficients
      u16(0)
      // Codec initialization data size
    ]);
  };
  var av1C = () => {
    let marker = 1;
    let version = 1;
    let firstByte = (marker << 7) + version;
    return box("av1C", [
      firstByte,
      0,
      0,
      0
    ]);
  };
  var soundSampleDescription = (compressionType, track) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1),
    // Data reference index
    u16(0),
    // Version
    u16(0),
    // Revision level
    u32(0),
    // Vendor
    u16(track.info.numberOfChannels),
    // Number of channels
    u16(16),
    // Sample size (bits)
    u16(0),
    // Compression ID
    u16(0),
    // Packet size
    fixed_16_16(track.info.sampleRate)
    // Sample rate
  ], [
    AUDIO_CODEC_TO_CONFIGURATION_BOX[track.info.codec](track)
  ]);
  var esds = (track) => {
    let description = new Uint8Array(track.info.decoderConfig.description);
    return fullBox("esds", 0, 0, [
      // https://stackoverflow.com/a/54803118
      u32(58753152),
      // TAG(3) = Object Descriptor ([2])
      u8(32 + description.byteLength),
      // length of this OD (which includes the next 2 tags)
      u16(1),
      // ES_ID = 1
      u8(0),
      // flags etc = 0
      u32(75530368),
      // TAG(4) = ES Descriptor ([2]) embedded in above OD
      u8(18 + description.byteLength),
      // length of this ESD
      u8(64),
      // MPEG-4 Audio
      u8(21),
      // stream type(6bits)=5 audio, flags(2bits)=1
      u24(0),
      // 24bit buffer size
      u32(130071),
      // max bitrate
      u32(130071),
      // avg bitrate
      u32(92307584),
      // TAG(5) = ASC ([2],[3]) embedded in above OD
      u8(description.byteLength),
      // length
      ...description,
      u32(109084800),
      // TAG(6)
      u8(1),
      // length
      u8(2)
      // data
    ]);
  };
  var dOps = (track) => {
    let preskip = 3840;
    let gain = 0;
    const description = track.info.decoderConfig?.description;
    if (description) {
      if (description.byteLength < 18) {
        throw new TypeError("Invalid decoder description provided for Opus; must be at least 18 bytes long.");
      }
      const view2 = ArrayBuffer.isView(description) ? new DataView(description.buffer, description.byteOffset, description.byteLength) : new DataView(description);
      preskip = view2.getUint16(10, true);
      gain = view2.getInt16(14, true);
    }
    return box("dOps", [
      u8(0),
      // Version
      u8(track.info.numberOfChannels),
      // OutputChannelCount
      u16(preskip),
      u32(track.info.sampleRate),
      // InputSampleRate
      fixed_8_8(gain),
      // OutputGain
      u8(0)
      // ChannelMappingFamily
    ]);
  };
  var stts = (track) => {
    return fullBox("stts", 0, 0, [
      u32(track.timeToSampleTable.length),
      // Number of entries
      track.timeToSampleTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        u32(x.sampleDelta)
        // Sample duration
      ])
    ]);
  };
  var stss = (track) => {
    if (track.samples.every((x) => x.type === "key"))
      return null;
    let keySamples = [...track.samples.entries()].filter(([, sample]) => sample.type === "key");
    return fullBox("stss", 0, 0, [
      u32(keySamples.length),
      // Number of entries
      keySamples.map(([index]) => u32(index + 1))
      // Sync sample table
    ]);
  };
  var stsc = (track) => {
    return fullBox("stsc", 0, 0, [
      u32(track.compactlyCodedChunkTable.length),
      // Number of entries
      track.compactlyCodedChunkTable.map((x) => [
        // Sample-to-chunk table
        u32(x.firstChunk),
        // First chunk
        u32(x.samplesPerChunk),
        // Samples per chunk
        u32(1)
        // Sample description index
      ])
    ]);
  };
  var stsz = (track) => fullBox("stsz", 0, 0, [
    u32(0),
    // Sample size (0 means non-constant size)
    u32(track.samples.length),
    // Number of entries
    track.samples.map((x) => u32(x.size))
    // Sample size table
  ]);
  var stco = (track) => {
    if (track.finalizedChunks.length > 0 && last(track.finalizedChunks).offset >= 2 ** 32) {
      return fullBox("co64", 0, 0, [
        u32(track.finalizedChunks.length),
        // Number of entries
        track.finalizedChunks.map((x) => u64(x.offset))
        // Chunk offset table
      ]);
    }
    return fullBox("stco", 0, 0, [
      u32(track.finalizedChunks.length),
      // Number of entries
      track.finalizedChunks.map((x) => u32(x.offset))
      // Chunk offset table
    ]);
  };
  var ctts = (track) => {
    return fullBox("ctts", 0, 0, [
      u32(track.compositionTimeOffsetTable.length),
      // Number of entries
      track.compositionTimeOffsetTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        u32(x.sampleCompositionTimeOffset)
        // Sample offset
      ])
    ]);
  };
  var mvex = (tracks) => {
    return box("mvex", null, tracks.map(trex));
  };
  var trex = (track) => {
    return fullBox("trex", 0, 0, [
      u32(track.id),
      // Track ID
      u32(1),
      // Default sample description index
      u32(0),
      // Default sample duration
      u32(0),
      // Default sample size
      u32(0)
      // Default sample flags
    ]);
  };
  var moof = (sequenceNumber, tracks) => {
    return box("moof", null, [
      mfhd(sequenceNumber),
      ...tracks.map(traf)
    ]);
  };
  var mfhd = (sequenceNumber) => {
    return fullBox("mfhd", 0, 0, [
      u32(sequenceNumber)
      // Sequence number
    ]);
  };
  var fragmentSampleFlags = (sample) => {
    let byte1 = 0;
    let byte2 = 0;
    let byte3 = 0;
    let byte4 = 0;
    let sampleIsDifferenceSample = sample.type === "delta";
    byte2 |= +sampleIsDifferenceSample;
    if (sampleIsDifferenceSample) {
      byte1 |= 1;
    } else {
      byte1 |= 2;
    }
    return byte1 << 24 | byte2 << 16 | byte3 << 8 | byte4;
  };
  var traf = (track) => {
    return box("traf", null, [
      tfhd(track),
      tfdt(track),
      trun(track)
    ]);
  };
  var tfhd = (track) => {
    let tfFlags = 0;
    tfFlags |= 8;
    tfFlags |= 16;
    tfFlags |= 32;
    tfFlags |= 131072;
    let referenceSample = track.currentChunk.samples[1] ?? track.currentChunk.samples[0];
    let referenceSampleInfo = {
      duration: referenceSample.timescaleUnitsToNextSample,
      size: referenceSample.size,
      flags: fragmentSampleFlags(referenceSample)
    };
    return fullBox("tfhd", 0, tfFlags, [
      u32(track.id),
      // Track ID
      u32(referenceSampleInfo.duration),
      // Default sample duration
      u32(referenceSampleInfo.size),
      // Default sample size
      u32(referenceSampleInfo.flags)
      // Default sample flags
    ]);
  };
  var tfdt = (track) => {
    return fullBox("tfdt", 1, 0, [
      u64(intoTimescale(track.currentChunk.startTimestamp, track.timescale))
      // Base Media Decode Time
    ]);
  };
  var trun = (track) => {
    let allSampleDurations = track.currentChunk.samples.map((x) => x.timescaleUnitsToNextSample);
    let allSampleSizes = track.currentChunk.samples.map((x) => x.size);
    let allSampleFlags = track.currentChunk.samples.map(fragmentSampleFlags);
    let allSampleCompositionTimeOffsets = track.currentChunk.samples.map((x) => intoTimescale(x.presentationTimestamp - x.decodeTimestamp, track.timescale));
    let uniqueSampleDurations = new Set(allSampleDurations);
    let uniqueSampleSizes = new Set(allSampleSizes);
    let uniqueSampleFlags = new Set(allSampleFlags);
    let uniqueSampleCompositionTimeOffsets = new Set(allSampleCompositionTimeOffsets);
    let firstSampleFlagsPresent = uniqueSampleFlags.size === 2 && allSampleFlags[0] !== allSampleFlags[1];
    let sampleDurationPresent = uniqueSampleDurations.size > 1;
    let sampleSizePresent = uniqueSampleSizes.size > 1;
    let sampleFlagsPresent = !firstSampleFlagsPresent && uniqueSampleFlags.size > 1;
    let sampleCompositionTimeOffsetsPresent = uniqueSampleCompositionTimeOffsets.size > 1 || [...uniqueSampleCompositionTimeOffsets].some((x) => x !== 0);
    let flags = 0;
    flags |= 1;
    flags |= 4 * +firstSampleFlagsPresent;
    flags |= 256 * +sampleDurationPresent;
    flags |= 512 * +sampleSizePresent;
    flags |= 1024 * +sampleFlagsPresent;
    flags |= 2048 * +sampleCompositionTimeOffsetsPresent;
    return fullBox("trun", 1, flags, [
      u32(track.currentChunk.samples.length),
      // Sample count
      u32(track.currentChunk.offset - track.currentChunk.moofOffset || 0),
      // Data offset
      firstSampleFlagsPresent ? u32(allSampleFlags[0]) : [],
      track.currentChunk.samples.map((_, i) => [
        sampleDurationPresent ? u32(allSampleDurations[i]) : [],
        // Sample duration
        sampleSizePresent ? u32(allSampleSizes[i]) : [],
        // Sample size
        sampleFlagsPresent ? u32(allSampleFlags[i]) : [],
        // Sample flags
        // Sample composition time offsets
        sampleCompositionTimeOffsetsPresent ? i32(allSampleCompositionTimeOffsets[i]) : []
      ])
    ]);
  };
  var mfra = (tracks) => {
    return box("mfra", null, [
      ...tracks.map(tfra),
      mfro()
    ]);
  };
  var tfra = (track, trackIndex) => {
    let version = 1;
    return fullBox("tfra", version, 0, [
      u32(track.id),
      // Track ID
      u32(63),
      // This specifies that traf number, trun number and sample number are 32-bit ints
      u32(track.finalizedChunks.length),
      // Number of entries
      track.finalizedChunks.map((chunk) => [
        u64(intoTimescale(chunk.startTimestamp, track.timescale)),
        // Time
        u64(chunk.moofOffset),
        // moof offset
        u32(trackIndex + 1),
        // traf number
        u32(1),
        // trun number
        u32(1)
        // Sample number
      ])
    ]);
  };
  var mfro = () => {
    return fullBox("mfro", 0, 0, [
      // This value needs to be overwritten manually from the outside, where the actual size of the enclosing mfra box
      // is known
      u32(0)
      // Size
    ]);
  };
  var VIDEO_CODEC_TO_BOX_NAME = {
    "avc": "avc1",
    "hevc": "hvc1",
    "vp9": "vp09",
    "av1": "av01"
  };
  var VIDEO_CODEC_TO_CONFIGURATION_BOX = {
    "avc": avcC,
    "hevc": hvcC,
    "vp9": vpcC,
    "av1": av1C
  };
  var AUDIO_CODEC_TO_BOX_NAME = {
    "aac": "mp4a",
    "opus": "Opus"
  };
  var AUDIO_CODEC_TO_CONFIGURATION_BOX = {
    "aac": esds,
    "opus": dOps
  };

  // src/target.ts
  var isTarget = Symbol("isTarget");
  var Target = class {
  };
  isTarget;
  var ArrayBufferTarget = class extends Target {
    constructor() {
      super(...arguments);
      this.buffer = null;
    }
  };
  var StreamTarget = class extends Target {
    constructor(options) {
      super();
      this.options = options;
      if (typeof options !== "object") {
        throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");
      }
      if (options.onData) {
        if (typeof options.onData !== "function") {
          throw new TypeError("options.onData, when provided, must be a function.");
        }
        if (options.onData.length < 2) {
          throw new TypeError(
            "options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs."
          );
        }
      }
      if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
        throw new TypeError("options.chunked, when provided, must be a boolean.");
      }
      if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
        throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.");
      }
    }
  };
  var FileSystemWritableFileStreamTarget = class extends Target {
    constructor(stream, options) {
      super();
      this.stream = stream;
      this.options = options;
      if (!(stream instanceof FileSystemWritableFileStream)) {
        throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");
      }
      if (options !== void 0 && typeof options !== "object") {
        throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");
      }
      if (options) {
        if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
          throw new TypeError("options.chunkSize, when provided, must be a positive integer");
        }
      }
    }
  };

  // src/writer.ts
  var _helper, _helperView;
  var Writer = class {
    constructor() {
      this.pos = 0;
      __privateAdd(this, _helper, new Uint8Array(8));
      __privateAdd(this, _helperView, new DataView(__privateGet(this, _helper).buffer));
      /**
       * Stores the position from the start of the file to where boxes elements have been written. This is used to
       * rewrite/edit elements that were already added before, and to measure sizes of things.
       */
      this.offsets = /* @__PURE__ */ new WeakMap();
    }
    /** Sets the current position for future writes to a new one. */
    seek(newPos) {
      this.pos = newPos;
    }
    writeU32(value) {
      __privateGet(this, _helperView).setUint32(0, value, false);
      this.write(__privateGet(this, _helper).subarray(0, 4));
    }
    writeU64(value) {
      __privateGet(this, _helperView).setUint32(0, Math.floor(value / 2 ** 32), false);
      __privateGet(this, _helperView).setUint32(4, value, false);
      this.write(__privateGet(this, _helper).subarray(0, 8));
    }
    writeAscii(text) {
      for (let i = 0; i < text.length; i++) {
        __privateGet(this, _helperView).setUint8(i % 8, text.charCodeAt(i));
        if (i % 8 === 7)
          this.write(__privateGet(this, _helper));
      }
      if (text.length % 8 !== 0) {
        this.write(__privateGet(this, _helper).subarray(0, text.length % 8));
      }
    }
    writeBox(box2) {
      this.offsets.set(box2, this.pos);
      if (box2.contents && !box2.children) {
        this.writeBoxHeader(box2, box2.size ?? box2.contents.byteLength + 8);
        this.write(box2.contents);
      } else {
        let startPos = this.pos;
        this.writeBoxHeader(box2, 0);
        if (box2.contents)
          this.write(box2.contents);
        if (box2.children) {
          for (let child of box2.children)
            if (child)
              this.writeBox(child);
        }
        let endPos = this.pos;
        let size = box2.size ?? endPos - startPos;
        this.seek(startPos);
        this.writeBoxHeader(box2, size);
        this.seek(endPos);
      }
    }
    writeBoxHeader(box2, size) {
      this.writeU32(box2.largeSize ? 1 : size);
      this.writeAscii(box2.type);
      if (box2.largeSize)
        this.writeU64(size);
    }
    measureBoxHeader(box2) {
      return 8 + (box2.largeSize ? 8 : 0);
    }
    patchBox(box2) {
      let endPos = this.pos;
      this.seek(this.offsets.get(box2));
      this.writeBox(box2);
      this.seek(endPos);
    }
    measureBox(box2) {
      if (box2.contents && !box2.children) {
        let headerSize = this.measureBoxHeader(box2);
        return headerSize + box2.contents.byteLength;
      } else {
        let result = this.measureBoxHeader(box2);
        if (box2.contents)
          result += box2.contents.byteLength;
        if (box2.children) {
          for (let child of box2.children)
            if (child)
              result += this.measureBox(child);
        }
        return result;
      }
    }
  };
  _helper = new WeakMap();
  _helperView = new WeakMap();
  var _target, _buffer, _bytes, _maxPos, _ensureSize, ensureSize_fn;
  var ArrayBufferTargetWriter = class extends Writer {
    constructor(target) {
      super();
      __privateAdd(this, _ensureSize);
      __privateAdd(this, _target, void 0);
      __privateAdd(this, _buffer, new ArrayBuffer(2 ** 16));
      __privateAdd(this, _bytes, new Uint8Array(__privateGet(this, _buffer)));
      __privateAdd(this, _maxPos, 0);
      __privateSet(this, _target, target);
    }
    write(data) {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos + data.byteLength);
      __privateGet(this, _bytes).set(data, this.pos);
      this.pos += data.byteLength;
      __privateSet(this, _maxPos, Math.max(__privateGet(this, _maxPos), this.pos));
    }
    finalize() {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos);
      __privateGet(this, _target).buffer = __privateGet(this, _buffer).slice(0, Math.max(__privateGet(this, _maxPos), this.pos));
    }
  };
  _target = new WeakMap();
  _buffer = new WeakMap();
  _bytes = new WeakMap();
  _maxPos = new WeakMap();
  _ensureSize = new WeakSet();
  ensureSize_fn = function(size) {
    let newLength = __privateGet(this, _buffer).byteLength;
    while (newLength < size)
      newLength *= 2;
    if (newLength === __privateGet(this, _buffer).byteLength)
      return;
    let newBuffer = new ArrayBuffer(newLength);
    let newBytes = new Uint8Array(newBuffer);
    newBytes.set(__privateGet(this, _bytes), 0);
    __privateSet(this, _buffer, newBuffer);
    __privateSet(this, _bytes, newBytes);
  };
  var DEFAULT_CHUNK_SIZE = 2 ** 24;
  var MAX_CHUNKS_AT_ONCE = 2;
  var _target2, _sections, _chunked, _chunkSize, _chunks, _writeDataIntoChunks, writeDataIntoChunks_fn, _insertSectionIntoChunk, insertSectionIntoChunk_fn, _createChunk, createChunk_fn, _flushChunks, flushChunks_fn;
  var StreamTargetWriter = class extends Writer {
    constructor(target) {
      super();
      __privateAdd(this, _writeDataIntoChunks);
      __privateAdd(this, _insertSectionIntoChunk);
      __privateAdd(this, _createChunk);
      __privateAdd(this, _flushChunks);
      __privateAdd(this, _target2, void 0);
      __privateAdd(this, _sections, []);
      __privateAdd(this, _chunked, void 0);
      __privateAdd(this, _chunkSize, void 0);
      /**
       * The data is divided up into fixed-size chunks, whose contents are first filled in RAM and then flushed out.
       * A chunk is flushed if all of its contents have been written.
       */
      __privateAdd(this, _chunks, []);
      __privateSet(this, _target2, target);
      __privateSet(this, _chunked, target.options?.chunked ?? false);
      __privateSet(this, _chunkSize, target.options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    }
    write(data) {
      __privateGet(this, _sections).push({
        data: data.slice(),
        start: this.pos
      });
      this.pos += data.byteLength;
    }
    flush() {
      if (__privateGet(this, _sections).length === 0)
        return;
      let chunks = [];
      let sorted = [...__privateGet(this, _sections)].sort((a, b) => a.start - b.start);
      chunks.push({
        start: sorted[0].start,
        size: sorted[0].data.byteLength
      });
      for (let i = 1; i < sorted.length; i++) {
        let lastChunk = chunks[chunks.length - 1];
        let section = sorted[i];
        if (section.start <= lastChunk.start + lastChunk.size) {
          lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
        } else {
          chunks.push({
            start: section.start,
            size: section.data.byteLength
          });
        }
      }
      for (let chunk of chunks) {
        chunk.data = new Uint8Array(chunk.size);
        for (let section of __privateGet(this, _sections)) {
          if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
            chunk.data.set(section.data, section.start - chunk.start);
          }
        }
        if (__privateGet(this, _chunked)) {
          __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, chunk.data, chunk.start);
          __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
        } else {
          __privateGet(this, _target2).options.onData?.(chunk.data, chunk.start);
        }
      }
      __privateGet(this, _sections).length = 0;
    }
    finalize() {
      if (__privateGet(this, _chunked)) {
        __privateMethod(this, _flushChunks, flushChunks_fn).call(this, true);
      }
    }
  };
  _target2 = new WeakMap();
  _sections = new WeakMap();
  _chunked = new WeakMap();
  _chunkSize = new WeakMap();
  _chunks = new WeakMap();
  _writeDataIntoChunks = new WeakSet();
  writeDataIntoChunks_fn = function(data, position) {
    let chunkIndex = __privateGet(this, _chunks).findIndex((x) => x.start <= position && position < x.start + __privateGet(this, _chunkSize));
    if (chunkIndex === -1)
      chunkIndex = __privateMethod(this, _createChunk, createChunk_fn).call(this, position);
    let chunk = __privateGet(this, _chunks)[chunkIndex];
    let relativePosition = position - chunk.start;
    let toWrite = data.subarray(0, Math.min(__privateGet(this, _chunkSize) - relativePosition, data.byteLength));
    chunk.data.set(toWrite, relativePosition);
    let section = {
      start: relativePosition,
      end: relativePosition + toWrite.byteLength
    };
    __privateMethod(this, _insertSectionIntoChunk, insertSectionIntoChunk_fn).call(this, chunk, section);
    if (chunk.written[0].start === 0 && chunk.written[0].end === __privateGet(this, _chunkSize)) {
      chunk.shouldFlush = true;
    }
    if (__privateGet(this, _chunks).length > MAX_CHUNKS_AT_ONCE) {
      for (let i = 0; i < __privateGet(this, _chunks).length - 1; i++) {
        __privateGet(this, _chunks)[i].shouldFlush = true;
      }
      __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
    }
    if (toWrite.byteLength < data.byteLength) {
      __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, data.subarray(toWrite.byteLength), position + toWrite.byteLength);
    }
  };
  _insertSectionIntoChunk = new WeakSet();
  insertSectionIntoChunk_fn = function(chunk, section) {
    let low = 0;
    let high = chunk.written.length - 1;
    let index = -1;
    while (low <= high) {
      let mid = Math.floor(low + (high - low + 1) / 2);
      if (chunk.written[mid].start <= section.start) {
        low = mid + 1;
        index = mid;
      } else {
        high = mid - 1;
      }
    }
    chunk.written.splice(index + 1, 0, section);
    if (index === -1 || chunk.written[index].end < section.start)
      index++;
    while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
      chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
      chunk.written.splice(index + 1, 1);
    }
  };
  _createChunk = new WeakSet();
  createChunk_fn = function(includesPosition) {
    let start = Math.floor(includesPosition / __privateGet(this, _chunkSize)) * __privateGet(this, _chunkSize);
    let chunk = {
      start,
      data: new Uint8Array(__privateGet(this, _chunkSize)),
      written: [],
      shouldFlush: false
    };
    __privateGet(this, _chunks).push(chunk);
    __privateGet(this, _chunks).sort((a, b) => a.start - b.start);
    return __privateGet(this, _chunks).indexOf(chunk);
  };
  _flushChunks = new WeakSet();
  flushChunks_fn = function(force = false) {
    for (let i = 0; i < __privateGet(this, _chunks).length; i++) {
      let chunk = __privateGet(this, _chunks)[i];
      if (!chunk.shouldFlush && !force)
        continue;
      for (let section of chunk.written) {
        __privateGet(this, _target2).options.onData?.(
          chunk.data.subarray(section.start, section.end),
          chunk.start + section.start
        );
      }
      __privateGet(this, _chunks).splice(i--, 1);
    }
  };
  var FileSystemWritableFileStreamTargetWriter = class extends StreamTargetWriter {
    constructor(target) {
      super(new StreamTarget({
        onData: (data, position) => target.stream.write({
          type: "write",
          data,
          position
        }),
        chunked: true,
        chunkSize: target.options?.chunkSize
      }));
    }
  };

  // src/muxer.ts
  var GLOBAL_TIMESCALE = 1e3;
  var SUPPORTED_VIDEO_CODECS = ["avc", "hevc", "vp9", "av1"];
  var SUPPORTED_AUDIO_CODECS = ["aac", "opus"];
  var TIMESTAMP_OFFSET = 2082844800;
  var FIRST_TIMESTAMP_BEHAVIORS = ["strict", "offset", "cross-track-offset"];
  var _options, _writer, _ftypSize, _mdat, _videoTrack, _audioTrack, _creationTime, _finalizedChunks, _nextFragmentNumber, _videoSampleQueue, _audioSampleQueue, _finalized, _validateOptions, validateOptions_fn, _writeHeader, writeHeader_fn, _computeMoovSizeUpperBound, computeMoovSizeUpperBound_fn, _prepareTracks, prepareTracks_fn, _generateMpeg4AudioSpecificConfig, generateMpeg4AudioSpecificConfig_fn, _createSampleForTrack, createSampleForTrack_fn, _addSampleToTrack, addSampleToTrack_fn, _validateTimestamp, validateTimestamp_fn, _finalizeCurrentChunk, finalizeCurrentChunk_fn, _finalizeFragment, finalizeFragment_fn, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn, _ensureNotFinalized, ensureNotFinalized_fn;
  var Muxer = class {
    constructor(options) {
      __privateAdd(this, _validateOptions);
      __privateAdd(this, _writeHeader);
      __privateAdd(this, _computeMoovSizeUpperBound);
      __privateAdd(this, _prepareTracks);
      // https://wiki.multimedia.cx/index.php/MPEG-4_Audio
      __privateAdd(this, _generateMpeg4AudioSpecificConfig);
      __privateAdd(this, _createSampleForTrack);
      __privateAdd(this, _addSampleToTrack);
      __privateAdd(this, _validateTimestamp);
      __privateAdd(this, _finalizeCurrentChunk);
      __privateAdd(this, _finalizeFragment);
      __privateAdd(this, _maybeFlushStreamingTargetWriter);
      __privateAdd(this, _ensureNotFinalized);
      __privateAdd(this, _options, void 0);
      __privateAdd(this, _writer, void 0);
      __privateAdd(this, _ftypSize, void 0);
      __privateAdd(this, _mdat, void 0);
      __privateAdd(this, _videoTrack, null);
      __privateAdd(this, _audioTrack, null);
      __privateAdd(this, _creationTime, Math.floor(Date.now() / 1e3) + TIMESTAMP_OFFSET);
      __privateAdd(this, _finalizedChunks, []);
      // Fields for fragmented MP4:
      __privateAdd(this, _nextFragmentNumber, 1);
      __privateAdd(this, _videoSampleQueue, []);
      __privateAdd(this, _audioSampleQueue, []);
      __privateAdd(this, _finalized, false);
      __privateMethod(this, _validateOptions, validateOptions_fn).call(this, options);
      options.video = deepClone(options.video);
      options.audio = deepClone(options.audio);
      options.fastStart = deepClone(options.fastStart);
      this.target = options.target;
      __privateSet(this, _options, {
        firstTimestampBehavior: "strict",
        ...options
      });
      if (options.target instanceof ArrayBufferTarget) {
        __privateSet(this, _writer, new ArrayBufferTargetWriter(options.target));
      } else if (options.target instanceof StreamTarget) {
        __privateSet(this, _writer, new StreamTargetWriter(options.target));
      } else if (options.target instanceof FileSystemWritableFileStreamTarget) {
        __privateSet(this, _writer, new FileSystemWritableFileStreamTargetWriter(options.target));
      } else {
        throw new Error(`Invalid target: ${options.target}`);
      }
      __privateMethod(this, _prepareTracks, prepareTracks_fn).call(this);
      __privateMethod(this, _writeHeader, writeHeader_fn).call(this);
    }
    addVideoChunk(sample, meta, timestamp, compositionTimeOffset) {
      if (!(sample instanceof EncodedVideoChunk)) {
        throw new TypeError("addVideoChunk's first argument (sample) must be of type EncodedVideoChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
        throw new TypeError(
          "addVideoChunk's fourth argument (compositionTimeOffset), when provided, must be a real number."
        );
      }
      let data = new Uint8Array(sample.byteLength);
      sample.copyTo(data);
      this.addVideoChunkRaw(
        data,
        sample.type,
        timestamp ?? sample.timestamp,
        sample.duration,
        meta,
        compositionTimeOffset
      );
    }
    addVideoChunkRaw(data, type, timestamp, duration, meta, compositionTimeOffset) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("addVideoChunkRaw's fourth argument (duration) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunkRaw's fifth argument (meta), when provided, must be an object.");
      }
      if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
        throw new TypeError(
          "addVideoChunkRaw's sixth argument (compositionTimeOffset), when provided, must be a real number."
        );
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).video)
        throw new Error("No video track declared.");
      if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _videoTrack).samples.length === __privateGet(this, _options).fastStart.expectedVideoChunks) {
        throw new Error(`Cannot add more video chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedVideoChunks}).`);
      }
      let videoSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _videoTrack), data, type, timestamp, duration, meta, compositionTimeOffset);
      if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _audioTrack)) {
        while (__privateGet(this, _audioSampleQueue).length > 0 && __privateGet(this, _audioSampleQueue)[0].decodeTimestamp <= videoSample.decodeTimestamp) {
          let audioSample = __privateGet(this, _audioSampleQueue).shift();
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        }
        if (videoSample.decodeTimestamp <= __privateGet(this, _audioTrack).lastDecodeTimestamp) {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        } else {
          __privateGet(this, _videoSampleQueue).push(videoSample);
        }
      } else {
        __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
      }
    }
    addAudioChunk(sample, meta, timestamp) {
      if (!(sample instanceof EncodedAudioChunk)) {
        throw new TypeError("addAudioChunk's first argument (sample) must be of type EncodedAudioChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      let data = new Uint8Array(sample.byteLength);
      sample.copyTo(data);
      this.addAudioChunkRaw(data, sample.type, timestamp ?? sample.timestamp, sample.duration, meta);
    }
    addAudioChunkRaw(data, type, timestamp, duration, meta) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("addAudioChunkRaw's fourth argument (duration) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunkRaw's fifth argument (meta), when provided, must be an object.");
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).audio)
        throw new Error("No audio track declared.");
      if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _audioTrack).samples.length === __privateGet(this, _options).fastStart.expectedAudioChunks) {
        throw new Error(`Cannot add more audio chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedAudioChunks}).`);
      }
      let audioSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _audioTrack), data, type, timestamp, duration, meta);
      if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _videoTrack)) {
        while (__privateGet(this, _videoSampleQueue).length > 0 && __privateGet(this, _videoSampleQueue)[0].decodeTimestamp <= audioSample.decodeTimestamp) {
          let videoSample = __privateGet(this, _videoSampleQueue).shift();
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        }
        if (audioSample.decodeTimestamp <= __privateGet(this, _videoTrack).lastDecodeTimestamp) {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        } else {
          __privateGet(this, _audioSampleQueue).push(audioSample);
        }
      } else {
        __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
      }
    }
    /** Finalizes the file, making it ready for use. Must be called after all video and audio chunks have been added. */
    finalize() {
      if (__privateGet(this, _finalized)) {
        throw new Error("Cannot finalize a muxer more than once.");
      }
      if (__privateGet(this, _options).fastStart === "fragmented") {
        for (let videoSample of __privateGet(this, _videoSampleQueue))
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        for (let audioSample of __privateGet(this, _audioSampleQueue))
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this, false);
      } else {
        if (__privateGet(this, _videoTrack))
          __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _videoTrack));
        if (__privateGet(this, _audioTrack))
          __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _audioTrack));
      }
      let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter(Boolean);
      if (__privateGet(this, _options).fastStart === "in-memory") {
        let mdatSize;
        for (let i = 0; i < 2; i++) {
          let movieBox2 = moov(tracks, __privateGet(this, _creationTime));
          let movieBoxSize = __privateGet(this, _writer).measureBox(movieBox2);
          mdatSize = __privateGet(this, _writer).measureBox(__privateGet(this, _mdat));
          let currentChunkPos = __privateGet(this, _writer).pos + movieBoxSize + mdatSize;
          for (let chunk of __privateGet(this, _finalizedChunks)) {
            chunk.offset = currentChunkPos;
            for (let { data } of chunk.samples) {
              currentChunkPos += data.byteLength;
              mdatSize += data.byteLength;
            }
          }
          if (currentChunkPos < 2 ** 32)
            break;
          if (mdatSize >= 2 ** 32)
            __privateGet(this, _mdat).largeSize = true;
        }
        let movieBox = moov(tracks, __privateGet(this, _creationTime));
        __privateGet(this, _writer).writeBox(movieBox);
        __privateGet(this, _mdat).size = mdatSize;
        __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
        for (let chunk of __privateGet(this, _finalizedChunks)) {
          for (let sample of chunk.samples) {
            __privateGet(this, _writer).write(sample.data);
            sample.data = null;
          }
        }
      } else if (__privateGet(this, _options).fastStart === "fragmented") {
        let startPos = __privateGet(this, _writer).pos;
        let mfraBox = mfra(tracks);
        __privateGet(this, _writer).writeBox(mfraBox);
        let mfraBoxSize = __privateGet(this, _writer).pos - startPos;
        __privateGet(this, _writer).seek(__privateGet(this, _writer).pos - 4);
        __privateGet(this, _writer).writeU32(mfraBoxSize);
      } else {
        let mdatPos = __privateGet(this, _writer).offsets.get(__privateGet(this, _mdat));
        let mdatSize = __privateGet(this, _writer).pos - mdatPos;
        __privateGet(this, _mdat).size = mdatSize;
        __privateGet(this, _mdat).largeSize = mdatSize >= 2 ** 32;
        __privateGet(this, _writer).patchBox(__privateGet(this, _mdat));
        let movieBox = moov(tracks, __privateGet(this, _creationTime));
        if (typeof __privateGet(this, _options).fastStart === "object") {
          __privateGet(this, _writer).seek(__privateGet(this, _ftypSize));
          __privateGet(this, _writer).writeBox(movieBox);
          let remainingBytes = mdatPos - __privateGet(this, _writer).pos;
          __privateGet(this, _writer).writeBox(free(remainingBytes));
        } else {
          __privateGet(this, _writer).writeBox(movieBox);
        }
      }
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
      __privateGet(this, _writer).finalize();
      __privateSet(this, _finalized, true);
    }
  };
  _options = new WeakMap();
  _writer = new WeakMap();
  _ftypSize = new WeakMap();
  _mdat = new WeakMap();
  _videoTrack = new WeakMap();
  _audioTrack = new WeakMap();
  _creationTime = new WeakMap();
  _finalizedChunks = new WeakMap();
  _nextFragmentNumber = new WeakMap();
  _videoSampleQueue = new WeakMap();
  _audioSampleQueue = new WeakMap();
  _finalized = new WeakMap();
  _validateOptions = new WeakSet();
  validateOptions_fn = function(options) {
    if (typeof options !== "object") {
      throw new TypeError("The muxer requires an options object to be passed to its constructor.");
    }
    if (!(options.target instanceof Target)) {
      throw new TypeError("The target must be provided and an instance of Target.");
    }
    if (options.video) {
      if (!SUPPORTED_VIDEO_CODECS.includes(options.video.codec)) {
        throw new TypeError(`Unsupported video codec: ${options.video.codec}`);
      }
      if (!Number.isInteger(options.video.width) || options.video.width <= 0) {
        throw new TypeError(`Invalid video width: ${options.video.width}. Must be a positive integer.`);
      }
      if (!Number.isInteger(options.video.height) || options.video.height <= 0) {
        throw new TypeError(`Invalid video height: ${options.video.height}. Must be a positive integer.`);
      }
      const videoRotation = options.video.rotation;
      if (typeof videoRotation === "number" && ![0, 90, 180, 270].includes(videoRotation)) {
        throw new TypeError(`Invalid video rotation: ${videoRotation}. Has to be 0, 90, 180 or 270.`);
      } else if (Array.isArray(videoRotation) && (videoRotation.length !== 9 || videoRotation.some((value) => typeof value !== "number"))) {
        throw new TypeError(`Invalid video transformation matrix: ${videoRotation.join()}`);
      }
      if (options.video.frameRate !== void 0 && (!Number.isInteger(options.video.frameRate) || options.video.frameRate <= 0)) {
        throw new TypeError(
          `Invalid video frame rate: ${options.video.frameRate}. Must be a positive integer.`
        );
      }
    }
    if (options.audio) {
      if (!SUPPORTED_AUDIO_CODECS.includes(options.audio.codec)) {
        throw new TypeError(`Unsupported audio codec: ${options.audio.codec}`);
      }
      if (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0) {
        throw new TypeError(
          `Invalid number of audio channels: ${options.audio.numberOfChannels}. Must be a positive integer.`
        );
      }
      if (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0) {
        throw new TypeError(
          `Invalid audio sample rate: ${options.audio.sampleRate}. Must be a positive integer.`
        );
      }
    }
    if (options.firstTimestampBehavior && !FIRST_TIMESTAMP_BEHAVIORS.includes(options.firstTimestampBehavior)) {
      throw new TypeError(`Invalid first timestamp behavior: ${options.firstTimestampBehavior}`);
    }
    if (typeof options.fastStart === "object") {
      if (options.video) {
        if (options.fastStart.expectedVideoChunks === void 0) {
          throw new TypeError(`'fastStart' is an object but is missing property 'expectedVideoChunks'.`);
        } else if (!Number.isInteger(options.fastStart.expectedVideoChunks) || options.fastStart.expectedVideoChunks < 0) {
          throw new TypeError(`'expectedVideoChunks' must be a non-negative integer.`);
        }
      }
      if (options.audio) {
        if (options.fastStart.expectedAudioChunks === void 0) {
          throw new TypeError(`'fastStart' is an object but is missing property 'expectedAudioChunks'.`);
        } else if (!Number.isInteger(options.fastStart.expectedAudioChunks) || options.fastStart.expectedAudioChunks < 0) {
          throw new TypeError(`'expectedAudioChunks' must be a non-negative integer.`);
        }
      }
    } else if (![false, "in-memory", "fragmented"].includes(options.fastStart)) {
      throw new TypeError(`'fastStart' option must be false, 'in-memory', 'fragmented' or an object.`);
    }
    if (options.minFragmentDuration !== void 0 && (!Number.isFinite(options.minFragmentDuration) || options.minFragmentDuration < 0)) {
      throw new TypeError(`'minFragmentDuration' must be a non-negative number.`);
    }
  };
  _writeHeader = new WeakSet();
  writeHeader_fn = function() {
    __privateGet(this, _writer).writeBox(ftyp({
      holdsAvc: __privateGet(this, _options).video?.codec === "avc",
      fragmented: __privateGet(this, _options).fastStart === "fragmented"
    }));
    __privateSet(this, _ftypSize, __privateGet(this, _writer).pos);
    if (__privateGet(this, _options).fastStart === "in-memory") {
      __privateSet(this, _mdat, mdat(false));
    } else if (__privateGet(this, _options).fastStart === "fragmented") {
    } else {
      if (typeof __privateGet(this, _options).fastStart === "object") {
        let moovSizeUpperBound = __privateMethod(this, _computeMoovSizeUpperBound, computeMoovSizeUpperBound_fn).call(this);
        __privateGet(this, _writer).seek(__privateGet(this, _writer).pos + moovSizeUpperBound);
      }
      __privateSet(this, _mdat, mdat(true));
      __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
    }
    __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
  };
  _computeMoovSizeUpperBound = new WeakSet();
  computeMoovSizeUpperBound_fn = function() {
    if (typeof __privateGet(this, _options).fastStart !== "object")
      return;
    let upperBound = 0;
    let sampleCounts = [
      __privateGet(this, _options).fastStart.expectedVideoChunks,
      __privateGet(this, _options).fastStart.expectedAudioChunks
    ];
    for (let n of sampleCounts) {
      if (!n)
        continue;
      upperBound += (4 + 4) * Math.ceil(2 / 3 * n);
      upperBound += 4 * n;
      upperBound += (4 + 4 + 4) * Math.ceil(2 / 3 * n);
      upperBound += 4 * n;
      upperBound += 8 * n;
    }
    upperBound += 4096;
    return upperBound;
  };
  _prepareTracks = new WeakSet();
  prepareTracks_fn = function() {
    if (__privateGet(this, _options).video) {
      __privateSet(this, _videoTrack, {
        id: 1,
        info: {
          type: "video",
          codec: __privateGet(this, _options).video.codec,
          width: __privateGet(this, _options).video.width,
          height: __privateGet(this, _options).video.height,
          rotation: __privateGet(this, _options).video.rotation ?? 0,
          decoderConfig: null
        },
        // The fallback contains many common frame rates as factors
        timescale: __privateGet(this, _options).video.frameRate ?? 57600,
        samples: [],
        finalizedChunks: [],
        currentChunk: null,
        firstDecodeTimestamp: void 0,
        lastDecodeTimestamp: -1,
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        compactlyCodedChunkTable: []
      });
    }
    if (__privateGet(this, _options).audio) {
      __privateSet(this, _audioTrack, {
        id: __privateGet(this, _options).video ? 2 : 1,
        info: {
          type: "audio",
          codec: __privateGet(this, _options).audio.codec,
          numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
          sampleRate: __privateGet(this, _options).audio.sampleRate,
          decoderConfig: null
        },
        timescale: __privateGet(this, _options).audio.sampleRate,
        samples: [],
        finalizedChunks: [],
        currentChunk: null,
        firstDecodeTimestamp: void 0,
        lastDecodeTimestamp: -1,
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        compactlyCodedChunkTable: []
      });
      if (__privateGet(this, _options).audio.codec === "aac") {
        let guessedCodecPrivate = __privateMethod(this, _generateMpeg4AudioSpecificConfig, generateMpeg4AudioSpecificConfig_fn).call(
          this,
          2,
          // Object type for AAC-LC, since it's the most common
          __privateGet(this, _options).audio.sampleRate,
          __privateGet(this, _options).audio.numberOfChannels
        );
        __privateGet(this, _audioTrack).info.decoderConfig = {
          codec: __privateGet(this, _options).audio.codec,
          description: guessedCodecPrivate,
          numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
          sampleRate: __privateGet(this, _options).audio.sampleRate
        };
      }
    }
  };
  _generateMpeg4AudioSpecificConfig = new WeakSet();
  generateMpeg4AudioSpecificConfig_fn = function(objectType, sampleRate, numberOfChannels) {
    let frequencyIndices = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
    let frequencyIndex = frequencyIndices.indexOf(sampleRate);
    let channelConfig = numberOfChannels;
    let configBits = "";
    configBits += objectType.toString(2).padStart(5, "0");
    configBits += frequencyIndex.toString(2).padStart(4, "0");
    if (frequencyIndex === 15)
      configBits += sampleRate.toString(2).padStart(24, "0");
    configBits += channelConfig.toString(2).padStart(4, "0");
    let paddingLength = Math.ceil(configBits.length / 8) * 8;
    configBits = configBits.padEnd(paddingLength, "0");
    let configBytes = new Uint8Array(configBits.length / 8);
    for (let i = 0; i < configBits.length; i += 8) {
      configBytes[i / 8] = parseInt(configBits.slice(i, i + 8), 2);
    }
    return configBytes;
  };
  _createSampleForTrack = new WeakSet();
  createSampleForTrack_fn = function(track, data, type, timestamp, duration, meta, compositionTimeOffset) {
    let presentationTimestampInSeconds = timestamp / 1e6;
    let decodeTimestampInSeconds = (timestamp - (compositionTimeOffset ?? 0)) / 1e6;
    let durationInSeconds = duration / 1e6;
    let adjusted = __privateMethod(this, _validateTimestamp, validateTimestamp_fn).call(this, presentationTimestampInSeconds, decodeTimestampInSeconds, track);
    presentationTimestampInSeconds = adjusted.presentationTimestamp;
    decodeTimestampInSeconds = adjusted.decodeTimestamp;
    if (meta?.decoderConfig) {
      if (track.info.decoderConfig === null) {
        track.info.decoderConfig = meta.decoderConfig;
      } else {
        Object.assign(track.info.decoderConfig, meta.decoderConfig);
      }
    }
    let sample = {
      presentationTimestamp: presentationTimestampInSeconds,
      decodeTimestamp: decodeTimestampInSeconds,
      duration: durationInSeconds,
      data,
      size: data.byteLength,
      type,
      // Will be refined once the next sample comes in
      timescaleUnitsToNextSample: intoTimescale(durationInSeconds, track.timescale)
    };
    return sample;
  };
  _addSampleToTrack = new WeakSet();
  addSampleToTrack_fn = function(track, sample) {
    if (__privateGet(this, _options).fastStart !== "fragmented") {
      track.samples.push(sample);
    }
    const sampleCompositionTimeOffset = intoTimescale(sample.presentationTimestamp - sample.decodeTimestamp, track.timescale);
    if (track.lastTimescaleUnits !== null) {
      let timescaleUnits = intoTimescale(sample.decodeTimestamp, track.timescale, false);
      let delta = Math.round(timescaleUnits - track.lastTimescaleUnits);
      track.lastTimescaleUnits += delta;
      track.lastSample.timescaleUnitsToNextSample = delta;
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        let lastTableEntry = last(track.timeToSampleTable);
        if (lastTableEntry.sampleCount === 1) {
          lastTableEntry.sampleDelta = delta;
          lastTableEntry.sampleCount++;
        } else if (lastTableEntry.sampleDelta === delta) {
          lastTableEntry.sampleCount++;
        } else {
          lastTableEntry.sampleCount--;
          track.timeToSampleTable.push({
            sampleCount: 2,
            sampleDelta: delta
          });
        }
        const lastCompositionTimeOffsetTableEntry = last(track.compositionTimeOffsetTable);
        if (lastCompositionTimeOffsetTableEntry.sampleCompositionTimeOffset === sampleCompositionTimeOffset) {
          lastCompositionTimeOffsetTableEntry.sampleCount++;
        } else {
          track.compositionTimeOffsetTable.push({
            sampleCount: 1,
            sampleCompositionTimeOffset
          });
        }
      }
    } else {
      track.lastTimescaleUnits = 0;
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        track.timeToSampleTable.push({
          sampleCount: 1,
          sampleDelta: intoTimescale(sample.duration, track.timescale)
        });
        track.compositionTimeOffsetTable.push({
          sampleCount: 1,
          sampleCompositionTimeOffset
        });
      }
    }
    track.lastSample = sample;
    let beginNewChunk = false;
    if (!track.currentChunk) {
      beginNewChunk = true;
    } else {
      let currentChunkDuration = sample.presentationTimestamp - track.currentChunk.startTimestamp;
      if (__privateGet(this, _options).fastStart === "fragmented") {
        let mostImportantTrack = __privateGet(this, _videoTrack) ?? __privateGet(this, _audioTrack);
        const chunkDuration = __privateGet(this, _options).minFragmentDuration ?? 1;
        if (track === mostImportantTrack && sample.type === "key" && currentChunkDuration >= chunkDuration) {
          beginNewChunk = true;
          __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this);
        }
      } else {
        beginNewChunk = currentChunkDuration >= 0.5;
      }
    }
    if (beginNewChunk) {
      if (track.currentChunk) {
        __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, track);
      }
      track.currentChunk = {
        startTimestamp: sample.presentationTimestamp,
        samples: []
      };
    }
    track.currentChunk.samples.push(sample);
  };
  _validateTimestamp = new WeakSet();
  validateTimestamp_fn = function(presentationTimestamp, decodeTimestamp, track) {
    const strictTimestampBehavior = __privateGet(this, _options).firstTimestampBehavior === "strict";
    const noLastDecodeTimestamp = track.lastDecodeTimestamp === -1;
    const timestampNonZero = decodeTimestamp !== 0;
    if (strictTimestampBehavior && noLastDecodeTimestamp && timestampNonZero) {
      throw new Error(
        `The first chunk for your media track must have a timestamp of 0 (received DTS=${decodeTimestamp}).Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of thedocument, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
`
      );
    } else if (__privateGet(this, _options).firstTimestampBehavior === "offset" || __privateGet(this, _options).firstTimestampBehavior === "cross-track-offset") {
      if (track.firstDecodeTimestamp === void 0) {
        track.firstDecodeTimestamp = decodeTimestamp;
      }
      let baseDecodeTimestamp;
      if (__privateGet(this, _options).firstTimestampBehavior === "offset") {
        baseDecodeTimestamp = track.firstDecodeTimestamp;
      } else {
        baseDecodeTimestamp = Math.min(
          __privateGet(this, _videoTrack)?.firstDecodeTimestamp ?? Infinity,
          __privateGet(this, _audioTrack)?.firstDecodeTimestamp ?? Infinity
        );
      }
      decodeTimestamp -= baseDecodeTimestamp;
      presentationTimestamp -= baseDecodeTimestamp;
    }
    if (decodeTimestamp < track.lastDecodeTimestamp) {
      throw new Error(
        `Timestamps must be monotonically increasing (DTS went from ${track.lastDecodeTimestamp * 1e6} to ${decodeTimestamp * 1e6}).`
      );
    }
    track.lastDecodeTimestamp = decodeTimestamp;
    return { presentationTimestamp, decodeTimestamp };
  };
  _finalizeCurrentChunk = new WeakSet();
  finalizeCurrentChunk_fn = function(track) {
    if (__privateGet(this, _options).fastStart === "fragmented") {
      throw new Error("Can't finalize individual chunks if 'fastStart' is set to 'fragmented'.");
    }
    if (!track.currentChunk)
      return;
    track.finalizedChunks.push(track.currentChunk);
    __privateGet(this, _finalizedChunks).push(track.currentChunk);
    if (track.compactlyCodedChunkTable.length === 0 || last(track.compactlyCodedChunkTable).samplesPerChunk !== track.currentChunk.samples.length) {
      track.compactlyCodedChunkTable.push({
        firstChunk: track.finalizedChunks.length,
        // 1-indexed
        samplesPerChunk: track.currentChunk.samples.length
      });
    }
    if (__privateGet(this, _options).fastStart === "in-memory") {
      track.currentChunk.offset = 0;
      return;
    }
    track.currentChunk.offset = __privateGet(this, _writer).pos;
    for (let sample of track.currentChunk.samples) {
      __privateGet(this, _writer).write(sample.data);
      sample.data = null;
    }
    __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
  };
  _finalizeFragment = new WeakSet();
  finalizeFragment_fn = function(flushStreamingWriter = true) {
    if (__privateGet(this, _options).fastStart !== "fragmented") {
      throw new Error("Can't finalize a fragment unless 'fastStart' is set to 'fragmented'.");
    }
    let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter((track) => track && track.currentChunk);
    if (tracks.length === 0)
      return;
    let fragmentNumber = __privateWrapper(this, _nextFragmentNumber)._++;
    if (fragmentNumber === 1) {
      let movieBox = moov(tracks, __privateGet(this, _creationTime), true);
      __privateGet(this, _writer).writeBox(movieBox);
    }
    let moofOffset = __privateGet(this, _writer).pos;
    let moofBox = moof(fragmentNumber, tracks);
    __privateGet(this, _writer).writeBox(moofBox);
    {
      let mdatBox = mdat(false);
      let totalTrackSampleSize = 0;
      for (let track of tracks) {
        for (let sample of track.currentChunk.samples) {
          totalTrackSampleSize += sample.size;
        }
      }
      let mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
      if (mdatSize >= 2 ** 32) {
        mdatBox.largeSize = true;
        mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
      }
      mdatBox.size = mdatSize;
      __privateGet(this, _writer).writeBox(mdatBox);
    }
    for (let track of tracks) {
      track.currentChunk.offset = __privateGet(this, _writer).pos;
      track.currentChunk.moofOffset = moofOffset;
      for (let sample of track.currentChunk.samples) {
        __privateGet(this, _writer).write(sample.data);
        sample.data = null;
      }
    }
    let endPos = __privateGet(this, _writer).pos;
    __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(moofBox));
    let newMoofBox = moof(fragmentNumber, tracks);
    __privateGet(this, _writer).writeBox(newMoofBox);
    __privateGet(this, _writer).seek(endPos);
    for (let track of tracks) {
      track.finalizedChunks.push(track.currentChunk);
      __privateGet(this, _finalizedChunks).push(track.currentChunk);
      track.currentChunk = null;
    }
    if (flushStreamingWriter) {
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    }
  };
  _maybeFlushStreamingTargetWriter = new WeakSet();
  maybeFlushStreamingTargetWriter_fn = function() {
    if (__privateGet(this, _writer) instanceof StreamTargetWriter) {
      __privateGet(this, _writer).flush();
    }
  };
  _ensureNotFinalized = new WeakSet();
  ensureNotFinalized_fn = function() {
    if (__privateGet(this, _finalized)) {
      throw new Error("Cannot add new video or audio chunks after the file has been finalized.");
    }
  };
  return __toCommonJS(src_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, Mp4Muxer)


/* ===== 内联第三方库：webm-muxer 5.1.4（MIT）===== */
"use strict";
var WebMMuxer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __accessCheck = (obj, member, msg) => {
    if (!member.has(obj))
      throw TypeError("Cannot " + msg);
  };
  var __privateGet = (obj, member, getter) => {
    __accessCheck(obj, member, "read from private field");
    return getter ? getter.call(obj) : member.get(obj);
  };
  var __privateAdd = (obj, member, value) => {
    if (member.has(obj))
      throw TypeError("Cannot add the same private member more than once");
    member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  };
  var __privateSet = (obj, member, value, setter) => {
    __accessCheck(obj, member, "write to private field");
    setter ? setter.call(obj, value) : member.set(obj, value);
    return value;
  };
  var __privateMethod = (obj, member, method) => {
    __accessCheck(obj, member, "access private method");
    return method;
  };

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    ArrayBufferTarget: () => ArrayBufferTarget,
    FileSystemWritableFileStreamTarget: () => FileSystemWritableFileStreamTarget,
    Muxer: () => Muxer,
    StreamTarget: () => StreamTarget,
    SubtitleEncoder: () => SubtitleEncoder
  });

  // src/ebml.ts
  var EBMLFloat32 = class {
    constructor(value) {
      this.value = value;
    }
  };
  var EBMLFloat64 = class {
    constructor(value) {
      this.value = value;
    }
  };
  var measureUnsignedInt = (value) => {
    if (value < 1 << 8) {
      return 1;
    } else if (value < 1 << 16) {
      return 2;
    } else if (value < 1 << 24) {
      return 3;
    } else if (value < 2 ** 32) {
      return 4;
    } else if (value < 2 ** 40) {
      return 5;
    } else {
      return 6;
    }
  };
  var measureEBMLVarInt = (value) => {
    if (value < (1 << 7) - 1) {
      return 1;
    } else if (value < (1 << 14) - 1) {
      return 2;
    } else if (value < (1 << 21) - 1) {
      return 3;
    } else if (value < (1 << 28) - 1) {
      return 4;
    } else if (value < 2 ** 35 - 1) {
      return 5;
    } else if (value < 2 ** 42 - 1) {
      return 6;
    } else {
      throw new Error("EBML VINT size not supported " + value);
    }
  };

  // src/misc.ts
  var readBits = (bytes, start, end) => {
    let result = 0;
    for (let i = start; i < end; i++) {
      let byteIndex = Math.floor(i / 8);
      let byte = bytes[byteIndex];
      let bitIndex = 7 - (i & 7);
      let bit = (byte & 1 << bitIndex) >> bitIndex;
      result <<= 1;
      result |= bit;
    }
    return result;
  };
  var writeBits = (bytes, start, end, value) => {
    for (let i = start; i < end; i++) {
      let byteIndex = Math.floor(i / 8);
      let byte = bytes[byteIndex];
      let bitIndex = 7 - (i & 7);
      byte &= ~(1 << bitIndex);
      byte |= (value & 1 << end - i - 1) >> end - i - 1 << bitIndex;
      bytes[byteIndex] = byte;
    }
  };

  // src/target.ts
  var isTarget = Symbol("isTarget");
  var Target = class {
  };
  isTarget;
  var ArrayBufferTarget = class extends Target {
    constructor() {
      super(...arguments);
      this.buffer = null;
    }
  };
  var StreamTarget = class extends Target {
    constructor(options) {
      super();
      this.options = options;
      if (typeof options !== "object") {
        throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");
      }
      if (options.onData) {
        if (typeof options.onData !== "function") {
          throw new TypeError("options.onData, when provided, must be a function.");
        }
        if (options.onData.length < 2) {
          throw new TypeError(
            "options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs."
          );
        }
      }
      if (options.onHeader && typeof options.onHeader !== "function") {
        throw new TypeError("options.onHeader, when provided, must be a function.");
      }
      if (options.onCluster && typeof options.onCluster !== "function") {
        throw new TypeError("options.onCluster, when provided, must be a function.");
      }
      if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
        throw new TypeError("options.chunked, when provided, must be a boolean.");
      }
      if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
        throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.");
      }
    }
  };
  var FileSystemWritableFileStreamTarget = class extends Target {
    constructor(stream, options) {
      super();
      this.stream = stream;
      this.options = options;
      if (!(stream instanceof FileSystemWritableFileStream)) {
        throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");
      }
      if (options !== void 0 && typeof options !== "object") {
        throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");
      }
      if (options) {
        if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
          throw new TypeError("options.chunkSize, when provided, must be a positive integer");
        }
      }
    }
  };

  // src/writer.ts
  var _helper, _helperView, _writeByte, writeByte_fn, _writeFloat32, writeFloat32_fn, _writeFloat64, writeFloat64_fn, _writeUnsignedInt, writeUnsignedInt_fn, _writeString, writeString_fn;
  var Writer = class {
    constructor() {
      __privateAdd(this, _writeByte);
      __privateAdd(this, _writeFloat32);
      __privateAdd(this, _writeFloat64);
      __privateAdd(this, _writeUnsignedInt);
      __privateAdd(this, _writeString);
      this.pos = 0;
      __privateAdd(this, _helper, new Uint8Array(8));
      __privateAdd(this, _helperView, new DataView(__privateGet(this, _helper).buffer));
      this.offsets = /* @__PURE__ */ new WeakMap();
      this.dataOffsets = /* @__PURE__ */ new WeakMap();
    }
    seek(newPos) {
      this.pos = newPos;
    }
    writeEBMLVarInt(value, width = measureEBMLVarInt(value)) {
      let pos = 0;
      switch (width) {
        case 1:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 7 | value);
          break;
        case 2:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 6 | value >> 8);
          __privateGet(this, _helperView).setUint8(pos++, value);
          break;
        case 3:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 5 | value >> 16);
          __privateGet(this, _helperView).setUint8(pos++, value >> 8);
          __privateGet(this, _helperView).setUint8(pos++, value);
          break;
        case 4:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 4 | value >> 24);
          __privateGet(this, _helperView).setUint8(pos++, value >> 16);
          __privateGet(this, _helperView).setUint8(pos++, value >> 8);
          __privateGet(this, _helperView).setUint8(pos++, value);
          break;
        case 5:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 3 | value / 2 ** 32 & 7);
          __privateGet(this, _helperView).setUint8(pos++, value >> 24);
          __privateGet(this, _helperView).setUint8(pos++, value >> 16);
          __privateGet(this, _helperView).setUint8(pos++, value >> 8);
          __privateGet(this, _helperView).setUint8(pos++, value);
          break;
        case 6:
          __privateGet(this, _helperView).setUint8(pos++, 1 << 2 | value / 2 ** 40 & 3);
          __privateGet(this, _helperView).setUint8(pos++, value / 2 ** 32 | 0);
          __privateGet(this, _helperView).setUint8(pos++, value >> 24);
          __privateGet(this, _helperView).setUint8(pos++, value >> 16);
          __privateGet(this, _helperView).setUint8(pos++, value >> 8);
          __privateGet(this, _helperView).setUint8(pos++, value);
          break;
        default:
          throw new Error("Bad EBML VINT size " + width);
      }
      this.write(__privateGet(this, _helper).subarray(0, pos));
    }
    writeEBML(data) {
      if (data === null)
        return;
      if (data instanceof Uint8Array) {
        this.write(data);
      } else if (Array.isArray(data)) {
        for (let elem of data) {
          this.writeEBML(elem);
        }
      } else {
        this.offsets.set(data, this.pos);
        __privateMethod(this, _writeUnsignedInt, writeUnsignedInt_fn).call(this, data.id);
        if (Array.isArray(data.data)) {
          let sizePos = this.pos;
          let sizeSize = data.size === -1 ? 1 : data.size ?? 4;
          if (data.size === -1) {
            __privateMethod(this, _writeByte, writeByte_fn).call(this, 255);
          } else {
            this.seek(this.pos + sizeSize);
          }
          let startPos = this.pos;
          this.dataOffsets.set(data, startPos);
          this.writeEBML(data.data);
          if (data.size !== -1) {
            let size = this.pos - startPos;
            let endPos = this.pos;
            this.seek(sizePos);
            this.writeEBMLVarInt(size, sizeSize);
            this.seek(endPos);
          }
        } else if (typeof data.data === "number") {
          let size = data.size ?? measureUnsignedInt(data.data);
          this.writeEBMLVarInt(size);
          __privateMethod(this, _writeUnsignedInt, writeUnsignedInt_fn).call(this, data.data, size);
        } else if (typeof data.data === "string") {
          this.writeEBMLVarInt(data.data.length);
          __privateMethod(this, _writeString, writeString_fn).call(this, data.data);
        } else if (data.data instanceof Uint8Array) {
          this.writeEBMLVarInt(data.data.byteLength, data.size);
          this.write(data.data);
        } else if (data.data instanceof EBMLFloat32) {
          this.writeEBMLVarInt(4);
          __privateMethod(this, _writeFloat32, writeFloat32_fn).call(this, data.data.value);
        } else if (data.data instanceof EBMLFloat64) {
          this.writeEBMLVarInt(8);
          __privateMethod(this, _writeFloat64, writeFloat64_fn).call(this, data.data.value);
        }
      }
    }
  };
  _helper = new WeakMap();
  _helperView = new WeakMap();
  _writeByte = new WeakSet();
  writeByte_fn = function(value) {
    __privateGet(this, _helperView).setUint8(0, value);
    this.write(__privateGet(this, _helper).subarray(0, 1));
  };
  _writeFloat32 = new WeakSet();
  writeFloat32_fn = function(value) {
    __privateGet(this, _helperView).setFloat32(0, value, false);
    this.write(__privateGet(this, _helper).subarray(0, 4));
  };
  _writeFloat64 = new WeakSet();
  writeFloat64_fn = function(value) {
    __privateGet(this, _helperView).setFloat64(0, value, false);
    this.write(__privateGet(this, _helper));
  };
  _writeUnsignedInt = new WeakSet();
  writeUnsignedInt_fn = function(value, width = measureUnsignedInt(value)) {
    let pos = 0;
    switch (width) {
      case 6:
        __privateGet(this, _helperView).setUint8(pos++, value / 2 ** 40 | 0);
      case 5:
        __privateGet(this, _helperView).setUint8(pos++, value / 2 ** 32 | 0);
      case 4:
        __privateGet(this, _helperView).setUint8(pos++, value >> 24);
      case 3:
        __privateGet(this, _helperView).setUint8(pos++, value >> 16);
      case 2:
        __privateGet(this, _helperView).setUint8(pos++, value >> 8);
      case 1:
        __privateGet(this, _helperView).setUint8(pos++, value);
        break;
      default:
        throw new Error("Bad UINT size " + width);
    }
    this.write(__privateGet(this, _helper).subarray(0, pos));
  };
  _writeString = new WeakSet();
  writeString_fn = function(str) {
    this.write(new Uint8Array(str.split("").map((x) => x.charCodeAt(0))));
  };
  var _target, _buffer, _bytes, _ensureSize, ensureSize_fn;
  var ArrayBufferTargetWriter = class extends Writer {
    constructor(target) {
      super();
      __privateAdd(this, _ensureSize);
      __privateAdd(this, _target, void 0);
      __privateAdd(this, _buffer, new ArrayBuffer(2 ** 16));
      __privateAdd(this, _bytes, new Uint8Array(__privateGet(this, _buffer)));
      __privateSet(this, _target, target);
    }
    write(data) {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos + data.byteLength);
      __privateGet(this, _bytes).set(data, this.pos);
      this.pos += data.byteLength;
    }
    finalize() {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos);
      __privateGet(this, _target).buffer = __privateGet(this, _buffer).slice(0, this.pos);
    }
  };
  _target = new WeakMap();
  _buffer = new WeakMap();
  _bytes = new WeakMap();
  _ensureSize = new WeakSet();
  ensureSize_fn = function(size) {
    let newLength = __privateGet(this, _buffer).byteLength;
    while (newLength < size)
      newLength *= 2;
    if (newLength === __privateGet(this, _buffer).byteLength)
      return;
    let newBuffer = new ArrayBuffer(newLength);
    let newBytes = new Uint8Array(newBuffer);
    newBytes.set(__privateGet(this, _bytes), 0);
    __privateSet(this, _buffer, newBuffer);
    __privateSet(this, _bytes, newBytes);
  };
  var _trackingWrites, _trackedWrites, _trackedStart, _trackedEnd;
  var BaseStreamTargetWriter = class extends Writer {
    constructor(target) {
      super();
      this.target = target;
      __privateAdd(this, _trackingWrites, false);
      __privateAdd(this, _trackedWrites, void 0);
      __privateAdd(this, _trackedStart, void 0);
      __privateAdd(this, _trackedEnd, void 0);
    }
    write(data) {
      if (!__privateGet(this, _trackingWrites))
        return;
      let pos = this.pos;
      if (pos < __privateGet(this, _trackedStart)) {
        if (pos + data.byteLength <= __privateGet(this, _trackedStart))
          return;
        data = data.subarray(__privateGet(this, _trackedStart) - pos);
        pos = 0;
      }
      let neededSize = pos + data.byteLength - __privateGet(this, _trackedStart);
      let newLength = __privateGet(this, _trackedWrites).byteLength;
      while (newLength < neededSize)
        newLength *= 2;
      if (newLength !== __privateGet(this, _trackedWrites).byteLength) {
        let copy = new Uint8Array(newLength);
        copy.set(__privateGet(this, _trackedWrites), 0);
        __privateSet(this, _trackedWrites, copy);
      }
      __privateGet(this, _trackedWrites).set(data, pos - __privateGet(this, _trackedStart));
      __privateSet(this, _trackedEnd, Math.max(__privateGet(this, _trackedEnd), pos + data.byteLength));
    }
    startTrackingWrites() {
      __privateSet(this, _trackingWrites, true);
      __privateSet(this, _trackedWrites, new Uint8Array(2 ** 10));
      __privateSet(this, _trackedStart, this.pos);
      __privateSet(this, _trackedEnd, this.pos);
    }
    getTrackedWrites() {
      if (!__privateGet(this, _trackingWrites)) {
        throw new Error("Can't get tracked writes since nothing was tracked.");
      }
      let slice = __privateGet(this, _trackedWrites).subarray(0, __privateGet(this, _trackedEnd) - __privateGet(this, _trackedStart));
      let result = {
        data: slice,
        start: __privateGet(this, _trackedStart),
        end: __privateGet(this, _trackedEnd)
      };
      __privateSet(this, _trackedWrites, void 0);
      __privateSet(this, _trackingWrites, false);
      return result;
    }
  };
  _trackingWrites = new WeakMap();
  _trackedWrites = new WeakMap();
  _trackedStart = new WeakMap();
  _trackedEnd = new WeakMap();
  var DEFAULT_CHUNK_SIZE = 2 ** 24;
  var MAX_CHUNKS_AT_ONCE = 2;
  var _sections, _lastFlushEnd, _ensureMonotonicity, _chunked, _chunkSize, _chunks, _writeDataIntoChunks, writeDataIntoChunks_fn, _insertSectionIntoChunk, insertSectionIntoChunk_fn, _createChunk, createChunk_fn, _flushChunks, flushChunks_fn;
  var StreamTargetWriter = class extends BaseStreamTargetWriter {
    constructor(target, ensureMonotonicity) {
      super(target);
      __privateAdd(this, _writeDataIntoChunks);
      __privateAdd(this, _insertSectionIntoChunk);
      __privateAdd(this, _createChunk);
      __privateAdd(this, _flushChunks);
      __privateAdd(this, _sections, []);
      __privateAdd(this, _lastFlushEnd, 0);
      __privateAdd(this, _ensureMonotonicity, void 0);
      __privateAdd(this, _chunked, void 0);
      __privateAdd(this, _chunkSize, void 0);
      __privateAdd(this, _chunks, []);
      __privateSet(this, _ensureMonotonicity, ensureMonotonicity);
      __privateSet(this, _chunked, target.options?.chunked ?? false);
      __privateSet(this, _chunkSize, target.options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    }
    write(data) {
      super.write(data);
      __privateGet(this, _sections).push({
        data: data.slice(),
        start: this.pos
      });
      this.pos += data.byteLength;
    }
    flush() {
      if (__privateGet(this, _sections).length === 0)
        return;
      let chunks = [];
      let sorted = [...__privateGet(this, _sections)].sort((a, b) => a.start - b.start);
      chunks.push({
        start: sorted[0].start,
        size: sorted[0].data.byteLength
      });
      for (let i = 1; i < sorted.length; i++) {
        let lastChunk = chunks[chunks.length - 1];
        let section = sorted[i];
        if (section.start <= lastChunk.start + lastChunk.size) {
          lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
        } else {
          chunks.push({
            start: section.start,
            size: section.data.byteLength
          });
        }
      }
      for (let chunk of chunks) {
        chunk.data = new Uint8Array(chunk.size);
        for (let section of __privateGet(this, _sections)) {
          if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
            chunk.data.set(section.data, section.start - chunk.start);
          }
        }
        if (__privateGet(this, _chunked)) {
          __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, chunk.data, chunk.start);
          __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
        } else {
          if (__privateGet(this, _ensureMonotonicity) && chunk.start < __privateGet(this, _lastFlushEnd)) {
            throw new Error("Internal error: Monotonicity violation.");
          }
          this.target.options.onData?.(chunk.data, chunk.start);
          __privateSet(this, _lastFlushEnd, chunk.start + chunk.data.byteLength);
        }
      }
      __privateGet(this, _sections).length = 0;
    }
    finalize() {
      if (__privateGet(this, _chunked)) {
        __privateMethod(this, _flushChunks, flushChunks_fn).call(this, true);
      }
    }
  };
  _sections = new WeakMap();
  _lastFlushEnd = new WeakMap();
  _ensureMonotonicity = new WeakMap();
  _chunked = new WeakMap();
  _chunkSize = new WeakMap();
  _chunks = new WeakMap();
  _writeDataIntoChunks = new WeakSet();
  writeDataIntoChunks_fn = function(data, position) {
    let chunkIndex = __privateGet(this, _chunks).findIndex((x) => x.start <= position && position < x.start + __privateGet(this, _chunkSize));
    if (chunkIndex === -1)
      chunkIndex = __privateMethod(this, _createChunk, createChunk_fn).call(this, position);
    let chunk = __privateGet(this, _chunks)[chunkIndex];
    let relativePosition = position - chunk.start;
    let toWrite = data.subarray(0, Math.min(__privateGet(this, _chunkSize) - relativePosition, data.byteLength));
    chunk.data.set(toWrite, relativePosition);
    let section = {
      start: relativePosition,
      end: relativePosition + toWrite.byteLength
    };
    __privateMethod(this, _insertSectionIntoChunk, insertSectionIntoChunk_fn).call(this, chunk, section);
    if (chunk.written[0].start === 0 && chunk.written[0].end === __privateGet(this, _chunkSize)) {
      chunk.shouldFlush = true;
    }
    if (__privateGet(this, _chunks).length > MAX_CHUNKS_AT_ONCE) {
      for (let i = 0; i < __privateGet(this, _chunks).length - 1; i++) {
        __privateGet(this, _chunks)[i].shouldFlush = true;
      }
      __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
    }
    if (toWrite.byteLength < data.byteLength) {
      __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, data.subarray(toWrite.byteLength), position + toWrite.byteLength);
    }
  };
  _insertSectionIntoChunk = new WeakSet();
  insertSectionIntoChunk_fn = function(chunk, section) {
    let low = 0;
    let high = chunk.written.length - 1;
    let index = -1;
    while (low <= high) {
      let mid = Math.floor(low + (high - low + 1) / 2);
      if (chunk.written[mid].start <= section.start) {
        low = mid + 1;
        index = mid;
      } else {
        high = mid - 1;
      }
    }
    chunk.written.splice(index + 1, 0, section);
    if (index === -1 || chunk.written[index].end < section.start)
      index++;
    while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
      chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
      chunk.written.splice(index + 1, 1);
    }
  };
  _createChunk = new WeakSet();
  createChunk_fn = function(includesPosition) {
    let start = Math.floor(includesPosition / __privateGet(this, _chunkSize)) * __privateGet(this, _chunkSize);
    let chunk = {
      start,
      data: new Uint8Array(__privateGet(this, _chunkSize)),
      written: [],
      shouldFlush: false
    };
    __privateGet(this, _chunks).push(chunk);
    __privateGet(this, _chunks).sort((a, b) => a.start - b.start);
    return __privateGet(this, _chunks).indexOf(chunk);
  };
  _flushChunks = new WeakSet();
  flushChunks_fn = function(force = false) {
    for (let i = 0; i < __privateGet(this, _chunks).length; i++) {
      let chunk = __privateGet(this, _chunks)[i];
      if (!chunk.shouldFlush && !force)
        continue;
      for (let section of chunk.written) {
        if (__privateGet(this, _ensureMonotonicity) && chunk.start + section.start < __privateGet(this, _lastFlushEnd)) {
          throw new Error("Internal error: Monotonicity violation.");
        }
        this.target.options.onData?.(
          chunk.data.subarray(section.start, section.end),
          chunk.start + section.start
        );
        __privateSet(this, _lastFlushEnd, chunk.start + section.end);
      }
      __privateGet(this, _chunks).splice(i--, 1);
    }
  };
  var FileSystemWritableFileStreamTargetWriter = class extends StreamTargetWriter {
    constructor(target, ensureMonotonicity) {
      super(new StreamTarget({
        onData: (data, position) => target.stream.write({
          type: "write",
          data,
          position
        }),
        chunked: true,
        chunkSize: target.options?.chunkSize
      }), ensureMonotonicity);
    }
  };

  // src/muxer.ts
  var VIDEO_TRACK_NUMBER = 1;
  var AUDIO_TRACK_NUMBER = 2;
  var SUBTITLE_TRACK_NUMBER = 3;
  var VIDEO_TRACK_TYPE = 1;
  var AUDIO_TRACK_TYPE = 2;
  var SUBTITLE_TRACK_TYPE = 17;
  var MAX_CHUNK_LENGTH_MS = 2 ** 15;
  var CODEC_PRIVATE_MAX_SIZE = 2 ** 13;
  var APP_NAME = "https://github.com/Vanilagy/webm-muxer";
  var SEGMENT_SIZE_BYTES = 6;
  var CLUSTER_SIZE_BYTES = 5;
  var FIRST_TIMESTAMP_BEHAVIORS = ["strict", "offset", "permissive"];
  var _options, _writer, _segment, _segmentInfo, _seekHead, _tracksElement, _segmentDuration, _colourElement, _videoCodecPrivate, _audioCodecPrivate, _subtitleCodecPrivate, _cues, _currentCluster, _currentClusterTimestamp, _duration, _videoChunkQueue, _audioChunkQueue, _subtitleChunkQueue, _firstVideoTimestamp, _firstAudioTimestamp, _lastVideoTimestamp, _lastAudioTimestamp, _lastSubtitleTimestamp, _colorSpace, _finalized, _validateOptions, validateOptions_fn, _createFileHeader, createFileHeader_fn, _writeEBMLHeader, writeEBMLHeader_fn, _createCodecPrivatePlaceholders, createCodecPrivatePlaceholders_fn, _createColourElement, createColourElement_fn, _createSeekHead, createSeekHead_fn, _createSegmentInfo, createSegmentInfo_fn, _createTracks, createTracks_fn, _createSegment, createSegment_fn, _createCues, createCues_fn, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn, _segmentDataOffset, segmentDataOffset_get, _writeVideoDecoderConfig, writeVideoDecoderConfig_fn, _fixVP9ColorSpace, fixVP9ColorSpace_fn, _writeSubtitleChunks, writeSubtitleChunks_fn, _createInternalChunk, createInternalChunk_fn, _validateTimestamp, validateTimestamp_fn, _writeBlock, writeBlock_fn, _createCodecPrivateElement, createCodecPrivateElement_fn, _writeCodecPrivate, writeCodecPrivate_fn, _createNewCluster, createNewCluster_fn, _finalizeCurrentCluster, finalizeCurrentCluster_fn, _ensureNotFinalized, ensureNotFinalized_fn;
  var Muxer = class {
    constructor(options) {
      __privateAdd(this, _validateOptions);
      __privateAdd(this, _createFileHeader);
      __privateAdd(this, _writeEBMLHeader);
      __privateAdd(this, _createCodecPrivatePlaceholders);
      __privateAdd(this, _createColourElement);
      __privateAdd(this, _createSeekHead);
      __privateAdd(this, _createSegmentInfo);
      __privateAdd(this, _createTracks);
      __privateAdd(this, _createSegment);
      __privateAdd(this, _createCues);
      __privateAdd(this, _maybeFlushStreamingTargetWriter);
      __privateAdd(this, _segmentDataOffset);
      __privateAdd(this, _writeVideoDecoderConfig);
      __privateAdd(this, _fixVP9ColorSpace);
      __privateAdd(this, _writeSubtitleChunks);
      __privateAdd(this, _createInternalChunk);
      __privateAdd(this, _validateTimestamp);
      __privateAdd(this, _writeBlock);
      __privateAdd(this, _createCodecPrivateElement);
      __privateAdd(this, _writeCodecPrivate);
      __privateAdd(this, _createNewCluster);
      __privateAdd(this, _finalizeCurrentCluster);
      __privateAdd(this, _ensureNotFinalized);
      __privateAdd(this, _options, void 0);
      __privateAdd(this, _writer, void 0);
      __privateAdd(this, _segment, void 0);
      __privateAdd(this, _segmentInfo, void 0);
      __privateAdd(this, _seekHead, void 0);
      __privateAdd(this, _tracksElement, void 0);
      __privateAdd(this, _segmentDuration, void 0);
      __privateAdd(this, _colourElement, void 0);
      __privateAdd(this, _videoCodecPrivate, void 0);
      __privateAdd(this, _audioCodecPrivate, void 0);
      __privateAdd(this, _subtitleCodecPrivate, void 0);
      __privateAdd(this, _cues, void 0);
      __privateAdd(this, _currentCluster, void 0);
      __privateAdd(this, _currentClusterTimestamp, void 0);
      __privateAdd(this, _duration, 0);
      __privateAdd(this, _videoChunkQueue, []);
      __privateAdd(this, _audioChunkQueue, []);
      __privateAdd(this, _subtitleChunkQueue, []);
      __privateAdd(this, _firstVideoTimestamp, void 0);
      __privateAdd(this, _firstAudioTimestamp, void 0);
      __privateAdd(this, _lastVideoTimestamp, -1);
      __privateAdd(this, _lastAudioTimestamp, -1);
      __privateAdd(this, _lastSubtitleTimestamp, -1);
      __privateAdd(this, _colorSpace, void 0);
      __privateAdd(this, _finalized, false);
      __privateMethod(this, _validateOptions, validateOptions_fn).call(this, options);
      __privateSet(this, _options, {
        type: "webm",
        firstTimestampBehavior: "strict",
        ...options
      });
      this.target = options.target;
      let ensureMonotonicity = !!__privateGet(this, _options).streaming;
      if (options.target instanceof ArrayBufferTarget) {
        __privateSet(this, _writer, new ArrayBufferTargetWriter(options.target));
      } else if (options.target instanceof StreamTarget) {
        __privateSet(this, _writer, new StreamTargetWriter(options.target, ensureMonotonicity));
      } else if (options.target instanceof FileSystemWritableFileStreamTarget) {
        __privateSet(this, _writer, new FileSystemWritableFileStreamTargetWriter(options.target, ensureMonotonicity));
      } else {
        throw new Error(`Invalid target: ${options.target}`);
      }
      __privateMethod(this, _createFileHeader, createFileHeader_fn).call(this);
    }
    addVideoChunk(chunk, meta, timestamp) {
      if (!(chunk instanceof EncodedVideoChunk)) {
        throw new TypeError("addVideoChunk's first argument (chunk) must be of type EncodedVideoChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      let data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.addVideoChunkRaw(data, chunk.type, timestamp ?? chunk.timestamp, meta);
    }
    addVideoChunkRaw(data, type, timestamp, meta) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunkRaw's fourth argument (meta), when provided, must be an object.");
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).video)
        throw new Error("No video track declared.");
      if (__privateGet(this, _firstVideoTimestamp) === void 0)
        __privateSet(this, _firstVideoTimestamp, timestamp);
      if (meta)
        __privateMethod(this, _writeVideoDecoderConfig, writeVideoDecoderConfig_fn).call(this, meta);
      let videoChunk = __privateMethod(this, _createInternalChunk, createInternalChunk_fn).call(this, data, type, timestamp, VIDEO_TRACK_NUMBER);
      if (__privateGet(this, _options).video.codec === "V_VP9")
        __privateMethod(this, _fixVP9ColorSpace, fixVP9ColorSpace_fn).call(this, videoChunk);
      __privateSet(this, _lastVideoTimestamp, videoChunk.timestamp);
      while (__privateGet(this, _audioChunkQueue).length > 0 && __privateGet(this, _audioChunkQueue)[0].timestamp <= videoChunk.timestamp) {
        let audioChunk = __privateGet(this, _audioChunkQueue).shift();
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, audioChunk, false);
      }
      if (!__privateGet(this, _options).audio || videoChunk.timestamp <= __privateGet(this, _lastAudioTimestamp)) {
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, videoChunk, true);
      } else {
        __privateGet(this, _videoChunkQueue).push(videoChunk);
      }
      __privateMethod(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    }
    addAudioChunk(chunk, meta, timestamp) {
      if (!(chunk instanceof EncodedAudioChunk)) {
        throw new TypeError("addAudioChunk's first argument (chunk) must be of type EncodedAudioChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      let data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.addAudioChunkRaw(data, chunk.type, timestamp ?? chunk.timestamp, meta);
    }
    addAudioChunkRaw(data, type, timestamp, meta) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunkRaw's fourth argument (meta), when provided, must be an object.");
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).audio)
        throw new Error("No audio track declared.");
      if (__privateGet(this, _firstAudioTimestamp) === void 0)
        __privateSet(this, _firstAudioTimestamp, timestamp);
      if (meta?.decoderConfig) {
        if (__privateGet(this, _options).streaming) {
          __privateSet(this, _audioCodecPrivate, __privateMethod(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
        } else {
          __privateMethod(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet(this, _audioCodecPrivate), meta.decoderConfig.description);
        }
      }
      let audioChunk = __privateMethod(this, _createInternalChunk, createInternalChunk_fn).call(this, data, type, timestamp, AUDIO_TRACK_NUMBER);
      __privateSet(this, _lastAudioTimestamp, audioChunk.timestamp);
      while (__privateGet(this, _videoChunkQueue).length > 0 && __privateGet(this, _videoChunkQueue)[0].timestamp <= audioChunk.timestamp) {
        let videoChunk = __privateGet(this, _videoChunkQueue).shift();
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, videoChunk, true);
      }
      if (!__privateGet(this, _options).video || audioChunk.timestamp <= __privateGet(this, _lastVideoTimestamp)) {
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, audioChunk, !__privateGet(this, _options).video);
      } else {
        __privateGet(this, _audioChunkQueue).push(audioChunk);
      }
      __privateMethod(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    }
    addSubtitleChunk(chunk, meta, timestamp) {
      if (typeof chunk !== "object" || !chunk) {
        throw new TypeError("addSubtitleChunk's first argument (chunk) must be an object.");
      } else {
        if (!(chunk.body instanceof Uint8Array)) {
          throw new TypeError("body must be an instance of Uint8Array.");
        }
        if (!Number.isFinite(chunk.timestamp) || chunk.timestamp < 0) {
          throw new TypeError("timestamp must be a non-negative real number.");
        }
        if (!Number.isFinite(chunk.duration) || chunk.duration < 0) {
          throw new TypeError("duration must be a non-negative real number.");
        }
        if (chunk.additions && !(chunk.additions instanceof Uint8Array)) {
          throw new TypeError("additions, when present, must be an instance of Uint8Array.");
        }
      }
      if (typeof meta !== "object") {
        throw new TypeError("addSubtitleChunk's second argument (meta) must be an object.");
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).subtitles)
        throw new Error("No subtitle track declared.");
      if (meta?.decoderConfig) {
        if (__privateGet(this, _options).streaming) {
          __privateSet(this, _subtitleCodecPrivate, __privateMethod(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
        } else {
          __privateMethod(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet(this, _subtitleCodecPrivate), meta.decoderConfig.description);
        }
      }
      let subtitleChunk = __privateMethod(this, _createInternalChunk, createInternalChunk_fn).call(this, chunk.body, "key", timestamp ?? chunk.timestamp, SUBTITLE_TRACK_NUMBER, chunk.duration, chunk.additions);
      __privateSet(this, _lastSubtitleTimestamp, subtitleChunk.timestamp);
      __privateGet(this, _subtitleChunkQueue).push(subtitleChunk);
      __privateMethod(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    }
    finalize() {
      if (__privateGet(this, _finalized)) {
        throw new Error("Cannot finalize a muxer more than once.");
      }
      while (__privateGet(this, _videoChunkQueue).length > 0)
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, __privateGet(this, _videoChunkQueue).shift(), true);
      while (__privateGet(this, _audioChunkQueue).length > 0)
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, __privateGet(this, _audioChunkQueue).shift(), true);
      while (__privateGet(this, _subtitleChunkQueue).length > 0 && __privateGet(this, _subtitleChunkQueue)[0].timestamp <= __privateGet(this, _duration)) {
        __privateMethod(this, _writeBlock, writeBlock_fn).call(this, __privateGet(this, _subtitleChunkQueue).shift(), false);
      }
      if (__privateGet(this, _currentCluster)) {
        __privateMethod(this, _finalizeCurrentCluster, finalizeCurrentCluster_fn).call(this);
      }
      __privateGet(this, _writer).writeEBML(__privateGet(this, _cues));
      if (!__privateGet(this, _options).streaming) {
        let endPos = __privateGet(this, _writer).pos;
        let segmentSize = __privateGet(this, _writer).pos - __privateGet(this, _segmentDataOffset, segmentDataOffset_get);
        __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(__privateGet(this, _segment)) + 4);
        __privateGet(this, _writer).writeEBMLVarInt(segmentSize, SEGMENT_SIZE_BYTES);
        __privateGet(this, _segmentDuration).data = new EBMLFloat64(__privateGet(this, _duration));
        __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(__privateGet(this, _segmentDuration)));
        __privateGet(this, _writer).writeEBML(__privateGet(this, _segmentDuration));
        __privateGet(this, _seekHead).data[0].data[1].data = __privateGet(this, _writer).offsets.get(__privateGet(this, _cues)) - __privateGet(this, _segmentDataOffset, segmentDataOffset_get);
        __privateGet(this, _seekHead).data[1].data[1].data = __privateGet(this, _writer).offsets.get(__privateGet(this, _segmentInfo)) - __privateGet(this, _segmentDataOffset, segmentDataOffset_get);
        __privateGet(this, _seekHead).data[2].data[1].data = __privateGet(this, _writer).offsets.get(__privateGet(this, _tracksElement)) - __privateGet(this, _segmentDataOffset, segmentDataOffset_get);
        __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(__privateGet(this, _seekHead)));
        __privateGet(this, _writer).writeEBML(__privateGet(this, _seekHead));
        __privateGet(this, _writer).seek(endPos);
      }
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
      __privateGet(this, _writer).finalize();
      __privateSet(this, _finalized, true);
    }
  };
  _options = new WeakMap();
  _writer = new WeakMap();
  _segment = new WeakMap();
  _segmentInfo = new WeakMap();
  _seekHead = new WeakMap();
  _tracksElement = new WeakMap();
  _segmentDuration = new WeakMap();
  _colourElement = new WeakMap();
  _videoCodecPrivate = new WeakMap();
  _audioCodecPrivate = new WeakMap();
  _subtitleCodecPrivate = new WeakMap();
  _cues = new WeakMap();
  _currentCluster = new WeakMap();
  _currentClusterTimestamp = new WeakMap();
  _duration = new WeakMap();
  _videoChunkQueue = new WeakMap();
  _audioChunkQueue = new WeakMap();
  _subtitleChunkQueue = new WeakMap();
  _firstVideoTimestamp = new WeakMap();
  _firstAudioTimestamp = new WeakMap();
  _lastVideoTimestamp = new WeakMap();
  _lastAudioTimestamp = new WeakMap();
  _lastSubtitleTimestamp = new WeakMap();
  _colorSpace = new WeakMap();
  _finalized = new WeakMap();
  _validateOptions = new WeakSet();
  validateOptions_fn = function(options) {
    if (typeof options !== "object") {
      throw new TypeError("The muxer requires an options object to be passed to its constructor.");
    }
    if (!(options.target instanceof Target)) {
      throw new TypeError("The target must be provided and an instance of Target.");
    }
    if (options.video) {
      if (typeof options.video.codec !== "string") {
        throw new TypeError(`Invalid video codec: ${options.video.codec}. Must be a string.`);
      }
      if (!Number.isInteger(options.video.width) || options.video.width <= 0) {
        throw new TypeError(`Invalid video width: ${options.video.width}. Must be a positive integer.`);
      }
      if (!Number.isInteger(options.video.height) || options.video.height <= 0) {
        throw new TypeError(`Invalid video height: ${options.video.height}. Must be a positive integer.`);
      }
      if (options.video.frameRate !== void 0) {
        if (!Number.isFinite(options.video.frameRate) || options.video.frameRate <= 0) {
          throw new TypeError(
            `Invalid video frame rate: ${options.video.frameRate}. Must be a positive number.`
          );
        }
      }
      if (options.video.alpha !== void 0 && typeof options.video.alpha !== "boolean") {
        throw new TypeError(`Invalid video alpha: ${options.video.alpha}. Must be a boolean.`);
      }
    }
    if (options.audio) {
      if (typeof options.audio.codec !== "string") {
        throw new TypeError(`Invalid audio codec: ${options.audio.codec}. Must be a string.`);
      }
      if (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0) {
        throw new TypeError(
          `Invalid number of audio channels: ${options.audio.numberOfChannels}. Must be a positive integer.`
        );
      }
      if (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0) {
        throw new TypeError(
          `Invalid audio sample rate: ${options.audio.sampleRate}. Must be a positive integer.`
        );
      }
      if (options.audio.bitDepth !== void 0) {
        if (!Number.isInteger(options.audio.bitDepth) || options.audio.bitDepth <= 0) {
          throw new TypeError(
            `Invalid audio bit depth: ${options.audio.bitDepth}. Must be a positive integer.`
          );
        }
      }
    }
    if (options.subtitles) {
      if (typeof options.subtitles.codec !== "string") {
        throw new TypeError(`Invalid subtitles codec: ${options.subtitles.codec}. Must be a string.`);
      }
    }
    if (options.type !== void 0 && !["webm", "matroska"].includes(options.type)) {
      throw new TypeError(`Invalid type: ${options.type}. Must be 'webm' or 'matroska'.`);
    }
    if (options.firstTimestampBehavior && !FIRST_TIMESTAMP_BEHAVIORS.includes(options.firstTimestampBehavior)) {
      throw new TypeError(`Invalid first timestamp behavior: ${options.firstTimestampBehavior}`);
    }
    if (options.streaming !== void 0 && typeof options.streaming !== "boolean") {
      throw new TypeError(`Invalid streaming option: ${options.streaming}. Must be a boolean.`);
    }
  };
  _createFileHeader = new WeakSet();
  createFileHeader_fn = function() {
    if (__privateGet(this, _writer) instanceof BaseStreamTargetWriter && __privateGet(this, _writer).target.options.onHeader) {
      __privateGet(this, _writer).startTrackingWrites();
    }
    __privateMethod(this, _writeEBMLHeader, writeEBMLHeader_fn).call(this);
    if (!__privateGet(this, _options).streaming) {
      __privateMethod(this, _createSeekHead, createSeekHead_fn).call(this);
    }
    __privateMethod(this, _createSegmentInfo, createSegmentInfo_fn).call(this);
    __privateMethod(this, _createCodecPrivatePlaceholders, createCodecPrivatePlaceholders_fn).call(this);
    __privateMethod(this, _createColourElement, createColourElement_fn).call(this);
    if (!__privateGet(this, _options).streaming) {
      __privateMethod(this, _createTracks, createTracks_fn).call(this);
      __privateMethod(this, _createSegment, createSegment_fn).call(this);
    } else {
    }
    __privateMethod(this, _createCues, createCues_fn).call(this);
    __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
  };
  _writeEBMLHeader = new WeakSet();
  writeEBMLHeader_fn = function() {
    let ebmlHeader = { id: 440786851 /* EBML */, data: [
      { id: 17030 /* EBMLVersion */, data: 1 },
      { id: 17143 /* EBMLReadVersion */, data: 1 },
      { id: 17138 /* EBMLMaxIDLength */, data: 4 },
      { id: 17139 /* EBMLMaxSizeLength */, data: 8 },
      { id: 17026 /* DocType */, data: __privateGet(this, _options).type ?? "webm" },
      { id: 17031 /* DocTypeVersion */, data: 2 },
      { id: 17029 /* DocTypeReadVersion */, data: 2 }
    ] };
    __privateGet(this, _writer).writeEBML(ebmlHeader);
  };
  _createCodecPrivatePlaceholders = new WeakSet();
  createCodecPrivatePlaceholders_fn = function() {
    __privateSet(this, _videoCodecPrivate, { id: 236 /* Void */, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
    __privateSet(this, _audioCodecPrivate, { id: 236 /* Void */, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
    __privateSet(this, _subtitleCodecPrivate, { id: 236 /* Void */, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
  };
  _createColourElement = new WeakSet();
  createColourElement_fn = function() {
    __privateSet(this, _colourElement, { id: 21936 /* Colour */, data: [
      { id: 21937 /* MatrixCoefficients */, data: 2 },
      { id: 21946 /* TransferCharacteristics */, data: 2 },
      { id: 21947 /* Primaries */, data: 2 },
      { id: 21945 /* Range */, data: 0 }
    ] });
  };
  _createSeekHead = new WeakSet();
  createSeekHead_fn = function() {
    const kaxCues = new Uint8Array([28, 83, 187, 107]);
    const kaxInfo = new Uint8Array([21, 73, 169, 102]);
    const kaxTracks = new Uint8Array([22, 84, 174, 107]);
    let seekHead = { id: 290298740 /* SeekHead */, data: [
      { id: 19899 /* Seek */, data: [
        { id: 21419 /* SeekID */, data: kaxCues },
        { id: 21420 /* SeekPosition */, size: 5, data: 0 }
      ] },
      { id: 19899 /* Seek */, data: [
        { id: 21419 /* SeekID */, data: kaxInfo },
        { id: 21420 /* SeekPosition */, size: 5, data: 0 }
      ] },
      { id: 19899 /* Seek */, data: [
        { id: 21419 /* SeekID */, data: kaxTracks },
        { id: 21420 /* SeekPosition */, size: 5, data: 0 }
      ] }
    ] };
    __privateSet(this, _seekHead, seekHead);
  };
  _createSegmentInfo = new WeakSet();
  createSegmentInfo_fn = function() {
    let segmentDuration = { id: 17545 /* Duration */, data: new EBMLFloat64(0) };
    __privateSet(this, _segmentDuration, segmentDuration);
    let segmentInfo = { id: 357149030 /* Info */, data: [
      { id: 2807729 /* TimestampScale */, data: 1e6 },
      { id: 19840 /* MuxingApp */, data: APP_NAME },
      { id: 22337 /* WritingApp */, data: APP_NAME },
      !__privateGet(this, _options).streaming ? segmentDuration : null
    ] };
    __privateSet(this, _segmentInfo, segmentInfo);
  };
  _createTracks = new WeakSet();
  createTracks_fn = function() {
    let tracksElement = { id: 374648427 /* Tracks */, data: [] };
    __privateSet(this, _tracksElement, tracksElement);
    if (__privateGet(this, _options).video) {
      tracksElement.data.push({ id: 174 /* TrackEntry */, data: [
        { id: 215 /* TrackNumber */, data: VIDEO_TRACK_NUMBER },
        { id: 29637 /* TrackUID */, data: VIDEO_TRACK_NUMBER },
        { id: 131 /* TrackType */, data: VIDEO_TRACK_TYPE },
        { id: 134 /* CodecID */, data: __privateGet(this, _options).video.codec },
        __privateGet(this, _videoCodecPrivate),
        __privateGet(this, _options).video.frameRate ? { id: 2352003 /* DefaultDuration */, data: 1e9 / __privateGet(this, _options).video.frameRate } : null,
        { id: 224 /* Video */, data: [
          { id: 176 /* PixelWidth */, data: __privateGet(this, _options).video.width },
          { id: 186 /* PixelHeight */, data: __privateGet(this, _options).video.height },
          __privateGet(this, _options).video.alpha ? { id: 21440 /* AlphaMode */, data: 1 } : null,
          __privateGet(this, _colourElement)
        ] }
      ] });
    }
    if (__privateGet(this, _options).audio) {
      __privateSet(this, _audioCodecPrivate, __privateGet(this, _options).streaming ? __privateGet(this, _audioCodecPrivate) || null : { id: 236 /* Void */, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
      tracksElement.data.push({ id: 174 /* TrackEntry */, data: [
        { id: 215 /* TrackNumber */, data: AUDIO_TRACK_NUMBER },
        { id: 29637 /* TrackUID */, data: AUDIO_TRACK_NUMBER },
        { id: 131 /* TrackType */, data: AUDIO_TRACK_TYPE },
        { id: 134 /* CodecID */, data: __privateGet(this, _options).audio.codec },
        __privateGet(this, _audioCodecPrivate),
        { id: 225 /* Audio */, data: [
          { id: 181 /* SamplingFrequency */, data: new EBMLFloat32(__privateGet(this, _options).audio.sampleRate) },
          { id: 159 /* Channels */, data: __privateGet(this, _options).audio.numberOfChannels },
          __privateGet(this, _options).audio.bitDepth ? { id: 25188 /* BitDepth */, data: __privateGet(this, _options).audio.bitDepth } : null
        ] }
      ] });
    }
    if (__privateGet(this, _options).subtitles) {
      tracksElement.data.push({ id: 174 /* TrackEntry */, data: [
        { id: 215 /* TrackNumber */, data: SUBTITLE_TRACK_NUMBER },
        { id: 29637 /* TrackUID */, data: SUBTITLE_TRACK_NUMBER },
        { id: 131 /* TrackType */, data: SUBTITLE_TRACK_TYPE },
        { id: 134 /* CodecID */, data: __privateGet(this, _options).subtitles.codec },
        __privateGet(this, _subtitleCodecPrivate)
      ] });
    }
  };
  _createSegment = new WeakSet();
  createSegment_fn = function() {
    let segment = {
      id: 408125543 /* Segment */,
      size: __privateGet(this, _options).streaming ? -1 : SEGMENT_SIZE_BYTES,
      data: [
        !__privateGet(this, _options).streaming ? __privateGet(this, _seekHead) : null,
        __privateGet(this, _segmentInfo),
        __privateGet(this, _tracksElement)
      ]
    };
    __privateSet(this, _segment, segment);
    __privateGet(this, _writer).writeEBML(segment);
    if (__privateGet(this, _writer) instanceof BaseStreamTargetWriter && __privateGet(this, _writer).target.options.onHeader) {
      let { data, start } = __privateGet(this, _writer).getTrackedWrites();
      __privateGet(this, _writer).target.options.onHeader(data, start);
    }
  };
  _createCues = new WeakSet();
  createCues_fn = function() {
    __privateSet(this, _cues, { id: 475249515 /* Cues */, data: [] });
  };
  _maybeFlushStreamingTargetWriter = new WeakSet();
  maybeFlushStreamingTargetWriter_fn = function() {
    if (__privateGet(this, _writer) instanceof StreamTargetWriter) {
      __privateGet(this, _writer).flush();
    }
  };
  _segmentDataOffset = new WeakSet();
  segmentDataOffset_get = function() {
    return __privateGet(this, _writer).dataOffsets.get(__privateGet(this, _segment));
  };
  _writeVideoDecoderConfig = new WeakSet();
  writeVideoDecoderConfig_fn = function(meta) {
    if (!meta.decoderConfig)
      return;
    if (meta.decoderConfig.colorSpace) {
      let colorSpace = meta.decoderConfig.colorSpace;
      __privateSet(this, _colorSpace, colorSpace);
      __privateGet(this, _colourElement).data = [
        { id: 21937 /* MatrixCoefficients */, data: {
          "rgb": 1,
          "bt709": 1,
          "bt470bg": 5,
          "smpte170m": 6
        }[colorSpace.matrix] },
        { id: 21946 /* TransferCharacteristics */, data: {
          "bt709": 1,
          "smpte170m": 6,
          "iec61966-2-1": 13
        }[colorSpace.transfer] },
        { id: 21947 /* Primaries */, data: {
          "bt709": 1,
          "bt470bg": 5,
          "smpte170m": 6
        }[colorSpace.primaries] },
        { id: 21945 /* Range */, data: [1, 2][Number(colorSpace.fullRange)] }
      ];
      if (!__privateGet(this, _options).streaming) {
        let endPos = __privateGet(this, _writer).pos;
        __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(__privateGet(this, _colourElement)));
        __privateGet(this, _writer).writeEBML(__privateGet(this, _colourElement));
        __privateGet(this, _writer).seek(endPos);
      }
    }
    if (meta.decoderConfig.description) {
      if (__privateGet(this, _options).streaming) {
        __privateSet(this, _videoCodecPrivate, __privateMethod(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
      } else {
        __privateMethod(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet(this, _videoCodecPrivate), meta.decoderConfig.description);
      }
    }
  };
  _fixVP9ColorSpace = new WeakSet();
  fixVP9ColorSpace_fn = function(chunk) {
    if (chunk.type !== "key")
      return;
    if (!__privateGet(this, _colorSpace))
      return;
    let i = 0;
    if (readBits(chunk.data, 0, 2) !== 2)
      return;
    i += 2;
    let profile = (readBits(chunk.data, i + 1, i + 2) << 1) + readBits(chunk.data, i + 0, i + 1);
    i += 2;
    if (profile === 3)
      i++;
    let showExistingFrame = readBits(chunk.data, i + 0, i + 1);
    i++;
    if (showExistingFrame)
      return;
    let frameType = readBits(chunk.data, i + 0, i + 1);
    i++;
    if (frameType !== 0)
      return;
    i += 2;
    let syncCode = readBits(chunk.data, i + 0, i + 24);
    i += 24;
    if (syncCode !== 4817730)
      return;
    if (profile >= 2)
      i++;
    let colorSpaceID = {
      "rgb": 7,
      "bt709": 2,
      "bt470bg": 1,
      "smpte170m": 3
    }[__privateGet(this, _colorSpace).matrix];
    writeBits(chunk.data, i + 0, i + 3, colorSpaceID);
  };
  _writeSubtitleChunks = new WeakSet();
  writeSubtitleChunks_fn = function() {
    let lastWrittenMediaTimestamp = Math.min(
      __privateGet(this, _options).video ? __privateGet(this, _lastVideoTimestamp) : Infinity,
      __privateGet(this, _options).audio ? __privateGet(this, _lastAudioTimestamp) : Infinity
    );
    let queue = __privateGet(this, _subtitleChunkQueue);
    while (queue.length > 0 && queue[0].timestamp <= lastWrittenMediaTimestamp) {
      __privateMethod(this, _writeBlock, writeBlock_fn).call(this, queue.shift(), !__privateGet(this, _options).video && !__privateGet(this, _options).audio);
    }
  };
  _createInternalChunk = new WeakSet();
  createInternalChunk_fn = function(data, type, timestamp, trackNumber, duration, additions) {
    let adjustedTimestamp = __privateMethod(this, _validateTimestamp, validateTimestamp_fn).call(this, timestamp, trackNumber);
    let internalChunk = {
      data,
      additions,
      type,
      timestamp: adjustedTimestamp,
      duration,
      trackNumber
    };
    return internalChunk;
  };
  _validateTimestamp = new WeakSet();
  validateTimestamp_fn = function(timestamp, trackNumber) {
    let lastTimestamp = trackNumber === VIDEO_TRACK_NUMBER ? __privateGet(this, _lastVideoTimestamp) : trackNumber === AUDIO_TRACK_NUMBER ? __privateGet(this, _lastAudioTimestamp) : __privateGet(this, _lastSubtitleTimestamp);
    if (trackNumber !== SUBTITLE_TRACK_NUMBER) {
      let firstTimestamp = trackNumber === VIDEO_TRACK_NUMBER ? __privateGet(this, _firstVideoTimestamp) : __privateGet(this, _firstAudioTimestamp);
      if (__privateGet(this, _options).firstTimestampBehavior === "strict" && lastTimestamp === -1 && timestamp !== 0) {
        throw new Error(
          `The first chunk for your media track must have a timestamp of 0 (received ${timestamp}). Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of the document, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
If you want to allow non-zero first timestamps, set firstTimestampBehavior: 'permissive'.
`
        );
      } else if (__privateGet(this, _options).firstTimestampBehavior === "offset") {
        timestamp -= firstTimestamp;
      }
    }
    if (timestamp < lastTimestamp) {
      throw new Error(
        `Timestamps must be monotonically increasing (went from ${lastTimestamp} to ${timestamp}).`
      );
    }
    if (timestamp < 0) {
      throw new Error(`Timestamps must be non-negative (received ${timestamp}).`);
    }
    return timestamp;
  };
  _writeBlock = new WeakSet();
  writeBlock_fn = function(chunk, canCreateNewCluster) {
    if (__privateGet(this, _options).streaming && !__privateGet(this, _tracksElement)) {
      __privateMethod(this, _createTracks, createTracks_fn).call(this);
      __privateMethod(this, _createSegment, createSegment_fn).call(this);
    }
    let msTimestamp = Math.floor(chunk.timestamp / 1e3);
    let relativeTimestamp = msTimestamp - __privateGet(this, _currentClusterTimestamp);
    let shouldCreateNewClusterFromKeyFrame = canCreateNewCluster && chunk.type === "key" && relativeTimestamp >= 1e3;
    let clusterWouldBeTooLong = relativeTimestamp >= MAX_CHUNK_LENGTH_MS;
    if (!__privateGet(this, _currentCluster) || shouldCreateNewClusterFromKeyFrame || clusterWouldBeTooLong) {
      __privateMethod(this, _createNewCluster, createNewCluster_fn).call(this, msTimestamp);
      relativeTimestamp = 0;
    }
    if (relativeTimestamp < 0) {
      return;
    }
    let prelude = new Uint8Array(4);
    let view = new DataView(prelude.buffer);
    view.setUint8(0, 128 | chunk.trackNumber);
    view.setInt16(1, relativeTimestamp, false);
    if (chunk.duration === void 0 && !chunk.additions) {
      view.setUint8(3, Number(chunk.type === "key") << 7);
      let simpleBlock = { id: 163 /* SimpleBlock */, data: [
        prelude,
        chunk.data
      ] };
      __privateGet(this, _writer).writeEBML(simpleBlock);
    } else {
      let msDuration = Math.floor(chunk.duration / 1e3);
      let blockGroup = { id: 160 /* BlockGroup */, data: [
        { id: 161 /* Block */, data: [
          prelude,
          chunk.data
        ] },
        chunk.duration !== void 0 ? { id: 155 /* BlockDuration */, data: msDuration } : null,
        chunk.additions ? { id: 30113 /* BlockAdditions */, data: chunk.additions } : null
      ] };
      __privateGet(this, _writer).writeEBML(blockGroup);
    }
    __privateSet(this, _duration, Math.max(__privateGet(this, _duration), msTimestamp));
  };
  _createCodecPrivateElement = new WeakSet();
  createCodecPrivateElement_fn = function(data) {
    return { id: 25506 /* CodecPrivate */, size: 4, data: new Uint8Array(data) };
  };
  _writeCodecPrivate = new WeakSet();
  writeCodecPrivate_fn = function(element, data) {
    let endPos = __privateGet(this, _writer).pos;
    __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(element));
    let codecPrivateElementSize = 2 + 4 + data.byteLength;
    let voidDataSize = CODEC_PRIVATE_MAX_SIZE - codecPrivateElementSize;
    if (voidDataSize < 0) {
      let newByteLength = data.byteLength + voidDataSize;
      if (data instanceof ArrayBuffer) {
        data = data.slice(0, newByteLength);
      } else {
        data = data.buffer.slice(0, newByteLength);
      }
      voidDataSize = 0;
    }
    element = [
      __privateMethod(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, data),
      { id: 236 /* Void */, size: 4, data: new Uint8Array(voidDataSize) }
    ];
    __privateGet(this, _writer).writeEBML(element);
    __privateGet(this, _writer).seek(endPos);
  };
  _createNewCluster = new WeakSet();
  createNewCluster_fn = function(timestamp) {
    if (__privateGet(this, _currentCluster)) {
      __privateMethod(this, _finalizeCurrentCluster, finalizeCurrentCluster_fn).call(this);
    }
    if (__privateGet(this, _writer) instanceof BaseStreamTargetWriter && __privateGet(this, _writer).target.options.onCluster) {
      __privateGet(this, _writer).startTrackingWrites();
    }
    __privateSet(this, _currentCluster, {
      id: 524531317 /* Cluster */,
      size: __privateGet(this, _options).streaming ? -1 : CLUSTER_SIZE_BYTES,
      data: [
        { id: 231 /* Timestamp */, data: timestamp }
      ]
    });
    __privateGet(this, _writer).writeEBML(__privateGet(this, _currentCluster));
    __privateSet(this, _currentClusterTimestamp, timestamp);
    let clusterOffsetFromSegment = __privateGet(this, _writer).offsets.get(__privateGet(this, _currentCluster)) - __privateGet(this, _segmentDataOffset, segmentDataOffset_get);
    __privateGet(this, _cues).data.push({ id: 187 /* CuePoint */, data: [
      { id: 179 /* CueTime */, data: timestamp },
      __privateGet(this, _options).video ? { id: 183 /* CueTrackPositions */, data: [
        { id: 247 /* CueTrack */, data: VIDEO_TRACK_NUMBER },
        { id: 241 /* CueClusterPosition */, data: clusterOffsetFromSegment }
      ] } : null,
      __privateGet(this, _options).audio ? { id: 183 /* CueTrackPositions */, data: [
        { id: 247 /* CueTrack */, data: AUDIO_TRACK_NUMBER },
        { id: 241 /* CueClusterPosition */, data: clusterOffsetFromSegment }
      ] } : null
    ] });
  };
  _finalizeCurrentCluster = new WeakSet();
  finalizeCurrentCluster_fn = function() {
    if (!__privateGet(this, _options).streaming) {
      let clusterSize = __privateGet(this, _writer).pos - __privateGet(this, _writer).dataOffsets.get(__privateGet(this, _currentCluster));
      let endPos = __privateGet(this, _writer).pos;
      __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(__privateGet(this, _currentCluster)) + 4);
      __privateGet(this, _writer).writeEBMLVarInt(clusterSize, CLUSTER_SIZE_BYTES);
      __privateGet(this, _writer).seek(endPos);
    }
    if (__privateGet(this, _writer) instanceof BaseStreamTargetWriter && __privateGet(this, _writer).target.options.onCluster) {
      let { data, start } = __privateGet(this, _writer).getTrackedWrites();
      __privateGet(this, _writer).target.options.onCluster(data, start, __privateGet(this, _currentClusterTimestamp));
    }
  };
  _ensureNotFinalized = new WeakSet();
  ensureNotFinalized_fn = function() {
    if (__privateGet(this, _finalized)) {
      throw new Error("Cannot add new video or audio chunks after the file has been finalized.");
    }
  };

  // src/subtitles.ts
  var cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
  var preambleStartRegex = /^WEBVTT.*?\n{2}/;
  var timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
  var inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;
  var textEncoder = new TextEncoder();
  var _options2, _config, _preambleSeen, _preambleBytes, _preambleEmitted, _parseTimestamp, parseTimestamp_fn, _formatTimestamp, formatTimestamp_fn;
  var SubtitleEncoder = class {
    constructor(options) {
      __privateAdd(this, _parseTimestamp);
      __privateAdd(this, _formatTimestamp);
      __privateAdd(this, _options2, void 0);
      __privateAdd(this, _config, void 0);
      __privateAdd(this, _preambleSeen, false);
      __privateAdd(this, _preambleBytes, void 0);
      __privateAdd(this, _preambleEmitted, false);
      __privateSet(this, _options2, options);
    }
    configure(config) {
      if (config.codec !== "webvtt") {
        throw new Error("Codec must be 'webvtt'.");
      }
      __privateSet(this, _config, config);
    }
    encode(text) {
      if (!__privateGet(this, _config)) {
        throw new Error("Encoder not configured.");
      }
      text = text.replace("\r\n", "\n").replace("\r", "\n");
      cueBlockHeaderRegex.lastIndex = 0;
      let match;
      if (!__privateGet(this, _preambleSeen)) {
        if (!preambleStartRegex.test(text)) {
          let error = new Error("WebVTT preamble incorrect.");
          __privateGet(this, _options2).error(error);
          throw error;
        }
        match = cueBlockHeaderRegex.exec(text);
        let preamble = text.slice(0, match?.index ?? text.length).trimEnd();
        if (!preamble) {
          let error = new Error("No WebVTT preamble provided.");
          __privateGet(this, _options2).error(error);
          throw error;
        }
        __privateSet(this, _preambleBytes, textEncoder.encode(preamble));
        __privateSet(this, _preambleSeen, true);
        if (match) {
          text = text.slice(match.index);
          cueBlockHeaderRegex.lastIndex = 0;
        }
      }
      while (match = cueBlockHeaderRegex.exec(text)) {
        let notes = text.slice(0, match.index);
        let cueIdentifier = match[1] || "";
        let matchEnd = match.index + match[0].length;
        let bodyStart = text.indexOf("\n", matchEnd) + 1;
        let cueSettings = text.slice(matchEnd, bodyStart).trim();
        let bodyEnd = text.indexOf("\n\n", matchEnd);
        if (bodyEnd === -1)
          bodyEnd = text.length;
        let startTime = __privateMethod(this, _parseTimestamp, parseTimestamp_fn).call(this, match[2]);
        let endTime = __privateMethod(this, _parseTimestamp, parseTimestamp_fn).call(this, match[3]);
        let duration = endTime - startTime;
        let body = text.slice(bodyStart, bodyEnd);
        let additions = `${cueSettings}
${cueIdentifier}
${notes}`;
        inlineTimestampRegex.lastIndex = 0;
        body = body.replace(inlineTimestampRegex, (match2) => {
          let time = __privateMethod(this, _parseTimestamp, parseTimestamp_fn).call(this, match2.slice(1, -1));
          let offsetTime = time - startTime;
          return `<${__privateMethod(this, _formatTimestamp, formatTimestamp_fn).call(this, offsetTime)}>`;
        });
        text = text.slice(bodyEnd).trimStart();
        cueBlockHeaderRegex.lastIndex = 0;
        let chunk = {
          body: textEncoder.encode(body),
          additions: additions.trim() === "" ? void 0 : textEncoder.encode(additions),
          timestamp: startTime * 1e3,
          duration: duration * 1e3
        };
        let meta = {};
        if (!__privateGet(this, _preambleEmitted)) {
          meta.decoderConfig = {
            description: __privateGet(this, _preambleBytes)
          };
          __privateSet(this, _preambleEmitted, true);
        }
        __privateGet(this, _options2).output(chunk, meta);
      }
    }
  };
  _options2 = new WeakMap();
  _config = new WeakMap();
  _preambleSeen = new WeakMap();
  _preambleBytes = new WeakMap();
  _preambleEmitted = new WeakMap();
  _parseTimestamp = new WeakSet();
  parseTimestamp_fn = function(string) {
    let match = timestampRegex.exec(string);
    if (!match)
      throw new Error("Expected match.");
    return 60 * 60 * 1e3 * Number(match[1] || "0") + 60 * 1e3 * Number(match[2]) + 1e3 * Number(match[3]) + Number(match[4]);
  };
  _formatTimestamp = new WeakSet();
  formatTimestamp_fn = function(timestamp) {
    let hours = Math.floor(timestamp / (60 * 60 * 1e3));
    let minutes = Math.floor(timestamp % (60 * 60 * 1e3) / (60 * 1e3));
    let seconds = Math.floor(timestamp % (60 * 1e3) / 1e3);
    let milliseconds = timestamp % 1e3;
    return hours.toString().padStart(2, "0") + ":" + minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0") + "." + milliseconds.toString().padStart(3, "0");
  };
  return __toCommonJS(src_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, WebMMuxer)



/* ===== 内联 HEVC 软解：@hevcjs/core 1.9.1 hevc-decode.js（MIT）===== */
var HEVCDecoderModule=(()=>{var _scriptName=globalThis.document?.currentScript?.src;return async function(moduleArg={}){var Module=moduleArg;(function(){function humanReadableVersionToPacked(str){str=str.split("-")[0];var vers=str.split(".").slice(0,3);while(vers.length<3)vers.push("00");vers=vers.map((n,i,arr)=>n.padStart(2,"0"));return vers.join("")}var packedVersionToHumanReadable=n=>[n/1e4|0,(n/100|0)%100,n%100].join(".");var TARGET_NOT_SUPPORTED=2147483647;if(typeof process!=="undefined"&&!process.versions?.bun&&typeof Deno=="undefined"){var currentNodeVersion=process.versions?.node?humanReadableVersionToPacked(process.versions.node):TARGET_NOT_SUPPORTED;if(currentNodeVersion<180300){throw new Error(`This emscripten-generated code requires node v${packedVersionToHumanReadable(180300)} (detected v${packedVersionToHumanReadable(currentNodeVersion)})`)}}var userAgent=typeof navigator!=="undefined"&&navigator.userAgent;if(!userAgent){return}var currentSafariVersion=userAgent.includes("Safari/")&&!userAgent.includes("Chrome/")&&userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/)?humanReadableVersionToPacked(userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/)[1]):TARGET_NOT_SUPPORTED;if(currentSafariVersion<15e4){throw new Error(`This emscripten-generated code requires Safari v${packedVersionToHumanReadable(15e4)} (detected v${currentSafariVersion})`)}var currentFirefoxVersion=userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/)?parseFloat(userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]):TARGET_NOT_SUPPORTED;if(currentFirefoxVersion<79){throw new Error(`This emscripten-generated code requires Firefox v79 (detected v${currentFirefoxVersion})`)}var currentChromeVersion=userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/)?parseFloat(userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]):TARGET_NOT_SUPPORTED;if(currentChromeVersion<85){throw new Error(`This emscripten-generated code requires Chrome v85 (detected v${currentChromeVersion})`)}})();var ENVIRONMENT_IS_WEB=!!globalThis.window;var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";var ENVIRONMENT_IS_SHELL=!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_NODE&&!ENVIRONMENT_IS_WORKER;var programArgs=[];var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};if(typeof __filename!="undefined"){_scriptName=__filename}else if(ENVIRONMENT_IS_WORKER){_scriptName=self.location.href}var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var readAsync,readBinary;if(ENVIRONMENT_IS_NODE){const isNode=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";if(!isNode)throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");var fs=require("node:fs");scriptDirectory=__dirname+"/";readBinary=filename=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename);assert(Buffer.isBuffer(ret));return ret};readAsync=async(filename,binary=true)=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename,binary?undefined:"utf8");assert(binary?Buffer.isBuffer(ret):typeof ret=="string");return ret};if(process.argv.length>1){thisProgram=process.argv[1].replace(/\\/g,"/")}programArgs=process.argv.slice(2);quit_=(status,toThrow)=>{process.exitCode=status;throw toThrow}}else if(ENVIRONMENT_IS_SHELL){}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){try{scriptDirectory=new URL(".",_scriptName).href}catch{}if(!(globalThis.window||globalThis.WorkerGlobalScope))throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");{if(ENVIRONMENT_IS_WORKER){readBinary=url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)}}readAsync=async url=>{if(isFileURI(url)){return new Promise((resolve,reject)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=()=>{if(xhr.status==200||xhr.status==0&&xhr.response){resolve(xhr.response);return}reject(xhr.status)};xhr.onerror=reject;xhr.send(null)})}var response=await fetch(url,{credentials:"same-origin"});if(response.ok){return response.arrayBuffer()}throw new Error(response.status+" : "+response.url)}}}else{throw new Error("environment detection error")}var out=console.log.bind(console);var err=console.error.bind(console);assert(!ENVIRONMENT_IS_SHELL,"shell environment detected but not enabled at build time (add `shell` to `-sENVIRONMENT` to enable)");var wasmBinary;if(!globalThis.WebAssembly){err("no native wasm support detected")}var ABORT=false;function assert(condition,text){if(!condition){abort("Assertion failed"+(text?": "+text:""))}}var isFileURI=filename=>filename.startsWith("file://");class EmscriptenEH extends Error{}class EmscriptenSjLj extends EmscriptenEH{}class CppException extends EmscriptenEH{constructor(excPtr){super(excPtr);this.excPtr=excPtr;const excInfo=getExceptionMessage(this);this.name=excInfo[0];this.message=excInfo[1]}}var runtimeDebug=true;(()=>{var h16=new Int16Array(1);var h8=new Int8Array(h16.buffer);h16[0]=25459;if(h8[0]!==115||h8[1]!==99)abort("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)")})();function consumedModuleProp(prop){var value=Module[prop];var msg=`Attempt to modify \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`;if(Array.isArray(value)){value=new Proxy(value,{set(target,key,val){abort(msg);return false},defineProperty(target,key,descriptor){abort(msg);return false},deleteProperty(target,key){abort(msg);return false}})}Object.defineProperty(Module,prop,{configurable:true,get(){return value},set(){abort(msg)}})}function makeInvalidEarlyAccess(name){return()=>assert(false,`call to '${name}' via reference taken before Wasm module initialization`)}function ignoredModuleProp(prop){if(Object.getOwnPropertyDescriptor(Module,prop)){abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`)}}function isExportedByForceFilesystem(name){return name==="FS_createPath"||name==="FS_createDataFile"||name==="FS_createPreloadedFile"||name==="FS_preloadFile"||name==="FS_unlink"||name==="addRunDependency"||name==="FS_createLazyFile"||name==="FS_createDevice"||name==="removeRunDependency"}function missingLibrarySymbol(sym){unexportedRuntimeSymbol(sym)}function unexportedRuntimeSymbol(sym){if(!Object.getOwnPropertyDescriptor(Module,sym)){Object.defineProperty(Module,sym,{configurable:true,get(){var msg=`'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;if(isExportedByForceFilesystem(sym)){msg+=". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you"}abort(msg)}})}}const stackCookie1=34821223;const stackCookie2=2310721022;function writeStackCookie(){var max=_emscripten_stack_get_end();assert((max&3)==0);if(max==0){max+=4}HEAPU32[max>>2]=stackCookie1;HEAPU32[max+4>>2]=stackCookie2;HEAPU32[0>>2]=1668509029}function u32ToHexString(num){return"0x"+(num>>>0).toString(16).padStart(8,"0")}function checkStackCookie(){if(ABORT)return;var max=_emscripten_stack_get_end();if(max==0){max+=4}var val1=HEAPU32[max>>2];var val2=HEAPU32[max+4>>2];if(val1!=stackCookie1||val2!=stackCookie2){abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords ${u32ToHexString(stackCookie2)} and ${u32ToHexString(stackCookie1)}, but received ${u32ToHexString(val2)} ${u32ToHexString(val1)}`)}if(HEAPU32[0>>2]!=1668509029){abort("Runtime error: The application has corrupted its heap memory area (address zero)!")}}var runtimeInitialized=false;function getMemoryBuffer(){return wasmMemory.buffer}function updateMemoryViews(){if(HEAP8?.buffer?.resizable)return;var b=getMemoryBuffer();HEAP8=new Int8Array(b);HEAP16=new Int16Array(b);Module["HEAPU8"]=HEAPU8=new Uint8Array(b);Module["HEAPU16"]=HEAPU16=new Uint16Array(b);HEAP32=new Int32Array(b);HEAPU32=new Uint32Array(b);HEAPF32=new Float32Array(b);HEAPF64=new Float64Array(b);HEAP64=new BigInt64Array(b)}assert(globalThis.Int32Array&&globalThis.Float64Array&&Int32Array.prototype.subarray&&Int32Array.prototype.set,"JS engine does not provide full typed array support");function preRun(){var preRun=Module["preRun"];if(preRun){if(typeof preRun=="function")preRun=[preRun];onPreRuns.push(...preRun)}consumedModuleProp("preRun");callRuntimeCallbacks(onPreRuns)}function initRuntime(){assert(!runtimeInitialized);runtimeInitialized=true;checkStackCookie();wasmExports["__wasm_call_ctors"]();checkStackCookie()}function postRun(){checkStackCookie();var postRun=Module["postRun"];if(postRun){if(typeof postRun=="function")postRun=[postRun];onPostRuns.push(...postRun)}consumedModuleProp("postRun");callRuntimeCallbacks(onPostRuns)}function abort(what){Module["onAbort"]?.(what);what=`Aborted(${what})`;err(what);ABORT=true;var e=new WebAssembly.RuntimeError(what);throw e}function fsMissing(){abort("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM")}var FS={init:fsMissing,createDataFile:fsMissing,createPreloadedFile:fsMissing,createLazyFile:fsMissing,open:fsMissing,mkdev:fsMissing,registerDevice:fsMissing,analyzePath:fsMissing,ErrnoError:fsMissing};function createExportWrapper(name,func,nargs){assert(func);return(...args)=>{assert(runtimeInitialized,`native function \`${name}\` called before runtime initialization`);assert(args.length<=nargs,`native function \`${name}\` called with ${args.length} args but expects ${nargs}`);return func(...args)}}var wasmBinaryFile;function findWasmBinary(){return locateFile("hevc-decode.wasm")}function getBinarySync(file){if(readBinary){return readBinary(file)}throw"both async and sync fetching of the wasm failed"}async function getWasmBinary(binaryFile){if(!wasmBinary){try{var response=await readAsync(binaryFile);return new Uint8Array(response)}catch{}}return getBinarySync(binaryFile)}async function instantiateArrayBuffer(binaryFile,imports){try{var binary=await getWasmBinary(binaryFile);var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){err(`failed to asynchronously prepare wasm: ${reason}`);if(isFileURI(binaryFile)){err(`warning: Loading from a file URI (${binaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`)}abort(reason)}}async function instantiateAsync(binary,binaryFile,imports){if(!binary&&!isFileURI(binaryFile)&&!ENVIRONMENT_IS_NODE){try{var response=fetch(binaryFile,{credentials:"same-origin"});var instantiationResult=await WebAssembly.instantiateStreaming(response,imports);return instantiationResult}catch(reason){err(`wasm streaming compile failed: ${reason}`);err("falling back to ArrayBuffer instantiation")}}return instantiateArrayBuffer(binaryFile,imports)}function getWasmImports(){var imports={env:wasmImports,wasi_snapshot_preview1:wasmImports};return imports}async function createWasm(){function receiveInstance(instance){wasmExports=instance.exports;assignWasmExports(wasmExports);updateMemoryViews();return wasmExports}var trueModule=Module;function receiveInstantiationResult(result){assert(Module===trueModule,"the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");trueModule=null;return receiveInstance(result["instance"])}var info=getWasmImports();var instantiateWasm=Module["instantiateWasm"];if(instantiateWasm){return new Promise(resolve=>{try{instantiateWasm(info,inst=>resolve(receiveInstance(inst)))}catch(e){err(`Module.instantiateWasm callback failed with error: ${e}`);throw e}})}wasmBinaryFile??=findWasmBinary();var result=await instantiateAsync(wasmBinary,wasmBinaryFile,info);var exports=receiveInstantiationResult(result);return exports}class ExitStatus{name="ExitStatus";constructor(status){this.message=`Program terminated with exit(${status})`;this.status=status}}var HEAP32;var HEAP8;var HEAPU32;var callRuntimeCallbacks=callbacks=>{while(callbacks.length>0){callbacks.shift()(Module)}};var onPostRuns=[];var onPreRuns=[];var noExitRuntime=true;function ptrToString(ptr){assert(typeof ptr==="number",`ptrToString expects a number, got ${typeof ptr}`);ptr>>>=0;return"0x"+ptr.toString(16).padStart(8,"0")}var stackRestore=val=>__emscripten_stack_restore(val);var stackSave=()=>_emscripten_stack_get_current();var warnOnce=text=>{warnOnce.shown||={};if(!warnOnce.shown[text]){warnOnce.shown[text]=1;if(ENVIRONMENT_IS_NODE)text="warning: "+text;err(text)}};var UTF8Decoder=globalThis.TextDecoder&&new TextDecoder;var findStringEnd=(heapOrArray,idx,maxBytesToRead,ignoreNul)=>{var maxIdx=idx+maxBytesToRead;if(ignoreNul)return maxIdx;while(heapOrArray[idx]&&!(idx>=maxIdx))++idx;return idx};var UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead,ignoreNul)=>{var endPtr=findStringEnd(heapOrArray,idx,maxBytesToRead,ignoreNul);if(endPtr-idx>16&&heapOrArray.buffer&&UTF8Decoder){return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))}var str="";while(idx<endPtr){var u0=heapOrArray[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heapOrArray[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heapOrArray[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2}else{if((u0&248)!=240)warnOnce(`Invalid UTF-8 leading byte ${ptrToString(u0)} encountered when deserializing a UTF-8 string in wasm memory to a JS string!`);u0=(u0&7)<<18|u1<<12|u2<<6|heapOrArray[idx++]&63}if(u0<65536){str+=String.fromCharCode(u0)}else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}return str};var HEAPU8;var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>{assert(typeof ptr=="number",`UTF8ToString expects a number (got ${typeof ptr})`);return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead,ignoreNul):""};var ___assert_fail=(condition,filename,line,func)=>abort(`Assertion failed: ${UTF8ToString(condition)}, at: `+[filename?UTF8ToString(filename):"unknown filename",line,func?UTF8ToString(func):"unknown function"]);var exceptionCaught=[];var uncaughtExceptionCount=0;var ___cxa_begin_catch=ptr=>{var info=new ExceptionInfo(ptr);if(!info.get_caught()){info.set_caught(true);uncaughtExceptionCount--}info.set_rethrown(false);exceptionCaught.push(info);return ___cxa_get_exception_ptr(ptr)};var exceptionLast=null;var ___cxa_end_catch=()=>{_setThrew(0,0);assert(exceptionCaught.length>0);var info=exceptionCaught.pop();___cxa_decrement_exception_refcount(info.excPtr);exceptionLast=null};class ExceptionInfo{constructor(excPtr){this.excPtr=excPtr;this.ptr=excPtr-24}set_type(type){HEAPU32[this.ptr+4>>2]=type}get_type(){return HEAPU32[this.ptr+4>>2]}set_destructor(destructor){HEAPU32[this.ptr+8>>2]=destructor}get_destructor(){return HEAPU32[this.ptr+8>>2]}set_caught(caught){caught=caught?1:0;HEAP8[this.ptr+12]=caught}get_caught(){return HEAP8[this.ptr+12]!=0}set_rethrown(rethrown){rethrown=rethrown?1:0;HEAP8[this.ptr+13]=rethrown}get_rethrown(){return HEAP8[this.ptr+13]!=0}init(type,destructor){this.set_adjusted_ptr(0);this.set_type(type);this.set_destructor(destructor)}set_adjusted_ptr(adjustedPtr){HEAPU32[this.ptr+16>>2]=adjustedPtr}get_adjusted_ptr(){return HEAPU32[this.ptr+16>>2]}}var setTempRet0=val=>__emscripten_tempret_set(val);var findMatchingCatch=args=>{var thrown=exceptionLast?.excPtr;if(!thrown){setTempRet0(0);return 0}var info=new ExceptionInfo(thrown);info.set_adjusted_ptr(thrown);var thrownType=info.get_type();if(!thrownType){setTempRet0(0);return thrown}for(var caughtType of args){if(!caughtType||caughtType===thrownType){break}var adjusted_ptr_addr=info.ptr+16;if(___cxa_can_catch(caughtType,thrownType,adjusted_ptr_addr)){setTempRet0(caughtType);return thrown}}setTempRet0(thrownType);return thrown};var ___cxa_find_matching_catch_2=()=>findMatchingCatch([]);var ___cxa_find_matching_catch_3=arg0=>findMatchingCatch([arg0]);var stackAlloc=sz=>__emscripten_stack_alloc(sz);var getExceptionMessageCommon=ptr=>{var sp=stackSave();var type_addr_addr=stackAlloc(4);var message_addr_addr=stackAlloc(4);___get_exception_message(ptr,type_addr_addr,message_addr_addr);var type_addr=HEAPU32[type_addr_addr>>2];var message_addr=HEAPU32[message_addr_addr>>2];var type=UTF8ToString(type_addr);_free(type_addr);var message;if(message_addr){message=UTF8ToString(message_addr);_free(message_addr)}stackRestore(sp);return[type,message]};var getExceptionMessage=exn=>getExceptionMessageCommon(exn.excPtr);var __Unwind_RaiseException=ex=>{throw ex};var ___cxa_throw=(ptr,type,destructor)=>{var info=new ExceptionInfo(ptr);info.init(type,destructor);___cxa_increment_exception_refcount(ptr);ptr=exceptionLast=new CppException(ptr);uncaughtExceptionCount++;__Unwind_RaiseException(ptr)};var __Unwind_Resume=ex=>{throw ex};var ___resumeException=ptr=>{ptr=exceptionLast??=new CppException(ptr);__Unwind_Resume(ptr)};var __abort_js=()=>abort("native code called abort()");var getHeapMax=()=>2147483648;var alignMemory=(size,alignment)=>{assert(alignment,"alignment argument is required");return Math.ceil(size/alignment)*alignment};var growMemory=size=>{var oldHeapSize=wasmMemory.buffer.byteLength;var pages=(size-oldHeapSize+65535)/65536|0;try{wasmMemory.grow(pages);updateMemoryViews();return 1}catch(e){err(`growMemory: Attempted to grow heap from ${oldHeapSize} bytes to ${size} bytes, but got error: ${e}`)}};var _emscripten_resize_heap=requestedSize=>{var oldSize=HEAPU8.length;requestedSize>>>=0;assert(requestedSize>oldSize);var maxHeapSize=getHeapMax();if(requestedSize>maxHeapSize){err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignMemory(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=growMemory(newSize);if(replacement){return true}}err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);return false};var _fd_close=fd=>{abort("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM")};var INT53_MAX=9007199254740992;var INT53_MIN=-9007199254740992;var bigintToI53Checked=num=>num<INT53_MIN||num>INT53_MAX?NaN:Number(num);function _fd_seek(fd,offset,whence,newOffset){offset=bigintToI53Checked(offset);return 70}var printCharBuffers=[null,[],[]];var printChar=(stream,curr)=>{var buffer=printCharBuffers[stream];assert(buffer);if(!curr||curr===10){(stream===1?out:err)(UTF8ArrayToString(buffer));buffer.length=0}else{buffer.push(curr)}};var flush_NO_FILESYSTEM=()=>{_fflush(0);if(printCharBuffers[1].length)printChar(1,10);if(printCharBuffers[2].length)printChar(2,10)};var _fd_write=(fd,iov,iovcnt,pnum)=>{var num=0;for(var i=0;i<iovcnt;i++){var ptr=HEAPU32[iov>>2];var len=HEAPU32[iov+4>>2];iov+=8;for(var j=0;j<len;j++){printChar(fd,HEAPU8[ptr+j])}num+=len}HEAPU32[pnum>>2]=num;return 0};var wasmTableMirror=[];var getWasmTableEntry=funcPtr=>{var func=wasmTableMirror[funcPtr];if(!func){wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr)}assert(wasmTable.get(funcPtr)==func,"table mirror is out of date");return func};var getCFunc=ident=>{var func=Module["_"+ident];assert(func,`Cannot call unknown function ${ident}, make sure it is exported`);return func};var writeArrayToMemory=(array,buffer)=>{assert(array.length>=0,"writeArrayToMemory array must have a length (should be an array or typed array)");HEAP8.set(array,buffer)};var lengthBytesUTF8=str=>{var len=0;for(var i=0;i<str.length;++i){var c=str.charCodeAt(i);if(c<=127){len++}else if(c<=2047){len+=2}else if(c>=55296&&c<=57343){len+=4;++i}else{len+=3}}return len};var stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{assert(typeof str==="string",`stringToUTF8Array expects a string (got ${typeof str})`);if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.codePointAt(i);if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63}else{if(outIdx+3>=endIdx)break;if(u>1114111)warnOnce(`Invalid Unicode code point ${ptrToString(u)} encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).`);heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;i++}}heap[outIdx]=0;return outIdx-startIdx};var stringToUTF8=(str,outPtr,maxBytesToWrite)=>{assert(typeof maxBytesToWrite=="number","stringToUTF8 requires a third parameter that specifies the length of the output buffer");return stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite)};var stringToUTF8OnStack=str=>{var size=lengthBytesUTF8(str)+1;var ret=stackAlloc(size);stringToUTF8(str,ret,size);return ret};var ccall=(ident,returnType,argTypes,args,opts)=>{var toC={string:str=>{var ret=0;if(str!==null&&str!==undefined&&str!==0){ret=stringToUTF8OnStack(str)}return ret},array:arr=>{var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string"){return UTF8ToString(ret)}if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;assert(returnType!=="array",'return type should not be "array"');if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(!stack)stack=stackSave();cArgs[i]=converter(args[i])}else{cArgs[i]=args[i]}}}var ret=func(...cArgs);function onDone(ret){if(stack)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret};var cwrap=(ident,returnType,argTypes,opts)=>(...args)=>ccall(ident,returnType,argTypes,args,opts);var HEAP16;var HEAPF32;var HEAPF64;var HEAP64;function getValue(ptr,type="i8"){if(type.endsWith("*"))type="*";switch(type){case"i1":return HEAP8[ptr];case"i8":return HEAP8[ptr];case"i16":return HEAP16[ptr>>1];case"i32":return HEAP32[ptr>>2];case"i64":return HEAP64[ptr>>3];case"float":return HEAPF32[ptr>>2];case"double":return HEAPF64[ptr>>3];case"*":return HEAPU32[ptr>>2];default:abort(`invalid type for getValue: ${type}`)}}var HEAPU16;{if(Module["noExitRuntime"])noExitRuntime=Module["noExitRuntime"];if(Module["print"])out=Module["print"];if(Module["printErr"])err=Module["printErr"];Module["FS_createDataFile"]=FS.createDataFile;Module["FS_createPreloadedFile"]=FS.createPreloadedFile;checkIncomingModuleAPI();if(Module["arguments"])programArgs=Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];assert(typeof Module["memoryInitializerPrefixURL"]=="undefined","Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");assert(typeof Module["pthreadMainPrefixURL"]=="undefined","Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");assert(typeof Module["cdInitializerPrefixURL"]=="undefined","Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");assert(typeof Module["filePackagePrefixURL"]=="undefined","Module.filePackagePrefixURL option was removed, use Module.locateFile instead");assert(typeof Module["read"]=="undefined","Module.read option was removed");assert(typeof Module["readAsync"]=="undefined","Module.readAsync option was removed (modify readAsync in JS)");assert(typeof Module["readBinary"]=="undefined","Module.readBinary option was removed (modify readBinary in JS)");assert(typeof Module["setWindowTitle"]=="undefined","Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");assert(typeof Module["TOTAL_MEMORY"]=="undefined","Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");assert(typeof Module["ENVIRONMENT"]=="undefined","Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");assert(typeof Module["STACK_SIZE"]=="undefined","STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");assert(typeof Module["wasmMemory"]=="undefined","Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");assert(typeof Module["INITIAL_MEMORY"]=="undefined","Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");var preInit=Module["preInit"];if(preInit){if(typeof preInit=="function")Module["preInit"]=preInit=[preInit];while(preInit.length>0){preInit.shift()()}}consumedModuleProp("preInit")}Module["ccall"]=ccall;Module["cwrap"]=cwrap;Module["getValue"]=getValue;var missingLibrarySymbols=["writeI53ToI64","writeI53ToI64Clamped","writeI53ToI64Signaling","writeI53ToU64Clamped","writeI53ToU64Signaling","readI53FromI64","readI53FromU64","convertI32PairToI53","convertI32PairToI53Checked","convertU32PairToI53","getTempRet0","createNamedFunction","zeroMemory","exitJS","withStackSave","strError","inetPton4","inetNtop4","inetPton6","inetNtop6","readSockaddr","writeSockaddr","readEmAsmArgs","jstoi_q","getExecutableName","autoResumeAudioContext","getDynCaller","dynCall","handleException","keepRuntimeAlive","runtimeKeepalivePush","runtimeKeepalivePop","callUserCallback","maybeExit","asyncLoad","asmjsMangle","mmapAlloc","HandleAllocator","getUniqueRunDependency","addRunDependency","removeRunDependency","addOnInit","addOnPostCtor","addOnPreMain","addOnExit","STACK_SIZE","STACK_ALIGN","POINTER_SIZE","ASSERTIONS","convertJsFunctionToWasm","getEmptyTableSlot","updateTableMap","getFunctionAddress","addFunction","removeFunction","setValue","intArrayFromString","intArrayToString","AsciiToString","stringToAscii","UTF16ToString","stringToUTF16","lengthBytesUTF16","UTF32ToString","stringToUTF32","lengthBytesUTF32","stringToNewUTF8","registerKeyEventCallback","maybeCStringToJsString","findEventTarget","getBoundingClientRect","fillMouseEventData","registerMouseEventCallback","registerWheelEventCallback","registerUiEventCallback","registerFocusEventCallback","fillDeviceOrientationEventData","registerDeviceOrientationEventCallback","fillDeviceMotionEventData","registerDeviceMotionEventCallback","screenOrientation","fillOrientationChangeEventData","registerOrientationChangeEventCallback","fillFullscreenChangeEventData","registerFullscreenChangeEventCallback","callCanvasResizedCallback","JSEvents_requestFullscreen","JSEvents_resizeCanvasForFullscreen","registerRestoreOldStyle","hideEverythingExceptGivenElement","restoreHiddenElements","setLetterbox","currentFullscreenStrategy","softFullscreenResizeWebGLRenderTarget","doRequestFullscreen","fillPointerlockChangeEventData","registerPointerlockChangeEventCallback","registerPointerlockErrorEventCallback","requestPointerLock","fillVisibilityChangeEventData","registerVisibilityChangeEventCallback","registerTouchEventCallback","fillGamepadEventData","registerGamepadEventCallback","registerBeforeUnloadEventCallback","fillBatteryEventData","registerBatteryEventCallback","setCanvasElementSize","getCanvasElementSize","jsStackTrace","getCallstack","convertPCtoSourceLocation","getEnvStrings","checkWasiClock","wasiRightsToMuslOFlags","wasiOFlagsToMuslOFlags","initRandomFill","randomFill","safeSetTimeout","setImmediateWrapped","safeRequestAnimationFrame","clearImmediateWrapped","registerPostMainLoop","registerPreMainLoop","getPromise","makePromise","addPromise","idsToPromises","makePromiseCallback","incrementUncaughtExceptionCount","decrementUncaughtExceptionCount","Browser_asyncPrepareDataCounter","isLeapYear","ydayFromDate","arraySum","addDays","getSocketFromFD","getSocketAddress","FS_createPreloadedFile","FS_preloadFile","FS_modeStringToFlags","FS_getMode","FS_fileDataToTypedArray","FS_stdin_getChar","FS_mkdirTree","_setNetworkCallback","heapObjectForWebGLType","toTypedArrayIndex","webgl_enable_ANGLE_instanced_arrays","webgl_enable_OES_vertex_array_object","webgl_enable_WEBGL_draw_buffers","webgl_enable_WEBGL_multi_draw","webgl_enable_EXT_polygon_offset_clamp","webgl_enable_EXT_clip_control","webgl_enable_WEBGL_polygon_mode","emscriptenWebGLGet","computeUnpackAlignedImageSize","colorChannelsInGlTextureFormat","emscriptenWebGLGetTexPixelData","emscriptenWebGLGetUniform","webglGetProgramUniformLocation","webglGetUniformLocation","webglPrepareUniformLocationsBeforeFirstUse","webglGetLeftBracePos","emscriptenWebGLGetVertexAttrib","__glGetActiveAttribOrUniform","writeGLArray","registerWebGlEventCallback","runAndAbortIfError","writeStringToMemory","writeAsciiToMemory","allocateUTF8","allocateUTF8OnStack","demangle","stackTrace","getNativeTypeSize"];missingLibrarySymbols.forEach(missingLibrarySymbol);var unexportedSymbols=["run","out","err","callMain","abort","wasmExports","writeStackCookie","checkStackCookie","INT53_MAX","INT53_MIN","bigintToI53Checked","HEAP8","HEAP16","HEAP32","HEAPU32","HEAPF32","HEAPF64","HEAP64","HEAPU64","stackSave","stackRestore","stackAlloc","setTempRet0","ptrToString","getHeapMax","growMemory","ENV","ERRNO_CODES","DNS","Protocols","Sockets","timers","warnOnce","readEmAsmArgsArray","alignMemory","wasmTable","wasmMemory","noExitRuntime","addOnPreRun","addOnPostRun","freeTableIndexes","functionsInTableMap","PATH","PATH_FS","UTF8Decoder","UTF8ArrayToString","UTF8ToString","stringToUTF8Array","stringToUTF8","lengthBytesUTF8","UTF16Decoder","stringToUTF8OnStack","writeArrayToMemory","JSEvents","specialHTMLTargets","findCanvasEventTarget","restoreOldWindowedStyle","UNWIND_CACHE","ExitStatus","flush_NO_FILESYSTEM","emSetImmediate","emClearImmediate_deps","emClearImmediate","promiseMap","uncaughtExceptionCount","exceptionLast","exceptionCaught","ExceptionInfo","findMatchingCatch","getExceptionMessageCommon","incrementExceptionRefcount","decrementExceptionRefcount","getExceptionMessage","Browser","requestFullscreen","setCanvasSize","getUserMedia","createContext","getPreloadedImageData__data","wget","MONTH_DAYS_REGULAR","MONTH_DAYS_LEAP","MONTH_DAYS_REGULAR_CUMULATIVE","MONTH_DAYS_LEAP_CUMULATIVE","SYSCALLS","preloadPlugins","FS_stdin_getChar_buffer","FS_unlink","FS_createPath","FS_createDevice","FS_readFile","FS","FS_root","FS_mounts","FS_devices","FS_streams","FS_nextInode","FS_nameTable","FS_currentPath","FS_initialized","FS_ignorePermissions","FS_filesystems","FS_syncFSRequests","FS_lookupPath","FS_getPath","FS_hashName","FS_hashAddNode","FS_hashRemoveNode","FS_lookupNode","FS_createNode","FS_destroyNode","FS_isRoot","FS_isMountpoint","FS_isFile","FS_isDir","FS_isLink","FS_isChrdev","FS_isBlkdev","FS_isFIFO","FS_isSocket","FS_flagsToPermissionString","FS_nodePermissions","FS_mayLookup","FS_mayCreate","FS_mayDelete","FS_mayOpen","FS_checkOpExists","FS_nextfd","FS_getStreamChecked","FS_getStream","FS_createStream","FS_closeStream","FS_dupStream","FS_doSetAttr","FS_chrdev_stream_ops","FS_major","FS_minor","FS_makedev","FS_registerDevice","FS_getDevice","FS_getMounts","FS_syncfs","FS_mount","FS_unmount","FS_lookup","FS_mknod","FS_statfs","FS_statfsStream","FS_statfsNode","FS_create","FS_mkdir","FS_mkdev","FS_symlink","FS_link","FS_rename","FS_rmdir","FS_readdir","FS_readlink","FS_stat","FS_fstat","FS_lstat","FS_doChmod","FS_chmod","FS_lchmod","FS_fchmod","FS_doChown","FS_chown","FS_lchown","FS_fchown","FS_doTruncate","FS_truncate","FS_ftruncate","FS_utime","FS_open","FS_close","FS_isClosed","FS_llseek","FS_read","FS_write","FS_mmap","FS_msync","FS_ioctl","FS_writeFile","FS_cwd","FS_chdir","FS_createDefaultDirectories","FS_createDefaultDevices","FS_createSpecialDirectories","FS_createStandardStreams","FS_staticInit","FS_init","FS_quit","FS_findObject","FS_analyzePath","FS_createFile","FS_createDataFile","FS_forceLoadFile","FS_createLazyFile","MEMFS","TTY","PIPEFS","SOCKFS","tempFixedLengthArray","miniTempWebGLFloatBuffers","miniTempWebGLIntBuffers","GL","AL","GLUT","EGL","GLEW","IDBStore","SDL","SDL_gfx","print","printErr","jstoi_s"];unexportedSymbols.forEach(unexportedRuntimeSymbol);function checkIncomingModuleAPI(){ignoredModuleProp("fetchSettings");ignoredModuleProp("logReadFiles");ignoredModuleProp("loadSplitModule");ignoredModuleProp("onMalloc");ignoredModuleProp("onRealloc");ignoredModuleProp("onFree");ignoredModuleProp("onSbrkGrow");ignoredModuleProp("onCOSCacheHit");ignoredModuleProp("onCOSCacheMiss");ignoredModuleProp("onCOSStore");ignoredModuleProp("GL_MAX_TEXTURE_IMAGE_UNITS");ignoredModuleProp("SDL_canPlayWithWebAudio");ignoredModuleProp("SDL_numSimultaneouslyQueuedBuffers");ignoredModuleProp("freePreloadedMediaOnUse");ignoredModuleProp("preinitializedWebGLContext");ignoredModuleProp("keyboardListeningElement");ignoredModuleProp("doNotCaptureKeyboard");ignoredModuleProp("extraStackTrace");ignoredModuleProp("preloadPlugins");ignoredModuleProp("preMainLoop");ignoredModuleProp("postMainLoop");ignoredModuleProp("forcedAspectRatio");ignoredModuleProp("mainScriptUrlOrBlob");ignoredModuleProp("onFullScreen");ignoredModuleProp("INITIAL_MEMORY");ignoredModuleProp("wasmMemory");ignoredModuleProp("wasmBinary")}var _hevc_frame_layout=Module["_hevc_frame_layout"]=makeInvalidEarlyAccess("_hevc_frame_layout");var _hevc_decoder_create=Module["_hevc_decoder_create"]=makeInvalidEarlyAccess("_hevc_decoder_create");var _hevc_decoder_destroy=Module["_hevc_decoder_destroy"]=makeInvalidEarlyAccess("_hevc_decoder_destroy");var _hevc_decoder_decode=Module["_hevc_decoder_decode"]=makeInvalidEarlyAccess("_hevc_decoder_decode");var _hevc_decoder_get_frame_count=Module["_hevc_decoder_get_frame_count"]=makeInvalidEarlyAccess("_hevc_decoder_get_frame_count");var _hevc_decoder_get_frame=Module["_hevc_decoder_get_frame"]=makeInvalidEarlyAccess("_hevc_decoder_get_frame");var _hevc_decoder_feed=Module["_hevc_decoder_feed"]=makeInvalidEarlyAccess("_hevc_decoder_feed");var _hevc_decoder_drain=Module["_hevc_decoder_drain"]=makeInvalidEarlyAccess("_hevc_decoder_drain");var _hevc_decoder_get_drained_frame=Module["_hevc_decoder_get_drained_frame"]=makeInvalidEarlyAccess("_hevc_decoder_get_drained_frame");var _hevc_decoder_flush=Module["_hevc_decoder_flush"]=makeInvalidEarlyAccess("_hevc_decoder_flush");var _hevc_decoder_get_suppressed_picture_count=Module["_hevc_decoder_get_suppressed_picture_count"]=makeInvalidEarlyAccess("_hevc_decoder_get_suppressed_picture_count");var _hevc_decoder_take_suppressed_pictures=Module["_hevc_decoder_take_suppressed_pictures"]=makeInvalidEarlyAccess("_hevc_decoder_take_suppressed_pictures");var _hevc_decoder_get_info=Module["_hevc_decoder_get_info"]=makeInvalidEarlyAccess("_hevc_decoder_get_info");var _fflush=makeInvalidEarlyAccess("_fflush");var _free=Module["_free"]=makeInvalidEarlyAccess("_free");var _malloc=Module["_malloc"]=makeInvalidEarlyAccess("_malloc");var _emscripten_stack_get_end=makeInvalidEarlyAccess("_emscripten_stack_get_end");var _emscripten_stack_get_base=makeInvalidEarlyAccess("_emscripten_stack_get_base");var _strerror=makeInvalidEarlyAccess("_strerror");var _setThrew=makeInvalidEarlyAccess("_setThrew");var __emscripten_tempret_set=makeInvalidEarlyAccess("__emscripten_tempret_set");var _emscripten_stack_init=makeInvalidEarlyAccess("_emscripten_stack_init");var _emscripten_stack_get_free=makeInvalidEarlyAccess("_emscripten_stack_get_free");var __emscripten_stack_restore=makeInvalidEarlyAccess("__emscripten_stack_restore");var __emscripten_stack_alloc=makeInvalidEarlyAccess("__emscripten_stack_alloc");var _emscripten_stack_get_current=makeInvalidEarlyAccess("_emscripten_stack_get_current");var ___cxa_decrement_exception_refcount=makeInvalidEarlyAccess("___cxa_decrement_exception_refcount");var ___cxa_increment_exception_refcount=makeInvalidEarlyAccess("___cxa_increment_exception_refcount");var ___get_exception_message=makeInvalidEarlyAccess("___get_exception_message");var ___cxa_can_catch=makeInvalidEarlyAccess("___cxa_can_catch");var ___cxa_get_exception_ptr=makeInvalidEarlyAccess("___cxa_get_exception_ptr");var memory=makeInvalidEarlyAccess("memory");var __indirect_function_table=makeInvalidEarlyAccess("__indirect_function_table");var wasmMemory=makeInvalidEarlyAccess("wasmMemory");var wasmTable=makeInvalidEarlyAccess("wasmTable");function assignWasmExports(wasmExports){assert(typeof wasmExports["hevc_frame_layout"]!="undefined","missing Wasm export: hevc_frame_layout");assert(typeof wasmExports["hevc_decoder_create"]!="undefined","missing Wasm export: hevc_decoder_create");assert(typeof wasmExports["hevc_decoder_destroy"]!="undefined","missing Wasm export: hevc_decoder_destroy");assert(typeof wasmExports["hevc_decoder_decode"]!="undefined","missing Wasm export: hevc_decoder_decode");assert(typeof wasmExports["hevc_decoder_get_frame_count"]!="undefined","missing Wasm export: hevc_decoder_get_frame_count");assert(typeof wasmExports["hevc_decoder_get_frame"]!="undefined","missing Wasm export: hevc_decoder_get_frame");assert(typeof wasmExports["hevc_decoder_feed"]!="undefined","missing Wasm export: hevc_decoder_feed");assert(typeof wasmExports["hevc_decoder_drain"]!="undefined","missing Wasm export: hevc_decoder_drain");assert(typeof wasmExports["hevc_decoder_get_drained_frame"]!="undefined","missing Wasm export: hevc_decoder_get_drained_frame");assert(typeof wasmExports["hevc_decoder_flush"]!="undefined","missing Wasm export: hevc_decoder_flush");assert(typeof wasmExports["hevc_decoder_get_suppressed_picture_count"]!="undefined","missing Wasm export: hevc_decoder_get_suppressed_picture_count");assert(typeof wasmExports["hevc_decoder_take_suppressed_pictures"]!="undefined","missing Wasm export: hevc_decoder_take_suppressed_pictures");assert(typeof wasmExports["hevc_decoder_get_info"]!="undefined","missing Wasm export: hevc_decoder_get_info");assert(typeof wasmExports["fflush"]!="undefined","missing Wasm export: fflush");assert(typeof wasmExports["free"]!="undefined","missing Wasm export: free");assert(typeof wasmExports["malloc"]!="undefined","missing Wasm export: malloc");assert(typeof wasmExports["emscripten_stack_get_end"]!="undefined","missing Wasm export: emscripten_stack_get_end");assert(typeof wasmExports["emscripten_stack_get_base"]!="undefined","missing Wasm export: emscripten_stack_get_base");assert(typeof wasmExports["strerror"]!="undefined","missing Wasm export: strerror");assert(typeof wasmExports["setThrew"]!="undefined","missing Wasm export: setThrew");assert(typeof wasmExports["_emscripten_tempret_set"]!="undefined","missing Wasm export: _emscripten_tempret_set");assert(typeof wasmExports["emscripten_stack_init"]!="undefined","missing Wasm export: emscripten_stack_init");assert(typeof wasmExports["emscripten_stack_get_free"]!="undefined","missing Wasm export: emscripten_stack_get_free");assert(typeof wasmExports["_emscripten_stack_restore"]!="undefined","missing Wasm export: _emscripten_stack_restore");assert(typeof wasmExports["_emscripten_stack_alloc"]!="undefined","missing Wasm export: _emscripten_stack_alloc");assert(typeof wasmExports["emscripten_stack_get_current"]!="undefined","missing Wasm export: emscripten_stack_get_current");assert(typeof wasmExports["__cxa_decrement_exception_refcount"]!="undefined","missing Wasm export: __cxa_decrement_exception_refcount");assert(typeof wasmExports["__cxa_increment_exception_refcount"]!="undefined","missing Wasm export: __cxa_increment_exception_refcount");assert(typeof wasmExports["__get_exception_message"]!="undefined","missing Wasm export: __get_exception_message");assert(typeof wasmExports["__cxa_can_catch"]!="undefined","missing Wasm export: __cxa_can_catch");assert(typeof wasmExports["__cxa_get_exception_ptr"]!="undefined","missing Wasm export: __cxa_get_exception_ptr");assert(typeof wasmExports["memory"]!="undefined","missing Wasm export: memory");assert(typeof wasmExports["__indirect_function_table"]!="undefined","missing Wasm export: __indirect_function_table");_hevc_frame_layout=Module["_hevc_frame_layout"]=createExportWrapper("hevc_frame_layout",wasmExports["hevc_frame_layout"],0);_hevc_decoder_create=Module["_hevc_decoder_create"]=createExportWrapper("hevc_decoder_create",wasmExports["hevc_decoder_create"],0);_hevc_decoder_destroy=Module["_hevc_decoder_destroy"]=createExportWrapper("hevc_decoder_destroy",wasmExports["hevc_decoder_destroy"],1);_hevc_decoder_decode=Module["_hevc_decoder_decode"]=createExportWrapper("hevc_decoder_decode",wasmExports["hevc_decoder_decode"],3);_hevc_decoder_get_frame_count=Module["_hevc_decoder_get_frame_count"]=createExportWrapper("hevc_decoder_get_frame_count",wasmExports["hevc_decoder_get_frame_count"],1);_hevc_decoder_get_frame=Module["_hevc_decoder_get_frame"]=createExportWrapper("hevc_decoder_get_frame",wasmExports["hevc_decoder_get_frame"],3);_hevc_decoder_feed=Module["_hevc_decoder_feed"]=createExportWrapper("hevc_decoder_feed",wasmExports["hevc_decoder_feed"],3);_hevc_decoder_drain=Module["_hevc_decoder_drain"]=createExportWrapper("hevc_decoder_drain",wasmExports["hevc_decoder_drain"],2);_hevc_decoder_get_drained_frame=Module["_hevc_decoder_get_drained_frame"]=createExportWrapper("hevc_decoder_get_drained_frame",wasmExports["hevc_decoder_get_drained_frame"],3);_hevc_decoder_flush=Module["_hevc_decoder_flush"]=createExportWrapper("hevc_decoder_flush",wasmExports["hevc_decoder_flush"],1);_hevc_decoder_get_suppressed_picture_count=Module["_hevc_decoder_get_suppressed_picture_count"]=createExportWrapper("hevc_decoder_get_suppressed_picture_count",wasmExports["hevc_decoder_get_suppressed_picture_count"],1);_hevc_decoder_take_suppressed_pictures=Module["_hevc_decoder_take_suppressed_pictures"]=createExportWrapper("hevc_decoder_take_suppressed_pictures",wasmExports["hevc_decoder_take_suppressed_pictures"],3);_hevc_decoder_get_info=Module["_hevc_decoder_get_info"]=createExportWrapper("hevc_decoder_get_info",wasmExports["hevc_decoder_get_info"],2);_fflush=createExportWrapper("fflush",wasmExports["fflush"],1);_free=Module["_free"]=createExportWrapper("free",wasmExports["free"],1);_malloc=Module["_malloc"]=createExportWrapper("malloc",wasmExports["malloc"],1);_emscripten_stack_get_end=wasmExports["emscripten_stack_get_end"];_emscripten_stack_get_base=wasmExports["emscripten_stack_get_base"];_strerror=createExportWrapper("strerror",wasmExports["strerror"],1);_setThrew=createExportWrapper("setThrew",wasmExports["setThrew"],2);__emscripten_tempret_set=createExportWrapper("_emscripten_tempret_set",wasmExports["_emscripten_tempret_set"],1);_emscripten_stack_init=wasmExports["emscripten_stack_init"];_emscripten_stack_get_free=wasmExports["emscripten_stack_get_free"];__emscripten_stack_restore=wasmExports["_emscripten_stack_restore"];__emscripten_stack_alloc=wasmExports["_emscripten_stack_alloc"];_emscripten_stack_get_current=wasmExports["emscripten_stack_get_current"];___cxa_decrement_exception_refcount=createExportWrapper("__cxa_decrement_exception_refcount",wasmExports["__cxa_decrement_exception_refcount"],1);___cxa_increment_exception_refcount=createExportWrapper("__cxa_increment_exception_refcount",wasmExports["__cxa_increment_exception_refcount"],1);___get_exception_message=createExportWrapper("__get_exception_message",wasmExports["__get_exception_message"],3);___cxa_can_catch=createExportWrapper("__cxa_can_catch",wasmExports["__cxa_can_catch"],3);___cxa_get_exception_ptr=createExportWrapper("__cxa_get_exception_ptr",wasmExports["__cxa_get_exception_ptr"],1);memory=wasmMemory=wasmExports["memory"];__indirect_function_table=wasmTable=wasmExports["__indirect_function_table"]}var wasmImports={__assert_fail:___assert_fail,__cxa_begin_catch:___cxa_begin_catch,__cxa_end_catch:___cxa_end_catch,__cxa_find_matching_catch_2:___cxa_find_matching_catch_2,__cxa_find_matching_catch_3:___cxa_find_matching_catch_3,__cxa_throw:___cxa_throw,__resumeException:___resumeException,_abort_js:__abort_js,emscripten_resize_heap:_emscripten_resize_heap,fd_close:_fd_close,fd_seek:_fd_seek,fd_write:_fd_write,invoke_ii,invoke_iii,invoke_iiii,invoke_iiiii,invoke_iiiiii,invoke_iiiiiii,invoke_v,invoke_vi,invoke_vii,invoke_viii,invoke_viiii,invoke_viiiii,invoke_viiiiii};function invoke_ii(index,a1){var sp=stackSave();try{return getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_iiii(index,a1,a2,a3){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_vii(index,a1,a2){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_v(index){var sp=stackSave();try{getWasmTableEntry(index)()}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_iiiiii(index,a1,a2,a3,a4,a5){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4,a5)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_iii(index,a1,a2){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_vi(index,a1){var sp=stackSave();try{getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_viiii(index,a1,a2,a3,a4){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_iiiii(index,a1,a2,a3,a4){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_viiiiii(index,a1,a2,a3,a4,a5,a6){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_iiiiiii(index,a1,a2,a3,a4,a5,a6){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_viiiii(index,a1,a2,a3,a4,a5){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4,a5)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}function invoke_viii(index,a1,a2,a3){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}}var calledRun;function stackCheckInit(){_emscripten_stack_init();writeStackCookie()}async function run(){assert(!calledRun);calledRun=true;stackCheckInit();preRun();var setStatus=Module["setStatus"];if(setStatus){setStatus("Running...");await new Promise(resolve=>setTimeout(resolve,1));setTimeout(setStatus,1,"")}if(ABORT)return;initRuntime();Module["onRuntimeInitialized"]?.();consumedModuleProp("onRuntimeInitialized");assert(!Module["_main"],'compiled without a main, but one is present. if you added it from JS, use Module["onRuntimeInitialized"]');postRun()}var wasmExports;wasmExports=await createWasm();await run();for(const prop of Object.keys(Module)){if(!(prop in moduleArg)){Object.defineProperty(moduleArg,prop,{configurable:true,get(){abort(`Access to module property ('${prop}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`)}})}}
;return Module}})();if(typeof exports==="object"&&typeof module==="object"){module.exports=HEVCDecoderModule;module.exports.default=HEVCDecoderModule}else if(typeof define==="function"&&define["amd"])define([],()=>HEVCDecoderModule);


/* ===== 内联 HEVC 软解：hevc-decode.wasm 344949B base64（MIT）===== */
var HEVC_WASM_B64 = "AGFzbQEAAAAB+QEcYAJ/fwBgAn9/AX9gAX8Bf2ABfwBgA39/fwF/YAN/f38AYAR/f39/AGAGf39/f39/AGAFf39/f38AYAAAYAR/f39/AX9gAAF/YAV/f39/fwF/YAh/f39/f39/fwBgB39/f39/f38AYAZ/f39/f38Bf2AHf39/f39/fwF/YAl/f39/f39/f38AYAp/f39/f39/f39/AGAOf39/f39/f39/f39/f38AYAN/fn8BfmAHf3x/f39/fwF/YAR/fn9/AX9gC39/f39/f39/f39/AGANf39/f39/f39/f39/fwBgC39/f39/f39/f39/AX9gAnx/AXxgAn5/AX8CsAQZA2VudglpbnZva2VfaWkAAQNlbnYbX19jeGFfZmluZF9tYXRjaGluZ19jYXRjaF8yAAsDZW52EV9fcmVzdW1lRXhjZXB0aW9uAAMDZW52C2ludm9rZV9paWlpAAoDZW52Cmludm9rZV92aWkABQNlbnYbX19jeGFfZmluZF9tYXRjaGluZ19jYXRjaF8zAAIDZW52EV9fY3hhX2JlZ2luX2NhdGNoAAIDZW52D19fY3hhX2VuZF9jYXRjaAAJA2VudghpbnZva2VfdgADA2Vudg1pbnZva2VfaWlpaWlpAA8DZW52Cmludm9rZV9paWkABANlbnYLX19jeGFfdGhyb3cABQNlbnYJaW52b2tlX3ZpAAADZW52DGludm9rZV92aWlpaQAIA2VudgxpbnZva2VfaWlpaWkADANlbnYOaW52b2tlX3ZpaWlpaWkADgNlbnYOaW52b2tlX2lpaWlpaWkAEANlbnYNaW52b2tlX3ZpaWlpaQAHA2VudgtpbnZva2VfdmlpaQAGFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAChZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX2Nsb3NlAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9zZWVrABYDZW52CV9hYm9ydF9qcwAJA2VudhZlbXNjcmlwdGVuX3Jlc2l6ZV9oZWFwAAIDZW52DV9fYXNzZXJ0X2ZhaWwABgPpA+cDCQsLAgMEAwIEBAEEAgIMBAEDAwMDCQkDAQEAAAMAAAQDAQICAgMABgMEAQYFAQwBBQQADwEBAQQHBQwDAAYDAAgACAAGAA8DBQMGAQIDAwMABgICAQIBAQEBAQEBAAYRFwIYEBkREhMTDQ0NDQcIBwcIBw4RDQ4FBQ4OBAoFBQACCAcSBA0CAgADAwMBAgQKAwMAAAAABgUGBgEABAAAAAAGAxADDwIUBAIFAgUEBQQBAgkKAhoMEAUCBhsIFQAEAQIDAQACAAMJCwsLAwACAgEBAQIDAAkDAAQBBQQEAQIFBQEEAgMAAwIDAwMACQkCAwQEBAUGBgYGBggHCAgIBwcHBAICAgIDAwICAwMCCwECAQUEAgABAwADAAAFAQEBAgECAQEBAgAFAgMBAAECAgQBAgEEBAQCAAACAQQCCgICAQIMAQQAAAEAAwABAAAAAQEKAQEBAQEBAQEAAAIABAwCAAIBAgIEAgEBAQEKAAAGAAAAAAAAAAAAAAAAAAEDAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAQEBAQAAAAAAAAEAAAAAAAAAAAABAQEAAAAAAAAAAAQAAAAAAAEAAgAABQAABQQHAXABmgOaAwUHAQHBAoCAAgYTA38BQcDcgQILfwFBAAt/AUEACwe/BiIGbWVtb3J5AgARX193YXNtX2NhbGxfY3RvcnMAGRFoZXZjX2ZyYW1lX2xheW91dAAaE2hldmNfZGVjb2Rlcl9jcmVhdGUAGxRoZXZjX2RlY29kZXJfZGVzdHJveQAdE2hldmNfZGVjb2Rlcl9kZWNvZGUAHhxoZXZjX2RlY29kZXJfZ2V0X2ZyYW1lX2NvdW50ACAWaGV2Y19kZWNvZGVyX2dldF9mcmFtZQAhEWhldmNfZGVjb2Rlcl9mZWVkACISaGV2Y19kZWNvZGVyX2RyYWluACMeaGV2Y19kZWNvZGVyX2dldF9kcmFpbmVkX2ZyYW1lACQSaGV2Y19kZWNvZGVyX2ZsdXNoACUpaGV2Y19kZWNvZGVyX2dldF9zdXBwcmVzc2VkX3BpY3R1cmVfY291bnQAJiVoZXZjX2RlY29kZXJfdGFrZV9zdXBwcmVzc2VkX3BpY3R1cmVzACgVaGV2Y19kZWNvZGVyX2dldF9pbmZvACkZX19pbmRpcmVjdF9mdW5jdGlvbl90YWJsZQEABmZmbHVzaAC/AQRmcmVlANsBBm1hbGxvYwDaARhlbXNjcmlwdGVuX3N0YWNrX2dldF9lbmQA5AEZZW1zY3JpcHRlbl9zdGFja19nZXRfYmFzZQDjAQhzdHJlcnJvcgDsAQhzZXRUaHJldwDfARdfZW1zY3JpcHRlbl90ZW1wcmV0X3NldADgARVlbXNjcmlwdGVuX3N0YWNrX2luaXQA4QEZZW1zY3JpcHRlbl9zdGFja19nZXRfZnJlZQDiARlfZW1zY3JpcHRlbl9zdGFja19yZXN0b3JlAKUCF19lbXNjcmlwdGVuX3N0YWNrX2FsbG9jAKYCHGVtc2NyaXB0ZW5fc3RhY2tfZ2V0X2N1cnJlbnQApwIiX19jeGFfZGVjcmVtZW50X2V4Y2VwdGlvbl9yZWZjb3VudACEAiJfX2N4YV9pbmNyZW1lbnRfZXhjZXB0aW9uX3JlZmNvdW50AIMCF19fZ2V0X2V4Y2VwdGlvbl9tZXNzYWdlAP8DD19fY3hhX2Nhbl9jYXRjaACbAhdfX2N4YV9nZXRfZXhjZXB0aW9uX3B0cgCcAgmcBQEAQQELmQMcMqcBuQEHtQG2AbcBJ58BMZ8CogGAAjToATfrAaMCQS5AQ0QuS0hKT0FBXEEuL0FRYGVmZ8kBaEtClgFqaZcBaz8+Li4uM5gBNZ8BaKABoQGiAaMBpAGlAaYBTTg6qAFUUFNVqgFXX1tYqwGsAa0BrgEurwGwAV1eTD2VAbsBvQGxAWJaswHCAcEBwAHWAdcB2AHKAcoByQH/AcoBygHKAekB+wH6AeoB/AH9AZ8BaPgB9AH1AfYB+QH+AaICiAKJAhjLAYUCnwFoogGiAYsCmgKXAo4CaJkClgKPAmiYApMCkQJonQJongKhAqICpAKhAqkCrQKuArkCugK+Ar4CvgLBAsICxwLaAu4C8ALyApAD/AOfAWizArQCtQK1AskByQHJAd0C3gLfAp8BaOAC4gLjAocCaOQC5gJo5wJo6ALtAu8C8QLzAmj0AvUCaIcDaIsDaIwDaI0DaI4DaI8DaJEDaJIDaJMDaJQDaJUDaJYDaJkDaJoDaJsDaJ0DaJ4DaJ8DaKEDaKIDaKMDpANopQOmA2inA6gDaKkDqgNoqwOsA2itA2ivA2iwA2ixA2iyA2i0A2i1A2i2A2i3A2i4A2i5A2i6A2i7A2i8A2i9A2i+A2i/A2jAA8EDaMIDaMQDaMUDaMYDxwNoyAPJA2jLA8oDaMwDxwNozQNozgNozwPBA2jQA8EDaNEDwQNowgNowgPSA9MD1APVA2jWA9cDaNgDxwNo2QNovwNopgNo2gNo2wPcA9wDaN0D3gNo3wNo4ANo4QPcA9wDaOID4wNo5ANo5QPmA+cD6ANo6QPqA2jrA2jsA2jtA2juA2jvA2jwA9wD3APxA2jyA/MD5gNo9AP1A2j2A/cDaPgD+gP3A2j7A/0DDAEnCvOxE+cDPgBBwNyBAiQCQcDcASQBQeTTAUHA3IECNgIAQczTAUEqNgIAQejTAUGAgIACNgIAQezTAUGoyQEoAgA2AgALhwEBAX8jAEFAaiIAJABB4MoBLQAARQRAIABCsICAgMAGNwMwIABCqICAgMAFNwMoIABCoICAgMAENwMgIABCmICAgMADNwMYIABCkICAgMACNwMQIABCiICAgMABNwMIIABCgICAgMAANwMAQeDKAUGACEGjCSAAEMwBGgsgAEFAayQAQeDKAQvyAQEDfwJAAn9BpNgBQQA2AgBBEEHo/wgQACEBQaTYASgCACEAQaTYAUEANgIAAkAgAEEBRgRAQQAQBRAGGkGk2AFBADYCAEEFEAhBpNgBKAIAQaTYAUEANgIAQQAhAUEBRg0BCyABDAELQQAQBRAfAAsiAQRAIAFBAEHo/wj8CwBBpNgBQQA2AgBBASABEAAhAEGk2AEoAgBBpNgBQQA2AgBBAUYNASAAQgA3AuD/CCAA/QwAAAAAAAAAAAAAAAAAAAAA/QsC0P8IIAD9DAAAAAAAAAAAAAAAAAAAAAD9CwLA/wgLIAEPCxABIAEQ2wEQAgAL4hMBBH8gAEEAOgD8nAIgAEEAOgDQjAIgAEEAOgDMjAIgAEEAOgCg/AEgAEEAOgCc/AEgAEEAOgDw6wEgAEEAOgDs6wEgAEEAOgDA2wEgAEEAOgC82wEgAEEAOgCQywEgAEEAOgCMywEgAEEAOgDgugEgAEEAOgDcugEgAEEAOgCwqgEgAEEAOgCsqgEgAEEAOgCAmgEgAEEAOgD8mQEgAEEAOgDQiQEgAEEAOgDMiQEgAEEAOgCgeSAAQQA6AJx5IABBADoA8GggAEEAOgDsaCAAQQA6AMBYIABBADoAvFggAEEAOgCQSCAAQQA6AIxIIABBADoA4DcgAEEAOgDcNyAAQQA6ALAnIABBADoArCcgAEEAOgCAFyAAQQA6APwWIABBADoAyBUgAEEAOgDEFSAAQQA6AJAUIABBADoAjBQgAEEAOgDYEiAAQQA6ANQSIABBADoAoBEgAEEAOgCcESAAQQA6AOgPIABBADoA5A8gAEEAOgCwDiAAQQA6AKwOIABBADoA+AwgAEEAOgD0DCAAQQA6AMALIABBADoAvAsgAEEAOgCICiAAQQA6AIQKIABBADoA0AggAEEAOgDMCCAAQQA6AJgHIABBADoAlAcgAEEAOgDgBSAAQQA6ANwFIABBADoAqAQgAEEAOgCkBCAAQQA6APACIABBADoA7AIgAEEAOgC4ASAAQQA6ALQBIABBADoAACAAQYCdAmoiAUEAOgD81QYgAUEAOgDUyAYgAUEAOgDQyAYgAUEAOgCouwYgAUEAOgCkuwYgAUEAOgD8rQYgAUEAOgD4rQYgAUEAOgDQoAYgAUEAOgDMoAYgAUEAOgCkkwYgAUEAOgCgkwYgAUEAOgD4hQYgAUEAOgD0hQYgAUEAOgDM+AUgAUEAOgDI+AUgAUEAOgCg6wUgAUEAOgCc6wUgAUEAOgD03QUgAUEAOgDw3QUgAUEAOgDI0AUgAUEAOgDE0AUgAUEAOgCcwwUgAUEAOgCYwwUgAUEAOgDwtQUgAUEAOgDstQUgAUEAOgDEqAUgAUEAOgDAqAUgAUEAOgCYmwUgAUEAOgCUmwUgAUEAOgDsjQUgAUEAOgDojQUgAUEAOgDAgAUgAUEAOgC8gAUgAUEAOgCU8wQgAUEAOgCQ8wQgAUEAOgDo5QQgAUEAOgDk5QQgAUEAOgC82AQgAUEAOgC42AQgAUEAOgCQywQgAUEAOgCMywQgAUEAOgDkvQQgAUEAOgDgvQQgAUEAOgC4sAQgAUEAOgC0sAQgAUEAOgCMowQgAUEAOgCIowQgAUEAOgDglQQgAUEAOgDclQQgAUEAOgC0iAQgAUEAOgCwiAQgAUEAOgCI+wMgAUEAOgCE+wMgAUEAOgDc7QMgAUEAOgDY7QMgAUEAOgCw4AMgAUEAOgCs4AMgAUEAOgCE0wMgAUEAOgCA0wMgAUEAOgDYxQMgAUEAOgDUxQMgAUEAOgCsuAMgAUEAOgCouAMgAUEAOgCAqwMgAUEAOgD8qgMgAUEAOgDUnQMgAUEAOgDQnQMgAUEAOgCokAMgAUEAOgCkkAMgAUEAOgD8ggMgAUEAOgD4ggMgAUEAOgDQ9QIgAUEAOgDM9QIgAUEAOgCk6AIgAUEAOgCg6AIgAUEAOgD42gIgAUEAOgD02gIgAUEAOgDMzQIgAUEAOgDIzQIgAUEAOgCgwAIgAUEAOgCcwAIgAUEAOgD0sgIgAUEAOgDwsgIgAUEAOgDIpQIgAUEAOgDEpQIgAUEAOgCcmAIgAUEAOgCYmAIgAUEAOgDwigIgAUEAOgDsigIgAUEAOgDE/QEgAUEAOgDA/QEgAUEAOgCY8AEgAUEAOgCU8AEgAUEAOgDs4gEgAUEAOgDo4gEgAUEAOgDA1QEgAUEAOgC81QEgAUEAOgCUyAEgAUEAOgCQyAEgAUEAOgDougEgAUEAOgDkugEgAUEAOgC8rQEgAUEAOgC4rQEgAUEAOgCQoAEgAUEAOgCMoAEgAUEAOgDkkgEgAUEAOgDgkgEgAUEAOgC4hQEgAUEAOgC0hQEgAUEAOgCMeCABQQA6AIh4IAFBADoA4GogAUEAOgDcaiABQQA6ALRdIAFBADoAsF0gAUEAOgCIUCABQQA6AIRQIAFBADoA3EIgAUEAOgDYQiABQQA6ALA1IAFBADoArDUgAUEAOgCEKCABQQA6AIAoIAFBADoA2BogAUEAOgDUGiABQQA6AKwNIAFBADoAqA0gAUEAOgAAIABBgPMIakEAQcAI/AsAIABCADcCyPsIIABCfzcCwPsIIAD9DAAAAAAAAAAAAAAAAAAAAAD9CwLQ+wggAEGBAjsB4PsIIABB4vsIakEAQdsA/AsAIABBwPwIaiICQQBB3AH8CwBBpNgBQQA2AgAgAEGc/ghqQQBBoQH8CwBBpNgBKAIAQaTYAUEANgIAQQFGBEAQASAAKAKQ/ggiAQRAIAAgATYClP4IIAAoApj+CBogARDbAQsgACgChP4IIgEEQCAAIAE2Aoj+CCAAKAKM/ggaIAEQ2wELIAAoAvj9CCIBBEAgACABNgL8/QggACgCgP4IGiABENsBCyAAKALs/QgiAQRAIAAgATYC8P0IIAAoAvT9CBogARDbAQsgACgC4P0IIgEEQCAAIAE2AuT9CCAAKALo/QgaIAEQ2wELIAAoAtT9CCIBBEAgACABNgLY/QggACgC3P0IGiABENsBCyAAKALI/QgiAQRAIAAgATYCzP0IIAAoAtD9CBogARDbAQsgACgCvP0IIgEEQCAAIAE2AsD9CCAAKALE/QgaIAEQ2wELIAAoArD9CCIBBEAgACABNgK0/QggACgCuP0IGiABENsBCyAAKAKk/QgiAQRAIAAgATYCqP0IIAAoAqz9CBogARDbAQsgACgCmP0IIgEEQCAAIAE2Apz9CCAAKAKg/QgaIAEQ2wELIAAoAoz9CCIBBEAgACABNgKQ/QggACgClP0IGiABENsBCyAAKAKA/QgiAQRAIAAgATYChP0IIAAoAoj9CBogARDbAQsgACgC9PwIIgEEQCAAIAE2Avj8CCAAKAL8/AgaIAEQ2wELIAAoAuj8CCIBBEAgACABNgLs/AggACgC8PwIGiABENsBCyAAKALc/AgiAQRAIAAgATYC4PwIIAAoAuT8CBogARDbAQsgACgCzPwIIgEEQCAAIAE2AtD8CCAAKALU/AgaIAEQ2wELIAIoAgAiAQRAIAAgATYCxPwIIAAoAsj8CBogARDbAQsgAEHI+whqECpBgPkIIQEDQCAAIAFBDGsiAmooAgAiAwRAIAAgAWoiAUEIayADNgIAIAFBBGsoAgAaIAMQ2wELIAIiAUGA8whHDQALIABBgJ0CahArIABBgBdqECwQAgALIAAL4wsBCn8gAARAIAAoAtj/CCIBBEAgACABNgLc/wggACgC4P8IGiABENsBCyAAKALM/wgiAQRAIAAgATYC0P8IIAAoAtT/CBogARDbAQsgACgCwP8IIgEEQCAAIAE2AsT/CCAAKALI/wgaIAEQ2wELQaTYAUEANgIAQQ0gAEGc/ghqIgVBJGoiARAMQaTYASgCACEDQaTYAUEANgIAAkAgA0EBRwRAIAVBAToAoAEgARDlASAFQTxqIgIQ5QECQCAFKAIAIgMgBSgCBCIERwRAA0BBpNgBQQA2AgBBDiADEAxBpNgBKAIAQaTYAUEANgIAQQFGDQIgA0EEaiIDIARHDQALCyAFQewAahDnARogAhDnARogARDnARoCfyAFQQxqIgIoAgQiASACKAIIIgNGBEAgAkEUaiEJIAEMAQsgAkEUaiEJIAEgAigCECIHQaoBbiIEQQJ0aiIGKAIAIgggByAEQaoBbGtBGGxqIgQgASACKAIUIAdqIgdBqgFuIgpBAnRqKAIAIAcgCkGqAWxrQRhsaiIHRwRAA0ACQCAEIAQoAhAiAUYEf0EQBSABRQ0BQRQLIQMgASABKAIAIANqKAIAEQMAIAYoAgAhCAsgBEEYaiIEIAhrQfAfRgRAIAYoAgQiCCEEIAZBBGohBgsgBCAHRw0ACyACKAIIIQMgAigCBCEBCyADCyAJQQA2AgAgAWtBAnUiBEECSwRAA0AgASgCABDbASACIAIoAgRBBGoiATYCBCACKAIIIgMgAWtBAnUiBEECSw0ACwtB1QAhBgJAAkACQCAEQQFrDgIBAAILQaoBIQYLIAIgBjYCEAsgASADRgR/IAMFA0AgASgCABDbASABQQRqIgEgA0cNAAsgAigCCCEDIAIoAgQLIQEgAiADIAMgAWtBfHFrNgIIIAIoAgAiAQRAIAIoAgwaIAEQ2wELIAUoAgAiAgRAIAIiASAFKAIEIgNHBEADQCADQQRrIgMoAgAEQBCGAgALIAIgA0cNAAsgBSgCACEBCyAFIAI2AgQgBSgCCBogARDbAQsMAgsLQQAQBRAfAAsgACgCkP4IIgEEQCAAIAE2ApT+CCAAKAKY/ggaIAEQ2wELIAAoAoT+CCIBBEAgACABNgKI/gggACgCjP4IGiABENsBCyAAKAL4/QgiAQRAIAAgATYC/P0IIAAoAoD+CBogARDbAQsgACgC7P0IIgEEQCAAIAE2AvD9CCAAKAL0/QgaIAEQ2wELIAAoAuD9CCIBBEAgACABNgLk/QggACgC6P0IGiABENsBCyAAKALU/QgiAQRAIAAgATYC2P0IIAAoAtz9CBogARDbAQsgACgCyP0IIgEEQCAAIAE2Asz9CCAAKALQ/QgaIAEQ2wELIAAoArz9CCIBBEAgACABNgLA/QggACgCxP0IGiABENsBCyAAKAKw/QgiAQRAIAAgATYCtP0IIAAoArj9CBogARDbAQsgACgCpP0IIgEEQCAAIAE2Aqj9CCAAKAKs/QgaIAEQ2wELIAAoApj9CCIBBEAgACABNgKc/QggACgCoP0IGiABENsBCyAAKAKM/QgiAQRAIAAgATYCkP0IIAAoApT9CBogARDbAQsgACgCgP0IIgEEQCAAIAE2AoT9CCAAKAKI/QgaIAEQ2wELIAAoAvT8CCIBBEAgACABNgL4/AggACgC/PwIGiABENsBCyAAKALo/AgiAQRAIAAgATYC7PwIIAAoAvD8CBogARDbAQsgACgC3PwIIgEEQCAAIAE2AuD8CCAAKALk/AgaIAEQ2wELIAAoAsz8CCIBBEAgACABNgLQ/AggACgC1PwIGiABENsBCyAAKALA/AgiAQRAIAAgATYCxPwIIAAoAsj8CBogARDbAQsgAEHI+whqECpBgPkIIQEDQCAAIAFBDGsiA2ooAgAiAgRAIAAgAWoiAUEIayACNgIAIAFBBGsoAgAaIAIQ2wELIAMiAUGA8whHDQALIABBgJ0CahArIABBgBdqECwgABDbAQsL1wMBAn8jAEEQayIDJABBfyEEAkACQCAARQ0AIAFFDQAgAkUNAEGk2AFBADYCAEEDIAAgASACEAMhAUGk2AEoAgBBpNgBQQA2AgBBAUcEQCABDQFBpNgBQQA2AgBBBCADQQRqIAAQBEGk2AEoAgBBpNgBQQA2AgBBAUcEQCAAKALA/wgiAQRAIAAgATYCxP8IIAAoAsj/CBogARDbASAAQQA2Asj/CCAAQgA3AsD/CAsgACADKAIENgLA/wggACADKAIINgLE/wggACADKAIMNgLI/whBACEEDAILC0EAEAUQBhpBpNgBQQA2AgBBBCADQQRqIAAQBEGk2AEoAgBBpNgBQQA2AgBBAUYNASAAQcD/CGoiASgCACICBEAgASACNgIEIAEoAggaIAIQ2wEgAUEANgIIIAFCADcCAAsgASADKAIENgIAIAEgAygCCDYCBCABIAMoAgw2AgggA0EANgIMIANCADcCBCADKAIEIgEEQCADIAE2AgggAygCDBogARDbAQtBf0EAIAAoAsD/CCAAKALE/whGGyEEEAcLIANBEGokACAEDwsQAUGk2AFBADYCAEEFEAhBpNgBKAIAQaTYAUEANgIAQQFGBEBBABAFEB8ACxACAAsLACAAEAYaEIYCAAsdACAARQRAQQAPCyAAKALE/wggACgCwP8Ia0ECdQv+AgEHf0F/IQMCQCABQQBIDQAgAEUNACACRQ0AIAEgACgCxP8IIAAoAsD/CCIAa0ECdU4NAEEBIQMgACABQQJ0aigCACIAKAJoIAAoAowBIgRBAkEBIAAtAIABIgFBAUYbIghtbCAAKAKEASIFQQFBAiABQQNGGyIJbWohASAAKAJkIARsIAVqIQYgACgCdCAEIAAoApABamshBCAAKAJwIAUgACgCiAFqayEFAn8gAC0ASEEBRgRAIAAoAhggAWohByAAKAIAIAZqIQYgACgCDCABagwBCyABQQF0IgEgACgCPGohByAA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AmggACgCbBogARDbAQsgACgCWCIBBEAgACABNgJcIAAoAmAaIAEQ2wELIAAoAkwiAQRAIAAgATYCUCAAKAJUGiABENsBCyAAKAJAIgEEQCAAIAE2AkQgACgCSBogARDbAQsgACgCNCIBBEAgACABNgI4IAAoAjwaIAEQ2wELIAAoAigiAQRAIAAgATYCLCAAKAIwGiABENsBCyAAKAIcIgEEQCAAIAE2AiAgACgCJBogARDbAQsgACgCACIBBEAgASICIAAoAgQiBEcEQANAAkAgBEEEaygCACICRQ0AIAIgAigCBCIDQQFrNgIEIAMNACACIAIoAgAoAggRAwACQCACKAIIIgMEQCACIANBAWs2AgggAw0BCyACIAIoAgAoAhARAwALCyABIARBCGsiBEcNAAsgACgCACECCyAAIAE2AgQgACgCCBogAhDbAQsLuQQAIABB1MgGahAtIABBqLsGahAtIABB/K0GahAtIABB0KAGahAtIABBpJMGahAtIABB+IUGahAtIABBzPgFahAtIABBoOsFahAtIABB9N0FahAtIABByNAFahAtIABBnMMFahAtIABB8LUFahAtIABBxKgFahAtIABBmJsFahAtIABB7I0FahAtIABBwIAFahAtIABBlPMEahAtIABB6OUEahAtIABBvNgEahAtIABBkMsEahAtIABB5L0EahAtIABBuLAEahAtIABBjKMEahAtIABB4JUEahAtIABBtIgEahAtIABBiPsDahAtIABB3O0DahAtIABBsOADahAtIABBhNMDahAtIABB2MUDahAtIABBrLgDahAtIABBgKsDahAtIABB1J0DahAtIABBqJADahAtIABB/IIDahAtIABB0PUCahAtIABBpOgCahAtIABB+NoCahAtIABBzM0CahAtIABBoMACahAtIABB9LICahAtIABByKUCahAtIABBnJgCahAtIABB8IoCahAtIABBxP0BahAtIABBmPABahAtIABB7OIBahAtIABBwNUBahAtIABBlMgBahAtIABB6LoBahAtIABBvK0BahAtIABBkKABahAtIABB5JIBahAtIABBuIUBahAtIABBjPgAahAtIABB4OoAahAtIABBtN0AahAtIABBiNAAahAtIABB3MIAahAtIABBsDVqEC0gAEGEKGoQLSAAQdgaahAtIABBrA1q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IABBADYCjA0gAEIANwKEDQsgACABKAKEDTYChA0gACABKAKIDTYCiA0gACABKAKMDTYCjA0gAUEANgKMDSABQgA3AoQNIAAoApANIgIEQCAAIAI2ApQNIAAoApgNGiACENsBIABBADYCmA0gAEIANwKQDQsgACABKAKQDTYCkA0gACABKAKUDTYClA0gACABKAKYDTYCmA0gAUEANgKYDSABQgA3ApANIAAoApwNIgIEQCAAIAI2AqANIAAoAqQNGiACENsBIABBADYCpA0gAEIANwKcDQsgACABKAKcDTYCnA0gACABKAKgDTYCoA0gACABKAKkDTYCpA0gAUEANgKkDSABQgA3ApwNIAAPCyAB/QACACEDIAH9AAIQIQQgAf0AAiAhBSABKQIwIQYgASkANSEHIABBADYCSCAAQgA3AkAgACAHNwA1IAAgBjcCMCAAIAX9CwIgIAAgBP0LAhAgACAD/QsCACAAIAEoAkA2AkAgACABKAJENgJEIAAgASgCSDYCSCABQQA2AkggAUIANwJAIABBADYCVCAAQgA3AkwgACABKAJMNgJMIAAgASgCUDYCUCAAIAEoAlQ2AlQgAUEANgJUIAFCADcCTCAAQdgAaiABQdgAakGsDPwKAAAgAEEANgKMDSAAQgA3AoQNIAAgASgChA02AoQNIAAgASgCiA02AogNIAAgASgCjA02AowNIAFBADYCjA0gAUIANwKEDSAAQQA2ApgNIABCADcCkA0gACABKAKQDTYCkA0gACABKAKUDTYClA0gACABKAKYDTYCmA0gAUEANgKYDSABQgA3ApANIABBADYCpA0gAEIANwKcDSAAIAEoApwNNgKcDSAAIAEoAqANNgKgDSAAIAEoAqQNNgKkDSABQQA2AqQNIAFCADcCnA0gAEEBOgCoDSAAC4EDAQV/IwBB8ABrIgQkACAEQcgAaiACKAIEIgMgAigCCCADaxA4IgNBARA6GiACLQAAQfgBcUEQRgRAIANBARA6GgsCf0EAIAMQOyIDQT9LDQAaIAAgA0GsDWxqIgVBgJ0CaiEGAkACQCAFLQCoqgIiBUEBRw0AIAYoAgQiB0EPSw0AIAAgA0ECdGooAoD5CCAAIAdBAnRqKAKA+whGDQELAkAgACADQQxsaiIHKAKA8wggBygChPMIRwRAIAAgAxBOGiAGLQCoDUUN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IglHBEAgBiAJSg0BDAILIAgoApQBIAQoApQBTg0BCyAAIAg2AgAMAQsgACAENgIAIAEgBTYCAAJAIAcgAigCACIEKAKYASIGRwRAIAYgB0gNAQwDCyAEKAKUASAFKAKUAU4NAgsgASAENgIACyACIAU2AgAgBSEECwJAAkAgAygCACIFKAKYASIGIAQoApgBIgdHBEAgBiAHSA0BDAILIAUoApQBIAQoApQBTg0BCyACIAU2AgAgAyAENgIAAkAgAigCACIDKAKYASIFIAEoAgAiBCgCmAEiBkcEQCAFIAZIDQEMAgsgAygClAEgBCgClAFODQELIAEgAzYCACACIAQ2AgACQCABKAIAIgIoApgBIgQgACgCACIDKAKYASIFRwRAIAQgBUgNAQwCCyACKAKUASADKAKUAU4NAQsgACACNgIAIAEgAzYCAAsLkgoBCH9BASEJAkACQAJAAkACQAJAAkACQCABIABrQQJ1DgYGBgABAgMECwJAIAFBBGsiAigCACIBKAKYASIEIAAoAgAiAygCmAEiBUcEQCAEIAVIDQEMBwsgASgClAEgAygClAFODQYLIAAgATYCACACIAM2AgAMBgsgAUEEayEBAkAgACgCBCIDKAKYASICIAAoAgAiBCgCmAEiBUcEQCACIAVODQEMBQsgAygClAEgBCgClAFIDQQLAkAgAiABKAIAIgQoApgBIgVHBEAgAiAFSg0BDAYLIAQoApQBIAMoApQBTg0FCyAAIAQ2AgQgASADNgIAAkAgACgCBCIBKAKYASICIAAoAgAiAygCmAEiBEcEQCACIARIDQEMBgsgASgClAEgAygClAFODQULIAAgAzYCBCAAIAE2AgAMBQsgACAAQQRqIABBCGogAUEEaxBjDAQLIAAgAEEEaiAAQQhqIABBDGoQYwJAIAFBBGsiAigCACIBKAKYASIEIAAoAgwiAygCmAEiBUcEQCAEIAVIDQEMBAsgASgClAEgAygClAFODQMLIAAgATYCDCACIAM2AgACQCAAKAIMIgEoApgBIgMgACgCCCICKAKYASIERwRAIAMgBEgNAQwECyABKAKUASACKAKUAU4NAwsgACABNgIIIAAgAjYCDAJAIAAoAgQiAigCmAEiBCADRwRAIAMgBEgNAQwECyABKAKUASACKAKUAU4NAwsgACACNgIIIAAgATYCBAJAIAAoAgAiAigCmAEiBCADRwRAIAMgBEgNAQwECyABKAKUASACKAKUAU4NAwsgACACNgIEIAAgATYCAAwDCyAAQQhqIQMCQAJAAkAgACgCBCIEKAKYASIFIAAoAgAiAigCmAEiB0cEQCAFIAdODQEMAgsgBCgClAEgAigClAFIDQELAkAgBSADKAIAIgYoApgBIghHBEAgBSAISg0BDAMLIAYoApQBIAQoApQBTg0CCyAAIAQ2AgggACAGNgIEAkAgByAIRwRAIAcgCEoNAQwDCyAGKAKUASACKAKUAU4NAgsgACACNgIEIAAgBjYCAAwBCwJAAkAgBSADKAIAIgYoApgBIghHBEAgBSAISg0BDAILIAYoApQBIAQoApQBTg0BCyAAIAI2AgggACAGNgIADAELIAAgAjYCBCAAIAQ2AgACQCAHIAhHBEAgByAISg0BDAILIAYoApQBIAIoApQBTg0BCyAAIAI2AgggACAGNgIECyAAQQxqIgIgAUYNAUEAIQYDQAJAAkAgAigCACIFKAKYASIHIAMoAgAiBCgCmAEiCEcEQCAHIAhIDQEMAgsgBSgClAEgBCgClAFODQELIAIgBDYCAAJAA0ACQCADQQRrIgQoAgAiCCgCmAEiCSAHRwRAIAcgCUgNAQwDCyAFKAKUASAIKAKUAU4NAgsgAyAINgIAIAQiAyAARw0ACyAAIQMLIAMgBTYCACAGQQFqIgZBCEcNACACQQRqIAFGIQkMAwsgAiIDQQRqIgIgAUcNAAsMAgsCQAJAIAIgASgCACIHKAKYASIGRwRAIAIgBkoNAQwCCyAHKAKUASADKAKUAU4NAQsgACAHNgIAIAEgBDYCAAwCCyAAIAQ2AgQgACADNgIAAkAgBSABKAIAIgMoApgBIgJHBEAgAiAFSA0BDAILIAMoApQBIAQoApQBTg0BCyAAIAM2AgQgASAENgIADAELIAkPC0EBCwwAIABBiCc2AgAgAAsPACAAQYgnNgIAIAAQ2wELlQIBAX8gAEEMaiIAKALAASIBBEAgACABNgLEASAAKALIARogARDbAQsgACgCtAEiAQRAIABBtAFqIAEQtAEgACgCvAEaIAAoArQBENsBCyAAKAKkASIBBEAgACABNgKoASAAKAKsARogARDbAQsgACgCPCIBBEAgACABNgJAIAAoAkQaIAEQ2wELIAAoAjAiAQRAIAAgATYCNCAAKAI4GiABENsBCyAAKAIkIgEEQCAAIAE2AiggACgCLBogARDbAQsgACgCGCIBBEAgACABNgIcIAAoAiAaIAEQ2wELIAAoAgwiAQRAIAAgATYCECAAKAIUGiABENsBCyAAKAIAIgEEQCAAIAE2AgQgACgCCBogARDbAQsLBwAgABDbAQvQAQICfgF/IABB/gM2ApwBIAAgATYCrAEgAUEJEDohASAAQQA2AqgBIAAgAa0iAzcDoAECQAJAIAAoAqwBIgEoAhgiBEEfSg0AIAEQOSABKAIYIgRBH0oNACAEQQBKBEAgATUCFCECCyABQgA3AxAgAUEANgIYIAEgASgCCEEgajYCCAwBCyABIARBIGs2AhggASABKQMQIgJCIIY3AxAgASABKAIIQSBqNgIIIAJCIIghAgsgACACIANCIIaENwOgASAAIAAoAqgBQSBqNgKoAQvzBgIBfwR7QQIhBAJAAkACQCABDgIBAgALQQAhAUEAIQQMAQtBASEEQQIhAQsgBCABIAMbQfAnaiEDQQAhBEEzIAJBACACQQBKGyIBIAFBM04bIgL9ESEHA0AgACAEaiADIARBA2xqIgEgASABIAH9BwAA/VQAAwH9VAAGAv1UAAkD/YkB/akBIgVBA/2rAf0MeAAAAHgAAAB4AAAAeAAAAP1OIAVBBP2tAf0MBQAAAAUAAAAFAAAABQAAAP21Af0M0////9P////T////0/////2uASAH/bUBQQT9rAH9rgH9DPD////w////8P////D////9rgEiBf0MAQAAAAEAAAABAAAAAQAAAP24Af0MfgAAAH4AAAB+AAAAfgAAAP22ASABIAEgASAB/QcADP1UAA8B/VQAEgL9VAAVA/2JAf2pASIGQQP9qwH9DHgAAAB4AAAAeAAAAHgAAAD9TiAGQQT9rQH9DAUAAAAFAAAABQAAAAUAAAD9tQH9DNP////T////0////9P////9rgEgB/21AUEE/awB/a4B/Qzw////8P////D////w/////a4BIgb9DAEAAAABAAAAAQAAAAEAAAD9uAH9DH4AAAB+AAAAfgAAAH4AAAD9tgH9DQAECAwQFBgcAAAAAAAAAABBAf1rIgj9DH5+fn5+fn5+fn5+fn5+fn79USAI/QyBgYGBgYGBgYGBgYGBgYGB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IAEgASgCqAFBIGoiAjYCqAELIAEgBDYCnAEgCEUFQQELIQYgCQRAIAEtACUiB0EBcSEIAkACQCAEIARBBnZBA3EgB0ECdHItAPJLIgNrIgStIAKthiIKIAtYBEAgASAHLQDyUDoAJSABIAsgCn0iCzcDoAEgCEEBcyEIIAMhBAwBCyABIActAPJPOgAlIARB/wFLDQELIAEgAiAEZ0EXayIDayICNgKoASAEIAN0IQQgAkEPSg0AAkACQCABKAKsASICKAIYIgNBH0oNACACEDkgAigCGCIDQR9KDQBCACEKIANBAEoEQCACNQIUIQoLIAJCADcDECACQQA2AhggAiACKAIIQSBqNgIIDAELIAIgA0EgazYCGCACIAIpAxAiCkIghjcDECACIAIoAghBIGo2AgggCkIgiCEKCyABIAogC0IghoQiCzcDoAEgASABKAKoAUEgaiICNgKoAQsgASAENgKcASAIRSEHCwJAIAVFBEAgAiEDDAELQQEhBSAGRQRAQQAhBUEBIQMDQCABIAJBAWsiBDYCqAEgASALQgAgATUCnAEgBK2GIgogCiALViIGG30iCzcDoAECQCACQRBKBEAgBCECDAELAkACQCABKAKsASICKAIYIgRBH0oNACACEDkgAigCGCIEQR9KDQAgBEEATAR+QgAFIAI1AhQLIQogAkIANwMQIAJBADYCGCACIAIoAghBIGo2AggMAQsgAiAEQSBrNgIYIAIgAikDECIKQiCGNwMQIAIgAigCCEEgajYCCCAKQiCIIQoLIAEgCiALQiCGhCILNwOgASABIAEoAqgBQSBqIgI2AqgBCwJAIAYEQCADIQQMAQtBASADdCAFaiEFQRQhBCADQQFqIgNBFEcNAQsLIAEgBBBvIAVqQQJqIQUgASkDoAEhCyABKAKoASECIAEoApwBIQQLIAEgAkEBayIDNgKoASABIAtCACAErSADrYYiCiAKIAtWIgQbfSILNwOgASACQRBMBEACQAJAIAEoAqwBIgIoAhgiA0EfSg0AIAIQOSACKAIYIgNBH0oNAEIAIQogA0EASgRAIAI1AhQhCgsgAkIANwMQIAJBADYCGCACIAIoAghBIGo2AggMAQsgAiADQSBrNgIYIAIgAikDECIKQiCGNwMQIAIgAigCCEEgajYCCCAKQiCIIQoLIAEgCiALQiCGhCILNwOgASABIAEoAqgBQSBqIgM2AqgBCyAAIAVBACAFayAEGzsBAAsgCQRAQQEhAiAHRQRAQQAhBUEBIQQDQCABIANBAWsiAjYCqAEgASALQgAgATUCnAEgAq2GIgogCiALViIGG30iCzcDoAECQCADQRBKBEAgAiEDDAELAkACQCABKAKsASICKAIYIgNBH0oNACACEDkgAigCGCIDQR9KDQAgA0EATAR+QgAFIAI1AhQLIQogAkIANwMQIAJBADYCGCACIAIoAghBIGo2AggMAQsgAiADQSBrNgIYIAIgAikDECIKQiCGNwMQIAIgAigCCEEgajYCCCAKQiCIIQoLIAEgCiALQiCGhCILNwOgASABIAEoAqgBQSBqIgM2AqgBCwJAIAYEQCAEIQIMAQtBASAEdCAFaiEFQRQhAiAEQQFqIgRBFEcNAQsLIAEgAhBvIAVqQQJqIQIgASkDoAEhCyABKAKoASEDCyABIANBAWsiBDYCqAEgASALQgAgATUCnAEgBK2GIgogCiALViIEG30iCzcDoAEgA0EQTARAAkACQCABKAKsASIDKAIYIgVBH0oNACADEDkgAygCGCIFQR9KDQBCACEKIAVBAEoEQCADNQIUIQoLIANCADcDECADQQA2AhggAyADKAIIQSBqNgIIDAELIAMgBUEgazYCGCADIAMpAxAiCkIghjcDECADIAMoAghBIGo2AgggCkIgiCEKCyABIAogC0IghoQ3A6ABIAEgASgCqAFBIGo2AqgBCyAAIAJBACACayAEGzsBAgsLMwAgACABKAJEIAEoAkggA0EEbWxBDGxqIAJBBG1BDGxqIgEoAQg2AQggACABKQEANwEAC4MOAgx/A34jAEEgayIOJAAgACgCCCEQIAAoAgwhCwJAIAAoAhgiCiAAKAIcIAUgACgCACgC6A8iDHVsIglBA3RqIAQgDHUiDEEDdGotAABBAkYEQCAQKALYDCIQQQJOBH8gCyAQEHAhDSAEIAAoAgAoAugPIgt1IQwgACgCGCEKIAAoAhwgBSALdWwFIAkLQQN0IApqIAxBA3RqQQE6AAcgDkEQaiAAIAEgAiADIAQgBSAGIAcgCCANEHkgDikDECIVQjCIIRcgFUIgiKchDCAVQhCIpyERIA4vARohDSAOLQAZIQkgDi0AGCEKIBWnIRIMAQsgCy0AECINQQFx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A3VqIANBB3EgBkEHcSAOIBAgESATQYBAaxB/C0EBIRILQQAhAwJAAkACQAJAIAlBAEgNACALRQ0AIAkgACgCFCIGKAJoIAYoAmQiBmtBAnVODQAgBiAJQQJ0aigCACIGRQ0AIAUNASAGIAEgBy4BACIBQQJ1aiACIAcuAQIiAkECdWogAUEDcSACQQNxIA4gECARIBMQfgwCCyASDQIgEEEATA0DIA5BAEwNA0H//wFBASARQQFrdCIAIABB//8BThshASAQQQNxIQNBACEJQQAhACAQQQFrQQNPBEAgEEH8////B3EhBEEAIQoDQCAORSICRQRAIAwgACANbGogASAO/AsACyACRQRAIAwgAEEBciANbGogASAO/AsACyACRQRAIAwgAEECciANbGogASAO/AsACyACRQRAIAwgAEEDciANbGogASAO/AsACyAAQQRqIQAgCkEEaiIKIARHDQALIANFDQQLA0AgDgRAIAwgACANbGogASAO/AsACyAAQQFqIQAgCUEBaiIJIANHDQALDAMLIAYgBSABIA9tIAcuAQAiAUEDdWogAiAUbSAHLgECIgJBA3VqIAFBB3EgAkEHcSAOIBAgESATEH8LQQEhAwsgBEEBcQRAIAAoAggiACgC3AghCgJ/IAVFBEAgACAIQQAgCEEAShtBDmxqIgEuAegIIBFBCGsiCHQhDyAAIAlBACAJQQBKG0EObGoiAEHICmohFCABQeYIaiEJIABBxgpqDAELIAVBAXRBAmsiASAAIAlBACAJQQBKG0EObGpqIgJBzgpqIRQgACAIQQAgCEEAShtBDmxqIAFqIgFB6ghqIQkgAUHuCGouAQAgEUEIayIIdCEPIAAoAuAIIApqIQogAkHKCmoLIQsgEEEATA0BQX8gEXRBf3MhBSAJLgEAIQRBASAKQQJBDiARayIAIABBAkwbaiIGQQFrdCECIAMgEkUiAHJBAUYEQCAULgEAIAh0IQkgCy4BACEHIAAgA3FBAUYEQCAOQQBMDQMgDkH4////B3EhASAF/REhGiAJ/REhGyAC/REhHCAH/REhHSATIQQgDkEISSEDQQAhCwNAQQAhCEEAIQACQCADRQRAA0AgCCAMaiAaIB0gBCAIQQF0av0AAQAiHv2nAf21ASAc/a4BIAb9rAEgG/2uAf0MAAAAAAAAAAAAAAAAAAAAAP24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eHEiFmohBiAELgEO/REhKCAELgEM/REhKSAELgEK/REhKiAELgEI/REhKyAELgEG/REhLCAELgEE/REhLSAELgEC/REhLiAELgEA/REhL0EAIQoDQCAFIAAgCmoiB0EBdGogASAHaiIHIAJq/V0AACI3/YkB/akBIC79tQEgB/1dAAAiOP2JAf2pASAv/bUB/a4BIAcgDGr9XQAAIjn9iQH9qQEgLf21Af2uASAHIA1q/V0AACI6/YkB/akBICz9tQH9rgEgByAOav1dAAAiO/2JAf2pASAr/bUB/a4BIAcgD2r9XQAAIjz9iQH9qQEgKv21Af2uASAHIBBq/V0AACI9/YkB/akBICn9tQH9rgEgByARav1dAAAiPv2JAf2pASAo/bUB/a4BIAv9rAH9DP//AAD//wAA//8AAP//AAD9TiA3ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgLv21ASA4ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgL/21Af2uASA5ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgLf21Af2uASA6ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgLP21Af2uASA7ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgK/21Af2uASA8ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgKv21Af2uASA9ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgKf21Af2uASA+ICf9DQQFBgcAAAAAAAAAAAAAAAD9iQH9qQEgKP21Af2uASAL/awB/Qz//wAA//8AAP//AAD//wAA/U79hgH9CwEAIApBCGoiCiAWRw0ACyAUIBZGDQELA0AgBSAGQQF0aiABIAZqIgAgAmotAAAgBC4BAmwgAC0AACAELgEAbGogACAMai0AACAELgEEbGogACANai0AACAELgEGbGogACAOai0AACAELgEIbGogACAPai0AACAELgEKbGogACAQai0AACAELgEMbGogACARai0AACAELgEObGogC3U7AQAgBkEBaiIGIAlHDQALCyABIBVqIQEgBSATaiEFIBJBAWoiEiADRw0ACwsLtQ0CGn8YeyACQQBKBEAgAy4BDv0RIR8gAy4BDP0RISAgAy4BCv0RISEgAy4BCP0RISIgAy4BBv0RISMg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IgBBACAAQQBKIgEbIgBBAWt0QQAgARshBQJAIANBCEkNACAGIAdrQXBLDQAgA0H4////B3EhAiAF/REhCUEAIQQDQCAHIARBAXQiAWogCSABIAZq/QABACII/acB/a4BIAD9rAH9DP//AAD//wAA//8AAP//AAD9TiAJIAj9qAH9rgEgAP2sAf0M//8AAP//AAD//wAA//8AAP1O/YYB/QsBACAEQQhqIgQgAkcNAAsgAiADRg0CCyACIQQgA0EDcSIRBEBBACEBA0AgByAEQQF0IhJqIAUgBiASai4BAGogAHU7AQAgBEEBaiEEIAFBAWoiASARRw0ACwsgAiADa0F8Sw0BA0AgByAEQQF0IgFqIAUgASAGai4BAGogAHU7AQAgByABQQJqIgJqIAUgAiAGai4BAGogAHU7AQAgByABQQRqIgJqIAUgAiAGai4BAGogAHU7AQAgByABQQZqIgFqIAUgASAGai4BAGogAHU7AQAgBEEEaiIEIANHDQALDAELIAUoAgQhEiAFKAIAIQUgECARNgKMgAFBFCAEayEDIABBAkYiEwRAIAb9AwEAIQoCeyATIAIgAUVxcSIABEAgCv0MVAAAAFQAAABUAAAAVAAAAP21ASAG/QMBCP0MSgAAAEoAAABKAAAASgAAAP21ASII/bEBIAb9AwEQIgv9DDcAAAA3AAAANwAAADcAAAD9tQH9rgEgBv0DARgiDP0M4////+P////j////4/////21Af2uAf0MQAAAAEAAAABAAAAAQAAAAP2uASENIAv9DLb///+2////tv///7b////9tQEgDCAK/a4B/QxKAAAASgAAAEoAAABKAAAA/bUB/a4B/QxAAAAAQAAAAEAAAABAAAAA/a4BQQf9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEhCSAI/QxAAAAAQAAAAEAAAABAAAAA/a4BIg4gCv0MNwAAADcAAAA3AAAANwAAAP21Af2uASAL/Qzj////4////+P////j/////bUB/a4BIAz9DKz///+s////rP///6z////9tQH9rgFBB/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASEIIA4gCv0MHQAAAB0AAAAdAAAAHQAAAP21Af2uASAL/QxUAAAAVAAAAFQAAABUAAAA/bUB/a4BIAz9DDcAAAA3AAAANwAAADcAAAD9tQH9rgFBB/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22AQwBCyAG/QMBECIJIAr9rgFBBv2rAf0MQAAAAEAAAABAAAAAQAAAAP2uASILIAb9AwEYIgj9DCQAAAAkAAAAJAAAACQAAAD9tQEgBv0DAQgiDP0MUwAAAFMAAABTAAAAUwAAAP21Af2uASIO/bEBIQ0gCiAJ/bEBQQb9qwH9DEAAAABAAAAAQAAAAEAAAAD9rgEiCiAI/Qyt////rf///63///+t/////bUBIAz9DCQAAAAkAAAAJAAAACQAAAD9tQH9rgEiCP2xAUEH/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIQkgCCAK/a4BQQf9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEhCCAOIAv9rgFBB/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22AQshCiAQIAn9GwA7AQQgECAI/RsAOwECIBAgCv0bADsBACAQIA1BB/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASIL/RsAOwEGIBAgCf0bAzsBHCAQIAj9GwM7ARogECAK/RsDOwEYIBAgC/0bAzsBHiAQIAogCP0NBAUUFQABAAEICRgZAAEAASAJ/RsB/RoCIAv9GwH9GgMgCf0bAv0aBiAL/RsC/RoH/QsDCEEBQRMgBGt0/REhCCAQ/QMDACEJIAcCeyAABEAgCf0MVAAAAFQAAABUAAAAVAAAAP21ASAI/a4BIBD9AwMI/QxKAAAASgAAAEoAAABKAAAA/bUBIg79sQEgEP0DAxAiCv0MNwAAADcAAAA3AAAANwAAAP21Af2uASAQ/QMDGCIL/Qzj////4////+P////j/////bUB/a4BIQwgCv0Mtv///7b///+2////tv////21ASAI/a4BIAsgCf2uAf0MSgAAAEoAAABKAAAASgAAAP21Af2uASAD/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIQ0gDiAI/a4BIg4gCf0MNwAAADcAAAA3AAAANwAAAP21Af2uASAK/Qzj////4////+P////j/////bUB/a4BIAv9DKz///+s////rP///6z////9tQH9rgEgA/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASEIIA4gCf0MHQAAAB0AAAAdAAAAHQAAAP21Af2uASAK/QxUAAAAVAAAAFQAAABUAAAA/bUB/a4BIAv9DDcAAAA3AAAANwAAADcAAAD9tQH9rgEgA/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22AQwBCyAQ/QMDECIKIAn9rgFBBv2rASAI/a4BIgsgEP0DAxgiDf0MJAAAACQAAAAkAAAAJAAAAP21ASAQ/QMDCCIO/QxTAAAAUwAAAFMAAABTAAAA/bUB/a4BIg/9sQEhDCAJIAr9sQFBBv2rASAI/a4BIgkgDf0Mrf///63///+t////rf////21ASAO/QwkAAAAJAAAACQAAAAkAAAA/bUB/a4BIgj9sQEgA/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASENIAggCf2uASAD/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIQggDyAL/a4BIAP9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgELIAj9DQABBAUICQwNEBEUFRgZHB0iCSANIAwgA/2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22Af0NAAEEBQgJDA0QERQVGBkcHSII/Q0EBQwNFBUcHQYHDg8WFx4f/QsBECAHIAkgCP0NAAEICRARGBkCAwoLEhMaG/0LAQAMAQsgBSASckUEQEH//wFBgIB+IAYuAQBBBnRBAXVBIGpBQHFBAUETIARrdGogA3UiASABQYCAfkwbIgEgAUH//wFOGyEEAkAgESAAdCICQQhJBEAgByEBIAIhAwwBCyACQQdxIQMgByACQXhxIgVBAXRqIQEgBP0QIQlBACEAA0AgByAAQQF0aiAJ/QsBACAAQQhqIgAgBUcNAAsg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AQAAIAAgDGogCv0ABHAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACABQQRqIgEgBUgNAAsMAwsgBkH+////B3EhFSAGQQFxIQ8DQCAKQYAEakEAQYAB/AsAIAIgDUEBdCIXaiEOQQAhAUEAIQACQCAGQQFHBEADQCAKQYAEaiIWIABBBHRqIA4gACALbEEBdGr9AwEA/QsEACAWIABBAXIiFkEEdGogDiALIBZsQQF0av0DAQD9CwQAIABBAmohACABQQJqIgEgFUcNAAsgD0UNAQsgCkGABGogAEEEdGogDiAAIAtsQQF0av0DAQD9CwQACyAKQYAEaiAGIAoQkAEgAyAXaiIAIAr9AAQAIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACALQQF0aiAK/QAEECAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgFGogCv0ABCAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBNqIAr9AAQwIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACASaiAK/QAEQCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgEWogCv0ABFAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBBqIAr9AARgIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAMaiAK/QAEcCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIA1BBGoiDSAFSA0ACwwCCyAFQQBMDQEgC0EebCEMIAtBHGwhECALQRpsIREgC0EYbCESIAtBFmwhEyALQRRsIRQgC0ESbCEVIAtBBHQhDyALQQ5sIRcgC0EMbCEWIAtBCmwhGSALQQN0IRogC0EGbCEbIAtBAnQhHEEBIARBAWt0/REhByAGQQBMBEBBACEBA0AgCkGABGoiAEEAQYAC/AsAIAAgBiAKEJEBIAMgAUEBdGoiACAK/QAEACAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgC0EBdGogCv0ABBAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBxqIAr9AAQgIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAbaiAK/QAEMCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgGmogCv0ABEAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBlqIAr9AARQIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAWaiAK/QAEYCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgF2ogCv0ABHAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIA9qIAr9AASAASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgFWogCv0ABJABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAUaiAK/QAEoAEgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBNqIAr9AASwASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgEmogCv0ABMABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACARaiAK/QAE0AEgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBBqIAr9AATgASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgDGogCv0ABPABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgAUEEaiIBIAVIDQALDAILIAZB/v///wdxIR0gBkEBcSEeA0AgCkGABGpBAEGAAvwLACACIA1BAXQiH2ohDkEAIQFBACEAAkAgBkEBRwRAA0AgCkGABGoiGCAAQQR0aiAOIAAgC2xBAXRq/QMBAP0LBAAgGCAAQQFyIhhBBHRqIA4gCyAYbEEBdGr9AwEA/QsEACAAQQJqIQAgAUECaiIBIB1HDQALIB5FDQELIApBgARqIABBBHRqIA4gACALbEEBdGr9AwEA/QsEAAsgCkGABGogBiAKEJEBIAMgH2oiACAK/QAEACAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgC0EBdGogCv0ABBAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBxqIAr9AAQgIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAbaiAK/QAEMCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgGmogCv0ABEAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBlqIAr9AARQIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAWaiAK/QAEYCAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgF2ogCv0ABHAgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIA9qIAr9AASAASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgFWogCv0ABJABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACAUaiAK/QAEoAEgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBNqIAr9AASwASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgEmogCv0ABMABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgACARaiAK/QAE0AEgB/2uASAE/awB/QwAgP//AID//wCA//8AgP///bgB/Qz/fwAA/38AAP9/AAD/fwAA/bYBIAf9DQABBAUICQwNAAEAAQABAAH9WwEAACAAIBBqIAr9AATgASAH/a4BIAT9rAH9DACA//8AgP//AID//wCA///9uAH9DP9/AAD/fwAA/38AAP9/AAD9tgEgB/0NAAEEBQgJDA0AAQABAAEAAf1bAQAAIAAgDGogCv0ABPABIAf9rgEgBP2sAf0MAID//wCA//8AgP//AID///24Af0M/38AAP9/AAD/fwAA/38AAP22ASAH/Q0AAQQFCAkMDQABAAEAAQAB/VsBAAAgDUEEaiINIAVIDQALDAELIAVBAEwNAEEBIAZBAWpBAm0iDSANQQFMGyIAQf7///8DcSERIABBAXEhEiAGQf7///8HcSETIAZBAXEhFEEBIARBAWt0/REhCCAGQQNIIRUDQCAKQYAEakEAQYAE/AsAIA5BAXQhEAJAAkAgBkEASgRAIAIgEGohDEEAIQBBACEBAkAgBkEBRwRAA0AgCkGABGoiDyAAQQR0aiAMIAAgC2xBAXRq/QMBAP0LBAAgDyAAQQFyIg9BBHRqIAwgCyAPbEEBdGr9AwEA/QsEACAAQQJqIQAgAUECaiIBIBNHDQALIBRFDQELIApB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IAogCP2xASAL/bUB/a4BIA4gD0GQAmogDP0bAEEBdGr9AAEAIgz9pwH9tQH9rgEgBP2sAf0M//8AAP//AAD//wAA//8AAP1OIA0gCf0MAQAAAAEAAAABAAAAAQAAAP2uASAH/bUB/a4BIAogCf2xASAL/bUB/a4BIA4gDP2oAf21Af2uASAE/awB/Qz//wAA//8AAP//AAD//wAA/U79hgH9CwEAIAj9DAgAAAAIAAAACAAAAAgAAAD9rgEhCCAJ/QwIAAAACAAAAAgAAAAIAAAA/a4BIQkgAEEIaiIAIBZHDQALDAELA0AgESAAQQF0aiAUIABBAWoiASAVbGogBSAAayATbGogEiAPQZACaiABQQF0ai4BAGxqIAR1OwEAIAEiACAQRw0ACwsgAiAQRw0ACwwCCyAPQZACaiAPIBRBEUsiABshEiAUQQJ0IgEoAqBGIRMgFEELa0EOTQRAQQIgA3QhEUEfIBMgA3RrQQV1IQIgASgCsEchFgJAIANBH0YNACARQQAgEUEAShtBAXRBAnIiAUUNACAPQaAEaiACQQF0aiASIAH8CgAACwJAIAJBAEwNACAPIA9BkAJqIAAbIQAgD0GgBGogAkEBdGohEkF/IQUgAkEITwRAIAJB+P///wdxIhVBf3MhBSAR/REhByAW/REhC/0M+/////r////5////+P///yEI/Qz//////v////3////8////IQlBACEBA0AgEiABQX9zQQF0akEOayAA/QyAAAAAgAAAAIAAAACAAAAAIAkgC/21Af2xAUEI/awBIAf9tgEiCv0bAEEBdGogACAK/RsBQQF0aiAAIAr9GwJBAXRqIAAgCv0bA0EBdGogAP0MgAAAAIAAAACAAAAAgAAAACAIIAv9tQH9sQFBCP2sASAH/bYBIgr9GwBBAXRqIAAgCv0bAUEBdGogACAK/RsCQQF0aiAAIAr9GwNBAXRq/QgBAP1VAQAB/VUBAAL9VQEAA/1VAQAE/VUBAAX9VQEABv1VAQAH/QsBACAJ/Qz4////+P////j////4/////a4BIQkgCP0M+P////j////4////+P////2uASEIIAFBCGoiASAVRw0ACyACIBVGDQELQQAgAmshAQNAIBIgBUEBdGogAEGAASAFIBZsa0EIdSIVIBEgESAVShtBAXRqLwEAOwEAIAEgBUgg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AUEgazYCGCACIAIpAxAiKUIghjcDECACIAIoAghBIGo2AgggKUIgiCEpCyAGICkgKEIghoQiKDcDoAEgBiAGKAKoAUEgaiIBNgKoAQsgBiAANgKcAUEEIAtFDQAaIAYgAUECayICNgKoASAGICggKCACrSIpiKcgAG4iAiAAbK0gKYZ9Iig3A6ABIAFBEUwEQAJAAkAgBigCrAEiACgCGCIBQR9KDQAgABA5IAAoAhgiAUEfSg0AQgAhKSABQQBKBEAgADUCFCEpCyAAQgA3AxAgAEEANgIYIAAgACgCCEEgajYCCAwBCyAAIAFBIGs2AhggACAAKQMQIilCIIY3AxAgACAAKAIIQSBqNgIIIClCIIghKQsgBiApIChCIIaENwOgASAGIAYoAqgBQSBqNgKoAQsgAkEDcQshACAHKAI4IAcoAkAgCEECdWxqIApBAnVqLQAAIQEgAEEERwRAQSIgAEECdEGA0gBqKAIAIgAgACABRhshAQtBASASQQRtIgAgAEEBTBsiC0H+////AXEhESALQQFxIRMgCEEEbSEUIApBBG0hAkEAIQ0gEkEISCESA0AgDSAUaiEGQQAhBUEAIQBBACEQAkAgEkUEQANAIAcoAjwgBygCQCAGbGogAmogAGogAToAACAHKAI8IAcoAkAgBmxqIAJqIABqIAE6AAEgAEECaiEAIBBBAmoiECARRw0ACyAAIQUgE0UNAQsgBygCPCAHKAJAIAZsaiACaiAFaiABOgAACyANQQFqIg0gC0cNAAsLIAxBQGskAEEBISRBACERQQEhAkEAIQUMAgtBACERQQAhJEEAIQJBACEFAkACQAJAAkACQAJAAkACQAJAIAlB/wFxDggAAQIHAwQFBgoLIAcgCiAIIA4gCiAIIA4gDkEAEHggG0EEaiIAIAcgCiAIEHcgByAKIAggDiAOIAAQmwEMCAsgByAKIAggDiAKIAggDiAOQQJtIgBBABB4IBtBBGoiASAHIAogCBB3IAcgCiAIIA4gACABEJsBQQEhCSAHIAogCCAOIAogACAIaiICIA4gAEEBEHggASAHIAogAhB3IAcgCiACIA4gACABEJsBDAYLQQIhCSAHIAogCCAOIAogCCAOQQJtIgAgDkEAEHggG0EEaiIBIAcgCiAIEHcgByAKIAggACAOIAEQmwEgByAKIAggDiAAIApqIgIgCCAAIA5BARB4IAEgByACIAgQdyAHIAIgCCAAIA4gARCbAQwFC0EEIQkgByAKIAggDiAKIAggDiAOQQRtIgFBABB4IBtBBGoiACAHIAogCBB3IAcgCiAIIA4gASAAEJsBIAcgCiAIIA4gCiABIAhqIgEgDkEDIAN0QQRtIgJBARB4IAAgByAKIAEQdyAHIAogASAOIAIgABCbAQwECyAHIAogCCAOIAogCCAOQQMgA3RBBG0iAUEAEHggG0EEaiIAIAcgCiAIEHcgByAKIAggDiABIAAQmwEgByAKIAggDiAKIAEgCGoiASAOIA5BBG0iAkEBEHggACAHIAogARB3IAcgCiABIA4gAiAAEJsBQQUhCQwDCyAHIAogCCAOIAogCCAOQQRtIgEgDkEAEHggG0EEaiIAIAcgCiAIEHcgByAKIAggASAOIAAQmwEgByAKIAggDiABIApqIgEgCEEDIAN0QQRtIgIgDkEBEHggACAHIAEgCBB3IAcgASAIIAIgDiAAEJsBQQYhCQwCCyAHIAogCCAOIAogCEEDIAN0QQRtIgEgDkEAEHggG0EEaiIAIAcgCiAIEHcgByAKIAggASAOIAAQmwEgByAKIAggDiABIApqIgEgCCAOQQRtIgIgDkEBEHggACAHIAEgCBB3IAcgASAIIAIgDiAAEJsBQQchCQwBCyAHIAogCCAOIAogCCAOQQJtIgAgAEEAEHggG0EEaiIBIAcgCiAIEHcgByAKIAggACAAIAEQmwEgByAKIAggDiAAIApqIgIgCCAAIABBARB4IAEgByACIAgQdyAHIAIgCCAAIAAgARCbASAHIAogCCAOIAogACAIaiIGIAAgAEECEHggASAHIAogBhB3IAcgCiAGIAAgACABEJsBQQMhCSAHIAogCCAOIAIgBiAAIABBAxB4IAEgByACIAYQdyAHIAIgBiAAIAAgARCbAUEAIQIMAgtBACECDAELQQAhCUEAIQULIA4gHCgC8A8iFm0iDEEASgRAIAxB8P///wdxIQAgCv0RISsgFv0RISwgBygCHCElIAcoAhghJiAHKAIAKALoDyELQQAhFyAMQRBJIScDQCAmICUgFiAXbCAIaiALdWxBA3RqIQZBACEBAkAgJ0UEQP0MDAAAAA0AAAAOAAAADwAAACEt/QwIAAAACQAAAAoAAAALAAAAIS79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ajYCBA8LIAUEQCAAIAU2AgQgBRDbASAAQQA2AgggAEIANwIAQQAhBAsCQCADQQBIDQBB/////wcgBCADIAMgBEkbIARB/v///wdPGyIDQQBIDQAgACADQQF0IgUQ6AEiAzYCBCAAIAM2AgAgACADIAVqNgIIIAIgAWsiAgRAIAMgASAC/AoAAAsgACACIANqNgIEDwsQLgALiwIBAn8gACgCCCIFIAAoAgAiBGsgA08EQCADIAAoAgQgBGsiBUsEQCAFBEAgBCABIAX8CgAACyAAKAIEIQMgAiABIAVqIgJrIgEEQCADIAIgAfwKAAALIAAgASADajYCBA8LIAIgAWsiAgRAIAQgASAC/AoAAAsgACACIARqNgIEDwsgBARAIAAgBDYCBCAEENsBIABBADYCCCAAQgA3AgBBACEFCyADQQBOBEAgAEH/////ByAFQQF0IgQgAyADIARJGyAFQf////8DTxsiBBDoASIDNgIEIAAgAzYCACAAIAMgBGo2AgggAiABayICBEAgAyABIAL8CgAACyAAIAIgA2o2AgQPCxAuAAvLBwEHfyAAQQA2AgggAEIANwIAAkACQAJAAkACQCABKAIEIgMgASgCACIFRwRAIAMgBWsiA0EASARAIABBCGohBSAAQQRqIQZBASECIAAhAwwCCyAAIAMQ6AEiAjYCBCAAIAI2AgAgACACIANqIgY2AgggAwRAIAIgBSAD/AoAAAsgACAGNgIECyAAQQA2AhQgAEIANwIMIAEoAhAiBCABKAIMIgdHBEAgAEEUaiEFIABBEGohBiAAQQxqIQNBACECIAQgB2siBEEASA0BQaTYAUEANgIAQRAgBBAAIQJBpNgBKAIAQaTYAUEANgIAQQFGBEAQASEEDAULIAMgAjYCACAAIAI2AhAgACACIARqIgM2AhQgBARAIAIgByAE/AoAAAsgACADNgIQCyAAQQA2AiAgAEIANwIYAkACQAJAIAEoAhwiAiABKAIYIgRHBEAgAEEgaiEGIABBHGohBUEYIQMgAEEYaiEHIAIgBGsiAkEASARAQQEhAgwCC0Gk2AFBADYCAEEQIAIQACEDQaTYASgCAEGk2AFBADYCAEEBRgRAEAEhBAwECyAAIAM2AhggACADNgIcIAAgAiADaiIFNgIgIAIEQCADIAQgAvwKAAALIAAgBTYCHAsgAEEANgIsIABCADcCJCABKAIoIgggASgCJCIERwRAIABBLGohBiAAQShqIQVBJCEDIABBJGohB0EAIQIgCCAEayIBQQBIDQFBpNgBQQA2AgBBECABEAAhA0Gk2AEoAgBBpNgBQQA2AgBBAUYEQBABIQRBJCEDDAMLIAAgAzYCJCAAIAM2AiggACABIANqIgI2AiwgAQRAIAMgBCAB/AoAAAsgACACNgIoCyAADwtBpNgBQQA2AgBBFRAIQaTYASgCAEGk2AFBADYCAEEBRw0DEAEhBCAHKAIAIgEEQCAFIAE2AgAgBigCABogARDbASACRQ0BDAILIAINAQsDQCAAIANBDGsiA2oiASgCACICBEAgASACNgIEIAEoAggaIAIQ2wELIANBGEcNAAsLIAAoAgwiAQRAIAAgATYCECAAKAIUGiABENsBCyAAKAIAIgFFDQQgACABNgIEIAAoAggaIAEQ2wEMBAtBpNgBQQA2AgBBGRAIQaTYASgCAEGk2AFBADYCAEEBRg0BCwALEAEhBCADKAIAIgEEQCAGIAE2AgAgBSgCABogARDbASACRQ0BDAILIAINAQsDQCADQQxrIgEoAgAiAgRAIANBCGsgAjYCACADQQRrKAIAGiACENsBCyABIgMgAEcNAAsLIAQQAgALugEBA38gACgCBCICIAFHBEADQCACQQxrKAIAIgMEQCACQQhrIAM2AgAgAkEEaygCABogAxDbAQsgAkEYaygCACIDBEAgAkEUayADNgIAIAJBEGsoAgAaIAMQ2wELIAJBJGsoAgAiAwRAIAJBIGsgAzYCACACQRxrKAIAGiADENsBCyACQTBrIgMoAgAiBARAIAJBLGsgBDYCACACQShrKAIAGiAEENsBCyADIgIgAUcNAAsLIAAgATYCBAsLACAAIAEgAhCnAQuxBQEOfwJAIAEoAsD7CCICQQ9NBEAgASACQbAQbGoiAi0ArCcNAQsgAEEANgIIIABCADcCAA8LIAFByPsIaiEJIwBBIGsiAyQAIAAiBEEANgIIIABCADcCACACQYAXaiIALQABQQxsIABqIgAoAogBIgtBH3YhDCAAKAKEASINQQBOIQ4CQANAAkACQAJAIAkoAgAiASAJKAIEIgpGIg9FBEAgCSgCDCEIQQAhBSABIQADQCAIIAAoAgAiAkcEQCAFIAItAJ4BaiEFCyAAQQhqIgAgCkcNAAtBACECIAEhAANAAkAgACgCACIGIAhGDQACQCAGLQCcAQ0AIAYtAJ0BQQFxDQAgBi0AngFBAUcNAQsgAkEBaiECCyAAQQhqIgAgCkcNAAsgAiANSg0BIAUgC0ohAAwCCyAMIQAgDg0BDAQLIAkoAgwhBkEAIQIgASEAA0AgBiAAKAIAIghHBEAgAiAILQCeAWohAgsgAEEIaiIAIApHDQALIAJBAEoNASAFIAtMDQMMAQsgAEUNAgsgDw0BIAkoAgwhBUEAIQIDQAJAIAEoAgAiACAFRg0AIAAtAJ4BQQFHDQACQCACRQ0AIAAoApgBIgYgAigCmAEiCEgNACAGIAhHDQEgACgClAEgAigClAFODQELIAAhAgsgAUEIaiIBIApHDQALIAJFDQEgAkEAOgCeASADIAI2AgggAyAHNgIMIAQoAgggAyAENgIYIAMgA0EIajYCFCADIANBDGo2AhAgB0sEQCAHIAI2AgAgBCAHQQRqIgc2AgQMAQtBpNgBQQA2AgBBISADQRBqEAxBpNgBKAIAQaTYAUEANgIAQQFHBEAgBCADKAIMIgc2AgQMAQsLEAEgBCgCACIABEAgBCAANgIEIAQoAggaIAAQ2wELEAIACyADQSBqJAAL4AIBCH8CQCMAQSBrIgIkACAAIgNBADYCCCAAQgA3AgACQAJAIAFByPsIaiIGKAIAIgUgBigCBCIHRg0AA0BBACEAA0ACQCAFKAIAIgEtAJ4BQQFHDQACQCAARQ0AIAEoApgBIgggACgCmAEiCUgNACAIIAlHDQEgASgClAEgACgClAFODQELIAEhAAsgBUEIaiIFIAdHDQALIABFDQEgAEEAOgCeASACIAA2AgggAiAENgIMIAMoAgghASACIAM2AhggAiACQQhqNgIUIAIgAkEMajYCECADAn8gASAESwRAIAQgADYCACAEQQRqDAELQaTYAUEANgIAQSEgAkEQahAMQaTYASgCAEGk2AFBADYCAEEBRg0DIAIoAgwLIgQ2AgQgBigCACIFIAYoAgQiB0cNAAsLIAJBIGokAAwBCxABIAMoAgAiAARAIAMgADYCBCADKAIIGiAAENsBCxACAAsLQQAgACABKALM/Ag2AgAgAUEANgLM/AggACABKALQ/Ag2AgQgAUEANgLQ/AggACABKALU/Ag2AgggAUEANgLU/AgLpwIBBX8jAEEgayICJAAgAEEANgIIIABCADcCAAJAIAEoAsj7CCIDIAEoAsz7CCIFRg0AQQAhAQJAA0ACQCADKAIAIgQtAJ4BQQFGBEAgAiAENgIIIAIgATYCDCAAKAIIIQYgAiAANgIYIAIgAkEIajYCFCACIAJBDGo2AhAgAAJ/IAEgBkkEQCABIAQ2AgAgAUEEagwBC0Gk2AFBADYCAEEeIAJBEGoQDEGk2AEoAgBBpNgBQQA2AgBBAUYNAiACKAIMCyIBNgIECyAFIANBCGoiA0cNAQwCCwsQASAAKAIAIgEEQCAAIAE2AgQgACgCCBogARDbAQsQAgALIAAoAgAiACABRg0AIAAgAUE+IAEgAGtBAnVnQQF0a0EBELoBCyACQSBqJAALvCUBDn8CQANAIAFBBGshDCABQQxrIQ8gAUEIayEQA0ACQAJAAkACQAJAAkACQAJAAkACQCABIAAiBmtBAnUiBA4GDAwAAQQCAwsCQCABQQRrIgIoAgAiBCgCmAEiASAGKAIAIgMoApgBIgBHBEAgACABSg0BDA0LIAQoApQBIAMoApQBTg0MCyAGIAQ2AgAgAiADNgIADwsgAUEEayEHAkAgBigCBCIFKAKYASIEIAYoAgAiAygCmAEiAkcEQCACIARMDQEMCQsgBSgClAEgAygClAFIDQgLAkAgBCAHKAIAIgEoApgBIgBHBEAgACAESA0BDAwLIAEoApQBIAUoApQBTg0LCyAGIAE2AgQgByAFNgIAAkAgBigCBCIDKAKYASIBIAYoAgAiAigCmAEiAEcEQCAAIAFKDQEMDAsgAygClAEgAigClAFODQsLIAYgAjYCBCAGIAM2AgAPCyAGIAZBBGogBkEIaiAGQQxqEGMCQCABQQRrIgIoAgAiBCgCmAEiASAGKAIMIgMoApgBIgBHBEAgACABSg0BDAsLIAQoApQBIAMoApQBTg0KCyAGIAQ2AgwgAiADNgIAAkAgBigCDCIDKAKYASICIAYoAggiASgCmAEiAEcEQCAAIAJKDQEMCwsgAygClAEgASgClAFODQoLIAYgAzYCCCAGIAE2AgwCQCAGKAIEIgEoApgBIgAgAkcEQCAAIAJKDQEMCwsgAygClAEgASgClAFODQoLIAYgATYCCCAGIAM2AgQCQCAGKAIAIgEoApgBIgAgAkcEQCAAIAJKDQEMCwsgAygClAEgASgClAFODQoLIAYgATYCBCAGIAM2AgAPCyAEQRdMBEAgASAGRiAGQQRqIgAgAUZyIQIgA0EBcQRAIAINCiAGIQIDQCACIQQgACECAkACQCAEKAIEIggoApgBIgcgBCgCACIDKAKYASIARwRAIAAgB0oNAQwCCyAIKAKUASADKAKUAU4NAQsgBCADNgIEAn8gBiAEIAZGDQAaA0ACQCAEQQRrIgAoAgAiBSgCmAEiAyAHRwRAIAMgB0oNASAEDAMLIAgoApQBIAUoApQBSA0AIAQMAgsgBCAFNgIAIAAiBCAGRw0ACyAGCyAINgIACyACQQRqIgAgAUcNAAsMCgsgAg0JA0AgBiEFIAAhBgJAAkAgBSgCBCIHKAKYASIDIAUoAgAiBCgCmAEiAEcEQCAAIANKDQEMAgsgBygClAEgBCgClAFODQELIAYhAANAAkAgACAENgIAIAUiAEEEayIFKAIAIgQoApgBIgIgA0cEQCACIANKDQIMAQsgBygClAEgBCgClAFIDQELCyAAIAc2AgALIAZBBGoiACABRw0ACwwJCyACRQRAIAEgBkYNCSAEQQJrQQF2IgwhBQNAAkAgDCAFIgNJDQAgBUEBdCICQQFyIQAgBCACQQJqIglLBEAgCSAAAn8gBiAAQQJ0aigCACIIKAKYASIHIAYgCUECdGooAgAiBSgCmAEiAkcEQCACIAdKDAELIAgoApQBIAUoApQBSAsbIQALAkAgBiAAQQJ0aiIIKAIAIgcoApgBIgUgBiADQQJ0aiICKAIAIg8oApgBIhBHBEAgBSAQTg0BDAILIAcoApQBIA8oApQBSA0BCyACIAc2AgACQCAAIAxLDQADQCAAQQF0IgJBAXIhBSAEIAJBAmoiCkoEQCAKIAUCfyAGIAVBAnRqKAIAIgsoApgBIgkgBiAKQQJ0aigCACIHKAKYASICRwRAIAIgCUoMAQsgCygClAEgBygClAFICxshBQsCQCAQIAYgBUECdGoiAigCACIJKAKYASIHRwRAIAcgEE4NAQwDCyAJKAKUASAPKAKUAUgNAgsgBiAAQQJ0aiAJNgIAIAIhCCAMIAUiAE4NAAsLIAggDzYCAAsgA0EBayEFIAMNAAsDQCAEIghBAmtBAXYhDyAGKAIAIQxBACEEIAYhBQNAIARBAXQiAkEBciEAIAUiByAEQQJ0aiIEQQRqIQUCQCAIIAJBAmoiA0wEQCAAIQQMAQsCQCAEKAIEIhAoApgBIgogBEEIaiICKAIAIgsoApgBIglHBEAgACEEIAkgCkoNAQwCCyAAIQQgECgClAEgCygClAFODQELIAIhBSADIQQLIAcgBSgCADYCACAEIA9MDQALAkAgAUEEayIBIAVGBEAgBSAMNgIADAELIAUgASgCADYCACABIAw2AgAgBSAGa0EEakECdSIAQQJIDQACQCAGIABBAmtBAXYiBEECdGoiACgCACIDKAKYASICIAUoAgAiCygCmAEiCUcEQCACIAlIDQEMAgsgAygClAEgCygClAFODQELIAUgAzYCAAJAIARFBEAgACEHDAELA0ACQCAJIAYgBEEBa0EBdiIEQQJ0aiIHKAIAIgMoApgBIgJHBEAgAiAJSA0BIAAhBwwDCyADKAKUASALKAKUAUgNACAAIQcMAgsgACADNgIAIAchACAEDQALCyAHIAs2AgALIAhBAWshBCAIQQJKDQALDAkLIAYgBEEBdEF8cWohCiAEQYEBTwRAAkAgCigCACIJKAKYASIIIAYoAgAiBygCmAEiBUcEQCAFIAhMDQEMBQsgCSgClAEgBygClAFIDQQLAkAgCCAMKAIAIgQoApgBIgBHBEAgACAISA0BDAYLIAQoApQBIAkoApQBTg0FCyAKIAQ2AgAgDCAJNgIAAkAgCigCACIHKAKYASIEIAYoAgAiBSgCmAEiAEcEQCAAIARKDQEMBgsgBygClAEgBSgClAFODQULIAYgBzYCACAKIAU2AgAMBAsCQCAGKAIAIgkoApgBIgggCigCACIHKAKYASIFRwRAIAUgCEwNAQwDCyAJKAKUASAHKAKUAUgNAgsCQCAIIAwoAgAiBCgCmAEiAEcEQCAAIAhIDQEMBgsgBCgClAEgCSgClAFODQULIAYgBDYCACAMIAk2AgACQCAGKAIAIgcoApgBIgQgCigCACIFKAKYASIARwRAIAAgBEoNAQwGCyAHKAKUASAFKAKUAU4NBQsgCiAHNgIAIAYgBTYCAAwECyAGIAZBBGogBkEIaiABQQRrEGMMBwsCQAJAAkAgCCAMKAIAIgQoApgBIgBHBEAgACAISA0BDAILIAQoApQBIAkoApQBTg0BCyAKIAQ2AgAMAQsgCiAJNgIAIAYgBzYCAAJAIAUgDCgCACIEKAKYASIARwRAIAAgBUgNAQwFCyAEKAKUASAHKAKUAU4NBAsgBiAENgIACyAMIAc2AgAMAgsCQAJAAkAgCCAMKAIAIgQoApgBIgBHBEAgACAISA0BDAILIAQoApQBIAkoApQBTg0BCyAGIAQ2AgAMAQsgBiAJNgIAIAogBzYCAAJAIAUgDCgCACIEKAKYASIARwRAIAAgBUgNAQwDCyAEKAKUASAHKAKUAU4NAgsgCiAENgIACyAMIAc2AgALAkACQAJAIApBBGsiCygCACIJKAKYASIIIAYoAgQiBygCmAEiBUcEQCAFIAhMDQEMAgsgCSgClAEgBygClAFIDQELAkAgCCAQKAIAIgQoApgBIgBHBEAgACAISA0BDAMLIAQoApQBIAkoApQBTg0CCyALIAQ2AgAgECAJNgIAAkAgCygCACIHKAKYASIEIAYoAgQiBSgCmAEiAEcEQCAAIARKDQEMAwsgBygClAEgBSgClAFODQILIAYgBzYCBCALIAU2AgAMAQsCQAJAAkAgCCAQKAIAIgQoApgBIgBHBEAgACAISA0BDAILIAQoApQBIAkoApQBTg0BCyAGIAQ2AgQMAQsgBiAJNgIEIAsgBzYCAAJAIAUgECgCACIEKAKYASIARwRAIAAgBUgNAQwDCyAEKAKUASAHKAKUAU4NAgsgCyAENgIACyAQIAc2AgALAkACQAJAIAooAgQiCSgCmAEiCCAGKAIIIgcoApgBIgVHBEAgBSAITA0BDAILIAkoApQBIAcoApQBSA0BCwJAIAggDygCACIEKAKYASIARwRAIAAgCEgNAQwDCyAEKAKUASAJKAKUAU4NAgsgCiAENgIEIA8gCTYCAAJAIAooAgQiBygCmAEiBCAGKAIIIgUoApgBIgBHBEAgACAESg0BDAMLIAcoApQBIAUoApQBTg0CCyAGIAc2AgggCiAFNgIEDAELAkACQAJAIAggDygCACIEKAKYASIARwRAIAAgCEgNAQwCCyAEKAKUASAJKAKUAU4NAQsgBiAENgIIDAELIAYgCTYCCCAKIAc2AgQCQCAFIA8oAgAiBCgCmAEiAEcEQCAAIAVIDQEMAwsgBCgClAEgBygClAFODQILIAogBDYCBAsgDyAHNgIACwJAAkACQCAKKAIAIgAoApgBIgkgCygCACIEKAKY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MCAAIAY2AiwgAEEANgIcIAAoAhQhASAAQgA3AxAgAkF/IAEbIQILIAAgACgCACIAIAdBIHFyNgIAQX8gAiAAQSBxGwsgBUHQAWokAAuJEwITfwJ+IwBBQGoiCCQAIAggATYCPCAIQSlqIRcgCEEnaiEYIAhBKGohEQJAAkACQAJAA0BBACEHA0AgASENIAcgDkH/////B3NKDQIgByAOaiEOAkACQAJAAkAgASIHLQAAIgsEQANAAkACQCALQf8BcSIBRQRAIAchAQwBCyABQSVHDQEgByELA0AgCy0AAUElRwRAIAshAQwCCyAHQQFqIQcgCy0AAiALQQJqIgEhC0ElRg0ACwsgByANayIHIA5B/////wdzIhlKDQkgAARAIAAgDSAHENEBCyAHDQcgCCABNgI8IAFBAWohB0F/IRACQCABLAABQTBrIgpBCUsNACABLQACQSRHDQAgAUEDaiEHQQEhEiAKIRALIAggBzYCPEEAIQwCQCAHLAAAIgtBIGsiAUEfSwRAIAchCgwBCyAHIQpBASABdCIBQYnRBHFFDQADQCAIIAdBAWoiCjYCPCABIAxyIQwgBywAASILQSBrIgFBIE8NASAKIQdBASABdCIBQYnRBHENAAsLAkAgC0EqRgRAAn8CQCAKLAABQTBrIgFBCUsNACAKLQACQSRHDQACfyAARQRAIAQgAUECdGpBCjYCAEEADAELIAMgAUEDdGooAgALIQ8gCkEDaiEBQQEMAQsgEg0GIApBAWohASAARQRAIAggATYCPEEAIRJBACEPDAMLIAIgAigCACIHQQRqNgIAIAcoAgAhD0EACyESIAggATYCPCAPQQBODQFBACAPayEPIAxBgMAAciEMDAELIAhBPGoQ0gEiD0EASA0KIAgoAjwhAQtBACEHQX8hCQJ/QQAgAS0AAEEuRw0AGiABLQABQSpGBEACfwJAIAEsAAJBMGsiCkEJSw0AIAEtAANBJEcNACABQQRqIQECfyAARQRAIAQgCkECdGpBCjYCAEEADAELIAMgCkEDdGooAgALDAELIBINBiABQQJqIQFBACAARQ0AGiACIAIoAgAiCkEEajYCACAKKAIACyEJIAggATYCPCAJQQBODAELIAggAUEBajYCPCAIQTxqENIBIQkgCCgCPCEBQQELIRUDQCAHIRNBHCEKIAEiFCwAACIH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AAtBAEgEQCAAIAE2AgQMAQsgACABQf8AcToACwsgASADakEAOgAACyAAC8cBAQV/AkACfyAAKAIAIQIgASgCACEDAkACQCABKAIEIgEgACgCBCIEIAEgBEkbIgBBBE8EQCACIANyQQNxDQEDQCACKAIAIAMoAgBHDQIgA0EEaiEDIAJBBGohAiAAQQRrIgBBA0sNAAsLIABFDQELA0AgAi0AACIFIAMtAAAiBkYEQCADQQFqIQMgAkEBaiECIABBAWsiAA0BDAILCyAFIAZrDAELQQALIgANAEEAIQAgASAERg0AQX9BASABIARLGyEACyAACxAAIAAgATYCBCAAIAI2AgALRwECfyMAQRBrIgMkACADQQhqIAAgASAAKAIAKAIMEQUAIAIoAgQgAygCDCACKAIAIQIgAygCCCEEIANBEGokAEYgAiAERnELEwAgACABKAIERiABKAIAIAJGcQuMAQEDfyAAIQIgARDNASEDAn8jAEEQayIEJAAgA0H3////B0kEQAJAIANBCk0EQCACIAM6AAsMAQsgBEEEaiADEO4BIAIgBCgCDDYCCCACIAQpAgQ3AgAgAigCACECCyAEQRBqJAAgAgwBCxDvAQALIQIgAwRAIAIgASAD/AoAAAsgAiADakEAOgAAIAALBQBB/hYLyQEBBH8CQCMAQZAIayIDJABB8NIBKAIAIQUCQAJAAkACQAJ/IANBEGohASACEOwBIgQQzQEiBkGACE8EQCABIARB/wcQxQEgAUEAOgD/B0HEAAwBCyABIAQgBkEBahDFAUEACyIEQQFqDgIAAgELQfDSASgCACEECyAEQRxHDQFB9SUhAQsgAS0AAEUEQCADIAI2AgAgA0EQaiIBQYAIQdsWIAMQzAEaC0Hw0gEgBTYCACAAIAEQ9wEaIANBkAhqJAAMAQsQywEACwvEAQEDfyMAQRBrIgQkAAJAIAEoAgAiBQRAIAIoAgQgAiwACyIDIANBAEgbBEAgAkGnI0GnIxDNARDyARogASgCACEFCyAEQQRqIgMgASgCBCIBIAUgASgCACgCGBEFAEGk2AFBADYCAEHxACACIAMQChpBpNgBKAIAQaTYAUEANgIAQQFGDQEgAxDwAQsgACACKAIINgIIIAAgAikCADcCACACQgA3AgAgAkEANgIIIARBEGokAA8LEAEgBEEEahDwARACAAsnAQF/IAAgASgCACABIAEsAAsiAEEASCICGyABKAIEIAAgAhsQ8gELvgEBA38jAEEgayIDJAAgA0EIaiACEPcBIQRBpNgBQQA2AgBB8gAgA0EUaiICIAEgBBASQaTYASgCACEFQaTYAUEANgIAAkACQCAFQQFHBEBBpNgBQQA2AgBB8wAgACACEAohAEGk2AEoAgBBpNgBQQA2AgBBAUYNASACEPABIAQQ8AEgAEHw7gA2AgAgACABKQIANwIIIANBIGokACAADwsQASECDAELEAEhAiADQRRqEPABCyAEEPABIAIQAgALBwAgABCjAgsKACAAEKMCENsBC5ABAgJ/AX4jAEEQayICJAAgAkHMygE2AgwgAiAANgIIIAIgAikCCDcDACMAQRBrIgAkAEEQEIECIQMgAikCACEEQaTYAUEANgIAIAAgBDcDCCAAIAQ3AwBB9AAgAyAAIAEQAyEAQaTYASgCAEGk2AFBADYCAEEBRwRAIABB/O4AQfUAEAsACxABIAMQggIQAgALEQAgACgCABpBHEGKFhD/AQALXwECf0Gk2AFBADYCAEH/ACAAQRtqQXxxIgEQACEAQaTYASgCACECQaTYAUEANgIAAkAgAkEBRwRAIABFDQEgAQRAIABBACAB/AsACyAAQRhqDwtBABAFEB8ACxCGAgALMwBBpNgBQQA2AgBBgAEgAEEYaxAMQaTYASgCAEGk2AFBADYCAEEBRwRADwtBABAFEB8ACxkAIAAEQCAAQRhrIgAgACgCAEEBajYCAAsLrAEBAX8CQAJAIABFDQAgAEEYayIBKAIARQRAQaTYAUEANgIAQYEBQaQcQYMPQZUBQaELEA1BpNgBKAIAQaTYAUEANgIAQQFGDQIACyABIAEoAgAiAUEBazYCACABQQFHDQAgAEELay0AAA0AIABBEGsoAgAiAQRAQaTYAUEANgIAIAEgABAAGkGk2AEoAgBBpNgBQQA2AgBBAUYNAgsgABCCAgsPC0EAEAUQHwAL8wEBAn8jAEEQayIDJABBmiNBC0GA2AAoAgAiAhDHASADIAE2AgwgAiAAIAFB5gBB5wAQzwEaAkACQCACKAJMIgBBAE4EQCAARQ0BQczTASgCACAAQf////8DcUcNAQsCQCACKAJQQQpGDQAgAigCFCIAIAIoAhBGDQAgAiAAQQFqNgIUIABBCjoAAAwCCyACEO0BDAELIAIgAigCTCIAQf////8DIAAbNgJMAkACQCACKAJQQQpGDQAgAigCFCIAIAIoAhBGDQAgAiAAQQFqNgIUIABBCjoAAAwBCyACEO0BCyACKAJMGiACQQA2AkwLEMsBAAuRAQEBf0HQygEoAgBBpNgBQQA2AgAQCEGk2AEoAgAhAEGk2AFBADYCAAJAIABBAUcEQEGk2AFBADYCAEGDAUG6FUEAEARBpNgBKAIAQaTYAUEANgIAQQFHDQELQQAQBRAGGkGk2AFBADYCAEGDAUHiEEEAEARBpNgBKAIAQaTYAUEANgIAQQFHDQBBABAFEB8LAAsLAEG5H0EAEIUCAAuuBgEIfyMAQRBrIgUkAEEBIAAgAEEBTRsiBiAGQQ9qQXBxIgAgACAGSRsiAEEPcUUEQAJ/QTAgAEGwf0sNABpBMAJ/IABBsH9PBEBB8NIBQTA2AgBBAAwBC0EAQRAgAEELakF4cSAAQQtJGyICQRxqENoBIgBFDQAaIABBCGshAQJAIABBD3FFBEAgASEADAELIABBBGsiBygCACIIQXhxIABBD2pBcHFBCGsiAEEQQQAgACABa0EPTRtqIgAgAWsiA2shBCAIQQNxRQRAIAEoAgAhASAAIAQ2AgQgACABIANqNgIADAELIAAgBCAAKAIEQQFxckECcjYCBCAAIARqIgQgBCgCBEEBcjYCBCAHIAMgBygCAEEBcXJBAnI2AgAgASADaiIEIAQoAgRBAXI2AgQgASADEN0BCwJAIAAoAgQiAUEDcUUNACABQXhxIgMgAkEQak0NACAAIAIgAUEBcXJBAnI2AgQgACACaiIBIAMgAmsiAkEDcjYCBCAAIANqIgMgAygCBEEBcjYCBCABIAIQ3QELIABBCGoLIgBFDQAaIAUgADYCDEEACyEAQQAgBSgCDCAAGyEBCyAFQRBqJAAgAQR/IAEFAn9BACEBIwBBIGsiAyQAQbDYASgCACICRQRAQczYAUGAgfQDNgIAQbDYAUHM2AE2AgBBzNgBIQILIAZBA2pBAnYiB0EBaiEFA0ACQAJAAkAgAiIAQcDcAUYEQEEAIQYMAQsgAEEEaiIGQQ9xDQEgAC8BAiICIAVrQQNxQQAgAiAFSxsgBWoiBCACSQRAIAAgAiAEayIBOwECIAAgAUH//wNxQQJ0aiIAIAQ7AQIgAEEAOwEAIABBBGoiBkEPcUUNASADQfUlNgIIIANBpwE2AgQgA0GHEDYCAEHvDSADEIUCAAsgAiAHTQ0CIAAvAQAhAgJAIAFFBEBBsNgBIAJBAnRBwNgBajYCAAwBCyABIAI7AQALIABBADsBAAsgA0EgaiQAIAYMAwsgA0H1JTYCGCADQZIBNgIUIANBhxA2AhBB7w0gA0EQahCFAgALIAAvAQBBAnRBwNgBaiECIAAhAQwACwALCwvrAQEGfwJAIABBwNgBSQ0AIABBwNwBTw0AIABBAmshBCAAQQRrIQFBsNgBKAIAIgUhAgJAA0ACQCACIgBFDQAgAEHA3AFGDQAgASAAIAAvAQIiAkECdGpGBEAgACAELwEAIAJqOwECDAMLIAAgASAELwEAIgZBAnRqRgRAIAQgAiAGajsBACADRQRAQbDYASABNgIAIAEgAC8BADsBAAwECyADIAFBwNgBa0ECdjsBAAwDBSAALwEAQQJ0QcDYAWohAiAAIQMMAgsACwsgASAFQcDYAWtBAnY7AQBBsNgBIAE2AgALDwsgABDbAQt0AQF/IAJFBEAgACgCBCABKAIERg8LIAAgAUYEQEEBDwsgASgCBCICLQAAIQECQCAAKAIEIgMtAAAiAEUNACAAIAFHDQADQCACLQABIQEgAy0AASIARQ0BIAJBAWohAiADQQFqIQMgACABRg0ACwsgACABRgvOAQECfyMAQdAAayIDJAACQAJ/QQEgACgCBCABKAIERg0AGkEAIAFB9O8AQaTwABCMAiIBRQ0AGiACKAIAIgRFDQEgA0EYakEAQTj8CwAgA0EBOgBLIANBfzYCICADIAA2AhwgAyABNgIUIANBATYCRCABIANBFGogBEEBIAEoAgAoAhwRBgAgAygCLCIAQQFGBEAgAiADKAIkNgIACyAAQQFGCyADQdAAaiQADwsgA0HxGDYCCCADQecDNgIEIANBww42AgBB7w0gAxCFAgALlQMBBH8jAEFAaiIDJAAgACAAKAIAIgRBCGsoAgAiBmohBQJAIARBBGsoAgAiBCgCBCACKAIERgRAQQAgBSAGGyEADAELIAAgBU4EQCADQgA3AhQgA0EANgIQIAMgAjYCDCADIAA2AgggAyAENgIEIANCADcCHCADQgA3AiQgA0IANwIsIANBADYCPCADQoGAgICAgICAATcCNCAEIANBBGogBSAFQQFBACAEKAIAKAIUEQcAIAMoAhwNAQsgA0IANwIUIANBADYCECADIAE2AgwgAyAANgIIIAMgAjYCBCADQgA3AhwgA0IANwIkIANCADcCLCADQgA3ADMgA0EANgI8IANBAToAOyAEIANBBGogBUEBQQAgBCgCACgCGBEIAEEAIQACQAJAIAMoAigOAgABAgsgAygCGEEAIAMoAiRBAUYbQQAgAygCIEEBRhtBACADKAIsQQFGGyEADAELIAMoAhxBAUcEQCADKAIsDQEgAygCIEEBRw0BIAMoAiRBAUcNAQsgAygCFCEACyADQUBrJAAgAAt2AQF/IAAoAiQiA0UEQCAAIAI2AhggACABNgIQIABBATYCJCAAIAAoAjg2AhQPCwJAAkAgACgCFCAAKAI4Rw0AIAAoAhAgAUcNACAAKAIYQQJHDQEgACACNgIYDwsgAEEBOgA2IABBAjYCGCAAIANBAWo2AiQLCxwAIAAoAgQgASgCCCgCBEYEQCABIAIgAxCNAgsLNQAgACgCBCABKAIIKAIERgRAIAEgAiADEI0CDwsgACgCCCIAIAEgAiADIAAoAgAoAhwRBgALewEDfyAAKAIEIgRBAXEhBgJ/IAEtADdBAUYEQCAEQQh1IgUgBkUNARogAigCACAFaigCAAwBCyAEQQh1IAZFDQAaIAEgACgCACgCBDYCOEEAIQJBAAshBSAAKAIAIgAgASACIAVqIANBAiAEQQJxGyAAKAIAKAIcEQYAC3IBAn8gACgCBCABKAIIKAIERgRAIAEgAiADEI0CDwsgACgCDCEEIABBEGoiBSABIAIgAxCQAgJAIARBAkkNACAFIARBA3RqIQQgAEEYaiEAA0AgACABIAIgAxCQAiABLQA2DQEgAEEIaiIAIARJDQALCwuaAQAgAEEBOgA1AkAgAiAAKAIERw0AIABBAToANAJAIAAoAhAiAkUEQCAAQQE2AiQgACADNgIYIAAgATYCECADQQFHDQIgACgCMEEBRg0BDAILIAEgAkYEQCAAKAIYIgJBAkYEQCAAIAM2AhggAyECCyAAKAIwQQFHDQIgAkEBRg0BDAILIAAgACgCJEEBajYCJAsgAEEBOgA2CwvDBAEDfwJAIAAgASgCCCAEEIoCBEAgAiABKAIERw0BIAEoAhxBAUYNASABIAM2AhwPCwJAIAAgASgCACAEEIoCBEACQCABKAIQIAJHBEAgAiABKAIURw0BCyADQQFHDQMgAUEBNgIgDwsgASADNgIgIAEoAixBBEYNASAAQRBqIgUgACgCDEEDdGohB0EAIQMDQAJAAkAgAQJ/AkAgBSAHTw0AIAFBADsBNCAFIAEgAiACQQEgBBCUAiABLQA2DQAgAS0ANUEBRw0DIAEtADRBAUYEQCABKAIYQQFGDQNBASEGQQEhAyAALQAIQQJxRQ0DDAQLQQEhAyAALQAIQQFxDQNBAwwBC0EDQQQgAxsLNgIsIAYNBQwECyABQQM2AiwMBAsgBUEIaiEFDAALAAsgACgCDCEFIABBEGoiBiABIAIgAyAEEJUCIAVBAkkNASAGIAVBA3RqIQYgAEEYaiEFAkAgACgCCCIAQQJxRQRAIAEoAiRBAUcNAQsDQCABLQA2DQMgBSABIAIgAyAEEJUCIAVBCGoiBSAGSQ0ACwwCCyAAQQFxRQRAA0AgAS0ANg0DIAEoAiRBAUYNAyAFIAEgAiADIAQQlQIgBUEIaiIFIAZJDQAMAwsACwNAIAEtADYNAiABKAIkQQFGBEAgASgCGEEBRg0DCyAFIAEgAiADIAQQlQIgBUEIaiIFIAZJDQALDAELIAEgAjYCFCABIAEoAihBAWo2AiggASgCJEEBRw0AIAEoAhhBAkcNACABQQE6ADYLC0sBAn8gACgCBCIGQQh1IQcgACgCACIAIAEgAiAGQQFxBH8gAygCACAHaigCAAUgBwsgA2ogBEECIAZBAnEbIAUgACgCACgCFBEHAAtJAQJ/IAAoAgQiBUEIdSEGIAAoAgAiACABIAVBAXEEfyACKAIAIAZqKAIABSAGCyACaiADQQIgBUECcRsgBCAAKAIAKAIYEQgAC4oCAAJAIAAgASgCCCAEEIoCBEAgAiABKAIERw0BIAEoAhxBAUYNASABIAM2AhwPCyAAIAEoAgAgBBCKAgRAAkAgASgCECACRwRAIAIgASgCFEcNAQsgA0EBRw0CIAFBATYCIA8LIAEgAzYCIAJAIAEoAixBBEYNACABQQA7ATQgACgCCCIAIAEgAiACQQEgBCAAKAIAKAIUEQcAIAEtADVBAUYEQCABQQM2AiwgAS0ANEUNAQwDCyABQQQ2AiwLIAEgAjYCFCABIAEoAihBAWo2AiggASgCJEEBRw0BIAEoAhhBAkcNASABQQE6ADYPCyAAKAIIIgAgASACIAMgBCAAKAIAKAIYEQgACwumAQACQCAAIAEoAgggBBCKAgRAIAIgASgCBEcNASABKAIcQQFGDQEgASADNgIcDwsgACABKAIAIAQQigJFDQACQCABKAIQIAJHBEAgAiABKAIURw0BCyADQQFHDQEgAUEBNgIgDwsgASACNgIUIAEgAzYCICABIAEoAihBAWo2AigCQCABKAIkQQFHDQAgASgCGEECRw0AIAFBAToANgsgAUEENgIsCwuXAgEGfyAAIAEoAgggBRCKAgRAIAEgAiADIAQQkgIPCyABLQA1IAAoAgwhBiABQQA6ADUgAS0ANCEIIAFBADoANCAAQRBqIgkgASACIAMgBCAFEJQCIAEtADUiCnIhByAIIAEtADQiC3IhCAJAIAZBAkkNACAJIAZBA3RqIQkgAEEYaiEGA0AgAS0ANg0BAkAgC0EBcQRAIAEoAhhBAUYNAyAALQAIQQJxDQEMAwsgCkEBcUUNACAALQAIQQFxRQ0CCyABQQA7ATQgBiABIAIgAyAEIAUQlAIgAS0ANSIKIAdyQQFxIQcgAS0ANCILIAhyQQFxIQggBkEIaiIGIAlJDQALCyABIAdBAXE6ADUgASAIQQFxOgA0CzkAIAAgASgCCCAFEIoCBEAgASACIAMgBBCSAg8LIAAoAggiACABIAIgAyAEIAUgACgCACgCFBEHAAscACAAIAEoAgggBRCKAgRAIAEgAiADIAQQkgILC0MBAX8jAEEQayIDJAAgAyACKAIANgIMIAAgASADQQxqIAAoAgAoAhARBAAiAARAIAIgAygCDDYCAAsgA0EQaiQAIAALPAEBfwJAIABBFGsoAgAiAUUNACABQbD1AEGE8QAQjAJFDQAgACgCAA8LIABBCGsoAgAiASAAQRhrIAEbCwUAQewWCwUAQYYTCxUAIABBoPQANgIAIABBBGoQoAIgAAstAQF/IAAoAgAiAEEEayIBIAEoAgBBAWsiATYCACABQQBIBEAgAEEMaxDbAQsLDQAgABCfAhogABDbAQsHACAAKAIECxUAIABBtPQANgIAIABBBGoQoAIgAAsNACAAEKMCGiAAENsBCwYAIAAkAAsQACMAIABrQXBxIgAkACAACwQAIwALcgIDfwF+IwBBIGsiAiQAIAAoAgQhAyACIAAoAgAiBDYCGCACIAMgBGs2AhwgAiABKQIAIgU3AxAgAiACKQIYNwMIIAIgBTcDACACQQhqIAIQtgIiAQRAIAAgACgCACAFQiCIp2o2AgALIAJBIGokACABC+0bAgx/AX4jAEGQAWsiBCQAIARBxABqIAAQuAIhDAJAAkACQAJAIAAoAgQiBiAAKAIAIgVGDQAgBiAFayECIAUtAAAiA0HHAEcEQCADQdQARw0BAkAgAkECSQ0AAkACQAJAAkACQAJAAkACQAJAAkAgBS0AASIDQcEAaw4JAQoGCgoKCggEAAsgA0HTAGsOBQQCCQEGCAsgACAFQQJqNgIAQaTYAUEANgIAQZ8BIAAQACECQaTYASgCAEGk2AFBADYCAEEBRg0NIAJFDQwgAEGYA2pBFBCqAiIBQRU6AAQgASACNgIQIAFBHjYCDCABQaggNgIIIAFBrPYANgIAIAEgAS8ABUGA4ANxQcAKcjsABQwMCyAAIAVBAmo2AgBBpNgBQQA2AgBBnQEgABAAIQJBpNgBKAIAQaTYAUEANgIAQQFGDQwgAkUNCyAAQZgDakEUEKoCIgFBFToABCABIAI2AhAgAUELNgIMIAFBwCE2AgggAUGs9gA2AgAgASABLwAFQYDgA3FBwApyOwAFDAsLIAAgBUECajYCAEGk2AFBADYCAEGdASAAEAAhAkGk2AEoAgBBpNgBQQA2AgBBAUYNCyACRQ0KIABBmANqQRQQqgIiAUEVOgAEIAEgAjYCECABQQg2AgwgAUHgITYCCCABQaz2ADYCACABIAEvAAVBgOADcUHACnI7AAUMCgsgACAFQQJqNgIAQaTYAUEANgIAQZ0BIAAQACECQaTYASgCAEGk2AFBADYCAEEBRg0KIAJFDQkgAEGYA2pBFBCqAiIBQRU6AAQgASACNgIQIAFBDTYCDCABQccgNgIIIAFBrPYANgIAIAEgAS8ABUGA4ANxQcAKcjsABQwJCyAAIAVBAmo2AgBBpNgBQQA2AgBBnQEgABAAIQJBpNgBKAIAQaTYAUEANgIAQQFGDQkgAkUNCCAAQZgDakEUEKoCIgFBFToABCABIAI2AhAgAUESNgIMIAFBoCE2AgggAUGs9gA2AgAgASABLwAFQYDgA3FBwApyOwAFDAgLIAAgBUECajYCAEGk2AFBADYCAEGdASAAEAAhBkGk2AEoAgBBpNgBQQA2AgBBAUYNCCAGRQ0HIARBLGogAEEBEKsCIAQoAjBFDQcgACgCACIDIAAoAgRGDQcgAy0AAEHfAEcNByAAIANBAWo2AgBBpNgBQQA2AgBBnQEgABAAIQJBpNgBKAIAQaTYAUEANgIAQQFGDQggAkUNByAAQZgDakEQEKoCIgFBFjoABCABIAY2AgwgASACNgIIIAFB+PcANgIAIAEgAS8ABUGA4ANxQcAKcjsABQwHCyAAIAVBAmo2AgBBpNgBQQA2AgBBoAEgAEEAEAohAkGk2AEoAgBBpNgBQQA2AgBBAUYNByAEIAI2AiwgAkUNBiAAQdUgIARBLGoQrAIhAQwGCyAAIAVBAmo2AgBBpNgBQQA2AgBBoAEgAEEAEAohAkGk2AEoAgBBpNgBQQA2AgBBAUYNBiACRQ0FIABBmANqQRQQqgIiAUEVOgAEIAEgAjYCECABQSg2AgwgAUH3IDYCCCABQaz2ADYCACABIAEvAAVBgOADcUHACnI7AAUMBQsgA0HjAEYNAwsgACAFQQFqIgM2AgAgAyAGRwRAIAMtAABB9gBGIQcLIAAQuwINA0Gk2AFBADYCAEGcASAAEAAhAkGk2AEoAgBBpNgBQQA2AgBBAUYNBCACRQ0DIABBmANqQRQQqgIiAUEVOgAEIAFBrPYANgIAIAEgAS8ABUGA4ANxQcAKcjsABSAHBEAgASACNgIQIAFBETYCDCABQYgiNgIIDAQLIAEgAjYCECABQRU2AgwgAUGEIjYCCAwDCyACQQJJDQICQAJAAkAgBS0AASIDQdIAaw4FAQUFBQACCyAAIAVBAmo2AgBBpNgBQQA2AgBBoAEgAEEAEAohAkGk2AEoAgBBpNgBQQA2AgBBAUYNBSACRQ0EIABBmANqQRQQqgIiAUEVOgAEIAEgAjYCECABQRM2AgwgAUHMITYCCCABQaz2ADYCACABIAEvAAVBgOADcUHACnI7AAUMBAsgACAFQQJqNgIAQaTYAUEANgIAQaABIABBABAKIQJBpNgBKAIAQaTYAUEANgIAQQFGDQQgAkUNAyAAIARBLGoQvAIhAwJAAkAgACgCACIBIAAoAgRGDQAgAS0AAEHfAEcNACAAIAFBAWo2AgAMAQtBACEBIANFDQQLIABBmANqQRQQqgIiAUEVOgAEIAEgAjYCECABQRg2AgwgAUGPIDYCCCABQaz2ADYCACABIAEvAAVBgOADcUHACnI7AAUMAwsgA0HJAEcNAiAAIAVBAmo2AgAgBEEANgIsIAAgBEEsahC9Ag0CIAQoAiwiA0UNAiAAQZgDakEUEKoCIgFBFToABCABIAM2AhAgAUEXNgIMIAFB2SI2AgggAUGs9gA2AgAgASABLwAFQYDgA3FBwApyOwAFDAILIAQgADYCQCAEQQA6ADQgBEEANgIwIARBADsBLCAAKALoAiECIAAoAuwCIQMgBEEAOgA8QaTYAUEANgIAIAQgAyACa0ECdTYCOEGgASAAIARBLGoQCiEDQaTYASgCAEGk2AFBADYCAEEBRg0CIANFDQEgAEHoAmohCSAEKAI4IgEgACgC7AIgACgC6AJrQQJ1IgogASAKSxshCyAAQcwCaiEIIAEhAgJAAkACQANAIAIgC0cEQEGk2AFBADYCAEGhASAJIAIQCkGk2AEoAgBBpNgBQQA2AgBBAUYNBCAAKALMAiAAKALQAkYNAigCACgCCCEHQaTYAUEANgIAQaIBIAhBABAKQaTYASgCAEGk2AFBADYCAEEBRg0EKAIARQ0CQaTYAUEANgIAQaIBIAhBABAKIQVBpNgBKAIAQaTYAUEANgIAQQFGDQQgByAFKAIAIgYoAgQgBigCAGtBAnVPDQJBpNgBQQA2AgBBogEgCEEAEApBpNgBKAIAQaTYAUEANgIAQQFGDQQoAgAhBkGk2AFBADYCAEGjASAGIAcQCkGk2AEoAgBBpNgBQQA2AgBBAUYNBCgCACEHQaTYAUEANgIAQaEBIAkgAhAKQaTYASgCAEGk2AFBADYCAEEBRg0EKAIAIAc2AgwgAkEBaiECDAELCyAAKALsAiAAKALoAiICa0ECdSABSQRAIARB2RM2AgBBpNgBQQA2AgAgBEGJATYCBCAEQZwfNgIIQYMBQe8NIAQQBEGk2AEoAgBBpNgBQQA2AgBBAUYNBgALIAAgAiABQQJ0ajYC7AIMAQtBACEBIAIgCkkNAwsgBEFAaxC/AgRAIAMhAQwDCyAEQQ02AiggBEHOGDYCJCAEIAQpAiQ3AxBBACEJQQAhCAJAAkAgACAEQRBqEKgCBEAgAEEIaiEGIAAoAgwgACgCCGtBAnUhAgNAAkAgACgCACIBIAAoAgRHBEAgAS0AAEHFAEYNAQtBpNgBQQA2AgBBnwEgABAAIQVBpNgBKAIAQaTYAUEANgIAQQFGDQggBCAFNgIYIAVFDQMgBiAEQRhqEMACDAELCyAAIAFBAWo2AgBBpNgBQQA2AgBBpAEgBEEYaiAAIAIQEkGk2AEoAgBBpNgBQQA2AgBBAUYNAiAAQZgDakEQEKoCIQggBCkDGCENIAhBCjoABCAIIA03AgggCEHAtgE2AgAgCCAILwAFQYDgA3FBwApyOwAFCwJAIAQtACwNACAELQAtQQFxRQ0AQQAhAUGk2AFBADYCAEGdASAAEAAhCUGk2AEoAgBBpNgBQQA2AgBBAUYNBiAJRQ0FCwJ/AkAgACgCACICIAAoAgQiAUYNACACLQAAQfYARw0AIAAgAkEBaiIGNgIAQQAhB0EADAELIABBmANqIQsgAEEIaiEHIAAoAgwgACgCCGsiBUECdSEGIAQtADxBAXEhAgNAQaTYAUEANgIAQZ0BIAAQACEKQaTYASgCAEGk2AFBADYCAEEBRg0HIAQgCjYCGCAKRQ0CAkAgBSAAKAIMIAAoAghrRw0AIAJFDQAgC0EMEKoCIgFB1wA6AAQgASAKNgIIIAFBsLcBNgIAIAEgAS8ABUGA4ANxQcAKcjsABSAEIAE2AhgLIAcgBEEYahDAAiAEQUBrEL8CRQRAIAAoAgAiASAAKAIERg0BIAEtAABB0QBHDQELC0Gk2AFBADYCAEGkASAEQRhqIAAgBhASQaTYASgCAEGk2AFBADYCAEEBRg0GIAQoAhwhByAAKAIEIQEgACgCACEGIAQoAhgLIQVBACECAkAgASAGRg0AIAYtAABB0QBHDQAgACAGQQFqNgIAQQAhAUGk2AFBADYCAEGlASAAEAAhAkGk2AEoAgBBpNgBQQA2AgBBAUYNBiACRQ0FCyAAQZgDakEoEKoCIAQoAjAhBiAELQA0IQBBE0EAQQFBABDcAiIBIAA6ACQgASAGNgIgIAEgAjYCHCABIAg2AhggASAHNgIUIAEgBTYCECABIAM2AgwgASAJNgIIIAFBqLgBNgIADAQLQQAhAQwDCwwDCwwCCyAAIAVBAmo2AgAgABC7Ag0AIAAQuwINAEGk2AFBADYCAEGcASAAEAAhAkGk2AEoAgBBpNgBQQA2AgBBAUYNASACRQ0AIABBmANqQRQQqgIiAUEVOgAEIAEgAjYCECABQRo2AgwgAUHpITYCCCABQaz2ADYCACABIAEvAAVBgOADcUHACnI7AAULIAwQwwIgBEGQAWokACABDwsQASAMEMMCEAIAC6MBAQN/AkACQCAAKAKAICICKAIEIgMgAUEPakFwcSIEakH4H0kEQCACIQEMAQsgBEH5H08EQCAEQQhyENoBIgBFDQIgAigCACEBIABBADYCBCAAIAE2AgAgAiAANgIAIABBCGoPC0GAIBDaASIBRQ0BQQAhAyABQQA2AgQgASACNgIAIAAgATYCgCALIAEgAyAEajYCBCABIANqQQhqDwsQhgIAC6QBAQR/IAEoAgQhBSABKAIAIgQhAwJAIAJFDQAgBCAFRg0AIAQtAABB7gBHDQAgASAEQQFqIgM2AgALAkAgAyAFRgRAQQAhAgwBC0EAIQIgAywAAEEwa0EJSw0AA0ACQCADIAVHBH8gAywAAEEwa0EJTQ0BIAMFIAULIARrIQYgBCECDAILIAEgA0EBaiIDNgIADAALAAsgACAGNgIEIAAgAjYCAAtZAQF/IABBmANqQRQQqgIhACABEM0BIQMgAigCACECIABBFToABCAAIAI2AhAgACADNgIMIAAgATYCCCAAQaz2ADYCACAAIAAvAAVBgOADcUHACnI7AAUgAAuNKQIJfwF+IwBBMGsiBCQAIARBADYCGAJAAkACQAJAAkACQAJAAkACQAJAIAAoAgQiBSAAKAIAIgJGDQAgBSACayEDAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAItAAAiAUHBAGsOOhghHhchJh8hISEAIRkhHRshHCAaJQAhISEhISEhISEhBQMEEhMRFAYJCiELDA8QISEABwgWAQINDhUhCyADIAFB8gBGIgFNDSRBAkEBIAEbIAEgASACai0AAEHWAEYbIgEgA0kEQCABIAEgAmotAABBywBGaiEBCyABIANPDSQCQCABIAJqLQAAQcQAaw4DACUmJQsgAyABQQFqIgFNDSQgASACai0AACIBQe8AayICQQlLDSNBASACdEGBBnFFDSMMJQsgACACQQFqNgIAIABBtRUQxAIhAQwoCyAAIAJBAWo2AgAgAEGdDRDEAiEBDCcLIAAgAkEBajYCACAAQdkSEMQCIQEMJgsgACACQQFqNgIAIABBtQ4QxAIhAQwlCyAAIAJBAWo2AgAgAEGuDhDEAiEBDCQLIAAgAkEBajYCACAAQawOEMQCIQEMIwsgACACQQFqNgIAIABBkQsQxAIhAQwiCyAAIAJBAWo2AgAgAEGICxDEAiEBDCELIAAgAkEBajYCACAAQc0LEMQCIQEMIAsgACACQQFqNgIAIABBxAsQxAIhAQwfCyAAIAJBAWo2AgAgAEG7FBDEAiEBDB4LIAAgAkEBajYCACAAQbIUEMQCIQEMHQsgACACQQFqNgIAIABBqBQQxAIhAQwcCyAAIAJBAWo2AgAgAEGYA2pBEBCqAiIBQQg6AAQgAUESNgIMIAFBnxQ2AgggAUHw+AA2AgAgASABLwAFQYDgA3FBwApyOwAFDBsLIAAgAkEBajYCACAAQfEbEMQCIQEMGgsgACACQQFqNgIAIABB6BsQxAIhAQwZCyAAIAJBAWo2AgAgAEGBDRDEAiEBDBgLIAAgAkEBajYCACAAQZkVEMQCIQEMFwsgACACQQFqNgIAIABBlBUQxAIhAQwWCyAAIAJBAWo2AgAgAEH6GxDEAiEBDBULIAAgAkEBajYCACAAQeMcEMQCIQEMFAsgACACQQFqNgIAIARBKGogABDFAiAEKAIsRQ0SAkAgACgCACIBIAAoAgRGDQAgAS0AAEHJAEcNACAAIAFBAWo2AgAgABCtAiICRQ0TIAAoAgAiASAAKAIERg0TIAEtAABBxQBHDRMgACABQQFqNgIAIABBmANqQRQQqgIhASAEKQMoIQogAUEHOgAEIAEgAjYCECABIAo3AgggAUGsvwE2AgAgASABLwAFQYDgA3FBwApyOwAFDA0LIAAgBEEoahDGAiEBDAwLQQAhASADQQJJDRICQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCACLQABIgZBwQBrDjgFCCUlJQQlJSUlDiUlJSElJQYHEAglJSUlJSUlJSUlJQwlDQABAiUDCSUOJSUPIRIlJQoQCxEhISULIAAgAkECajYCACAAQZAcEMQCIQEMJAsgACACQQJqNgIAIABBhRwQxAIhAQwjCyAAIAJBAmo2AgAgAEGaHBDEAiEBDCILIAAgAkECajYCACAAQdoUEMQCIQEMIQsgACACQQJqNgIAIARBAzYCFCAEQYwXNgIQIAQgBCkCEDcDACAAIAQQqAIEQCAAQa0NEMQCIQEMIQsgBEEoaiICIABBABCrAiAAIAIQxgIhAyAAKAIAIgIgACgCBEYNICACLQAAQd8ARw0gIAAgAkEBajYCACAAQZgDakEMEKoCIgFBHzoABCABIAM2AgggAUGcwAE2AgAgASABLwAFQYDgA3FBwApyOwAFDCALIANBAkYEQCAAIAJBA2o2AgAMIAsgAi0AAiEDIAAgAkEDajYCAAJAAkACQAJAAkACQCADQekAaw4MAgMlBAUlJSUlJQABJQsgAEHPERDEAiEBDCQLIABBxhEQxAIhAQwjCyAAQaESEMQCIQEMIgsgAEGYEhDEAiEBDCELIABBhxIQxAIhAQwgCyAAQf4REMQCIQEMHwsgA0ECRgRAIAAgAkEDajYCAAwfCyACLQACIQMgACACQQNqNgIAAkACQAJAAkACQAJAIANB6QBrDgwCAyQEBSQkJCQkAAEkCyAAQagMEMQCIQEMIwsgAEGfDBDEAiEBDCILIABB+gwQxAIhAQwhCyAAQfEMEMQCIQEMIAsgAEHgDBDEAiEBDB8LIABB1wwQxAIhAQweCyAAIAJBAmoiAzYCACADIAVGDR0gBSADayIFQQJJDR0gAy0AAEHEAEcNHSACLQADIgNB0gBHBEAgA0HBAEcNHiAFQQJNBEAgACACQQVqNgIADB8LIAItAAQhAyAAIAJBBWo2AgACQAJAAkACQAJAAkAgA0HpAGsODAIDJAQFJCQkJCQAASQLIABBrxEQxAIhAQwjCyAAQcEREMQCIQEMIgsgAEHcERDEAiEBDCELIABBkxIQxAIhAQwgCyAAQegREMQCIQEMHwsgAEH5ERDEAiEBDB4LIAVBAk0EQCAAIAJBBWo2AgAMHgsgAi0ABCEDIAAgAkEFajYCAAJAAkACQAJAAkACQCADQekAaw4MAgMjBAUjIyMjIwABIwsgAEGIDBDEAiEBDCILIABBmgwQxAIhAQwhCyAAQbUMEMQCIQEMIAsgAEHsDBDEAiEBDB8LIABBwQwQxAIhAQweCyAAQdIMEMQCIQEMHQsgACACQQJqIgI2AgACQAJAIAIgBUYNACACLAAAQTBrQQlLDQAgBEEoaiICIABBABCrAiAAIAIQxgIhAwwBCyAAEMcCIgNFDR0LIAAoAgAiAiAAKAIERg0cIAItAABB3wBHDRwgACACQQFqNgIAIABBmANqQRAQqgIiAUEgOgAEIAEgBkHCAEY6AAwgASADNgIIIAFBjMEBNgIAIAEgAS8ABUGA4ANxQcAKcjsABQwVCyAAIAJBAmo2AgAgAEHGDRDEAiEBDBsLIAAgAkECajYCACAAQb0NEMQCIQEMGgsgACACQQJqNgIAIABBpQ0QxAIhAQwZCyAAIAJBAmo2AgAgAEHNEBDEAiEBDBgLIAAgAkECajYCACAAQcYdEMQCIQEMFwsgACACQQJqNgIAIABBABC6AiICRQ0WIABBmANqQRQQqgIiAUEFOgAEIAFBBUEPIAZB6wBGIgAbNgIQIAFBzBBBxR0gABs2AgwgASACNgIIIAFB+MEBNgIAIAEgAS8ABUGA4ANxQcAKcjsABQwWCyAAIAJBAmo2AgAgAEGODRDEAiEBDBULIAAQyAIhAQwRCyAEQQI2AiwgBEGgCTYCKCAEIAQpAig3AwggACAEQQhqEKgCRQ0QAkACQCAAKAIAIgIgACgCBEYNACACLAAAIgNBMUgNACADQTlNBEAgBEEcaiICIABBABCrAiAEIAAgAhDGAiIDNgIkIAAoAgAiAiAAKAIEIgVGDRMgAi0AAEHfAEcNEyAAIAJBAWoiATYCAAJAIAEgBUYNACABLQAAQfAARw0AIAAgAkECajYCACAAQZgDakEMEKoCIgFBHjoABCABIAM2AgggAUHwwgE2AgAgASABLwAFQYDgA3FBwApyOwAFDBQLIAQgABCtAiIBNgIcIAFFDQ4gACAEQRxqIARBJGoQyQIhAQwTCyADQd8ARg0BCyAEIAAQxwIiAjYCHCACRQ0RIAAoAgAiAiAAKAIERg0RIAItAABB3wBHDREgACACQQFqNgIAIAQgABCtAiIBNgIkIAFFDQwgACAEQSRqIARBHGoQyQIhAQwRCyAAIAJBAWo2AgAgABCtAiICRQ0QIABBmANqQRAQqgIiAUEdOgAEIAFBADYCDCABIAI2AgggAUHgwwE2AgAgASABLwAFQYDgA3FBwApyOwAFDBALIAAgAkECajYCACAEIAAQrQIiAjYCKCACRQ0SIAAgBEEoahDKAiEBDAsLIAAgAkEBaiIBNgIAIAACfwJAIAEgBUYNACABLAAAQTBrQQlNBEBBACEBIARBKGoiAiAAQQAQqwIgACACEMYCIQMgACgCACICIAAoAgRGDREgAi0AAEHfAEcNESACQQFqDAILIAEtAABB3wBHDQBBACEDIAJBAmoMAQtBACEBIAAQxwIiA0UNDyAAKAIAIgIgACgCBEYNDyACLQAAQd8ARw0PIAJBAWoLNgIAIAAQrQIiAkUNCSAAQZgDakEQEKoCQQ9BAEEAQQEQ3AIiASADNgIMIAEgAjYCCCABQczEATYCAAwOCyAAIAJBAWo2AgBBACEBIAAQrQIiA0UNDSAAEK0CIgJFDQ0gAEGYA2pBEBCqAkEOIAItAAVBBnZBAUEBENwCIgEgAjYCDCABIAM2AgggAUHMxQE2AgAMDQsCQCADQQJJDQACQCACLQABIgFB8wBrDgMIAQgACyABQeUARg0HCyAEIAAQywIiATYCGCABRQ0OIAAtAIQDQQFHDQ0gACgCACICIAAoAgRGDQ0gAi0AAEHJAEcNDSAAQZQBaiAEQRhqIgIQwAJBACEBIAQgAEEAEMwCIgM2AiggA0UNDyAAIAIgBEEoahDNAiEBDAgLIAAgAkEBajYCACAAEK0CIgJFDQ0gAEGYA2pBDBCqAkEMIAItAAVBBnZBAUEBENwCIgEgAjYCCCABQbjHATYCAAwHCyAAIAJBAWo2AgAgBCAAEK0CIgE2AiggAUUNDCAEQQA2AhwgACAEQShqIARBHGoQzgIhAQwGCyAAIAJBAWo2AgAgBCAAEK0CIgE2AiggAUUNCyAEQQE2AhwgACAEQShqIARBHGoQzgIhAQwFCyAAIAJBAWo2AgAgABCtAiICRQ0KIABBmANqQRQQqgIiAUEFOgAEIAFBCDYCECABQbYINgIMIAEgAjYCCCABQfjBATYCACABIAEvAAVBgOADcUHACnI7AAUMBAsgACACQQFqNgIAIAAQrQIiAkUNCSAAQZgDakEUEKoCIgFBBToABCABQQo2AhAgAUGlCDYCDCABIAI2AgggAUH4wQE2AgAgASABLwAFQYDgA3FBwApyOwAFDAMLIANBAk8EQCACLQABQfQARg0BCyAEQQA6ABwgBCAAQQAgBEEcahDPAiIBNgIYIAFFDQggACgCACIDIAAoAgRGBEAgBC0AHEUNCAwKCyAELQAcIQIgAy0AAEHJAEYEQAJAIAJBAXEEQCAALQCEAw0BDAwLIABBlAFqIARBGGoQwAILIAQgAEEAEMwCIgE2AiggAUUNCSAAIARBGGogBEEoahDNAiEBDAMLIAJBAXFFDQcMCQtBACEFQQAhASMAQTBrIgMkACADQQI2AiwgA0HsDTYCKCADIAMpAig3AxACfyAAIANBEGoQqAIEQEHrCyEFQQYMAQsgA0ECNgIkIANByQo2AiAgAyADKQIgNwMIIAAgA0EIahCoAgRAQZQRIQVBBQwBCyADQQI2AhwgA0GuFTYCGCADIAMpAhg3AwAgACADEKgCRQRAQQEhAUEADAELQaoRIQVBBAshBiAAQQAQugIhAgJAAkAgAQ0AIAJFDQAgAEGYA2pBFBCqAiIBQQY6AAQgASACNgIQIAEgBjYCDCABIAU2AgggAUHAxgE2AgAgASABLwAFQYDgA3FBwApyOwAFDAELIAIhAQsgA0EwaiQADAULQQAhAQwECyAEIAE2AhgMBAsgAUHPAEYNAQsgABDQAiEBDAELQQAhA0EAIQEjAEHwAGsiAiQAIAAQ0wIhCCACQQI2AmwgAkHfEDYCaCACIAIpAmg3AzACQAJAIAAgAkEwahCoAgRAIABBmAsQxAIhAwwBCyACQQI2AmQgAkGtGDYCYCACIAIpAmA3AyggACACQShqEKgCBEAgABDHAiIFRQ0CIAAoAgAiAyAAKAIERg0CIAMtAABBxQBHDQIgACADQQFqNgIAIABBmANqQQwQqgIiA0EROgAEIAMgBTYCCCADQYi6ATYCACADIAMvAAVBgOADcUHACnI7AAUMAQsgAkECNgJcIAJBmgk2AlggAiACKQJYNwMgIAAgAkEgahCoAkUNACAAQQhqIQMgACgCDCAAKAIIa0ECdSEFAkADQCAAKAIAIgEgACgCBEcEQCABLQAAQcUARg0CCyACIAAQrQIiATYCUCABBEAgAyACQdAAahDAAgwBCwtBACEBDAILIAAgAUEBajYCACACQdAAaiAAIAUQwQIgAEGYA2pBEBCqAiEDIAIpA1AhCiADQRI6AAQgAyAKNwIIIANB+LoBNgIAIAMgAy8ABUGA4ANxQcAKcjsABQsgAkECNgJMIAJBvwg2AkggAiACKQJINwMYIAAgAkEYahCoAhpBACEBIAAoAgAiBSAAKAIEIgdGDQAgBS0AAEHGAEcNACAAIAVBAWoiBjYCAAJAIAYgB0YNACAGLQAAQdkARw0AIAAgBUECajYCAAsgABCtAiIGRQ0AIABBCGohByAAKAIMIAAoAghrQQJ1IQkDQAJAAkAgACgCACIFIAAoAgRGDQAgBS0AAEHFAEYEQCAAIAVBAWo2AgBBACEFDAILIAUtAABB9gBHDQAgACAFQQFqNgIADAILIAJBAjYCRCACQeAYNgJAIAIgAikCQDcDECAAIAJBEGoQqAIEQEEBIQUMAQtBAiEFIAJBAjYCPCACQeMYNgI4IAIgAikCODcDCCAAIAJBCGoQqAINACACIAAQrQIiBTYCUCAFRQ0CIAcgAkHQAGoQwAIMAQsLIAJB0ABqIAAgCRDBAiAAQZgDakEgEKoCIAIpA1AhCkEQQQBBAUEAENwCIgEgAzYCHCABIAU6ABggASAINgIUIAEgCjcCDCABIAY2AgggAUHwuwE2AgALIAJB8ABqJAALIAQgATYCGCABRQ0BCyAAQZQBaiAEQRhqEMACDAELQQAhAQsgBEEwaiQAIAELMAAgASAAIAEoAgAoAggRAAAgAC8ABUHAAXFBwABHBEAgASAAIAEoAgAoAgwRAAALCykBAX8gAEEBELECIAAgACgCCCICQQFqNgIIIAIgACgCBGogAToAACAAC20BAn8gAEGYA2ohAgNAIAAoApgjIgEEQCAAIAEoAgA2ApgjIAEgAkYNASABENsBDAELCyAAKALoAiIBIABB9AJqRwRAIAEQ2wELIABBzAJqELICIABBoAJqELICIABBlAFqELICIABBCGoQsgILUAEBfwJAIAAoAgggAWoiASAAKAIMIgJNDQAgACACQQF0IgIgAUHgB2oiASABIAJJGyIBNgIMIAAgACgCBCABENwBIgA2AgQgAA0AEMsBAAsLGQEBfyAAKAIAIgEgAEEMakcEQCABENsBCwsRACABIAAgASgCACgCIBEAAAsRACABIAAgASgCACgCJBEAAAsCAAtyAgJ/An4jAEEgayICJAACf0EAIAEoAgQiAyAAKAIESw0AGiAAIAM2AgQgASkCACEEIAIgACkCACIFNwMQQQAgBCAFhUL/////D1YNABogAiAENwMIIAIgBDcDGCACQRBqIAJBCGoQ8wFFCyACQSBqJAALFQAgACABNgIAIAAgARDNATYCBCAAC60BAQJ/IABCADcCECAAIAE2AgAgAEIANwIYIABCADcCLCAAQgA3AjQgAEIANwI8IABCADcCRCAAIABBIGoiAzYCDCAA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NgKYASAAIAFBmAFqEIQDIQIMFQsgACADQQJqNgIAIAFBBDYClAIgAUG1DjYCkAIgASABKQKQAjcDICAAIAFBIGoQgwMhAgwUCyAAIANBAmo2AgAgAUELNgKMAiABQa4ONgKIAiABIAEpAogCNwMoIAAgAUEoahCDAyECDBMLIAAgA0ECajYCACABQQ02AoQCIAFBrA42AoACIAEgASkCgAI3AzAgACABQTBqEIMDIQIMEgsgACADQQJqNgIAIAFBBTYC/AEgAUGRCzYC+AEgASABKQL4ATcDOCAAIAFBOGoQgwMhAgwRCyAAIANBAmo2AgAgAUEONgL0ASABQYgLNgLwASABIAEpAvABNwNAIAAgAUFAaxCDAyECDBALIAAgA0ECajYCACABQQA2AuwBIAFB9SU2AugBIAEgASkC6AE3A0ggACABQcgAahCDAyECDA8LIAAgA0ECajYCACABQQE2AuQBIAFBygo2AuABIAEgASkC4AE3A1AgACABQdAAahCDAyECDA4LIAAgA0ECajYCACABQQE2AtwBIAFB9RI2AtgBIAEgASkC2AE3A1ggACABQdgAahCDAyECDA0LIAAgA0ECajYCACABQQI2AtQBIAFB0xI2AtABIAEgASkC0AE3A2AgACABQeAAahCDAyECDAwLIAAgA0ECajYCACABQQI2AswBIAFB3xI2AsgBIAEgASkCyAE3A2ggACABQegAahCDAyECDAsLIAAgA0ECajYCACABQQM2AsQBIAFB3hI2AsABIAEgASkCwAE3A3AgACABQfAAahCDAyECDAoLIAAgA0ECajYCACABQQg2ArwBIAFB8Rs2ArgBIAEgASkCuAE3A3ggACABQfgAahCDAyECDAkLIAAgA0ECajYCACABQRE2ArQBIAFB6Bs2ArABIAEgASkCsAE3A4ABIAAgAUGAAWoQgwMhAgwICyAAIANBAmoiBTYCACAHIAVrQQlJDQcgA0EKaiEGQQAhBANAIARBCEcEQCAEIAVqLQAAIghB4QBrIARBAWohBCAIQTBrQf8BcUEKSQ0BQf8BcUEGSQ0BDAkLCyAAIAY2AgAgBiAHRg0HIAYtAABBxQBHDQcgACADQQtqNgIAIABBmANqQRAQqgIiAkHOADoABCACQQg2AgwgAiAFNgIIIAJBsIsBNgIAIAIgAi8ABUGA4ANxQcAK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LQANQQFGBEAgAkECNgIcIAJB/xc2AhggAiACKQIYNwMAIAEgAhDhAhoLIAFBIBCvAiIBIAAoAggiACABKAIAKAIIEQAAIAAvAAVBwAFxQcAARwRAIAEgACABKAIAKAIMEQAACyACQTBqJAALcwEBfyAALQAUQQFGBEAgAUEoEIgDCyABIAAoAggiAiABKAIAKAIIEQAAIAIvAAVBwAFxQcAARwRAIAEgAiABKAIAKAIMEQAACyAALQAUQQFGBEAgAUEpEIoDCyABQSgQiAMgAEEMaiABEJADIAFBKRCKAwtdAQF/IAFBKBCIAyABIAAoAggiAiABKAIAKAIIEQAAIAIvAAVBwAFxQcAARwRAIAEgAiABKAIAKAIMEQAACyABQSkQigMgAUEoEIgDIABBDGogARCQAyABQSkQigMLiwEBAX8jAEEgayICJAAgACgCCCABIAAvAAVBP3FBABCJAyACQQM2AhwgAkGNIzYCGCACIAIpAhg3AwggASACQQhqEOECIQEgACgCDCABQRNBABCJAyACQQM2AhQgAkGmIzYCECACIAIpAhA3AwAgASACEOECIQEgACgCECABQRFBARCJAyACQSBqJAAL7AECBX8BfiMAQTBrIgIkACACIAApAggiBzcDECACIAc3AyggASACQRBqEOECIgEtABwhBSABQQE6ABwgAkEBNgIkIAJBzRs2AiAgAiACKQIgNwMIIAEgAkEIahDhAiEDIAAoAhAhBCADKAIAKAIIQaTYAUEANgIAIAMgBBAEQaTYASgCAEGk2AFBADYCAEEBRwRAIAJBATYCHCACQf4ZNgIYIAIgAikCGDcDACADIAIQ4QIhAyABIAU6ABwgA0EoEIgDIAAoAhQgA0ETQQAQiQMgA0EpEIoDIAJBMGokAA8LEAEgASAFOgAcEAIAC48BAgJ/AX4jAEEgayICJAAgAiAAKQIIIgQ3AwggAiAENwMYIAEgAkEIahDhAiIBQSgQiAMgASAAKAIQIgMgASgCACgCCBEAACADLwAFQcABcUHAAEcEQCABIAMgASgCACgCDBEAAAsgAUEpEIoDIAIgACkCFCIENwMAIAIgBDcDECABIAIQ4QIaIAJBIGokAAuLAQEEfyMAQRBrIgIkACAAIAE2AgAgASgCzAIhAyABKALQAiEEIABCADcCFCAAIABBNGo2AhAgACAA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AyACIAAoAhBBAWs2AhwgAiADQQFqNgIYIAIgAikCGDcDCCACQQhqEOECGgwBCyACIAApAgwiBDcDECACIAQ3AxggASACQRBqEOECGgsgAkEgaiQAC1ICAX8BfiMAQSBrIgIkACACQQI2AhwgAkHGEDYCGCACIAIpAhg3AwggASACQQhqEOECIAIgACkCCCIDNwMAIAIgAzcDECACEOECGiACQSBqJAALgQMCAn8BfiMAQdAAayICJAAgAiAANgJEIAIgATYCQCABQSgQiAMCQAJAIAAtABhBAUYEQCAAKAIMIgNFDQIgAyABQQNBARCJAwwBCyACQUBrELMDCyACQQE2AkwgAkHIIzYCSCACIAIpAkg3AzggASACQThqEOECIAIgACkCECIENwMwIAIgBDcDSCACQTBqEOECIAJBATYCTCACQcgjNgJIIAIgAikCSDcDKCACQShqEOECGgsgAkEDNgJMIAJB4xw2AkggAiACKQJINwMgIAEgAkEgahDhAiEBAkAgAC0AGEUEQCAAKAIMRQ0BCyACQQE2AkwgAkHIIzYCSCACIAIpAkg3AxggASACQRhqEOECIAIgACkCECIENwMQIAIgBDcDSCACQRBqEOECIAJBATYCTCACQcgjNgJIIAIgAikCSDcDCCACQQhqEOECIQMgAC0AGEEBRgRAIAJBQGsQswMMAQsgACgCDCADQQNBARCJAwsgAUEpEIoDIAJB0ABqJAALlAEBA38jAEEQayIBJAAgACgCBCAAKAIAQSgQiAMoAgghAiABQSo6AAggASACNgIMIAFB9JkBNgIEIAEgAS8ACUGA4ANxQcAKcjsACSAAKAIAIgIgAUEEaiIDIAIoAgAoAggRAAAgAy8ABUHAAXFBwABHBEAgAiADIAIoAgAoAgwRAAALIAAoAgBBKRCKAyABQRBqJAAL9QIBB38jAEEgayICJAAgASgCFCEGIAEoAhAhByABQn83AhAgASgCCCEDIAAoAgghBEGk2AFBADYCAEGeASAEIAEQBEGk2AEoAgAhBEGk2AFBADYCAAJAIARBAUYNAAJAAkACQAJAIAEoAhQiBEEBag4CAgABCyABKAIIIQAgASgCACgCFEGk2AFBADYCACABIAAgAxASQaTYASgCAEGk2AFBADYCAEEBRg0DIAEgAzYCCAwCC0EBIQMDQCADIARGDQIg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CyEDIAIgA0sEfyAAKAIIIANBAnRqKAIAIgAgASAAKAIAKAIMEQEABSAACwtcAQJ/An8gASgCFEF/RwRAIAAoAgwhAiABKAIQDAELIAAoAgwhAiABQQA2AhAgASACNgIUQQALIQMgAiADSwRAIAEgACgCCCADQQJ0aigCACABKAIAKAIIEQAACwtcAQJ/An8gASgCFEF/RwRAIAAoAgwhAiABKAIQDAELIAAoAgwhAiABQQA2AhAgASACNgIUQQALIQMgAiADSwRAIAEgACgCCCADQQJ0aigCACABKAIAKAIMEQAACwunAQEDfyMAQSBrIgIkACABLQAcIQMgAUEBOgAcIAJBATYCHCACQc0bNgIYIAIgAikCGDcDCCABIAJBCGoQ4QIhBEGk2AFBADYCAEGrASAAQQhqIAQQBEGk2AEoAgBBpNgBQQA2AgBBAUcEQCACQQE2AhQgAkH+GTYCECACIAIpAhA3AwAgBCACEOECGiABIAM6ABwgAkEgaiQADwsQASABIAM6ABwQAgALagEBfyABIAAoAggiAiABKAIAKAIIEQAAIAIvAAVBwAFxQcAARwRAIAEgAiABKAIAKAIMEQAACyABIAAoAgwiACABKAIAKAIIEQAAIAAvAAVBwAFxQcAARwRAIAEgACABKAIAKAIMEQAACwtHAQF/IwBBEGsiAiQAIAJBDDYCDCACQdUbNgIIIAIgAikCCDcDACAAQQhqIAEgAhDhAiIAEJADIABB3QAQrwIaIAJBEGokAAtnAQF/IwBBEGsiAiQAIAJBBTYCDCACQfQfNgIIIAIgAikCCDcDACABIAIQ4QIiASAAKAIIIgAgASgCACgCCBEAACAALwAFQcABcUHAAEcEQCABIAAgASgCACgCDBEAAAsgAkEQaiQACwQAQQELsgEBA38jAEEQayICJAACQCAAKAIIIgNFDQAgASADIAEoAgAoAggRAAACfyAAKAIIIgMtAAVBBnYiBEECRwRAIARFDAELIAMgASADKAIAKAIAEQEACw0AIAJBATYCDCACQcgjNgIIIAIgAikCCDcDACABIAIQ4QIaCyABIAAoAgwiACABKAIAKAIIEQAAIAAvAAVBwAFxQcAARwRAIAEgACABKAIAKAIMEQAACyACQRBqJAALzAMBA38jAEHgAGsiAiQAIAFBKBCIAyAAQRBqIAEQkAMg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ADYCAEGsASACQRhqIAAgARASQaTYASgCAEGk2AFBADYCAEEBRg0BIAIoAhwiAwRAQaTYAUEANgIAQakBIAMgARAKIQRBpNgBKAIAQaTYAUEANgIAQQFGDQICQCAERQRAQaTYAUEANgIAQaoBIAMgARAKQaTYASgCAEGk2AFBADYCAEEBRg0ERQ0BCyACQQE2AhQgAkH7HTYCECACIAIpAhA3AwggASACQQhqEOECGgsgASgCACgCDEGk2AFBADYCACABIAMQBEGk2AEoAgBBpNgBQQA2AgBBAUYNAgsgAEEAOgAQCyACQSBqJAAPCxABIABBADoAEBACAAvYAQEBfwJAAkAgACABc0EDcQRAIAEtAAAhAgwBCyABQQNxBEADQCAAIAEtAAAiAjoAACACRQ0DIABBAWohACABQQFqIgFBA3ENAAsLQYCChAggASgCACICayACckGAgYKEeHFBgIGChHhHDQADQCAAIAI2AgAgAEEEaiEAIAEiAkEEaiEBQYCChAggAigCBCICayACckGAgYKEeHFBgIGChHhGDQALCyAAIAI6AAAgAkH/AXFFDQADQCAAIAEtAAEiAjoAASAAQQFqIQAgAUEBaiEBIAINAAsLC8YLAQh/IwBBEGsiBiQAIAYgADYCDCAAQRRrKAIAIgooAgQhACAGQQA2AggCfyAGQQhqIQgjAEGwJGsiAyQAAkACQCAAIgdFBEBBACEAIAhFDQEgCEF9NgIADAELIAcQzQEhBCADIANB9AFqNgJwIAMgA0H0AGoiADYCbCADIAA2AmggAyAHNgJgIAMgBCAHajYCZCAAQQBBgAH8CwAgAyADQYADajYC/AEgAyADQYACaiIANgL4ASADIAA2AvQBIABBAEGAAfwLACADQgA3AowDIAMgA0GsA2o2AogDIAMgA0GMA2oiADYChAMgAyAANgKAAyADQgA3ApQDIANCADcCnAMgA0IANwKkAyADQgA3A7gDIAMgA0HIA2o2ArQDIAMgA0G4A2oiADYCsAMgAyAANgKsAyADQgA3A8ADIANCADcC1AMgAyADQeQDajYC0AMgAyADQdQDaiIANgLMAyADIAA2AsgDIANCADcC3AMgA0EBOwHkAyADQX82AugDIANBADoA5gMgA0EANgL8AyADQgA3AvQDIANCADcC7AMgAyADQfgDaiIANgL4IyADQQI2AkQgA0GZGDYCQCADIAMpAkA3AzgCfwJAAkACQAJAIANB4ABqIgQgA0E4ahCoAkUEQCADQQM2AqwkIANBmBg2AqgkIAMgAykCqCQ3AzAgBCADQTBqEKgCRQ0BC0Gk2AFBADYCAEGcASADQeAAahAAIQRBpNgBKAIAQaTYAUEANgIAQQFGDQYgBEUNAiADKAJkIgkgAygCYCIFRgRAIAQhAAwCCyAFLQAAQS5HDQIgAEEUEKoCIgBBAToABCAAIAkgBWs2AhAgACAFNgIMIAAgBDYCCCAAQZy5ATYCACAAIAAvAAVBgOADcUHACnI7AAUgAyADKAJkNgJgDAELIANBBDYCpCQgA0GXGDYCoCQgAyADKQKgJDcDKAJAAkAgA0HgAGoiACADQShqEKgCRQRAIANBBTYCnCQgA0GWGDYCmCQgAyADKQKYJDcDICAAIANBIGoQqAJFDQELQQAhAEGk2AFBADYCAEGcASADQeAAaiIFEAAhBEGk2AEoAgBBpNgBQQA2AgBBAUYNByADIAQ2ApQkIARFDQEgA0ENNgKQJCADQaAVNgKMJCADIAMpAowkNwMYIAUgA0EYahCoAkUNAQJ/QQAgAygCYCIEIAMoAmRGDQAaQQAgBC0AAEHfAEcNABogAyAEQQFqNgJgQQELIANBhCRqIANB4ABqQQAQqwIEQCADKAKIJEUNAgsgAygCZCIEIAMoAmAiBUcEQCAFLQAAQS5HDQIgAyAENgJgCyADQeAAakGaIiADQZQkahCsAiEADAELQaTYAUEANgIAQZ0BIANB4ABqEAAhAEGk2AEoAgBBpNgBQQA2AgBBAUYNBiADKAJkIAMoAmBGDQAMAgsgAEUNAQsgA0EAOgBcIANBADYCWCADQn83AlAgA0EANgJMIANBADYCSCADQQA2AkQgA0HQ9QA2AkAgAygCyAMgAygCzANGDQEgA0HLDzYCAEGk2AFBADYCACADQYwDNgIEIANB9SU2AghBgwFB7w0gAxAEQaTYASgCAEGk2AFBADYCAEEBRg0EAAtBfiEEQQAMAQtBpNgBQQA2AgBBngEgACADQUBrIgAQBEGk2AEoAgBBpNgBQQA2AgBBAUYNAiAAQQAQrwIaQQAhBCADKAJECyEAIAgEQCAIIAQ2AgALIANB4ABqELACCyADQbAkaiQAIAAMAQsQASADQeAAahCwAhACAAshAAJAAkAgBigCCA0AIABFDQAgASAANgIADAELIAAQ2wEgASAHEM0BQQFqENoBIgA2AgAgACAHEP4DCyACQQA2AgBBvPMAIAogBkEMakG88wAoAgAoAhARBAAEQCACIAYoAgwiACAAKAIAKAIIEQIAIgAQzQFBAWoQ2gEiATYCACABIAAQ/gMLIAZBEGokAAsLzL4BJwBBgAgL9R1vcGVyYXRvcn4Aey4uLn0Ab3BlcmF0b3J8fABvcGVyYXRvcnwAIGltYWdpbmFyeQBUeQBueAAgY29tcGxleABEeAAtKyAgIDBYMHgALTBYKzBYIDBYLTB4KzB4IDB4AHR3AHRocm93AEJpdHN0cmVhbVJlYWRlcjogRXhwLUdvbG9tYiBvdmVyZmxvdwBvcGVyYXRvciBuZXcARHcAXHYARHYAeTolenUsY2I6JXp1LGNyOiV6dSx3aWR0aDolenUsaGVpZ2h0OiV6dSxzdHJpZGVfeTolenUsc3RyaWRlX2M6JXp1LGNocm9tYV93aWR0aDolenUsY2hyb21hX2hlaWdodDolenUsYml0X2RlcHRoOiV6dSxwb2M6JXp1LGN2c19pZDolenUsYnl0ZXNfcGVyX3NhbXBsZTolenUsX3NpemU6JXp1AFR1ACBjb25zdABjb25zdF9jYXN0AHJlaW50ZXJwcmV0X2Nhc3QAc3RhdGljX2Nhc3QAZHluYW1pY19jYXN0AHVuc2lnbmVkIHNob3J0ACBub2V4Y2VwdABfX2N4YV9kZWNyZW1lbnRfZXhjZXB0aW9uX3JlZmNvdW50AHVuc2lnbmVkIGludABfQml0SW50AG9wZXJhdG9yIGNvX2F3YWl0AHN0cnVjdAAgcmVzdHJpY3QAb2JqY19vYmplY3QAX1NhdCBzaG9ydCBfRnJhY3QAX1NhdCB1bnNpZ25lZCBzaG9ydCBfRnJhY3QAX1NhdCBfRnJhY3QAX1NhdCBsb25nIF9GcmFjdABfU2F0IHVuc2lnbmVkIGxvbmcgX0ZyYWN0AF9TYXQgdW5zaWduZWQgX0ZyYWN0AGZsb2F0AF9GbG9hdABzdGQ6Om51bGxwdHJfdAB3Y2hhcl90AGNoYXI4X3QAc3RkOjpiZmxvYXQxNl90AGNoYXIxNl90AGNoYXIzMl90AFx0AFV0AFR0AFN0AHRoaXMAZ3MAcmVxdWlyZXMAVHMAJXM6JWQ6ICVzAG51bGxwdHIAc3IAdmVjdG9yAG9wZXJhdG9yAGFsbG9jYXRvcgBVbmtub3duIGVycm9yAHVuc2lnbmVkIGNoYXIAXHIAcnEAc3AAL2Vtc2RrL2Vtc2NyaXB0ZW4vc3lzdGVtL2xpYi9saWJjeHhhYmkvc3JjL3ByaXZhdGVfdHlwZWluZm8uY3BwAC9lbXNkay9lbXNjcmlwdGVuL3N5c3RlbS9saWIvbGliY3h4YWJpL3NyYy9jeGFfZXhjZXB0aW9uX2Vtc2NyaXB0ZW4uY3BwAC9lbXNkay9lbXNjcmlwdGVuL3N5c3RlbS9saWIvbGliY3h4YWJpL3NyYy9jeGFfZGVtYW5nbGUuY3BwAC9lbXNkay9lbXNjcmlwdGVuL3N5c3RlbS9saWIvbGliY3h4YWJpL3NyYy9mYWxsYmFja19tYWxsb2MuY3BwAGZwAFRwACBhdXRvAG9iamNwcm90bwBzbwBEbwB0ZXJtaW5hdGVfaGFuZGxlciB1bmV4cGVjdGVkbHkgdGhyZXcgYW4gZXhjZXB0aW9uAHVuaW9uAGRuAG5hbgBcbgBUbgBEbgBlbnVtAF9TYXQgc2hvcnQgX0FjY3VtAF9TYXQgdW5zaWduZWQgc2hvcnQgX0FjY3VtAF9TYXQgX0FjY3VtAF9TYXQgbG9uZyBfQWNjdW0AX1NhdCB1bnNpZ25lZCBsb25nIF9BY2N1bQBfU2F0IHVuc2lnbmVkIF9BY2N1bQBiYXNpY19pb3N0cmVhbQBiYXNpY19vc3RyZWFtAGJhc2ljX2lzdHJlYW0AdWwAdGwAYm9vbAB1bGwAaWwAc3RyaW5nIGxpdGVyYWwAVWwAeXB0bmsAVGsAcGkAbGkAYmFkX2FycmF5X25ld19sZW5ndGgAL2Vtc2RrL2Vtc2NyaXB0ZW4vc3lzdGVtL2xpYi9saWJjeHhhYmkvc3JjL2RlbWFuZ2xlL1V0aWxpdHkuaAAvZW1zZGsvZW1zY3JpcHRlbi9zeXN0ZW0vbGliL2xpYmN4eGFiaS9zcmMvZGVtYW5nbGUvSXRhbml1bURlbWFuZ2xlLmgAdW5zaWduZWQgbG9uZyBsb25nAHVuc2lnbmVkIGxvbmcAYmFzaWNfc3RyaW5nAF9fdXVpZG9mAGluZgBoYWxmACVhZgBcZgB0cnVlAG9wZXJhdG9yIGRlbGV0ZQBmYWxzZQBkZWNsdHlwZQAgdm9sYXRpbGUAbG9uZyBkb3VibGUAX2Jsb2NrX2ludm9rZQBUZQBzdGQAdm9pZAB0ZXJtaW5hdGVfaGFuZGxlciB1bmV4cGVjdGVkbHkgcmV0dXJuZWQAJ3VubmFtZWQAY29uZGl0aW9uX3ZhcmlhYmxlIHdhaXQgZmFpbGVkAHRocmVhZDo6am9pbiBmYWlsZWQAbXV0ZXggbG9jayBmYWlsZWQAY29uZGl0aW9uX3ZhcmlhYmxlOjp3YWl0OiBtdXRleCBub3QgbG9ja2VkAFVua25vd24gZXJyb3IgJWQAc3RkOjpiYWRfYWxsb2MAbWMAZ2VuZXJpYwBcYgBVYgAxNmIAQml0c3RyZWFtUmVhZGVyOiByZWFkIHBhc3QgZW5kIG9mIGRhdGEAJ2xhbWJkYQBcYQAlYQBiYXNpY18Ab3BlcmF0b3JeAG9wZXJhdG9yIG5ld1tdAG9wZXJhdG9yW10Ab3BlcmF0b3IgZGVsZXRlW10AXFwAcGl4ZWwgdmVjdG9yWwBzWgBfX19fWgBmcFQAJFRUACRUAHJRAHNQAERPAHNyTgBfR0xPQkFMX19OAE5BTgAkTgBmTAAlTGFMAFVhOWVuYWJsZV9pZkkASU5GAFJFAE9FAGIxRQBiMEUAREMAY2F0Y2hpbmcgYSBjbGFzcyB3aXRob3V0IGFuIG9iamVjdD8Ab3BlcmF0b3I/AG9wZXJhdG9yPgA8Y2hhciwgc3RkOjpjaGFyX3RyYWl0czxjaGFyPgAsIHN0ZDo6YWxsb2NhdG9yPGNoYXI+AG9wZXJhdG9yPj4Ab3BlcmF0b3I8PT4Ab3BlcmF0b3ItPgBvcGVyYXRvcnw9AG9wZXJhdG9yPQBvcGVyYXRvcl49AG9wZXJhdG9yPj0Ab3BlcmF0b3I+Pj0Ab3BlcmF0b3I9PQBvcGVyYXRvcjw9AG9wZXJhdG9yPDw9AG9wZXJhdG9yLz0Ab3BlcmF0b3ItPQBvcGVyYXRvcis9AG9wZXJhdG9yKj0Ab3BlcmF0b3ImPQBvcGVyYXRvciU9AG9wZXJhdG9yIT0Ab3BlcmF0b3I8AHRlbXBsYXRlPABpZDwAb3BlcmF0b3I8PAAuPAAiPABbYWJpOgAgW2VuYWJsZV9pZjoAc3RkOjoAdW5zaWduZWQgX19pbnQxMjgAX19mbG9hdDEyOABkZWNpbWFsMTI4AGRlY2ltYWw2NABkZWNpbWFsMzIAZXhjZXB0aW9uX2hlYWRlci0+cmVmZXJlbmNlQ291bnQgPiAwAG9wZXJhdG9yLwBvcGVyYXRvci4Ac2l6ZW9mLi4uAG9wZXJhdG9yLQAtaW4tAG9wZXJhdG9yLS0Ab3BlcmF0b3IsAG9wZXJhdG9yKwBvcGVyYXRvcisrAG9wZXJhdG9yKgBvcGVyYXRvci0+KgA6OioAb3BlcmF0b3IuKgAgZGVjbHR5cGUoYXV0bykAKG51bGwpAChhbm9ueW1vdXMgbmFtZXNwYWNlKQBvcGVyYXRvcigpACAoAG9wZXJhdG9yIG5hbWUgZG9lcyBub3Qgc3RhcnQgd2l0aCAnb3BlcmF0b3InACdibG9jay1saXRlcmFsJwBvcGVyYXRvciYAb3BlcmF0b3ImJgAgJiYAICYAb3BlcmF0b3IlAFwiAD4iACIiAEludmFsaWQgYWNjZXNzIQBQb3BwaW5nIGVtcHR5IHZlY3RvciEAb3BlcmF0b3IhAHNocmlua1RvU2l6ZSgpIGNhbid0IGV4cGFuZCEAUHVyZSB2aXJ0dWFsIGZ1bmN0aW9uIGNhbGxlZCEAdGhyb3cgAG5vZXhjZXB0IAAgYXQgb2Zmc2V0IAB0aGlzIAAgcmVxdWlyZXMgAG9wZXJhdG9yIAByZWZlcmVuY2UgdGVtcG9yYXJ5IGZvciAAdGVtcGxhdGUgcGFyYW1ldGVyIG9iamVjdCBmb3IgAHR5cGVpbmZvIGZvciAAdGhyZWFkLWxvY2FsIHdyYXBwZXIgcm91dGluZSBmb3IgAHRocmVhZC1sb2NhbCBpbml0aWFsaXphdGlvbiByb3V0aW5lIGZvciAAdHlwZWluZm8gbmFtZSBmb3IgAGNvbnN0cnVjdGlvbiB2dGFibGUgZm9yIABndWFyZCB2YXJpYWJsZSBmb3IgAFZUVCBmb3IgAGNvdmFyaWFudCByZXR1cm4gdGh1bmsgdG8gAG5vbi12aXJ0dWFsIHRodW5rIHRvIABpbnZvY2F0aW9uIGZ1bmN0aW9uIGZvciBibG9jayBpbiAAYWxpZ25vZiAAc2l6ZW9mIAA+IHR5cGVuYW1lIABpbml0aWFsaXplciBmb3IgbW9kdWxl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/87/MgBZABIAtf+1/xIAWQAyAM7/p//u/0sASwDu/6f/zv8yAFkAEgC1/7X/EgBZADIAzv+n/+7/SwBJAOH/pv/q/04AQwDa/6b/8/9SAD0A0v+o//z/VQA2AMr/q/8EAFgALgDD/67/DQBaACYAvf+y/xYAWgAfALf/RgDV/6n/CQBaABkAsP/H/zkAUADn/6b/9/9XACsAuv+6/ysAVwD3/6b/5/9QADkAx/+w/xkAWgAJAKn/1f9GAEMAyv+y/yYAVQDq/6b/BABaAA0AqP/h/1IALgC3/8P/PQBJANL/rv8fAFgA8/+m//z/WgAWAKv/2v9OADYAvf9AAMD/wP9AAEAAwP/A/0AAQADA/8D/QABAAMD/wP9AAEAAwP/A/0AAQADA/8D/QABAAMD/wP9AAEAAwP/A/0AAPQC3/9L/UgAfAKj/8/9aAPz/pv8WAFUA2v+y/zYAQwC9/8r/TgAmAKv/6v9aAAQApv8NAFgA4f+u/y4ASQDD/zkAsP/n/1oA9/+p/ysARgC6/9X/VwAJAKb/GQBQAMf/x/9QABkApv8JAFcA1f+6/0YAKwCp//f/WgDn/7D/OQA2AKv//P9YANL/w/9SAA0Apv8mAEMAsv/q/1oA4f+3/0kAHwCm/xYATgC9/9r/WgDz/67/PQAuAKj/BABVAMr/MgCn/xIASwC1/+7/WQDO/87/WQDu/7X/SwASAKf/MgAyAKf/EgBLALX/7v9ZAM7/zv9ZAO7/tf9LABIAp/8yAC4Apv8mADYApv8fAD0AqP8WAEMAq/8NAEkArv8EAE4Asv/8/1IAt//z/1UAvf/q/1gAw//h/1oAyv/a/1oA0v8rAKb/OQAZAKn/RgAJALD/UAD3/7r/VwDn/8f/WgDV/9X/WgDH/+f/VwC6//f/UACw/wkARgCp/xkAOQCm/ysAJgCo/0kA/P+9/1oA0v/h/1UAsv8NAD0Apv82ABYArv9SAOr/yv9aAMP/8/9OAKv/HwAuAKb/QwAEALf/WADa/yQArf9TANz/3P9TAK3/JAAkAK3/UwDc/9z/UwCt/yQAJACt/1MA3P/c/1MArf8kACQArf9TANz/3P9TAK3/JAAfALL/WgDD/wQANgCo/1IA2v/q/0kApv9DAPP/0v9VAKv/LgANAL3/WgC3/xYAJgCu/1gAyv/8/z0Apv9OAOH/GQC6/1oAsP8r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AAAqAgBBuN4ACwYnBDkESAQAQc7eAAsCkgQAQeLeAAvSHDgFUgVgBVMGAADKAbsGAADSBgAA6QYJBxkHPgdZB2kHfgdTdWNjZXNzAElsbGVnYWwgYnl0ZSBzZXF1ZW5jZQBEb21haW4gZXJyb3IAUmVzdWx0IG5vdCByZXByZXNlbnRhYmxlAE5vdCBhIHR0eQBQZXJtaXNzaW9uIGRlbmllZABPcGVyYXRpb24gbm90IHBlcm1pdHRlZABObyBzdWNoIGZpbGUgb3IgZGlyZWN0b3J5AE5vIHN1Y2ggcHJvY2VzcwBGaWxlIGV4aXN0cwBWYWx1ZSB0b28gbGFyZ2UgZm9yIGRlZmluZWQgZGF0YSB0eXBlAE5vIHNwYWNlIGxlZnQgb24gZGV2aWNlAE91dCBvZiBtZW1vcnkAUmVzb3VyY2UgYnVzeQBJbnRlcnJ1cHRlZCBzeXN0ZW0gY2FsbABSZXNvdXJjZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZQBJbnZhbGlkIHNlZWsAQ3Jvc3MtZGV2aWNlIGxpbmsAUmVhZC1vbmx5IGZpbGUgc3lzdGVtAERpcmVjdG9yeSBub3QgZW1wdHkAQ29ubmVjdGlvbiByZXNldCBieSBwZWVyAE9wZXJhdGlvbiB0aW1lZCBvdXQAQ29ubmVjdGlvbiByZWZ1c2VkAEhvc3QgaXMgZG93bgBIb3N0IGlzIHVucmVhY2hhYmxlAEFkZHJlc3MgaW4gdXNlAEJyb2tlbiBwaXBlAEkvTyBlcnJvcgBObyBzdWNoIGRldmljZSBvciBhZGRyZXNzAEJsb2NrIGRldmljZSByZXF1aXJlZABObyBzdWNoIGRldmljZQBOb3QgYSBkaXJlY3RvcnkASXMgYSBkaXJlY3RvcnkAVGV4dCBmaWxlIGJ1c3kARXhlYyBmb3JtYXQgZXJyb3IASW52YWxpZCBhcmd1bWVudABBcmd1bWVudCBsaXN0IHRvbyBsb25nAFN5bWJvbGljIGxpbmsgbG9vcABGaWxlbmFtZSB0b28gbG9uZwBUb28gbWFueSBvcGVuIGZpbGVzIGluIHN5c3RlbQBObyBmaWxlIGRlc2NyaXB0b3JzIGF2YWlsYWJsZQBCYWQgZmlsZSBkZXNjcmlwdG9yAE5vIGNoaWxkIHByb2Nlc3MAQmFkIGFkZHJlc3MARmlsZSB0b28gbGFyZ2UAVG9vIG1hbnkgbGlua3MATm8gbG9ja3MgYXZhaWxhYmxlAFJlc291cmNlIGRlYWRsb2NrIHdvdWxkIG9jY3VyAFN0YXRlIG5vdCByZWNvdmVyYWJsZQBPd25lciBkaWVkAE9wZXJhdGlvbiBjYW5jZWxlZABGdW5jdGlvbiBub3QgaW1wbGVtZW50ZWQATm8gbWVzc2FnZSBvZiBkZXNpcmVkIHR5cGUASWRlbnRpZmllciByZW1vdmVkAERldmljZSBub3QgYSBzdHJlYW0ATm8gZGF0YSBhdmFpbGFibGUARGV2aWNlIHRpbWVvdXQAT3V0IG9mIHN0cmVhbXMgcmVzb3VyY2VzAExpbmsgaGFzIGJlZW4gc2V2ZXJlZABQcm90b2NvbCBlcnJvcgBCYWQgbWVzc2FnZQBGaWxlIGRlc2NyaXB0b3IgaW4gYmFkIHN0YXRlAE5vdCBhIHNvY2tldABEZXN0aW5hdGlvbiBhZGRyZXNzIHJlcXVpcmVkAE1lc3NhZ2UgdG9vIGxhcmdlAFByb3RvY29sIHdyb25nIHR5cGUgZm9yIHNvY2tldABQcm90b2NvbCBub3QgYXZhaWxhYmxlAFByb3RvY29sIG5vdCBzdXBwb3J0ZWQAU29ja2V0IHR5cGUgbm90IHN1cHBvcnRlZABOb3Qgc3VwcG9ydGVkAFByb3RvY29sIGZhbWlseSBub3Qgc3VwcG9ydGVkAEFkZHJlc3MgZmFtaWx5IG5vdCBzdXBwb3J0ZWQgYnkgcHJvdG9jb2wAQWRkcmVzcyBub3QgYXZhaWxhYmxlAE5ldHdvcmsgaXMgZG93bgBOZXR3b3JrIHVucmVhY2hhYmxlAENvbm5lY3Rpb24gcmVzZXQgYnkgbmV0d29yawBDb25uZWN0aW9uIGFib3J0ZWQATm8gYnVmZmVyIHNwYWNlIGF2YWlsYWJsZQBTb2NrZXQgaXMgY29ubmVjdGVkAFNvY2tldCBub3QgY29ubmVjdGVkAENhbm5vdCBzZW5kIGFmdGVyIHNvY2tldCBzaHV0ZG93bgBPcGVyYXRpb24gYWxyZWFkeSBpbiBwcm9ncmVzcwBPcGVyYXRpb24gaW4gcHJvZ3Jlc3MAU3RhbGUgZmlsZSBoYW5kbGUARGF0YSBjb25zaXN0ZW5jeSBlcnJvcgBSZXNvdXJjZSBub3QgYXZhaWxhYmxlAFJlbW90ZSBJL08gZXJyb3IAUXVvdGEgZXhjZWVkZWQATm8gbWVkaXVtIGZvdW5kAFdyb25nIG1lZGl1bSB0eXBlAE11bHRpaG9wIGF0dGVtcHRlZABSZXF1aXJlZCBrZXkgbm90IGF2YWlsYWJsZQBLZXkgaGFzIGV4cGlyZWQAS2V5IGhhcyBiZWVuIHJldm9rZWQAS2V5IHdhcyByZWplY3RlZCBieSBzZXJ2aWNlAAAAvDgAACg3AABOU3QzX18yMTRlcnJvcl9jYXRlZ29yeUUAAAAAAAAAAMQ3AAB2AAAAdwAAAHgAAAB5AAAAegAAAHsAAAB8AAAAAAAAAHw3AAB1AAAAfQAAAH4AAADkOAAAiDcAAJA6AABOU3QzX18yMTJzeXN0ZW1fZXJyb3JFAADkOAAArDcAACA3AABOU3QzX18yMTJfX2RvX21lc3NhZ2VFAADkOAAA0DcAAKA3AABOU3QzX18yMjRfX2dlbmVyaWNfZXJyb3JfY2F0ZWdvcnlFAADkOAAAADgAALA6AABOMTBfX2N4eGFiaXYxMTZfX3NoaW1fdHlwZV9pbmZvRQAAAADkOAAAMDgAAPQ3AABOMTBfX2N4eGFiaXYxMTdfX2NsYXNzX3R5cGVfaW5mb0UAAADkOAAAYDgAAPQ3AABOMTBfX2N4eGFiaXYxMTdfX3BiYXNlX3R5cGVfaW5mb0UAAADkOAAAkDgAAFQ4AABOMTBfX2N4eGFiaXYxMTlfX3BvaW50ZXJfdHlwZV9pbmZvRQAAAAAAJDgAAIQAAACFAAAAhgAAAIcAAACIAAAAiQAAAIoAAACLAAAAAAAAAAQ5AACEAAAAjAAAAIYAAACHAAAAiAAAAI0AAACOAAAAjwAAAOQ4AAAQOQAAJDgAAE4xMF9fY3h4YWJpdjEyMF9fc2lfY2xhc3NfdHlwZV9pbmZvRQAAAAAAAAAAYDkAAIQAAACQAAAAhgAAAIcAAACIAAAAkQAAAJIAAACTAAAA5DgAAGw5AAAkOAAATjEwX19jeHhhYml2MTIxX192bWlfY2xhc3NfdHlwZV9pbmZvRQAAAAAAAAD8OQAACgAAAJQAAACVAAAAAAAAANQ5AAAKAAAAlgAAAJcAAAC8OAAAxDkAAFN0OWV4Y2Vw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";

  var VERSION = '1.1.0';
  var MICRO = 1000000;

  /* =====================================================================
   * 0. 基础工具
   * ===================================================================== */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function even(v) { var n = Math.round(v / 2) * 2; return n < 2 ? 2 : n; }
  function hex2(v) {
    var s = (v & 255).toString(16);
    return s.length < 2 ? '0' + s : s;
  }
  function now() { return Date.now(); }
  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function err(message) {
    var e = new Error(message);
    return e;
  }

  function cancelError() {
    var e = new Error('已取消');
    e.name = 'AbortError';
    e.code = 'CANCELLED';
    return e;
  }

  function checkCancel(hooks) {
    if (hooks && typeof hooks.isCancelled === 'function') {
      var c = false;
      try { c = !!hooks.isCancelled(); } catch (e) { c = false; }
      if (c) throw cancelError();
    }
  }

  function log(hooks, msg) {
    if (!hooks || typeof hooks.onLog !== 'function') return;
    try { hooks.onLog(msg); } catch (e) { /* 忽略回调异常 */ }
  }

  /* 单调递增、限流的进度上报 */
  function makeProgress(hooks) {
    var last = -1;
    var lastAt = 0;
    return function (p, force) {
      if (!hooks || typeof hooks.onProgress !== 'function') return;
      p = clamp(p, 0, 1);
      if (p < last) p = last;
      var t = now();
      if (!force && p < 1 && t - lastAt < 60) return;
      lastAt = t;
      last = p;
      try { hooks.onProgress(p); } catch (e) { /* 忽略 */ }
    };
  }

  function closeQuietly(obj) {
    if (!obj) return;
    try { if (obj.state !== 'closed') obj.close(); } catch (e) { /* 忽略 */ }
  }

  /* 一对多唤醒器：等待事件（解码输出 / 状态变化） */
  function Signal() { this.waiters = []; }
  Signal.prototype.wait = function () {
    var self = this;
    return new Promise(function (resolve) { self.waiters.push(resolve); });
  };
  Signal.prototype.notify = function () {
    var list = this.waiters;
    this.waiters = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* 忽略 */ }
    }
  };

  function bytesToSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* 输入统一转 Uint8Array（File/Blob/ArrayBuffer/TypedArray 均可） */
  async function toBytes(input) {
    if (!input) throw err('没有输入文件');
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      var ab = await input.arrayBuffer();
      return new Uint8Array(ab);
    }
    throw err('不支持的输入类型（需要 File / Blob / ArrayBuffer / Uint8Array）');
  }

  /* =====================================================================
   * 1. 容器识别
   * ===================================================================== */

  function fourcc(b, off) {
    return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  }

  function detectContainer(b) {
    if (!b || b.length < 8) return 'unknown';
    // EBML (WebM / MKV)
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
      var dt = ebmlDocType(b);
      if (dt && dt.indexOf('webm') >= 0) return 'webm';
      return 'mkv';
    }
    // ISO BMFF
    var brand = '';
    if (b.length >= 12 && fourcc(b, 4) === 'ftyp') brand = fourcc(b, 8);
    if (brand === 'qt  ') return 'mov';
    if (brand) return 'mp4';
    // 有些 MOV 没有 ftyp，直接以 moov/mdat 开头
    if (b.length >= 8 && (fourcc(b, 4) === 'moov' || fourcc(b, 4) === 'mdat' || fourcc(b, 4) === 'wide')) return 'mov';
    return 'unknown';
  }

  /* 只读 EBML 头里的 DocType 字符串 */
  function ebmlDocType(b) {
    try {
      var id = ebmlId(b, 0);
      if (!id) return '';
      var sz = ebmlVint(b, id.length, false);
      if (!sz) return '';
      var end = Math.min(b.length, id.length + sz.length + sz.value);
      var p = id.length + sz.length;
      while (p < end) {
        var eid = ebmlId(b, p);
        if (!eid) break;
        var esz = ebmlVint(b, p + eid.length, false);
        if (!esz) break;
        var bs = p + eid.length + esz.length;
        var be = Math.min(end, bs + esz.value);
        if (eid.id === 0x4282) return utf8(b, bs, be);
        p = be;
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /* =====================================================================
   * 2. EBML / WebM / MKV 解封装（自实现）
   * ===================================================================== */

  var ID = {
    EBML: 0x1A45DFA3, DOCTYPE: 0x4282,
    SEGMENT: 0x18538067,
    INFO: 0x1549A966, TIMECODESCALE: 0x2AD7B1, DURATION: 0x4489,
    TRACKS: 0x1654AE6B, TRACKENTRY: 0xAE,
    TRACKNUMBER: 0xD7, TRACKUID: 0x73C5, TRACKTYPE: 0x83, CODECID: 0x86,
    CODECPRIVATE: 0x63A2, DEFAULTDURATION: 0x23E383, CODECDELAY: 0x56AA, SEEKPREROLL: 0x56BB,
    VIDEO: 0xE0, PIXELWIDTH: 0xB0, PIXELHEIGHT: 0xBA,
    DISPLAYWIDTH: 0x54B0, DISPLAYHEIGHT: 0x54BA, DISPLAYUNIT: 0x54B2,
    AUDIO: 0xE1, SAMPLINGFREQ: 0xB5, CHANNELS: 0x9F, BITDEPTH: 0x6264,
    CLUSTER: 0x1F43B675, TIMECODE: 0xE7, SIMPLEBLOCK: 0xA3,
    BLOCKGROUP: 0xA0, BLOCK: 0xA1, BLOCKDURATION: 0x9B, REFERENCEBLOCK: 0xFB,
    CUES: 0x1C53BB6B, TAGS: 0x1254C367, ATTACHMENTS: 0x1941A469, CHAPTERS: 0x1043A770,
    PROJECTION: 0x7670, POSE_ROLL: 0x7675,
    CONTENTENCODINGS: 0x6D80
  };

  function isTopLevelId(id) {
    return id === ID.SEGMENT || id === ID.CLUSTER || id === ID.CUES || id === ID.TAGS ||
      id === ID.ATTACHMENTS || id === ID.CHAPTERS || id === 0x1C53BB6B;
  }

  function ebmlId(b, off) {
    if (off + 1 > b.length) return null;
    var first = b[off];
    var len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 4 || off + len > b.length) return null;
    var v = first;
    for (var i = 1; i < len; i++) v = v * 256 + b[off + i];
    return { id: v, length: len };
  }

  /* size vint；keepMarker=true 时保留 marker 位（用于 Block 里的 track number） */
  function ebmlVint(b, off, keepMarker) {
    if (off + 1 > b.length) return null;
    var first = b[off];
    var len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || off + len > b.length) return null;
    var unknown = (first & (mask - 1)) === (mask - 1);
    var v = keepMarker ? first : (first & (mask - 1));
    for (var i = 1; i < len; i++) {
      v = v * 256 + b[off + i];
      if (b[off + i] !== 0xFF) unknown = false;
    }
    return { value: v, length: len, unknown: unknown };
  }

  function readUint(b, start, end) {
    var v = 0;
    for (var i = start; i < end && i < b.length; i++) {
      v = v * 256 + b[i];
      if (v > 9007199254740991) return v;
    }
    return v;
  }

  function readFloat(b, start, end) {
    var dv = new DataView(b.buffer, b.byteOffset + start, end - start);
    if (end - start === 4) return dv.getFloat32(0, false);
    if (end - start === 8) return dv.getFloat64(0, false);
    return 0;
  }

  function utf8(b, start, end) {
    start = Math.max(0, start); end = Math.min(b.length, end);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(b.subarray(start, end)); } catch (e) { /* 忽略 */ }
    }
    var s = '';
    for (var i = start; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  /* 遍历 EBML 子元素 */
  function eachEbmlChild(b, start, end, cb) {
    var p = start;
    var guard = 0;
    while (p < end && guard++ < 2000000) {
      var id = ebmlId(b, p);
      if (!id) break;
      var sz = ebmlVint(b, p + id.length, false);
      if (!sz) break;
      var bs = p + id.length + sz.length;
      if (bs > end) break;
      var be = sz.unknown ? end : Math.min(end, bs + sz.value);
      var stop = cb(id.id, bs, be);
      if (stop === false) break;
      if (be <= p) break;
      p = be;
    }
    return p;
  }

  /* 扫描 WebM/MKV，收集元数据与（可选）压缩样本 */
  function readWebM(b, needSamples, containerHint) {
    var meta = {
      container: containerHint === 'mkv' ? 'mkv' : 'webm',
      duration: 0, rotation: 0, fps: 0,
      codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0,
      width: 0, height: 0,
      videoCodec: '', videoDescription: null, videoTrackNumber: 0,
      videoHevc: null,
      audioCodec: '', audioDescription: null, audioTrackNumber: 0,
      audioSampleRate: 48000, audioChannels: 2,
      videoBitrateKbps: 0, audioBitrateKbps: 0, size: b.length,
      videoSamples: null, audioSamples: null,
      videoStartTs: 0, audioStartTs: 0,
      hasVideo: false, hasAudio: false
    };
    var timecodeScale = 1000000;
    var rawDuration = 0;
    var tracks = {};
    var trackStats = {};   // trackNumber -> {frames, count, bytes, firstTs, lastTs}
    var docType = '';

    function stat(num, frame, bytes) {
      var st = trackStats[num];
      if (!st) {
        st = trackStats[num] = { frames: [], count: 0, bytes: 0, firstTs: Infinity, lastTs: -1 };
      }
      st.count++;
      st.bytes += bytes;
      if (frame.ts < st.firstTs) st.firstTs = frame.ts;
      var endTs = frame.ts + (frame.dur || 0);
      if (endTs > st.lastTs) st.lastTs = endTs;
      if (needSamples) st.frames.push(frame);
    }

    function parseInfo(start, end) {
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TIMECODESCALE) timecodeScale = readUint(b, bs, be) || 1000000;
        else if (id === ID.DURATION) rawDuration = readFloat(b, bs, be);
      });
    }

    function parseTrackEntry(start, end) {
      var t = {
        number: 0, type: 0, codecId: '', codecPrivate: null,
        defaultDuration: 0, width: 0, height: 0,
        displayWidth: 0, displayHeight: 0, displayUnit: 0,
        sampleRate: 0, channels: 0, bitDepth: 0, roll: null
      };
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TRACKNUMBER) t.number = readUint(b, bs, be);
        else if (id === ID.TRACKTYPE) t.type = readUint(b, bs, be);
        else if (id === ID.CODECID) t.codecId = utf8(b, bs, be);
        else if (id === ID.CODECPRIVATE) t.codecPrivate = b.subarray(bs, be);
        else if (id === ID.DEFAULTDURATION) t.defaultDuration = readUint(b, bs, be);
        else if (id === ID.VIDEO) {
          eachEbmlChild(b, bs, be, function (vid, vbs, vbe) {
            if (vid === ID.PIXELWIDTH) t.width = readUint(b, vbs, vbe);
            else if (vid === ID.PIXELHEIGHT) t.height = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYWIDTH) t.displayWidth = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYHEIGHT) t.displayHeight = readUint(b, vbs, vbe);
            else if (vid === ID.DISPLAYUNIT) t.displayUnit = readUint(b, vbs, vbe);
            else if (vid === ID.PROJECTION) {
              eachEbmlChild(b, vbs, vbe, function (pid, pbs, pbe) {
                if (pid === ID.POSE_ROLL) t.roll = readFloat(b, pbs, pbe);
              });
            }
          });
        } else if (id === ID.AUDIO) {
          eachEbmlChild(b, bs, be, function (aid, abs, abe) {
            if (aid === ID.SAMPLINGFREQ) t.sampleRate = readFloat(b, abs, abe);
            else if (aid === ID.CHANNELS) t.channels = readUint(b, abs, abe);
            else if (aid === ID.BITDEPTH) t.bitDepth = readUint(b, abs, abe);
          });
        }
      });
      if (t.number) tracks[t.number] = t;
    }

    function parseTracks(start, end) {
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.TRACKENTRY) parseTrackEntry(bs, be);
      });
    }

    function pushFrame(trackNum, frame, bytes) {
      if (!trackNum) return;
      stat(trackNum, frame, bytes);
    }

    /* Block / SimpleBlock */
    function parseBlock(start, end, clusterTime, isKey, durOverrideUs) {
      var tn = ebmlVint(b, start, false);
      if (!tn) return;
      var p = start + tn.length;
      if (p + 3 > end) return;
      var rel = (b[p] << 8) | b[p + 1];
      if (rel & 0x8000) rel -= 0x10000;
      var flags = b[p + 2];
      p += 3;
      if (isKey === undefined) isKey = !!(flags & 0x80);
      var lacing = (flags & 0x06) >> 1;
      var pieces = [];
      var i, n, sizes, rest, sum, off, each;

      if (lacing === 0) {
        pieces.push({ off: p, len: end - p });
      } else if (lacing === 1) {           // Xiph lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        sizes = [];
        for (i = 0; i < n - 1; i++) {
          var s = 0, byte = 0, guard = 0;
          do {
            if (p >= end || guard++ > 100000) return;
            byte = b[p++]; s += byte;
          } while (byte === 255);
          sizes.push(s);
        }
        rest = end - p; sum = 0;
        for (i = 0; i < sizes.length; i++) sum += sizes[i];
        sizes.push(rest - sum);
        off = p;
        for (i = 0; i < n; i++) { pieces.push({ off: off, len: sizes[i] }); off += sizes[i]; }
      } else if (lacing === 2) {           // 固定 lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        each = Math.floor((end - p) / n);
        for (i = 0; i < n; i++) pieces.push({ off: p + i * each, len: each });
      } else {                              // EBML lacing
        if (p >= end) return;
        n = b[p] + 1; p++;
        var first = ebmlVint(b, p, false);
        if (!first) return;
        p += first.length;
        sizes = [first.value];
        for (i = 1; i < n - 1; i++) {
          var d = ebmlVint(b, p, false);
          if (!d) return;
          p += d.length;
          var bits = 7 * d.length;
          sizes.push(sizes[i - 1] + (d.value - (Math.pow(2, bits) - 1)));
        }
        rest = end - p; sum = 0;
        for (i = 0; i < sizes.length; i++) sum += sizes[i];
        sizes.push(Math.max(0, rest - sum));
        off = p;
        for (i = 0; i < n; i++) { pieces.push({ off: off, len: sizes[i] }); off += sizes[i]; }
      }

      var track = tracks[tn.value];
      var defDurUs = (track && track.defaultDuration ? track.defaultDuration / 1000 : 0);
      var durUs = durOverrideUs > 0 ? durOverrideUs : (defDurUs > 0 ? defDurUs : (track && track.type === 2 ? 20000 : 0));
      var baseTs = Math.round((clusterTime + rel) * timecodeScale / 1000);

      for (i = 0; i < pieces.length; i++) {
        var pc = pieces[i];
        if (pc.len <= 0 || pc.off < 0 || pc.off + pc.len > b.length) continue;
        pushFrame(tn.value, {
          ts: baseTs + Math.round(i * durUs),
          dur: durUs,
          key: isKey,
          data: needSamples ? b.subarray(pc.off, pc.off + pc.len) : null
        }, pc.len);
      }
    }

    function parseBlockGroup(start, end, clusterTime) {
      var blockRange = null;
      var blockDuration = 0;
      var hasReference = false;
      eachEbmlChild(b, start, end, function (id, bs, be) {
        if (id === ID.BLOCK) blockRange = [bs, be];
        else if (id === ID.BLOCKDURATION) blockDuration = readUint(b, bs, be);
        else if (id === ID.REFERENCEBLOCK) hasReference = true;
      });
      if (!blockRange) return;
      var durUs = blockDuration > 0 ? Math.round(blockDuration * timecodeScale / 1000) : 0;
      parseBlock(blockRange[0], blockRange[1], clusterTime, !hasReference, durUs);
    }

    function parseCluster(start, end, unknownSize) {
      var pos = start;
      var clusterTime = 0;
      var guard = 0;
      while (pos < end && guard++ < 4000000) {
        var id = ebmlId(b, pos);
        if (!id) break;
        if (unknownSize && isTopLevelId(id.id)) return pos;
        var sz = ebmlVint(b, pos + id.length, false);
        if (!sz) break;
        var bs = pos + id.length + sz.length;
        if (bs > end) break;
        var be = sz.unknown ? end : Math.min(end, bs + sz.value);
        if (id.id === ID.TIMECODE) clusterTime = readUint(b, bs, be);
        else if (id.id === ID.SIMPLEBLOCK) parseBlock(bs, be, clusterTime, undefined, 0);
        else if (id.id === ID.BLOCKGROUP) parseBlockGroup(bs, be, clusterTime);
        if (be <= pos) break;
        pos = be;
      }
      return pos;
    }

    /* ---- EBML 头 ---- */
    var head = ebmlId(b, 0);
    if (!head || head.id !== ID.EBML) throw err('不是有效的 WebM/Matroska 文件');
    var hSize = ebmlVint(b, head.length, false);
    if (!hSize) throw err('WebM 头部损坏');
    var hEnd = Math.min(b.length, head.length + hSize.length + hSize.value);
    eachEbmlChild(b, head.length + hSize.length, hEnd, function (id, bs, be) {
      if (id === ID.DOCTYPE) docType = utf8(b, bs, be);
    });
    if (docType && docType.indexOf('webm') < 0) meta.container = 'mkv';

    /* ---- Segment ---- */
    var segStart = -1, segEnd = -1;
    var p = hEnd;
    while (p + 4 < b.length) {
      var id2 = ebmlId(b, p);
      if (!id2) break;
      var sz2 = ebmlVint(b, p + id2.length, false);
      if (!sz2) break;
      var bs2 = p + id2.length + sz2.length;
      if (id2.id === ID.SEGMENT) {
        segStart = bs2;
        segEnd = sz2.unknown ? b.length : Math.min(b.length, bs2 + sz2.value);
        break;
      }
      if (sz2.unknown) break;
      p = bs2 + sz2.value;
    }
    if (segStart < 0) throw err('WebM 文件中未找到 Segment');
    if (segEnd < segStart) segEnd = b.length;

    var sp = segStart, guard1 = 0;
    while (sp < segEnd && guard1++ < 1000000) {
      var sid = ebmlId(b, sp);
      if (!sid) break;
      var ssz = ebmlVint(b, sp + sid.length, false);
      if (!ssz) break;
      var sbs = sp + sid.length + ssz.length;
      if (sbs > segEnd) break;
      var sbe = ssz.unknown ? segEnd : Math.min(segEnd, sbs + ssz.value);
      if (sid.id === ID.INFO) {
        parseInfo(sbs, sbe);
      } else if (sid.id === ID.TRACKS) {
        parseTracks(sbs, sbe);
      } else if (sid.id === ID.CLUSTER) {
        sbe = parseCluster(sbs, ssz.unknown ? segEnd : sbe, !!ssz.unknown);
      }
      if (sbe <= sp) break;
      sp = sbe;
    }

    /* ---- 组装元数据 ---- */
    var trackNumbers = Object.keys(tracks);
    var vTrack = null, aTrack = null;
    for (var ti = 0; ti < trackNumbers.length; ti++) {
      var tr = tracks[trackNumbers[ti]];
      if (tr.type === 1 && !vTrack) vTrack = tr;
      else if (tr.type === 2 && !aTrack) aTrack = tr;
    }

    var totalDurationSec = rawDuration > 0 ? rawDuration * timecodeScale / 1e9 : 0;

    if (vTrack) {
      var vst = trackStats[vTrack.number];
      meta.hasVideo = true;
      meta.videoTrackNumber = vTrack.number;
      meta.codedWidth = vTrack.width;
      meta.codedHeight = vTrack.height;
      var dw0 = (vTrack.displayWidth > 0 && vTrack.displayUnit === 0) ? vTrack.displayWidth : vTrack.width;
      var dh0 = (vTrack.displayHeight > 0 && vTrack.displayUnit === 0) ? vTrack.displayHeight : vTrack.height;
      meta.displayWidth = dw0;
      meta.displayHeight = dh0;
      var roll = vTrack.roll;
      if (isNum(roll)) {
        var rr = ((Math.round(roll / 90) * 90) % 360 + 360) % 360;
        if (rr === 90 || rr === 180 || rr === 270) meta.rotation = rr;
      }
      var codecInfo = webmVideoCodec(vTrack);
      meta.videoCodec = codecInfo.codec;
      meta.videoDescription = codecInfo.description;
      meta.videoHevc = codecInfo.hevc || null;
      meta.fps = webmFps(vTrack, vst, totalDurationSec);

      if (vst && vst.count > 0) {
        meta.videoStartTs = isFinite(vst.firstTs) ? vst.firstTs : 0;
        var defDur = vTrack.defaultDuration ? vTrack.defaultDuration / 1000 : (meta.fps > 0 ? Math.round(1e6 / meta.fps) : 33333);
        var vframes = vst.frames;
        var vLastEnd = vst.lastTs;
        if (needSamples) {
          // 视频块没有 duration：用相邻时间戳差补全，保持 VFR 节奏
          for (var vi = 0; vi < vframes.length; vi++) {
            var cur = vframes[vi];
            if (!cur.dur) {
              if (vi + 1 < vframes.length) cur.dur = Math.max(1000, vframes[vi + 1].ts - cur.ts);
              else cur.dur = Math.max(1000, defDur);
            }
            if (cur.ts + cur.dur > vLastEnd) vLastEnd = cur.ts + cur.dur;
          }
          if (vLastEnd > meta.duration) meta.duration = vLastEnd;
          meta.videoSamples = vframes;
        } else {
          if (vLastEnd + defDur > meta.duration) meta.duration = vLastEnd + defDur;
        }
        if (meta.fps <= 0 && vst.count > 1) {
          var span = (vst.lastTs - vst.firstTs) / 1e6;
          meta.fps = span > 0 ? (vst.count - 1) / span : 30;
        }
        var vEndSec = Math.max(meta.duration, vLastEnd) / 1e6;
        meta.videoBitrateKbps = vEndSec > 0 ? Math.round(vst.bytes * 8 / vEndSec / 1000) : 0;
      }
    }

    if (aTrack) {
      var ast = trackStats[aTrack.number];
      meta.hasAudio = true;
      meta.audioTrackNumber = aTrack.number;
      meta.audioSampleRate = aTrack.sampleRate > 0 ? Math.round(aTrack.sampleRate) : 48000;
      meta.audioChannels = aTrack.channels > 0 ? aTrack.channels : 2;
      var aInfo = webmAudioCodec(aTrack);
      meta.audioCodec = aInfo.codec;
      meta.audioDescription = aInfo.description;
      if (ast && ast.count > 0) {
        meta.audioStartTs = isFinite(ast.firstTs) ? ast.firstTs : 0;
        var aframes = ast.frames;
        var aDefDur = aTrack.defaultDuration ? aTrack.defaultDuration / 1000 : 20000;
        var aLastEnd = ast.lastTs;
        if (needSamples) {
          for (var ai = 0; ai < aframes.length; ai++) {
            if (!aframes[ai].dur) aframes[ai].dur = aDefDur;
            if (aframes[ai].ts + aframes[ai].dur > aLastEnd) aLastEnd = aframes[ai].ts + aframes[ai].dur;
          }
          meta.audioSamples = aframes;
        }
        if (aLastEnd > meta.duration) meta.duration = aLastEnd;
        var aEndSec = aLastEnd / 1e6;
        meta.audioBitrateKbps = aEndSec > 0 ? Math.round(ast.bytes * 8 / aEndSec / 1000) : 0;
      }
    }

    if (totalDurationSec > 0) meta.duration = Math.max(meta.duration, totalDurationSec * 1e6);
    meta.duration = Math.round(meta.duration) / 1e6;
    meta.fps = meta.fps > 0 ? Math.round(meta.fps * 1000) / 1000 : 30;
    meta.width = meta.rotation % 180 ? meta.displayHeight : meta.displayWidth;
    meta.height = meta.rotation % 180 ? meta.displayWidth : meta.displayHeight;
    return meta;
  }

  function webmVideoCodec(t) {
    var cid = (t.codecId || '').toUpperCase();
    var desc = t.codecPrivate || null;
    if (cid === 'V_VP8') return { codec: 'vp8', description: null };
    if (cid === 'V_VP9') return { codec: vp9CodecFromVpcC(desc), description: null };
    if (cid === 'V_AV1') return { codec: av1CodecFromAv1C(desc), description: desc };
    if (cid === 'V_MPEG4/ISO/AVC') return { codec: 'avc1.42E01E', description: desc };
    if (cid === 'V_MPEGH/ISO/HEVC') return { codec: 'hvc1.1.6.L93.B0', description: desc, hevc: parseHvcC(desc) };
    return { codec: cid ? cid.toLowerCase() : '', description: desc };
  }

  function webmAudioCodec(t) {
    var cid = (t.codecId || '').toUpperCase();
    var desc = t.codecPrivate || null;
    if (cid === 'A_OPUS') return { codec: 'opus', description: desc || opusHead(t.channels || 2, 312, 48000) };
    if (cid === 'A_VORBIS') return { codec: 'vorbis', description: desc };
    if (cid === 'A_AAC') return { codec: 'mp4a.40.2', description: desc };
    if (cid === 'A_MPEG/L3') return { codec: 'mp3', description: null };
    if (cid === 'A_FLAC') return { codec: 'flac', description: desc };
    if (cid === 'A_PCM/INT/LIT') return { codec: 'pcm-s16', description: null };
    return { codec: '', description: desc };
  }

  function webmFps(track, st, totalSec) {
    if (track.defaultDuration > 0) return Math.round((1e9 / track.defaultDuration) * 1000) / 1000;
    if (st && st.count > 1) {
      var span = (st.lastTs - st.firstTs) / 1e6;
      if (span > 0) return Math.round(((st.count - 1) / span) * 1000) / 1000;
    }
    if (totalSec > 0 && st) return Math.round(st.count / totalSec * 1000) / 1000;
    return 30;
  }

  /* vpcC（WebM CodecPrivate = vpcC 负载）：version(1) flags(1) profile(1) level(1) bitDepth(4bit) chroma... */
  function vp9CodecFromVpcC(desc) {
    try {
      if (!desc || desc.length < 6) return 'vp09.00.10.08';
      var profile = desc[2], level = desc[3], bitDepth = desc[4] >> 4;
      if (bitDepth !== 8 && bitDepth !== 10 && bitDepth !== 12) bitDepth = 8;
      var p = profile < 10 ? '0' + profile : '' + profile;
      var l = level < 10 ? '0' + level : '' + level;
      var bd = bitDepth < 10 ? '0' + bitDepth : '' + bitDepth;
      return 'vp09.' + p + '.' + l + '.' + bd;
    } catch (e) { return 'vp09.00.10.08'; }
  }

  /* av1C（WebM CodecPrivate = av1C 负载）：marker/version(2) seq_profile(3)+level(5) tier(1) high_bitdepth(1)... */
  function av1CodecFromAv1C(desc) {
    try {
      if (!desc || desc.length < 4) return 'av01.0.04M.08';
      var b1 = desc[1], b2 = desc[2];
      var profile = b1 >> 5;
      var level = b1 & 0x1F;
      var tier = (b2 >> 7) & 1 ? 'H' : 'M';
      var highBit = (b2 >> 6) & 1, twelve = (b2 >> 5) & 1;
      var depth = highBit ? (twelve ? 12 : 10) : 8;
      var lv = level < 10 ? '0' + level : '' + level;
      var dd = depth < 10 ? '0' + depth : '' + depth;
      return 'av01.' + profile + '.' + lv + tier + '.' + dd;
    } catch (e) { return 'av01.0.04M.08'; }
  }

  /* =====================================================================
   * 3. MP4 / MOV / M4V 解封装（mp4box.js）
   * ===================================================================== */

  function readMp4(b, needSamples, containerHint) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function fail(e) {
        if (settled) return;
        settled = true;
        reject(e);
      }
      if (typeof MP4Box === 'undefined' || !MP4Box.createFile) {
        fail(err('mp4box 库未加载'));
        return;
      }
      try {
        if (typeof Log !== 'undefined' && Log.setLogLevel && Log.error) Log.setLogLevel(Log.error);
      } catch (e) { /* 忽略 */ }

      var mp4;
      try { mp4 = MP4Box.createFile(); } catch (e) { fail(err('mp4box 初始化失败：' + e.message)); return; }

      var videoSamples = [];
      var audioSamples = [];
      var meta = null;

      mp4.onError = function (e) { fail(err('MP4 解析失败：' + String(e))); };

      mp4.onReady = function (info) {
        try {
          meta = buildMp4Meta(mp4, info, containerHint);
          if (!needSamples) {
            settled = true;
            resolve(meta);
            return;
          }
          mp4.setExtractionOptions(meta.videoTrackId, 'v', { nbSamples: 64 });
          if (meta.audioTrackId) mp4.setExtractionOptions(meta.audioTrackId, 'a', { nbSamples: 64 });
          mp4.start();
        } catch (e) { fail(e); }
      };

      mp4.onSamples = function (id, user, samples) {
        try {
          var arr = user === 'v' ? videoSamples : audioSamples;
          var scale = user === 'v' ? meta.videoTimescale : meta.audioTimescale;
          for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            if (!s.data || !s.data.byteLength) continue;
            arr.push({
              ts: Math.round(s.cts * MICRO / (s.timescale || scale || 1000)),
              dur: Math.round((s.duration || 0) * MICRO / (s.timescale || scale || 1000)),
              key: !!s.is_sync,
              data: s.data
            });
          }
        } catch (e) { fail(e); }
      };

      try {
        var ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        ab.fileStart = 0;
        mp4.appendBuffer(ab);
        mp4.flush();
      } catch (e) {
        fail(err('MP4 解封装失败：' + (e && e.message ? e.message : e)));
        return;
      }

      if (settled) return;
      if (!meta) { fail(err('MP4 文件中未找到可用的视频轨道')); return; }
      if (!needSamples) { settled = true; resolve(meta); return; }

      var vStart = Infinity, aStart = Infinity;
      for (var vi = 0; vi < videoSamples.length; vi++) if (videoSamples[vi].ts < vStart) vStart = videoSamples[vi].ts;
      for (var ai = 0; ai < audioSamples.length; ai++) if (audioSamples[ai].ts < aStart) aStart = audioSamples[ai].ts;
      meta.videoStartTs = isFinite(vStart) ? vStart : 0;
      meta.audioStartTs = isFinite(aStart) ? aStart : 0;
      meta.videoSamples = videoSamples;
      meta.audioSamples = audioSamples;
      if (!videoSamples.length) { fail(err('MP4 视频轨道没有可解码的样本')); return; }
      settled = true;
      resolve(meta);
    });
  }

  function buildMp4Meta(mp4, info, containerHint) {
    var vT = info.videoTracks && info.videoTracks[0];
    if (!vT) throw err('文件中没有视频轨道');
    var aT = (info.audioTracks && info.audioTracks.length) ? info.audioTracks[0] : null;
    var trak = mp4.getTrackById(vT.id);
    if (!trak) throw err('无法读取视频轨道');
    var entry = trak.mdia.minf.stbl.stsd.entries[0];

    var codedW = vT.video && vT.video.width ? vT.video.width : (entry.width || 0);
    var codedH = vT.video && vT.video.height ? vT.video.height : (entry.height || 0);
    var dispW = vT.track_width > 0 ? vT.track_width : codedW;
    var dispH = vT.track_height > 0 ? vT.track_height : codedH;
    var rotation = rotationFromMatrix(vT.matrix);
    var fps = fpsFromStts(trak, vT);
    var durationSec = info.duration > 0 ? info.duration / 1000 : 0;
    if (!(durationSec > 0)) {
      var md = vT.movie_duration, mts = vT.movie_timescale;
      if (md > 0 && mts > 0) durationSec = md / mts;
    }
    var vInfo = mp4VideoCodec(entry, vT.codec);
    var meta = {
      container: containerHint === 'mov' ? 'mov' : 'mp4',
      duration: durationSec,
      rotation: rotation,
      fps: fps,
      codedWidth: codedW,
      codedHeight: codedH,
      displayWidth: dispW,
      displayHeight: dispH,
      width: rotation % 180 ? dispH : dispW,
      height: rotation % 180 ? dispW : dispH,
      videoCodec: vInfo.codec,
      videoDescription: vInfo.description,
      videoHevc: vInfo.hevc || null,
      videoTrackId: vT.id,
      videoTimescale: vT.timescale,
      videoBitrateKbps: vT.bitrate > 0 ? Math.round(vT.bitrate / 1000) : 0,
      audioCodec: '', audioDescription: null, audioTrackId: 0, audioTimescale: 0,
      audioSampleRate: 0, audioChannels: 0, audioBitrateKbps: 0,
      hasVideo: true, hasAudio: false,
      size: 0, videoSamples: null, audioSamples: null,
      videoStartTs: 0, audioStartTs: 0
    };

    if (aT) {
      var atrak = mp4.getTrackById(aT.id);
      var aentry = atrak ? atrak.mdia.minf.stbl.stsd.entries[0] : null;
      var aInfo = mp4AudioCodec(aentry, aT.codec);
      meta.hasAudio = true;
      meta.audioTrackId = aT.id;
      meta.audioTimescale = aT.timescale;
      meta.audioCodec = aInfo.codec;
      meta.audioDescription = aInfo.description;
      meta.audioSampleRate = aT.audio && aT.audio.sample_rate ? aT.audio.sample_rate : (aentry && aentry.samplerate ? aentry.samplerate : 48000);
      meta.audioChannels = aT.audio && aT.audio.channel_count ? aT.audio.channel_count : (aentry && aentry.channel_count ? aentry.channel_count : 2);
      meta.audioBitrateKbps = aT.bitrate > 0 ? Math.round(aT.bitrate / 1000) : 0;
      var aDur = (aT.movie_duration && aT.movie_timescale) ? aT.movie_duration / aT.movie_timescale : 0;
      if (aDur > durationSec) durationSec = aDur;
      if (aT.samples_duration > 0 && aT.timescale > 0) {
        var ad = aT.samples_duration / aT.timescale;
        if (ad > durationSec) durationSec = ad;
      }
      meta.duration = durationSec;
    }
    return meta;
  }

  function rotationFromMatrix(m) {
    if (!m || m.length < 9) return 0;
    function fx(v) {
      if (v > 2147483647) v -= 4294967296;
      return v / 65536;
    }
    var a = fx(m[0]), bb = fx(m[1]);
    if (!isNum(a) || !isNum(bb)) return 0;
    var deg = Math.atan2(bb, a) * 180 / Math.PI;
    var r = Math.round(deg / 90) * 90;
    r = ((r % 360) + 360) % 360;
    return (r === 90 || r === 180 || r === 270) ? r : 0;
  }

  function fpsFromStts(trak, vT) {
    try {
      var stts = trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stts;
      if (stts && stts.sample_counts && stts.sample_deltas) {
        var bestCount = 0, bestDelta = 0;
        for (var i = 0; i < stts.sample_counts.length; i++) {
          if (stts.sample_counts[i] > bestCount) {
            bestCount = stts.sample_counts[i];
            bestDelta = stts.sample_deltas[i];
          }
        }
        if (bestDelta > 0) return Math.round((vT.timescale / bestDelta) * 1000) / 1000;
      }
    } catch (e) { /* 忽略 */ }
    if (vT.nb_samples > 0 && vT.samples_duration > 0) {
      return Math.round((vT.nb_samples * vT.timescale / vT.samples_duration) * 1000) / 1000;
    }
    return 30;
  }

  /* 自带的 mp4box 兼容写入器：不依赖 mp4box 内部的 DataStream（不同打包方式暴露位置不同）。
     mp4box 的 box.write(stream) 只会用到下面这些方法。 */
  function BoxWriter() {
    this.buf = new ArrayBuffer(256);
    this.u8 = new Uint8Array(this.buf);
    this.pos = 0;
  }
  BoxWriter.prototype._ensure = function (n) {
    if (this.pos + n <= this.u8.length) return;
    var cap = this.u8.length;
    while (cap < this.pos + n) cap *= 2;
    var nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.u8.subarray(0, this.pos));
    this.buf = nb;
    this.u8 = new Uint8Array(nb);
  };
  BoxWriter.prototype.getPosition = function () { return this.pos; };
  BoxWriter.prototype.writeUint8 = function (v) {
    this._ensure(1);
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt8 = function (v) { this.writeUint8(v); };
  BoxWriter.prototype.writeUint16 = function (v) {
    this._ensure(2);
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt16 = function (v) { this.writeUint16(v & 0xFFFF); };
  BoxWriter.prototype.writeUint24 = function (v) {
    this._ensure(3);
    this.u8[this.pos++] = (v >>> 16) & 255;
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeUint32 = function (v) {
    this._ensure(4);
    this.u8[this.pos++] = Math.floor(v / 16777216) & 255;
    this.u8[this.pos++] = (v >>> 16) & 255;
    this.u8[this.pos++] = (v >>> 8) & 255;
    this.u8[this.pos++] = v & 255;
  };
  BoxWriter.prototype.writeInt32 = function (v) {
    if (v < 0) v += 4294967296;
    this.writeUint32(v);
  };
  BoxWriter.prototype.writeUint64 = function (v) {
    var hi = Math.floor(v / 4294967296);
    this.writeUint32(hi);
    this.writeUint32(v - hi * 4294967296);
  };
  BoxWriter.prototype.writeString = function (str, endian, length) {
    var n = length === undefined ? str.length : length;
    this._ensure(n);
    for (var i = 0; i < n; i++) this.u8[this.pos++] = i < str.length ? (str.charCodeAt(i) & 255) : 0;
  };
  BoxWriter.prototype.writeCString = function (str) {
    this.writeString(str, null, str.length);
    this.writeUint8(0);
  };
  BoxWriter.prototype.writeUint8Array = function (arr, length) {
    var n = length === undefined ? arr.length : length;
    this._ensure(n);
    this.u8.set(arr.subarray ? arr.subarray(0, n) : arr, this.pos);
    this.pos += n;
  };
  BoxWriter.prototype.writeInt32Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeInt32(arr[i]);
  };
  BoxWriter.prototype.writeUint32Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeUint32(arr[i]);
  };
  BoxWriter.prototype.writeUint16Array = function (arr) {
    for (var i = 0; i < arr.length; i++) this.writeUint16(arr[i]);
  };
  BoxWriter.prototype.adjustUint32 = function (position, value) {
    this.u8[position] = Math.floor(value / 16777216) & 255;
    this.u8[position + 1] = (value >>> 16) & 255;
    this.u8[position + 2] = (value >>> 8) & 255;
    this.u8[position + 3] = value & 255;
  };
  BoxWriter.prototype.bytes = function () { return this.u8.slice(0, this.pos); };

  function boxPayload(box) {
    var w = new BoxWriter();
    box.write(w);
    var all = w.bytes();
    if (all.length <= 8) return all;
    // box.write() 带 8 字节 box 头（FullBox 另含 4 字节 version/flags，属于记录内容）
    return all.slice(8);
  }

  /* 直接按 AVCConfigurationBox 字段重建 avcC，避免依赖 mp4box 的写盒实现 */
  function buildAvcCRecord(box) {
    var sps = box.SPS || [];
    var pps = box.PPS || [];
    var i, nalu;
    var total = 7;
    for (i = 0; i < sps.length; i++) total += 2 + (sps[i].nalu ? sps[i].nalu.length : 0);
    for (i = 0; i < pps.length; i++) total += 2 + (pps[i].nalu ? pps[i].nalu.length : 0);
    var out = new Uint8Array(total);
    var p = 0;
    out[p++] = 1;
    out[p++] = box.AVCProfileIndication || 0x42;
    out[p++] = box.profile_compatibility || 0;
    out[p++] = box.AVCLevelIndication || 0x1F;
    out[p++] = 0xFC | (isNum(box.lengthSizeMinusOne) ? (box.lengthSizeMinusOne & 3) : 3);
    out[p++] = 0xE0 | (sps.length & 31);
    for (i = 0; i < sps.length; i++) {
      nalu = sps[i].nalu;
      out[p++] = (nalu.length >> 8) & 255;
      out[p++] = nalu.length & 255;
      out.set(nalu, p); p += nalu.length;
    }
    out[p++] = pps.length & 255;
    for (i = 0; i < pps.length; i++) {
      nalu = pps[i].nalu;
      out[p++] = (nalu.length >> 8) & 255;
      out[p++] = nalu.length & 255;
      out.set(nalu, p); p += nalu.length;
    }
    return out;
  }

  function looksLikeAvcC(u8) {
    if (!u8 || u8.length < 7) return false;
    return u8[0] === 1 && (u8[4] & 3) === 3 && (u8[5] & 31) > 0;
  }

  function avcCDescription(entry) {
    var box = entry.avcC;
    if (box.SPS && box.SPS.length && box.PPS && box.PPS.length) {
      var built = buildAvcCRecord(box);
      if (looksLikeAvcC(built)) return built;
    }
    var payload = boxPayload(box);
    if (looksLikeAvcC(payload)) return payload;
    // 某些实现 write() 不含 box 头：尝试几种偏移
    for (var off = 0; off <= 12 && off < payload.length; off++) {
      if (looksLikeAvcC(payload.subarray(off))) return payload.slice(off);
    }
    return payload;
  }

  function mp4VideoCodec(entry, codecStr) {
    var codec = codecStr || entry.type;
    if (entry.avcC) {
      var avc = avcCDescription(entry);
      return { codec: codec.indexOf('.') >= 0 ? codec : 'avc1.42E01E', description: avc };
    }
    if (entry.hvcC) {
      var hvcDesc = boxPayload(entry.hvcC);
      return { codec: codec, description: hvcDesc, hevc: parseHvcC(hvcDesc) };
    }
    if (entry.av1C) return { codec: codec, description: boxPayload(entry.av1C) };
    if (entry.vpcC) return { codec: codec, description: null };
    return { codec: codec, description: null };
  }

  function findEsdsDesc(node, tag) {
    if (!node) return null;
    if (node.tag === tag && node.data) return node.data;
    var kids = node.descs || [];
    for (var i = 0; i < kids.length; i++) {
      var r = findEsdsDesc(kids[i], tag);
      if (r) return r;
    }
    return null;
  }

  function mp4AudioCodec(entry, codecStr) {
    if (!entry) return { codec: codecStr || '', description: null };
    var codec = codecStr || entry.type;
    if (entry.esds) {
      var data = findEsdsDesc(entry.esds.esd, 5);
      if (data && data.length >= 1) return { codec: codec, description: new Uint8Array(data) };
      return { codec: codec, description: null };
    }
    if (entry.dOps) {
      return { codec: 'opus', description: opusHeadFromDOps(entry.dOps) };
    }
    return { codec: codec, description: null };
  }

  /* dOps -> OpusHead（改大端为小端） */
  function opusHeadFromDOps(d) {
    var ch = d.OutputChannelCount || 2;
    var preSkip = d.PreSkip || 312;
    var rate = d.InputSampleRate || 48000;
    var gain = d.OutputGain || 0;
    var head = new Uint8Array(19);
    head.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    head[8] = 1;
    head[9] = ch;
    head[10] = preSkip & 255; head[11] = (preSkip >> 8) & 255;
    head[12] = rate & 255; head[13] = (rate >> 8) & 255; head[14] = (rate >> 16) & 255; head[15] = (rate >>> 24) & 255;
    head[16] = gain & 255; head[17] = (gain >> 8) & 255;
    head[18] = 0;
    return head;
  }

  function opusHead(channels, preSkip, inputRate) {
    var h = new Uint8Array(19);
    h.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    h[8] = 1;
    h[9] = channels;
    h[10] = preSkip & 255; h[11] = (preSkip >> 8) & 255;
    h[12] = inputRate & 255; h[13] = (inputRate >> 8) & 255;
    h[14] = (inputRate >> 16) & 255; h[15] = (inputRate >>> 24) & 255;
    h[16] = 0; h[17] = 0; h[18] = 0;
    return h;
  }

  /* MPEG-4 AudioSpecificConfig（AAC-LC），用于缺少 esds 的兜底 */
  function makeAsc(sampleRate, channels) {
    var rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    var idx = rates.indexOf(sampleRate);
    if (idx < 0) idx = 3;
    var ch = clamp(channels || 2, 1, 2);
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
  }

  async function readSource(b, needSamples) {
    var container = detectContainer(b);
    if (container === 'mp4' || container === 'mov') {
      var m = await readMp4(b, needSamples, container);
      m.size = b.length;
      return m;
    }
    if (container === 'webm' || container === 'mkv') {
      var w = readWebM(b, needSamples, container);
      w.size = b.length;
      return w;
    }
    throw err('无法识别的文件格式（支持 MP4 / MOV / M4V / WebM / MKV）');
  }

  /* =====================================================================
   * 4. 能力检测
   * ===================================================================== */

  var supportCache = null;

  async function checkVideoDecode(codec) {
    try {
      var r = await VideoDecoder.isConfigSupported({ codec: codec, codedWidth: 640, codedHeight: 360 });
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function checkVideoEncode(codec, w, h, bitrate, extra) {
    try {
      var cfg = { codec: codec, width: w, height: h, bitrate: bitrate, framerate: 30 };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) cfg[k] = extra[k];
      var r = await VideoEncoder.isConfigSupported(cfg);
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function checkAudioEncode(codec, sampleRate, channels, bitrate) {
    try {
      var r = await AudioEncoder.isConfigSupported({ codec: codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: bitrate });
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  async function detectSupport() {
    var hasWC = (typeof VideoDecoder !== 'undefined') && (typeof VideoEncoder !== 'undefined') &&
      (typeof EncodedVideoChunk !== 'undefined') && (typeof VideoFrame !== 'undefined');
    var out = {
      webcodecs: hasWC,
      // hevcSoftware 表示「内置 wasm 软解可用」（扩展字段）；hevc 仍只表示原生解码能力
      decode: { h264: false, vp8: false, vp9: false, av1: false, hevc: false, hevcSoftware: true },
      encode: { h264: false, vp9: false, av1: false, vp8: false },
      audioEncode: { aac: false, opus: false },
      containers: {
        mp4: typeof Mp4Muxer !== 'undefined' && !!(Mp4Muxer && Mp4Muxer.Muxer),
        webm: typeof WebMMuxer !== 'undefined' && !!(WebMMuxer && WebMMuxer.Muxer)
      }
    };
    if (!hasWC) return out;
    var dec = await Promise.all([
      checkVideoDecode('avc1.42001f'),
      checkVideoDecode('vp8'),
      checkVideoDecode('vp09.00.10.08'),
      checkVideoDecode('av01.0.04M.08'),
      checkVideoDecode('hvc1.1.6.L93.B0')
    ]);
    out.decode.h264 = dec[0]; out.decode.vp8 = dec[1]; out.decode.vp9 = dec[2];
    out.decode.av1 = dec[3]; out.decode.hevc = dec[4];
    var enc = await Promise.all([
      checkVideoEncode('avc1.420028', 1280, 720, 2500000, { avc: { format: 'avc' } }),
      checkVideoEncode('vp09.00.10.08', 1280, 720, 2500000),
      checkVideoEncode('av01.0.04M.08', 1280, 720, 2500000),
      checkVideoEncode('vp8', 1280, 720, 2500000)
    ]);
    out.encode.h264 = enc[0]; out.encode.vp9 = enc[1];
    out.encode.av1 = enc[2]; out.encode.vp8 = enc[3];
    var a = await Promise.all([
      checkAudioEncode('mp4a.40.2', 48000, 2, 128000),
      checkAudioEncode('opus', 48000, 2, 128000)
    ]);
    out.audioEncode.aac = a[0]; out.audioEncode.opus = a[1];
    return out;
  }

  function support() {
    if (!supportCache) supportCache = detectSupport();
    return supportCache;
  }

  /* =====================================================================
   * 5. probe
   * ===================================================================== */

  async function probe(input) {
    var b = await toBytes(input);
    var src = await readSource(b, false);
    return {
      container: src.container,
      duration: Math.round(src.duration * 1000) / 1000,
      width: src.width,
      height: src.height,
      fps: src.fps,
      rotation: src.rotation,
      videoCodec: src.videoCodec || '',
      audioCodec: src.audioCodec || '',
      hasAudio: !!src.hasAudio,
      videoBitrate: src.videoBitrateKbps || 0,
      audioBitrate: src.audioBitrateKbps || 0,
      size: b.length
    };
  }

  /* =====================================================================
   * 6. 音频重采样 / 声道混合
   * ===================================================================== */

  function Resampler(inRate, outRate, channels) {
    this.step = inRate / outRate;
    this.pos = 0;
    this.base = 0;
    this.ch = channels;
    this.bufs = [];
    for (var i = 0; i < channels; i++) this.bufs.push(new Float32Array(0));
  }

  Resampler.prototype.push = function (chans) {
    var ch = this.ch, i, c;
    var inLen = chans[0] ? chans[0].length : 0;
    var out = [];
    if (!inLen) {
      for (c = 0; c < ch; c++) out.push(new Float32Array(0));
      return out;
    }
    for (c = 0; c < ch; c++) {
      var nb = new Float32Array(this.bufs[c].length + inLen);
      nb.set(this.bufs[c]);
      nb.set(chans[c] || chans[0], this.bufs[c].length);
      this.bufs[c] = nb;
    }
    var len = this.bufs[0].length;
    var maxIndex = this.base + len - 1;
    var maxOut = Math.ceil(len / this.step) + 2;
    for (c = 0; c < ch; c++) out.push(new Float32Array(maxOut));
    var n = 0;
    while (this.pos + 1 <= maxIndex) {
      var i0 = Math.floor(this.pos);
      var frac = this.pos - i0;
      var a = i0 - this.base;
      for (c = 0; c < ch; c++) {
        var buf = this.bufs[c];
        out[c][n] = buf[a] * (1 - frac) + buf[a + 1] * frac;
      }
      n++;
      this.pos += this.step;
    }
    var keep = Math.floor(this.pos) - this.base - 1;
    if (keep > 0) {
      for (c = 0; c < ch; c++) this.bufs[c] = this.bufs[c].slice(keep);
      this.base += keep;
    }
    for (c = 0; c < ch; c++) out[c] = out[c].slice(0, n);
    return out;
  };

  function mixChannels(chans, outCh) {
    var inCh = chans.length;
    var n = chans[0].length;
    var i, c;
    if (inCh === outCh) return chans;
    var out = [];
    if (outCh === 1) {
      var mono = new Float32Array(n);
      for (c = 0; c < inCh; c++) {
        var src = chans[c];
        for (i = 0; i < n; i++) mono[i] += src[i] / inCh;
      }
      for (i = 0; i < n; i++) mono[i] = clamp(mono[i], -1, 1);
      return [mono];
    }
    if (outCh === 2) {
      if (inCh === 1) return [chans[0], chans[0].slice(0)];
      var L = new Float32Array(n), R = new Float32Array(n);
      if (inCh >= 6) {
        // 5.1: FL FR FC LFE BL BR
        for (i = 0; i < n; i++) {
          L[i] = clamp(chans[0][i] + 0.707 * chans[2][i] + 0.707 * chans[4][i] + 0.25 * chans[3][i], -1, 1);
          R[i] = clamp(chans[1][i] + 0.707 * chans[2][i] + 0.707 * chans[5][i] + 0.25 * chans[3][i], -1, 1);
        }
      } else {
        for (i = 0; i < n; i++) { L[i] = chans[0][i]; R[i] = chans[1][i]; }
      }
      return [L, R];
    }
    for (c = 0; c < outCh; c++) out.push(chans[Math.min(c, inCh - 1)]);
    return out;
  }

  /* =====================================================================
   * 7. 画布变换（旋转 + 等比缩放）
   * ===================================================================== */

  function makeCanvas(w, h) {
    var canvas, ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false });
    }
    if (!ctx) {
      if (typeof document === 'undefined') throw err('当前环境不支持 Canvas 2D');
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext('2d', { alpha: false });
    }
    if (!ctx) throw err('无法创建 2D 画布上下文');
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* 忽略 */ }
    return { canvas: canvas, ctx: ctx, width: w, height: h };
  }

  /* displayW/displayH：旋转前的显示尺寸（含 SAR）；rotation：0/90/180/270 顺时针 */
  function drawRotated(cv, frame, displayW, displayH, rotation) {
    var ctx = cv.ctx;
    var outW = cv.width, outH = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    var s = Math.min(outW / displayW, outH / displayH);
    var dw = displayW * s;
    var dh = displayH * s;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    if (rotation === 90) {
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame, -dh / 2, -dw / 2, dh, dw);
    } else if (rotation === 180) {
      ctx.rotate(Math.PI);
      ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    } else if (rotation === 270) {
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(frame, -dh / 2, -dw / 2, dh, dw);
    } else {
      ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
  }

  /* =====================================================================
   * 7.5 HEVC 软解（@hevcjs/core wasm，仅原生解码不可用时启用）
   * ===================================================================== */

  var hevcWasmBytes = null;
  var hevcModulePromise = null;
  var hevcModuleError = null;

  function base64ToBytes(b64) {
    if (typeof atob !== 'function') throw err('当前环境缺少 atob，无法解码内联 wasm');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hevcWasmBinary() {
    if (hevcWasmBytes) return hevcWasmBytes;
    if (typeof HEVC_WASM_B64 !== 'string' || !HEVC_WASM_B64) {
      throw err('HEVC 软解 wasm 未内联到引擎中');
    }
    hevcWasmBytes = base64ToBytes(HEVC_WASM_B64).buffer;
    return hevcWasmBytes;
  }

  /* 懒加载：编译 wasm + 初始化 Emscripten 模块（file:// 可用，无 fetch） */
  function createHevcModule() {
    if (hevcModulePromise) return hevcModulePromise;
    if (hevcModuleError) return Promise.reject(hevcModuleError);
    if (typeof HEVCDecoderModule !== 'function') {
      hevcModuleError = err('HEVC 软解模块未加载（HEVCDecoderModule 缺失）');
      return Promise.reject(hevcModuleError);
    }
    var initError = null;
    var timeoutError = null;
    var init = Promise.resolve().then(function () {
      return WebAssembly.compile(hevcWasmBinary());
    }).then(function (compiled) {
      return Promise.race([
        HEVCDecoderModule({
          instantiateWasm: function (imports, success) {
            WebAssembly.instantiate(compiled, imports).then(function (res) {
              // WebAssembly.instantiate(Module, imports) 直接返回 Instance
              try { success(res && res.exports ? res : res.instance); } catch (e) { initError = e; }
            }, function (e) { initError = e; });
          }
        }),
        new Promise(function (resolve, reject) {
          setTimeout(function () {
            timeoutError = err('HEVC 软解 wasm 初始化超时');
            reject(timeoutError);
          }, 20000);
        })
      ]);
    }).then(function (mod) {
      if (!mod) throw initError || err('HEVC 软解模块初始化失败');
      return mod;
    }).catch(function (e) {
      hevcModuleError = initError || timeoutError || e;
      hevcModulePromise = null;
      throw hevcModuleError;
    });
    hevcModulePromise = init;
    return init;
  }

  function parseHevcFrameLayout(spec) {
    var fields = String(spec || '').split(',');
    var out = {};
    for (var i = 0; i < fields.length; i++) {
      var s = fields[i];
      var idx = s.indexOf(':');
      if (idx < 0) continue;
      out[s.slice(0, idx)] = Number(s.slice(idx + 1));
    }
    if (!isNum(out._size) || !isNum(out.width) || !isNum(out.y)) {
      throw err('HEVC 软解 wasm 帧布局不兼容');
    }
    return out;
  }

  /* 直接基于 Emscripten 模块的轻量封装（等价于 @hevcjs/core 的 HEVCDecoder） */
  function HevcDecoderHandle(mod) {
    this.m = mod;
    var cw = mod.cwrap;
    this.layout = parseHevcFrameLayout(cw('hevc_frame_layout', 'string', [])());
    this.api = {
      create: cw('hevc_decoder_create', 'number', []),
      destroy: cw('hevc_decoder_destroy', null, ['number']),
      feed: cw('hevc_decoder_feed', 'number', ['number', 'number', 'number']),
      drain: cw('hevc_decoder_drain', 'number', ['number', 'number']),
      getDrainedFrame: cw('hevc_decoder_get_drained_frame', 'number', ['number', 'number', 'number']),
      flush: cw('hevc_decoder_flush', 'number', ['number']),
      getInfo: cw('hevc_decoder_get_info', 'number', ['number', 'number'])
    };
    this.dec = this.api.create();
    if (!this.dec) throw err('HEVC 软解器创建失败');
    this.destroyed = false;
  }

  HevcDecoderHandle.prototype._readFrame = function (framePtr) {
    var m = this.m, at = this.layout;
    var yPtr = m.getValue(framePtr + at.y, '*');
    var cbPtr = m.getValue(framePtr + at.cb, '*');
    var crPtr = m.getValue(framePtr + at.cr, '*');
    var width = m.getValue(framePtr + at.width, 'i32');
    var height = m.getValue(framePtr + at.height, 'i32');
    var strideY = m.getValue(framePtr + at.stride_y, 'i32');
    var strideC = m.getValue(framePtr + at.stride_c, 'i32');
    var cw = m.getValue(framePtr + at.chroma_width, 'i32');
    var ch = m.getValue(framePtr + at.chroma_height, 'i32');
    var bd = m.getValue(framePtr + at.bit_depth, 'i32');
    var poc = m.getValue(framePtr + at.poc, 'i32');
    var cvsId = m.getValue(framePtr + at.cvs_id, 'i32');
    var bps = m.getValue(framePtr + at.bytes_per_sample, 'i32');
    function plane(ptr, pw, ph, stride) {
      var out = new Uint16Array(pw * ph);
      var heap = bps === 1 ? m.HEAPU8 : m.HEAPU16;
      var base = bps === 1 ? ptr : ptr >> 1;
      for (var yy = 0; yy < ph; yy++) {
        out.set(heap.subarray(base + yy * stride, base + yy * stride + pw), yy * pw);
      }
      return out;
    }
    return {
      y: plane(yPtr, width, height, strideY),
      cb: plane(cbPtr, cw, ch, strideC),
      cr: plane(crPtr, cw, ch, strideC),
      width: width, height: height,
      chromaWidth: cw, chromaHeight: ch,
      bitDepth: bd, poc: poc, cvsId: cvsId
    };
  };

  HevcDecoderHandle.prototype.feed = function (u8) {
    var m = this.m;
    var ptr = m._malloc(u8.length);
    try {
      m.HEAPU8.set(u8, ptr);
      var ret = this.api.feed(this.dec, ptr, u8.length);
      if (ret !== 0) throw err('HEVC 软解 feed 失败（code ' + ret + '）');
    } finally {
      m._free(ptr);
    }
  };

  HevcDecoderHandle.prototype.drain = function () {
    var m = this.m;
    var countPtr = m._malloc(4);
    var frames = [];
    try {
      var ret = this.api.drain(this.dec, countPtr);
      if (ret !== 0) return frames;
      var count = m.getValue(countPtr, 'i32');
      var framePtr = m._malloc(this.layout._size);
      try {
        for (var i = 0; i < count; i++) {
          var r = this.api.getDrainedFrame(this.dec, i, framePtr);
          if (r === 0) frames.push(this._readFrame(framePtr));
        }
      } finally {
        m._free(framePtr);
      }
    } finally {
      m._free(countPtr);
    }
    return frames;
  };

  HevcDecoderHandle.prototype.flush = function () {
    var m = this.m;
    var frames = [];
    if (this.api.flush(this.dec) !== 0) return frames;
    var framePtr = m._malloc(this.layout._size);
    try {
      for (var i = 0; i < 100000; i++) {
        var r = this.api.getDrainedFrame(this.dec, i, framePtr);
        if (r !== 0) break;
        frames.push(this._readFrame(framePtr));
      }
    } finally {
      m._free(framePtr);
    }
    return frames;
  };

  HevcDecoderHandle.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.api.destroy(this.dec); } catch (e) { /* 忽略 */ }
    this.dec = 0;
  };

  /* hvcC（HEVCDecoderConfigurationRecord）解析：参数集 + NAL 长度前缀 + 色度/位深 */
  function parseHvcC(p) {
    if (!p || p.length < 23 || p[0] !== 1) return null;
    var numArrays = p[22];
    var off = 23;
    var vps = [], sps = [], pps = [];
    for (var a = 0; a < numArrays; a++) {
      if (off + 3 > p.length) break;
      var nalType = p[off] & 0x3F;
      var count = (p[off + 1] << 8) | p[off + 2];
      off += 3;
      var target = nalType === 32 ? vps : nalType === 33 ? sps : nalType === 34 ? pps : null;
      for (var n = 0; n < count; n++) {
        if (off + 2 > p.length) break;
        var len = (p[off] << 8) | p[off + 1];
        off += 2;
        if (len <= 0 || off + len > p.length) break;
        if (target) target.push(p.subarray(off, off + len));
        off += len;
      }
    }
    return {
      lengthSize: (p[21] & 3) + 1,
      chromaFormat: p[16] & 3,
      bitDepthLuma: (p[17] & 7) + 8,
      bitDepthChroma: (p[18] & 7) + 8,
      vps: vps, sps: sps, pps: pps
    };
  }

  function annexBFromNals(nals) {
    var total = 0, i;
    for (i = 0; i < nals.length; i++) total += 4 + nals[i].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (i = 0; i < nals.length; i++) {
      out[p++] = 0; out[p++] = 0; out[p++] = 0; out[p++] = 1;
      out.set(nals[i], p);
      p += nals[i].length;
    }
    return out;
  }

  function hevcParamAnnexB(hevc) {
    return annexBFromNals(hevc.vps.concat(hevc.sps, hevc.pps));
  }

  /* AVCC（4 字节长度前缀）-> Annex B（00 00 00 01 起始码） */
  function avccToAnnexB(data, lengthSize) {
    var nals = [];
    var p = 0;
    while (p + lengthSize <= data.length) {
      var len = 0;
      for (var i = 0; i < lengthSize; i++) len = len * 256 + data[p + i];
      p += lengthSize;
      if (len <= 0 || p + len > data.length) break;
      nals.push(data.subarray(p, p + len));
      p += len;
    }
    return annexBFromNals(nals);
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /* HEVCFrame（Y/Cb/Cr 平面，8/10bit，4:2:0）-> I420 VideoFrame（10bit 右移 2 位降到 8bit） */
  function hevcFrameToVideoFrame(f, tsUs, durUs) {
    var w = f.width | 0, h = f.height | 0;
    var cw = f.chromaWidth | 0, ch = f.chromaHeight | 0;
    var bd = f.bitDepth | 0;
    if (w <= 0 || h <= 0) throw err('HEVC 软解输出帧尺寸无效');
    if (cw !== ((w + 1) >> 1) || ch !== ((h + 1) >> 1)) {
      throw err('HEVC 软解仅支持 4:2:0（色度 ' + cw + 'x' + ch + ' 与亮度 ' + w + 'x' + h + ' 不匹配）');
    }
    if (bd !== 8 && bd !== 10) {
      throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + bd + 'bit）');
    }
    var shift = bd === 10 ? 2 : 0;
    var yN = w * h, cN = cw * ch;
    var data = new Uint8Array(yN + cN * 2);
    var i;
    for (i = 0; i < yN; i++) data[i] = (f.y[i] >> shift) & 255;
    for (i = 0; i < cN; i++) data[yN + i] = (f.cb[i] >> shift) & 255;
    for (i = 0; i < cN; i++) data[yN + cN + i] = (f.cr[i] >> shift) & 255;
    return new VideoFrame(data, {
      format: 'I420',
      codedWidth: w,
      codedHeight: h,
      timestamp: Math.max(0, Math.round(tsUs)),
      duration: Math.max(1000, Math.round(durUs)),
      layout: [
        { offset: 0, stride: w },
        { offset: yN, stride: cw },
        { offset: yN + cN, stride: cw }
      ],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    });
  }

  function isHevcCodec(codec) {
    return /^(hvc1|hev1|hvc2|hev2)(\.|$)/i.test(String(codec || ''));
  }

  /* =====================================================================
   * 8. 编码器选择
   * ===================================================================== */

  async function chooseVideoEncoder(format, outW, outH, fps, bitrate) {
    var candidates = [];
    if (format === 'mp4') {
      candidates = [
        { codec: 'avc1.420028', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.42001f', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.4d0028', container: 'avc', avc: { format: 'avc' } },
        { codec: 'avc1.640028', container: 'avc', avc: { format: 'avc' } }
      ];
    } else {
      candidates = [
        { codec: 'vp09.00.10.08', container: 'V_VP9' },
        { codec: 'vp8', container: 'V_VP8' }
      ];
    }
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var extra = c.avc ? { avc: c.avc } : null;
      var ok = await checkVideoEncode(c.codec, outW, outH, bitrate, extra);
      if (ok) return c;
    }
    throw err(format === 'mp4'
      ? '当前浏览器不支持 H.264 编码，无法输出 MP4'
      : '当前浏览器不支持 VP9 / VP8 编码，无法输出 WebM');
  }

  async function chooseAudioConfig(format, srcRate, srcCh, bitrateKbps) {
    var baseCh = clamp(srcCh || 2, 1, 2);
    var bitrate = clamp(bitrateKbps || 128, 32, 512) * 1000;
    var rates;
    var chanList = [baseCh];
    if (format === 'webm') {
      rates = [48000];
    } else {
      rates = srcRate === 44100 ? [44100, 48000] : [srcRate || 48000, 48000, 44100];
      // 部分平台的 AAC 编码器只支持立体声，单声道输入退化为立体声输出
      if (baseCh === 1) chanList.push(2);
    }
    var codec = format === 'webm' ? 'opus' : 'mp4a.40.2';
    for (var ci = 0; ci < chanList.length; ci++) {
      var channels = chanList[ci];
      for (var i = 0; i < rates.length; i++) {
        var rate = rates[i];
        if (!(rate >= 8000 && rate <= 96000)) continue;
        if (format === 'webm' && rate !== 48000) continue;
        if (await checkAudioEncode(codec, rate, channels, bitrate)) {
          return {
            codec: codec, sampleRate: rate, numberOfChannels: channels, bitrate: bitrate,
            containerCodec: format === 'webm' ? 'opus' : 'aac', upmixed: channels !== baseCh
          };
        }
      }
    }
    return null;
  }

  async function audioDecoderConfig(src) {
    if (!src.hasAudio || !src.audioCodec) return null;
    var cfg = {
      codec: src.audioCodec,
      sampleRate: src.audioSampleRate || 48000,
      numberOfChannels: src.audioChannels || 2
    };
    if (src.audioDescription && src.audioDescription.length) cfg.description = src.audioDescription;
    if (src.audioCodec.indexOf('mp4a') === 0 && !cfg.description) {
      cfg.description = makeAsc(cfg.sampleRate, cfg.numberOfChannels);
    }
    try {
      var r = await AudioDecoder.isConfigSupported(cfg);
      if (r && r.supported) return cfg;
    } catch (e) { /* 继续尝试无 description */ }
    if (cfg.description) {
      var cfg2 = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels };
      try {
        var r2 = await AudioDecoder.isConfigSupported(cfg2);
        if (r2 && r2.supported) return cfg2;
      } catch (e2) { /* 忽略 */ }
    }
    return null;
  }

  /* =====================================================================
   * 9. 视频转码
   * ===================================================================== */

  /* 创建视频编码器：统一 muxer 写入（DTS + composition offset）、实际编码串回读、错误收集 */
  function createVideoEncoder(ctx, state) {
    var frameDurUs = state.frameDurUs || Math.max(1000, Math.round(MICRO / ctx.targetFps));
    var enc = new VideoEncoder({
      output: function (chunk, meta) {
        try {
          if (ctx.format === 'mp4') {
            // mp4-muxer 的第三个参数是「显示时间戳 PTS」，DTS = timestamp - compositionTimeOffset。
            // 因此这里传 PTS，offset = PTS - DTS；DTS 按帧时长严格递增，B 帧乱序时也不会回退。
            var pts = Math.round(chunk.timestamp);
            var dts = Math.round(state.dtsUs);
            var offset = pts - dts;
            if (offset < state.minCompOffset) state.minCompOffset = offset;
            state.dtsUs += (chunk.duration && chunk.duration > 0 ? chunk.duration : frameDurUs);
            ctx.muxer.addVideoChunk(chunk, meta, pts, offset);
          } else {
            ctx.muxer.addVideoChunk(chunk, meta);
          }
          if (!state.actualCodec && ctx.format === 'mp4' && meta && meta.decoderConfig && meta.decoderConfig.description) {
            var d = new Uint8Array(meta.decoderConfig.description);
            if (d.length >= 4 && d[0] === 1) {
              state.actualCodec = 'avc1.' + hex2(d[1]) + hex2(d[2]) + hex2(d[3]);
            }
          }
        } catch (e) { state.error = e; }
      },
      error: function (e) { state.error = e; }
    });
    enc.configure(ctx.encoderConfig);
    return enc;
  }

  /* 视频帧公共处理：fps 网格丢帧 -> 旋转/缩放 -> VideoFrame -> 编码 -> 进度 + 背压 */
  function makeVideoFrameSink(ctx, enc, state) {
    var frameDurUs = state.frameDurUs || Math.max(1000, Math.round(MICRO / ctx.targetFps));
    var firstTs = ctx.src.videoStartTs || 0;
    var nextAcceptUs = -1;
    var lastKeyUs = -1e12;
    var outFrames = 0;
    var lastOutTs = -1;
    var videoEndUs = 0;
    return {
      push: async function (frame, ts, durHint) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var keep = true;
        if (ctx.limitFps) {
          // 网格采样：以首帧时间戳为 0 号槽位，只有越过槽位才保留一帧，
          // 平均帧率严格等于 targetFps，且总时长不变。
          if (nextAcceptUs < 0) nextAcceptUs = ts;
          var guardSlots = 0;
          while (nextAcceptUs + frameDurUs <= ts && guardSlots++ < 10000) {
            nextAcceptUs += frameDurUs;
          }
          keep = ts >= nextAcceptUs;
          if (keep) nextAcceptUs += frameDurUs;
        }
        if (!keep) return false;

        var outTs = ts - firstTs;
        if (outTs < 0) outTs = 0;
        if (outTs <= lastOutTs) outTs = lastOutTs + 1;
        var dur = ctx.limitFps ? frameDurUs : (durHint && durHint > 0 ? durHint : frameDurUs);

        drawRotated(ctx.canvas, frame, ctx.displayW, ctx.displayH, ctx.src.rotation);
        var vf = new VideoFrame(ctx.canvas.canvas, {
          timestamp: outTs,
          duration: Math.max(1000, dur),
          alpha: 'discard'
        });
        var keyFrame = outFrames === 0 || (outTs - lastKeyUs >= ctx.keyIntervalUs);
        if (keyFrame) lastKeyUs = outTs;
        enc.encode(vf, { keyFrame: keyFrame });
        vf.close();
        outFrames++;
        lastOutTs = outTs;
        videoEndUs = outTs + Math.max(1000, dur);
        ctx.progress(Math.min(0.985, (outTs + dur) / Math.max(1, ctx.totalUs)));

        var guard = 0;
        while (enc.encodeQueueSize > 4) {
          checkCancel(ctx.hooks);
          if (state.error) throw state.error;
          await sleep0();
          if (++guard > 100000) throw err('视频编码器长时间无响应');
        }
        return true;
      },
      end: function () {
        if (state.error) throw state.error;
        ctx.videoEndUs = videoEndUs;
        ctx.outFrames = outFrames;
        ctx.actualVideoCodec = state.actualCodec || '';
        if (state.minCompOffset < -2000) {
          ctx.notes.push('编码器输出 B 帧：已写入 composition time offset（ctts）');
        }
        if (!outFrames) throw err('视频解码没有产生任何帧');
      }
    };
  }

  async function encodeVideo(ctx) {
    var src = ctx.src;
    var samples = src.videoSamples;
    var state = {
      error: null, dtsUs: 0, minCompOffset: 0, actualCodec: '',
      frameDurUs: Math.max(1000, Math.round(MICRO / ctx.targetFps))
    };
    var queue = [];
    var signal = new Signal();
    var decodeError = null;
    var flushed = false;
    var sampleIdx = 0;
    var dec = null;
    var enc = null;

    log(ctx.hooks, '视频：' + samples.length + ' 帧样本，' + ctx.decoderConfig.codec +
      ' → ' + ctx.encoder.codec + '，输出 ' + ctx.outW + 'x' + ctx.outH + ' @ ' + Math.round(ctx.targetFps) + ' fps');

    dec = new VideoDecoder({
      output: function (frame) { queue.push(frame); signal.notify(); },
      error: function (e) { decodeError = e; signal.notify(); }
    });
    dec.configure(ctx.decoderConfig);

    enc = createVideoEncoder(ctx, state);
    var sink = makeVideoFrameSink(ctx, enc, state);

    try {
      while (true) {
        checkCancel(ctx.hooks);
        if (decodeError) throw decodeError;
        if (state.error) throw state.error;

        while (sampleIdx < samples.length && dec.decodeQueueSize < 6) {
          var s = samples[sampleIdx++];
          dec.decode(new EncodedVideoChunk({
            type: s.key ? 'key' : 'delta',
            timestamp: s.ts,
            duration: Math.max(1000, s.dur || state.frameDurUs),
            data: s.data
          }));
        }

        if (queue.length === 0) {
          if (sampleIdx >= samples.length && !flushed) {
            await dec.flush();
            flushed = true;
            continue;
          }
          if (flushed) break;
          await signal.wait();
          continue;
        }

        var frame = queue.shift();
        try {
          if (frame.timestamp >= 0) await sink.push(frame, frame.timestamp, frame.duration);
        } finally {
          frame.close();
        }
      }
      checkCancel(ctx.hooks);
      await enc.flush();
      sink.end();
    } finally {
      closeQuietly(dec);
      closeQuietly(enc);
    }

    if (decodeError) throw decodeError;
  }

  /* HEVC 软解路径：hvcC 参数集 + Annex B 喂给 wasm，输出 I420 VideoFrame 后复用同一套 Canvas/编码逻辑 */
  async function encodeVideoSoft(ctx) {
    var src = ctx.src;
    var hevc = src.videoHevc;
    var samples = src.videoSamples;
    var srcFps = src.fps > 0 ? src.fps : 30;
    var frameDurUs = Math.max(1000, Math.round(MICRO / srcFps));
    var firstTs = src.videoStartTs || 0;
    var state = {
      error: null, dtsUs: 0, minCompOffset: 0, actualCodec: '', frameDurUs: frameDurUs
    };
    var enc = null;
    var handle = null;
    var outIndex = 0;
    var tStart = now();

    if (!hevc || !hevc.vps.length || !hevc.sps.length || !hevc.pps.length) {
      throw err('HEVC 软解缺少参数集（hvcC 中的 VPS/SPS/PPS），无法解码');
    }
    if (hevc.chromaFormat !== 1) {
      throw err('HEVC 软解仅支持 4:2:0（当前 chroma_format_idc=' + hevc.chromaFormat + '）');
    }
    if (hevc.bitDepthLuma > 10 || hevc.bitDepthChroma > 10) {
      throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + hevc.bitDepthLuma + 'bit）');
    }

    log(ctx.hooks, '视频（HEVC 软解）：' + samples.length + ' 帧样本，' + src.videoCodec +
      ' → ' + ctx.encoder.codec + '，输出 ' + ctx.outW + 'x' + ctx.outH + ' @ ' + Math.round(ctx.targetFps) + ' fps');

    enc = createVideoEncoder(ctx, state);
    var sink = makeVideoFrameSink(ctx, enc, state);

    async function consume(frames) {
      for (var i = 0; i < frames.length; i++) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var f = frames[i];
        var ts = firstTs + outIndex * frameDurUs;
        outIndex++;
        var vf = hevcFrameToVideoFrame(f, ts, frameDurUs);
        try {
          await sink.push(vf, ts, frameDurUs);
        } finally {
          vf.close();
        }
      }
      frames.length = 0;
    }

    try {
      var mod = await createHevcModule();
      checkCancel(ctx.hooks);
      handle = new HevcDecoderHandle(mod);
      var params = hevcParamAnnexB(hevc);

      for (var i = 0; i < samples.length; i++) {
        checkCancel(ctx.hooks);
        if (state.error) throw state.error;
        var s = samples[i];
        var body = avccToAnnexB(s.data, hevc.lengthSize);
        // 首帧与每个关键帧前都补上 hvcC 参数集，兼容 hvc1/hev1 以及流中途换参数集的情况
        var payload = (i === 0 || s.key) ? concatBytes(params, body) : body;
        handle.feed(payload);
        await consume(handle.drain());
        ctx.progress(Math.min(0.985, ((s.ts + (s.dur || frameDurUs)) - firstTs) / Math.max(1, ctx.totalUs)));
        if ((i & 7) === 0) await sleep0();
      }

      await consume(handle.flush());
      checkCancel(ctx.hooks);
      await enc.flush();
      sink.end();
      log(ctx.hooks, 'HEVC 软解完成：' + outIndex + ' 帧，用时 ' +
        ((now() - tStart) / 1000).toFixed(1) + ' 秒');
    } finally {
      if (handle) handle.destroy();
      closeQuietly(enc);
    }
  }

  /* =====================================================================
   * 10. 音频转码
   * ===================================================================== */

  async function encodeAudio(ctx) {
    var src = ctx.src;
    var samples = src.audioSamples || [];
    var targetRate = ctx.audioRate;
    var targetCh = ctx.audioChannels;
    var chunkFrames = ctx.format === 'webm' ? 960 : 1024;
    var inRate = src.audioSampleRate || 48000;
    var resampler = inRate !== targetRate ? new Resampler(inRate, targetRate, targetCh) : null;
    var baseTsUs = Math.max(0, (src.audioStartTs || 0) - (src.videoStartTs || 0));
    var acc = [];
    var accFrames = 0;
    var outFrames = 0;
    var audioEndUs = 0;
    var raw = [];
    var rawFrames = 0;
    var rawMax = targetRate;      // 最多缓存 1 秒原始音频
    var signal = new Signal();
    var decodeError = null;
    var encodeError = null;
    var flushed = false;
    var sampleIdx = 0;
    var dec = null;
    var enc = null;
    var opusDesc = ctx.format === 'webm' ? opusHead(targetCh, 312, 48000) : null;
    var c;

    for (c = 0; c < targetCh; c++) acc.push(new Float32Array(0));

    function appendAcc(pieces) {
      var n = pieces[0] ? pieces[0].length : 0;
      if (!n) return;
      for (var i = 0; i < targetCh; i++) {
        var nb = new Float32Array(acc[i].length + n);
        nb.set(acc[i]);
        nb.set(pieces[i] || pieces[0], acc[i].length);
        acc[i] = nb;
      }
      accFrames += n;
    }

    async function emitChunk() {
      var data = new Float32Array(chunkFrames * targetCh);
      for (var i = 0; i < targetCh; i++) {
        data.set(acc[i].subarray(0, chunkFrames), i * chunkFrames);
        acc[i] = acc[i].slice(chunkFrames);
      }
      accFrames -= chunkFrames;
      var tsUs = baseTsUs + Math.round(outFrames * MICRO / targetRate);
      var ad = new AudioData({
        format: 'f32-planar',
        sampleRate: targetRate,
        numberOfFrames: chunkFrames,
        numberOfChannels: targetCh,
        timestamp: tsUs,
        data: data
      });
      enc.encode(ad);
      ad.close();
      outFrames += chunkFrames;
      audioEndUs = tsUs + Math.round(chunkFrames * MICRO / targetRate);
      var guard = 0;
      while (enc.encodeQueueSize > 6) {
        checkCancel(ctx.hooks);
        await sleep0();
        if (++guard > 100000) throw err('音频编码器长时间无响应');
      }
    }

    dec = new AudioDecoder({
      output: function (ad) {
        try {
          var n = ad.numberOfFrames, ch = ad.numberOfChannels, chans = [];
          for (var i = 0; i < ch; i++) {
            var a = new Float32Array(n);
            ad.copyTo(a, { planeIndex: i, format: 'f32-planar' });
            chans.push(a);
          }
          raw.push({ chans: chans, frames: n });
          rawFrames += n;
        } catch (e) { decodeError = e; }
        try { ad.close(); } catch (e2) { /* 忽略 */ }
        signal.notify();
      },
      error: function (e) { decodeError = e; signal.notify(); }
    });
    dec.configure(ctx.audioDecodeConfig);

    enc = new AudioEncoder({
      output: function (chunk, meta) {
        try {
          if (ctx.format === 'webm') {
            ctx.muxer.addAudioChunk(chunk, {
              decoderConfig: {
                codec: 'opus',
                sampleRate: targetRate,
                numberOfChannels: targetCh,
                description: opusDesc
              }
            });
          } else {
            var md = meta && meta.decoderConfig ? meta : {};
            if (!md.decoderConfig || !md.decoderConfig.description) {
              md = {
                decoderConfig: {
                  codec: 'mp4a.40.2',
                  sampleRate: targetRate,
                  numberOfChannels: targetCh,
                  description: makeAsc(targetRate, targetCh)
                }
              };
            }
            ctx.muxer.addAudioChunk(chunk, md);
          }
        } catch (e) { encodeError = e; }
      },
      error: function (e) { encodeError = e; }
    });
    enc.configure(ctx.audioEncoderConfig);

    log(ctx.hooks, '音频：' + (src.audioCodec || '?') + ' ' + inRate + 'Hz ' + (src.audioChannels || 2) + 'ch → ' +
      (ctx.format === 'webm' ? 'Opus' : 'AAC') + ' ' + targetRate + 'Hz ' + targetCh + 'ch ' +
      Math.round(ctx.audioEncoderConfig.bitrate / 1000) + 'kbps');

    try {
      while (true) {
        checkCancel(ctx.hooks);
        if (decodeError) throw decodeError;
        if (encodeError) throw encodeError;

        while (sampleIdx < samples.length && rawFrames < rawMax && dec.decodeQueueSize < 10) {
          var s = samples[sampleIdx++];
          dec.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: s.ts,
            duration: Math.max(1000, s.dur || 20000),
            data: s.data
          }));
        }

        if (raw.length === 0) {
          if (sampleIdx >= samples.length && !flushed) {
            await dec.flush();
            flushed = true;
            continue;
          }
          if (flushed) break;
          await signal.wait();
          continue;
        }

        var seg = raw.shift();
        rawFrames -= seg.frames;
        var mixed = mixChannels(seg.chans, targetCh);
        var pieces = resampler ? resampler.push(mixed) : mixed;
        appendAcc(pieces);
        while (accFrames >= chunkFrames) {
          checkCancel(ctx.hooks);
          await emitChunk();
        }
      }

      // 尾部不足一帧：补静音
      if (accFrames > 0) {
        var pad = [];
        for (c = 0; c < targetCh; c++) {
          var p = new Float32Array(chunkFrames);
          p.set(acc[c].subarray(0, Math.min(accFrames, chunkFrames)));
          pad.push(p);
        }
        acc = pad;
        accFrames = chunkFrames;
        checkCancel(ctx.hooks);
        await emitChunk();
      }

      checkCancel(ctx.hooks);
      await enc.flush();
    } finally {
      closeQuietly(dec);
      closeQuietly(enc);
    }

    if (decodeError) throw decodeError;
    if (encodeError) throw encodeError;
    ctx.audioEndUs = audioEndUs;
    ctx.audioOutFrames = outFrames;
  }

  /* =====================================================================
   * 11. convert
   * ===================================================================== */

  function planSize(src, opts) {
    var vw = src.rotation % 180 ? src.displayHeight : src.displayWidth;
    var vh = src.rotation % 180 ? src.displayWidth : src.displayHeight;
    if (!(vw > 0) || !(vh > 0)) {
      vw = src.rotation % 180 ? src.codedHeight : src.codedWidth;
      vh = src.rotation % 180 ? src.codedWidth : src.codedHeight;
    }
    var maxW = isNum(opts.maxWidth) && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 0;
    var maxH = isNum(opts.maxHeight) && opts.maxHeight > 0 ? Math.floor(opts.maxHeight) : 0;
    var scale = 1;
    if (maxW && vw > maxW) scale = Math.min(scale, maxW / vw);
    if (maxH && vh > maxH) scale = Math.min(scale, maxH / vh);
    return { width: even(vw * scale), height: even(vh * scale), srcDisplayW: vw, srcDisplayH: vh };
  }

  function autoBitrate(w, h, fps) {
    var kbps = Math.round(w * h * Math.min(fps || 30, 60) * 0.09 / 1000);
    return Math.round(clamp(kbps, 300, 20000));
  }

  async function convert(input, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    if (!opts.format) throw err('缺少输出格式 opts.format（mp4 / webm）');
    var format = opts.format;
    if (format !== 'mp4' && format !== 'webm') throw err('不支持的输出格式：' + opts.format);

    var t0 = now();
    var progress = makeProgress(hooks);
    progress(0, true);
    checkCancel(hooks);

    var bytes = await toBytes(input);
    log(hooks, '读取 ' + bytesToSize(bytes.length) + '，开始探测');
    var src = await readSource(bytes, true);
    checkCancel(hooks);

    if (!src.hasVideo) throw err('文件中没有视频轨道');
    if (!src.videoSamples || !src.videoSamples.length) throw err('视频轨道没有可解码的样本（解封装失败）');
    if (!src.videoCodec) throw err('无法识别视频编码');
    progress(0.01, true);

    var size = planSize(src, opts);
    var outW = size.width, outH = size.height;

    var limitFps = isNum(opts.fps) && opts.fps > 0;
    var targetFps = limitFps ? clamp(opts.fps, 1, 240) : (src.fps > 0 ? src.fps : 30);
    var limitByFps = limitFps && targetFps < src.fps - 0.001;

    var vKbps = isNum(opts.videoBitrate) && opts.videoBitrate > 0
      ? Math.round(opts.videoBitrate)
      : autoBitrate(outW, outH, targetFps);

    var keyIntervalSec = isNum(opts.keyframeInterval) && opts.keyframeInterval > 0 ? opts.keyframeInterval : 2;
    var notes = [];

    // 旋转/缩放说明
    if (src.rotation) notes.push('已按元数据旋转画面 ' + src.rotation + '°（输出无旋转矩阵）');
    if (outW !== size.srcDisplayW || outH !== size.srcDisplayH) {
      notes.push('输出尺寸 ' + outW + 'x' + outH + '（原 ' + size.srcDisplayW + 'x' + size.srcDisplayH + '）');
    }
    if (limitByFps) notes.push('帧率 ' + src.fps + ' → ' + targetFps + ' fps（按时间戳丢帧，时长不变）');

    var encoder = await chooseVideoEncoder(format, outW, outH, Math.round(targetFps), vKbps * 1000);
    var encoderConfig = {
      codec: encoder.codec,
      width: outW,
      height: outH,
      bitrate: clamp(vKbps * 1000, 50000, 60000000),
      framerate: Math.max(1, Math.round(targetFps)),
      latencyMode: 'quality',
      hardwareAcceleration: 'no-preference'
    };
    if (encoder.avc) encoderConfig.avc = encoder.avc;

    // ---- 音频规划 ----
    var audioActive = false;
    var audioDecodeCfg = null;
    var audioEncodeCfg = null;
    var audioDropReason = '';
    if (opts.audio === 'drop') {
      audioDropReason = '按参数丢弃音频';
    } else if (!src.hasAudio) {
      audioDropReason = '输入没有音频轨道';
    } else if (!src.audioSamples || !src.audioSamples.length) {
      audioDropReason = '输入音频轨道没有可用样本';
    } else {
      audioDecodeCfg = await audioDecoderConfig(src);
      if (!audioDecodeCfg) {
        audioDropReason = 'WebCodecs 无法解码输入音频编码 ' + (src.audioCodec || '未知');
      } else {
        var chosen = await chooseAudioConfig(format, src.audioSampleRate, src.audioChannels, opts.audioBitrate);
        if (!chosen) {
          audioDropReason = (format === 'mp4' ? 'AAC' : 'Opus') + ' 音频编码不可用';
        } else {
          audioActive = true;
          audioEncodeCfg = chosen;
          if (chosen.upmixed) notes.push('单声道音频已上混为立体声输出（平台 AAC 编码器不支持单声道）');
        }
      }
    }
    if (audioDropReason) {
      notes.push('音频已丢弃：' + audioDropReason);
      log(hooks, '音频已丢弃：' + audioDropReason);
    }

    // ---- 创建合成器 ----
    var muxer;
    if (format === 'mp4') {
      var mp4Opts = {
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: outW, height: outH, frameRate: Math.max(1, Math.round(targetFps)) },
        firstTimestampBehavior: 'offset',
        fastStart: 'in-memory'
      };
      if (audioActive) {
        mp4Opts.audio = {
          codec: 'aac',
          sampleRate: audioEncodeCfg.sampleRate,
          numberOfChannels: audioEncodeCfg.numberOfChannels
        };
      }
      muxer = new Mp4Muxer.Muxer(mp4Opts);
    } else {
      var webmOpts = {
        target: new WebMMuxer.ArrayBufferTarget(),
        video: {
          codec: encoder.container,
          width: outW,
          height: outH,
          frameRate: Math.max(1, Math.round(targetFps))
        },
        firstTimestampBehavior: 'offset'
      };
      if (audioActive) {
        webmOpts.audio = {
          codec: 'A_OPUS',
          sampleRate: audioEncodeCfg.sampleRate,
          numberOfChannels: audioEncodeCfg.numberOfChannels
        };
      }
      muxer = new WebMMuxer.Muxer(webmOpts);
    }

    var canvas = makeCanvas(outW, outH);
    var decoderConfig = {
      codec: src.videoCodec,
      codedWidth: src.codedWidth,
      codedHeight: src.codedHeight,
      optimizeForLatency: false
    };
    if (src.videoDescription && src.videoDescription.length) decoderConfig.description = src.videoDescription;

    // 原生 VideoDecoder 优先；HEVC 原生不可用时回退到内置 wasm 软解
    var vdecSupported = false;
    var softHevc = false;
    try {
      var vr = await VideoDecoder.isConfigSupported(decoderConfig);
      vdecSupported = !!(vr && vr.supported);
    } catch (e) { vdecSupported = false; }
    if (!vdecSupported && decoderConfig.description) {
      var cfg2 = { codec: decoderConfig.codec, codedWidth: decoderConfig.codedWidth, codedHeight: decoderConfig.codedHeight };
      try {
        var vr2 = await VideoDecoder.isConfigSupported(cfg2);
        if (vr2 && vr2.supported) { decoderConfig = cfg2; vdecSupported = true; }
      } catch (e2) { /* 忽略 */ }
    }
    if (!vdecSupported) {
      if (isHevcCodec(src.videoCodec)) {
        var hvc = src.videoHevc;
        if (!hvc || !hvc.vps.length || !hvc.sps.length || !hvc.pps.length) {
          throw err('当前浏览器无法解码 HEVC（' + src.videoCodec + '），且文件缺少 hvcC 参数集，无法软解');
        }
        if (hvc.chromaFormat !== 1) {
          throw err('HEVC 软解仅支持 4:2:0（当前 chroma_format_idc=' + hvc.chromaFormat + '），4:2:2/4:4:4 不受支持');
        }
        if (hvc.bitDepthLuma > 10 || hvc.bitDepthChroma > 10) {
          throw err('HEVC 软解仅支持 8bit / 10bit（当前 ' + hvc.bitDepthLuma + 'bit）');
        }
        softHevc = true;
        notes.push('HEVC 使用内置软解（@hevcjs/core wasm），时间戳按恒定帧率估算，转码较慢');
        if (hvc.bitDepthLuma > 8) notes.push('10bit HEVC 已降为 8bit 输出');
        log(hooks, '原生 HEVC 解码不可用，改用内置软解');
      } else {
        throw err('当前浏览器无法解码输入视频编码 ' + src.videoCodec + '（可能缺少解码器或描述信息）');
      }
    }

    var ctx = {
      src: src,
      format: format,
      hooks: hooks,
      progress: progress,
      muxer: muxer,
      encoder: encoder,
      encoderConfig: encoderConfig,
      decoderConfig: decoderConfig,
      canvas: canvas,
      outW: outW,
      outH: outH,
      displayW: size.srcDisplayW,
      displayH: size.srcDisplayH,
      targetFps: targetFps,
      limitFps: limitByFps,
      keyIntervalUs: keyIntervalSec * MICRO,
      totalUs: Math.max(1, src.duration * MICRO),
      videoEndUs: 0,
      audioEndUs: 0,
      notes: notes,
      actualVideoCodec: '',
      softHevc: softHevc,
      audioRate: audioActive ? audioEncodeCfg.sampleRate : 0,
      audioChannels: audioActive ? audioEncodeCfg.numberOfChannels : 0,
      audioDecodeConfig: audioDecodeCfg,
      audioEncoderConfig: audioEncodeCfg
    };

    log(hooks, '输出：' + format.toUpperCase() + ' ' + outW + 'x' + outH + '，' +
      Math.round(targetFps) + ' fps，视频 ' + vKbps + ' kbps');
    progress(0.02, true);

    try {
      if (ctx.softHevc) {
        await encodeVideoSoft(ctx);
      } else {
        await encodeVideo(ctx);
      }
      checkCancel(hooks);
      progress(0.99, true);

      if (audioActive) {
        await encodeAudio(ctx);
      }

      checkCancel(hooks);
      muxer.finalize();
      var outBuf = muxer.target.buffer;
      var data = outBuf instanceof Uint8Array ? outBuf : new Uint8Array(outBuf);
      progress(1, true);

      var durationSec = Math.max(ctx.videoEndUs, ctx.audioEndUs) / MICRO;
      if (!(durationSec > 0)) durationSec = src.duration;
      var elapsed = (now() - t0) / 1000;
      log(hooks, '完成：' + bytesToSize(data.length) + '，用时 ' + elapsed.toFixed(1) + ' 秒');

      var meta = {
        format: format,
        width: outW,
        height: outH,
        fps: Math.round(targetFps * 1000) / 1000,
        duration: Math.round(durationSec * 1000) / 1000,
        videoCodec: format === 'mp4'
          ? (ctx.actualVideoCodec || encoder.codec)
          : (encoder.container === 'V_VP9' ? 'vp09.00.10.08' : 'vp8'),
        audioCodec: audioActive ? (format === 'webm' ? 'opus' : 'mp4a.40.2') : '',
        bitrate: durationSec > 0 ? Math.round(data.length * 8 / durationSec / 1000) : 0,
        size: data.length,
        notes: notes
      };
      return { data: data, meta: meta };
    } catch (e) {
      throw e;
    }
  }

  /* =====================================================================
   * 12. 导出
   * ===================================================================== */

  var VideoEngine = {
    version: VERSION,
    support: support,
    probe: probe,
    convert: convert,
    /* HEVC wasm 软解是否随包提供（不代表原生解码能力） */
    hevcSoftware: true,
    /* 便于测试/调试，非稳定 API */
    _internal: {
      detectContainer: detectContainer,
      readSource: readSource,
      readWebM: readWebM,
      readMp4: readMp4,
      drawRotated: drawRotated,
      makeCanvas: makeCanvas,
      Resampler: Resampler,
      mixChannels: mixChannels,
      opusHead: opusHead,
      makeAsc: makeAsc,
      parseHvcC: parseHvcC,
      avccToAnnexB: avccToAnnexB,
      hevcFrameToVideoFrame: hevcFrameToVideoFrame,
      createHevcModule: createHevcModule,
      HevcDecoderHandle: HevcDecoderHandle,
      isHevcCodec: isHevcCodec
    }
  };

  try {
    Object.defineProperty(global, 'VideoEngine', { value: VideoEngine, writable: true, configurable: true, enumerable: true });
  } catch (e) {
    global.VideoEngine = VideoEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
