# REVIEW — iteration 2, pass 7

- **Commit under review:** `2f65555` — "iter2(7): street furniture II - dumpsters, bikes, vending machines, shelters, posters".
- **Reviewer verdict:** **FIXED — the source was correct; the gate was not, and neither was the gate I wrote to replace it.** Two findings. The first is the pass's: all fifteen pools were gated on counts and placement rules, neither of which can see a camera, so nothing in the repository could tell whether a single piece of furniture was ever in a photograph. The second is mine, and it is the more interesting one: the visibility gate this review added reported **zero furniture in all fourteen views** on its first run, and that answer was *correct* and completely wrong, because the probe had a bug that made "nothing" its only possible output.
- **Gate at verdict time:** 221/221 pure, 68/68 world, 14/14 captures → **222/222 pure, 70/70 world, 14/14 captures** (post-review).

## What the pass does

`2f65555` added fifteen instanced pools to the kerb: dumpsters and their castors, trash bags, vending machines with dead/lit/flickering liners and product rails, bus shelters with benches and ad panels, bollard runs, bicycles with torus wheels, and two poster pools (whole and torn, because the tear is in the alpha). It also added `flickerAt` to `hash.js` — one tick of a failing ballast, as a pure function of a seed, a tick index and a salt — and made exactly one machine in each of the world's three wrapped copies misbehave.

## Finding 1: every pass-7 gate is a count, and a count cannot see a camera

The pass shipped six world checks. All six read `pool.used` or a placement rule:

| check | what it reads | what it cannot see |
| --- | --- | --- |
| families are placed, objects are their pieces | `pool.used`, cross-pool arithmetic | where any of it is |
| the district table is real | `dressingLog`, `DISTRICT_DRESSING` | which district is in frame |
| nothing in a carriageway, nothing in front of a portal | x/z against roads and anchors | whether the kerb is in shot |
| the lit liner is a fogged surface | material flags, `flickerLot` | whether a lit liner is visible |
| the flicker is a function of the clock | `flickerAt` output | whether anything renders it |
| a bin stands on its castors | instance `y`, scale | whether a bin is in the picture |

Every one of those is a true statement about the world, and none of them is a statement about the fourteen PNGs. §16.5's views all stand on one intersection — `STREET_NODE` is `{ax: 1, az: 1}` and six of the fourteen stand on the lamp standing on it — so the entire gallery photographs **one corner of a 448 m wrapped world**, and the pass's placement rules gave it no reason to put anything legible on that corner. A pass that had placed all fifteen pools in the far quadrant would have passed all six checks and produced a gallery of a bare street.

Measured, nearest legible piece per family from the §16.5 node:

```
dumpster 46m   trashBag 46m   vending 75m   shelter 132m
bike 121m      bollard 24m    poster 32m
```

## The gate this review adds

`sightline()` in `capture/main.jsx` projects every pass-7 instance's bounding sphere through the **real** `PerspectiveCamera`, after the real steps have run, and reports pieces in frame and pieces *legible* (>= `FURNITURE_MIN_LEGIBLE_PX` = 3 px of radius) per family. It is recorded into `benchmark/captures.json` and gated twice: `tools/capture.mjs` refuses to write a frame below the floor, and `verify.mjs` reads the committed report back.

Measured result — **14/14 views pass**:

| view | legible | kinds | nearest | in frame, by kind |
| --- | --- | --- | --- | --- |
| title | 3 | 2 | 64.5 m | vending, shelter |
| street | 9 | 2 | 68.6 m | vending 5@5.3px, shelter 4@6.0px |
| hammer-located | 19 | 4 | 21.3 m | dumpster 10@13.9px, shelter, bollard, poster |
| hammer-awakening | 17 | 4 | 15.8 m | dumpster 10@18.7px, shelter, bollard, poster |
| portal-located | 2 | 1 | 74.5 m | shelter 2@3.8px |
| portal-shutdown | 2 | 1 | 72.2 m | shelter 2@3.8px |
| creature-stalking | 14 | 2 | 54.4 m | vending 6@5.4px, shelter 8@8.0px |
| creature-chasing | 14 | 3 | 50.0 m | dumpster, vending 8@7.0px, shelter |
| banish | 9 | 2 | 68.6 m | vending 5@5.3px, shelter 4@6.0px |
| capture-reset | 9 | 2 | 68.6 m | vending 5@5.3px, shelter 4@6.0px |
| finale-headlights | 6 | 3 | 7.2 m | shelter, bollard 4@19.5px, poster 1@9.9px |
| win | 4 | 3 | 18.0 m | shelter, bollard, poster |
| responsive | 4 | 1 | 68.6 m | vending 4@6.2px |
| pause | 9 | 2 | 68.6 m | vending 5@5.3px, shelter 4@6.0px |

