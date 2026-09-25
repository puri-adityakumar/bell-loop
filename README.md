# THE BELL LOOP — CHECKPOINT

`main` is the canonical checkpoint for the autonomous model benchmark. It is the reference point that every model starts from before creating a provider/model improvement branch.

The first completed result is `stealth/space-bunny`, produced by OpenCode using `space-bunny-free`. That branch is an example of the expected workflow: branch from `main`, run bounded improvement passes with a council, verify, capture states, and document the delta in the branch README.

## Run

```bash
npm ci
npm run dev
npm run check
```

## Checkpoint contract

- The maze seed is the loop number.
- The bell resets the maze every 60 seconds.
- Three candles persist across loops.
- The center door opens on the next loop after all three candles are lit.
- All assets remain procedural.
- A model starts from the current `main` commit and records that commit in its result metadata.
- The deterministic task and quality expectations do not change between model runs.

## Model workflow

1. Create a branch named `provider/model` from `main`.
2. Run bounded improvement passes with a read-only council and one writer.
3. Run `npm run check` after every meaningful pass.
4. Capture title, entry, shrine, door, reset, pause, win, responsive, and detail states.
5. Replace the root README with the result-card structure from `benchmark/templates/result-readme.md`.
6. Record model stats, workflow diagram, pass ledger, twelve screenshots, delta from `main`, deployment link, and known debt.
7. Push the result branch for comparison.

## Branch roles

- `main`: canonical checkpoint and reference implementation.
- `stealth/space-bunny`: first completed model result.
- `provider/model`: one model result created from `main`.

There is no separate catalog or base branch. Each result README is the durable record of that model run.
