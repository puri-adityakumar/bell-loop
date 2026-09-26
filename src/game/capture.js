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
      { op: 'wait', seconds: 0.3 },
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
