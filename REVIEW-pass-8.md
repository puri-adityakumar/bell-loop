# REVIEW — iteration 2, pass 8

- **Commit under review:** `344d38f` — "iter2(8): water & reflections - lamp-streak puddles, drainage canal, wet-road darkening".
- **Reviewer verdict:** **FIXED — two real defects in the canal's shimmer, both invisible to every gate the pass shipped, plus one comment that argued for the defect.** The world was otherwise sound: placement, banding, cost, the portal exclusion and the streak's eye arithmetic are all correct and all genuinely gated. What was broken is the one animated thing in the pass, and it was broken in the two ways an animated thing can be: **it moved on the wrong axis, at a twenty-third of the advertised speed**, and **its texture did not tile, so it drew a hard seam once per tile**. Both are the kind of bug that reads on screen as "the water is a bit still" and is therefore indistinguishable from the property the pass was deliberately after. The third finding is the constant's own doc block, which reasoned its way to the false conclusion that the speed was right — the reason a human reader did not catch the first one.
- **Gate at verdict time:** 225/225 pure, 77/77 world, 14/14 captures → **225/225 pure, 77/77 world, 14/14 captures** (post-review; no gate count moved. Two new *measurements* were added inside the existing canal test, plus two new pure claims and two new mutations).

## What the pass does

`344d38f` gave the street its first water. Four new palette entries (`puddle`, `wetSheen`, `canalBed`, `waterStreak`), five new instanced pools, and a build pass that places, per node: gutter-band puddles in the 0.7 m channel against the kerb, crossing-band puddles in the two wheel ruts of the avenue's carriageway, one additive reflection streak per lamp, and — at the single `CANAL_NODE` the whole §16.5 gallery stands on — a 26 m drainage channel crossing the carriageway with standing water between two 100 mm lips, its surface scrolling a procedural shimmer.

The design argument is good and mostly holds. The reflection is *drawn* rather than sampled, so the world keeps one camera, one pass and no render target; the streak is one additive warm quad per lamp, gated below the creature's `EYE_MIN`; the three puddle bands each draw their radius into the room that band was given, which is the fix for the bug that shipped inside the first version of the pass (a global `PUDDLE_R_MAX` put a third of the world's puddles on the footway); and the portal exclusion is *called* from both water families, with a plant-based check that removes the filter's call site cleanly.

## Finding 1: the shimmer scrolled across the channel, at 1/23.6th of its stated speed

`update()` animates the canal like this:

```js
const shimmer = (t * CANAL_SHIMMER_MPS) / (CANAL_LEN / CANAL_SHIMMER_TILES)
this._materials.canalWater.map.offset.x = shimmer % 1
```

`offset.x` is a scroll in **texture U**, and a texture's U is its X. The divisor is `CANAL_LEN / CANAL_SHIMMER_TILES` = 26 / 7 = **3.71 m**, so the arithmetic is only correct if one U tile spans 3.71 m of *world* — which is only true if U runs along the 26 m channel.

It does not. The pool was built as:

```js
new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)   // streetView.js:4408 in 344d38f
```

Laying a plane down with `rotateX(-PI/2)` puts **U on the local X**, and `place()` scales the local X by `CANAL_W` = 1.1 m. So the scroll ran across the channel's 1.1 m **width**, at 0.06 x (1.1/26) = **0.0025 m/s** — 23.6x slower than `CANAL_SHIMMER_MPS` promises, and 90 degrees from "water moves down the channel". Measured off the built geometry, not reasoned:

```
U (texture x) world extent = 1.100 m     <- the width
V (texture y) world extent = 26.00 m     <- the length
1 texture U unit = 0.1571 m              (update() divides by 3.7143 m)
ground speed: documented 0.06 m/s | ACTUAL 0.00254 m/s | 23.6x
```

**Every pass-8 world check passed with this bug in place.** The canal was one instance per copy, two lips 1.1 m apart, water 10 mm below the lip tops and 10 mm above the road, darker than the asphalt, a lit `MeshStandardMaterial` with fog on, `RepeatWrapping`, an offset that advanced by exactly `4 * CANAL_SHIMMER_MPS / (CANAL_LEN / CANAL_SHIMMER_TILES)` in four seconds, bit-identical on two runs to `t=12.5`, and `repeat.x === 7`. All of that is true. None of it can see an **axis**: the delta check recomputes the same formula it is testing, so a scroll on the wrong axis satisfies it exactly.

