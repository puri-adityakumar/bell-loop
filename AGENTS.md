# AGENTS.md — Bell Loop Model Benchmark

## Purpose

This repository is an autonomous model benchmark built around one deterministic first-person horror maze. `main` is the canonical checkpoint. Models start from the current `main` commit, create a `provider/model` branch, improve the shared experience, and publish a documented result.

The current result branch is `stealth/space-bunny`. Its README is the canonical record of that run.

## Branch model

- `main`: checkpoint, shared task contract, catalog, and approved comparison captures.
- `provider/model`: one model result created from `main`.
- There is no separate `base`, `index`, or template branch.
- Do not merge model-specific work into `main` unless it is intentionally becoming the next checkpoint.

## Result workflow

1. Create `provider/model` from the latest `main`.
2. Read `README.md`, `AGENTS.md`, and `benchmark/README.md`.
3. Establish a bounded improvement plan and use a read-only council for investigation.
4. Use one writer for the implementation change.
5. Run `npm run check` after every meaningful pass.
6. Capture title, entry, shrine, door, reset, pause, win, responsive, and detail states.
7. Replace the result branch README with `benchmark/templates/result-readme.md`.
8. Record the exact starting `main` commit, model metadata, token accounting, pass count, screenshots, deployment URL, and known debt.
9. Deploy only the result branch. Do not deploy `main` as a model result.
10. Add approved comparison screenshots and the result row to the `main` catalog.

## Main catalog

`main/README.md` is intentionally concise. Its result table has two columns:

- Column 1: a representative screenshot.
- Column 2: branch name, model name, and deployed link.

A comparison section shows representative screenshots side by side. Unreleased results may appear as clearly marked pending rows; never invent a branch, deployment URL, or screenshot.

## Quality rules

- `npm run check` is the required gate.
- Keep `main` stable while a model run is active.
- Keep the deterministic maze seed, loop rules, and win condition comparable between runs.
- Keep local logs and unpublished captures out of commits.
- Never commit credentials, tokens, or account secrets.
- Record non-cache tokens and cache reads separately.

## Useful paths

- `benchmark/README.md`: benchmark contract and result metadata.
- `benchmark/templates/result-readme.md`: result README structure.
- `benchmark/templates/checkpoint-readme.md`: checkpoint README structure.
- `benchmark/build-catalog.mjs`: optional local metadata generator.
- `benchmark/screenshots/`: approved main-branch comparison captures.
- `src/game/`: deterministic game implementation.
- `verify.mjs` and `verify-world.mjs`: pure and world checks.
