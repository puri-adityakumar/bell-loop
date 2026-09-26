#!/usr/bin/env node
/**
 * png-luma.mjs — how much light is actually in a PNG, with no dependencies.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A capture set's failure mode is not a missing file. It is a file that exists,
 * is the right size, and shows nothing: twelve of slice 16's fourteen gallery
 * frames came back as `benchmark/screenshots/<id>.png` at 1280x720, all of them
 * reported `captured`, and every one of them was a black rectangle with the HUD
 * on top. Nothing in the harness objected, because "the screenshot was taken" and
 * "the screenshot shows the street" are different claims and only the second one
 * needs looking at.
 *
 * So the photographer measures its own work: the mean luma of the pixels, in
 * 0-255, and refuses to keep a frame under the floor. The number is deliberately
 * crude — a mean over the whole frame, weights borrowed from Rec. 601 — because
 * the thing it has to catch is a frame with no light in it at all, and the
 * cheapest measure of that is the one that cannot be fooled by a bright HUD
 * glyph in the corner. `max` comes along for free and is worth reading next to
 * it: `max: 255, mean: 1.2` is one lamp in a black frame, which is a composition
 * problem, and is a completely different bug from `max: 3`.
 *
 * WHY IT DECODES THE PNG ITSELF
 * -----------------------------
 * The obvious way to read a PNG's pixels is to draw it into a canvas in the
 * browser that is already open and ask. That is a worse answer, not a lazier
 * one: it would measure the image *after* the browser's own colour management,
 * and the number the gate records would then depend on which Chrome is in the
 * Puppeteer cache. Inflating the IDAT stream here means the same bytes give the
 * same luma on any machine, forever, which is the only property a gate value
 * needs.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * Enough of the format to read what a screenshot is: 8-bit, non-interlaced,
 * greyscale / RGB / greyscale+alpha / RGBA. That is everything Chrome's
 * `Page.captureScreenshot` emits. Anything else — 16-bit depth, a palette,
 * interlacing — throws with the header field that disagreed, because silently
 * returning a wrong number to a gate is the one thing this file must not do.
 */
import { deflateSync, inflateSync } from 'node:zlib'

/** The eight bytes every PNG opens with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel, by the IHDR colour type. Index 0 is the type itself. */
const CHANNELS = [1, 0, 3, 0, 2, 0, 4]

/** The Rec. 601 weights as the usual 8-bit integer triple. */
const LUMA_R = 77
const LUMA_G = 150
const LUMA_B = 29

/**
 * The Rec. 601 luma of one decoded pixel, 0-255.
 *
 * Shared by `luma` and `sceneProfile` so the two can never disagree about what
 * a pixel is worth — a gate that measures a frame two different ways is a gate
 * whose two numbers will eventually contradict each other in a comment.
 */
function lumaAt(data, at, channels) {
  if (channels <= 2) {
    // greyscale: the single channel is already the luma
    return data[at]
  }
  return (LUMA_R * data[at] + LUMA_G * data[at + 1] + LUMA_B * data[at + 2]) >> 8
}

/**
 * Where the scene is, as a fraction of frame height.
 *
 * The lower half. The upper half of every frame in this gallery is dusk sky, a
 * house roofline and the HUD, and all three are dark by design — §12.1's lit
 * horizon is a band, not a wash, and the HUD is text. None of them is evidence
 * about whether the street is lit, and averaging them in is what made a whole-
 * frame mean useless as a gate (see `luma`).
 */
const SCENE_TOP = 0.5

/**
 * The luma at which a pixel counts as *lit*, 0-255.
 *
 * 18 rather than a round 16: below this the film grain and the vignette are
 * doing the work, and a grain speck is not a lit road. 18 is above the ~12 the
 * broken frames put on their own unlit asphalt and well under the ~40 a sodium
 * pool lands on, so the measure separates the two populations instead of
 * averaging them together.
 */
export const LIT_LUMA = 18

/** The PNG filter predictor, which is the one piece of arithmetic here. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}


/**
 * decodePng — the raw samples of a PNG, as `{width, height, channels, data}`.
 *
 * `data` is `width * height * channels` bytes, scanline by scanline, already
 * un-filtered. The five filter types are undone here rather than delegated,
 * because a filter is not optional: the bytes in IDAT are differences, and a
 * decoder that skipped this step would report the picture's high-pass and call
 * it luma.
 */
