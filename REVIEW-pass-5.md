# REVIEW — iteration 2, pass 5

- **Commit under review:** `bbd36c4` (wip) + `6e5ebee` (final) — "iter2(5): building depth: per-instance color fix, windows, doors, rooflines, entry lamps", plus the working tree.
- **Reviewer verdict:** **FIXED.** One real finding — a second, parallel set of windows and door lights that every pass-5 gate structurally could not see. The review fix retires the two legacy fixture kinds at the pool, adds one gate stated in the units that could have caught it, and recaptures the gallery 14/14.
- **Gate at verdict time:** 214/214 pure, 55/55 world, lint clean, build green, 14/14 captures.

## What the pass does

`6e5ebee` gave the houses depth: per-instance wall colour via `setColorAt`, a real
window stack (pane, extruded frame, sill, rare lit pane), a recessed door under a
canopy with steps, a roofline, and an entry lamp on the dimmest rung of T11's
emissive ladder. The build was sound — the per-instance colour fix is correct, the
window reveal has real depth behind it, the doors are recessed, the roofline reads.

The finding is not in what the pass built. It is in what the pass left running
underneath it.

## The finding: two fixture kinds that outlived the facade system

`neighborhood.js` emits decorative fixtures of nine kinds, two of which are
`window` and `porchLight`. Both predate the facade system and both were
superseded by it. They were still being emitted, still had pools, and were still
being drawn — as **132 always-lit window panels and 132 sodium porch lights**, on
top of the facade system's own glazing and door lighting.

Measured on the pre-review file at `6e5ebee`, by instrumenting the `verify-world`
harness:

```
PRE-REVIEW fixture pool used:
   window       132        <- unconditionally materials.windowLit  (confirmed: true)
   porchLight   132        <- unconditionally materials.sodium     (confirmed: true)
   stake        132
   ... 9 fixture pools, 1038 placed instances total
   windowLit pool count 111   entryLamps pool count 171
```

The damage is not that the windows looked duplicated. It is that the retired set
drew the **wrong rung of the ladder the pass had just written a document about**:

- **`window` fixtures are `windowLit`** — the brightest of the four rungs, applied
  unconditionally. So the pass's claim that a lit window is a rare event was false
  on screen: 132 of the world's 243 lit-window surfaces (111 from the facade
  system's rare `litIndex` choice, 132 legacy) were lit at a **100% rate**. More
  than half of every lit window on screen came from the path the pass did not own.
- **`porchLight` fixtures are `sodium`** — the lamp-*head* rung. So the pass's
  claim that the entry lamp is the lowest rung was false on screen too: 132
  fittings brighter than every one of the 171 entry lamps hung over the doors the
  pass had deliberately fitted with the dimmest light in the game.

Both claims were true of the constants and false of the render, and **all 268
checks stayed green** through the whole of pass 5.

### Why every existing gate missed it

This is the part worth keeping. The gates were not weak; they were aimed at the
wrong object.

- The **emissive-ladder gate** reads `PALETTE` — the tone constants. The ladder
  was correctly ordered, so it passed.
- The **lit-window-rate gate** counts `pools.windowLit` — the facade pool. The

## The fix: retire the kinds at the pool, not in the generator

`src/game/streetView.js` gains `RETIRED_FIXTURE_KINDS = ['window', 'porchLight']`,
and `_buildFixturePools` skips them. `_addFixture` already returned on a missing
pool, so a retired kind is dead by construction rather than by a branch that has
to be remembered. The now-dead special-case placement block in `_addFixture` — and
with it the per-lot map, the `chunkAt` call that filled it, and the `find` that
read it — are deleted; a fixture no longer needs to know which lot it is near.

**The kinds deliberately stay in `DECORATIVE_KINDS`.** `neighborhood.js` is the
pure module and its emitted set is part of the loop's determinism contract;
dropping two kinds from it would re-roll every fixture slot in the world and
change captures that have nothing to do with this. Retiring at the pool is also
where drawing actually happens, so a retired kind costs one array entry and draws
nothing.

### The counts, and the correction to them

The first pass of the fix documented the retirement as "132 of each kind" without
saying what unit that was, and a companion note put the total at 132 rather than
264. Both figures are now stated in the unit they are measured in, and both are
re-derivable:

| quantity | value | source |
| --- | --- | --- |
| canonical loop-1 slots, retired | **88** of **346** | `fixturePass(1337, 1)`, 44 + 44 |
| placed instances, retired | **264** of **1,038** | 88 × 3 `WRAP_COPIES` |
| `fixturePools[kind].used` at `6e5ebee` | **132** each | pre-review harness, confirmed |

**132 is loop-1 specific and is PLACED instances, not slots.** The underlying slot
count is 44 per kind; 44 × 3 wrap copies = 132. Across other loops the placed
count moves (117–144 for `window` over loops 1–5), which is exactly why the gate
below asserts *absence of the pool* rather than a count — a count would have to be
restated every time the density or the loop changed.

### No collateral damage

The retirement had to remove the legacy set and nothing else. Measured on both
files:

| | pre-review `6e5ebee` | post-fix |
| --- | --- | --- |
| `pools.windowLit` count | 111 | **111** |
| `pools.entryLamps` count | 171 | **171** |
| player colliders | 760 | **760** |
| fixture instances | 1,038 | **774** (−264) |
| total instances | — | 9,029 |
| pools (draw calls) | 33 | **31** (−2) |

The facade system's own lighting is bit-for-bit unchanged, so the fix cannot have
been satisfied by deleting the facade system — which is the failure mode the gate
has to rule out, and does.

## The gate

One check in `verify-world.mjs`, `the retired window and porchLight fixtures draw
nothing (pass 5 review)`, stated in the only units that could have caught the
original defect — **what the fixture pools actually hold**:

1. `fixturePools.window` is `undefined`;
2. `fixturePools.porchLight` is `undefined`;

## How the gate was validated

**Control.** Baseline, the predicate holds in **5/5** loop states (loops 1–5,
rebuilt through `applyLoop`, which is the reset/reshuffle path).

**Four mutations, each breaking the predicate in 5/5 states:**

| mutation | predicate | reported failure |
| --- | --- | --- |
| **M0** baseline | HOLDS 5/5 | — |
| **M1** drop the `RETIRED_FIXTURE_KINDS` skip, restoring both pools | BROKEN 5/5 | `pool window exists (used 132)`, `pool porchLight exists (used 132)` |
| **M2** point a live fixture pool at `windowLit` | BROKEN 5/5 | `cone on windowLit rung` |
| **M3a** force `isLit = false` in the facade window loop | BROKEN 5/5 | `facade placed no lit windows` |
| **M3b** delete the facade entry-lamp placement | BROKEN 5/5 | `facade placed no entry lamps` |

M2–M3b are the important half: they are what shows the gate is not merely
"the pools are gone", but that it also refuses a wrong-rung material and refuses
to be satisfied by deleting the facade lighting.

**A note on how these were run, because it changes the claim.** The mutations were
*not* run through the full 55-check suite. Restoring the legacy pools makes that
suite exceed the 4 GiB cgroup limit and get SIGKILLed (exit 137) — the suite runs
close enough to the ceiling that 264 extra instances tip it over. The predicate was
therefore evaluated in a **scoped** harness that builds one world and applies the
six assertions across the five loop states. Two consequences worth recording: the
mutation evidence is about the predicate, not about the other 54 checks; and
because stdout is block-buffered when redirected, a SIGKILL loses every buffered
`PASS` line, so the first OOM run reported `0` passes and looked like it had died
during world construction when it had not — a scoped probe showed the mutated world
builds cleanly at 33 pools and 132 + 132 instances with zero overflow.

## The gallery

Full recapture, **14 captured, 0 failed**, because removing 264 emissive instances
from the world changes every frame that contains a house wall.

| capture | lit% | mean | max | | capture | lit% | mean | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| title | 48.3 | 38.0 | 196 | | creature-chasing | 93.2 | 47.6 | 249 |
| street | 84.9 | 76.3 | 225 | | banish | 82.6 | 73.4 | 221 |
| hammer-located | 26.4 | 45.8 | 239 | | capture-reset | 83.7 | 75.9 | 221 |
| hammer-awakening | 21.2 | 43.5 | 236 | | finale-headlights | 94.6 | 42.2 | 245 |
| portal-located | 41.6 | 47.1 | 218 | | win | 9.9 | 15.7 | 196 |
| portal-shutdown | 88.4 | 33.2 | 189 | | responsive | 93.0 | 64.8 | 222 |
| creature-stalking | 30.7 | 44.6 | 253 | | pause | 68.0 | 46.0 | 196 |


