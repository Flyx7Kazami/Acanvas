export interface HtmlSemanticControl {
  id:string;tag:string;type:string;role:string;label:string;value?:string;checked?:boolean;disabled:boolean;readOnly:boolean;
  bounds:{x:number;y:number;width:number;height:number};options?:Array<{value:string;label:string;disabled:boolean;selected:boolean}>;
  selection?:{start:number;end:number;direction:'forward'|'backward'|'none'};focused:boolean;multiple?:boolean;accept?:string;
  min?:string;max?:string;step?:string;tabIndex:number;
}
export interface HtmlReadingItem {id:string;role:string;text:string;level?:number;bounds:{x:number;y:number;width:number;height:number}}
export interface HtmlSemanticSnapshot {controls:HtmlSemanticControl[];readingOrder:HtmlReadingItem[];selection:string;scroll:{x:number;y:number};viewport:{width:number;height:number};activeElementId?:string;title:string;omittedControls:number;omittedText:number}
export interface HtmlSurfacePopup {frameSeq:number;bounds:{x:number;y:number;width:number;height:number}}
export interface SelectedHtmlFile {name:string;mime:string;bytesBase64:string;lastModified:number}
export type HtmlControlInput=
  | {type:'focus';controlId:string}
  | {type:'composition';action:'update'|'commit'|'cancel';text:string;selectionStart?:number;selectionEnd?:number}
  | {type:'control';controlId:string;value:string|string[]}
  | {type:'text-selection';controlId:string;start:number;end:number;direction?:'forward'|'backward'|'none'}
  | {type:'files';controlId:string;files:SelectedHtmlFile[]};
export interface HtmlPcmPacket {audioSeq:number;channels:number;sampleRate:number;frames:number;pts:number;pcmBase64:string}
export interface HtmlPcmBatch {surfaceId:string;instanceId:string;clock:'engine-monotonic-ms';packets:HtmlPcmPacket[]}
export interface HtmlClipboardData {text:string;html?:string;imagePngBase64?:string}
export type HtmlClipboardAction={type:'clipboard';action:'copy'|'cut'|'paste';data?:HtmlClipboardData};
export interface HtmlInputResult {inputSeq:number;clipboard?:HtmlClipboardData;clipboardError?:string}
export const htmlFileRequestBytes=8_388_608;
export const htmlInputRequestBytes=12_582_912;
