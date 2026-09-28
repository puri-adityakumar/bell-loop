# REVIEW — iteration 2, pass 18

- **Commit under review:** `bd4573f` — "PASS 18: paint the sigil backdrop the contrast gate assumes; revert the spawn move".
- **Reviewer verdict:** **MOSTLY FIXED, with one hole the pass reopened itself.** The sigil plate is real and correct. The spawn revert is byte-identical to HEAD, as claimed. But the new source-contract gate `bd4573f` added to hold that plate in place — the thing the pass points at as its proof — **survived four mutations and false-positived on two harmless reformats of a correct stylesheet. It was worse than no gate in both directions.** Two docblocks describing the spawn geometry were false about it. All three defects are corrected here; the framing numbers the pass was sold on are retracted, with the measurements that replace them.
- **Gate at verdict time:** 306/306 pure (unchanged count — the corrections land inside existing checks, plus a small CSS reader exercised by that same test), **112/112 world** (unchanged), `npm run check` exit 0.

> **Honesty note on the count.** The pure count did not move: 306 → 306. The hardened gate replaced one fragile regex inside an existing test with four independent claims inside that same test, and added a five-function CSS reader used only by it. The honest description is "a gate that could not fail now can fail six different ways, and no longer cries wolf on whitespace," not "three more checks."

## Verdict on each claim I was asked to check

| Claim | Verdict | Evidence |
|---|---|---|
| The sigil plate is real: `.hud__sigils` now paints opaque `--bg`, and the contrast clears 3:1 on real pixels | **CONFIRMED, browser-verified** | Live page (`vite preview` + puppeteer): computed `background: rgb(3,4,7)` = `--bg`, `opacity: 1`. Framebuffer scan through the first sigil reads plate `#020305` and lit ink `#3ad6d6` (= `PORTAL_SIGIL_LIT` exactly) → **11.56:1** against a 3:1 floor. See Finding 1. |
| The spawn revert is byte-identical to HEAD | **CONFIRMED** | `sha256(src/game/neighborhood.js)` = `git show HEAD:…` = `30fe4f70…`. `git diff HEAD` on `src/` is empty. See Finding 5. |
| The new source-contract gate holds the plate in place | **FALSE — it survived four mutations and two false-positived. Fixed.** | The single regex `/\.hud__sigils \{[^}]*background: var\(--bg\)/` was defeated by renaming the class in the JSX, by leaving the declaration in a comment, by wrapping the rule in an at-rule, and by a later higher-specificity override — all four green. It also failed a correct sheet reformatted (brace on its own line; two spaces after `background:`). Replaced by a rule-reading gate; **all six holes now caught, both reformats tolerated.** See Finding 2. |
| `STREET_HALF_WIDTH` is the pavement; the spawn is on it | **FALSE on both counts. Fixed.** | `streetView.js` on the constant itself: *"Metres of road either side of a centreline; the kerb and the walk sit outside."* It is the **carriageway** (6 m each side). The kerb face is at 6.4, the walk runs to 9.4. The spawn sits **4.0 m off the centreline — in the road**, 2.4 m short of the kerb. And the assertion is the one candidate A **passes** (`toEdge` 2.50 m ∈ 0..6), so it is a weaker corner invariant, not what stopped the move. See Finding 3. |
| "nearest lamp 60.5 m → 19.6 m" / "a wall 15.4 m away" | **RETRAKTED. The labels are wrong; only 19.6 m is a distance.** | Nearest lamp to the spawn **full stop is 5.09 m at 180° off-axis** (behind the camera); 60.5 m is the nearest *inside the 52.3° half-FOV*. 19.6 m is candidate A's nearest in *any* direction. The 15.4 m "wall" is a `colliders()` **footprint** — a 0.22 m post = `POLE_DIAMETER` — and the kinded `occluders()` ray returns **OPEN**. See Finding 4. |
| Thin margin on the pursuit-speed gate | **CONFIRMED. Documented, deliberately NOT retuned.** | `verify-world.mjs` requires `pursuit[2] >= SPEED_CEILING * 0.85` = 4.42 m/s; measured last-third mean is 4.62 m/s → **+0.20, a 4.5% headroom**. Standing risk; no threshold touched. See Finding 6. |
| Reduced motion is gated | **CONFIRMED** | `verify.mjs`: "reduced motion resolves the OS preference…", "…suppresses exactly three things", "…path through the tells keeps the information", and the `animation: none !important` source check. |
| Pacing of the first 30 s is gated | **NOT DONE — no gate, by design-decision, not oversight.** | Probed; see the NOT-DONE section. This is the one thing in the pass I am **not** closing, with a concrete proposal and the reason it needs a design call first. |

