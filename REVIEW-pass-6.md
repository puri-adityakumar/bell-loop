# REVIEW — iteration 2, pass 6

- **Commit under review:** `2fa9fe4` — "iter2(6): street furniture I - poles, wires, signs, hydrants, grates".
- **Reviewer verdict:** **FIXED — the source was already correct; the gate was not.** One finding, and it is the same species as pass 5's: a real defect that every gate in the repository was structurally unable to see. The review adds **zero** lines to `src/`. It adds the three gates that would have caught it.
- **Gate at verdict time:** 218/218 pure, 61/61 world, build green, 14/14 captures (pre-review) → **218/218 pure, 62/62 world** (post-review).

## What the pass does

`2fa9fe4` added the first overhead in the world: 42 poles per wrapped copy with a
crossarm, a bracket and a hook, six conductors each; every span drawn as a
**screen-space ribbon** in a single indexed `BufferGeometry` and a single draw
call; two signs, a hydrant and a kerb gully dealt out on the corners the pole did
not take. It also lifted the creature's eye out of the transparent depth sort,
because the new furniture had broken the creature gate: a cable two metres from
the lens sorted *after* an eye at thirty, and a luma-17.6 silhouette over a
luma-226 additive quad cut `creature-stalking.png`'s one solid 9x7 eye into two
fragments.

The build is sound. I checked the load-bearing parts directly and they are right:
the near plane is recovered from the projection matrix rather than restated
(`projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0)`), the width divides by
`clip.w` and never by `-p.z`, the segment is shortened against `z = -near` in
**view space before** it is projected so every surviving vertex has `w >= near`,
`side: THREE.DoubleSide` makes the ribbon orientation-independent, and the
poles stand at exactly `STREET_HALF_WIDTH + 1` from both road axes in all three
wrapped copies.

## The finding: the pass's two worst defects were fixed in comments, and nothing tested either one

The pass shipped, at some point during its own development, two geometry bugs
that each destroy the wire system outright:

```js
const quad = [p, q, q, p]          // the corners form a RING
const quadOther = [q, q, p, p]     // BUG: paired as if they ALTERNATED
const base = face                  // BUG: the INDEX cursor, not the VERTEX one
```

- **`aEnd` paired as an alternation.** The corner order is a *ring* -- `p, q, q, p`
  -- but the pairing was written as `k < 2 ? q : p`, which hands k=1 (a `q`
  corner) the point `q` and k=3 (a `p` corner) the point `p`. That is a
  **zero-length segment on half the corners**. A zero-length segment has no
  direction, so the shader's `dir` falls back to a hardcoded `(1, 0)` and the
  ribbon is extruded along the screen's *y* axis instead of perpendicular to
  the wire: edges tilt, quads stop abutting, neighbours overlap.
- **The index base read off the wrong cursor.** `face` counts *indices* at six
  per quad; `corner` counts *vertices* at four. They drift apart by two per
  quad. The first quad is coincidentally correct and every later triangle spans
  three unrelated world positions.

Both are now fixed in the source. **The point of this review is that neither fix
was gated, and reverting either one left the entire suite green:**

```
BEFORE the review, with EITHER defect reverted:

    node verify.mjs         218/218 checks passed -- all green
    node verify-world.mjs    61/61 world checks passed
```

The source carries a long, confident, **correct** comment about each defect --
including the exact predicted casualty count, "36,288 of 72,576". The comment was
right. It was also the only evidence that the bug was fixed, and a comment is not
a test.

### Why every existing gate missed it

Same failure mode as pass 5, one level down. The gates were not weak; they were
aimed at a different object than the one that was wrong.

- The **world wire check** proves the geometry *has* an `aEnd` attribute, that
  `aSide.count === position.count`, and that there are twelve samples per
  conductor. All of that is true of a buffer in which every `aEnd` is the
  corner's own position. It asserts the attribute is *present*, not that anything
  is *in* it.
- The **pure source claims** covered the shader, the mesh, the sag, the poles, the
  gully and the signs. The mutation table had ten rows and named ten claims. The
  two tables that carry the wire's actual shape were not among them.
- The **gallery** could not see it. Both defects rasterise as "a handful of
  screen-filling wedges" -- which is also what a *healthy* wire looks like from
  the wrong angle, since a span seen end-on has no screen-space length to expand
  against. There is no frame in `benchmark/screenshots/` that separates the two.

## The fix: no source change, three gates

`src/game/streetView.js` is **byte-identical to `2fa9fe4`**. The fixes were right;
what was missing was any way to know that. So the review writes the missing
instrument, in the units that could have failed.

**1. A geometry check, read off the built buffer** -- `verify-world.mjs`,
`'every wire quad is a fan of its OWN four corners, paired to the other end of its
segment'`. It walks all 18,144 quads and counts three things:

- indices that are not this quad's own fan, in order -- `base, base+1, base+2 |
  base, base+2, base+3`. Requiring the *order* catches a base that drifted by
  one; requiring *membership* catches one that drifted by two;
- corners whose `aEnd` equals their own `position` -- the zero-length hop;
- quads whose `aSide` alternates rather than splitting the ring -- which stitches
  the ribbon along the span instead of opening it across.

This is deliberately a measurement and not a fingerprint, because the source
comment already demonstrated that a fingerprint of this file can be confident,
detailed and wrong at the same time.

**2 and 3. Two source claims and two mutation rows** -- `verify.mjs`,
`'every ribbon corner is paired with the other end of its own segment'` and
`'each wire quad is indexed from its own four corners'`, with a row in the
mutation table for each. The claim floor moves `>= 16` to `>= 19` so deleting a
claim is now itself a failure.

## The gate

```
before:  218/218 pure, 61/61 world   (no gate could see the ribbon tables)
after:   218/218 pure, 62/62 world   (one geometry check, two claims,
                                      two mutation rows, floor 16 -> 19)
