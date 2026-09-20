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

## 2026-09-20 — Deploy (GitHub + Vercel)

- **GitHub**: created https://github.com/zeke-cmd/bell-loop (public, branch `main`),
  pushed 26 files (source, PLAN/PROGRESS/TASK docs, verify.mjs, verify-world.mjs).
  `node_modules/` and `dist/` gitignored; identity `zeke-cmd` set repo-locally.
- **README.md**: rewritten — title, description (temporal horror maze, Vite+React+Three.js),
  run instructions (`npm install` / `npm run dev` / `npm run build` / `node verify.mjs`),
  controls (WASD, mouse look, E to light candles), win condition (3 candles across bell
  loops -> center door -> "THE BELL STOPPED").
- **Build re-verified before push**: `npm run build` passes (dist ~790K, 27 modules).
- **Vercel**: CLI 59.23.2 installed. Not authenticated (`whoami` → loggedIn:false) and no
  token in env → `vercel deploy --prod --yes` fails with "No existing credentials found".
  Worked around headlessly with **anonymous temporary deploy**:
  - Live URL: https://temporary-turbo-perseus-1w66ooi.vercel.app (verified HTTP 200, serves the game)
  - Claim: https://vercel.com/claim-deployment?code=c8739d46-d1d7-438c-884c-25a24de2c9d7
  - **Expires in ~60 minutes** — claim it, or use vercel.com/new for a permanent one.
- **Blocker**: persistent (project-owned, push-to-deploy) Vercel deploy needs a token
  (`vercel --prod --token <TOKEN>`) or one-click import at https://vercel.com/new —
  details in `BLOCKED-VERCEL.md`. Zero config needed: Vite auto-detected.