## Finding 1: the sigil plate is real, and the contrast holds on real pixels (CONFIRMED)

The pass's landed half is good, and I confirmed it three ways, because a claim about painted pixels deserves a painted-pixel check:

1. **Computed style, live page:** `getComputedStyle('.hud__sigils')` → `background: rgb(3,4,7)` (that is `--bg`), `opacity: 1`, `box-shadow: rgb(3,4,7) 0 0 22px 10px`, four `.sigil` children present.
2. **Framebuffer:** a vertical scan down the first sigil reads the plate ramping to `#020305`, the lit ink body `#3ad6d6` (exactly `PORTAL_SIGIL_LIT`), and the ink-vs-plate contrast computes **11.56:1** against the 3:1 floor. The darkened ink sits at `#1b6361` on the way in, so the mark keeps an edge in greyscale, which is what §14.3 wants.
3. **Opacity note, recorded because it looked alarming and is not:** a computed read of the `.hud` wrapper's `opacity` returns `"0"` while the class is plain `hud` (no `hud--hidden`). That is the 0.8 s `opacity` transition sampled on a headless, throttled page, not a hidden HUD — the framebuffer scan finds the ink on screen. The plate is real.

One honest nuance, so nobody over-reads the pixel match: the plate's darkest interior pixel is `#020305`, one-to-two units off the `HUD_BACKDROP` constant `#030407`, because the 22 px/10 px same-colour shadow bleeds a little under the row's own edge. It is not an exact match and the contrast is unaffected (11.56:1 against a 3:1 floor has enormous slack). The plate does what it was added to do.

## Finding 2 (the serious one): the source contract survived its own mutants

`bd4573f` added exactly one line of new gating for the plate, inside "every sigil state is legible in greyscale, on the shell background":

```js
assert.ok(
  /\.hud__sigils \{[^}]*background: var\(--bg\)/.test(STYLES_SOURCE),
  'the sigil row paints no backdrop, so the contrast above is measured against a colour that is not behind it',
)
```

Its comment claims *"a contrast gate that cannot fail is worse than no gate."* Then the gate itself could not fail, **and could fail for free.** I ran six mutations of the real stylesheet/JSX against the real suite, each applied and restored, all against the committed tree:

| # | Mutation | What it does to the hole | Result on `bd4573f` | Result after this review |
|---|---|---|---|---|
| **M1** | Rename the class in `Hud.jsx` (`hud__sigils` → `hud__sigils-row`) | The CSS rule is **orphaned** — nothing renders with the plate | **SURVIVED (306/306 green)** | **caught** (exact-token JSX check) |
| **M2** | Delete the `background` declaration; leave the words in a CSS comment | The rule still *reads* as painted; the plate is gone | **SURVIVED (green)** | **caught** (comments stripped before the rule is read) |
| **M3** | Wrap the rule in `@media (prefers-reduced-motion: no-preference)` | The plate is painted only under one condition; `[^}]*` cannot see into an at-rule | **SURVIVED (green)** | **caught** (rule-reading marks it conditional) |
| **M4** | Add a later `.hud--still .hud__sigils { background: transparent }` | The cascade paints nothing; the regex still sees the original | **SURVIVED (green)** | **caught** (every background reaching the element must be the plate) |
| **M5** | Retint `--bg` in `:root` to `#564d37` | The sheet paints a colour the gate never measured | **unreachable — the old gate never looked at `--bg` at all** | **caught** (new: `--bg` must equal `HUD_BACKDROP`) |
| **M6** | Make the plate `rgba(3,4,7,0.5)` | A translucent scrim, not an opaque backdrop; the contrast drifts again | **green — the regex matches the text** | **caught** (the value must be exactly `var(--bg)`) |
| **B1** | Reformat a correct sheet: brace on its own line | **No change to what is painted** | **caught — FALSE POSITIVE** | **correctly green** |
| **B2** | Reformat a correct sheet: two spaces after `background:` | **No change to what is painted** | **caught — FALSE POSITIVE** | **correctly green** |

