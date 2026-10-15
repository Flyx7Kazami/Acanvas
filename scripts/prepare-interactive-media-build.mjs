import { cp, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const source = resolve(process.env.ACANVAS_PERF_SOURCE_ROOT || process.cwd());
const output = process.env.ACANVAS_PERF_BUILD_OUTPUT || await mkdtemp('/private/tmp/acanvas-interactive-media-build-');
if (process.env.ACANVAS_PERF_REF) {
  const archive = execFileSync('git', ['archive', process.env.ACANVAS_PERF_REF], { cwd:source,maxBuffer:200*1024*1024 });
  execFileSync('tar', ['-x','-C',output], { input:archive });
} else for (const path of ['app','scripts','package.json','package-lock.json']) await cp(join(source,path),join(output,path),{recursive:true});
await symlink(join(source,'node_modules'),join(output,'node_modules'));
// Locate the instrumented source inside the exported revision's own layout.
const rendererSources = [];
async function locateRenderer(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await locateRenderer(path);
    else if (entry.isFile() && path.endsWith(join('src', 'web', 'scene-renderer', 'content.tsx'))) rendererSources.push(path);
  }
}
await locateRenderer(output);
if (rendererSources.length !== 1) throw new Error(`Expected one scene renderer source in the selected revision, found ${rendererSources.length}.`);
const content = rendererSources[0], board = join(dirname(content), 'board.tsx');
const replace = async (path, before, after) => { const text=await readFile(path,'utf8'); if(!text.includes(before))throw new Error('Instrumentation location changed: '+path); await writeFile(path,text.replace(before,after)); };
await replace(content,'this.frames.set(objectId, new SceneContentFrame(document, input)); this.emit();','const started = performance.now(); this.frames.set(objectId, new SceneContentFrame(document, input)); (window as any).mediaPerf?.publish(objectId, input, { milliseconds: performance.now() - started, source: (input as any).commands ? \'commands\' : input.pixels?.constructor.name, commandCount: (input as any).commands?.length }); this.emit();');
await replace(content,'clear(objectId: string) { if','clear(objectId: string) { (window as any).mediaPerf?.clear(objectId); if');
await replace(content,'const publisher = useMemo(() => scope && ({ ...scope,','const publisher = useMemo(() => scope && ((window as any).mediaPerf?.publisher(scope.objectId), { ...scope,');
await replace(board,'const frame = renderer.current!.presented!; presentation.current = frame;','const frame = renderer.current!.presented!; (window as any).mediaPerf?.sceneCommit(scene, [...sources.keys()]); presentation.current = frame;');
const node=join(source,'.runtime/node_modules/node/bin/node');
// Its runtime script selects the revision's compiler and Vite configurations.
execFileSync(node,[join(output,'scripts/runtime.mjs'),'build'],{cwd:output,stdio:'inherit'});
console.log('BUILD_ROOT',output);
