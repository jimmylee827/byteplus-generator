# BytePlus Studio, CLI-first: Phase 0 plan

## Context

`docs/agent-prompt-cli-first.md` asks for BytePlus Studio to become CLI-first. One `core/`
holds all the logic. The CLI, the HTTP server and a new MCP server are thin adapters over
it, and a Skill teaches agents to use the CLI. The working app must keep behaving as it
does now. The brief's Phase 0 is this document: corrections to its §1, the final command
list, the route ↔ command ↔ tool mapping, the state and locking design, the tunnel
decision, the migration steps and the open questions.

**Execution once approved:** create branch `cli-first`, save this plan as
`docs/cli-first-plan.md`, and commit it (Phase 0). Then run Phases 1–5, one commit per
phase, with no push and no PR. I will stop to ask before running the live smoke test.
No data migration is planned (§11). The brief's file `docs/agent-prompt-cli-first.md` is
committed with Phase 0 unless you say otherwise.

Decisions you made in planning:
- **Command name:** `ai-media-studio` instead of `studio`, which you found too ambiguous.
  The names derived from it follow the same pattern:

  | Thing | Name |
  |---|---|
  | `package.json` `bin` | `ai-media-studio` |
  | MCP server | `ai-media-studio` |
  | MCP tools | `ai_media_studio_*` |
  | Skill | `skills/ai-media-studio/` |
  | env vars | `AI_MEDIA_STUDIO_*` |

  The UI keeps its "BytePlus Studio" branding, since the visual design must not change.
- **Tunnel scope:** requests that arrive through the tunnel get only `/videos/staging/*`.
- **ENDPOINT_ID:** masked (last 4 characters) in `config show` and in `--dry-run`. Records
  keep storing it as they do today.
- **Image file extension:** taken from the real downloaded bytes (magic number). Existing
  records are not touched.

---

## 1. Corrections and additions to the brief's §1

These are confirmed against the code at `880d429`.

1. **Limits live only in the HTTP layer.** The 9 images × 10 MB limit and
   `VIDEO_UPLOAD_LIMIT_MB` (default 200) are enforced by multer only
   (`server.js:226-239`). Core must enforce them itself so the CLI and MCP get them too.
2. **Every image is saved as `.jpeg`** (`server.js:343`), whatever `output_format` says.
   Today this is harmless because the UI never asks for PNG. It becomes a real bug once
   `--format png` exists, hence your extension decision.
3. **`size` is computed only in the browser.** The server defaults it to `'4K'` when it is
   missing. The UI's `buildSize()` returns the bare resolution (for example `"2K"`) when
   the ratio is `auto` or the ratio is unknown.
4. **Video polls count as key "uses".** `arkTaskGet` calls `recordSuccess()` (line 623), so
   status polls count toward the 200-use swap. Today's semantics are kept.
5. **Once a key passes 200 uses, rotation happens after every use.** After rotating away,
   a key's `uses` stays at 200 or more, so on its next turn it rotates after a single use.
   Today a restart resets this. Persisting the state makes it permanent (open question 1).
6. **Lost-update race inside one process.** The video status route reads the record, then
   awaits downloads, then rewrites the whole manifest (`server.js:954-1013`). Two
   concurrent polls can lose each other's changes even in a single process.
7. **Gallery IDs use local time, not UTC.** The ID is chosen before the download but the
   file appears only afterwards. Two requests in the same millisecond could already
   collide today.
8. **`/api/health` returns `{ ok: true, … }`, not `success`.** Error responses carry no
   `code`. `videoEnabled` is always `true`, because the process exits when it has no keys.
9. **Polling an unknown task ID creates a record.** If upstream knows the task, the server
   inserts a stub record (lines 955-957, 1012). This is kept.
10. **Video options are hard-coded in `index.html`.** The video model, resolutions
    (1080p/720p/480p), ratios (including `adaptive`) and duration (4–30, default 5) are
    fixed there. So are the image ratio labels and the `3:4` default. These are moved
    into the catalogue too.
