# REVIEW — pass 19 (debt sweep)

Reviewer: independent session, did not write this pass.
Reviewed: `97c67f5` "iter2(19): debt sweep", against `01b1a04`.
Gate at verdict time: **306/306 pure** (unchanged), **113/113 world** (unchanged),
`npm run check` exit 0, `vite build` clean.

## VERDICT: FIXED

The pass is real work and four of its six ledger items hold up under checking. The
new pacing gate is the right *kind* of gate — an order, not a duration, which is
the only honest form available without a design decision — and §16.6.1 is an
accurate record. But the gate's own headline artefact, the "one ordering
assertion", does not do the job the pass says it does, and the same defect
appears three more times as a name, a print, and a checklist line. That is a
pattern, not a typo, and it is exactly what this pass was chartered to sweep.

Five real defects fixed, listed below. No gate was weakened, retuned, deleted or
re-thresholded. Gate counts are unchanged at 306 pure and 113 world.

---

## Finding 1 — the "ordering assertion" could not see an order (FIXED)

**This is the substantive finding.** The pass's central claim about its new gate
is:

> M3 swap ONLY the expected order, world untouched -> RED... M3 is the one that
> matters: the three facts above are also each asserted on their own, so a gate
> that only had them would have gone green on a world that satisfied every one of
> them and none of them in sequence.

M3 does go red — I reproduced it (see the mutation table). But it goes red
because the array literal changed, which proves the comparison is wired up and
nothing else. The order it compared was **not the world's**.

I instrumented the real harness to record the frame each beat first reads true:

```
PROBEFRAMES {"control":0,"sighting":0,"dissolve":0} distinctFrames=1 finalI=0
```

**All three beats are true on frame 0 — the very first `update(DT)` after
`start()`.** So the pass's loop

```js
if (ordered.player.enabled && !seen.includes('control')) seen.push('control')
if (ordered.creatureView.root.visible && !seen.includes('sighting')) seen.push('sighting')
if (ordered.fade < 1 && !seen.includes('dissolve')) seen.push('dissolve')
if (seen.length === 3) break
```

breaks on its **first iteration**, and `seen` is `['control','sighting','dissolve']`
purely because of the order those three `if` statements are written in. The array
is a description of `verify-world.mjs`'s own source. It would read identically on
a world in which the three beats are simultaneous, and the printed
`opening order: control -> sighting -> dissolve` is therefore a statement about
the harness, presented as a measurement of the game.

The array form is also weak in a way the frame form is not: it accepts a world
that hands the player control on frame 0 and the sighting on frame 30, because
such a world still pushes `'control'` first whenever the dissolve has not yet
lifted past the sighting's arrival.

**Fix applied.** The order is now recorded as the frame each beat first reads
true and asserted as a relation between frames:

```js
assert.equal(at.control, at.sighting, ...)   // control and sighting arrive TOGETHER
assert.ok(at.dissolve >= at.control, ...)    // input is not gated behind the picture
```


## Finding 2 — the check's own name asserted the reverse of its contract (FIXED)

The check was named:

```
the opening beats arrive in §6.1's order: dissolve, control, then the sighting
```

and asserted `['control', 'sighting', 'dissolve']`. **The name is the exact
reverse of the assertion.** This is visible in the M3 red output itself, where the
FAIL line and its own message contradict each other on adjacent lines:

```
FAIL  the opening beats arrive in §6.1's order: dissolve, control, then the sighting
      the opening beats arrived in the order control -> sighting -> dissolve; ...
```

