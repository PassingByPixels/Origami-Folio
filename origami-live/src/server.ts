/* The local serving core (R3 subset). file:// decks can't send an HTTP Referer,
   so referrer-gated embeds (YouTube, Power BI publish-to-web) fall back to a
   link card — the viewer keys that purely on `location.protocol === 'file:'`.
   Served over http://127.0.0.1 the SAME deck file becomes an http origin: the
   Referer flows, the viewer builds the real iframe, the embed plays.

   Deliberately tiny: a read-only static server bound to loopback, scoped to one
   folder, no deps. It serves the deck bytes verbatim — it never rewrites them. */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // local video the deck references by relative path (the video block's local source)
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
};

export interface ServeOptions {
  /** Absolute folder to serve. */
  root: string;
  /** Deck file (relative to root) that "/" redirects to; omitted = a listing. */
  indexFile?: string;
  /** Push file-changes to the served page over SSE (the "watch it build" channel). */
  live?: boolean;
  /** Network-share gate: when set, every request must carry this as its first path
      segment (`/<token>/…`). Absent/wrong → 404. Undefined = loopback path (no gate). */
  token?: string;
}

/* The live loader, injected into served HTML in --live mode ONLY (the on-disk file
   is never rewritten; the runtime's zero-network invariant means this can't live in
   the deck). It subscribes to /__live and reloads when the file changes. */
function liveLoader(prefix: string): string {
  return `<script>(function(){try{var s=new EventSource('${prefix}/__live');s.onmessage=function(){location.reload()}}catch(e){}})()</script>`;
}

function injectLive(html: string, prefix: string): string {
  const i = html.lastIndexOf('</body>');
  const loader = liveLoader(prefix);
  return i === -1 ? html + loader : html.slice(0, i) + loader + html.slice(i);
}

/** Parse a single-range `Range: bytes=…` header against a known file size.
    - `bytes=a-b`, `bytes=a-`, `bytes=-n` → { start, end } (inclusive)
    - malformed, or multi-range (a comma) → 'ignore' (serve the whole file, 200)
    - a well-formed range wholly outside the file → 'unsatisfiable' (416)
    Pure, so the arithmetic is testable without a socket. */
function parseRange(header: string, size: number): { start: number; end: number } | 'ignore' | 'unsatisfiable' {
  const m = /^bytes=(.+)$/.exec(header.trim());
  if (!m) return 'ignore';
  const spec = m[1].trim();
  if (spec.includes(',')) return 'ignore'; // multi-range: serve it whole, never multipart
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts || (parts[1] === '' && parts[2] === '')) return 'ignore';
  if (size === 0) return 'unsatisfiable';
  if (parts[1] === '') {
    const n = Number(parts[2]); // suffix: the last N bytes
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(parts[1]);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  const end = parts[2] === '' ? size - 1 : Math.min(Number(parts[2]), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Resolve a request path to a real file under root, or null if it escapes. */
function resolveUnderRoot(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(root, '.' + decoded);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // containment
  return target;
}

export function createDeckServer(opts: ServeOptions): Server {
  const root = path.resolve(opts.root);
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        // LAN share gate: when a token is set, every request must carry it as the
        // first path segment. Wrong/absent → 404 (a 403 would confirm the port to a
        // network scanner; the QR carries the token, a scanner doesn't). Checked
        // before the method gate, so a port opened without the token reveals nothing.
        const prefix = opts.token ? '/' + opts.token : '';
        let urlPath = rawUrl;
        if (opts.token) {
          const pathname = rawUrl.split('?')[0];
          if (pathname !== prefix && !pathname.startsWith(prefix + '/')) {
            res.writeHead(404).end('not found');
            return;
          }
          urlPath = rawUrl.slice(prefix.length) || '/';
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end('method not allowed');
          return;
        }

        // The live push channel: an SSE stream held open until the client leaves.
        if (opts.live && (urlPath === '/__live' || urlPath.startsWith('/__live?'))) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }

        if ((urlPath === '/' || urlPath === '') && opts.indexFile) {
          res.writeHead(302, { location: prefix + '/' + encodeURIComponent(opts.indexFile) }).end();
          return;
        }
        const target = resolveUnderRoot(root, urlPath);
        if (!target) {
          res.writeHead(403).end('forbidden');
          return;
        }
        let info;
        try {
          info = await stat(target);
        } catch {
          res.writeHead(404).end('not found');
          return;
        }
        if (info.isDirectory()) {
          const names = (await readdir(target)).filter((n) => /\.origami\.html$|\.html$/i.test(n));
          const links = names.map((n) => `<li><a href="${prefix}/${encodeURIComponent(n)}">${n}</a></li>`).join('');
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(`<!doctype html><meta charset=utf-8><title>Origami decks</title><h1>Decks</h1><ul>${links}</ul>`);
          return;
        }
        const ext = path.extname(target).toLowerCase();
        const type = TYPES[ext] ?? 'application/octet-stream';

        // Live mode augments the served HTML with the loader (disk file untouched);
        // read fully rather than stream so we can inject before </body>.
        if (opts.live && (ext === '.html' || ext === '.htm')) {
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end();
            return;
          }
          const body = Buffer.from(injectLive(await readFile(target, 'utf8'), prefix), 'utf8');
          res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
          res.end(body);
          return;
        }

        // Range support so a local video streams and scrubs instead of
        // downloading whole. A malformed or multi-range header is ignored
        // (whole-file 200); a range outside the file is 416.
        const rangeHeader = req.headers.range;
        if (rangeHeader !== undefined) {
          const range = parseRange(rangeHeader, info.size);
          if (range === 'unsatisfiable') {
            res.writeHead(416, { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' });
            res.end();
            return;
          }
          if (range !== 'ignore') {
            res.writeHead(206, {
              'content-type': type,
              'content-length': range.end - range.start + 1,
              'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store',
            });
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            createReadStream(target, { start: range.start, end: range.end }).pipe(res);
            return;
          }
        }

        res.writeHead(200, {
          'content-type': type,
          'content-length': info.size,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(target).pipe(res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end('server error');
      }
    })();
  });

  if (opts.live) {
    const broadcast = (): void => {
      // a DEFAULT (unnamed) message so the loader's EventSource.onmessage fires
      // (onmessage ignores named events — those need addEventListener)
      for (const res of clients) res.write('data: changed\n\n');
    };
    let debounce: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    try {
      // watch the FOLDER, not the file: the MCP/Studio save via atomic rename,
      // which replaces the file and breaks a file-scoped watch. Debounce absorbs
      // the rename's burst of events.
      watcher = watch(root, { persistent: false }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(broadcast, 120);
      });
    } catch {
      /* fs.watch unsupported here — live degrades to plain serving */
    }
    const heartbeat = setInterval(() => {
      for (const res of clients) res.write(': ping\n\n');
    }, 25000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    server.on('close', () => {
      clearTimeout(debounce);
      clearInterval(heartbeat);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
    });
  }

  return server;
}

