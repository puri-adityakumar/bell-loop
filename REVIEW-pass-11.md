# REVIEW — iteration 2, pass 11

- **Commit under review:** `a5ab4fe` — "iter2(11): creature fidelity II - heat haze, lamp flicker, glow pulse, dust puffs".
- **Reviewer verdict:** **FIXED — this is the best-gated pass in the run, and it still shipped a published measurement that inverted on read.** All four of the new features are in the shipped gallery and every one of them is provably in front of a camera, which is the exact thing pass 10 got wrong. One real defect: `game.lampDread.distance` published `Infinity` on every frame of §9.3 and §10.4, which the pure module reads as "standing directly under the lamp". Fixed and gated in five claims. Two documentation defects corrected and turned into a gate. One structural property measured, found to be pre-existing, amplified by this pass, and **not** in scope to fix here — recorded with the numbers and the fix.
- **Gate at verdict time:** 251/251 pure, 93/93 world -> **252/252 pure, 94/94 world** (post-review; +1 pure test, +1 world check, +1 pure source-contract mutation, `EYE_MIN`/`EYE_MAX_SPAN`/`EYE_MIN_AREA` now exported and pinned).

## What the pass does

`a5ab4fe` gave the creature four things that are *around* it rather than on it, on the argument that a 2.80 m figure in sodium fog is a smudge and the only substitutes for a better smudge are the things the figure does to the air, the light and the ground: a `hazeAmount`/`hazeLayers` shimmer column within 30 m, a `lampDread` strobe on the nearest sodium lamp within 12 m, a `lampPulse` on that lamp driven by the eye flare's own envelope, and `puffStep` footfall dust on `dripStep`'s reducer discipline.

The architectural claim holds and is the strongest part of the pass: every number is decided in the pure `creature.js`, the view only applies it, and the world only wires it. The comment density is at the pass-9/pass-10 standard and several of the notes are genuinely load-bearing explanations of a *failed earlier version* rather than restatements of the code.

## What is actually visible in the shipped gallery

I measured the committed PNGs rather than reading the design prose, because that is the claim prose cannot make. Every one of the four features is present, and — unlike pass 10 — the pass ships a gate that says so.

| Feature | Where it is | Evidence |
|---|---|---|
| Shimmer column | `creature-stalking`, `creature-chasing`, `banish` | one `creatureHaze` mesh, `AdditiveBlending`, RGBA vertex alpha, `HAZE_LAYERS` 6, worst pixel **+7.6 luma** on a 19-level surround |
| Lamp strobe | `creature-chasing` (6.5 m), `banish` (4.0 m) | `lampDread` at the floor 0.30 for **32%** of its ticks; `street.png` is clean because nothing is under a lamp |
| Glow pulse | none of the fourteen | see Finding 4 — `eyeFlare` is 0 in every shipped framing, same structural gap pass 10 recorded |
| Footfall dust | `creature-chasing` | `puffStep` at 0.45 m/stride lays 5 puffs in the 1.2 s staging, and the world check **projects them** and finds them inside the frame |

Pass 10's review found the trail in no frame and no gate able to see that. Pass 11's equivalent check is `pass-11: a footfall puff is in the frame, and the cap holds in the built world`, and it projects, and it mutates. That is the single strongest piece of evidence I have that this pass learned from the last one.

The luma gate is comfortable everywhere: the tightest frame is `win` at 1.63x its floor, and the tightest creature frame is `creature-stalking` at 4.16x.

## Finding 1 (the real one): a published measurement that read as its own opposite

`this.lampDread` publishes four numbers. Three of them were right. The fourth was not.

`_writeLampDread` is called with `drawn === null` from exactly two places — `PHASE.RESET` (§9.3's black) and `PHASE.WON` (§10.4's card) — and on those frames it computed `distance = Infinity` for every lamp, so `closest` stayed `Infinity` with it, and the field published `distance: Infinity` for the whole of both phases. (It serialises as `null` in `captures.json`, which is how it hides.)

