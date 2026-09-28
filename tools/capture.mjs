#!/usr/bin/env node
/**
 * capture.mjs — take the §16.5 gallery (v2 slice 16), and iteration 2 pass 15's
 * per-state light probe.
 *
 *   npm run capture                 # all fourteen
 *   npm run capture -- --only win   # one, for iterating on a composition
 *   npm run capture -- --out /tmp/x # somewhere other than benchmark/screenshots
 *   npm run capture -- --probe      # the twelve probe frames, NOT the gallery
 *   npm run capture -- --probe --only creature-probe-stalk-1
 *
 * THE PROBE, AND WHY IT IS A FLAG AND NOT A FIFTEENTH VIEW
 * ------------------------------------------------------
 * `verify.mjs` pins §16.5's fourteen ids, their order and their count, and a
 * harness that could quietly add a fifteenth would be a harness whose gallery
 * claim has drifted. So pass 15's lighting rig is a MODE: the same server, the
 * same browser, the same shutter, a different list of views from
 * `src/game/capture.js` (`CREATURE_PROBE_IDS`), its own output directory, its
 * own report, and `npm run capture` with no flags still means the fourteen.
 *
 * What the gallery can and cannot answer is the reason the mode exists. Three of
 * the fourteen happen to hold a creature; `CREATURE_PRESENTATION` has five rows
 * that can be presented to the player, and the other two were being carried by
 * pass 1's brighter amber fog on nothing more than an opinion. The probe is the
 * measurement: one stand-off, one light, five rows, and three claims per frame —
 * the silhouette ratio (§12.1's "a hole in the fog"), the eye's floor, and the
 * shimmer's own lift over the SAME frame with the figure taken out of it.
 *
 * THE BASELINE IS NOT A VIEW
 * --------------------------
 * The first version took its control as a thirteenth view — `stalk`'s own step list
 * with the `creature` step removed — and ran it as a second page load. That is the
 * same world to within a frame, and this measurement is worth one level of luma, so
 * the baseline is now taken in the SAME page immediately after the shutter:
 * `__captureBaseline` removes the figure, puts the lamps back, and renders one more
 * frame with the clock held. Twelve views, twelve baselines, and the differential
 * is a subtraction of two frames that differ by one object.
 *
 * WHAT IT DOES
 * ------------
 * Starts a Vite dev server on a free port, opens `capture.html` in the
 * chrome-headless-shell already in this machine's Puppeteer cache, and asks the
 * page to take each view in `src/game/capture.js` in turn. For every view it
 * writes `benchmark/screenshots/<id>.png` and records, in
 * `benchmark/captures.json`, what the world actually looked like at that moment.
 *
 * WHY THE REPORT IS PART OF THE OUTPUT
 * ------------------------------------
 * A PNG is a claim with no evidence attached. The report is the evidence: phase,
 * portals shut, hold fraction, creature state, awareness, dusk, the number of
 * banishes — read out of the live world after the last step, not out of the
 * script. When a view is wrong, the report is what says whether the world was
 * wrong or the camera was, and a gallery entry whose JSON says `creature:
 * "telegraph"` next to a filename called `creature-chasing` is a bug the next
 * reader can see without opening anything.
 *
 * WHY IT FAILS LOUDLY
 * -------------------
 * There is no fallback. If the page cannot reach a state, this records the
 * failure, writes no PNG for that id, and exits 1 — a gallery with a hole in it
 * beats a gallery with a plausible wrong picture in it. The same applies to the
 * renderer: if WebGL cannot be created at all, that is written into the report
 * verbatim and the exit code is 1, because "the screenshots are missing" and
 * "the screenshots are of a black rectangle" must never be the same event.
 *
 * THE FLAGS, AND WHY THEY ARE THESE
 * ---------------------------------
 * `--no-sandbox` because the container runs as root; `--use-gl=swiftshader` and
 * `--enable-unsafe-swiftshader` because there is no GPU here and the software
 * rasteriser is the only thing that will give this build a WebGL 2 context.
 * `--disable-gpu` is kept as well: it stops the browser trying to use a
 * hardware path that does not exist and failing late, which is the failure mode
 * that costs a minute per view. The renderer string the page actually got is
 * recorded in the report, so none of this has to be taken on trust.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'
import {
  CAPTURE_DIR,
  CAPTURE_IDS,
  CAPTURE_MIN_LIT,
  describeSightline,
  FURNITURE_MIN_FAMILIES,
  FURNITURE_MIN_LEGIBLE_PX,
  FURNITURE_MIN_ON_SCREEN,
  // pass 15. The probe's list, its floors and its view lookup, all read from
  // `src/game/capture.js` rather than restated here, for the same reason the
  // gallery's are: the thing that decides what a frame is supposed to show has
  // to be readable in node, by the gate, without a browser.
  CREATURE_PROBE_IDS,
  CREATURE_PROBE_ROWS,
  PROBE_ANCHOR_MAX_PX,
  PROBE_BASELINE_MAX_DRIFT,
  PROBE_EYE_MARGIN,
  PROBE_FLICKER_ROWS,
  PROBE_FLICKER_SPREAD,
  PROBE_MIN_LIT,
  PROBE_SHIMMER_MIN,
  probeRowOf,
  viewById,
  // pass 17. The budget's poses, its six ceilings, and the gallery's own viewport,
  // read from `src/game/capture.js` for the same reason every other import on
  // this list is there: the thing that decides what is being measured has to be
  // readable in node, by the gate, without a browser. A budget this file wrote
  // itself would be a budget with no gate.
  BUDGET,
  BUDGET_POSES,
  BUDGET_ALLOC_FRAMES,
  CAPTURE_VIEWPORT,
} from '../src/game/capture.js'
import {
  creatureContrast,
  describeCreatureContrast,
  describeLuma,
  describeShimmerLift,
  EYE_MAX_SPAN,
  EYE_MIN,
  EYE_MIN_AREA,
  luma,
  LIT_LUMA,
  shimmerLift,
  SILHOUETTE_MAX,
} from './png-luma.mjs'

/** The browser this machine already has. Puppeteer's own download is not needed. */
const CHROME = process.env.CAPTURE_CHROME
  ?? '/work/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell'

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-dev-shm-usage',
  // PASS 17. `--expose-gc` and nothing else changed, and it is here for one
  // measurement: `__captureBudget`'s heap delta needs a way to collect before it
  // reads, or the delta is dominated by whatever the last major GC happened to
  // leave behind. It is a V8 flag inside a Chrome flag, which is why it is
  // `--js-flags=--expose-gc` and not `--expose-gc`. The page checks for
  // `window.gc` and reports `null` rather than a number if it is missing, so a
  // browser that drops the flag degrades one row of a report and does not lie.
  '--js-flags=--expose-gc',
]

/** How long one view may take before the harness calls it a failure. */
const VIEW_TIMEOUT_MS = 90_000

/** The repository root, which every path in this file's arguments is relative to. */
const REPO_ROOT = new URL('..', import.meta.url).pathname

