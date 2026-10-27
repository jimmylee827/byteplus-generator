# Agent prompt: improve AI Media Studio from a real production run (EC shop)

Paste everything below the line into a coding agent (e.g. Claude Code) started in the root of
this repository.

---

You are improving **AI Media Studio** (this repo, `byteplus-generator`) based on feedback from
its first heavy production use. Keep the CLI-first architecture: logic lives in `core/`; the
CLI, HTTP API, MCP server and Skill only expose it. Do not change behaviour that existing
callers rely on unless a task below says so.

## 1. How the tool was used

The EC online shop (`../pdd_clothes_shop`) generated its whole product catalogue with
`ai-media-studio image generate`, driven by its own wrapper (`ec photo` in
`../pdd_clothes_shop/ec-backend/cli/ec.js` and `src/core/photo.js`). Read both to see the
real usage. In one session (2026-10-27/28):

- **463 paid generations**: 440 on Seedream 5.0 Pro (all 2K, 3:4), 23 on Seedream 4.5
  (4K, mostly for character reference images).
- Workload: 2 fictional models × 6 reference views; then 25 products × 4 shots
  (front, three-quarter, front close-up, side close-up) × 76 colourways; then lookbook covers.
- Every call passed 2–5 reference images: the seller's garment photo first, then the
  character's reference views. Up to 6 calls ran in parallel without errors.

## 2. What worked — keep it

- `--dry-run` printing the exact request with keys and the endpoint id masked. It was used
  before every new prompt shape, and it caught two mistakes for free.
- `--json` output with `item.paths.output`, and `--out` copying the result into the caller's
  folder. This made wrapping the CLI easy.
- `models` listing the exact pixel size for every model × resolution × ratio.
- `--prompt-file`, and the "BILLED" warnings in the help text.
- No failures, rate-limit errors or key problems at 6-way concurrency.

## 3. Problems seen, with evidence

Verify each against the code before acting. Items marked *model behaviour* are not bugs in
this repo; the tool can only reduce them through features and guidance.

1. **No batch command.** The caller wrote three separate Python thread-pool wrappers to run
   jobs 6 at a time, and one `xargs` attempt failed. There was no resume after a partial run,
   no "what's left" view, and no aggregate cost.
2. **No cost reporting.** Neither the JSON result nor any summary gives a price. The caller
   guessed US$0.04 per image and never confirmed the 5.0 Pro price. 463 calls means real
   money, and nothing told the user how much.
3. **No seed for images.** `core/operations.js` exposes `seed` for video only. A shot could
   not be re-run with one wording change while keeping everything else fixed.
4. **Group generation is hard-coded off.** `core/images.js` always sends
   `sequential_image_generation: 'disabled'` to models that support it (4.x, 5.0 Lite).
   The caller's main quality problem was **drift between shots of the same item**, because
   each of the 4 shots was a separate call:
   - a gingham skirt's close-up became a checkerboard;
   - a belt disappeared in a close-up;
   - a one-shoulder top became a normal neckline in its close-up.

   The caller's workaround was to generate full-body shots first and pass the new front shot
   as a reference for the close-ups. Seedream 4.x's group mode
   (`sequential_image_generation: 'auto'` with `max_images`) exists for exactly this kind of
   consistent set. *(Unverified here: how well it keeps a garment identical across a set.
   Test before recommending it.)*
5. **References are positional only.** Prompts had to say "the FIRST reference image shows the
   garment" and "the character reference images". Nothing records which image played which
   role. When a seller photo of a *different colourway* was passed as the garment reference,
   the colour drifted, and only a human eye caught it.
6. **No post-processing.** The caller had to write its own scripts with Pillow and sharp to
   trim backgrounds and tile reference views into sheets, compose card images, and crop and
   compare shots for review.
7. *Model behaviour, worth documenting:*
   - **Negation primes the unwanted thing.** "NOT a mullet" produced mullets twice in a row.
     Describing the wanted hairstyle positively fixed it.
   - **Multiple subjects.** A side-view body shot rendered two people; "Exactly ONE person"
     only helped some of the time.
   - **Text in images.** A 4.5 character sheet invented garbled labels until the prompt
     banned text explicitly.
   - **Layout.** A 4.5 sheet with six views overlapped portraits and wasted space. Code
     layout (trim, then tile) was the reliable fix.
   - **Copying the reference's styling.** A seller photo with turned-up hems gave every
     generated pair of trousers a contrasting cuff. The fix was a different reference photo
     plus an explicit "plain hems, no turned-up cuff".
   - **Crop drift.** Close-ups asked to exclude the head did so reliably once the prompt said
     "the frame starts below the neck". Before that, 2 of 48 still showed a face.
8. **Housekeeping.** `gallery/` grew by 463 files with no pruning or tagging. A caller cannot
   find "all images made for job X" except by keeping its own records.

## 4. Tasks, in priority order

Each task: core first, then CLI, then the HTTP/MCP/Skill surfaces, then tests in `test/`.
Do not make paid calls without asking the user. Use `--dry-run` and stubs in tests.

1. **`image batch`**: run a JSONL or JSON file of generate jobs.
   - Options: `--concurrency N` (default 4), `--max-spend USD` (stop before going over),
     `--resume` (skip jobs whose output exists or is recorded as done).
   - Write a status file next to the jobs file. Print one JSON line per finished job, then a
     summary: done, failed, skipped, spend.
   - A job = the same fields as `image generate`, plus an optional `id`, `out` and `tags`.
