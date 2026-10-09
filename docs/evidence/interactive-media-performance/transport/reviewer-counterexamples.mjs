import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {WebSocket as RealSocket} from 'ws';
const build=process.env.ACANVAS_CONNECTION_REVIEW_BUILD;if(!build)throw new Error('Set ACANVAS_CONNECTION_REVIEW_BUILD to a private compiled tree with node_modules symlink.');
const {startServer}=await import(build+'/src/server/http.js');
const {createBoardConnections}=await import(build+'/src/server/board-connection.js');
const {BoardConnection,BoardConnectionError}=await import(build+'/src/web/board-connection.js');
const {boardConnectionMessage,boardConnectionRequest}=await import(build+'/src/shared/board-connection.js');
const view={projectId:'owned-project',sessionId:'owned-session',documentId:'owned-document',viewId:'owned-view',viewGeneration:1};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await pause(5);}assert.fail('condition timed out');};
class MockSocket extends EventTarget{
 static OPEN=1;static instances=[];readyState=0;sent=[];
 constructor(url){super();this.url=url;MockSocket.instances.push(this);}
 send(raw){assert.equal(this.readyState,1);this.sent.push(JSON.parse(raw));}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
 open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
 message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
}
const withMock=async fn=>{const previous={WebSocket:globalThis.WebSocket,window:globalThis.window};Object.assign(globalThis,{WebSocket:MockSocket,window:{location:{href:'http://127.0.0.1:1234/?session=owned'}}});MockSocket.instances=[];try{await fn();}finally{Object.assign(globalThis,previous);}};
test('strict bounded request/response schemas reject excess keys, unsafe ids and identity/string boundaries',()=>{
 for(const id of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'1',null]){assert.equal(boardConnectionRequest({type:'events',id}),undefined);assert.equal(boardConnectionMessage({type:'change',id}),undefined);}
 for(const candidate of [{...view,projectId:''},{...view,viewId:'x'.repeat(201)},{...view,viewGeneration:1.1},{...view,viewGeneration:0},{...view,extra:true}])assert.equal(boardConnectionRequest({type:'watch-view',id:1,view:candidate}),undefined);
 for(const value of [{type:'ready',id:1,instanceId:'x'.repeat(201)},{type:'error',id:1,status:399,code:'x'},{type:'error',id:1,status:600,code:'x'},{type:'error',id:1,status:409,code:'x'.repeat(101)},{type:'change',id:1,extra:true}])assert.equal(boardConnectionMessage(value),undefined);
 assert(boardConnectionRequest({type:'events',id:Number.MAX_SAFE_INTEGER}));assert(boardConnectionMessage({type:'view-ready',id:1,view}));
});
test('asynchronous error then close rejects every owner once; late old-socket events cannot close a replacement',()=>withMock(async()=>{
 const connection=new BoardConnection('owned-instance');let ready=0;
 const a=connection.watchEvents(new AbortController().signal,()=>ready++,()=>{}),b=connection.watchView(view,new AbortController().signal,()=>ready++);
 const rejected=Promise.all([assert.rejects(a,BoardConnectionError),assert.rejects(b,BoardConnectionError)]),old=MockSocket.instances[0];old.open();
 queueMicrotask(()=>old.dispatchEvent(new Event('error')));await rejected;assert.equal(old.readyState,3);
 const controller=new AbortController(),next=connection.watchView(view,controller.signal,()=>ready++),replacement=MockSocket.instances[1];replacement.open();
 old.message({type:'view-ready',id:3,view});old.dispatchEvent(new Event('error'));old.dispatchEvent(new Event('close'));assert.equal(replacement.readyState,1);assert.equal(ready,0);
 replacement.message({type:'view-ready',id:3,view});assert.equal(ready,1);controller.abort();await next;assert.equal(replacement.readyState,3);
}));
test('abort last CONNECTING owner closes only that transport; already-aborted request starts no socket',()=>withMock(async()=>{
 const connection=new BoardConnection('owned-instance'),c=new AbortController();const p=connection.watchView(view,c.signal,()=>assert.fail('canceled ready'));const old=MockSocket.instances[0];c.abort();await p;assert.equal(old.readyState,3);
 old.open();assert.equal(old.sent.length,0);await connection.watchView(view,c.signal,()=>assert.fail('aborted ready'));assert.equal(MockSocket.instances.length,1);
 const nextController=new AbortController(),next=connection.watchEvents(nextController.signal,()=>{},()=>{});const replacement=MockSocket.instances[1];replacement.open();assert.equal(replacement.sent.length,1);connection.close();await assert.rejects(next,BoardConnectionError);assert.equal(replacement.readyState,3);
}));
test('explicit development origin is accepted; cross-site and null origins remain rejected, including when configured',async t=>{
 const root=await mkdtemp('/private/tmp/acanvas-dev-origin-review-');const server=await startServer({root,port:0,allowedOrigins:['http://127.0.0.1:5173','null']});let socket;t.after(async()=>{socket?.terminate();await server.close();await rm(root,{recursive:true,force:true});});
 const response=await fetch(server.url+'/api/bootstrap'),cookie=response.headers.get('set-cookie').split(';')[0];await response.json();
 const attempt=async(origin,extra={})=>{const ws=new RealSocket(server.url.replace('http:','ws:')+'/api/connection',{headers:{Cookie:cookie,Origin:origin,...extra}});ws.on('error',()=>{});return await new Promise(resolve=>{ws.once('open',()=>{ws.terminate();resolve(101);});ws.once('unexpected-response',(_,response)=>{const status=response.statusCode;response.destroy();ws.terminate();resolve(status);});});};
 assert.equal(await attempt('http://127.0.0.1:5173'),101);assert.equal(await attempt('http://127.0.0.1:5173',{'Sec-Fetch-Site':'cross-site'}),403);assert.equal(await attempt('null'),403);
});
test('ping timeout retires exact owners, explicit view end removes its subscription, shutdown clears heartbeat and sockets',async t=>{
 const server=createServer();let tick,cleared=false;const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;
 globalThis.setInterval=fn=>{tick=fn;return{unref(){}};};globalThis.clearInterval=id=>{cleared=true;};
 let watchEnded=0,owner;const connections=createBoardConnections(server,{instanceId:'owned-instance',guard(){},watch(view,connection){owner=connection;return()=>watchEnded++;}});globalThis.setInterval=originalSet;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const socket=new RealSocket('ws://127.0.0.1:'+port+'/api/connection',{autoPong:false}),messages=[];socket.on('message',raw=>messages.push(JSON.parse(raw)));socket.on('error',()=>{});await new Promise(resolve=>socket.once('open',resolve));
 t.after(async()=>{globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear;socket.terminate();connections.close();await new Promise(resolve=>server.close(resolve));});
 socket.send(JSON.stringify({type:'watch-view',id:1,view}));await until(()=>messages.some(m=>m.type==='view-ready'));owner.end();await until(()=>messages.some(m=>m.type==='error'));assert.equal(watchEnded,1);
 socket.send(JSON.stringify({type:'watch-view',id:2,view}));await until(()=>messages.some(m=>m.id===2));tick();await pause(10);tick();await new Promise(resolve=>socket.once('close',resolve));await until(()=>watchEnded===2);assert.equal(watchEnded,2);
 connections.close();assert.equal(cleared,true);globalThis.clearInterval=originalClear;
});
