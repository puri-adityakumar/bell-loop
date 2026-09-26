---
benchmark: bell-loop
result_id: cline/space-bunny-alpha
title: "THE LONG QUIET (provisional) — Bell Loop v2"
branch: cline/space-bunny-alpha
base_branch: main
base_commit: 3ccd9f89185200423ec62d5f794c6a7570067ce3
status: draft
phase: design
date: 2026-09-25
decisions_ratified: 13
supersedes: nothing — v1 remains the published checkpoint on main
---

# THE LONG QUIET — Bell Loop v2

Design document for a new game version built on `cline/space-bunny-alpha`.
v1 (`THE BELL LOOP`) remains the published checkpoint on `main`; nothing here
merges to `main` and nothing deploys until v2 passes its gate.

This is the Phase 1 output. Thirteen decisions were ratified in discussion;
every value below that is not marked `PROPOSED` was agreed.

---

## 0. Meta

| Field | Value |
| --- | --- |
| Branch | `cline/space-bunny-alpha` |
| Base commit | `3ccd9f89185200423ec62d5f794c6a7570067ce3` |
| Checkpoint status | experimental — deferred until the gate passes |
| Base commit rationale | this branch is a direct child of `main` at this SHA, so it is the exact v1 state v2 forks from |
| Published results | unaffected — `stealth/space-bunny` and Grok 4.7 are v1 and stay valid |
| Companion doc | [`V2-PLAN.md`](./V2-PLAN.md) — ordered implementation slices |

---

## 1. Premise

Dusk in a suburban neighborhood that repeats. Three glowing portals are open in
the streets, and something is walking them. You have a bell-hammer. Shut the
portals down and get out.

The v1 loop was a stick hitting a bell. v2 keeps the bell and replaces the
stick: the creature that used to be a timer is now a hunter, the failure state
is a chase instead of a screen fade, and the artifact that repels it is a
bronze-and-wood tuning hammer.

---

## 2. Pillars and non-goals

### Pillars

1. **The bell starts the hunt.** Picking up the hammer tolls once, and the toll
   is what wakes the creature. The loop's signature sound becomes the causal
   trigger for the antagonist. The creature is the bell's shadow, mechanically as
   well as thematically.
2. **Sound is the whole game.** Awareness is an audio mechanic, the objective is
   inherently loud, sprinting is loud, and the counter-play is silence. If the
   audio were removed the game would not be playable, which is the test of
   whether a design is actually committed to something.
3. **The hammer visibly wins.** The banish window escalates across a run while
   the creature escalates on a separate axis, so the run has an arc v1 never had.
   You can watch yourself get stronger.

### Non-goals

These are decisions, not omissions. Each is something a reader might reasonably
expect, and should be told is deliberately absent.

- **No timer.** v1's 60-second bell is gone. Nothing happens on a clock.
- **No death.** Being caught resets the loop. There is no fail state and no
  game-over screen. A run is a series of attempts inside one continuity.
- **No world-kills-you-by-attrition.** The map wraps, so the player can always
  walk away from anything forever. Only capture resets the loop. Running is
  always available; it is just loud, so it is never free.
- **No text in the play space.** The HUD stays text-free apart from the loop
  counter, inherited from v1.
- **No crouch.** Standing perfectly still is the stealth verb, and it costs
  nothing to learn. A crouch mode is a deferred slice (§16).
- **No awareness bar.** The player infers it. See §6 and §14.
- **One creature.** No variants, no second hunter, no escalation by count.

---

## 3. World layout

### 3.1 Topology

A finite grid of city blocks that wraps toroidally.

| Constant | Value | Note |
| --- | --- | --- |
| `GRID` | 7 × 7 blocks | 49 blocks, 4 districts (2 × 2 quadrants) |
| `BLOCK` | 64 m | **first constant to tune**; see below |
| World extent | 448 m × 448 m | wraps seamlessly on both axes |
| Sprint crossing time | ~75 s | full traverse at 6.0 m/s |
| Walk crossing time | ~124 s | full traverse at 3.6 m/s |

`BLOCK = 64 m` is deliberate. An earlier draft considered 48 m, which yields a
336 m map — 56 seconds to cross sprinting. That wears the map out in under a
minute and the endless illusion dies. 64 m reads as genuinely larger while
staying cheap enough for a single `InstancedMesh`. It is one exported constant
and the first thing to change if the scale feels wrong in play.

Because the grid wraps there is no edge, no boundary fog wall, and no "you have
reached the end of the map". That is the entire trick. See §4 for how the player
stays oriented without a minimap.

### 3.2 Random-access generation

The generator must be addressable by chunk coordinate, not a sequential stream.
This is the most important architectural decision in the document, and it is
what makes deferred streaming possible later.

**Why not a PRNG stream.** v1 uses `mulberry32(loopNumber)` and pulls values in
order. A chunk-addressed world cannot do that: chunk `(cx, cz)` must be
generatable *without* generating `(cx-1, cz)` first. Sequential streams
structurally cannot do random access. This is invisible until you try to stream,
which is exactly why it is settled now rather than later.

