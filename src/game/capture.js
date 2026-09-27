/**
 * capture.js — the §16.5 capture set, as data (v2 slice 16).
 *
 * WHY THIS IS A MODULE AND NOT A SCRIPT
 * ------------------------------------
 * The fourteen PNGs in `benchmark/screenshots/` are the benchmark's evidence
 * that the game looks like the design says, and until slice 16 they were taken
 * by hand. Hand-taken galleries rot in a specific and expensive way: the twelfth
 * screenshot is the one nobody re-takes, so the set slowly stops describing the
 * build and starts describing the day. Fourteen views of a two-act game with a
 * chase, a finale and a pause is exactly the size of set where that happens.
 *
 * So the set lives here, as data, and `verify.mjs` asserts it against §16.5
 * *before* anything is rendered: the twelve names in the design's order, plus the
 * responsive and pause views §16.5 says are captured in addition rather than
 * instead. A capture that silently stops being taken, or is renamed, or is
 * reordered, fails the gate instead of quietly ageing.
 *
 * WHY IT IS PURE, AND WHY THAT IS THE POINT
 * ------------------------------------------
 * This file imports nothing. It has no DOM, no Three.js, no clock and no globals,
 * for the same reason `creature.js` does: the thing that decides *what a
 * screenshot is supposed to show* has to be readable in node, by the gate, on a
 * machine with no browser. The steps below are a small vocabulary of verbs rather
 * than a list of field assignments — see `CAPTURE_OPS` — so what a view *does* is
 * reviewable here even though what it *looks like* is only reviewable in the PNG.
 *
 * The interpreter is `capture/main.jsx` (browser-only, and deliberately not part
 * of the production bundle: `vite build` takes `index.html` as its only entry) and
 * the photographer is `tools/capture.mjs`. Between them they hold every way of
 * reaching a state that is not a walk from the title screen; this file holds only
 * the order those ways are taken in.
 *
 * THE HONESTY RULE
 * ----------------
 * A view that cannot be reached must FAIL, not fall back to something else. The
 * interpreter throws on a step it cannot take, `tools/capture.mjs` writes the
 * failure into `benchmark/captures.json` and exits non-zero, and no file is
 * written for that id. A gallery with a hole in it is a fact a reviewer can see;
 * a gallery with a plausible wrong picture in it is not.
 */

/**
 * The vocabulary. A step is `{op, ...}` and `op` is one of these; anything else is
 * a typo, and the gate fails on it rather than the interpreter ignoring it.
 *
 * What each verb is allowed to be is the interesting part, so it is written down:
 *
 *   begin       `game.start()` — the same call the START button makes.
 *   goto        put the player `back` metres from a named anchor, facing it, on a
 *               standable tile with a clear line to it. A camera move and nothing
 *               else: no simulation state is written. An optional `bearing`, in
 *               degrees, pins the stand-off to one side instead of letting the
 *               interpreter take the first of sixteen that works — which is what
 *               photographing a *street* needs, because the streetlights are a
 *               bearing and a distance rather than a subject. `target: 'avenue'`
 *               is the street node with that intent spelled out, and
 *               `target: 'lamp'` is the sodium lamp standing on it: §12.1's pool
 *               is twelve metres across, and a view that has to clear the
 *               lighting gate wants that pool filling the bottom of the frame
 *               rather than a lamp head somewhere off at the edge of it.
 *   takeHammer  goto the hammer and hold `E` long enough for §7.1's pickup. The
 *               awakening toll is the world's, not ours.
 *   shut        goto each open portal in turn and hold `E` long enough for §5.2.
 *               Three real 1.2 s commits, not three flags.
 *   hold        `player.pressKey(code)`, wait, release. §5.2 is a hold, so the
 *               only way to photograph one is to hold it.
 *   swing       `player.pressKey('Mouse0')` for one frame: §7.4 is a press.
 *   creature    set the creature's §6.1 state and stand it `metres` in front of the
 *               player at `bearing` degrees off the view axis. This is the one verb
 *               that writes simulation state, and it exists because a stalker
 *               cannot be walked into a screenshot on demand.
 *   caught      stand the creature on the player in a chase and let the world run
 *               its own capture test. §9.3's beat is the world's to produce.
 *   win         stand the player inside §10.4's win trigger with the finale
 *               running. Again the world's: `_win()` fires or it does not.
 *   pause       `game.setPaused(true)` — §14.3's Esc.
 *   motion      `game.setReducedMotion(on)` — §14.3's toggle.
 *   wait        let the world's own clock advance by N seconds, measured on
 *               `animTime` rather than on frames, so a slow software renderer gets
 *               the same beat a fast GPU does.
 *   frames      let N frames render, for "and let it settle".
 */
export const CAPTURE_OPS = Object.freeze([
  'begin',
  'caught',
  'creature',
  'frames',
  'goto',
  'hold',
  'motion',
  'pause',
  'shut',
  'swing',
  'takeHammer',
  'wait',
  'win',
])

/** §16.5's twelve, in the design's order. The gate compares this list verbatim. */
export const TWELVE_CAPTURE_IDS = Object.freeze([
  'title',
  'street',
  'hammer-located',
  'hammer-awakening',
  'portal-located',
  'portal-shutdown',
  'creature-stalking',
  'creature-chasing',
  'banish',
  'capture-reset',
  'finale-headlights',
  'win',
])

/** §16.5: "Responsive and pause states are captured in addition to these twelve". */
export const EXTRA_CAPTURE_IDS = Object.freeze(['responsive', 'pause'])

/** Where the gallery goes. Relative to the repo root; the harness resolves it. */
export const CAPTURE_DIR = 'benchmark/screenshots'

