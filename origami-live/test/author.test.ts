/**
 * The armed authoring session (Phase 2a): arming opens a loopback MCP port over a
 * working dir, writes the discovery file, and pushes the deck bytes to the (here,
 * virtual) extension whenever the agent authors a deck — the server-side half of the
 * "arm → agent builds → you watch" relay. The in-Chrome half (SW + Studio) is
 * manual-verified; this proves everything up to the native-port push.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from 'origami-mcp';
import { createAuthorSession } from '../src/host';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/* The agent side is now a plain stateless HTTP client (MCP 2026-07-28): one independent
   POST per call, no initialize, no session, and — the port being tokenless — no credential.
   Exactly what an external AI client sends. */
async function toolCall(
  conn: { url: string },
  name: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const res = await fetch(conn.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/client': { name: 'arm-test', version: '0.0.0' } } },
    }),
  });
  const body = (await res.json()) as { result?: any };
  if (res.status !== 200) throw new Error(`MCP ${res.status}: ${JSON.stringify(body)}`);
  return body.result;
}
const callJson = async (conn: { url: string }, name: string, args: Record<string, unknown> = {}): Promise<any> =>
  JSON.parse((await toolCall(conn, name, args)).content[0].text);

/** A raw node:http POST so a test can forge a Host header fetch would not let it set. */
function rawPost(url: string, headers: Record<string, string>, body = '{}'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

it('arm → authorable MCP port + discovery file; create_deck pushes relay bytes; disarm cleans up', async () => {
  const pushes: Array<Record<string, unknown>> = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-arm-'));
  const cfg = path.join(tmp, 'live.json');
  // ephemeral port (0) so the test never collides with a real armed helper on 8765
  const author = createAuthorSession((m) => pushes.push(m as Record<string, unknown>), { configPath: cfg, port: 0 });

  const info = await author.arm();
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };

  // the discovery file an agent reads carries the live url (tokenless) + working dir
  const disco = JSON.parse(await fs.readFile(cfg, 'utf8'));
  expect(disco.url).toBe(info.url);
  expect('token' in disco).toBe(false);
  expect(disco.workingDir).toBe(info.dir);

  // an external agent posts ONE independent request to the port and creates a deck from nothing
  const made = await callJson(info, 'create_deck', { title: 'Relayed' });
  expect(made.created).toMatch(/relayed\.origami\.html$/i);

  // the working-dir watch pushed the new deck's BYTES to the extension (relay-update)
  await vi.waitFor(
    () => expect(pushes.some((p) => p.type === 'relay-update')).toBe(true),
    { timeout: 4000, interval: 100 }
  );
  const update = pushes.find((p) => p.type === 'relay-update')!;
  expect(String(update.name)).toMatch(/relayed\.origami\.html$/i);
  expect(String(update.html)).toContain('<script id="origami-runtime">'); // real, openable deck bytes

  await author.disarm();
  // disarm removes the discovery file (the port is closed too)
  await expect(fs.readFile(cfg, 'utf8')).rejects.toThrow();
});

/* t-j3yy3c: the connection an agent holds must survive (a) repeated arm calls — the SW re-arms
   on every Studio open and every quiet retry — and (b) a helper restart. The port is tokenless,
   so the URL is the whole connection: it must not change, and no credential may appear. */
it('repeated arm keeps the same connection; a disarm + re-arm on the fixed port publishes the same url', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-rearm-'));
  const cfg = path.join(tmp, 'live.json');
  // a free ephemeral port, used as this test's "fixed" port (never 8765)
  const port = await new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const author = createAuthorSession(() => {}, { configPath: cfg, port });
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };

  const first = await author.arm();
  const disco1 = await fs.readFile(cfg, 'utf8');
  const again = await author.arm();
  const third = await author.arm();
  expect(again).toEqual(first);
  expect(third).toEqual(first);
  expect(await fs.readFile(cfg, 'utf8')).toBe(disco1); // discovery not rewritten
  expect((await callJson(first, 'create_deck', { title: 'Still Here' })).created).toMatch(/still-here/i);

  // helper restart: the agent's saved url keeps working with nothing to copy
  await author.disarm();
  const after = await author.arm();
  expect(after.url).toBe(first.url);
  const disco2 = JSON.parse(await fs.readFile(cfg, 'utf8'));
  expect(disco2.url).toBe(first.url);
  expect('token' in disco2).toBe(false);
  expect((await callJson(first, 'create_deck', { title: 'After Restart' })).created).toMatch(/after-restart/i);
});

