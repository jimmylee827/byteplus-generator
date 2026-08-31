# BytePlus Studio

A self-hosted, production-ready web app for generating images and editing videos with **BytePlus ModelArk** — Seedream image generation (4.5 endpoint **and** Seedream 5.0 Pro) plus Seedance 2.5 video editing — with hot-swappable API keys, multi-image inputs, a persistent local gallery, and a versioned prompt library with `{{variable:default}}` templating.

> Bring your own BytePlus API key(s). The app runs entirely on your machine — generated images and saved prompts never leave your disk.

---

## Features

- **Hot-swappable key rotation.** Drop in any number of API keys; the server rotates them automatically (proactively after 200 successful uses, reactively on `402 / 403 / 429`, hard-disable on `401`). The same keys power image generation *and* video editing.
- **Two tabs.** *Image* (generation) and *Video editing* (Seedance 2.5). Switch in the top bar.
- **Per-model image generation.** Pick Seedream 4.5 (your configured endpoint) or **Seedream 5.0 Pro** (`dola-seedream-5-0-pro-260628`) in the composer. 5.0 Pro tops out at 2K (1K / 1.5K / 2K) and supports PNG/JPEG, so the resolution dropdown and output format adapt to the selected model. Other model IDs can be passed through via the API.
- **Video editing with Seedance 2.5.** Paste a public clip URL (or upload a local file, with `PUBLIC_BASE_URL` set — see below), write an edit instruction, set resolution / audio / watermark (ratio and duration are inherited from the source clip), and the app submits an `omni_reference_task_type: "edit"` task to `POST /api/v3/contents/generations/tasks`, polls `GET /api/v3/contents/generations/tasks/{id}` until it completes, and downloads the final MP4 to disk. The optional reference image is added with role `reference_image`.
- **Multi-image composition.** Drag, drop, paste, or browse — 1 to 9 reference images per request, base64 forwarded to BytePlus.
- **Permanent local gallery.** Generated images *and* videos are downloaded to disk before the upstream URL expires. Manifests + input thumbnails are persisted, so your gallery survives restarts; stopped tasks resume polling on reload.
- **Prompt library with version control.** Save reusable prompts by title; every body change creates a new version; history is browsable and restorable as a new version (no destructive edits). (Image tab.)
- **Variable templating.** Use `{{name:default}}` placeholders inside any prompt — duplicates share a single input, defaults seed the field, and a live compiled preview shows what will actually be sent. (Image tab.)
- **Resolution & aspect control.** Image: 2K / 4K × 8 aspect ratios (1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9), watermark toggle. Video: 480p / 720p / 1080p, generate-audio & watermark toggles (ratio and duration follow the source clip).
- **Studio-grade UX.** Sticky composer on desktop, global scroll on mobile, dark theme, processing pool with shimmer skeletons, lightbox with copy/download/delete, gallery search, keyboard shortcuts (`Ctrl/Cmd + Enter` to generate, `Esc` to close modals).
- **Predictable file naming.** Gallery files are named `YYYYMMDD_HHmmss_sss[_N]` for clean chronological sort and conflict-free downloads.

---

## Quick start

### Prerequisites

- Node.js **18+** (uses the built-in `fetch`)
- A BytePlus ModelArk account with at least one API key and a Seedream endpoint ID
- `cloudflared` — only for uploading local clips in the Video editing tab (`brew install cloudflared`)

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

# Optional — a named tunnel on your own domain. Recommended for clips over ~10 MB;
# the server takes its public address from the tunnel, so PUBLIC_BASE_URL is unused.
# TUNNEL_NAME=byteplus-studio
# TUNNEL_HOSTNAME=byteplus.yourdomain.com