/**
 * The lit floor: a captured frame whose lower scene is less than this fraction
 * lit is not kept, and the run exits non-zero.
 *
 * WHY A FLOOR AT ALL, GIVEN THE HARNESS ALREADY FAILS LOUDLY
 * ---------------------------------------------------------
 * Because "failed loudly" and "showed something" are different claims. Every one
 * of slice 16's fourteen views reported `captured`, wrote a 1280x720 PNG, and was
 * a black rectangle with the HUD on top — the harness was telling the truth the
 * whole time, because the screenshot *had* been taken. The only claim it was
 * making that was false was the one only a human was making by opening the file.
 *
 * WHY THE FLOOR IS A FRACTION AND NOT A LUMA
 * -------------------------------------------
 * The obvious gate is "mean luma of the whole frame must be at least N", and
 * measuring it is how that idea died. Those same fourteen broken frames score a
 * whole-frame mean between 5.7 and 24.1, so there is no N: a floor under 24.1
 * passes frames that are black rectangles, and a floor over 24.1 fails the
 * gallery the moment it is fixed. The spread is not noise — §14.3's grain,
 * vignette and HUD put about 7.6 under every frame whatever the world is doing,
 * and `creature-chasing` and `finale-headlights` are lifted further by chase
 * vignette and headlight bloom. The mean measures the post-processing, not the
 * street.
 *
 * So the gate asks the question the gallery actually exists to answer: over what
 * fraction of the lit *scene* — the lower half of the frame, per `LIT_LUMA` in
 * `tools/png-luma.mjs` — is there light at all? That is a coverage question
 * rather than a brightness one, and coverage is what the black frames fail at
 * regardless of how much glow is bleeding into their corners.
 *
 * WHY 6 PERCENT, SPECIFICALLY
 * ---------------------------
 * Calibrated against the two measured populations, which are both in
 * `benchmark/captures.json` next to it — every entry carries its own `luma`:
 *
 *   the bug's frames, lower-scene lit   0.80% - 3.09%
 *   the fixed world, same measurement   13.96% and up
 *
 * Six sits in the empty middle of that gap rather than just above the broken
 * maximum, on purpose. A floor pinned to 3.1 + epsilon would reject precisely
 * the frames it was calibrated from and nothing else; 6 is far enough above the
 * whole broken population that a partial regression fails, and less than half of
 * what a good frame measures, so ordinary variation between views — `title` is a
 * UI card over a dark street, `win` is a full-screen card — does not trip it.
 * Every one of the fourteen has to clear it, and the darkest of them is printed
 * in the run log so the margin is visible rather than assumed.
 */
export const CAPTURE_MIN_LIT = 0.06

/**
 * The one view that is allowed a lower floor, and why it is not a hole.
 *
 * §16.5.1's title is "the start overlay over the live street": a full-bleed
 * `.title-veil` radial gradient that has to be opaque enough for a nine-letter
 * title to read over drifting fog. A UI card is a different claim from "is the
 * street lit", and holding it to the street's floor measures the card's
 * typography rather than the world behind it.
 *
 * The floor is still a floor. It sits at 3.5%, which is *above* the 3.09% the
 * fourteen broken frames measured and barely above the 0.80% they bottomed at,
 * so it rejects every frame the original bug ever produced — a black rectangle
 * with a HUD on it still fails here. What it stops doing is requiring a title
 * card to be as bright as a photograph of a lamp. `verify.mjs` asserts the
 * number sits in that gap, and asserts that no other view may ask for it.
 */
export const TITLE_MIN_LIT = 0.035

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 7 — the furniture floor
// ---------------------------------------------------------------------------

/**
 * The seven kinds of thing pass 7 added to the kerb, and the POOLS that carry
 * them.
 *
 * WHY A LIST OF POOLS AND NOT A LIST OF INSTANCES
 * -----------------------------------------------
 * Pass 7 was gated on *arithmetics*: a machine has one liner and two rails, a
 * shelter is four steel pieces, a bike is five bars and two wheels. All of that
 * is true of a machine standing in the next district with its back to the
 * camera, and every one of those checks reads `pool.used` — a COUNT, which is
 * blind to where the thing is. So the pass could have placed all fifteen pools
 * on the far side of a 448 m wrapped world, every count would hold, and the
 * fourteen PNGs in `benchmark/screenshots/` would be a street with no dumpster,
 * no bike, no machine, no shelter and no poster on it. That is not a
 * hypothetical: it is what the first fourteen frames of this pass look like.
 *
 * So the second gate is not another count. It is a *sightline*, measured
 * through the camera the photographer is holding (see `capture/main.jsx`), and
 * the list below is what a sightline is measured over. One representative pool
 * per kind, deliberately: `vendingFaces`/`vendingLitFaces`/`vendingFlickerFaces`
 * are three liners of the same cabinet, and counting all three would let a
 * single machine inflate the vending count to three.
 *
 * The poster is the one kind listed twice, and it is a real distinction rather
 * than a fudge: a torn sheet is a separate alpha-tested pool with its own
 * texture (`verify-world.mjs` gates that the two are different maps), and "a
 * poster is visible" is a weaker claim than "a whole sheet and a torn one are".
 */
export const FURNITURE_FAMILIES = Object.freeze([
  Object.freeze({ kind: 'dumpster', pools: Object.freeze(['dumpsters']) }),
  Object.freeze({ kind: 'trashBag', pools: Object.freeze(['trashBags']) }),
  Object.freeze({ kind: 'vending', pools: Object.freeze(['vendingBodies']) }),
  Object.freeze({ kind: 'shelter', pools: Object.freeze(['shelterSteel']) }),
  Object.freeze({ kind: 'bike', pools: Object.freeze(['bikeFrames']) }),
  Object.freeze({ kind: 'bollard', pools: Object.freeze(['bollards']) }),
  Object.freeze({ kind: 'poster', pools: Object.freeze(['posters', 'postersTorn']) }),
])

/**
 * Every pool a sightline is measured over, as one flat list.
 *
 * `FURNITURE_FAMILIES` flattened, so the probe and the gate cannot disagree about
 * which pools count: there is one list, and one of them derives from the other.
 */
export const FURNITURE_POOLS = Object.freeze(FURNITURE_FAMILIES.flatMap((family) => [...family.pools]))

/**
 * How many pieces of pass-7 furniture must be inside the frame.
 *
 * Two, and not one, because the honest reading of "a dumpster is in this
 * photograph" is a dumpster *and something else*: a single lit machine on a
 * dark kerb is one bright rectangle in a black frame, which is a picture with an
 * object in it, not a street with furniture on it. Two also gives the gate a
 * little room: a piece that clips the very edge of the frustum on one view and
 * falls out on another should not be the difference between green and red.
 *
 * Calibrated against the run, not guessed — the measured per-view counts are in
 * `benchmark/captures.json` under `furniture`, and the floor sits far under the
 * tightest of them.
 */
export const FURNITURE_MIN_ON_SCREEN = 2

/**
 * How many DISTINCT kinds must be in frame.
 *
 * The count above can be satisfied twice over by one shelter, because a shelter
 * is four instances in one pool and the probe reports pieces. This is the
 * counterweight: two pieces of two DIFFERENT kinds, so a view cannot pass by
 * pointing at a single object. One, not two, because a phone-in-portrait frame
 * at 480x854 has a narrow horizontal field and a genuinely close subject.
 */
export const FURNITURE_MIN_FAMILIES = 1

/**
 * The smallest on-screen RADIUS, in pixels, that counts as legible.
 *
 * Below this a piece is a smudge: at 1 px it is a rounding artefact of a
 * silhouette and at 2 px it is a single lit texel that no reader of the gallery
 * could identify as a *kind* of thing. The unit is a radius rather than a
 * diameter because the probe measures a bounding sphere, and a sphere of radius
 * r is r pixels across in every direction — so a radius floor IS a "smaller than
 * a circle this wide" floor, with no factor of two to get wrong.
 *
 * Three pixels of radius is six pixels across. That is small, and deliberately:
 * the floor's job is to exclude furniture that is in the frustum but sub-pixel
 * (`frustumCulled = false` on every pool means an instance behind the camera is
 * still "in the world" and would otherwise satisfy a naive on-screen count), not
 * to demand a hero shot. A gate that required 40 px would fail a correctly framed
 * view of a poster 30 m down an avenue.
 */
