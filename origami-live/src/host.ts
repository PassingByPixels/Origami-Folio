/* Origami Live — the native-messaging host (one-click "Go Live").

   An MV3 extension can't open a listening socket, so the Studio's Go Live talks to
   this small helper over Chrome native messaging (length-prefixed JSON on stdio).
   The Studio hands over the deck BYTES (an FSA handle never exposes the OS path, so
   we can't be told a path) — the host writes them to a temp file and serves that
   folder with `--live`, returning the http URL. On every save the Studio sends the
   new bytes; the host overwrites the temp file, its watcher fires, the served page
   rebuilds. One install, then Go Live is one click.

   Protocol (each message is uint32-LE length + UTF-8 JSON):
     -> { cmd: 'ping' }                 <- { ok, version }
     -> { cmd: 'serve', name, html }    <- { ok, url }   (idempotent: re-serves the bytes)
     -> { cmd: 'update', html }         <- { ok }        (rebuild the live page)
     -> { cmd: 'stop' }                 <- { ok }
*/
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { createDeckServer, listenLoopback, listenLan, lanAddress } from './server.js';
import { WELCOME_HTML } from './welcome-html.js';

export const HOST_VERSION = '0.1.0';

interface LiveState {
  server: Server;
  dir: string;
  url: string;
  deckName: string;
  lan?: { server: Server; url: string; token: string };
}

/** Keep the served file name deck-like and path-safe (it's attacker-influenced text). */
function safeName(name: string): string {
  const base = path.basename(String(name || 'deck.origami.html')).replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.html?$/i.test(base) ? base : base + '.origami.html';
}

