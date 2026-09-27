# REVIEW — iteration 2, pass 16

- **Commit under review:** `23d65cc` — "iter2(16): full capture refresh - gallery on the new look, floors re-justified".
- **Reviewer verdict:** **FIXED — the central discovery is TRUE and the fix is the right one, but the gate that was built to prove it could not see four of the ways the page spends world time, and one of those four is a hang.** The reproducibility claim is not merely plausible; I measured it four times over and every world-time field is bit-identical between repeat runs. The instrument, however, had a hole the same shape as the defect it was written for: the op-cost model prices some verbs out of the page's own text and hardcodes others, and the committed report — captured from that same page — agrees with a stale model, so the gate read **green** on a page that had moved the world by a step the step list never asked for.
- **Gate at verdict time:** **301/301 pure** (the count is unchanged: three fixes and every guard went *inside* two existing tests, and no check was weakened, relaxed or deleted), **111/111 world** (unchanged), `vite build` clean, lint unchanged at its five pre-existing warnings. `npm run check` exits 0.

## Verdict on each claim I was asked to check

| Claim | Verdict | Evidence |
|---|---|---|
| The harness is now anchored and a run is worth the same picture twice | **CONFIRMED, measured four ways** | Repeat runs of a probe row and of three gallery views, in the real browser: **every** `clock`, `pose`, `where`, `lamp`, `furniture`, `hold`, `awareness` and `portals` field is bit-identical between two runs of the same steps. Only rasterised luma moves, by 0.13–1.18 points. |
| The spread should now be far tighter than REVIEW-pass-15's ~1.1 luma | **CONFIRMED, and better than the claim** | Pass 15: the same view read 14.70% / 15.58% / **22.46%** lit, one sample resolving no eye at all, and `telegraph-2` came back at **0.11% — under the floor**. Pass 16: the worst pair I measured is `win` at 10.49% / 11.67%, a **1.18 point** spread, and **no repeat of any view came near its floor**. |
| The two new gates do their job | **BOTH REAL, AND BOTH INCOMPLETE** | 21 mutations of the real page. The door gate caught all four of its own; the op-cost gate caught the shutter off-by-one both ways and five page edits — and went **green on four edits it exists to catch**, plus **hung on a fifth**. Fixed, re-measured, and all nine now fail by name. |
| The report's clock fields are published and checked | **CONFIRMED, and the model is right by an independent hand** | I re-derived the entire op-cost model from `capture/main.jsx` and `rules.js` by hand — a different implementation, not `verify.mjs`'s — and it agrees with the committed report on **all fourteen views, step for step** (206 steps / 3.4333 s for `hammer-awakening`, 398 / 6.6333 for `win`, 132 / 2.15 with 3 refused for `pause`, and so on). |
| The gallery is the report | **CONFIRMED exactly** | All fourteen committed PNGs re-measured from disk with `tools/png-luma.mjs`: `litPct` and `mean` match `benchmark/captures.json` on **14 of 14**, to the last digit. |
| 14/14 on the final look, floors hold | **CONFIRMED, and `win` is the one to watch** | Tightest margin is **`win` at 10.57% against a 6.00% floor, +4.57**; next is `hammer-awakening` +15.43. `win` is also the noisiest view I measured (1.18 points A/B), so it has ~26% of its margin in hand. Not a defect — a fact the next pass should be given rather than rediscover. |
| `hammer-awakening`'s budget is a real op-cost model, not a band | **CONFIRMED** | The model walks each op's *sequence* and counts a `wait` by the page's own loop condition in float, reproducing the page's overshoot to the step: `title`'s `wait(1.9)` is 115 steps, not the 114 that exact arithmetic gives, because 114 additions of `1/60` reach 1.8999999999999981. The ceiling pass 15 rejected is gone; the comparison is now `steps === steps` on all fourteen. |
| `npm run check` holds at 301 pure / 111 world | **CONFIRMED** | `301/301 checks passed — all green`, `111/111 world checks passed`, `✓ built in 515ms`, exit 0. |

## The reproducibility measurement, in full

Two runs of the same steps, the real harness, SwiftShader. Every field below is compared, not spot-checked.