export const FURNITURE_MIN_LEGIBLE_PX = 3

/**
 * describeSightline — one frame's furniture, as a sentence.
 *
 * HERE rather than in `capture/main.jsx` or `tools/capture.mjs`, because there are
 * two callers with a stake in the phrasing agreeing: the page prints it when a
 * view fails, and the harness prints it when a view passes. `describeLuma` is in
 * `png-luma.mjs` for the same reason, and a harness that assembles its own
 * phrasing is a harness whose log lines drift apart from each other over a pass
 * or two.
 */
export function describeSightline(measured) {
  const kinds = Object.entries(measured.byKind)
    .filter(([, entry]) => entry.legible > 0)
    .map(([kind, entry]) => `${kind} ${entry.legible}@${entry.maxPx}px`)
  return (
    `${measured.legible} legible piece(s) of ${measured.onScreen} in frame across ` +
    `${measured.kinds} kind(s) [${kinds.join(', ') || 'none'}]` +
    (measured.nearest === null ? ', nothing in the frustum at all' : `, nearest ${measured.nearest} m`)
  )
}

/** 16:9 at the size the comparison rows are rendered at, so nothing is rescaled. */
export const CAPTURE_VIEWPORT = Object.freeze({ width: 1280, height: 720 })

/**
 * The responsive view is a phone in portrait, not a smaller desktop.
 *
 * §14's whole surface is absolutely positioned inside a full-bleed canvas, and a
 * portrait viewport is the one shape that can actually break it — so that is the
 * shape worth photographing. A short landscape window only proves the desktop
 * layout survives being squashed, which it does by construction.
 */
export const RESPONSIVE_VIEWPORT = Object.freeze({ width: 480, height: 854 })

/**
 * The intersection the `street`, `responsive` and `pause` views stand at, and the
 * ground the creature views are staged on.
 *
 * A node in `neighborhood.js`'s own `(ax, az)` numbering, so the composition is a
 * fact about the map rather than a magic pair of coordinates: one block
 * north-east of spawn, which is a long avenue with lamps on both kerbs and house
 * frontage to recede into — the shot that shows §3.1's repeat rather than a
 * single wall. The creature views stand ON the intersection rather than near it,
 * because a figure 17 m down a road is the shot §6.1 describes and a figure
 * round a corner is not.
 */
export const STREET_NODE = Object.freeze({ ax: 1, az: 1 })

