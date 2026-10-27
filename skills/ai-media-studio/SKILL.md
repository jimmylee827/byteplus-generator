---
name: ai-media-studio
description: Generate or edit images with BytePlus Seedream, and generate or edit video with Seedance, through the `ai-media-studio` CLI — including reference images, saved prompt templates with {{slots}}, first/last-frame video, and finding or reusing past results in the local gallery and prompt library. Use when the user asks to create, edit or animate an image or clip with BytePlus / Seedream / Seedance, or to look up, reuse or delete something in BytePlus Studio's gallery or prompt library.
---

# ai-media-studio

`ai-media-studio` is the command-line core of BytePlus Studio. Everything the web UI
can do, it can do. Run it from the BytePlus Studio repository folder:

```bash
npx ai-media-studio <command> … --json      # or `ai-media-studio` if it was npm-linked
```

## Ground rules

1. **Always pass `--json`** and parse stdout. It holds exactly one JSON document.
   Progress and logs go to stderr; ignore them unless something fails.
2. **Check `success` and the exit code.** A failure prints
   `{ "success": false, "error": "…", "code": "…" }`.

   | exit | code | what to do |
   |---|---|---|
   | 0 | — | done |
   | 2 | `USAGE` / `VALIDATION` / `PATH_NOT_ALLOWED` | fix the arguments; `error` says how |
   | 3 | `UPSTREAM_REJECTED` / `UPSTREAM_BAD_RESPONSE` / `TASK_FAILED` | BytePlus refused, or the task failed; report `error` |
   | 4 | `KEYS_EXHAUSTED` | every API key is out of quota or invalid; tell the user |
   | 5 | `NOT_FOUND` | wrong id |
   | 6 | `UPLOADS_UNAVAILABLE` | local video inputs need a public URL; see "Video from local files" |
   | 7 | `WAIT_TIMEOUT` | the task is still running; continue later with `video wait ID` |
   | 1 | anything else | report `error` |

3. **Don't guess models, sizes or video parameters.** Read them:
   `ai-media-studio models --json` (image models, resolutions, ratios, pixel sizes) and
   `ai-media-studio video modes --json` (video modes, which parameters each accepts,
   duration bounds).
4. **Mind the cost.** Every `image generate` and `video create` is a **paid** BytePlus
   call.
   - Check a request first with `--dry-run` (free; prints the exact request) or
     `video plan` (free; says what is wrong).
   - Generate once per request. Do not loop or retry generations unless the user asks.
   - Always report the output's absolute path (`item.paths.output` for images,
     `record.paths.fullVideo` for videos) back to the user.
5. **Deletes are permanent.** They need `--yes` when not run interactively. Delete only
   what the user asked you to delete.

## Workflows

### Text to image

```bash
ai-media-studio image generate -p "A red fox in fresh snow, golden hour" --ratio 3:4 --dry-run --json
ai-media-studio image generate -p "A red fox in fresh snow, golden hour" --ratio 3:4 --json
# → .item.paths.output  (also .item.id for later)
```

- `--model` takes `endpoint` (the default, Seedream 4.5) or a model id listed by
  `models`.
- `--resolution` must be one that model offers. `--ratio auto` lets the model decide.
- `--size WxH` sets exact pixels.
- `--out DIR` also copies the result into DIR.

### Image edit with reference images

```bash
ai-media-studio image generate -p "Same person, now in a rain-soaked neon street" \
  --image ./portrait.jpg --image ./style.png --json
```

Up to 9 local images, 10 MB each. They are sent as data, so they need no tunnel.

### Using a saved prompt with slots

```bash
ai-media-studio prompts list --search city --json            # find it → .items[].id
ai-media-studio prompts slots PROMPT_ID --json               # → .slots [{name, default}]
ai-media-studio prompts compile PROMPT_ID --slot style=noir --json   # → .text, exactly what is sent
ai-media-studio image generate --from-prompt PROMPT_ID --slot style=noir --json
```

Slots you don't set use their default. `--slot name=` (empty) deliberately sends
nothing for that slot. Save a new template with
`prompts create --title T --body "A {{style:cyberpunk}} city"`.

### Video edit from a clip

```bash
ai-media-studio video plan -p "Make it a night scene in a neon city" --video https://example.com/clip.mp4 --json
ai-media-studio video create -p "Make it a night scene in a neon city" --video https://example.com/clip.mp4 --wait --timeout 900 --json
# → .status "succeeded", .record.paths.fullVideo
```

- With a clip, the aspect ratio and duration come from the clip. Don't pass `--ratio`
  or `--duration`; `video plan` shows what is accepted.
- The source clip must run 4–30 s and be at least about 854×480.
- `--image` adds a reference image. With no clip at all, an image alone animates that
  image, and then `--ratio` and `--duration` apply.

### First/last-frame video

```bash
ai-media-studio video create --mode first-last -p "Slow push-in as the sun sets" \
  --first-frame ./start.png --last-frame ./end.png --duration 6 --wait --timeout 900 --json
```

The ratio follows the first frame. A last frame is optional, and frames can't be mixed
with a reference clip or reference image.

### Video from local files (exit 6)

BytePlus downloads video inputs from a public URL, so local files need a live tunnel.

1. Check it with `ai-media-studio tunnel status --json`.
2. If it is down, ask the user to keep `ai-media-studio serve` (the web app) or
   `ai-media-studio tunnel up` running in another terminal.
3. Alternatively, pass public `https://` URLs instead of local paths.

### Long-running tasks

`video create` without `--wait` returns a `taskId` immediately. Then:

- `ai-media-studio video wait ID --timeout 900 --json` waits for that task to finish.
- `ai-media-studio video status ID --json` checks it once.
- `ai-media-studio video resume --json` finishes every task still pending.

The finished clip is downloaded automatically.

### Finding and reusing a past result

```bash
ai-media-studio gallery list --search fox --limit 5 --json   # images, newest first
ai-media-studio gallery show IMAGE_ID --json                 # → .item.prompt, .item.paths.output
ai-media-studio video list --json                            # videos, with .pendingIds
```

- To vary a past image, reuse its `prompt` with `image generate -p …`.
- To edit the past image itself, pass its `paths.output` to `--image`.
- The gallery lists all history; the web UI's "panic mode" does not apply to the CLI.

## Other commands

| command | what it does |
|---|---|
| `health` | key counts, whether uploads work |
| `size --model M --resolution R --ratio A` | the exact pixel size |
| `prompts show/update/restore/delete` | prompt history: every body change is a new version, and restore copies an old version forward |
| `config show` | effective settings, secrets masked |
| `keys status` | per-key use counts, masked |

Add `--help` to any command to see its options.