| View | committed | run A | run B | what moved |
|---|---|---|---|---|
| probe `creature-probe-stalk-1` | — | 27.25% lit, ratio 0.5790, band +1.87, anchor 1.05 px | 27.38% lit, ratio 0.5797, band +1.82, anchor 1.05 px | luma only. `pose.*` (haze 0.62, presence 0.62, eye 0.8, eyeSize 0.2329), `where.*` (16.665 m, 29.904 px/m, head 594.2616/332.7189), `baseline.animTime` 3.35, `clock.*` — **all identical** |
| `title` | 48.36% | 48.67% | 48.93% | luma only. 118 steps, `at` = `budget` = 1.9667 in both |
| `banish` | 71.40% | 70.22% | 70.51% | luma only. 220 steps, `at` = `budget` = 3.6667 in both |
| `win` | 10.57% | 11.67% | 10.49% | luma only. 398 steps, `at` = `budget` = 6.6333 in both |

For `banish` and `win` I diffed **every** field in the report entry: four differ in `banish` (three `luma.*` plus wall-clock `ms`) and four in `win` (three `luma.*` plus `ms`). `pose`, `where`, `hold`, `awareness`, `creature`, `portals`, `finale`, `furniture.*` and all four `clock` fields are identical to the last digit. That is the strongest form §6.5 can be checked in: the *world* is the same picture, twice, and the only thing left is the rasteriser.

Two honest caveats. The committed `banish` (71.40%) sits about 0.9 points above my two runs and the committed `win` (10.57%) falls between mine — the committed run was a different machine under different load, and rasterisation noise is what remains. And the pass's own uncertainty about the shimmer floor is still open: the one probe view I ran still **fails** the 0.6 luma shimmer gate (*"the stalk's heat haze is not reaching the screen… needs over 0.6 luma"*), which is the documented debt and not a regression — but it is now failing **reproducibly** (band +1.87 and +1.82, a 0.05 luma spread), which is what makes that debt re-measurable instead of noisy.

## The defects, and what I changed

All three are in `verify.mjs` — in the **instrument**, not in the game. No gameplay, page or capture behaviour changed, and the committed gallery is untouched.

### DEFECT 1 — the op-cost model could not see four ways the page spends a frame, and a stale report hid all four

The gate compares the committed report's `clock.steps` against a model built from the page's text. That comparison is only worth anything if the model can see everything the page does. It could not, in four places, and the reason it stayed green is the subtle part: **the report was captured from the same page, so a model that under-counts and a report that under-counts agree perfectly.** Two numbers that cannot see each other are not a check.

| # | Mutation to the real page | Before | After |
|---|---|---|---|
| a | one `stepWorld(SIM_DT)` added to `caught()` | **GREEN** | `capture-reset took 277 step(s) and its step list costs 278` |
| b | `begin`'s hand-off `stepWorld(SIM_DT)` doubled | **GREEN** | `street took 132 step(s) and its step list costs 133` |
| c | one `await frames(1)` added to `shutPortal()` | **GREEN** | `finale-headlights took 414 step(s) and its step list costs 417` |
| d | `swing` delegating both its frames to a `drawFrame()` helper | **GREEN** | `banish took 220 step(s) and its step list costs 218` |

(b) and (c) were hardcoded `draws(1)`s in `CLOCK_OPS`; (a) and (d) were blind spots in the reader. The reader is the worse half, because **its own docblock already described the behaviour it did not implement**:

> `frames(n)` costs `n`; `stepWorld(SIM_DT)` costs the one step it names; and `stepWorld(0)` costs nothing …

and the implementation matched `/stepWorld\((\d+)\)/`, which does not match `stepWorld(SIM_DT)` at all — the form `applyStep`'s own `begin` arm uses. `drawFrame()` was not priced either, and `drawFrame` is what `frames(1)` is made of.

**Fixed in three parts, none of them a relaxation:**

1. `pageFrames` now prices **every** form the page spends a frame in — `frames(n)`, `drawFrame(...)`, `stepWorld(...)` — **by its argument**, and an argument it cannot resolve **throws** instead of costing zero. A step nobody counts is a step nothing checks.
2. `begin`'s frame and `shut`'s two frame counts are read out of the page's own text, by a new `pageFramesAroundHold` that keeps the frames either side of a hold **in order** (order is what `pause` depends on).
3. The whole report was re-derived by hand from the page and agrees with the model on all fourteen views, so none of this moved a number that was already right.

### DEFECT 2 — a `wait` after a `pause` hung `npm run check` with no output and no failing check

`worldCost` counts a wait with `while (at - started < value)`, which is the page's own loop. §14.3's pause stops `at` — that is the entire mechanism of the pause — so a step list that waits *after* pausing can never satisfy the condition, and the loop **spun forever**. Measured: one `{ op: 'wait', seconds: 0.1 }` added to the `pause` view and `node verify.mjs` produced no output at all in 100 s, where the unmutated file answers in ~20 s.

