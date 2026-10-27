# BytePlus Studio

A self-hosted studio for generating images and editing videos with **BytePlus ModelArk**.
It covers Seedream image generation (the 4.5 endpoint **and** Seedream 5.0 Pro) and
Seedance 2.5 video. It comes with rotating API keys, multi-image inputs, a persistent
local gallery, and a versioned prompt library with `{{variable:default}}` templates.

It is **CLI-first**. The `ai-media-studio` command is the core of the product, and three
thin front ends share it:

- the **web UI** (`ai-media-studio serve`, or `npm start`)
- the **HTTP API** that the web UI uses
- an **MCP server** (`ai-media-studio mcp`) and a **Claude Code Skill**, so AI agents can
  use it too

Everything the web UI can do, the CLI can do.

> Bring your own BytePlus API key(s). It runs entirely on your machine: generated images,
> videos and saved prompts never leave your disk.

---

## Quick start

### Prerequisites

- Node.js **20+** (uses the built-in `fetch`)
- A BytePlus ModelArk account with at least one API key and a Seedream endpoint ID
- `cloudflared`, only for uploading local files as video inputs (`brew install cloudflared`)

### Install and configure

```bash
git clone https://github.com/<your-username>/byteplus-generator.git
cd byteplus-generator
npm install
cp .env.example .env      # then set ENDPOINT_ID and BYTEPLUS_API_KEYS
```

### Use it

```bash
npm start                                   # web UI at http://localhost:3000
npx ai-media-studio --help                  # every command
npx ai-media-studio image generate -p "A red fox in fresh snow" --ratio 3:4
```

`npx ai-media-studio` works inside the repository. Run `npm link` once to get
`ai-media-studio` on your PATH everywhere. It always uses this repository's `.env` and
data folders, wherever you run it from.

---

## Features

