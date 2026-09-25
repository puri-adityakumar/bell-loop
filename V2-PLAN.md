# V2 implementation plan — THE LONG QUIET

Ordered slices for building v2 on `cline/space-bunny-alpha`, forked from
`main` at `3ccd9f89185200423ec62d5f794c6a7570067ce3`.

Design authority: [`GAMEDESIGN.md`](./GAMEDESIGN.md). Where this document and
the design disagree, the design wins and this document is the bug.

## Ground rules

- **Every slice ends with `npm run check` green.** No slice lands with a failing
  gate, even partially. A red branch makes every subsequent diagnosis harder.
- **Additive sequencing.** v2 lands as new modules. v1's `maze.js` and `loop.js`
  are not touched until slice 09, and the swap happens at one line in `App.jsx`.
  If v2 stalls, reverting is a one-line change and v1 is intact throughout.
- **Pure modules stay pure.** Anything imported by `verify.mjs` may not touch the
  DOM, Three.js, `window`, or a clock. This is the rule that makes the game
  verifiable at all, and it is the reason the whole creature AI is a pure module.
- **`verify.mjs` grows in the same slice as the code it tests.** A slice that
  adds a rule without adding its assertion is not finished.
- **`verify-world.mjs` is not in `npm run check` today, and does not currently
  pass on its own** — it exits 1 on an incomplete canvas stub. Slice 14 repairs
  and wires it in. Until then, expect it to fail, and do not treat that as
  something a slice broke.

## Gate vocabulary

Each slice below names the checks it must add and the gate it must pass.

- **pure** — assertions added to `verify.mjs` (node, headless, deterministic)
- **world** — assertions added to `verify-world.mjs` (stubbed DOM + renderer)
- **gate** — `npm run check` = `oxlint` → `node verify.mjs` → `vite build`

---

## Phase A — pure foundation (no visuals)

Everything in Phase A is node-testable and nothing renders. The game is not
playable at the end of Phase A, and that is correct: it means the entire rules
surface is proven before a single triangle exists.

### Slice 01 — random-access PRNG

**Goal.** `src/game/hash.js`: `hash32(seed, cx, cz)` and `mulberry32`. The
foundation for everything in §3.2.

**Checks (pure).** `hash32` is deterministic and well-distributed; the same
`(seed, cx, cz)` always yields the same stream; different coordinates yield
different streams; no correlation between adjacent `cx` values (adjacency
clustering is the classic failure mode of naive hash mixes and it would show up
as visibly repeating streets).

**Gate.** `npm run check`.

### Slice 02 — chunks, wrap, street graph

**Goal.** `src/game/neighborhood.js`: `chunkAt`, `resolveChunk`, the street
graph, BFS helpers, connectivity.

**Checks (pure).** Same `(seed, cx, cz)` → identical `signature`; **generation
order does not matter** (generate chunks shuffled, compare all signatures);
out-of-range coordinates still generate deterministically, proving the generator
does not secretly depend on wrap state; the street graph is connected **across
the wrap seam** in all four directions — the wrap's specific bug class, invisible
in a browser and trivial in node.

**Gate.** `npm run check`.

### Slice 03 — districts and objective anchors

**Goal.** Anchor placement for three portals, the hammer and the exit.

**Checks (pure).** One objective per district for the four district objectives;
every anchor on a lot cell and never a street cell; graph distance from spawn
within `[MIN_OBJECTIVE_DISTANCE, pool ceiling]`; hammer at least
`MIN_OBJECTIVE_DISTANCE` from every portal; exit at the maximum-distance block;
**hammer anchor signature byte-identical across loops 1..8** (it is a fixed point
of the run, not a fixture — this is the assertion that makes dying unable to
erase the goal); all five anchors mutually BFS-reachable from spawn.

**Gate.** `npm run check`.

### Slice 04 — fixtures and the four rules

**Goal.** The per-loop fixture pass: structural and decorative classes, keyed
`hash32(seed ^ loopSalt(loop), cx, cz)`.

**Checks (pure).** Deterministic per `(seed, loop, cx, cz)`; **no fixture ever
occupies a street cell**; no fixture on any reserved anchor or inside the spawn
clearance; no fixture blocks a portal approach (BFS from the street to the portal
anchor survives fixture placement for every anchor on every loop 1..8);
structural and decorative fixtures stay in their own classes; different loops
actually produce different layouts, and adjacent loops do not produce identical
ones (a fixture pass that never changes is a silent failure).

**Gate.** `npm run check`.

### Slice 05 — the rules module

**Goal.** `src/game/rules.js`: the portal hold verb, breath, the persistence
table, the finale flag, `isInsideExit`.

**Checks (pure).** Portal: no sound below the midpoint, sound above, exact clamp
at 1.0, decay on release, no double-completion on a dead portal, permanence
across a simulated reset. Breath: monotonic drain, recovery, **hysteresis** —
lockout persists until breath crosses the recovery threshold and a value oscillating
around zero does not permit sprint-bobbing. Persistence: every row of the §9.1
table survives a capture; every reset-column value does change. `isInsideExit`
mirrors the v1 `isInsideChamber` test including the negative cases.

