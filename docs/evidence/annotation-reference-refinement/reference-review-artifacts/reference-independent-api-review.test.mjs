import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server/http.js';
import { referenceParts } from '../src/shared/task-message.js';
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-reference-occurrences-'));
    let running = await startServer({ root, port: 0 });
    let token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token;
    t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    const call = async (path, method = 'GET', body, expected = 200) => {
        const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const value = await response.json();
        assert.equal(response.status, expected, JSON.stringify(value));
        return value;
    };
    const session = await call('/api/sessions', 'POST', { name: 'Repeated references' }, 201);
    const cli = async (args) => {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'dist/src/cli.js'), ...args, '--project', root, '--url', running.url, '--session', session.id]);
        assert.equal(stderr, '');
        return stdout;
    };
    const save = (draft) => call(`/api/sessions/${session.id}/draft`, 'PUT', draft);
    const draft = async () => (await call(`/api/state?sessionId=${session.id}`)).draft;
    const send = (value) => call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: value.id, expectedRevision: value.revision });
    const asset = await (await fetch(`${running.url}/api/assets?name=Repeated.png&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'private fixture pixels' })).json();
    await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'repeated-object', assetId: asset.id, x: 50, y: 80, width: 100, height: 60 } }] });
    return { root, session, asset, call, cli, save, draft, send, async restart() { await running.close(); running = await startServer({ root, port: 0 }); token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token; } };
}

test('independent same raw ID across object and task kinds preserves occurrences and strips local host metadata',async t=>{
 const f=await fixture(t);
 const prior=(await f.send(await f.save({...await f.draft(),text:'Prior'}))).task;
 await f.call('/api/board/operations','POST',{sessionId:f.session.id,operations:[{type:'create',object:{id:prior.id,assetId:f.asset.id,x:3,y:5,width:40,height:30}}]});
 const order=[{kind:'task',id:prior.id,textOffset:0,hostKey:'reference-local',occurrenceId:'local-only'},{kind:'object',id:prior.id,textOffset:0},{kind:'object',id:prior.id,textOffset:3},{kind:'task',id:prior.id,textOffset:3}];
 const expected=order.map(({kind,id,textOffset})=>({kind,id,textOffset}));
 const value=await f.save({...await f.draft(),text:'A😀',references:{objectIds:[prior.id],taskIds:[prior.id],order}});
 assert.deepEqual(value.references,{objectIds:[prior.id],taskIds:[prior.id],order:expected});
 const sent=await f.send(value);
 assert.deepEqual(sent.task.snapshot.requestReferences.order.map(({kind,id,textOffset})=>({kind,id,textOffset})),expected);
 assert.deepEqual(sent.task.snapshot.referenceContent.taskIds,[prior.id]);assert.equal(sent.task.snapshot.referenceContent.objects.length,1);assert.equal(sent.task.snapshot.referenceContent.assets.length,1);
 assert.equal(JSON.stringify(sent.task.snapshot).includes('reference-local'),false);assert.equal(JSON.stringify(sent.task.snapshot).includes('local-only'),false);
});

test('independent repeated forbidden task and stale revision retain the entire draft atomically',async t=>{
 const f=await fixture(t),id='repeated-object';
 const b=await f.call('/api/sessions','POST',{name:'Other session'},201);
 let other=(await f.call(`/api/state?sessionId=${b.id}`)).draft;
 other=await f.call(`/api/sessions/${b.id}/draft`,'PUT',{...other,text:'Other'});
 const foreign=(await f.call(`/api/sessions/${b.id}/tasks`,'POST',{draftId:other.id,expectedRevision:other.revision})).task;
 const before=await f.save({...await f.draft(),text:'A😀B',references:{objectIds:[id],taskIds:[],order:[{kind:'object',id,textOffset:1},{kind:'object',id,textOffset:3}]}});
 const forbidden=await f.call(`/api/sessions/${f.session.id}/draft`,'PUT',{...before,text:'Different',references:{objectIds:[id],taskIds:[foreign.id],order:[{kind:'object',id,textOffset:0},{kind:'task',id:foreign.id,textOffset:0},{kind:'task',id:foreign.id,textOffset:0}]}},403);
 assert.equal(forbidden.error.code,'task_reference_scope');assert.deepEqual(await f.draft(),before);
 const stale=await f.call(`/api/sessions/${f.session.id}/draft`,'PUT',{...before,revision:before.revision-1,text:'Stale',references:{objectIds:[id],taskIds:[],order:[{kind:'object',id,textOffset:0},{kind:'object',id,textOffset:0},{kind:'object',id,textOffset:0}]}},409);
 assert.equal(stale.error.code,'draft_revision_conflict');assert.deepEqual(await f.draft(),before);
});