Four real holes and two cries of wolf. A contract that holds in neither direction is worse than none, because it is trusted either way: a green run after M1 is a lie, and a red run after B1 trains the next author to paste a fix without reading it.

**The fix** replaces the regex with a small CSS reader — `stripCssComments`, `cssBlockEnd`, `cssRules`, `cssDeclarations`, `selectorTargets`, `backgroundsFor` — and asserts four things instead of one:

- **(a)** at least one `background` reaches `.hud__sigils`, and **(b)** every one that does is exactly `var(--bg)` and unconditional (not inside an at-rule);
- **(c)** something actually renders with the class — with exact-token boundaries, because `hud__sigils` is a *prefix* of `hud__sigils-row` and a naive match passes the rename. The first version of this fix got that wrong too, and the code comment says so rather than quietly fixing it a second time;
- **(d)** `--bg` in `:root` is the same colour as `hud.HUD_BACKDROP` — closing M5, a fifth hole the original gate could not even see, because it never looked at the variable it was asserting on.

I chose to assert that *every* background reaching the element is the plate, rather than computing the cascade winner. Picking a winner means restating a cascade rule inside a test, which is how the regex came to be wrong in the first place; the stronger property is simpler and cannot be defeated by an override I failed to anticipate.

## Finding 3: the pavement docblock was wrong twice, and understated its own gate

The comment said the spawn is *"on the block's own frontage pavement, not in a garden: the strip is `STREET_HALF_WIDTH` wide,"* and the assertion's own failure message called the 6 m *"the pavement."* Both are false, and the correction is a matter of reading the constant's own docblock in `streetView.js`:

- `STREET_HALF_WIDTH` (6) is *"metres of road either side of a centreline; the kerb and the walk sit outside."* It is the **carriageway**, 12 m kerb-to-kerb. The kerb face is at 6.4; the walk runs 6.4 → 9.4.
- The spawn is 4.0 m off the centreline, so it is **in the road**, 2.4 m short of the kerb. It is not on the pavement, and the walk is 3 m wide, not 6.

The second error is the one that matters, because the comment implied this assertion is strong. It is not. Re-probing candidate A (`-189.5, -165.5`, the move the pass reverted) through `verify.mjs`'s own `toEdge` formula: **2.50 m, inside 0..6 — candidate A PASSES this check.** The reason is the `Math.min` over the two axes: the move slid 26.5 m *along* the frontage, leaving the across-the-road inset untouched. So this assertion holds the spawn off the far kerb and out of the gardens; it says nothing about *where along the frontage* the body stands, and it is **not** the invariant that stopped the move. What stopped the move is the 110/112 world regression, which is a different and much stronger claim.

The comment now says all of this plainly, and the failure message says "carriageway" rather than "pavement."

## Finding 4: the framing numbers are retracted, and the labels were the real error

The pass was sold on "the nearest lamp goes from 60.5 m to 19.6 m and the sightline opens past a 15.4 m wall." I re-probed the shipped framing and candidate A, each folded around itself. Two of the three figures are misdescribed, and it is the *label*, not the number, that is wrong:

- **"60.5 m nearest lamp"** — the nearest lamp to the spawn **full stop is 5.09 m away, at 180° off-axis, i.e. directly behind the camera.** 60.5 m is the nearest lamp *inside the camera's 52.3° half-FOV* at the shipped 45° yaw. The pass compared an in-frame-lamp metric against candidate A's nearest-in-*any*-direction distance and called both "the nearest lamp." For candidate A the two happen to coincide (19.58 m), which is exactly why the mismatch was invisible. Only 19.6 m is a plain distance.
- **"a wall 15.4 m away"** — there is no wall. 15.4 m is the first hit against `colliders()`, which is a list of 2-D **footprints** (`cx, cz, hx, hz`; no height, no kind). The rect at that range is **0.22 × 0.22 m — exactly `POLE_DIAMETER` — sitting 7.0 m off the far centreline, exactly `POLE_STANDOFF`.** It is a lamp post, which the player sees straight past. The same ray against `occluders()` (the kinded sightline list) returns **OPEN** at both the spawn and the candidate: nothing sight-blocking is within 6 m. The probe's own header had flagged this trap and then read the wrong list.

So the shipped opening is not a view walled off at 15.4 m; it is a view with **no lamp in the first 37 m**. That is a real and much smaller framing defect than "a wall," and it is the honest residual the pass should have recorded instead of the two it did. Corrected in the docblock with all four numbers and both lists named.

## Finding 5: the spawn revert itself is clean

Confirmed and worth saying plainly, because the pass's own first attribution of the move was wrong: `src/game/` is byte-identical to `bd4573f^` (`sha256` match on `neighborhood.js`), `SPAWN.position` is still `{ roadAxisToWorld(0) + 4, roadAxisToWorld(0) + 4 }`, and `SPAWN_YAW` is still `Math.PI * 0.25` at `world.js:67`. The 112/112 → 110/112 → 108/112 A/B in the commit message is the pass's own evidence and I have no reason to doubt its direction; what I am correcting is the *framing justification*, not the regression.

## Finding 6: the pursuit-speed margin is thin, and I am not touching it

`verify-world.mjs` gates the last third of a run at `pursuit[2] >= SPEED_CEILING * 0.85`. `SPEED_CEILING` is 5.2 m/s, so the floor is **4.42 m/s**, and the measured last-third mean is **4.62 m/s** — **+0.20 m/s, a 4.5% margin.** The gate's comment defends the 0.85 share ("what a straight-line measure of a street-graph walk actually keeps"), which is fair, but the consequence is that a small change to the ramp table, the aggression curve, or the pathing can turn this red for reasons unrelated to the trend it is actually checking (pursuit speed *rising* over a run, asserted by the two checks above it).

I am **deliberately not retuning it.** Moving a threshold so a suite goes green is the failure mode this whole review series exists to catch; the correct response is to document the headroom, which is what I am doing. The standing risk is real and named: **§11.3's trend gate and the speed-ceiling gate are coupled through one constant, and only 4.5% separates the shipped value from red.** If a future pass tunes `RAMP_TABLE`, this is the check that will catch it, and whoever tunes it should expect to re-justify 0.85 rather than lower the measurement.

## The balance report (`/tmp/balance.log`), recorded and not retuned

The balance simulation (216 rows = 8 seeds × 27 policies) reads, taken whole, as a **13.0% win rate (28 won / 188 lost)** — which looks alarming and is mostly an artifact of the harness's 45 s clock rather than the game's balance:

| Archetype | rows | won | timeouts | mean on-field | max on-field |
|---|---|---|---|---|---|
| `careless-hammer` | 48 | 1 | 44 | 44.7 s | 45.0 s |
| `competent-hammer` | 48 | 1 | 46 | 44.7 s | 45.0 s |
| `careless+hammer` | 48 | 1 | 47 | 44.8 s | 45.0 s |
| `competent+hammer` | 48 | 1 | 42 | 44.4 s | 45.0 s |
| `competent` | 8 | 8 | 0 | 328.1 s | 433.1 s |
| `careless-finale` | 8 | 8 | 0 | 70.1 s | 128.2 s |
| `competent-finale` | 8 | 8 | 0 | 55.4 s | 76.3 s |