## Performance

No per-frame cost was added, and the diff could not add one: all three edited
sites are **construction/reset-time only**.

- `_buildFixturePools` — constructor, `streetView.js:1458`
- `applyLoop` — constructor `:1462`, loop change `world.js:1742`, restart `world.js:2110`
- `_addFixture` — only from `applyLoop`, `:2749`

None is reachable from `StreetView.update(dt)` (`:3036`). The pass-5 work is
strictly *less* work than it was: **2 fewer draw calls** (33 → 31 pools) and **264
fewer instances** (1,038 → 774 fixture instances), at 9,029 total. `InstancePool`
was not modified; over-capacity writes are still counted rather than thrown, and
the retired kinds were well inside capacity (132 against 165), so this is a
removal rather than a reallocation.

## Residual risk

- **The gate reads pool occupancy, not pixels.** It proves the legacy set is not
  drawn; it does not prove the facade system's glazing looks right. That remains
  a `npm run capture` question, and is why the gallery was recaptured in full.
- **`RETIRED_FIXTURE_KINDS` must be kept in step with `DECORATIVE_KINDS`.** The
  kinds stay in the pure module on purpose, so a reader can reasonably ask why
  they are still emitted. The comment at the constant and the one at the pool
  creation both say so; the gate's (3)/(4) assertions are what make a forgotten
  entry fail loudly rather than silently.
- **Full-suite mutation runs exceed the 4 GiB cgroup.** This is pre-existing and
  not caused by the fix — the suite passes at 9,029 instances — but it does mean
  a future reviewer cannot mutation-test through `npm run check` on this machine
  and must scope the predicate as above.
- **`fixturePools.used` for a retired kind is now `undefined`, not `0`.** Any
  future code that walks `fixturePools` must handle absence rather than reading
  `.used`; `_addFixture` already returns on it, and this gate pins the contract.
- **`README.md`'s gallery prose is hand-maintained and still stale.** Carried
  forward from pass 1 and uncorrected by any gate.

## Verdict

**FIXED.** Pass 5 built a facade system and left the previous one running beside
it: 132 always-`windowLit` panels and 132 `sodium` porch lights, which made both
of the pass's headline lighting claims false on screen while all 268 checks stayed
green — the ladder gate read the tone constants and the lit-rate gate read the
facade pool, and neither could see a third path. Retiring the two kinds at the pool
removes exactly 264 instances and zero facade instances (`windowLit` 111 → 111,
`entryLamps` 171 → 171, colliders 760 → 760), keeps the generator's determinism
contract intact, and is guarded by a gate stated in the one unit that could have
caught it. That gate holds 5/5 at baseline and breaks 5/5 under all four
mutations, including the two that try to satisfy it by deleting the facade
lighting. Gallery recaptured 14/14, and the mis-stated "132 per kind" figure is
corrected to 88/346 canonical slots and 264/1,038 placed instances.

```
before:  214/214 pure, 54/54 world   (no gate could see the fixture pools)
after:   214/214 pure, 55/55 world   (one gate, in pool-occupancy units,
                                       control 5/5, four mutations 5/5)
```

`street.png` and `title.png` were inspected directly. Both read correctly: the
title keeps a near-black skyline over a warm foreground, and the street keeps
lit windows as a sparse accent against a graded wall rather than a field of them —
which is the specific thing the finding was about, and which the pre-fix frames
could not show.

3. no fixture pool draws on the `windowLit` rung;
4. no fixture pool draws on the `sodium` rung;
5. `pools.windowLit.mesh.count > 0` — the facade still lights its windows;
6. `pools.entryLamps.mesh.count > 0` — the facade still fits its lamps.

(3) and (4) are the negative form and are the ones with teeth going forward: they
hold for *any* fixture kind, so a **third** retired kind added later without being
listed in `RETIRED_FIXTURE_KINDS` still fails. (5) and (6) are the guard against
the cheap way to make (1)–(4) pass, which is deleting the facade system instead.

  facade's rare lit choice is real, so it passed.

The legacy kinds bypassed *both*, because they were placed through the **fixture
pool** path rather than the **facade** path. Nothing in the codebase asserted that
the fixture pools and the facade pools were drawing the same subject. The world
had two parallel sets of windows, and the contract that would have caught it did
not exist.