On a pass whose sixth ledger item is "doc comments match reality", shipping a
gate whose human-readable name states the inverse contract is the finding, not a
nitpick. Renamed to *"the opening beats arrive in one order: control and sighting
first, the dissolve after"*, which is what it asserts. The same inversion was in
`ITERATION-2-CHECKLIST.md` ("the ORDER of title-dissolve → spawn-control → first
telegraph") and is corrected there too.

## Finding 3 — the honest print contained a hardcoded copy of a source constant (FIXED)

The pass's justification for printing rather than asserting the 15.93 s figure is
that "a debt nobody can re-measure quietly stops being true". Good reasoning —
but the same line printed the dissolve duration as `(1 / 0.7)`, a **second copy
of `world.js`'s `FADE_LIFT_PER_SECOND`**. Retune that constant and the print,
whose entire job is to stay true, silently goes stale and nothing notices.

Now measured off the built world in the beat loop, and it reproduces the review's
figure exactly rather than approximating it:

```
the dissolve clears at frame 85 (1.42 s)
```

was `the dissolve clears at 1.43 s` from the hardcoded arithmetic. (The pass-18
review measured 1.42 s; the measured value now agrees with it.)

The 15.93 s figure itself is honest and I reproduced it: the gate prints
`loses the sighting at 15.93 s`, matching REVIEW-pass-18 line 121 to the digit.
**The decision not to assert a duration is correct and I endorse it** — a
threshold encodes an answer to a pacing question no pass has been authorised to
answer. The gate declines it in the right place.

## Finding 4 — `GAMEDESIGN.md` had two sections numbered 16.5 (FIXED)

The pass renumbered `### 16.4 Deferred scope` to `### 16.5 Deferred scope` while
adding a new `### 16.6`, leaving:

```
952: ### 16.5 Deferred scope
964: ### 16.5 The twelve captures
```

Two sections, one number, in the design document that is the authority for the
whole repository. Worse, §15.4's cross-reference was updated in the same diff
("the twelve captures in §16.4 exist" → "§16.5") so it now points at a number
that matches **two** sections. The intent was presumably to free a slot for 16.6;
the cost was that `§16.5` — cited in 40+ places across `verify.mjs`,
`tools/capture.mjs`, `README.md` and every prior review, where it always means
*The twelve captures* — became ambiguous.

**Fix applied:** restored `### 16.4 Deferred scope`. The sequence is now 16.1,
16.2, 16.3, 16.4, 16.5, 16.6 with no collision, and §15.4's `§16.5` resolves
uniquely to *The twelve captures*. This is the correct fix rather than
renumbering the twelve-captions section, because the twelve-captions number is
the one under load.

## Finding 5 — a verification claim in the commit message cites a file that does not contain it (recorded)

The commit says:


## Claims verified as accurate

**(1) The pacing gate exists, is in the right file, and is not `restart()`-based.
CONFIRMED.** It lives at `verify-world.mjs:828`, reads `game.fade`,
`game.player.enabled` and `creatureView.pose` — none of which the pure harness
can import. The reasoning for building its own world is sound and I checked the
premise: `restart()` at `world.js:2585` sets `startedOnce = true` and never sets
`player.enabled = false`, so it genuinely cannot produce the title-card
precondition the first three asserts depend on. Not weakening anything.

**(2) §16.6.1 numbers match REVIEW-pass-18. CONFIRMED, all of them.** Cross-read
line by line: 112 → 110 → 108 of 112 (pass-18 line 88); `STREET_HALF_WIDTH` = 6
as the **carriageway**, kerb 6.4, walk to 9.4 (lines 68-70); candidate A's 2.50 m
inside 0..6, so it **passes** the weaker invariant, which "says nothing about
*where along the frontage* the body stands" (line 73) — the correction is stated
correctly and is the more interesting half of the finding; 5.09 m nearest lamp at
180° off-axis behind the camera vs 60.5 m in-FOV (line 81); 15.4 m is a
`colliders()` footprint, 0.22 m = `POLE_DIAMETER`, with `occluders()` returning
**OPEN** (line 82); and the honest residual, "no lamp in the first 37 m" (line
84). §16.6.2 and §16.6.3 also check out — the `SPEED_CEILING * 0.85` gate is real
at `verify-world.mjs:3347`, and 4.62 − 4.42 = 0.20 m/s = 4.5% is arithmetically
right.

**(3) Dead code: `allProbeSteps` gone, zero references, CSS false positives
genuine. CONFIRMED.** The function is deleted from `src/game/capture.js` and a
repo-wide grep across `.js/.jsx/.mjs/.md` returns **one** hit — the checklist
line that describes the deletion. Not referenced by either harness. I spot-checked
the CSS false positives: `src/ui/Hud.jsx:63` builds the class as
`` `sigil sigil--${mark.state}...` `` and `hud.js:126` sets `SIGIL_LIT = 'lit'`,
so `.sigil--lit` at `styles.css:267` is reached by template, not by a literal
string a grep would find. The data-URI case is `.grain` (`styles.css:88`), also
built by template at `Hud.jsx:100`. Both are genuine false positives.

**(4) Docblocks spot-checked — three of the six confirmed fixed.**
`skyView.js` header is now "WHY NO POOL" and states the pass-17 reversal
explicitly; the contradiction it used to sit above is real and now resolved
(`InstancedMesh` at `skyView.js:804`, forty-two parts, 542 triangles).
`hud.js` HUD_BACKDROP: `git log -S 'background: var(--bg)'` returns `bd4573f` —
pass 18, as the corrected docblock now says, not PASS 1. `audio.js`: four
priced-at-0 rows confirmed (`roomTone`, `hazeWind`, `facility`, `drip`, all
`kind: null` in `AUDIO_ROUTES`), and `gust` is indeed in `AMBIENCE_SPECS` with no
`AUDIO_ROUTES` row, exactly as the corrected text says. The pass-17 "bit-identical"
correction is genuinely held: `verify.mjs:17821` fails if the phrase returns, and
`AESTHETIC-NOTES.md:757-777` carries the 9.2e-8 float32 residual.

**(5) Gallery deliberately not re-shot. CONFIRMED, and the reasoning holds.**
Filtering `git diff 01b1a04..97c67f5 -- src/ capture/` to non-comment lines yields
**exactly three lines**, all of them the `allProbeSteps` deletion:

```
-export function allProbeSteps() {
-  return CREATURE_PROBE_VIEWS.flatMap((view) => view.steps.map((step) => ({ view: view.id, step })))
-}
```

No pixel can have moved. Correct call, and correct reasoning for not re-shooting
fourteen frames to re-justify a comment edit.

**(6) Gate green. CONFIRMED** — 306/306 pure, 113/113 world, `npm run check` exit
0, `vite build` clean, before and after this review's fixes. `oxlint` exit 0.

## Mutation record (mine, all applied to the real harness and reverted)

| # | Mutation | Result |
|---|---|---|
| M3 | swap the expected order, world untouched | **112/113 RED** — reproduced the pass's claim. Also exposed the name/message contradiction. |
| probe | instrument beat frames | **all three beats at frame 0** — the basis of Finding 1 |
| M4 | delay the sighting one frame in `world.js` | **112/113 RED** on the individual fact; ordering block not reached |

Every mutation was reverted and hash-verified (`sha256sum -c` clean on both
`verify-world.mjs` and `src/game/world.js`); `git diff --stat` after the sweep
shows only the files this review intended to change.

## What I did not do

- I did not add a duration threshold. The pass's refusal is correct and the
  15.93 s stretch stays open debt, now attached to a number that is measured
  rather than copied.
- I did not re-shoot the gallery. Nothing in `src/` moved a pixel.
- I did not touch `src/` at all. The one code defect I found was in the harness
  that was checking it.

> creatureView.js checked and left alone - the hazeLayers stash, the
> _hazeStash tombstone and **the bodyFloor note** all still describe the code.

`bodyFloor` does not appear in `src/game/creatureView.js` at all. It lives in
`src/game/creature.js:1985` (`flicker: { rate: 5.4, depth: 0.62, floor: 0.06,
bodyFloor: 0.82 }`) and is gated by `verify.mjs:16648-16654`. The other two items
check out — `creatureView.js:605` builds `_hazeStash` once and `:964-980` refills
it in place, exactly as the comment describes — so the negative result itself
("creatureView.js is clean") is plausible. But one of the three cited checks was
performed against the wrong file, and it is recorded here because a commit
message is the artefact a future pass reads when it asks "did anyone already
check this?".

---

plus a completeness assert that all three landed inside the 1.5 s window. This is
**strictly tighter** than the array it replaces: equality where the array allowed
`<=`, and an explicit lower bound where the array relied on statement order. A
frame index is the one reading a same-frame world cannot fake by reordering
statements.

**Honest caveat, recorded rather than glossed.** The ordering assertion remains
*largely redundant* with the three individual facts above it, because `opening`
and `ordered` are two deterministic runs of the same code. I confirmed this with
a real world mutation:

> **M4 (new, mine):** delay the sighting by one frame in `world.js` — `start()`
> sets `_sightDelay = 1`, `_updateCreatureView` presents a null pose and returns
> for that frame. Harness untouched. Result: **112/113, RED**, but the failure is
> the *individual fact* — `and the first frame the player can act on has nothing
> on screen` / `false !== true` — and the ordering block is never reached.

So the gate is not toothless, but the ordering assertion is not independently
load-bearing either. The fix makes it an honest, strictly stronger expression of
the contract rather than a stronger claim than the harness can support. I have
said so in the code rather than letting the next pass read "ordering assertion"
and assume a sequence is being checked.
