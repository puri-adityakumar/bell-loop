# THE BELL LOOP

A first-person temporal horror maze built with **Vite + React + Three.js**. You are
trapped in a shifting labyrinth where a bell tolls every 60 seconds: the walls slide to
new positions and you are returned to the entrance. But the rearrangement is
deterministic per loop number — observant players learn the pattern. Three candle
shrines are hidden in the maze; light one per loop and they stay lit across resets.
Light all three and, on the next loop, the exit door at the maze's center stands open.
Walk through it to win: **"THE BELL STOPPED."**

Everything in the game is procedural — geometry, textures, and all audio (bell toll,
ambient drone, footsteps) are synthesized at runtime. No external assets.

## Run

```bash
npm install
npm run dev       # dev server
npm run build     # production build -> dist/
node verify.mjs   # headless logic checks (33/33: maze solvability, candles, store, scripted run)
```

## Controls

- **WASD** — move
- **Mouse look** — click to lock the pointer
- **E** (or click) — light a candle when near a shrine

## Win condition

Light 3 candles across bell loops. They persist through resets. Once all three are
lit, the next loop's bell opens the center door — walk through it.

## Stack

- Vite + React 19 (UI shell: start overlay, HUD, win screen)
- Three.js (first-person 3D world in a canvas, vanilla game loop)
- WebAudio (all sounds synthesized)
- Seeded PRNG (mulberry32) for deterministic per-loop maze layouts

Built autonomously by [Cline](https://github.com/cline/cline). See `PLAN.md`,
`TASK.md`, and `PROGRESS.md` for the full story.
