# LOOPLOG — THE BELL LOOP improvement series

## LOOP 1 — Atmosphere pass
FIXED/CHANGED:
- Darker horror palette (bg/fog/wall/floor/ceiling/wood/brass/cold all shifted colder+dark) in `src/game/world.js` PALETTE and mirrored CSS vars in `src/ui/styles.css`, `src/index.css`, `index.html` theme-color
- FogExp2 density 0.095 -> 0.135; exposure 1.1 -> 0.92; hemisphere light colder and dimmer
- Heavier film grain (0.05 -> 0.09), tighter/darker vignette, new cold desaturation wash layer (`.desat`, mix-blend-mode: saturation) in `src/ui/styles.css` + `src/App.jsx`
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: 48e21d5

## LOOP 2 — Shrine models
FIXED/CHANGED:
- Rebuilt `_buildShrines` in `src/game/world.js`: chipped stone pedestal (beveled 4-sided plinth, fluted 6-sided column, collar, irregular 7-gon cap), iron drip dish + holder ring, wax candle with procedurally placed drips/blobs down the side (seeded per-shrine), stone bump-map shading
- Cold glimmer / flame / halo / candle-light all re-anchored to the new candle height
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: 63a30e3

## LOOP 3 — The Door
FIXED/CHANGED:
- Rebuilt `_buildDoor` in `src/game/world.js`: arched stone frame (jamb boxes + 9 radial voussoirs + oversized keystone, stone bump material), iron-banded double door (two hinged leaves, iron bands, brass ring handles)
- Door now opens AJAR (DOOR_AJAR_SWING=0.12, both leaves swing outward symmetrically) when unlocked; warm light leak: thin emissive crack sliver + breathing point light through the gap; swings fully wide in `_win()`; `restart()` resets the wide flag
- `_setDoorOpen`/`_updateDoor`/`_applyDoorSwing` reworked for the double hinge
- Note: `verify-world.mjs` (headless world smoke test) fails 4/12 — verified pre-existing on pristine baseline commit 8b3c3b9 (stale harness vs current world API), unrelated to this series; the task gate (verify.mjs + build) is what is tracked per loop
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: 6ea0d66

## LOOP 4 — Wall materials
FIXED/CHANGED:
- New `makeBrickTexture` in `src/game/world.js`: procedural dark stone-brick tile (offset rows, recessed mortar lines, per-brick value variation, chips, grime speckle, damp streaks)
- Wall material now uses the brick tile as `map` + `bumpMap` (mortar recesses read in relief); noise tile kept as roughness variation
- Per-instance tint upgraded from grayscale jitter to RGB value + warm/cool drift (`tintR/G/B`) so walls no longer read as clones
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: e759cf2

## LOOP 5 — Floor and ceiling
FIXED/CHANGED:
- `makeFloorTexture` replaced by `makeCobbleTexture` (procedural cobblestone: jittered rounded stones, worn highlights, seated shadows, dust speckle) used as map + bumpMap on the floor in `src/game/world.js`
- Ceiling now dark planks via new `makePlankTexture` (board seams, grain streaks)
- Dark wooden ceiling beams every 3 cells, both orientations (shadow-casting, noise-bumped)
- 6 hanging chains: curved TubeGeometry segments with sag from the ceiling (one anchored in the entrance cell and one in the centre chamber, which are always open; 4 seeded positions elsewhere)
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: c8d1b9c

## LOOP 6 — Flashlight rework
FIXED/CHANGED:
- Flashlight rebuilt in `src/game/world.js`: warmer colour (0xffdca0), wider cone (0.5), deeper penumbra (0.62), softer decay (1.8); documented as the scene's single shadow-casting light
- Battery behaviour: irregular brown-out dips in the last 8s of a loop (flickerNoise-driven, deepening with danger), a post-toll dip at reset start, smooth exponential intensity recovery, and a colour that cools as it dims
- Lag-follow cone retained and tuned
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: dd5ade3

## LOOP 7 — Candle flames
FIXED/CHANGED:
- New `makeFlameSpriteTexture` (procedural teardrop glow) in `src/game/world.js`; the stretched-sphere flame replaced by 3 layered additive sprites per shrine, each bobbing/swaying at its own frequency, opacity+scale driven by the flicker field and the ignite ramp
- Point light now pulses both intensity AND radius (`flameLight.distance` breathes 7.4..8.8)
- Ember particles: 12-point Points cloud per shrine rising from the wick with lateral drift and recycle; simulated + visible only while lit
- Unlit candles read waxy-dead: greyer duller wax (0x57554e), roughness 0.88 vs lit 0.62
- `_applyShrineStates` / `_lightShrine` / `_updateShrines` updated for the flames array + embers
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: ff46f6c

## LOOP 8 — HUD redesign
FIXED/CHANGED:
- `src/ui/Hud.jsx`: candle dots replaced with SVG flame sigils (outline flame + inner core + wick) that ignite with a flicker animation when a shrine is lit
- Timer bar replaced with a thin failing-heartbeat SVG trace: retracts with the timer, stroke colour interpolates bone→blood red with `danger = 1 - timeFraction`, glow widens, and a `hud__timer--critical` throb (scaleY/opacity pulse) below 18% time
- Loop counter re-typeset: thin letter-spaced uppercase, negative margin re-centering
- `src/ui/styles.css`: `.flame-sigil` block, `sigil-flicker` + `heartbeat-throb` keyframes, heartbeat trace styles
VERIFY: PASS (33/33) | BUILD: PASS | COMMIT: e7fca73
