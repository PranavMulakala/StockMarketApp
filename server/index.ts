import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT } from './data';
import { RoomHub } from './rooms';

const PORT = Number(process.env.TAPE_PORT ?? 8787);
// Localhost only: the cached market data is licensed for personal use and must not be served to others.
const HOST = '127.0.0.1';
const DIST = join(ROOT, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const hub = new RoomHub();

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Serves the built web app (npm run build). In development, Vite serves it instead. */
async function serveStatic(pathname: string, res: ServerResponse) {
  let file = normalize(join(DIST, pathname));
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('No build found. Run `npm run build`, or use `npm run dev` while developing.');
  }
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/api/rooms') return json(res, hub.list());
  if (pathname === '/api/health') return json(res, { ok: true });
  void serveStatic(pathname, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => hub.connect(ws));
});

server.listen(PORT, HOST, () => console.log(`Tape server on http://${HOST}:${PORT}`));