11. **`video.js` makes decisions itself.** `currentSubtask()` mirrors `videoSubtask()`,
    and `generate()` pre-validates (first frame required, clip or image required).
    `library.js` rejects blank bodies and restoring the current version, which the
    server allows.
12. **Exact polling cadence** (`video.js:445-491`):
    - The first poll is immediate.
    - After that, the delay is 5 s while attempts < 6, 10 s while < 20, then 20 s.
    - A network error retries after 10 s while attempts < 12.
    - A non-OK response stops polling at once.
    - There is no overall timeout.
13. **Frame mode accepts uploads only.** There is no URL field for first or last frames.
    The edit-mode reference image is also upload-only. The CLI and MCP will also accept
    URLs, passed through verbatim the same way `refVideoUrl` is.
14. **Seed `0` is dropped** (`if (seed)`). `generateAudio` is omitted when it is not sent.
    The UI always sends it, defaulting to true. Both are kept.
15. **Security: the tunnel exposes the whole app.** Your `.env` runs a named tunnel, so the
    full UI and API, including DELETE routes and the paid generate routes, are reachable
    at a fixed public hostname. Fixed per your decision (§8).
16. **Unused dependencies.** `node-fetch` and `uuid` are never required; the code uses
    global `fetch` and `crypto.randomUUID`. The README says Node 18+, while the brief
    wants Node 20 or later (local is v24).
17. **`archive/gallery-2026-08-21/` is not referenced by any code.** It is left alone.
18. **`docs/named-tunnel.md` needs an update.** Its step 5 verifies with
    `curl https://<host>/api/health`, which will return 404 through the tunnel after
    point 15 is fixed.

## 2. Target layout

```
core/
  config.js      lazy env load; only commands that call BytePlus require keys/ENDPOINT_ID
  errors.js      StudioError(code, message, {httpStatus, exitCode, raw})
  ark.js         authenticated fetch with key rotation (one helper, three call sites, each keeping its current error semantics)
  keys.js        KeyManager over .state/keys.json
  models.js      SEEDREAM_MODELS + video catalogue + resolveImageSize()   (moved from app.js / index.html)
  slots.js       SLOT_RE, parseSlots, compilePrompt, segments, reconcileValues (moved from app.js)
  images.js      buildImageBody, generateImage, gallery ops
  videos.js      planVideo, buildVideoTaskBody, videoSubtask, createVideo, pollOnce, wait, resume
  staging.js     stage/unstage/sweep (6 h TTL)
  tunnel.js      git mv of tunnel.js + state-file publishing
  publicUrl.js   who is the public URL right now (in-process value | state file | .env)
  stores/        json.js (atomic write + lock), lock.js, gallery.js, videos.js, prompts.js
  operations.js  ONE table: id, description, billed/destructive, JSON-Schema input, defaults, run()
  serialize.js   success/error envelope, record decoration (absolute paths), dry-run redaction
  allowlist.js   path allow-list for MCP file inputs
  preview.js     ≤1024 px preview via optional `sharp`
cli/ai-media-studio.js   bin; node:util parseArgs driven by operations.js; cli/format.js for text output
server/app.js    createApp(): each route = map req → input → ops.run → serialize
server/serve.js  listen, tunnel, sweep, signals, tunnel-scope middleware
mcp/server.js    low-level MCP Server; tool list generated from operations.js
skills/ai-media-studio/SKILL.md
server.js        shim → server/serve.js (keeps `node server.js` and the docs valid)
```

- No new dependencies apart from `@modelcontextprotocol/sdk`, `zod` (its peer), and
  `sharp` as an **optionalDependency**. Without `sharp`, MCP returns the file path with
  no preview.
- CommonJS stays. `engines: node >= 20`.
- `AI_MEDIA_STUDIO_DATA_DIR` (default: repo root) relocates `gallery/ videos/ prompts/
  .state/`. Every test uses a temporary directory and never touches your real data.

