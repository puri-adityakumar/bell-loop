# ITERATION 2 — THE LONG QUIET, second pass (20-pass loop)

Authority: this file + GAMEDESIGN.md. Branch: `cline/space-bunny-alpha`.
Protocol per pass N (the supervisor runs this; never skip a step):

1. **IMPROVE** — one Cline session implements the item marked `PASS N` below.
   Gate: `npm run check` green (add checks for new features), `vite build` clean.
   Commit: `iter2(N): <item label>`.
2. **REVIEW** — a second, independent Cline session reviews the commit
   (skeptic: is the item actually done, not gate-gamed? any design regression?).
   Writes `REVIEW-pass-N.md` with verdict APPROVED / FIXED / NOT-DONE.
   Small fixes allowed as a second commit: `iter2(N) review: fixes`.
3. **GATE** — `npm run check` must pass after review, else the loop halts.
4. **PUSH** — every pass is pushed before the next starts.

Hard rules for every pass:
- No external assets: everything procedural (geometry, WebAudio, canvas).
- No copyrighted audio: the music is an original evocation of the reference vibe.
- The screenshots must stay legible: the §16.5 luma gate is re-run every capture
  pass and gallery PNGs are replaced, never hand-edited.
- Every tuned constant gets a comment with its before/after.

## P1 — LIGHT: yellow-tinted cinematic dusk (the "can't see things" fix)
- [DONE] `PASS 1: Sky + fog retune toward amber-yellow haze.` skyStops/fogStops are
  violet-dark (0x2a2233/0x4a3550/0x12101a). Retune to warm sodium-amber dusk
  (Backrooms 67ktSmxCniA vibe: yellow haze, LIGHTER, still night-horror), raise
  hemisphere from 0.5, rework the exposure curve (0.95 − 0.17t is too punishing).
- [DONE] `PASS 2: Sodium light feels cinematic.` Broader warm pools (radius),
  warm bounce on walls/ground near lamps, lamp flicker stays. Fog should be a
  depth cue, not a wall: lower density close to lamps. Verify: street + title
  captures clearly brighter and amber; creature silhouette still reads.

## P2 — PORTAL: a black-hole disc, not a halo
- [DONE] `PASS 3: Portal look rebuild.` The floating cyan torus reads as a HALO.
  Rebuild as a true portal: near-black core disc filling the doorway, bright
  hot rim, slow swirl (shader or layered rotated geometry), keeps its cyan
  identity + ground apron. Dead portal = cold, dim, inert disc. Captures
  portal-located/shutdown must photograph the disc, not a ring.

