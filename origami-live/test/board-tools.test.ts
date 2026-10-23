/**
 * t-7q01c9: the MCP surface the helper serves on :8765 must include the Board tools.
 * 0.2.5 shipped the deck tools only, so an agent connected through the helper could not
 * build a board. This arms the SAME author session the host runs and asserts on the real
 * tools/list reply — a stale helper cannot pass this check.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from 'origami-mcp';
import { createAuthorSession } from '../src/host';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** A raw stateless tools/list request, exactly what an external MCP client posts to the port. */
async function listTools(conn: { url: string }): Promise<Array<{ name: string }>> {
  const res = await fetch(conn.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  expect(res.status).toBe(200);
  expect(body.result?.tools).toBeTruthy();
  return body.result!.tools!;
}

it('the served MCP surface carries the board family and keeps the deck tools', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'origami-board-tools-'));
  const author = createAuthorSession(() => {}, { configPath: path.join(tmp, 'live.json'), port: 0 });
  const info = await author.arm();
  cleanup = async () => {
    await author.disarm();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };

  const names = new Set((await listTools(info)).map((t) => t.name));

  // the representative set named by the ticket, including the 0.5.23 additions
  for (const name of ['board_fold_create', 'board_add_nodes', 'board_render', 'board_get', 'board_frames', 'board_export', 'board_group', 'board_ungroup', 'board_icon_import']) {
    expect(names.has(name), `missing ${name}`).toBe(true);
  }
  // the whole family, not a couple of stragglers — 0.2.5 served zero board tools
  expect([...names].filter((n) => n.startsWith('board_')).length).toBeGreaterThanOrEqual(40);

  // the deck tools 0.2.5 did serve stay on the surface
  for (const name of ['create_deck', 'origami_guide']) expect(names.has(name), `missing ${name}`).toBe(true);
});
