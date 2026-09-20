# PLAN.md — THE BELL LOOP

A first-person 3D horror maze. The maze resets every 60 seconds (bell tolls, walls
shift, player returns to entrance). The rearrangement is **deterministic per loop
number**. Three candle shrines; once lit they stay lit across resets. Light all
three -> next loop the exit door at the maze center stands open. Walk through ->
"THE BELL STOPPED."

---

## 1. Stack & architecture

- **Vite + React 18 + Three.js** (pinned: react/react-dom ^18.3.1, three latest,
  vite + @vitejs/plugin-react).
- **React = UI shell only.** It renders: start overlay, win overlay, loop counter,
  candle indicator, thin timer bar, fade-to-black layer, grain/vignette layers.
- **One React component** (`GameCanvas`) owns a `<div>` ref and mounts a vanilla
  Three.js world (`new BellLoopGame(container)`) exactly once in `useEffect`.
- **Game state lives in a plain mutable store** (`src/game/loop.js`,
  `createStore()`): `{ phase, loop, timeLeft, candles:{A,B,C}, doorOpen, fade }`.
  NOT React state. Store has `get()/set(patch)/subscribe(fn)`. React subscribes
  and re-renders only the cheap HUD values (loop number, candles lit, phase,
  timeLeft for the bar, fade opacity).
- The simulation loop (`requestAnimationFrame`) lives in `world.js`
  (`BellLoopGame.tick`) and drives: player movement, loop timer, wall/shrine/door
  animation, flashlight lag, flame flicker. It writes to the store; it never
  touches React.
- **Pure modules stay DOM/three-free** so `verify.mjs` can import them in node:
  `maze.js` (PRNG, maze gen, zones, shrine placement, BFS solvability) and the
  pure reducers of `loop.js` (`createInitialState`, `applyLightCandle`,
  `shouldDoorOpenAtLoopStart`, `LOOP_SECONDS`).

### File layout

```
src/main.jsx            react entry (template)
src/App.jsx             shell: subscribes to store, renders canvas + UI
src/ui/Hud.jsx          loop counter, timer bar, candle dots, fade layer
src/ui/StartOverlay.jsx title + click-to-begin (pointer lock gesture)
src/ui/WinOverlay.jsx   "THE BELL STOPPED." + restart
src/ui/styles.css       palette-driven styling, grain, vignette
src/game/maze.js        mulberry32, generateMaze(loop), zones, BFS  [pure]
src/game/loop.js        createStore, pure reducers, reset timeline   [pure core]
src/game/player.js      pointer-lock FPS controller, capsule-vs-AABB
src/game/world.js       Three.js scene: walls/floor/ceiling/shrines/door,
                        flashlight, fog, bell-reset animation, win check
src/game/audio.js       AudioManager: all synthesized WebAudio
verify.mjs              node assertions over pure modules
```

---

## 2. Assets (all procedural — zero downloaded files)

**Palette**

| role         | hex       |
|--------------|-----------|
| bg / void    | `#05060a` |
| fog          | `#070a12` |
| wall stone   | `#2a2f3a` |
| floor        | `#14171f` |
| wood (door, pedestals) | `#4a3320` |
| candle flame | `#ffb347` (light `#ff9a3c`) |
| UI text      | `#d8cfae` |
| brass accent | `#8c7a3f` |

- **Walls**: one `InstancedMesh` of `BoxGeometry(cellSize, wallHeight,
  wallThickness)` (and the rotated twin), `MeshStandardMaterial` wall color,
  roughness 0.93, metalness 0.0. Per-instance color jitter (±6% lightness) via
  `setColorAt` so runs of wall don't read flat. A shared procedural
  `CanvasTexture` (128px value-noise, grayscale, used as a subtle bump/roughness
  variation map) keeps them from looking like plastic. castShadow/receiveShadow.
- **Floor**: big `PlaneGeometry`, floor color, roughness 1.0, with a procedural
  256px canvas texture of dark stone tiles (grid lines + noise), repeated over
  the maze footprint. receiveShadow.
- **Ceiling**: plane at wall height, near-black (`#0a0c12`), roughness 1 —
  closes the space so the flashlight matters.
- **Flashlight cone + fog**: `THREE.FogExp2(#070a12, 0.10)` -> view distance ~7
  cells. `SpotLight(#ffe6b0, 60, distance 30, angle 0.46, penumbra 0.55, decay
  2)` parented at the camera position; its `target` lerps toward the camera's
  forward point with exponential damping -> the "lag". castShadow, 1024 map.
  Plus a whisper of `HemisphereLight(#1a2233, #05060a, 0.25)` so unlit wall
  faces aren't pure black.
- **Candles**: `CylinderGeometry` body (ivory `#e8ddc8`), flame = small
  `SphereGeometry` squashed, `MeshBasicMaterial(#ffb347)` (emissive look without
  bloom), plus a `PointLight(#ff9a3c, 14, 7, 2)`. Flicker: per-frame intensity =
  base * (0.82 + 0.18 * valueNoise(t * speed + offset)) and flame scale wobble.
  Unlit shrine: flame hidden, light off, candle wax greyed.
- **Shrines**: squat pedestal — stacked cylinders (base radius .45 h .18, shaft
  radius .28 h .55, cap radius .4 h .1) in wood/stone — with the candle on top.
  A faint cold glimmer (`#334`, tiny PointLight intensity 1.2 dist 2.5) marks
  unlit shrines so they're findable in the dark but clearly "off".
