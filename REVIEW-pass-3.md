# REVIEW — iteration 2, pass 3

- **Commit under review:** `fc1ab19` + the working tree — "iter2(3) review: swirl contrast + gallery refresh"
- **Reviewer verdict:** **APPROVED.** The pass-3 rebuild was geometrically correct and visually wrong: the hole was built and the thing inside it was not. The tone change fixes it, and the new gate is anchored, controlled and mutation-tested rather than decorative.
- **Gate at verdict time:** 206/206 pure, 47/47 world, lint clean, build green, 14/14 captures.

## What the pass does

`fc1ab19` rebuilt the portal from a floating cyan torus into a near-black core disc
with a hot rim and a ground apron. It was the right change and it did not land,
because the swirl *texture* was never retuned with it. This pass retunes the tone
and adds the gate that would have caught the first one.

## The defect: the disc had structure, and averaged out anyway

The complaint was "washed-out cyan swirl". The tempting reading is that the swirl is
too bright. It is not: the committed `portal-located.png` at `fc1ab19` has a band
**mean luma of 28.7**, which is dark. The wash was never a brightness problem.

`makeSwirlTexture` held everything inside the fade at a floor of `0.25` under an
amplitude of `0.2`, so the arms were `0.2 / 0.45` = 44% of the signal to move in,
and the arm itself was `wave * wave` — a soft band, not a filament. Measured on the
8-bit alpha the function actually writes, over the same 0.30–0.62 upper annulus the
gate reads on the finished PNG:

| tone triple | p95 | p05 | ratio | peak alpha |
| --- | --- | --- | --- | --- |
| **before** 128 / 0.25 / 0.2 / ² | 83 | 35 | **2.37:1** | 0.400 |
| **after** 192 / 0.1 / 0.62 / ³ | 131 | 13 | **10.08:1** | 0.600 |

Run 2.37:1 through ACES at exposure 1.02 and the arms land a few luma levels apart
on the PNG. The frame shows a flat dark wash — inside a correctly rebuilt rim, which
is exactly why it survived review in a thumbnail.

Three changes, in `PORTAL_SWIRL_TONE` and `PORTAL_SWIRL_SIZE`:

- **Floor `0.25 → 0.1`**, so the ground between arms is the disc's own near-black
  rather than a uniform lift.
- **Amplitude `0.2 → 0.62` and power `2 → 3`**, turning each arm from a band into a
  filament with dark ground between it and the next. 2.4× the old peak.
- **Texture `128 → 192` texels**, because a filament widened by three pixels of
  bilinear blur is a band again. Built once at start-up, so ~2.2× the texels is free.

Dither was halved `0.18 → 0.09` in the same pass: at 3× the contrast it was no longer
hiding banding, it was competing with the arms.

**Verified on the render, not on the texture:** band sd **1.9 → 36.5**, p10 26 → 21,
pupil 28 → 13. The pupil mattered as much as the arms — the floor lift had been
raising the middle of the hole, and the core is now near-black again with the rim
still the brightest thing in the doorway.

## The gate

`swirlContrast` (`tools/png-luma.mjs`) measures the **spread** of luma inside the
swirl band. Not brightness, and not brightness relative to the rim — a flat disc at
full cyan is *brighter* than a structured one and still washed out, so a
brightness gate calls the broken render the good one. Spread rises when structure
appears and falls when it is smoothed away, which is also what makes the mutation
test meaningful.

**Self-locating, from the frame alone.** The hot cyan rim's bounding box gives the
centre and radius — cyan rather than merely bright, so the warm sodium lamps cannot
be mistaken for it. No hard-coded rectangle, because a hard-coded rectangle is a
second copy of "where the portal is" and it stops matching silently the first time
the camera moves.

**Upper half of the annulus only**, 0.30–0.62 R. The floor apron under a portal is
the brightest thing below the disc and it brightens with camera distance, so a full
annulus reports a number that partly describes where the photographer stood. The
upper half cannot see the floor at all.

**Why not a percentile ratio.** p95/p05 is the obvious formula and it is wrong: the
stale pre-pass-3 render scores **8.86:1** on it, because the pupil supplies the low
percentile and the rim supplies the high one while everything between them — the
only pixels that show whether a swirl exists — goes unexamined. A ratio across the
whole annulus rewards exactly the frame with a hard edge and a dark middle.

### How the gate was validated

**1. The no-portal control.** `street.png` reports no portal (0 hot cyan pixels), and
so do all 12 frames that contain none. The only two that report one are the two
that contain one:

```
portal-located.png    sd 36.5  p10 21  pupil 13   n 4574
portal-shutdown.png   sd 36.9  p10 21  pupil  7   n 56170
all 12 others         no portal (0 hot cyan px)
```

**2. A mutation ladder.** `repaintSwirl` washes the band toward a flat disc and
leaves the rim anchor untouched, so the only thing varying is swirl contrast:

```
mix      0     0.1    0.25   0.5    0.75   0.9    1.0
sd      36.5   32.8   27.4   18.2    9.1    3.7    0.0
passes   yes    yes    no     no     no     no     no
```

Monotonically falling at every step, and the crossover sits between mix 0.1 and
0.25 — documented, so the gate's sensitivity is a number rather than a hope. A gate
with no stated crossover point is one nobody can tell how close it is to passing a
frame nobody has looked at.

**3. Three thresholds, three different failures.** `sd >= 28` (structure),
`p10 <= 32` (structure with dark gaps, not noise scattered through a bright field),
`pupil <= 20` (the portal is a hole, so it must stay the darkest thing in frame).
The replaced render failed the first and the third together.

The `28` margin is deliberately thin, on the same grounds as the creature gate's
`0.62`: this is a small subject against a graded scene, and a loose threshold here
would be the same decorative gate again with a different formula.

## The gallery

All 14 frames were regenerated, and `benchmark/captures.json` reports **14 captured,
0 failed**. The swirl fix changes the portal frames and everything downstream of
shared lighting, so a full recapture was required rather than a targeted one.

**`portal-shutdown` captures a transition, and that is intentional.** Its state
records `hold: 0.556` — past §5.2's midpoint tick (§16.5.6), with all three portals
already flagged `false`. The swirl is still measurable there (sd 36.9) because the
hold is mid-fade rather than complete. It is a documented frame, not a stale one:
the step's own label and the committed `state` block agree.

## Corrections made during review

Three figures quoted in the new comments could not be reproduced by any convention
and were wrong in the last digit:

- `p95/p05 2.45:1 → 9.53:1` → **2.37:1 → 10.08:1** (83/35 → 131/13).
- `peak alpha 0.380 → 0.601` → **0.400 → 0.600**.
- `measured value is 36.3` → **36.5**, and the replaced render's sd is **1.9**, not
  the 21.4 the comment claimed. `21.4` matched no committed PNG at any ref.

Approximate numbers in a comment that exists to carry evidence are still wrong
numbers, so they are now the values a reader gets by re-running the measurement.
`git show fc1ab19:benchmark/screenshots/portal-located.png` reproduces the "before"
column, which is how the claim stays checkable after this commit lands.

## Residual risk

- **The gate reads a committed PNG, so a stale capture passes.** Inherited from the
  anti-rotation check and unchanged by this pass; the fix is `npm run capture`, not a
  test. The no-portal control and the two-frame sweep reduce how long a stale frame
  can go unnoticed.
- **`PORTAL_RIM_MIN = 170` is a claim about this palette.** The rim lands at 185–188
  in every capture, so the anchor survives a large retune of the swirl itself — which
  is the property that matters, since the rim is the one thing the gate must keep
  finding while the thing it measures changes underneath it. A retune that dims the
  rim below 170 would make every frame report no portal, which fails loudly.
- **A portal photographed much further off shrinks the band** under
  `BAND_MIN_PIXELS` and reports no portal. Again a loud failure naming the missing
  anchor rather than a quiet pass.
- **The ladder is built on `portal-located` only.** It exercises the measure's
  response to a washed swirl, not its response to a second framing; the close
  shutdown framing is covered by its own measurement instead.
- **`README.md`'s gallery prose is hand-maintained and still stale.** Carried forward
  from pass 1 and uncorrected by any gate.

## Verdict

**APPROVED.** Pass 3 built the hole and left the swirl behind a floor, so the disc
averaged to a flat wash that measured *dark* and therefore read as a lighting bug
rather than a texture bug. The tone triple and the texel size fix it, the pupil is
near-black again, and the new gate measures the one quantity that separates a swirl
from a wash — the spread of luma inside the band — with a self-locating anchor, a
no-portal control, a mutation ladder with a documented crossover, and three
thresholds that fail for three different reasons. Gallery recaptured 14/14, and the
three unreproducible figures in the new comments were corrected to measured ones.

```
before:  203/203 pure, 47/47 world   (one gate that could not fail)
after:   206/206 pure, 47/47 world   (three gates: one structure test, one
                                       no-portal control, one mutation ladder)
```