/**
 * PROBE_DIR / PROBE_REPORT — where the probe's frames and numbers go.
 *
 * Not under `benchmark/screenshots/`, and not in `benchmark/` either: the probe is
 * instrumentation for one pass, and `benchmark/` is the published surface (the
 * fourteen approved captures, the catalog, the result templates). A committed
 * `benchmark/creature-probe.json` would be a second report that a reader of the
 * benchmark has to work out the standing of, and a probe frame would be one more
 * PNG in a folder whose contents are quoted as evidence. So the probe writes to
 * `.probe/`, which is gitignored alongside the other local artifacts.
 */
const PROBE_DIR = '.probe/frames'
const PROBE_REPORT = '.probe/creature-probe.json'

/**
 * BUDGET_REPORT — where pass 17's numbers go.
 *
 * `.perf/budget.json`, and the reasoning is the probe's verbatim: this is
 * instrumentation for one pass, not a deliverable, and `benchmark/` is the
 * published surface whose contents are quoted as evidence. A committed
 * `benchmark/budget.json` would be a second report in a folder a reader of the
 * benchmark has to work out the standing of. The MEASURED numbers are quoted in
 * `AESTHETIC-NOTES.md` §10 instead, which is where a reader is meant to find
 * them, and the file itself stays local and gitignored.
 *
 * There is no frame directory at all: the budget writes no PNG, and the flag
 * below has no `--out` default because there is nothing to put in one.
 */
const BUDGET_REPORT = '.perf/budget.json'

/**
 * fromRepo — a path in this file's arguments, resolved against the repository root.
 *
 * `path.resolve`, not `new URL('../' + arg, import.meta.url)`. The URL form looks
 * right and is wrong in a way that costs an afternoon: URL resolution treats a
 * leading `/` as the root of the *file* scheme, so `--out /tmp/probe` silently
 * became `<repo>/tmp/probe` and wrote a run's captures into the working tree,
 * which is exactly the thing `.gitignore` and the benchmark's "keep unpublished
 * captures out of commits" rule exist to prevent. `path.resolve` honours the
 * leading `/` a person means.
 */
function fromRepo(argument) {
  return path.resolve(REPO_ROOT, argument)
}

function parseArgs(argv) {
  const options = { only: null, out: null, report: null, probe: false, budget: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--only') options.only = argv[(index += 1)]
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length)
    else if (arg === '--out') options.out = argv[(index += 1)]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--report') options.report = argv[(index += 1)]
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length)
    else if (arg === '--probe') options.probe = true
    else if (arg === '--budget') options.budget = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  // PASS 17. `--budget` is not a third PHOTOGRAPHY mode and it is refused to
  // pretend to be one. The two flags that only make sense for a set of pictures —
  // `--only` (one view of a set) and `--out` (a directory of PNGs) — are errors
  // here rather than being quietly ignored, because a silently ignored `--out` on
  // a run that writes no frames is a flag that appears to have done something.
  if (options.budget) {
    if (options.probe) throw new Error('--probe and --budget are two different measurements; pick one')
    if (options.only) throw new Error('--only is a view selector, and the budget is not a set of views')
    if (options.out) throw new Error('--out is a frame directory, and the budget writes no frames')
    if (options.report === null) options.report = BUDGET_REPORT
    return options
  }
  // The defaults FOLLOW the mode rather than being written into `parseArgs`, so
  // that a probe run cannot be pointed at the gallery's directory by omission —
  // the two sets of frames are different pictures of the same world and mixing
  // them in one folder would leave a `creature-probe-stalk-1.png` sitting in the
  // approved comparison captures, which is the one place this repository promises
  // contains nothing but the fourteen.
  if (options.out === null) options.out = options.probe ? PROBE_DIR : CAPTURE_DIR
  if (options.report === null) options.report = options.probe ? PROBE_REPORT : 'benchmark/captures.json'
  return options
}

/**
 * The ids to take: all fourteen, or the one that was asked for.
 *
 * `viewById` and not `captureView`, so `--probe --only creature-probe-stalk-1`
 * validates against the list the mode is actually iterating. The error message
 * lists that mode's own ids, because "no such capture view" followed by fourteen
 * names is a confusing way to be told you typed a probe id without the flag.
 */
function idsFor(options) {
  const known = options.probe ? CREATURE_PROBE_IDS : CAPTURE_IDS
  if (!options.only) return [...known]
  const ids = options.only.split(',').map((id) => id.trim()).filter(Boolean)
  for (const id of ids) {
    if (!viewById(id)) throw new Error(`no such ${options.probe ? 'probe' : 'capture'} view: ${id}\nknown: ${known.join(', ')}`)
  }
  return ids
}

/**
 * The probe's two curtain bands, as rectangles in the picture, in pixels.
 *
 * BEFORE pass 15: this function computed the boxes, out of `PROBE_BAND_INNER` 0.65
 * and `PROBE_BAND_OUTER` 0.95 of `HAZE_HALF_WIDTH`, either side of the projected
 * HEAD. Both halves of that were wrong and they were wrong in opposite directions:
 * the column is a cone (0.72 of `HAZE_HALF_WIDTH` at the floor, 1.28 at the crown),
 * so a fraction of the constant straddles the hole in the low bands and overshoots
 * the crest in the high ones; and the column stands on the figure's GROUND position
 * while the head is on §7.4's recoil, so a staggering figure's head is 1.17 m — 35 px
 * — off the axis its own shimmer is standing on. The stagger's three samples were
 * photographing fog.
 *
 * AFTER: the boxes are read off `where.curtain` and `where.reference`, which
 * `capture/main.jsx` projected from `creatureView.hazeLayers` — the band list
 * `_presentHaze` actually wrote this frame — and this function's only remaining job
 * is to refuse to measure a frame that has no column in it. A frame with no shimmer
 * drawn is a failure with a name, not a reason to look somewhere else.
 *
 * AND THE RECTANGLES ARE CHECKED BEFORE THEY ARE MEASURED
 * --------------------------------------------------------
 * Which is where the first version of this probe died, one gate further on and for
 * a full run of wall clock later: the page built the LEFT-hand boxes by ordering
 * the two radii rather than the two x-coordinates, so on the left of the axis —
 * where the smaller radius is the larger x — it handed back a rectangle with its
 * corners the wrong way round, and `regionMean` threw on the first of the four.
 * The right half was the only half that was ever a rectangle, and the shimmer of
 * every row in the set was being measured on one band of a two-band claim.
 *
 * So the geometry is checked here, by this function, before a single pixel is read:
 * four boxes, each of them ordered and inside the frame, and the failure sentence
 * names ALL of them. `regionMean` is right to refuse a bad rectangle and wrong to
 * be where the answer is that the left side of the figure had none.
 */
