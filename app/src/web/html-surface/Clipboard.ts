import type {HtmlClipboardAction,HtmlClipboardData} from '../../shared/html-surface';
type ClipboardEventLike=Pick<ClipboardEvent,'isTrusted'|'clipboardData'|'preventDefault'|'stopPropagation'>;
export type HtmlClipboardRequest=(action:HtmlClipboardAction)=>Promise<HtmlClipboardData|undefined>;
let currentClipboardOperation=0;
if(typeof document!=='undefined')for(const type of ['copy','cut','paste'])document.addEventListener(type,event=>{if(event.isTrusted)++currentClipboardOperation},true);

/** Only a current trusted client clipboard event authorizes local clipboard access. */
export function htmlClipboardHandlers(request:HtmlClipboardRequest,onError?:(error:unknown)=>void){
  const copy=(event:ClipboardEventLike,action:'copy'|'cut')=>{
    if(!event.isTrusted)return;event.preventDefault();event.stopPropagation();
    const operation=++currentClipboardOperation;
    void request({type:'clipboard',action}).then(async data=>{if(!data)throw new Error('The HTML clipboard result is unavailable.');if(operation!==currentClipboardOperation)return;const types:Record<string,Blob>={'text/plain':new Blob([data.text],{type:'text/plain'})};if(data.html!==undefined)types['text/html']=new Blob([data.html],{type:'text/html'});if(data.imagePngBase64!==undefined){const bytes=Uint8Array.from(atob(data.imagePngBase64),c=>c.charCodeAt(0));types['image/png']=new Blob([bytes],{type:'image/png'})}await navigator.clipboard.write([new ClipboardItem(types)])}).catch(error=>onError?.(error));
  };
  const paste=(event:ClipboardEventLike)=>{
    if(!event.isTrusted)return;event.preventDefault();event.stopPropagation();
    ++currentClipboardOperation;
    const transfer=event.clipboardData;if(!transfer)return;
    const data:HtmlClipboardData={text:transfer.getData('text/plain')},html=transfer.getData('text/html');if(html)data.html=html;
    const image=Array.from(transfer.files).find(file=>file.type==='image/png');
    void (async()=>{if(data.text.length>65_536||(data.html?.length??0)>65_536)throw new Error('The HTML clipboard text exceeds 64 KiB.');if(image){if(image.size>1_048_576)throw new Error('The HTML clipboard PNG exceeds 1 MiB.');const bytes=new Uint8Array(await image.arrayBuffer());let raw='';for(let index=0;index<bytes.length;index+=8192)raw+=String.fromCharCode(...bytes.subarray(index,index+8192));data.imagePngBase64=btoa(raw)}await request({type:'clipboard',action:'paste',data})})().catch(error=>onError?.(error));
  };
  return{onCopy:(event:ClipboardEventLike)=>copy(event,'copy'),onCut:(event:ClipboardEventLike)=>copy(event,'cut'),onPaste:paste};
}