/** Start the server on the first free port at/after `port`, bound to loopback. */
export function listenLoopback(server: Server, port: number, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p: number): void => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempt < tries) {
          attempt++;
          tryListen(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    };
    tryListen(port);
  });
}

const LINK_LOCAL = /^169\.254\./; // APIPA — never routable, exclude outright
// Virtual / VPN adapters that hand out plausible-looking private IPs but aren't
// the Wi-Fi/Ethernet a phone is on. Tailscale also matches by its 100.64/10
// range below; this catches the rest (Hyper-V/WSL vEthernet, VMware, etc).
const VIRTUAL_IFACE = /tailscale|vethernet|hyper-?v|vmware|virtualbox|vbox|\bwsl\b|loopback|zerotier|wireguard|nordlynx|\bvpn\b|utun|tun\d/i;

/** Higher = more likely to be the address a phone on the same Wi-Fi can reach. */
function lanRangeScore(addr: string): number {
  if (addr.startsWith('192.168.')) return 100; // the typical home Wi-Fi range
  const o = addr.split('.').map((n) => Number(n));
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 90; // 172.16/12 private
  if (o[0] === 10) return 80; // 10/8 private (home/corp)
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 5; // 100.64/10 CGNAT (Tailscale) — last resort
  return 40; // some other public/private v4
}

export interface IfaceAddr {
  family: string | number;
  internal: boolean;
  address: string;
}

/**
 * Choose the best LAN-reachable IPv4 from a networkInterfaces()-shaped map.
 * Prefers a genuine private-LAN address on a physical adapter (192.168 > 172.16
 * > 10) and de-prioritises Tailscale's 100.64/10 CGNAT range and virtual
 * adapters — so a "scan on your Wi-Fi" QR points at an address phones can
 * actually reach, not the tailnet IP only tailnet devices can. Link-local
 * 169.254 (APIPA) is excluded. Pure (takes the interface map) so it's testable.
 */
export function pickLanAddress(ifaces: Record<string, IfaceAddr[] | undefined>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      const isV4 = ni.family === 'IPv4' || ni.family === 4;
      if (!isV4 || ni.internal || LINK_LOCAL.test(ni.address)) continue;
      const score = lanRangeScore(ni.address) - (VIRTUAL_IFACE.test(name) ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = ni.address;
      }
    }
  }
  return best;
}

/** The best LAN-reachable IPv4 address — for building a QR/URL phones can open. */
export function lanAddress(): string | null {
  return pickLanAddress(networkInterfaces() as Record<string, IfaceAddr[] | undefined>);
}

/** Start on 0.0.0.0 (LAN-reachable) at the first free port at/after `port`. */
export function listenLan(server: Server, port: number, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p: number): void => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempt < tries) {
          attempt++;
          tryListen(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, '0.0.0.0', () => resolve((server.address() as { port: number }).port));
    };
    tryListen(port);
  });
}