## 3. Final CLI surface (`ai-media-studio`, shown as `ams` below for width only; no alias is installed)

Global flags: `--json`, `--help`, `--version`. Additions to the brief are marked ★.

```
ams health
ams config show                          keys → ****abcd; ENDPOINT_ID → ****n8gm
ams keys status | reset [--yes]          ★ masked per-key uses/disabled; reset clears .state/keys.json
ams models
ams size --model M --resolution R --ratio A

ams image generate (-p TEXT | --prompt-file F | --from-prompt ID) [--slot k=v]...
    [--image PATH]...(≤9) [--model M] [--resolution R] [--ratio A] [--size WxH ★]
    [--format jpeg|png] [--watermark] [--out DIR] [--dry-run]
ams gallery list [--search Q] [--limit N] | show ID | path ID | delete ID [--yes]

ams prompts list [--search Q ★] | show ID | create --title T (--body B | --body-file F)
    | update ID [--title T] [--body B | --body-file F] | restore ID VERSION | delete ID [--yes]
ams prompts slots (ID | --text T | --text-file F)
ams prompts compile (ID | --text T | --text-file F) [--slot k=v]...

ams video modes
ams video plan   <same flags as create>  ★ free: subtask, accepted params, problems; no staging, no call
ams video create --mode edit|first-last -p TEXT
    [--video PATH|URL] [--image PATH|URL] [--first-frame PATH|URL] [--last-frame PATH|URL]
    [--model M] [--resolution R] [--ratio A] [--duration S] [--audio|--no-audio] [--seed N]
    [--watermark] [--wait [--timeout S]] [--dry-run]
ams video status ID | wait ID [--timeout S] | resume [--timeout S] | list | show ID | delete ID [--yes]

ams tunnel status | up [--port P]
ams serve [--port P]
ams mcp
```

**Conventions** (all from the brief):
- `--json` prints exactly one JSON document. Logs go to stderr.
- `-p -` and `--body-file -` read stdin.
- Destructive commands need `--yes` when stdin is not a TTY; otherwise they ask.
- Records are decorated with `paths` (absolute file paths) alongside the existing `/gallery/…`
  and `/videos/…` web paths.
- `npm start` = `ai-media-studio serve`, and `npx ai-media-studio …` works inside the repo.

**Image defaults:** core decides them, in one rule for every adapter.
- An explicit `size` is used verbatim. This is the legacy HTTP field.
- Otherwise the resolution is the one given, else the model's default (`4K` for an
  unknown model). The ratio is the one given, else `auto`.
- `output_format` is the one given, else the model's catalogue default (`null` means
  omit it).

## 4. Errors and exit codes

| code | exit | HTTP | when |
|---|---|---|---|
| `USAGE` | 2 | 400 | bad flags / unknown command |
| `VALIDATION` | 2 | 400 | every existing 400 message, verbatim |
| `UPSTREAM_REJECTED` | 3 | upstream status | BytePlus non-rotating error (message extracted exactly as today) |
| `UPSTREAM_BAD_RESPONSE` | 3 | 502 | "No image returned…", "No task id…", poll errors |
| `KEYS_EXHAUSTED` | 4 | 503 | today's 503 messages, verbatim per route |
| `NOT_FOUND` | 5 | 404 | "Not found." / "Version not found." |
| `UPLOADS_UNAVAILABLE` | 6 | 400 | local file but no live public URL. HTTP keeps today's text; CLI/MCP text names `ai-media-studio serve` / `ai-media-studio tunnel up` / "pass a public URL" |
| `WAIT_TIMEOUT` | 7 ★ | — | `--timeout` hit; task left pending, `resume` continues it |
| `PATH_NOT_ALLOWED` | 2 | — | MCP file input outside the allow-list |
| `DOWNLOAD_FAILED`, `NETWORK`, `INTERNAL` | 1 | 502 / 500 / 500 | as today |

