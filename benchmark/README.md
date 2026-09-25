# Bell Loop Model Benchmark

`main` is the canonical checkpoint. Every model creates a provider/model branch from `main`, improves the same deterministic task, and records the complete run in that branch's root `README.md`.

The first reference result is `stealth/space-bunny`. It is an example of the expected workflow, not a separate template branch.

## Branch contract

| Branch | Role |
| --- | --- |
| `main` | Canonical checkpoint, shared task, and reference implementation. |
| `provider/model` | One model result created from `main`. |

Result pull requests target `main`. There is no separate catalog, base, or index branch.

## Result README contract

The root `README.md` on every result branch is the durable run card. YAML frontmatter makes the metadata machine-readable while the body remains the human report.

```yaml
---
benchmark: bell-loop
result_id: provider/model
provider: provider
model: model-name
variant: default
branch: provider/model
base_branch: main
base_commit: main-commit-sha
status: candidate
run_count: 1
pass_count: 0
task_calls: 0
persisted_agents: 0
general_agents: 0
explore_agents: 0
wall_time_ms: 0
active_agent_time_ms: 0
input_tokens: 0
output_tokens: 0
reasoning_tokens: 0
cache_read_tokens: 0
cache_write_tokens: 0
non_cache_tokens: 0
total_tokens: 0
cost_usd: 0
pure_checks: 0
world_checks: 0
build: not-run
screenshots: []
---
```

The body must include the run summary, stats, Mermaid workflow, pass ledger, twelve-capture gallery, delta from `main`, reproduction commands, and known debt.

## Workflow

1. Create `provider/model` from the current `main`.
2. Run bounded passes with a read-only council and one writer.
3. Run `npm run check` after every meaningful pass.
4. Capture the required visual states.
5. Copy `benchmark/templates/result-readme.md` to the root README and fill it in.
6. Record the exact `main` commit used as the starting checkpoint.
7. Push the result branch for comparison.

## Local reporting

`npm run benchmark:catalog` can generate a local `benchmark/site/catalog.json` from available result branches. It is optional tooling; the repository has no hosted catalog branch.

## Result rules

- Keep `main` stable while a model run is active.
- Use the same deterministic task and quality expectations for every model.
- Keep local logs and unpublished captures out of the checkpoint.
- Record non-cache tokens and cache reads separately.
- Use an immutable result tag after a candidate is finalized.
- Do not merge model-specific changes into `main` unless they become the next intentional checkpoint.

## Quality gate

Every result must pass:

```bash
npm run check
```

The result README should record the final pure-check count, world-check count, build status, and any known warnings.
