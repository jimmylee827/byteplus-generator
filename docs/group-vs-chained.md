# Group generation vs chained single calls: not run yet

**Status:** not run. The comparison needs paid BytePlus calls, and the user has not yet
approved spending them. Nothing below is a result.

## The question

The EC shop's main quality problem was drift between the four shots of one garment:

- a gingham skirt's close-up became a checkerboard;
- a belt disappeared in a close-up;
- a one-shoulder top got a normal neckline in its close-up.

The fix used in production was **chaining**: generate the full-body front with
Seedream 5.0 Pro, then pass that front shot as a reference for the close-ups.

Seedream 4.5 can now be asked for a **group** of related images in one call
(`--group 4`). Does a group keep a garment identical across shots at least as well as
chaining?

## Proposed test

At most 6 paid calls. The cost is estimated from the price table in `core/models.js`.

| Arm | Calls | Model and size | Estimated cost |
|---|---|---|---|
| A: group | 1 call, `--group 4` | Seedream 4.5, 4K at 3:4 | 4 × $0.04 = **$0.16** |
| B: chained | 4 calls (front, then 3 close-ups/angles with the front as a reference) | Seedream 5.0 Pro, 2K at 3:4 | 4 × $0.09 + references after the first at $0.003 each ≈ **$0.39** |
| Total | 5 calls | | **≈ $0.55** |

Setup:

- **Garment.** Use one garment with the details that drifted before: a patterned skirt
  (gingham), or a top with a belt or an asymmetric neckline.
- **References.** Both arms use the same garment reference (`garment=…`) and the same
  character pack (`character=…`).
- **Shots.** Both arms produce the shop's standard four: front, three-quarter, front
  close-up, side close-up.
- **Prompts.** Use the shop's own prompt builder (`ec-backend/src/core/photo.js`). For
  arm A, combine the four shot descriptions into one group prompt.
- **Judging.** Build one sheet per arm with `ai-media-studio image compare` and judge by
  eye:
  - pattern scale and shape
  - every detail (belt, buttons, neckline)
  - colour
  - the same face and body
  - whether the head-less close-ups really show no face

Record here: the commands, the gallery ids, the actual cost (`usage --tag group-test`),
the two review sheets, and a verdict per criterion.

## Why it might not be a fair fight

The arms differ in model as well as method: 4.5 at 4K against 5.0 Pro at 2K.

Group generation isn't available on 5.0 Pro, so a strictly like-for-like comparison is
impossible. If arm A is clearly more consistent but weaker on garment fidelity, one
more call could help: chain a 5.0 Pro front shot into a 4.5 group. That costs one more
5.0 Pro call (≈ $0.10).
