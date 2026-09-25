---
description: Request approval to run the repository quality gates
agent: qa-runner
subtask: true
---

Run one verification pass for $ARGUMENTS. Request approval before shell access, then execute `npm run check`, report every failing gate with exact output, and stop without editing source files, committing, or pushing.
