# ORCHESTRATOR LOG — cline/space-bunny-alpha

Benchmark run: Bell Loop v2 ("The Quiet Streets" working title)
Orchestrator: Hermes (reviews, decides, views screenshots; does not code)
Implementer: Cline CLI on **Space Bunny Alpha** (free model, Cline provider), driven via tmux session `cline-main`
Base commit: `3ccd9f8` (main)
Branch: `cline/space-bunny-alpha`

## Brief (from Aditya)
- Branch off main. New game version: liminal-space walking, **open world of repeating streets**.
- Goal: find **3 portals** and shut them down. Old stick-hits-bell loop-restart mechanic replaced: a **creature** stalks; being caught restarts the loop; artifact (bell-hammer) repels/stuns it.
- UI inspired by Kenton-GMI/sakuragaoka-station (procedural three.js, walkable FP, HUD) but **yellowish tint + darker theme**; bg mood = Backrooms ("7 Weeks 3 Days (Backrooms Version)" video: mono-yellow sodium haze, liminal dusk).
- Assets procedural, "realistic-looking".
- Orchestrator runs **100s of Cline passes** on free models; if a model is exhausted, set a timer and switch/retry.
- Blockers: research first, then ask Aditya.
- Vercel CLI deploy at the end (auth coming later). Keep this log.

## Design decisions so far (ideation with Space Bunny, no code yet)
1. **World**: fork Q1 → chose **4** — toroidal wrap grid (7×7 blocks ≈ 336 m, seamless repeat) now, streaming later as a slice. Generator is chunk-addressed from day one (`chunkAt(cx, cz)`), wrap = coordinate transform.
2. **Reshuffle on reset**: fork Q2 → chose **3** — fixed geometry, **permuted fixtures** per loop (parked cars, lit windows, hedges re-roll via `hash32(seed ^ loopSalt(loop), cx, cz)`). Streets never move; the place feels wrong each loop without erasing progress.
3. **Dusk keying**: Space Bunny correction, accepted — darkness is keyed to **portals shut** (progress), not loop number (no death spiral).
4. **Creature learning**: accepted as second ramp axis — captures shorten creature memory + raise aggression; portals = positional progress, captures = AI pressure.
5. **Hammer**: fork Q3 → chose **1** — must be found (fixed per run, fair distance pool). Space Bunny's synthesis: **pickup tolls the bell → toll wakes the creature**. Act I = quiet streets (no capture possible, telegraph sightings only), Act II = hunt live. Bell = causal spine of the game.
6. **Win condition** (proposed, accepted): 3rd portal down → creature permanently ENRAGED (5.2 m/s vs sprint 6.0, always knows position, no phase-out) + exit opens at far edge (car with headlights). Reach it → win: "THE NEIGHBORHOOD WENT QUIET."
7. **Ramp table** (accepted): 0 portals: speed 2.2/detect 14 m/stalk only + 8 s grace · 1: 2.8/17 · 2: 3.4/20/chained chases · 3: 5.2/∞/no phase-out. Stamina becomes load-bearing (limited sprint).
8. **Creature AI**: DORMANT → STALK → CHASE → STAGGER (stun 1.6 s within 2.2 m, swing cooldown 0.55 s, swing is loud) → REPOSITION. Detection = sight cone ~70°/18 m + hearing (sprint 22 m, walk 9 m, swing 30 m) with **awareness meter** (no binary spot). Chase >12 s → phases out (anti-frustration).
9. **Portals**: 3, in liminal structures (shed / bus shelter / phone box), one per district, min graph distance from spawn + from each other. Shut down = **hold E 1.2 s** (progress ring, vulnerability window). Persist across loops. Each shutdown: dusk deepens, creature faster.

## Phase 2 status (docs pass, complete)
- Resumed session 1790368004047_sshb9 in interactive TUI after timeout kill (lesson: run with no -t flag).
- GAMEDESIGN.md written (26.7 KB, 16 sections, "THE LONG QUIET" working title).
- V2-PLAN.md written: 16 slices in 3 phases (A: pure modules 01–07, B: integration 08–13, C: gate/balance/publish 14–16). Critical slices: 09 (the swap) and 15 (balance simulation).
- Cline found verify-world.mjs broken at base (canvas stub rot, `ctx.beginPath`) — scheduled as slice 14; not in npm run check today.
- npm install run (node_modules absent); npm run check green: lint clean, 33/33 pure checks, build clean.
- Committed: 4b60ca6 "docs(v2): design THE LONG QUIET and its 16-slice implementation plan" (GAMEDESIGN.md + V2-PLAN.md).

## Pass log
- Pass 1 (ideation): recon of repo (loop.js, maze.js pure modules; verify.mjs gate = oxlint + verify + build; PlayerController 3.6/6.0 m/s; HUD text-free; determinism = seed via mulberry32). Produced 16-section design outline + proposals. Flagged: verify-world.mjs NOT in `npm run check` gate (gap to fix in implementation).
- Q1 world geometry → 4 (wrap now, streaming later). Q2 reshuffle → 3 (fixed geometry, permuted fixtures). Q3 hammer → 1 (must be found) + creature-learning kept.
- Pass 2 (docs): resumed, wrote both docs, gate green, committed 4b60ca6. Token usage ~95K input + 500K cache reads, $0.00.
- Aditya went offline → autonomous overnight run authorized: "continue until finished, push everything; Vercel later."

## Slice completion log (autonomous run)
| Slice | Commit | Gate | Notes |
|---|---|---|---|
| 01 hash.js PRNG | 42800f4 | 40/40 | +7 checks |
| 02 neighborhood chunks/wrap/graph | 0b05dd5 | 50/50 | wrap-seam connectivity proven |
| 03 districts + anchors | c3653f2 | 59/59 | 5 objectives placed, hammer stable loops 1..8 |
| 04 fixtures + 4 rules | c101e3c | 67/67 | Cline process died mid-slice (silent exit) — resumed via `cline --id`, finished. BFS fixture checks slow → optimized |
| 05 rules.js portal/breath/persistence | 62238eb | 78/78 | tmux server died twice (container reaping); resumed via --id again |
| 06 creature.js awareness + state machine | 1411e29 | 101/101 | non-interactive background cline per slice (no tmux); 7 states incl. STAGGER/REPOSITION; awareness held by sight |
| 07 pathing + the two ladders | (this commit) | 115/115 | BFS on the 49-node street graph; §7.4 ladder 8→24 capped; §11.2 aggression strictly up, delay strictly down; §8.2 phase-out at 12 s; §8.3 placement cascade; §11.3 pure trend |
| 08 player breath + two verbs | (this commit) | 123/123 | +8 checks; `player.js` lost its `three` import (Vec3/Vec2) so §15.1's "pure, importable by verify.mjs" is now literally true; E=interact hold, LMB=swing edge; exhausted breath is a continuous `still` event on the creature's table |
| 09 THE SWAP | (this commit) | 130/130 | `streetView.js` (49 chunks x 3 wrapped copies, ~760 colliders, 18 instanced pools); `world.js` rewritten as `LongQuietGame` on the v2 simulation; `App.jsx` changed at exactly one line; v1 `maze.js`/`loop.js` now dead but not deleted |

### Slice 08 decisions (recorded for the next slice)

- **`player.js` is now genuinely pure** and `verify.mjs` imports it directly. The only
  thing that ever blocked that was `import * as THREE from 'three'`, needed for two
  vector objects; `Vec3`/`Vec2` replaced them. Outward API checked against callers first:
  `world.js` reads only `pos.x` / `pos.z`, `verify-world.mjs` uses `pos.clone()` and
  `keys.add/delete` — all preserved, so v1 wiring is untouched. The browser surface is
  confined to `attach` / `dispose` / `requestLock`; DOM events are translated into
  `pressKey` / `pressButton`, and that is the same door the pure checks use.
- **One sprint flag, two gates.** `sprinting = wantsSprint && !exhausted` is computed
  *before* `breathStep` and re-checked *after* it, so neither the pre-existing flag nor a
  held Shift key can buy a single frame of sprint speed. Dropping either gate alone is
  survivable; dropping both is caught by the gate (mutation-tested).
