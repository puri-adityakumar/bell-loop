# REVIEW — iteration 2, pass 15

- **Commit under review:** `f7d11cc` — "iter2(15): creature in the new light - per-state presentation retune".
- **Reviewer verdict:** **FIXED — the pass is real, its instrument is real, and its central discovery is TRUE. Three of its own docblocks state a finding its own evidence contradicts, and its headline row-level gate could not execute in the world it ships.** Nothing behavioural was wrong: the retune's arithmetic holds, the window story is correct, and every regression guard holds. What I changed is evidence and reachability, and I corrected three misdiagnoses that would have sent the next pass after the wrong thing.
- **Gate at verdict time:** **296/296 pure** (the count is unchanged: I strengthened three existing checks and the probe's own `probeGates`, and added no parallel ones), **111/111 world** (unchanged), `vite build` clean, lint unchanged at its five pre-existing warnings. Nothing was weakened, relaxed or deleted.

## Verdict on each claim I was asked to check

| Claim | Verdict | Evidence |
|---|---|---|
| (1) The probe infra is new; its gates are real | **CONFIRMED, with one gate that could not run** | Four mutations of the real harness in a real browser (§ below). The staging, silhouette and baseline-clock gates each fail with their own sentence. The **eye-margin gate could not execute**: the row table was gated on `report.failed === 0`, and the shimmer floor fails 12/12, so `report.probe` was never produced in any run a person can make. **Fixed.** |
| (1) The probe fails when the creature is invisible | **CONFIRMED** | `telegraph` presence 0.78 → 0: `FAIL creature-probe-telegraph-1 no creature in … no eye quad anywhere in the frame — there is no creature in this picture to be a hole`, pose recorded as `present: false, presence: 0, haze: 0`. |
| (2) Telegraph presence 0.3 → 0.78, probe ratio 0.429 | **CONFIRMED** | `creature-probe-telegraph-1` ratio 0.4294 against `SILHOUETTE_MAX` 0.62; worst across all five rows 0.5745 (`stalk`), against the commit's "0.575 — stalk". Anchors 0.58–1.42 px against a 24 px ceiling. |
| (2) The old banish gate was counting a lit window, not an eye | **CONFIRMED — and I proved the *mechanism*, which the pass only asserted** | Old `banish.png` at `82509dd`: `creatureContrast` resolves a **54 px blob at 171.2 mean, box x636-641 y196-205, body 29.7 against sides 30.3, ratio 0.982**, 650 px from the head the report stages at (570.4, −445.8). Margin **+21.2**. Put that PNG back and **both** readers of the field fail with the pass's own sentence: *"the finder resolved a 54 px blob at 171.2 luma, 650 px from a head that is not in it. That is scenery wearing the creature's name."* And it **is** a window: staged with `stagger`'s presence at 0 and nothing else changed, the region behind the creature reads **185-188 across x630-642, y196-205 — a 13 × 10 lit rectangle**, of which the creature's body covers all but two columns. |
| (2) Eye margin now +77 on a real creature | **CONFIRMED** | `creature-chasing.png` eye 227.2 (**+77.2**), `creature-stalking.png` 230.7 (+80.8). The gate's own printed line reads `eye 227.16/150`. |
| (3) The eye gate derives frames from the staged head, both branches enforced | **CONFIRMED in both readers** | `CREATURE_FRAMES` is walked; `!at.inside` asserts `measured.found === false` and `continue`s, otherwise it asserts `found`, `anchor ≤ PROBE_ANCHOR_MAX_PX`, `eye ≥ EYE_MIN`, `n ≥ EYE_MIN_AREA`, `ratio < SILHOUETTE_MAX`, `span ≤ EYE_MAX_SPAN`. Mutation: head moved **onto** the window blob, so the anchor passes at 0.0 px and the **silhouette** line catches it alone — *"the body under it is at luma 29.7 against a surround of 30.3 — a ratio of 0.98… A blob with nothing dark under it is a window."* Two independent lines, both live. The same treatment is in the pass-12 guard, and the missing `found` guard is a real fix: the pre-pass-15 loop read `measured.eye` on a frame with no eye. |
| (4) The debt is real and documented, not hidden | **CONFIRMED** | The committed `.probe/creature-probe.json` is 12 shimmer fails with lifts −0.468…+0.331 against `PROBE_SHIMMER_MIN` 0.6; the floor's own docblock in `src/game/capture.js` says why the measurement cannot answer it yet. The telegraph's eye at 165.24 against the 160 floor is **+5.24**, exactly the pass's "5.2", and it is written down. `banish`'s composition is unchanged on purpose and says so. The shimmer floor is a floor, not a target, and nothing was relaxed to pass. |
| (5) Regression guards hold; balance sim untouched | **CONFIRMED** | The gate's own margin line: `pupil 9/20`, `swirl sd 36.25/28`, `eye 227.16/150`, `lit 9.83/6.00`. The `verify-world.mjs` diff is 33 lines, all inside one creature-pose check — **the balance simulation is not touched at all**. |
| (6) The `HAZE_PEAK` revert is complete | **CONFIRMED** | `HAZE_PEAK = 0.006`; the only `0.012` left in the tree is inside the comment that explains the round trip. No active reference anywhere. |

## The probe's gates, mutation-tested in the real harness

I edited the source, ran `npm run capture -- --probe` in the real browser, and restored with `git checkout`. No reimplementation, no stub.

| Gate | Mutation | Result |
|---|---|---|
| staging / "is there a creature here" | `telegraph.presence 0.78 → 0` | `FAIL … no eye quad anywhere in the frame — there is no creature in this picture to be a hole` |
| silhouette | `stalk.presence 0.62 → 0.3` (the value the pass measured at 0.90) | `FAIL … does not read as a hole in this fog: body luma 65.0 against a local background of 79.2 (ratio 0.82) … (needs under 0.62) — retune the row's presence, not the world` |
| baseline clock | `releaseLoop()` at the top of `__captureBaseline` — the first version's bug, restored exactly | `FAIL … the baseline … was taken 0.0215 s of world time after the frame it is supposed to differ from … (ceiling 0.02 s)`, `drift 0.0215`, `held 0.0215` |
| eye margin (row) | `probeGates` on the real committed report, then the telegraph peak 165.24 → 159 | passes at 165.24; `FAIL … its loudest sample's eye is 159 luma, under the 160 floor (150 + 10)` |

The first three also run, unmodified, in the shipped code on every frame: the baseline must be lit, must resolve no creature, and must have the figure off the screen (the committed report's twelve baselines are 24.2–27.0% lit with `foundCreature: false` and `drift: 0`), and the projected shimmer boxes are checked for rectangle-ness before a pixel is read.

## The defects, and what I changed

### DEFECT 1 — the probe's row-level eye floor was dead code

`probeGates` is the only place `PROBE_EYE_MARGIN` is enforced, and the commit message claims "the eye's floor" as one of the three claims per row. It could not run:

```js
if (options.probe && report.failed === 0) { … probeGates(rows) … }
```

The world this pass ships fails its shimmer floor on **all twelve** frames — the documented debt — so that condition is false in every run a person can make, and no report ever carried a `probe` key. It was not merely unreachable: called on the real report, `probeGates` **crashes**, because `telegraph` samples 2 and 3 resolve no creature and never get an `entry.contrast`, and the row reduce reads `a.contrast.eye`. That is the same class of failure the pass itself fixed in `verify.mjs` this pass.

**Fixed, in four parts, and none of them is a relaxation:**

1. **The condition** is now "the run covered every probe view", not "nothing failed". The shimmer failures keep their own exit code; nothing here can turn a red run green.
2. **`probeGates` gates over the samples that were measured** and counts the rest as `unmeasured`. A missing sample is not a failure of the row — two of three telegraph samples finding no eye *is* §6.1's beat doing its job — and a row with no measured sample at all is the one thing that throws.
3. **The row is recorded from the id**, in the capture loop, not inside `measureProbe`. I found this by running it: a frame that fails the luma floor never reaches `measureProbe`, so it reached the table with no `row` and silently removed a sample from the count. Two of twelve did exactly that on my run. The row a frame belongs to is a property of its name.
4. **A `--only` run says it is not a whole probe** instead of throwing a row-count sentence at someone iterating on one composition.

Proven end-to-end, twice, and the second time is the interesting one. On the **committed report** the table now builds: `telegraph` eye 165.24/160 peak `[1 of 3 samples measured]`, `stalk` 233.76, `chase` 234.90, `stagger` 242.35, `enraged` 204.50 — none failing — and with one peak moved to 159 it fails with the sentence above. On a **fresh full run** all three `telegraph` samples resolved no creature, so the row had nothing measured, and the harness said so by name: *"the telegraph row has no sample that got as far as a contrast measurement, so its eye floor has nothing to be measured against."* All twelve frames carried their `row` (12 of 12). That is the property I wanted: the table now produces a verdict or a named reason, and it can never again be silently absent.

### DEFECT 2 — `tools/png-luma.mjs` still documents the false positive as the creature's eye

Three constants this pass moved or reasoned about carried measurements that **this pass invalidated**, and none of them was updated:

- `EYE_MIN`: "the three real eyes in the gallery sit at 234 (stalk), 228 (chase) and 171 (banish) mean, so the floor has **21 luma of margin** on the worst of them". The 171 was a window. Re-measured: **230.7 (52 px)** and **227.2 (55 px)**, so **+80.8** and **+77.2**.
- `EYE_MAX_SPAN`: a whole paragraph — "THE BANISH FRAME IS THE ONE TO WATCH… the blob is 12 px tall against this 14 px ceiling — **two pixels**" — warning a future change to the eye's size that there was almost no room. There is no eye in that frame. The widest real eye in the gallery is 8 px, six to spare.
- `EYE_MIN_AREA`: "the largest square, solid impostor in the gallery (**9 px**, a lit window in `hammer-located`)" and the two real eyes as "49 and 70 px". `hammer-located.png` now resolves **72 px at a mean of 192 in a 12 × 6 box** — passing the area floor by 48, filling 100%, at an aspect of exactly 2.0 against a ceiling of 2.

A reader planning a change to the eye's size would have been warned off by a paragraph about a window. Re-measured and rewritten, with the window's own geometry as the proof that the shape tests — not the threshold — hold the line.

### DEFECT 3 — a comment claimed a constant was a measurement, and the constant leaves two frames uncovered

`stagedHead`'s docblock said: "The list of frames that owe an eye is **DERIVED from the report rather than written down**." It is `const CREATURE_FRAMES = ['creature-stalking', 'creature-chasing', 'banish']`. Only the *head* test is derived. In a repository whose entire gate culture is "a claim with no evidence is a comment", that sentence is the exact failure the culture exists to prevent — and it is load-bearing, because a list of three in a gallery of fourteen can leave something out. It does:

- **`hammer-located.png`** stages a `telegraph` with its head inside the picture at (981.3, 357.8), and the finder resolves **72 px at 192.0 mean, 57 px from that head, with a body ratio of 7.1**. It is the lit 12 × 6 window that `PROBE_ANCHOR_MAX_PX`'s own comment in `src/game/capture.js` cites as **the reason that tolerance exists** — the motivating example, in the one frame nobody pointed the mechanism at.
- **`finale-headlights.png`** stages an `enraged` with its head 1653 px outside the frame and resolves **64 px at 164.3, a ratio of 1.10, 1829 px away**. The finale's own glare.

Both want a re-frame and a re-shoot, which is a capture pass's work and not a review's — I am not going to re-frame Act I or rewrite fourteen committed PNGs inside a review. What a review *can* do is stop them being invisible, so I added the coverage assertion: it reads every frame the report says stages a creature, and asserts the set of those that resolve an eye further than `PROBE_ANCHOR_MAX_PX` from their own staged head is **exactly** `['finale-headlights', 'hammer-located']`. A third frame joining it fails; a re-frame that fixes one fails until the line is deleted and the frame added to `CREATURE_FRAMES`. That is the same shape as the pinned `EYE_MIN` two assertions above, and it costs 335 ms. The false claim in the docblock is corrected to say what is true.

### DEFECT 4 — the sliver's evidence was the bounding box, not the measurement

The pass argues the excused frame will not flake because "brightness is not what rejects scenery", quoting "a 2 x 9 sliver at 153-155 — three luma over `EYE_MIN`, and rejected at **18 px** against a 24 px area floor". The area floor is tested against the lit count, and the lit count is **12**; 18 is the bounding box, and 67% is the fill that goes with it. The mean is **152.3**, not 153. The conclusion is unchanged and better supported with the right numbers (12 px against 24, 67% against 70%, aspect 4.5 against 2 — and the aspect is the scale-free one, so brightening it cannot help), so I corrected the numbers and added the measurement that settles the *identity*: the window, with the creature removed, is a 13 × 10 block at 185-188.

### DEFECT 5 — three comments quote a ratio the pass's own re-shoot moved

`0.607` for "the measured value on the shipped `creature-stalking.png`" appears in `tools/png-luma.mjs` (written by this pass, on `SILHOUETTE_MAX` itself), in `src/game/capture.js`'s stand-off docblock (also written by this pass), and in `verify.mjs` (older). The committed PNG measures **0.572** (body 45.0 against a surround of 78.7); 0.607 was the pre-pass-15 gallery. `verify.mjs:11949` also turned that into "**0.013 of headroom, the tightest margin in the repository**" — the real headroom is 0.048. All three corrected, because a number that names a PNG has to name the PNG that is committed.

### DEFECT 6 — the eye-ceiling gate got looser in the same retune, with nothing holding the gap

The telegraph's `eye` column moved 0.5 → 0.6, so `brightest < 0.55` became `brightest < quietestEyeRow` — and the next dimmest row's column is 0.8. The *claim* is right ("the apparition's eye is the faintest thing in the table") and stating it relatively is better than keeping a literal that no longer describes the design. But 0.55 → 0.8 is a real loosening, and pass 15 moved this row's entire read off its body and onto its eye, so this is now the gate that holds it. A table with two rows 0.01 apart satisfies "fainter than" and reads as one row.

I added the margin the relative form lost: `quietestEyeRow - brightest >= 0.1`, against a gap of 0.2 — twice the 0.05 the pairwise test uses for "apart in the frame", because this is two rows rather than two samples of one row.

### DEFECT 7 — a stale constant inside a gate

`the shimmer boxes are the shimmer` measures the reference's distance from the axis with `pxPerMetre = 30.1113`. The probe report's own `where.pxPerMetre` is **29.3075** at this stand-off. The two bounds (20 and 200) are wide enough that the conclusion is the same either way, which is precisely why a stale measurement in a gate is worth correcting rather than tolerating. Corrected, with the comment's "39-54 px" becoming "38-53 px".

## Three misdiagnoses I corrected rather than inherited

The pass's **conclusions** are right in all three cases. The **evidence** it gave for them is not, and left alone it would have pointed the next pass at the wrong thing.

1. **`HAZE_PEAK`'s revert rationale.** The docblock says that at 0.012 "the eye finder could no longer resolve the eye in the SHIPPED `banish.png` — the figure is **four metres** away and the doubled additive haze **softens the eye quad's edge**", and that `verify.mjs` fails on that frame and is right to. I re-shot that view at `HAZE_PEAK` 0, 0.006 and 0.012: **none of the three resolves an eye**, and §16.5.9 stages the banish at **1.9 m**, not four. There is no eye quad in that frame to soften. What the doubling moved is the *scenery* — the 2-px remainder of the window reads 152-155 at 0 and 0.006 and **138-141** at 0.012, which is under `EYE_MIN` — so the finder's answer on that frame is decided by how much of a house window the creature's body happens to be covering. `verify.mjs` fails that frame because its head is out of the picture, and it fails it for that reason at all three alphas.

   **The decision stands and the real argument for it is better than the one the pass gave:** a third of a luma against 0.7 of noise, on a frame where the effect's own alpha helps decide whether a window reads as a creature's eye. That is a number with a real price attached. Only the price was misattributed, and I rewrote the note to say what I measured.
2. **`capture/main.jsx`'s held-loop comment** explained the same event from the other side — "its eye is 21 luma above the finder's floor of 150… The committed `banish.png` measured 171 and the next run of the same steps found nothing at all" — i.e. the same window, called an eye, flickering on the stagger's beat. The hold is right and the reason is *stronger* than the one given: what it fixed was not an eye flickering but a gallery frame whose answer to "is there a creature in this picture" depended on when the shutter was pressed.
3. **`the five states do not read as one state`** dropped `telegraph` from the presence ladder (`telegraph < stalk` → `stalk < chase <= enraged`) and gave the reason. The reason is measured and correct, and the pairwise test that actually holds the five apart still passes with a wider spread — I checked the gap rather than assuming. Not a defect; recorded so the next pass knows the ladder has four rungs on purpose.

## NOT DONE — measured, documented, and not mine to close

**The probe is not reproducible run-to-run, and the pass's own uncertainty is about three times too optimistic.** This is the finding I would most want the next pass to have. I ran the whole probe again, unchanged:

| View | committed report | my re-runs | repeats of one view |
|---|---|---|---|
| `telegraph-1` | 14.70% lit, resolves an eye at 165.2 | 15.58% lit, resolves an eye at 165.3 — **and 22.46%, resolves none** | — |
| `telegraph-2` | 20.77% lit | **0.11% lit** (fails the floor) and 19.30% | 19.30%, 18.39% |
| `stalk-2` | 25.79% lit | **2.24% lit** (fails the floor) and 25.04% (reaches the shimmer gate) | — |
| `chase-2` shimmer | **−0.186** (fails) | **+0.87** (passes) and +0.26 (fails) | — |
| `enraged-1` shimmer | +0.331 (fails) | **+1.09** and **+1.05** (both pass) | — |

So "twelve frames, twelve shimmer fails" is a true statement about one run and not a property of the world: a repeat already produces two passes and a near-black frame, and the apparition's eye resolved in **1 of 3** samples in the committed run and **0 of 3** in another. The mechanism is visible in the source — `world.js` computes `lampDread(distance, this.animTime, …)` and `flickerAt` ticks at 11 Hz on `animTime`, which is the sum of clamped frame deltas **since page load**, so a page load of a different length lands the world on a different lamp-drodd phase, and a drodded pool is a nearly black road. `run`'s held loop fixed the frame→baseline gap; the run→run gap is untouched, and the pass's own justification quotes §6.5's "a set of steps is worth the same picture twice" as a property it restored for the gallery. It did not restore it.

The fix is to anchor the clock at the top of `run` (`game.animTime = 0` with `clock.oldTime` reset) so every view is stepped from the same origin. That changes the shipped gallery and needs all fourteen re-shot, which is why it is not a review fix: it is capture-pass work, and it belongs with the shimmer debt, whose 0.6 luma floor is currently being compared against a ±1 luma scatter.

**Two smaller ones, both real:**

- The commit message says "**Twelve** new pure checks" and "296/296 pure (**was 294**)". It was 285, and eleven `test()` blocks were added. The count I report is the one the gate prints.
- The new `readings.length >= 2` guard cannot fire today, and cannot: a frame the head test excludes must resolve nothing, and only `banish` qualifies, so the list can never fall below two. It is a correct floor and an unreachable one, which is worth knowing before someone relies on it.

## What I did not touch

`src/game/creature.js`'s retuned numbers, `creatureView.js`'s `hazeLayers` stash, the `bodyFloor` split, the `holdLoop`/`releaseLoop` change, the gallery, and the balance simulation. The `bodyFloor` design decision — the apparition's body holds a constant 0.82 floor while its eye runs the full beat — is a judgement about §6.1 and I am not the reviewer of it; what I checked is that it is measured (0.429 at the trough against a 0.62 ceiling, whole beat inside the gate), documented with its arithmetic, and held by `verify-world.mjs`'s new beat check and by the pure pairwise separation.

## Files changed by this review

- `tools/capture.mjs` — the row table is reachable, gated over the measured samples, and a frame's row comes from its id. No threshold changed.
- `tools/png-luma.mjs` — three docblocks re-measured against the committed gallery; no constant changed.
- `verify.mjs` — a coverage assertion over the frames the list leaves out, a separation floor on the eye-ceiling gate, one stale constant, and four comments corrected to what I measured.
- `src/game/creature.js` — `HAZE_PEAK`'s note rewritten around the evidence I measured. The value is untouched at 0.006.
- `capture/main.jsx` — the held-loop comment corrected about what it actually fixed. No behaviour changed.
- `src/game/capture.js` — one stale ratio in a comment.
