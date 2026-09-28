# REVIEW — iteration 2, pass 17

- **Commit under review:** `e476ee9` — "iter2(17): performance + draw calls - budget check, merging where cheap".
- **Reviewer verdict:** **FIXED — the optimisation is real and the two halves of it are well made, but the pass's headline sentence about the horizon was FALSE, and it was false in a way the gate was built to prevent. Three docblocks in three files described code that does not do what they say. And a fourth defect, found by mutation rather than by reading, is the serious one: the instrument whose numbers §10 quotes — `tools/perf-census.mjs` — had no gate on it whatsoever, and the two mutations I aimed at it both came back green.**
- **Gate at verdict time:** 305/306 pure → **306/306 pure** (+1 check; see the honesty note on the count below), **112/112 world** (unchanged), `npm run check` exit 0.

> **Honesty note on the count.** The net is 305 → 306, which understates this review. What actually happened: the pass's suite was 306 with **one check failing** on the committed tree, and that failing check is the new one. So the committed state was 305/306, this review fixed the prose it was complaining about and added the census gate *inside* the same test rather than as a new one, and the count moved by one. The arithmetic is 306 → 306 → 306 and the honest description of it is "a new check that fails on the commit it reviews, and two mutations that were green until now."

## Verdict on each claim I was asked to check

| Claim | Verdict | Evidence |
|---|---|---|
| Draw calls 111 → 70 idle | **CONFIRMED structurally; the live number is re-measurable but not re-runnable here** | The ring's forty-two `THREE.Mesh` objects are now one `InstancedMesh` over a shared unit box. Gate: `verify.mjs` asserts one `InstancedMesh`, a shared `BoxGeometry(1,1,1)`, `instanceMatrix.needsUpdate`, and that no per-part geometry cache survives — with six sky-side mutations, every one caught. |
| 140 → 99 busy, 294 140/400 000 triangles, 19/48 programs, `update()` 0.1 ms p50 | **NOT RE-RUNNABLE HERE, and the pass is right to say so** | The live half needs Chrome + WebGL; this harness has neither. `tools/capture.mjs --budget` is a MODE, and `verify.mjs` holds the budget's *properties* statically instead. That is the correct split and I have no complaint about it. |
| 415 allocations a frame removed | **CONFIRMED as a census of the code; the min-of-N figure is the one I trust most** | The per-site table in §10 reads as honest — it separates the 90 redundant `needsUpdate` writes as *not* allocations and marks them 0 rather than folding them into the total, and the `world.js::_audioFrame` and `frustumCulled` rows are argued for rather than quietly skipped. |
| The horizon substitution is "bit-identical" / "the same box to the last bit" | **FALSE. Retracted and corrected.** | The identity rested on `qw * (w/qw) === w`, which is false in IEEE-754. Measured over the shipped shape tables: **the identity fails on 375 of 10 752 axes** (3.5%), and 847 of those axes move a world half-extent at all. See Finding 1. |
| The three docblocks | **All three were false. All three corrected.** | `rules.js` orphaned docblock, `lampsNear`'s "squared" claim, `skyView.js`'s "last bit" claim. See Findings 2–4. |
| The budget is six ceilings that can each fail | **TRUE for the page, FALSE for the standalone tool** | 23 mutations, all caught — after this review added four of them, because two of mine survived first. See Finding 5. |
## Finding 1 (the headline): the "bit-identical" claim was false, and the picture did not move

Pass 17 replaced forty-two `BoxGeometry(qw, qh, 0.6)` meshes with one `InstancedMesh` over a `BoxGeometry(1, 1, 1)`, and wrote the justification as an identity: since the old code built a box of width `qw` and scaled the *mesh* by `w/qw`, and `qw * (w/qw) === w`, the unit box scaled by `w` is the same box. It said "bit-identical" in `AESTHETIC-NOTES.md` §10, "the same box to the last bit" in the `_buildHorizon` header, and "an unchanged 542 triangles" in the checklist.

**Two things are wrong there and one thing is right.**

1. **The identity is false.** `qw * (w/qw) === w` does not hold in IEEE-754 for 375 of 10 752 axes drawn from the file's own shape tables — 3.5% of the input domain. A comment that cites a false identity cannot be trusted, and a reader who checked would have found it.
2. **The instanced path adds a rounding the cached one did not have.** `InstancedMesh.instanceMatrix` is a `Float32Array`; the old `mesh.scale` rode a float64 `Matrix4`. So even where the identity happened to hold, the two paths do not produce identical bits. 847 axes move a world half-extent.
3. **The picture did not move.** The worst residual is **1.15 × 10⁻⁷ relative** — about five millionths of a pixel at 232 m. The substitution is a *correct* optimisation; only the sentence was wrong.

