# TASK-ITERATE: 15 improvement loops for THE BELL LOOP

You will run exactly 15 improvement loops on this game. Each loop: improve ONE thing,
verify, build, commit, log. No loop may skip verification. You work alone — no
questions, all decisions yours.

## Loop protocol (repeat 15 times)

1. Pick the next item from the ROADMAP below (in order; if an item turns out
   infeasible, note why in LOOPLOG.md and pick the next).
2. Implement it (edit real files; this is a code loop, not a planning loop).
3. Verify: `node verify.mjs` must pass ALL checks, and `node node_modules/vite/bin/vite.js build`
   must succeed. If you broke something, fix it before committing.
4. Commit: `git add -A && git commit -m "loop <N>: <short what>"` then
   `git push origin main`.
5. Append to LOOPLOG.md (create on loop 1) EXACTLY this report shape:

```
## LOOP <N> — <title>
FIXED/CHANGED:
- <bullet what changed, files touched>
VERIFY: PASS (33/33 or new count) | BUILD: PASS | COMMIT: <hash>
```

6. Continue immediately to the next loop. After loop 15: `npm run build` final,
   final LOOPLOG entry "ALL 15 LOOPS COMPLETE", final git push, and print a summary
   of all 15 loops.

## ROADMAP (design / feel / UI / 3D models — in this order)

1. **Atmosphere pass** — richer exponential fog, CSS film-grain + vignette overlay,
   darker horror palette, subtle desaturation. Feel target: cold cellar dread.
2. **Shrine models** — proper 3D candle shrines: stone pedestal (beveled box +
   column + chipped top), wax-dripping candle cylinder, iron holder ring. No more
   bare shapes.
3. **The Door** — real model: arched stone frame, iron-banded wooden double door,
   slightly ajar when unlocked, faint warm light leaking through the crack.
4. **Wall materials** — procedural canvas texture (dark stone bricks with mortar
   lines + noise), used as map + bumpMap on all walls; per-instance slight tint
   variation so walls stop looking cloned.
5. **Floor & ceiling** — cobblestone floor texture (procedural), dark wooden ceiling
   beams every few cells, occasional hanging chain (curved tube segments).
6. **Flashlight rework** — warm cone with penumbra, casts real shadow maps (one
   shadow-casting light), subtle battery flicker at loop end, smooth lag follow.
7. **Candle flames** — animated flame (shader or layered sprites), pulsing point
   light radius, tiny ember particles rising; unlit candles look waxy-dead.
8. **UI redesign** — horror-styled HUD: letter-spaced thin uppercase type, candle
   dots become small flame icons that ignite when lit, timer bar becomes a thin
   failing-heartbeat line that reddens near the bell.
9. **Start overlay** — proper title screen: THE BELL LOOP in big spaced serif,
   fog drifting behind (render running), "click to wake up" prompt, controls hint.
10. **Bell transition cinematics** — screenshake on toll, double echo tail, walls
    ANIMATE to new positions over ~1.2s instead of popping, fade-to-black edges.
11. **Audio depth** — whispered ambience layer (filtered noise shaped like breath),
    footstep surface variation, distant second bell (quiet, offset, reversed).
12. **Win sequence** — bell stops mid-toll (cut off), total silence 2s, then slow
    warm dawn light floods the corridor, door swings fully, camera eases toward it.
13. **Performance audit** — instancing check, DPR clamp at 1.5, dispose stale
    geometries on rebuild, target steady 60fps; add hidden FPS counter (toggle F).
14. **Micro-story pass** — 6 faint wall engravings (procedural glyphs) placed on
    loop-pattern-relevant walls, a barely-visible handprint near the door, one
    discarded toy boat in a corner. No text anywhere; pure set dressing.
15. **Final polish** — OG/meta tags + favicon (bell glyph), title treatment in-page,
    subtle controller vibration API no-op guard, final verify + build + push,
    LOOPLOG summary.

## Hard rules

- NEVER let verify.mjs or build stay broken at a loop boundary.
- Keep the game's mechanics identical — this is a look/feel/UI improvement series.
- If a daily free-model limit hits mid-series: write where you stopped in LOOPLOG.md
  (LAST COMPLETED LOOP: N) and stop cleanly.
- Do not ask questions. Decide, do, log.
