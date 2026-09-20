# TASK-DEPLOY: GitHub + Vercel for THE BELL LOOP

You are deploying the finished game in this directory. Work autonomously, no questions.
The `gh` CLI is already authenticated (account: zeke-cmd). `git` is available.

## Steps

1. **Prep the repo**
   - `git init` if needed; create a proper `.gitignore` (node_modules/, dist/,
     .oxlint cache, *.local) — keep source, PLAN.md, PROGRESS.md, TASK.md, verify.mjs.
   - Set local git identity: name `zeke-cmd`, email `zeke-cmd@users.noreply.github.com`.
   - Update README.md: game title, one-paragraph description (temporal horror maze,
     Vite+React+Three.js), how to run (npm install / npm run dev / npm run build /
     node verify.mjs), controls (WASD, mouse look, E to light candles), and the
     win condition (3 candles across bell loops -> center door).
2. **Create the GitHub repo and push**
   - Repo name: `bell-loop` (if taken, `bell-loop-game`).
   - Public. `gh repo create <name> --public --source=. --push` (or equivalent).
   - Verify with `gh repo view <name> --json url,defaultBranchRef`.
3. **Vercel**
   - Try: `npm i -g vercel` then `vercel deploy --prod --yes` (or `vercel --prod`).
   - If it requires interactive login (it will, headless), DO NOT loop. Instead:
     write `BLOCKED-VERCEL.md` containing: (a) the exact non-interactive command
     that works with a token (`vercel --prod --token <TOKEN>`), (b) the fallback
     for the human: open https://vercel.com/new , import the `zeke-cmd/bell-loop`
     repo — Vite is auto-detected, zero config — and every future push auto-deploys.
   - If the `vercel` npm install itself fails due to permissions, use
     `npm config set prefix "$HOME/.local"` first (it is already set), then retry once.
4. **Wrap up**
   - Append a dated section to PROGRESS.md: repo URL, push result, vercel status,
     any blockers.
   - Final message: repo URL + vercel status summary.

## Rules
- Retry transient failures up to 3 times; free-tier network flakes happen.
- If genuinely hard-blocked, write the blocker to BLOCKED-VERCEL.md and continue
  with what you can. Do not wait or ask questions.