- **179 of 216 rows (82.9%) are 45.0 s timeouts, and every one of them is in the four hammer-hunting archetypes** — each wins 1 in 48. A policy that goes looking for the hammer essentially never finishes inside the horizon.
- The three archetypes that go for the exit win **24/24**, with zero timeouts.
- On the **37 rows that do not time out**, the win rate is **75.7%**.

So the headline "13% win rate" is really "the 45 s horizon is shorter than a hammer run takes." That is a **report/observability** issue — the harness should either give the hammer policies a longer horizon, or report "still searching" as its own outcome rather than folding it into "lost" — and it is **not** a call to retune balance. I have recorded the breakdown and changed nothing, per the standing rule that thresholds are not moved to make a report read better.

## NOT DONE — the first-30s pacing, deliberately

**Pacing of the opening is measured but has no gate, and closing it needs a design decision I am not the reviewer of.** I probed it — stand still, and walk forward, logging every fire-and-forget beat:

- **Standing still:** 3 beats in 30 s; the creature appears at 0.02 s and the fade completes at 1.42 s. Longest silent stretch 1.40 s. This is fine and reads as intended.
- **Walking forward (the default first act):** 3 beats in 30 s, but the creature's telegraph goes dormant and it vanishes at **15.93 s** — a **15.93 s silent stretch**, and the only stretch over 5 s.

So the "first act" hands the player a creature in the first second and then goes quiet for sixteen seconds. Whether that is a defect depends entirely on a question I cannot answer from the code: **what is the opening *supposed* to order?** A game that front-loads its apparition and then lets the player walk in silence on purpose is doing something deliberate; a game meant to hand the player a new beat every few seconds is failing. That is a §6/§7 pacing-design call, not a gate.

**Why I did not just add a threshold.** Gating "no silent stretch over N s" needs an N, and N encodes the answer to the design question above. Worse, the thing that is *spaced* is presentation (the telegraph → dormant transition, the prompt, the fade), but `SPAWN.position` and `SPAWN_YAW` — the body pose — feed `_firstSightingPoint`, so presentation timing and simulation state are currently coupled through the spawn. Measuring "beats per 30 s" cleanly would need the presentation timeline decoupled from the body pose, which is the same coupling the reverted spawn move tripped over.

**Concrete proposal for pass 19, in the order I would do it:**

1. **Decide the ordering contract first** and write it into §6 as a sentence a check can quote — e.g. "the first 30 s contain a beat at least every 8 s, or one deliberate silence the design names." Without that sentence, any threshold I pick is me inventing the design.
2. **Decouple the presentation clock** so the opening beats are a function of run time alone rather than of where the body is standing: have them read a `runElapsed` the run already owns, instead of re-deriving "am I still in Act I" from the creature's node, which the body pose feeds.
3. **Then** add one `verify-world.mjs` check: over a scripted 30 s hold-forward, the gap between consecutive fire-and-forget presentation beats must stay under the §6 number. It is a property of the world, so it belongs in `verify-world.mjs` and not the pure suite — and it will be a real check rather than a `probeLog`-gated one, because the current pacing probe is diagnostic infrastructure, not a gate.

I am not closing this in this review because step 1 is a design decision, and steps 2–3 are implementation that should not land without it.

## What I did not touch

`src/game/neighborhood.js`, `streetView.js`, `hud.js`, `styles.css` and `Hud.jsx` are all **byte-identical to `bd4573f`** — this review changed `verify.mjs` only. I did not re-shoot the gallery, re-run the balance simulation to change a number, retune the 0.85 pursuit floor, or move the spawn.

## Files changed by this review

- `verify.mjs` — the hardened source-contract gate and its CSS reader (Finding 2); the pavement/carriageway docblock and failure message (Finding 3); the framing-numbers docblock (Finding 4). Pure count unchanged at 306.
- `REVIEW-pass-18.md` — this file.

## Gate at verdict

`npm run check` → lint 0 errors, **306/306 pure**, **112/112 world**, `vite build` clean. Verified on a clean worktree after every mutation sweep; the sweep restores `src/`, and I hash-check the restore.

CHECK: PASS (lint, 306/306, 112/112, build)