```

`npm run check` is green end to end: **218/218 pure, 62/62 world, lint clean,
build 901.76 kB in 446 ms, EXIT=0.**

## How the gate was validated

The new gate is worth nothing if it cannot fail, so each defect was reverted and
the suite re-run. The numbers below are the new world check's own failure text --
and they are the independent confirmation that the source comments were right all
along:

| Mutation | Pure | World | Measured |
| --- | --- | --- | --- |
| `quadOther` -> `[q, q, p, p]` | 216/218 (2 FAIL) | 61/62 | `36288 of 72576 wire corners carry their OWN position as aEnd` |
| `base = corner - 4` -> `base = face` | 216/218 (2 FAIL) | 61/62 | `108858 of 108864 wire indices are not this quad's own fan` |
| `quadSide` -> `[-1, 1, -1, 1]` | 218/218 (green) | 61/62 | `18144 wire quads alternate aSide` |
| unmutated | 218/218 | 62/62 | -- |

`108858 of 108864` is six correct indices out of 108,864: exactly the first quad,
exactly as the cursor analysis predicts. The geometry check reproduced both
predicted casualty counts without having read them.

The third row is the one asymmetry worth stating plainly: **the `aSide` ring is
caught by the world gate only.** It has no pure-side claim, because a claim for it
would be a third fingerprint of the same two lines, and the review's finding is
precisely that fingerprints of those lines do not work. The world gate owns it.

## The gallery

**No recapture.** `src/` is unchanged, so the render is unchanged and the
committed 14/14 captures still describe it exactly; the gallery gate still passes
`PASS the gallery in the repository is the gallery the design asks for`.
Re-running the capture would have produced identical frames and a no-op diff.

I inspected `street.png` and `creature-stalking.png` directly. Wires read as thin
dark silhouettes against the amber rather than as a ruled grid or as filled
wedges; the pole is grounded on the pavement; the signs and the hydrant sit on
the walk and clear of the carriageway; and the creature carries a single solid
eye in `creature-stalking.png`, which is the specific regression the
`EYE_RENDER_ORDER` change exists to prevent.

## Performance

Unchanged and re-confirmed. The wire system is one indexed `BufferGeometry` and
one draw call carrying **1,512 conductors -> 18,144 quads -> 72,576 corners ->
108,864 indices** across all three wrapped copies, with `frustumCulled = false`
and no outline pass -- against the ~252 calls a `LineSegments` per span would
cost, in a scene graph the file header caps at ~4,600 objects. The one allocation
per attribute is still sized from the span list rather than grown by push. The
new gate's own cost is a linear walk of 18,144 quads in a harness that already
builds three wrapped copies of the world; it is not a runtime cost and does not
enter `dist/`.

## Residual risk

- **The world gate owns `aSide`.** A mutation of `quadSide` alone keeps the pure
  side green. The world gate catches it, so this is defence-in-depth asymmetry
  rather than a hole, but it is the one row without a pure-side claim.
- **The wire's *visual* thickness is still gated by construction, not by
  measurement.** `uMinPx` / `uMaxPx` are asserted to exist and the divisor to be
  `p.w`, but no gate measures a wire's on-screen width. A ribbon that renders at
  1 px or at 40 px satisfies every check in the repository.
  `benchmark/captures.json` carries luma statistics for the frames; it does not
  carry a wire-width statistic.
- **The eye render-order fix is gated on the constant, not on the render.** The
  claim asserts `EYE_RENDER_ORDER` exists, is non-zero, and is assigned to the
  `eye` mesh rather than the `eyes` group, with three mutations. It does not
  assert that the eye is *last* -- the comment says "the last transparent thing
  drawn in a frame", and `1` only means "after the default", so any future
  transparent object given a `renderOrder >= 1` would re-break the creature gate
  silently.
- **The `free[]` corner reservation is a filter, not a spatial test.** A sign and
  a hydrant on the same corner are kept apart by differing walk offsets
  (`SIGN_WALK_OFFSET` vs `HYDRANT_WALK_OFFSET`) rather than by a shared exclusion
  volume, so the two tables are coupled by convention. A future third corner
  occupant that reuses a walk offset would overlap the sign, and no gate
  measures inter-furniture distance.

## Verdict

**FIXED.** The pass built the right thing: the wire shader's near-plane clip and
`p.w` divisor are correct, the pole geometry is correct, the furniture
reservation is sound, and the eye render-order fix is the right fix for the right
reason. What the pass lacked was any way to *know* its two worst bugs were gone
-- it had fixed them in prose, and the prose was accurate enough to be believed.

The review therefore changes no source and adds one geometry check, two claims,
two mutation rows and a raised claim floor. Each defect now fails loudly instead
of passing quietly:

```
before:  218/218 pure, 61/61 world   (green with either defect reverted)
after:   218/218 pure, 62/62 world   (216/218 and 61/62 with either reverted)
```

Known debt is listed under residual risk: the `aSide` ring is unclaimed on the
pure side, the wire's on-screen width is unmeasured, the eye's "last" is asserted
as "non-zero", and the corner reservation is a filter rather than a spatial test.
