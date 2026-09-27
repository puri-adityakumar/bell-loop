# REVIEW — iteration 2, pass 14

- **Commit under review:** `b088576` — "iter2(14): sound II - Backrooms ambient music bed, duck ladder, finale silence".
- **Reviewer verdict:** **FIXED — two real defects, and both of them are gates, not behaviour.** The music itself is correct: it is genuinely music, the ladder is the documented table, the finale cuts on the latched flag, the bus is separate, and every claim in the commit message that I could measure is true. What the pass got wrong was the *evidence*. Two properties the pass states in its own docblocks — the finale's ORDER, and "a graph that is built and then told nothing must not be heard" — had **no check behind them at all**, and I proved it by re-introducing the exact bugs the pass says it caught and watching the gate stay green. I added the gates. The second is the more serious: it is one of the two bugs the pass caught *itself*, and a self-caught bug with no check behind it is the one that comes back in four passes.
- **Gate at verdict time:** **285/285 pure** (unchanged — the pure count is the same because I strengthened two existing checks and the committed mutation harness rather than adding parallel ones), **111/111 world** (was 107 — my +4), `vite build` clean, lint unchanged at its five pre-existing warnings. Nothing was weakened, relaxed or deleted. The world harness goes from 21.8 s to 27.3 s, which is the honest cost of four more real-world checks.

## What the pass does, and whether it is actually music

This is the user's explicit ask for the pass, so I did not take the commit message's word for any of it. I built a **recording `AudioContext` of my own** — stricter than the repository's stub in three ways: an `AudioParam` is not an `AudioNode` and has no `connect()` (so a param wired as a node is a `TypeError` in node exactly as in Chrome), every edge goes into one global table so a claim like *"voice N reaches the master"* is a reachability question rather than a grep, and `setTargetAtTime`'s **third argument is recorded**, because for this file the time constant *is* the design (0.12 s is a cut, 0.6 s is a duck, and they are the same number written to the same node).

| Requirement | Verdict | Evidence |
|---|---|---|
| (1) The pad is a **musical drone**, not noise | **CONFIRMED** | Three `OscillatorNode`s, types `sine`/`triangle`/`sine`, detunes `−7 / 0 / +5.5` cents (12.5 cents of spread, so it beats rather than being one wobbling pitch). Every voice's `frequency` is a pitch of **A natural minor**, checked with `12·log₂(f/110)` against a hard-coded `[0,2,3,5,7,8,10]` — *not* against the module's own scale, which would be circular. |
| (1) The progression is i–VI–III–VII | **CONFIRMED, and my first probe was wrong about it** | Chord 0 is `[0, 3, 7]` from its own root (a minor triad, Am). Chords 1–3 are `[0, 4, 7]` — **major**, which is correct: in natural minor VI and III and VII are F and C and G. The four roots over an hour are pitch classes `{0, 3, 8, 10}` relative to A = **A, C, F, G**, and nothing else. `MUSIC_CHORD_SECONDS` is 4.444 s and is **derived** (`beats·60/tempo`), not typed. |
| (1) A **slow filter LFO**, not a static filter | **CONFIRMED** | `pad.depth.sinks` contains `pad.low.frequency` — an oscillator into an `AudioParam`, 0.011 Hz (**91 s a sweep**), depth 190 Hz on a 480 Hz cutoff. The wobble reaches `osc.detune` on all three voices and never `osc.frequency`: it is a *pitch* LFO, not a level one. |
| (3) Finale silence on the **LATCHED** flag, and a **stagger must not pulse it back** | **CONFIRMED, and this is the pass's best decision** | `world.js` reads `finaleEnraged: this.state.finale === true` — the flag, never `this.creature.state`. On a real world I put the creature through `stagger → stalk → chase → dormant → reposition → enraged → stagger → stagger` with a live 1.4 s recoil, and through a **capture** (`phase: 'reset'`) mid-finale: the music is silent on all of them, and still silent on the black. Five mutants, including the two exact shapes this review names, are killed. |
| (3) One low tone **rises after** | **CONFIRMED** | 41.2 Hz, level 0.026, rise 1.6 s, and it is connected to `music.bus` while `music.hiss.level` is connected to `music.level` — so the tone is genuinely **below** the ladder and the cut cannot take it. Both halves are separate `GainNode`s and I read the edges, not the comment. |
| (4) Own bus, and the **world bed keeps breathing** | **CONFIRMED** | `music.bus.sinks` = `[master]`; `music.bus.sinks` does **not** contain `ambient.bus`, and `ambient.bus.sinks` does not contain `music.bus`. Path-walking the edge table in both directions finds no path either way. Through the finale the room tone and the wind are still routed above 0, the `gust` cursor still advances, and the pad is still at 0 after 600 further frames. |
| (5) Autoplay gate, determinism, pause — **same as pass 13** | **CONFIRMED** | A headless manager routes a full frame and every routed voice and never becomes ready, builds no graph and advances no cursor. `musicVoice` is a pure function of its frame. The world's `animTime` is frozen by §14.3 **before** the audio is updated, and I held a five-real-minute pause and the chord did not move once. |
| (6) No external files, no CDN | **CONFIRMED** | `dist/` = 4 files. Zero `decodeAudioData`, `new Audio(`, `XMLHttpRequest`, `createMediaElementSource`, and zero `.mp3/.wav/.ogg/.m4a/.flac`. The one `fetch(` is React's `<link rel=preload>` helper; the seven `http` strings are `react.dev/errors` and W3C namespace URIs. The bundle is **byte-identical** before and after this review (md5 `44ec6bd4…`) because I changed no source. |
| (7) The two **self-caught bugs** | **ONE GATE WAS FAKE — see below** | BUG 2 (the `{osc, gain}` pairs) is caught two ways. BUG 1 (the pad constructed at nominal rather than silent) was caught **by nothing**, and I have now given it a gate. |

