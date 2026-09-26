# REVIEW — iteration 2, pass 1

- **Commit under review:** `1a444f8` — "iter2(1): yellow-tinted cinematic dusk - sky, fog, hemisphere, exposure"
- **Reviewer verdict:** **FIXED** — the design is right and is now on the evidence; two defects found and repaired in `iter2(1) review: fixes`.
- **Gate at verdict time:** 191/191 pure, 44/44 world, lint clean, build green, 14/14 captures.

## What the pass does

Moves both atmosphere ramps out of violet and into sodium ochre, and flattens the
exposure curve so the world is no longer paying for darkness during the acts where
the player is supposed to be looking at it.

| | before | after |
| --- | --- | --- |
| `skyStops` | `0x2a2233` / `0x4a3550` / `0x12101a` | `0x6b5836` / `0x7a6440` / `0x3f3320` |
| `fogStops` | `0x241d2a` / `0x1e1826` / `0x141018` | `0x574a30` / `0x6a5938` / `0x332a1c` |
| hemisphere | `0.5 - 0.22t` | `0.85 - 0.18t` |
| horizon key | `0x6b4a6b` @ 0.32 | `0xffc27a` @ 0.34 |
| exposure | `0.95 - 0.17t` | `1.02 - 0.14t²` |

The diagnosis in the commit message is correct and is the right diagnosis: the
report was "the world is too dark to see things", and the cause was a **hue**
before it was a level. A violet sky reflects nothing amber back at a street lit
entirely by amber, so raising the violet would have raised the wrong thing.

## The three claims that had to survive, and whether they did

Each was checked against rendered frames, not against the commit message.

1. **The ramp still closes.** Measured sky stop 0 is 1.71× stop 2 in 8-bit
   Rec. 601 and 2.94× in linear relative luminance. Confirmed.
2. **The mid stop is still the crest.** `0x7a6440` (luma 102.5) is above stop 0
   (89.8), so the sky still reads as lit overcast rather than a flat wash.
   Confirmed, and the new pin test holds it.
3. **The creature is still a hole in the fog.** This is the one that mattered,
   because a whole-world brightening is exactly the move that can erase the
   subject. Scene-half percentiles on `creature-stalking`:

   | | min | p0.1 | p1 | p5 | median | p95 |
   | --- | --- | --- | --- | --- | --- | --- |
   | before | 5 | 7 | 9 | 11 | 20 | 57 |
   | after | 4 | 7 | 10 | 14 | 24 | 62 |

   The 0.1 percentile is **unchanged at 7** while the median rose 20 → 24 and p95
   rose 57 → 62. The atmosphere lifted and the subject did not. The trick worked.

## Findings

### 1. BLOCKER — two gate tests were nested inside another, and silently vanished on failure

`verify.mjs:6441` opened `test('the fog is darker than the sky at every stop …')`.
Its closing `})` was missing: line 6452 closed only the `for` loop, line 6453 was
blank, and line 6454 opened the next `test(`. The stray `})` at 6543 is what
actually closed the fog test. So **"the ambient and exposure curves…" and "the
constructor exposure is the curve at dusk 0" were registered from inside the fog
test's callback.**

`node --check` passed and the suite reported 191/191, because at HEAD nothing in
the fog test fails. The bug only appears when the fog assertion throws — and then
the two nested tests are never reached, so they never register, never run, and
never report. A regression in the silhouette rule silently disarms the entire
exposure/ambient section of the gate.

Reproduced on a full copy of the tree, breaking **only** the fog-under-sky
property (`fogStops[2] = 0x7a6440`, above `skyStops[2]`):