it('open_deck rounds a consent prompt through the browser, then edits the approved file in place + mirrors it live', async () => {
  const pushes: Array<Record<string, unknown>> = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-armopen-'));
  const cfg = path.join(tmp, 'live.json');
  const author = createAuthorSession((m) => pushes.push(m as Record<string, unknown>), { configPath: cfg, port: 0 });
  const info = await author.arm();

  // a real deck OUTSIDE the armed working dir: mint one in the sandbox, then copy it elsewhere
  const ext = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-extdeck-'));
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(ext, { recursive: true, force: true }).catch(() => {});
  };

  const call = (name: string, args: Record<string, unknown> = {}): Promise<any> => callJson(info, name, args);
  const made = await call('create_deck', { title: 'Sample' });
  const extFile = path.join(ext, 'sample.origami.html');
  await fs.copyFile(made.created, extFile);

  // open_deck blocks on the user's answer — we drive the answer via resolveConfirm (the browser's role)
  const resolveOpenWith = async (approved: boolean, p = extFile) => {
    const before = pushes.length;
    const open = call('open_deck', { path: p }); // do NOT await yet — it's waiting on consent
    await vi.waitFor(() => {
      const confirm = pushes.slice(before).find((m) => m.type === 'relay-confirm');
      expect(confirm).toBeTruthy();
    }, { timeout: 4000, interval: 50 });
    const confirm = pushes.slice(before).find((m) => m.type === 'relay-confirm')!;
    expect(String(confirm.path)).toBe(path.resolve(p)); // the prompt names the exact file
    author.resolveConfirm(String(confirm.requestId), approved);
    return open;
  };

  // APPROVE → opens, the bytes are pushed live, and editing writes the REAL external file
  const opened = await (await resolveOpenWith(true));
  expect(opened.opened).toBe(path.resolve(extFile));
  await vi.waitFor(
    () => expect(pushes.some((m) => m.type === 'relay-update' && String(m.name).endsWith('sample.origami.html'))).toBe(true),
    { timeout: 4000, interval: 100 }
  );
  expect((await call('list_chunks', { deck: extFile })).chunks.length).toBe(1);
  expect((await call('add_chunk', { deck: extFile, label: 'AI edit' })).chunkId).toBeTruthy();
  expect((await call('save_deck', { deck: extFile })).saved).toBe(true);
  // the watch on the approved file pushed the saved bytes back to the relay tab (live mirror)
  await vi.waitFor(() => {
    const last = [...pushes].reverse().find((m) => m.type === 'relay-update' && String(m.name).endsWith('sample.origami.html'))!;
    expect(String(last.html)).toContain('AI edit');
  }, { timeout: 4000, interval: 100 });

  // DENY → the tool errors and the file is never reachable for editing
  const ext2 = path.join(ext, 'second.origami.html');
  await fs.copyFile(made.created, ext2);
  const denied = await (async () => {
    const before = pushes.length;
    const open = toolCall(info, 'open_deck', { path: ext2 });
    await vi.waitFor(() => expect(pushes.slice(before).some((m) => m.type === 'relay-confirm')).toBe(true), { timeout: 4000, interval: 50 });
    const c = pushes.slice(before).reverse().find((m) => m.type === 'relay-confirm')!;
    author.resolveConfirm(String(c.requestId), false);
    return open;
  })();
  expect(denied.isError).toBe(true);
  const blocked = await toolCall(info, 'list_chunks', { deck: ext2 });
  expect(blocked.isError).toBe(true); // never approved → outside the sandbox, refused
});

/* t-9mwumg: one Allow must cover the same file for the armed session. A repeat open_deck on
   an approved file, and save_deck on it, must not raise a second banner; a different file is
   its own grant; a deny stays retryable; disarm revokes every open_deck approval. */
