---
name: ai-media-studio
description: Generate or edit images with BytePlus Seedream, and generate or edit video with Seedance, through the `ai-media-studio` CLI — including named reference images, consistent image sets, batches of many images with a spend cap, cost reporting, saved prompt templates with {{slots}}, first/last-frame video, and finding, tagging, reusing or pruning past results. Use when the user asks to create, edit or animate an image or clip with BytePlus / Seedream / Seedance, or to look up, reuse or delete something in BytePlus Studio's gallery or prompt library.
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
   | 8 | `BATCH_INCOMPLETE` | some batch jobs failed or were skipped; read `summary.results`, fix, rerun with `--resume` |
   | 1 | anything else | report `error` |

3. **Don't guess models, sizes or video parameters.** Read them:
   `ai-media-studio models --json` (image models, resolutions, ratios, pixel sizes) and
   `ai-media-studio video modes --json` (video modes, which parameters each accepts,
   duration bounds).
4. **Mind the cost.** Every `image generate`, `image batch` job and `video create` is a
   **paid** BytePlus call.
   - Check a request first with `--dry-run` (free). It prints the exact request and its
     `estimatedCost`. For video, use `video plan` (free; says what is wrong).
   - Every image result carries `cost` (US$, from the official price table). It is `null`
     when the model has no known price; say so rather than guessing.
   - Before a large run, dry-run the batch and tell the user the estimated total.
   - Tell the user what was spent. `ai-media-studio usage --since 1d --json` totals it.
   - Seedream 5.0 Pro has a **pixel price tier**: up to 2.61 MP costs $0.045, above
     costs $0.09. 2K at 3:4 (1776×2368, 4.2 MP) is $0.09; 1.5K at 3:4 (1344×1792) is
     $0.045. Each reference image after the first adds $0.003. Suggest 1.5K when 2K
     isn't needed.
   - Generate once per request. Do not loop or retry generations unless the user asks.
   - Always report the output's absolute path (`item.paths.output` for images,
     `record.paths.fullVideo` for videos) back to the user.
5. **Deletes are permanent.** They need `--yes` when not run interactively. Delete only
   what the user asked you to delete.

## Workflows

### Many images: `image batch`

Use this instead of a shell loop or a thread pool. A jobs file holds one job per line
(JSON Lines). Each job takes the same fields as `image generate`, plus an optional `id`.
Relative paths are relative to the file.

```jsonl
{"id":"sweat-01-front","promptFile":"prompts/sweat-01-front.txt","images":["garment=listing/sweat-01.jpg","character=pack/head_front.jpeg","character=pack/body_front.jpeg"],"model":"dola-seedream-5-0-pro-260628","resolution":"2K","ratio":"3:4","out":"photos/sweat-01_front.jpeg","tags":["ec","sweat-01"]}
```

```bash
ai-media-studio image batch jobs.jsonl --dry-run --json                 # validate everything + estimated spend
ai-media-studio image batch jobs.jsonl --concurrency 4 --max-spend 20 --jsonl
# interrupted, or a job failed? fix it, then:
ai-media-studio image batch jobs.jsonl --resume --jsonl
```

- `--jsonl` prints one line per finished job, then a summary line. `--json` prints one
  document at the end.