The page itself is safe — `wait` throws up front with *"the world is paused, and §14.3 freezes its clock"*, so the capture run would have said so by name. But `npm run check` runs `verify` first, so the gate that is supposed to catch a bad step list is the thing that hangs on it, and it hangs *silently*.

**Fixed:** the loop is bounded by what the wait could possibly cost — a wait can never need more steps than its own duration at the step rate — and exceeding it throws a message naming the op, the duration and the page's own refusal. The same mutation now fails with *"worldCost: 'wait' holds for 0.1s on a world this step list has already frozen with a pause…"* in under 20 s.

### DEFECT 3 — nothing in the pure suite asserted that `run` holds the render loop before the shutter

Since `anchorClock`, the world clock cannot move whatever the loop does, so `run`'s `holdLoop()` is no longer what makes a frame reproducible — the pass says so itself, and I agree. But the probe's **control** still depends on the world being still in the stricter sense, one `_animate` between the two shutters. Removing `holdLoop()` from `run` left the pure suite **green**.

The capture harness does catch it, and by name — `__captureBaseline` refuses a control taken against a running loop (*"this is a second world"*) — so this was a coverage gap rather than a hole. But a claim the whole gallery rests on belongs in the suite that runs on every commit, not only in a capture run somebody has to remember to make. **Fixed** with two assertions: one that `run` holds the loop, one that the baseline still refuses without it.

## Everything else I mutated, and what it did

Twenty-one mutations of the real page, each reverted, each with the tree verified clean afterwards. Nine of them found something; the rest are recorded because a gate nobody has tried to fool is a gate nobody knows.

| Mutation | Result |
|---|---|
| reader-visible: `caught()` drops a frame; `takeHammer`'s hold margin 0.35 → 0.2; `PORTAL_SHUT_SECONDS` 1.2 → 1.3 | RED, with the exact step count |
| `run` draws two shutter frames / no shutter frame | RED — `title took 118 and its step list costs 119` / `... 117` |
| a second real `game.update(...)` door; `teleport` spends world time | RED — *"calls game.update( 2 times in its CODE"* |
| `anchorClock()` removed from `run`; its `getDelta` stub removed; page `SIM_DT` decoupled from the contract; `wait` loses `holdLoop`; `wait` loses `releaseLoop`-in-`finally`; `run` loses `holdLoop` | RED, each with its own sentence |
| an op a view names that `CLOCK_OPS` has never heard of (`wobble`) | RED |
| **a comment-only mention of `game.update(`** | **GREEN, correctly.** The door count is taken on `stripProse(source)`, not on the raw text, so prose about the call is not a call. This is the brief's test B and it passes as designed. |
| `wait`'s condition changed from `<` to `<=` | **GREEN, and behaviourally inert.** I checked every duration the views use — `wait(1.5)` stops at 91 steps, `wait(1.9)` at 115 — and **none of the nine ever lands exactly on the boundary**, so the two conditions are the same function. Not a gap in the gate; an arithmetic fact, stated here so nobody re-derives it. |
| `releaseLoop()` weakened to `heldHere && false` rather than deleted | GREEN. The gate is **textual** — browser code is read, not run, which the file states and pass 15 confirmed is a deliberate seam. Deleting the line is caught (RED). I am recording the limit of the seam rather than pretending a regex can be a semantic check. |

One process note, because it cost me two measurement rounds: my own mutation harness restored the tree with `git checkout`, which silently reverted **my fix** and made a whole battery meaningless. Every result above was re-measured after the restore was corrected and the tree re-verified clean between mutations. The contaminated runs also produced a spectacular false positive — `win` "failing" with `wait(1.45) never completed ... 11031 ms a yield` — which was nothing but my own load average of 4.28 on a two-core box. The clean run of the same command: `ok  win  103606 ms  lit 11.67%`. **No defect; recorded so the next reviewer does not chase it.**

## What I did not touch

`capture/main.jsx`, `src/game/capture.js`, `src/game/rules.js`, `src/game/world.js` and the committed gallery are byte-identical to `23d65cc`. I did not retune a threshold, re-shoot a frame, or touch the shimmer debt: all twelve probe frames still fail the 0.6 luma shimmer floor, and that is pass 16's documented debt, now measured rather than guessed. `win` at +4.57 over its floor is the frame to watch on the next capture run.

## Files changed by this review

- `verify.mjs` — the op-cost model prices every argument form the page uses and refuses the ones it cannot resolve; `begin` and `shut` read their frame counts from the page instead of a literal; the wait loop is bounded and fails by name; `run`'s held loop is asserted. **Every guard went inside an existing test, so the count is still 301 pure and 111 world. No threshold was weakened, relaxed or deleted.**