## P3 — 3D FIDELITY (the bulk; reference: sakuragaoka-station)
- [DONE] `PASS 4: Aesthetic study.` Read the reference repo's world-building
  (https://github.com/Kenton-GMI/sakuragaoka-station): what makes its streets
  read as places. Write AESTHETIC-NOTES.md: concrete techniques to port
  (procedural only) + what we deliberately keep different (darker, emptier).
- [DONE] `PASS 5: Building depth.` Inset windows with emissive variance (some lit
  warm, most dark), door recesses + steps, roofline silhouettes (parapets, AC
  boxes), wall-mounted entry lamps. Buildings stop being flat extrusions.
- [x] `PASS 6: Street furniture I.` Telephone/power poles with catenary wires
  between them, traffic signs at intersections, hydrants, drain grates.
- [x] `PASS 7: Street furniture II.` Dumpsters, vending machines (one lit),
  trash bags, bollards, bus-shelter ad panels (dim). Place per district rules.
- [x] `PASS 8: Ground detail.` Faded center dashes, crosswalks at intersections,
  kerb joints, sidewalk seam lines, manholes, patch repairs (darker quads).
  Yard variety: different fence types per district.
- [x] `PASS 9: Vehicles.` Parked-car variety (hatchback/sedan/van profiles,
  muted colors), wheel arches instead of box wheels, one with hazards blinking
  far off. The exit car gets detail (mirrors, plate glow in headlight wash).
- [x] `PASS 10: Sky volume.` Gradient sky dome instead of flat background,
  faint cloud bands catching sodium glow, distant skyline silhouette ring
  (procedural boxes above fog line). Stars are absent (haze) — keep it that way.
- [x] `PASS 11: Materials pass.` Roughness/color variation per building (grime
  streaks under windows via canvas textures), asphalt wear, damp patches near
  drains. Canvas-generated textures are allowed (still no external assets).
- [x] `PASS 12: Composition pass.` Vary building setbacks/heights per district,
  sightline accents (a lit window at the end of an avenue), prune anything that
  clutters. Screenshot 3 avenues and judge them as photographs.

## P4 — SOUND: the world bed, then the music
- [x] `PASS 13: Sound I - the world bed.` Low continuous room tone (filtered
  noise + slow LFO, on the drone's own duck ladder); distant facility rumbles /
  clanks / thumps on a SEEDED 20-60 s schedule, placed in the world and panned +
  damped by distance; a wind layer whose level and brightness follow the drifting
  haze bands from pass 9; the portal hum's second distance channel (a lowpass
  that closes with range). All procedural, all seeded, all `kind: null` so the
  creature cannot hear them. The `setTimeout` ambience scheduler is gone: three
  cursor streams on the world's own `dt` replaced it, which fixes a bed that kept
  breathing through a pause and could not be asserted. No music in this pass.
- [x] `PASS 14: Sound II - the ambient music.` (was P4's two rows: the music
  route and its ducking table.) Slow pad progression over the bed, minor,
  whole-note chords at a 50-60 BPM feel, tape wobble + hiss, an occasional
  distant bell motif echoing the toll. Original synthesis evoking the reference
  video's mood — NOT the copyrighted track. Route-table rows + checks (audible
  while playing, ducked in chase, near-silent on win), and the routing must
  share the bed's bus discipline rather than sit beside it. Two rows
  (`music`, `musicMotif`) on a SEPARATE `GainNode` reaching the master, with a
  shared LIFETIME: `stopAmbient` tears the pad down as well. The pad is three
  detuned oscillators (sine/triangle/sine) through a 480 Hz lowpass with a
  0.011 Hz LFO and a two-rate (0.043/0.071 Hz) tape wobble, under a 2400 Hz
  hiss, moving through A natural minor's i-VI-III-VII at 54 BPM — one whole-note
  chord per 4.44 s, a pure function of `world.animTime` so the pause freezes the
  music with the simulation, and a seeded rotation so two seeds start on
  different chords. Ladder: `max(proximity, awareness)` over the breath's own
  30 m, 1.18 in the safe band and 0.30 at maximum threat, on the drone's own
  black/win rungs. Finale: `state.finale` latches, the music cuts in 0.12 s and
  one 41.2 Hz tone rises over 1.6 s from BELOW the ladder's gain, so the cut
  cannot take it; the world bed keeps breathing through it. Ceiling:
  `CREATURE_BREATH_LEVEL`, not the bed's — the music must stay under the
  awareness readout. Two deviations from the row, both documented in
  `AESTHETIC-NOTES.md` §8: the motif is a struck STRING and not a bell (§9 gives
  the bell to the player alone — it echoes the toll's envelope, never its
  inharmonic partials), and a "safe zone" is a STATE (nothing near, nothing
  aware) because a city that wraps on both axes has no safe rooms. The motif is
  a fourth row in `AMBIENCE_SPECS` (8-20 s) on pass 13's cursor machine rather
  than a second scheduler. No external audio, no CDN: `createOscillator`,
  `createBiquadFilter`, `createStereoPanner` and the shared seeded noise buffer.
  Captures are unchanged by design — the pass adds no pixels, so §16.5's luma
  gate has nothing new to re-justify; the evidence is a listener, not a PNG.

