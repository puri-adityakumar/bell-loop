# REVIEW — iteration 2, pass 2

- **Commit under review:** `e779417` — "iter2(2): cinematic sodium pools, warm bounce, fog as depth cue + creature-separation gate"
- **Reviewer verdict:** **FIXED** — the sodium work is right and now on the evidence; the pass-1 review's most valuable requested gate was shipped broken and is rebuilt here, and the gallery was recaptured because the gate exposed a framing defect in it.
- **Gate at verdict time:** 198/198 pure, 44/44 world, lint clean, build green, 14/14 captures.

## What the pass does

Widens the sodium pools from 12 m to 18 m with a rim, adds a warm bounce fill, and
lowers fog density close to the lamps so the fog reads as a depth cue rather than a
wall. It then adds the gate pass 1 asked for by name: a rendered check that the
creature still reads darker than the background it stands in.

The atmospheric changes are good and are confirmed below. The gate is the story of
this review, and it is a story about a gate that could not fail.

## The blocker: the creature-separation gate was a false positive

### What it claimed

The shipped test asserted a ratio of two **global percentiles** of the whole lower
scene — `p0_1` against `median` — and the comment stated the reasoning outright:

> `p0_1` is the creature (the darkest thousandth of the lower scene … a figure at
> 17 m) and `median` is the lit road it is standing on.

### Why that is false

Both halves are false, and the disproof is a single measurement. `street.png` —
which contains **no creature at all** — scores **0.14** on that ratio.
`creature-stalking.png`, which does contain one, scores **0.18**.

```
frame                  p0_1  median  ratio     (the old gate, on e779417's own PNGs)
street.png               6      44   0.14   <- no creature in this frame
creature-stalking.png    8      45   0.18   <- creature in this frame
```

Both figures are measured on the PNGs **as committed at `e779417`**, which is the
only place the old gate's verdict is meaningful — the gallery has since been
recaptured, and re-measuring the new frames would be answering a different
question. The ordering is the point and it does not depend on either absolute
value: a frame with no subject in it scored *better* separation than the frame with
a subject in it.

The cause is that both percentiles describe the frame's **histogram**, not its
subject. On this street that histogram is a very large bright mass (the sodium
pools) and a very large dark mass (the vignette, the unlit house fronts, the
kerbs). `p0_1` is the darkest 460 px of 460,800 — on this content, the frame's own
corners. The consequence is the specific thing a gate exists to prevent: **lifting
the pools lowers the ratio whether or not the creature changed at all.** The
sentence "p0_1 IS the creature" was an assumption that happened to look plausible
in a comment, and it was never checked against the pixels.

### The rebuilt gate

§12.1's actual claim — "a hole in the fog rather than an object in it" — is a
statement about a subject and its **immediate** surround, so it is now measured
that way, in `creatureContrast` (`tools/png-luma.mjs`):

1. **Locate the subject.** The creature is found by its eye quad, which
   `creatureView.js` draws with `fog: false` and additive blending. That makes it
   the only mark in a frame that is unfogged, distance-invariant and small.
2. **Measure two adjacent populations.** The body's own pixels against the pixels
   10–30 px either side of them, over the same rows.

Because the two populations are adjacent they share the fog, the dusk and the
grade. A pass that lifts the whole world moves both and the ratio holds; a pass
that lifts the creature alone is caught. The percentile version had no such
property, which is precisely why it could not fail.

**The anchor is load-bearing, and the review checked it rather than trusting it.**
A ratio needs a subject, and "the darkest blob" is not one — on this content the
lamp post, the house fronts and the vignette are all darker than the creature and
all bigger. Three impostor classes had to be excluded, each found by running the
detector over the whole gallery rather than over the frame it was written for:

| impostor | in | rejected by |
| --- | --- | --- |
| HUD glyph runs, sky highlights | `street`, `title`, `win`, `responsive` | shape: 4×9 and 1×8 slivers, not square |
| lit windows in distant houses | `hammer-located` | area: 9 px against the real eyes' 49 and 70 |
| lamp heads near camera | `banish` | span: wider than 14 px |

After them, **every frame without a creature reports no creature** — which is the
property the old gate lacked entirely, and is now its own test.

## The second defect: the gallery's own stalk frame was misframed

The rebuilt gate failed immediately on the committed `creature-stalking.png`, at a
ratio of **1.22** — the creature was *brighter* than its background. That was not a
bad threshold; it was the picture.

`src/game/capture.js` stood the camera 11 m short of the lamp and then placed the
creature 17 m from the **camera**, at bearing 34°. That put the figure 6 m *beyond*
the lamp and 34° off the road axis — outside the pool entirely, in front of an
unlit house front. The frame showed a slightly-lighter smudge on a dark wall. The
step's own comment had claimed the opposite the whole time:

> §6.1's figure is a silhouette because it is standing in a lit street … The pool
> lights the road the creature is walking down.

The comment was true of the *intent* and false of the *frame*, and the old gate was
constructed out of the same assumption, which is how a wrong picture and a gate that
could not contradict it ended up in the same commit.

Fixed to `back: 25`, `bearing: 6` — which puts the lamp ahead of the creature and
the pool under its feet. Five framings were captured and measured rather than
guessed:

| `back` | `metres` | `bearing` | ratio | |
| --- | --- | --- | --- | --- |
| 11 (was) | 17 | 34° | 1.22 | in front of an unlit wall |
| 20 | 17 | 4° | 0.62 | exactly at the gate's limit, no margin |
| **25** | **17** | **6°** | **0.59** | **chosen** |
| 30 | 17 | 6° | 0.56 | smaller figure, no gain |
| 25 | 15 | 10° | 0.59 | also fine; 17 m is §6.1's distance |

The recaptured frame is not a marginal pass against a threshold. The creature is
now a tall, unmistakable dark figure with a lit eye, standing on a lit sodium
street, legs visible against the road.

## How the new gate was validated

A gate that only ever runs against committed PNGs is a gate that is only ever
exercised against frames that happen to exist — and the old one looked green on the
exact artifact nobody re-examined. So the rebuild ships its own counterexamples.

**1. The no-subject control.** `street.png` is shot from the *same viewpoint* as
`creature-stalking.png` — both are `goto lamp`, with the creature absent in one of
them — so it is precisely the frame the old measure scored 0.14 on. It must report
no creature. It does.

**2. A mutation ladder.** `repaintBody` fills the creature's trunk with a flat grey
and leaves the eye and the rest of the frame untouched, so the anchor still resolves
and the only thing varying is how the body compares to its background:

```
body luma  120    90    60    40    20     0
ratio      1.38  1.03  0.69  0.47  0.24  0.01
```

Monotonically falling, with both ends agreeing with the threshold the real frames
are held to. The test asserts the **direction**, not a pair of numbers: a gate that
passes frame A and fails frame B can be satisfied by a constant, whereas a
measurement that moves the right way as the subject is washed into its background
cannot. The ladder is capped at 120 rather than 200 for a reason about the anchor
rather than the threshold — a body painted at 200 joins the eye quad and the frame
correctly reports no creature at all, which is the measure working, but it makes
such a row evidence about the anchor instead of about contrast.

**3. The gallery, in full.** Fourteen frames measured; the only two that report a
creature are the two that contain one, and both are genuine holes:

```
street.png          no creature     <- the frame that scored 0.14 on the old gate
creature-stalking   0.59   body 47.3  vs background 79.7
creature-chasing    0.30   body 25.3  vs background 84.1
```

## The sodium work, checked

The atmospheric claims hold, measured on the regenerated frames.

- **Fog still closes.** Fog is 2.33× darker than sky at dusk 0, so the silhouette
  rule §12.1 depends on is intact.
- **The pool reaches past the kerb.** `LAMP_POOL_DIAMETER` 18 against a 12 m
  carriageway, with `LAMP_POOL_RIM` at a plateau so the wider falloff does not read
  as a smudge, and 64 m lamp spacing so §4's grid survives as a grid rather than a
  continuous orange sheet.
- **The bounce is a fill, not a second key.** It lifts walls near lamps without
  competing with the lamp heads, which stay the brightest thing on the road.
- **A lamp reaches the next lamp.** Search radius holds at the measured 56 m
  against the 47.6 m the spacing requires.

## Residual risk

- **`EYE_MIN_AREA` is a claim about two distances, not all of them.** The eye quad
  scales with distance, so a creature much further off than §6.1's 17 m would fall
  under the 24 px floor and report no creature. The alternative — dropping the floor
  and relying on shape alone — was measured, and it admits lit windows. This is the
  smaller of the two limitations and it fails loudly, naming the missing anchor,
  rather than quietly measuring the wrong blob.
- **The gate reads a committed PNG, so a stale capture passes.** Inherited from the
  anti-rotation check and unchanged by this pass; the fix is `npm run capture`, not a
  test. The new control tests reduce how long a stale frame can go unnoticed, since
  a stale `street.png` or a stale creature frame now has a second thing to agree
  with.
- **The mutation ladder is built on `creature-chasing` only.** It exercises the
  measure's response to a washed subject, not its response to a subject at 17 m;
  the 17 m case is covered by the stalk frame's own measurement instead.
- **`README.md`'s gallery prose is hand-maintained and was already stale before this
  pass.** Carried forward from pass 1 and still uncorrected by any gate.

## Verdict

**FIXED.** The sodium work is the right change for the right reason and is now on
the evidence. The blocker was the gate pass 1 specifically asked for: it shipped
able to pass a frame containing no creature at all, on a comment that asserted
`p0_1` was the creature when the pixels say it is the frame's own corners. It is
rebuilt as a localized, eye-anchored, adjacent-population measurement, validated
against a no-subject control and a mutation ladder, and it immediately caught a
second defect the old gate was structurally unable to see — the stalk frame's
creature was standing in front of an unlit house wall, brighter than its own
background, while the gate called it 0.18. The gallery is recaptured, the framing
is fixed, and `npm run check` is green at 198/198 and 44/44.

```
before:  196/196 pure, 44/44 world   (one gate that could not fail)
after:   198/198 pure, 44/44 world   (three gates, two of them controls,
                                       one of them with a mutation ladder)
```
