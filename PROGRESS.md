# PROGRESS — THE BELL LOOP

Built autonomously by cline (kimi-k3 for planning, deepseek-v4.1-flash free tier for
implementation), orchestrated via tmux.

## What was built
- Vite + React + Three.js first-person horror maze, per TASK.md
- Seeded deterministic maze per loop (mulberry32), learnable wall-phase pattern
- 60s loop timer, bell toll (synthesized WebAudio partials), wall reshuffle + reset
- 3 candle shrines, persistence across loops, door unlock, win screen "THE BELL STOPPED"
- Pointer-lock WASD controller, flashlight spotlight + fog, HUD (loop counter, timer
  bar, candle dots)
- verify.mjs: 33/33 checks passed (maze solvability loops 1-8, candle zones, store
  reducers, scripted full run)
- npm run build passes; dist/ ~800K

## Decisions
- Game state in plain mutable store, React subscribes only to HUD values
- All assets procedural; all audio synthesized (autoplay-safe: starts on first click)
- Phase-ghost walls shown as faint outlines (learnability aid)

## Known gaps
- No mobile touch controls (keyboard required)
- Ghost-replay and konami Easter egg cut per TASK.md scope

## Run
- dev: npm run dev
- build: npm run build  (dist/)
- verify: node verify.mjs
