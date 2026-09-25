---
description: Run one bounded detect, fix, verify, and review cycle
agent: build
---

Run one bounded improvement cycle for $ARGUMENTS.

1. Establish a short task list and inspect the current diff and relevant conventions.
2. Reproduce the issue and define one acceptance criterion set.
3. Keep production changes within the smallest coherent file set.
4. Use one writer. Launch read-only investigation or review subagents only for non-overlapping work.
5. Run the repository quality gates with `npm run check`.
6. Run independent code, UI, and 3D review when the change touches those areas.
7. Stop after three failed repair attempts, when scope expands, or when a human decision is required.
8. Do not commit or push unless explicitly requested.
