# Seedream Studio

A self-hosted, production-ready web app for generating images with **BytePlus ModelArk Seedream 4.5**, with hot-swappable API keys, multi-image inputs, a persistent local gallery, and a versioned prompt library with `{{variable:default}}` templating.

> Bring your own BytePlus API key(s). The app runs entirely on your machine — generated images and saved prompts never leave your disk.

---

## Features

- **Hot-swappable key rotation.** Drop in any number of API keys; the server rotates them automatically (proactively after 200 successful uses, reactively on `402 / 403 / 429`, hard-disable on `401`).
- **Multi-image composition.** Drag, drop, paste, or browse — 1 to 9 reference images per request, base64 forwarded to BytePlus.
- **Permanent local gallery.** Generated images are downloaded to disk before the upstream URL expires. Manifest + input thumbnails are persisted, so your gallery survives restarts.
- **Prompt library with version control.** Save reusable prompts by title; every body change creates a new version; history is browsable and restorable as a new version (no destructive edits).
- **Variable templating.** Use `{{name:default}}` placeholders inside any prompt — duplicates share a single input, defaults seed the field, and a live compiled preview shows what will actually be sent.
- **Resolution & aspect control.** 2K / 4K × 8 aspect ratios (1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9), watermark toggle.
- **Studio-grade UX.** Sticky composer on desktop, global scroll on mobile, dark theme, processing pool with shimmer skeletons, lightbox with copy/download/delete, gallery search, keyboard shortcuts (`Ctrl/Cmd + Enter` to generate, `Esc` to close modals).
- **Predictable file naming.** Gallery files are named `YYYYMMDD_HHmmss_sss[_N]` for clean chronological sort and conflict-free downloads.

---

## Quick start

### Prerequisites

- Node.js **18+** (uses the built-in `fetch`)
- A BytePlus ModelArk account with at least one API key and a Seedream endpoint ID

### Install

```bash
git clone https://github.com/<your-username>/byteplus-generator.git
cd byteplus-generator
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your credentials:

```ini
# Your Seedream / ModelArk endpoint ID (e.g., ep-xxxxxxxxxxxxxx)
ENDPOINT_ID=ep-XXXXXXXXXXXXXX

# Comma-separated list of BytePlus API keys (the server rotates between them)
BYTEPLUS_API_KEYS=key_one,key_two,key_three