**The pass was not wrong about the world.** Furniture is placed, legal, and in frame in all fourteen views. What the pass could not do was *show* it, and the screenshots confirm why: the legible furniture in most views is a 3-6 px lit rectangle 65-75 m away, which is why a first pass at reading `street.png` and `portal-located.png` found "no clearly identifiable furniture". That was a true observation about the gallery and a false inference about the pass. `hammer-located` and `hammer-awakening` — the two views that stand at the hammer rather than the lamp — carry the pass properly, with a bin at 13.9-18.7 px and a poster at 3.3-4.3 px, twenty metres away.

## Finding 2: my probe reported "nothing" in all fourteen views, and that was a bug

The first capture run of the new gate failed every view:

```
FAIL street  the frame is not evidence that the street has furniture on it:
             0 legible piece(s) of 0 in frame across 0 kind(s) [none],
             nothing in the frustum at all
```

This is the most dangerous failure mode a visibility gate can have, and it deserves to be written down in full.

**The bug.** `THREE.Vector3.applyMatrix4` divides by `w` for you and discards it. `viewPoint.applyMatrix4(camera.projectionMatrix)` on a `Vector3` therefore leaves `viewPoint.w` as `undefined`, so the near-clip guard `if (!(w > 0)) continue` rejected **every point in the frustum**. A `Vector4` preserves `w` and the guard does its job.

**Why it was so hard to see.** The output was *indistinguishable from the defect the gate was written to find*. "No furniture in any of the fourteen views" is exactly the finding, the numbers were internally consistent, the failure was uniform across all fourteen runs, and the gate had been added to a pass that genuinely had thin furniture coverage. There was no anomaly anywhere except that the gate never once reported a positive number. A gate that can only ever return zero agrees with every bug that puts nothing there — **including its own**.

**How it was caught.** By pointing a camera at a piece the test placed itself. The check now in `verify-world.mjs` plants a 0.5 m sphere 5 m dead ahead and asserts the probe reports it — a **positive control**, which is the only thing a "nothing is there" gate needs and the only thing it did not have.

That control then caught a second, subtler version of the same bug when I tried to mutate the check: swapping `camera.matrixWorldInverse` for an identity matrix left all six original controls green, because a point at world `(0, 1.75, -5)` is already "in front" in world space and projects to NDC `(0, 0.48)`. The assertion that actually distinguishes a probe reading the camera from a probe reading a constant is the **rotated camera**: turn the camera 90 degrees, and the piece that was dead ahead must leave the frame while the one now ahead must enter it. Without that assertion the whole check is satisfiable by a probe that ignores the camera entirely.

## What was NOT changed

`src/game/streetView.js` and `src/game/hash.js` are **untouched** — the pass's placement, its rates, its exclusion zones and its flicker are all correct; the defect was that nothing could see them. A review that responded by moving furniture to make a screenshot look better would have destroyed a correct world to satisfy a gate that did not exist yet. `verify.mjs`'s `EYE_RENDER_ORDER` gate, the pass-3 portal-pupil gate and the pass-6 wire gates are all still in place and still green.

The only file under `src/` this review adds to is `src/game/capture.js`, and it adds no game logic: 117 lines of the furniture family table, the three floors, and `describeSightline`. That module is the §16.5 capture set *as data*, it is already imported by `verify.mjs`, and it is not reachable from `index.html`'s entry graph. `capture/main.jsx` and `tools/capture.mjs` are capture-only by construction and never reach `dist/`.