That is the shape of the bug. Nothing about the shimmer's direction is visible to a check about the shimmer's *rate*, and a wrong axis renders as water that is simply still — which is what "slow" is supposed to look like, so the failure mode is indistinguishable from the success condition.


### The fix

One rotation, in the pool's own geometry expression:

```js
new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2)
```

`rotateY(PI/2)` after the lay-down moves U onto the local Z, which `place()` scales by `CANAL_LEN`. `place()` is still called with `(CANAL_W, 1, CANAL_LEN)`, so the channel's footprint is unchanged — 1.1 m across, 26 m along — and the divisor in `update()` now means what it says. Nothing else in the file uses this pool, so the yaw costs one rotation and no layout change.

### The gates

Both are needed, because they fail independently and for different reasons.

`verify-world.mjs` measures the **built** geometry: it walks the UV attribute, finds which local axis a U step of 0→1 moves along, and requires it to be Z. It then converts that to a length — one U tile in world metres, `scale / repeat.x` — and requires it to equal `CANAL_LEN / CANAL_SHIMMER_TILES`. The direction half would pass on a plane correctly yawed but wrongly scaled; the length half is what pins the **speed**.

`verify.mjs` asserts the same property at the source, on the geometry expression, plus a mutation that flattens the plane back. It is written against the *expression* rather than `'canalWater'`, because `stripProse` blanks every string literal to `""` and a regex quoting the pool's name could never match its own file.

Reverting the fix fails both, independently:

```
pure:  the canal water plane is yawed so its U axis runs along the channel
world: the canal's U axis follows the local X axis, and local X is the 1.1 m
       width, so the shimmer scrolls across the channel instead of down it
```

## Finding 2: the shimmer's tile did not tile, so it drew a seam once per tile

Claim 12 of the pass is *"the shimmer map repeats on both axes, because it is scrolled"*, and it is true as written: `wrapS`/`wrapT` are `RepeatWrapping` and `repeat.set(7, 1)`. But a wrap mode is the **enabler** of a seam, not its prevention. `RepeatWrapping` on a map whose image does not meet itself draws that discontinuity at the boundary — once per tile, seven times down a 26 m channel, sliding at 0.06 m/s. The claim named the mechanism and the artefact was still there.

`makeShimmerTexture` is a sum of sines, and a sine tiles seamlessly only at a **whole number of cycles** across the tile. The pass shipped:

```js
Math.sin(v * Math.PI * 2 * 2.3 + phase * 1.7) * 0.32    // across
Math.sin(v * Math.PI * 2 * 4.1 + phase * 0.6) * 0.18    // across
Math.sin(u * Math.PI * 2 * 1.7 + phase * 2.3) * 0.16    // along — the one that scrolls
```

2.3, 4.1 and 1.7 are all non-integers, and the comment says why: *"the three are INCOMMENSURATE, so the pattern does not visibly repeat over the 26 m of channel."* That is a real aesthetic goal and it is **unreachable together with tileability** — a tile that repeats is periodic by definition. The pass chose the goal and kept the wrap mode, and got the worst of both.

Measured on the built texture at `SURFACE_SEEDS.water`:

| | wrap step | steepest step *inside* the tile | verdict |
| --- | --- | --- | --- |
| shipped (2.3 / 4.1 / 1.7) | **70/255** on U, 38/255 on V | 7/255 on U, 20/255 on V | seam — an order of magnitude steeper than the texture's own gradient |
| fixed (1.0 / 2.0 / 4.0 bands, 2.0 swell) | 6/255 on U, 3/255 on V | 8/255 on U, 19/255 on V | no seam — the wrap is gentler than the interior |

### The fix