function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the signature is wrong')
  }
  let offset = 8
  let header = null
  const parts = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new Error(`truncated PNG: chunk ${type} runs past the end`)
    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        depth: buffer[start + 8],
        color: buffer[start + 9],
        interlace: buffer[start + 12],
      }
    } else if (type === 'IDAT') {
      parts.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (!header) throw new Error('no IHDR: this is not a PNG we can read')
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth}, expected 8`)
  if (header.interlace !== 0) throw new Error('interlaced PNG, which a screenshot never is')
  const channels = CHANNELS[header.color]
  if (!channels) throw new Error(`unsupported colour type ${header.color}`)

  const raw = inflateSync(Buffer.concat(parts))
  const { width, height } = header
  const stride = width * channels
  const data = Buffer.allocUnsafe(stride * height)
  let prior = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = raw.subarray(cursor, cursor + stride)
    cursor += stride
    const row = data.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0
      const up = prior[x]
      const upLeft = x >= channels ? prior[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      row[x] = value & 0xff
    }
    prior = row
  }
  return { width, height, channels, data }
}

/**
 * luma — what a frame actually shows, as `{lit, litPct, mean, max}`.
 *
 * `lit` is the gate. It is the fraction of *scene* pixels (the lower half of the
 * frame, see `SCENE_TOP`) at or above `LIT_LUMA`, so it answers the one question
 * the gallery exists to answer: is the street lit, over how much of it?
 *
 * WHY THE MEAN IS NOT THE GATE
 * ----------------------------
 * A whole-frame mean was tried first and measured to be useless, which is worth
 * recording because "add a brightness check" obviously seems like it should
 * work. The fourteen frames that shipped broken — black rectangles with the HUD
 * on top — scored a mean of 5.7 to 24.1. A gate cannot be placed above a
 * population that spans a factor of four, and it certainly cannot be placed
 * below it and call itself a gate. The mean fails for a specific reason: §14.3's
 * film grain, vignette and HUD put a floor of about 7.6 under *every* frame, so
 * the mean mostly measures the post-processing, and two of the broken frames
 * (`creature-chasing`, `finale-headlights`) were lifted further by chase
 * vignette and headlight bloom into territory a real lit street never occupies.
 *
 * So `mean` and `max` are still computed and still reported, because a frame
 * with `max: 3` and a frame with `max: 255, lit: 1.4%` are different bugs and
 * the pair tells them apart at a glance — one lamp in a black frame is a
 * composition problem. They are diagnostics. `lit` is the decision.
 *
 * The two populations `lit` separates, measured on the real views:
 *
 *   broken frames          0.8% - 3.1%
 *   the fixed world       13.9% and up
 *
 * which is the property that matters: there is room for a threshold in between
 * that rejects every frame the bug ever produced.
 */
export function luma(buffer) {
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  const firstRow = Math.floor(height * SCENE_TOP)
  let total = 0
  let max = 0
  let lit = 0
  let scene = 0
  for (let y = 0; y < height; y += 1) {
    const inScene = y >= firstRow
    for (let x = 0; x < width; x += 1) {
      const value = lumaAt(data, (y * width + x) * channels, channels)
      total += value
      if (value > max) max = value
      if (inScene) {
        scene += 1
        if (value >= LIT_LUMA) lit += 1
      }
    }
  }
  const pixels = width * height
  return {
    lit: scene > 0 ? lit / scene : 0,
    litPct: scene > 0 ? Number(((lit / scene) * 100).toFixed(2)) : 0,
    mean: Number((total / pixels).toFixed(3)),
    max,
  }
}

/**
 * describeLuma — the gate's own sentence about one frame, in one line.
 *
 * Written here rather than in the caller because there is exactly one right way
 * to say it, and a harness that assembles its own phrasing is a harness whose
 * log lines drift apart from each other.
 */
export function describeLuma(measured, floor) {
  return (
    `${measured.litPct}% of the lower scene at or above luma ${LIT_LUMA}/255 ` +
    `(whole-frame mean ${measured.mean}, max ${measured.max}), floor ${floor}%`
  )
}

/**
 * sceneProfile — the *distribution* of the lower scene, not one number from it.
 *
 * WHY THIS EXISTS, AND IT IS THE REVIEW
 * ------------------------------------
 * `luma` answers "is the street lit?". It cannot answer "is the creature still
 * visible against it?", and that second question is the one a whole-world
 * brightening puts at risk: every pass that lifts the fog also lifts whatever
 * is standing in the fog, and the gate's only evidence that the subject
 * survived was a comment saying it did.
 *
 * A distribution separates the two populations a frame is made of. On a lit
 * sodium street there is a bright mass (the road, the pools) and a dark mass
 * (the creature, the unlit kerb, the vignette), and the claim §12.1 makes is
 * that the dark mass is *darker than the bright one by enough to be a shape*.
 * That is a statement about the gap between two populations, which a mean is
 * structurally incapable of expressing: raising the mean and raising the
 * subject together leaves the mean looking like progress.
 *
 * The percentiles are reported raw rather than as an index, because the useful
 * reading is the pair. On `creature-stalking` the median is the lit road and
 * p0.1 is the creature; the gate asserts on the RATIO, so a pass that lifts the
 * street has to lift the creature by the same factor to stay quiet, and a pass
 * that lifts only the street is caught.
 *
 * SCOPE: the same lower-scene crop as `luma` (see `SCENE_TOP`), for the same
 * reason and no new one — the upper half is sky, roofline and HUD, and none of
 * those is evidence about whether a silhouette reads.
 */
export function sceneProfile(buffer) {
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  const firstRow = Math.floor(height * SCENE_TOP)
  const values = new Uint8Array(width * (height - firstRow))
  let cursor = 0
  for (let y = firstRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[cursor] = lumaAt(data, (y * width + x) * channels, channels)
      cursor += 1
    }
  }
  // 256 buckets, so "sort the scene" is a counting sort over the luma range the
  // format actually has. A Float64Array of a 1280x720 half-frame would also
  // work and would allocate 8x the bytes to learn the same thing.
  const histogram = new Uint32Array(256)
  for (let i = 0; i < values.length; i += 1) histogram[values[i]] += 1
  const total = values.length
  const percentile = (fraction) => {
    if (total === 0) return 0
    const want = Math.min(total - 1, Math.max(0, Math.round(fraction * (total - 1))))
    let seen = 0
    for (let value = 0; value < 256; value += 1) {
      seen += histogram[value]
      if (seen > want) return value
    }
    return 255
  }
  return {
    pixels: total,
    min: percentile(0),
    p0_1: percentile(0.001),
    p1: percentile(0.01),
    p5: percentile(0.05),
    median: percentile(0.5),
    p95: percentile(0.95),
    max: percentile(1),
    at: percentile,
  }
}

export default luma

/**
 * EYE_MIN — the luma at which a blob is the creature's eye and not scenery.
 *
 * §4 promises three things stay readable at distance: the portals, the sodium
 * lamps and the thing hunting you. Only the first two are *fogged*, and the
 * lamps are far larger than an eye, so the eye is separated from both by size
 * as well as by brightness. 150 is measured, not guessed: the stalk eye in
 * `creature-stalking` sits at 227 mean and the chase eye at 223, while the
 * brightest thing anywhere in `street.png` — a lamp head — peaks at 167.
 */
const EYE_MIN = 150
/**
 * The eye quad's own size bounds, in pixels. `CREATURE_COLORS.eye` is a small
 * additive billboard, so a *hit* is a compact blob: 9x8 in the stalk frame,
 * 7x7 in the chase frame. The upper bound is what rejects the lamp heads, which
 * are bright but grow past 14 px as the camera nears them; the lower bound
 * rejects single-pixel specular hits on kerbs and window frames.
 */
const EYE_MAX_SPAN = 14
const EYE_MIN_PIXELS = 4
/**
 * Shape tests, and the reason the eye can be found at all.
 *
 * See `findEyes`. Briefly: an eye quad is a solid billboard, so it FILLS its
 * bounding box and is as wide as it is tall. The bright HUD fragments that share
 * its luma are lines, and fail both. 0.70 and 2 are the measured margins — the
 * two real eyes in the gallery fill 97% and 100% of their boxes and are 1.13
 * and 1.00 aspect, while the nearest HUD impostor fills 100% of a 4x9 box at
 * 0.44 aspect, so the shape test rejects it and the fill test has room to
 * spare.
 */
const EYE_MIN_FILL = 0.7
const EYE_MAX_ASPECT = 2
/**
 * The area floor, in lit pixels. See the AREA note in `findEyes`: it separates
 * the two real eyes (49 and 70 px) from the largest square, solid impostor in
 * the gallery (9 px, a lit window in `hammer-located`).
 */
const EYE_MIN_AREA = 24
/** Rows measured below the eye quad, and the columns either side of it. */
const BODY_ROWS = 22
const SIDE_GAP = 10
const SIDE_REACH = 30

/**
 * Every compact blob at or above `EYE_MIN`, brightest first.
 *
 * 8-connected flood fill over a boolean mask, one pass. The frames are 1280x720
 * and the mask is sparse, so the straightforward version is the fast one here;
 * a union-find or a scanline run would be a second algorithm to keep correct
 * for no measurable gain.
 */
function findEyes(width, height, at) {
  const seen = new Uint8Array(width * height)
  const found = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (seen[start] || at(x, y) < EYE_MIN) continue
      seen[start] = 1
      const stack = [start]
      let minX = width
      let maxX = -1
      let minY = height
      let maxY = -1
      let sum = 0
      let count = 0
      while (stack.length > 0) {
        const key = stack.pop()
        const py = Math.floor(key / width)
        const px = key - py * width
        sum += at(px, py)
        count += 1
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const nx = px + dx
            const ny = py + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            const next = ny * width + nx
            if (!seen[next] && at(nx, ny) >= EYE_MIN) {
              seen[next] = 1
              stack.push(next)
            }
          }
        }
      }
      if (count < EYE_MIN_PIXELS) continue
      if (maxX - minX > EYE_MAX_SPAN || maxY - minY > EYE_MAX_SPAN) continue
      // AREA — the third impostor class, and the one the shape tests cannot see.
      //
      // A lit window in a distant house passes both shape tests: `hammer-located`
      // has one at x934-936, y359-361 that is square and solid. It is 9 px
      // against the real eyes' 49 and 70. The floor is set at 24 px, which is
      // under half the smallest genuine eye in the gallery and over twice the
      // largest impostor, so neither side of the decision is close.
      //
      // The margin exists because `eyeWorldSize` scales the quad with distance,
      // and a *further* creature has a *smaller* eye — so this floor is a claim
      // about the two distances the gallery actually shoots (§6.1's stalk at
      // 17 m and §16.5.8's chase at 9 m), not a claim about all distances. The
      // alternative, dropping the floor and relying on shape alone, was measured
      // and lets windows through; this is the smaller of the two limitations and
      // the one that fails loudly, since a too-distant creature reports no eye
      // and the gate says so rather than measuring the wrong blob.
      if (count < EYE_MIN_AREA) continue
      // FILL AND SHAPE — the two checks that separate a creature's eye from the
      // bright HUD fragments that share its luma.
      //
      // Without them the anchor is not an anchor. Measured over the gallery, the
      // brightest blob in `street.png` is a 36 px HUD element at x593-596,
      // y75-83 — above `SCENE_TOP`, in the sky, and nothing to do with the
      // creature — and `title.png`, `win.png` and `responsive.png` all have
      // similar ones. Each is a *sliver*: 4 wide by 9 tall, or 1 by 8. An eye
      // quad is a billboard, so it is as wide as it is tall and solid across.
      // The two tests are therefore:
      //
      //   FILL: at least 70% of the bounding box is lit. A HUD glyph run and a
      //         window frame are lines, and a line fills a third of its box.
      //   SQUARE: neither side is more than 2x the other. This is the one that
      //         does the real work, because it is scale-free — it holds for a
      //         9x8 eye at 17 m and a 7x7 eye at 9 m alike, while an absolute
      //         width test would only ever be right at one distance.
      //
      // Both are stated against `CREATURE_SHAPE`'s proportions rather than
      // tuned to the two frames that ship, so a creature drawn larger or
      // further off still anchors.
      const spanX = maxX - minX + 1
      const spanY = maxY - minY + 1
      if (count / (spanX * spanY) < EYE_MIN_FILL) continue
      if (spanX > spanY * EYE_MAX_ASPECT || spanY > spanX * EYE_MAX_ASPECT) continue
      found.push({ n: count, minX, maxX, minY, maxY, mean: sum / count })
    }
  }
  found.sort((a, b) => b.mean - a.mean)
  return found
}

/**
 * creatureContrast — is the creature a HOLE in the fog, where "the fog" is the
 * few hundred pixels immediately around it?
 *
 * WHY THE GLOBAL PERCENTILE MEASURE WAS WRONG, AND THIS IS THE REPLACEMENT
 * -----------------------------------------------------------------------
 * The first version of this asserted `p0_1 / median` over the whole lower
 * scene, on the reasoning that the darkest thousandth is the creature and the
 * median is the road it stands on. Both halves of that are false, and the
 * failure is not subtle: measured over the shipped gallery, `street.png` —
 * a frame with NO creature in it at all — scored a ratio of 0.14, *better
 * separation* than `creature-stalking.png` at 0.18. A gate that passes a frame
 * with no subject in it is not a gate.
 *
 * The reason is that those percentiles describe the frame's histogram, not its
 * subject. On this street the histogram is dominated by a huge bright mass (the
 * sodium pools) and a huge dark mass (the vignette, the unlit house fronts, the
 * kerbs). `p0_1` is the darkest 460 px of 460,800, which on this content is
 * the frame's own corners. Lifting the pools lifts the denominator and the
 * ratio falls, whether or not the creature changed at all.
 *
 * So the claim §12.1 actually makes — "a hole in the fog rather than an object
 * in it" — is a statement about a subject and its IMMEDIATE surround, and it
 * has to be measured that way. The creature is located first, by the one mark
 * in the frame that is unambiguously it (the unfogged additive eye quad), and
 * only then are two populations compared:
 *
 *   - the BODY: the column of pixels directly beneath the head, which is the
 *     figure's trunk, and
 *   - the SIDES: the same rows, 10-30 px to either hand, which is whatever the
 *     figure is standing in front of.
 *
 * Those two are adjacent, so they share the fog, the dusk and the grade. A pass
 * that lifts the whole world lifts both and leaves the ratio alone; a pass that
 * lifts the creature alone moves the numerator toward the denominator and is
 * caught. That is the property the percentile version could not have.
 *
 * THE ANCHOR IS LOAD-BEARING
 * --------------------------
 * A ratio needs a subject, and "the darkest blob" is not one — on this content
 * the lamp post, the house fronts and the vignette are all darker than the
 * creature and all of them are bigger. The eye is used instead because
 * `creatureView.js` draws it with `fog: false` and additive blending, which
 * makes it the only mark in a frame that is (a) unfogged, (b) at a fixed
 * brightness regardless of distance, and (c) small. Measured across the whole
 * gallery, only the two frames that are *meant* to contain the creature produce
 * an eye hit at all; `street.png`, `title.png`, `win.png` and `hammer-located`
 * produce none, and a frame with no creature therefore cannot pass this gate no
 * matter what its histogram looks like. That is the check the percentile
 * version was missing, and it is why the anchor is the eye and not a
 * threshold on darkness.
 *
 * @param {Buffer} buffer a PNG, as `luma` and `sceneProfile` take it
 * @returns {{found: boolean, reason?: string, eye?: object, body?: number,
 *   sides?: number, ratio?: number}}
 */
export function creatureContrast(buffer) {
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  const at = (x, y) => lumaAt(data, (y * width + x) * channels, channels)
  // The eye is searched over the WHOLE frame, not the `SCENE_TOP` crop the two
  // other measures use, and deliberately so: a figure at 17 m has its head
  // above the midpoint — the stalk frame's eye is at y=335 of 720 — so the
  // lower-scene crop this module uses everywhere else would cut the subject's
  // head off and find nothing. Searching the whole frame costs a little noise
  // rejection and is the only crop under which the subject is intact.
  const eyes = findEyes(width, height, at)
  if (eyes.length === 0) {
    return {
      found: false,
      reason: 'no eye quad anywhere in the frame — there is no creature in this picture to be a hole',
    }
  }
  const eye = eyes[0]
  const top = eye.maxY + 1
  const bottom = Math.min(height - 1, top + BODY_ROWS)
  if (top >= height) {
    return { found: false, reason: `the eye at y=${eye.minY} has no body below it in the frame`, eye }
  }
  // The body: the head's own column span, rows below it. Averaged rather than
  // thresholded, because a threshold would let the gate pick its own subject —
  // "the pixels dark enough to count" is a moving definition that a brightened
  // world can satisfy by having fewer of them.
  let bodySum = 0
  let bodyCount = 0
  for (let y = top; y <= bottom; y += 1) {
    for (let x = eye.minX; x <= eye.maxX; x += 1) {
      bodySum += at(x, y)
      bodyCount += 1
    }
  }
  // The sides: the same rows, offset either hand. `SIDE_GAP` keeps the body's
  // own antialiased edge out of its own comparison, and `SIDE_REACH` stops the
  // "background" from drifting so far that it is a different part of the world.
  let sideSum = 0
  let sideCount = 0
  for (let y = top; y <= bottom; y += 1) {
    for (let x = eye.minX - SIDE_REACH; x <= eye.minX - SIDE_GAP; x += 1) {
      if (x < 0 || x >= width) continue
      sideSum += at(x, y)
      sideCount += 1
    }
    for (let x = eye.maxX + SIDE_GAP; x <= eye.maxX + SIDE_REACH; x += 1) {
      if (x < 0 || x >= width) continue
      sideSum += at(x, y)
      sideCount += 1
    }
  }
  if (sideCount === 0 || bodyCount === 0) {
    return { found: false, reason: 'the eye is at the frame edge with no room either side to compare against', eye }
  }
  const bodyMean = bodySum / bodyCount
  const sideMean = sideSum / sideCount
  return {
    found: true,
    eye,
    body: bodyMean,
    // The background has to be LIT for a dark figure to be a hole in it rather
    // than a dark shape on a dark wall. §12.1's figure is a silhouette in a
    // sodium street; against an unlit house front there is nothing to be a
    // silhouette *against*, and the ratio alone cannot tell those apart — a
    // black shape on a black wall scores a perfect 0.0.
    sides: sideMean,
    ratio: bodyMean / sideMean,
  }
}

/**
 * One sentence about a `creatureContrast` result, in the house voice.
 *
 * Written here rather than in the caller for the same reason `describeLuma` is:
 * there is exactly one right way to phrase the gate's own evidence, and a
 * harness that assembles its own sentences is a harness whose log lines drift.
 */
export function describeCreatureContrast(measured) {
  if (!measured.found) return `no creature in frame: ${measured.reason}`
  const e = measured.eye
  return (
    `body luma ${measured.body.toFixed(1)} against a local background of ` +
    `${measured.sides.toFixed(1)} (ratio ${measured.ratio.toFixed(2)}), ` +
    `eye ${e.n}px at x${e.minX}-${e.maxX} y${e.minY}-${e.maxY}`
  )
}


// ---------------------------------------------------------------------------
// Writing a PNG back out, which exists for exactly one reason: so the gate can
// be tested against frames where the answer is known by construction.
// ---------------------------------------------------------------------------

/** The CRC-32 table PNG chunk checksums use, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 over a chunk's type and payload, per the PNG specification. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * encodePng — 8-bit RGB, non-interlaced, one filter-0 scanline per row.
 *
 * The narrowest thing that can hold what the mutations below need. It is NOT a
 * general encoder and says so: it re-encodes 8-bit RGB only, which is what
 * `decodePng` accepts and what Chrome emits, and it drops any alpha channel
 * rather than guessing at it. The gate only ever round-trips frames it is
 * about to assert on, so a file that survives `decodePng` survives this.
 */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter type 0: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * repaintBody — a copy of `buffer` with the creature's trunk filled to `luma`.
 *
 * WHY A MUTATOR LIVES IN THE MEASUREMENT MODULE
 * ----------------------------------------------
 * A gate that can only be run against committed PNGs is a gate that is only
 * ever exercised against frames that happen to exist — and the whole reason the
 * creature gate was wrong for a pass is that nobody could tell it was wrong
 * without re-deriving what the creature looks like by hand. So the mutation is
 * built here, next to the decoder and the measure, and the rectangle is derived
 * from `creatureContrast`'s OWN reported eye rather than hard-coded: a hard-coded
 * box is a second copy of "where the creature is", and it is exactly the kind of
 * copy that silently stops matching when the view changes.
 *
 * The eye is deliberately left alone. Repainting it would move the anchor, and
 * the point of these frames is to vary the subject's contrast while holding its
 * position fixed, so that the only thing the measurement can be responding to
 * is how the body compares to what surrounds it.
 *
 * @param {Buffer} buffer a PNG
 * @param {{eye: {minX: number, maxX: number, maxY: number}}} measured the
 *   result of `creatureContrast` on that same PNG
 * @param {number} luma 0-255, the grey the trunk is filled with
 * @returns {Buffer} a new PNG
 */
export function repaintBody(buffer, measured, luma) {
  if (!measured.found) throw new Error('repaintBody needs a frame that actually has a creature in it')
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = data[i * channels]
    rgb[i * 3 + 1] = data[i * channels + 1]
    rgb[i * 3 + 2] = data[i * channels + 2]
  }
  const { eye } = measured
  // The same span `creatureContrast` measures as the body, so the mutation lands
  // on exactly the pixels the gate reads and nowhere else.
  for (let y = eye.maxY + 1; y <= eye.maxY + BODY_ROWS; y += 1) {
    if (y < 0 || y >= height) continue
    for (let x = eye.minX; x <= eye.maxX; x += 1) {
      if (x < 0 || x >= width) continue
      rgb[(y * width + x) * 3] = luma
      rgb[(y * width + x) * 3 + 1] = luma
      rgb[(y * width + x) * 3 + 2] = luma
    }
  }
  return encodePng(width, height, rgb)
}

/**
 * PORTAL_RIM_MIN — the Rec. 601 luma a pixel has to reach to count as rim.
 *
 * The rim is the portal's only fully-saturated surface: `PALETTE.portal` is
 * applied at full strength, so it lands at 185-188 in every capture, while the
 * swirl inside it is an alpha-blended wash that never gets near that. The gap
 * is wide enough that the anchor survives a large change to the swirl itself,
 * which is the property that matters — this threshold has to keep finding the
 * *ring* while the thing the gate measures changes underneath it.
 */
const PORTAL_RIM_MIN = 170

/**
 * The swirl band, as a fraction of the rim radius, and which half of the disc
 * to read.
 *
 * `0.30` is inside both swirl layers (`PORTAL_SWIRL_RADII` is `[0.66, 0.40]`
 * of a 0.72 m core) and `0.62` stops short of the core's own edge so a rim
 * highlight can never leak in and read as swirl.
 *
 * THE UPPER HALF ONLY, and that is not a convenience. The floor apron under a
 * portal is the brightest thing below the disc, it is lit by the same 26 m
 * point light, and it brightens and dims with camera distance. A full annulus
 * measures it, so a full annulus reports a number that partly describes where
 * the photographer stood. The upper half cannot see the floor at all, which
 * makes the measurement a property of the portal alone.
 */
const PORTAL_BAND = Object.freeze({ inner: 0.3, outer: 0.62, upperHalf: true })

/** Enough rim pixels to be a ring and not a stray highlight. */
const RIM_MIN_PIXELS = 1500

/** Enough band pixels for a standard deviation to mean anything. */
const BAND_MIN_PIXELS = 1500

/**
 * swirlContrast — is the light inside the portal a swirl, or a wash?
 *
 * WHAT THIS IS FOR
 * -----------------
 * The complaint behind iteration 2, pass 3 was not that the portal was the
 * wrong shape and not that the wrong thing was being built. The geometry was
 * fine. The swirl *texture* held everything inside the core at a floor of
 * 0.25, so the arms and the gaps between them sat close together and the whole
 * disc averaged out to a single flat cyan field. The rim around it was correct,
 * which is exactly why the frame still looked composed in a thumbnail.
 *
 * So the quantity under test is not brightness, and not brightness *relative
 * to the rim* — a flat disc at full cyan is brighter than a structured one and
 * still washed out. It is the **spread of luma inside the swirl band**. A
 * swirl has dark gaps and bright filaments; a wash has one value everywhere.
 * The standard deviation separates those two cases by more than a factor of
 * 1.7, and it needs no reference level: it rises when structure appears and
 * falls when it is smoothed away, which is also what makes the mutation test
 * meaningful.
 *
 * WHY NOT A PERCENTILE RATIO
 * --------------------------
 * The obvious formula is p95/p05, and it was the one tried first. It is wrong,
 * and the failure is instructive: a portal with a *perfectly flat* core and a
 * near-black pupil measures 8.86:1 on it. The pupil supplies the low percentile
 * and the rim supplies the high one, and everything between them — the only
 * pixels that show whether a swirl exists — goes unexamined. A ratio across the
 * whole annulus rewards exactly the frame that has a hard edge and a dark
 * middle, which is the stale pre-pass-3 render. The band has no such blind
 * spot, because the pupil and the rim are both outside it.
 *
 * HOW IT FINDS THE PORTAL
 * ----------------------
 * Self-locating, from the frame alone: the hot cyan rim's bounding box gives
 * the centre and the radius, and the band is that box scaled by
 * `PORTAL_BAND`. No hard-coded rectangle, because a hard-coded rectangle is a
 * second copy of "where the portal is" and it stops matching silently the
 * first time the camera moves.
 *
 * @param {Buffer} buffer a PNG
 */
export function swirlContrast(buffer) {
  const notFound = (reason) => ({
    found: false,
    reason,
    rim: { minX: 0, maxX: 0, topY: 0 },
    centre: { x: 0, y: 0 },
    radius: 0,
    band: null,
    pupil: 0,
    rimPixels: 0,
  })
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  // `lumaAt` indexes raw bytes, so it needs the channel stride folded in — the
  // same convention `creatureContrast`'s own `at` uses, and the reason this is
  // a one-liner rather than a reimplementation.
  const luma = (x, y) => lumaAt(data, (y * width + x) * channels, channels)
  // Cyan, not just bright. The world has other bright things in it — the sodium
  // lamps are the obvious one — and they are warm, so requiring the blue
  // channel to lead both red and green is what keeps the anchor on the portal
  // rather than on the street lighting.
  const isRim = (x, y) => {
    const i = (y * width + x) * channels
    return (
      data[i + 2] > 60 &&
      data[i + 2] - data[i] > 22 &&
      data[i + 1] - data[i] > 14 &&
      luma(x, y) >= PORTAL_RIM_MIN
    )
  }
  let minX = Infinity
  let maxX = -1
  let topY = Infinity
  let rimPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isRim(x, y)) continue
      rimPixels += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < topY) topY = y
    }
  }
  if (rimPixels < RIM_MIN_PIXELS) {
    return notFound(`only ${rimPixels} hot cyan pixels, needs ${RIM_MIN_PIXELS} to call it a portal`)
  }
  // The rim is a ring seen slightly from below, so its bounding box is wider
  // than it is tall and its bottom edge is cut off by the doorway it stands in.
  // The width is the honest measure of its diameter; the centre sits one radius
  // below the topmost rim pixel, which is where the circle through that pixel
  // has to put its centre.
  const cx = (minX + maxX) / 2
  const R = (maxX - minX) / 2
  const cy = topY + R
  const { inner, outer, upperHalf } = PORTAL_BAND
  const values = []
  for (let y = Math.max(0, Math.floor(cy - R * outer)); y <= Math.min(height - 1, Math.floor(cy + R * outer)); y += 1) {
    if (upperHalf && y > cy) continue
    for (let x = Math.max(0, Math.floor(cx - R * outer)); x <= Math.min(width - 1, Math.floor(cx + R * outer)); x += 1) {
      const d = Math.hypot(x - cx, y - cy) / R
      if (d >= inner && d < outer) values.push(luma(x, y))
    }
  }
  if (values.length < BAND_MIN_PIXELS) {
    return notFound(`the swirl band holds only ${values.length} pixels, needs ${BAND_MIN_PIXELS}`)
  }
  values.sort((a, b) => a - b)
  const at = (f) => values[Math.min(values.length - 1, Math.round(f * (values.length - 1)))]
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
  return {
    found: true,
    reason: '',
    rim: { minX, maxX, topY },
    centre: { x: cx, y: cy },
    radius: R,
    band: {
      n: values.length,
      mean,
      sd: Math.sqrt(variance),
      p10: at(0.1),
      p50: at(0.5),
      p90: at(0.9),
      max: at(1),
    },
    pupil: luma(Math.round(cx), Math.round(cy)),
    rimPixels,
  }
}

/** One line, every number, so a retune starts from the measurement. */
export function describeSwirlContrast(measured) {
  if (!measured.found) return `no portal in frame (${measured.reason})`
  const b = measured.band
  return (
    `swirl band sd ${b.sd.toFixed(1)} (mean ${b.mean.toFixed(1)}, p10 ${b.p10}, p50 ${b.p50}, ` +
    `p90 ${b.p90}, n ${b.n}), pupil luma ${measured.pupil}, rim x ${measured.rim.minX}-${measured.rim.maxX} r ${measured.radius.toFixed(1)}`
  )
}

/**
 * repaintSwirl — a copy of `buffer` with the swirl band washed toward a flat
 * `luma`, by `mix`.
 *
 * The control for the swirl gate, and it exists for the same reason
 * `repaintBody` does: a gate read only against committed PNGs is only ever
 * exercised against frames that happen to exist, and a gate that would have
 * passed the washed-out render is exactly a gate that looks green on the one
 * artifact nobody re-examined.
 *
 * The band is derived from `swirlContrast`'s OWN reported centre and radius, so
 * the mutation lands on precisely the pixels the gate reads. The rim is left
 * completely alone — it is the anchor, and repainting it would move the very
 * thing being held fixed, which is how the creature mutation stays honest and
 * how this one does too.
 *
 * `mix` is what makes this a *monotonic* control rather than an on/off switch.
 * At `mix: 1` the band is perfectly flat and the spread is exactly zero, which
 * only ever exercises one end of the curve. Stepping it down traces the whole
 * path from the real render to a wash, and the sd has to fall along it without
 * a bump — a measure that is not monotone in the amount of structure removed is
 * not measuring structure.
 *
 * @param {Buffer} buffer a PNG
 * @param {ReturnType<typeof swirlContrast>} measured the same PNG, already measured
 * @param {number} luma 0-255, the flat grey the swirl washes toward
 * @param {number} mix 0-1, how far to wash it (1 is perfectly flat)
 * @returns {Buffer} a new PNG
 */
export function repaintSwirl(buffer, measured, luma, mix = 1) {
  if (!measured.found) throw new Error('repaintSwirl needs a frame that actually has a portal in it')
  const { width, height, channels, data } = decodePng(Buffer.from(buffer))
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = data[i * channels]
    rgb[i * 3 + 1] = data[i * channels + 1]
    rgb[i * 3 + 2] = data[i * channels + 2]
  }
  const { centre, radius } = measured
  const { inner, outer, upperHalf } = PORTAL_BAND
  for (let y = Math.max(0, Math.floor(centre.y - radius * outer)); y <= Math.min(height - 1, Math.floor(centre.y + radius * outer)); y += 1) {
    if (upperHalf && y > centre.y) continue
    for (let x = Math.max(0, Math.floor(centre.x - radius * outer)); x <= Math.min(width - 1, Math.floor(centre.x + radius * outer)); x += 1) {
      const d = Math.hypot(x - centre.x, y - centre.y) / radius
      if (d < inner || d >= outer) continue
      // Per channel rather than on the luma, so a pixel blends along the line
      // between its own colour and the grey instead of drifting through a
      // different hue on the way. The gate only reads luma, so this does not
      // change the measured value — it just keeps the intermediate frames
      // honest if anyone opens them.
      for (let c = 0; c < 3; c += 1) {
        rgb[(y * width + x) * 3 + c] = Math.round(rgb[(y * width + x) * 3 + c] * (1 - mix) + luma * mix)
      }
    }
  }
  return encodePng(width, height, rgb)
}