```
before the fix:  186/189 checks passed — 3 FAILED     (denominator fell 191 -> 189)

### 2. BLOCKER — the pass shipped no capture artifacts, so its own evidence was unverifiable

`git show --stat 1a444f8` touches 5 files: `GAMEDESIGN.md`, `streetView.js`,
`world.js`, `verify.mjs`, `verify-world.mjs`. **No screenshot and no
`benchmark/captures.json`.** The committed `street.png` is byte-identical to the
pre-pass frame (sha256 `5ba7da49…`), so `main` was still showing the violet world
the pass exists to replace, and every luma figure in the commit message described
a build nobody could see.

This matters more than a missing artifact usually does, because this benchmark's
result tables are built from those PNGs, and `verify.mjs`'s own anti-rotation
check only asserts the files *exist* and are over 20 KB. A stale frame passes it.

**Fix:** regenerated the gallery. `npm run capture` → **14 captured, 0 failed**,
mean luma 57.006%, tightest margin `win` at 10.1% against a 6% floor. Measured
before → after on the lower scene:

| frame | before | after |
| --- | --- | --- |
| `title` | 4.60% | 8.19% |
| `street` | 52.80% | 74.09% |
| `creature-stalking` | 63.53% | 84.28% |

Note `street` before is **52.8%**, not the 56.3% quoted in the commit message —
that figure does not match the committed frame, and full-frame luma on the same
file is 71.4%, so 56.3% appears to be from neither measurement. The direction and
rough magnitude of the claim hold; the specific before-number is wrong.

Consequence worth recording: `README.md` claimed `title` was the tightest frame
at 4.6% (+1.1) and mean luma was 46.237%. After the retune the binding
constraint **moves off `title` for the first time since slice 16** — `win` is
tightest at +4.1, with `title` second at +4.69. README updated to match.

### 3. MINOR — the exposure comparison was arithmetically wrong in three places

`world.js` and `GAMEDESIGN.md` claimed the new curve "costs 1.75%" at `t = 0.5`
where the old cost 8.5%. Measured:

- old: `0.95 − 0.17(0.5)` = 0.865, i.e. **8.9%** of its 0.95 base surrendered
- new: `1.02 − 0.14(0.5)²` = 0.985, i.e. **3.5%** of its 1.02 base surrendered

1.75% is half the real figure (it is the drop measured against 1.0 while the base
is 1.02, then halved again somewhere), and 8.5% should be 8.9%. The *claim* the
numbers support — the new curve is far flatter through Act I — is still true, and
more true than stated. Corrected in all three locations.

### 4. MINOR — "3.0x to 9.8x in relative luminance" was ambiguous, not wrong

The range is correct **only** in linear relative luminance (sky 2.97×–6.15×, fog
4.18×–9.81×). In 8-bit Rec. 601 — the space every other number in the same
comment is quoted in, and the space `tools/png-luma.mjs` measures in — the lifts
are only 1.64×–3.30×. A reader checking the claim against the luma table directly
below it would find a contradiction. The comment now states which space it means
and gives both.

## What the pass got right, specifically

- **Naming the constants.** `EXPOSURE_BASE`/`EXPOSURE_CUT` exist so the
  constructor and `_applyDusk` can be asserted to agree. A literal in one writer
  and a constant in the other is a real bug class, and it is now gated.
- **Asserting the call site, not just the constants.** The commit's own account of
  finding this by reverting the curve and watching the test stay green is the
  right instinct, and the `[^\n;]` tightening of the regex (a whitespace-permissive
  character class let the match run onto the next line) is a careful fix.
- **Splitting loose properties from a value pin.** Warm / lighter / closes /
  fog-under-sky are properties that should survive a future mood pass; the exact
  six hexes are a decision that should fail loudly when changed. Having both, with
  the pin's failure message naming the remedy, is the correct arrangement.
- **Keeping fog below sky rather than matching it.** The one deliberate
  departure from "mono-yellow", and it is the departure that makes §12.1's
  silhouette rule possible. Gated pairwise at all three stops, not just at
  whichever stop the captures happen to show.
- **Not flattening the sodium grid.** Hemisphere at 0.85 rather than 1.0, on the
  reasoning that the lamps have to stay the brightest thing on the road. Correct,
  and visible in the captures: the pools still read as a grid you steer by.

## Residual risk

- The two ramp families are pinned to exact hexes, so pass 2 will trip the pin on
  purpose. That is the intended behaviour; the pin's message says so.
- The creature silhouette is currently protected by a *source* property
  (fog < sky) plus a *rendered* observation I made by hand. Nothing in the gate
  measures creature-vs-background separation in a frame. A future pass that lifts
  the fog without lifting the sky could satisfy every existing check and still cost
  the subject its read. **This is the most valuable gate to add next.**
- `README.md`'s gallery prose is hand-maintained and was already stale before this
  pass. It is corrected here, but nothing keeps it honest.

## Verdict

**FIXED.** The retune is the right change for the right reason, the three
properties it had to preserve are preserved in the rendered frames, and the gate
genuinely grew. Two blockers were real: a test-nesting bug that let a regression
disarm two other tests without a word, and a whole-gallery omission that left the
pass's own evidence unviewable. Both are fixed here, the exposure arithmetic is
corrected, and `npm run check` is green at 191/191 and 44/44.

                 grep for the two exposure tests: 0   (they never ran)
after the fix:   188/191 checks passed — 3 FAILED     (denominator held at 191)
                 grep for the two exposure tests: 2   (they still ran)
```

The tell in the original output is the ordering: "ambient and exposure" and
"constructor exposure" were printed *before* the fog test that contains them.

**Fix:** added the missing `})` after the `for` loop and removed the orphan at
6543. Section now reports in source order and the denominator is stable under
failure. This is the same bug class the commit message already caught once (the
exposure test that "never read the call site") — found again by probing rather
than reading, which is the only way it shows up.