## P5 — POLISH + VERIFY
- [x] `PASS 15: Creature in the new light.` Silhouette/eyes read against amber
  fog in all states; per-state presentation retuned if the warmer fog washes it.
- [x] `PASS 16: Full capture refresh.` Re-run all 14 captures on the new look,
  luma floors re-justified, gallery replaced. Photographs must be legible.
- [DONE] `PASS 17: Performance + draw calls.` Budget check (draw calls, geometry
  count), instancing/merging where the fidelity passes added cost, 60 FPS
  headroom on integrated GPU class. Instrument: `npm run capture -- --budget`
  (live `renderer.info`) and `node tools/perf-census.mjs` (graph census, runs at
  any commit — `--tree bede4ed` for the slice-16 baseline). Measured: **draw calls
  70/256 at the avenue, 99/256 at the portal; triangles 294 140/400 000; programs
  19/48; `update()` 0.1 ms/4 ms p50.** Against the slice-16 baseline the fidelity
  passes 5.8x'd triangles and 4x'd instances for +73 objects. The one thing that
  was actually wrong was `skyView`'s forty-two-mesh silhouette ring, now one
  `InstancedMesh` over a unit box at an **unchanged 542 triangles** (calls
  111→70) and boxes equal to within float32 quantisation. 415 per-frame
  allocations removed from `lampsNear`, `_writeDebris`, the ash loop and the
  creature's haze/trail, plus 90 redundant buffer writes. Budget, breakdown, the
  things left alone and the things the instrument could not measure:
  `AESTHETIC-NOTES.md` §10.
- [x] `PASS 18: Game feel sweep.` Spawn framing, first-30-seconds pacing, sigil
  + HUD contrast against the brighter world, reduced-motion still respected.
- [DONE] `PASS 19: Debt sweep.` Fix top items from REVIEW-pass-*.md NOT-DONE
  notes, remove dead code from replaced systems, doc comments match reality.
  **Closed, and the honest accounting of what each item cost is in the commit.**
  The five from the ledger: (1) pass-15's probe reproducibility was fully
  addressed by pass 16's `anchorClock` and re-measured four ways — every
  world-time field bit-identical between repeat runs, only rasterised luma
  moving, by 0.13-1.18 points; the ±0.3 claim is gone from the tree and the
  residual is a property of the rasteriser, not of the harness. (2) pass-17's
  "bit-identical" triangle claim is corrected at all three sites and **held** by
  the pass-17 review's own check, which recomputes the residual and fails if
  either phrase returns. (3) the first-30s pacing gate, in the form the pass-18
  review said was the only one available without a design decision: **the ORDER
  of the opening beats — control and the sighting together on the first frame of
  PLAYING, the dissolve lifting on or after that frame — and no durations at
  all** — an order is a property of the world, a duration is a property of a
  design the design has not written down. (The pass first wrote this line as
  "title-dissolve → spawn-control → first telegraph", which is the reverse of the
  contract the gate asserts; see `REVIEW-pass-19.md` Finding 2. The gate asserts
  the order as a relation between FRAMES, after the pass-19 review measured all
  three beats first reading true on the same frame.) It builds its own world rather than
  using `restart()`, because §10.4's BEGIN AGAIN is a new *begun* run and cannot
  produce the title-card preconditions. **Pass-19 review:** the ordering
  assertion was rewritten — the pass collected the beats into a `seen` array and
  `deepEqual`'d it, which on a world where all three beats read true on the SAME
  frame (measured: frame 0, all three) returns the order the harness's own `if`
  statements are written in, so M3's RED proved the literal was compared and
  nothing about the world. It is now a relation between FRAMES
  (`at.control === at.sighting`, `at.dissolve >= at.control`) — strictly tighter
  than the array, and a sequence a same-frame world cannot fake. The check's own
  name, which asserted the exact reverse of its contract, is corrected too; see
  `REVIEW-pass-19.md` Findings 1-2. The review's 15.93 s walking-forward
  stretch is **re-measured and printed** on every run rather than asserted
  against, because a debt nobody can re-measure quietly stops being true. (4)
  the presentation-vs-simulation coupling is **documented, not decoupled**, with
  the candidate-A numbers, in `GAMEDESIGN.md` §16.6.1: `SPAWN.position` is a
  simulation constant and not a framing knob, pass 18's move cost 112→110→108 of
  112, the 2.50 m `toEdge` that let the candidate through is named as the weaker
  invariant, and the retracted framing numbers (5.09 m nearest lamp behind the
  camera, the 15.4 m "wall" that is a `POLE_DIAMETER` footprint with
  `occluders()` OPEN) are recorded. (5) dead code: a full sweep of every export
  and every top-level binding in `src/`, `capture/`, `tools/` and `benchmark/`,
  cross-read against both harnesses, found **one** provably dead item —
  `capture.js`'s `allProbeSteps`, whose docblock claimed the pass-15 contract
  check walked it and which nothing walks. Deleted. The sweep is *documented
  below* because a "nothing is dead" claim is a claim, and the sweep that
  supports it is not re-derivable from a reader's seat. (6) doc comments
  match reality: **six false or stale docblocks corrected, no code reformatted.**
  `skyView.js`'s header still argued "WHY NO INSTANCING" three lines above a
  42-mesh→1-`InstancedMesh` rewrite; `hud.js` credited the sigil plate to PASS 1
  when PASS 18 painted it; `audio.js`'s header said "Three new rows" over four
  (and the fifth pass-13 stream, `gust`, has no routed row at all);
  `capture/main.jsx` claimed `stepWorld`'s "only caller" was `wait` or `frames`
  when there are five. **No pixels changed, so the gallery was not re-shot** —
  §16.5's luma gate has nothing new to re-justify, and re-shooting 14 frames to
  re-justify a comment edit is the failure mode this pass exists to prevent.
  Gate: 306 pure + 113 world (the pacing gate is the one addition; nothing was
  weakened, retuned or deleted).