```js
hash32(seed, cx, cz)          // 32-bit avalanche mix
mulberry32(hash32(...))       // an independent stream per chunk
chunkAt(seed, cx, cz)         // → { streets, lots, props, signature }
```

Every chunk owns a private stream. Nothing is shared between chunks, so
generation order cannot affect content — and `verify.mjs` can assert this by
generating chunks in a deliberately shuffled order and comparing signatures.

### 3.3 Wrap semantics

The wrap is a coordinate transform layered over the generator, not a special
case inside it:

```js
wrap(v, n)       = ((v % n) + n) % n
resolveChunk(x, z) = { cx: wrap(x, GRID), cz: wrap(z, GRID) }
```

When streaming arrives (§16), `resolveChunk` stops folding and nothing else
changes. That is the boundary this design is protecting.


### 3.4 Districts and objective placement

Four districts are the 2 × 2 quadrants of the 7 × 7 grid. Objective placement
reuses the fairness machinery v1 already uses for shrines, because it works:

- candidates ranked by **graph distance from spawn** in the final street graph
- a **floor** (`MIN_OBJECTIVE_DISTANCE`) so nothing lands on the doorstep
- a **ceiling pool** (the nearest N) so nothing is a trek across the whole map
- **one objective per district**, giving the player a real spatial plan rather
  than a haystack to search

| Objective | Placement |
| --- | --- |
| Portals 1–3 | one each in three districts |
| Hammer | the fourth district |
| Exit | **not district-allocated** — the block of maximum graph distance from spawn |

The exit is the deliberate exception: the way out is always the far side of
somewhere you have barely been, which is both thematically right and the reason
the finale is a destination rather than a random walk.

### 3.5 Streets and lots

- **Streets** form a graph on block boundaries — road surface, kerbs, sidewalks.
  Street cells are the creature's navigation graph and are never obstructed.
- **Lots** are the interiors: front yards, driveways, porches, garages, sheds.
  All four objectives live on lots, never in the street, so the player can
  always see the road they need to reach in order to reach them.
- Houses sit behind hedges or fences, giving every block a soft edge and giving
  the sightline system something to occlude against.

### 3.6 Prop grammar and fixtures

Props split into two classes, because they have different costs and different
failure modes.

| Class | Examples | Collision | Per-loop churn |
| --- | --- | --- | --- |
| **Structural** | hedges, parked cars, bins, fences, garden sheds | yes — collider set rebuilds at reset | yes |
| **Decorative** | lit windows, porch lights, garden stakes, road cones | no | yes |

Permutable collision is a real bug source, so the fixture pass is constrained by
four rules. Each one is a named assertion in `verify.mjs`:

1. **Street cells are never fixtures.** Props anchor to lot and driveway anchor
   points only, so no respawn can break street-graph connectivity. This is the
   direct successor to v1's "wall segments exactly cover every closed edge"
   invariant.
2. **Reserved anchors stay clear.** Every portal anchor, the hammer anchor, the
   exit anchor and the spawn clearance zone are excluded from the fixture pool.
   Direct successor to v1's `LANDMARK_CLEARANCE = 2`.
3. **No fixture may block a portal approach.** A car across the mouth of a portal
   is an unwinnable state, and it is precisely the kind of bug that is invisible
   in a browser and one line of BFS in node.
4. **Fixtures never spawn on the player.** The player is returned to spawn on
   reset, and spawn is cleared by rule 2.

Fixtures are keyed `hash32(seed ^ loopSalt(loopNumber), cx, cz)` — per-chunk and
per-loop random access, same generator, no global state. Rebuilding instance
matrices is a discrete event at reset rather than a per-frame cost, so v1's
existing reset path absorbs it without modification.

### 3.7 Dusk

Dusk is a continuous value driven by **portals shut**, never by captures. Keying
it to the loop would darken the world every time the player died, which is a
death spiral: dying makes the game harder to see. Progress drives light; pressure
drives darkness only in the finale (§10).


---

## 4. Navigation without a minimap

The world is 448 m of repeating streets with no map, no compass, no markers and
no text. Three mechanisms carry all orientation, in order of strength:

1. **The exit car's headlights.** The exit is physically present from Act I —
   parked, dark, unremarkable — and its headlights come on when the finale
   triggers (§10). It is the only navigational beacon in the game, and it is
   visible through fog at distance. This is what turns the finale from a random
   search into a destination.
2. **Portal glow.** Each open portal emits a coloured light visible from
   distance and through gaps between houses. A player who has seen a portal once
   can steer back toward it. This is a *memory* aid, not a tracker: it rewards
   having looked, and does nothing for a player who never did.
3. **Dusk as a clock.** The sky's colour and fog density track portals shut
   (§3.7), so the player always knows how far through the run they are without
   reading a number.

The repeating-grid structure is a fourth, quieter signal: blocks are near-identical
by design, so a player who notices one distinctive prop — a specific car colour,
one porch light — can re-find that block later. That is the backrooms instinct,
and it is deliberately the weakest and most rewarding of the four.

---

## 5. Portals

### 5.1 What they are

Three glowing portals, one per district (§3.4), each in a different kind of
liminal structure — a shed, a bus shelter, a phone box. Shut all three down to
trigger the finale.

