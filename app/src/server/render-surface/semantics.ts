import type {HtmlSemanticControl,HtmlReadingItem,HtmlSemanticSnapshot} from '../../shared/html-surface.js';
export type {HtmlSemanticControl,HtmlReadingItem,HtmlSemanticSnapshot} from '../../shared/html-surface.js';

/** Reads in an isolated world; the source document's JavaScript remains intact. */
export function readHtmlSemantics():HtmlSemanticSnapshot{
  const controlSelector='input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"])';
  const roles:Record<string,string>={button:'button',select:'combobox',textarea:'textbox',a:'link'};
  function path(element:Element):string{
    if(element.id){const selector=`#${CSS.escape(element.id)}`;if(document.querySelectorAll(selector).length===1)return selector}
    const parts:string[]=[];let current:Element|null=element;
    while(current&&current!==document.documentElement){const tag=current.localName;let index=1;for(let sibling=current.previousElementSibling;sibling;sibling=sibling.previousElementSibling)if(sibling.localName===tag)index++;parts.unshift(`${tag}:nth-of-type(${index})`);current=current.parentElement}return parts.join('>');
  }
  function visible(element:Element,rect=element.getBoundingClientRect()){const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth&&style.display!=='none'&&style.visibility==='visible'&&!element.closest('[hidden],[inert],[aria-hidden="true"]')}
  const bounds=(rect:DOMRect)=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
  function labelText(label:HTMLLabelElement|undefined){if(!label)return '';const texts:string[]=[],walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())if(!node.parentElement?.closest('input,textarea,select,button,[contenteditable]'))texts.push(node.textContent??'');return texts.join(' ').trim()}
  const all=Array.from(document.querySelectorAll<HTMLElement>(controlSelector)).filter(element=>visible(element));
  const controls:HtmlSemanticControl[]=all.slice(0,256).map(element=>{
    const input=element as HTMLInputElement,tag=element.localName,type=tag==='input'?input.type:element.isContentEditable?'contenteditable':tag;
    const labelled=(element.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim();
    const label=(element.getAttribute('aria-label')||labelled||labelText(input.labels?.[0])||element.getAttribute('title')||element.getAttribute('placeholder')||element.textContent||type).trim().slice(0,1000);
    const value=type==='password'?undefined:tag==='input'||tag==='textarea'||tag==='select'?input.value:element.isContentEditable?element.textContent??'':undefined;
    const direction=input.selectionDirection;
    let selection=typeof input.selectionStart==='number'&&typeof input.selectionEnd==='number'?{start:input.selectionStart,end:input.selectionEnd,direction:(direction==='backward'||direction==='forward'?direction:'none') as 'forward'|'backward'|'none'}:undefined;
    if(element.isContentEditable){const current=getSelection();if(current?.anchorNode&&current.focusNode&&element.contains(current.anchorNode)&&element.contains(current.focusNode)){const offset=(node:Node,position:number)=>{const range=document.createRange();range.setStart(element,0);range.setEnd(node,position);return range.toString().length},anchor=offset(current.anchorNode,current.anchorOffset),focus=offset(current.focusNode,current.focusOffset);selection={start:Math.min(anchor,focus),end:Math.max(anchor,focus),direction:anchor>focus?'backward':anchor<focus?'forward':'none'}}}
    return {id:path(element),tag,type,role:element.getAttribute('role')||(roles[tag]??(['checkbox','radio'].includes(type)?type:'textbox')),label,value:value?.slice(0,65_536),checked:['checkbox','radio'].includes(type)?input.checked:undefined,disabled:!!input.disabled,readOnly:!!input.readOnly,bounds:bounds(element.getBoundingClientRect()),focused:document.activeElement===element,selection,tabIndex:element.tabIndex,min:input.min,max:input.max,step:input.step,...(tag==='input'?{multiple:input.multiple,accept:input.accept}:{}),...(tag==='select'?{multiple:(element as HTMLSelectElement).multiple,options:Array.from((element as HTMLSelectElement).options).slice(0,256).map(option=>({value:option.value,label:option.label,disabled:option.disabled||(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled),selected:option.selected}))}:{})};
  });
  const controlsById=new Map(controls.map(control=>[control.id,control])),readingOrder:HtmlReadingItem[]=[];
  let omittedText=0,visited=0;
  const walker=document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    if(++visited>16_384){omittedText++;break}
    const element=node instanceof Element?node:node.parentElement;if(!element)continue;
    if(element.parentElement?.closest(`${controlSelector},h1,h2,h3,h4,h5,h6`))continue;
    if(node instanceof Element){
      const control=controlsById.get(path(element));if(control){if(readingOrder.length<512)readingOrder.push({id:control.id,role:control.role,text:control.label,bounds:control.bounds});else omittedText++;continue}
      if(!/^h[1-6]$/.test(element.localName)||!visible(element))continue;
      const text=(element.textContent??'').trim().slice(0,1000);if(text){if(readingOrder.length<512)readingOrder.push({id:path(element),role:'heading',level:Number(element.localName[1]),text,bounds:bounds(element.getBoundingClientRect())});else omittedText++}continue;
    }
    if(element.matches(`${controlSelector},h1,h2,h3,h4,h5,h6`))continue;
    const text=(node.textContent??'').trim().slice(0,1000);if(!text||!visible(element))continue;
    const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();if(!visible(element,rect))continue;
    if(readingOrder.length<512){const index=Array.from(element.childNodes).indexOf(node as ChildNode);readingOrder.push({id:`${path(element)}::text(${index})`,role:'text',text,bounds:bounds(rect)})}else omittedText++;
  }
  const active=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
  return {controls,readingOrder,selection:(getSelection()?.toString()??'').slice(0,65_536),scroll:{x:scrollX,y:scrollY},viewport:{width:innerWidth,height:innerHeight},activeElementId:active&&controls.find(control=>control.id===path(active))?.id,title:document.title.slice(0,1000),omittedControls:Math.max(0,all.length-controls.length),omittedText};
}