Whole cycles: bands at 1, 2 and 4 across, swell at 2 along. The interference pattern is unchanged in character (three incommensurate-enough harmonics, still not a comb), and the honest version of the "does not repeat" claim replaces the old one: the pattern now repeats every **3.71 m**, which at the 5.6-31.6 m the canal is actually read from is under the threshold at which the eye resolves a repeat. A seam every 3.7 m is a far smaller artefact than seven hard lines travelling down the water.

The comment in `makeShimmerTexture` that asserted the pattern "does not visibly repeat over the 26 m of channel" was **false as written** and has been corrected rather than deleted.

### The gate, and a correction to it

This is the check that could not be written before the 2D stub kept its `putImageData` payload: *"does the generated texture meet itself"* is a property of the image and of nothing else, and reading it off the source regexes that produced the pixels would be asking the generator whether it agrees with itself. The stub now stores the last image per canvas (`putImageData(image) { if (image && image.data) canvas.pixels = image }`), and the gate reads it back off `map.image.pixels`. The existing member-walk check is unaffected — it asserts every member is a *function*, which is still true.

**The first version of this gate was wrong, and the error is recorded in the gate itself.** I wrote `vSeam <= 3 && uSeam <= 3` and it failed the *fixed* shimmer at 3 and 6. The bound was unsatisfiable: the generated buffer samples `u = x/size` for `x` in `[0, size)`, so the last texel sits at 0.984 and wraps to 0.0 across a one-texel gap — even a perfectly periodic function lands with a step there. A gate that no seamless sine can satisfy is a gate that reports the world is broken.

The correct question is whether the wrap is **distinguishable from the texture it is cut out of**, so the bound is the steepest *adjacent* step already inside the tile, in the same direction. That is what the table above measures, and it is the version that shipped.

`verify.mjs` adds a matching source claim (every `Math.sin` frequency in `makeShimmerTexture` is an integer) and a mutation that restores 2.3. Reverting the fix fails both:

```
pure:  the shimmer's sine frequencies are whole cycles, so the tile has no seam
world: the shimmer does not tile: wrapping its U axis steps 70/255 where the
       texture's own steepest step is 7/255, and its V axis steps 38/255
       against 20/255, so a scrolled RepeatWrapping map draws a hard seam
       once per tile
```

The world check also asserts the tile is **not flat** (crest-to-trough must exceed 40/255), because a texture of one value everywhere also has a zero wrap step — the other half of the same bound, and a canal with no variation along its length is a painted line.

## Finding 3: the constant's own comment asserted the property that was false

`CANAL_SHIMMER_TILES`' doc block in `344d38f` (`streetView.js:2017-2025`) is the most expensive line in the pass, because it is a *correct-looking proof of a false claim*:

> `update()` scrolls `offset.x` by `CANAL_SHIMMER_MPS * dt / (CANAL_LEN / CANAL_SHIMMER_TILES)`, so the metres-per-second on the constant really is metres per second on the ground and not tiles per second, which is the mistake that makes a "slow" scroll 7x too fast.

It reasons about *tiles per second* when the actual error was *the axis*, and it concludes the property holds. It did not. The same block also promised a tile "without a repeat a player can catch", which the shipped 2.3/4.1/1.7 frequencies could not deliver anyway — the repeat is the tile, whether or not anyone catches it.

This is a documentation defect rather than a behavioural one, and I found it only because Finding 1 made me read the block. It is recorded as a finding because it is the mechanism by which Finding 1 survived review by a human: a comment that argues the property is fine is indistinguishable, to a reader, from a comment that is fine. The block now states the axis requirement as a precondition, records the integer-cycle reason, and says plainly that the pattern does repeat and that this is a trade.

`makeShimmerTexture`'s own block was already corrected as part of Finding 2 — it was the only other place that named the frequencies.

## What the pass got right, and kept

I want to be specific, because the temptation after three findings is to treat the pass as weak. Most of it is genuinely well-gated, and I verified the gates by mutation rather than by reading them (below).

