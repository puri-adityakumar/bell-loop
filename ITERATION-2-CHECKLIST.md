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
- [x] `PASS 5: Building depth.` Inset windows with emissive variance (some lit
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

## P4 — MUSIC
- [x] `PASS 13: Ambient music route.` New MUSIC route in AudioManager: slow pad
  progression over the drone (minor, whole-note chords ~50-60 BPM feel), tape
  wobble + hiss, occasional distant bell motif echoing the toll. Original
  synthesis evoking the reference video's mood — NOT the copyrighted track.
- [x] `PASS 14: Music integration.` Ducking table (chase/capture/win), level
  routing through the same bus discipline as the drone, route-table rows +
  checks (audible while playing, ducked in chase, near-silent on win).

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