- **Exhausted breathing is a continuous `still` event**, emitted once per
  `SOUND_EVENT_SECONDS` window via `creature.soundRadius('still', …)` (= +6 m), *in
  addition to* the per-stride gait event that already carries the +6. The alternative —
  folding the bonus into the gait event only — was rejected: it would leave a spent
  player standing behind a hedge in silence, which is the exact moment §7.3 is about.
  The reachable radius set is asserted exhaustively: `{0, 6, 9, 15, 22, 28}`.
- **Breath survives a capture.** §9.1's reset column is short on purpose and breath is
  in neither column, so `teleport()` does not touch it. Slice 09 wires `applyCapture`.
- **World harness, run by hand:** `node verify-world.mjs` still exits 1, unchanged from
  the base commit — `TypeError: ctx.beginPath is not a function` at
  `makeCobbleTexture (src/game/world.js:182:11)` ← `new BellLoopGame
  (src/game/world.js:482:26)` ← `verify-world.mjs:133`. Not touched; slice 14 owns it.
- **The new checks were mutation-tested**, because a check that cannot fail is worse than
  no check: leaking the lockout into the speed, hard-coding a sound radius, re-declaring
  `BREATH_DRAIN_PER_SEC`, dropping the stride gate, and emitting a footstep per frame
  are each caught (the last two by the sound-table and standing-still checks).

### Slice 09 decisions (recorded for the next slice)

- **THE WRAP IS A DRAW-WINDOW PROBLEM, NOT A FOLD PROBLEM.** The obvious snap,
  `round(x / WORLD_EXTENT) * WORLD_EXTENT`, is 32 m out: the block grid runs from
  the first road axis to one block *past* the last, so the fold window
  `[-224, +224)` and the drawn tile `[-192, +256)` are out of step. The error
  hides in one 32 m strip along the western edge, where the player stands on bare
  asphalt with the neighbourhood 32 m behind them. `originFor` in `streetView.js`
  derives the period index from `roadAxisToWorld(0)` instead, and `verify.mjs`
  asserts the folded position is inside the tile over a 3,000-point grid plus the
  four directions by hand. This is the single most valuable thing the slice found.
- **THE PLAYER NEVER WRAPS; THE WORLD DOES.** `recentre()` moves the whole street
  group by whole periods, nearest copy to the player, and the collider and
  occluder lists are composed against the same origin — so "walking into a hedge
  collides" cannot decay into "walking into the same hedge 448 m away does not".
  Only the canonical copy contributes colliders (760 boxes, not 1,800).
- **THE EXIT CAR IS PARKED BESIDE ITS ANCHOR, NEVER ON IT.** `isInsideExit` is a
  1.15 m radius and the player radius is 0.36 m, so a car body centred on the
  anchor makes the win condition geometrically unreachable. The anchor sits at the
  driver's door instead.
- **CANONICAL VS WORLD FRAME IS NOW EXPLICIT.** Anchors, the creature's position
  and the AI's occluders are all canonical (folded); the player and everything
  drawn are not. Every crossing goes through `streetView.worldOf` or
  `creature.js`'s `wrapDelta` — including the win test, which re-frames
  `state.exitAnchor` before handing it to `rules.checkExitWin` so §10.4's rule
  stays the pure one slice 05 asserted.
- **TELEGRAPH PLACEMENT IS §8.3 INVERTED, ON PURPOSE.** A re-emergence must never
  be in line of sight; a telegraph must be, or §6.1's "appears at long range and is
  gone when you look back" is not a sentence. Same distance floor, inverted sight
  rule, hashed so a replay is the same apparition. `sighting` is therefore the
  view cone alone — the detection range belongs to the hunter Act II turns it into.
- **TEXTURES ARE PIXEL-ONLY, DELIBERATELY.** Every procedural texture in
  `streetView.js` is `createImageData`/`putImageData` and nothing else, so the v2
  world constructs inside `verify-world.mjs`'s existing five-member canvas stub.
  Slice 09 was smoke-tested headlessly with that stub unchanged; slice 14 still
  owns repairing the harness, and the failure it reports is unchanged
  (`TypeError: ctx.beginPath`) rather than a new one.
- **App.jsx IS ONE LINE.** `import { LongQuietGame as BellLoopGame } from
  './game/world.js'`. The alias keeps the diff to the single line §15.1 promises
  while `world.js` exports the honest name, and it keeps `verify-world.mjs`'s
  `import { BellLoopGame }` resolving until slice 14 rewrites that file.
- **SMALL OVERLAP WITH SLICES 12/13, DELIBERATE AND BOUNDED.** The world mirrors
  the v2 portal state into the v1 HUD's `candles`/`timeLeft`/`prompt` fields and
  pins the heartbeat line full (v2 has no countdown), and the finale's *visible*
  consequences — one dusk step, the headlights, the win check — are wired here.
  Slice 12 still owns the HUD and slice 13 still owns the enrage presentation and
  the finale's world checks.
- **Gate:** lint clean, 130/130 pure checks, `vite build` clean. The new checks
  were mutation-tested (flattening a dusk fog row, constructing the game twice in
  `App.jsx`, and removing every N-side fixture are each caught). The world harness
  is still out of the gate by design; a temporary 14-check node smoke run against
  the existing stub passed and is not committed.

### Slice 10 — creature view and the capture loop

- **THE SLICE SPLITS ALONG §15.2's SEAM, DELIBERATELY.** The plan gives slice 10 a
  *world* gate, and its checks "belong" in `verify-world.mjs` — which does not run
  and which slice 14 owns. Taken literally that leaves the whole of the creature's
  visual design unverified for five slices, in a project whose defining constraint
  is that it cannot be playtested. So the policy went into `creature.js` (pure) and
  the geometry into `creatureView.js` (Three.js). The numbers are provable today;
  the triangles are not, and pretending otherwise would be theatre.
- **THE EYES HOLD A PIXEL FLOOR, AND THAT IS THE WHOLE OF "EMISSIVE EYES".** At
  §8.3's minimum re-emergence distance — 90.5 m, the closest a banished thing can
  legally come back — a 7 cm sphere subtends about half a pixel. Geometry has no
  floor on its apparent size, so `eyeWorldSize` solves the solid angle and the eyes
  are quads: 9 cm up close, 1.27 m at 90 m. `EYE_PIXEL_FLOOR = 7`. They are the
  only part of the figure whose world size is a promise rather than a proportion,
  which is why `present()` divides them back out of the figure's own scale.
- **THE EYES ARE UNFOGGED, DELIBERATELY.** The same decision `streetView.js` makes
  for the portal rings and the sodium lamp heads: §4's three distance-readable
  things are the two lights and the thing hunting you, and a fogged emissive at
  90 m is a slightly brighter piece of fog. They are billboarded every frame too,
  because a creature facing you with its eyes pointed behind you has no readable
  face.
- **THE FIGURE IS 7:1, AND THAT IS A MEASUREMENT RATHER THAN A MOOD.** 2.80 m on a
  0.40 m shoulder, against `streetView.js`'s own 1.1–1.3 m frontage and 5.2 m house
  wall. It is 2.2x the hedge and under the roofline, and the gate asserts all three:
  a silhouette that cleared the roofs would be a landmark, and a landmark is not a
  horror. The parts sum to the height, so the rig cannot be built twice and
  disagree.
- **BODY COLOUR IS `PALETTE.creature`, AND NEAR-BLACK IS DOING WORK.** Every §12.3
  fog stop is *lighter* than the body, so the figure always reads as a darker shape
  than the air in front of it. That is what lets a near-black figure survive a
  transparent material: a 30%-opacity apparition is a hole in the fog, not a grey
  smudge on top of it. `depthWrite: false`, because a translucent mesh that writes
  depth occludes itself.
- **§6.1'S EDGE-OF-VISION ANGLE IS A FRACTION OF THE HALF-FIELD, AND IT HAS A
  DOCUMENTED ASPECT FLOOR.** One number has to be inside the frame (or §6.1's STALK
  is a state nobody learns to read) *and* outside `SIGHT_HALF_ANGLE` (or the thing
  at the edge of your vision can see you). At 16:9 / 72° that is 41.8° and it
  works. At 1:1 the frame is 36° and the cone is 35°, so the two promises are *not*
  simultaneously satisfiable. `stalkEdgeAspectFloor` computes where they stop being
  satisfiable (1.317:1) and the gate asserts the floor rather than pretending a
  square window keeps the design intact. 4:3 — the narrowest aspect any real screen
  ships at — is inside it. This was found by the gate, not by playing.