### 5.2 The verb

Hold to shut. Progress fills over `PORTAL_SHUT_SECONDS`; the shutdown only
becomes audible at the halfway mark.

This is the central decision of the interaction, and the noise threshold is the
whole point. A creature arriving in the first half means you can release and
abort with zero penalty and nothing having happened. A creature arriving in the
second half means you are committed for roughly another half-second. The player
is choosing, every time, *which half they are in when it shows up* — which
converts an interaction into a decision under pressure.

Two mechanics fall out of it:

- **Progress decays on release**, and sound is emitted only while held *and* past
  the threshold. There is no penalty for aborting, but you cannot stall by letting
  go — the noise already happened while you were past halfway.
- **Two verbs, two keys.** `E` interacts (portal shutdown, hammer pickup);
  **LMB** swings the hammer. One key cannot be both, because the worst possible
  moment to attempt a banish is while already committed to a portal shutdown.

### 5.3 Persistence

A shut portal stays dead for the rest of the run, across every capture. This
directly inherits v1's `candles[id] = true` persistence, which is the single
most important rule in the original design: progress you have earned is never
taken back.

### 5.4 World reaction

Each portal shut advances the dusk one step (§3.7) and permanently darkens the
portal's own light — a visible, permanent record of progress on the HUD sigils
(§14) and in the world.


---

## 6. The creature

### 6.1 States

```
TELEGRAPH ──(hammer pickup toll)──▶ STALK ⇄ CHASE ──(banish)──▶ DORMANT
   Act I          Act II                                    re-emerge → STALK
                                          └──── 3rd portal ────▶ ENRAGED
```

- **TELEGRAPH** (Act I only). Cannot detect, cannot capture, cannot be banished.
  It appears at long range and is gone when you look back. It exists to make
  Act I frightening without ever making Act I unfair. Being physically unable to
  catch you is what stops the pre-hammer phase being an unwinnable state.
- **STALK**. Moves to the player's **last-heard position** and ranges around it.
  It does not beeline. A sound-hunter searches; committing to a position and
  checking the surrounding streets is both the correct behaviour and the most
  delicious failure mode available — the player hears it arrive at the wrong
  street.
- **CHASE**. Full knowledge of the player's position, direct approach at the
  tier's top speed. Triggered by the awareness meter reaching 1.0.
- **DORMANT**. Banished, or pre-awakening. Enters `STALK` on re-emergence at a
  minimum graph distance from the player and never in line of sight (§8).
- **ENRAGED**. The finale state (§10). Ignores the banish ladder.

### 6.2 Awareness

A meter in `[0, 1]`, not a boolean. It fills from stimuli and decays when none
arrive.

| Range | Behaviour |
| --- | --- |
| `0.0 – 0.4` | unaware — no tracking, wanders |
| `0.4 – 0.8` | investigates the last stimulus position |
| `1.0` | `CHASE` |

**Sound fills the meter roughly four to five times faster than sight.** Sight's
job is to *confirm and hold* — once it has seen the player, the meter stops
decaying — not to acquire. Sound acquires.

| Sound event | Radius |
| --- | --- |
| Walking | 9 m |
| Sprinting | 22 m |
| Portal shutdown (past threshold) | 25 m |
| Hammer toll (swing or pickup) | 30 m |
| Exhausted breathing | +6 m on top of the gait radius (§7.3) |

Standing perfectly still emits nothing, so *"kill your footsteps and let it lose
you"* is a real, learnable strategy — and it means no crouch mechanic is
required to have a stealth game.

The consequence that makes the whole thing work:

> **The thing you do to escape it is the loudest thing you can do.**

Panic-running is the only reliable way to break a chase, and sprinting has the
second-largest sound radius in the game. Fleeing does not solve anything; it
relocates the problem and tells the creature where it is.

### 6.3 Sight

An occlusion-aware cone, tested against house volumes, hedges and fog falloff.
Range scales with the aggression tier (§11). Sighting is what pins the meter
against decay, so breaking line of sight is a genuine tactic — but it is a
*tactical* one, because sound will reacquire you if you keep moving.

### 6.4 No awareness bar

The player is never shown the meter. It is inferred from:

- **audio** — breathing that grows louder and shallower with proximity, and
  changes character as awareness rises
- **the post-processing layer** — the existing `vignette` and `grain` overlays
  tighten and coarsen as it closes in

This preserves v1's text-free rule and keeps the dread intact. It is a genre
decision, not only a UI one; an explicit meter would convert this from a horror
game into a stealth game.

### 6.5 Pure module

The entire state machine, awareness integration, pathing and both difficulty
ladders live in `src/game/creature.js` with no Three.js and no DOM. This is what
makes it testable at all, and it is the reason a hunting AI is viable in a
project that cannot be playtested (§16).


---

## 7. The bell-hammer

### 7.1 Acquisition

The hammer sits at a fixed, deterministic anchor in the fourth district, placed
by the same fairness machinery as the portals (§3.4): ranked by graph distance
from spawn, with a floor, drawn from the nearest-N pool.

Three properties make it a real goal rather than a lucky corner:

- **at least `MIN_OBJECTIVE_DISTANCE` graph steps from every portal anchor** — the
  four objectives are four genuinely separate errands
- **never a street cell, never a fixture anchor, never inside a reserved
  clearance zone**
- **stable across loop numbers** — the anchor signature is byte-identical for
  loops 1..8. It is a fixed point of the run, not a fixture, and that stability
  is the entire reason dying cannot erase the goal.

### 7.2 The awakening toll

Picking up the hammer tolls once, at maximum radius, and `TELEGRAPH` becomes
`STALK`. This is the design's central move: it converts "you must find the hammer
first" from a cruel opening act into a clean two-act structure, and it makes the
bell — v1's signature sound — the causal trigger for v2's antagonist.

It also guarantees the creature never exists in a state where banishing is
impossible, so the "you can only flee until you find it" rule is never exercised
unfairly.

### 7.3 Breath, and why exhaustion is loud

Sprinting drains a breath meter and locks out until it recovers. The meter is
**never displayed**. Breathing audio and a pulsing vignette are the only readout.

Lockout uses **hysteresis** — it persists until breath crosses a recovery
threshold, not until it merely reaches zero. Without it you get sprint-bobbing at
0.01 breath forever, which reads acceptably in code and feels awful in play.

And then the synthesis that makes the system worth building:

> **Exhaustion makes you louder.**

Being out of breath raises your sound radius. The system punishes *the state you
are in when you get caught* rather than *the act of running*. You can still
panic-sprint; you simply pay for it in noise while already too tired to move
quietly. This welds stamina directly into the sound mechanic that everything else
is built on, and produces the exhausted, gasping-through-a-hedge moment the genre
is made of — without putting a bar on screen.

### 7.4 The swing, and the escalating banish

LMB swings the hammer within `BANISH_RANGE`. A connected swing is a **full
removal**, not a stagger: the creature is driven off entirely for a duration that
grows with each successive banish in the run.

| Banish `n` | 1 | 2 | 3 | 4 | 5 | 6+ |
| --- | --- | --- | --- | --- | --- | --- |
| `banishDuration(n)` (s) | 8 | 12 | 16 | 20 | 24 | 24 |

The counter **retains across the run**, not per encounter — that is what makes
the arc visible. The cap is deliberately low at 24 s, because a run-long ladder
plus the speed ramp would otherwise walk the game into triviality.

Every banish is paid for by the other axis: the creature re-emerges angrier
(§11). The two ladders are opposed on purpose. You are buying time, and the price
is that the thing returns faster, sooner, and more aware.

One design note on what was *dropped*: an earlier draft made the swing itself
raise the creature's awareness, as a cost. With a true escalating banish that is
incoherent — the creature is gone, so its awareness is moot. The toll was demoted
to pure feedback and identity. It is how you know you connected, and it is the
sound the game is named for.


---

## 8. Anti-frustration rules

These are explicit guarantees, each one a named check. They exist because a
stalking AI with no release valve is a game that is either trivially safe or
permanently lethal, and neither is a design.

1. **Act I cannot kill you.** `TELEGRAPH` has no capture path at all. The
   pre-hammer exploration is never at risk.
2. **A chase cannot last forever.** A `CHASE` exceeding `CHASE_MAX_SECONDS`
   (~12 s) makes the creature phase out and return to `DORMANT` elsewhere. This
   is the single most important rule in the section: it guarantees the player is
   never permanently cornered, and it is the pressure valve that makes an
   otherwise-fatal AI shippable.
3. **Re-emergence is never instant death.** The creature returns at a minimum
   graph distance from the player, never in line of sight.
4. **Aborting a portal costs nothing.** Releasing `E` decays progress and emits no
   further sound. There is no punishment for a failed attempt.
5. **Progress is never taken back.** Portals, the hammer, the banish counter and
   the loop counter all survive a capture. Only position and creature state reset.
6. **The world cannot be exhausted.** The map wraps, so no amount of running
   ends the run — and running is loud, so the player cannot simply outlast the
   creature either.
7. **Sound is always fair.** Every stimulus is emitted by a player action the
   player can see themselves making, except the creature's own proximity, which
   is telegraphed by breathing (§6.4).

---

## 9. Loop reset

The loop is now triggered by **capture only**. There is no timer and no bell on a
clock; the only bell in the game is the hammer, and it tolls for the player
rather than against them.

### 9.1 Persistence table

This table is the contract. It is the closest thing v2 has to v1's candle rule,
and it is the thing most likely to be broken by a careless refactor.

| Persists across a reset | Resets on capture |
| --- | --- |
| Shuttered portals (per portal) | Player position → spawn |
| Hammer held | Hammer anchor state → uncollected only if never collected |
| Banish counter | Creature state → `STALK` (or `DORMANT` in Act I) |
| Loop / capture counter | Re-emergence counter |
| Exit anchor and finale flag | Current sound events |
| Learned layout (player knowledge) | Dusk → unchanged; it tracks portals only |

The right-hand column is short on purpose. A capture should cost the player *where
they were*, never *what they achieved*.

### 9.2 Counter semantics

- **Capture counter** increments on capture only.
- **Banish does not advance the capture counter.** A one-line assertion, and
  exactly the kind of thing a future refactor would break.