- Progress is kept in `jobs.jsonl.status.json`. Running the same file again without
  `--resume` (skip what's done) or `--restart` (pay again) is refused, so a batch is
  never paid for twice by accident.
- `--max-spend` stops before the batch's recorded spend would pass the cap. Jobs with
  no known price are skipped while a cap is set.
- Every image is tagged with `meta.batch` and `meta.job`.
- A `.json` file can hold `{ "defaults": { … }, "jobs": [ … ] }`.

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

**Name what each reference shows** with `role=path`. The order is kept, the prompt gets
a legend prefix ("Image 1 is the garment; images 2 and 3 are the character."), and the
roles are saved on the record:

```bash
ai-media-studio image generate -p "Dress the character in the garment …" \
  --image garment=./listing.jpg --image character=./head_front.jpeg --image character=./body_front.jpeg --json
```

Use `--no-legend` if your prompt already explains the order.

### A consistent set of one item: `--group`

```bash
ai-media-studio image generate -p "Four photos of the same garment on the same model: front, three-quarter, front close-up, side close-up" \
  --group 4 --image garment=./listing.jpg --image character=./body_front.jpeg --json
# → .items[] (each with groupId, groupIndex), .requested, .returned, .failures, .cost
```

- Group generation works on Seedream 4.5 (the `endpoint` model), 4.0 and 5.0 Lite. It
  is refused for 5.0 Pro and Flash.
- References plus images may not exceed 15.
- The model may return fewer images than asked for; only returned images are billed.
- Whether a group keeps a garment more consistent than chained single calls is **not
  yet tested** (see the README).

**Seeds:** `--seed` exists, but no current Seedream model (5.0, 4.5, 4.0) has a seed
parameter, so it is refused for them. To vary one wording while keeping a shot
"fixed", reuse the same references, size and prompt, and change only that wording.

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

### Tags, usage and cleanup

```bash
ai-media-studio image generate -p "…" --tag ec --tag sweat-01 --meta sku=men-sweat-01 --json
ai-media-studio gallery list --tag sweat-01 --json        # everything made for one item
ai-media-studio usage --since 2026-10-27 --tag ec --json   # spend, per model
ai-media-studio gallery prune --tag drafts --older-than 30d --json        # dry run: what would go
ai-media-studio gallery prune --tag drafts --older-than 30d --yes --json  # delete (only if the user asked)
```

### Cropping and review: do it in code, not in the prompt

These local utilities are free and make no BytePlus calls:

```bash
ai-media-studio image trim view.jpeg --margin 2 --json                      # crop the empty margin around the subject
ai-media-studio image tile a.png b.png c.png d.png e.png f.png --columns 3 --out sheet.png --json
ai-media-studio image compare front.jpeg close.jpeg --label front --label close --out review.jpg --json
```

- `trim` finds the subject by its edges, so it also works on studio backdrops with
  gradients and soft shadows. It reports `unchanged` (and copies the file) when there is
  nothing to separate. Raise `--threshold` or lower `--margin` if it trims too much.
- The models overlap and mislabel multi-view sheets they are asked to draw. Generate
  each view on its own, then `trim` and `tile` them.

## Model guide

Observed in one production run of 463 images (an online clothing shop). This is **not a
benchmark**. Facts from the BytePlus docs are marked as such.

| | Seedream 4.5 (`endpoint`) | Seedream 5.0 Pro (`dola-seedream-5-0-pro-260628`) |
|---|---|---|
| Max resolution (docs) | 4K (3520×4704 at 3:4) | 2K (1776×2368 at 3:4) |
| Price (docs, read 2026-10-28) | $0.04 per image; references free | $0.045 up to 2.61 MP, $0.09 above; references after the first $0.003 each |
| Output (docs) | jpeg | png or jpeg (this tool pins jpeg) |
| Group generation (docs) | yes: `--group N` | no |
| Seed (docs) | no | no |
| Used for | character reference views, where 4K face detail matters | every customer-facing photo: product shots, recolours, lookbook covers |
| Observed strengths | face consistency when the first reference is an angle-matched crop of the same face | follows long, structured prompts; keeps garment details (drawstrings, pleats, collars, buttons); recolours a garment while keeping the cut; follows framing rules; natural light and editorial poses |
| Observed failures | invented text on sheets; overlapping multi-view layouts; two people in a side view; hairstyle drift when the prompt used negations | pattern drift in close-ups without a full-body reference of the same item; copies styling quirks from the garment reference (turned-up hems); colour drifts if the garment reference shows another colourway |

When to use which (a recommendation, not tested head-to-head):

- **Reference material later images are built from** (character sheets, swatches): 4.5
  at 4K. Later outputs gain detail from a sharper reference.
- **Anything a customer sees:** 5.0 Pro. Use 2K when the detail is worth $0.09; 1.5K
  costs half.
- **A consistent set of one item:** chain 5.0 Pro single calls through the item's own
  front shot (proven in that run). Or try 4.5 `--group` (untested).
- **Drafts and prompt tests:** 5.0 Pro at 1K or 1.5K ($0.045). Seedream 5.0 Flash
  (`dola-seedream-5-0-flash-260915`, $0.018) is cheaper but untested here.

## Prompting rules

Observed in that run, not tested systematically. They apply to both models.

1. **Say what you want; avoid "not X".** Negations prime X: "NOT a mullet" produced
   mullets. "Thick black hair with a full fringe and short tapered sides" beats "not a
   buzz cut, not a mullet".
2. **Name each reference's role and order.** `role=path` does this for you.
3. **One garment reference per job, showing the target colourway.** For a new colour,
   pass the item's own generated front shot and ask to change only the colour.
4. **Chain shots.** Generate the full-body front first, then pass it as a reference for
   that item's close-ups and covers. This stopped a gingham skirt turning into a
   checkerboard and a belt vanishing in close-ups.
5. **State framing as an edge.** "The frame starts just below the neck" is followed far
   better than "focus on the garment". It took faces in head-less close-ups from 2 in
   48 to none.
6. **Pin the colour.** Name it, give a hex ("khaki, close to #A08B62"), and say "do not
   lighten, darken, warm or saturate it".
7. **Describe hems, cuffs and straps explicitly** when the reference photo styles them
   unusually. A turned-up hem in the reference became a cuff on every generated pair of
   trousers.
8. **Always add** "Exactly ONE person" and "NO text, letters, logos or watermarks". Do
   layouts (sheets, grids, collages) in code: `image trim` and `image tile`.
9. **One fixed styling sentence per item**, reused verbatim in every shot of that item,
   so the rest of the outfit doesn't change between shots.

## Other commands

| command | what it does |
|---|---|
| `health` | key counts, whether uploads work |
| `usage [--since D] [--until D] [--tag T]` | spend from the gallery, per model |
| `size --model M --resolution R --ratio A` | the exact pixel size |
| `prompts show/update/restore/delete` | prompt history: every body change is a new version, and restore copies an old version forward |
| `config show` | effective settings, secrets masked |
| `keys status` | per-key use counts, masked |

Add `--help` to any command to see its options.
