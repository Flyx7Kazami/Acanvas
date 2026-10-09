test('independent media layout stays usable under CSS zoom and short viewport', { timeout: 90000 }, async t => {
  const app = await fixture(t, true), { page } = app;
  const media = await app.importAsset('Review.mp3', 'audio/mpeg', await readFile(resolve('tests/fixtures/reference-tone.mp3')));
  const object = await app.object(media, { x: 40, y: 350, width: 240, height: 180 });
  await page.locator(`[data-object-id="${object.id}"] audio`).evaluate(async audio => {
    if (!Number.isFinite(audio.duration)) await new Promise(resolve => audio.addEventListener('loadedmetadata', resolve, { once:true }));
  });
  const facts = [];
  for (const [zoom, height] of [[1.25,700],[0.8,700],[1,480]]) {
    await page.setViewportSize({width:320,height});
    await page.evaluate(zoom => {document.body.style.zoom=String(zoom);}, zoom);
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const bounds = await page.locator(`[data-object-id="${object.id}"]`).boundingBox();
    await app.mark({x:Math.min(270,bounds.x+bounds.width/2),y:Math.min(height-120,bounds.y+bounds.height/2)});
    const input = page.getByRole('textbox',{name:'Add a comment',exact:true});
    await input.fill('Chinese text 评论与音频。\n'.repeat(50));
    await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready','true');
    await page.locator('.annotation-full').evaluate(async element => {await Promise.all(element.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
    const geometry = await page.locator('.annotation-full').evaluate(element => {
      const rect=s=>{const r=element.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
      const text=rect('.annotation-fulltext'),media=rect('.annotation-media-control'),footer=rect('.annotation-footer'),done=rect('.annotation-done');
      return {text,media,footer,done,doneHit:document.elementFromPoint(done.x+done.width/2,done.y+done.height/2)?.closest('button')===element.querySelector('.annotation-done')};
    });
    facts.push({zoom,height,...geometry});
    await page.screenshot({path:join(app.evidence,`independent-media-${zoom}-${height}.png`)});
    assert(geometry.text.height>=64*zoom-0.1,JSON.stringify(geometry));
    assert(geometry.text.bottom<=geometry.media.y+0.1,JSON.stringify(geometry));
    assert(geometry.media.bottom<=geometry.footer.y+0.1,JSON.stringify(geometry));
    assert(geometry.done.right<=320+0.1 && geometry.done.bottom<=height+0.1 && geometry.doneHit,JSON.stringify(geometry));
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state','complete');
  }
  await writeFile(join(app.evidence,'independent-media-geometry.json'),JSON.stringify(facts,null,2));
});

test('independent same ID redraw takes the new marker and target on immediate Done', async t => {
  const app=await fixture(t), {page}=app;
  const asset=await app.image('Retarget.png'),first=await app.object(asset),second=await app.object(asset,{x:800,y:300,width:300,height:180});
  await app.mark({x:520,y:360});
  const original=await app.done('Preserved comment');
  await page.locator('.draft-annotation .annotation-content').click();
  await page.getByRole('button',{name:'Redraw mark',exact:true}).click();
  await page.mouse.click(950,380);
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state','complete');
  const saved=(await app.saved()).annotations[0];
  assert.equal(saved.id,original.id);assert.equal(saved.objectId,second.id);assert.equal(saved.text,original.text);assert(saved.captureState.version>original.captureState.version);
  assert.equal(saved.capture.target.objectId,second.id);assert.notEqual(saved.capture.id,original.capture.id);
  assert.equal(saved.capture.scene.objects.find(e=>e.object.id===second.id).object.x,800);
  await assertSceneCopy(page,saved);
  await writeFile(join(app.evidence,'independent-retarget.json'),JSON.stringify({annotationId:saved.id,first:first.id,second:second.id,version:saved.captureState.version,target:saved.capture.target,frameSeq:saved.capture.presentation.frameSeq},null,2));
});

test('independent expanded comment stays reachable when its page is resized under CSS zoom', async t => {
  const app=await fixture(t),{page}=app;
  await page.setViewportSize({width:1200,height:850});
  await page.addStyleTag({content:'.app-shell{zoom:1.25}'});
  await app.mark({x:200,y:300});
  await page.getByRole('textbox',{name:'Add a comment',exact:true}).fill('Keep this open while resizing.');
  await page.locator('.annotation-full').evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  await page.setViewportSize({width:320,height:700});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await page.locator('.annotation-full').evaluate(element=>{const r=element.getBoundingClientRect(),d=element.querySelector('.annotation-done').getBoundingClientRect();return{note:{x:r.x,y:r.y,width:r.width,height:r.height},done:{x:d.x,y:d.y,width:d.width,height:d.height,right:d.right,bottom:d.bottom},hit:document.elementFromPoint(d.x+d.width/2,d.y+d.height/2)?.closest('button')===element.querySelector('.annotation-done')};});
  await page.screenshot({path:join(app.evidence,'independent-open-resize.png')});
  await writeFile(join(app.evidence,'independent-open-resize.json'),JSON.stringify(geometry,null,2));
  assert(geometry.done.right<=320+0.1 && geometry.done.bottom<=700+0.1 && geometry.hit,JSON.stringify(geometry));
});

test('independent real copy failure preserves text and recovers through another Done', async t => {
  const app=await fixture(t),{page}=app;
  await page.evaluate(()=>{
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    window.reviewBlockCopy=true;
    CanvasRenderingContext2D.prototype.drawImage=function(...args){if(window.reviewBlockCopy && args[0] instanceof HTMLCanvasElement && args[0].classList.contains('scene-canvas') && args.length===9 && this.canvas!==args[0]){window.reviewBlockCopy=false;throw new Error('Review temporary copy unavailable');}return draw.apply(this,args);};
  });
  await app.mark({x:900,y:400});
  await page.getByRole('textbox',{name:'Add a comment',exact:true}).fill('Retained through unavailable display copy.');
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state','saved');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-capturing','true');
  const failed=(await app.saved()).annotations[0];
  assert.equal(failed.text,'Retained through unavailable display copy.');assert.equal(failed.captureState.status,'incomplete');assert.equal(failed.capture,undefined);assert.equal(failed.sceneSource,undefined);
  await expect(page.getByRole('button',{name:'Send request',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state','complete');
  const recovered=(await app.saved()).annotations[0];assert.equal(recovered.text,failed.text);await assertSceneCopy(page,recovered);
  await writeFile(join(app.evidence,'independent-copy-failure.json'),JSON.stringify({failed:{text:failed.text,status:failed.captureState.status,sceneSource:failed.sceneSource},recovered:{status:recovered.captureState.status,frameSeq:recovered.capture.presentation.frameSeq}},null,2));
});

test('independent collapsed region comments keep their text inside the padded surface at CSS zoom', async t => {
  const app=await fixture(t,true),{page}=app;
  await page.setViewportSize({width:320,height:1000});
  await page.addStyleTag({content:'.app-shell{zoom:1.25}'});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await app.mark({x:2,y:200},{x:90,y:240});
  const saved=await app.done('A readable very long summary for a narrow visible canvas.');
  const note=page.locator(`.canvas-annotation-comment[data-annotation-id="${saved.id}"]`);
  await note.evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await note.evaluate(element=>{const r=element.getBoundingClientRect(),s=element.querySelector('.canvas-annotation-summary').getBoundingClientRect(),st=getComputedStyle(element);return {surface:{x:r.x,y:r.y,width:r.width,right:r.right},text:{x:s.x,width:s.width,right:s.right},paddingRight:Number.parseFloat(st.paddingRight),scale:r.width/element.offsetWidth};});
  await page.screenshot({path:join(app.evidence,'independent-collapsed-region-zoom.png')});
  await writeFile(join(app.evidence,'independent-collapsed-region-zoom.json'),JSON.stringify(geometry,null,2));
  assert(geometry.text.right<=geometry.surface.right-geometry.paddingRight*geometry.scale+0.5,JSON.stringify(geometry));
});