/** The live session: one temp dir + one --live server, reused across updates. */
export function createLiveSession() {
  let state: LiveState | null = null;

  return {
    get url() {
      return state?.url ?? null;
    },
    async serve(name: string, html: string): Promise<string> {
      if (!state) {
        const dir = await mkdtemp(path.join(tmpdir(), 'origami-live-'));
        const deckName = safeName(name);
        await writeFile(path.join(dir, deckName), html, 'utf8');
        const server = createDeckServer({ root: dir, indexFile: deckName, live: true });
        const port = await listenLoopback(server, 8787);
        state = { server, dir, url: `http://127.0.0.1:${port}/`, deckName };
      } else {
        await writeFile(path.join(state.dir, state.deckName), html, 'utf8');
      }
      return state.url;
    },
    async update(html: string): Promise<void> {
      if (state) await writeFile(path.join(state.dir, state.deckName), html, 'utf8');
    },
    /** Also serve the SAME temp deck on the LAN, gated by a random token (a second
        server, so "stop sharing" leaves the loopback session running). View-only by
        construction: the only write path is `update` over stdio, never HTTP. */
    async shareLan(): Promise<{ url: string; token: string } | null> {
      if (!state) return null; // nothing live to share yet
      if (state.lan) return { url: state.lan.url, token: state.lan.token }; // idempotent
      const addr = lanAddress();
      if (!addr) return null; // no non-loopback network found
      const token = randomBytes(16).toString('base64url');
      const server = createDeckServer({ root: state.dir, indexFile: state.deckName, live: true, token });
      const port = await listenLan(server, 8788);
      const url = `http://${addr}:${port}/${token}/`;
      state.lan = { server, url, token };
      return { url, token };
    },
    async stopLan(): Promise<void> {
      if (!state?.lan) return;
      const { server } = state.lan;
      state.lan = undefined;
      await new Promise<void>((r) => server.close(() => r()));
    },
    async stop(): Promise<void> {
      if (!state) return;
      const { server, dir, lan } = state;
      state = null;
      if (lan) await new Promise<void>((r) => lan.server.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type Msg = { cmd?: string; name?: string; html?: string };

export async function handleMessage(
  session: ReturnType<typeof createLiveSession>,
  msg: Msg
): Promise<Record<string, unknown>> {
  switch (msg.cmd) {
    case 'ping':
      return { ok: true, version: HOST_VERSION };
    case 'serve':
      return { ok: true, url: await session.serve(msg.name ?? 'deck.origami.html', msg.html ?? '') };
    case 'update':
      await session.update(msg.html ?? '');
      return { ok: true };
    case 'shareLan': {
      const r = await session.shareLan();
      return r ? { ok: true, lanUrl: r.url, token: r.token } : { ok: false, error: 'no local network found' };
    }
    case 'stopLan':
      await session.stopLan();
      return { ok: true };
    case 'stop':
      await session.stop();
      return { ok: true };
    default:
      return { ok: false, error: `unknown cmd "${msg.cmd}"` };
  }
}

/* ---------- the native-messaging stdio framing ---------- */

function writeMessage(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(len);
  process.stdout.write(body);
}

function runHost(): void {
  const session = createLiveSession();
  let acc = Buffer.alloc(0);
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (acc.length >= 4) {
        const len = acc.readUInt32LE(0);
        if (acc.length < 4 + len) break;
        const json = acc.subarray(4, 4 + len).toString('utf8');
        acc = acc.subarray(4 + len);
        let reply: Record<string, unknown>;
        try {
          reply = await handleMessage(session, JSON.parse(json));
        } catch (e) {
          reply = { ok: false, error: (e as Error).message };
        }
        writeMessage(reply);
      }
    } finally {
      draining = false;
    }
  };

  process.stdin.on('data', (chunk: Buffer) => {
    acc = Buffer.concat([acc, chunk]);
    void drain();
  });
  // Chrome closed the port (tab/extension gone): tear the server down and exit.
  process.stdin.on('end', () => void session.stop().then(() => process.exit(0)));
}

/* ---------- self-install (the packaged exe is its own installer) ----------
   Double-clicked, the .exe registers itself: it writes the native-messaging
   manifest next to itself (pointing at itself) + the HKCU registry keys that
   Chrome/Brave/Edge read. Launched again by Chrome (native messaging), it's the
   host. One file, one double-click — no npm/PowerShell/Node needed by the user. */

const HOST_NAME = 'com.origami.live';
// The extension this host accepts messages from. PINNED via the manifest `key`
// (packages/extension/static/manifest.json), so the unpacked dev id is stable. The
// Chrome Web Store assigns its OWN id at first publish, so this is OVERRIDABLE without
// rebuilding/re-signing the exe: set ORIGAMI_EXTENSION_ID, or drop the published id in
// `extension-id.txt` next to the exe, then re-run it to re-register.
const DEFAULT_EXTENSION_ID = 'oghflmdefaljpkmdeeijbjbhofadhkli';
function resolveExtensionId(exeDir: string): string {
  const env = process.env.ORIGAMI_EXTENSION_ID?.trim();
  if (env) return env;
  try {
    const sidecar = readFileSync(path.join(exeDir, 'extension-id.txt'), 'utf8').trim();
    if (sidecar) return sidecar;
  } catch {
    /* no sidecar — use the pinned default */
  }
  return DEFAULT_EXTENSION_ID;
}
const REG_BASES = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
];

function selfInstall(): void {
  const exe = process.execPath; // the OrigamiLive.exe the user double-clicked
  const manifestPath = path.join(path.dirname(exe), `${HOST_NAME}.json`);
  const extensionId = resolveExtensionId(path.dirname(exe));
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Origami Live - serves the current deck on localhost so it plays like a real web page',
        path: exe,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2
    ),
    'utf8'
  );
  for (const base of REG_BASES) {
    try {
      execFileSync('reg', ['add', `${base}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
        stdio: 'ignore',
      });
    } catch {
      /* that browser isn't installed here — skip it */
    }
  }
  // Drop the branded welcome page beside the exe and open it — this IS the
  // "installer UI": an offline, Origami-styled page explaining what Live unlocks,
  // the security model, and the one-time Windows warning. Best-effort.
  try {
    const welcomePath = path.join(path.dirname(exe), 'welcome.html');
    writeFileSync(welcomePath, WELCOME_HTML, 'utf8');
    execFileSync('cmd', ['/c', 'start', '', welcomePath], { stdio: 'ignore' });
  } catch {
    /* no default browser, or the write failed — the stdout line below is the fallback */
  }
  process.stdout.write('Origami Live is installed.\nReturn to your browser and press "Go Live".\n');
}

/* Entrypoint. Chrome launches us with a chrome-extension:// origin arg -> be the
   host. Run as the dev host.cjs -> host too. A double-clicked packaged exe (no such
   arg, execPath is not node) -> self-install. Imported by a test (execPath is node,
   no extension arg) -> do nothing. */
const calledByChrome = process.argv.some((a) => a.startsWith('chrome-extension://'));
const devHost = /host\.[cm]?js$/.test(process.argv[1] ?? '');
const isPackagedExe = !/[\\/]node(\.exe)?$/i.test(process.execPath);
if (calledByChrome || devHost) runHost();
else if (isPackagedExe) selfInstall();