## The two defects, and what I changed

### DEFECT 1 — the finale's ORDER was a table claim and nothing else

`MUSIC_FINALE`'s docblock says the order *is* the beat: the cut is instant and the tone is slow, "a pad that took its own tone with it would be a cut and not a cut". Its neighbour three lines up already asserted the shape of its own half against `applyMusic`:

```js
claim('the cut is a cut and not a duck',
  api.MUSIC_FINALE.cut < api.MUSIC_PAD.levelTau / 3
    && /params\.silent === true \? MUSIC_FINALE\.cut : MUSIC_PAD\.levelTau/.test(apply), …)
```

The tone's half asserted **only** `api.MUSIC_FINALE.tone.rise > api.MUSIC_FINALE.cut * 5` — a statement about the *table*, which is true however the code *uses* it. I replaced the call site's `MUSIC_FINALE.tone.rise` with `MUSIC_FINALE.cut` and the repository was **285/285 green**. The low tone would have arrived in 0.12 s with the music leaving it, which is precisely the "reads as a switch rather than as something left behind" the docblock argues against.

**Fix, in three forms, because they are not the same claim:**

1. **The wiring, as a source contract** — the claim now also requires `/params\.tone > 0 \? MUSIC_FINALE\.tone\.rise : MUSIC_FINALE\.cut/` against `apply`, matching the sibling's discipline exactly.
2. **The wiring, measured** — and this is the stronger one. I taught the shared `fakeAudioContext` stub to record the `setTargetAtTime` time constant (`taus`, `lastTau`), and the real-AudioContext check now asserts that on the finale frame the pad and the hiss were **written with tau 0.12** and the tone **with tau 1.6**. A number, read off the automation the graph was actually given.
3. **Two mutants in the committed harness**, `the low tone arrives with the cut` and `the low tone leaves as slowly as it arrives`, both naming that claim — so the harness's own invariant ("every claim is covered by at least one mutation") still holds and the gap cannot reopen silently.

### DEFECT 2 — one of the two self-caught bugs had no gate at all

The commit message says the implementer caught "the pad constructed gain at nominal not silence". The fix **is** in the file (`level.gain.value = 0.0001`, with a docblock explaining why the other voices in the class *cannot* do the same). I re-introduced the exact bug:

```
level.gain.value = 0.0001   ->   level.gain.value = MUSIC_PAD.level
```

**285/285 green.** No source match, no number, and no graph probe saw it. `audio.js:2418` argues the case at length and nothing in the repository could tell whether the argument was still true. The same was true of the hiss, of the finale's tone, and of the `−1` sentinels the whole discipline rests on.

**Fix, measured rather than matched.** In the recording-stub check I read the three gains **straight out of the builder, before anything routes a level**, and assert the four caches are `−1` sentinels. The placement is the whole point and I got it wrong first: an assertion placed *after* the first `update` passes whether or not the graph was ever silent, because the router overwrites all three gains on that frame — my first version of this check failed with `the ladder was constructed at 0.04484, not silent`, which is the bug it is written for. The claim is also in `musicClaims` (so the source-contract list covers it) and **three mutants** in `MUSIC_MUTANTS` name it, one per gain.

Both defects are **gaps in evidence, not defects in behaviour**. `src/game/audio.js` and `src/game/world.js` are unchanged by this review. That is the honest summary: the pass's code was right, and its two strongest claims were the two nothing could check.



## My own battery, and what it found

Three instruments, kept separate on purpose, because they answer different questions:

