# Origami Live — GitHub Release notes (template)

Paste this into the GitHub Release that ships `OrigamiLive.exe`. Fill every
`{{PLACEHOLDER}}` before publishing. Build the exe from this repo with
`npm -w origami-serve run build:exe` (Node SEA — deliberately **not** code-signed).

---

## v0.2.2 — what's new
- **Local video over Go Live** — when the deck is saved, Go Live now serves the deck's own folder, so a video beside the deck (a relative path like `media/intro.mp4`) streams and scrubs over http instead of 404ing. The deck's bytes still come from the editor (unsaved edits keep working) and your folder is never written to.
- **Media-only siblings** — serving the folder is restricted to media and asset extensions (`mp4 m4v webm ogv mov png jpg jpeg gif webp avif svg`); every other path answers 404, so the helper cannot be used to read the other files in the folder.
- **An unsaved deck is unchanged** — with no folder known, Go Live still serves a temporary copy.
- **LAN share stays private** — the QR server keeps its own temporary copy of the deck and never exposes your folder.
- **Honest editor placeholder** — the Studio canvas shows a placeholder for a local video instead of a dead black player, and the video panel's hint now states where a local file actually plays (opened from disk, or Go Live with the deck saved).

## v0.2.1 — what's new
- **Seekable local video** — the helper now answers HTTP `Range` requests: `Accept-Ranges: bytes`, a `206 Partial Content` reply with `Content-Range` and the requested slice, and `416` when the range is unsatisfiable. A video that sits beside the deck streams and scrubs instead of downloading whole.

## Origami Live v{{VERSION}}

A tiny, free helper that serves your Origami deck on **localhost**, so a single
`.origami.html` file behaves like a real web page. One download, one double-click —
no Node, no npm, no terminal.

### What it unlocks
- **Video & dashboards play inline** — YouTube, Vimeo, Power BI and other embeds, instead of a fallback link card.
- **Smooth, seekable video** — big local videos stream and scrub cleanly (no `file://` stutter).
- **Live data** — slides can fetch live numbers: a chart, a KPI, a status board that's current at present-time.
- **Watch it build** — connect an AI coding tool via `origami-mcp` and watch slides appear in real time. The local endpoint is tokenless: paste the URL alone, with no key to copy or keep current.
- **Share to the room** — a read-only QR link so anyone on your Wi-Fi can view the deck on their own device (view-only, key-gated).

### Install
1. Download **OrigamiLive.exe** from the Assets below.
2. Double-click it once. It registers itself with your browser and opens a short welcome page.
3. Back in the Origami Studio, click **Go Live**.

### The Windows warning — please read
Origami Live is **free and source-available**, and it isn't code-signed (a certificate is a
recurring cost we'd rather not put on a free tool yet). So Windows SmartScreen may show a
blue **"Windows protected your PC"** screen the first time you run it.

- Click **More info → Run anyway**.
- This is the *unrecognized-publisher* warning, **not** a malware detection.
- Don't take our word for it — the entire source is in this repo. Read it, and build the
  exe yourself with `npm -w origami-serve run build:exe` if you'd rather.

**SHA-256:** `{{SHA256}}` — verify your download matches.

### Private by design
- Serves to **127.0.0.1** (your machine) by default — nothing is uploaded, no account, no cloud.
- **Read-only**: it hands out the page and nothing else; a viewer cannot change your files.
- Serves the deck's own folder when it is saved (the deck plus media siblings only) — never the rest of your files; an unsaved deck is served from a temporary copy.
- Runs only while you're live; close the tab or press **Stop** and the server is gone.
- Network sharing (the QR) is **opt-in, per-session, key-gated, and view-only**; Windows asks once to allow it on your network.

### Uninstall
Delete the exe, then in a terminal remove the registration:
```
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.origami.live" /f
```
(repeat for `BraveSoftware\Brave-Browser`, `Microsoft\Edge`, `Chromium` if you use them).

---
*Origami Live is part of Origami. Source: {{REPO_URL}}*
