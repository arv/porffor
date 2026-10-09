// serves the repository for the playground: node threads/playground/serve.js [port]
// (or $PORT, as on Railway). SharedArrayBuffer (and so shared Wasm memory) needs a
// cross-origin isolated page, hence the COOP/COEP headers. any static host that sends them works
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = parseInt(process.argv[2]) || parseInt(process.env.PORT) || 8787;

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

// gzipped files, by path and modification time
const gzipped = new Map();
const gzip = (file, stat, data) => {
  const key = `${file}:${stat.mtimeMs}`;
  if (!gzipped.has(key)) gzipped.set(key, zlib.gzipSync(data));
  return gzipped.get(key);
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (url.pathname === '/') { res.writeHead(302, { location: '/threads/playground/' }).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    // a directory's page loads its scripts relative to it, so it needs the trailing slash
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end(); return; }
    file = path.join(file, 'index.html');
  }
  const headers = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-cache',
    'vary': 'accept-encoding'
  };
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, headers).end('not found'); return; }
    // no-cache with a validator: browsers check each time, and get a 304 when nothing changed
    const modified = stat.mtime.toUTCString();
    if (req.headers['if-modified-since'] === modified) { res.writeHead(304, headers).end(); return; }
    const type = types[path.extname(file)] ?? 'application/octet-stream';
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500, headers).end(); return; }
      const compress = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && data.length > 1024;
      if (compress) data = gzip(file, stat, data);
      res.writeHead(200, { ...headers, 'content-type': type, 'last-modified': modified, ...(compress ? { 'content-encoding': 'gzip' } : {}) }).end(data);
    });
  });
}).listen(port, () => console.log(`playground: http://localhost:${port}/threads/playground/`));