- **My own probes** (a recording `AudioContext` with edge-tracing and tau capture; an independent hard-coded reference scale) ask *is the claim true*.
- **The repository's own gate** run against a mutated sandbox tree asks *is there a check in this repository that catches it*.
- **The sandbox is byte-faithful** (285/285 + 107/107 before I touched anything) and is rebuilt from the **live repository**, never from itself. My first `prepare()` copied the sandbox into "pristine", an earlier run of mine had been killed mid-loop and left a mutant there, and I was one mutant away from publishing a kill rate measured against a stale file. Every anchor must match **exactly once** or the mutation is refused.

**60 mutants through the repository's own gate, plus 3 more through my own claim** (28 + 11 + 8 + 13, and 3). 56 are killed outright, 3 more by the gates this review added, and **one** is left standing — and none of the four is a gate gap:

| Survivor | Verdict |
|---|---|
| `the finale fades rather than cuts` | **My tool's bug, not a gap.** `String.replace` with a string pattern replaces only the *first* of two occurrences, so the mutant was half-applied and the gate was right to ignore it. With `replaceAll` it dies. I nearly filed this as a surviving gate gap. |
| `the low tone arrives with the cut` | **The real gap.** Fixed and proved fixed. |
| `the low tone leaves as slowly as it arrives` | Fixed and proved fixed. |
| `the motif is audible before the run begins` (the `started &&` dropped from the `motif` line only) | **Not a gap, and chasing it would be gate-theatre.** `musicVoice` is only ever called from `routeAudio`, which returns `[]` for a non-started frame, and the gate holds *that* at `verify.mjs:5872`. The dropped `started &&` makes `motif` inconsistent with `level`/`hiss` in unreachable code. Defence in depth, already held one level up. |

Two more of my mutants are worth naming because the pass got them right and I nearly did not: the pass-13 **regression control** — I first aimed it at `duckAmbient`, the method the pass-13 review explicitly said was *always right*, and it survived, because the only `duckAmbient()` call in the suite is on a **headless** manager where `this.ambientGain` is `null` and the line short-circuits. The bug the review actually found was in `applyDrone`; pointed there it is killed by the recording-stub check, as the pass claimed. And the pad-is-noise mutant (`createOscillator` → `createBufferSource`) is killed by the source contract, which is the only thing that can see it: a `BufferSource` has no `.detune`, so a graph-level probe would throw rather than measure.

## The world checks the pass states and does not hold

The pass says it ran the stagger mutant *ad hoc*. A mutant with no committed check behind it is a story, and the first pass to retune `_audioFrame` would have found nothing. I committed four world checks (107 → 111), each mutation-tested:

- **`a STAGGER in the finale does not pulse the silence back (§7.4, §10.2)`** — eight creature postures with a live recoil, then a capture. Kills five mutants, including `finaleEnraged: this.creature.state === 'enraged'`, `… || this.creature.state === 'stagger'`, and `… && this.creature.state === 'enraged'`.
- **`the progression is frozen by a pause, over five real minutes of one`** — and it asserts against `animTime`, not against the paused frame. A paused world hands the audio `{ started: false }` and *no facts*, so reading `lastFrame.time` there is reading nothing; I got that wrong on my first attempt, and the check the pass already had had documented the trap in detail.
- **`the world hands the music its own clock, and the LATCHED finale flag`** — a deliberate *source* read of `world.js`, plus an assertion that `animTime += dt` is **after** the pause's `return`. A claim about a line in `world.js` asserted only by behaviour survives a well-behaved substitute, and a substitute handing the audio its own `performance.now()` is the exact bug the sibling block exists to catch. Kills both mutants.
- **`two worlds of one seed hear the same music, and two seeds do not`** — a *second* `BellLoopGame`, so the comparison is run-against-run rather than check-against-itself, and it asserts the determinism is not the trivial kind where every run sounds identical.

## Four probe results I want to retract

Adversarial review is only worth anything if it publishes its own false alarms. All four were mine:

1. **"Every chord is a minor triad" — FALSE ALARM.** My first probe asserted `[0, 3, 7]` for all four chords and chord 1 came back `[0, 4, 7]`. I was wrong: i–VI–III–VII in natural minor is Am–F–C–G, and three of those are major. The probe was the defect; the pass was right.
2. **"The four roots are not A, F, C, G" — FALSE ALARM.** My reference pitch-class set was wrong: relative to A, F is 8 and G is 10, not 5 and 7. The result `{0, 3, 8, 10}` *is* A, C, F, G.
3. **"The music level is not monotone" — FALSE ALARM.** I walked the distance upwards and asserted a fall. The music *swells* as the creature recedes; I had the axis backwards. The corrected walk (distance downwards, level must never rise) passes over 240 samples.
4. **"The hiss survives the finale's cut" — FALSE ALARM, and the interesting one.** `hissDepth.connect(hissLevel.gain)` puts a ±0.0011 LFO on a gain whose routed level is written to **0** on the finale, so the residual looked like a hiss still breathing under the silence. It is not: the hiss lands on `music.level`, the ladder node, which goes to 0.0001 — a factor of 10⁴ downstream. The docblock's claim that the hiss is taken with the cut is structurally true, and the LFO is the only thing in the file that looks like a counter-example.