- **The puddle bands.** `PUDDLE_GUTTER_INSET` 0.70 < `PUDDLE_CANAL_SETBACK` 0.85 < `PUDDLE_CROSSING_OFFSET` 2.10 is asserted as an *ordering*, not as three separate ranges, which is what makes "a band that is merely re-widened" catchable. The gutter band is additionally measured against the **kerb face** rather than against the constant that placed it — the only free measurement, taken off the drawn frame.
- **The portal exclusion is *called*.** The pass-7 review's finding (a predicate that is only ever tested directly has no call site left to remove) is answered properly: a portal is planted on a real streak and a real puddle, the world is rebuilt, and the specific piece must be gone. Removing `if (!this._waterClear(x, z, copy)) continue` from `_addStreak` is caught.
- **The streak's eye arithmetic** is asserted in both directions — `peak < 150` so it cannot be found as the creature's eye, and `peak > 60` so a streak at luma 4 cannot pass as "a reflection". The bound is in `lumaOf(material.color) * STREAK_PEAK`, and the first version of that line divided an already-normalised colour by 255 a second time and read a peak of 4.0, which passed.
- **The canal's derived water lift** (`CANAL_LIP_H - CANAL_DEPTH`, not a third literal) means a later edit to either number cannot leave the water floating in or sunk through its own channel with nothing failing.
- **The canal is on the photographed corner.** `CANAL_NODE` is the §16.5 node *because* the whole gallery stands there — the first pass to act on pass 7's "the gallery photographs one corner of a 448 m world" review. It shows: the channel is 5.6-31.6 m directly ahead of the `street` camera, and in the re-captured `street.png` it is legible. Measured on the committed frame rather than eyeballed — the canal is a dark band spanning rows **386-404**, peaking at row **398**, where 39.9% of the width across x 150-1250 sits at least 18/255 below the road 14 px above and below. At row 398 it runs from **x 337 to x 882**, i.e. 546 px of a 1280 px frame, with the lit lips immediately above and below it. The orchestrator's note that no canal was visible in the earlier `street.png` was correct *for that frame*; the channel was always in shot, it is simply a mid-distance slot and not a foreground feature. (The two captures taken either side of the review's re-shoot are pixel-identical here — the row profile is the same to the decimal — which is the capture harness being deterministic, and is why these numbers are quotable at all.)
- **No seam survives into the frame.** Along row 398 across the canal's 546 px, the mean adjacent luma step is **1.58/255** and the largest is **32/255**. Seven tiles over 546 px would put a wrap edge every **78.0 px** at regular spacing. The eight largest steps instead fall at x 607, 624-628, 635, 644 — spacings of 17, 1, 1, 1, 1, 7, 9 px, all inside a single 37 px cluster where the lamp post stands. Irregular, and 78 px absent. This is a weaker check than the pixel-level one in `verify-world.mjs` and is offered only as the on-screen counterpart to it.

## Mutation coverage, run independently

I did not take the pass's twelve mutations on trust. I built a clean sandbox (`/tmp/mut`, real `node_modules`, symlinked gallery) and ran **45 mutations** — the pass's twelve plus 33 adversarial ones of my own, each applied to the real source and each requiring the suite to go red. `node tools/capture.mjs` was not involved; each mutation ran `verify.mjs` and `verify-world.mjs` against the mutated tree.

| group | attempted | caught | not applied |
| --- | --- | --- | --- |
| pass-8 authored (`p8`) | 12 | 11 | 1 |
| adversarial (`adv`) | 33 | 32 | 1 |
| **total** | **45** | **43** | **2** |

**Zero survived.** The two that did not apply reported `SKIPPED(0 sites)`: `p8 lit streak` and `adv halo drop (no darkening)`. In both cases my replacement text did not match the source as quoted, so nothing was mutated and the row proves nothing either way; I record them as unproven rather than counting them. (An earlier draft of this file claimed 47 mutations with both skips filed under "adversarial" — the harness log is 45 rows, 12 + 33, one skip in each group. The 47 was my arithmetic, not the harness's.)

All 32 adversarial mutations that applied were caught, including the ones aimed at the gaps this pass's own comments describe: gutter inset widened to 0.95 (the footway bug), streak inset made negative (the pavement bug), per-band room ordering inverted, halo smaller than its puddle, halo lifted above the water, canal water above its lips, lips with no height, canal moved out of its block, canal duplicated per node, shimmer frozen, shimmer 4x too fast, shimmer one tile, elongation 1 (a disc rather than an ellipse), segments raised without the budget moving, streak axis made constant (a comb), streak count driven by puddles, and the canal band placed at every node.

The two new mutations added by this review are **not** in that table — the 45-row sweep predates them. They are the `rotateY`-flattening and fractional-frequency mutations in `verify.mjs`'s water block, and they were verified the isolation way instead: each fix reverted on its own, both suites run, and the suite required to go red did. Each is caught by the specific claim it names, not by an unrelated predicate.

## Gates

| | before | after |
| --- | --- | --- |
| `npm run lint` | pass | pass |
| `npm run verify` (pure) | 225/225 | 225/225 (14 water claims, 14 mutations — was 12/12) |
| `npm run verify:world` | 77/77 | **77/77** |
| `npm run build` | pass | pass |
| captures | 14/14 | 14/14 |

**No gate was weakened, and no gate count moved.** Two new *measurements* were added inside the existing canal test — the U-axis/length one and the pixel tileability one — so the world suite reads 77 before and 77 after, and the `pass-8 canal:` line in its output now carries `tile wraps u6/8 v3/19 over 239/255 of crest-to-trough` where it previously reported only length, offset and tile count. The pure suite went 12 water claims to 14, each with a mutation.

## Known debt, left deliberately

- **The capture harness flaked once and the gallery was re-shot.** The first post-fix sweep returned `13 captured, 1 failed`: `hammer-awakening` died with `Execution context was destroyed, most likely because of a navigation` and a React `createRoot()`-on-an-existing-root console error, and its PNG was left deleted on disk — which correctly turned the pure suite's gallery check red (`224/225`, `hammer-awakening.png is missing`). That is the gate working. The view was re-shot clean on a retry and the whole 14-view sweep was then re-run end to end so that `benchmark/captures.json` and all 14 PNGs come from **one** run; the committed gallery is that sweep, not a merge of two. The flake is in the harness, not in the world, and I did not chase it — but it is the reason the review's own first `npm run check` after the fix was not green, and that is worth recording rather than quietly re-running until it was.
- **The shimmer now repeats every 3.71 m.** This is a real change in the look and the honest cost of tileability. It is below the resolution threshold at the distances the canal is read from, but it is a trade, not a free win, and it is stated as one in the source.
- **`verify-world.mjs`'s U-axis measurement assumes a four-corner plane.** A geometry with a different vertex layout would make the `partner` search find nothing and the check would report `neither`, which is a fail — safe, but it would be a confusing message rather than an accurate one.
- **The `street` view is the only one that photographs the canal well.** `CANAL_NODE` puts it on the corner six views stand on, and `street` is the best of them, but the others see it obliquely or not at all. A canal-legibility probe in the style of pass 7's `sightline()` would be the honest next gate; I did not add one because it is a new measurement surface rather than a fix to this pass.

## Reproducing

```sh
npm run check                       # lint + 225 pure + 77 world + build
npm run capture                     # 14 views, ~13 min
node /tmp/mut/run-mutations.mjs     # 45 mutations, both suites per mutation
```

The two defects are reproducible by reverting either fix in isolation, and I re-confirmed both after the documentation fix rather than trusting the earlier run. Each revert fails **both** suites on its own:

| reverted in isolation | pure | world |
| --- | --- | --- |
| `rotateY(Math.PI / 2)` on the `canalWater` pool's geometry | 223/225 | 76/77 |
| the three `Math.sin` frequencies in `makeShimmerTexture` | 223/225 | 76/77 |

The world failure messages are the ones quoted above, verbatim:

```
the canal's U axis follows the local X axis, and local X is the 1.1 m width,
so the shimmer scrolls across the channel instead of down it

the shimmer does not tile: wrapping its U axis steps 70/255 where the texture's
own steepest step is 7/255, and its V axis steps 38/255 against 20/255, so a
scrolled RepeatWrapping map draws a hard seam once per tile
```

Reverting *one* frequency rather than all three is also caught, and by the V axis alone (U still steps 6/255 against 8/255, which passes): `its V axis steps 45/255 against 20/255`. That is worth stating because it is the one case where the U measurement would have missed it.