Failure shape everywhere: `{ "success": false, "error": "...", "code": "...", "raw"?: "..." }`.
The `raw` field is kept where video routes return it today.

## 5. Route ↔ command ↔ MCP tool (tool prefix `ai_media_studio_`, shortened to `…_` below)

| HTTP | CLI | MCP tool | hints |
|---|---|---|---|
| GET /api/health | health | …_health | read-only |
| GET /api/models ★ | models | …_models | read-only |
| — | size | …_size | read-only |
| POST /api/generate | image generate | …_image_generate | billed, openWorld |
| GET /api/gallery | gallery list | …_gallery_list | read-only |
| GET /api/gallery/:id | gallery show / path | …_gallery_get | read-only |
| DELETE /api/gallery/:id | gallery delete | …_gallery_delete | destructive |
| GET /api/prompts | prompts list | …_prompts_list | read-only |
| GET /api/prompts/:id | prompts show | …_prompts_get | read-only |
| POST /api/prompts | prompts create | …_prompts_create | |
| PUT /api/prompts/:id | prompts update | …_prompts_update | |
| POST /api/prompts/:id/restore/:v | prompts restore | …_prompts_restore | |
| DELETE /api/prompts/:id | prompts delete | …_prompts_delete | destructive |
| POST /api/prompts/slots ★ | prompts slots | …_prompts_slots | read-only |
| POST /api/prompts/compile ★ | prompts compile | …_prompts_compile | read-only |
| GET /api/video/modes ★ | video modes | …_video_modes | read-only |
| POST /api/video/plan ★ | video plan | …_video_plan | read-only |
| POST /api/video/generate | video create | …_video_create | billed, openWorld |
| GET /api/video/tasks/:id | video status | …_video_status | openWorld |
| — | video wait | …_video_wait | openWorld |
| — | video resume | …_video_resume | openWorld |
| GET /api/video/gallery | video list | …_video_list | read-only |
| GET /api/video/:id | video show | …_video_get | read-only |
| DELETE /api/video/:id | video delete | …_video_delete | destructive |
| — | tunnel status | …_tunnel_status | read-only |
| — | config show, keys *, tunnel up, serve, mcp | *not exposed* | |

The HTTP response bodies only gain fields; none are removed or renamed. The additions are:
- `success` on health
- `code` on errors
- `paths` on records
- `terminal`, `failureReason` and `nextPollMs` on poll responses (`?attempt=N`)
- `pendingIds` on the video list

## 6. Shared state and locking (brief §4.1)

- **Lock:** `core/stores/lock.js`, `withLock(name, fn)`.
  - It creates `.state/locks/<name>.lock` with `fs.open(…, 'wx')`, containing `{pid, at}`.
  - It retries with jittered back-off for up to 10 s. A lock whose pid is dead, or that is
    older than 30 s, is broken.
  - An in-process promise chain avoids contention with itself.
  - Locks never sit inside your data folders.
- **Atomic JSON:** write `<file>.<pid>.<rand>.tmp`, then `rename`. The formatting stays the
  same `JSON.stringify(x, null, 2)`, so the files stay diff-compatible.
- **Locked mutations:** every manifest mutation is read, mutate, write under the lock for
  that file. The mutation callback always receives a fresh read. This fixes item 6 of §1.
- **Video finalize:** download plus record update runs under the lock `video-<id>`, and
  re-checks `fullVideo` after acquiring the lock. Two pollers in different processes
  therefore download once. Downloads write to temp files and are then renamed.
- **Gallery ID:** chosen under lock `gallery-id` with today's format and collision check.
  It is reserved by creating `<id>.part` with `wx`. The `<id>.` prefix already counts as
  taken. The download streams into `.part`, the magic bytes decide the extension
  (`.jpeg` / `.png` / `.webp`, unknown falls back to `.jpeg`), and then the file is
  renamed. On failure, `.part` is removed.
