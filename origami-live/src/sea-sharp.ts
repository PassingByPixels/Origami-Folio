/* sharp inside the Origami Live exe (t-cd5nec).
   A Node SEA binary resolves `require` to builtins only, so the native sharp addon cannot
   be imported from the bundle (ERR_UNKNOWN_BUILTIN_MODULE). build-exe.mjs embeds sharp's
   package tree (JS + sharp-*.node + the libvips DLLs) as SEA assets with a manifest. On the
   first raster add_asset this unpacks that tree once to a versioned folder under
   %LOCALAPPDATA%\OrigamiLive and loads it with a disk-backed require. Later starts reuse it.
   Nothing runs at startup, so the exe starts as fast as before. */
import { createRequire } from 'node:module';
import * as sea from 'node:sea';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type SharpFn from 'sharp';

export const SHARP_MANIFEST_KEY = 'sharp-manifest.json';

interface Manifest {
  /** sharp version + a hash of every embedded file: a changed tree unpacks to a new folder. */
  tag: string;
  /** asset keys = paths relative to the unpack root (node_modules/<pkg>/...). */
  files: string[];
}

/** Write every embedded file to a fresh folder, then rename it into place. A second helper
    that races us loses the rename and uses the winner's copy. */
async function unpack(root: string, manifest: Manifest): Promise<void> {
  const staging = `${root}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    for (const key of manifest.files) {
      const out = path.join(staging, ...key.split('/'));
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(sea.getRawAsset(key)));
    }
    await writeFile(path.join(staging, '.complete'), manifest.tag, 'utf8');
    try {
      await rename(staging, root);
    } catch (e) {
      if (!existsSync(path.join(root, '.complete'))) throw e;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** The loader for setSharpLoader in a SEA build, or null when this is not a SEA build or the
    build carries no sharp (then the default import, or its clear error, applies). */
export function seaSharpLoader(baseDir = process.env.LOCALAPPDATA ?? tmpdir()): (() => Promise<typeof SharpFn>) | null {
  if (!sea.isSea()) return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(sea.getAsset(SHARP_MANIFEST_KEY, 'utf8')) as Manifest;
  } catch {
    return null;
  }
  let loaded: Promise<typeof SharpFn> | undefined;
  return () =>
    (loaded ??= (async () => {
      const root = path.join(baseDir, 'OrigamiLive', `sharp-${manifest.tag}`);
      if (!existsSync(path.join(root, '.complete'))) await unpack(root, manifest);
      return createRequire(path.join(root, 'loader.cjs'))('sharp') as typeof SharpFn;
    })().catch((e) => {
      loaded = undefined; // a failed unpack (disk full, AV lock) may succeed on the next call
      throw e;
    }));
}
