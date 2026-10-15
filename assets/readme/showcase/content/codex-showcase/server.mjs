import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const shell='/content/codex-showcase/index.html';
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.wav':'audio/wav','.md':'text/plain; charset=utf-8','.note':'text/plain; charset=utf-8'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname==='/'){res.writeHead(302,{Location:shell,'Cache-Control':'no-store'}).end();return;}const path=resolve(root,'.'+pathname);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}const info=await stat(path);if(!info.isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(await readFile(path));}catch{res.writeHead(404).end('Not found');}});
server.listen(Number(process.env.SHOWCASE_PORT||0),'127.0.0.1',()=>console.log(`Showcase: http://127.0.0.1:${server.address().port}/`));
