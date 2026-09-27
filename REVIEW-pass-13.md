# REVIEW — iteration 2, pass 13

- **Commit under review:** `052704c` — "iter2(13): sound I - room-tone drone, distant facility sounds, wind layer, portal hum".
- **Reviewer verdict:** **FIXED — one real defect, found by an instrument the gate did not have.** The pass's own claims are all true and all load-bearing: the four channels are on the bus, the wind's coupling is the sky's own moving reading rather than a constant, both distance models are the world's `soundStrength`, and the cursor clock is the world's `dt`. I confirmed each by independent probe rather than by reading the check that asserts it. But the file this pass spent 1215 lines on had a line in it that **threw a `TypeError` on every frame in a real browser**, and it predates the pass. The gate could not see it because nothing in the repository ever constructed a WebAudio graph. I fixed it, and closed the seam that hid it.
- **Gate at verdict time:** 274/274 pure (was 273 — my check is the +1), 103/103 world, `vite build` clean, lint unchanged at its five pre-existing warnings. Nothing was weakened; one gate was added.

## What the pass does

Four rows in the routing table the game already had — `roomTone`, `hazeWind`, `facility`, `drip` — plus a second distance channel on the portal hum, all `kind: null` so §6.2 prices the whole bed at radius 0. The `setTimeout` ambience chain is replaced by three cursor streams advanced by the frame's own `dt`; `Math.random` is gone from the file; `DEFAULT_SEED` moved into `hash.js` and the world hands its seed to the audio once. The architecture is right: every tuned number is a table, the view applies it, the world wires it. `verify.mjs` grew 649 lines and `verify-world.mjs` 243, which is the correct ratio for four channels and one scheduler replacement.

## The defect: `applyDrone` threw on every frame

`startAmbient` assigns `this.ambientGain = bus.gain` — which is already the **`AudioParam`**, not the `GainNode`. `applyDrone` then wrote through `this.ambientGain.gain.setTargetAtTime(...)`. The extra `.gain` read `undefined`:


## Every hard requirement, checked