function shimmerBands(where, viewport) {
  const column = where.column
  if (!column || column.on !== true) {
    return { found: false, reason: column ? column.reason : 'the page reported no column at all' }
  }
  if (!Array.isArray(where.curtain) || where.curtain.length === 0) {
    return { found: false, reason: 'the column was drawn but projected to no boxes' }
  }
  if (!Array.isArray(where.reference) || where.reference.length === 0) {
    return { found: false, reason: 'the column was drawn but no reference boxes came with it' }
  }
  const bad = []
  for (const [name, list] of [['curtain', where.curtain], ['reference', where.reference]]) {
    list.forEach((box, index) => {
      const why = []
      if (!(box.x1 > box.x0)) why.push(`its x edges are the wrong way round (${box.x0}..${box.x1})`)
      if (!(box.y1 > box.y0)) why.push(`its y edges are the wrong way round (${box.y0}..${box.y1})`)
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > viewport.width || box.y1 > viewport.height) {
        why.push(`it hangs off a ${viewport.width}x${viewport.height} frame`)
      }
      if (why.length > 0) bad.push(`${name}[${index}] (${box.x0},${box.y0})-(${box.x1},${box.y1}): ${why.join(' and ')}`)
    })
  }
  if (bad.length > 0) {
    return { found: false, reason: `the projected boxes are not rectangles in the picture — ${bad.join('; ')}` }
  }
  return { found: true, bands: where.curtain, reference: where.reference }
}

/**
 * `measureProbe` — one probe frame, and the three claims pass 15 makes about it.
 *
 * 1. THE ANCHOR. `creatureContrast` finds the brightest compact blob in the
 *    frame and then says things about whatever is under it, so every number it
 *    returns is a claim about that blob. Passes 5-12 added lit windows, and a
 *    window in a house 200 px from the staged figure passes all of the finder's
 *    tests. The page now projects the creature's own head out of the scene graph
 *    it was drawn in, so the anchor the finder used can be compared against the
 *    subject the harness staged, and a frame whose eye is further than
 *    `PROBE_ANCHOR_MAX_PX` from it fails instead of measuring the wrong thing.
 * 2. THE SILHOUETTE. §12.1's "a hole in the fog", against the same
 *    `SILHOUETTE_MAX` the pure gate holds `creature-stalking.png` to — one
 *    number, read in both places, so a retune cannot leave the pure harness and
 *    this harness disagreeing about what washed out means. The lit background is
 *    checked too, for the reason `verify.mjs` checks it there: a black shape on
 *    an unlit wall scores a perfect 0.0.
 * 3. THE SHIMMER. The figure's own heat-haze curtains, as a DIFFERENTIAL against
 *    the baseline — the SAME frame, the SAME camera, the SAME clock, with the
 *    figure taken out of it — less what the figure's other effect on the light did
 *    to the whole picture (pass 11's `lampPulse`, worth +7.6 luma, read over the
 *    reference boxes at the same rows). Positive means the figure put light into
 *    the air beside it; zero or negative means pass 11's haze is not reaching the
 *    screen, which no per-pixel constant in this file can tell.
 *
 * The BASELINE is measured too, and is expected to find NOTHING: that is the proof
 * the frame the differential is measured against is a frame with no figure in it,
 * which is the one assumption a subtraction rests on. It is also why the baseline
 * cannot be a second run of the same steps — a second run is the same world only to
 * the order of a frame, and a subtraction that can be moved by a frame cannot be
 * read at one level of luma.
 *
 * AND A FAILED FRAME KEEPS ITS MEASUREMENT
 * -----------------------------------------
 * Every claim above is written onto `entry` as it is checked, and the caller keeps
 * `entry` when one of them throws. That is the difference between "the stagger's
 * heat haze is not reaching the screen" and the same sentence plus the pose, the
 * projected column, the contrast and the lift — which is the difference between a
 * failure report and a retune. The first run of this probe failed six frames and
 * could only be diagnosed by re-deriving the geometry by hand.
 */
function measureProbe(id, shot, snapshot, baselineShot, baseline, entry, { floor, viewport }) {
  const where = snapshot.where
  const measured = creatureContrast(shot)
  // The CALLER'S entry, and not a new object of the same shape, because this
  // function throws from inside three of the checks below and everything it has
  // measured by then has to survive the throw. A local object is discarded by it:
  // every failed probe frame in the first run reported a sentence and no numbers
  // at all, and the block that prints the numbers on a failure had never once had
  // anything to print. The comment that claimed otherwise was the bug.
  entry.state = snapshot.creature
  entry.pose = snapshot.pose
  entry.where = where
  const row = probeRowOf(id)
  if (row === null) {
    throw new Error(`${id} is not a probe row sample, so there is nothing to measure — a control view is not a view any more`)
  }
  // THE BASELINE'S OWN CLAIM, first, because everything after it is a subtraction
  // against this frame and a subtraction against a frame that still has the figure
  // in it is a difference between two figures.
  const blank = creatureContrast(baselineShot)
  // The control is a frame of THIS street, and it is measured like one. The reason
  // it needs saying: the page draws the control and then waits a single compositor
  // frame for the canvas to reach the shutter, so "the drawing buffer was cleared
  // before the shutter read it" is a real failure mode of the fix that made the
  // control share this frame's clock — and it fails SILENTLY. A black control
  // resolves no creature, so every claim above it passes, and the shimmer
  // differential comes back enormous and green. The floor is the same 6% the
  // creature's own frame is measured against, because a control that is darker
  // than the frame it controls is not a control.
  const blankLuma = luma(baselineShot)
  entry.baseline = { ...baseline, foundCreature: blank.found, litPct: blankLuma.litPct }
  if (blankLuma.lit < floor) {
    throw new Error(
      `the baseline of ${id} is too dark to be the same street: ${describeLuma(blankLuma, Number((floor * 100).toFixed(2)))}`,
    )
  }
  if (blank.found) {
    throw new Error(
      `the baseline of ${id} still resolves a creature (${describeCreatureContrast(blank)}), so the shimmer ` +
        'differential would be measuring the difference between two creatures',
    )
  }
  if (baseline.presented === true) {
    throw new Error(`the baseline of ${id} still has the figure on screen, so nothing was taken out of it`)
  }
  // The clock, and it is the gap between the two frames rather than the movement
  // inside the call that takes the second of them. The page holds the render loop
  // from the creature's last draw through this shutter (`holdLoop`), so the number
  // below is the whole of the world time between the picture and its control and
  // is expected to be zero. It is reported rather than assumed because the gate
  // this pass wrote is the thing that caught the harness it was written next to.
  if (!(Math.abs(baseline.drift) <= PROBE_BASELINE_MAX_DRIFT)) {
    throw new Error(
      `the baseline of ${id} was taken ${baseline.drift} s of world time after the frame it is supposed to ` +
        `differ from, so a lamp dropout can land in one and not the other (ceiling ${PROBE_BASELINE_MAX_DRIFT} s)`,
    )
  }
  entry.row = row.state
  entry.sample = Number(/-(\d+)$/.exec(id)?.[1] ?? 0)
  entry.foundCreature = measured.found
  if (!measured.found) {
    throw new Error(`no creature in ${id}.png: ${measured.reason}`)
  }
  const eyeX = (measured.eye.minX + measured.eye.maxX) / 2
  const eyeY = (measured.eye.minY + measured.eye.maxY) / 2
  entry.anchor = { dx: Number((eyeX - where.head.x).toFixed(2)), dy: Number((eyeY - where.head.y).toFixed(2)) }
  entry.anchorDistance = Number(Math.hypot(entry.anchor.dx, entry.anchor.dy).toFixed(2))
  if (entry.anchorDistance > PROBE_ANCHOR_MAX_PX) {
    throw new Error(
      `the eye the finder locked onto is ${entry.anchorDistance} px from the head this frame staged ` +
        `(${entry.anchor.dx},${entry.anchor.dy} from it, ceiling ${PROBE_ANCHOR_MAX_PX}) — a probe frame that ` +
        'measured a house window is a failed frame, not a washed-out creature',
    )
  }
  const spanX = measured.eye.maxX - measured.eye.minX
  const spanY = measured.eye.maxY - measured.eye.minY
  if (measured.eye.n < EYE_MIN_AREA || spanX > EYE_MAX_SPAN || spanY > EYE_MAX_SPAN) {
    throw new Error(`the eye in ${id}.png is ${measured.eye.n} px and ${spanX}x${spanY} px, which is not the shape a creature's eye is`)
  }
  entry.contrast = {
    eye: Number(measured.eye.mean.toFixed(2)),
    body: Number(measured.body.toFixed(2)),
    sides: Number(measured.sides.toFixed(2)),
    ratio: Number(measured.ratio.toFixed(4)),
    n: measured.eye.n,
  }
  if (measured.ratio >= SILHOUETTE_MAX) {
    throw new Error(
      `the ${row.state} does not read as a hole in this fog: ${describeCreatureContrast(measured)} ` +
        `(needs under ${SILHOUETTE_MAX}) — retune the row's presence, not the world`,
    )
  }
  if (measured.sides < LIT_LUMA) {
    throw new Error(
      `the ${row.state} is against an unlit background (luma ${measured.sides.toFixed(1)}, floor ${LIT_LUMA}), so there ` +
        'is nothing for it to be a silhouette against',
    )
  }
  const boxes = shimmerBands(where, viewport)
  if (!boxes.found) {
    throw new Error(`the shimmer could not be measured on ${id}.png: ${boxes.reason}`)
  }
  const shimmer = shimmerLift(shot, baselineShot, boxes.bands, boxes.reference)
  if (!shimmer.found) {
    throw new Error(`the shimmer could not be measured on ${id}.png: ${shimmer.reason}`)
  }
  entry.shimmer = {
    lift: Number(shimmer.lift.toFixed(3)),
    // MOVEMENTS of each box against itself between the two frames — see the note on
    // `shimmerLift`'s return. These two are the confound and the claim, in that
    // order, and their difference is the lift above.
    band: Number(shimmer.band.toFixed(2)),
    spill: Number(shimmer.spill.toFixed(2)),
    // the boxes' own levels, kept because the difference between them is what the
    // confound is NOT and a reader who wants to check the subtraction needs them
    creature: Number(shimmer.creature.toFixed(2)),
    baseline: Number(shimmer.baseline.toFixed(2)),
    reference: Number(shimmer.reference.toFixed(2)),
    n: shimmer.n,
    boxes: boxes.bands,
    // per band, and per side. The claim is about two rectangles and this is the
    // only place a reader can see whether it is ONE of them carrying the other: a
    // curtain drawn on the figure's left and not its right passes an average.
    perBand: shimmer.perBand.map((one) => ({
      box: one.box,
      referenceBox: one.ref,
      creature: Number(one.creature.toFixed(2)),
      baseline: Number(one.baseline.toFixed(2)),
      refCreature: Number(one.refCreature.toFixed(2)),
      refBaseline: Number(one.refBaseline.toFixed(2)),
      band: Number(one.band.toFixed(2)),
      spill: Number(one.spill.toFixed(2)),
      lift: Number(one.lift.toFixed(2)),
    })),
  }
  if (shimmer.lift <= PROBE_SHIMMER_MIN) {
    throw new Error(
      `the ${row.state}'s heat haze is not reaching the screen: ${describeShimmerLift(shimmer)} ` +
        `(needs over ${PROBE_SHIMMER_MIN} luma)`,
    )
  }
  return entry
}

