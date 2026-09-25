# Benchmark Catalog

This repository is a model benchmark built around one deterministic task. The `index` branch is the catalog and default branch. The `base` branch is the frozen template. Each result branch contains one model's implementation, run card, captures, and deployment metadata.

## Branch contract

| Branch | Role | Rule |
| --- | --- | --- |
| `index` | Static catalog | Contains the published benchmark index and generated catalog data. |
| `base` | Template | Shared starting point, evaluator, task contract, and baseline behavior. |
| `stealth/<model>` | Result | One model submission. |
| `claude/<model>` | Result | One model submission. |
| `<provider>/<model>` | Result | Additional model submissions follow the same contract. |

Result pull requests target `base`. Catalog changes are generated from result branch READMEs and land on `index` through a catalog pull request or CI job.

## Result README contract

The root `README.md` on every result branch is the canonical run card. It must contain YAML frontmatter so the catalog can be generated without interpreting arbitrary prose.

```yaml
---
benchmark: bell-loop
result_id: stealth/space-bunny
provider: opencode
model: space-bunny-free
variant: max
branch: stealth/space-bunny
base_branch: base
base_commit: 148c75c
status: candidate
run_count: 1
pass_count: 30
task_calls: 127
persisted_agents: 123
general_agents: 109
explore_agents: 14
wall_time_ms: 137620751
active_agent_time_ms: 54834840
input_tokens: 20377902
output_tokens: 951504
reasoning_tokens: 2747996
cache_read_tokens: 502587723
cache_write_tokens: 0
non_cache_tokens: 24077402
total_tokens: 524665125
cost_usd: 0
pure_checks: 35
world_checks: 23
build: pass
screenshots: ["cycle30-title.png", "cycle30-entry.png"]
---
```

The body must include the model summary, stats table, workflow diagram, pass ledger, twelve-capture gallery, delta from `base`, reproduction commands, and known debt.

## Generate the catalog

Install dependencies and run:

```bash
npm run benchmark:catalog
```

The generator reads result branch READMEs with `git show`, validates the required frontmatter, and writes `benchmark/site/catalog.json`. Run it from a checkout that has the result branches available locally or as fetched refs.

## Publish

Serve `benchmark/site` as the static site for the `index` branch. The site has no build dependency and reads only `catalog.json`. Each card links to the result README, branch, and deployment URL when one exists.

## Result rules

- Keep `base` unchanged while a benchmark run is active.
- Use deterministic seeds, the same task, and the same quality gate for every model.
- Keep generated screenshots and local logs out of the catalog branch; publish only approved captures.
- Record both non-cache tokens and cache reads so provider accounting is unambiguous.
- Use an immutable result tag after a candidate is finalized.

## Local quality gate

Every result branch must pass:

```bash
npm run check
```

The evaluator currently reports pure logic checks, Three.js world checks, lint, and production build status. The result README should record the final counts rather than copying stale numbers from the template.
