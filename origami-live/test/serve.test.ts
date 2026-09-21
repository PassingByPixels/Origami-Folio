import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { createDeckServer, listenLoopback } from '../src/server.js';

const DECK = '<!doctype html><html><head><title>Served Deck</title></head><body>hello deck</body></html>';

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'origami-serve-'));
  await writeFile(path.join(dir, 'a.origami.html'), DECK, 'utf8');
  await writeFile(path.join(dir, 'note.txt'), 'secret', 'utf8');
  await writeFile(path.join(dir, 'clip.mp4'), Buffer.from('0123456789')); // 10 known bytes for Range
  server = createDeckServer({ root: dir, indexFile: 'a.origami.html' });
  const port = await listenLoopback(server, 0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('origami-serve', () => {
  it('serves the deck over http with a real text/html content-type (the referer-enabling origin)', async () => {
    const res = await fetch(`${base}/a.origami.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('hello deck');
  });

  it('redirects / to the index deck', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/a.origami.html');
  });

  it('404s a missing file', async () => {
    expect((await fetch(`${base}/nope.origami.html`)).status).toBe(404);
  });

  it('refuses path traversal out of the served folder', async () => {
    // a raw (un-normalized-by-fetch) traversal — go through the low-level path
    const res = await fetch(`${base}/%2e%2e%2f%2e%2e%2fwindows%2fwin.ini`);
    expect([403, 404]).toContain(res.status); // contained: never 200
    expect(res.status).not.toBe(200);
  });

  it('a directory root lists only deck files (the txt stays hidden)', async () => {
    const bare = createDeckServer({ root: dir });
    const port = await listenLoopback(bare, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();
      expect(body).toContain('a.origami.html');
      expect(body).not.toContain('note.txt');
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});

describe('origami-serve HTTP Range (local video scrubbing)', () => {
  const bytes = async (res: Response): Promise<Buffer> => Buffer.from(await res.arrayBuffer());

  it('advertises byte ranges and serves the whole file on a plain request', async () => {
    const res = await fetch(`${base}/clip.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toContain('video/mp4');
    expect(res.headers.get('content-length')).toBe('10');
    expect((await bytes(res)).toString()).toBe('0123456789');
  });

  it('bytes=0- → 206 with the full Content-Range and byte count', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/10');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await bytes(res)).toString()).toBe('0123456789');
  });

  it('a closed range returns exactly the requested slice', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect((await bytes(res)).toString()).toBe('2345');
  });

  it('a suffix range counts back from the end', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10');
    expect((await bytes(res)).toString()).toBe('789');
  });

  it('an unsatisfiable range → 416 with Content-Range: bytes */size', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=20-30' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
    expect((await bytes(res)).length).toBe(0);
  });

  it('a malformed range is ignored — the whole file comes back 200', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=abc' } });
    expect(res.status).toBe(200);
    expect((await bytes(res)).toString()).toBe('0123456789');
  });

  it('a multi-range header is ignored rather than multipart-answered', async () => {
    const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=0-1,4-5' } });
    expect(res.status).toBe(200);
    expect((await bytes(res)).toString()).toBe('0123456789');
  });
});