**Gate.** `npm run check`.

### Slice 06 — creature awareness and state machine

**Goal.** `src/game/creature.js`: the §6.1 state machine, awareness integration,
the §6.2 sound table, line-of-sight.

**Checks (pure).** Sound fills the meter faster than sight by the documented
ratio; thresholds transition at 0.4 and 1.0; the meter decays when no stimulus
arrives and is **held** by sight; the meter clamps to `[0, 1]` and cannot exceed
1.0 from a single event; the sound-radius table matches the §6.2 constants;
`TELEGRAPH` has no capture path; **scripted-run** — a fixed event sequence
produces a byte-identical awareness trace on replay.

**Gate.** `npm run check`.

### Slice 07 — pathing and the two ladders

**Goal.** Street-graph pathing, `banishDuration`, `aggressionAt`, the
re-emergence rule, `CHASE_MAX_SECONDS` phase-out.

**Checks (pure).** `banishDuration` is monotonically non-decreasing and respects
the §7.4 table including the cap. `aggressionAt` is strictly increasing in
re-emergence count. A chase past `CHASE_MAX_SECONDS` transitions to phase-out.
A banish does **not** advance the capture counter. **The §11.3 balance assertion
in its pure form**: sampled across the run, expected creature-on-field time
trends down while threat per encounter trends up.

**Gate.** `npm run check`.


---

## Phase B — integration

The game becomes playable here. Slices 09 and 10 are the risky ones: 09 is the
point of no return for the branch, and 10 changes the gate itself.

### Slice 08 — player: breath and two verbs

**Goal.** Extend `src/game/player.js` with breath, sprint lockout, the
exhausted-breathing sound event, and distinct `E` (interact) and `LMB` (swing)
bindings. Movement, collision and camera behaviour are otherwise untouched.

**Checks (pure).** Breath integration is driven entirely by `breathStep` from
slice 05 — no duplicated constants in `player.js`. Sprint lockout cannot be
bypassed by holding the key. Standing still emits no footstep sound event.

**Gate.** `npm run check`, plus `node verify-world.mjs` by hand.

### Slice 09 — the swap

**Goal.** `src/game/streetView.js` renders chunks, fixtures, portals, the hammer
and the exit car, and rebuilds the collider set on reset. `src/game/world.js`
adopts the v2 simulation. `App.jsx` changes at exactly one line.

**This is the point of no return.** Before it, reverting is a one-line change and
v1 is untouched. After it, v1's `maze.js` and `loop.js` are dead code that
should be deleted in slice 16.

**Checks (world).** The game constructs and renders; chunk streaming produces
geometry in shuffled order identical to in-order; the collider set is correct
after a fixture permutation; the player spawns clear of every fixture; walking
into a hedge and a car both collide; the first-person controller behaves
identically to v1 when `enabled`.

**Gate.** `npm run check`, plus `node verify-world.mjs` by hand. **Manual:** load
the page and confirm the street renders, the wrap is seamless in all four
directions, and Act I is walkable with no creature present.

### Slice 10 — creature view and the capture loop

**Goal.** `src/game/creatureView.js` plus the full Act I → Act II →
capture → reset cycle.

**Checks (world).** The awakening toll transitions `TELEGRAPH` → `STALK` on
hammer pickup and not before. A capture in Act II resets the player to spawn,
restores fixtures, and leaves portals, hammer and counters untouched. Re-emergence
places the creature at a minimum graph distance from the player and **never in
line of sight**. A `CHASE` past `CHASE_MAX_SECONDS` phase-outs. A banish removes
the creature for the documented duration and re-emergence is angrier.
`dispose()` still tears everything down without throwing.

**Gate.** `npm run check`, plus `node verify-world.mjs` by hand. **Manual:** play
one full capture → reset cycle.

### Slice 11 — audio

**Goal.** Extend `AudioManager`: the three bell tunings, the gated footstep set,
breathing, creature breath, portal hum, the shutdown event, and the capture
reset sting.

**Checks (world).** The awakening toll fires exactly once on pickup and never
again. The banish toll fires only on a connected swing. Sound events carry the
documented radii and are emitted only by the player actions that should cause
them. The reset sting is a toll, not a fade cue.

**Gate.** `npm run check`.

### Slice 12 — HUD and accessibility

**Goal.** Portal sigils, the hammer sigil, the radial hold ring with a midpoint
tick, the awareness vignette and grain tells, the breath vignette, pause,
greyscale-legible sigil states, rate-limited finale effects, reduced-motion
toggle.

**Checks (world).** Sigil state tracks portal state through a reset. The progress
ring reaches exactly 1.0 and emits its sound event only past the midpoint tick.
Pause freezes the creature as well as the player. Reduced motion suppresses head
bob, camera shake and finale screen effects.

