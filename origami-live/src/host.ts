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
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { serveHttp, type HttpServeHandle, type AuthorBridge } from 'origami-mcp';
import { createDeckServer, listenLoopback, listenLan, lanAddress } from './server.js';
import { WELCOME_HTML } from './welcome-html.js';

/* 0.2.0 ships the tokenless MCP port (Origin/Host guard instead of a bearer token), so the
   arm reply and live.json no longer carry a token. An older helper still REQUIRES a token and
   would fail with the new extension, which is why the extension's REQUIRED_HELPER moves to
   0.2.0 with it. The arm flow itself is otherwise unchanged (temp working dir, live.json,
   loopback 8765). */
export const HOST_VERSION = '0.2.1';

/** How long open_deck waits for the user to approve in the browser before giving up (deny). */
const CONFIRM_TIMEOUT_MS = 120_000;

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

/* ---------- the armed authoring session (the MCP "port") ----------
   When the browser addon ARMS, the host opens a loopback MCP /mcp port over a
   working dir it owns (serveHttp from @origami/mcp), writes the url to
   ~/.origami/live.json for the agent to read, and watches the dir. Whenever the
   agent's create_deck / save_deck writes a deck there, the host pushes the bytes
   to the armed extension over the native port (relay-update) — the Studio adopts
   them live. The agent never touches the browser; arming is the consent. */

/** The discovery file the external agent reads for the loopback URL. */
function liveConfigPath(): string {
  return path.join(homedir(), '.origami', 'live.json');
}

interface ArmState {
  http: HttpServeHandle;
  dir: string;
  watcher?: FSWatcher;
}

/** Manages the armed MCP port + the working-dir watch → relay-update push. `push`
    frames a message onto the native port (host → extension). Separate from the
    Go-Live session so arming and Go-Live are independent. `opts` are injectable for
    tests (real arming uses the defaults: the fixed port + ~/.origami/live.json). */
export function createAuthorSession(
  push: (msg: unknown) => void,
  opts: { configPath?: string; port?: number } = {}
) {
  const configPath = opts.configPath ?? liveConfigPath();
  // fixed loopback port so a static MCP client config (a URL in a config file) keeps
  // working across arms — the URL is the whole connection now (tokenless).
  const port = opts.port ?? 8765;
  let state: ArmState | null = null;
  let debounce: NodeJS.Timeout | undefined;
  // open_deck consent round-trips: requestId → the resolver waiting on the browser's answer.
  const pendingConfirms = new Map<string, (approved: boolean) => void>();
  // per-approved-file watchers, so a save_deck to a real file re-pushes it to the relay tab.
  const openWatchers = new Map<string, FSWatcher>();
  // per-file debounce timers (a single shared timer would let one file's save cancel another's push).
  const openDebounce = new Map<string, NodeJS.Timeout>();

  /** Read a deck file and push its bytes to the relay tab (host → extension over the native port). */
  async function pushFile(absFile: string): Promise<void> {
    if (!state) return;
    try {
      const html = await readFile(absFile, 'utf8');
      push({ type: 'relay-update', name: path.basename(absFile), html });
    } catch {
      /* file mid-write (atomic rename in flight) — the next watch event re-reads */
    }
  }
  const pushDeck = (file: string): Promise<void> =>
    state ? pushFile(path.join(state.dir, file)) : Promise.resolve();

  /** The host hook open_deck uses: ask the browser to approve a real file, then mirror it live.
      requestOpen is the consent gate; onOpened starts the watch-and-push once approved. */
  const bridge: AuthorBridge = {
    requestOpen(absPath: string): Promise<boolean> {
      // one consent prompt at a time — the relay tab shows a single banner, so a second
      // concurrent open_deck would clobber the first. Reject it clearly instead of hanging.
      if (pendingConfirms.size > 0) {
        return Promise.reject(
          new Error('another deck is awaiting your approval in the browser — answer that prompt first, then retry')
        );
      }
      return new Promise<boolean>((resolve) => {
        const requestId = randomBytes(8).toString('hex');
        let settled = false;
        const finish = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingConfirms.delete(requestId);
          resolve(approved);
        };
        const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS); // no answer → deny (safe-fail)
        pendingConfirms.set(requestId, finish);
        push({ type: 'relay-confirm', kind: 'open', path: absPath, requestId });
      });
    },
    onOpened(absPath: string): void {
      // show it in the relay tab right away, then watch its dir (filtered to this file's name)
      // so each save_deck write re-pushes — the same live path create_deck rides.
      void pushFile(absPath);
      if (openWatchers.has(absPath)) return;
      try {
        const dir = path.dirname(absPath);
        const base = path.basename(absPath);
        const w = watch(dir, { persistent: false }, (_event, fname) => {
          if (fname && path.basename(String(fname)) !== base) return; // ignore sibling files
          clearTimeout(openDebounce.get(absPath)); // per-file timer: one file's save never cancels another's
          openDebounce.set(
            absPath,
            setTimeout(() => {
              openDebounce.delete(absPath);
              void pushFile(absPath);
            }, 120) // absorb the atomic-rename burst
          );
        });
        openWatchers.set(absPath, w);
      } catch {
        /* fs.watch unsupported here — still editable, just no live re-push on save */
      }
    },
  };

  return {
    get armed(): boolean {
      return state !== null;
    },
    info(): { url: string; dir: string } | null {
      return state ? { url: state.http.url, dir: state.dir } : null;
    },
    async arm(): Promise<{ url: string; dir: string }> {
      if (state) return { url: state.http.url, dir: state.dir };
      const dir = await mkdtemp(path.join(tmpdir(), 'origami-author-'));
      const http = await serveHttp([dir], { port }, bridge);
      state = { dir, http };
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ url: http.url, workingDir: dir, pid: process.pid }, null, 2),
        'utf8'
      );
      try {
        state.watcher = watch(dir, { persistent: false }, (_event, fname) => {
          const name = fname ? String(fname) : '';
          if (!/\.origami\.html$/i.test(name)) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => void pushDeck(name), 120); // absorb the atomic-rename burst
        });
      } catch {
        /* fs.watch unsupported here — the agent still authors; just no live push */
      }
      return { url: http.url, dir };
    },
    /** Route the browser's answer to an open_deck consent prompt back to the waiting tool. */
    resolveConfirm(requestId: string, approved: boolean): void {
      pendingConfirms.get(requestId)?.(approved);
    },
    async disarm(): Promise<void> {
      if (!state) return;
      const s = state;
      state = null;
      clearTimeout(debounce);
      for (const t of openDebounce.values()) clearTimeout(t);
      openDebounce.clear();
      for (const w of openWatchers.values()) w.close();
      openWatchers.clear();
      for (const finish of pendingConfirms.values()) finish(false); // any pending open → deny
      pendingConfirms.clear();
      s.watcher?.close();
      await s.http.close();
      await rm(configPath, { force: true }).catch(() => {});
    },
  };
}

