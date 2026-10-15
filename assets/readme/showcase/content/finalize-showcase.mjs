import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const content=dirname(fileURLToPath(import.meta.url)), installation=resolve(content,'../../../..');
const base=JSON.parse(await readFile(join(process.argv[2],'demo-base.json'),'utf8'));
const {project,session}=base, run=promisify(execFile);
const command=async(...args)=>JSON.parse((await run(process.execPath,[join(installation,'scripts/acanvas.mjs'),...args,'--project',project,'--session',session],{cwd:installation})).stdout);
const input=async(name,value)=>{const path=join(project,name);await writeFile(path,JSON.stringify(value));return path;};
const layout={wordmark:[0,35,310,93],bloom:[0,145,310,465],signal:[0,645,187,120],echo:[370,60,215,215],drift:[370,330,450,300],direction:[370,630,220,135],next:[610,60,210,140],ticket:[610,238,210,65],brief:[850,500,330,250],activity:[850,50,330,411],afterimage:[1208,55,350,125],smallhours:[1208,220,350,125],listening:[1208,390,225,130],lineup:[1450,390,150,190],palette:[1450,650,140,82]};
const files=['bloom','echo','drift','bloom-blue-study','echo-blue-study','drift-blue-study'];
for(const [index,key] of files.entries()){
 const file=join(content,'../art',key+'.png');const asset=await command('asset','import','--file',file,'--allow-directory',resolve(content,'../art'));
 const [x,y,width,height]=layout[key]||[1208+(index-3)*250,550,220,220];
 await command('board','operations','--input',await input('art-create.json',{operations:[{type:'create',object:{assetId:asset.id,x,y,width,height}}]}));
 base.objects.push({key,file:'../art/'+key+'.png',assetId:asset.id,mime:'image/png',x,y,width,height,hidden:key.includes('blue-study')});
}
let state=await command('session','read');
base.objects.forEach(o=>Object.assign(o,state.objects.find(row=>row.assetId===o.assetId)));
const moves=base.objects.filter(o=>layout[o.key]).map(o=>{const[x,y,width,height]=layout[o.key];return{type:'update',objectId:o.id,expectedVersion:o.version,changes:{x,y,width,height}};});
await command('board','operations','--input',await input('layout.json',{operations:moves}));
state=await command('session','read');
base.objects.forEach(o=>Object.assign(o,state.objects.find(row=>row.assetId===o.assetId)));
for(const [name,keys] of [['Colour studies',['echo','drift','next','ticket']],['Image studies',['bloom-blue-study','echo-blue-study','drift-blue-study']]]){
 const members=base.objects.filter(o=>keys.includes(o.key));
 await command('board','operations','--input',await input('group.json',{operations:[{type:'group.create',group:{name,color:'cobalt',objectIds:members.map(o=>o.id)},expectedVersions:Object.fromEntries(members.map(o=>[o.id,o.version]))}]}));
}
state=await command('session','read');
const folder=state.groups.find(g=>g.name==='Image studies');
await command('board','operations','--input',await input('folder.json',{operations:[{type:'group.update',groupId:folder.id,expectedVersion:folder.version,changes:{mode:'folder',x:1208,y:500}}]}));
const requests=[
 {text:'Make a 15-second motion study from the bloom.',image:'bloom.png',keys:['bloom'],detail:'Keep the grain, let the petals drift slowly, and leave the title still.'},
 {text:'Try a softer transition between the sonic sketches.',image:'echo.png',keys:['afterimage','smallhours'],detail:'Bring Afterimage into Small hours with a longer tail and a little more space.'},
 {text:'Explore the chrome studies for the evening programme.',image:'echo-blue-study.png',group:true,detail:'Use the Image studies group as the starting point for a second programme direction.'}
];
for(const r of requests){state=await command('session','read');const draft={...state.draft,text:r.text,attachments:[],annotations:[],references:{objectIds:base.objects.filter(o=>r.keys?.includes(o.key)).map(o=>o.id),taskIds:[],groupIds:r.group?[folder.id]:[]}};const saved=await command('draft','save','--input',await input('request.json',draft));await command('draft','send','--draft',saved.id,'--revision',String(saved.revision));}
state=await command('session','read');const draft={...state.draft,text:'Turn this direction into a moving poster.',references:{objectIds:[base.objects.find(o=>o.key==='bloom').id],taskIds:[],groupIds:[folder.id]}};await command('draft','save','--input',await input('draft.json',draft));
await command('view','save','--input',await input('view.json',{x:70,y:76,zoom:.55,selectedObjectIds:[]}));
state=await command('session','read');base.objects.forEach(o=>Object.assign(o,state.objects.find(row=>row.assetId===o.assetId)));
const showcase={objects:base.objects,groups:state.groups,requests,sounds:base.sounds,bounds:{width:1600,height:875}};
await writeFile(join(content,'codex-showcase/showcase.json'),JSON.stringify(showcase,null,2));
await writeFile(join(project,'readback.json'),JSON.stringify(state,null,2));
console.log(JSON.stringify({project,session,objects:state.objects.length,groups:state.groups.map(g=>({name:g.name,mode:g.mode,members:g.objectIds.length})),tasks:state.tasks.map(t=>({sequence:t.sequence,status:t.status})),draft:state.draft.text}));
