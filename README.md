<div align="center">

<img src="assets/crane.svg" width="104" alt="Origami crane">

# Origami

**The document, refolded for the AI era.**

One self-contained `.origami.html` file — a deck, a report, a dashboard — that opens in any browser, works offline, and any AI can read and rewrite.

![Works offline](https://img.shields.io/badge/works-offline-3D8B5A?style=flat-square)
![No account](https://img.shields.io/badge/no-account-557A4E?style=flat-square)
![One file](https://img.shields.io/badge/one-.origami.html-1a1a1a?style=flat-square)
![Add-on](https://img.shields.io/badge/Chrome-add--on-557A4E?style=flat-square)

[**Website**](https://origami.gratis) · [**Download OrigamiLive**](https://github.com/PassingByPixels/Origami-Folio/releases/latest) · [**Get the add-on**](#install)

</div>

---

## What is Origami?

PowerPoint hands you a 600 MB app and a binary file no machine can read. Origami hands you **one HTML file**. It holds your whole deck — slides, charts, Gantts, node graphs, trackers, and long-form A4 reports — and nothing else. No app to install to view it. No account. No network. You email the file; it just opens.

And because it's plain HTML, it's the native medium of every AI assistant: hand the file to Claude or ChatGPT, ask for a change, paste it back. The model edits one **fold** at a time and folds it back into place — that's where the name comes from.

## Why HTML?

Every tool was shaped by the era that made it, and PowerPoint is a product of the desktop age — a person, a mouse, an afternoon nudging shapes. The agentic era doesn't reward that. HTML is live, interactive, opens anywhere, and an agent can draft, restyle and rebuild it in seconds. Try building a Gantt or a node graph in PowerPoint and watch an afternoon disappear.

## What you get

| | |
|---|---|
| 🗂 **One file, the whole deck** | Slides, data grids, charts, Gantts, node graphs, trackers and long-form documents — all in a single `.origami.html`. |
| 🌐 **Opens anywhere** | Any browser. No app, no account, no network. Email it, USB it, host it. |
| 🤖 **AI-editable** | It's just HTML — any assistant can read and rewrite a fold, then fold it back. |
| 🎨 **Studio authoring** | Insert blocks, theme it, drive the AI fold-editor, export. |
| 📤 **Export** | PDF, PowerPoint (image-perfect slides) and Word (document folds). |
| 🔒 **Private by default** | No telemetry, no account; an `.origami.html` makes zero network requests. |

## Install

Origami comes in three layers — use as many as you need.

**1. The file — nothing to install.**
Any `.origami.html` opens in any browser. To view, present or read one, just open it.

**2. The Studio add-on — to author.** *(Chrome Web Store)*
The full authoring surface: insert palette, themes, the AI fold-editor and export.
→ **Add to Chrome** *(listing in review — link landing shortly)*

**3. OrigamiLive — to go live, and to connect an AI.** *(this repo's Releases)*
A small local companion that adds **Go Live** (serve a deck over a local link), **QR present** (drive the deck from your phone), and the **local AI connection** — it hosts the MCP endpoint an AI coding tool uses to build the deck you have open. That endpoint is **tokenless**: paste the URL alone, no key to copy or keep current.
→ [**Download the latest release**](https://github.com/PassingByPixels/Origami-Folio/releases/latest), run it, done.

## Quickstart

1. Grab a sample deck from [the website](https://origami.gratis) (or any `.origami.html`).
2. Open it — arrow keys move between folds, `F` presents, `Esc` exits.
3. Install the Studio add-on, click **Edit**, and start folding.

## The `.origami.html` format

- **Self-contained & lossless.** Fonts, styles, data and the viewer all ride inside the one file. It's the source of truth — not a lossy export.
- **Yours.** You own the file. It works offline, forever, with no dependency on us.
- **Safe to share.** If a deck ever carries active content, recipients open it locked and scrubbed by default.

> Office export (PowerPoint / Word) is a separate, intentionally lossy path — slides flatten to images, document folds map to Word. The `.origami.html` itself stays the lossless original.

## Privacy & security

Origami is offline-first. No account, no telemetry, no analytics. An `.origami.html` makes **zero network requests** on its own. OrigamiLive serves only on your own machine or network, and only when you ask it to.

## FAQ

**Can I reuse or republish the code?** No — Origami is proprietary; see [LICENSE](LICENSE). The `.origami.html` files *you* create are entirely yours.

**Does it phone home?** No.

**Do I need OrigamiLive to use a deck?** No. Files open, and the add-on authors decks, without it. It is required for **Go Live** / **QR present**, and for the **AI connection** — the helper is what hosts the local MCP endpoint (because a browser extension cannot open a listening port itself). That endpoint is tokenless: no key to paste.

## Licence

Proprietary. © 2026 Origami Labs. All rights reserved. See [LICENSE](LICENSE).

---

<div align="center"><sub>Origami Labs — the document, refolded.</sub></div>
