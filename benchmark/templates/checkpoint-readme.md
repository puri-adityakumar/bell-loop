# THE BELL LOOP — CHECKPOINT TEMPLATE

`main` is the canonical checkpoint. Create a provider/model branch from it, run the shared improvement workflow, and replace the root README with the result-card template.

## Run

```bash
npm ci
npm run dev
npm run check
```

## Checkpoint rules

- The maze seed is the loop number.
- The bell resets the maze every 60 seconds.
- Three candles persist across loops.
- The center door opens on the next loop after all three candles are lit.
- All assets remain procedural.
- A result records the exact `main` commit it started from.

## Result handoff

Copy `benchmark/templates/result-readme.md` to the root README on the result branch. Add model stats, workflow diagram, pass ledger, twelve screenshots, delta from `main`, deployment link, and known debt.