- **Loop number** is displayed in the existing HUD slot and counts captures, not
  world states — the world no longer has a per-loop identity, only the fixtures
  do (§3.6).

### 9.3 Reset timeline

v1's `RESET_TIMELINE` (2.35 s, with the layout swap behind full black) is
retained almost unchanged. The difference is the audio: the reset sting is now a
bell toll rather than a screen fade, and the fade-to-black is shorter because
there is no wall-rise animation to cover. Creature reset happens behind the black.


---

## 10. The finale and the win condition

### 10.1 Trigger

Shutting down the **third** portal triggers the finale. Nothing else does.

### 10.2 Enrage

The creature becomes `ENRAGED`:

- top speed `5.2 m/s` — deliberately just under the player's `6.0` sprint, so the
  gap is real and crossable
- **permanent position knowledge** — no awareness decay, no search behaviour, it
  always knows where the player is
- **no phase-out** — the §8.2 safety valve is suspended
- **banish still works**, but the ladder is ignored and re-emergence is a flat
  short delay. The hammer must stay relevant or Act II's whole skill ceiling
  evaporates at the climax; the enraged creature simply cannot be made to wait.

This is where the aggression ramp from §11 is spent.

### 10.3 The exit

The exit is a car parked at the maximum-graph-distance block, **present in the
world from Act I** — dark, unremarkable, easy to walk past. Its headlights come
on when the finale triggers.

This is the detail the finale depends on. Without it, the finale is a random
search across a wrapping 448 m neighborhood at maximum aggression, which is a coin
flip rather than a climax. With it, the beacon is trivially findable *because the
world has no minimap* — headlights are the only navigational aid in the game — and
the challenge becomes **reaching it while the fastest thing in the world is
behind you**.

The player will almost certainly have walked past that car a dozen times without
a second look. That is the backrooms beat the whole game is built on: the exit was
always there, you just weren't ready to see it.

### 10.4 Win trigger

```js
isInsideExit(playerPosition, exitCenter, radius)   // → boolean
```

Deliberately the same shape as v1's `isInsideChamber`, so the verification
pattern transfers verbatim and the benchmark's "keep the win condition comparable
between runs" is literally true rather than merely aspirational.

**Win screen:** `THE NEIGHBORHOOD WENT QUIET.`

### 10.5 State shape

The finale is a **`finale: true` flag**, not a new `PHASE`. `PHASE` keeps its
existing meaning — start / playing / reset / won, i.e. *what the simulation is
doing* — and the finale is a *condition* the simulation is doing the same thing
under. The HUD keys its treatment off the flag.

---

## 11. Difficulty ramp

Two opposed axes, both pure functions, both asserted by the gate.

### 11.1 Progress axis — driven by portals shut

| Portals shut | Speed | Detection range | Behaviour |
| --- | --- | --- | --- |
| 0 | 2.2 m/s | 14 m | stalk only; Act I `TELEGRAPH` until the hammer is taken |
| 1 | 2.8 m/s | 17 m | short chases |
| 2 | 3.4 m/s | 20 m | chained chases |
| 3 | 5.2 m/s | ∞ | `ENRAGED`; always knows; no phase-out |

### 11.2 Pressure axis — driven by re-emergence count

Each time the creature comes back it is faster, and its re-emergence delay is
shorter. This is what pays for the escalating banish (§7.4), and it is the reason
the two axes are modelled separately rather than as one "difficulty" number.

### 11.3 The balance assertion

Escalating banish makes the game *easier* over a run; the aggression ladder makes
it *harder*. The gate must prove the net trend is correct:

- **expected seconds of creature-on-field per encounter → decreasing** (because
  the banish window widens)
- **damage per encounter → increasing** (because speed, awareness and frequency
  all rise)

A single bad constant in either table currently makes the game either unlosable
or unwinnable, and neither is visible from a screenshot. `verify-world.mjs`
simulates encounters headlessly — creature at tier `N`, player sprinting, `M`
portals down — and asserts both trends numerically. This turns "it feels
balanced" into something the gate can fail on, and it is the highest-value single
piece of infrastructure in the plan.


---

## 12. Art direction

### 12.1 Dusk, not night

The neighbourhood sits in permanent late dusk — the hour where the sky is still
lit but the streetlights have already come on. This is a deliberate constraint
rather than a mood: a fully dark world would hide the creature and destroy the
game, and a fully lit one would destroy it differently by removing the fog. Dusk
keeps silhouettes readable while letting fog still do its work.

### 12.2 Two light families, in conflict

| Family | Colour | Role |
| --- | --- | --- |
| **Sodium vapour** (streetlights, porch lights, car headlights) | warm amber `#ffa54a`, exit beacons `#ffe2a8` | the world, safety, orientation |
| **Portal cyan** | cold `#3ad6d6` → extinguished to `#0b2b2b` | the objectives, the only cold light in the game |

The two families never mix. Amber is the neighbourhood and cyan is the thing
intruding on it, so a cyan glow through a gap between two houses reads instantly
as *wrong* without any UI telling you so. The exit headlights are amber, so the
one beacon that is safe is also the one that looks like home.