/**
 * `probeGates` — the claims that are about a ROW rather than a frame, and the
 * only ones the pass makes in its own voice.
 *
 *   eye floor       the row's LOUDEST sample clears `EYE_MIN` by
 *                   `PROBE_EYE_MARGIN`. On the peak, because §6.1's telegraph
 *                   and §7.4's stagger are SUPPOSED to go dark — a gate on every
 *                   sample would be asking the design to stop flickering.
 *   flicker spread  REPORTED, not gated. It used to be gated here, and the first
 *                   run of this probe is why it cannot be: all three `telegraph`
 *                   samples landed inside one trough of a beat whose 2.2 exponent
 *                   makes troughs wide and flat, so a row that flickers correctly
 *                   read as one that never goes quiet. The claim is made in
 *                   `verify.mjs` instead, over a whole period of the beat. What is
 *                   reported here is what these three frames happened to see, which
 *                   is a measurement and not a gate.
 *
 * Returns the whole table rather than throwing on the first failure: a retune
 * wants every row's numbers, not the first thing that crossed a line, and a
 * per-row `fails` list is the sentence a human reads to decide what to change.
 *
 * REVIEW 15. WHICH SAMPLES A ROW IS GATED OVER
 * -------------------------------------------------------
 * `measureProbe` writes `entry.contrast` only once the frame has got that far, and
 * a frame that resolved no creature — or resolved one at the wrong distance, or
 * failed the anchor — never gets there. A row is therefore gated over the samples
 * that WERE measured, and the ones that were not are counted and named.
 *
 * BEFORE this review: `samples.reduce((a, b) => a.contrast.eye ...)` over every
 * sample of the row, which cannot be reached at all in the world this pass ships —
 * the shimmer floor fails all twelve frames (that is the documented debt), the
 * row table was gated on `report.failed === 0`, and so the eye floor, the one ROW
 * claim in this file, was dead code: an instrument whose headline number was never
 * computed. It is also not a hypothetical hazard: the real report's `telegraph`
 * samples 2 and 3 resolved no creature at all, so calling this with the whole row
 * dies on `a.contrast.eye` with a TypeError, which is the same class of failure
 * this pass fixed in `verify.mjs`.
 *
 * A missing sample is NOT a failure of the row, and it is not a skip either. Two of
 * the three telegraph samples finding no eye is §6.1's beat doing exactly what
 * §6.1's beat is for, so demanding three resolvable eyes would be asking the design
 * to stop flickering; and a row whose loudest sample is one frame called three is
 * still a row whose loudest sample is what the floor is about. So the count is in
 * the table, the peak is taken over what exists, and a row with NO measured sample
 * at all is the one thing that throws — a run in which nothing was measured has no
 * row claim to make.
 */