## P6 — CLOSE
- [DONE] `PASS 20: Iteration 2 close-out.` ORCHESTRATOR-LOG iteration-2 section,
  result README updated (gallery, notes), AESTHETIC-NOTES finalized, deploy
  checklist for the orchestrator (space-bunny-v2 project). No new features.
  **Documentation and records only: four `.md` files, no `src/`, no `capture/`,
  no capture re-run, no pixel moved.** Written: the log's iteration-2 close-out
  (20 passes, the 43-commit chain `1a444f8`→`c32d294`, the gate ladder
  **203+47 → 306+113**, the nine reviewer findings, $0.00 on Space Bunny Alpha);
  the README rewritten to the iteration-2 state (feature list, controls, run
  instructions, `space-bunny-v2` deploy placeholder); `AESTHETIC-NOTES.md`
  finalized as the iteration-2 authority record with the two deviations recorded
  honestly (§11.1 spawn framing unshippable, cross-referenced to `GAMEDESIGN.md`
  §16.6.1; §11.2 the gallery is not byte-reproducible) and the §1 orphan repaired;
  and the exact Vercel recipe appended to the log for the orchestrator
  (`vercel link --project space-bunny-v2` → `vercel deploy --prod --yes` → SSO
  disable `PATCH` → Hobby author note). **Pass 20 did not deploy**; the recipe is
  for the orchestrator, which holds the credentials. Gate unchanged at
  **306 pure + 113 world**, `vite build` clean — as it must be for a pass that
  changed no code. **Iteration 2 is complete: 20/20.**

## Orchestrator notes
- Loop supervisor: `tools/iteration2-loop.sh` (halts on gate fail or repeated
  cline auth failure; logs to `iteration2.log`).
- The orchestrator reviews screenshots at checkpoints and may inject course
  corrections between passes; Cline implements, reviewer verifies.
