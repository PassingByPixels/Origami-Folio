// End-to-end check of the BUILT exe (t-cd5nec): add_asset of a 4000px JPEG through the exe's
// own MCP port must be downscaled to <=1920 and re-encoded by the sharp copy the exe carries.
// Runs a COPY of dist/OrigamiLive.exe from a temp folder, as Chrome would (native-message
// frames on stdin/stdout), with USERPROFILE/LOCALAPPDATA in that folder and the MCP port on an
// ephemeral port, so an installed helper (port 8765, ~/.origami/live.json) is never touched.
// Two launches: the first unpacks sharp, the second must reuse the unpacked copy.
// Run: npm -w origami-serve run build:exe && npm -w origami-serve run test:exe
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const exeSrc = fileURLToPath(new URL('../dist/OrigamiLive.exe', import.meta.url));
assert.ok(existsSync(exeSrc), 'build the exe first: npm -w origami-serve run build:exe');
const tmp = mkdtempSync(path.join(tmpdir(), 'origami-exe-sharp-'));
const exe = path.join(tmp, 'OrigamiLive-test.exe');
copyFileSync(exeSrc, exe);

function launch() {
  const child = spawn(exe, ['chrome-extension://testextensionid/'], {
    env: { ...process.env, USERPROFILE: path.join(tmp, 'home'), LOCALAPPDATA: path.join(tmp, 'local'), ORIGAMI_LIVE_PORT: '0' },
    cwd: tmp, // never a folder with node_modules above it: the exe must not find a dev sharp
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let acc = Buffer.alloc(0);
  const waiting = [];
  const replies = [];
  child.stdout.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4 && acc.length >= 4 + acc.readUInt32LE(0)) {
      const len = acc.readUInt32LE(0);
      const msg = JSON.parse(acc.subarray(4, 4 + len).toString('utf8'));
      acc = acc.subarray(4 + len);
      if (msg.type === 'relay-update' || msg.type === 'relay-open') continue; // host pushes, not replies
      const w = waiting.shift();
      w ? w(msg) : replies.push(msg);
    }
  });
  const send = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([head, body]));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${msg.cmd}`)), 20000);
      const done = (m) => (clearTimeout(t), resolve(m));
      replies.length ? done(replies.shift()) : waiting.push(done);
    });
  };
  return { child, send };
}

async function callJson(url, name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/client': { name: 'exe-e2e', version: '0.0.0' } } },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { isError: body.result.isError === true, data: JSON.parse(body.result.content[0].text) };
}

// A 4000x3000 photo-like JPEG (noise defeats any trivial size win).
const src = await sharp(Buffer.alloc(400 * 300 * 3).map(() => Math.floor(Math.random() * 256)), { raw: { width: 400, height: 300, channels: 3 } })
  .resize(4000, 3000, { kernel: 'nearest' })
  .jpeg({ quality: 95 })
  .toBuffer();

async function round(label) {
  const { child, send } = launch();
  try {
    const arm = await send({ cmd: 'arm' });
    assert.equal(arm.ok, true, JSON.stringify(arm));
    console.log(`${label}: armed ${arm.url} (helper ${arm.version})`);
    const deck = (await callJson(arm.url, 'create_deck', { title: 'Exe sharp' })).data.created;
    const t0 = Date.now();
    const added = await callJson(arm.url, 'add_asset', { deck, dataBase64: src.toString('base64'), mime: 'image/jpeg', name: 'photo' });
    const ms = Date.now() - t0;
    assert.equal(added.isError, false, JSON.stringify(added.data));
    const html = readFileSync(deck, 'utf8');
    const m = html.match(/data:(image\/jpeg);base64,([A-Za-z0-9+/=]+)/);
    assert.ok(m, 'no JPEG data: URL asset in the deck'); // the blank deck already carries SVG art
    const stored = Buffer.from(m[2], 'base64');
    const meta = await sharp(stored).metadata();
    assert.equal(m[1], 'image/jpeg');
    assert.equal(meta.format, 'jpeg');
    assert.ok(meta.width <= 1920 && meta.height <= 1080, `stored ${meta.width}x${meta.height}`);
    assert.ok(stored.length < src.length, 're-encoded bytes must be smaller than the 4000px source');
    console.log(`${label}: add_asset ${ms} ms, source 4000x3000 ${src.length} B -> stored ${meta.width}x${meta.height} ${meta.format} ${stored.length} B`);
  } finally {
    child.kill();
  }
}

try {
  await round('launch 1');
  const unpacked = readdirSync(path.join(tmp, 'local', 'OrigamiLive'));
  assert.equal(unpacked.length, 1, `one unpacked sharp folder, got ${unpacked}`);
  const marker = path.join(tmp, 'local', 'OrigamiLive', unpacked[0], '.complete');
  const firstMtime = statSync(marker).mtimeMs;
  console.log(`unpacked to %LOCALAPPDATA%\\OrigamiLive\\${unpacked[0]}`);
  await round('launch 2');
  assert.equal(statSync(marker).mtimeMs, firstMtime, 'second launch must reuse the unpacked copy');
  assert.deepEqual(readdirSync(path.join(tmp, 'local', 'OrigamiLive')), unpacked, 'no extra folders');
  console.log('PASS exe-sharp e2e');
} finally {
  await new Promise((r) => setTimeout(r, 500)); // let the killed exe release its file locks
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
