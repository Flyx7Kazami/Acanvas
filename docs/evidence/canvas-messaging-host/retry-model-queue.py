#!/usr/bin/env python3
"""Explicitly authorized fresh-runtime retry; single bounded actual model queue test.
Approval callbacks are held until a parent-reviewed exact decision file exists.
Only accept/decline/cancel for one callback; never session/policy amendments.
"""
import asyncio, base64, hashlib, importlib.util, json, pathlib, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
PROJECT = '/var/folders/fg/z9w29z3n0lj7cm7cw_jh8cjh0000gn/T/acanvas-messaging-queue-4JpW6E'
SESSION = '892f0bef-1666-4811-9115-180cf37010f3'
TASK = 'f9e3f5a5-6d09-47bc-99d8-2d562eb5f66c'
BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
NODE = str(REPO / '.runtime/node_modules/node/bin/node')
RUNTIME = str(REPO / 'scripts/runtime.mjs')
spec = importlib.util.spec_from_file_location('scratch_wire', HERE / 'connect-only.py')
core = importlib.util.module_from_spec(spec); spec.loader.exec_module(core)
scratch = pathlib.Path(tempfile.mkdtemp(prefix='acanvas-host-retry-'))
records = []

def emit(kind, **data):
    r = {'time': round(time.time(), 3), 'kind': kind, **data}
    records.append(r); print(json.dumps(r), flush=True)
    (HERE / 'retry-evidence.json').write_text(json.dumps(records, indent=2) + '\n')

