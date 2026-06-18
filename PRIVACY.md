# Privacy Policy — Origami Folio

**Effective date: 18 June 2026**

Origami Folio ("the extension") is a Chrome extension by Origami Labs for
creating, editing, presenting and exporting `.origami.html` documents. This
policy explains, plainly, what the extension does and does not do with your data.

## The short version

**Origami Folio collects nothing.** It has no accounts, no sign-in, no
analytics, no telemetry, and no tracking. It makes no network requests to send
your data anywhere. Your documents and settings stay on your own device. We — the
developers — never see them.

## What stays on your device

Everything. Specifically:

- **Your documents.** The `.origami.html` files you open, create and edit are
  read from and written back to your own device, only when you explicitly open
  or save them.
- **Preferences and recents.** Settings such as your theme, and the list of
  recently opened documents, are stored locally using the browser's `storage`
  API so the app can restore them next time.
- **Autosave and backups.** While you edit, the Studio keeps local autosave
  snapshots and timestamped backups of the current document (in IndexedDB and
  the browser's private file storage) so your work isn't lost. These never leave
  your device. (This is why the extension requests `unlimitedStorage` — documents
  can be several megabytes, and the default quota is too small for reliable local
  backups.)

None of this data is transmitted to us or to any third party.

## Permissions, in plain terms

- **`storage` / `unlimitedStorage`** — store your preferences, recents, autosaves
  and backups locally, as described above.
- **`file:///*` (and the file:// content script)** — let the extension recognise
  an `.origami.html` file you double-click or choose, open it in the Studio, and
  save your edits back to that same file. It only touches files you explicitly
  open, and it does not browse, collect or transmit your files. (You also have to
  enable "Allow access to file URLs" for the extension.)
- **`nativeMessaging`** — used only by the optional **Go Live** feature, and only
  when you turn it on. A browser extension cannot open a local network port
  itself, so Go Live connects to a small companion app you install separately to
  serve the document you're editing **from your own machine, over your own local
  network** (for example, to open it on your phone via a QR code). It connects
  only to that local companion; nothing is sent to us or to any remote server. If
  you never use Go Live, this never runs.

## Network activity

The extension makes **no network requests** for its own operation, and contains
**no analytics or telemetry**. There are two cases where *your content* can cause
network activity — both under your control:

- **Live embeds via Go Live.** If you add an embed (for example a video or a
  dashboard) to a document and then use Go Live, your browser will load that
  embedded content directly from the third party that hosts it. That request goes
  to that third party, subject to *their* privacy policy — not to us. Offline,
  embeds are shown as static link cards and load nothing.
- **Serving on your local network.** When you choose Go Live, the document is
  served from your machine to other devices *you* point at it on your own local
  network. It is not uploaded to the internet or to us.

## Export

Exporting to PowerPoint, Word or image formats happens entirely on your device.
No document content is sent anywhere to perform an export.

## Remote code

All of the extension's code ships inside the package; the extension never
downloads or executes code from a remote server. (For full transparency: the
offline export feature uses a bundled third-party HTML-to-image library that
internally uses `new Function()` on in-package data — no external code is
involved.)

## Data sharing and sale

We do **not** sell or transfer your data to third parties. We do **not** use or
transfer your data for any purpose unrelated to the extension's single purpose,
and we do **not** use it to determine creditworthiness or for lending. There is
no user data for us to share, because we never collect any.

## Children

The extension is a general-purpose document tool and is not directed at children.
It collects no personal information from anyone.

## Changes to this policy

If this policy changes, the updated version will be published at this same
location with a new effective date.

## Contact

Origami Labs — via the project repository at
<https://github.com/PassingByPixels/Origami-Folio>.
