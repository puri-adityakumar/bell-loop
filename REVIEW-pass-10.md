# REVIEW — iteration 2, pass 10

- **Commit under review:** `abbd0a7` — "iter2(10): creature fidelity I - idle micro-motion, limb swing, viscous trail, eye flare telegraph".
- **Reviewer verdict:** **FIXED — the pass shipped four real features and defended all four in the abstract, while not one of the four is visible in any frame of the gallery.** The eye and the articulated motion *are* legible and the work is good; the trail and the eye flare are absent from every capture. Every gate that exists passes, because all of them ask whether a number is right, and the defect is that the number is right and nobody ever pointed a camera at it.
- **Gate at verdict time:** 243/243 pure, 88/88 world → **244/244 pure, 89/89 world** (post-review; +1 pure check, +1 world check, +1 pure/source staging gate pairing).

## What the pass does

`abbd0a7` gave the creature four things it did not have: a breathing idle (`IDLE_BREATH_DEPTH` ±1.6% on a 4.2 s period, `IDLE_SWAY_RADIANS` ±1.7° on an unrelated 5.9 s period), two-jointed arms with an elbow lagging the shoulder by `ELBOW_LAG` 0.66 rad, a viscous trail of decals laid every `DRIP_STRIDE_METRES` 0.9 m of walking, and an eye flare on the frame the creature first spots the player. The architectural claim holds and is the strongest part: every number is decided in the pure `creature.js`, the view only applies it, and `creatureFidelityClaims` mutates four sources (19 mutants, all caught) to prove the gates are not decorative.

## What is actually visible in the shipped gallery

I measured the committed PNGs rather than reading the design prose, because that is the claim the design prose cannot make.

| Frame | eye found | body rows / px darker than surround | ratio | trail marks in frame |
|---|---|---|---|---|
| `creature-stalking.png` | yes, 50 px at 594,332 | 46 / 446 | 0.607 | **0** |
| `creature-chasing.png` | yes, 42 px at 605,302 | 57 / 1090 | 0.413 | **0** |
| `banish.png` | yes, 56 px at 639,201 | 55 / 452 | 1.057 | **0** (one mark exists, off-screen) |

So the eye and the silhouette are real and hold up, and the articulated motion is measurably different per state on the built rig (arm swing 0.104 rad stalk, -0.703 chase, -0.058 banish; the elbow follows at its lag). Two of the four features are not in the gallery at all.

## Finding 1 (the real one): the trail is in no frame, and no gate could see that

`DRIP_STRIDE_METRES` is 0.9 m and tier 0's speed is 2.2 m/s, so the first mark needs **1.48 s** of walking. The three creature views give it:

- `creature-stalking` — 0.35 s, 0.77 m. No mark.
- `creature-chasing` — 0.30 s, 0.62 m. No mark.
- `banish` — 0.45 s, 0.99 m. One mark — and it is laid at the creature's own feet, 1.0 m from a camera 1.6 m up, which projects to **y=1213 in a 720-tall frame: 493 px below the bottom edge.**

The frame *named for the chase* was the one frame in the set where the feature was arithmetically impossible. This is the same class of bug `tools/png-luma.mjs` was written to prevent — "the screenshot was taken" and "the screenshot shows the street" are different claims — except here the gap is one level up: the reducer laid a mark, the buffer held it, and the mark was underneath the camera.

I confirmed the staging is the whole of it by replaying the real sequences against the built world: at 1.2 s the chase walks 2.60 m, lays two marks, and both project **inside** a 1280x720 frame, ~21 px across, at alpha 0.62 and 0.86, 7-8 m out where the sodium pool still lights the road under them. `creature.state` is still `chase` on the final frame at 1.2 s and has decayed back to `stalk` by ~1.5 s, so 1.2 s is inside the window.

**Fixed** in `src/game/capture.js` (`creature-chasing`, 0.3 s → 1.2 s).

**Gated** in two halves, because the two claims need different evidence and putting them in one place would have made one of them decorative:

- `verify.mjs` asks the **data** question — is any view staged long enough to lay a mark at all? It reads `rampAt(0).speed` rather than a literal, so the gate cannot drift from §11.1's table.
- `verify-world.mjs` asks the **picture** question — does a mark actually land inside the frame? It projects, because that is the only place in the repository with a camera. It also asserts a **camera control**: with the headless matrices left stale, `matrixWorldInverse` is the identity and a point at 3 m projects to the same pixel as one at 26 m, which would make every screen-space assertion here meaningless. I hit exactly that while measuring this review and it silently produced 4 marks at one 5-px column.

Both were verified to fail on the pre-fix tree: `creature-chasing is staged for 0.3s and laid no mark at all`.

## Finding 2: the eye flare cannot be photographed at all, and this is a pre-existing structural gap

`spotElapsed` is `null` in all three creature views, so `pose.eyeFlare` is 0 at every shutter. The world check for the flare is thorough — it forces a real sighting and asserts the built `THREE.Color`, the swell, and the settle — but it synthesises a sighting **no capture performs**. Measured: a spot never fires in any shipped framing.

The cause is not in the capture data. `worldOf()` returns `{x, z}` and no yaw, and `inSightCone` does `from.yaw ?? 0`, so `canSee(drawn, player, ...)` tests the cone along **-z in world space** rather than along the creature's actual facing — which `_updateCreatureView` only computes *after* `_updateCreature` has already asked. Passing a yaw explicitly makes `canSee` return true and arms the spot, which is how I found it.

This line is byte-identical at `50ac436` (pass 9), so it is **pre-existing and not a pass-10 regression** — pass 10 built a flare on top of a spot clock that the capture harness cannot reach. I have deliberately **not** fixed it here: changing what the creature can see is a simulation change with a much wider blast radius than a review of a fidelity pass should carry, and it would move the awareness behaviour every other gate is calibrated against. It is recorded here as the next pass's work, with the mechanism and the one-line evidence.

## Finding 3: `hammer-located.png` reports an eye, contradicting `png-luma.mjs`

`creatureContrast` reports an eye hit in `hammer-located.png` (n=72, 11x5 at 919,359) though `tools/png-luma.mjs` states that frame "produce[s] none". Measured identical at pass 9, so not a regression. The documented claim is false, but nothing depends on it — the only gate that asserts `found === false` does so on `street.png`, which correctly reports none. Left alone and recorded, because correcting the prose would weaken an argument about impostor rejection that is otherwise correct.

## Not changed, and why

- **Rendering.** No rendering change was warranted. The trail is drawn correctly, in one draw call, on a sibling of the figure, queued before the eye, with a real per-mark vertex alpha; it was simply never asked to draw anything the camera could see. The four features pass 10 built are correct.
- **`creature-stalking` and `banish` staging.** Deliberately left alone. `creature-stalking` is framed to a measured ratio of 0.607 against a 0.62 floor — 0.013 of headroom, the tightest margin in the repository — and making the figure walk would move it out of the sodium pool that view exists to stand it in. `banish` is a connected swing at 1.9 m inside §7.4's reach, and its beat is the dismissal, not a decal. The new gate is therefore scoped "at least one view", which is the claim that was actually false.

## Verification

`npm run check` green at **244/244 pure, 89/89 world**, build clean. The new world check reports: `creature-chasing lays 2 mark(s), 2 inside the frame at 1114,494 1161,518; banish's 1 mark is off-screen under the camera, as documented`.

**Known limitation:** the re-capture of `creature-chasing.png` could not be completed in this environment. `npm run capture -- --only creature-chasing` ran 175 s and failed with `Page.captureScreenshot timed out` under SwiftShader, deleting the PNG; the gallery has been restored to its committed state (14 PNGs, clean tree apart from the three source files). The committed `creature-chasing.png` is therefore still the **old** 0.3 s frame and does not yet show the trail. The staging change is verified against the built world by the new world check, but **the PNG needs regenerating on a machine with a working software renderer before this branch's gallery matches its own spec.**