- **Key state:** `.state/keys.json` = `{version, currentKeyHash, keys: {<sha256[:16]>: {uses, disabled, disabledAt, lastStatus}}}`.
  - The current index comes from `currentKeyHash`'s position in the `.env` order.
  - Each operation runs under lock `keys`.
  - `recordSuccess` and rotation apply to **the key that was actually used**, and a
    process rotates only if that key is still current. This removes double rotation when
    two processes both see a 429.
  - Resets: a key removed from `.env` is dropped. `ai-media-studio keys reset` clears
    everything. A key disabled by a 401 stays disabled until one of those happens.
  - The raw keys are never written, logged or exposed through MCP.
- `.state/` is added to `.gitignore`.

## 7. Video completion without the browser (brief §4.3)

- `core/videos.pollOnce(id)` is exactly today's status-route logic, plus finalize under
  lock. The HTTP route calls it.
- `wait(id, {timeout, onProgress})` uses `pollDelay(attempt)` and the network-error retry
  rules from §1 item 12 (immediate first poll; 5 s / 10 s / 20 s; 10 s retry, at most 12
  times). A non-OK poll gives exit 3, and the record is not marked failed (same as today).
  `resume` waits on every queued or running record concurrently.
- Core picks the failure text the UI shows:
  `task.error.message || code || JSON`, else "Generation failed upstream.".
- **UI:** it keeps its own timer, but uses `nextPollMs`, `terminal` and `failureReason`
  from the response. Only the "server unreachable" retry stays in the UI (it cannot ask
  the server), using the same constants.

## 8. Tunnel and uploads (brief §4.2)

- `core/tunnel.js` (moved with every comment) also publishes `.state/tunnel.json`:
  `{status, url, mode: quick|named|manual, ownerPid, port, updatedAt}`. It is written on
  every publish, start and stop.
- **Keep the `.env` `PUBLIC_BASE_URL` rewrite** for quick tunnels, unchanged, and document
  it as a hint only. The state file is what other processes read.
- `publicUrl.current()` resolves in this order:
  1. `AUTO_TUNNEL=0` → `.env PUBLIC_BASE_URL`.
  2. Otherwise, inside the server → its in-memory value.
  3. Otherwise → the state file, if its status is `up` and `ownerPid` is alive.
  4. Otherwise → none, so local files fail with exit 6.
- `ai-media-studio tunnel up` refuses to start if a live owner already exists. It runs a
  minimal listener that serves **only** `/videos/staging/*`, plus the tunnel and the
  hourly sweep, in the foreground until Ctrl-C.
- **Tunnel scope (your decision):** in `serve`, any request that carries
  `cf-connecting-ip` (that is, it came through cloudflared) is allowed only `GET`/`HEAD`
  `/videos/staging/*`. Anything else returns 404. Localhost is unchanged.
  `docs/named-tunnel.md` step 5 switches to `ai-media-studio tunnel status` plus a probe
  of a staged file.
- **Cleanup:** `stagedPaths` are already absolute in the record, so any process that
  finalizes can unstage. The sweep runs on `serve` and `tunnel up` (at boot, then hourly),
  and also at the start of `video create`, `wait` and `resume`.

## 9. Removing logic from the UI (brief §4.4), with no visual change

- **`app.js`:**
  - Delete `SEEDREAM_MODELS` and `buildSize`. The selects are filled from
    `/api/models` with the same labels and defaults (`endpoint`, `4K`, `3:4`).
  - Send `model`, `resolution` and `ratio`; drop `size` and `output_format`. The
    9-file limit is read from the catalogue.
  - Delete `SLOT_RE`, `parseSlots` and `compilePrompt`. On input (debounced about
    120 ms) the UI calls `/api/prompts/compile {text, values}`. The response has
    `slots [{name, default}]`, `values` (reconciled), `text` and `segments` (for the
    highlighted preview).
  - Generate sends the raw template plus a `slots` JSON field, and core compiles it.
  - The download filename takes its extension from `outputPath`.