it('open_deck: one Allow covers later calls on the same file for the armed session; deny is retryable; disarm revokes', async () => {
  const pushes: Array<Record<string, unknown>> = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-once-'));
  const cfg = path.join(tmp, 'live.json');
  const author = createAuthorSession((m) => pushes.push(m as Record<string, unknown>), { configPath: cfg, port: 0 });
  const info = await author.arm();
  const ext = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-oncedeck-'));
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(ext, { recursive: true, force: true }).catch(() => {});
  };

  const made = await callJson(info, 'create_deck', { title: 'Approve Once' });
  const file = path.join(ext, 'once.origami.html');
  const other = path.join(ext, 'other.origami.html');
  await fs.copyFile(made.created, file);
  await fs.copyFile(made.created, other);

  const confirms = (): Array<Record<string, unknown>> => pushes.filter((m) => m.type === 'relay-confirm');
  /** Answer the NEXT consent prompt (the browser's role) while a tool call is in flight. */
  const answerNext = async (approved: boolean): Promise<Record<string, unknown>> => {
    const seen = confirms().length;
    await vi.waitFor(() => expect(confirms().length).toBeGreaterThan(seen), { timeout: 4000, interval: 20 });
    const c = confirms()[seen];
    author.resolveConfirm(String(c.requestId), approved);
    return c;
  };

  // first open_deck: exactly one prompt, naming the file; Allow opens it
  const first = callJson(info, 'open_deck', { path: file });
  const prompt = await answerNext(true);
  expect(prompt.path).toBe(path.resolve(file));
  expect((await first).opened).toBe(path.resolve(file));

  // a repeat open_deck on the same approved file does NOT prompt again
  const afterFirst = confirms().length;
  const again = await callJson(info, 'open_deck', { path: file });
  expect(again.opened).toBe(path.resolve(file));
  expect(confirms()).toHaveLength(afterFirst);

  // save_deck on the approved file does NOT prompt (the store's grant covers read/write)
  expect((await callJson(info, 'save_deck', { deck: file })).saved).toBe(true);
  expect(confirms()).toHaveLength(afterFirst);

  // a different file is a different grant: it prompts, and Deny blocks it
  const otherCall = toolCall(info, 'open_deck', { path: other });
  expect((await answerNext(false)).path).toBe(path.resolve(other));
  const denied = await otherCall;
  expect(denied.isError).toBe(true);
  expect((await toolCall(info, 'list_chunks', { deck: other })).isError).toBe(true);
  expect(confirms()).toHaveLength(afterFirst + 1);

  // Deny is retryable: the next open_deck prompts again and Allow opens it
  const retry = callJson(info, 'open_deck', { path: other });
  await answerNext(true);
  expect((await retry).opened).toBe(path.resolve(other));
  expect(confirms()).toHaveLength(afterFirst + 2);

  // disarm revokes every open_deck grant: after a re-arm, the same file prompts again
  await author.disarm();
  const info2 = await author.arm();
  const beforeReArm = confirms().length;
  const reopened = callJson(info2, 'open_deck', { path: file });
  await answerNext(true);
  expect((await reopened).opened).toBe(path.resolve(file));
  expect(confirms()).toHaveLength(beforeReArm + 1);
});

/* The security walls that must survive the tokenless change, asserted on the REAL armed
   port the helper opens (not an in-test serveHttp): loopback bind, the Origin/Host guard,
   and no session leg to hijack. */
