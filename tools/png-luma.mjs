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
import { inflateSync } from 'node:zlib'

/** The eight bytes every PNG opens with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel, by the IHDR colour type. Index 0 is the type itself. */
const CHANNELS = [1, 0, 3, 0, 2, 0, 4]

/** The Rec. 601 weights as the usual 8-bit integer triple. */
const LUMA_R = 77
const LUMA_G = 150
const LUMA_B = 29

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
      const at = (y * width + x) * channels
      let value
      if (channels <= 2) {
        // greyscale: the single channel is already the luma
        value = data[at]
      } else {
        value = (LUMA_R * data[at] + LUMA_G * data[at + 1] + LUMA_B * data[at + 2]) >> 8
      }
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

export default luma
