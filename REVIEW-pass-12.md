# REVIEW — iteration 2, pass 12

- **Commit under review:** `aa61850` — "iter2(12): portal II - swirl rotation, debris ring, shutdown collapse, lensing hint".
- **Reviewer verdict:** **APPROVED — no source change, no gate change, nothing committed for this pass beyond this document.** All three defects the implementer caught in their own pass are *still caught* when I re-derive them from the current tree, which is the only question a re-review can settle about them. The pass's central claim — that the swirl is a deterministic, re-takeable animation rather than a frame count — I confirmed by independent measurement rather than by reading the gate that asserts it. One of my own previous session's claims is wrong and is corrected below; two gaps are real and are recorded rather than fixed, because fixing either means changing a source line the gate currently pins, and that is a pass, not a review.
- **Gate at verdict time:** 261/261 pure, 99/99 world, `vite build` clean. Unchanged by this review.

## What the pass does

Pass 12 rebuilds the pass-3 portal downward, from a "cyan ring" to a hole with a descent. The swirl is now an **integral** (`rotation.z += rate * dt`) against a near-field-scaled rate rather than a product against the view clock; the gate owns a 14-rock **debris ring** on the orbit `radius * FLATTEN`; a shut portal runs a 0.8 s **collapse** over the dead disc; and a **lens** quad darkens the background in an annulus outside the lip. `resetMotion` — the loop-wipe hook `world.js:2610` calls — was extended to put all three new integrals back to their built values.

The architectural claim holds: every tuned number (rates, ring radii, `FLATTEN`, collapse envelope, lens profile) is decided in the pure `rules.js`, the view applies it, the world wires it. `verify.mjs` grew 1067 lines and `verify-world.mjs` 652, which is the right ratio for a pass that adds four features and finds three defects in itself.

## The three self-caught fixes: all three re-verified as caught

The harness is at `/tmp/mut/mutate.mjs`. Every mutation is applied to a **throwaway copy** of the tree — the live repo is only ever read, and the run prints `live tree unchanged by this run` as a fact it checks, not a promise. The sandbox is asserted byte-faithful against the repo before any mutation runs, because a missing input is a *silently* meaningless kill rate rather than an error: an earlier attempt copied `src/` and `tools/` only, scored 250/261, and would have reported eleven gallery failures as "killed by the mutation" for every single mutation. Each anchor must occur **exactly once** — zero is a no-op that survives for free, more than one edits the wrong line.

| # | Self-caught defect | Reverted as | Caught by | Result |
|---|---|---|---|---|
| A1 | `resetMotion` does not zero the swirl | delete `layer.rotation.z = 0` | `pass-12: the near field reaches the built swirl…` | **CAUGHT** |
| A2 | integral → pass-3's product `t * rate` (the discontinuity) | `+= rate * dt` → `= t * rate` | 3 pure claims incl. *`every descent claim can actually fail, and a mutation names the one it breaks`* | **CAUGHT** |

### One survivor, and it is the right one

`PORTAL_DEBRIS_FLATTEN` removed from `portalDebrisPose` entirely **survives**, and it must: at `FLATTEN = 1` the squash is the identity, so removing the multiply is not a defect, it is the same function. This is an equivalent mutant by construction and I record it as such rather than as a hole. It is also the reason the constant is a named export that still travels on the orbit instead of being deleted at 1.0 — `rules.js:427-431` says exactly this, and the surviving mutant is the proof that the seam is load-bearing for the *next* retune. A gate cannot kill this one, and no gate should try: the only mutant that would catch it is one asserting a particular line of source exists, which is a fingerprint, not a measurement. B2 (`FLATTEN = 0.72`, nearest approach exactly equal to the hole radius) **is** caught, which is the boundary case that matters — the claim is a strict inequality and the gate holds it strictly.

## Independent measurement: the swirl really is an animation

I did not take the gate's word for the pass's central claim. I built a probe against a private copy of the harness (`/tmp/probe`, so the shipped 99/99 count is untouched). Worth recording how: I first injected the probe at the top of the file and it broke two unrelated checks by mutating the shared `game` before they ran; moving it to just before the summary print restored 99/99. That is the same shared-fixture trap pass 11's review found four times in `_walkCreature`, met a fifth time by me.

| Probe | Result |
|---|---|
| P1 advances at the table's rate, opposite directions | **L0 +0.210000 rad/s, L1 −0.130000 rad/s** — matches `PORTAL_SWIRL_RATES` read out of the source to 1e-6 |
| P2 same elapsed, three step sizes (60/30/20 Hz) | 5 s: max delta **2.89e-15 rad** (one float ulp) |
| P2b monotone | 240 consecutive steps, **0 reversals** |
| P3 loop wipe from 37 s of travel | was `[7.8785, −4.8772]` rad → **exactly `[0, 0]`** |
| P4 re-take reproduces the first take | 12 s twice: **identical to the bit** at 2.628500000000 rad |

## Debris visibility: measured, and one of my own previous claims was wrong

My previous session's note said `portal-shutdown.png` "shows debris silhouetted against the cyan rim (visible!)". **That is wrong, and the source says so directly**: `streetView.js:7367` sets `portal.debris.visible = !shut`, with a comment explaining that a ring of lit flakes orbiting a dead hole is neither cold nor inert per §5.3. The ring is *deliberately absent* from the shutdown frame. I re-measured and the pixels agree with the source rather than with my note:

- `portal-shutdown`: the 2D annulus at the ring radii (378–465 px) yields **0 rock-sized angular clusters**. There is no ring. There was never going to be.
- `portal-located`: **6 rock-sized clusters** (13–27°) of the 14 `rules.js` draws, plus one 295° run that is the shed doorway crop the docblock predicts. Deepest excursion **6.6 luma against a 43.9 surround — a ratio of 0.15**, i.e. the rocks are near-black specks on a mid-grey/cyan band. That is genuinely visible.

My first pass at this measurement counted 6 dark runs and called it inconclusive; the confound was the doorway crop, which is one long dark arc, and the fix was to threshold against the *local radial median* rather than a global one so the crop cannot set the bar. A raw run count is not a rock count, and the difference between those two numbers is the whole measurement.

The cluster count is 6 and not 14 for a reason I can state rather than guess: the ring is cropped by the 1.1 m doorway on two edges (the same two edges the disc is cropped by, which is the consistency `PORTAL_DEBRIS_FLATTEN`'s docblock argues for), and at the §16.5.6 stand-off a rock is 5.0–11.1 px across, so neighbouring rocks merge into single clusters at this resolution. The gate's claim is *"in the built frame and outside the hole"*, and it projects every rock through the **real camera** from the built `instanceMatrix` — not from `rules`, so a wrong pose cannot pass by being right in the pure module. That is the correct claim for a 5-px feature and it is the claim pass 10 got wrong by asserting nothing.

### The pupil holds

`swirlContrast` on the committed PNGs: **pupil 8 in both `portal-located` and `portal-shutdown`**, against the ≤20 floor. The radial profile explains why the ring is legible: luma runs 8.7 at the centre, 17.2 at the gate radius, and **48.5 at the rock orbit** (1.06 core radii) — the orbit sits in the bright band just outside the lip, which is exactly the "8% outside the 0.72 m disc" the constant's docblock claims. The measurement and the comment agree.

## Remaining gaps, recorded honestly

1. **My previous session's shutdown claim was wrong** (above). Corrected here. The fix is to the note, not the code.
2. **`portal-shutdown` shows the ring dying on no frame at all.** The ring goes out on the same frame the portal shuts, so there is no capture of the ring collapsing — the 0.8 s collapse aperture is drawn with `collapseCore`/`collapseFlash` and no debris. PASS 3's brief ("Captures portal-located/shutdown must photograph the disc, not a ring") is satisfied either way, but a reviewer looking for the ring's death will not find it. Adding a capture is a §16.5 change with a re-derived luma floor behind it; that is a pass.
3. **6 of 14 rocks are individually separable in the shipped frame** (above). The gate proves all 14 are in-frame and outside the hole, which is the right claim, but a viewer counting rocks will count ~6. Worth knowing before someone reads the count as a spec.
4. **The lens has no shipped frame that is *about* the lens.** The world check projects and measures the built alpha ramp, and C1/C2/C3 are all caught by reading the built **bytes** rather than the formula — the strongest single piece of evidence in this pass, because reading the formula is the only way to confuse those three mutants, all of which differ only in a denominator. The visual payoff is incidental in the gallery.
5. **Two pre-existing lint warnings** (`world.js:1232` unused `dt`, `verify-world.mjs` three unused functions) are outside this pass and were not introduced by it.

## What I did not do

I changed no source, no gate and no capture. The three self-caught fixes are correct as shipped, the surviving mutant is provably equivalent, and every gap above is either a correction to my own note or work whose honest scope is a new pass. Committing only this document.


P3 and P4 are the claims this pass actually made — a wipe that leaves a swirl mid-travel is not a re-take, and `resetMotion` is the method that promises one. Both hold to the bit.

P2 is honest but weaker than it looks, and I will not oversell it: a product form is *exact* at any step size, so a step-size test cannot by itself tell an integral from a product. What pins the form is A2's mutant, and what the probe adds is P2b — that no individual step ever moves against the table's sign, which the gate does not check at that granularity. I am recording the limit of the probe because a review that overstates its own instruments is the failure mode pass 10 and pass 11 both recorded.

| A3 | drop the `* dt` (a frame count) | `+= rate * dt` → `+= rate` | same 3 pure claims | **CAUGHT** |
| B1 | `FLATTEN` back to 0.62 (ellipse reaches into the pupil) | `= 1` → `= 0.62` | `pass-12: the debris ring is in the built frame, and every rock is outside the hole` | **CAUGHT** |
| C1 | lens divides by `half` alone (annulus sampled at no texel on the axes) | `outer / half` → `1 / half` | `pass-12: the lens darkens the background near the rim and nothing else` | **CAUGHT** |
| C2 | lens factor inverted (lip at canvas edge, crest off canvas) | `outer / half` → `half / outer` | same | **CAUGHT** |
| C3 | lens divides by nothing (same failure, different route) | `outer / half` → `1` | same | **CAUGHT** |

**8/8 required mutations caught.** A2 and A3 are the interesting pair: they are caught by *three* pure claims, one of which is the meta-claim that every descent claim can actually fail. The two mutants are near-equivalent at runtime — both leave a plausible-looking animation — and a gate that had only asserted "the swirl turns" would have passed both. It does not, and the reason is that pass 12 rewrote the claim from "does it turn" to "does it turn *in a form that cannot be a frame count*".