One claim I had to correct rather than ship: the probe's comment originally said the column *norm* was "the yaw correction". That is wrong as stated — a column norm is yaw-**invariant**, because rotation preserves length, so the norm of a basis column is `scaleX` at 0, 30, 60 and 90 degrees alike. What is actually load-bearing is the norm versus a single **element**: element 0 of a yawed instance is `scaleX * cos(yaw)`, which at 60 degrees reads 0.055 for a true 0.11. The comment now says that, with the numbers.

## A gate that reports a fact it cannot act on

The measurement says **five** of seven families are legible somewhere in the gallery and **seven** of seven are in frame. A trash bag peaks at 1.66 px of radius and a bicycle frame at 1.93 px, in any view, because the nearest bag is 46 m off and the nearest bike is 121 m; a bin reaches 18.74 px and a bollard 19.48 px from the same corners.

So `verify.mjs` asserts **all seven in frame** (the pass's claim about the map) and enumerates the **five legible** ones (the floor's claim about the photographs), rather than demanding legibility from all seven. Demanding the impossible is not a stricter gate — it is a gate that gets deleted the first time it is inconvenient. The two exceptions are named in the check, so "no view shows a bicycle legibly" is a recorded property of this build rather than a gap a reader has to notice unaided.

## Mutation results

Every new gate was checked by breaking it. All were caught:

| mutation | caught by |
| --- | --- |
| report says 0 legible everywhere | `verify.mjs` furniture gate |
| one view drops below the floor | `verify.mjs` |
| `furniture` key removed (stale report) | `verify.mjs` — `undefined` vs a number fails loudly |
| the bike dropped from every `byKind` | `verify.mjs` in-frame set |
| `pools` count disagrees with the list | `verify.mjs` |
| `legible > pieces` | `verify.mjs` |
| `nearest: 0` on a view with furniture | `verify.mjs` |
| probe view matrix -> identity | `verify-world.mjs` rotated-camera control |
| probe near/far test removed | `verify-world.mjs` 300 m control |
| probe legibility predicate removed | `verify-world.mjs` 100 m control |

The last three are *the same bug class as finding 2*, reintroduced deliberately. The control that catches them is the one that did not exist when the bug was shipped.

## Known debt, left deliberately

- **`trashBag` and `bike` are never legible** (1.66 px and 1.93 px). A future pass that re-composes the lamp stand-off, or raises these families' rates near the anchor node, should tighten the legible list in `verify.mjs` to seven. The measured `maxPx` for both is in `benchmark/captures.json`, so the tightening will fail on a number rather than on an opinion.
- **The probe is duplicated** between `capture/main.jsx` and `verify-world.mjs`, because the first is a browser closure over a module-level `game` and cannot be imported. Both take the near/far planes and the FOV off the camera rather than restating them, and the duplication is held honest by the rotation control. If the probe is ever extracted into a pure module, the duplicate and its mutation test can go together.
- **`sightline` measures frustum membership, not occlusion.** A dumpster 30 m down an avenue behind a lamp post is in the frame and is counted. That is the right floor for this pass — demanding zero occlusion across 14 views x ~2,241 instances would fail on a hair — but the gate cannot answer "can you see the bin", only "is the bin in the picture".
- `verify-world.mjs`'s `nodeTable` and `nearestNode` helpers remain unused. Both predate this review; they are left alone.

## Re-running this review's evidence

```
node verify.mjs         222/222   (the furniture gate reads benchmark/captures.json)
node verify-world.mjs    70/70    (prints the 45 m family counts on every run)
node tools/capture.mjs   14/14    (writes furniture into the report; refuses a bare frame)
npm run check                        lint + 222 + 70 + build, all green
```

The probe's own arithmetic, if you want to check it without a browser: a 0.5 m sphere at 5 m is 49.5 px of radius at 720p and a 72-degree FOV, at 20 m it is 12.4 px, and at 100 m it is 2.5 px — under the floor, and reported as in frame but not legible. `verify-world.mjs` asserts all three.