Two more that were mine to get right and were not: a units error (`1200·log₂` for a semitone instead of `12·log₂`), and three mutation anchors off by one level of indentation, which the exactly-once rule caught for me — which is the entire reason that rule exists.

## Remaining gaps, recorded honestly

1. **The gate has a fake `AudioContext`, not a browser.** Mine is stricter than the repository's, and it is still a stub: it does not sound, it does not model `StereoPanner`'s law, and it cannot tell a graph that is wired *well* from one wired *badly* — only one wired to a parameter of the wrong shape. The one browser-shaped bug in this file's history was found by a stub, and the next one may need a browser.
2. **No capture frame photographs the music.** The pass adds no pixels, so §16.5's luma gate has nothing to re-justify and nothing was re-photographed. That is correct. The right evidence for a bus and a ladder is a listener.
3. **The finale's ORDER is now gated, and the stub is what makes that possible** — so the check is only as good as the stub's fidelity on `setTargetAtTime`'s constant. It records the argument; it does not simulate the exponential approach, and whether 0.12 s is *perceptually* a cut is a listening question.
4. **The pad is audible, but whether it is *pretty* is not answerable here.** `MUSIC_PEAK` is **0.0700** against a `CREATURE_BREATH_LEVEL` ceiling of 0.085 — at **−23.1 dBFS**, inside the compressor's −14 dB knee, so the pad is never the thing being compressed. Whether A natural minor at A2 through a 480 Hz lowpass is frightening or merely dark is M8's own admission and I have nothing to add to it.
5. **`AESTHETIC-NOTES.md`'s tail is muddled, and it is not this pass's fault.** The end of the file now reads: §7's one-line summary → §8's pass-14 addendum → an **orphaned fragment of §1's numbered list** (items 4–7, with no items 1–3 and no heading under them). I verified with `git show 5b13663:AESTHETIC-NOTES.md` that the orphan **predates this pass**; pass 14 only inserted §8 between §7 and it. I did not fix it: moving §1's list is a different pass's rot and this review should not silently reorganise a file it is reviewing. **Recorded, not fixed** — it is a one-line move for whoever does.
6. **`restart()` does not rewind `animTime`, so BEGIN AGAIN resumes the progression mid-loop** rather than restarting at the seed's chord. This is the direct consequence of "a pure function of the world's clock" and the design asks for exactly that; it is documented nowhere, though, and a player who wins and restarts hears the loop where the world clock left it. Recorded, not fixed.
7. **The pad keeps sounding at its last level under the pause card**, because a paused world routes nothing and therefore writes nothing. That is pass 13's bed behaviour and this pass correctly inherits it; the pad's *chord* is what is frozen, and the chord is the part that would read as "the game is still running". Recorded so a later pass does not rediscover it as a bug.
8. **Five pre-existing lint warnings**, unchanged by this pass and not introduced by it.

## What I changed

- **`verify.mjs`** — no gate weakened, three added, two strengthened:
  - `musicClaims`: the tone's ORDER is now asserted against `applyMusic`'s **wiring**, not only against the table.
  - `musicClaims`: a new claim, *"a music graph built and then told nothing is silent"*, over the three constructed gains in `_buildMusic`.
  - `fakeAudioContext`: the shared stub now records `setTargetAtTime`'s **time constant** (`taus`, `lastTau`). This is what let the ORDER become a measurement rather than a grep.
  - The real-AudioContext check reads the three constructed gains **out of the builder, before the router touches them**, asserts the four `−1` sentinels, and asserts the tau actually written on the finale frame.
  - `MUSIC_MUTANTS`: **five rows added** (tone arrives with the cut, tone leaves as slowly, and one per constructed gain), each naming its claim.
- **`verify-world.mjs`** — **four checks added**, 107 → 111: the stagger, the five-minute pause, the world-source read, and the two-world determinism. Each mutation-tested against a named mutant.
- **`src/game/audio.js`, `src/game/world.js`** — **unchanged.** The `dist` bundle is byte-identical.

The pass did the thing the user asked for. A minor pad on its own bus, ducked on the creature, cut on a latch, with a piano note an octave above it on the same scale — and the two things I found are the two things it *said* about itself and could not prove.
