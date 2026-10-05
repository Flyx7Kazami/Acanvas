import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const dir=path.dirname(fileURLToPath(import.meta.url));
const output=process.env.AUDIO_OPTIONS_OUTPUT || await fs.mkdtemp(path.join(tmpdir(),'acanvas-audio-options-')); 
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:740,height:650}});
const failures=[];const results=[];
for(const option of ['a','b','c']){
 await page.goto('file://'+path.join(dir,`option-${option}.html`));
 for(const {width,height} of [{width:740,height:600}]){
  await page.setViewportSize({width,height});
  for(const track of ['0','1'])for(const theme of ['Light','Dark'])for(const shape of ['Compact','Wide','Square','Tall','Fill']){
   await page.locator('#track').selectOption(track);
   await page.getByRole('button',{name:theme,exact:true}).click();
   await page.getByRole('button',{name:shape,exact:true}).click();
   await page.waitForTimeout(35);
   const evidence=await page.evaluate(()=>{
    const p=document.querySelector('.player'),r=p.getBoundingClientRect();
    const nodes=[...p.querySelectorAll('.panel,.meta,.wave,.transport,.play,.times,.track-title,.artist')].filter(e=>getComputedStyle(e).display!=='none');
    const outside=nodes.filter(e=>{const b=e.getBoundingClientRect();return b.left<r.left-.5||b.right>r.right+.5||b.top<r.top-.5||b.bottom>r.bottom+.5}).map(e=>e.className);
    const images=[...document.querySelectorAll('.cover')].filter(e=>e.getBoundingClientRect().width>0);return {outside,images:images.every(i=>i.complete&&i.naturalWidth>0),layout:p.dataset.layout,width:r.width,height:r.height,scroll:document.documentElement.scrollWidth>innerWidth};
   });
   const record={option,viewportWidth:width,viewportHeight:height,track,theme,shape,...evidence};results.push(record);if(evidence.outside.length||!evidence.images||evidence.scroll)failures.push(record);
   if(option==='a'&&track==='0'&&theme==='Dark'&&shape==='Compact')await page.locator('.player').screenshot({path:path.join(output,'rounded-compact.png')});
   if(width===740&&track==='0'&&(['Wide','Tall','Compact','Square'].includes(shape)))await page.screenshot({path:path.join(output,`${option}-${theme}-${shape}.png`)});
  }
 }
 await page.getByRole('button',{name:'Choose '+option.toUpperCase(),exact:true}).click();
 await page.getByRole('button',{name:'Light',exact:true}).click();
 if(await page.locator('.choose').getAttribute('aria-pressed')!=='true')failures.push({option,choiceLost:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('#position').fill('500');
 await page.locator('#position').focus();
 await page.keyboard.press('ArrowRight');
 if(await page.locator('#position').inputValue()!=='501')failures.push({option,keyboardSeekFailed:true});
 if(!((await page.locator('.current').textContent())!=='0:00'))failures.push({option,seekFailed:true});
}
await fs.writeFile(path.join(output,'results.json'),JSON.stringify({checks:results.length,failures,results},null,2));
console.log(JSON.stringify({checks:results.length,failures,output},null,2));await browser.close();if(failures.length)process.exitCode=1;
