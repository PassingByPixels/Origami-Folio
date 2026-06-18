// Package the native-messaging host (dist/host.cjs) into a standalone Windows
// executable via Node SEA (Single Executable Application) — so users need no Node,
// npm or PowerShell: one download, one double-click. The welcome page is inlined
// into host.cjs (see build.mjs), so this stays a single self-contained .exe.
//
// NO code-signing: the helper is free + source-available, and SmartScreen is handled by
// honest framing (welcome.html + the GitHub release notes), not a paid certificate.
//
// Run: npm run build:exe   ->   dist/OrigamiLive.exe
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const exe = path.join(here, 'dist', 'OrigamiLive.exe');
const blob = path.join(here, 'dist', 'sea-prep.blob');
// Fixed sentinel Node ships in its binary for SEA; postject flips it. Wrong value =>
// postject fails to find it, which is itself the check that the blob is wired right.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const run = (cmd, args, opts) => execFileSync(cmd, args, { cwd: here, stdio: 'inherit', ...opts });

run(node, ['build.mjs']);                                      // fresh dist/host.cjs (welcome inlined)
run(node, ['--experimental-sea-config', 'sea-config.json']);   // -> dist/sea-prep.blob
copyFileSync(node, exe);                                        // clone the Node runtime as the exe
// postject runs via npx (a .cmd on Windows). Use a single quoted shell string so
// Node spawns the .cmd cleanly and doesn't warn about un-escaped args (DEP0190).
execSync(`npx --yes postject "${exe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${FUSE}`, {
  cwd: here,
  stdio: 'inherit',
});
console.log('Origami Live exe built -> ' + exe);