| Requirement | Verdict | Evidence |
|---|---|---|
| (a) Synthesized WebAudio, no files, no CDN | **CONFIRMED** | `dist/` = 4 files (html, css, js, favicon). No `fetch`/`XMLHttpRequest`/`new Audio`/`decodeAudioData` in the bundle; the only `http` strings are React/Three namespace URIs. All audio is `createOscillator`/`createBuffer`/`createBiquadFilter`. |
| (b) Starts only after a user gesture | **CONFIRMED, gate is real** | With a counting `AudioContext`: a full `update()` + every routed voice constructed **0** contexts; one `unlock()` constructed exactly 1. `unlock()` is reached only from `begin`/`restart`/`resume` in `App.jsx`. |
| (c) Scheduling is seeded and deterministic | **CONFIRMED** | `Math.random`/`setTimeout` are gone from the file's code. Mutants M12, M23, M24 (unseeded placement, unseeded gaps, unseeded noise floor) all **killed**. `hazeIntensityAt(100,1337)=0.728264` vs `(100,99)=0.400410`. |
| (d) Four channels, audible by design | **CONFIRMED** | With a real context: room/wind gains both connect to the drone bus; room chain is highpass→lowpass→gain with the LFO→depth→`roomLow.frequency` AudioParam correctly wired (rate 0.017, depth 140); wind is source→band→gain. Bed sums to **0.0940** at ceiling against one walk footstep at **0.1** — `WORLD_BED_CEILING` holds, and at −20.5 dBFS the bed sits under the compressor's −14 dB threshold. |
| (d) Wind follows the sky, **not a constant** | **CONFIRMED** | Sky haze over 1 h spans **0.0005 → 0.9818**; wind level over 2 min takes 24 distinct values. It is the *same* function the renderer reads: `game.skyView.hazeIntensity() === hazeIntensityAt(skyView._time, seed)` on the sky's own clock, and `world._audioFrame().haze` is that number. Monotone in haze (0.006 → 0.012 → 0.018), bounded `[0,1]` over 2 h. M1/M2/M3/M4/M6/M8 all **killed**. |
| (d) Portal hum distance model matches | **CONFIRMED** | Level is **bit-identical** to `PORTAL_HUM_LEVEL * soundStrength(d, 30)` at every 0.25 m from 0 to 30; damp strictly decreasing throughout, exactly 1800 at the portal and 500 at the range edge. M18/M19/M20 **killed**. |
| (e) Pause reaches the bed clock | **CONFIRMED** | A paused frame routes `{started:false}` → `routeAudio` returns `[]` → no voice runs → no cursor moves. Mutants M16 (`dt<=0` no longer refused) and M17 (cursor clock taken as a constant 0.05 rather than the frame's `dt`) both **killed**. |
| (e) Hidden tab does not stack a backlog | **CONFIRMED** | A 900 s frame fires exactly `AMBIENCE_MAX_PER_FRAME` and re-bases the cursor to the clock. M14 (cap removed) and M15 (backlog stacked, `at` nudged instead of re-based) both **killed**. M15 first hung the harness as an infinite loop, which is itself the honest signature of a stacked backlog. |
| (f) Capture gallery unchanged **by design** | **CONFIRMED** | `capture/main.jsx:153` passes no `audio`; `grep -n audio capture/main.jsx src/game/capture.js` returns **nothing**. `git show 052704c --stat -- benchmark/` is empty. Audio is not in the capture render path, so leaving the gallery alone is correct, not laziness. |
| (3) Music deferred, not smuggled in | **CONFIRMED** | Checklist P4 keeps `PASS 14` unchecked and says "No music in this pass." `AUDIO_ROUTE_IDS` has **0** rows matching music/pad/chord/progression/melody; the 16 rows are the 12 pre-existing plus the 4 bed rows. The `winChord` is slice 13's, unchanged by this pass. |

## My own mutation battery: 24/24 killed

Throwaway sandbox at `/tmp/rv13/sb/tree`, asserted **byte-faithful** against the repo before any mutation (a missing input is a silently meaningless kill rate — my first attempt had a stale `audio.js` and I rebuilt it rather than trust the number). Every anchor had to occur exactly once. Mutations are applied to the sandbox only; the live tree was read-only throughout, confirmed by `git diff --stat` being empty before I made my own edit.

All 24 killed: haze coupling removed / constant / inverted / unfloored; sky haze constant / unseeded; cycle→1; facility wrap dropped / own curve / flat damp / `Math.random` placement / gap escaping 20–60 s; backlog cap removed / backlog stacked; `dt<=0` accepted; cursor clock decoupled; portal damp constant / inverted; portal level off `soundStrength`; room tone off the ladder; bed row given a `kind`; unseeded gaps; unseeded noise floor.

**This gate is genuinely strong.** Not one survivor across 24 independent mutants covering every headline claim of the pass. That is the opposite of pass 11's lamp record and deserves saying plainly.

```
TypeError: Cannot read properties of undefined (reading 'setTargetAtTime')
    at AudioManager.applyDrone (src/game/audio.js:2408:27)
    at AudioManager.update (src/game/audio.js:1918:13)
```

Faithful repro of `App.jsx`'s BEGIN (`unlock()` → `startAmbient()` → one `update(1/60, frame)`): **1 of 1 frames threw.** The duck ladder was therefore never applied — the bus sat at its constructed `0.052` through the capture's black (which should be `0.0234`) and through the win chord (which should be `0.004`). The drone never quieted. That is the exact behaviour the ladder exists to prevent, and the pass's own claim that the room tone and wind ride "the drone's own duck ladder" was resting on a ladder whose bottom step threw.

**Blast radius was the whole frame, not the drone.** `update` has no `try`, `world._updateAudio` has no `try`, `_animate` has no `try`. And because `requestAnimationFrame(this._animate)` is the *first* statement in `_animate`, the loop survived but every subsequent frame abandoned `this.update(dt)` and `this.renderer.render(...)` part-way. This is a pre-existing bug from slice 11 (`9983207e`) — not pass 13's — but pass 13 made the bed depend on this line, so the review owns it.

**Why no gate saw it, which is the interesting part.** `update` opens with `if (!this.ctx) return`, and no check in either harness ever installs an `AudioContext` — `verify.mjs` drives a real `AudioManager` that is *deliberately* headless, which is a good property that is also a blind spot. The capture page builds the world with `new LongQuietGame(containerRef.current, { store })` (`capture/main.jsx:153`, no `audio` key), so `this.audio` is `null` there too. Every "the voice survives without a context" claim in the suite is true *because* it never reaches a node. The one place the line executes is a real browser — the one place a gate cannot be run from.

**Fix:** one `.gain` removed, so it matches `duckAmbient`, the other writer of the same AudioParam three hundred lines up, which was always right. **Gate added:** a new check, `a real AudioContext: every routed voice runs a frame without throwing, and the duck reaches the bus`, installs a recording stub that models WebAudio's one structural rule — a `GainNode` has a `.gain` AudioParam and an `AudioParam` has no `.gain` of its own — so a double-wrap is a `TypeError` in node exactly as it is in Chrome. It drives the whole of `App.jsx`'s BEGIN, then asserts the bus reaches the routed level for playing / black / won, in that order. I mutation-tested it by putting the `.gain` back: **FAIL, 273/274.** The gate now catches the bug it was written for.

## Two probe results I want to retract

Adversarial review is only worth anything if the reviewer publishes its own false alarms. My first probe reported "G4 FAIL — the room-tone cutoff LFO is not wired" and "I6 FAIL — the facility pan is inverted at yaw=pi/2". **Both were artifacts of my stub, not defects.** G4: I asserted `roomDepth.sinks.includes(roomLow)`, but `roomDepth` connects to `roomLow.frequency`, an **AudioParam** — the correct WebAudio idiom, verified separately (`roomDepth.sinks[0] === roomLow.frequency`, depth 140, rate 0.017). I6: I read `pan === 0` at yaw=pi/2 as a failure, but at that yaw the source is *dead ahead*, where 0 is the correct answer; recomputing against `player.js`'s own basis (`forward = (-sin,-cos)`, `right = (cos,-sin)`) gives pan `+1 / 0 / -1 / 0` for the four cardinal yaws, which is right. The pan is correct.

## Remaining gaps, recorded honestly

1. **The gate now has a fake `AudioContext`, not a browser.** It models the one structural rule that broke and asserts parameter *shape*. It does not assert that the graph sounds right, that no node leaks, or that a `StereoPanner` behaves as Chrome's does. The headless-manager property is preserved: a manager with no context still builds nothing.
2. **No capture frame photographs the bed.** The bed is audio; the gallery is visual; §16.5 needs no change and none was made. The right visual evidence for this pass is a listener, not a screenshot.
3. **The four facility kinds are distinguishable on paper only.** The table gives each a distinct tone/band/decay and the gate reads the table, but nothing measures that a rumble and a clank are *audibly* different — that needs a listening pass.
4. **`HAZE_AUDIO_CYCLE = 24` is a judgement, not a derivation.** The docblock is honest that it is chosen, and M8 (retuned to 1) is killed, so the coupling is asserted. Whether 24 is the *prettiest* multiplier is a listening question this pass cannot answer and correctly does not pretend to.
5. **Five pre-existing lint warnings**, unchanged by this pass and not introduced by it.

## What I changed

- `src/game/audio.js` — `applyDrone`: removed the stray `.gain`. One token of source; the rest of the diff is the docblock recording why it was invisible and what it cost.
- `verify.mjs` — one new check that installs a recording `AudioContext`, drives `App.jsx`'s BEGIN, and asserts the duck ladder reaches the bus. **Mutation-tested: it fails when the bug is present.**

No gate was weakened, relaxed, or deleted. `npm run check` is green at 274/274 + 103/103 + clean build.

The pass did what it said. The file it landed in had been quietly broken since slice 11, and the reason is the one thing a review with a browser-shaped instrument exists to find.
