const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const workspace = process.env.SHOWCASE_WORKSPACE;
const root = path.join(workspace, 'webview');
const config = JSON.parse(fs.readFileSync(path.join(root, 'fixture-config.json')));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.wasm': 'application/wasm', '.mp4': 'video/mp4' };
const server = http.createServer(async (req, res) => {
    const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'POST' && requestPath === '/fixture-log') {
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        fs.appendFileSync(path.join(workspace, 'fixture-log.jsonl'), Buffer.concat(chunks));
        fs.appendFileSync(path.join(workspace, 'fixture-log.jsonl'), '\n');
        res.writeHead(204, { 'Content-Length': '0' });
        res.end();
        return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(requestPath));
    if (!file.startsWith(root + '/') && file !== root) {
        res.writeHead(403);
        res.end();
        return;
    }
    if (requestPath === '/' || requestPath === '/index.html' || requestPath === '/local/showcase-slow-signal') {
        let text = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(`<script type="module" crossorigin src="${config.entryModule}"></script>`, '<script type="module" src="/fixture.js"></script>').replaceAll('./assets/', '/assets/');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
        res.end(text);
        return;
    }
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile())
            throw Error('missing');
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': requestPath === '/fixture.js' ? 'no-store' : 'public, max-age=86400' });
        if (req.method === 'HEAD')
            res.end();
        else
            fs.createReadStream(file).pipe(res);
    }
    catch {
        res.writeHead(404, { 'Content-Length': '0' });
        res.end();
    }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen({ host: '127.0.0.1', port: 0, backlog: 512 }, () => console.log(`http://127.0.0.1:${server.address().port}/`));