function probeGates(rows) {
  const summary = []
  for (const row of CREATURE_PROBE_ROWS) {
    const all = rows.filter((entry) => entry.row === row.state)
    if (all.length !== row.waits.length) {
      throw new Error(
        `the ${row.state} row has ${all.length} of ${row.waits.length} samples — re-run the whole probe before reading it`,
      )
    }
    const samples = all.filter((entry) => entry.contrast)
    if (samples.length === 0) {
      throw new Error(
        `the ${row.state} row has no sample that got as far as a contrast measurement, so its eye floor ` +
          'has nothing to be measured against',
      )
    }
    const peak = samples.reduce((a, b) => (a.contrast.eye >= b.contrast.eye ? a : b))
    const quietest = samples.reduce((a, b) => (a.contrast.eye <= b.contrast.eye ? a : b))
    const worst = samples.reduce((a, b) => (a.contrast.ratio >= b.contrast.ratio ? a : b))
    const floor = EYE_MIN + PROBE_EYE_MARGIN
    const fails = []
    if (peak.contrast.eye < floor) {
      fails.push(`its loudest sample's eye is ${peak.contrast.eye} luma, under the ${floor} floor (${EYE_MIN} + ${PROBE_EYE_MARGIN})`)
    }
    summary.push({
      state: row.state,
      samples: samples.length,
      // the samples of this row that failed BEFORE a contrast was read, kept so a
      // reader of the table is told which rows it is a statement about two frames
      // rather than three. `telegraph` is 1 of 3 in the report this pass shipped.
      unmeasured: all.length - samples.length,
      flickers: PROBE_FLICKER_ROWS.includes(row.state),
      eye: { peak: peak.contrast.eye, quietest: quietest.contrast.eye, floor, id: peak.id },
      ratio: { worst: worst.contrast.ratio, id: worst.id, max: SILHOUETTE_MAX },
      observedSpread: Number((quietest.contrast.eye / peak.contrast.eye).toFixed(3)),
      shimmer: {
        min: Number(Math.min(...samples.map((entry) => entry.shimmer?.lift ?? Number.NaN)).toFixed(3)),
        max: Number(Math.max(...samples.map((entry) => entry.shimmer?.lift ?? Number.NaN)).toFixed(3)),
        floor: PROBE_SHIMMER_MIN,
      },
      fails,
    })
  }
  return summary
}

/**
 * budgetGates — the six ceilings, read against a run's four poses.
 *
 * §16.5's gallery gates its frames against a floor, and this is the same shape
 * for a different kind of claim. Three rules, and the third is the one that
 * matters most:
 *
 *  1. EVERY pose is measured. A budget read at one street position is a claim
 *     about that position, and the pass asked for the worst cases, so a run with
 *     a missing pose is a failed run rather than a partial one.
 *  2. EVERY pose is judged. A budget that only failed if the WORST row failed
 *     would let `lamp` regress by 200 draw calls while `street` stayed under the
 *     line, and the bright frame is the one with the least headroom on a
 *     fill-limited machine. So the gate is the max over poses, and every breach
 *     is named with the pose that breached it.
 *  3. A MISSING instrument is not a pass. `alloc` is `null` when the browser was
 *     not started with `--expose-gc`, and the row reports that as `not measured`
 *     with the reason, which is a warning in the report and a red exit code here
 *     — because a gate that is skipped on the machine that skipped it is exactly
 *     the shape of hole pass 16 spent a review finding in this very file.
 *
 * @param {object[]} poses the page's rows
 * @returns {object[]} one gate row per ceiling, `fails` empty when green
 */
function budgetGates(poses) {
  const worst = (read) => {
    let id = null
    let value = -Infinity
    for (const pose of poses) {
      const next = read(pose)
      if (next === null || next === undefined) continue
      if (next > value) {
        value = next
        id = pose.id
      }
    }
    return { id, value }
  }
  const rows = []
  const ceiling = (key, label, read) => {
    const { id, value } = worst(read)
    const fails = []
    if (!poses.some((pose) => read(pose) !== null && read(pose) !== undefined)) {
      fails.push(`no pose reported a ${label}, so the ceiling cannot be checked`)
    } else if (value > BUDGET[key]) {
      fails.push(`${id} is ${value} ${label}, over the ${BUDGET[key]} ceiling`)
    }
    rows.push({ ceiling: key, label, value, pose: id, budget: BUDGET[key], fails })
  }
  ceiling('drawCalls', 'draw calls', (pose) => pose.calls)
  ceiling('triangles', 'triangles', (pose) => pose.triangles)
  ceiling('programs', 'linked programs', (pose) => pose.programs)
  ceiling('geometries', 'resident geometries', (pose) => pose.graph.geometries)
  ceiling('updateMs', 'ms of update per frame', (pose) => pose.updateMs.p50)
  // rule 3: the allocation instrument being absent is a failure with a reason.
  const alloc = worst((pose) => (pose.alloc ? pose.alloc.bytes : null))
  const allocFails = []
  if (!poses.some((pose) => pose.alloc)) {
    allocFails.push(
      'no pose reported an allocation reading, so the ceiling cannot be checked — the browser was ' +
        'not started with `--expose-gc`, which tools/capture.mjs passes as `--js-flags=--expose-gc`',
    )
  } else if (alloc.value > BUDGET.allocBytes) {
    allocFails.push(`${alloc.id} allocates ${alloc.value} bytes a frame, over the ${BUDGET.allocBytes} ceiling`)
  }
  rows.push({
    ceiling: 'allocBytes',
    label: 'bytes of garbage per frame',
    value: poses.some((pose) => pose.alloc) ? alloc.value : null,
    pose: poses.some((pose) => pose.alloc) ? alloc.id : null,
    budget: BUDGET.allocBytes,
    fails: allocFails,
  })
  return rows
}

/**
 * budgetRun — `--budget`: one page, one world, four poses, no pictures.
 *
 * The shape is deliberately unlike the gallery loop. The gallery is a loop over
 * views because a view is a script that has to be walked; the budget is four
 * stances of a settled world, and the page's own `__captureBudget` is the only
 * thing that can take them (it owns the game, the `place` search and the
 * `SIM_DT` step, all of which are page-side by the argument `capture.html`
 * itself makes). So this function's whole job is: serve, open, ask, judge,
 * print, write one JSON file, and never take a screenshot.
 *
 * A budget run is therefore FAST — a few seconds rather than the minutes a
 * fourteen-frame gallery costs — which is the second reason it is worth having
 * as a mode at all. A performance budget nobody re-measures is a budget that
 * stops being true silently, and this one costs less than reading this comment.
 *
 * @param {object} options from `parseArgs`, with `budget: true`
 * @returns {Promise<void>}
 */
