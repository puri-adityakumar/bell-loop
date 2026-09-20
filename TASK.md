# TASK: "THE BELL LOOP" — a spooky temporal maze game (Vite + React + Three.js)

You are building a complete, working browser game autonomously. You will not receive
answers to questions — every decision you need is in this file, and where something is
unspecified you decide, note the decision in PROGRESS.md, and keep moving.

## What the game is

A first-person 3D horror maze. The core twist: **the maze resets every 60 seconds** (a
bell rings, walls slide to new positions, the player is returned to the entrance), but
the rearrangement is **deterministic per loop number** — observant players learn the
pattern. Three candle shrines are hidden in the maze; light one per loop and they STAY
lit across resets. Light all three → on the next loop, the exit door at the maze's
center stands open. Walk through it → win screen: "THE BELL STOPPED."

That is the entire game. No monster, no death, no inventory, no tutorials, no text
beyond the win screen and a minimal loop counter.

## Deliverables (in order)

1. `PLAN.md` — think through the best possible approach before writing game code. It
   must have these SEPARATE sections:
   - **Stack & architecture**: Vite + React 18 + Three.js. React handles UI shell
     (start overlay, win overlay, loop counter, candle indicator), a vanilla
     Three.js world runs in a canvas managed by one React component. Game state
     lives in a plain mutable store (NOT React state) — React only subscribes to
     the few values it renders (loop number, candles lit, phase).
   - **Assets (all procedural — zero downloaded files)**: describe exactly how each
     looks and how you build it: walls (InstancedMesh, color, roughness), floor,
     ceiling, flashlight cone + fog settings, candles (geometry + point light +
     flame flicker), shrines (small pedestal + unlit candle), the exit door
     (geometry + open animation), bell transition effect (screen fade + camera
     reset), win screen styling. Include a palette (bg, fog, wall, wood, candle
     flame, UI text) with hex codes.
   - **Theme music & sound (WebAudio, all synthesized)**: bell toll (layered sine
     partials + exponential decay), ambient drone (2 detuned oscillators, lowpass,
     very quiet), footstep ticks, candle-light whoosh, door creak, win chord.
     One AudioManager class, master gain, all started after first user click
     (autoplay policy).
   - **Game mechanics spec**: grid maze generation (seeded PRNG, e.g. mulberry32,
     seed = loop number, recursive backtracker on a 15x15 cell grid with some loops
     carved for multiple routes), wall phase rules (which walls shift and how the
     seed changes each loop — MAKE THE PATTERN LEARNABLE: document the rule you
     choose), candle placement per loop (deterministic, 3 distinct zones), player
     controller (pointer lock, WASD, capsule vs AABB wall collision), flashlight
     (SpotLight attached to camera with lag), loop timer (60s, shown only as a
     thin depleting bar), bell event sequence, candle lighting (proximity + E key
     or click), persistence store across resets, door unlock + win trigger,
     restart. Difficulty: a first-time player wins in ~5 minutes on loop 5–6.
2. `PROGRESS.md` — append a dated entry after every work session describing what you
   did and what's next. Keep it current — your orchestrator reads this.
3. The working game: scaffold with `npm create vite@latest bell-loop -- --template
   react` inside the CURRENT directory, `npm install`, `npm i three`. Organize as
   `src/game/` (world.js, maze.js, player.js, audio.js, loop.js) + `src/App.jsx` +
   `src/ui/`. If scaffolding fails, create the project structure by hand.
4. `npm run build` must pass with ZERO errors. Then `npm run dev` and verify the dev
   server serves the page (curl the HTML, check it contains the root div and script
   tag). You cannot click the game yourself — instead write a tiny `verify.mjs` node
   script that imports your core pure modules (maze generation, seed logic, candle
   placement) and asserts their behavior (maze is solvable for loops 1..8, candle
   zones are distinct, pattern repeats as documented). Run it with `node verify.mjs`.

## Working rules

- Work in Plan→Act cycles yourself: plan a phase in PLAN.md, implement it, verify,
  append PROGRESS.md, continue. Suggested phase order: scaffold → maze + collision +
  first-person movement → loop timer + bell reset + seeded reshuffle → candles +
  persistence + door + win → audio → polish (grain, fog tuning, UI).
- If you hit a free-tier rate limit, wait by doing useful local work (writing files,
  running builds), then retry the same step. Never abandon a step because of one
  failure — retry at least 3 times before rethinking the approach.
- If genuinely blocked (can't proceed at all), write the exact blocker to BLOCKED.md
  with what you tried, then continue with any other part of the task that doesn't
  depend on the blocker. Do not stop and wait.
- Do not ask the user anything. All decisions are yours; log the important ones.
- Final message: summarize what works, how to run it (`npm run dev`), and any known
  gaps.

Definition of done: `npm run build` exits 0, `node verify.mjs` passes, dev server
serves the page, PROGRESS.md tells the story, game implements every mechanic above.