**Gate.** `npm run check`.

### Slice 13 — the finale and the win

**Goal.** Third portal → `finale: true`, enrage, headlights, `isInsideExit`,
win overlay.

**Checks (world).** The finale triggers on the third and only the third portal.
The creature reaches `ENRAGED` and ignores the banish ladder. Headlights come on
and are visible through fog. Walking into the exit sets `PHASE.WON`, plays the
win sting and freezes the simulation. `BEGIN AGAIN` returns to loop 1 with
portals, hammer and counters wiped — the one place a full wipe is correct.

**Gate.** `npm run check`.


---

## Phase C — gate, balance, publish

### Slice 14 — close the gate hole

**Goal.** Repair `verify-world.mjs`, then wire it into `npm run check`.

This slice has two halves, and the first was found by running it.

**Half one — the harness is broken.** `node verify-world.mjs` exits 1 at the base
commit: `TypeError: ctx.beginPath is not a function`, thrown from
`makeCobbleTexture` (`src/game/world.js:182`). The 2D canvas stub at
`verify-world.mjs:18` implements only `createImageData`, `putImageData`,
`fillRect`, `globalAlpha` and `fillStyle`, while all six procedural texture
functions draw through `beginPath`, `ellipse`, `fill`, `stroke`, `moveTo`,
`lineTo` and friends. It has rotted silently because nothing runs it.

Extend the stub to cover the canvas 2D surface the world actually uses. It stays a
stub — it renders nothing — it just stops throwing.

**Half two — make it required.** Only once it passes on its own.

v2's logic is integration-heavy enough that leaving this unrun is a real hole,
and the balance simulation in slice 15 lives in this file.

**Checks.** `npm run check` runs and fails on a deliberately broken world
assertion. If the combined gate proves too slow for iteration, it becomes a
separate required CI step — but it must be required, and it must pass before it
is required.

**Gate.** `npm run check`, plus a deliberate-failure test of the gate itself.

### Slice 15 — the balance simulation

**Goal.** The §11.3 centerpiece: headless encounter simulation in
`verify-world.mjs` that plays hundreds of runs — creature at tier `N`, player
sprinting or walking, `M` portals down, hammer held or not — and asserts the two
trends numerically.

This is the highest-value single piece of infrastructure in the build. It is what
makes a tuning pass possible at all in a project that cannot be playtested.

**Checks (world).** A competent player wins; a careless player loses; neither
outcome is degenerate across seeds 1..8. Both §11.3 trends hold. The Act I
configuration is losing-by-construction impossible — the player cannot be caught
before the hammer.

**Gate.** `npm run check`. **Tuning pass:** this slice is expected to change
constants, and that is the slice's purpose.

### Slice 16 — captures, cleanup, result card

**Goal.** The twelve captures in §16.5 plus responsive and pause states. Delete
v1's `maze.js` and `loop.js` and their now-dead tests. Replace the root `README.md`
with `benchmark/templates/result-readme.md`, recording the base commit, model
metadata, token accounting, pass count, pure and world check counts, build status,
and known debt.

**Gate.** `npm run check` green **with v1 deleted** — the deletion is the last
thing that can be reverted, so it happens only after everything above is proven.

---

## Slice summary

| # | Slice | Adds | Gate |
| --- | --- | --- | --- |
| 01 | random-access PRNG | `hash.js` | pure |
| 02 | chunks, wrap, street graph | `neighborhood.js` | pure |
| 03 | districts and anchors | `neighborhood.js` | pure |
| 04 | fixtures and the four rules | `neighborhood.js` | pure |
| 05 | portal verb, breath, persistence | `rules.js` | pure |
| 06 | awareness and state machine | `creature.js` | pure |
| 07 | pathing and the two ladders | `creature.js` | pure |
| 08 | player breath and two verbs | `player.js` | pure + world |
| 09 | **the swap** | `streetView.js`, `world.js` | pure + world |
| 10 | creature view, capture loop | `creatureView.js` | pure + world |
| 11 | audio | `audio.js` | pure + world |
| 12 | HUD and accessibility | `src/ui/*` | pure + world |
| 13 | finale and win | `rules.js`, `world.js` | pure + world |
| 14 | **repair and require the world harness** | `verify-world.mjs`, `package.json` | gate |
| 15 | **balance simulation** | `verify-world.mjs` | world |
| 16 | captures, cleanup, result card | `README.md` | full |

Slices 09 and 15 are the two that matter. 09 is irreversible; 15 is the only
thing standing between this design and a game nobody can tune.

---

## Definition of done

- `npm run check` exits 0, including the world harness
- all sixteen slices closed
- twelve captures plus responsive and pause states
- v1 deleted, result README written from the template
- `base_commit: 3ccd9f89185200423ec62d5f794c6a7570067ce3` recorded
- still on `cline/space-bunny-alpha`; **nothing merged to `main`, nothing
  deployed** until the checkpoint question is reopened