**Fixed** in three files: `skyView.js`'s header, `AESTHETIC-NOTES.md` §10, and the checklist row now say "the same box to within float32 quantisation" and attribute the rounding to the `Float32Array` rather than to an identity that does not exist.

**Gated** by a new check that is a MEASUREMENT wherever a measurement is possible, because a numeric predicate cannot read prose and this defect *was* prose:

- it re-derives the old and new half-extents over the shipped tables and asserts `identityFailures > 0` (the identity is still false — a future change that made it true should let the comments say so plainly rather than keep hedging) **and** `halfExtentFailures > 0` (the rounding is real) **and** `worstRelative < 1e-6` (and it is a rounding, not a regression). All three, because a review that corrected a claim in one direction can over-correct in the other and start calling a substitution that is exact to 8 significant figures "approximate".
- it then asserts the prose: `same box to the last bit` and `bit-identical 542` must not appear in `skyView.js`, §10, or the checklist. A floor, not a ban — a future pass that finds a genuinely exact formulation may delete those two lines.

This check is why the committed tree was **305/306**: it fires on the committed `ITERATION-2-CHECKLIST.md`, which still said "bit-identical 542". The fix and the failure are the same event.
## Findings 2–4: three docblocks that lied about the code

Each is a comment asserting something the code beside it does not do. They are grouped because the finding is the grouping — this is what a "doc comments match reality" pass looks like when it is done by reading the comment rather than the code.

**2. `src/game/rules.js` — an orphaned docblock.** A `/** … */` block sat detached above an unrelated declaration, documenting a function that was not the one immediately under it. A docblock that is not attached to its subject is worse than no docblock: it looks like documentation and is read as documentation. Reattached to the function it describes.

**3. `src/game/streetView.js` — `lampsNear` claims a squared-distance comparison and calls `Math.hypot`.** The comment said the hot loop avoided a square root by comparing squared distances; the code calls `Math.hypot` and the comment two lines below *argues at length for why `hypot` is the right choice* — correctly, since §10 explains the sort is stable and the light pool is aimed from `lamps[0]`, so a one-ULP change to `distance` can flip a tie and move a light. So the reasoning was right and the summary of the mechanism was wrong. Corrected to describe the `hypot` it actually calls.

**4. `src/game/skyView.js` — "the last bit".** Covered in Finding 1; listed separately because it is the same *class* as 2 and 3: a confident, specific, checkable-sounding sentence that is false.

I found these by reading each docblock against its code, not by pattern-matching for hedge words. Two of the three would pass any lint rule in this repository.

## Finding 5 (the serious one): the census tool had no gate, and two mutations survived it

I ran three ceiling mutations against the committed pass in a clean worktree, aimed at the census arithmetic rather than at the ring. **Two of the three came back green.**

| # | Mutation | Result on the committed pass |
|---|---|---|
| **M4** | `tools/perf-census.mjs`: `geometries.add(geometry.uuid)` → `geometry.type` | **SURVIVED — 306/306 green** |
| **M5** | `tools/perf-census.mjs`: `triangles += per * count` → `triangles += per` | **SURVIVED — 306/306 green** |
| **M10** | `src/game/capture.js`: two `BUDGET_POSES` share an `id` | caught by "the budget is six ceilings…" |

**Why this matters more than the two rows suggest.** Pass 17 quoted the tool's output in `AESTHETIC-NOTES.md` §10: 184 objects at `e476ee9^`, the 5.8x triangle and 4x instance ratios, the share of triangles by object, the "three-quarters spent" reading. `verify.mjs` checked the census the *page* runs — clause 8 asserts `isInstancedMesh ? object.count : 1` and the culling census in `capture/main.jsx`. **The identical arithmetic written a second time in `tools/perf-census.mjs` was asserted by nothing at all.**

M5 is not a rounding error. `triangles += per` reports the frame as roughly its 62-mesh value instead of 294 140 — a number four times too small — and §10's central conclusion ("the triangle half said it was three-quarters spent") is computed from exactly that line. The pass would have shipped that number with a green suite behind it.

## On the allocation census

§10's table is the part of this pass I trust most, and the reason is that it argues rather than tallies. Three rows are doing work a table of numbers usually does not:

- the **90 redundant `needsUpdate` writes are marked "not allocations" and scored 0**, instead of being folded into the 415. Folding them would have made a better headline.
- `Math.hypot` in `lampsNear` is **left in place with a measured justification** (over 16 000 queries the two forms agree on the lamp set and differ by one ULP; the sort is stable and the light is aimed from `lamps[0]`, so paying a rounding difference on the path that aims a light is the wrong trade for a call costing nanoseconds against a 16.7 ms frame). It also records that the gate which appeared to catch this was a two-core load artifact — a review's own false positive, kept in writing so the next reviewer does not re-derive it.
- `frustumCulled = false` on all 62 pools is left alone **with the reason**: `InstancedMesh` culls all-or-nothing over the whole buffer, and with three wrapped copies spanning 1 344 m the camera is essentially always inside them, so turning it on would cull nothing.

The min-of-N heap reading is also the right call: an allocation number from `performance.memory` is a distribution, and reporting a p50 of it as "the" number would be the same overstatement as "bit-identical", one layer down. I did not re-run it (no browser here) and I am not able to confirm the 415 figure by independent measurement — I am confirming that the *census is honest about what it counted*, which is a different and weaker claim, and I am labelling it as such rather than letting the table imply I measured what I did not.

## What I did not check, and why

- **The live budget numbers** (`--budget`: 70/99 calls, 294 140 triangles, 19 programs, 0.1 ms p50) need a real WebGL context. This harness has SwiftShader at best. I verified the *properties* that would have to break for those numbers to move, which is what the pass claimed, and I am not restating the numbers as confirmed.
- **60 FPS headroom on integrated GPU class** is not established by anything in this pass and is not claimed to be. The gate budgets `update()` and explicitly refuses to gate `renderMs`, with the reasoning in the page header. That is the right call and I endorse it: a software rasteriser's frame time says nothing about the target machine.
- **The captures.** This pass adds no pixels by design, so §16.5's luma gate has nothing new to justify and I did not re-run it. Correct, and stated.

## Standing debt for pass 19

1. **`tools/perf-census.mjs` and `capture/main.jsx` hold the same census in two files.** Clause 8b now gates both, which closes the hole but does not remove the duplication. The honest fix is one shared module; that is a structural change and out of scope for a review.
2. **Three docblocks lied and no lint rule here can see it.** There is no gate in this repository that compares a comment to its code. The three I found were found by reading. A pass that greps for hedge words would find none of them, because all three were *confident*.
3. **The identity gate is scoped to this substitution.** It recomputes the old and new half-extents from the shape tables as they are today. A change to the quantisation step, the ring's depth, or the tables' shape would need it re-measured — it is a measurement of one claim, not a general float32 property.

## Gate at verdict

```
node verify.mjs        306/306 checks passed — all green
node verify-world.mjs  112/112 world checks passed
npm run check          exit 0
```

**Verdict: FIXED.** The optimisation is correct and the allocation work is honest. The pass's one load-bearing sentence about it was false, the sentence has been replaced with a measured one, and the gate that would have caught it is now a gate that measures instead of asserting. The census tool's missing gate is the more consequential finding, and it is closed.

**Fixed** by adding clause 8b to the existing budget-harness check: four claims on the tool's own arithmetic — distinct geometries by `uuid`, triangles per instance in the total, triangles per instance in the breakdown, and the `InstancedMesh` expansion. Note the third: `row.triangles` and `triangles` are separate accumulations feeding different columns, and the "where the triangles are" breakdown is what a reader acts on, so a gate that covered only the total would have let the actionable number through.

**Gated**, because a clause with no mutation row is a clause nobody has tested: four rows added to the existing table (M4, M5, and the two cousins — the per-row attribution and the instance expansion). **23 mutations, every one caught.** All four external mutations now fail by name:

```
M4  → FAIL the budget harness measures a live frame…  + FAIL every budget claim can actually fail…
M5  → FAIL the budget harness measures a live frame…  + FAIL every budget claim can actually fail…
M10 → FAIL the budget is six ceilings, they are numbers, and the poses are the gallery own
```

**One thing I got wrong while fixing it, recorded because the mutation table caught it for me.** My first clause patterns were `/triangles \+= per \* count/` and `/row\.triangles \+= per \* count/`. The first matches *inside* the second, so the M5 mutation left the row clause satisfied and the mutation table reported green — a gate I had written to catch a surviving mutation was itself survivable. Both patterns are now anchored to line start and end (`/^ {4}triangles \+= per \* count$/m`). The table refused to pass, which is the entire reason it exists.