The field's own docblock, written by this pass, says the opposite and says why it matters:

> `distance` is finite on EVERY frame, and when nothing is drodded it is the distance to the nearest lamp that was considered. It has to be: `lampDread` reads a non-finite distance as zero — "standing directly under the lamp" — so a world check that fed the published distance into `lampDread` to verify the wiring got a full-strength strobe for a lamp with nothing near it, and correctly reported a fault that was in the record rather than in the light.

That is a precise description of the bug, and the author had already fixed it on the path where *nothing was drodded while a creature was present*. The `drawn === null` path is the other door into the same room. Measured on the shipped tree:

```
playing  : {"lamp":0,"level":0.802,"pulse":1,"distance":9.895}   finite? true
reset+0.017s: {"lamp":-1,"level":1,"pulse":1,"distance":null}     finite? false
... 240 frames ...
published distance fed back into lampDread() -> 0.6512   (1.0000 = "no dread at all")
```

So a lamp with a **dormant creature 13 m away**, on a frame with **no figure in the picture at all**, published a distance that the pure module resolves to a 35% drodd. `capture-reset` is a shipped gallery frame and it spends 1.4 s of its staging in exactly that phase.

**Why nothing caught it.** The check that exists to catch exactly this — `pass-11: the lamp under the creature strobes on the built light` — feeds the published distance straight back into `lampDread` on 240 consecutive frames, which is the right thing to do. It samples only frames where a creature is present, because that is the state it is about. The bug lives exclusively in the two states it never visits.

**Fixed** in `src/game/world.js`. The position the *record* is measured from is now the creature's canonical position folded through the same `worldOf` every other drawn position in that file comes from; the position the *light* is driven from is still `drawn`. Nothing about the rendered frame changes — `level` and `near` remain gated on `drawn` — so the gallery is untouched and no `captures.json` value moves.

**Gated** in `verify-world.mjs` as `pass-11 review: the lamp record is a measurement on every frame, including the two quiet phases`, over both quiet phases, in five claims ordered by how much they can distinguish a measurement from a sentinel:

1. **finite** on all 240 sampled frames of each phase, not only the frame the phase was entered on;
2. **responsive** — walk the creature somewhere the world's own aimed list says is clear of the radius and the published distance has to *change* by more than 10 m. The search is for a spot rather than a direction, because the first version of this check asserted "moving `+z` makes it larger" and that is false on a repeating grid: 40 m north of one lamp is 24 m from the next. The pre-fix world cannot fail this one at all, because there is no arithmetic on `Infinity`;
3. **correct** — the published number equals the distance to the nearest aimed lamp, computed in the check from `world._lampAimed` and `worldOf` rather than taken out of `_writeLampDread`, so the check cannot agree with the bug by construction;
4. **reads back as nothing-near-it** — `lampDread(published, ...) === 1`, the half the bug was actually in;
5. **and a lamp cannot be pulsed at an absence** — white-box `_writeLampDread(null, <a flaring pose>)` with the creature back under the lamp, which must leave every visible key at 400 and every visible bounce at 46.

Claim 5 exists because of a mutation that survived the first version of the gate. `const near = distance < beast.LAMP_DREAD_RADIUS` — dropping the `drawn !== null` I had added — passed **94/94**. It is an equivalent mutant at today's call sites, because every caller that passes no figure also passes no pose, so `pulse` is 1 and the term is inert. It is kept anyway: it is the only thing between a future caller that passes a pose and a lamp across the street surging on the creature's behalf. Getting the gate to notice took putting the creature *back under the lamp* first — at the far spot, `near` is false on geometry alone and the guard is invisible.

**Mutation-tested**, three mutants, all caught:

| Mutant | Caught by |
|---|---|
| `measured = { x: Infinity, z: Infinity }` (the original bug) | claim 1: `the record published Infinity m` |
| `measured = worldOf(this.player.pos)` (finite, wrong thing) | claim 2: `moved the published distance only 224.66 -> 224.66` |
| drop `drawn !== null &&` from `near` | claim 5: `a lamp with no figure under it surged to 580` |