- **THE EDGE OFFSET IS PROPORTIONAL TO HOW NEAR THE FRAME EDGE THE CREATURE IS.**
  A constant applied to every sighting would dress up something standing dead
  ahead as though it were at the edge of your vision, and a player can see through
  that. `roll = edge * clamp(bearing / viewHalfFov)`.

### Slice 10 — bugs found (four, all invisible to slice 09)

- **A CHASE WAS TAKING THE STALK'S EDGE OFFSET.** The roll was gated on `sway > 0`,
  and `chase` sways 0.05 — so a chase, the one state that should be squared up to
  the player, was presented 42° off the bearing to them. `edge` is now a named
  column on the presentation table and the gate asserts which states set it. The
  gait and *where in the frame the thing stands* are different properties and had
  been sharing a test.
- **THE HAMMER RANG AND NOTHING ANSWERED.** Since slice 09 `_updateVerbs` consumed
  the LMB edge, pushed a toll sound event, and then `creatureStep` was handed
  `swing: false` — hardcoded. The banish ladder did not exist in the running game.
  `_swingPending` now carries the edge to the step, and because `creatureStep` runs
  the capture test *after* the swing, a hammer that connects on the frame it would
  otherwise have caught you is §6.1's promise that STAGGER cannot touch you.
- **THE §7.4 LADDER NEVER MOVED.** `world.js` mirrored `state.banishCount` onto the
  creature every frame, overwriting the increment `creatureStep` had just made. The
  counter stayed on zero for the whole run, so every banish bought the first rung's
  eight seconds forever. The write-back now happens *before* the mirror, and the
  gate asserts the invariant that closes it: the mirror is idempotent, so writing
  the creature's own count back into the run is a no-op and cannot double-count.
- **THE NEW CREATURE WAS DRAWN ON THE CAPTURE FRAME.** §9.3 says the creature reset
  happens behind the black, but `_updateCreatureView` read `this.phase`, which
  `update` had cached at the top of the frame — so a phase that changed *during* the
  frame was read as the old one. It now reads the store, the same reason `_syncHud`
  does. Caught by an assertion added to the world list, not by reading the code
  carefully.

- **THE RECOIL IS THE BANISH WINDOW, AND THE EXPONENT IS ABOVE ONE.**
  `staggerRecoil` reads the `staggerSeconds` clock the state machine already keeps,
  so a hammer thrown with a long window throws further and there is no second
  source of truth to disagree. The curve is `remaining ^ 2` — a struck body
  *decelerates into a stop*. My first exponent was 0.55 with a comment claiming it
  front-loaded the throw; it does the exact opposite, and the gate's shape
  assertion is what said so. The constant is now named `shape` rather than
  `falloff`, because that name *was* the bug.
- **THE DISMISSAL WINDOW IS §9.3's CROSS-FADE LENGTH, 1.1 s, ON PURPOSE.** A removal
  the player cannot watch reads as a stutter, and §8.2 is the most important rule in
  the anti-frustration section: being cornered is survivable *because you watch the
  thing that cornered you give up*. The figure finishes leaving exactly as the
  screen starts going down. The arrival is 0.9 s and fades rather than snapping,
  because §8.3's placement is instant and a teleport is how a horror game tells you
  its own rules are not real.
- **A REMOVAL IS DRAWN, WHICH NEEDS A `dismissing` ROW.** §7.4 and §8.2 both leave
  the creature `dormant`, and `dormant` draws nothing — so without a departure row
  both rules would be invisible. It is not a §6.1 state and is documented as not one.
- **THE ACT I APPARITION IS DRAWN ON THE TITLE SCREEN.** `_updateCreatureView` runs
  in every phase and suppresses the figure only in RESET and WON. §6.1's first
  sighting is the only thing on that screen that says there is something out here.
- **NO TEXTURES, NO `document.createElement`, NO CLOCK, NO RANDOM.** The figure is
  13 geometries and 384 triangles, built bottom-up from `CREATURE_SHAPE`. This
  keeps the constructor inside `verify-world.mjs`'s existing five-member canvas
  stub, which is why the scratch harness that validated all ten world checks needed
  only `document.removeEventListener` added.

### Slice 10 — gate

- **Gate:** lint clean, **144/144** pure checks (up from 130 — a new "Creature view
  and the capture loop" section, 14 checks), `vite build` clean. The 14 new checks
  were mutation-tested: **17/17 caught** in `creature.js` (thinning the silhouette,
  removing the telegraph flicker, deleting the eye pixel floor, moving the stalk
  edge inside the sight cone, un-gating the recoil on state, linearising the
  recoil, un-freezing the table, making `creaturePose` throw, and ten more). The
  10 world checks were validated in a scratch harness and mutation-tested **10/10**
  against `world.js`; the scratch harness is not committed.
- **The world harness is still out of the gate and its failure is UNCHANGED** —
  `1/12 world checks passed`, exit 1, `SHRINE_IDS is not iterable`, byte-identical
  to the slice 09 baseline (verified by stashing). Slice 10's ten world checks are
  parked at the bottom of `verify-world.mjs` inside a block comment, transcribed
  from a working run rather than sketched, so slice 14 should find them nearly
  drop-in. That block is the deliverable slice 14 should start from.
- **Left for slice 11/12/13, deliberately:** the `searchExhausted` and
  `searchPosition` frame channels are still hardcoded `false`/`null` in
  `_updateCreature`, so `reposition` is a presentation row nothing reaches yet.
  `presentationFor` has a row for it and the gate asserts it, so nothing breaks —
  wiring the search layer is not slice 10's work.

## Slice 11 — audio (§13, GAMEDESIGN section 13 is the authority)

**Goal as executed.** `AudioManager` extended, not replaced: the three bell
tunings, the gated footstep set, breathing, the creature's breath, the portal hum,
the shutdown event and the capture reset sting. All procedural, no assets.

### The structural decision — the audio became half data

`audio.js` now has a **pure** half above the `AudioManager` boundary, because §15.1
lists it as a pure module and because a WebAudio graph cannot be asserted in node:

- `AUDIO_ROUTES` — §13's seven sounds as **12 rows** (one per *source*, not per
  sound: three tolls, three gaits, four sustained voices), each naming its
  `AudioManager` voice and its `kind`/`exhausted` arguments.
- `cueRadius(row)` asks `creature.soundRadius`, so **every creature-facing radius
  is the AI's own table**. §7.3's whole synthesis is now structurally incapable of
  drifting: the player cannot price a footstep differently from the creature.
- `routeAudio(frame)` is a pure function of **15 documented frame fields**
  (`AUDIO_FRAME_FIELDS`) and is the only thing in the codebase that decides what
  the player hears.
- `breathVoice`, `creatureBreathVoice`, `portalHumVoice`, `portalHumPitch`,
  `droneLevelFor`, `footstepGaitFor`, `proximityAt` — pure parameter functions.
- The class gained one entry point, `update(dt, frame)`, and `_pulse` — a shared
  dt-driven clock for the two continuous voices. **No `setTimeout`**: a voice that
  keeps its own time keeps breathing through the pause and the capture's black.