const VIEWS = [
  {
    id: 'title',
    label: 'Title — the start overlay over the live street (§16.5.1)',
    viewport: CAPTURE_VIEWPORT,
    // the one view measured against TITLE_MIN_LIT rather than the street's floor
    minLit: TITLE_MIN_LIT,
    steps: [
      // the veil is a card, not a lid: long enough for `.title-veil`'s own
      // 1.6 s fade-in to have landed, so the frame is the finished composition
      { op: 'wait', seconds: 1.9 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'street',
    label: 'Street — first person, dusk, repeating blocks (§16.5.2)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      // 11 m off the lamp rather than 26 m off the node. The pool is twelve
      // metres across, so at 11 m it runs from under the camera to the kerb
      // opposite and fills the bottom of the frame; at 26 m the same lamp is a
      // bright dot two thirds of the way up it. The avenue is still the subject
      // — the camera looks down the road with the lamp line receding past it.
      { op: 'goto', target: 'lamp', back: 11 },
      { op: 'wait', seconds: 0.6 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'hammer-located',
    label: 'Hammer located — the one warm light on a dark lot (§16.5.3)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'goto', target: 'hammer', back: 5.5 },
      { op: 'wait', seconds: 0.8 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'hammer-awakening',
    label: 'Hammer awakening — §7.2 pickup toll, sigil flash, telegraph to stalk',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'takeHammer' },
      // long enough for the toll to have rung and the flash to be at its peak,
      // short enough that the creature is still arriving rather than walking
      { op: 'wait', seconds: 0.25 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'portal-located',
    label: 'Portal located — cyan through a gap between houses (§16.5.5)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      // 4.5 m, not 6.5. §12.2's ring is the only cold light in the game and it
      // is a 26 m point light, so the lit ground is a tight apron around the
      // doorway; standing further back put the apron in the middle distance and
      // filled the bottom of the frame with unlit lot.
      { op: 'goto', target: 'portal', id: 'A', back: 4.5 },
      { op: 'wait', seconds: 0.8 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'portal-shutdown',
    label: "Portal shutdown — the hold, past §5.2's midpoint tick (§16.5.6)",
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      // 0.8 s of a 1.2 s commit. The ring in the PNG reads 0.556, not the 0.667
      // the clock alone predicts, and the gap is worth writing down rather than
      // rounding away: `hold` samples the fraction with the key still down, then
      // lets go, `PORTAL_RELEASE_DECAY` is 2, and the two rendered frames between
      // that release and `page.screenshot()` bleed 0.111 off before the shutter.
      // So what is photographed is a hold *letting go*, just past §5.2's 0.5 tick
      // at 0.6 s — the §14.2 ring in its loud half, and not yet latched at 1.0.
      // Measured off the PNG itself: 13.3 of `STEPS.hold`'s 24, from 12 o'clock.
      //
      // The 0.056 of headroom above the tick is a margin, not a guarantee — a
      // faster machine renders those two frames in less time and bleeds less. The
      // number to actually read is `hold` in `benchmark/captures.json`, which is
      // sampled from the live world at the end of the view rather than asserted
      // here, so a reviewer can check the claim instead of trusting this comment.
      //
      // 2.2 m, and that number is load-bearing in a way the last one was not.
      // `streetView.portalRange` is 2.6 m and `_updateVerbs` reads the hold
      // target through `nearestPortal`, so anything past 2.6 m has no target at
      // all: `applyPortalHold` is handed `active: false` for all three portals and
      // bleeds the progress back to zero. This view used to stand at 3.4 m "so
      // the apron would be under the camera", photographed a perfectly lit live
      // ring, measured 35.42% lit, and passed — as a second copy of
      // `portal-located`, under a filename claiming a shutdown. The apron is 7 m
      // across, so 2.2 m is still comfortably inside it and the framing is
      // unchanged; `main.jsx`'s `hold` now asserts the hold actually engaged.
      { op: 'hold', key: 'KeyE', seconds: 0.8, at: { target: 'portal', id: 'A', back: 2.2 } },
      { op: 'frames', count: 1 },
    ],
  },
  {
    id: 'creature-stalking',
    label: 'Creature stalking — a silhouette at the edge of vision (§16.5.7)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'takeHammer' },
      // The lamp, not the bare node: §6.1's figure is a silhouette because it is
      // standing in a lit street, and a figure 17 m out against unlit asphalt has
      // nothing to be a silhouette *against*. The pool lights the road the
      // creature is walking down.
      //
      // 25 m, not 11, and 6 degrees, not 34 — and the second number was the bug.
      //
      // The comment above has been true of the INTENT since this view was
      // written and false of the FRAME the whole time. At `back: 11` the camera
      // stood 11 m short of the lamp and the creature was then placed 17 m from
      // the *camera*, which put it 6 m BEYOND the lamp and 34 degrees off the
      // road axis — out of the pool entirely, in front of an unlit house front.
      // Measured on the committed PNG before this was fixed: the creature's body
      // sat at luma 18.8 against a local background of 15.4, a ratio of 1.22 —
      // BRIGHTER than the wall behind it. The figure was a slightly-lighter
      // smudge on a dark house, and the gate pass 2 shipped to prevent called it
      // 0.18. Both numbers were true measurements of two different things, which
      // is the whole failure this entry is worth reading for.
      //
      // Standing 25 m back puts the lamp 25 m ahead and the creature 17 m out, so
      // the pool now lies BETWEEN the camera and the figure and fills the ground
      // the figure is standing on. The measured ratio is 0.57, and 6 degrees is
      // enough to keep it off the exact road axis without pushing it into the
      // kerb. Two nearby framings were measured and rejected for the record:
      // `back: 30` (0.56, a slightly smaller figure for no gain) and
      // `back: 20` (0.62, which is the gate's own limit and has no margin).
      { op: 'goto', target: 'lamp', back: 25 },
      { op: 'creature', state: 'stalk', metres: 17, bearing: 6 },
      { op: 'wait', seconds: 0.35 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'creature-chasing',
    label: 'Creature chasing — full chase, §14.3 vignette tightened (§16.5.8)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'takeHammer' },
      { op: 'goto', target: 'node', back: 0 },
      { op: 'creature', state: 'chase', metres: 9, bearing: 4 },
      // 1.2 s, not 0.3 s, and the number is load-bearing in a way the old one was
      // not. Pass 10 gave the creature a viscous trail, and §16.5.8 photographs a
      // full chase — but at 0.3 s this view laid NOTHING: `DRIP_STRIDE_METRES` is
      // 0.9 m, the figure covers 0.62 m in 0.3 s, and the reducer's first mark
      // needs 1.48 s of walking. So the frame named for the chase was the one
      // frame in the set where the trail could not possibly appear, and the
      // feature shipped with no picture of it anywhere in the gallery.
      //
      // At 1.2 s it walks 2.60 m and lays two marks, and the world check at the
      // bottom of `verify-world.mjs` projects both of them INSIDE a 1280x720
      // frame — about 21 px across, at alpha 0.62 and 0.86, 7-8 m out where the
      // sodium pool is still lighting the road under them. That is the difference
      // between a feature that is measured by a gate and a feature a reviewer can
      // see. The exact pixel coordinates are deliberately not written down here:
      // they move with the frame, and a comment that goes stale is worse than
      // one that points at the check that measures it.
      //
      // It also stops short of §9.3 and of the state machine's own give-up: the
      // meter decays once nothing is in the cone, and past ~1.5 s the creature
      // drops back to stalk, at which point the capture is filing a stalk under a
      // filename claiming a chase. Measured on the built world, 1.2 s is inside
      // the window where `creature.state` is still `chase` on the final frame, and
      // it is the point where BOTH marks are at their most legible together
      // (alpha 0.62 and 0.86) rather than one strong and one barely there.
      { op: 'wait', seconds: 1.2 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'banish',
    label: "Banish — §7.4's connected swing, the creature leaving (§16.5.9)",
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'takeHammer' },
      // the same lamp as `creature-stalking`, because §7.4's swing is the same
      // moment as §6.1's stalk seen from the other end: the figure is close
      // enough to touch, and the pool it is standing in is what makes the shape
      // legible as a shape rather than a hole in the frame
      { op: 'goto', target: 'lamp', back: 11 },
      // inside §7.4's BANISH_RANGE of 2.6 m, and the one place the answer is not
      // ambiguous: `resolveSwing` on a connected target is a banish, every time
      { op: 'creature', state: 'stalk', metres: 1.9, bearing: 8 },
      { op: 'swing' },
      // the dismissal fade is 1.1 s, so this is the figure still on its way out
      { op: 'wait', seconds: 0.45 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'capture-reset',
    label: "Capture reset — §9.3's sting and cross-fade, the street behind it",
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'takeHammer' },
      // the lamp before the capture, not after: §9.3 puts the player back at the
      // spawn, so a stand-off taken afterwards would be photographing a corner
      // the reset chose rather than the street the view is about
      { op: 'goto', target: 'lamp', back: 11 },
      { op: 'caught' },
      // §9.3's window is 1.1 s and its midpoint is full black, so a screenshot
      // taken "at the reset" photographs nothing at all — which is what the first
      // run of this view did, at a measured 0.00% lit. The beat is the sting, not
      // the black: wait the window out and the HUD carries its loop-2 state.
      { op: 'wait', seconds: 1.4 },
      // and stand on the lamp *again* afterwards, because §9.3 put the player back
      // at the spawn and a stand-off taken before the capture is a stand-off at a
      // corner the reset chose. This is the street the view is about.
      { op: 'goto', target: 'lamp', back: 11 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'finale-headlights',
    label: "Finale headlights — §10.3's car, lit, beacon through the fog",
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'shut' },
      { op: 'goto', target: 'exit', back: 11 },
      { op: 'wait', seconds: 0.8 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'win',
    label: 'Win — §10.4: "THE NEIGHBORHOOD WENT QUIET." (§16.5.12)',
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      { op: 'shut' },
      // the exit, not the lamp: §10.4's sentence lands over the car the whole run
      // was walking to, and `shut` has just latched the finale, so the headlights
      // this stands in are §10.3's beacon at full brightness
      { op: 'win' },
      { op: 'wait', seconds: 0.5 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'responsive',
    label: 'Responsive — the same street at 480x854, a phone in portrait',
    viewport: RESPONSIVE_VIEWPORT,
    steps: [
      { op: 'begin' },
      // the same shot as `street`, because the thing being checked is that the
      // layout survives a portrait frame — a different composition would be
      // testing a different thing
      { op: 'goto', target: 'lamp', back: 11 },
      { op: 'wait', seconds: 0.6 },
      { op: 'frames', count: 2 },
    ],
  },
  {
    id: 'pause',
    label: "Pause — §14.3's card over a completely frozen simulation",
    viewport: CAPTURE_VIEWPORT,
    steps: [
      { op: 'begin' },
      // the same shot as `street`, and the same 0.6 s wait, which is load-bearing
      // here for a reason `street` does not have: `update()` returns above
      // `_updateLampPool()` while paused, so the four point lights are still
      // snapped to wherever the player was *before* this stand-off. A wait
      // before `pause` is the only thing that lets them re-aim onto the lamp this
      // view is standing at, and without it the card is over a dark street
      // however well composed the street is.
      { op: 'goto', target: 'lamp', back: 11 },
      { op: 'wait', seconds: 0.6 },
      { op: 'pause' },
      { op: 'frames', count: 2 },
    ],
  },
]

/** The twelve, plus the two, frozen: `{id, label, viewport, steps}` each. */
export const CAPTURE_VIEWS = Object.freeze(VIEWS)

/** Every id, §16.5's twelve first. What `tools/capture.mjs` iterates. */
export const CAPTURE_IDS = Object.freeze([...TWELVE_CAPTURE_IDS, ...EXTRA_CAPTURE_IDS])

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 15 — THE PER-STATE LIGHT PROBE
//
// WHAT THIS IS
// ------------
// Passes 1, 9 and 11 made the world warmer and brighter: the sky and fog stops
// went sodium-amber, the hemisphere rose, the haze bands and the pale moon went
// in. §12.1's promise that the creature "should read as a hole in the fog" is a
// claim about a RELATIONSHIP between a subject and the air in front of it, and a
// relationship is exactly what a change of air quietly invalidates.
//
// The gallery can answer that for the three frames that happen to hold a
// creature (`creature-stalking`, `creature-chasing`, `banish` — which is a
// `stagger`), and it cannot answer it for the other two rows in
// `CREATURE_PRESENTATION`. So the probe is a second, smaller set: the SAME
// camera, the SAME light, the SAME distance, one view per presentation row.
//
// WHY IT IS NOT PART OF THE GALLERY
// ---------------------------------
// `CAPTURE_VIEWS` is §16.5's fourteen and `verify.mjs` holds that number, the
// order and the ids. Fourteen photographs of a game is the deliverable; a
// thirteen-frame lighting rig is instrumentation, it belongs with the commit
// that reads it, and it must never be able to pad the gallery count. The probe
// therefore has its own list, its own ids, its own output directory and its own
// report, and the gallery does not know it exists.
//
// ONE STAND-OFF, FIVE ROWS, AND WHY THAT IS THE MEASUREMENT
// -----------------------------------------------------------
// Every view here stands at `CREATURE_PROBE_STANDOFF`: the camera 25 m back
// from the same sodium lamp `creature-stalking` uses, the figure 17 m from the
// camera at 6 degrees off the road axis, so the pool lights the road the figure
// is standing on and the pool lies BETWEEN the lens and the subject. That is
// `creature-stalking`'s staging, chosen once and reused, and the reuse is
// structural — every view is built from the one table below, so "the five rows
// were photographed in the same light" cannot rot the way a hand-copied stand-off
// in five separate view blocks would.
//
// 17 m is also where the measurement works. `creatureContrast` compares the
// trunk against the pixels 10-30 px either side of the eye, so the figure has to
// be NARROWER than that window for the sides to be anything but more creature:
// at 17 m the shoulder is ~17 px across and the window is clear of it, and at the
// 1.9 m of `banish` the window is entirely inside the figure and the ratio is a
// measurement of the body against itself. One stand-off for all five rows also
// means the frames are comparable to each other, which is the claim: not "the
// creature reads somewhere" but "of the five ways it can be presented, these are
// the ones the new fog washes out".
//
// DUSK 0 FOR ALL FIVE, AND WHY
// ---------------------------
// The finale (§10.2) is where `enraged` is actually reached, and it runs at dusk
// 1. Every row is therefore staged at dusk 0, which is the BRIGHTER and so the
// HARDER test: a brighter surround is a smaller contrast ratio and a hotter eye
// wash, and a row that reads at dusk 0 is not thereby claimed to read at dusk 1.
// The finale's own lighting is in the gallery already (`finale-headlights` and
// `win` are both dusk 1) and its reachability is §10.2's own gate, not a
// presentation question.
//
// WHY MORE THAN ONE FRAME PER ROW
// -------------------------------
// Two of the five rows FLICKER — `telegraph` at `apparitionFlicker`'s 5.4 Hz and
// `stagger` at 7.7 Hz — and a single photograph of a flickering row is a
// photograph of one phase of it. A row is therefore sampled at waits spaced
// across its own period (`CREATURE_PROBE_ROWS`), and the report holds every
// sample, so "the apparition's eye clears the floor" is a claim about its
// loudest beat and "the apparition is a rumour" is a claim about the gap between
// its samples rather than about one lucky frame. The steady rows are sampled
// twice for the same reason: a read that holds on one frame of a walk is not a
// read.
//
// WHAT THE SAMPLES MAY NOT BE ASKED TO PROVE
// -----------------------------------------
// "The apparition is a rumour" used to be gated here, as a spread between the
// row's loudest and quietest sample. It cannot be, and the run that motivated this
// pass is the reason: all three `telegraph` samples landed inside ONE trough of
// `apparitionFlicker` (a beat whose 2.2 exponent makes a trough wide and flat), so
// the spread came out at 0.99 of peak and the gate would have failed a row that
// flickers correctly. Three frames at three arbitrary phases of a 5.4 Hz beat are
// not a measurement of the beat. The claim is made in `verify.mjs` instead, over a
// WHOLE period at 240 Hz a beat, which is the same number and cannot be luck — and
// the observed spread is still reported here, as a measurement rather than a gate.
// ---------------------------------------------------------------------------

/**
 * CREATURE_PROBE_STANDOFF — the one camera the whole probe is taken from.
 *
 * BEFORE (pass 15): nothing; the three creature views each carried their own
 * stand-off, which is right for a gallery and wrong for a comparison. AFTER:
 * these three numbers, read by every probe view and asserted by `verify.mjs`,
 * so "the five rows were photographed in the same light" is a fact about one
 * table instead of a promise in five comments.
 *
 * `back: 25` and `metres: 17` are `creature-stalking`'s, measured: that frame
 * puts the pool between the lens and the figure and lands at a contrast ratio
 * of 0.572 against a 0.62 floor (body 45.0 against a surround of 78.7, measured
 * off the committed PNG). `bearing: 6` keeps the figure off the exact
 * road axis without pushing it into the kerb.
 */
export const CREATURE_PROBE_STANDOFF = Object.freeze({ back: 25, metres: 17, bearing: 6 })

/**
 * CREATURE_PROBE_ROWS — the five §6.1-presentable rows, and how each is sampled.
 *
 * `state` is the row of `CREATURE_PRESENTATION` the frame is there to measure;
 * `hammer` is whether the pickup is in the view, which is §8.1 rather than
 * taste: a `telegraph` is Act I's apparition and Act I has no hammer, and every
 * other row is Act II and must have one;
 *
 * `waits` are the world-seconds after the placement, one per sample.
 *
 * AND THE SPACING IS NOT A WHOLE NUMBER OF PERIODS, which the first version of this
 * table got exactly backwards. It claimed the spacing was "each row's own flicker
 * period crossed two or three times over, so the samples see the row at more than one
 * phase of itself" — and crossing a period is the ONE spacing that sees the SAME
 * phase. The telegraph's steps of 0.18 s were 0.972 of `apparitionFlicker`'s 5.4 Hz
 * period (0.1852 s), so its three samples sat 0.028 of a period — 5 ms of phase —
 * apart, and the probe measured it: `pose.haze` 0.6966 / 0.6971 / 0.6940 for waits
 * 0.18 s apart, which is three samples of one point. All three landed in the same
 * trough of the apparition's beat and not one of them had an eye for the finder to
 * anchor on. The steps are now 0.11 s, which is 0.594 of the period: three phases
 * 0.594 and 0.188 of a cycle apart, and no pair of them can coincide whatever the
 * row's hashed `offset` turns out to be, because a step that is not a whole number
 * of periods cannot land twice in the same place. `verify.mjs` gates that.
 *
 * `stagger` is the exception and it is not an oversight. Its spacing is spent on
 * §7.4's RECOIL, which is a different clock and the thing the row is there to sample
 * — the three waits walk `staggerRecoil` from 0.47 down to 0.23 — and its steps of
 * 0.13 s are one whole 7.7 Hz period, which is what walking a recoil costs. The row
 * still has its beat running and `probeGates` gates that row's LOUDEST sample, which
 * is the peak of the beat, so the phase being fixed costs the row nothing that was
 * being measured.
 *
 * `staggerSeconds` is the §7.4 recoil clock, and it exists because a `stagger`
 * with none is not a stagger: `creatureStep` sees `staggerSeconds` at 0, ends
 * the banish on the next frame and the figure is `dormant` before the shutter.
 * 1.1 of `STAGGER_SECONDS` 1.6 is a mid-recoil pose (`staggerRecoil` 0.47), and
 * the three samples then walk it down to 0.23, which is three different points
 * of the same throw.
 */
export const CREATURE_PROBE_ROWS = Object.freeze([
  Object.freeze({ state: 'telegraph', hammer: false, staggerSeconds: 0, waits: Object.freeze([0.1, 0.21, 0.32]) }),
  Object.freeze({ state: 'stalk', hammer: true, staggerSeconds: 0, waits: Object.freeze([0.18, 0.42]) }),
  Object.freeze({ state: 'chase', hammer: true, staggerSeconds: 0, waits: Object.freeze([0.18, 0.42]) }),
  Object.freeze({ state: 'stagger', hammer: true, staggerSeconds: 1.1, waits: Object.freeze([0.08, 0.21, 0.34]) }),
  Object.freeze({ state: 'enraged', hammer: true, staggerSeconds: 0, waits: Object.freeze([0.18, 0.42]) }),
])

/**
 * probeRowOf — the row a probe id belongs to, or `null` for nonsense.
 *
 * BEFORE pass 15: `null` also meant the control view. AFTER: every probe view is a
 * row, because the control is no longer a VIEW — it is the same page with the
 * figure taken out of it after the shutter (`capture/main.jsx`'s
 * `__captureBaseline`), which is the only way the baseline can be the same world at
 * the same clock. A `null` here is a bug in a caller or a typo in an `--only`, and
 * the harness says so instead of quietly measuring a control.
 */
export function probeRowOf(id) {
  const match = /^creature-probe-([a-z]+)-\d+$/.exec(String(id))
  return match ? CREATURE_PROBE_ROWS.find((row) => row.state === match[1]) ?? null : null
}

/** The id one sample of one row is filed under. `sample` is 1-based. */
export function probeId(state, sample) {
  return `creature-probe-${state}-${sample}`
}

/**
 * The steps for one probe view, and the one function every probe view is built
 * through — so the stand-off, the lamp, the act and the framing cannot differ
 * between two rows by accident.
 *
 * BEFORE this pass it also built the control view, which is `stalk`'s first sample
 * with the `creature` step removed, and that derivation was the whole reason the
 * probe had a control at all: the shimmer differential is this frame minus that
 * one, so the two have to have run the same world for the same time with the same
 * camera. They did — as two page loads, which is the same world to within a frame,
 * and this measurement is worth one level of luma. The control is now taken inside
 * the same page after the shutter, which is the same picture with one thing taken
 * out of it, so there is no control VIEW to derive and nothing here to keep in step.
 *
 * `staggerSeconds` is written on EVERY creature step rather than only on the
 * stagger's, so the step's shape is one shape: a number that is present for four
 * rows and absent for one is a step whose contract depends on which row is being
 * photographed, and `verify.mjs` would then have two shapes to check instead of
 * one. `placeCreature` treats 0 as "leave the clock alone", which is the same
 * answer for the four rows that never read it.
 */
function probeSteps(row, wait) {
  const S = CREATURE_PROBE_STANDOFF
  const steps = [{ op: 'begin' }]
  if (row.hammer) steps.push({ op: 'takeHammer' })
  steps.push({ op: 'goto', target: 'lamp', back: S.back })
  steps.push({
    op: 'creature',
    state: row.state,
    metres: S.metres,
    bearing: S.bearing,
    staggerSeconds: row.staggerSeconds,
  })
  steps.push({ op: 'wait', seconds: wait })
  steps.push({ op: 'frames', count: 2 })
  return Object.freeze(steps)
}

/**
 * Every probe view, in row order: `{id, row, sample, wait, viewport, steps}`.
 *
 * BEFORE pass 15: the control view led this list. AFTER: twelve views, one per
 * sample of the five rows, and the baseline is not among them because it is not a
 * view — `capture/main.jsx` takes it in the same page after the shutter. That is
 * why the ids are the rows' own and nothing else: a name here is a row sample, and
 * anything that is not one has no business being photographed as a gallery frame.
 */
export const CREATURE_PROBE_VIEWS = Object.freeze(
  CREATURE_PROBE_ROWS.flatMap((row) =>
    row.waits.map((wait, index) =>
      Object.freeze({
        id: probeId(row.state, index + 1),
        row,
        sample: index + 1,
        wait,
        viewport: CAPTURE_VIEWPORT,
        steps: probeSteps(row, wait),
      }),
    ),
  ),
)

/** Every probe id, in row order. What `tools/capture.mjs` iterates in `--probe`. */
export const CREATURE_PROBE_IDS = Object.freeze(CREATURE_PROBE_VIEWS.map((view) => view.id))

/**
 * probeView — one probe view by id, or `null`.
 *
 * The same contract as `captureView` and for the same reason: the harness asks
 * this for an `--only` argument typed by a human, and a typo should read as "no
 * such view" in the report rather than as a stack trace.
 */
export function probeView(id) {
  return CREATURE_PROBE_VIEWS.find((view) => view.id === id) ?? null
}

/** Every step of every probe view, tagged — what the pass-15 contract check walks. */
export function allProbeSteps() {
  return CREATURE_PROBE_VIEWS.flatMap((view) => view.steps.map((step) => ({ view: view.id, step })))
}

/**
 * PROBE_MIN_LIT — the probe's own lit floor, and it is the street's.
 *
 * BEFORE: n/a. AFTER `CAPTURE_MIN_LIT` (0.06), by reference rather than by a
 * second number.
 *
 * A probe frame is a lighting measurement and not a composition one, so the
 * thing that must not happen to it is a black rectangle; the luma floor is the
 * gate for that and it is the same gate, at the same value, for the same reason
 * the fourteen gallery views use it. A probe that let a darker frame through on
 * the argument that it is "only instrumentation" would be measuring a different
 * world from the one the gallery describes.
 */
export const PROBE_MIN_LIT = CAPTURE_MIN_LIT

/**
 * PROBE_ANCHOR_MAX_PX — how far the eye finder may be from the creature's own
 * projected head, in pixels. 24.
 *
 * BEFORE: nothing could check this, which is how a 12x6 lit window in
 * `hammer-located.png` came to satisfy every one of `findEyes`'s tests. AFTER:
 * every probe frame carries the head's pixel position out of the world it was
 * drawn in, and the harness fails the frame when the anchor it found is further
 * away than this.
 *
 * 24 px is roughly two eye widths at the 17 m this probe stands at, and the
 * figure's own head never moves that far from its own eyes: the eyes are 3 cm
 * above the head's centre, `lean` swings the crown about 6 px and §6.1's
 * edge-of-vision roll about 4. A blob 200 px away in a house window is not a
 * tight tolerance being tight — it is a different subject, and this is the number
 * that says so. A probe frame whose head is off the picture entirely cannot pass
 * it either, which is the point: the finder is trusted only where it has been
 * shown to be right.
 */
export const PROBE_ANCHOR_MAX_PX = 24

/**
 * PROBE_BASELINE_MAX_DRIFT — how far the world's own clock may move between a probe
 * frame and the baseline taken out of the same page after it, in seconds. 0.02.
 *
 * BEFORE pass 15: there was no bound, because the baseline was a second run of the
 * same steps and the two runs' clocks differed by the sampling delay — tens of
 * milliseconds, uncontrolled, and different for every row because every row waits a
 * different length of time. AFTER: `run` holds the render loop the moment the
 * creature's last frame is drawn and `__captureBaseline` never re-arms it, so the
 * two shutters are a second of wall clock apart and no world time at all. The
 * movement is still measured and still gated here, because a hold is a claim and a
 * claim with no number is a comment.
 *
 * THE FIRST VERSION OF THE FIX WAS WORTH 0.05, ON EVERY ROW
 * ---------------------------------------------------------
 * The page held the loop at the top of `__captureBaseline` and handed it BACK
 * before the shutter, so the frame that came back was worth `world.js`'s own 0.05 s
 * clamp every run: the delta it was handed was the second the software renderer
 * had spent drawing the frame underneath it. Twelve of twelve rows failed this
 * ceiling with the same number to three places, which is the signature of a
 * harness fault and not of a lamp dropout. Holding the loop across BOTH shutters is
 * the same fix at the other end, and the ceiling is left where it was: it is
 * smaller than the thing it has to be smaller than, and a tighter one would only
 * be tighter.
 *
 * 0.02 s is `world.js`'s own 0.05 s frame clamp divided by two and a half, and it is
 * chosen from what it has to be smaller than rather than from taste: `flickerAt` — the
 * hashed lamp dropout behind `lampDread` — ticks on `animTime` at
 * `LAMP_DREAD_HZ` 11 Hz, so a tenth of a tick is the number below which a dropout
 * cannot land between the two frames. At 0.02 s the worst case is a 20% chance of
 * straddling a tick, and the reference boxes divide a lamp's level change out anyway;
 * the bound is here so that a page which stops holding the loop fails loudly instead
 * of quietly measuring two different worlds.
 */
export const PROBE_BASELINE_MAX_DRIFT = 0.02

/**
 * PROBE_BAND_ROWS — how many rows either side of the head's own row the shimmer is
 * measured over. 2, a five-row window.
 *
 * Head height is 2.68 m, where pass 11's six bands put two of them, and nothing else
 * in the creature's kit is there: the trail and the dust puffs are at the feet,
 * which at 17 m is 90 px below the eye. A five-row window here is the shimmer and
 * nothing else, which is what makes the differential a measurement of one effect
 * rather than of the whole figure.
 *
 * BEFORE pass 15 this number sat beside `PROBE_BAND_INNER` 0.65 and
 * `PROBE_BAND_OUTER` 0.95, fractions of `HAZE_HALF_WIDTH` that placed the boxes
 * 0.40-0.59 m either side of the HEAD. Both are gone, and the reason is in
 * `capture/main.jsx`'s `column`: the column is a cone standing on the creature's
 * ground position, and a staggering figure's head is a metre off that axis. The
 * radii now come from the band the frame actually drew (`creatureView.hazeLayers`),
 * so this file keeps the one number that is a property of the framing rather than
 * of the geometry — the rows — and the geometry is read rather than re-derived.
 */
export const PROBE_BAND_ROWS = 2

/**
 * PROBE_REFERENCE_INNER / PROBE_REFERENCE_OUTER — the reference band's own two
 * edges in METRES off the figure's axis: 1.3 and 1.8.
 *
 * The reference is what the creature's SECOND effect on the light is divided out
 * against, and pass 11 built that effect deliberately: `lampPulse` scales the
 * sodium lamps within `LAMP_DREAD_RADIUS` by the eye-flare envelope, and a figure
 * the harness has just placed has its flare at the peak. Measured over the whole
 * picture that is worth +7.6 luma on a chase frame and +5.6 on an enraged one —
 * eight times the shimmer the same frames were claimed to be showing. The first
 * version of this measurement reported those numbers as `shimmer`, and the three
 * `stagger` samples (which were taken at waits the control's wait did not share, so
 * the lamp's hashed 11 Hz dropout landed differently in the two frames) came out at
 * -0.31, -0.31 and +0.05: a report about the lamps, wearing the shimmer's name.
 *
 * 1.3 m is clear of the widest band the table can draw. `HAZE_HALF_WIDTH` is 0.62 m,
 * the cone reaches 1.28 of it at the crown, and `enraged` scales the whole rig by
 * 1.08: 0.62 x 1.28 x 1.08 = 0.857 m. 1.3 is half as far again, so no band can put
 * a pixel inside the reference on any row of any state, and `verify.mjs` asserts
 * that inequality from the same constants rather than trusting the arithmetic here.
 *
 * 1.8 m is the other end, and it is bounded by the frame rather than by the column:
 * at the 17 m stand-off and 30 px to the metre these are 39 to 54 px either side of
 * the axis, which at 1280 wide leaves the reference on the same fog the band is
 * standing in front of rather than out on the kerb. Same rows, same depth, same
 * light, no shimmer — which is the entire point of a reference.
 */
export const PROBE_REFERENCE_INNER = 1.3
export const PROBE_REFERENCE_OUTER = 1.8

/**
 * PROBE_EYE_MARGIN — the luma a row's LOUDEST sample has to clear `EYE_MIN` by.
 * 10.
 *
 * The same number pass 2's eye gate already holds the gallery's three creature
 * frames to, and for the same reason: a ten-level margin is a frame that passes
 * by rounding, and a pass-11 note that quotes only the comfortable frames is how
 * a 21-level margin became an unstated 4-level one.
 *
 * It applies to the loudest sample of a row and not to all of them, because two
 * of the five rows are SUPPOSED to go dark: §6.1's telegraph is "a thing that is
 * there, then is not, then is", and a gate that held its floor on every sample
 * would be asking the design to stop flickering. The floor is on the beat where
 * the apparition is present, and `PROBE_FLICKER_SPREAD` is what holds the rest.
 */
export const PROBE_EYE_MARGIN = 10

/**
 * PROBE_FLICKER_SPREAD — how much quieter a flickering row's quietest beat is than
 * its loudest, as a ratio of the eye. 0.45.
 *
 * A row that flickers and a row that is simply dim are different things, and only
 * one of them is §6.1. A single frame cannot tell them apart — a telegraph caught at
 * the bottom of its beat looks exactly like a telegraph that is permanently faint —
 * so the claim has to be made ACROSS a beat rather than in one of them.
 *
 * WHERE IT IS GATED, AND WHY IT MOVED
 * -----------------------------------
 * BEFORE pass 15: here, as a ratio between the loudest and quietest of a row's three
 * sampled frames. AFTER: in `verify.mjs`, over a whole period of the row's own beat
 * at 240 samples a period. The first version of this gate could not be passed by a
 * correct row, and the run that found that out is the same run this pass is built
 * on: all three `telegraph` samples landed inside ONE trough of `apparitionFlicker`
 * (whose 2.2 exponent makes a trough wide and flat), so the observed spread was
 * 0.99 of peak where the floor is 0.45. Three frames at three arbitrary phases of
 * a 5.4 Hz beat are not a measurement of that beat; the pure module has all of it
 * and costs nothing to walk.
 *
 * The number stays HERE, and the pure gate imports it, because "how quiet does a
 * flickering row go" is one design threshold and the probe still reports what it
 * observed. What changed is that a measurement of luck is reported and a
 * measurement of the thing is gated.
 *
 * The steady rows are not asked this at all: `stalk`, `chase` and `enraged` have no
 * `flicker` in `CREATURE_PRESENTATION`, and `verify.mjs` holds that the set of rows
 * with a flicker is exactly the set gated here.
 */
export const PROBE_FLICKER_SPREAD = 0.45

/**
 * PROBE_SHIMMER_MIN — the luma the shimmer's curtain bands have to gain over the
 * same pixels of the same frame with the figure taken out of it, once the creature's
 * own effect on the street lighting is divided out against `PROBE_REFERENCE_*`.
 * 0.60.
 *
 * BEFORE pass 15: 0.20, against a control frame that was a second page load of the
 * same steps. The number was not the problem. The problem was what it was measuring,
 * and the first run of this probe found it: with the boxes on the head and the
 * baseline a frame away in world time, `chase` read +9.9 and `enraged` +11.6 — and
 * both of those are `lampPulse`, pass 11's own effect, which is +7.6 luma over the
 * WHOLE picture on a freshly placed figure. Against the reference the same frames
 * read +1.10 and +4.06, and `stalk` read -0.40. The 0.20 floor was being cleared by
 * the lamps.
 *
 * WHY 0.60. It is a floor against a MEASURED noise, not a preference. The scatter
 * between two samples of the same row — the two `stalk` samples, one of them at the
 * same world time as the baseline and one of them not — was 0.7 luma on the
 * uncorrected boxes, and a floor under a number that noisy is a gate on the noise.
 * 0.60 is three times the per-pixel noise of a same-clock pair (1.3 levels over
 * 43 000 pixels is 0.006 per pixel, and a 65-pixel box averages it away), it is
 * 0.7% of the luma-90 fog the bands stand in, and it is a fifth of what the doubled
 * `HAZE_PEAK` is expected to deliver. A shimmer worth less than 0.7% of the fog is
 * not a shimmer; that is the claim, and it is the same claim pass 11's own [2, 12]
 * budget made against the fog of the day.
 *
 * It is a floor and not a target. The measured lifts are in the report beside it and
 * a retune that pushes them up is not required to preserve them, because the property
 * being claimed is "the shimmer reaches the screen" and visibility has no upper bound
 * worth defending.
 */
export const PROBE_SHIMMER_MIN = 0.6

/**
 * PROBE_FLICKER_ROWS — the two rows whose presentation flickers, read off
 * `CREATURE_PRESENTATION` rather than typed as a second list.
 *
 * `verify.mjs` holds that this is exactly the set of rows with a `flicker`, so
 * a retune that gave a third row a flicker without a third row of samples fails
 * the gate instead of quietly going unmeasured.
 */
export const PROBE_FLICKER_ROWS = Object.freeze(
  CREATURE_PROBE_ROWS.filter((row) => row.waits.length > 2).map((row) => row.state),
)

/**
 * `viewById` — the gallery first, then the probe. What the page asks for.
 *
 * Two lists and one lookup, rather than one list, because the two sets have
 * different owners: the gallery is §16.5's deliverable and `verify.mjs` pins its
 * fourteen ids, and the probe is this pass's instrument. Merging them would let
 * a probe view be photographed into the gallery and counted in it.
 */
export function viewById(id) {
  return captureView(id) ?? probeView(id)
}

/**
 * captureView — the one view, by id, or `null`.
 *
 * `null` rather than a throw, because the harness asks this for an `--only`
 * argument typed by a human, and a typo there should read as "no such view" in the
 * report instead of a stack trace.
 */
export function captureView(id) {
  return CAPTURE_VIEWS.find((view) => view.id === id) ?? null
}

/** Every step of every view, tagged with its view — what the gate walks. */
export function allSteps() {
  return CAPTURE_VIEWS.flatMap((view) => view.steps.map((step) => ({ view: view.id, step })))
}

export default CAPTURE_VIEWS