- **Exit door** at center cell: two door-post boxes + lintel (wood), and a door
  panel `BoxGeometry(1.6, 2.3, 0.12)` hinged at one post (pivot via a `Group`
  offset). Closed: flush. Open animation: `rotation.y` eases 0 -> -1.85 rad over
  ~1.6 s with the door creak; a warm `PointLight` + emissive plane behind the
  doorway sells "beyond".
- **Bell transition effect**: CSS fade layer (opacity = store.fade) to full
  black over ~0.6 s while 3 bell tolls play; old walls sink into the floor
  (instanced Y offset) during fade-out; maze swaps at peak black; new walls rise
  with a stagger ripple keyed by distance from the entrance during fade-in;
  camera teleports to entrance, yaw reset.
- **Win screen**: full-viewport overlay, bg radial-gradient from `#1a1408` to
  `#05060a`, text "THE BELL STOPPED." in Georgia serif, letter-spacing .5em,
  color #d8cfae, slow fade-in animation, small brass "BEGIN AGAIN" button.
- **Grain/vignette**: vignette = CSS radial-gradient overlay; grain = inline SVG
  `feTurbulence` data-URI tile with a steps() keyframe jitter, opacity .05.

---

## 3. Theme music & sound (WebAudio, all synthesized)

One `AudioManager` class (`src/game/audio.js`). The `AudioContext` is created
lazily and `resume()`d on the first user click (start overlay) to satisfy
autoplay policy. Signal path: every voice -> per-voice gain -> **master gain**
(0.9) -> `DynamicsCompressor` (tames bell peaks) -> destination.

- **Bell toll**: layered sine partials of a struck bell — hum `0.5f`, prime
  `f`, tierce `1.19f`, quint `1.5f`, nominal `2f` (f = 220 Hz) — each with its
  own gain (hum .5, prime 1, tierce .35, quint .25, nominal .45) and an
  exponential-decay envelope (`setTargetAtTime` to 0, tau 1.6–2.8 s, longer for
  low partials), plus a 30 ms filtered-noise "strike" click. The reset sequence
  rings 3 tolls spaced 0.7 s.
- **Ambient drone**: 2 oscillators (sine 55 Hz, triangle detuned +~3 cents) ->
  lowpass 180 Hz (Q 0.7) -> gain 0.045. A 0.05 Hz LFO wobbles the filter cutoff
  ±40 Hz. Starts after first click, runs forever, very quiet.
- **Footstep ticks**: every 1.7 m traveled — 90 ms bandpassed noise burst
  (center 700–1000 Hz randomized, Q 2) + 60 ms sine thud at 75 Hz, fast attack,
  0.06 s decay, volume 0.10.
- **Candle-light whoosh**: noise buffer -> bandpass sweeping 300 -> 2400 Hz
  over 0.45 s, gain 0 -> 0.25 -> 0.
- **Door creak**: sawtooth 90 -> 55 Hz over 1.4 s through a peaking filter
  (700 Hz, Q 8, wobbling for stick-slip), gain 0.12, plus short noise scrapes.
- **Win chord**: sines C4/E4/G4/C5 (261.6/329.6/392/523.3), attack 0.8 s,
  release 4 s, gain 0.18 each, detuned shimmer octave; drone ducks out.


---

## 4. Game mechanics spec

**Constants**: grid 15x15 cells, cellSize 3.0 m, wallHeight 2.8 m, wall
thickness 0.34 m. Maze centered on origin. Entrance = cell (0,0) corner, exit
door = center cell (7,7). `LOOP_SECONDS = 60`.

**Maze generation (seeded)** — `generateMaze(loopNumber)`:
- PRNG = `mulberry32(loopNumber)` — **seed IS the loop number**.
- Recursive backtracker (iterative stack) from (0,0) over the 15x15 grid ->
  perfect maze (fully connected, 224 carved passages).
- Then carve **14 extra random internal walls** (never the boundary) -> loops
  in the graph and multiple routes.
- Output: cell wall flags + flat wall-segment list (AABBs for collision,
  matrices for the InstancedMesh).

**Wall phase rules — THE LEARNABLE PATTERN (chosen & documented)**:
1. *Same loop number => same maze. Always.* `generateMaze(3)` is byte-identical
   on every run. When the bell rings and loop N+1 begins, **all** walls
   reshuffle to maze(N+1); on game restart the sequence maze(1), maze(2), ...
   replays exactly. A replaying player learns "loop 1's layout", then "loop
   2's", etc.
2. *Shrine zones are stable*: every loop hides exactly one shrine in each of 3
   fixed zones — **NW quadrant (rows 0–6, cols 0–6), NE quadrant (rows 0–6,
   cols 8–14), South band (rows 8–14, all cols)**. The cell inside the zone is
   seeded per loop; the zone rule never changes. Learning "one per zone"
   halves the search space.
3. *Constants*: entrance corner and center exit door never move; nothing spawns
   within 2 cells of either.

So the pattern = fixed sequence of mazes + fixed zone rule + fixed landmarks.

**Candle placement per loop (deterministic)**: after maze gen, the same PRNG
stream picks one random candidate cell per zone (excluding entrance, center,
and their 8-neighborhoods). Shrine IDs `A, B, C` map to zones NW, NE, S —
shrine identity persists across loops even though its cell changes per loop.

