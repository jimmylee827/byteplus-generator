# Agent prompt: make BytePlus Studio CLI-first, with Skill + MCP access

Paste everything below the line into a coding agent (e.g. Claude Code) started in the
root of this repository.

---

You are refactoring **BytePlus Studio** (this repo, `byteplus-generator`) so that a
command-line tool is the core of the product. The web UI and the HTTP API become thin
wrappers over that core, and AI agents reach the same core through a Skill and an MCP
server. The working app must keep behaving exactly as it does now.

## 1. What exists today (verify before changing anything)

Read these files in full first: `server.js`, `tunnel.js`, `migrate-gallery.js`,
`public/app.js`, `public/video.js`, `public/library.js`, `public/panic.js`,
`public/media-nav.js`, `public/index.html`, `README.md`, `.env.example`,
`docs/named-tunnel.md`.

My reading of the current state, which you must confirm against the code:

- **`server.js` (~1100 lines, Express 5, CommonJS)** holds nearly all business logic in
  route handlers:
  - `KeyManager`: rotates `BYTEPLUS_API_KEYS`, swaps after 200 uses, rotates on
    401/402/403/429, disables a key on 401. **State is in memory only.**
  - Image generation (`POST /api/generate`): Seedream via
    `ark.ap-southeast.bytepluses.com/api/v3/images/generations`; `endpoint` resolves to
    `ENDPOINT_ID`, other model IDs pass through; `modelSupportsSequentialAndStream()`
    drops keys Seedream 5.0 Pro rejects; reference images go as data URIs (max 9 × 10 MB);
    the result is downloaded into `gallery/` with a timestamp ID and recorded in
    `gallery/manifest.json`.
  - Gallery read/delete, the prompt library with versioning and restore
    (`prompts/library.json`).
  - Video (Seedance 2.5, `contents/generations/tasks`): `buildVideoTaskBody()` and
    `videoSubtask()` encode hard-won API rules (edit / reference / first_last; which of
    ratio/duration are legal in each; duration 4–30 s; frames can't mix with reference
    media). Local uploads are **staged** into `videos/staging/` and exposed through a
    public URL because BytePlus only fetches URLs; staged files are swept after 6 h.
    Task status is polled; on success the clip and keyframes are downloaded into
    `videos/` and `videos/manifest.json` is updated.
  - `tunnel.js` supervises a cloudflared quick or named tunnel and republishes the
    public URL (also into `.env`).
- **Business logic currently living only in the browser** (this is what most violates
  CLI-first):
  - `public/app.js`: `SEEDREAM_MODELS` (models, resolutions, defaults, output format,
    the aspect-ratio → pixel-size matrix) and `buildSize()`.
  - `public/app.js`: prompt slot templating: `{{name:default}}` syntax, `parseSlots()`,
    `compilePrompt()` (an empty string is a deliberate value; only `undefined` falls
    back to the default; duplicate names share one value; first default wins).
  - `public/video.js`: task polling cadence, retry-on-network-blip, and resuming
    pending tasks after reload.
  - `public/panic.js`: "panic mode" hides history from before the current page load.
    This is **presentation only**; keep it UI-only (see §6).
- Data folders `gallery/`, `videos/`, `prompts/`, `archive/` and `.env` are git-ignored
  **user data and secrets**.

If anything above is wrong or incomplete, say so in your plan before building on it.

## 2. Target architecture

```
core/        all logic: pure functions + stores; no Express, no console, no process.exit
  config.js     env loading/validation; secrets never returned unmasked
  keys.js       key rotation, with state persisted (see §4.1)
  models.js     model catalogue + size matrix (moved from public/app.js)
  slots.js      parse/compile prompt templates (moved from public/app.js)
  images.js     build request, call upstream with rotation, save, record
  videos.js     validate, build task body, stage, create, poll, finalize, wait
  stores/       gallery, videos, prompts manifests (atomic writes + lock)
  staging.js, tunnel.js, errors.js (typed errors with stable codes)
cli/         `studio` command: argument parsing + output formatting only
server/      Express app: each route = parse request → one core call → serialize
mcp/         MCP server: each tool = one core call
skills/byteplus-studio/SKILL.md
public/      the existing UI, with its business logic removed
```

Rules:

1. **One core, three thin adapters (CLI, HTTP, MCP).** An adapter may parse input and
   format output. It may not decide anything: no validation rules, no defaults, no
   status mapping, no size computation.
2. **Every HTTP route and every MCP tool maps to a CLI command** that returns the same
   JSON. Use the same serializer for all three. A person at a terminal must be able to
   see and do everything the UI can. The UI and server keep calling the core in-process
   rather than spawning the CLI per request; parity is guaranteed by the shared
   function plus a parity test (§7).
3. Keep `npm start` working as an alias of `studio serve`.
4. Keep CommonJS and the current dependency style, unless you show a concrete reason
   to change it in your plan. Node ≥ 20. Use `node:test` for tests.

## 3. CLI contract (`studio`)

Expose through `package.json` `bin` so `npx studio …` works in the repo (and
`npm link` works globally).

Proposed surface; refine it in your plan, but keep the principles:

```
studio health                         keys active/total, video enabled, uploads available, public URL
studio config show                    effective config, API keys masked (last 4 chars only)
studio models                         models, resolutions, ratios, defaults, output formats
studio size --model M --resolution R --ratio A   → "1728x2304"

studio image generate (-p TEXT | --prompt-file F | --from-prompt ID) [--slot k=v]...
       [--image PATH]... (≤9) [--model M] [--resolution R] [--ratio A]
       [--format jpeg|png] [--watermark] [--out DIR] [--dry-run]
studio gallery list [--search Q] [--limit N] | show ID | path ID | delete ID [--yes]

studio prompts list | show ID | create --title T (--body B | --body-file F)
       | update ID [--title] [--body|--body-file] | restore ID VERSION | delete ID [--yes]
studio prompts slots (ID | --text T)           → slot names + defaults
studio prompts compile (ID | --text T) [--slot k=v]...

studio video create --mode edit|first-last -p TEXT
       [--video PATH|URL] [--image PATH|URL] [--first-frame PATH] [--last-frame PATH]
       [--resolution] [--ratio] [--duration S] [--audio|--no-audio] [--seed N]
       [--watermark] [--wait [--timeout S]] [--dry-run]
studio video status ID | wait ID [--timeout S] | resume | list | show ID | delete ID [--yes]
studio video modes                     legal parameters per mode (for UIs and agents)

studio tunnel status | up
studio serve [--port P]                web UI + HTTP API (today's server)
studio mcp                             MCP server over stdio
```

Output and error conventions (apply to every command):

- `--json` prints exactly **one** JSON document to stdout. Without it, print readable
  text. Logs, progress and warnings go to **stderr** only.
- Success: `{ "success": true, ... }`. Failure: `{ "success": false, "error": "<human
  message>", "code": "<STABLE_CODE>" }`, the same shape the HTTP API already uses.
- Stable exit codes: `0` ok, `2` usage/validation, `3` upstream rejected the request,
  `4` all keys exhausted, `5` not found, `6` uploads unavailable (no public URL),
  `1` anything else. Document them.
- Reading input: `-p -` and `--body-file -` read stdin.
- `--dry-run` on anything that costs money prints the exact upstream request body
  (images as `<data-uri: N bytes>`, keys never shown) and exits without calling
  BytePlus.
- Destructive commands need `--yes` when stdin is not a TTY; otherwise they ask.
- Output paths are absolute filesystem paths, plus the `/gallery/...` web path where
  one exists.

## 4. Problems you must solve (not just move code)

### 4.1 Shared state between processes

Today the server is the only writer. After this change the CLI, the server and the
MCP server can run at the same time.

- **Key rotation state** (uses, current index, disabled keys) must persist, e.g. in
  `.state/keys.json` (git-ignored), keyed by a hash of each key, never the key itself.
  Reads and writes go through a lock. Decide and document what resets it (e.g. a key
  disabled by 401 stays disabled until `.env` changes).
- **Manifest writes** (`gallery`, `videos`, `prompts`) are read-modify-write today. Make
  them atomic (write temp file + rename) and serialized with a lock file, so two
  processes can't lose each other's records.
- **Gallery IDs** must stay unique across processes. Today they're timestamp-based with
  a collision suffix checked against the filesystem; keep that format, but reserve the
  ID under the same lock.

### 4.2 Tunnel and uploads from the CLI

Local video/frame uploads only work while a public URL exists. Today `server.js` owns
the tunnel.

- Persist the tunnel's current public URL and status to `.state/tunnel.json`.
- `studio video create` with local files uses that URL when it is live; otherwise it
  fails with exit code `6` and tells the user to run `studio serve` or `studio tunnel up`
  (or to pass a public URL instead).
- Staged files must still be cleaned up after the task is terminal, whichever process
  polls it, and the 6-hour sweep must still run.
- Keep the existing `.env` `PUBLIC_BASE_URL` rewriting behaviour, or replace it with the
  state file and explain why in the plan. Don't silently drop it.

### 4.3 Video completion without the browser

`studio video wait` and `studio video resume` must poll, download outputs, update the
manifest and unstage inputs using the same core function the HTTP status route uses.
Keep the current cadence and retry-on-network-error behaviour (read `public/video.js`
for the exact delays) as the core default. The UI may keep its own timer for display,
but every decision (terminal or not, what to download, which error to show) comes from
the core.

### 4.4 Remove logic from the UI

- Replace `SEEDREAM_MODELS` and `buildSize()` with `GET /api/models` (= `studio models`).
  The UI sends model + resolution + ratio; the core computes the pixel size. Keep
  accepting the old `size` field for backward compatibility.
- Replace `parseSlots`/`compilePrompt` with `POST /api/prompts/slots` and
  `/api/prompts/compile` (debounced from the UI). Port the exact semantics and cover
  them with tests before deleting the browser copy.
- Video form rules come from `GET /api/video/modes` (= `studio video modes`), so the
  UI only shows/hides fields and never re-implements validation.
- Leave purely visual behaviour in the UI: layout, lightbox, toasts, downloads, drag &
  drop, keyboard shortcuts, panic mode.

