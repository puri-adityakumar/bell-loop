# REVIEW — iteration 2, pass 9

- **Commit under review:** `e45037b` — "iter2(9): sky & atmosphere II - haze bands, pale moon, horizon silhouettes, ash motes".
- **Reviewer verdict:** **FIXED — the pass shipped a real design, and the gates defended the *brightness* of it while three of its geometry properties were read, logged, and never compared to anything.** The world is otherwise sound: the render-order argument is the strongest in the repo, the luma budget is measured on the built materials in the renderer's own colour space, the ash exclusion is geometric rather than a brightness allowance, and the moon-before-bands derivation is asserted rather than restated. The defect this review found is not a bug in the shipped world — `MOON_RADIUS = 5.2` at 236 m is correct and looks correct. **The defect is that nothing would have noticed if it had been wrong**, and 7 of 45 external mutations demonstrated exactly that.
- **Gate at verdict time:** 233/233 pure, 84/84 world → **234/234 pure, 84/84 world** (post-review; +1 pure check, +2 source claims, +12 mutations). External sky mutation suite: **37/45 → 44/45 caught**, the one remaining survivor argued below rather than papered over.

## What the pass does

`e45037b` replaced a flat `scene.background` with a full atmosphere: a gradient dome, a pale moon at a fixed bearing, three additive haze strata at three radii, a hazed horizon ring of tower silhouettes, and 90 drifting ash motes. The architectural claim is the good part and it holds — everything is drawn in the world's own pass, with no second camera and no render target, and the sky is a sibling of the wrapped street group rather than a child of it.

## Finding 1: three geometry properties were read, logged, and never asserted

`SKY_NUMBERS` in `verify.mjs` reads `MOON_RADIUS`, `MOON_DISTANCE`, `MOON_ELEVATION`, `ASH_SIZE`, `ASH_BOX` and `HORIZON_RADIUS` out of the source. Before this review, three of those were used **only** to build the log line the luma budget prints. A number that is printed is not a gate.

The luma budget is a genuinely good gate, and it is the reason the gap survived review: it measures how **bright** the moon is (21.4 luma) and how bright the whole pass is (44.3, 30% of `EYE_MIN`). "Dim" and "disc" are independent properties. A moon can be perfectly dim and completely the wrong size, and this harness could not see it.

`skyView.js` states all three properties itself, in the docblock above the constants:

- *"5.2 m at 236 m is 2.5° of arc… What it must NOT become is a second sun, and the constraint that keeps it honest is the arc — **past about 6° it stops reading as a moon and starts reading as a light**"*
- *"236 m puts it BEYOND `HORIZON_RADIUS`, so a tower is always in front of it… which is the only arrangement in which a moon reads as far away"*
- *"(a true-scale moon) would be 3 px: a rounding artefact"*

Each is a design decision with a stated numeric bound. None was a test. A 45-mutation run against `skyView.js` confirmed the gap — the following mutants left **both** harnesses fully green:

| Mutant | Measured | Verdict |
|---|---|---|
| `MOON_RADIUS = 34` (6.5x) | **16.4 deg of arc** — a sun, covering 44% of the frame height | **real defect** |
| `MOON_DISTANCE = 30` | inside the 232 m horizon ring; nothing stands in front of it | **real defect** |
| `MOON_ELEVATION = -0.4` | the disc sits at y < 0, below the road | **real defect** |
| `ASH_SIZE = 0.9` (16x) | a 4.2 px mote becomes a 68 px floating blob | **real defect** |

The arc is the load-bearing one, and the module's own 6-degree limit is what makes it falsifiable. A check that restated `5.2` would fail the next legitimate retune and teach the next pass to delete it, so the new gate asserts the **relation** instead — `2*atan(r/d) < 6` degrees for the ceiling, `>= 1.28` degrees for the floor (the "3 px rounding artefact" end), `MOON_DISTANCE > HORIZON_RADIUS` for the occlusion claim, and the mote's apparent size at the box edge against the same 20 px the comment names. Committed values: **2.52 deg arc, 25.2 px, 236 m against a 232 m ring, 137 m up, motes 4.2 px at 15 m.**

## Finding 2: the haze strata could collapse into one smear without complaint

The same run found two more survivors in the band table, and the file's own docblock is as explicit about these:

- *"**WHY THREE, AND WHY AT THREE RADII**"* — and the reason given is quantitative: the fog is *"18% opaque at 52 m and 34% at 86 m"*, so distinct radii are what make `fog: true` readable. Collapsing the radii (a `Math.cos(angle) * 86` mutation) puts all three bands at one distance, and the fog then eats them **together** — the dusk loses the depth cue the pass is built on.
- `const angle = 0 * band.drift` freezes every band. A band that no longer turns is a pasted texture, which is precisely what the `fog: true` note in the same docblock rejects. It was green because the gates checked the *luma* of the bands and nothing checked whether they *move*.

The new claim asserts three distinct **ascending** radii, three ascending heights, and a non-zero drift on every band. The `+0`/`-0` case matters: a check that only asked that a `drift` field exists is satisfied by zero, which is the frozen mutant.