## Finding 2: the lamp record's contract was a fingerprint of the source, and editing the source turned it red

`_writeLampDread` is the only method in `world.js` that writes `light.intensity` outside the aiming pass, and the `near` term it added is the only path by which `pose.eyeFlare` reaches a light. Pass 11 stated that as a source contract in `verify.mjs` and mutated it — and the mutation's `from` string was the literal source text of `const near`, so editing that line without editing the gate turns the claim red. That is the gate working as intended and I am recording it because it is a sharp edge in this pass: the claim text is a fingerprint of the source, not a restatement of it, and a future edit that only changes formatting will produce a confusing failure. Two mutations now cover the two halves of the term (the radius, and the figure), where there was one before.

## Finding 3: `png-luma.mjs` justified `EYE_MIN` with a measurement pass 11 invalidated, and the real mechanism was never stated

The `EYE_MIN` 150 docblock claimed:

> the stalk eye in `creature-stalking` sits at 227 mean and the chase eye at 223, while the brightest thing anywhere in `street.png` — a lamp head — peaks at 167.

Every one of those numbers moved, and one of them moved by 82 luma:

| | quoted | measured on the committed PNGs |
|---|---|---|
| stalk eye, mean | 227 | **233.7** |
| chase eye, mean | 223 | **227.7** |
| `street.png` peak | 167 | **249** |
| stalk blob | 9x8 | 8x6 |
| chase blob | 7x7 | 7x6 |

`banish` — which the comment did not mention at all — resolves an eye at 170.7 mean in a **7x12** blob, i.e. two pixels under the `EYE_MAX_SPAN` 14 ceiling. That is the tightest margin in the eye pipeline and the tightest-ignored number in the repository.

**The threshold was never wrong, and the argument underneath it was.** 150 did not reject the lamp heads; the *size* tests did, and they still do — `street.png` at a 249 peak resolves zero eyes. The comment claimed a brightness separation that had stopped existing the moment this pass gave the sodium family a strobe, and a reader auditing `EYE_MIN` against it would have been auditing a fiction.

**Corrected** in place, with the real numbers, the real mechanism, and an explicit note that the spans are written in the form the code compares (`maxX - minX`, so the old comment was off by one against the number it was justifying).

**Gated** by a new pure test, `the eye-finder's own numbers hold on the shipped gallery, and brightness is not what does the work`, which measures the committed PNGs and asserts the comment's three claims. The load-bearing one is the control:

> `street.png` peaks at **249** — well over `EYE_MIN` 150 — and still resolves no eye, so the shape tests are not doing the work.

and its mirror, which fails if the frame ever stops being able to make that argument (`peak > EYE_MIN`).

`EYE_MIN`, `EYE_MAX_SPAN`, `EYE_MIN_AREA` and the other three shape constants are now exported so the test reads them rather than restating them — and then **pinned**, because the first version of this test imported all three, every relation scaled with them, and two real mutations left 252/252 green:

| Mutant | Result before pinning | Result after |
|---|---|---|
| `EYE_MAX_SPAN` 14 -> 60 | 252/252 **green** | caught |
| `EYE_MIN_AREA` 24 -> 1 | 252/252 **green** | caught |
| `EYE_MIN` 150 -> 100 | — | caught |
| `EYE_MIN` 150 -> 190 | — | caught |

A relation against a constant proves the two agree, not that either is right. These three are the contract rather than a derived value, so their values are the claim and a retune has to say so in the same commit. This is the one place in this review where I deliberately restated a literal, and the reason the first version of the test was decorative is the reason.

## Finding 4: the committed pixels are a function of the machine's frame rate, and this pass made that visible

`animTime` at the shutter is not a function of the staged capture. Every view ends with `frames(2)`, which awaits two real `requestAnimationFrame` callbacks, and the page's own loop calls `game.update(clock.getDelta())` on each one. `benchmark/captures.json` records `simFrozen: false` on all thirteen non-pause views, which is that loop, observed. So the shutter lands at `animTime + sum(real dt)`, and `sum(real dt)` is however long this machine took to render two frames.

