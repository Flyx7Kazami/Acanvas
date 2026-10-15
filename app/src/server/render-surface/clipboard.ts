import type {HtmlClipboardAction,HtmlClipboardData} from '../../shared/html-surface.js';
import type {NativeHtmlRuntime} from './cef.js';

export function validateHtmlClipboard(data:HtmlClipboardData):HtmlClipboardData{
  if(!data||typeof data.text!=='string'||data.text.length>65_536||data.html!==undefined&&(typeof data.html!=='string'||data.html.length>65_536))throw new Error('surface_clipboard_text_size');
  if(data.imagePngBase64!==undefined){if(typeof data.imagePngBase64!=='string'||data.imagePngBase64.length>1_398_104)throw new Error('surface_clipboard_image_size');const bytes=Buffer.from(data.imagePngBase64,'base64');if(bytes.length>1_048_576||bytes.toString('base64')!==data.imagePngBase64||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('surface_clipboard_image');}
  return{text:data.text,...(data.html!==undefined?{html:data.html}:{}),...(data.imagePngBase64!==undefined?{imagePngBase64:data.imagePngBase64}:{})};
}

/** The trusted wrapper's clipboard is the per-process headless ClipboardNonBacked store. */
export class NativeSurfaceClipboard {
  private initialized=false;
  constructor(private runtime:NativeHtmlRuntime,private origin:string){}
  private async ready(){if(this.initialized)return;await this.runtime.protocol('Browser.grantPermissions',{origin:this.origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});this.initialized=true;}
  private async evaluate(expression:string){const result=await this.runtime.protocol('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error('surface_clipboard_protocol');return result.result.value;}
  private async write(data:HtmlClipboardData){
    await this.evaluate(`(async()=>{const data=${JSON.stringify(data)},items={'text/plain':new Blob([data.text],{type:'text/plain'})};if(data.html!==undefined)items['text/html']=new Blob([data.html],{type:'text/html'});if(data.imagePngBase64!==undefined){const raw=Uint8Array.from(atob(data.imagePngBase64),c=>c.charCodeAt(0));items['image/png']=new Blob([raw],{type:'image/png'})}await navigator.clipboard.write([new ClipboardItem(items)]);return true})()`);
  }
  private async read():Promise<HtmlClipboardData>{
    const value=await this.evaluate(`(async()=>{const result={text:''},items=await navigator.clipboard.read();for(const item of items)for(const type of item.types){if(type==='text/plain'||type==='text/html'){const text=await(await item.getType(type)).text();if(text.length>65536)throw new Error('clipboard_text_size');result[type==='text/plain'?'text':'html']=text}else if(type==='image/png'){const bytes=new Uint8Array(await(await item.getType(type)).arrayBuffer());if(bytes.length>1048576)throw new Error('clipboard_image_size');let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));result.imagePngBase64=btoa(raw)}}return result})()`);return validateHtmlClipboard(value);
  }
  async apply(input:HtmlClipboardAction):Promise<HtmlClipboardData|undefined>{
    if(!['copy','cut','paste'].includes(input.action))throw new Error('surface_clipboard_action');
    const data=input.action==='paste'?validateHtmlClipboard(input.data!):undefined;await this.ready();if(data)await this.write(data);
    const key={copy:'c',cut:'x',paste:'v'}[input.action],code=`Key${key.toUpperCase()}`;
    // The constant native edit command follows the source renderer's real keyboard/default-action pipeline.
    await this.runtime.protocol('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:4,commands:[input.action]});
    await this.runtime.protocol('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:4});
    return input.action==='paste'?undefined:this.read();
  }
}
