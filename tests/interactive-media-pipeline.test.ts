import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('audio cached commands match full panel raster and copied drawing sources retain exportable frame ownership', { skip:process.env.ACANVAS_INTERACTIVE_MEDIA_TESTS !== '1',timeout:120_000 },async t=>{
  const { createServer }=await import('vite'),{ chromium }=await import('playwright-core');
  const audio=await readFile('tests/fixtures/amplitude-cover.mp3');
  const server=await createServer({configFile:false,appType:'mpa',root:process.cwd(),esbuild:{jsx:'automatic'},plugins:[{name:'owned-audio',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/lab/audio/'))return next();if(request.url.startsWith('/lab/audio/broken')){response.writeHead(404);response.end();return;}if(request.url.startsWith('/lab/audio/artwork')){response.writeHead(204);response.end();return;}const range=request.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=range?Number(range[1]):0,end=range?.[2]?Math.min(audio.length-1,Number(range[2])):audio.length-1;response.writeHead(range?206:200,{'Content-Type':'audio/mpeg','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${audio.length}`}:{})});response.end(request.method==='HEAD'?undefined:audio.subarray(start,end+1));});}}],server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.runtime/**']}},logLevel:'error'});
  await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:1000},deviceScaleFactor:2});
  page.setDefaultTimeout(10_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]+'tests/fixtures/universal-media/index.html?kind=audio');
  await page.waitForFunction(()=>!(document.querySelector('.audio-player-play') as HTMLButtonElement)?.disabled&&(window as any).mediaLab?.metadata()?.media);
  const comparisons:unknown[]=[];
  const output=process.env.ACANVAS_INTERACTIVE_MEDIA_QA_OUTPUT||await mkdtemp('/private/tmp/acanvas-interactive-media-qa-');
  async function compare(name:string){
    await page.waitForTimeout(350);
    const result=await page.evaluate(async()=>{
      const {paintControlledPanel}=await import('/src/web/scene-renderer/media/controlled-panel.ts' as string),{SceneContentFrame}=await import('/src/web/scene-renderer/texture.ts' as string);
      const root=document.querySelector('.audio-canvas-player') as HTMLElement,full=paintControlledPanel(root,{gpu:true}),frame=new SceneContentFrame(document,full),canvas=document.createElement('canvas');canvas.width=full.bitmap.width;canvas.height=full.bitmap.height;const context=canvas.getContext('2d')!;context.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--surface');context.fillRect(0,0,canvas.width,canvas.height);frame.draw(context,{x:0,y:0,width:canvas.width,height:canvas.height});
      const expected=context.getImageData(0,0,canvas.width,canvas.height).data,captured=await (window as any).mediaLab.capture(),actual=captured.rgba;
      let changed=0,max=0,total=0,left=Infinity,top=Infinity,right=0,bottom=0;const rows:Record<string,number>={};for(let i=0;i<expected.length;i++){const difference=Math.abs(expected[i]-actual[i]);if(difference){changed++;max=Math.max(max,difference);total+=difference;const x=Math.floor(i/4)%canvas.width,y=Math.floor(i/4/canvas.width);left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);rows[Math.floor(y/16)]=(rows[Math.floor(y/16)]||0)+1;}}
      return{changed,max,total,channels:expected.length,bounds:{left,top,right,bottom},rows,bitmap:full.bitmap,metadata:(window as any).mediaLab.metadata(),actualPNG:captured.png,expectedPNG:[...new Uint8Array(await(await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!)))).arrayBuffer())]};
    });const{actualPNG,expectedPNG,...facts}=result;comparisons.push({name,...facts});await writeFile(join(output,name+'-actual.png'),Buffer.from(actualPNG));await writeFile(join(output,name+'-expected.png'),Buffer.from(expectedPNG));await writeFile(join(output,'comparison-checkpoint.json'),JSON.stringify({comparisons},null,2));assert.equal(result.changed,0,name+' pixels');
  }
  await compare('ready');
  await page.getByRole('button',{name:'Play audio',exact:true}).click();await page.waitForFunction(()=>document.querySelector('audio')!.currentTime>1.1);await page.getByRole('button',{name:'Pause audio',exact:true}).click();await compare('second-change-pause');
  await page.evaluate(async()=>{
    const {SceneContentRegistry}=await import('/src/web/scene-renderer/content.tsx' as string),publish=SceneContentRegistry.prototype.publish;(window as any).seekingPublishes=[];
    SceneContentRegistry.prototype.publish=function(objectId:string,input:any){const audio=document.querySelector('audio')!;if(audio.seeking)(window as any).seekingPublishes.push({currentTime:audio.currentTime,media:input.media});return publish.call(this,objectId,input);};
    document.querySelector('audio')!.currentTime=2.5;
  });await page.waitForFunction(()=>Math.abs((window as any).mediaLab.metadata().media.playbackTime-2.5)<.01).catch(async error=>{const state=await page.evaluate(()=>{const audio=document.querySelector('audio')!;return{time:audio.currentTime,seeking:audio.seeking,paused:audio.paused,readyState:audio.readyState,metadata:(window as any).mediaLab.metadata()};});await writeFile(join(output,'seek-failure.json'),JSON.stringify(state,null,2));throw error;});
  const seekingPublishes=await page.evaluate(()=>(window as any).seekingPublishes);assert.ok(seekingPublishes.some((frame:any)=>frame.currentTime===2.5&&frame.media?.playbackTime===2.5));await writeFile(join(output,'seeking-publication.json'),JSON.stringify(seekingPublishes,null,2));await compare('seek');
  await page.hover('.audio-player-play');await compare('hover');
  await page.locator('.audio-player-waveform').focus();await compare('focus');
  await page.evaluate(()=>document.querySelector('.audio-player-waveform')!.setAttribute('aria-disabled','true'));await compare('disabled-opacity');
  await page.evaluate(()=>{document.querySelector('.audio-player-waveform')!.setAttribute('aria-disabled','false');(document.querySelector('.audio-player-waveform canvas') as HTMLElement).style.visibility='hidden';});await compare('dynamic-hidden');
  await page.evaluate(()=>{(document.querySelector('.audio-player-waveform canvas') as HTMLElement).style.visibility='visible';const wave=document.querySelector('.audio-player-waveform') as HTMLElement;wave.style.overflow='hidden';wave.style.borderRadius='8px';(wave.querySelector('canvas') as HTMLElement).style.transform='translateX(-8px)';});await compare('ancestor-clip');
  await page.evaluate(()=>{const wave=document.querySelector('.audio-player-waveform') as HTMLElement;wave.style.overflow='';wave.style.borderRadius='';(wave.querySelector('canvas') as HTMLElement).style.transform='';const range=document.createRange();range.setStart(document.querySelector('.audio-player-heading strong')!.firstChild!,1);range.setEnd(document.querySelector('.audio-player-clock>span')!.firstChild!,2);getSelection()!.removeAllRanges();getSelection()!.addRange(range);});await compare('cross-node-selection');
  await page.evaluate(()=>{getSelection()!.removeAllRanges();const message=document.createElement('span');message.className='audio-wave-status';message.textContent='Waveform unavailable';document.querySelector('.audio-player-waveform')!.append(message);});await compare('ordered-foreground');
  await page.evaluate(()=>document.querySelector('.audio-wave-status')!.remove());
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await compare('dark');
  await page.evaluate(()=>(window as any).mediaLab.resize(224,280));await page.waitForFunction(()=>(window as any).mediaLab.metadata().cssSize.width===224);await compare('stack');
  await page.evaluate(()=>{document.body.style.zoom='1.25';(document.querySelector('.tile') as HTMLElement).style.transform='scale(.8)';});await compare('transformed');
  await page.evaluate(()=>{document.querySelector('audio')!.src='/lab/audio/broken';});await page.waitForFunction(()=>!!document.querySelector('audio')!.error);await compare('native-media-error');
  const ownership=await page.evaluate(async()=>{
    const {SceneContentFrame}=await import('/src/web/scene-renderer/texture.ts' as string);
    const base=document.createElement('canvas'),overlay=document.createElement('canvas');base.width=base.height=32;overlay.width=overlay.height=8;
    base.getContext('2d')!.fillStyle='red';base.getContext('2d')!.fillRect(0,0,32,32);overlay.getContext('2d')!.fillStyle='blue';overlay.getContext('2d')!.fillRect(0,0,8,8);
    const input={pixels:base,bitmap:{width:32,height:32},commands:[{op:'call' as const,method:'drawImage' as const,args:[overlay,8,8,8,8]}],media:{playbackTime:1,presentedTime:1,timePrecision:'playback-sampled' as const}},frame=new SceneContentFrame(document,input),output=document.createElement('canvas');output.width=output.height=32;
    const rgba=()=>{frame.draw(output.getContext('2d')!,{x:0,y:0,width:32,height:32});return[...output.getContext('2d')!.getImageData(0,0,32,32).data];},before=rgba();base.getContext('2d')!.fillStyle='green';base.getContext('2d')!.fillRect(0,0,32,32);overlay.getContext('2d')!.fillStyle='yellow';overlay.getContext('2d')!.fillRect(0,0,8,8);input.media.presentedTime=2;const stable=JSON.stringify(before)===JSON.stringify(rgba())&&frame.metadata.media.presentedTime===1;
    const image=new Image();const url=new URL('/tests/fixtures/universal-scene/texture.svg',location.href);url.hostname='localhost';image.src=url.href;await image.decode();let rejected=false;try{new SceneContentFrame(document,{pixels:base,bitmap:{width:32,height:32},commands:[{op:'call',method:'drawImage',args:[image,0,0,32,32]}]});}catch(error){rejected=error instanceof DOMException&&error.name==='SecurityError';}
    const guarded:Record<string,boolean>={},callback=()=>{throw new Error('The source callback ran.');};
    for(const [name,commands] of Object.entries({nonfinite:[{op:'call',method:'translate',args:[NaN,0]}],callback:[{op:'call',method:'callback',args:[callback]}],sourceCallback:[{op:'call',method:'drawImage',args:[callback,0,0]}],contextProperty:[{op:'set',property:'canvas',value:base}]})){
      try{new SceneContentFrame(document,{bitmap:{width:32,height:32},commands});guarded[name]=false;}catch(error){guarded[name]=error instanceof TypeError;}
    }
    const path=new Path2D();path.rect(0,0,8,8);const pathFrame=new SceneContentFrame(document,{bitmap:{width:32,height:32},commands:[{op:'set',property:'fillStyle',value:'blue'},{op:'call',method:'fill',args:[path]}]});output.getContext('2d')!.clearRect(0,0,32,32);pathFrame.draw(output.getContext('2d')!,{x:0,y:0,width:32,height:32});const pathBefore=[...output.getContext('2d')!.getImageData(0,0,32,32).data];path.rect(16,16,8,8);output.getContext('2d')!.clearRect(0,0,32,32);pathFrame.draw(output.getContext('2d')!,{x:0,y:0,width:32,height:32});const pathStable=JSON.stringify(pathBefore)===JSON.stringify([...output.getContext('2d')!.getImageData(0,0,32,32).data]);
    return{stable,rejected,guarded,pathStable,forgedFrameRejected:!SceneContentFrame.isCopiedTexture({metadata:frame.metadata,draw(){}})};
  });assert.equal(ownership.stable,true);assert.equal(ownership.rejected,true);assert.equal(ownership.pathStable,true);assert.equal(ownership.forgedFrameRejected,true);assert.ok(Object.values(ownership.guarded).every(Boolean));assert.deepEqual(errors,[]);
  await writeFile(join(output,'composition.json'),JSON.stringify({comparisons,ownership,errors},null,2));
});
