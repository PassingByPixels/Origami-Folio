/* THE ALLOW-LIST CHROME READS.

   Native messaging is origin-gated: Chrome hands the host a `chrome-extension://<id>/` origin and
   refuses the connection outright unless that exact origin is in the manifest's `allowed_origins`.
   The add-on has TWO legitimate ids — the Web Store's, and the unpacked dev build's, pinned by the
   manifest `key` the store package strips — and through v0.1.4 the shipped exe registered only the
   dev one. Nothing failed at build time and nothing failed for a developer, because a developer
   runs the unpacked build; it failed for every Web Store user, whose "Go Live" could not connect.

   These assert the allow-list itself rather than the write, which is why `nativeManifest` is its
   own function: a test that drove `selfInstall` would need the disk and HKCU, and would prove the
   file was written rather than what it permits. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { nativeManifest, resolveExtensionIds } from '../src/host.js';

/** The published Chrome Web Store id — the one a normal user installs. */
const STORE_ID = 'flhbdfakcooaomfaehhgenmmnlglhehk';
/** The unpacked dev id, derived by Chrome from the manifest `key`. */
const DEV_ID = 'oghflmdefaljpkmdeeijbjbhofadhkli';

const origins = (ids: string[]): unknown => nativeManifest('C:\\OrigamiLive\\OrigamiLive.exe', ids).allowed_origins;
const freshDir = (): string => mkdtempSync(path.join(tmpdir(), 'origami-live-'));

describe('native-messaging allow-list', () => {
  it('permits BOTH the Web Store add-on and the unpacked dev build out of the box', () => {
    // no env, no sidecar — exactly what a user who downloads the exe and double-clicks it gets
    const ids = resolveExtensionIds(freshDir(), undefined);
    expect(ids, 'the Web Store id is what a normal install connects from').toContain(STORE_ID);
    expect(ids, 'the unpacked dev id has to keep working for development').toContain(DEV_ID);
    expect(origins(ids)).toEqual([`chrome-extension://${STORE_ID}/`, `chrome-extension://${DEV_ID}/`]);
  });

  it('names the exe Chrome should launch, as a stdio host', () => {
    const m = nativeManifest('C:\\OrigamiLive\\OrigamiLive.exe', resolveExtensionIds(freshDir(), undefined));
    expect(m.name).toBe('com.origami.live');
    expect(m.type).toBe('stdio');
    expect(m.path).toBe('C:\\OrigamiLive\\OrigamiLive.exe');
  });

  it('lets a custom build REPLACE the pair from the environment, one id or several', () => {
    expect(resolveExtensionIds(freshDir(), 'aaaabbbbccccddddeeeeffffgggghhhh')).toEqual([
      'aaaabbbbccccddddeeeeffffgggghhhh',
    ]);
    // a list is accepted by either separator, and whitespace around entries is not an id
    expect(resolveExtensionIds(freshDir(), ' aaaa, bbbb \n cccc ')).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('reads the same override from an extension-id.txt beside the exe', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'extension-id.txt'), `${STORE_ID}\n`, 'utf8');
    expect(resolveExtensionIds(dir, undefined)).toEqual([STORE_ID]);
  });

  it('falls back to the shipped pair when an override is present but empty', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'extension-id.txt'), '   \n', 'utf8');
    // a blank sidecar must not produce `chrome-extension:///`, which would allow nothing at all
    expect(resolveExtensionIds(dir, '  ')).toEqual([STORE_ID, DEV_ID]);
  });
});
