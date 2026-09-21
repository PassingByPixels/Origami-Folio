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