describe('origami-serve — indexHtml mode (Go Live serves the deck’s real folder)', () => {
  const DECKFILE = 'deck.origami.html';
  const MEMORY = '<!doctype html><html><head><title>Memory Deck</title></head><body>from memory</body></html>';
  let realDir: string;
  let realServer: Server;
  let realBase: string;

  beforeAll(async () => {
    realDir = await mkdtemp(path.join(tmpdir(), 'origami-realdir-'));
    await writeFile(path.join(realDir, DECKFILE), 'DISK DECK — never served', 'utf8');
    await writeFile(path.join(realDir, 'clip.mp4'), Buffer.from('0123456789'));
    await writeFile(path.join(realDir, 'notes.txt'), 'private notes', 'utf8');
    await writeFile(path.join(realDir, 'secrets.env'), 'TOKEN=hunter2', 'utf8');
    realServer = createDeckServer({ root: realDir, indexFile: DECKFILE, indexHtml: MEMORY, live: true });
    const port = await listenLoopback(realServer, 0);
    realBase = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => realServer.close(() => r()));
    await rm(realDir, { recursive: true, force: true });
  });

  it('serves the in-memory index (with the live loader), never the on-disk deck', async () => {
    const res = await fetch(`${realBase}/${DECKFILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('from memory');
    expect(body).not.toContain('DISK DECK');
    expect(body).toContain("EventSource('/__live')");
  });

  it('answers HEAD on the index with 200 and no body', async () => {
    const res = await fetch(`${realBase}/${DECKFILE}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  });

  it('Range-requests a media sibling → 206 with exactly the requested bytes', async () => {
    const res = await fetch(`${realBase}/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('2345');
  });

  it('404s a non-media sibling even though it exists (the media allowlist)', async () => {
    expect((await fetch(`${realBase}/notes.txt`)).status).toBe(404);
    expect((await fetch(`${realBase}/secrets.env`)).status).toBe(404);
  });

  it('still refuses a path escaping the root', async () => {
    const res = await fetch(`${realBase}/%2e%2e%2f%2e%2e%2fwindows%2fwin.ini`);
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

describe('origami-serve --live', () => {
  const DECKFILE = 'live.origami.html';
  let liveDir: string;
  let liveServer: Server;
  let liveBase: string;

  beforeAll(async () => {
    liveDir = await mkdtemp(path.join(tmpdir(), 'origami-live-'));
    await writeFile(path.join(liveDir, DECKFILE), DECK, 'utf8');
    liveServer = createDeckServer({ root: liveDir, indexFile: DECKFILE, live: true });
    const port = await listenLoopback(liveServer, 0);
    liveBase = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => liveServer.close(() => r()));
    await rm(liveDir, { recursive: true, force: true });
  });

  it('injects the live loader into served HTML; the disk file is untouched', async () => {
    const before = await readFile(path.join(liveDir, DECKFILE), 'utf8');
    const body = await (await fetch(`${liveBase}/${DECKFILE}`)).text();
    expect(body).toContain("EventSource('/__live')"); // the loader rode along the response
    expect(await readFile(path.join(liveDir, DECKFILE), 'utf8')).toBe(before); // file never rewritten
  });

  it('serves verbatim (no loader) when --live is off', async () => {
    const plain = createDeckServer({ root: liveDir, indexFile: DECKFILE }); // live omitted
    const port = await listenLoopback(plain, 0);
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/${DECKFILE}`)).text();
      expect(body).not.toContain('/__live');
    } finally {
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });

  it('pushes a "changed" event over /__live when the deck file changes', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${liveBase}/__live`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // drain the ': connected' comment — the client is now registered

    // a writer (the MCP, the Studio, a hand edit) changes the file on disk
    await writeFile(path.join(liveDir, DECKFILE), DECK + '<!--changed-->', 'utf8');

    let got = '';
    const deadline = Date.now() + 2500;
    while (!got.includes('data: changed') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      got += dec.decode(value, { stream: true });
    }
    ctrl.abort();
    expect(got).toContain('data: changed');
  });
});

describe('origami-serve token gate (LAN share)', () => {
  const TOKEN = 'testtoken123';
  const DECKFILE = 'share.origami.html';
  let tDir: string;
  let tServer: Server;
  let tBase: string;

  beforeAll(async () => {
    tDir = await mkdtemp(path.join(tmpdir(), 'origami-token-'));
    await writeFile(path.join(tDir, DECKFILE), DECK, 'utf8');
    tServer = createDeckServer({ root: tDir, indexFile: DECKFILE, live: true, token: TOKEN });
    const port = await listenLoopback(tServer, 0);
    tBase = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => tServer.close(() => r()));
    await rm(tDir, { recursive: true, force: true });
  });

  it('404s every path without the token — a scanner cannot confirm the deck exists', async () => {
    expect((await fetch(`${tBase}/`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${tBase}/${DECKFILE}`)).status).toBe(404); // right file, missing token
    expect((await fetch(`${tBase}/__live`)).status).toBe(404); // the SSE channel is gated too
  });

  it('404s a wrong token, including one that is only a prefix of the real token', async () => {
    expect((await fetch(`${tBase}/wrongtoken/${DECKFILE}`)).status).toBe(404);
    expect((await fetch(`${tBase}/${TOKEN}x/${DECKFILE}`)).status).toBe(404); // no partial-segment match
  });

  it('serves the deck under the token path and redirects the token root to it', async () => {
    const ok = await fetch(`${tBase}/${TOKEN}/${DECKFILE}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('hello deck');
    const root = await fetch(`${tBase}/${TOKEN}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(`/${TOKEN}/${DECKFILE}`);
  });

  it('token-scopes the injected live loader so the SSE stays behind the gate', async () => {
    const body = await (await fetch(`${tBase}/${TOKEN}/${DECKFILE}`)).text();
    expect(body).toContain(`EventSource('/${TOKEN}/__live')`);
  });

  it('stays READ-ONLY under a valid token: writes are refused (the only mutation path is stdio, never HTTP)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await fetch(`${tBase}/${TOKEN}/${DECKFILE}`, { method })).status).toBe(405);
    }
  });
});