async def cli(args):
    argv = [NODE, RUNTIME, 'cli', *args, '--project', PROJECT]
    p = await asyncio.create_subprocess_exec(*argv, cwd=str(REPO), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await p.communicate()
    try: result = json.loads(stdout)
    except ValueError: result = {'text': stdout.decode()[:1000], 'error': stderr.decode()[:1000]}
    emit('harness_cli', argv=argv, exitCode=p.returncode, result=result)
    return result

async def connect(sock, thread, label):
    r, w = await asyncio.open_unix_connection(str(sock)); key = base64.b64encode(__import__('os').urandom(16)).decode()
    w.write(('GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n').encode()); await w.drain()
    header = await r.readuntil(b'\r\n\r\n')
    assert header.startswith(b'HTTP/1.1 101')
    rpc = core.Rpc(r, w, thread, HERE / ('retry-client-'+label+'.json'))
    asyncio.create_task(rpc.read())
    await rpc.request('initialize', {'clientInfo': {'name': 'acanvas_retry_'+label, 'version': '0.1'}})
    await rpc.send(b'{"method":"initialized","params":{}}')
    return rpc

async def approval_gate(rpc):
    while True:
        message = await rpc.server_requests.get()
        request_id = message['id']
        checkpoint = {'kind':'approval_checkpoint','client':'A','requestId':request_id,'method':message.get('method'),'params':message.get('params'),'decisionFile':str(scratch / ('decision-'+str(request_id)+'.json'))}
        emit(**checkpoint)
        path = pathlib.Path(checkpoint['decisionFile'])
        while not path.exists(): await asyncio.sleep(.2)
        decision = json.loads(path.read_text())
        assert decision.get('requestId') == request_id
        assert decision.get('decision') in ('accept','decline','cancel')
        assert message.get('method') == 'item/commandExecution/requestApproval'
        emit('parent_reviewed_individual_approval_response', requestId=request_id, decision=decision['decision'])
        await rpc.send(json.dumps({'id':request_id,'result':{'decision':decision['decision']}}).encode())

async def main():
    owner = None; clients = []; url = None
    try:
        opened = await cli(['project','open','--session',SESSION,'--port','0'])
        url = opened.get('url') or opened.get('serverUrl')
        if not url:
            url = opened.get('openUrl','').split('?')[0].rstrip('/')
        assert url.startswith('http://127.0.0.1:')
        sock = scratch / 'owner.sock'
        owner = await asyncio.create_subprocess_exec(BIN,'app-server','--listen','unix://'+str(sock),cwd=str(scratch),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
        emit('fresh_owner_started',pid=owner.pid,scratch=str(scratch),socket=str(sock),configOverrides=False)
        for _ in range(100):
            if sock.exists(): break
            await asyncio.sleep(.1)
        a = await connect(sock,'','A'); clients.append(a)
        started = await a.request('thread/start',{'cwd':str(scratch),'ephemeral':True,'serviceName':'acanvas-explicit-retry'})
        result = started['result']; thread = result['thread']['id']; a.thread = thread
        emit('runtime_checkpoint',pid=owner.pid,threadId=thread,model=result.get('model'),approvalPolicy=result.get('approvalPolicy'),approvalsReviewer=result.get('approvalsReviewer'),sandbox=result.get('sandbox'),oldThreadId='01a13116-8b09-7410-a3cc-c637e5383c99',sameAsOriginalThread=False)
        b = await connect(sock,thread,'B'); clients.append(b)
        loaded = await b.request('thread/loaded/list',{}); assert thread in loaded['result']['data']
        # An explicit binding conflict is evidence; no database edit or force rebind.
        binding = await cli(['project','open','--session',SESSION,'--host','codex','--thread',thread,'--url',url])
        if not binding.get('sessionId'):
            emit('binding_conflict_or_failure',result=binding)
            return
        completion = scratch / 'completion.json'
        completion.write_text(json.dumps({'summary':'Acknowledged the owned scratch queue request through actual model-driven Canvas CLI.','assetIds':[],'validation':['Task requirement was read; one progress acknowledgment recorded.'],'operations':[]})+'\n')
        asyncio.create_task(approval_gate(a))
        prompt = f'''This is an authorized bounded acanvas scratch experiment. Use actual command tools, within 120 seconds. No other projects, external jobs, messages to people, private logs, databases, settings, or app controls. Your runtime is a new experimental thread, not the previous ephemeral runtime.
The explicitly bound scratch project is {PROJECT}; session {SESSION}; service {url}; queued task {TASK}. Execute the already-built CLI using command tools with workdir {REPO}: {NODE} {RUNTIME} cli <command> --project {PROJECT} --session {SESSION} --url {url}.
1. Call task next with no --consumer to allocate a fresh activation. Retain returned run ID and consumer ID. Confirm claimed task ID is {TASK}.
2. Call task read --task {TASK} and read its requirementText and history.
3. Call task progress --task {TASK} --run RETURNED_RUN --consumer RETURNED_CONSUMER --message "Actual model read the scratch request and acknowledges it."
4. Call task complete --task {TASK} --run RETURNED_RUN --consumer RETURNED_CONSUMER --input {completion}.
5. Call task next using that same consumer to release idle, then read task once to verify the completed receipt.
The completion file is precreated. Do not create other files. Preserve the inherited sandbox and approval settings. If localhost CLI is sandbox-blocked, request normal individual command approval; never change settings or claim success before tool receipts. Reply ACANVAS_QUEUE_MODEL_OK with task ID and receipt only after completion; otherwise report exact failure.'''
        await b.request('turn/start',{'threadId':thread,'clientUserMessageId':'acanvas-retry-model-queue-1','input':[{'type':'text','text':prompt}]})
        completed = await asyncio.wait_for(a.completed.get(),180)
        emit('model_turn_finished',threadId=thread,turn=completed)
        final = await cli(['task','read','--session',SESSION,'--task',TASK,'--url',url])
        emit('post_model_task_state',task=final.get('task'))
    except Exception as error:
        emit('retry_blocked_or_failed',errorType=type(error).__name__,message=str(error))
    finally:
        for c in clients:
            try: await c.send(b'',8); c.writer.close(); await c.writer.wait_closed()
            except Exception: pass
        if owner and owner.returncode is None:
            owner.terminate()
            try: await asyncio.wait_for(owner.wait(),5)
            except asyncio.TimeoutError: owner.kill(); await owner.wait()
            emit('owned_runtime_stopped',pid=owner.pid,exitCode=owner.returncode)
        if url:
            stopped = await cli(['project','stop','--session',SESSION,'--url',url])
            emit('owned_queue_service_stopped',status=stopped.get('status'))
        emit('scratch_preserved',path=str(scratch))

asyncio.run(main())
