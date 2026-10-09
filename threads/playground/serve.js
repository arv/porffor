// serves the repository for the playground: node threads/playground/serve.js [port]
// SharedArrayBuffer (and so shared Wasm memory) needs a cross-origin isolated page, hence
// the COOP/COEP headers. any static host that sends them works too
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = parseInt(process.argv[2]) || 8787;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.tar': 'application/x-tar',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (url.pathname === '/') { res.writeHead(302, { location: '/threads/playground/' }).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    const headers = {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-cache'
    };
    if (err) { res.writeHead(404, headers).end('not found'); return; }
    res.writeHead(200, { ...headers, 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  });
}).listen(port, () => console.log(`playground: http://localhost:${port}/threads/playground/`));