### Finding 2a: the first version of that claim was itself wrong

With the frozen-drift mutant closed, a clean 45-mutant re-run came back **42 caught, 3 survived** — and two of the three were not gaps in the *world*. They were gaps in the claim this review had just written:

| Mutant | What it changes | Why the first claim missed it |
|---|---|---|
| `Math.cos(angle) * 86` | the **use site**, not the table | the table still read 52/68/86 and was perfectly ordered |
| `band.height` -> `1.6` | the **use site**, not the table | the table still read 26/41/58 and was perfectly ascending |

A claim that checks a table is a claim about a **literal**. An `update()` that hard-codes the far band's radius, or puts every band on the horizon line, leaves the table flawless and ignores it — so the first version of this claim would have passed a sky in which all three strata sat at 86 m. The fix is the same move the file already uses for render order: assert the **derivation**, not the value. The claim now requires the `mesh.position.set` call to read `band.radius` on both axes and `band.height` on the Y, and requires every height to clear the 1.6 m eye.

This is worth stating plainly rather than quietly fixing, because it is the same failure this repo's comments warn about twice — *"a claim that cannot be broken by the bug it names is not a claim"* — and the review reproduced it one layer up, in the very check written to prevent it.

## What was checked and found correct

- **Render order.** All four sky orders negative, moon `-100` before bands from `-98`, derived as `BAND_RENDER_ORDER_BASE + index` with an explicit assertion that the sign has not flipped — the mutation for the reversed sign is caught, which is the property a restated `-98` would miss.
- **The luma budget.** 44.3 luma worst case = moon 21.4 + bands 15.8 + ash 7.1, which is 30% of the `EYE_MIN` 150 that a creature's eye must clear. Measured on the built materials in the renderer's own colour space, with a comment recording that the naive sRGB version read the moon at 3.3 where the renderer produces 21.4.
- **The ash exclusion is geometric, not a brightness budget.** `ASH_MIN_Y` is derived from the pupil gate's stand-off, so it holds however the ash is retuned. A `ASH_MIN_Y = -1.0` mutation is caught.
- **Portal and eye gates still hold.** Portal pupils measure 8 and 7 px against a ceiling of 20; sky luma is 29.6% of the eye minimum. The new ash-size gate cannot loosen the pupil gate, because the exclusion is a height and the new assertion is an apparent size.
- **Title-view zero sky deltas are correct, not a missed measurement.** The title is the unstarted view with no `begin` step, so there is nothing for the sky to have advanced from. Confirmed against the built scene rather than assumed.
- **The haze is genuinely on screen.** A same-task `gl.readPixels` diff on `street` measured the bands at **10.87% of pixels changed (100,217 px, max delta 94)** against a **0-pixel** control, so the strata are a real contribution to the frame and not a pass that only satisfies its own arithmetic.

## Methodology note

Mutation runs and browser captures must not run concurrently. 45 full-suite mutations starve Chromium and produce `__captureReady` timeouts that look like capture failures rather than resource contention. For the same reason the scratch tree the mutation runner rewrites must not be touched by any other process during a run — a concurrent edit invalidates the results, which is how one intermediate run in this review had to be discarded and repeated. Screenshots are also unstable with `preserveDrawingBuffer: false`; same-task `gl.readPixels` is the valid measurement path.

## Changes made

`verify.mjs` only; **no source file was modified**. `skyView.js` at `e45037b` is correct as committed.

- **+1 pure check**, "the moon is a disc at a fixed bearing, not a sun, a smudge, or a thing below the street", asserting the arc ceiling and floor, `MOON_DISTANCE > HORIZON_RADIUS`, positive elevation, and the mote's apparent size.
- **+2 source claims** in `skyClaims` — "the moon stays a resolvable disc beyond the ring, and the motes stay dust" and "the three haze strata are at three distinct, ascending radii and never stop drifting" — so the new properties are enforced on the source too and cannot rot back into comments.
- **+12 mutations**, one per defect each way, including the `0`-drift and true-scale-moon cases that a weaker check would pass, and the two use-site mutations that caught this review's own first claim.

All four original geometry survivors and all three band survivors are now caught, each failing loudly in the real harness (232/234 or 233/234) rather than only inside the claims table. The claims table reports **9 source contracts, 21 mutations, every one caught**.

## Not fixed / known debt

- **`MOON_BEARING` is the one remaining external survivor, and it is deliberately left that way.** The comment argues the bearing should be a *constant* rather than a hash of the seed, so the moon is in the same place nightly. A mutation to a different constant (`1.94` -> `0.4`) does not violate that argument: the moon is still in the same place every night, just a different place. There is no falsifiable property here to assert — only a restated `1.94`, which would fail the next legitimate retune and teach the next pass to delete the check. Gating it would make the table look stronger while measuring nothing, so it is left ungated and recorded here instead. The determinism property that *is* falsifiable (the same time twice gives the same sky) is already asserted and survives the mutation.
- The external mutation harness is a scratch script under `/tmp`, not a committed artifact, so this class of gap is only found when someone re-runs it. A committed runner would be the durable fix and is out of scope for a review.
