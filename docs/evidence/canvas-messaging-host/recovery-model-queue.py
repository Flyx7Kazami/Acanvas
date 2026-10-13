#!/usr/bin/env python3
"""Explicitly authorized fresh-runtime retry; single bounded actual model queue test.
Approval callbacks are held until a parent-reviewed exact decision file exists.
Only accept/decline/cancel for one callback; never session/policy amendments.
"""
import asyncio, base64, hashlib, importlib.util, json, pathlib, tempfile, time, shlex

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
scratch = pathlib.Path(tempfile.mkdtemp(prefix='acanvas-host-recovery-'))
records = []

def emit(kind, **data):
    r = {'time': round(time.time(), 3), 'kind': kind, **data}
    records.append(r); print(json.dumps(r), flush=True)
    (HERE / 'recovery-evidence.json').write_text(json.dumps(records, indent=2) + '\n')

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
    rpc = core.Rpc(r, w, thread, HERE / ('recovery-client-'+label+'.json'))
    asyncio.create_task(rpc.read())
    await rpc.request('initialize', {'clientInfo': {'name': 'acanvas_recovery_'+label, 'version': '0.1'}})
    await rpc.send(b'{"method":"initialized","params":{}}')
    return rpc

async def approval_gate(rpc, known, completion_hash, clock):
    while True:
        message = await rpc.server_requests.get()
        started = time.monotonic(); clock['waitingStarted'] = started
        request_id = message['id']; params = message.get('params') or {}
        emit('individual_approval_request',requestId=request_id,method=message.get('method'),params=params)
        try:
            assert message.get('method') == 'item/commandExecution/requestApproval'
            outer = shlex.split(params['command']); assert len(outer)==3 and outer[:2]==['/bin/zsh','-lc']
            assert not any(token in outer[2] for token in ['&&','||',';','>','<','`','$('])
            argv=shlex.split(outer[2]); assert argv[:4]==[NODE,RUNTIME,'cli','task']
            op=argv[4]; assert op in ['read','progress','complete','next']
            fields=argv[5:]; assert len(fields)%2==0
            flags=dict(zip(fields[::2],fields[1::2]));assert len(flags)*2==len(fields)
            assert params.get('cwd')==str(REPO)
            assert all(k in known and v==known[k] for k,v in flags.items())
            required={'read':['--task'],'progress':['--task','--run','--consumer','--message'],'complete':['--task','--run','--consumer','--input'],'next':['--consumer']}[op]
            assert all(flags.get(k)==known[k] for k in required+['--project','--session','--url'])
            if op=='complete':
                raw=pathlib.Path(known['--input']).read_bytes(); assert hashlib.sha256(raw).hexdigest()==completion_hash
                body=json.loads(raw);assert body['assetIds']==[] and body['operations']==[]
            decision='accept'
            emit('individual_authorized_command_validated',requestId=request_id,exactCommand=params['command'],decision=decision,policyAmendment=False)
        except Exception as error:
            path=scratch / ('unexpected-decision-'+str(request_id)+'.json')
            emit('unexpected_approval_checkpoint',requestId=request_id,reason=str(error),decisionFile=str(path))
            while not path.exists():await asyncio.sleep(.2)
            body=json.loads(path.read_text());assert body.get('requestId')==request_id and body.get('decision') in ['accept','decline','cancel']
            decision=body['decision']
        await rpc.send(json.dumps({'id':request_id,'result':{'decision':decision}}).encode())
        clock['approvalWait'] += time.monotonic()-started;clock['waitingStarted']=None
        emit('individual_approval_response',requestId=request_id,decision=decision,noPolicyChange=True)

async def bounded_completion(rpc, clock):
    waiter=asyncio.create_task(rpc.completed.get());started=time.monotonic()
    while not waiter.done():
        wall=time.monotonic()-started
        pending=time.monotonic()-clock['waitingStarted'] if clock['waitingStarted'] else 0
        active=wall-clock['approvalWait']-pending
        if active>=240 or wall>=300:
            waiter.cancel();raise TimeoutError(f'Active model budget exceeded: active={active:.1f}s wall={wall:.1f}s')
        await asyncio.wait([waiter],timeout=.5)
    return waiter.result()

