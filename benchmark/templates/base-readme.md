# THE BELL LOOP — BASE TEMPLATE

`base` is the frozen benchmark template. It defines the task, deterministic rules, shared quality gate, and starting experience. Model-specific changes belong on result branches such as `stealth/space-bunny` or `claude/opus-5.5`.

## Run

```bash
npm ci
npm run dev
npm run check
```

## Benchmark contract

- The maze seed is the loop number.
- The bell resets the maze every 60 seconds.
- Three candles persist across loops.
- The center door opens on the next loop after all three candles are lit.
- All assets remain procedural.
- Every result is compared against the same `base` commit.

## Result contract

Copy `benchmark/templates/result-readme.md` to the root `README.md` on a result branch. Add the model stats, workflow diagram, twelve screenshots, deltas, deployment link, and known debt before opening the result pull request.

## Branch roles

- `index`: static catalog and default branch.
- `base`: this template.
- `provider/model`: one benchmark result.