### 12.3 Palette anchors

Carried forward and extended from v1's `PALETTE` in `src/game/world.js`:

| Role | Hex |
| --- | --- |
| Sky / dusk horizon | `#6b5836` → `#7a6440` → `#3f3320` (sodium ochre; iteration 2 pass 1 replaced a violet `#2a2233` → `#4a3550` → `#12101a`) |
| Fog | `#574a30` → `#6a5938` → `#332a1c`, density rising with dusk stage |
| Horizon key light | `#ffc27a` at 0.34, falling to 0.20 |
| Sky fill (hemisphere) | sky `#6b5836` / ground `#0d0b12`, intensity 0.85 falling to 0.67 |
| Tone-mapping exposure | `1.02 − 0.14t²` — 1.02 at dusk 0, 0.88 at dusk 1 |
| Asphalt | `#17151b` |
| Sidewalk | `#2b2830` |
| House siding | `#3a3540` and `#4a4038` (two-tone, per-lot deterministic) |
| Hedge | `#1e2a1e` |
| Portal glow | `#3ad6d6` |
| Sodium streetlight | `#ffa54a` |
| Headlight beacon | `#ffe2a8` |
| Creature | near-black `#08070a` with a faint wet specular — it should read as a hole in the fog rather than an object in it |

The three sky stops and the three fog stops are a single dusk ramp, and they
carry four properties the gate asserts rather than four intentions a comment
states (`verify.mjs`, "Sodium dusk (iteration 2, pass 1)"):

1. **Every stop is warm** (red > green > blue). The first run of this design was
   violet, and a violet sky over a sodium-lit street reads as two unrelated
   palettes meeting in the middle of frame.
