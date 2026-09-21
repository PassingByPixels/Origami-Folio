import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveSession, handleMessage } from '../src/host.js';

const DECK = '<!doctype html><html><head><title>Host Deck</title></head><body>host hello</body></html>';
const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.resolve(here, '..', 'dist', 'host.cjs');

describe('Origami Live host — session', () => {
  let session: ReturnType<typeof createLiveSession>;
  afterEach(async () => {
    await session?.stop();
  });

  it('serves handed-over bytes over http with the live loader injected', async () => {
    session = createLiveSession();
    const res = await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK });
    expect(res.ok).toBe(true);
    const url = res.url as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await (await fetch(url + 'demo.origami.html')).text();
    expect(page).toContain('host hello'); // the bytes the Studio handed over
    expect(page).toContain("EventSource('/__live')"); // the live channel, injected
  });

  it('update rewrites the served deck (the live page would rebuild)', async () => {
    session = createLiveSession();
    const served = (await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK })) as {
      url: string;
    };
    await handleMessage(session, { cmd: 'update', html: DECK.replace('host hello', 'host UPDATED') });
    const page = await (await fetch(served.url + 'demo.origami.html')).text();
    expect(page).toContain('host UPDATED');
    expect(page).not.toContain('host hello');
  });

  it('ping reports a version; stop tears the server down', async () => {
    session = createLiveSession();
    expect(await handleMessage(session, { cmd: 'ping' })).toMatchObject({ ok: true });
    const served = (await handleMessage(session, { cmd: 'serve', name: 'd.origami.html', html: DECK })) as {
      url: string;
    };
    await handleMessage(session, { cmd: 'stop' });
    await expect(fetch(served.url + 'd.origami.html')).rejects.toThrow(); // nothing listening anymore
  });

  // OPT-IN: shareLan binds 0.0.0.0 (the network), which pops the Windows Firewall
  // prompt — the same one end-users see. Routine `npm test` SKIPS this; run with
  // OASRV_LAN_TEST=1 to exercise the live LAN serve. The token gate + read-only are
  // already covered on loopback in serve.test.ts (no network bind there).
  it.runIf(!!process.env.OASRV_LAN_TEST)(
    'shareLan opens a token-gated LAN server; stopLan closes only it',
    async () => {
      session = createLiveSession();
      // a real folder with a media sibling: the loopback server serves it, the LAN must not.
      const lanDir = await mkdtemp(path.join(tmpdir(), 'origami-hostlan-'));
      await writeFile(path.join(lanDir, 'clip.mp4'), Buffer.from('0123456789'));
      await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK, dir: lanDir });
      const r = (await handleMessage(session, { cmd: 'shareLan' })) as {
        ok: boolean;
        lanUrl?: string;
        token?: string;
        error?: string;
      };
      if (!r.ok) {
        expect(r.error).toBeTruthy(); // no non-loopback interface here — the honest no-op path
        await rm(lanDir, { recursive: true, force: true });
        return;
      }
      expect(r.lanUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/[A-Za-z0-9_-]+\/$/);
      const base = (r.lanUrl as string).replace(/\/$/, ''); // http://<lan-ip>:<port>/<token>
      const origin = new URL(r.lanUrl as string).origin;
      // fetch via the LAN IP (not 127.0.0.1): on Windows a loopback-only squatter on
      // the same port can shadow our 0.0.0.0 server on the loopback path.
      expect((await fetch(`${base}/demo.origami.html`)).status).toBe(200);
      expect((await fetch(`${base}/clip.mp4`)).status).toBe(404); // the folder is never exposed to the LAN
      expect((await fetch(`${origin}/demo.origami.html`)).status).toBe(404); // black hole without the token
      expect((await fetch(`${base}/demo.origami.html`, { method: 'POST' })).status).toBe(405); // view-only

      const again = (await handleMessage(session, { cmd: 'shareLan' })) as { lanUrl?: string };
      expect(again.lanUrl).toBe(r.lanUrl); // idempotent

      await handleMessage(session, { cmd: 'stopLan' });
      await expect(fetch(`${base}/demo.origami.html`)).rejects.toThrow();
      expect(session.url).not.toBeNull(); // the loopback session is untouched
      await rm(lanDir, { recursive: true, force: true });
    }
  );
});

describe('Origami Live host — serving the deck’s real folder', () => {
  let session: ReturnType<typeof createLiveSession>;
  let dir: string;
  afterEach(async () => {
    await session?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A real deck folder: the deck on disk plus a media sibling and a non-media sibling. */
  async function realFolder(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'origami-hostdir-'));
    await writeFile(path.join(dir, 'demo.origami.html'), 'DISK BYTES — must never be served', 'utf8');
    await writeFile(path.join(dir, 'clip.mp4'), Buffer.from('0123456789'));
    await writeFile(path.join(dir, 'notes.txt'), 'private notes', 'utf8');
    return dir;
  }

  it('serves the in-memory deck and streams a media sibling over Range', async () => {
    session = createLiveSession();
    const d = await realFolder();
    const res = (await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK, dir: d })) as {
      url: string;
    };

    const page = await (await fetch(`${res.url}demo.origami.html`)).text();
    expect(page).toContain('host hello'); // the handed-over bytes, not the disk file
    expect(page).not.toContain('DISK BYTES');
    expect(page).toContain("EventSource('/__live')");

    const range = await fetch(`${res.url}clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await range.arrayBuffer()).toString()).toBe('2345');
  });

  it('update keeps the new bytes in memory and never writes into the folder', async () => {
    session = createLiveSession();
    const d = await realFolder();
    const before = await readdir(d);
    const res = (await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK, dir: d })) as {
      url: string;
    };
    await handleMessage(session, { cmd: 'update', html: DECK.replace('host hello', 'host UPDATED') });

    const page = await (await fetch(`${res.url}demo.origami.html`)).text();
    expect(page).toContain('host UPDATED');
    expect(await readdir(d)).toEqual(before); // no deck written, no file added or removed
    expect(await readFile(path.join(d, 'demo.origami.html'), 'utf8')).toBe('DISK BYTES — must never be served');
  });

  it('stop leaves the real folder intact (it only removes a temp dir it made)', async () => {
    session = createLiveSession();
    const d = await realFolder();
    await handleMessage(session, { cmd: 'serve', name: 'demo.origami.html', html: DECK, dir: d });
    await session.stop();
    expect((await readdir(d)).sort()).toEqual(['clip.mp4', 'demo.origami.html', 'notes.txt']);
    expect((await readFile(path.join(d, 'clip.mp4'))).toString()).toBe('0123456789');
  });
});

describe('Origami Live host — native-messaging framing', () => {
  const frame = (msg: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    return Buffer.concat([len, body]);
  };

  it('round-trips a uint32-prefixed message over stdio (the Chrome interface)', async () => {
    const host = spawn('node', [HOST], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        let buf = Buffer.alloc(0);
        host.stdout.on('data', (c: Buffer) => {
          buf = Buffer.concat([buf, c]);
          if (buf.length >= 4) {
            const len = buf.readUInt32LE(0);
            if (buf.length >= 4 + len) resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
          }
        });
        host.on('error', reject);
      });
      host.stdin.write(frame({ cmd: 'ping' }));
      expect(await reply).toMatchObject({ ok: true, version: expect.any(String) });
    } finally {
      host.kill();
    }
  });
});
