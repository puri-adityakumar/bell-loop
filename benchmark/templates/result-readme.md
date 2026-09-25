---
benchmark: bell-loop
result_id: provider/model-name
provider: provider
model: model-name
variant: default
branch: provider/model-name
base_branch: main
base_commit: main-commit-sha
status: draft
run_count: 0
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

# Result — Provider / Model

## Run summary

Describe the model, provider, variant, task prompt, and final result in one paragraph.

## Stats

| Metric | Value |
| --- | ---: |
| Runs | 0 |
| Passes | 0 |
| Task calls | 0 |
| Persisted agents | 0 |
| General agents | 0 |
| Explore agents | 0 |
| Wall time | 0 ms |
| Active agent time | 0 ms |
| Input tokens | 0 |
| Output tokens | 0 |
| Reasoning tokens | 0 |
| Cache read | 0 |
| Cache write | 0 |
| Non-cache tokens | 0 |
| Total tokens | 0 |
| Cost | $0.00 |
| Pure checks | 0/0 |
| World checks | 0/0 |
| Build | not-run |

## Workflow

```mermaid
flowchart LR
  B[main checkpoint] --> C[Council debate]
  C --> P[Passes]
  P --> I[Implementation]
  I --> G[Quality gate]
  G --> C2[Capture]
  C2 --> P
  G --> D[Deploy]
```

## Pass ledger

| Pass | Council agents | Change | Gate | Capture |
| ---: | ---: | --- | --- | --- |
| 01 | 0 | TBD | TBD | TBD |

## Gallery

Use six rows with two screenshots per row.

<table>
  <tr><td><img src="benchmark/site/screenshots/title.png" alt="Title"><br>Title</td><td><img src="benchmark/site/screenshots/entry.png" alt="Entry"><br>Entry</td></tr>
  <tr><td><img src="benchmark/site/screenshots/shrine.png" alt="Shrine"><br>Shrine</td><td><img src="benchmark/site/screenshots/door.png" alt="Door"><br>Door</td></tr>
  <tr><td><img src="benchmark/site/screenshots/reset.png" alt="Reset"><br>Reset</td><td><img src="benchmark/site/screenshots/pause.png" alt="Pause"><br>Pause</td></tr>
  <tr><td><img src="benchmark/site/screenshots/win.png" alt="Win"><br>Win</td><td><img src="benchmark/site/screenshots/short.png" alt="Short landscape"><br>Short landscape</td></tr>
  <tr><td><img src="benchmark/site/screenshots/detail-a.png" alt="Detail A"><br>Detail A</td><td><img src="benchmark/site/screenshots/detail-b.png" alt="Detail B"><br>Detail B</td></tr>
  <tr><td><img src="benchmark/site/screenshots/detail-c.png" alt="Detail C"><br>Detail C</td><td><img src="benchmark/site/screenshots/detail-d.png" alt="Detail D"><br>Detail D</td></tr>
</table>

## Delta from `main`

### Logic

- TBD

### Rendering and atmosphere

- TBD

### Audio

- TBD

### UX and accessibility

- TBD

### Performance

- TBD

### Tests and tooling

- TBD

## Reproduce

```bash
npm ci
npm run check
npm run dev
```

## Known debt

- TBD