2. **Every stop is lighter than the violet it replaced**, by 3.0× to 9.8× in
   relative luminance (the smallest lift is the sky's own mid stop). This is the
   "too dark to see things" report, held as a floor so a later mood pass cannot
   quietly take it back.
3. **The ramp still closes.** Stop 0 is 1.7× the luma of stop 2 in 8-bit sRGB
   (2.9× in linear relative luminance), so §3.7's dusk
   is still a clock, and the mid stop is still the *brightest* — a sodium overcast
   is brightest where the haze is thickest, and a monotone ramp is a grey sky.
4. **The fog is darker than the sky at every stop.** Geometry fades *towards* the
   fog colour, so a fog that rose above the sky would light the far roofs more
   than the sky behind them and the world would read inside-out.

The exposure curve is quadratic rather than linear, and that is the substance of
the fix rather than its endpoints: Act I and Act II are played between `t = 0` and
`t ≈ 0.66`, and the previous linear curve had already surrendered 8.9% of its 0.95
base by `t = 0.5` — charging the player for darkness during the part of the
run where the design wants them looking at the street. The new curve costs 3.5% of
its 1.02 base there and spends almost all of its fall on the finale, which is the
only stretch of the run where §3.7 wants the world tightening.

The creature being a silhouette rather than a model is deliberate: at fog
distances a low-detail dark mass with a hard rim reads far more disturbingly than
a detailed mesh, and it is also cheaper to render and to verify.

**The hue is part of the constraint (iteration 2, pass 1).** §12.1 originally
specified *how much* light the world has and left *what colour* it to §12.3, and
the two together shipped a violet sky over a sodium-lit street — a contradiction
that a brightness number cannot express and that no §12.1 reading would have
caught. The player report was "the world is too dark to see things", and the
underlying fault was that the sky was not the same colour as the light source:
sodium lamps bounce amber, a violet sky bounces nothing, so the road was lit only
where the lamps reached and the space between them was black regardless of how
far the exposure was turned up. Fixing the *hue* is therefore part of fixing the
brightness, and §12.2's "amber is the neighbourhood" now extends to the air
between the buildings, not only to the lamps themselves.

The reference is the Backrooms video (67ktSmxCniA): a mono-yellow sodium haze.
It is used for its *colour logic* — one warm family, lit from a sky as well as
from lamps — and not for its content, which is a different game in a different
place.

---

## 13. Audio

v1's `AudioManager` is extended, not replaced. The continuity is the point: the
bell is the only sound that crosses from v1 into v2, and it crosses as the
*player's* instrument rather than the world's timer.

| Sound | Source | Role |
| --- | --- | --- |
| **Bell toll** | hammer swing, hammer pickup, capture reset sting | the identity; three distinct tunings |
| Ambient drone | 2 detuned oscillators, lowpass, very quiet | v1's, retuned lower |
| Footstep ticks | gait-dependent: walk, sprint, and an exhausted variant | the primary sound-radius tell (§6.2) |
| **Breathing** | rate and depth tied to the breath meter and creature proximity | the stamina readout and the proximity readout, doubling as both |
| Portal hum | per-portal, pitch falls as it is shut down | progress feedback in-world |
| Creature breath | distance-attenuated; sharper as awareness rises | the awareness readout (§6.4) |
| Portal shutdown | the sustained 25 m event above the noise threshold | the commitment tell |

Two of these are load-bearing rather than decorative:

- **Breathing does double duty** — it is simultaneously the stamina meter and the
  creature-proximity meter, which is what allows both to exist on screen without
  any bar.
- **The reset sting is a toll.** v1's reset was a screen fade under three bell
  tolls; v2's is one toll and a shorter fade. The loop's signature sound now means
  "you were caught" *and* "your hammer works", which is the whole thesis of v2 in
  one audio event.

---

## 14. HUD and accessibility

### 14.1 What the HUD shows

v1's three flame sigils become three **portal sigils** — cyan and lit, dark and
extinguished. A fourth **hammer sigil** appears dark until pickup. The loop
counter keeps its existing slot and now counts captures (§9.2).

No new text is introduced. No awareness bar, no stamina bar, no distance readout,
no minimap. Every new piece of state is communicated through sigils, sound, or
the post-processing layer.

### 14.2 The hold interaction

The existing `E` prompt element grows a **radial progress ring** for the portal
hold (§5.2), including a visible midpoint tick so the noise threshold is
communicated spatially rather than by text. This is the only new HUD geometry, and
it is the same 0 → 1 → 0 language v1's heartbeat bar already established.

### 14.3 Accessibility commitments

- **Colour-blind safe portal state.** Portal sigils differ by *fill*, not only by
  hue — lit is solid, extinguished is a hollow outline. Readable in greyscale.
- **Photosensitivity.** Portal glow and the headlights use steady values with
  gentle breathing, not strobing. Creature proximity is conveyed by vignette
  tightening, not by flashing. v1's grain and desat layers are retained but
  **rate-limited** during the finale.
- **No reliance on audio alone for critical state.** Every audio cue has a visual
  counterpart: the banish toll has a sigil flash, the awareness state has the
  vignette, the breath state has the vignette, the portal commit has the progress
  ring. A deaf player loses atmosphere, not information.
- **Pause.** `Esc` / pointer-lock loss pauses and freezes the simulation
  completely, including the creature. A pause that does not stop the AI is a
  death sentence for some players.
- **Motion sensitivity.** Head bob and camera shake are reduced by an existing-
  style toggle, and the finale's screen effects are the only new ones.


---

## 15. Architecture and verification

### 15.1 Module split

New pure modules — no DOM, no Three.js, no clock, importable by `verify.mjs` in
node:

| Module | Responsibility |
| --- | --- |
| `src/game/hash.js` | `hash32`, `mulberry32`, the random-access PRNG foundation (§3.2) |
| `src/game/neighborhood.js` | chunk generation, wrap resolution, street graph, districts, anchor placement, fixture pools and their four rules |
| `src/game/creature.js` | state machine, awareness integration, pathing, the banish ladder, the aggression ladder |
| `src/game/rules.js` | portal hold verb, breath, persistence table, loop reset, finale flag, `isInsideExit` |
| `src/game/audio.js` | extended from v1 (§13) |
| `src/game/player.js` | extended from v1 with breath; two verb keys |

Three.js is split three ways, because v2 pushes v1's single 1,967-line
`world.js` well past 3,000:

| Module | Responsibility |
| --- | --- |
| `src/game/world.js` | scene, lighting, post-processing, simulation loop, phase machine |
| `src/game/streetView.js` | chunk geometry, fixtures, portals, hammer, exit car, collider rebuild |
| `src/game/creatureView.js` | creature mesh, silhouette shading, animation, proximity tells |

`App.jsx` changes at exactly one line — the game class it constructs — until
slice 09, which is what makes the whole build revertible.

### 15.2 The seam between the two harnesses

Some rules are checkable in pure node and some are not. This distinction is
deliberate and should be documented rather than blurred:

- **`verify.mjs`** — anything expressible as a function of (seed, constants,
  event sequence). Determinism, connectivity, placement fairness, awareness
  integration, the ladders, the portal verb, breath hysteresis, the persistence
  table, `isInsideExit`.
- **`verify-world.mjs`** — anything depending on a live player position, the
  renderer, or real frame timing. Re-emergence distance, line-of-sight on
  return, collider rebuild after a fixture change, the full capture → reset →
  banish → finale → win sequence, and the balance simulation (§11.3).

### 15.3 Two changes to the repo gate

1. **Wire `verify-world.mjs` into `npm run check`.** It exists with 20+
   integration checks, but it is **not run by the gate at all** — `check` is
   `oxlint` → `node verify.mjs` → `vite build` — **and as of the base commit it
   does not even pass on its own.** `node verify-world.mjs` exits 1:
   `makeCobbleTexture` calls `ctx.beginPath()`, and the 2D canvas stub in
   `verify-world.mjs` implements only `createImageData`, `putImageData`,
   `fillRect`, `globalAlpha` and `fillStyle`. Every procedural texture
   (`makeCobbleTexture`, `makePlankTexture`, `makeBrickTexture`,
   `makeFlameSpriteTexture`, `makeGlyphTexture`, `makeHandprintTexture`) draws
   through canvas APIs the stub does not have.

   So this is not "wire it in" — it is **repair the harness, then wire it in**.
   The stub has silently rotted because nothing ran it. Repairing it is a
   prerequisite for the balance simulation in §11.3, which is the only way this
   design can be tuned without playtesting. If the combined gate proves too slow
   for iteration, it becomes a separate required CI step — but it must be
   required, and it must pass before it is required.
2. **A scripted-run assertion per new subsystem.** v1 already has a "Scripted
   run" section; v2 extends the pattern so that awareness, breath, banish and
   portal traces are each byte-identical on replay. Non-determinism in a
   benchmark game is a correctness bug even when it looks fine on screen.

### 15.4 Definition of done

- `npm run check` exits 0, including the world harness
- the twelve captures in §16.4 exist
- `V2-PLAN.md` slices all closed
- v1's `maze.js` and `loop.js` deleted only in the final slice, after the gate is
  green


---

## 16. Risks, open questions, and deferred scope

### 16.1 The defining risk: this game cannot be playtested

v1's difficulty was one constant. v2's is a state machine, and a single bad
value in `aggressionAt` makes the game unlosable or unwinnable — and neither is
visible from a screenshot. Nobody on this project can click through a chase.

The mitigation is structural and already designed in: the entire AI is a pure
module, so `verify-world.mjs` can simulate hundreds of headless encounters and
assert balance numerically (§11.3). That simulation is the highest-value single
piece of infrastructure in the build, and it is also what makes a v2 result
genuinely more valuable in this benchmark than a prettier v1.

### 16.2 Unproven assumptions

- That the wrap actually reads as seamless rather than as a visible repeat
- That 448 m of fog does not flatten into visual mush at dusk
- That the Act I → Act II handoff lands as a thrill rather than as a betrayal
- That a player reads the noise threshold on the portal hold without being told

Each of these needs a capture and an honest look, not a unit test.

### 16.3 Open questions carried forward

These were raised during design and **not** settled. None blocks the build.

| Question | Recommendation |
| --- | --- |
| **Should captures make the creature learn** — shorter memory, higher aggression per capture, as a third counter alongside portals and re-emergences? | *Recommended, not ratified.* It gives the loop counter real teeth and creates a ramp orthogonal to the portal axis. Held back because it adds a third difficulty input and the two existing axes are already in tension. |
| Provisional title `THE LONG QUIET` | Unratified. The win string is agreed; the title is not. |
| Is `BLOCK = 64 m` correct? | Tune first. It is one constant and the cheapest thing to change. |
| Should the finale banish re-emergence be 1.5 s or longer? | Tune against §11.3. |

### 16.4 Deferred scope

Explicitly **not** in v2, listed so they are not silently lost:

- **Chunk streaming** — the generator is already random-access, so this is a
  change to `resolveChunk` and a loader, not a rewrite (§3.3)
- **Crouch mode** — standing still already provides the stealth verb (§6.2)
- **A second creature** — one hunter is the design; a second is a different game
- **A variant flag shipping v1 and v2 together** — deferred while the branch is
  experimental (§0)
- **Prop variants, weather, interior spaces**

### 16.5 The twelve captures

v1's capture set (title/entry/shrine/door/reset/pause/win/responsive/detail) does
not map onto a two-act game with a chase. v2's set:

1. `title` — start overlay over the neighbourhood
2. `street` — first-person, dusk, repeating blocks
3. `hammer-located` — the hammer in its clearing
4. `hammer-awakening` — the pickup toll, `TELEGRAPH` → `STALK`
5. `portal-located` — cyan glow through a gap between houses
6. `portal-shutdown` — the hold, progress ring past the midpoint tick
7. `creature-stalking` — silhouette at the edge of vision
8. `creature-chasing` — full chase, vignette tightened
9. `banish` — the toll, the creature gone
10. `capture-reset` — reset sting and fade
11. `finale-headlights` — the car, lit, beacon through fog
12. `win` — `THE NEIGHBORHOOD WENT QUIET.`

Responsive and pause states are captured in addition to these twelve, not
instead of them.

---

## Appendix — decision ledger

The thirteen ratified decisions, for traceability back through the discussion.

| # | Axis | Decision |
| --- | --- | --- |
| 1 | World | 7 × 7 blocks, toroidal wrap, random-access chunk generator via `hash32` |
| 2 | Streaming | Deferred; the wrap is a coordinate transform over the same API |
| 3 | Reshuffle | Geometry fixed per run; structural + decorative fixtures permute per loop |
| 4 | Dusk | Keyed to portals shut, **never** to captures — no death spiral |
| 5 | Objectives | 3 portals + hammer, one per district; exit at max graph distance from spawn |
| 6 | Act I | Find the hammer; the creature is telegraph-only and cannot capture |
| 7 | Act II | The pickup tolls; the creature awakens; banish goes live |
| 8 | Detection | Awareness meter, sound-weighted ×4–5, sight confirms and holds, decays when silent |
| 9 | Banish | Escalating full removal 8 → 24 s, capped, vs. an aggression ladder on re-emergence |
| 10 | Portal verb | Hold to shut; silent first half, loud committed second half |
| 11 | Win | Third portal → enraged creature + headlights on a car that was always there |
| 12 | Stamina | Invisible breath meter; lockout with hysteresis; exhaustion raises sound radius |
| 13 | Reset | Capture only. Portals, hammer, counters and exit all persist |