- **`video.js`:** delete `currentSubtask` and the pre-checks in `generate()`.
  `/api/video/plan` (debounced on change) returns `{subtask, accepts: {ratio, duration},
  ratioFollows, problems[]}`. The UI only shows or hides fields and toasts
  `problems[0]`. The options come from `/api/video/modes`, and `pendingIds` drives the
  resume.
- **`library.js`:** the checks for a blank title or body and for restoring the current
  version move into core. The UI shows the returned error.
- **Unchanged:** `panic.js` and `media-nav.js` stay exactly as they are, as do the
  lightboxes, toasts, drag and drop, downloads, shortcuts and the instant search filter.
  Search is display filtering; core has the same case-insensitive substring rule for
  `--search`.

## 10. MCP and Skill (brief §5)

- **Server:** `mcp/server.js` uses the SDK's low-level `Server` over stdio, named
  `ai-media-studio`. `tools/list` is generated from `operations.js`, with the JSON Schema
  used verbatim, so it cannot drift from the CLI.
- **Tool descriptions:** billed tools begin with "BILLED: each call is a paid BytePlus
  generation." Deletes carry `destructiveHint`, generations carry `openWorldHint`, and
  reads carry `readOnlyHint`.
- **Results:** a text item with the same JSON as the CLI. Image generation also returns an
  `image` item (JPEG, longest edge at most 1024 px, via `sharp`) plus the absolute path.
- **File inputs:** they must be absolute. They are resolved with `realpath` and checked
  against `AI_MEDIA_STUDIO_ALLOWED_DIRS` (path-delimiter separated; default: the repo and
  `os.homedir()`). The repo's `.env*` and `<data>/.state/` are always denied.
- **Config:** only a README `.mcp.json` snippet
  (`"ai-media-studio": {"command": "npx", "args": ["ai-media-studio", "mcp"]}`, with the
  repo as `cwd`). No user or global MCP config is touched.
- **Skill:** `skills/ai-media-studio/SKILL.md` covers:
  - frontmatter (`name: ai-media-studio`, `description`) and the `--json` and exit-code
    discipline
  - the six workflows from the brief
  - "read `ai-media-studio models --json` / `video modes --json`", with no hard-coded sizes
  - cost etiquette: `--dry-run` first, no generation loops, and report the paths
  - installation by symlink, documented in the README only

## 11. Intentional behaviour differences

The UI produces byte-identical BytePlus bodies. Only items 1, 2 and 5 can change a body,
and only for direct API callers.

1. A direct API call to Seedream 5.0 Pro with no `size`/`resolution`/`ratio` now sends
   `2K` (the model default). Before, it sent `4K`, which that model doesn't offer.
2. The same kind of call without `output_format` now gets `jpeg`, the catalogue default
   the UI already sent.
3. New non-JPEG results are saved under their real extension.
4. Prompt create and update reject a blank body, and restoring the current version is
   rejected. The UI already blocked both.
5. Under concurrency, a different key may be chosen (the double-rotation fix). This
   changes the Authorization header only, never the body.
6. Key state survives restarts.
7. Tunnel traffic is limited to the staging folder.
8. The HTTP responses gain the fields listed in §5.
9. Node 20 or later is required.

**No data migration is needed.** Every format change is additive, and existing files and
records are never rewritten or reordered.

## 12. Phases and migration steps