# Optional — defaults to 3000
# PORT=3000
```

Multiple keys are optional but recommended if you're working through trial quotas.

### Run

```bash
npm start
```

Open <http://localhost:3000>.

---

## Usage

1. **Compose.** Type a prompt. Use `{{name:default}}` to mark variables — they appear as auto-growing chips below the prompt box.
2. **Add references (optional).** Drop, paste, or browse 1–9 images.
3. **Pick output.** Choose 2K / 4K and an aspect ratio. Toggle watermark off if you don't want it.
4. **Generate.** Click *Generate* or hit `Ctrl/Cmd + Enter`. The job appears in the processing pool, then drops into your gallery once finished.
5. **Iterate.** Click any gallery thumbnail to open the lightbox: copy the prompt, download the file, or delete.
6. **Save & reuse.** Hit *Save to library* to store the current prompt; reopen it later from the *Library* drawer. Editing a saved prompt creates a new version automatically; you can browse the version history and restore older versions as fresh versions.

### Variable syntax cheatsheet

```
A {{style:cyberpunk}} portrait of {{subject}}, {{lighting:dramatic studio light}},
shot on {{camera:medium format}}, photographed by {{style}}
```

- `{{name}}` — required slot, no default
- `{{name:some default text}}` — slot with a default
- The same `name` repeated reuses the **same** input. The first occurrence's default wins.
- Names match `[A-Za-z0-9_-]+`.

---

## Project layout

```
byteplus-generator/
├─ server.js              # Express API + key rotation + gallery & prompt persistence
├─ migrate-gallery.js     # One-shot migration: UUID → timestamp filenames (idempotent)
├─ public/
│  ├─ index.html          # UI shell
│  ├─ styles.css          # Theme + components
│  ├─ app.js              # Composer, gallery, lightbox, slot engine
│  └─ library.js          # Prompt library drawer + editor
├─ gallery/                (generated, gitignored) Saved images + manifest.json
├─ prompts/                (generated, gitignored) library.json with all prompts + versions
├─ .env                    (gitignored) Your secrets
└─ .env.example
```

---

## API reference

The browser app talks to a small JSON API; you can also drive it from `curl`, scripts, or your own client.

### Generate

`POST /api/generate` — `multipart/form-data`

| field       | type        | notes                                           |
| ----------- | ----------- | ----------------------------------------------- |
| `prompt`    | string      | Required. May contain pre-compiled text.        |
| `size`      | string      | `2K`, `4K`, or explicit `WIDTHxHEIGHT`.         |
| `watermark` | `"true"`/`"false"` | Optional, default `false`.               |
| `images`    | file × 0–9  | Optional reference images.                      |

Returns `{ success, item }` where `item` is the persisted gallery record.

### Gallery

- `GET /api/gallery` — list all items (newest first)
- `GET /api/gallery/:id` — one item
- `DELETE /api/gallery/:id` — remove the manifest entry, the output, and any input thumbnails

### Prompt library

- `GET /api/prompts` — summarized list (title, current body, current version)
- `GET /api/prompts/:id` — full record with all versions
- `POST /api/prompts` — `{ title, body }` → creates v1
- `PUT /api/prompts/:id` — `{ title?, body? }` → bumps a new version when `body` differs
- `POST /api/prompts/:id/restore/:version` — restores a historical version as a new (current) version
- `DELETE /api/prompts/:id` — hard-deletes the prompt and all versions

### Health

`GET /api/health` → `{ ok, activeKeys, totalKeys }`

---

## Migrating an older gallery

If you ran an earlier build that stored gallery files under UUID names, run:

```bash
node migrate-gallery.js
```

The script is idempotent, sorts by `createdAt` for stable collision suffixes, refuses to clobber existing destinations, and rewrites `gallery/manifest.json` in place.

---

## Configuration reference

| Variable             | Required | Description                                                |
| -------------------- | -------- | ---------------------------------------------------------- |
| `ENDPOINT_ID`        | yes      | Your Seedream endpoint (e.g., `ep-...`).                   |
| `BYTEPLUS_API_KEYS`  | yes      | Comma-separated list of keys. Order is the rotation order. |
| `PORT`               | no       | HTTP port (default `3000`).                                |

The base URL is currently hard-coded to the BytePlus AP-Southeast region (`https://ark.ap-southeast.bytepluses.com/api/v3/images/generations`). Change it in [`server.js`](server.js) if you're on a different region.

---

## Privacy & data handling

- Your API keys live only in `.env` and in the server's memory.
- Generated images are downloaded to `gallery/` on your disk; the upstream URL is never persisted (it expires in 24 h anyway).
- Reference images you upload are stored locally as input thumbnails next to each generated image.
- Saved prompts and version history live in `prompts/library.json`.
- `.gitignore` excludes `.env`, `gallery/`, and `prompts/` so nothing personal is ever committed.

There is no telemetry. The server only contacts BytePlus, and only on your action.

---

## Tech stack

- **Backend:** Node.js, Express 5, Multer, dotenv
- **Frontend:** Vanilla JS, CSS custom properties, Inter font
- **Upstream:** BytePlus ModelArk Seedream 4.5

No build step. No bundler. No framework.

---

## Roadmap / ideas

- Optional cloud-storage adapter for the gallery
- Per-prompt thumbnail (last generated output)
- Tags / folders for the prompt library
- Shareable read-only gallery view

PRs welcome.

---

## License

MIT — see [`LICENSE`](LICENSE) (add one before publishing if you haven't already).

---

## Acknowledgements

- [BytePlus ModelArk](https://www.byteplus.com/) for the Seedream image API.
- The Inter typeface by Rasmus Andersson.