- **Rotating API keys.** Add any number of keys and they rotate automatically: after 200
  successful uses, on `402 / 403 / 429`, and with a hard disable on `401`. The rotation
  state is shared by the server, the CLI and the MCP server (see
  [Shared state](#shared-state)).
- **Per-model image generation.** Seedream 4.5 (your endpoint) or **Seedream 5.0 Pro**,
  with the correct resolutions and pixel sizes for each. Other ModelArk model IDs pass
  through unchanged.
- **Video with Seedance 2.5.** Three modes:
  - edit a reference clip
  - animate a reference image
  - interpolate between a first and a last frame

  Finished clips download automatically, from the browser or from
  `ai-media-studio video wait`.
- **Multi-image composition.** 1–9 reference images per image request.
- **Permanent local gallery.** Images and videos are downloaded before the upstream URL
  expires. Records live in `gallery/manifest.json` and `videos/manifest.json`.
- **Prompt library with version control.** Every body change is a new version. Restoring
  copies an old version forward, so history is never rewritten.
- **Variable templating.** `{{name:default}}` placeholders. The web UI shows a live
  compiled preview, and the CLI's `prompts compile` gives the same result.
- **Panic mode (web UI only).** History from before the current page load is hidden
  until five quick clicks on the brand mark. It is on by default every load and is never
  persisted. The CLI and MCP always list everything.

---

## CLI reference

```
ai-media-studio <command> [arguments] [options]
```

Every command takes `--json` and `--help`. With `--json`, stdout carries exactly **one**
JSON document; logs and progress go to stderr. `-p -`, `--prompt-file -`,
`--body-file -` and `--text-file -` read stdin.

| Command | What it does |
|---|---|
| `health` | Keys active/total, whether video is enabled and uploads work, the public URL |
| `config show` | The effective configuration: API keys and ENDPOINT_ID masked to their last 4 characters |
| `keys status` | Per-key uses and disabled flags (masked) |
| `keys reset [--yes]` | Clear rotation state: re-enables 401-disabled keys and zeroes the counters |
| `models` | Image and video models, resolutions, ratios, defaults, output formats, pixel sizes |
| `size --model M --resolution R --ratio A` | The pixel size sent upstream, e.g. `1728x2304` |
| `image generate (-p TEXT \| --prompt-file F \| --from-prompt ID) [--slot k=v]… [--image [ROLE=]PATH]… [--no-legend] [--model M] [--resolution R] [--ratio A] [--size WxH] [--format jpeg\|png] [--watermark] [--seed N] [--group N] [--tag T]… [--meta k=v]… [--out DIR\|FILE] [--dry-run]` | **Billed.** Generate one image, or a group of related images, and save it to the gallery. The result includes its `cost` |
| `image batch FILE [--concurrency N] [--max-spend USD] [--resume \| --restart] [--tag T]… [--dry-run] [--jsonl]` | **Billed.** Run a file of generate jobs (see [Batches](#batches-cost-and-tags)) |
| `usage [--since D] [--until D] [--tag T]…` | Image spend from the gallery, per model |
| `image trim IN [--out F] [--margin %] [--threshold N] [--min-content %] [--pad N] [--background HEX]` · `image tile IMG… --out F [--columns N] [--cell WxH] [--fit contain\|cover]` · `image compare IMG… --out F [--label L]… [--height N]` | Local, free: crop the empty margin around the subject, lay out a gap-free grid, build a labelled review sheet (needs `sharp`) |
| `gallery list [--search Q] [--tag T]… [--limit N]` · `show ID` · `path ID` · `delete ID [--yes]` | The image gallery |
| `gallery prune (--tag T \| --older-than D) [--yes]` | Delete by tag and/or age; a dry run unless `--yes` |
| `prompts list [--search Q]` · `show ID` · `create --title T (--body B \| --body-file F)` · `update ID [--title T] [--body B \| --body-file F]` · `restore ID VERSION` · `delete ID [--yes]` | The prompt library |
| `prompts slots (ID \| --text T \| --text-file F)` | A template's slots and their defaults |
| `prompts compile (ID \| --text T \| --text-file F) [--slot k=v]…` | The exact prompt that would be sent |
| `video modes` | Video modes, which parameters each accepts, models, resolutions, ratios, duration bounds |
| `video plan <create options>` | Free: which subtask a request becomes, what it accepts, what is wrong with it |
| `video create --mode edit\|first-last -p TEXT [--video PATH\|URL] [--image PATH\|URL] [--first-frame PATH\|URL] [--last-frame PATH\|URL] [--model M] [--resolution R] [--ratio A] [--duration S] [--audio\|--no-audio] [--seed N] [--watermark] [--wait [--timeout S]] [--dry-run]` | **Billed.** Start a Seedance task |
| `video status ID` · `wait ID [--timeout S]` · `resume [--timeout S]` | Check once, wait until finished, or finish every pending task; the result downloads automatically |
| `video list` · `show ID` · `delete ID [--yes]` | The video gallery |
| `tunnel status` · `tunnel up [--port P]` | The public URL for local video inputs; `up` runs one in the foreground |
| `serve [--port P]` | The web UI and HTTP API (what `npm start` runs) |
| `mcp` | The MCP server over stdio |

Conventions:

- **`--dry-run`** prints the exact upstream request and stops. Nothing is billed, staged or
  saved. Images are shown as `<data-uri: N bytes>`, the endpoint ID is masked, and keys
  are never shown.
- **Destructive commands** ask for confirmation in a terminal, and require `--yes` when
  stdin is not a terminal.
- **Paths:** records include `paths` (absolute file paths) next to the `/gallery/…` and
  `/videos/…` web paths.

### Exit codes

| Exit | Meaning | `code` |
|---|---|---|
| 0 | Success | — |
| 1 | Anything else (network, download, configuration, internal) | `NETWORK`, `DOWNLOAD_FAILED`, `CONFIG`, `INTERNAL` |
| 2 | Usage or validation error | `USAGE`, `VALIDATION`, `PATH_NOT_ALLOWED` |
| 3 | BytePlus rejected the request, or a video task failed | `UPSTREAM_REJECTED`, `UPSTREAM_BAD_RESPONSE`, `TASK_FAILED` |
| 4 | Every API key is exhausted or invalid | `KEYS_EXHAUSTED` |
| 5 | Not found | `NOT_FOUND` |
| 6 | Local video inputs need a public URL and none is live | `UPLOADS_UNAVAILABLE` |
| 7 | `--timeout` reached while waiting; the task is still running | `WAIT_TIMEOUT` |
| 8 | Some batch jobs failed or were skipped (details in `summary`); fix and rerun with `--resume` | `BATCH_INCOMPLETE` |

Every failure prints `{ "success": false, "error": "…", "code": "…" }`, which is the same
shape the HTTP API returns.

### Examples

```bash
# Check the request, then generate
ai-media-studio image generate -p "A {{style:cyberpunk}} city" --slot style=noir --dry-run --json
ai-media-studio image generate -p "A {{style:cyberpunk}} city" --slot style=noir --json

# A saved template
ai-media-studio prompts create --title "City" --body "A {{style:cyberpunk}} city at {{time:dusk}}"
ai-media-studio image generate --from-prompt <id> --slot time=dawn

# Video from a public clip, waiting for the result
ai-media-studio video create -p "Make it a neon night" --video https://example.com/clip.mp4 --wait --timeout 900

# Finish whatever was still rendering when the browser tab closed
ai-media-studio video resume
```

---

## Batches, cost and tags

These features came out of a real production run. An online clothing shop made 463
images in two days, driving the CLI from its own scripts.

### Cost

- **Every result shows its cost.** Each image result has `cost` in US$
  (`{ usd, outputUsd, inputUsd, model, priceRead }`), and the same figure is saved on
  the gallery record. `--dry-run` shows `estimatedCost`.
- **Where the prices come from.** They are in `IMAGE_PRICES` in
  [`core/models.js`](core/models.js), copied from the
  [official ModelArk price table](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing)
  on 2026-10-28. A model with no known price reports `cost: null` and a `costNote`;
  nothing is guessed.
- **The endpoint's price.** `ENDPOINT_ID` is priced as the model it serves, which is
  `ENDPOINT_BASE_MODEL` (default `seedream-4-5-251128`).
- **Totals.** `ai-media-studio usage [--since D] [--tag T]` adds up spend from the
  gallery. Images made before costs were recorded are priced from their model, size and
  number of references, and reported separately as `estimatedUsd`.

| Model | Price per image (read 2026-10-28) |
|---|---|
| Seedream 5.0 Pro | $0.045 up to 2.61 MP, $0.09 above (2K at 3:4 is 4.2 MP, so $0.09; 1.5K is $0.045); $0.003 per reference after the first |
| Seedream 4.5 / 4.0 | $0.04 / $0.03; references free |
| Seedream 5.0 Lite / Flash | $0.035 / $0.018 |

### Batches

`image batch` runs a jobs file. In JSON Lines, each line takes the same fields as
`image generate`, plus an optional `id`. A `.json` file instead holds
`{ "defaults": {…}, "jobs": [ … ] }`. Relative paths are relative to the file.

```bash
ai-media-studio image batch jobs.jsonl --dry-run              # validate + estimated total
ai-media-studio image batch jobs.jsonl --concurrency 4 --max-spend 20 --jsonl
ai-media-studio image batch jobs.jsonl --resume --jsonl       # after a failure or an interruption
```

- **Concurrency.** `--concurrency` (default 4) is how many jobs run at once.
- **Spend cap.** `--max-spend` stops before the batch's recorded spend would pass the
  cap. While a cap is set, a job with no known price is skipped.
- **Progress file.** Progress goes to `<file>.status.json`, written after every job.
  Re-running a recorded batch needs `--resume` (skip finished jobs and existing `out`
  files) or `--restart` (run everything and pay again).
- **Output.** `--jsonl` prints one line per finished job, then a summary line. `--json`
  prints one document at the end.
- **Exit codes.** 0 when every job is done; 8 (`BATCH_INCOMPLETE`) otherwise.
- **Labels on the images.** Every image is tagged with `meta.batch` and `meta.job`, plus
  any `--tag`.

### Named references, groups and seeds

- **Named references.** `--image garment=a.jpg --image character=b.jpg …` keeps the
  order, starts the prompt with "Image 1 is the garment; image 2 is the character.", and
  saves `inputRoles` on the record. `--no-legend` leaves the prompt alone.
- **Groups.** `--group N` asks Seedream 4.5, 4.0 or 5.0 Lite for up to N related images
  in one call (`sequential_image_generation: "auto"`). All of them are saved and linked
  by `groupId`. It is refused for 5.0 Pro and Flash, and when references + N > 15.
- **Seeds.** `--seed` is refused for every current Seedream model. None of them has a
  seed parameter in the
  [API reference](https://docs.byteplus.com/en/docs/ModelArk/1541523) (last updated
  2026-10-17); only the 3.0 generation did.

### Tags and cleanup

`--tag T` (repeatable) and `--meta key=value` are saved on the image. Use them with
`gallery list --tag`, `usage --tag` and `gallery prune --tag T --older-than 30d`.
`prune` only reports what it would delete until you add `--yes`.

### Cropping and sheets in code

Studio backdrops are not one flat colour: they have gradients, soft shadows and
vignetting. `image trim` therefore finds the **subject** (strong edges, measured per row
and per column) instead of one background colour, and keeps a small margin around it:

```bash
ai-media-studio image trim shot.jpeg --json          # → width/height/trimmed/unchanged
ai-media-studio image trim shot.jpeg --margin 3 --out tight.png
```

- `--margin` (default 1.5% of the long edge) is breathing room kept around the subject.
- `--threshold` (default 16) is how strong an edge must be. Raise it to trim less.
- `--min-content` (default 4%) is how much of a row or column must be edges to count.
- Images with transparency are cropped to their opaque pixels.
- When nothing can be separated (`unchanged: true`) the file is copied through, with a
  reason. That's the case for a flat image, or a subject that fills the frame.

Measure a 4K image in about a third of a second. `image tile` and `image compare` build
the multi-view sheets and review collages that the models themselves get wrong.

### Model guide and prompting rules

The Skill ([`skills/ai-media-studio/SKILL.md`](skills/ai-media-studio/SKILL.md)) has
the model guide (Seedream 4.5 vs 5.0 Pro) and the prompting rules learned in that run.
In short:

- describe what you want, not "not X";
- name each reference's role;
- chain close-ups through the item's own front shot;
- state framing as an edge ("the frame starts below the neck");
- pin colours with a hex;
- always say "exactly ONE person" and "no text";
- make sheets and grids with `image tile`, not in the prompt.

These are observations, not benchmarks.

---

## AI access

### MCP server

`ai-media-studio mcp` is an MCP server over stdio. It is built on the official
`@modelcontextprotocol/sdk`.

**Tools.** It has one tool per capability: `ai_media_studio_image_generate`,
`ai_media_studio_gallery_list`, `…_gallery_get`, `…_gallery_delete`, `…_prompts_*`,
`…_prompts_compile`, `…_models`, `…_video_create`, `…_video_status`,
`…_video_wait`, `…_health`, and more.

**Inputs and results.** Inputs use the same JSON Schemas as the CLI, and results are
the same JSON as `--json`. Image generation also returns a preview (longest edge at most
1024 px) as MCP image content, together with the absolute path to the full file. The
preview needs the optional `sharp` dependency; without it, you get only the path.

**Costs and safety hints.** Each billed tool says so in its description. Deletes carry
`destructiveHint`, and generations carry `openWorldHint`.

**Local files.** File inputs must be **absolute paths** inside
`AI_MEDIA_STUDIO_ALLOWED_DIRS`. The default is this repository and your home folder. The
`.env` file and the `.state/` folder are always refused.

**What is not exposed.** `config`, `keys`, `serve` and `tunnel up` are not tools, and no
tool ever returns an API key.

Add it to a project's `.mcp.json` (or your client's MCP config):

```json
{
  "mcpServers": {
    "ai-media-studio": {
      "command": "node",
      "args": ["/absolute/path/to/byteplus-generator/cli/ai-media-studio.js", "mcp"]
    }
  }
}
```

### Claude Code Skill

[`skills/ai-media-studio/SKILL.md`](skills/ai-media-studio/SKILL.md) teaches an agent to
use the **CLI**, so it works even without MCP. It covers `--json` and exit codes, cost
etiquette (dry-run first, no generation loops), and copy-paste workflows. To install
it, symlink it into a project or into your user skills folder:

```bash
# one project
mkdir -p /path/to/project/.claude/skills
ln -s "$(pwd)/skills/ai-media-studio" /path/to/project/.claude/skills/ai-media-studio

# every project
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/ai-media-studio" ~/.claude/skills/ai-media-studio
```

---

## Architecture

```
                 ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
  people ──────► │  web UI      │   │  ai-media-    │   │  MCP server  │ ◄── AI agents
                 │  public/*.js │   │  studio CLI   │   │  mcp/        │     (or the Skill,
                 └──────┬───────┘   │  cli/         │   └──────┬───────┘      via the CLI)
                        │ HTTP      └───────┬───────┘          │
                 ┌──────▼───────┐           │                  │
                 │ HTTP API     │           │                  │
                 │ server/      │           │                  │
                 └──────┬───────┘           │                  │
                        └───────────┬───────┴──────────────────┘
                                    ▼
             core/  — every rule and side effect, one copy
             operations.js  the table the CLI and MCP are generated from
             images · videos · prompts · models · slots · keys · staging · tunnel
             stores/ (locked, atomic JSON) · serialize · errors
                                    │
              ┌─────────────────────┼──────────────────────────┐
              ▼                     ▼                          ▼
   BytePlus ModelArk      gallery/ videos/ prompts/      .state/ (keys, tunnel, locks)
```

- **core/** decides everything: validation, defaults, pixel sizes, request bodies, key
  rotation, polling cadence, what a task status means, and every error's code and exit
  status.
- **The front ends only translate.** The CLI parses flags, the HTTP routes read
  requests, and the MCP server reads tool arguments. All three make the same core call
  and print the result through the same serializer.
- **The browser** renders what the server returns. For example: `/api/models` fills the
  menus, `/api/prompts/compile` compiles slots, `/api/video/plan` decides which video
  controls apply, and the poll response decides when a task is finished.
- **Tested parity:** an automated test checks that every HTTP route and its CLI command
  return identical JSON and send identical bytes to BytePlus.

| HTTP | CLI | MCP tool |
|---|---|---|
| `GET /api/health` | `health` | `ai_media_studio_health` |
| `GET /api/models` | `models` | `ai_media_studio_models` |
| `POST /api/generate` | `image generate` | `ai_media_studio_image_generate` |
| `GET /api/gallery` | `gallery list` | `ai_media_studio_gallery_list` |
| `GET /api/gallery/:id` | `gallery show` | `ai_media_studio_gallery_get` |
| `DELETE /api/gallery/:id` | `gallery delete` | `ai_media_studio_gallery_delete` |
| `GET /api/prompts` · `GET /api/prompts/:id` | `prompts list` · `prompts show` | `…_prompts_list` · `…_prompts_get` |
| `POST /api/prompts` · `PUT /api/prompts/:id` | `prompts create` · `prompts update` | `…_prompts_create` · `…_prompts_update` |
| `POST /api/prompts/:id/restore/:v` · `DELETE /api/prompts/:id` | `prompts restore` · `prompts delete` | `…_prompts_restore` · `…_prompts_delete` |
| `POST /api/prompts/slots` · `POST /api/prompts/compile` | `prompts slots` · `prompts compile` | `…_prompts_slots` · `…_prompts_compile` |
| `GET /api/video/modes` · `POST /api/video/plan` | `video modes` · `video plan` | `…_video_modes` · `…_video_plan` |
| `POST /api/video/generate` | `video create` | `ai_media_studio_video_create` |
| `GET /api/video/tasks/:id` | `video status` | `ai_media_studio_video_status` |
| — | `video wait` · `video resume` | `…_video_wait` · `…_video_resume` |
| `GET /api/video/gallery` · `GET /api/video/:id` · `DELETE /api/video/:id` | `video list` · `show` · `delete` | `…_video_list` · `…_video_get` · `…_video_delete` |
| `POST /api/image/batch` | `image batch` | `…_image_batch` |
| `GET /api/usage` | `usage` | `…_usage` |
| `POST /api/gallery/prune` | `gallery prune` | `…_gallery_prune` |
| `POST /api/image/trim` · `/tile` · `/compare` | `image trim` · `tile` · `compare` | `…_image_trim` · `…_image_tile` · `…_image_compare` |

### HTTP API notes

**Image generation.** `POST /api/generate` takes `multipart/form-data` with these fields:

- `prompt` (required)
- `slots` (optional): a JSON object of slot values; the prompt is then compiled as a
  template
- `model`
- `resolution` and `ratio`, **or** an explicit `size`
- `output_format`
- `watermark`
- `seed`, `group`
- `imageRoles`: a JSON array aligned with `images`
- `legend`
- `tags`: repeated fields or a JSON array
- `meta`: a JSON object
- `images`: 0–9 files

It returns `{ success, item, cost }`, or `{ success, groupId, items, cost }` for a group.

**JSON routes.** `POST /api/image/batch`, `/api/image/trim|tile|compare` and
`/api/gallery/prune` take the same JSON fields as the CLI operation, with paths.
`GET /api/usage` takes `since`, `until` and `tag`.

**Video generation.** `POST /api/video/generate` takes `multipart/form-data` with these
fields:

- `userMessage`
- `mode`: `edit` or `firstLast`
- `video` (file) or `refVideoUrl`
- `image` (file) or `refImageUrl`
- `firstFrame` (file) or `firstFrameUrl`
- `lastFrame` (file) or `lastFrameUrl`
- `model`, `resolution`, `ratio`, `duration`, `generateAudio`, `seed`, `watermark`

It returns `{ success, taskId, record }`.

**Video status.** `GET /api/video/tasks/:id?attempt=N` returns
`{ success, status, task, record, terminal, failureReason, nextPollMs }`.

**Errors** come back as `{ success: false, error, code }`. A transient failure also
carries `retryable: true`.

---

## Video uploads and the tunnel

BytePlus fetches reference media **itself, server-side, from a URL**. Its task API
accepts exactly five content types (`text`, `image_url`, `audio_url`, `video_url` and
`draft_task`), so there is no way to hand it bytes directly:

- base64 data URIs are rejected (`reference_video must be provided as a web url`),
- there is no `file_id` content block, and
- the ModelArk Files API is not a workaround: uploads reach `status: "active"` but never
  return the documented `download_url`, so a `file_id` can't be resolved to a URL either.

So a **local** clip or frame only works if BytePlus can download it from you.
`ai-media-studio serve` (and `npm start`) handles this automatically:

- it runs a `cloudflared` tunnel for as long as the server runs,
- it stages uploads into `videos/staging/` behind the tunnel,
- it deletes them once the task is finished.

Anything an interrupted task leaves behind is swept after 6 hours.

To work without the web UI, run `ai-media-studio tunnel up` in another terminal. It
serves only the staging folder through the tunnel. Any process can use a live tunnel,
whoever started it, so the CLI and MCP find it on their own. Without one, local video
inputs fail with exit code 6, and **public `https://` URLs always work**.

**Only staged files are public.** Requests that arrive through the tunnel can reach
`/videos/staging/*` and nothing else. The web UI and the API (including deletes and paid
generation) answer only on `localhost`.

**Quick tunnel (default).** Quick-tunnel hostnames are ephemeral and rotate. The
supervisor in [`core/tunnel.js`](core/tunnel.js) handles that: it respawns `cloudflared`
with a back-off from 2 s to 60 s, and publishes each new hostname live. The address is
written to `.state/tunnel.json`, which other processes read, and also into `.env` as
`PUBLIC_BASE_URL`, which is only a hint.

**Named tunnel on your own domain (recommended for large clips).** Free quick tunnels
are throttled to roughly **100–400 KB/s**, so BytePlus times out fetching anything
sizeable (`timeout while fetching resource`). A named tunnel removes that limit and pins
the hostname: set `TUNNEL_NAME` and `TUNNEL_HOSTNAME`. Setup is in
[docs/named-tunnel.md](docs/named-tunnel.md).

**Manage it yourself.** Set `AUTO_TUNNEL=0` and your own `PUBLIC_BASE_URL`.

> **Source clip limits.** Reference clips must clear the model's floor of **407,696
> pixels** (about 854×480) and run **4–30 seconds**. Uploads are capped at 200 MB
> (`VIDEO_UPLOAD_LIMIT_MB`).

> **Activate the models** in the [Ark Console](https://ai.byteplus.com/ark).
> `dola-seedream-5-0-pro-260628` and `dreamina-seedance-2-5-260628` must be activated on
> your account; the Seedream 4.5 endpoint (`ENDPOINT_ID`) is unaffected.

The base URL is the BytePlus AP-Southeast region (`ARK_BASE` in [`core/ark.js`](core/ark.js)).

---

## Configuration reference

| Variable | Required | Description |
|---|---|---|
| `ENDPOINT_ID` | for the default image model | Your Seedream 4.5 endpoint (`ep-…`), used by the `endpoint` model |
| `BYTEPLUS_API_KEYS` | yes | Comma-separated ARK API keys, in rotation order. Shared by images and video |
| `VIDEO_MODEL` | no | Seedance model ID (default `dreamina-seedance-2-5-260628`) |
| `TUNNEL_NAME` / `TUNNEL_HOSTNAME` | no | Run your own named cloudflared tunnel instead of a quick tunnel |
| `PUBLIC_BASE_URL` | no | Written by the quick tunnel as a hint; set it yourself only with `AUTO_TUNNEL=0` |
| `AUTO_TUNNEL` | no | `0` disables the built-in tunnel supervisor |
| `VIDEO_UPLOAD_LIMIT_MB` | no | Maximum size of one uploaded video input (default `200`) |
| `PORT` | no | HTTP port (default `3000`) |
| `AI_MEDIA_STUDIO_ALLOWED_DIRS` | no | Folders MCP file inputs may come from, separated by `:` (default: this repository and your home folder) |
| `AI_MEDIA_STUDIO_DATA_DIR` | no | Where `gallery/`, `videos/`, `prompts/` and `.state/` live (default: this repository) |
| `AI_MEDIA_STUDIO_ENV_FILE` | no | Which `.env` to read (default: this repository's `.env`) |
| `AI_MEDIA_STUDIO_VERBOSE` | no | `1` makes the MCP server log to stderr |
| `ENDPOINT_BASE_MODEL` | no | Which model `ENDPOINT_ID` serves, for pricing (default `seedream-4-5-251128`) |

### Shared state

The server, the CLI and the MCP server can run at the same time on one data folder:

- **Manifests.** Every manifest write is locked (`.state/locks/`) and atomic (a temp
  file, then a rename). Two processes can't lose each other's records, and a reader
  never sees a half-written file.
- **Gallery IDs.** IDs keep the `YYYYMMDD_HHmmss_sss[_N]` format, and are reserved under
  a lock.
- **Key rotation.** The state lives in `.state/keys.json`. Keys are identified by a
  hash and are never stored. A key disabled by a `401` stays disabled until it is
  removed from `.env` or you run `ai-media-studio keys reset`.
- **Finishing a video.** A finished video is downloaded once, even if several processes
  are polling it.

---

## Privacy and data handling

- **Keys.** API keys live only in `.env`. No command, tool or log prints them.
- **Your files.** Generated images go to `gallery/` and videos to `videos/`. Upstream
  URLs are never persisted (they expire anyway).
- **Reference images** are kept next to each result. Saved prompts and their history
  live in `prompts/library.json`.
- **Git.** `.gitignore` excludes `.env`, `gallery/`, `videos/`, `prompts/`, `archive/`
  and `.state/`.

There is no telemetry. BytePlus is contacted only when you generate something or check a task you started.

---

## Development

```bash
npm test          # node:test; BytePlus is mocked, user data is never touched
```

- **Characterisation tests.** `test/characterisation/` pins the behaviour of the
  pre-refactor code. It runs the original server from git in a temporary copy, and
  compares every upstream request body byte for byte against the goldens in
  `test/fixtures/upstream/`. Run with `TEST_TARGET=legacy` to check the goldens against
  that original code.
- **Other suites.** `test/core`, `test/cli` and `test/mcp` cover locking and concurrency,
  CLI conventions, HTTP ↔ CLI parity, and the MCP server.
- **Data guard.** `npm test` fails if the real `gallery/`, `videos/` or `prompts/`
  manifests change during the run.

### Migrating an older gallery

If you ran an early build that stored gallery files under UUID names, run
`node migrate-gallery.js`. It is idempotent, sorts by `createdAt` for stable collision
suffixes, refuses to overwrite existing files, and rewrites `gallery/manifest.json` in
place.

---

## License

MIT — see [`LICENSE`](LICENSE).

## Acknowledgements

- [BytePlus ModelArk](https://www.byteplus.com/) for the Seedream and Seedance APIs.
- The Inter typeface by Rasmus Andersson.