it('the armed port is loopback-only and Origin/Host-gated on every single request', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-armsec-'));
  const author = createAuthorSession(() => {}, { configPath: path.join(tmp, 'live.json'), port: 0 });
  const info = await author.arm();
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };

  expect(info.url.startsWith('http://127.0.0.1:')).toBe(true);

  const post = (headers: Record<string, string>): Promise<Response> =>
    fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  // no credential: a local client (no Origin, loopback Host) is served
  expect((await post({ 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' })).status).toBe(200);
  // an Origin header is refused 403 — the browser drive-by wall
  expect(
    (await post({ origin: 'https://evil.example', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' })).status
  ).toBe(403);
  // a non-loopback Host is refused 403 — the DNS-rebinding wall (raw http puts Host on the wire)
  const rebind = await rawPost(info.url, {
    'content-type': 'application/json',
    host: 'evil.example.com',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': 'tools/list',
  });
  expect(rebind.status).toBe(403);
  expect(rebind.text).toMatch(/Host/i);
  // the session legs are gone: nothing to GET a stream from, nothing to DELETE
  const streamed = await fetch(info.url, { method: 'GET' });
  expect(streamed.status).toBe(405);

  // and no LAN address answers on that port
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  for (const addr of lan) {
    const reached = await fetch(`http://${addr}:${new URL(info.url).port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    }).then(
      () => true,
      () => false
    );
    expect(reached, `${addr} answered — the armed port is not loopback-only`).toBe(false);
  }
});

/* ---------- add_asset image-read consent: one approval per folder, scoped, revocable ---------- */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function imageConsentRig() {
  const pushes: Array<Record<string, unknown>> = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-imgconsent-'));
  const author = createAuthorSession((m) => pushes.push(m as Record<string, unknown>), { configPath: path.join(tmp, 'live.json'), port: 0 });
  const info = await author.arm();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-imgout-'));
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  };
  const deck = (await callJson(info, 'create_deck', { title: 'Gallery' })).created as string;
  const confirms = (): Array<Record<string, unknown>> => pushes.filter((m) => m.type === 'relay-confirm');
  /** Answer the NEXT consent prompt (the browser's role) while a tool call is in flight. */
  const answerNext = async (approved: boolean): Promise<Record<string, unknown>> => {
    const seen = confirms().length;
    await vi.waitFor(() => expect(confirms().length).toBeGreaterThan(seen), { timeout: 4000, interval: 20 });
    const c = confirms()[seen];
    author.resolveConfirm(String(c.requestId), approved);
    return c;
  };
  const img = async (dir: string, name: string): Promise<string> => {
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, name);
    await fs.writeFile(p, PNG_1X1);
    return p;
  };
  return { author, info, outside, deck, confirms, answerNext, img };
}

it('add_asset: a five-image gallery from one outside folder prompts ONCE, as an image-read (not a deck) request', async () => {
  const r = await imageConsentRig();
  const files = await Promise.all([1, 2, 3, 4, 5].map((n) => r.img(r.outside, `p${n}.png`)));
  const first = callJson(r.info, 'add_asset', { deck: r.deck, path: files[0] });
  const prompt = await r.answerNext(true);
  expect((await first).assetId).toBeTruthy();
  expect(prompt.kind).toBe('read-images');
  expect(prompt.path).toBe(path.resolve(r.outside)); // names the FOLDER
  for (const f of files.slice(1)) expect((await callJson(r.info, 'add_asset', { deck: r.deck, path: f })).assetId).toBeTruthy();
  expect(r.confirms()).toHaveLength(1); // five images, one prompt
  const listed = await callJson(r.info, 'list_assets', { deck: r.deck }); // reload/re-read: no prompt
  expect(JSON.stringify(listed).match(/"id"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  expect(r.confirms()).toHaveLength(1);
});

it('add_asset: parallel calls for one new folder share a single prompt', async () => {
  const r = await imageConsentRig();
  const files = await Promise.all([1, 2, 3].map((n) => r.img(r.outside, `q${n}.png`)));
  const calls = files.map((f) => callJson(r.info, 'add_asset', { deck: r.deck, path: f, name: path.basename(f, '.png') }));
  await r.answerNext(true);
  const done = await Promise.all(calls);
  expect(done.every((d) => typeof d.assetId === 'string')).toBe(true);
  expect(r.confirms()).toHaveLength(1);
});

it('add_asset: an approved folder does NOT cover a sibling folder, a subfolder, or a deck; those are still refused or prompted', async () => {
  const r = await imageConsentRig();
  const a = await r.img(r.outside, 'a.png');
  const sub = await r.img(path.join(r.outside, 'sub'), 'b.png');
  const sibling = await r.img(await fs.mkdtemp(path.join(os.tmpdir(), 'origami-imgsib-')), 'c.png');
  const siblingDeck = path.join(r.outside, 'other.origami.html');
  await fs.copyFile(r.deck, siblingDeck);
  try {
    const ok = callJson(r.info, 'add_asset', { deck: r.deck, path: a });
    await r.answerNext(true);
    await ok;
    // subfolder: a NEW prompt, and a denial reads nothing
    const denied = toolCall(r.info, 'add_asset', { deck: r.deck, path: sub });
    expect((await r.answerNext(false)).path).toBe(path.resolve(path.dirname(sub)));
    const dr = await denied;
    expect(dr.isError).toBe(true);
    expect(dr.content[0].text).toMatch(/declined/i);
    // sibling folder: also its own prompt, denied
    const denied2 = toolCall(r.info, 'add_asset', { deck: r.deck, path: sibling });
    await r.answerNext(false);
    expect((await denied2).isError).toBe(true);
    // the image grant did not widen the deck sandbox: a deck in the approved folder is unreachable
    const before = r.confirms().length;
    const list = await toolCall(r.info, 'list_chunks', { deck: siblingDeck });
    expect(list.isError).toBe(true);
    expect(r.confirms()).toHaveLength(before);
  } finally {
    await fs.rm(path.dirname(sibling), { recursive: true, force: true }).catch(() => {});
  }
});

it('add_asset: the grant covers images only and is revocable (revokeImageReads, and disarm)', async () => {
  const r = await imageConsentRig();
  const a = await r.img(r.outside, 'a.png');
  const ok = callJson(r.info, 'add_asset', { deck: r.deck, path: a });
  await r.answerNext(true);
  await ok;
  // a non-image file in the approved folder is refused by add_asset before any read
  const txt = path.join(r.outside, 'secret.txt');
  await fs.writeFile(txt, 'x');
  const bad = await toolCall(r.info, 'add_asset', { deck: r.deck, path: txt });
  expect(bad.isError).toBe(true);
  expect(r.confirms()).toHaveLength(1);
  // revoke -> the same folder prompts again
  r.author.revokeImageReads();
  const again = callJson(r.info, 'add_asset', { deck: r.deck, path: a, name: 'again' });
  await r.answerNext(true);
  expect((await again).assetId).toBeTruthy();
  expect(r.confirms()).toHaveLength(2);
});

it('add_asset: a link inside an approved folder that points OUTSIDE it is judged by its real folder (prompts / refused)', async (ctx) => {
  const r = await imageConsentRig();
  const approved = path.join(r.outside, 'approved');
  const secret = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-imgsecret-'));
  try {
    const ok = await r.img(approved, 'a.png');
    const target = await r.img(secret, 'secret.png');
    const link = path.join(approved, 'link.png');
    const dirLink = path.join(approved, 'linkdir');
    const attempt = async (fn: () => Promise<void>): Promise<boolean> => fn().then(() => true, () => false);
    // a file symlink needs a privilege on Windows; a directory junction does not
    const fileLinked = await attempt(() => fs.symlink(target, link, 'file'));
    const dirLinked = await attempt(() => fs.symlink(secret, dirLink, 'junction'));
    if (!fileLinked && !dirLinked) {
      ctx.skip('neither a file symlink nor a directory junction can be created in this environment');
      return;
    }
    const first = callJson(r.info, 'add_asset', { deck: r.deck, path: ok });
    await r.answerNext(true);
    await first;
    expect(r.confirms()).toHaveLength(1);
    // file symlink -> secret.png: NOT covered by the approved folder; prompts for the REAL folder, denied
    if (fileLinked) {
      const viaFile = toolCall(r.info, 'add_asset', { deck: r.deck, path: link });
      const p1 = await r.answerNext(false);
      expect(p1.path).toBe(await fs.realpath(secret));
      expect((await viaFile).isError).toBe(true);
    }
    // directory link -> secret/: same
    if (dirLinked) {
      const viaDir = toolCall(r.info, 'add_asset', { deck: r.deck, path: path.join(dirLink, 'secret.png') });
      const p2 = await r.answerNext(false);
      expect(p2.path).toBe(await fs.realpath(secret));
      expect((await viaDir).isError).toBe(true);
    }
  } finally {
    await fs.rm(secret, { recursive: true, force: true }).catch(() => {});
  }
});

it("add_asset: a '..' traversal out of an approved folder is judged by where it lands", async () => {
  const r = await imageConsentRig();
  const approved = path.join(r.outside, 'approved');
  const other = path.join(r.outside, 'other');
  const ok = await r.img(approved, 'a.png');
  await r.img(other, 'x.png');
  const first = callJson(r.info, 'add_asset', { deck: r.deck, path: ok });
  await r.answerNext(true);
  await first;
  const sneaky = approved + path.sep + '..' + path.sep + 'other' + path.sep + 'x.png';
  const call = toolCall(r.info, 'add_asset', { deck: r.deck, path: sneaky });
  const p = await r.answerNext(false);
  expect(p.path).toBe(await fs.realpath(other));
  expect((await call).isError).toBe(true);
  expect(r.confirms()).toHaveLength(2);
});

/* t-u6cons: the task scope the Studio sets is enforced by the helper's MCP port, not by the UI.
   An agent posting a raw request still cannot write outside it; a malformed scope never widens. */
it('set-scope: a read-only task refuses create_deck over the real port; clearing it restores writes; disarm clears it', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-scope-'));
  const author = createAuthorSession(() => {}, { configPath: path.join(tmp, 'live.json'), port: 0 });
  const info = await author.arm();
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };

  expect(author.setScope({ mode: 'read-only' })).toEqual({ ok: true, scope: 'read-only — no writes' });
  const refused = await callJson(info, 'create_deck', { title: 'Blocked' });
  expect(refused.error).toMatch(/outside the task scope/);
  expect((await fs.readdir(info.dir)).filter((f) => f.endsWith('.origami.html'))).toEqual([]);

  // a malformed scope is refused and the read-only scope stays in force
  expect(author.setScope({ mode: 'everything' }).ok).toBe(false);
  expect((await callJson(info, 'create_deck', { title: 'Still blocked' })).error).toMatch(/outside the task scope/);

  author.setScope(null);
  expect((await callJson(info, 'create_deck', { title: 'Allowed' })).created).toMatch(/allowed\.origami\.html$/i);

  author.setScope({ mode: 'read-only' });
  await author.disarm();
  expect(author.scope).toBeNull();
});