- **Phase 1: characterisation tests (no production code changes).**
  - `test/helpers/legacy-server.js` copies `server.js`, `tunnel.js` and `public/` into a
    temporary directory, symlinks `node_modules`, and starts the copy with
    `AUTO_TUNNEL=0`, fake keys and `NODE_OPTIONS=--require test/helpers/mock-fetch.js`.
    Its `ROOT=__dirname` then points at the temporary directory, so your real gallery is
    never written.
  - `mock-fetch.js` intercepts the ARK host and the mock CDN URLs. It records
    `{url, method, keyIndex, body}` and replays scripted responses.
  - The tests pin:
    - the image bodies for every catalogue model, pass-through IDs, and 0, 1 and 9 refs
    - every video mode, including every 400 rejection and its message
    - key rotation on 200 uses, on 401 (disable) and on 402/403/429, and exhaustion
    - prompt versioning and restore
    - the ID format and collision suffix
    - the manifest updates, including the poll finalize and unstaging
  - Browser logic: `vm` loads the `SEEDREAM_MODELS`, `buildSize`, `SLOT_RE`,
    `parseSlots` and `compilePrompt` source out of `public/app.js`. The slot edge cases
    are covered: an empty string versus undefined, duplicate names, the first default
    winning, whitespace, and a missing default.
  - The recorded upstream bodies are saved as goldens under `test/fixtures/upstream/`.
  - Commit.
- **Phase 2: extract `core/`.** Move the code together with its comments (`git mv
  tunnel.js core/tunnel.js`) and add the stores, locks and key state.
  `server.js` = Express over core. Phase 1 tests now run against the new server, with the
  same goldens. Multi-process tests cover concurrent generations (unique IDs, no lost
  records), the key-state lock and the finalize lock. Commit.
- **Phase 3: CLI.** Add `cli/ai-media-studio.js`, the `package.json`
  `bin: {"ai-media-studio": …}`, `npm start` → `serve`, and `npm test` → `node --test`.
  Parity test: every route against its CLI command (spawned with the same mock preload)
  gives identical JSON, ignoring IDs and timestamps. Commit.
- **Phase 4: thin the server and UI.** Make the §9 changes. Then check them in a real
  browser (agent-browser) against `serve` with mocked upstream and a temporary data
  directory:
  - image generation with refs
  - the gallery, plus lightbox delete and download
  - the prompt library and slots
  - both video modes, plus the reference sub-mode
  - panic mode (on by default, unlocked by five clicks)

  After that, a read-only look at your real data. Commit.
- **Phase 5: MCP, Skill and docs.** Add `mcp/server.js`, with a scripted stdio client
  test against a mocked core: tool list, schemas, annotations, the allow-list,
  preview present or absent, and no secrets in any output. Then write `SKILL.md`, rewrite
  the README (quick start, CLI reference, exit codes, `.mcp.json` example, Skill install,
  architecture diagram), and update `docs/named-tunnel.md` and `.env.example`
  (`AI_MEDIA_STUDIO_DATA_DIR`, `AI_MEDIA_STUDIO_ALLOWED_DIRS`). Commit, then write the
  final report.

## 13. Verification

- `npm test`: every test uses `node:test`, mocked `fetch` and a temporary
  `AI_MEDIA_STUDIO_DATA_DIR`, and makes no BytePlus calls. A check confirms that the md5
  of the real `gallery/manifest.json`, `videos/manifest.json` and `prompts/library.json`
  is unchanged before and after the suite.
- Goldens: the new code's upstream bodies equal the ones recorded from the legacy code.
- Parity: route versus CLI command.
- Concurrency: tests that spawn several processes at once.
- The MCP stdio client test.
- Manual: the browser walkthrough from Phase 4, plus `ai-media-studio tunnel up` with a
  probe through the tunnel. The probe expects a staged file to return 200 and
  `/api/health` to return 404.
- Live smoke test (`AI_MEDIA_STUDIO_LIVE=1`, one image at the smallest size). **Only
  after I ask you.**

## 14. Open questions (the default is used unless you say otherwise)

1. **Key `uses` counters:** should they persist forever (default; reset with
   `ai-media-studio keys reset`), or reset each time `serve` starts, which mimics today's
   restart?
2. **Unused `node-fetch` and `uuid`:** default is to leave them; this is out of scope.
3. **`migrate-gallery.js`:** default is to leave it as is (it is a one-shot script, and
   it is not rewired to core).
4. **`package.json` `name`:** it is still `byteplus-generator`. Default is to leave it
   (only the `bin` is renamed). Say if you want the package renamed too.