type Msg = { cmd?: string; name?: string; html?: string; requestId?: string; approved?: boolean };

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
  const author = createAuthorSession(writeMessage);
  let acc = Buffer.alloc(0);
  let draining = false;

  /** arm/disarm/arm-status drive the authoring port; everything else is Go-Live. */
  async function dispatch(msg: Msg): Promise<Record<string, unknown>> {
    switch (msg.cmd) {
      case 'arm':
        // include the helper version so the extension can nudge an old (e.g. 0.1.2, no open_deck) helper to update
        return { ok: true, version: HOST_VERSION, ...(await author.arm()) };
      case 'disarm':
        await author.disarm();
        return { ok: true };
      case 'arm-status':
        return { ok: true, armed: author.armed, ...(author.info() ?? {}) };
      case 'relay-confirm-reply':
        author.resolveConfirm(String(msg.requestId ?? ''), msg.approved === true);
        return { ok: true };
      default:
        return handleMessage(session, msg);
    }
  }

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
          reply = await dispatch(JSON.parse(json));
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
  // Chrome closed the port (tab/extension gone): disarm + tear the server down and exit.
  process.stdin.on('end', () => void Promise.all([author.disarm(), session.stop()]).then(() => process.exit(0)));
}

/* ---------- self-install (the packaged exe is its own installer) ----------
   Double-clicked, the .exe registers itself: it writes the native-messaging
   manifest next to itself (pointing at itself) + the HKCU registry keys that
   Chrome/Brave/Edge read. Launched again by Chrome (native messaging), it's the
   host. One file, one double-click — no npm/PowerShell/Node needed by the user. */

const HOST_NAME = 'com.origami.live';
/* THE EXTENSIONS THIS HOST ACCEPTS MESSAGES FROM — BOTH OF THEM, BY DEFAULT.
   There are two legitimate ids for the same add-on. The unpacked dev build's is PINNED by the
   manifest `key` (packages/extension/static/manifest.json), so it is stable; the Chrome Web Store
   assigns its OWN at first publish, because the packaged zip deliberately strips that key.
   Registering only the dev id — which is what shipped through v0.1.4 — meant Chrome refused the
   native-messaging connect for every WEB STORE install: the caller's origin simply was not on the
   list, so "Go Live" failed for everyone who did not build the add-on themselves. The override
   below existed, but a user has no way to know they need it. So both ship.
   Still overridable for a custom build: set ORIGAMI_EXTENSION_ID, or drop ids in
   `extension-id.txt` next to the exe (comma- or whitespace-separated), then re-run it to
   re-register. An override REPLACES this pair rather than adding to it. */
const STORE_EXTENSION_ID = 'flhbdfakcooaomfaehhgenmmnlglhehk';
const DEV_EXTENSION_ID = 'oghflmdefaljpkmdeeijbjbhofadhkli';
const DEFAULT_EXTENSION_IDS = [STORE_EXTENSION_ID, DEV_EXTENSION_ID];

const parseIds = (raw: string): string[] => raw.split(/[,\s]+/).filter((id) => id.length > 0);

export function resolveExtensionIds(exeDir: string, env = process.env.ORIGAMI_EXTENSION_ID): string[] {
  const fromEnv = parseIds(env ?? '');
  if (fromEnv.length) return fromEnv;
  try {
    const fromSidecar = parseIds(readFileSync(path.join(exeDir, 'extension-id.txt'), 'utf8'));
    if (fromSidecar.length) return fromSidecar;
  } catch {
    /* no sidecar — ship the pinned pair */
  }
  return DEFAULT_EXTENSION_IDS;
}

/** The native-messaging manifest Chrome reads, as an object — separated from the write so the
    allow-list can be asserted without touching the disk or the registry. */
export function nativeManifest(exe: string, ids: string[]): Record<string, unknown> {
  return {
    name: HOST_NAME,
    description: 'Origami Live - serves the current deck on localhost so it plays like a real web page',
    path: exe,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
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
  const ids = resolveExtensionIds(path.dirname(exe));
  writeFileSync(manifestPath, JSON.stringify(nativeManifest(exe, ids), null, 2), 'utf8');
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