That is pre-existing, and the harness already reasons about it — `wait()` exists *because* "a frame-counted wait photographs a different moment on every machine". What pass 11 changed is the size of the consequence. Before this pass the sodium ran on smooth sines, so 33 ms of clock drift moved a lamp's level by about 0.02. `lampDread` is a **step function**:

```
distinct levels in 4 s at 0.5 m: 0.300, 0.552, 0.601, ... 0.946
block widths ms: 90, 91, 181, 273            (1/11 s = 90.9 ms)
P(one 60 Hz frame of animTime drift changes the level) = 17.1%
worst level swing over the two rAF frames every capture ends on: 0.644
a lamp under the creature sits at its floor for 32% of its time
```

So roughly a **one-in-six chance per capture** that the committed `creature-chasing.png` or `banish.png` shows a sodium pool up to 0.644 of base brighter or darker than the run that produced the previous one. The flicker itself is deterministic — `flickerAt` is a hash of the tick index, and pass 11 got that right — but *which* tick the shutter lands on is not.

**This does not threaten any gate.** The luma margins are 13.9x (`creature-chasing`) and 12.1x (`banish`) against a 6% floor, and `capture-reset`, `win` and `pause` are in phases where the lamps are pinned flat. The *pixels* are not reproducible; the *pass/fail* is.

**Not fixed here, deliberately.** The fix belongs in the capture harness, not the game: neuter `game.clock.getDelta` for the duration of a capture so `animTime` is a pure function of `wait()`'s `SIM_DT` stepping. That is a capture-only change with no blast radius on the simulation, and it is the right fix — but it moves `animTime` for **every** frame, so all fourteen PNGs, every luma reading, the creature-contrast ratios and the swirl measurement would all have to be re-derived, and the margins in this repository are already thin in places (`creature-stalking`'s 0.607 against a 0.62 floor is 0.013). Doing that as a side effect of a fidelity review, with no time to re-tune the gates it moved, is how a gate gets quietly weakened. It is a pass of its own. Recorded here with the mechanism, the numbers, and the one-line change.

## Not changed, and why

- **The haze and the puffs against the eye finder.** The obvious risk in this pass is that a new additive element sits next to the eye and either joins the flood fill past `EYE_MAX_SPAN` or manufactures a false eye. It is already gated, on the built materials in the renderer's own colour space: the shimmer is well under 60 luma alone against `EYE_MIN` 150 and adds 7.6 luma worst case; a puff composites under 150, is about 30 px across at the chase distance (so the shape test rejects it before the floor is consulted), and is cooler than the sodium it stands in. I looked for a hole here and did not find one.
- **`hammer-located.png` still reports an eye.** 72 px at 919,359, a lit window. Recorded in pass 10 as a false claim in `png-luma.mjs`; unchanged by this pass, nothing depends on it, and correcting the prose there would still weaken an argument about impostor rejection that is otherwise correct. My new test does not depend on that frame.
- **Restaging `banish`.** Its eye blob is 7x12 against a 14 px ceiling. That is tight, and it is the creature's own proximity at 1.9 m rather than a loose finder, and moving the framing would move the one ratio in the repository with 0.013 of headroom. Measured, reported, gated against going further, and left.
- **The `lampDread` constructor default.** `distance: Infinity` before the first `update()` is left alone, and is now the one place that value is honest: before the first frame no lamp has been considered at all. The new gate samples after `update()` in each phase, and the field's docblock says so.

## What I would want the next pass to do

1. The capture-clock fix above, as its own pass, with the whole gallery re-derived and the two thin margins re-measured before anything is re-tuned.
2. `worldOf` should carry a yaw, so `inSightCone` tests the cone along the creature's actual facing. This is pass 10's Finding 2, still unfixed, and it is the reason the glow pulse is in no frame — pass 11 built a second effect on the same unreachable clock rather than reaching the first one.
