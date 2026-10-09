import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {CanvasService} from './src/server/service.js';
import {ProjectHtmlSurfaces} from './src/server/render-surface/html.js';
import {NativeHtmlRuntime} from './src/server/render-surface/cef.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{resolve,promise}};
async function fixture(t,options={}){
 const root=await mkdtemp('/private/tmp/acanvas-independent-lifecycle-'),service=new CanvasService(root),session=service.createSession('Independent');
 const id=randomUUID(),path=`assets/${id}.html`,source='<!doctype html><input>';await writeFile(join(service.dataDir,path),source);service.registerAsset({id,name:'Owned.html',kind:'file',mime:'text/html',size:source.length,createdAt:new Date().toISOString()},path);
 const object=service.boardOperations(session.id,[{type:'create',object:{assetId:id,x:0,y:0,width:100,height:60}}]).objects[0];
 const releases=new Set(),revokes=new Set(),opens=[],closes=[];
 const manager=new ProjectHtmlSurfaces(service,{issue:()=>{const id=randomUUID();return{id,url:'http://localhost:1/'+id,origin:'http://localhost:1',expiresAt:new Date().toISOString()}},hold:id=>()=>releases.add(id),revoke:id=>revokes.add(id)},options);
 t.mock.method(manager,'start',async()=>{manager.origin='http://localhost:1'});
 t.mock.method(NativeHtmlRuntime.prototype,'open',async function(){const gate=deferred();opens.push({runtime:this,gate});await gate.promise});
 t.mock.method(NativeHtmlRuntime.prototype,'directory',()=>root);t.mock.method(NativeHtmlRuntime.prototype,'close',async function(){closes.push(this)});
 const create=(viewId=randomUUID())=>manager.create({sessionId:session.id,documentId:randomUUID(),viewId,viewGeneration:1,objectId:object.id,assetId:id},{width:100,height:60});
 t.after(async()=>{for(const item of opens)item.gate.resolve();await manager.close();service.close();await rm(root,{recursive:true,force:true})});
 const until=async condition=>{for(let i=0;i<1000&&!condition();i++)await new Promise(resolve=>setImmediate(resolve));assert(condition())};
 return{manager,create,opens,closes,releases,revokes,until};
}
test('independent: evicting a closed opening entry keeps its owned runtime in shutdown drain',async t=>{
 const f=await fixture(t,{maxRetainedSurfaces:1}),view=randomUUID(),first=f.create(view),rejectedFirst=assert.rejects(first,e=>e.code==='surface_closed');await f.until(()=>f.opens.length===1);const removed=[...f.manager.entries.values()][0];await f.manager.closeView(view);
 const second=f.create(),rejectedSecond=assert.rejects(second,e=>e.code==='surface_closed');await f.until(()=>f.opens.length===2);assert(!f.manager.entries.has(removed.info.surfaceId));assert.equal(f.manager.creating.size,2);
 let finished=false;const closing=f.manager.close().then(()=>finished=true);await new Promise(resolve=>setImmediate(resolve));assert(!finished);for(const item of f.opens)item.gate.resolve();await Promise.all([closing,rejectedFirst,rejectedSecond]);assert.equal(new Set(f.closes).size,2);assert.equal(f.releases.size,2);assert.equal(f.revokes.size,2);assert.equal(f.manager.creating.size,0);assert.equal(f.manager.entries.size,0);
});
test('independent: per-entry input and sample chains serialize without serializing another entry',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create();await f.until(()=>f.opens.length===2);for(const item of f.opens)item.gate.resolve();const [ia,ib]=await Promise.all([a,b]),ea=f.manager.entries.get(ia.surfaceId),eb=f.manager.entries.get(ib.surfaceId),gate=deferred(),events=[];
 const first=f.manager.serial(ea,async()=>{events.push('a-start');await gate.promise;events.push('a-end')});const second=f.manager.serial(ea,async()=>events.push('a-second'));await f.manager.serial(eb,async()=>events.push('b'));
 assert.deepEqual(events,['a-start','b']);gate.resolve();await Promise.all([first,second]);assert.deepEqual(events,['a-start','b','a-end','a-second']);
});
test('independent: shutdown rejects new admission and preserves original resource ceilings',async t=>{
 const f=await fixture(t);await f.manager.close();await assert.rejects(f.create(),e=>e.code==='surface_closed'||e.code==='surface_stopped');assert.equal(f.opens.length,0);assert.equal(f.manager.entries.size,0);assert.equal(f.manager.creating.size,0);
});