**`world.js` has exactly three `this.audio?.` call sites** — `update` (the router,
once per frame), `winChord` (slice 13's) and `stopPortalHums` (teardown) — and the
gate asserts that set by name, so a new ad-hoc sound in the world fails the build.

### Design calls worth recording

- **THE THREE TUNINGS ARE D3–G3–C4, A STACK OF TWO FOURTHS**, and the gate
  asserts the intervals in cents rather than trusting the numbers. Three tolls on
  one recipe have to be told apart in half a second of panic, and pitch is the only
  channel that survives fog, a compressor and a laptop speaker. `reset` (146.83) is
  the lowest and the only one with **no echo and a 6% downward sag** — §13's "a toll
  and not a fade cue" is one strike, and a sting with a tail reads as a transition.
  `awakening` (196) rings longest because it is the act break; `banish` (261.63) is
  the shortest decay and the brightest, because a banish has to punch.
- **THE HAMMER IS A BELL, LITERALLY ONE LIST.** `BELL_PARTIALS` is exported and
  shared by all four tolls (including the whiff), and the gate asserts the
  harmonic ratios are *absent* — the identity is a property of the recipe, not of a
  comment.
- **A MISS IS THE WHIFF, NOT A FOURTH TUNING.** Same recipe, damped to 700 Hz, no
  echo, and still a 30 m event: the creature hears a swing whether or not it lands
  (§7.4), and the feedback has to say which happened. The three `resolveSwing`
  outcomes are asserted to be exactly the three cases the table handles, so slice
  13's fourth outcome lands on a row rather than on silence.
- **THE OPENING TOLL IS GONE, AND THAT IS §13 READ THE OTHER WAY.** v1 rang a bell
  on BEGIN. §13 keeps the bell and changes what it is for — it "crosses as the
  *player's* instrument rather than the world's timer" — and §9 says there is no
  timer and no bell on a clock. BEGIN is now answered by the drone coming up. The
  title screen routes **nothing** (`started !== true` returns no cues at all).
- **THE AMBIENT DISTANT BELLS ARE GONE** (`_distantClang`, `_distantSecondBell`,
  v1 loop 12). A bell that rings every fourteen seconds from nowhere is a fourth
  tuning the player has to learn to ignore, and §9 says the only bell in the game is
  the hammer. `candleWhoosh` and `doorCreak` went with the shrines and the door —
  the gate asserts all four names are gone from the prototype.
- **THE DRONE IS RETUNED A FOURTH DOWN** into `DRONE_TUNING` (55→44 Hz, cutoff
  180→140, rumble 32/33.3→27.5/28.6), because §13 says "v1's, retuned lower" and a
  claim with no number in it cannot be checked or undone. The win duck is
  `DUCK_LEVEL`, restated as a *ratio* of the bus gain so the manual `duckAmbient`
  and the routed `DRONE_LEVEL_WON` cannot drift.
- **BREATHING IS SILENT OUTSIDE PLAYING.** Not caution: §9.3 gives a capture
  exactly one sound and it is the toll, so the breath, the rasp and the hums all
  arrive on the black with a level of zero. That is why the router emits sustained
  rows on *every* started frame — a voice that has to be explicitly silenced is a
  voice that can be left running.
- **`BREATH_PROXIMITY_RANGE` (30 m) IS DELIBERATELY WIDER THAN
  `CREATURE_BREATH_RANGE` (20 m).** §13 wants the player's own lungs to be the
  *earlier* of the two tells: you hear yourself panic before you hear it.

### Two real bugs this slice found

1. **THE 25 m PORTAL EVENT COULD NEVER FIRE.** `portalNoiseElapsed` was one number
   shared by all three portals, and the hold loop zeroes it for every portal that
   is *not* the one being held — so the two idle portals reset the accumulator at
   the end of every frame. §5.2's entire promise (silent first half, loud second
   half) was silently never kept, and slices 09/10 could not see it because nothing
   asserted the event was *emitted*. Now keyed per portal id. **Found by the parked
   world check, not by the pure gate** — which is the argument for slice 14.
2. **THE AWAKENING TOLL COULD NEVER RING.** The frame reported `hammerHeld` in the
   present tense, and `_takeHammer` flips that flag on the very frame it raises the
   pickup edge — so the gate `hammerPickup && !hammerHeld` was false on the only
   frame it could ever be true. The field is now `hammerHeldBefore` and says what
   it means. Found by the scratch world harness on the first run of the parked
   checks, and fixed before either landed.

A third finding was the gate's own doing: **`proximityAt` ran the wrong way**, so a
creature in the next district read as *maximum* proximity and the player's breath
sat permanently at the "something is on top of you" end of its own ladder. It is
now `1 - distance / range`, and the comment above it says so.

### Slice 11 — gate