async def main():
    owner = None; clients = []; url = None
    try:
        opened = await cli(['project','open','--session',SESSION,'--port','0'])
        url = opened.get('url') or opened.get('serverUrl')
        if not url:
            url = opened.get('openUrl','').split('?')[0].rstrip('/')
        assert url.startswith('http://127.0.0.1:')
        prior=await cli(['task','read','--session',SESSION,'--task',TASK,'--url',url])
        saved=prior['task']; assert saved['status']=='interrupted' and saved['currentRunId']=='8b40b11d-d49a-4ccf-8012-840eb8e935dd'
        assert saved['receipt'] is None and all(not run['outputAssetIds'] and not run['progress'] for run in saved['runs'])
        recovered=await cli(['task','resume','--session',SESSION,'--task',TASK,'--expected-run',saved['currentRunId'],'--resolution','Reviewed bounded model experiment timeout: prior run only claimed and read; no external jobs, outputs, progress or receipt. Preserve history and continue scratch textual acknowledgment.','--url',url])
        current=recovered['run'];run=current['id'];consumer=recovered['consumerId']
        emit('public_task_recovered',oldRun=saved['currentRunId'],runId=run,consumerId=consumer,historyPreserved=True)
        sock = scratch / 'owner.sock'
        owner = await asyncio.create_subprocess_exec(BIN,'app-server','--listen','unix://'+str(sock),cwd=str(scratch),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
        emit('third_fresh_owner_started',pid=owner.pid,scratch=str(scratch),socket=str(sock),configOverrides=False)
        for _ in range(100):
            if sock.exists(): break
            await asyncio.sleep(.1)
        a = await connect(sock,'','A'); clients.append(a)
        started = await a.request('thread/start',{'cwd':str(scratch),'ephemeral':True,'serviceName':'acanvas-explicit-recovery'})
        result = started['result']; thread = result['thread']['id']; a.thread = thread
        emit('third_runtime_checkpoint',pid=owner.pid,threadId=thread,model=result.get('model'),approvalPolicy=result.get('approvalPolicy'),approvalsReviewer=result.get('approvalsReviewer'),sandbox=result.get('sandbox'),priorThreadIds=['01a13116-8b09-7410-a3cc-c637e5383c99','01a13126-62f1-7343-a504-ab8a5ab9bf6a'],priorThreadsResumed=False)
        b = await connect(sock,thread,'B'); clients.append(b)
        loaded = await b.request('thread/loaded/list',{}); assert thread in loaded['result']['data']
        await a.request('turn/start',{'threadId':thread,'clientUserMessageId':'acanvas-recovery-ready-1','input':[{'type':'text','text':'Isolated scratch host experiment. Reply exactly ACANVAS_RECOVERY_READY. Do not use tools or read files.'}]})
        await asyncio.wait_for(a.completed.get(),60)
        emit('same_live_thread_ready_turn_completed',threadId=thread,ownerPid=owner.pid)
        # An explicit binding conflict is evidence; no database edit or force rebind.
        binding = await cli(['project','open','--session',SESSION,'--host','codex','--thread',thread,'--url',url])
        if not binding.get('sessionId'):
            emit('binding_conflict_or_failure',result=binding)
            return
        completion = scratch / 'completion.json'
        completion.write_text(json.dumps({'summary':'Acknowledged the recovered owned scratch queue request through actual model-driven Canvas CLI.','assetIds':[],'validation':['Task requirement was read; one progress acknowledgment recorded.'],'operations':[]})+'\n')
        known={'--project':PROJECT,'--session':SESSION,'--url':url,'--task':TASK,'--run':run,'--consumer':consumer,'--message':'Actual model read the recovered scratch request and acknowledges it.','--input':str(completion)}
        clock={'approvalWait':0,'waitingStarted':None}
        asyncio.create_task(approval_gate(a,known,hashlib.sha256(completion.read_bytes()).hexdigest(),clock))
        prompt=f"""Continue this same live experimental thread by processing its explicitly bound acanvas scratch task through actual command tools. The prior experiment ended after claim/read without external jobs, outputs, progress or receipt. The public task resume has preserved that history and assigned run {run}, consumer {consumer}.
+Project {PROJECT}; session {SESSION}; exact service {url}; task {TASK}. These scratch operations are explicitly user-authorized. Preserve inherited permissions. Request individual normal command approval for localhost CLI if necessary; do not change policies. Use workdir {REPO} and command {NODE} {RUNTIME} cli <command> --project {PROJECT} --session {SESSION} --url {url}.
+1. Actual task read --task {TASK}; inspect requirementText and saved run history.
+2. Actual task progress --task {TASK} --run {run} --consumer {consumer} --message \"Actual model read the recovered scratch request and acknowledges it.\".
+3. Actual task complete --task {TASK} --run {run} --consumer {consumer} --input {completion}. That owned precreated JSON is a textual receipt with no assets or canvas operations.
+4. Actual task next --consumer {consumer} to release idle. Actual task read --task {TASK} to confirm receipt.
+Only these exact CLI commands; no shell chains, redirects, created files, settings, other projects, external jobs, app controls or person-directed messages. Use the existing run/consumer, not a new claim. Reply ACANVAS_QUEUE_MODEL_OK with the task ID and completed receipt after actual success. If a command fails, preserve exact error and request the normal individual approval for this exact command. This followup is from Client B on the same live owner and ready thread; older ephemeral threads are not restored."""
        await b.request('turn/start',{'threadId':thread,'clientUserMessageId':'acanvas-recovery-model-queue-1','input':[{'type':'text','text':prompt}]})
        completed = await bounded_completion(a,clock)
        emit('model_turn_finished',threadId=thread,turn=completed)
        final = await cli(['task','read','--session',SESSION,'--task',TASK,'--url',url])
        emit('post_model_task_state',task=final.get('task'))
    except Exception as error:
        emit('recovery_blocked_or_failed',errorType=type(error).__name__,message=str(error))
        if url:
            final=await cli(['task','read','--session',SESSION,'--task',TASK,'--url',url]);emit('actual_receipt_after_failure_or_timeout',task=final.get('task'))
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
