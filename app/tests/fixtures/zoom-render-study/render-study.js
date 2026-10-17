const panel=document.createElement('div');
panel.dataset.canvasControl='';panel.style='position:fixed;z-index:10000;top:65px;right:12px;padding:8px;background:white;border:1px solid #888;font:12px monospace;color:#111;width:400px;height:240px;overflow:auto';
panel.innerHTML='<label>Renderer study <select id="study-mode"><option value="app">Full app</option><option value="camera">Camera DOM only</option><option value="compositor">Compositor camera</option><option value="culling">Camera + offscreen containment</option><option value="both">Compositor + containment</option><option value="app-both">Full app + compositor + containment</option></select></label> <label>Range <select id="study-range"><option value="15">Zoom in 15x</option><option value="0.25">Zoom out 4x</option></select></label> <label>Steps <select id="study-steps"><option>180</option><option>60</option></select></label> <button id="study-run">Run</button><pre id="study-result">Ready</pre>';
document.body.append(panel);
const read=()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-world')).transform);return {x:m.e,y:m.f,zoom:m.a}};
const modes=panel.querySelector('select'),result=panel.querySelector('pre'),button=panel.querySelector('button');
button.addEventListener('click',async()=>{
 const totalSteps=Number(panel.querySelector('#study-steps').value),factor=Number(panel.querySelector('#study-range').value),mode=modes.value, world=document.querySelector('.canvas-world'), board=document.querySelector('#whiteboard'), start=read(), items=[...document.querySelectorAll('.board-object')];
 if(!world||document.querySelector('.content-loading')){result.textContent='Content loading';return}
 button.disabled=true;result.textContent='Running';
 const initialStyle=world.style.cssText;
 if(mode==='compositor'||mode==='both'||mode==='app-both')world.style.willChange='transform';
 if(mode==='culling'||mode==='both'||mode==='app-both')items.forEach(item=>{item.querySelector('.object-media').style.contentVisibility='auto';});
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const frames=[],handlers=[],longFrames=[];let observer;
 if(PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) { observer=new PerformanceObserver(list=>longFrames.push(...list.getEntries().map(x=>({duration:x.duration,blocking:x.blockingDuration,renderStart:x.renderStart,styleAndLayoutStart:x.styleAndLayoutStart,startTime:x.startTime})))); observer.observe({type:'long-animation-frame'}); }
 const rect=board.getBoundingClientRect(),anchor={x:rect.width/2,y:rect.height/2};
 const origin={x:(anchor.x-start.x)/start.zoom,y:(anchor.y-start.y)/start.zoom};
 let previous,startTime,zoom=start.zoom,steps=0;
 await new Promise(resolve=>{
  function frame(time){
   if(startTime===undefined)startTime=time;if(previous!==undefined)frames.push(time-previous);previous=time;
   const nextZoom=Math.max(.05,Math.min(4,start.zoom*Math.exp(Math.sin(steps/totalSteps*Math.PI)*Math.log(factor))));
   const began=performance.now();
   if(mode==='app'||mode==='app-both') board.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,clientX:rect.x+anchor.x,clientY:rect.y+anchor.y,deltaY:-Math.log(nextZoom/zoom)/.005}));
   else world.style.transform=`translate(${anchor.x-origin.x*nextZoom}px,${anchor.y-origin.y*nextZoom}px) scale(${nextZoom})`;
   handlers.push(performance.now()-began);zoom=nextZoom;
   if(++steps<=totalSteps)requestAnimationFrame(frame);else resolve();
  }requestAnimationFrame(frame);
 });
 await new Promise(resolve=>requestAnimationFrame(resolve));observer?.disconnect();
 const percentile=(array,p)=>[...array].sort((a,b)=>a-b)[Math.floor(array.length*p)];
 const summary={mode,factor,dpr:devicePixelRatio,width:innerWidth,height:innerHeight,nodes:document.querySelectorAll('*').length,items:items.length,elapsed:previous-startTime,frames:frames.length,fps:frames.length*1000/(previous-startTime),p50:percentile(frames,.5),p95:percentile(frames,.95),over25:frames.filter(v=>v>25).length,over50:frames.filter(v=>v>50).length,handlerMs:handlers.reduce((a,b)=>a+b,0),longFrames,start,end:read()};
 result.textContent=JSON.stringify(summary,null,2);console.log('RENDER_STUDY '+JSON.stringify(summary));

 world.style.cssText=initialStyle;items.forEach(item=>item.querySelector('.object-media').style.contentVisibility='');button.disabled=false;
});
