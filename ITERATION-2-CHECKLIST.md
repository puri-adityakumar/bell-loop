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
- [x] `PASS 17: Performance + draw calls.` Budget check (draw calls, geometry
  count), instancing/merging where the fidelity passes added cost, 60 FPS
  headroom on integrated GPU class.
- [x] `PASS 18: Game feel sweep.` Spawn framing, first-30-seconds pacing, sigil
  + HUD contrast against the brighter world, reduced-motion still respected.
- [x] `PASS 19: Debt sweep.` Fix top items from REVIEW-pass-*.md NOT-DONE
  notes, remove dead code from replaced systems, doc comments match reality.

## P6 — CLOSE
- [x] `PASS 20: Iteration 2 close-out.` ORCHESTRATOR-LOG iteration-2 section,
  result README updated (gallery, notes), AESTHETIC-NOTES finalized, deploy
  checklist for the orchestrator (space-bunny-v2 project). No new features.

## Orchestrator notes
- Loop supervisor: `tools/iteration2-loop.sh` (halts on gate fail or repeated
  cline auth failure; logs to `iteration2.log`).
- The orchestrator reviews screenshots at checkpoints and may inject course
  corrections between passes; Cline implements, reviewer verifies.
