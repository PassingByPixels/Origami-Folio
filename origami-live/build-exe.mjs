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
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/* sharp (add_asset's image library) is native: the exe cannot require it from the bundle.
   Embed its package tree (sharp, its JS deps, this platform's @img/sharp-<os>-<arch> with the
   .node addon + libvips DLLs) as SEA assets plus a manifest; src/sea-sharp.ts unpacks it on
   first use (t-cd5nec). Types, docs, ESM twins and C++ sources are not needed at run time. */
function sharpAssets() {
  // Node's own resolution: the nearest node_modules/<name> walking up (exports maps hide package.json).
  const findPackage = (name, fromDir) => {
    for (let d = fromDir; ; d = path.dirname(d)) {
      const candidate = path.join(d, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return candidate;
      if (path.dirname(d) === d) throw new Error(`build-exe: cannot find ${name} from ${fromDir}`);
    }
  };
  const skip = /(\.md|\.d\.[cm]?ts|\.mjs)$/i;
  const assets = {};
  const hash = createHash('sha256');
  const seen = new Set();
  const addPackage = (name, fromDir) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkgJson = findPackage(name, fromDir);
    const dir = path.dirname(pkgJson);
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!f.isFile() || skip.test(f.name)) continue;
      const abs = path.join(f.parentPath, f.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (name === 'sharp' && /^(src|install)\//.test(rel)) continue;
      const key = `node_modules/${name}/${rel}`;
      assets[key] = abs;
      hash.update(key).update(readFileSync(abs));
    }
    const deps = Object.keys(pkg.dependencies ?? {});
    if (name === 'sharp') deps.push(`@img/sharp-${process.platform}-${process.arch}`);
    for (const d of deps) addPackage(d, dir);
  };
  addPackage('sharp', path.dirname(findPackage('origami-mcp', here)));
  const version = JSON.parse(readFileSync(assets['node_modules/sharp/package.json'], 'utf8')).version;
  const manifest = { tag: `${version}-${hash.digest('hex').slice(0, 12)}`, files: Object.keys(assets) };
  const manifestPath = path.join(here, 'dist', 'sharp-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { ...assets, 'sharp-manifest.json': manifestPath };
}

run(node, ['build.mjs']);                                      // fresh dist/host.cjs (welcome inlined)
const seaConfig = path.join(here, 'dist', 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ ...JSON.parse(readFileSync(path.join(here, 'sea-config.json'), 'utf8')), assets: sharpAssets() }, null, 2)
);
run(node, ['--experimental-sea-config', seaConfig]);            // -> dist/sea-prep.blob
copyFileSync(node, exe);                                        // clone the Node runtime as the exe
// postject runs via npx (a .cmd on Windows). Use a single quoted shell string so
// Node spawns the .cmd cleanly and doesn't warn about un-escaped args (DEP0190).
execSync(`npx --yes postject "${exe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${FUSE}`, {
  cwd: here,
  stdio: 'inherit',
});
console.log('Origami Live exe built -> ' + exe);