# Optional — the quick tunnel writes this for you on startup. Set it by hand only
# alongside AUTO_TUNNEL=0, when you manage the address yourself.
# AUTO_TUNNEL=0
# PUBLIC_BASE_URL=https://your-tunnel-hostname

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
├─ server.js              # Express API + key rotation + gallery & prompt & video persistence
├─ migrate-gallery.js     # One-shot migration: UUID → timestamp filenames (idempotent)
├─ tunnel.js              # cloudflared quick-tunnel supervisor (auto-restart + URL publish)
├─ public/
│  ├─ index.html          # UI shell (Image + Video editing tabs)
│  ├─ styles.css          # Theme + components
│  ├─ app.js              # Composer, gallery, lightbox, slot engine, model selector, tabs
│  ├─ library.js          # Prompt library drawer + editor
│  └─ video.js            # Video editing composer, polling, gallery, lightbox
├─ gallery/                (generated, gitignored) Saved images + manifest.json
├─ videos/                 (generated, gitignored) Saved video edits + manifest.json
│  └─ staging/            Uploaded reference media, served publicly until the task finishes
├─ prompts/                (generated, gitignored) library.json with all prompts + versions
├─ .env                    (gitignored) Your secrets
└─ .env.example
```

---

## API reference

The browser app talks to a small JSON API; you can also drive it from `curl`, scripts, or your own client.

### Generate

`POST /api/generate` — `multipart/form-data`

| field           | type        | notes                                                                 |
| --------------- | ----------- | --------------------------------------------------------------------- |
| `prompt`        | string      | Required. May contain pre-compiled text.                             |
| `model`         | string      | Optional. `endpoint` (default → your `ENDPOINT_ID`, Seedream 4.5) or a ModelArk model ID such as `dola-seedream-5-0-pro-260628`. |
| `size`          | string      | `2K`, `4K`, `1K`, `1.5K`, or explicit `WIDTHxHEIGHT`.                |
| `output_format` | string      | Optional. `png` / `jpeg` (Seedream 5.0 Pro); omitted → endpoint default. |
| `watermark`     | `"true"`/`"false"` | Optional, default `false`.                                     |
| `images`        | file × 0–9  | Optional reference images.                                            |

Returns `{ success, item }` where `item` is the persisted gallery record.

### Video editing (Seedance 2.5)

`POST /api/video/generate` — `multipart/form-data` — starts an async edit task.

| field            | type        | notes                                                          |
| ---------------- | ----------- | -------------------------------------------------------------- |
| `userMessage`    | string      | Required. The edit instruction.                               |
| `video`          | file (1)    | Reference video (or `refVideoUrl` below). Staged locally and served via `PUBLIC_BASE_URL` with role `reference_video`; requires `PUBLIC_BASE_URL` to be set. |
| `refVideoUrl`    | string      | Alternative to `video` — a public video URL, passed upstream verbatim. Needs no tunnel. |
| `image`          | file (1)    | Optional reference image, sent with role `reference_image`. Also staged, so also needs `PUBLIC_BASE_URL`. |
| `model`          | string      | Optional, default `dreamina-seedance-2-5-260628`.              |
| `resolution`     | string      | `480p` / `720p` / `1080p` (default `1080p`).                   |

> `ratio` and `duration` are **not accepted** in edit mode — the model derives both from
> the source clip and rejects the request if either is sent. The real values come back on
> the finished task and are stored on the record.
| `generateAudio`  | `"true"`/`"false"` | Optional, default `false`.                              |
| `watermark`      | `"true"`/`"false"` | Optional, default `false`.                              |

Submits `omni_reference_task_type: "edit"` and returns `{ success, taskId, record }`.

Polling: `GET /api/video/tasks/:id` → `{ success, status, task, record }` where `status` ∈ `queued | running | succeeded | failed`. On success the server downloads the produced MP4 to `videos/` and returns it as `record.fullVideo`.

Other:

- `GET /api/video/gallery` — list all video edits (newest first)
- `DELETE /api/video/:id` — remove the record, the downloaded MP4, and any thumbnails

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

`GET /api/health` → `{ ok, activeKeys, totalKeys, videoEnabled, videoUploadsEnabled }`

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
| `ENDPOINT_ID`        | yes      | Your Seedream 4.5 endpoint (e.g., `ep-...`). Used for the default "endpoint" image-model option. |
| `BYTEPLUS_API_KEYS`  | yes      | Comma-separated list of ARK API keys. Order is the rotation order. Shared by image generation **and** Seedance video generation. |
| `VIDEO_MODEL`        | no       | Seedance model ID for the Video tab (default `dreamina-seedance-2-5-260628`). |
| `TUNNEL_NAME`        | no       | Name of a cloudflared **named tunnel** to run instead of a quick tunnel. Requires `TUNNEL_HOSTNAME`. |
| `TUNNEL_HOSTNAME`    | no       | The fixed hostname that named tunnel resolves to. The server uses it as its public address, so `PUBLIC_BASE_URL` is ignored in this mode. |
| `PUBLIC_BASE_URL`    | no       | Public address of this server. **Written automatically by the quick tunnel**, and ignored when a named tunnel is configured; set it yourself only with `AUTO_TUNNEL=0`. |
| `AUTO_TUNNEL`        | no       | `0` disables the built-in cloudflared supervisor (default on). Use with your own `PUBLIC_BASE_URL`. |
| `VIDEO_UPLOAD_LIMIT_MB` | no    | Max size of any single file uploaded in the Video tab — reference clip or frame image (default `200`). |
| `PORT`               | no       | HTTP port (default `3000`).                                |

### Video uploads and the auto tunnel

BytePlus fetches reference media **itself, server-side, from a URL**. Its task API accepts
exactly five content types — `text`, `image_url`, `audio_url`, `video_url`, `draft_task` —
so there is no way to hand it bytes directly:

- base64 data URIs are rejected (`reference_video must be provided as a web url`),
- there is no `file_id` content block, and
- the ModelArk Files API is not a workaround: uploads reach `status: "active"` but never
  return the documented `download_url`, so a `file_id` can't be resolved to a URL either.

So a **local** clip only works if BytePlus can download it from you. `npm start` handles
this automatically: it launches a `cloudflared` quick tunnel, publishes the hostname as
`PUBLIC_BASE_URL`, and stages uploads into `videos/staging/` behind it. **No setup needed** —
just make sure `cloudflared` is installed (`brew install cloudflared`).

Quick-tunnel hostnames are **ephemeral and rotate**. The supervisor in [`tunnel.js`](tunnel.js)
handles that for you:

- watches the `cloudflared` process and respawns it (2s → 60s backoff) whenever it dies,
- republishes each new hostname live — **no server restart required**,
- mirrors it into `.env` atomically, and reports it at `GET /api/health`,
- marks uploads unavailable while reconnecting, so nothing is staged behind a dead URL,
- kills the tunnel on `SIGINT`/`SIGTERM` so no orphan is left behind.

The browser polls health every 30s, so the composer re-enables itself automatically.

**Pasting a public video URL needs no tunnel at all** — BytePlus fetches that directly.

#### Named tunnel on your own domain (recommended for large clips)

Free quick tunnels are throttled to roughly **100–400 KB/s**, so BytePlus times out
fetching anything sizeable (`timeout while fetching resource`). Measured on a quick
tunnel: 5 MB took 47s, 20 MB took 55s — the same files serve locally in 0.02s. A named
tunnel on a domain you own removes that limit and pins the hostname.

One-time setup, then set both vars and the server does the rest:

```ini
TUNNEL_NAME=byteplus-studio
TUNNEL_HOSTNAME=byteplus.yourdomain.com
```

In this mode the server runs *your* tunnel only while it's up, publishes the fixed
hostname once the edge registers a connection, and leaves `.env` alone. Setup steps are
in [docs/named-tunnel.md](docs/named-tunnel.md).

To manage the address entirely yourself, set `AUTO_TUNNEL=0` and provide your own
`PUBLIC_BASE_URL`.

Staged inputs are deleted once a task reaches a terminal state; anything orphaned by an
interrupted task is swept after 6 hours (on boot and hourly).

> Reference clips must clear the model's floor of **407,696 pixels** (~854×480) and run
> **4–30 seconds**; otherwise the task is rejected with a `video pixel count` or duration
> error. Uploads are capped at 200 MB (`VIDEO_UPLOAD_LIMIT_MB`).

> **Activate the models you want to use** in the [Ark Console](https://ai.byteplus.com/ark). Both `dola-seedream-5-0-pro-260628` (Seedream 5.0 Pro) and `dreamina-seedance-2-5-260628` (Seedance 2.5) must be activated on your account before the corresponding UI options will succeed; the default Seedream 4.5 endpoint (`ENDPOINT_ID`) is unaffected.

The base URL is hard-coded to the BytePlus AP-Southeast region (`https://ark.ap-southeast.bytepluses.com/api/v3`). Image generation hits `/images/generations`; video editing hits `/contents/generations/tasks`. Change `WEB_API_BASE` / `API_URL` in [`server.js`](server.js) if you're on a different region.

---

## Privacy & data handling

- Your API keys live only in `.env` and in the server's memory.
- Generated images are downloaded to `gallery/` and edited videos to `videos/` on your disk; upstream URLs are never persisted (they expire anyway).
- Reference images you upload are stored locally as input thumbnails next to each generated image.
- Saved prompts and version history live in `prompts/library.json`.
- `.gitignore` excludes `.env`, `gallery/`, `videos/`, and `prompts/` so nothing personal is ever committed.

There is no telemetry. The server only contacts BytePlus, and only on your action.

---

## Tech stack

- **Backend:** Node.js, Express 5, Multer, dotenv
- **Frontend:** Vanilla JS, CSS custom properties, Inter font
- **Upstream:** BytePlus ModelArk — Seedream (4.5 endpoint + 5.0 Pro) for images, Seedance 2.5 for video editing

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
