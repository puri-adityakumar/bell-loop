# ORCHESTRATOR LOG — cline/space-bunny-alpha

Benchmark run: Bell Loop v2 ("The Quiet Streets" working title)
Orchestrator: Hermes (reviews, decides, views screenshots; does not code)
Implementer: Cline CLI on **Space Bunny Alpha** (free model, Cline provider), driven via tmux session `cline-main`
Base commit: `3ccd9f8` (main)
Branch: `cline/space-bunny-alpha`

## Brief (from Aditya)
- Branch off main. New game version: liminal-space walking, **open world of repeating streets**.
- Goal: find **3 portals** and shut them down. Old stick-hits-bell loop-restart mechanic replaced: a **creature** stalks; being caught restarts the loop; artifact (bell-hammer) repels/stuns it.
- UI inspired by Kenton-GMI/sakuragaoka-station (procedural three.js, walkable FP, HUD) but **yellowish tint + darker theme**; bg mood = Backrooms ("7 Weeks 3 Days (Backrooms Version)" video: mono-yellow sodium haze, liminal dusk).
- Assets procedural, "realistic-looking".
- Orchestrator runs **100s of Cline passes** on free models; if a model is exhausted, set a timer and switch/retry.
- Blockers: research first, then ask Aditya.
- Vercel CLI deploy at the end (auth coming later). Keep this log.

## Design decisions so far (ideation with Space Bunny, no code yet)
1. **World**: fork Q1 → chose **4** — toroidal wrap grid (7×7 blocks ≈ 336 m, seamless repeat) now, streaming later as a slice. Generator is chunk-addressed from day one (`chunkAt(cx, cz)`), wrap = coordinate transform.
2. **Reshuffle on reset**: fork Q2 → chose **3** — fixed geometry, **permuted fixtures** per loop (parked cars, lit windows, hedges re-roll via `hash32(seed ^ loopSalt(loop), cx, cz)`). Streets never move; the place feels wrong each loop without erasing progress.
3. **Dusk keying**: Space Bunny correction, accepted — darkness is keyed to **portals shut** (progress), not loop number (no death spiral).
4. **Creature learning**: accepted as second ramp axis — captures shorten creature memory + raise aggression; portals = positional progress, captures = AI pressure.
5. **Hammer**: fork Q3 → chose **1** — must be found (fixed per run, fair distance pool). Space Bunny's synthesis: **pickup tolls the bell → toll wakes the creature**. Act I = quiet streets (no capture possible, telegraph sightings only), Act II = hunt live. Bell = causal spine of the game.
6. **Win condition** (proposed, accepted): 3rd portal down → creature permanently ENRAGED (5.2 m/s vs sprint 6.0, always knows position, no phase-out) + exit opens at far edge (car with headlights). Reach it → win: "THE NEIGHBORHOOD WENT QUIET."
7. **Ramp table** (accepted): 0 portals: speed 2.2/detect 14 m/stalk only + 8 s grace · 1: 2.8/17 · 2: 3.4/20/chained chases · 3: 5.2/∞/no phase-out. Stamina becomes load-bearing (limited sprint).
8. **Creature AI**: DORMANT → STALK → CHASE → STAGGER (stun 1.6 s within 2.2 m, swing cooldown 0.55 s, swing is loud) → REPOSITION. Detection = sight cone ~70°/18 m + hearing (sprint 22 m, walk 9 m, swing 30 m) with **awareness meter** (no binary spot). Chase >12 s → phases out (anti-frustration).
9. **Portals**: 3, in liminal structures (shed / bus shelter / phone box), one per district, min graph distance from spawn + from each other. Shut down = **hold E 1.2 s** (progress ring, vulnerability window). Persist across loops. Each shutdown: dusk deepens, creature faster.

## Phase 2 status (docs pass, complete)
- Resumed session 1790368004047_sshb9 in interactive TUI after timeout kill (lesson: run with no -t flag).
- GAMEDESIGN.md written (26.7 KB, 16 sections, "THE LONG QUIET" working title).
- V2-PLAN.md written: 16 slices in 3 phases (A: pure modules 01–07, B: integration 08–13, C: gate/balance/publish 14–16). Critical slices: 09 (the swap) and 15 (balance simulation).
- Cline found verify-world.mjs broken at base (canvas stub rot, `ctx.beginPath`) — scheduled as slice 14; not in npm run check today.
- npm install run (node_modules absent); npm run check green: lint clean, 33/33 pure checks, build clean.
- Committed: 4b60ca6 "docs(v2): design THE LONG QUIET and its 16-slice implementation plan" (GAMEDESIGN.md + V2-PLAN.md).

## Pass log
- Pass 1 (ideation): recon of repo (loop.js, maze.js pure modules; verify.mjs gate = oxlint + verify + build; PlayerController 3.6/6.0 m/s; HUD text-free; determinism = seed via mulberry32). Produced 16-section design outline + proposals. Flagged: verify-world.mjs NOT in `npm run check` gate (gap to fix in implementation).
- Q1 world geometry → 4 (wrap now, streaming later). Q2 reshuffle → 3 (fixed geometry, permuted fixtures). Q3 hammer → 1 (must be found) + creature-learning kept.
- Pass 2 (docs): resumed, wrote both docs, gate green, committed 4b60ca6. Token usage ~95K input + 500K cache reads, $0.00.
- Aditya went offline → autonomous overnight run authorized: "continue until finished, push everything; Vercel later."