async function budgetRun(options) {
  const started = Date.now()
  console.log(`capture: budget -> ${options.report}`)
  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'warn',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  })
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: CHROME_ARGS,
    protocolTimeout: VIEW_TIMEOUT_MS + 30_000,
  })
  const report = {
    tool: 'tools/capture.mjs --budget',
    design: 'GAMEDESIGN.md §16.5 / ITERATION-2-CHECKLIST.md PASS 17',
    module: 'src/game/capture.js',
    seed: 1337,
    mode: 'budget',
    budget: BUDGET,
    poses: BUDGET_POSES.map((pose) => pose.id),
    viewport: { ...CAPTURE_VIEWPORT },
    renderer: null,
    userAgent: null,
    browser: await browser.version(),
    node: process.version,
    started: new Date(started).toISOString(),
    ms: 0,
    measured: [],
    gates: [],
  }
  let exitCode = 0
  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`)
    })
    // The gallery's own viewport, and the reason it is read from `capture.js`
    // rather than typed here: a budget taken at a different resolution than the
    // gallery is a budget of a resolution nobody plays at.
    await page.setViewport({ width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height })
    await page.goto(`${origin}capture.html`, { waitUntil: 'domcontentloaded', timeout: VIEW_TIMEOUT_MS })
    await page.waitForFunction('window.__captureReady === true', { timeout: VIEW_TIMEOUT_MS })
    report.renderer = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      if (!canvas) return 'no canvas: the world never built'
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      if (!gl) return 'no context: this build cannot create WebGL'
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    })
    report.userAgent = await browser.userAgent()
    const measured = await page.evaluate(() => window.__captureBudget())
    report.measured = measured.poses
    await page.close()
    // Rule 1: every pose, or the run is not a run.
    const missing = report.poses.filter((id) => !report.measured.some((pose) => pose.id === id))
    if (missing.length > 0) {
      exitCode = 1
      report.gates.push({
        ceiling: 'poses',
        label: 'poses measured',
        value: report.measured.length,
        pose: null,
        budget: report.poses.length,
        fails: [`missing: ${missing.join(', ')}`],
      })
    } else {
      try {
        report.gates = budgetGates(report.measured)
      } catch (error) {
        exitCode = 1
        report.gateError = String(error.message ?? error)
        console.log(`  FAIL  ${report.gateError}`)
      }
    }
    for (const row of report.gates) {
      if (row.fails.length > 0) exitCode = 1
    }
    for (const message of pageErrors.slice(0, 5)) {
      exitCode = 1
      console.log(`        page: ${message}`)
    }
  } catch (error) {
    exitCode = 1
    report.error = String(error && error.stack ? error.stack : error)
    console.log(`  FAIL  ${report.error}`)
  } finally {
    await browser.close()
    await server.close()
  }
  await writeBudgetReport(report, options, started, exitCode === 0 ? 0 : 1)
  process.exitCode = exitCode
}

/**
 * writeBudgetReport — print the rows, write the JSON, and say the one number
 * that is deliberately not judged.
 *
 * Split out of `budgetRun` so that `budgetRun`'s `try/finally` can be about the
 * browser and nothing else. This half cannot fail: a report that could not be
 * written is a loud error, not a silent one, and every write here is to a path
 * under `.perf/` that `.gitignore` already holds.
 *
 * @param {object} report the assembled report, mutated with `ms`
 * @param {object} options from `parseArgs`
 * @param {number} started `Date.now()` at entry
 * @param {number} exitCode 0 green, 1 red — carried through so the caller keeps
 *   the only assignment of `process.exitCode`
 */
function writeBudgetReport(report, options, started, exitCode) {
  for (const pose of report.measured) {
    const alloc = pose.alloc
      ? `${pose.alloc.bytes} B/frame over ${BUDGET_ALLOC_FRAMES} frames`
      : 'alloc NOT MEASURED'
    console.log(
      `  ${pose.id.padEnd(9)} calls ${String(pose.calls).padStart(4)}/${BUDGET.drawCalls}  ` +
        `tris ${String(pose.triangles).padStart(7)}/${BUDGET.triangles}  ` +
        `programs ${String(pose.programs).padStart(2)}/${BUDGET.programs}  ` +
        `geom ${String(pose.graph.geometries).padStart(3)}/${BUDGET.geometries}  ` +
        `update p50 ${pose.updateMs.p50}ms p95 ${pose.updateMs.p95}ms (/${BUDGET.updateMs})  ` +
        alloc,
    )
    console.log(
      `            graph ${pose.graph.objects} objects (${pose.graph.kinds.instanced} instanced, ` +
        `${pose.graph.kinds.mesh} mesh, ${pose.graph.kinds.points} points, ${pose.graph.kinds.line} line, ` +
        `${pose.graph.kinds.light} lights), ${pose.graph.unculled} unculled, ` +
        `${pose.graph.instances} instances, ${pose.graph.materials} materials, ` +
        `${pose.graph.triangles} triangles resident`,
    )
  }
  for (const row of report.gates) {
    const verdict = row.fails.length === 0 ? 'ok  ' : 'FAIL'
    console.log(
      `  ${verdict}  ${row.label.padEnd(30)} ${row.value} / ${row.budget}` +
        `${row.pose ? ` (worst: ${row.pose})` : ''}`,
    )
    for (const sentence of row.fails) console.log(`          ${sentence}`)
  }
  // The triangle breakdown, once, from the pose with the most of them. Printed
  // on every pose's behalf rather than on one pose's, because the shape of the
  // answer is the same at all four and a reader who wants to diff them has the
  // JSON.
  const heaviestPose = report.measured.reduce(
    (worst, pose) => (pose.graph.triangles > worst.graph.triangles ? pose : worst),
    report.measured[0],
  )
  if (heaviestPose) {
    console.log(`capture: where the triangles are (${heaviestPose.id}, ${heaviestPose.graph.triangles} total)`)
    for (const row of heaviestPose.graph.heaviest) {
      console.log(
        `  ${String(row.triangles).padStart(7)}  ${row.name.padEnd(28)} ` +
          `${String(row.instances).padStart(6)} instance(s) over ${row.objects} object(s)` +
          `${row.unculled ? ', unculled' : ''}`,
      )
    }
  }
  report.ms = Date.now() - started
  const reportPath = fromRepo(options.report)
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`capture: budget done in ${report.ms} ms, report -> ${options.report}`)
  if (report.renderer) console.log(`capture: renderer -> ${report.renderer}`)
  // `renderMs` is printed and NOT judged, on purpose: it is a software
  // rasteriser's number wearing a renderer's name, and the page's own header
  // says so at length. Printing it beside the caveat is more useful than
  // omitting it, because the first thing anybody does with a frame time is go
  // looking for a frame time.
  for (const pose of report.measured) {
    console.log(`capture: ${pose.id} render ${pose.renderMs} ms on SwiftShader (reported, not budgeted)`)
  }
  if (exitCode !== 0) console.log('capture: budget OVER — see the FAIL rows above')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // PASS 17. The budget is a different job in the same harness, and it is
  // branched BEFORE anything gallery-shaped is built — no viewport, no `ids`, no
  // shutter, no luma floor. The gallery loop below is untouched by this pass and
  // its fourteen rows are exactly what they were.
  if (options.budget) return budgetRun(options)
  const ids = idsFor(options)
  const started = Date.now()
  console.log(`capture: ${ids.length} view(s) -> ${options.out}`)

  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'warn',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  })
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  console.log(`capture: dev server ${origin}`)

  const outDir = fromRepo(options.out)
  mkdirSync(outDir, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: CHROME_ARGS,
    protocolTimeout: VIEW_TIMEOUT_MS + 30_000,
  })

  const report = {
    tool: 'tools/capture.mjs',
    design: 'GAMEDESIGN.md §16.5',
    module: 'src/game/capture.js',
    seed: 1337,
    // Which of the two sets of views this run walked. A reader of a report with
    // fourteen rows knows which it is; a reader of a report with twelve rows
    // would otherwise have to guess from the ids whether the gallery was
    // re-taken, half-taken, or replaced by the probe.
    mode: options.probe ? 'probe' : 'gallery',
    // The run's headline floor. Per-view floors are read inside the loop and
    // written into each entry as `minLit`; this is the one every view inherits
    // unless it declares its own, and it is what a reader of the report should
    // assume a frame was measured against.
    lumaFloor: options.probe ? PROBE_MIN_LIT : CAPTURE_MIN_LIT,
    viewport: null,
    renderer: null,
    userAgent: null,
    browser: await browser.version(),
    node: process.version,
    started: new Date(started).toISOString(),
    ms: 0,
    captured: 0,
    failed: 0,
    captures: [],
  }

  let exitCode = 0
  try {
    for (const id of ids) {
      const view = viewById(id)
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]))
      page.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`)
      })
      await page.setViewport({ width: view.viewport.width, height: view.viewport.height })
      // The floor a view is measured against is the street's, except where the
      // view declares its own and says why (see `TITLE_MIN_LIT`). It is read
      // per view rather than once for the run so that an exception cannot
      // spread: a view with no `minLit` is on the same gate as its thirteen
      // neighbours, whatever the others are doing. The probe inherits the same
      // street floor by reference (`PROBE_MIN_LIT` IS `CAPTURE_MIN_LIT`), so a
      // probe frame can never be measured on a different world from the gallery.
      const floor = view.minLit ?? (options.probe ? PROBE_MIN_LIT : CAPTURE_MIN_LIT)
      // `file` is recorded repo-relative on purpose. The report is committed, so
      // an absolute path would publish this machine's checkout layout and stop
      // meaning anything on anyone else's disk. The absolute path is still
      // needed to write the bytes, and that is `target`.
      const target = path.join(outDir, `${id}.png`)
      // REVIEW 15. The probe's row is recorded from the ID, here, rather than inside
      // `measureProbe`. A frame can fail BEFORE `measureProbe` is reached — the luma
      // floor is the ordinary way, and this pass's own second run had two of twelve
      // frames fail it — and a frame that fails there used to reach the row table
      // without a `row` at all, so one dark frame silently removed a row's sample from
      // the count the table is gated over. The row a frame belongs to is a property of
      // its NAME; it should not depend on how far the frame got.
      const probeRow = options.probe ? probeRowOf(id) : null
      const entry = {
        id,
        label: view.label,
        viewport: { ...view.viewport },
        file: path.posix.join(options.out.split(path.sep).join('/'), `${id}.png`),
        minLit: floor,
        ...(probeRow ? { row: probeRow.state, sample: Number(/-(\d+)$/.exec(id)?.[1] ?? 0) } : {}),
      }
      try {
        await page.goto(`${origin}capture.html`, { waitUntil: 'domcontentloaded', timeout: VIEW_TIMEOUT_MS })
        await page.waitForFunction('window.__captureReady === true', { timeout: VIEW_TIMEOUT_MS })
        // the renderer string is the honest answer to "did this actually render"
        if (!report.renderer) {
          report.renderer = await page.evaluate(() => {
            const canvas = document.querySelector('canvas')
            if (!canvas) return 'no canvas: the world never built'
            const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
            if (!gl) return 'no context: this build cannot create WebGL'
            const debug = gl.getExtension('WEBGL_debug_renderer_info')
            return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
          })
          report.userAgent = await browser.userAgent()
          report.viewport = { ...view.viewport }
        }
        const snapshot = await page.evaluate(
          (wanted) => window.__captureRun(wanted),
          id,
        )
        const shot = Buffer.from(await page.screenshot())
        // The frame is measured before it is kept, and the file is only written
        // once it has passed. Screenshotting straight to a path cannot do this:
        // by the time anybody looked at the bytes, a black rectangle was already
        // sitting in the gallery wearing the id of a view it never showed.
        entry.luma = luma(shot)
        if (entry.luma.lit < floor) {
          throw new Error(
            `the frame is too dark to be evidence: ${describeLuma(entry.luma, Number((floor * 100).toFixed(2)))}`,
          )
        }
        // Pass 15. The probe's own gate, in the same place in the loop as the
        // gallery's, and for the same reason: measured before the file is
        // written, so a probe frame that cannot answer its question never
        // becomes a PNG somebody opens.
        //
        // The BASELINE is taken here, in this page, with this figure, at this clock
        // — the one thing a second run of the same steps cannot be. It is held in
        // memory and never written to disk: it is a control, not evidence, and a
        // folder of frames with the creature removed would be thirteen pictures
        // nobody asked for.
        //
        // The world has already been stopped by `__captureRun` (`holdLoop`) and stays
        // stopped across this call, so the control is the frame the creature's own was
        // drawn in and not a later one. The page re-arms the loop exactly once, in
        // `releaseLoop`, at the top of the next run — and this page is closed after
        // this frame, so for the last frame of a set the world simply never starts
        // again.
        if (options.probe) {
          const baseline = await page.evaluate(() => window.__captureBaseline())
          const baselineShot = Buffer.from(await page.screenshot())
          Object.assign(entry, measureProbe(id, shot, snapshot, baselineShot, baseline, entry, { floor, viewport: view.viewport }))
        }
        // Pass 7's floor, and the same shape as the luma one for the same reason:
        // a frame is only written once it has passed, so a gallery can never hold
        // a picture of a street with nothing on the kerb. The measurement comes
        // out of the page, off the camera the PNG was just taken through, rather
        // than out of this file — this file cannot see, and the whole finding was
        // that a gate that cannot see will pass. NOT applied to a probe frame:
        // those stand 17 m down a lamp-lit road on purpose, to put the pool
        // between the lens and the figure, and the furniture floor is a
        // statement about §16.5's fourteen compositions, not about this rig.
        if (options.probe) {
          // recorded, not gated: a probe frame is a lighting measurement, and
          // the furniture count is a statement about a composition
          entry.furniture = snapshot.furniture
        } else {
          entry.furniture = snapshot.furniture
          if (entry.furniture.legible < FURNITURE_MIN_ON_SCREEN || entry.furniture.kinds < FURNITURE_MIN_FAMILIES) {
            throw new Error(
              `the frame is not evidence that the street has furniture on it: ` +
                `${describeSightline(entry.furniture)}, floors ${FURNITURE_MIN_ON_SCREEN} piece(s) and ` +
                `${FURNITURE_MIN_FAMILIES} kind(s) at ${FURNITURE_MIN_LEGIBLE_PX}px`,
            )
          }
        }
        writeFileSync(target, shot)
        entry.status = 'captured'
        entry.state = snapshot
        entry.ms = snapshot.ms
        report.captured += 1
        // The probe prints its own three numbers, because the gallery's line is
        // about a composition and this one is about a contrast ratio: a reader
        // scanning the log wants `ratio 0.61/0.62  eye 233  anchor 4px  shimmer
        // +2.14` on the row, and the furniture count would push it off the end of
        // a terminal. The shimmer is the CORRECTED number, with the band's own
        // movement in brackets, because the corrected one is the claim and the
        // other is the confound it had to be got past.
        console.log(
          options.probe
            ? `  ok    ${id.padEnd(24)} ${String(snapshot.creature).padEnd(9)} ${snapshot.ms} ms  ` +
              `lit ${entry.luma.litPct}% (floor ${(floor * 100).toFixed(2)}%)  ` +
              `ratio ${entry.contrast.ratio.toFixed(3)}/${SILHOUETTE_MAX}  eye ${entry.contrast.eye}  ` +
              `anchor ${entry.anchorDistance}px  shimmer +${entry.shimmer.lift.toFixed(2)} ` +
              `(band ${entry.shimmer.band >= 0 ? '+' : ''}${entry.shimmer.band}, light ${entry.shimmer.spill >= 0 ? '+' : ''}${entry.shimmer.spill})`
            : `  ok    ${id.padEnd(19)} ${snapshot.phase}/${snapshot.creature} ${snapshot.ms} ms  ` +
              `lit ${entry.luma.litPct}% (floor ${(floor * 100).toFixed(2)}%)  ` +
              `furniture ${entry.furniture.legible} piece(s), ${entry.furniture.kinds} kind(s)`,
        )
      } catch (error) {
        entry.status = 'failed'
        entry.error = String(error && error.message ? error.message : error).split('\n')[0]
        entry.pageErrors = pageErrors.slice(0, 5)
        // A failed view must leave nothing behind that a reader could mistake for
        // this run's work. A frame that was too dark to keep is exactly the file
        // most likely to still be sitting there from a previous green run, and it
        // would look like a passing capture to anybody who only opens the folder.
        rmSync(target, { force: true })
        report.failed += 1
        exitCode = 1
        // ...and the MEASUREMENT STAYS. `measureProbe` writes each claim onto the
        // entry as it checks it and then throws, so whatever it got to is still
        // here: the pose, the projected column, the contrast, the boxes and the
        // lift. Pass 15's first run failed six frames and the report held six
        // sentences, which is how the diagnosis took an afternoon instead of a
        // second run. A failure that reports why and not what it measured is a
        // failure that has to be reproduced to be understood.
        console.log(`  FAIL  ${id.padEnd(19)} ${entry.error}`)
        if (options.probe && entry.contrast) {
          console.log(
            `        pose presence ${entry.pose?.presence} eye ${entry.pose?.eye} haze ${entry.pose?.haze}  ` +
              `ratio ${entry.contrast.ratio}  anchor ${entry.anchorDistance ?? '-'}px` +
              (entry.shimmer ? `  shimmer +${entry.shimmer.lift} (band ${entry.shimmer.band}, light ${entry.shimmer.spill})` : ''),
          )
        }
        for (const message of pageErrors.slice(0, 5)) console.log(`        page: ${message}`)
      }
      report.captures.push(entry)
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }

  // The row-level claims, once every sample of every row exists. Outside the
  // `try` and after it, deliberately: a row that lost a sample to a failure has
  // already exited non-zero with the failed frame named, and the row gates here
  // would only restate that in a less useful sentence. What this block owns is
  // the opposite case — every frame present, and the SET still not being true.
  //
  // REVIEW 15. THE CONDITION IS "EVERY SAMPLE IS IN THE RUN", NOT
  // "NOTHING FAILED", and the difference is the whole reason the eye floor is a
  // gate rather than dead code.
  //
  // BEFORE: `report.failed === 0`. The world this pass ships fails its shimmer floor
  // on all twelve frames — the documented, unanswered debt — so that condition was
  // false in every run a person can actually make, and the row table below was
  // never produced: no `probe` key in the report, no per-row eye verdict, and the
  // eye floor this pass claims to enforce enforced nothing. A gate behind a
  // condition no passing run can satisfy is a comment.
  //
  // AFTER: the table is built whenever the run covered the whole probe, over the
  // samples that were MEASURED (`probeGates` names the rest), so a frame that went
  // on to fail a later claim still contributes the eye reading it produced. The
  // shimmer failures keep their own exit code — nothing here can turn a red run
  // green — and a `--only` run says plainly that it is not a whole probe instead of
  // throwing a row-count sentence at someone iterating on one composition.
  if (options.probe) {
    const rows = report.captures.filter((entry) => entry.row)
    if (report.captures.length === CREATURE_PROBE_IDS.length) {
      try {
        report.probe = probeGates(rows)
      } catch (error) {
        exitCode = 1
        report.probeError = String(error.message ?? error)
        console.log(`  FAIL  ${report.probeError}`)
      }
      for (const row of report.probe ?? []) {
        const verdict = row.fails.length === 0 ? 'ok  ' : 'FAIL'
        if (row.fails.length > 0) exitCode = 1
        console.log(
          `  ${verdict}  ${row.state.padEnd(9)} eye ${row.eye.peak}/${row.eye.floor} peak` +
            // the spread is printed, not judged: see `probeGates`. The pure harness
            // gates the beat over a whole period; this is three frames' luck.
            `${row.flickers ? `, observed spread ${row.observedSpread} (floor ${PROBE_FLICKER_SPREAD}, gated in verify.mjs)` : ''}  ` +
            `worst ratio ${row.ratio.worst}/${row.ratio.max} (${row.ratio.id})  shimmer +${row.shimmer.min}..+${row.shimmer.max}` +
            `${row.unmeasured > 0 ? `  [${row.samples} of ${row.samples + row.unmeasured} samples measured]` : ''}`,
        )
        for (const sentence of row.fails) console.log(`          ${sentence}`)
      }
    } else if (rows.length > 0) {
      console.log(
        `capture: probe row gates skipped — ${report.captures.length} of ${CREATURE_PROBE_IDS.length} views in this ` +
          'run, and a row claim is about every sample of every row',
      )
    }
  }

  report.ms = Date.now() - started
  const reportPath = fromRepo(options.report)
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  // The mean of the means, and the darkest frame in the set: the two numbers
  // that tell a reader whether this gallery is a set of photographs of a street.
  //
  // "Darkest" is reported as a *margin* rather than a raw percentage, because the
  // floors are not all the same: the honest question is not "which frame is
  // dimmest" but "which frame came closest to being rejected". A view measured
  // against a lower floor is judged on how close it got to that floor, so the
  // tightest margin in the set is the one number worth printing.
  const measured = report.captures
    .filter((entry) => typeof entry.luma?.litPct === 'number')
    .map((entry) => ({ ...entry, margin: entry.luma.litPct - entry.minLit * 100 }))
  if (measured.length > 0) {
    const mean = measured.reduce((sum, entry) => sum + entry.luma.litPct, 0) / measured.length
    const tightest = measured.reduce((low, entry) => (entry.margin < low.margin ? entry : low))
    report.luma = {
      floor: Number((report.lumaFloor * 100).toFixed(2)),
      mean: Number(mean.toFixed(3)),
      tightest: {
        id: tightest.id,
        litPct: tightest.luma.litPct,
        floor: Number((tightest.minLit * 100).toFixed(2)),
        margin: Number(tightest.margin.toFixed(2)),
      },
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      `capture: lit mean ${report.luma.mean}%, tightest ${tightest.id} at ` +
        `${tightest.luma.litPct}% against a ${(tightest.minLit * 100).toFixed(2)}% floor ` +
        `(+${tightest.margin.toFixed(2)})`,
    )
  }
  console.log(`capture: ${report.captured} captured, ${report.failed} failed, ${report.ms} ms`)
  console.log(`capture: report -> ${options.report}`)
  if (report.renderer) console.log(`capture: renderer -> ${report.renderer}`)
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(`capture: ${error.stack ?? error}`)
  process.exitCode = 1
})
