import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const workspace=resolve('.'), source=process.env.ACANVAS_AUDIO_FIXTURES || '/private/tmp/acanvas-audio-redesign-20261005';
const root=await mkdtemp(join(tmpdir(),'acanvas-selected-a-'));
const tracks=[{id:'first',key:'i-see-you',ext:'m4a',mime:'audio/mp4',name:'cr3sh & KYPT - All Nighter Vol. 8 - 08 I SEE YOU.m4a'},{id:'second',key:'nests-fractures',ext:'mp3',mime:'audio/mpeg',name:'adri - All Nighter Vol. 7 - 24 nests&Fractures.mp3'}];
const api=async(req,res,next)=>{
 if(req.url==='/api/bootstrap'){res.setHeader('content-type','application/json');res.end('{}');return;}
 if(req.url?.startsWith('/api/state?')){res.setHeader('content-type','application/json');res.end(JSON.stringify({assets:tracks}));return;}
 const m=req.url?.match(/^\/api\/assets\/(first|second)\/(content|artwork)$/);if(!m)return next();
 const t=tracks.find(t=>t.id===m[1]);const file=join(source,m[2]==='artwork'?`${t.key}-cover-0.jpg`:`${t.key}.${t.ext}`);const size=(await stat(file)).size;
 res.setHeader('content-type',m[2]==='artwork'?'image/jpeg':t.mime);res.setHeader('accept-ranges','bytes');
 const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;
 if(range){res.statusCode=206;res.setHeader('content-range',`bytes ${start}-${end}/${size}`);}res.setHeader('content-length',end-start+1);if(req.method==='HEAD')res.end();else createReadStream(file,{start,end}).pipe(res);
};
const server=await createServer({configFile:false,plugins:[{name:'fixture-api',configureServer(server){server.middlewares.use(api)}}],root,resolve:{alias:{react:resolve('node_modules/react'),'react-dom':resolve('node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,workspace]}}});
await writeFile(join(root,'index.html'),`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/entry.ts"></script></body></html>`);
await writeFile(join(root,'entry.ts'),`import '/@fs/${workspace}/src/web/AudioReview.tsx';`);
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:900,height:900}});
page.setDefaultTimeout(15000);page.on('pageerror',e=>console.log('pageerror',e.message));const results=[];try{
 await server.listen();await page.addInitScript(()=>localStorage.setItem('acanvas-theme','dark'));console.log('fixture',server.resolvedUrls.local[0]);await page.goto(server.resolvedUrls.local[0]+'?session=isolated',{waitUntil:'domcontentloaded'});console.log('loaded');
 const player=page.locator('.audio-canvas-player'),wave=player.locator('canvas');
 for(const t of tracks){
  console.log('track',t.id);await page.getByRole('combobox',{name:'Audio file'}).selectOption(t.id);console.log('selected');
  await page.waitForFunction(()=>document.querySelector('.audio-player-waveform canvas')?.dataset.ready==='true'&&document.querySelector('.audio-player-cover')?.naturalWidth>0);
  console.log('ready');const cover=await player.locator('img').evaluate(i=>({src:i.src,width:i.naturalWidth,height:i.naturalHeight}));
  const actual=await page.request.get(cover.src);if(!Buffer.from(await actual.body()).equals(await readFile(join(source,`${t.key}-cover-0.jpg`))))throw Error('Cover byte mismatch');
  for(const theme of ['dark','light']){
   await page.evaluate(theme=>{localStorage.setItem('acanvas-theme',theme);dispatchEvent(new StorageEvent('storage',{key:'acanvas-theme',newValue:theme}));},theme);
   for(const [name,w,h,layout] of [['compact',520,88,'compact'],['wide',740,220,'beside'],['wide-boundary',524,150,'beside'],['square',420,420,'stack'],['tall',320,480,'stack']]){
    await page.locator('.audio-review-player').evaluate((e,[w,h])=>{e.style.width=w+'px';e.style.height=h+'px'},[w,h]);
    await page.waitForFunction(layout=>document.querySelector('.audio-canvas-player')?.dataset.layout===layout,layout);
    const geometry=await player.evaluate(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height,background:getComputedStyle(e).backgroundColor,radius:getComputedStyle(e).borderRadius,within:[...e.querySelectorAll('.audio-player-cover,.audio-player-heading,.audio-player-play,.audio-player-waveform,.audio-player-clock')].every(c=>{const b=c.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom})}});
    const coverFits=await player.locator('.audio-player-art').evaluate(e=>{const a=e.getBoundingClientRect(),b=e.querySelector('.audio-player-cover').getBoundingClientRect();return b.left>=a.left-.1&&b.right<=a.right+.1&&b.top>=a.top-.1&&b.bottom<=a.bottom+.1});
    if(!coverFits||!geometry.within||geometry.width!==w||geometry.height!==h)throw Error('Layout overflow '+JSON.stringify(geometry));
    if(geometry.background!==(theme==='dark'?'rgb(41, 41, 41)':'rgb(245, 245, 245)'))throw Error('Theme mismatch');
    results.push({track:t.id,theme,shape:name,...geometry});
    if(t.id==='first')await player.screenshot({path:join(root,`${theme}-${name}.png`)});
   }
  }
  await player.getByRole('button',{name:'Play audio',exact:true}).click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>.15);
  const slider=player.getByRole('slider');await slider.press('PageUp');if(await player.locator('audio').evaluate(a=>a.currentTime)<12)throw Error('Keyboard seek failed');
  const b=await slider.boundingBox();await page.mouse.move(b.x+b.width*.2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*.65,b.y+b.height/2);await page.mouse.up();
  const playback=await player.locator('audio').evaluate(a=>({paused:a.paused,fraction:a.currentTime/a.duration}));if(playback.paused||Math.abs(playback.fraction-.65)>.02)throw Error('Scrub resume failed');
  await player.getByRole('button',{name:'Pause audio',exact:true}).click();results.push({track:t.id,coverBytesMatch:true,coverWidth:cover.width,coverHeight:cover.height,playback});
 }
 await writeFile(join(root,'results.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({checks:results.length,output:root,passed:true}));
}catch(e){console.error(e);await page.screenshot({path:join(root,'failure.png')});throw e}finally{await browser.close();await server.close()}