## 5. AI access

### 5.1 MCP server (`studio mcp`)

- Use the official `@modelcontextprotocol/sdk`, stdio transport.
- One tool per core capability, named like `studio_image_generate`,
  `studio_gallery_list`, `studio_gallery_get`, `studio_gallery_delete`,
  `studio_prompts_*`, `studio_prompts_compile`, `studio_models`, `studio_video_create`,
  `studio_video_status`, `studio_video_wait`, `studio_health`. Inputs are JSON schemas
  generated from (or checked against) the same definitions the CLI uses.
- Tool descriptions must state cost: each image or video generation is a billed
  BytePlus call. Mark deletes with `destructiveHint: true` and generations with
  `openWorldHint: true`.
- Results return the same JSON as the CLI. For images, also return a small preview
  (resized, ≤ 1024 px long edge) as MCP image content so the calling model can see it,
  plus the absolute file path to the full-size file.
- Inputs that reference local files take absolute paths. Reject paths outside an
  allow-list that defaults to the repo and the user's home directory; document the
  setting.
- Never expose API keys, `.env` contents, or the raw key-state file through any tool.
- Ship an example `.mcp.json` snippet in the README. **Do not** edit any user-level or
  global MCP configuration yourself.

### 5.2 Skill (`skills/byteplus-studio/SKILL.md`)

A Claude Code Skill that teaches an agent to use the **CLI** (works even without MCP):

- Frontmatter `name` and a `description` that says when to use it (generating or
  editing images with Seedream, generating/editing video with Seedance, managing the
  gallery or prompt library).
- Always use `--json` and parse stdout; check `success` and the exit code.
- Workflows with copy-paste examples: text-to-image; image edit with reference images;
  using a saved prompt with slots; video edit from a clip; first/last-frame video with
  `--wait`; finding and reusing a past result.
- Model and size guidance comes from `studio models --json`, not from the skill text,
  so it can't go stale.
- Cost etiquette: prefer `--dry-run` to check a request; don't loop generations without
  the user asking; report output paths back to the user.
- Document installation (symlink into `.claude/skills/` of a project or the user's
  skills folder) in the README. Don't install it yourself.

## 6. Hard constraints

- **No behaviour regressions.** Every request body sent to BytePlus must be
  byte-for-byte what the current code sends for the same inputs. Capture today's bodies
  first (§7) and compare.
- **Preserve the comments.** The comments in `server.js` and `tunnel.js` record API
  behaviour learned by trial and error (unsupported keys, duration bounds, why data URIs
  and file IDs fail, ratio rules per mode). Move them with the code they explain.
- **User data is sacred.** Never delete, rewrite or reorder existing items in
  `gallery/`, `videos/`, `prompts/`, `archive/`. Data formats stay backward compatible;
  if a format must change, write a migration that backs up the file first and is
  idempotent, and ask me before running it.
- **Secrets:** never print, log, commit or return API keys or `.env` values.
  `.state/` goes into `.gitignore`.
- **Costs:** tests must not call BytePlus. Mock `fetch`. A live smoke test (one
  smallest-size image) may exist behind an explicit env flag; ask me before running it.
- Panic mode stays exactly as it is: UI-only, on by default every page load, unlocked
  by five quick clicks on the brand mark, not persisted. The CLI and MCP list all
  history; that is intended.
- Don't change the visual design of the web UI.

## 7. Working method

**Phase 0: inventory and plan (stop for approval).**
Write `docs/cli-first-plan.md` with: corrections to §1, the final command list, the
HTTP route ↔ CLI command ↔ MCP tool mapping table, the state/locking design, the
tunnel decision (§4.2), the migration steps, and open questions. Then stop and wait
for my approval.

**Phase 1: characterisation tests (before moving any code).**
Write tests that pin today's behaviour: request bodies for every image model and every
video mode (including the rejection cases), key rotation, slot parse/compile edge
cases, prompt versioning and restore, ID generation, manifest updates, the size
matrix. They must pass against the current code.

**Phase 2: extract `core/`.** Move logic out of `server.js` and the browser into
`core/` with no behaviour change. Phase 1 tests must still pass.

**Phase 3: CLI.** Build `studio` on the core. Add a **parity test**: for each HTTP route,
call the route and the matching CLI command with the same input and assert identical
JSON (excluding timestamps and IDs).

**Phase 4: thin the server and UI.** Routes become one-line core calls; UI logic is
replaced by the new endpoints from §4.4. Check the UI manually in a browser: image
generation, gallery, lightbox delete/download, prompt library with slots,
both video modes, panic mode.

**Phase 5: MCP + Skill + docs.** Build `studio mcp` and `SKILL.md`. Test the MCP server
with the MCP Inspector or a scripted stdio client using a mocked core. Rewrite the
README: quick start, full CLI reference, exit codes, `.mcp.json` example, Skill
installation, architecture diagram.

Work on a new branch. Commit at the end of each phase with a clear message. Do not push
or open a PR unless I ask. At the end, report what changed, what was verified and how,
what wasn't verified, and any behaviour that differs from before.
