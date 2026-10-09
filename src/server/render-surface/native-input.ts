import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { NativeHtmlRuntime } from './cef.js';

interface KeyDefinition { key: string; keyCode: number; keyCodeWithoutLocation?: number; shiftKey?: string; shiftKeyCode?: number; text?: string; location?: number }
const require = createRequire(import.meta.url), driver = dirname(require.resolve('playwright-core/package.json'));
const layout = require(join(driver, 'lib/server/usKeyboardLayout.js')).USKeyboardLayout as Record<string, KeyDefinition>;
const keys = new Map<string, KeyDefinition & { code: string }>();
for (const [code, definition] of Object.entries(layout)) {
  const value={...definition,code};keys.set(code,value);
  if (!keys.has(definition.key)) keys.set(definition.key,value);
  if (definition.shiftKey) keys.set(definition.shiftKey,{...value,key:definition.shiftKey,keyCode:definition.shiftKeyCode??definition.keyCode});
}
const bits: Record<string,number>={Alt:1,Control:2,Meta:4,Shift:8};
// macOS virtual key codes identify physical keys independently of generated text.
const macKeys:Record<string,number>={KeyA:0,KeyS:1,KeyD:2,KeyF:3,KeyH:4,KeyG:5,KeyZ:6,KeyX:7,KeyC:8,KeyV:9,KeyB:11,KeyQ:12,KeyW:13,KeyE:14,KeyR:15,KeyY:16,KeyT:17,Digit1:18,Digit2:19,Digit3:20,Digit4:21,Digit6:22,Digit5:23,Equal:24,Digit9:25,Digit7:26,Minus:27,Digit8:28,Digit0:29,BracketRight:30,KeyO:31,KeyU:32,BracketLeft:33,KeyI:34,KeyP:35,Enter:36,KeyL:37,KeyJ:38,Quote:39,KeyK:40,Semicolon:41,Backslash:42,Comma:43,Slash:44,KeyN:45,KeyM:46,Period:47,Tab:48,Space:49,Backquote:50,Backspace:51,Escape:53,MetaRight:54,MetaLeft:55,ShiftLeft:56,AltLeft:58,ControlLeft:59,ShiftRight:60,AltRight:61,ControlRight:62,F17:64,NumpadDecimal:65,NumpadMultiply:67,NumpadAdd:69,NumLock:71,NumpadDivide:75,NumpadEnter:76,NumpadSubtract:78,F18:79,F19:80,NumpadEqual:81,Numpad0:82,Numpad1:83,Numpad2:84,Numpad3:85,Numpad4:86,Numpad5:87,Numpad6:88,Numpad7:89,F20:90,Numpad8:91,Numpad9:92,F5:96,F6:97,F7:98,F3:99,F8:100,F9:101,F11:103,F13:105,F16:106,F14:107,F10:109,F12:111,F15:113,Insert:114,Home:115,PageUp:116,Delete:117,F4:118,End:119,F2:120,PageDown:121,F1:122,ArrowLeft:123,ArrowRight:124,ArrowDown:125,ArrowUp:126};
const macCharacters:Record<string,number>={Enter:13,Tab:9,Backspace:8,Escape:27,Delete:127,ArrowUp:0xf700,ArrowDown:0xf701,ArrowLeft:0xf702,ArrowRight:0xf703,Home:0xf729,End:0xf72b,PageUp:0xf72c,PageDown:0xf72d,Insert:0xf727};
export class NativeSurfaceInput {
  private modifiers=new Set<string>();
  private buttons=0;
  constructor(private runtime:NativeHtmlRuntime) {}
  private mask(){return [...this.modifiers].reduce((mask,key)=>mask|(bits[key]??0),0)}
  private mouseMask(){return(this.modifiers.has('Shift')?2:0)|(this.modifiers.has('Control')?4:0)|(this.modifiers.has('Alt')?8:0)|(this.modifiers.has('Meta')?128:0)|(this.buttons&1?16:0)|(this.buttons&4?32:0)|(this.buttons&2?64:0)}
  async pointer(action:'move'|'down'|'up'|'click',x:number,y:number,button:'left'|'middle'|'right'='left'){
    if(action==='down'||action==='click')await this.runtime.protocol('Surface.focus');
    await this.runtime.protocol('Surface.sendMouseEvent',{type:'move',x:Math.floor(x),y:Math.floor(y),modifiers:this.mouseMask()});
    const bit={left:1,right:2,middle:4}[button];
    if(action==='down'||action==='click'){this.buttons|=bit;await this.runtime.protocol('Surface.sendMouseEvent',{type:'down',x:Math.floor(x),y:Math.floor(y),button,modifiers:this.mouseMask()})}
    if(action==='up'||action==='click'){this.buttons&=~bit;await this.runtime.protocol('Surface.sendMouseEvent',{type:'up',x:Math.floor(x),y:Math.floor(y),button,modifiers:this.mouseMask()})}
  }
  async wheel(x:number,y:number,deltaX:number,deltaY:number){await this.runtime.protocol('Surface.sendMouseEvent',{type:'wheel',x:Math.floor(x),y:Math.floor(y),deltaX:Math.round(-deltaX),deltaY:Math.round(-deltaY),modifiers:this.mouseMask()})}
  private definition(key:string){const resolved=key==='ControlOrMeta'?'Meta':key,value=keys.get(resolved);if(!value)throw new Error('surface_input_key:Use a supported physical key or text input.');return value;}
  private async send(action:'down'|'up',key:string,emitText=true,characterText?:string){
    const value=this.definition(key);if(bits[value.key])action==='down'?this.modifiers.add(value.key):this.modifiers.delete(value.key);
    if((this.modifiers.has('Meta')||this.modifiers.has('Control'))&&['KeyC','KeyV','KeyX'].includes(value.code))throw new Error('surface_clipboard_client:Complete clipboard actions in the client browser.');
    const nativeKeyCode=macKeys[value.code];if(nativeKeyCode===undefined)throw new Error('surface_input_key:Use a supported physical key or text input.');
    const producedKey=this.modifiers.has('Shift')&&value.shiftKey?value.shiftKey:value.key;
    const character=characterText?.charCodeAt(0)??(producedKey.length===1?producedKey.charCodeAt(0):macCharacters[producedKey]??0);
    const modifiers=(this.modifiers.has('Shift')?2:0)|(this.modifiers.has('Control')?4:0)|(this.modifiers.has('Alt')?8:0)|(this.modifiers.has('Meta')?128:0);
    const params={nativeKeyCode,windowsKeyCode:value.keyCodeWithoutLocation??value.keyCode,character,unmodifiedCharacter:character,modifiers};
    await this.runtime.protocol('Surface.sendKeyEvent',{...params,type:action});
    // Chromium suppresses the following character when the page cancels raw keydown.
    if(action==='down'&&emitText&&character&&(characterText!==undefined||producedKey.length===1||['Enter','Tab'].includes(producedKey))&&!this.modifiers.has('Meta')&&!this.modifiers.has('Control')&&(!this.modifiers.has('Alt')||characterText!==undefined))await this.runtime.protocol('Surface.sendKeyEvent',{...params,type:'char'});
  }
  async key(action:'down'|'up'|'press',key:string,emitText=true,characterText?:string){
    if(characterText!==undefined&&(typeof characterText!=='string'||characterText.length!==1))throw new Error('surface_input_key_character');
    if(action!=='press'){this.definition(key);await this.send(action,key,emitText,characterText);return}
    const parts=key.split('+'),last=parts.pop()||'+',modifiers=parts.filter(Boolean);for(const part of [...modifiers,last])this.definition(part);
    const pressed:string[]=[];
    try{for(const modifier of modifiers){const value=this.definition(modifier);if(!this.modifiers.has(value.key)){await this.send('down',modifier);pressed.push(modifier)}}await this.send('down',last,emitText,characterText);await this.send('up',last,emitText,characterText)}finally{for(const modifier of pressed.reverse())await this.send('up',modifier)}
  }
  text(text:string){return this.runtime.protocol('Input.insertText',{text});}
}