- **Gate:** lint clean, **158/158** pure checks (up from 144 — a new "Audio: the
  routing table and the three tolls" section, **14 checks**), `vite build` clean.
- **Mutation testing: 14/17 caught by the pure gate.** Caught: banish tolling on a
  miss, the already-held lock removed, a walk priced as a sprint, the reset sting
  sharing the banish pitch, the awakening decaying like a banish, a row naming a
  voice that does not exist, the hum rising instead of falling, the commitment tell
  deleted, action cues ignoring the phase, the title screen made non-silent, the
  sprint key reporting the winded gait, the breath not routed at all, the world
  ringing a v1 bell directly, the reset flag never cleared, the player never
  reporting exhaustion. One of the three misses is an **equivalent mutant** (the
  `cueRadius` guard is redundant, because `soundRadius` already floors unknown
  kinds at 0). The other two are world-*runtime* state the pure gate structurally
  cannot see — and **both are caught by the parked world checks** (verified:
  re-introducing the shared accumulator fails the shutdown check, and reporting a
  miss as a connect fails the swing check). **17/17 covered by the suite as a whole.**
- **Seven world checks, validated in a scratch harness, 7/7 passing** — one router
  call per frame and a quiet frame is quiet; a connect tolls and a miss whiffs; the
  awakening toll fires once and never again across a capture; the capture sting is
  exactly one toll and nothing else speaks through the black; footstep sound only
  while really moving; the shutdown is silent in the first half, loud and windowed
  in the second, and silent forever after; `dispose()` stops the hums. Parked at the
  bottom of `verify-world.mjs` in a block comment, transcribed from that run. The
  scratch harness is not committed.
- **The world harness is still out of the gate and its failure is UNCHANGED** —
  `1/12 world checks passed`, exit 1, `SHRINE_IDS is not iterable`, identical to
  the slice 09 and 10 baselines. `makeFakeAudio` was rewritten to record `update`
  and replay the frame through the real `routeAudio`, and the v1-era live checks
  that asserted `bellToll`/`bellSequence`/`candleWhoosh`/`doorCreak` were retitled
  or dropped rather than left asserting an API that no longer exists. Two lines
  (`beast`, `hood`) were added for the parked blocks, and the file header now states
  plainly which block slice 14 is replacing.
- **Left for slice 12/13, deliberately:** `winChord` is still called directly by
  `_win` — the one non-routed sound left, and slice 13 should give it a row, after
  which the whitelist is just `update` and `stopPortalHums`. The
  `searchExhausted`/`searchPosition` channels from slice 10 are still hardcoded.
- **Known limit, stated rather than hidden:** the WebAudio graphs themselves
  (`_breathVoice`, `_raspVoice`, the whiff's drag scuff) cannot be asserted in node,
  and two mutations inside them survive the pure gate. What *is* verified is that the
  parameters reaching them are right. A listening pass is a Phase C capture concern
  (slice 16).

## Slice 12 — HUD and accessibility (§14, GAMEDESIGN section 14 is the authority)

Read-only council first (AGENTS.md step 3), then one writer. Both councils earned
their keep immediately: the design council caught a lit/shut **inversion** and a
redundant vignette owner, the engineering council caught three things that would
have turned the gate red. Recorded because the next slice should assume the same
review happened.

### The structural decision — the HUD is a pure projection, and it is closed

`src/ui/hud.js` takes the store's state and returns the finished values the DOM
paints. No DOM, no Three, no clock, no globals, so `verify.mjs` imports it
directly. v1's `hudSnapshot` was **deleted from `loop.js`** in the same move
rather than left beside the new one — two projections would have survived until
slice 16 deleted the file that owns the wrong one, which is the worst time to
find out.

The projection's key set is **written down and asserted** (`HUD_FIELDS`), and
that set is the whole argument for §6.4's "no awareness bar", §7.3's undrawn
breath and §14.1's "no distance readout": `awareness` is an *input* to the
projection and never an output of it. It arrives, is squared into two visual
amplitudes, and is gone. Adding a readout to this game now means adding a line to
one exported array.

### Design calls worth recording

- **THE SIGIL POLARITY WAS INVERTED, AND THE PLAN DID NOT SAY SO.**
  `state.portals[id] === true` means the portal is **shut** (§5.3); v1's
  `candles[id] === true` meant the flame was **lit**. The v1 mirror lit its three
  flames *from* the portal flags — correct for v1, exactly backwards for §14.1,
  and it would have shipped a HUD that lit up as the player made progress. The
  fix is `portalSigil(shut)`, asserted in **both** directions, and the council's
  reason for catching it is the one to keep: the sigil function is a one-line
  ternary over a boolean whose name is `shut`.
- **THE SIGIL STATE IS THE FILL, AND NOTHING ELSE.** §14.3 asks for lit and
  extinguished to be told apart in greyscale. The first draft gave each state its
  own rim ink; the contrast check killed it — a near-white rim on mid-cyan is
  1.65:1, i.e. a bright shape with no edge, which is a blob. The shipped version
  shares **one outline ink across both states**, so `filled` is the only channel
  carrying state at all, and the keyline still clears 3.56:1 against the lit body
  so the solid shape keeps a visible edge. Lit `#3ad6d6` at 11.49:1, extinguished
  `#1d6a66` at 3.23:1, lit:dark luminance ratio 4.67:1.
- **§12.2's `#0b2b2b` IS NOT THE HUD INK.** At 1.36:1 on the shell background it
  is a mark nobody can see. It stays the colour of the *world's* dead portal
  light, which is what it was written for; the HUD's dark sigil is the same hue
  lifted until it clears `SIGIL_MIN_CONTRAST`. Obeying §12.2 literally here would
  have been a failure of §14.3, and the two sections do not actually conflict.
- **THE OSCILLATION IS CSS; THE LEVEL IS REACT.** A 2.2 s breath that ran through
  the store would be 132 re-renders. So every value in `hud.js` is a *level* in
  `[0, 1]`, React paints it as a custom property, and the stylesheet animates it.
  Two payoffs: a slow breath costs a handful of repaints, and §14.3's toggle can
  stop it with one `animation: none` — a store flag cannot reach a running
  keyframe, so the switch has to arrive as a **class**.
- **THE BREATH PULSE IS FLOORED AT 0.45 Hz** (`BREATH_PULSE_FAST` = 2.2 s), two
  orders of magnitude below the 3–30 Hz band that provokes photosensitive
  seizures, and asserted as `< 0.8 Hz` for every input. The finale's ramp is
  `FINALE_EFFECT_INTERVAL = 1.5 s` over six steps: nine seconds from nothing to
  full, so a player reaches the exit *inside* one ramp rather than watching a dial.
- **THE FINALITE SWAPS THE GRAIN ANIMATION, NOT JUST ITS LEVEL.** v1's
  `grain-jitter 0.66s steps(3)` is a 4.5 Hz full-screen positional flicker. §14.3
  says the grain is "retained but rate-limited during the finale", and the honest
  reading is that a 4.5 Hz jitter cannot be *dimmed* into safety — it is replaced
  with a 2.2 s one for the finale. The v1 baseline is retained outside it, as the
  design says, and the reasoning is written down: it is a low-contrast
  *positional* jitter rather than a luminance flash, which is why reduced motion
  (`animation: none`) is the right answer to it and a lower opacity would not be.
- **THE TWO TELLS SHARE ONE VIGNETTE, COMPOSED WITH A CAP.** §6.4's vignette and
  §7.3's vignette are the same element. Two owners writing two inline styles on
  one element is a fight; `vignetteTell` sums them and caps the awareness share by
  whatever the breath floor has left, so the worst case is a dark screen and never
  a layer past opaque — which is where two overlaid alphas start cancelling.
- **PAUSE IS A FLAG, NOT A PHASE.** §10.5's reason applied to §14.3: a player who
  pauses during a capture's black has not invented a phase, so `PHASE` still has
  exactly four members (asserted) and `update()` returns *before* `animTime` moves.
  A paused frame routes `{ started: false }` — the title screen's frame, and the
  only moment in the game where nothing is playing — so a winded player's rasp
  goes to zero instead of holding its last gain for as long as they read the menu.
  Pointer-lock loss pauses one-way (it can never un-pause), with a 0.5 s grace
  window so the pause's own lock release cannot re-pause the game.
- **THE PAUSE CARD IS OVERLAY CHROME, NOT HUD.** §14.1's "no new text" is scoped
  to the HUD: the sigils, the counter, the ring, the tells. A menu that cannot say
  anything is not a menu, and §14.3 requires a *toggle*, which has to be a
  control with a name. So the HUD gains no text at all — asserted by grepping its
  JSX for text nodes and pinning the set to `{LOOP}` plus the `E` key-hint
  constant — and the card is a sibling of the title and win overlays.
- **THE v1 HEARTBEAT LINE AND THE FLAME SIGILS ARE GONE.** The heartbeat was a
  *countdown* and v2 has no countdown (slice 09 pinned it full); §9.2 counts
  captures in the counter's existing slot. Keeping either would have been keeping
  a v1 promise this game does not make. The start screen's control hints were also
  corrected: they said "light candles", which has been untrue since slice 04, and
  now name §5.2's two verbs and Esc.

### One real bug this slice found

**THE PAUSE WAS GOING TO *PERFORM* A SWING INSTEAD OF DROPPING IT.** `setPaused`
originally called `player.consumeSwing()` to clear a pending click. That is the
door that *fires* the swing callback, so opening the pause menu on the frame a
swing was queued would have banished something the player never aimed — and it is
invisible in the harness, because the world never sets `onSwing`. Found by
mutation testing, not by review: the explicit call was redundant with
`releaseAllKeys()`, which drops the flag without taking the edge, and the correct
fix was to **delete the call and assert its absence** rather than to add a test
that could not see it.

### Slice 12 — gate

- **Gate:** lint clean (three pre-existing `verify-world.mjs` unused-import
  warnings, one of them the `hud` import added for the parked block), **194/194**
  pure checks (up from 158 — a new "HUD and accessibility (v2 slice 12)" section,
  **36 checks**), `vite build` clean. `npm run check` exits 0.
- **Three gate-rippers the engineering council caught before they landed**, all of
  which would have failed `npm run check` and none of which is visible from the
  code: (1) a second `this.audio?.update(` in `world.js` breaks the slice-11 audio
  whitelist, which requires exactly one; (2) removing v1's `hudSnapshot` from
  `loop.js` breaks `verify.mjs`'s named import as a **link-time SyntaxError**,
  not a failed test; (3) a helper method whose name contains `_audioFrame(` breaks
  the check that the frame is built in exactly one place, because the regex
  matches inside `_pausedAudioFrame()`. The pause's audio is therefore handled
  *inside* `_audioFrame()`, and the count is still 2.
- **Nine world checks, validated in a scratch harness, 9/9 passing** — sigil state
  through a capture and a wipe; the ring closing on exactly 1.0 with its tick
  crossing on §5.2's frame and bleeding back off; pause freezing the creature, the
  player, every clock and the held keys; pointer-lock loss pausing one-way; the
  grace window; reduced motion suppressing bob, shake (both sides) and the finale
  ramp and restoring all three; the mirror's repaint budget; the awareness tell
  fed by the real meter and stopped by a banish. Parked in the same block comment
  as slices 10 and 11, transcribed from that run. The scratch harness is not
  committed.
- **Mutation testing: 6 of 7 caught.** Caught: never re-locking into a pause, not
  dropping held keys, a head bob that ignores the switch, an unquantized
  awareness, a shake banked while suppressed, a finale ramp that ignores reduced
  motion. The survivor is an **equivalent mutant** — dropping the `|| this.paused`
  guard in `_onLockChange` changes nothing, because `setPaused(true)` on an
  already-paused world is a no-op. The guard stays because it documents the
  intent and the pure gate pins its source.
- **The HUD was rendered and read, not just built.** No browser is available in
  this container, so `Hud` and `PauseOverlay` were rendered to static markup through
  `react-dom/server` in a throwaway Vite SSR bundle and the output inspected in
  four states (opening, mid-hold past the tick, reduced motion while hunted, and
  paused). That caught one real defect a static read had not: the grain layer was
  carrying a `hud--still` class, which worked but was wrong BEM, and is now
  `grain--still` on its own block. Confirmed in the markup: `A:dark/hollow B:lit/filled
  C:lit/filled` for one portal shut, `stroke-dashoffset` 40.59 of 106.81 at 0.62,
  `hud__ring-tick--passed` present, `--breath-amp: 0.000` under reduced motion,
  and the pause card reading `PAUSED | RESUME | REDUCED MOTION ON | ESC`. The
  scratch bundle is not committed.
- **The world harness's failure is UNCHANGED** — `1/12 world checks passed`, exit
  1, `SHRINE_IDS is not iterable`, identical to the slice 09/10/11 baselines. The
  new DOM calls are guarded so the constructor cannot throw on the stub
  (`typeof window.matchMedia === 'function'`, `document.removeEventListener?.()`),
  and the file header now records that the slice-12 parked block was written
  *with* a working harness, so slice 14 knows its nine checks are transcribed
  from a run rather than from a sketch.
- **Left for slice 13/16, deliberately:** the v1 title `THE BELL LOOP` and the win
  card's `THE BELL STOPPED.` are still v1's; §10.4's win text is "THE NEIGHBORHOOD
  WENT QUIET." and §0's working title is THE LONG QUIET, so the naming is a
  slice-13/16 decision, not an accessibility one. `winChord` is still called
  directly by `_win`, and the `searchExhausted`/`searchPosition` channels are
  still hardcoded, both carried forward from slice 11.
- **Known limit, stated rather than hidden:** the tells are levels, so their
  *appearance* — whether 34%→13% reads as "boxed in" and whether a 2.6× grain
  scale reads as "coarsening" — is a judgement only a screenshot can settle. Slice
  16's twelve captures are where that gets decided, and the numbers are all
  exported and asserted so moving one is a one-line change.

## Slice 13 — the finale and the win

The finale was *wired* before this slice and the plan knew it: `applyPortalHold`
has latched the flag since 05, `creatureStep` has had the enrage edge since 06,
the dusk step and the headlights are 09, §14.3's ramp is 12. So the slice is
mostly about the **seams** — one flag, four consequences, and the sentence the
plan asks for stated as facts — and about two things that turned out to be wrong.

### What changed in the rules
- **`FINAL_PORTAL_COUNT` + `triggersFinale(portals)`** (§10.1) as a named rule.
  "Only the third" is now a predicate over *all three* rather than a sentence
  inside `applyPortalHold`, and the flag stays latched (`next.finale ||`) so §9.1
  cannot be undone by a re-derivation.
- **`WIPE_TABLE` + `wipeRun(state)`** (§10.4), the mirror image of
  `CAPTURE_TABLE`. The claim "a wiped run is indistinguishable from a new one" is
  now provable: `deepEqual(wipeRun(dirty), createInitialState(...))` in the gate.
  `WIPE_EXEMPT_FIELDS` names the two anchors (§3.4 geometry, not progress), and
  the gate fails on any state field that neither table decides.
- **`portalsShut` is null-safe**, for the reason `isInsideExit` already was: both
  are asked a question by a caller holding a state it did not build.
- `openPortals()` / `zeroProgress()` / `FULL_BREATH` exist so the wipe and the
  constructor cannot disagree about what "open" or "full" means.

### Two real bugs this slice found
1. **THE FINALE HAD NO LOCOMOTION.** The world's walk was gated on
   `step.to === 'stalk'`, so **CHASE and ENRAGED never moved** — §10.2's 5.2 m/s
   was a number with nothing to spend it on, and the climax was a stroll to the
   car with an omniscient statue behind it. The pure module now owns the answer:
   `PURSUING_STATES = ['chase', 'enraged']` (asserted to contain every
   `CAPTURE_STATES` member — a state that can end a run must be able to move in
   it) and `pursuitTarget(creature, player)`, which sends ENRAGED at the player's
   *live* position and everything else at its evidence (heard → seen → player).
   **This also makes CHASE close for the first time**, which is a real difficulty
   change to Act II and is exactly what slice 15's simulation is for.
2. **THE WIN COULD RING MORE THAN ONCE.** `_win` had no guard, and a player
   standing in the exit car keeps satisfying the test on every frame. It now
   returns false if the store is already `PHASE.WON` (the store, not
   `this.phase`, which is only refreshed at the top of a frame).

### Smaller, deliberate
- `restart()` now wipes through `rules.wipeRun` rather than rebuilding with
  `createInitialState` — invisible at runtime, walkable by the gate — and
  clears two more pieces of run state that survived it: the per-portal §5.2
  sound windows and the per-portal hold readings.
- `restart()` re-requests the pointer lock. The win card is the one screen the
  player was never holding the lock on, so without it a new run starts
  un-walkable — the same gesture-lock reason §14.3 gives for RESUME.
- **Win text.** `THE BELL STOPPED.` → **`THE NEIGHBORHOOD WENT QUIET.`** (§10.4).
  The v1 line is gone from all of `src/`, and the gate now greps the whole tree
  to keep it gone; `loop.js`'s stale `PHASE.WON` comment went with it.
- The finale has **no audio row**, and that is a decision rather than an
  omission: §13's table is the design's list of sounds and a finale sting is not
  on it. The climax is heard as the last portal hum stopping. The win chord stays
  v1's and stays the one direct `audio.*` call the whitelist allows; `won` is
  still on the frame and still ducks the drone to v1's `DRONE_LEVEL_WON`.

### Gate
- **206/206 pure checks** (up from 194) — a new "The finale and the win (v2
  slice 13)" section, **12 checks**: the trigger over all eight portal subsets and
  three orders; the finale as a condition not a phase (`PHASE` still has four
  members); one flag read by four consequences; ENRAGED as a chase with the
  ceiling clamped under the sprint and `CAPTURE_RADIUS / gap` seconds of clean
  sprinting to leave contact; the flat 1.5 s window walked end to end
  (swing → stagger → dormant → back **enraged**); no phase-out in 60 s of
  silence while §8.2 still fires everywhere else; the win's phase/freeze/one
  chord; the wipe; the world's wiring; the headlights as a beacon
  (`_glow` sets `fog: false`, and the beam range is read out of the source and
  compared against `fogVisibility` at dusk 1); and the win card's text.
- **Mutation testing: 8 of 8 caught** — finale on the second portal, the purge of
  `PURSUING_STATES`, a dropped `WIPE_TABLE` row, a dead headlight beam,
  `restart()` running `applyCapture`, v1's line returning, ENRAGED walking at a
  stale memory, and headlights reading `false`. Each fails 1–4 checks.
- **Five world checks, validated in the scratch harness, 5/5** — and the first is
  the only check in the project that shuts the three portals the way a player
  does: walk the body to each anchor, hold E, let `applyPortalHold` fill, and
  watch the flag, the headlights and the creature's state after each one. Then
  the enrage and the 5.2 m/s actually spent on the ground, the beacons through
  the fog, the win (one chord, then nothing moves but the fade), and the full
  wipe. Parked in a new block with its own header.
- **A control run says the other four parked world failures are not mine.**
  Stashing this slice's three source files and re-running the scratch harness
  gives 24/31 instead of 27/31 — the same four slice-10 checks fail either way:
  the Act I apparition's title-screen pose, the telegraph's "gone when you look
  back", the phase-out check's `§9.2` assertion, and the creature view's folded
  position. Presentation expectations that drifted when slices 11–12 changed the
  world; **slice 14's backlog**, and left alone here because "fixing" an
  expectation about what a frame looks like, with no browser in this container,
  would be guessing.
- **A defect in slice 11's parked block, found by uncommenting it:** its last
  check (`dispose() stops the hums it started`) never closed its `})`. Invisible
  while commented, a parse error the moment slice 14 uncomments it. Fixed.
- **The world harness's failure is UNCHANGED** — 1/12, `SHRINE_IDS is not
  iterable`, the same baseline as 09/10/11/12. Slice 14 owns the repair; this
  slice must not change how it fails, and did not.
- **Left for slice 16, deliberately:** the title is still v1's `THE BELL LOOP`
  (and `index.html`'s og/twitter tags with it). §0's working title is THE LONG
  QUIET and the result README will name the run, so the naming is a slice-16
  decision; §10.4's win text was not, and it moved.
- **Not verifiable here:** whether the lit car reads as a beacon at 60 m through
  dusk-1 fog, and whether an enraged creature closing at 5.2 m/s is thrill rather
  than a coin flip. Slice 16's `finale-headlights` capture and slice 15's §11.3
  simulation are where those two get answered.

## Slice 15 — the balance simulation (§11.3 is the authority)

The harness landed in `498b13d` as a *report*: 232 runs, every table printed, one
check that printed it and asserted nothing. This slice is the half that makes it a
gate, and the report it printed on its first run is what found the bugs.

**The headline is that the game could not lose and could not be fought.** Sixteen
full runs, sixteen wins, **zero captures and zero connected swings across all of
them**, and a competent player that could not finish seed 8. §7.4's escalating
banish — the only thing in the game that makes it easier — had never fired once in
the branch's history, and §11.3's two trends were being measured on a creature
that was permanently present and permanently harmless.

### The three bugs, in the order the simulation found them

1. **THE CREATURE WALKED OUT OF THE MAP.** `creaturePosition` is canonical and
   `_walkCreature` moves it by `wrapDelta` deltas, so a chase across the seam
   walks it a whole `WORLD_EXTENT` out of the window the view draws it in. Seed 8's
   finale ended with `creaturePosition.x = -448.0` while the player's canonical x
   was `0.0` and the view origin was `(256, 256)`. `wrapDelta` correctly reported
   the two as *coincident*; `worldOf` drew the figure 448 m away on the far side
   of the map; and `distanceBetween` — a plain Euclidean, and the function the
   world uses for `CAPTURE_RADIUS`, `BANISH_RANGE`, the awareness meter's distance
   and §6.4's proximity breath — read 448 m of nothing. **508.2 s inside
   `BANISH_RANGE` of the player, zero captures, zero banishes, and a run that
   timed out instead of winning.** This is the fifth frame bug of the family (the
   other four are documented at `world.js`'s `_walkCreature`), and it is the one
   the harness's own `reachOf` disagreed with, which is how it was caught: the
   harness folds, the world did not, and a 0.0 m against a 448 m disagreement is
   not a rounding error.
   - **`hood.nearestImage(canonical, nearWorld)`** — new, pure, one place. The
     nearest image of a canonical point to a world point, `round` not `floor` so
     a half-period tie is stable, and **idempotent** so it can be applied every
     frame without drift. It returns a canonical coordinate that may sit a whole
     period outside the canonical window, which is deliberate: `nodeId` and
     `nearestIntersection` fold, so the graph is unaffected, and `worldOf`
     composes with it into the image nearest the player. The picture and the AI
     are now the same creature by construction.
   - **`world._recentre()`** now folds the creature with the map, once per frame,
     in the one place the wrap moves. `_capture` and `_wipe` call `_recentre()`
     instead of `streetView.recentre` directly, and `_wipe` teleports *first*, so
     the fold is taken against where the player actually is.
   - **Removed** the `BELL_DEBUG_CAPTURE` probe the previous pass left in
     `_updateCreature`, and deleted `scratch-bench.mjs`.
2. **§6.2'S SOUND TABLE WAS BEING READ AT ZERO METRES.** `player.js` says it
   outright — "The world owns the creature's position, so it owns the distance"
   — and every event it emits is `{kind, radius, position}`. `awarenessStep` reads
   `event.distance` with a default of `0`, and **nobody in `world.js` ever
   supplied one**. So a footstep was heard at full strength from anywhere in a
   448 m neighbourhood: a walk carries 9 m, a sprint 22, a toll 30, a shutdown 25,
   and all five were being applied at 0 m. The creature therefore knew where the
   player was from the first Act II footstep, which is §10.2's ENRAGED property
   handed to every state in the game. The trace shows it plainly: `AW
   walk@0/9 | seen=false range=16 dist=277.2 st=chase ->1.00`. This is the bug
   that made Act II *unmeasurable* rather than merely mis-tuned — the creature was
   permanently acquired, so §8.2's twelve-second valve always fired before it could
   cross the gap it had been given, and every encounter was 17 s of on-field inside
   a 19 s cycle with the thing 98 m away and closing nothing.
   - The fix is one `map` in `_updateCreature`, and the distance is measured from
     the **listener** (the creature's drawn copy) to the event, not from the player
     to itself — which is the mistake I made first, and which the report caught by
     not moving a single digit.
3. **THE COMPETENT POLICY NEVER SWUNG.** Not a game bug, and the most expensive
   one to find, because the game was working and the *player* was not. With
   hiding allowed from 34 m and fighting only inside 26 m, the competent player
   hid the whole way in: the meter decayed, the chase released, the creature
   walked to a position the player had already left, and it closed to 26 m exactly
   never. §6.2's table is a sprint at 22 m — the loudest thing in the game — and
   §11.1 never grants the creature more than 5.2, so sprinting from a chase buys
   0.8 m/s and a neighbourhood full of witnesses, forever.
### Every constant this slice tuned, before and after

| constant | before | after | why |
| --- | --- | --- | --- |
| `hood.nearestImage` | did not exist | new pure fold | the creature's frame; idempotent, nearest image |
| `world._recentre()` | folded the map only | folds the map **and** `creaturePosition` | once per frame, where the wrap already moves |
| `_updateCreature` sound events | no `distance`; read as `0` | `distance` = `wrapDelta` from the creature | §6.2's table is distances |
| `BELL_DEBUG_CAPTURE` probe | present in `world.js` | removed | debug scaffolding, not a feature |
| `FIGHT_RANGE` (harness) | 26 m | **22 m** (via 45) | the edge of §11.1's own detection table — inside all three pre-finale ranges so contact happens, and as close to that edge as possible so the wait is not on-field time |
| hide gate (harness) | `!fighting` (distance) | `!canFight` (the hammer) | a player holding the hammer has a better answer than silence |
| sprint gate (harness) | `plan.sprint && …` | `plan.sprint && (finale \|\| !canFight) && …` | §6.2's sprint is the *loudest* thing in the game; §10.2 is the one place it is the answer |
| `finaleRuns()` pose | `skipHammer: true`, "no hammer" | **hammer in hand** | §10.2: "banish still works … the hammer must stay relevant or Act II's whole skill ceiling evaporates at the climax". A finale with the hammer removed cannot fail *at* the hammer |
| `nearestCopy` (harness) | its own copy of the fold | `hood.nearestImage` | one definition, so the harness and the game cannot disagree by construction |
| `REEMERGE_DELAY_FLOOR` | 0.5 s | **0.5 s** (tried 1.5, reverted) | raised to give §8.2's valve real value; moved the third-2/third-3 share margin by 0.001, so it was reverted rather than committed as a change that buys nothing |
| `scratch-bench.mjs` | 53 KB at the repo root | deleted | the debug bench is not the gate |

Nothing in `creature.js`'s two ladders moved. `AGGRESSION_SPEED_STEP` 0.45,
`AGGRESSION_SIGHT_STEP` 2.0, `BANISH_TABLE` 8/12/16/20/24, `CHASE_MAX_SECONDS` 12,
`SPEED_CEILING` 5.2, `CAPTURE_RADIUS` 1.1, `BANISH_RANGE` 2.6,
`REEMERGE_MIN_GRAPH_DISTANCE` 2 hops, `REEMERGE_DELAY_CEILING` 6,
`ENRAGED_REEMERGENCE_SECONDS` 1.5, and §7.3's `BREATH_DRAIN_PER_SEC` 0.28 /
`BREATH_RECOVER_PER_SEC` 0.18 are all **unchanged**, and that is the finding rather
than an omission: every number the previous pass tuned was defensible and the game
was still unplayable, because the faults were in the *wiring between the tables*
and in which copy of the map a position was in.

One of those unchanged numbers is worth a note, because it looked like a tuning
target and is not. §10.2 promises 5.2 m/s is "deliberately just under the player's
6.0 sprint, so the gap is real and crossable", and `verify.mjs` asserts
`BREATH_DRAIN_PER_SEC > BREATH_RECOVER_PER_SEC` — recovery slower than drain. Those
two are mutually inconsistent: with a duty cycle of k = drain/recover > 1, the
*sustainable* average of a sprinting player is `(6.0 + 3.6k)/(1 + k)`, which is
**4.54 m/s** at the tuned 0.28/0.18 and can never exceed 6.0 for any k > 1. So the
gap is crossable for the first ~3.5 s of a sprint and not after, and the finale is
a sequence of sprint, catch, sprint. That is a real finding and the design's
premise is genuinely weaker than it reads — but the *fix* is not a breath constant,
because §7.3's hysteresis and `verify.mjs`'s "recovery must be slower than drain"
are both deliberate, and the measured answer turned out to be §10.2's other bullet
instead: a connected swing in the finale is 1.6 s of STAGGER plus
`ENRAGED_REEMERGENCE_SECONDS` and a §8.3 placement 90 m away — three seconds of
standing still for a block and a half of head start — which is why the competent
finale is now 0-for-8 on captures with the hammer in hand. **The hammer, not the
sprint, is §10.2's real escape valve**, and it was only measurable once the frame
was fixed. Left for the orchestrator to rule on: whether the breath duty cycle or
§10.2's 5.2 is the number that should move.

### What the gate asserts now, and what it measured

`TEMP balance report` is gone. In its place, **six permanent checks** and a shared
`pooledThirds()` that the report and the checks both read, so the printed table
and the gated numbers cannot drift:

| claim | before | after |
| --- | --- | --- |
| on-field share, thirds 1→2→3 | 0.830 / 0.888 / 0.908 **rising** | **0.945 / 0.849 / 0.829 falling** |
| on-field seconds per encounter | 17.0 / 17.2 / 25.6 | **178.6 / 83.0 / 73.1** (2.4x) |
| damage per encounter (pursuit m/s) | 3.47 / 5.13 / 5.10 | **1.54 / 2.55 / 4.62** |
| banish rung at encounter start | 0.00 / 0.00 / 0.00 | **0.06 / 0.80 / 2.11** |
| competent full runs | 7/8 won, seed 8 lost, 0 banishes in 5 seeds | **8/8 won, 0 captures, 2–6 banishes every seed** |
| competent finale | 1 capture in 8/8 | **0 captures in 8/8** |
| careless finale | 1–3 captures, won anyway | **1–2 captures in 8/8, never wins clean** |
| Act I reckless | 0 captures | **0 captures, and 0 `_capture` decisions** |
| re-emergences meeting §8.3 | 201 (35 in cone, 0 sighted) | 43 (5 in cone, 0 sighted, 0 under the hop floor) |

Trend 1 is asserted on **both** readings — the share, which is the stricter one
because the exposure has to fall faster than the cycle it is measured against, and
the raw on-field seconds, which is §11.3's own wording — and on **the mechanism**:
the rung the encounter began on has to climb, and runs that swung the hammer have
to show a lower share than runs that never did. A trend that holds while the ladder
sits still is a coincidence, and the previous pass's numbers were exactly that.

Trend 2 is asserted on the measured closing speed, monotonically, and against
`SPEED_CEILING * 0.85` — not `1.0`, because it is a mean over every frame spent
being pursued and a locked leg spends some of those turning a corner. The gate says
so in the assertion rather than quietly rounding it.

The finale check asserts what the measurement supports and **says what it does not**:
a runner is never caught and a walker is caught in most seeds and never wins clean,
and the runner is *not* reliably faster, because it spends its time on the hammer
and the walker spends its time being caught and §9.1 draws both from the same
budget. An earlier draft of that check gated on seconds-per-seed; seed 2 failed it
and the honest fix was to stop claiming it.

### Gate
- **207/207 pure checks** (up from 206) — one new check, `nearestImage puts a
  canonical point in the copy the player is nearest to`: idempotence over every
  node and ±periods, nearest-image-not-merely-nearer against an exhaustive
  one-period brute force, the half-period bound, and the player's own wrap being
  unable to change the answer.
- **43/43 world checks** (up from 39) — the one TEMP check became six, and the
  dead `actTwoEncounters` helper is gone, so `oxlint` is clean with no warnings.
- 232 runs in ~10 s, so the whole gate is still seconds rather than minutes.

### Honest limits of this slice
- **The harness plays three policies, not people.** The competent policy is a
  claim about how a competent player behaves — hold ground with the hammer, answer
  the thing, sprint only in the finale — and this slice had to *write* that claim
  before the trends existed, because the trends do not exist without it. It is the
  weakest link in the chain and the one slice 16 should be most suspicious of.
- **`FIGHT_RANGE` is a policy constant, not a game one.** The game's own
  `BANISH_RANGE` (2.6) and the three §11.1 detection ranges (14/17/20) bracket it,
  which is why 22 is defensible rather than arbitrary, but it is a *policy* number
  and a different policy would move the pooled thirds.
- **The third-2/third-3 share margin is 0.020.** The trend is monotone and the
  on-field-seconds margin is 2.4x, so the gate is not balanced on the thin edge —
  but the *share* specifically is held by a small number, because the first third's
  mean is dominated by a handful of very short phase-out cycles. Widening it means
  more Act II encounters per run, not a different constant.
- **Not verifiable here:** whether a 22 m stand-off reads as nerve or as a bug to
  a person holding a bell-hammer, and whether 0.945 → 0.829 is *felt* as the run
  getting easier. Slice 16's captures and a human play are where those land.

## Infrastructure notes (for reproducibility)


- tmux sessions die ~every 20–40 min in this container → abandoned tmux for slice execution.
- New protocol per slice: `cline -P cline -m stealth/space-bunny-alpha --auto-approve true "<slice spec, V2-PLAN.md is authority>"` as Hermes-tracked background process; on exit → orchestrator runs `npm run check` itself, pushes via credential helper, updates this log, launches next slice.
- Push auth: `git -c credential.helper='!f(){ echo username=zeke-cmd; echo password=${GH_TOKEN}; }; f' push origin cline/space-bunny-alpha` (GH_TOKEN from /work/.hermes/.env).
- `cline --id <session>` resume works and preserves context, but sessions balloon (340K+ input tokens, all cache reads, still $0.00 on Space Bunny Alpha). Fresh sessions per slice are cheaper and avoid stale-context drift; V2-PLAN.md + GAMEDESIGN.md on disk carry the design.
- chromium-browser here is a snap transitional stub (no real binary) → screenshot tooling for Phase C captures: investigate repo tools/shot.mjs browser discovery or npx puppeteer browsers install chrome-headless-shell when Phase B renders exist.

## Pending
- **Slice 16 is next, and it is the last one:** captures (title, entry, shrine, door, reset, pause, win, responsive, detail), `benchmark/templates/result-readme.md`, the deploy, the main catalog row. Nothing in the balance chain is left open.
- **Two design questions this slice raised rather than settled, for the orchestrator.** (1) §10.2's "the gap is real and crossable" is not true of a *sustainable* sprint — the breath duty cycle caps a sprinting player at 4.54 m/s against 5.2 — so either `BREATH_DRAIN_PER_SEC`/`BREATH_RECOVER_PER_SEC` or §10.2's 5.2 has to move, and `verify.mjs` currently pins "recovery must be slower than drain". (2) §16.3's open question "Should the finale banish re-emergence be 1.5 s or longer?" was measured and **1.5 s is right**: at 1.5 s the competent finale is 0-for-8 on captures, and the reason is not the delay but the §8.3 placement 90 m away, so raising the delay would only add dead time. Recorded here rather than changed, because both are design-table numbers and not this slice's to move.
- Slices 09–15 are landed; the branch is past the point of no return and reverting v2 means reverting one line in `App.jsx`. **Slice 14's brief is stale** — `verify-world.mjs` is repaired, in the gate, and now carries 43 checks. The slice-15 section above is the record of what the harness found once it could run, and three of those findings were in gameplay code rather than in the harness.
- Slice 07's open questions are now **measured**, not asserted: `REEMERGE_MIN_GRAPH_DISTANCE` = 2 hops (90.5 m), `AGGRESSION_SPEED_STEP` = 0.45, `AGGRESSION_SIGHT_STEP` = 2.0, re-emergence delay 6 s → 0.5 s asymptote, `HUNT_SECONDS_PER_ENCOUNTER` = 9 s, `ENRAGED_REEMERGENCE_SECONDS` = 1.5 s. The only one of the six that moved this slice is the delay floor, and it moved back to where it was.
- **Slice 13's warning turned out to matter more than it looked.** It said the §11.3 number to watch is `CAPTURE_RADIUS / (SPRINT - tier speed)` — 1.4 s of clean sprinting in the finale — and that is exactly the margin the finale runs on. It is asserted, and no tuning pass pushed a tier past the sprint.
- Vercel deploy: BLOCKED on Aditya auth — do not attempt without; everything else proceeds.