2. **Cost**: add a per-model price table in `core/models.js`, sourced from BytePlus pricing,
   with the source URL and date in a comment. Do not invent numbers: if a price is unknown,
   report `cost: null` and say so.
   - Add `cost` to every generate result, and `spend` to the batch summary.
   - Add `ai-media-studio usage [--since DATE] [--tag T]` that totals spend from the gallery
     manifest.
3. **`--seed`** for image generation, only for models that accept it. Check the ModelArk
   docs per model; if a model rejects the key, leave it out the same way
   `modelSupportsSequentialAndStream` does. Record the seed in the manifest and the JSON
   result.
4. **Group generation**: `--group N` (and `--group-prompt` if needed) for models that support
   `sequential_image_generation: 'auto'`.
   - Return all images with their indices. Save each to the gallery, linked by a shared
     `groupId`.
   - Refuse cleanly for models that do not support it (5.0 Pro).
   - Then spend at most 6 paid calls, **with the user's approval**, comparing a 4-shot group
     against 4 single calls for one garment. Record the result in `docs/`.
5. **Named references**: allow `--image role=path` (e.g. `garment=a.jpg`,
   `character=b.jpg`), alongside the current positional form.
   - Keep sending images in order, and prepend a short legend to the prompt
     ("Image 1 is the garment; images 2–3 are the character").
   - Store the roles in the manifest.
6. **Tags and metadata**: `--tag` (repeatable) and `--meta key=value` saved in the manifest.
   Add `gallery list --tag T` and `gallery prune --tag T --older-than D` (prune: dry run by
   default, `--yes` to delete).
7. **Image utilities** (optional, no paid calls): `image trim` (crop plain background),
   `image tile` (grid with no gaps), `image compare` (side-by-side sheet of N images with
   labels, for human review). Pure local operations with sharp, which is already a
   dependency-tree option. Check before adding one.
8. **Skill guidance**: extend `skills/ai-media-studio/SKILL.md` with the model guide in §5
   and the prompting rules in §6. Label anything not benchmarked as "observed, not tested".

## 5. Model guide to add to the Skill (observed in this run, not a benchmark)

| | Seedream 4.5 (`endpoint`) | Seedream 5.0 Pro (`dola-seedream-5-0-pro-260628`) |
|---|---|---|
| Max resolution | 4K (e.g. 3520×4704 at 3:4) | 2K (1776×2368 at 3:4) |
| Output | jpeg | png or jpeg (pinned to jpeg here) |
| Group generation | supported by the API (currently disabled by this tool) | not accepted |
| Used here for | character reference views, where 4K detail in the face mattered | every customer-facing photo: product shots, recolours, lookbook covers |
| Observed strengths | face consistency when given an angle-matched crop of the same face as the first reference | follows long, structured prompts; keeps garment details (drawstrings, pleats, collars, buttons); recolours a garment while keeping the cut; follows framing rules (no head in close-ups); natural light and editorial poses |
| Observed failures | invented text on sheets; overlapping multi-view layouts; two people in a side view; hairstyle drift (mullet, buzz cut) when the prompt used negations | pattern drift in close-ups without a full-body reference of the same item; copies styling quirks from the garment reference (turned-up hems); colour drifts if the garment reference shows another colourway |

**When to use which (recommendation, not tested head-to-head):**

- **Reference material that later images are built from** (character sheets, texture or
  pattern swatches) → **4.5 at 4K.** Resolution is the point, and later 2K outputs gain
  detail from a sharper reference.
- **Anything a customer sees** (product photos, covers, banners) → **5.0 Pro at 2K.** The
  user accepted 2K for these.
- **A consistent set of one item** (4 angles of one garment) → try **4.5 group generation**
  once task 4 exists, and compare it with 5.0 Pro single calls chained through the item's
  own front shot.
- **Quick drafts and prompt tests** → whichever is cheaper per image once task 2 gives real
  prices; use `--resolution 1K` on 5.0 Pro.

## 6. Prompting rules to add to the Skill (both models)

1. **Say what you want; avoid "not X".** Negations prime X. "Thick black hair with a full
   fringe and short tapered sides" beats "not a buzz cut, not a mullet".
2. **Name each reference's role and order** in the first lines: "The FIRST reference image
   shows the garment…; the other images show the character."
3. **One reference per job.** The garment reference should show the target colourway. For a
   new colour, use the item's own generated front shot and ask to change only the colour.
4. **Chain shots.** Generate the full-body front first, then pass it as a reference for
   close-ups and covers of the same item.
5. **State the framing as an edge**: "the frame starts just below the neck" is followed far
   better than "focus on the garment".
6. **Pin the colour**: name it and give a hex ("khaki, close to #A08B62"); say "do not
   lighten, darken, warm or saturate it".
7. **Describe hems, cuffs, straps and other edge details explicitly** when the reference photo
   styles them unusually.
8. **Always add** "Exactly ONE person" and "NO text, letters, logos or watermarks". Do
   layouts (sheets, grids, collages) in code, not in the prompt.
9. **One fixed styling sentence per item**, reused verbatim in every shot of that item, so
   the sub-outfit does not change between shots.

## 7. Done means

- Every new option appears in `--help`, `--json` output, the HTTP API, MCP and the Skill.
- `test/` covers: batch resume and spend cap, the cost table returning `null` for unknown
  prices, `--seed` and `--group` being dropped or refused for models that do not accept
  them, and named-reference ordering. No test makes a network call.
- `README.md` documents batch, usage, tags and the model guide.
- A short `docs/` note records the group-vs-chained comparison, or says it was not run.
