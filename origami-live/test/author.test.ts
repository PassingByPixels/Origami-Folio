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
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAuthorSession } from '../src/host';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

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

  // the discovery file an agent reads carries the live url + token
  const disco = JSON.parse(await fs.readFile(cfg, 'utf8'));
  expect(disco.url).toBe(info.url);
  expect(disco.token).toBe(info.token);
  expect(disco.workingDir).toBe(info.dir);

  // an external agent connects to the port and creates a deck from nothing
  const client = new Client({ name: 'arm-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: `Bearer ${info.token}` } },
    })
  );
  const made = JSON.parse(
    ((await client.callTool({ name: 'create_deck', arguments: { title: 'Relayed' } })) as any).content[0].text
  );
  expect(made.created).toMatch(/relayed\.origami\.html$/i);

  // the working-dir watch pushed the new deck's BYTES to the extension (relay-update)
  await vi.waitFor(
    () => expect(pushes.some((p) => p.type === 'relay-update')).toBe(true),
    { timeout: 4000, interval: 100 }
  );
  const update = pushes.find((p) => p.type === 'relay-update')!;
  expect(String(update.name)).toMatch(/relayed\.origami\.html$/i);
  expect(String(update.html)).toContain('<script id="origami-runtime">'); // real, openable deck bytes

  await client.close();
  await author.disarm();
  // disarm removes the discovery file (the port is closed too)
  await expect(fs.readFile(cfg, 'utf8')).rejects.toThrow();
});