## Slice completion log (autonomous run)
| Slice | Commit | Gate | Notes |
|---|---|---|---|
| 01 hash.js PRNG | 42800f4 | 40/40 | +7 checks |
| 02 neighborhood chunks/wrap/graph | 0b05dd5 | 50/50 | wrap-seam connectivity proven |
| 03 districts + anchors | c3653f2 | 59/59 | 5 objectives placed, hammer stable loops 1..8 |
| 04 fixtures + 4 rules | c101e3c | 67/67 | Cline process died mid-slice (silent exit) — resumed via `cline --id`, finished. BFS fixture checks slow → optimized |
| 05 rules.js portal/breath/persistence | 62238eb | 78/78 | tmux server died twice (container reaping); resumed via --id again |
| 06 creature.js awareness + state machine | 1411e29 | 101/101 | non-interactive background cline per slice (no tmux); 7 states incl. STAGGER/REPOSITION; awareness held by sight |
| 07 pathing + the two ladders | (this commit) | 115/115 | BFS on the 49-node street graph; §7.4 ladder 8→24 capped; §11.2 aggression strictly up, delay strictly down; §8.2 phase-out at 12 s; §8.3 placement cascade; §11.3 pure trend |
| 08 player breath + two verbs | (this commit) | 123/123 | +8 checks; `player.js` lost its `three` import (Vec3/Vec2) so §15.1's "pure, importable by verify.mjs" is now literally true; E=interact hold, LMB=swing edge; exhausted breath is a continuous `still` event on the creature's table |

### Slice 08 decisions (recorded for the next slice)

- **`player.js` is now genuinely pure** and `verify.mjs` imports it directly. The only
  thing that ever blocked that was `import * as THREE from 'three'`, needed for two
  vector objects; `Vec3`/`Vec2` replaced them. Outward API checked against callers first:
  `world.js` reads only `pos.x` / `pos.z`, `verify-world.mjs` uses `pos.clone()` and
  `keys.add/delete` — all preserved, so v1 wiring is untouched. The browser surface is
  confined to `attach` / `dispose` / `requestLock`; DOM events are translated into
  `pressKey` / `pressButton`, and that is the same door the pure checks use.
- **One sprint flag, two gates.** `sprinting = wantsSprint && !exhausted` is computed
  *before* `breathStep` and re-checked *after* it, so neither the pre-existing flag nor a
  held Shift key can buy a single frame of sprint speed. Dropping either gate alone is
  survivable; dropping both is caught by the gate (mutation-tested).
- **Exhausted breathing is a continuous `still` event**, emitted once per
  `SOUND_EVENT_SECONDS` window via `creature.soundRadius('still', …)` (= +6 m), *in
  addition to* the per-stride gait event that already carries the +6. The alternative —
  folding the bonus into the gait event only — was rejected: it would leave a spent
  player standing behind a hedge in silence, which is the exact moment §7.3 is about.
  The reachable radius set is asserted exhaustively: `{0, 6, 9, 15, 22, 28}`.
- **Breath survives a capture.** §9.1's reset column is short on purpose and breath is
  in neither column, so `teleport()` does not touch it. Slice 09 wires `applyCapture`.
- **World harness, run by hand:** `node verify-world.mjs` still exits 1, unchanged from
  the base commit — `TypeError: ctx.beginPath is not a function` at
  `makeCobbleTexture (src/game/world.js:182:11)` ← `new BellLoopGame
  (src/game/world.js:482:26)` ← `verify-world.mjs:133`. Not touched; slice 14 owns it.
- **The new checks were mutation-tested**, because a check that cannot fail is worse than
  no check: leaking the lockout into the speed, hard-coding a sound radius, re-declaring
  `BREATH_DRAIN_PER_SEC`, dropping the stride gate, and emitting a footstep per frame
  are each caught (the last two by the sound-table and standing-still checks).

## Infrastructure notes (for reproducibility)
- tmux sessions die ~every 20–40 min in this container → abandoned tmux for slice execution.
- New protocol per slice: `cline -P cline -m stealth/space-bunny-alpha --auto-approve true "<slice spec, V2-PLAN.md is authority>"` as Hermes-tracked background process; on exit → orchestrator runs `npm run check` itself, pushes via credential helper, updates this log, launches next slice.
- Push auth: `git -c credential.helper='!f(){ echo username=zeke-cmd; echo password=${GH_TOKEN}; }; f' push origin cline/space-bunny-alpha` (GH_TOKEN from /work/.hermes/.env).
- `cline --id <session>` resume works and preserves context, but sessions balloon (340K+ input tokens, all cache reads, still $0.00 on Space Bunny Alpha). Fresh sessions per slice are cheaper and avoid stale-context drift; V2-PLAN.md + GAMEDESIGN.md on disk carry the design.
- chromium-browser here is a snap transitional stub (no real binary) → screenshot tooling for Phase C captures: investigate repo tools/shot.mjs browser discovery or npx puppeteer browsers install chrome-headless-shell when Phase B renders exist.

## Pending
- Slices 09–16 in order (09 THE SWAP, 10 creature view, 11 audio, 12 HUD, 13 finale, 14 verify-world repair, 15 balance sim, 16 captures+cleanup+result README).
- Slice 07 open questions resolved, to be tuned in slice 15: `REEMERGE_MIN_GRAPH_DISTANCE` = 2 hops (90.5 m minimum straight line), `AGGRESSION_SPEED_STEP` = 0.25 m/s, `AGGRESSION_SIGHT_STEP` = 1.5 m, re-emergence delay 6 s → 0.5 s asymptote, `HUNT_SECONDS_PER_ENCOUNTER` = 9 s, `ENRAGED_REEMERGENCE_SECONDS` = 1.5 s (§16.3's candidate). §11.3 is asserted from the tables in node; slice 15 replaces that with the real simulation.
- Vercel deploy: BLOCKED on Aditya auth — do not attempt without; everything else proceeds.
