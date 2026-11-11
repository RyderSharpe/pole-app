#!/usr/bin/env node
// A small web server for trying the app on this computer.
//
//   node tools/serve.mjs            serves the project at http://localhost:8080
//   node tools/serve.mjs 9000       uses another port
//
// It is for development only. A phone needs an https:// address, such as GitHub Pages.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Makes a server for one folder.
 * options.mount     serve the folder under this path, for example "/app/" (default "/")
 * options.intercept (path inside the folder) => undefined, or { status, type, body } to answer in place of the file
 */
export function makeServer(root, options = {}) {
  const base = path.resolve(root);
  const mount = options.mount || '/';
  return createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(405, 'text/plain; charset=utf-8', 'Method not allowed');
        return;
      }
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (mount !== '/') {
        if (pathname === mount.slice(0, -1)) {
          response.writeHead(301, { Location: mount });
          response.end();
          return;
        }
        if (!pathname.startsWith(mount)) {
          send(404, 'text/plain; charset=utf-8', 'Not found');
          return;
        }
        pathname = '/' + pathname.slice(mount.length);
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const inside = pathname.replace(/^\/+/, '');
      if (options.intercept) {
        const answer = await options.intercept(inside);
        if (answer) {
          send(answer.status || 200, answer.type || TYPES[path.extname(inside)] || 'application/octet-stream', answer.body);
          return;
        }
      }
      const file = path.resolve(base, inside);
      if (file !== base && !file.startsWith(base + path.sep)) {
        send(403, 'text/plain; charset=utf-8', 'Not allowed');
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        send(404, 'text/plain; charset=utf-8', 'Not found');
        return;
      }
      send(200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', await readFile(file));
    } catch (error) {
      send(500, 'text/plain; charset=utf-8', 'Server error');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = Number(process.argv[2]) || 8080;
  makeServer(root).listen(port, '127.0.0.1', () => {
    console.log('Pole Field Data is at http://localhost:' + port + '  (Ctrl+C to stop)');
  });
}
