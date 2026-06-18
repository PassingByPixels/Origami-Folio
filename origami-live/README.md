# OrigamiLive — source (published for transparency)

This folder is the complete source of **OrigamiLive** — the small local helper
distributed as `OrigamiLive.exe`. It's published here for one reason: so you can
**read exactly what the unsigned executable does before you trust it on your
machine.**

OrigamiLive runs a tiny web server on **`127.0.0.1`** (your machine only) so a
single `.origami.html` deck behaves like a real web page — letting embedded video
and dashboards play, big local videos stream smoothly, and (opt-in) a **view-only**
QR share to devices on your own Wi-Fi. It uploads nothing, needs no account, and
serves a temporary, read-only copy of the open deck.

## Source-available (proprietary)

This source is provided for **inspection and audit only**. OrigamiLive is
proprietary software — © 2026 Origami Labs, all rights reserved (see
[`../LICENSE`](../LICENSE)). You may **read** this code to satisfy yourself about
what the program does. You may **not** copy, modify, redistribute, or reuse it.

We publish it because trust in an unsigned download should come from being able to
read the source — not from blind faith.

## Where to look

- **`src/server.ts`** — the HTTP server. Note it's **read-only** (it only ever
  hands out the page; there is no write path), binds to `127.0.0.1` by default,
  and the LAN-share mode is gated behind a random per-session key
  (`randomBytes(16)`), so a port opened on your network reveals nothing without
  the key from the QR.
- **`src/host.ts`** — the native-messaging host the browser extension talks to;
  it's what receives a deck and starts/stops the server.
- **`src/cli.ts`** — the command-line entry point.
- **`src/welcome-html.ts`** — the post-install welcome page (no network, no
  tracking).
- **`host/setup-host.ps1`** — exactly what gets registered with your browser
  (the native-messaging manifest), so you can see what the install touches.
- **`build.mjs` / `build-exe.mjs` / `sea-config.json`** — how `OrigamiLive.exe`
  is produced (a Node Single-Executable Application), so the released binary can
  be traced back to this source.
- **`test/`** — the test suite (LAN-address selection, the server, the host).

## What it does NOT do

- No telemetry, no analytics, no accounts, no uploads — read `src/server.ts` and
  `src/host.ts` to confirm.
- It doesn't serve your folders — only a temporary copy of the deck you chose to
  go live with.
- LAN sharing is opt-in, per-session, key-gated, and **view-only** by
  construction (the server has no endpoint that writes).

## Building

`build.mjs` (bundle) and `build-exe.mjs` (Node SEA → `dist/OrigamiLive.exe`) are
the exact recipe used for the release. They run on Node 20 with esbuild; the
package is wired for the Origami toolchain, so they're here to be **read and
verified** rather than as a turnkey standalone build.

---
*Part of [Origami](https://origami.gratis). The Origami Studio extension and the
rest of Origami remain closed-source; only this helper is published, for the
transparency reasons above.*
