import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const source = resolve(process.env.ACANVAS_PERF_SOURCE_ROOT || process.cwd());
const output = process.env.ACANVAS_PERF_BUILD_OUTPUT || await mkdtemp('/private/tmp/acanvas-interactive-media-build-');
if (process.env.ACANVAS_PERF_REF) {
  const archive = execFileSync('git', ['archive', process.env.ACANVAS_PERF_REF], { cwd:source,maxBuffer:200*1024*1024 });
  execFileSync('tar', ['-x','-C',output], { input:archive });
} else for (const path of ['src','tests','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts']) await cp(join(source,path),join(output,path),{recursive:true});
await symlink(join(source,'node_modules'),join(output,'node_modules'));
const replace = async (path, before, after) => { const target=join(output,path),text=await readFile(target,'utf8'); if(!text.includes(before))throw new Error('Instrumentation location changed: '+path); await writeFile(target,text.replace(before,after)); };
await replace('src/web/scene-renderer/content.tsx','this.frames.set(objectId, new SceneContentFrame(document, input)); this.emit();','const started = performance.now(); this.frames.set(objectId, new SceneContentFrame(document, input)); (window as any).mediaPerf?.publish(objectId, input, { milliseconds: performance.now() - started, source: (input as any).commands ? \'commands\' : input.pixels?.constructor.name, commandCount: (input as any).commands?.length }); this.emit();');
await replace('src/web/scene-renderer/content.tsx','clear(objectId: string) { if','clear(objectId: string) { (window as any).mediaPerf?.clear(objectId); if');
await replace('src/web/scene-renderer/content.tsx','const publisher = useMemo(() => scope && ({ ...scope,','const publisher = useMemo(() => scope && ((window as any).mediaPerf?.publisher(scope.objectId), { ...scope,');
await replace('src/web/scene-renderer/board.tsx','const frame = renderer.current!.presented!; presentation.current = frame;','const frame = renderer.current!.presented!; (window as any).mediaPerf?.sceneCommit(scene, [...sources.keys()]); presentation.current = frame;');
const node=join(source,'.runtime/node_modules/node/bin/node');
execFileSync(node,[join(source,'node_modules/typescript/bin/tsc'),'-p','tsconfig.server.json'],{cwd:output,stdio:'inherit'});
execFileSync(node,[join(source,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:output,stdio:'inherit'});
execFileSync(node,[join(source,'node_modules/vite/bin/vite.js'),'build'],{cwd:output,stdio:'inherit'});
console.log('BUILD_ROOT',output);
