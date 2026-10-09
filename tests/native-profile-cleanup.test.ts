import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cleanNativeProfiles,nativeSurfaceExecutable} from '../src/server/render-surface/cef.js';

test('native profile recovery removes owned inactive records and preserves active or unknown material',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'acanvas-profile-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const record=async(name:string,value:object|undefined)=>{const path=join(directory,name);await mkdir(path,{mode:0o700});await writeFile(join(path,'owned-fixture.txt'),'fixture');if(value)await writeFile(join(path,'acanvas-instance.json'),JSON.stringify(value),{mode:0o600});return path};
  const removed=await record('instance-expired',{controllerPid:999_999_999,executable:nativeSurfaceExecutable});
  const active=await record('instance-current',{controllerPid:process.pid,executable:nativeSurfaceExecutable});
  const browserActive=await record('instance-browser',{controllerPid:999_999_999,browserPid:process.pid,executable:nativeSurfaceExecutable});
  const unknown=await record('instance-unknown',undefined);
  const unrelated=await record('instance-other',{controllerPid:999_999_999,executable:'/Applications/User.app/Contents/MacOS/User'});
  const outside=await mkdtemp(join(tmpdir(),'acanvas-profile-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'fixture.txt'),'outside');await symlink(outside,join(directory,'instance-linked'));
  await cleanNativeProfiles(directory);
  await assert.rejects(readFile(join(removed,'owned-fixture.txt')),{code:'ENOENT'});
  for(const path of [active,browserActive,unknown,unrelated])assert.equal(await readFile(join(path,'owned-fixture.txt'),'utf8'),'fixture');
  assert.equal(await readFile(join(outside,'fixture.txt'),'utf8'),'outside');
});
