#!/usr/bin/env node
/**
 * verify.mjs — node-side assertions over the PURE game modules.
 *
 * The browser game cannot be clicked by a script, so this file proves the parts
 * that are testable headlessly. As of slice 16 it proves the whole of v2:
 *
 *   - the random-access PRNG is deterministic, well distributed and free of
 *     adjacency clustering (§3.2)
 *   - chunks, the wrap and the street graph agree with each other in any
 *     generation order, and across the seam in all four directions (§3.1–§3.2)
 *   - objective anchors are one per district, on lots, fair distances apart,
 *     and the exit is the far edge (§3.4)
 *   - the four fixture rules hold for every chunk, loop and seed (§3.6)
 *   - the portal verb, the breath meter, the capture table and the win test
 *     (§5.2, §7.3, §9.1, §10.1)
 *   - the creature's awareness, sight, state machine, pathing and both ladders
 *     (§6, §7.4, §8, §11.1–§11.3)
 *   - the HUD as a closed, total, colour-blind-safe projection (§14)
 *   - the finale and the win (§10)
 *   - the capture set of §16.5, and that v1 is really gone (slice 16)
 *
 * WHAT WAS DELETED AND WHY IT IS NOT MISSED
 * -----------------------------------------
 * v1's `maze.js` and `loop.js` are gone, and so are the eight sections that only
 * ever tested them (PRNG, solvability, extra carves, shrine zones, wall segments,
 * the loop rules, the store's v1 reducers, and the scripted candle run). Every
 * one of them asserted a claim about a game that no longer exists: a 15x15 perfect
 * maze, three candle shrines, a countdown and a door. None of it is "still true of
 * v2 in another file" — the v2 replacements are the connectivity and fairness
 * checks in slices 02 and 03, and they were written rather than inherited,
 * because the two games have nothing geometric in common. What survives of the
 * store is its contract, which is v2's contract: the unchanged-patch-does-not-
 * notify rule that the HUD mirror's repaint budget is built on.
 *
 * Run: node verify.mjs   (exit code 0 = all green)
 */
import assert from 'node:assert/strict'
// v2 slice 01. `hash32`, `streamAt` and the one `mulberry32` left in the
// repository — v1's `maze.js` carried a second copy and slice 16 deleted it, so
// the alias this import used to need (`mulberry32V2`) is gone with it.
import { flickerAt, hash32, streamAt, mulberry32, DEFAULT_SEED } from './src/game/hash.js'
// v2 slice 02. Imported as a namespace because GRID, BLOCK and the BFS helper
// names all collide with the v2 world modules' own vocabulary, and the v2 world
// reads `hood.*` beside them.
import * as hood from './src/game/neighborhood.js'
// v2 slice 05. Namespace again: `breath`, `portals` and friends are game-state
// names as well as rule names, and flat imports would read ambiguously.
import * as rules from './src/game/rules.js'
// v2 slice 06. Namespace for the same reason, twice over: `state`, `distance`,
// `sounds` and `captured` are all frame fields *and* all rule names, and the
// creature's states would sit next to the PHASE table looking like one thing.
import * as beast from './src/game/creature.js'
// v2 slice 08. The first-person controller. It is in the pure harness because
// slice 08 removed its `three` import, which is the only thing that ever made it
// unimportable here (§15.1 lists it as a pure module). Imported flat: it exports
// exactly one class and no rule names that collide.
import { PlayerController } from './src/game/player.js'
// v2 slice 11. The audio is a *pure* module per §15.1, and the half of it that
// matters to this gate is above the `AudioManager`: the routing table, the three
// bell tunings and the four parameter functions. They are what the checks below
// can read, and they are the reason the webaudio half needed splitting out of the
// decisions in the first place. Imported as a namespace for the same reason as
// `rules` and `beast`: `bellToll`, `reset` and `drone` are all rule names here.
import * as audio from './src/game/audio.js'
// v2 slice 12. The HUD as a pure projection, in `src/ui/hud.js`. Imported as a
// namespace under its own name for the same reason as `rules`, `beast` and
// `audio` — `hud`, `sigil`, `hold` and `clamp01` are all rule names here and
// half of them collide with things already imported flat.
import * as hud from './src/ui/hud.js'
// slice 16. The phase table and the store, which v1's `loop.js` owned and
// `src/game/store.js` now owns. `createStartStore` is here because the world
// harness and `App.jsx` both start from it and the gate is the third reader of
// the same fact: a store that starts somewhere else is a title screen that
// disagrees with the world behind it.
import { createStartStore, createStore, PHASE } from './src/game/store.js'
// slice 16. The §16.5 capture set as data. The harness that photographs it lives
// in `tools/capture.mjs` and the page it drives in `capture/`, and this is the
// one piece of it that is pure — which is what lets the gate assert that the
// gallery is the gallery the design asked for, before anything is rendered.
import * as capture from './src/game/capture.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
// `tools/png-luma.mjs` for the same reason `tools/capture.mjs` uses it: the
// creature-separation gate in "Sodium light (iteration 2, pass 2)" has to
// measure a *rendered* frame, and this is the module that already owns PNG
// decoding and the lower-scene crop. It is imported here rather than
// reimplemented because a second decoder would be a second set of numbers for
// the same file, and the two would eventually disagree in a comment.
import { creatureContrast, describeCreatureContrast, repaintBody, luma, EYE_MIN, EYE_MAX_SPAN, EYE_MIN_AREA, LIT_LUMA } from './tools/png-luma.mjs'
// The swirl-structure gate added in "Portal swirl (iteration 2, pass 3)" measures
// a *rendered* frame for the same reason the creature gate above does, and it is
// imported from the same module so the two can never disagree about what a pixel
// in a committed PNG is worth.
import { swirlContrast, describeSwirlContrast, repaintSwirl } from './tools/png-luma.mjs'

const VERIFY_LOOPS = [1, 2, 3, 4, 5, 6, 7, 8]

const sections = []
let current = null
let passed = 0
let failed = 0

function section(title) {
  current = { title, tests: [] }
  sections.push(current)
}

function test(name, fn) {
  if (!current) section('ungrouped')
  try {
    fn()
    passed += 1
    current.tests.push({ name, ok: true })
  } catch (error) {
    failed += 1
    current.tests.push({ name, ok: false, error: error.message })
  }
}

/** Population count of `a ^ b` — how many of the 32 bits differ. */
function hamming32(a, b) {
  let x = (a ^ b) >>> 0
  let count = 0
  while (x) {
    x &= x - 1
    count += 1
  }
  return count
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// v2 slice 01 — random-access hashing
// ---------------------------------------------------------------------------

section('Random-access hashing (v2 slice 01)')

test('hash32 is reproducible and stays an unsigned 32-bit integer', () => {
  for (let seed = 0; seed < 32; seed++) {
    for (let cx = 0; cx < 8; cx++) {
      for (let cz = 0; cz < 8; cz++) {
        const first = hash32(seed, cx, cz)
        assert.equal(hash32(seed, cx, cz), first, `hash32(${seed},${cx},${cz}) is not reproducible`)
        assert.equal(hash32(seed, cx, cz), first, 'a third call drifted')
        assert.ok(Number.isInteger(first), 'hash32 must return an integer')
        assert.ok(first >= 0 && first <= 0xffffffff, `out of range: ${first}`)
      }
    }
  }
})

test('hash32 is well distributed across both the high and the low bits', () => {
  // A weak mix usually avalanches the top bits and leaves the bottom ones
  // nearly untouched, so both ends get their own bucket test. Uniformity is
  // asserted with a chi-square statistic rather than a hand-tuned per-bucket
  // tolerance: 16 buckets is 15 degrees of freedom, where 30.6 is p < 0.01.
  //
  // Measured against weaker alternatives at this threshold, so the test is not
  // merely passing its own output: the additive hash scores 20.3, the XOR
  // combiner 146.0, a single fmix32 round 112.8, and `seed ^ cx ^ cz` 122880.
  const STRIDES = [1, 7, 13, 101, 4096, 65537]
  const CHI2_LIMIT = 30.6 // 15 df, p < 0.01
  for (const stride of STRIDES) {
    const high = new Array(16).fill(0)
    const low = new Array(16).fill(0)
    let samples = 0
    for (let seed = 0; seed < 8; seed++) {
      for (let cx = 0; cx < 32; cx++) {
        for (let cz = 0; cz < 32; cz++) {
          const h = hash32(seed * stride, cx, cz)
          high[(h >>> 28) & 15] += 1
          low[h & 15] += 1
          samples += 1
        }
      }
    }
    // per stride, not cumulative: each pass is its own 8192-sample experiment
    assert.equal(samples, 8192)
    const expected = samples / 16
    const chiSquare = (buckets) =>
      buckets.reduce((sum, n) => sum + ((n - expected) * (n - expected)) / expected, 0)
    for (const [name, buckets] of [['high', high], ['low', low]]) {
      const stat = chiSquare(buckets)
      assert.ok(
        stat < CHI2_LIMIT,
        `${name} bits are not uniform at stride ${stride}: chi-square ${stat.toFixed(1)} over 15 df`,
      )
    }
  }
})

test('the same (seed, cx, cz) always yields the same stream', () => {
  const coords = [
    [0, 0, 0],
    [1, 3, 4],
    [1337, 6, 6],
    [0xffffffff, 12, 40],
    [-1, -2, -3],
  ]
  for (const [seed, cx, cz] of coords) {
    const a = streamAt(seed, cx, cz)
    const b = streamAt(seed, cx, cz)
    for (let i = 0; i < 1000; i++) {
      const value = a()
      assert.equal(value, b(), `stream ${i} diverged for (${seed},${cx},${cz})`)
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
    }
  }
  // the exported generator is the same one streamAt drives
  const direct = mulberry32(hash32(1337, 6, 6))
  const viaStream = streamAt(1337, 6, 6)
  for (let i = 0; i < 64; i++) assert.equal(direct(), viaStream())
})

test('distinct chunk coordinates yield distinct streams', () => {
  const seen = new Map()
  let checked = 0
  // negative coordinates included: the wrap in §3.3 folds them into range
  for (let seed = 0; seed < 4; seed++) {
    for (let cx = -4; cx < 8; cx++) {
      for (let cz = -4; cz < 8; cz++) {
        const rng = streamAt(seed, cx, cz)
        const signature = Array.from({ length: 6 }, () => rng().toFixed(12)).join(',')
        const key = `${seed}:${cx}:${cz}`
        assert.ok(!seen.has(signature), `collision between ${seen.get(signature)} and ${key}`)
        seen.set(signature, key)
        checked += 1
      }
    }
  }
  assert.equal(checked, 4 * 12 * 12)
  assert.equal(seen.size, checked, 'every coordinate must have its own stream')
})

test('adjacent cx values avalanche instead of clustering', () => {
  // THE test for this slice. A weak mix leaves neighbouring chunks a couple of
  // bits apart, which reads in game as visibly repeating streets down every row.
  // Two independent 32-bit values differ in 16 bits on average.
  const distances = []
  for (let seed = 0; seed < 16; seed++) {
    for (let cz = 0; cz < 16; cz++) {
      for (let cx = 0; cx < 32; cx++) {
        distances.push(hamming32(hash32(seed, cz * 7919, cx), hash32(seed, cz * 7919, cx + 1)))
      }
    }
  }
  const average = mean(distances)
  const closest = Math.min(...distances)
  const farthest = Math.max(...distances)
  assert.equal(distances.length, 16 * 16 * 32)
  assert.ok(average > 12, `adjacent chunks average only ${average.toFixed(2)} bits apart — clustering`)
  assert.ok(average < 20, `adjacent chunks average ${average.toFixed(2)} bits apart — implausibly diffuse`)
  assert.ok(closest >= 4, `the closest adjacent pair is only ${closest} bits apart`)
  assert.ok(farthest <= 28, `the furthest adjacent pair is ${farthest} bits apart`)
})

test('adjacent streams diverge as fast as unrelated streams do', () => {
  // The bit-level test above could pass while the streams themselves stayed
  // correlated, so compare neighbours against a control population of streams
  // that are deliberately far apart. Two independent uniforms differ by 1/3 on
  // average; a clustering hash pulls the adjacent figure under the control.
  const adjacent = []
  const control = []
  for (let cz = 0; cz < 32; cz++) {
    for (let cx = 0; cx < 32; cx++) {
      const here = streamAt(7, cx, cz)
      const next = streamAt(7, cx + 1, cz)
      const far = streamAt(7, cx + 32, cz)
      adjacent.push(Math.abs(here() - next()))
      control.push(Math.abs(here() - far()))
    }
  }
  const adjacentMean = mean(adjacent)
  const controlMean = mean(control)
  assert.ok(controlMean > 0.25 && controlMean < 0.42, `control mean looks wrong: ${controlMean}`)
  assert.ok(
    adjacentMean > controlMean * 0.8,
    `neighbouring streams differ by ${adjacentMean.toFixed(4)} vs control ${controlMean.toFixed(4)} — clustering`,
  )
  assert.ok(
    adjacentMean < controlMean * 1.2,
    `neighbouring streams differ by ${adjacentMean.toFixed(4)} vs control ${controlMean.toFixed(4)} — implausible`,
  )
})

test('chunk streams are independent of the order they are generated in', () => {
  // The property that makes deferred streaming a change to `resolveChunk`
  // instead of a rewrite: nothing is shared between chunks.
  const signature = (seed, cx, cz) => {
    const rng = streamAt(seed, cx, cz)
    return Array.from({ length: 8 }, () => rng().toFixed(12)).join(',')
  }
  const forward = []
  for (let cx = 0; cx < 16; cx++) {
    for (let cz = 0; cz < 16; cz++) forward.push(signature(1337, cx, cz))
  }
  // `forward` is filled cx-outer/cz-inner, so its index is cx * 16 + cz
  const backward = new Array(forward.length)
  for (let cx = 15; cx >= 0; cx--) {
    for (let cz = 15; cz >= 0; cz--) backward[cx * 16 + cz] = signature(1337, cx, cz)
  }
  assert.equal(forward.length, 256)
  assert.equal(new Set(forward).size, 256, 'two chunks shared a stream')
  assert.deepEqual(backward, forward, 'generating chunks in a different order changed their content')

  // and a different seed is a different world rather than a shifted one
  const base = streamAt(1, 0, 0)
  const other = streamAt(2, 0, 0)
  assert.notEqual(base(), other(), 'two seeds produced the same first value')
})

// ---------------------------------------------------------------------------
// v2 slice 02 — chunks, wrap, street graph
// ---------------------------------------------------------------------------

section('Neighborhood chunks + wrap (v2 slice 02)')

test('the slice 02 constants match the design', () => {
  assert.equal(hood.GRID, 7, 'GAMEDESIGN.md §3.1 fixes a 7 x 7 block grid')
  assert.equal(hood.BLOCK, 64, 'GAMEDESIGN.md §3.1 fixes 64 m blocks')
  assert.equal(hood.WORLD_EXTENT, 448)
  assert.equal(hood.WORLD_HALF, 224)
  assert.equal(hood.CHUNKS, 49)
  assert.equal(hood.INTERSECTIONS, 49)
  assert.equal(hood.DISTRICTS, 4)
  assert.equal(hood.SIDE_NAMES.length, 4)
  assert.equal(hood.streetEdgeCount(), 98, '49 nodes x 4 neighbours / 2')
})

test('wrap folds negatives and multiples into range', () => {
  assert.equal(hood.wrap(-1, 7), 6, 'plain % would return -1 here')
  assert.equal(hood.wrap(-7, 7), 0)
  assert.equal(hood.wrap(-8, 7), 6)
  assert.equal(hood.wrap(7, 7), 0)
  for (let v = -50; v <= 50; v++) {
    const folded = hood.wrap(v, 7)
    assert.ok(folded >= 0 && folded < 7, `wrap(${v}, 7) = ${folded} is out of range`)
    assert.equal(hood.wrap(folded, 7), folded, 'wrapping twice must be stable')
    // normalised, because `(0 - 7) % 7` is -0 and assert.strictEqual compares
    // with Object.is, under which -0 and 0 are different values
    assert.equal(
      ((folded - v) % hood.GRID + hood.GRID) % hood.GRID,
      0,
      `wrap(${v}, 7) is not congruent to the input`,
    )
  }
})

test('the same (seed, cx, cz) always yields the same signature', () => {
  const forward = new Array(hood.CHUNKS)
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      forward[cz * hood.GRID + cx] = hood.chunkAt(1337, cx, cz).signature
    }
  }
  // regenerate all 49 in reverse, interleaved with other seeds, so a stream
  // accidentally shared between chunks would show up as drift
  const backward = new Array(hood.CHUNKS)
  for (let cx = hood.GRID - 1; cx >= 0; cx--) {
    for (let cz = hood.GRID - 1; cz >= 0; cz--) {
      hood.chunkAt(999, cx, cz)
      hood.chunkAt(42, cx, 0)
      backward[cz * hood.GRID + cx] = hood.chunkAt(1337, cx, cz).signature
    }
  }
  assert.equal(new Set(forward).size, hood.CHUNKS, 'two chunks in one seed shared a signature')
  assert.deepEqual(backward, forward, 'regenerating a chunk produced different content')
})

test('chunk generation order cannot affect any chunk', () => {
  const reference = new Map()
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) reference.set(`${cx},${cz}`, hood.chunkAt(7, cx, cz).signature)
  }
  // visit every chunk in a stride-5 permutation of the flattened index, twice,
  // so nothing can depend on being generated first
  const order = []
  for (let k = 0; k < hood.CHUNKS; k++) order.push((k * 5) % hood.CHUNKS)
  assert.equal(new Set(order).size, hood.CHUNKS, 'the stride permutation must visit every chunk once')
  for (let pass = 0; pass < 2; pass++) {
    for (const index of order) {
      const cx = Math.floor(index / hood.GRID)
      const cz = index % hood.GRID
      assert.equal(
        hood.chunkAt(7, cx, cz).signature,
        reference.get(`${cx},${cz}`),
        `chunk ${cx},${cz} changed on pass ${pass}`,
      )
    }
  }
})

test('out-of-range coordinates generate deterministically and never depend on wrap state', () => {
  // the same block, reached two ways: the folded parts must agree
  const negative = hood.chunkAt(1337, -1, 5)
  const positive = hood.chunkAt(1337, 6, 5)
  assert.equal(negative.key, positive.key, 'cx = -1 must name the same block as cx = 6')
  assert.equal(negative.district, positive.district)
  assert.deepEqual(negative.corners, positive.corners)
  assert.deepEqual(negative.centre, positive.centre)
  // ...but they are DIFFERENT chunks with different streams. This is the
  // contract that makes deferred streaming a one-line change: when the world
  // stops wrapping, -1 becomes a real chunk beside 0 instead of a copy of it.
  assert.notEqual(negative.signature, positive.signature, 'unfolded coordinates must not share a stream')

  for (const [cx, cz] of [[-1, 5], [-21, -21], [27, 13], [1000000, -1000000], [-99999, 99999]]) {
    assert.equal(
      hood.chunkAt(1337, cx, cz).signature,
      hood.chunkAt(1337, cx, cz).signature,
      `chunk ${cx},${cz} is not reproducible`,
    )
    assert.equal(
      hood.chunkKey(cx, cz),
      hood.chunkKey(cx + hood.GRID, cz - hood.GRID),
      'folding must be periodic in both axes',
    )
  }

  // every coordinate in a wide band folds to the block it names
  for (let cx = -21; cx <= 27; cx++) {
    for (let cz = -21; cz <= 27; cz++) {
      const chunk = hood.chunkAt(1337, cx, cz)
      const key = hood.resolveChunk(cx, cz)
      assert.equal(chunk.key, key.cx * hood.GRID + key.cz, `chunk ${cx},${cz} has the wrong key`)
      assert.equal(chunk.district, hood.districtOf(cx, cz), `chunk ${cx},${cz} is in the wrong district`)
      assert.equal(chunk.cx, cx, 'chunkAt must report the coordinate it was asked for')
      assert.equal(chunk.cz, cz)
    }
  }
})

test('the street graph is connected across the wrap seam in all four directions', () => {
  // the four seam crossings exist as real edges, in both directions, everywhere
  for (let i = 0; i < hood.GRID; i++) {
    const last = hood.streetNodeId(hood.GRID - 1, i)
    const first = hood.streetNodeId(0, i)
    assert.ok(hood.STREET_ADJ[last].includes(first), `no east seam edge on row ${i}`)
    assert.ok(hood.STREET_ADJ[first].includes(last), `no west seam edge on row ${i}`)
    const lastCol = hood.streetNodeId(i, hood.GRID - 1)
    const firstCol = hood.streetNodeId(i, 0)
    assert.ok(hood.STREET_ADJ[lastCol].includes(firstCol), `no south seam edge on column ${i}`)
    assert.ok(hood.STREET_ADJ[firstCol].includes(lastCol), `no north seam edge on column ${i}`)
  }
  // one connected component, from every start. Note this alone does NOT prove
  // the wrap: a plain 7 x 7 grid is 49/49 reachable too. The distance test below
  // is what actually proves it. Both stay, because they fail for different
  // reasons — a missing seam edge breaks this, a missing fold breaks that.
  for (let start = 0; start < hood.INTERSECTIONS; start++) {
    assert.equal(
      hood.reachableIntersections(start).size,
      hood.INTERSECTIONS,
      `node ${start} cannot reach the whole map`,
    )
  }
  // crossing a seam costs exactly one step, in every direction
  const at = (ax, az) => ({ ax, az })
  assert.equal(hood.streetPathLength(at(0, 0), at(6, 0)), 1, 'east seam')
  assert.equal(hood.streetPathLength(at(6, 0), at(0, 0)), 1, 'west seam')
  assert.equal(hood.streetPathLength(at(0, 0), at(0, 6)), 1, 'south seam')
  assert.equal(hood.streetPathLength(at(0, 6), at(0, 0)), 1, 'north seam')
  // a diagonal that needs BOTH seams at once
  assert.equal(hood.streetPathLength(at(6, 6), at(0, 0)), 2, 'both seams')
  assert.equal(hood.streetPathLength(at(0, 0), at(3, 3)), 6, 'opposite corner of the torus')
  assert.equal(hood.hasStreetPath(at(6, 6), at(0, 0)), true)
})

test('the wrap is real: the map is 6 steps across, not 12', () => {
  // An unwrapped 7 x 7 grid is 12 steps corner to corner. A wrapped one is
  // floor(7/2) + floor(7/2) = 6. If the fold ever breaks, this says so — and
  // unlike a visual check, it cannot be missed in a screenshot.
  let worst = 0
  for (let start = 0; start < hood.INTERSECTIONS; start++) {
    const dist = hood.streetDistanceMap(start)
    assert.ok(
      Array.from(dist).every((d) => d >= 0),
      `node ${start} cannot reach part of the map`,
    )
    worst = Math.max(worst, ...dist)
  }
  assert.equal(worst, 6, 'the world is not wrapping — far corners are further apart than the torus allows')
})

test('world and chunk coordinates round trip', () => {
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      const centre = hood.blockCentre(cx, cz)
      const back = hood.chunkAtWorld(centre.x, centre.z)
      assert.equal(back.cx, cx, `block ${cx},${cz} centre resolves to ${back.cx},${back.cz}`)
      assert.equal(back.cz, cz)
      // and so does any point inside the block, which is what the renderer
      // relies on when it works out which chunk a moving player is in
      for (const d of [-hood.BLOCK / 2 + 1, -1, 0, 1, hood.BLOCK / 2 - 1]) {
        const inner = hood.chunkAtWorld(centre.x + d, centre.z + d)
        assert.equal(inner.cx, cx, `point ${d} inside block ${cx},${cz} resolved elsewhere`)
        assert.equal(inner.cz, cz)
      }
    }
  }
  // the unfolded centre of the last block sits exactly one period past the fold
  assert.equal(hood.blockCentre(hood.GRID - 1, hood.GRID - 1).x, hood.WORLD_HALF)
  assert.equal(hood.blockCentre(hood.GRID - 1, hood.GRID - 1).z, hood.WORLD_HALF)
})

test('the BFS helpers agree with each other', () => {
  for (let from = 0; from < hood.INTERSECTIONS; from++) {
    const dist = hood.streetDistanceMap(from)
    const seen = hood.reachableIntersections(from)
    for (let to = 0; to < hood.INTERSECTIONS; to++) {
      const length = hood.streetPathLength(from, to)
      assert.equal(length, dist[to], `pathLength(${from},${to}) disagrees with distanceMap`)
      assert.equal(hood.hasStreetPath(from, to), length >= 0)
      assert.equal(seen.has(to), dist[to] >= 0)
    }
  }
  assert.equal(hood.streetPathLength({ ax: 3, az: 3 }, { ax: 3, az: 3 }), 0, 'a node is zero steps from itself')
  assert.equal(hood.streetNodeId(9, 9), hood.streetNodeId(2, 2), 'node ids must fold')
  assert.deepEqual(hood.streetNodeCoords(hood.streetNodeId(9, 9)), { ax: 2, az: 2 })
  assert.equal(hood.streetEdgeCount(), 98)
})

test('every block fronts streets, and the four districts cover the world', () => {
  const counts = new Array(hood.DISTRICTS).fill(0)
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      const chunk = hood.chunkAt(1337, cx, cz)
      counts[chunk.district] += 1
      assert.equal(chunk.corners.length, 4)
      assert.equal(new Set(chunk.corners).size, 4, `block ${cx},${cz} has a repeated corner`)
      // all four corners reach each other, so every side fronts a real street
      for (const corner of chunk.corners) {
        for (const other of chunk.corners) {
          assert.ok(hood.hasStreetPath(corner, other), `corner ${corner} cannot reach ${other}`)
        }
      }
      // lots sit strictly inside their block — that is what makes the slice 04
      // rule "no fixture on a street cell" easy to state and to assert
      assert.equal(chunk.lots.length, 4)
      for (const lot of chunk.lots) {
        assert.ok(hood.LOT_KINDS.includes(lot.kind), `unknown lot kind ${lot.kind}`)
        assert.ok(lot.tint >= 0 && lot.tint < 4, `tint ${lot.tint} is out of range`)
        assert.ok(
          Math.abs(lot.x - chunk.centre.x) + lot.w / 2 <= hood.BLOCK / 2,
          `lot ${lot.side} pokes outside block ${cx},${cz} on x`,
        )
        assert.ok(
          Math.abs(lot.z - chunk.centre.z) + lot.d / 2 <= hood.BLOCK / 2,
          `lot ${lot.side} pokes outside block ${cx},${cz} on z`,
        )
      }
    }
  }
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    hood.CHUNKS,
    'every block must belong to exactly one district',
  )
  for (let d = 0; d < hood.DISTRICTS; d++) {
    assert.ok(counts[d] > 0, `district ${d} has no blocks`)
  }
})

// ---------------------------------------------------------------------------
// v2 slice 03 — districts and objective anchors
// ---------------------------------------------------------------------------

section('Objective anchors (v2 slice 03)')

/** Closest approach of a world point to any road centreline, in metres. */
function distanceToNearestRoad(x, z) {
  const dx = Math.abs(x / hood.BLOCK - Math.round(x / hood.BLOCK)) * hood.BLOCK
  const dz = Math.abs(z / hood.BLOCK - Math.round(z / hood.BLOCK)) * hood.BLOCK
  return Math.min(dx, dz)
}

test('the slice 03 constants match the design', () => {
  assert.equal(hood.MIN_OBJECTIVE_DISTANCE, 3, '§3.4 keeps objectives a real walk from spawn')
  assert.equal(hood.OBJECTIVE_POOL, 6, '§3.4 caps the nearest-N candidate pool')
  assert.equal(hood.MIN_ANCHOR_SEPARATION, 2, 'no two objectives on adjacent blocks')
  assert.deepEqual([...hood.PORTAL_IDS], ['A', 'B', 'C'])
  assert.deepEqual([...hood.ANCHOR_IDS], ['A', 'B', 'C', 'HAMMER', 'EXIT'])
  // spawn is a fixed point, like v1's ENTRANCE — the distances mean nothing if it moves
  assert.equal(hood.SPAWN.cx, 0)
  assert.equal(hood.SPAWN.cz, 0)
  assert.equal(hood.chunkAtWorld(hood.SPAWN.position.x, hood.SPAWN.position.z).cx, 0)
  assert.equal(hood.districtOf(hood.SPAWN.cx, hood.SPAWN.cz), 0)
})

test('every district hosts exactly one objective, and identity is welded to it', () => {
  assert.equal(Object.keys(hood.OBJECTIVE_DISTRICT).length, 4)
  assert.deepEqual(
    hood.PORTAL_IDS.map((id) => hood.OBJECTIVE_DISTRICT[id]).sort(),
    [0, 1, 2],
    'the three portals take three distinct districts',
  )
  const districts = hood.PORTAL_IDS.map((id) => hood.OBJECTIVE_DISTRICT[id]).concat(hood.OBJECTIVE_DISTRICT.HAMMER)
  assert.equal(new Set(districts).size, 4, 'the four district objectives must be one per district')

  for (let seed = 1; seed <= 64; seed++) {
    const objectives = hood.placeObjectives(seed, 1)
    for (const anchor of [...objectives.portals, objectives.hammer]) {
      assert.equal(
        anchor.district,
        hood.OBJECTIVE_DISTRICT[anchor.id],
        `seed ${seed}: ${anchor.id} is in district ${anchor.district}, expected ${hood.OBJECTIVE_DISTRICT[anchor.id]}`,
      )
      assert.equal(anchor.district, hood.districtOf(anchor.chunk.cx, anchor.chunk.cz))
    }
    assert.equal(objectives.exit.district, null, 'the exit is deliberately not district-allocated')
    // the five objectives never share a block
    assert.equal(new Set(objectives.all.map((a) => a.chunk.cx + ',' + a.chunk.cz)).size, 5)
  }
})

test('every anchor sits on a lot, never on a street', () => {
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      const chunk = hood.chunkAt(seed, anchor.chunk.cx, anchor.chunk.cz)
      const lot = chunk.lots.find((candidate) => candidate.side === anchor.lot.side)
      assert.ok(lot, `seed ${seed}: ${anchor.id} names a lot that does not exist`)
      assert.equal(anchor.position.x, lot.x, `${anchor.id} is not on its lot`)
      assert.equal(anchor.position.z, lot.z)
      // and that lot is strictly inside the block, clear of the road centreline
      assert.ok(
        Math.abs(anchor.position.x - chunk.centre.x) + lot.w / 2 <= hood.BLOCK / 2,
        `${anchor.id} pokes out of its block`,
      )
      assert.ok(
        distanceToNearestRoad(anchor.position.x, anchor.position.z) >= hood.SETBACK,
        `${anchor.id} is on the street, not on a lot`,
      )
    }
  }
})


test('objectives respect the distance floor and the nearest-N pool ceiling', () => {
  const pools = hood.objectiveCandidates()
  assert.equal(pools.length, hood.DISTRICTS)
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      assert.ok(
        anchor.distance >= hood.MIN_OBJECTIVE_DISTANCE,
        `seed ${seed}: ${anchor.id} is ${anchor.distance} steps from spawn, inside the ${hood.MIN_OBJECTIVE_DISTANCE}-step floor`,
      )
      assert.equal(
        anchor.distance,
        hood.blockDistanceFromSpawn(anchor.chunk.cx, anchor.chunk.cz),
        `${anchor.id} reports the wrong distance`,
      )
      // the exit is not district-allocated, so it has no pool to rank within
      if (anchor.kind === 'exit') continue
      // drawn from the nearest-N of its own district's eligible blocks
      const pool = pools[hood.OBJECTIVE_DISTRICT[anchor.id]]
      const rank = pool.findIndex((block) => block.cx === anchor.chunk.cx && block.cz === anchor.chunk.cz)
      assert.ok(rank >= 0, `seed ${seed}: ${anchor.id} is not in its district's candidate pool`)
      assert.ok(
        rank < hood.OBJECTIVE_POOL,
        `seed ${seed}: ${anchor.id} came from rank ${rank}, past the pool of ${hood.OBJECTIVE_POOL}`,
      )
    }
  }
  // eligibility is structural, so the pools are identical every run
  assert.deepEqual(hood.objectiveCandidates(), hood.objectiveCandidates())
  assert.equal(pools.reduce((n, pool) => n + pool.length, 0), 25, '25 of 49 blocks clear the 3-step floor')
})

test('the hammer is separated from every portal by construction', () => {
  for (let seed = 1; seed <= 128; seed++) {
    const objectives = hood.placeObjectives(seed, 1)
    for (const portal of objectives.portals) {
      assert.ok(
        portal.separation >= hood.MIN_ANCHOR_SEPARATION,
        `seed ${seed}: ${portal.id} is only ${portal.separation} blocks from the hammer`,
      )
      assert.equal(
        portal.separation,
        hood.blockCentreDistance(portal.chunk, objectives.hammer.chunk),
        `${portal.id} reports the wrong separation`,
      )
      // concretely: never on a block adjacent to the hammer's block
      const hx = Math.abs(portal.chunk.cx - objectives.hammer.chunk.cx)
      const hz = Math.abs(portal.chunk.cz - objectives.hammer.chunk.cz)
      const dx = Math.min(hx, hood.GRID - hx)
      const dz = Math.min(hz, hood.GRID - hz)
      assert.ok(Math.hypot(dx, dz) >= hood.MIN_ANCHOR_SEPARATION, `seed ${seed}: ${portal.id} sits next to the hammer`)
    }
  }
})

test('the exit is the maximum-distance block, and that block is unique', () => {
  const eligible = hood.objectiveCandidates().flat()
  const furthest = Math.max(...eligible.map((block) => block.distance))
  const atFurthest = eligible.filter((block) => block.distance === furthest)
  // Unique for GRID = 7: the antipodal block. So the exit is a fixed point of the
  // run for the same reason the hammer is, and the §10.3 headlights beacon is a
  // place you can learn rather than re-roll every run.
  assert.equal(atFurthest.length, 1, 'the furthest block is no longer unique — tie-breaking now matters')
  for (let seed = 1; seed <= 64; seed++) {
    const exit = hood.placeObjectives(seed, 1).exit
    assert.equal(exit.chunk.cx, atFurthest[0].cx)
    assert.equal(exit.chunk.cz, atFurthest[0].cz)
    assert.equal(exit.distance, furthest)
    assert.equal(exit.kind, 'exit')
  }
})


test('the hammer anchor signature is byte-identical across loops 1..8', () => {
  // §7.1: the hammer is a fixed point of the RUN, not a fixture. This is the
  // assertion that makes dying unable to erase the goal.
  for (const seed of [1, 7, 42, 1337, 90210]) {
    const reference = hood.placeObjectives(seed, 1)
    for (let loop = 2; loop <= 8; loop++) {
      const objectives = hood.placeObjectives(seed, loop)
      assert.equal(objectives.hammer.signature, reference.hammer.signature, `seed ${seed}: the hammer moved on loop ${loop}`)
      assert.equal(objectives.hammer.chunk.cx, reference.hammer.chunk.cx)
      assert.equal(objectives.hammer.chunk.cz, reference.hammer.chunk.cz)
      assert.equal(objectives.hammer.lot.side, reference.hammer.lot.side)
      // and the whole set is loop-invariant, not just the hammer
      assert.equal(objectives.signature, reference.signature, `seed ${seed}: the objective set changed on loop ${loop}`)
    }
  }
})

test('all five anchors are reachable from spawn', () => {
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      assert.ok(
        hood.blockDistanceFromSpawn(anchor.chunk.cx, anchor.chunk.cz) >= 0,
        `seed ${seed}: ${anchor.id} is unreachable from spawn`,
      )
      // and its own block's corners can actually walk to the spawn corner
      for (const corner of hood.blockCorners(anchor.chunk.cx, anchor.chunk.cz)) {
        const steps = hood.streetPathLength(corner, hood.SPAWN.node)
        assert.ok(steps >= 0, `seed ${seed}: corner ${corner} of ${anchor.id} cannot reach spawn`)
        assert.ok(steps <= 6, `seed ${seed}: ${anchor.id} is ${steps} steps out, past the torus diameter`)
      }
    }
  }
  assert.equal(hood.blockDistance({ cx: 0, cz: 0 }, { cx: 0, cz: 0 }), 0)
  assert.ok(hood.blockDistance({ cx: 0, cz: 0 }, { cx: 3, cz: 3 }) >= 0)
})

test('placement is deterministic per seed and varies between seeds', () => {
  assert.equal(hood.placeObjectives(1337, 1).signature, hood.placeObjectives(1337, 1).signature)
  const signatures = new Set()
  for (let seed = 1; seed <= 64; seed++) signatures.add(hood.placeObjectives(seed, 1).signature)
  assert.equal(signatures.size, 64, 'two seeds produced the same objective layout')
  // the exit being fixed must not drag the rest of the set down with it
  const exits = new Set()
  for (let seed = 1; seed <= 64; seed++) exits.add(hood.placeObjectives(seed, 1).exit.chunk.cx)
  assert.equal(exits.size, 1, 'the exit block should be the fixed antipodal one')
  // a starved pool is a design bug; placeObjectives throws rather than degrade, so
  // a wide seed sweep is the check that the starvation guard never actually fires
  for (let seed = 1; seed <= 300; seed++) {
    assert.equal(hood.placeObjectives(seed, 1).all.length, 5, `seed ${seed} produced the wrong number of objectives`)
  }
})

// ---------------------------------------------------------------------------
// v2 slice 04 — fixtures and the four rules
// ---------------------------------------------------------------------------

section('Fixture pass (v2 slice 04)')

/** 1 m occupancy grid over one block, with structural fixtures solid. */
function blockWalkability(pass, cx, cz) {
  const step = 1
  const centre = hood.blockCentre(cx, cz)
  const n = Math.round(hood.BLOCK / step)
  const originX = centre.x - hood.BLOCK / 2
  const originZ = centre.z - hood.BLOCK / 2
  const solid = new Uint8Array(n * n)
  for (const fixture of pass.fixtures) {
    if (!fixture.collides) continue
    if (fixture.chunk.cx !== cx || fixture.chunk.cz !== cz) continue
    const i0 = Math.max(0, Math.floor((fixture.x - fixture.w / 2 - originX) / step))
    const i1 = Math.min(n - 1, Math.ceil((fixture.x + fixture.w / 2 - originX) / step))
    const j0 = Math.max(0, Math.floor((fixture.z - fixture.d / 2 - originZ) / step))
    const j1 = Math.min(n - 1, Math.ceil((fixture.z + fixture.d / 2 - originZ) / step))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) solid[j * n + i] = 1
    }
  }
  return { n, step, originX, originZ, solid }
}

function cellOf(grid, x, z) {
  return [
    Math.min(grid.n - 1, Math.max(0, Math.floor((x - grid.originX) / grid.step))),
    Math.min(grid.n - 1, Math.max(0, Math.floor((z - grid.originZ) / grid.step))),
  ]
}

/** The outermost cell on the lot's own street frontage — arriving from the road. */
function streetEdgeCell(grid, lot) {
  const c = cellOf(grid, lot.x, lot.z)
  if (lot.side === 'N') return [c[0], 0]
  if (lot.side === 'S') return [c[0], grid.n - 1]
  if (lot.side === 'W') return [0, c[1]]
  return [grid.n - 1, c[1]]
}

/** 4-connected BFS over free cells. */
function walkReaches(grid, from, to) {
  const { n, solid } = grid
  const start = from[1] * n + from[0]
  const goal = to[1] * n + to[0]
  if (solid[start] || solid[goal]) return false
  const seen = new Uint8Array(n * n)
  const queue = [start]
  seen[start] = 1
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur === goal) return true
    const i = cur % n
    const j = (cur - i) / n
    if (i + 1 < n) push(i + 1, j)
    if (i > 0) push(i - 1, j)
    if (j + 1 < n) push(i, j + 1)
    if (j > 0) push(i, j - 1)
  }
  return false

  function push(i, j) {
    const next = j * n + i
    if (seen[next] || solid[next]) return
    seen[next] = 1
    queue.push(next)
  }
}

/** Closest approach of a world point to any road centreline, in metres. */
function roadClearance(x, z) {
  return (
    Math.min(Math.abs(x / hood.BLOCK - Math.round(x / hood.BLOCK)), Math.abs(z / hood.BLOCK - Math.round(z / hood.BLOCK))) *
    hood.BLOCK
  )
}

test('the fixture constants and slot geometry are self-consistent', () => {
  assert.equal(hood.FIXTURE_DENSITY, 0.75)
  assert.equal(hood.SPAWN_CLEARANCE_BLOCKS, 1)
  assert.equal(hood.APPROACH_SLOT, 1)
  // the lot-width limit is derived, so changing BLOCK or SETBACK cannot break it
  assert.equal(hood.LOT_WIDTH, hood.BLOCK - 2 * hood.SETBACK - 2 * hood.LOT_DEPTH)
  // adjacent loops must get unrelated salts, or the world barely changes
  const salts = [1, 2, 3, 4, 5, 6, 7, 8].map((loop) => hood.loopSalt(loop))
  assert.equal(new Set(salts).size, 8, 'two loops share a salt')
  assert.equal(new Set([1, 2].map((loop) => hood.loopSalt(loop))).size, 2)

  const chunk = hood.chunkAt(1337, 0, 0)
  for (const lot of chunk.lots) {
    const slots = hood.lotSlots(lot)
    assert.equal(slots.length, 3)
    assert.equal(slots[hood.APPROACH_SLOT].x, lot.x, 'the approach slot is the lot centre')
    assert.equal(slots[hood.APPROACH_SLOT].z, lot.z)
    // slot spacing must clear the widest fixture, or two hedges collide
    const spacing = Math.abs(slots[2].x - slots[0].x) || Math.abs(slots[2].z - slots[0].z)
    const widest = Math.max(...hood.STRUCTURAL_KINDS.map((spec) => Math.max(spec.w, spec.d)))
    assert.ok(spacing > widest, `slot spacing ${spacing.toFixed(2)}m does not clear a ${widest}m fixture`)
    // and the approach corridor really contains the middle slot
    const approach = hood.lotApproach(lot)
    assert.ok(hood.rectsOverlap({ x0: slots[1].x - 0.1, x1: slots[1].x + 0.1, z0: slots[1].z - 0.1, z1: slots[1].z + 0.1 }, approach))
  }
})

test('the pass is deterministic per (seed, loop, chunk)', () => {
  assert.equal(hood.fixturePass(1337, 3).signature, hood.fixturePass(1337, 3).signature)
  const first = hood.fixturePass(42, 2)
  // regenerate every chunk in reverse, interleaved with other seeds and loops
  const second = []
  for (let cx = hood.GRID - 1; cx >= 0; cx--) {
    for (let cz = hood.GRID - 1; cz >= 0; cz--) {
      hood.fixturePass(999, 1)
      hood.fixturePass(42, 7)
      second.push(...hood.chunkFixtures(42, 2, cx, cz, first.reserved))
    }
  }
  // compared in a canonical order, because the rebuild visits chunks backwards
  // and the two lists are otherwise the same fixtures in a different order
  const byId = (list) => list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rebuilt = byId(second)
  assert.equal(rebuilt.length, first.fixtures.length, 'the rebuilt pass has a different fixture count')
  assert.equal(rebuilt[0].id, byId(first.fixtures)[0].id)
  assert.equal(
    rebuilt.map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`).join('|'),
    byId(first.fixtures).map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`).join('|'),
    'regenerating a chunk in a different order changed its fixtures',
  )
  assert.equal(hood.fixturePass(42, 2).signature, first.signature)
})


test('rule 1: no fixture ever occupies a street cell', () => {
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    assert.ok(pass.fixtures.length > 200, `loop ${loop} dressed only ${pass.fixtures.length} fixtures`)
    for (const fixture of pass.fixtures) {
      const centre = hood.blockCentre(fixture.chunk.cx, fixture.chunk.cz)
      // strictly inside its own block...
      assert.ok(
        Math.abs(fixture.x - centre.x) + fixture.w / 2 <= hood.BLOCK / 2 + 1e-9,
        `loop ${loop}: ${fixture.id} pokes out of its block on x`,
      )
      assert.ok(
        Math.abs(fixture.z - centre.z) + fixture.d / 2 <= hood.BLOCK / 2 + 1e-9,
        `loop ${loop}: ${fixture.id} pokes out of its block on z`,
      )
      // ...and clear of the carriageway on every side it touches
      assert.ok(
        roadClearance(fixture.x, fixture.z) - Math.max(fixture.w, fixture.d) / 2 >= hood.STREET_HALF_WIDTH,
        `loop ${loop}: ${fixture.id} stands in the road`,
      )
    }
  }
})

test('rule 2: reserved anchors and the spawn clearance stay clear', () => {
  const pass = hood.fixturePass(1337, 1)
  // 9 clearance blocks x 4 lots, plus one lot per objective, none overlapping
  assert.equal(pass.reserved.size, 41)
  let clearanceBlocks = 0
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) if (hood.inSpawnClearance(cx, cz)) clearanceBlocks++
  }
  assert.equal(clearanceBlocks, 9, 'the spawn clearance is the wrong size')

  for (let loop = 1; loop <= 8; loop++) {
    const current = hood.fixturePass(1337, loop)
    // the spawn block itself is always protected (rule 4: never spawn on you)
    assert.ok(current.reserved.has('0,0,N'))
    for (const fixture of current.fixtures) {
      const key = `${fixture.chunk.cx},${fixture.chunk.cz},${fixture.lot}`
      assert.ok(!current.reserved.has(key), `loop ${loop}: fixture ${fixture.id} is on a reserved lot`)
    }
    // and the five objective lots stay reserved in every loop, because anchors do
    // not move (§7.1) while fixtures do
    for (const anchor of current.objectives.all) {
      assert.ok(
        current.reserved.has(`${anchor.chunk.cx},${anchor.chunk.cz},${anchor.lot.side}`),
        `loop ${loop}: ${anchor.id}'s lot is not reserved`,
      )
    }
  }
})

test('rule 3: a walk from the street reaches every anchor, loops 1..8', () => {
  // BFS rather than a rectangle overlap, so a fixture anywhere on the route is
  // caught — not only one sitting on the anchor's own lot
  let checked = 0
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    for (const anchor of pass.objectives.all) {
      const grid = blockWalkability(pass, anchor.chunk.cx, anchor.chunk.cz)
      const lot = hood.chunkAt(1337, anchor.chunk.cx, anchor.chunk.cz).lots.find((l) => l.side === anchor.lot.side)
      const from = streetEdgeCell(grid, lot)
      const to = cellOf(grid, anchor.position.x, anchor.position.z)
      assert.ok(
        walkReaches(grid, from, to),
        `loop ${loop}: ${anchor.id} at ${anchor.chunk.cx},${anchor.chunk.cz} is walled off from the street`,
      )
      checked += 1
    }
  }
  assert.equal(checked, 40, 'five anchors across eight loops')
})


test('the two fixture classes never leak into each other', () => {
  const structural = new Map(hood.STRUCTURAL_KINDS.map((spec) => [spec.kind, spec]))
  const decorative = new Map(hood.DECORATIVE_KINDS.map((spec) => [spec.kind, spec]))
  assert.equal(new Set([...structural.keys(), ...decorative.keys()]).size, 9, 'a kind appears in both classes')
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    let solid = 0
    let ghost = 0
    for (const fixture of pass.fixtures) {
      if (fixture.cls === 'structural') {
        assert.ok(structural.has(fixture.kind), `${fixture.kind} is not a structural kind`)
        assert.equal(fixture.collides, true, `${fixture.kind} must collide`)
        solid += 1
      } else {
        assert.equal(fixture.cls, 'decorative')
        assert.ok(decorative.has(fixture.kind), `${fixture.kind} is not a decorative kind`)
        assert.equal(fixture.collides, false, `${fixture.kind} must not collide`)
        ghost += 1
      }
      assert.ok(fixture.w > 0 && fixture.d > 0, `${fixture.id} has no footprint`)
      assert.equal(fixture.loop, loop, 'a fixture carries the wrong loop')
    }
    assert.ok(solid > 50, `loop ${loop} had only ${solid} structural fixtures`)
    assert.ok(ghost > 50, `loop ${loop} had only ${ghost} decorative fixtures`)
  }
})

test('the pass changes between loops, including adjacent ones', () => {
  const signatures = []
  for (let loop = 1; loop <= 8; loop++) signatures.push(hood.fixturePass(1337, loop).signature)
  assert.equal(new Set(signatures).size, 8, 'two loops produced the same layout')
  for (let loop = 2; loop <= 8; loop++) {
    assert.notEqual(signatures[loop - 1], signatures[loop - 2], `loops ${loop - 1} and ${loop} are identical`)
  }
  // and they change substantially, not just by one prop. Measured churn between
  // adjacent loops runs about 90%, so 50% is a floor that still means "rebuilt".
  const describe = (pass) => pass.fixtures.map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`)
  for (const seed of [1, 1337, 90210]) {
    for (let loop = 2; loop <= 8; loop++) {
      const before = new Set(describe(hood.fixturePass(seed, loop - 1)))
      const after = describe(hood.fixturePass(seed, loop))
      const changed = after.filter((entry) => !before.has(entry)).length
      assert.ok(changed / after.length > 0.5, `seed ${seed} loop ${loop}: only ${changed}/${after.length} fixtures changed`)
    }
  }
})

test('fixtures never overlap each other', () => {
  // Regression guard. Slice 02's lots were 46 m wide on a 64 m block, so all four
  // adjacent pairs shared 400 m² and fixtures on neighbouring lots could land
  // inside one another — 21 of 2814 did, across 8 seeds and 8 loops.
  const footprint = (fixture) => ({
    x0: fixture.x - fixture.w / 2,
    x1: fixture.x + fixture.w / 2,
    z0: fixture.z - fixture.d / 2,
    z1: fixture.z + fixture.d / 2,
  })
  let total = 0
  const collisions = []
  for (const seed of [1, 7, 1337]) {
    for (let loop = 1; loop <= 8; loop++) {
      const pass = hood.fixturePass(seed, loop)
      for (let i = 0; i < pass.fixtures.length; i++) {
        for (let j = i + 1; j < pass.fixtures.length; j++) {
          if (hood.rectsOverlap(footprint(pass.fixtures[i]), footprint(pass.fixtures[j]))) {
            collisions.push(`seed ${seed} loop ${loop}: ${pass.fixtures[i].id} overlaps ${pass.fixtures[j].id}`)
          }
        }
      }
      total += pass.fixtures.length
    }
  }
  // collected rather than asserted inline: the message is built per pair, and
  // there are well over a million of them
  assert.deepEqual(collisions.slice(0, 5), [], `${collisions.length} fixtures overlap something else`)
  assert.equal(collisions.length, 0)
  assert.ok(total > 2000, `only ${total} fixtures were overlap-checked`)
})

// ---------------------------------------------------------------------------
// v2 slice 05 — portal verb, breath, persistence
// ---------------------------------------------------------------------------

section('Portal verb, breath, persistence (v2 slice 05)')

const DT = 1 / 60

test('the slice 05 constants match the design', () => {
  assert.equal(rules.PORTAL_SHUT_SECONDS, 1.2)
  assert.equal(rules.PORTAL_NOISE_THRESHOLD, 0.5, '§5.2: silent first half, loud second half')
  assert.equal(rules.PORTAL_SOUND_RADIUS, 25, '§6.2: second loudest thing in the game')
  assert.equal(rules.EXIT_WIN_RADIUS, 1.15, 'must match v1 DOOR_WIN_RADIUS')
  assert.ok(rules.BREATH_RECOVERY_THRESHOLD > 0, 'hysteresis needs a threshold above zero')
  assert.ok(rules.BREATH_RECOVERY_THRESHOLD < 1, 'a threshold of 1 would never lift')
  assert.ok(rules.BREATH_DRAIN_PER_SEC > rules.BREATH_RECOVER_PER_SEC, 'recovery must be slower than drain')
})

test('the portal hold is silent below the midpoint and loud above it', () => {
  let progress = 0
  let firstLoud = null
  let frames = 0
  for (; frames < 600 && progress < 1; frames++) {
    const result = rules.portalShutProgress(progress, DT, true)
    // the invariant, asserted every single frame rather than at one sample
    assert.equal(
      result.soundEmitted,
      result.progress >= rules.PORTAL_NOISE_THRESHOLD,
      `frame ${frames}: sound ${result.soundEmitted} at progress ${result.progress}`,
    )
    if (result.soundEmitted && firstLoud === null) firstLoud = result.progress
    progress = result.progress
  }
  assert.equal(progress, 1, 'the hold never completed')
  assert.ok(firstLoud >= rules.PORTAL_NOISE_THRESHOLD, 'the shutdown was audible before the midpoint')
  // and it is genuinely silent for a real stretch of time first
  const quietSeconds = (rules.PORTAL_SHUT_SECONDS * rules.PORTAL_NOISE_THRESHOLD)
  assert.ok(quietSeconds > 0.5, 'the silent half is too short to be a decision')
  // the first half is committed silence, so a creature arriving there is free
  assert.equal(rules.portalShutProgress(0, DT * 10, true).soundEmitted, false)
})

test('the portal hold clamps at exactly 1.0 and completes on one frame only', () => {
  let progress = 0
  let completions = 0
  for (let i = 0; i < 600; i++) {
    const result = rules.portalShutProgress(progress, DT, true)
    if (result.completed) completions += 1
    assert.ok(result.progress <= 1, `progress overshot to ${result.progress}`)
    assert.ok(result.progress >= 0, 'progress went negative')
    progress = result.progress
  }
  assert.equal(progress, 1, 'progress should saturate at exactly 1')
  assert.equal(completions, 1, `a held portal completed ${completions} times`)
  // a single huge timestep must not skip past the threshold silently
  const jump = rules.portalShutProgress(0, 99, true)
  assert.equal(jump.progress, 1)
  assert.equal(jump.completed, true)
  assert.equal(jump.soundEmitted, true)
})

test('releasing the hold decays progress and stops the sound', () => {
  const before = rules.portalShutProgress(0.8, DT, true)
  assert.equal(before.soundEmitted, true, '0.8 should be loud')
  const after = rules.portalShutProgress(before.progress, DT, false)
  assert.ok(after.progress < before.progress, 'releasing must decay progress')
  assert.equal(after.soundEmitted, false, 'releasing must stop the noise immediately')
  assert.equal(after.completed, false)
  // aborting is free: it bleeds to nothing and never completes
  let progress = 0.8
  for (let i = 0; i < 600; i++) {
    const result = rules.portalShutProgress(progress, DT, false)
    assert.equal(result.completed, false, 'an abandoned hold completed a portal')
    progress = result.progress
  }
  assert.equal(progress, 0, 'progress should bleed all the way back to zero')
  // and decay is faster than the fill, so re-committing is responsive
  assert.ok(rules.PORTAL_RELEASE_DECAY > 1, 'decay should outrun the fill')
})


test('breath drains monotonically, recovers, and locks out with hysteresis', () => {
  let breath = 1
  let exhausted = false
  let previous = breath
  for (let i = 0; i < 600 && !exhausted; i++) {
    const result = rules.breathStep(breath, exhausted, true, DT)
    assert.ok(result.breath <= previous, `breath rose while sprinting: ${previous} -> ${result.breath}`)
    previous = result.breath
    breath = result.breath
    exhausted = result.exhausted
  }
  assert.equal(exhausted, true, 'sprinting forever never exhausted the player')
  assert.equal(breath, 0, 'exhaustion should land exactly on zero')

  // the lockout lifts at the threshold, not at zero, and NOT while sprinting.
  // Compared against the POST-step value, since that is what the rule inspects.
  let frames = 0
  while (exhausted && frames < 600) {
    const result = rules.breathStep(breath, exhausted, true, DT) // sprint key still down
    assert.equal(
      result.exhausted,
      result.breath < rules.BREATH_RECOVERY_THRESHOLD,
      `lockout disagrees with the threshold at breath ${result.breath}`,
    )
    breath = result.breath
    exhausted = result.exhausted
    frames += 1
  }
  assert.equal(exhausted, false, 'the lockout never lifted')
  assert.ok(breath >= rules.BREATH_RECOVERY_THRESHOLD, `lockout lifted at breath ${breath}`)

  // recovery: walking refills, and never past full
  let walking = breath
  for (let i = 0; i < 3000; i++) {
    const result = rules.breathStep(walking, false, false, DT)
    assert.ok(result.breath >= walking, 'breath fell while walking')
    assert.ok(result.breath <= 1, `breath overfilled to ${result.breath}`)
    walking = result.breath
  }
  assert.equal(walking, 1, 'breath should refill to full')

  // THE hysteresis case. Bobbing means mashing the sprint key on and off, not
  // resting: while locked out the key must be IGNORED, so the meter can never
  // dip. Without the lockout the flag would flicker every frame and the player
  // would get an infinite sprint out of two alternating inputs.
  // ...and bobbing must not PREVENT recovery either: the lockout still lifts
  // once the threshold is reached, roughly on schedule. Measured from where the
  // meter actually starts, which is just under the threshold, not from zero.
  const BOB_START = 0.34
  let bobBreath = BOB_START
  let bobExhausted = true
  let everDipped = false
  let liftedAt = null
  for (let i = 0; i < 120; i++) {
    const wasExhausted = bobExhausted
    const result = rules.breathStep(bobBreath, bobExhausted, i % 2 === 0, DT)
    // only a step that BEGAN locked out is allowed to prove the point; once the
    // lockout legitimately lifts, sprinting drains again and a dip is correct
    if (wasExhausted && result.breath < bobBreath) everDipped = true
    if (wasExhausted && !result.exhausted && liftedAt === null) liftedAt = i
    bobBreath = result.breath
    bobExhausted = result.exhausted
  }
  assert.equal(everDipped, false, 'bobbing the sprint key drained breath while locked out')
  assert.ok(liftedAt !== null, 'bobbing the sprint key kept the player locked out forever')
  const framesToLift = (rules.BREATH_RECOVERY_THRESHOLD - BOB_START) / rules.BREATH_RECOVER_PER_SEC / DT
  assert.ok(
    Math.abs(liftedAt - framesToLift) < 2,
    `lockout lifted at frame ${liftedAt}, expected about ${Math.round(framesToLift)}`,
  )

  // and the lockout has a floor: it lasts exactly as long as it takes to reach
  // the threshold, not one frame
  let lockBreath = 0
  let lockExhausted = true
  let elapsed = 0
  while (lockExhausted && elapsed < 100) {
    const result = rules.breathStep(lockBreath, lockExhausted, true, DT)
    lockBreath = result.breath
    lockExhausted = result.exhausted
    elapsed += DT
  }
  const expected = rules.BREATH_RECOVERY_THRESHOLD / rules.BREATH_RECOVER_PER_SEC
  assert.ok(
    Math.abs(elapsed - expected) < DT * 2,
    `lockout lasted ${elapsed.toFixed(3)}s, expected about ${expected.toFixed(3)}s`,
  )
})

test('exhaustion makes you louder', () => {
  // §7.3: the rule is not "sprinting costs stamina", it is that being out of
  // breath raises your sound radius
  assert.equal(rules.breathSoundRadius(9, false), 9, 'walking is 9 m (§6.2)')
  assert.equal(rules.breathSoundRadius(22, false), 22, 'sprinting is 22 m (§6.2)')
  assert.equal(rules.breathSoundRadius(9, true), 9 + rules.EXHAUSTED_BREATH_SOUND_BONUS)
  assert.equal(rules.EXHAUSTED_BREATH_SOUND_BONUS, 6)
  // Exhausted sprinting is 28 m: louder than a portal shutdown (25) and louder
  // than walking (9), but the hammer toll is still 30 and still the loudest
  // thing in the game. That ordering is the point - being spent is a liability,
  // but the hammer stays the player's own weapon.
  assert.equal(rules.breathSoundRadius(22, true), 28)
  assert.ok(rules.breathSoundRadius(22, true) > rules.PORTAL_SOUND_RADIUS, 'exhaustion should out-shout a portal')
  assert.ok(rules.breathSoundRadius(22, true) < 30, 'exhaustion must not out-shout the hammer toll (§6.2)')
  assert.ok(rules.breathSoundRadius(9, true) > rules.breathSoundRadius(9, false))
})


test('every row of the capture table behaves as §9.1 says', () => {
  assert.equal(rules.CAPTURE_TABLE.length, 10)
  const keep = rules.CAPTURE_TABLE.filter((row) => row.mutation === 'keep').map((row) => row.field)
  assert.deepEqual(keep, ['portals', 'hammerHeld', 'banishCount', 'finale', 'dusk'])

  // a state where every field is deliberately at a non-default value
  const dirty = {
    portals: { A: true, B: true, C: false },
    hammerHeld: true,
    banishCount: 3,
    finale: true,
    dusk: 0.66,
    loop: 5,
    player: { x: 500, z: 500 },
    prompt: 'shutdown',
    creature: { state: 'chase', reemergenceCount: 4, awareness: 0.8 },
    sounds: [{ radius: 9 }],
  }
  for (const row of rules.CAPTURE_TABLE) {
    assert.ok(row.field in dirty, `the table mentions ${row.field}, which the test does not dirty`)
  }

  const before = { ...rules.createInitialState(hood.placeObjectives(1337, 1)), ...dirty }
  const after = rules.applyCapture(before)

  for (const row of rules.CAPTURE_TABLE) {
    const from = rules.readField(before, row.field)
    const to = rules.readField(after, row.field)
    if (row.mutation === 'keep') {
      assert.equal(JSON.stringify(to), JSON.stringify(from), `${row.field} should survive a capture`)
    } else if (row.mutation === 'increment') {
      assert.equal(to, from + 1, `${row.field} should increment by one`)
    } else {
      assert.notEqual(JSON.stringify(to), JSON.stringify(from), `${row.field} should reset on capture`)
    }
  }
  // the two named consequences, spelled out because they are the whole point
  assert.equal(after.player.x, hood.SPAWN.position.x, 'the player must be returned to spawn')
  assert.equal(after.player.z, hood.SPAWN.position.z)
  assert.equal(after.creature.state, 'stalk', 'a player holding the hammer returns to STALK')
  assert.equal(after.creature.reemergenceCount, 0, 'the aggression ladder restarts')
  // and the table is frozen, so a caller cannot quietly rewrite the rules
  assert.equal(Object.isFrozen(rules.CAPTURE_TABLE), true)
})

test('a shut portal ignores the verb and stays shut across a capture', () => {
  let state = rules.createInitialState(hood.placeObjectives(1337, 1))
  for (let i = 0; i < 200 && !state.portals.A; i++) state = rules.applyPortalHold(state, 'A', DT, true)
  assert.equal(state.portals.A, true, 'holding never shut portal A')

  // holding it again changes nothing at all — no double completion, no progress
  const held = rules.applyPortalHold(state, 'A', DT, true)
  assert.equal(held, state, 'a dead portal was not inert')
  assert.ok(held.progress.A > 0, 'a shut portal lost its progress')
  assert.deepEqual(rules.portalShutProgress(0.4, DT, true, true), {
    progress: 1,
    soundEmitted: false,
    completed: false,
  })
  assert.equal(rules.applyPortalHold(state, 'Z', DT, true), state, 'an unknown portal id was invented')

  // permanence: A survives any number of captures (§5.3). This run started fresh,
  // so loop 1 plus five captures is loop 6 and only portal A is shut.
  for (let i = 0; i < 5; i++) state = rules.applyCapture(state)
  assert.equal(state.portals.A, true, 'a shut portal was undone by dying')
  assert.equal(state.portals.B, false, 'an untouched portal was shut for free')
  assert.equal(state.loop, 6, 'five captures from loop 1 is loop 6')
  assert.equal(state.dusk, 1 / 3, 'dusk followed the progress, not the deaths')
  assert.equal(state.hammerHeld, false, 'the hammer was never picked up in this run')
  assert.equal(state.banishCount, 0, 'nothing was banished in this run')
  assert.equal(state.finale, false, 'the finale is not open after one portal')
})

test('the third portal opens the finale, and only the third', () => {
  let state = rules.createInitialState(hood.placeObjectives(42, 1))
  for (const id of ['A', 'B']) {
    for (let i = 0; i < 200 && !state.portals[id]; i++) state = rules.applyPortalHold(state, id, DT, true)
    assert.equal(state.portals[id], true, `portal ${id} did not shut`)
    assert.equal(state.finale, false, `the finale opened on portal ${id}`)
    assert.equal(state.dusk, rules.portalsShut(state.portals) / 3)
  }
  for (let i = 0; i < 200 && !state.portals.C; i++) state = rules.applyPortalHold(state, 'C', DT, true)
  assert.equal(state.finale, true, 'the third portal did not open the finale')
  assert.equal(state.dusk, 1, 'dusk should be full with every portal shut')
  assert.equal(rules.portalsShut(state.portals), 3)
  assert.equal(rules.duskForPortals({ A: true, B: true, C: true }), 1)
  assert.equal(rules.duskForPortals({ A: false, B: false, C: false }), 0)
  // dusk is a function of progress alone, so it can never be a death spiral
  assert.equal(rules.applyCapture(state).dusk, 1, 'dusk fell when the player died')
})

test('isInsideExit is the v1 chamber test, negatives included', () => {
  // §15.2 asked for the v2 win geometry to be the same *shape* as v1's
  // `isInsideChamber`, so two runs of this benchmark are comparable. Slice 16
  // deleted the function it used to be compared against, so the comparison can no
  // longer be made live — which means the table below is now the artifact. Every
  // row of it was transcribed from the run that did compare the two, including the
  // three null rows and the negatives, and the one number it leaned on is pinned
  // immediately below so a drift in the radius cannot pass as parity.
  assert.equal(rules.EXIT_WIN_RADIUS, 1.15, '§10.4: the win radius is v1\'s 1.15 m, unchanged')
  const cases = [
    [{ x: 0, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 1.1, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 1.2, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: -1.15, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0, z: -1.15 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0.8, z: 0.8 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0.81, z: 0.81 }, { x: 0, z: 0 }, 1.15],
    [{ x: 900, z: -900 }, { x: 0, z: 0 }, 1.15],
    [null, { x: 0, z: 0 }, 1.15],
    [{ x: 0, z: 0 }, null, 1.15],
    [{ x: 0, z: 0 }, undefined, 1.15],
    [null, null, 1.15],
    [{ x: 3, z: 4 }, { x: 3, z: 4 }, 5],
    [{ x: 8, z: 4 }, { x: 3, z: 4 }, 5],
  ]
  for (const [position, centre, radius] of cases) {
    // the closed disc, both signs on both axes, and no throw on a missing argument
    const inside = rules.isInsideExit(position, centre, radius)
    assert.equal(typeof inside, 'boolean', `isInsideExit did not answer for ${JSON.stringify(position)}`)
    if (position && centre) {
      const expected = Math.hypot(position.x - centre.x, position.z - centre.z) <= radius
      assert.equal(inside, expected, `isInsideExit disagrees with its own definition at ${JSON.stringify(position)}`)
    } else {
      assert.equal(inside, false, 'a missing position or centre is never inside')
    }
  }
  assert.equal(rules.isInsideExit({ x: 0, z: 0 }, { x: 0, z: 0 }), true)
  assert.equal(rules.isInsideExit({ x: 2, z: 0 }, { x: 0, z: 0 }), false)
  assert.equal(rules.isInsideExit(null, { x: 0, z: 0 }), false)
})

test('winning needs the finale as well as the geometry', () => {
  const objectives = hood.placeObjectives(1337, 1)
  let state = rules.createInitialState(objectives)
  const exit = objectives.exit.position
  const inside = { x: exit.x, z: exit.z }
  // standing in the exit before the third portal does nothing
  assert.equal(rules.isInsideExit(inside, exit), true, 'the geometry should already be satisfied')
  assert.equal(rules.checkExitWin(state, inside), false, 'won without triggering the finale')
  for (const id of ['A', 'B', 'C']) {
    for (let i = 0; i < 200 && !state.portals[id]; i++) state = rules.applyPortalHold(state, id, DT, true)
  }
  assert.equal(state.finale, true)
  assert.equal(rules.checkExitWin(state, inside), true, 'standing in the exit did not win')
  assert.equal(rules.checkExitWin(state, { x: exit.x + 50, z: exit.z }), false, 'won from across the map')
  // the finale is a flag, not a new PHASE: the state still reads as playing
  assert.equal(typeof state.finale, 'boolean')
})

// ---------------------------------------------------------------------------
// v2 slice 06 — the creature's awareness, sound table and sight
// ---------------------------------------------------------------------------

section('Creature awareness (v2 slice 06)')

test('the slice 06 constants match the design', () => {
  assert.equal(beast.AWARENESS_INVESTIGATE, 0.4, '§6.2: 0.4 is the investigate threshold')
  assert.equal(beast.AWARENESS_CHASE, 1.0, '§6.2: 1.0 is the chase threshold')
  assert.ok(beast.SOUND_TO_SIGHT_RATIO >= 4 && beast.SOUND_TO_SIGHT_RATIO <= 5, '§6.2: four to five times')
  assert.equal(
    beast.SOUND_FILL_PER_SEC,
    beast.SOUND_TO_SIGHT_RATIO * beast.SIGHT_FILL_PER_SEC,
    'the sound rate must be derived from the ratio, not typed beside it',
  )
  assert.ok(beast.SOUND_FILL_PER_SEC > beast.SIGHT_FILL_PER_SEC)
  assert.equal(beast.STAGGER_SECONDS, 1.6, 'the pass-8 stun length')
  assert.ok(beast.BANISH_RANGE > beast.CAPTURE_RADIUS, 'a banish has to reach past contact')
  assert.deepEqual([...beast.AWARENESS_LEVELS], ['unaware', 'investigate', 'chase'])
  for (const state of ['dormant', 'telegraph', 'stalk', 'reposition', 'chase', 'stagger', 'enraged']) {
    assert.ok(beast.CREATURE_STATES.includes(state), `${state} is not a state`)
  }
  assert.equal(beast.createCreature().state, 'telegraph', 'Act I opens in TELEGRAPH (§6.1)')
})

test('the sound table is the §6.2 table and nothing else', () => {
  assert.deepEqual({ ...beast.SOUND_RADII }, { walk: 9, sprint: 22, portal: 25, toll: 30 })
  assert.equal(beast.SOUND_RADII.portal, rules.PORTAL_SOUND_RADIUS, 'one definition of the shutdown radius (§5.2, §6.2)')
  // the documented ordering, which is the whole point of the table
  assert.ok(beast.SOUND_RADII.toll > beast.SOUND_RADII.portal, 'the hammer outranks the shutdown')
  assert.ok(beast.SOUND_RADII.portal > beast.SOUND_RADII.sprint, 'a shutdown outranks a sprint')
  assert.ok(beast.SOUND_RADII.sprint > beast.SOUND_RADII.walk, 'a sprint outranks a walk')
  for (const kind of Object.keys(beast.SOUND_RADII)) {
    assert.equal(beast.soundRadius(kind), beast.SOUND_RADII[kind], `${kind} radius`)
  }
  assert.equal(beast.soundRadius('nonsense'), 0, 'an unknown event is silent, not a crash')
})

test('the hammer stays the loudest thing in the game whatever the player is doing', () => {
  const exhaustedSprint = beast.soundRadius('sprint', { exhausted: true })
  assert.ok(
    exhaustedSprint <= beast.SOUND_RADII.toll,
    `an exhausted sprint (${exhaustedSprint} m) is louder than the hammer`,
  )
  // §7.3's bonus does lift a sprint past the shutdown, and that is intended
  assert.ok(exhaustedSprint > beast.SOUND_RADII.portal, 'exhaustion should out-shout a shutdown')
  // the gate that matters is directional: sprinting must be louder than walking,
  // at every distance, because §6.2 lives or dies on the player running away
  for (const distance of [0, 4, 8, 12, 16, 20, 22]) {
    const sprint = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance }] }).heard[0]
    const walk = beast.awarenessStep(0, DT, { sounds: [{ kind: 'walk', distance }] }).heard[0]
    if (!sprint) {
      assert.equal(walk, undefined, `a walk is heard at ${distance} m but a sprint is not`)
      continue
    }
    // at the source the two doses are equal — what differs is how far out the
    // sprint carries and how often it happens, which the next two lines cover
    assert.ok(sprint.step >= (walk ? walk.step : 0), `${distance} m: a sprint cannot be quieter than a walk`)
    if (walk && distance > 0) {
      assert.ok(sprint.step > walk.step, `${distance} m: a sprint must be louder than a walk`)
    }
  }
  // beyond the walk's radius the sprint is the only thing the creature hears
  assert.equal(beast.awarenessStep(0, DT, { sounds: [{ kind: 'walk', distance: 15 }] }).heard.length, 0)
  assert.equal(beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 15 }] }).heard.length, 1)
  // and per second, not per event, a sprint is louder everywhere they are both heard
  const stridesPerSecond = (speed) => speed / 1.7 // the player's 1.7 m stride, player.js
  for (const distance of [0, 2, 5, 8]) {
    const rate = (kind, speed) => {
      const step = beast.awarenessStep(0, DT, { sounds: [{ kind, distance }] }).heard[0]
      return step ? (step.step * stridesPerSecond(speed)) / beast.SOUND_EVENT_SECONDS : 0
    }
    assert.ok(rate('sprint', 6.0) > rate('walk', 3.6), `${distance} m: sprinting must fill the meter faster`)
  }
})

test('standing still is silence, and exhaustion is the only way to break it', () => {
  assert.equal(beast.soundRadius('still'), 0, '§6.2: a still player emits nothing')
  assert.equal(
    beast.soundRadius('still', { exhausted: true }),
    rules.EXHAUSTED_BREATH_SOUND_BONUS,
    '§7.3: exhaustion makes you louder even standing still',
  )
  // +6 on top of the gait radius, through the one function that owns the bonus
  for (const kind of ['walk', 'sprint']) {
    assert.equal(
      beast.soundRadius(kind, { exhausted: true }) - beast.soundRadius(kind, { exhausted: false }),
      rules.EXHAUSTED_BREATH_SOUND_BONUS,
      `${kind}: the §7.3 bonus`,
    )
    assert.equal(beast.soundRadius(kind, { exhausted: true }), rules.breathSoundRadius(beast.SOUND_RADII[kind], true))
  }
  // and the strategic consequence: a still player at full breath is not a stimulus
  const quiet = beast.awarenessStep(0.5, DT, { sounds: [{ kind: 'still', distance: 0 }] })
  assert.equal(quiet.heard.length, 0)
  assert.ok(quiet.decayed > 0, 'standing still must let the meter fall')
  const gasping = beast.awarenessStep(0.5, DT, { sounds: [{ kind: 'still', distance: 0, exhausted: true }] })
  assert.equal(gasping.heard.length, 1, 'gasping while still is still a stimulus')
  assert.ok(gasping.awareness > 0.5)
})

test('sound fills the meter four to five times faster than sight, at every strength', () => {
  const gain = (frame) => beast.awarenessStep(0, DT, frame).awareness
  // one full-strength sound window against one second of full-strength sight
  const sound = gain({ sounds: [{ kind: 'sprint', distance: 0 }] }) / beast.SOUND_EVENT_SECONDS
  const sight = gain({ seen: true, sightDistance: 0, sightRange: 14 }) / DT
  const ratio = sound / sight
  assert.ok(Math.abs(ratio - beast.SOUND_TO_SIGHT_RATIO) < 1e-9, `measured ratio ${ratio}`)
  assert.ok(ratio >= 4 && ratio <= 5, '§6.2: roughly four to five times')
  // the ratio is a property of the integration, not of one lucky sample
  for (const soundDistance of [0, 5, 11, 20]) {
    for (const sightDistance of [0, 3.5, 7, 13]) {
      const heard = gain({ sounds: [{ kind: 'walk', distance: soundDistance }] })
      const glanced = gain({ seen: true, sightDistance, sightRange: 14 })
      if (!(heard > 0) || !(glanced > 0)) continue
      const expected =
        (beast.SOUND_FILL_PER_SEC * beast.SOUND_EVENT_SECONDS * beast.soundStrength(soundDistance, 9)) /
        (beast.SIGHT_FILL_PER_SEC * beast.sightStrength(sightDistance, 14) * DT)
      assert.ok(
        Math.abs(heard / glanced - expected) < 1e-9,
        `sound ${soundDistance} m vs sight ${sightDistance} m: measured ${heard / glanced}, expected ${expected}`,
      )
    }
  }
})

test('sight confirms and holds the meter; sound is what acquires it', () => {
  // sight never decays: this is the entire tactical value of breaking contact
  const held = beast.awarenessStep(0.9, 1, { seen: true, sightDistance: 12, sightRange: 14 })
  assert.equal(held.decayed, 0, 'sight must not bleed the meter')
  assert.ok(held.awareness > 0.9)
  let a = 0.62
  for (let i = 0; i < 120; i += 1) {
    a = beast.awarenessStep(a, DT, { seen: true, sightDistance: 3, sightRange: 14 }).awareness
  }
  assert.ok(a > 0.62, 'sight does fill, which is why it is worth hiding')
  // ...but it takes seconds of unbroken attention, while a sprint is heard in one
  const secondsOfSightToChase = 1 / beast.SIGHT_FILL_PER_SEC
  assert.ok(secondsOfSightToChase > 8, `point-blank sight chases in ${secondsOfSightToChase.toFixed(1)} s`)
  const strides = Math.ceil(1 / (beast.SOUND_FILL_PER_SEC * beast.SOUND_EVENT_SECONDS * beast.soundStrength(5, 22)))
  const secondsOfSprintToChase = strides * 0.3 // a 1.7 m stride at 6.0 m/s is 0.28 s
  assert.ok(secondsOfSprintToChase < secondsOfSightToChase / 2, 'sound must be the fast lane')
  // breaking the sightline ends the hold on the very next frame
  const broken = beast.awarenessStep(0.9, DT, { seen: false })
  assert.ok(broken.decayed > 0, 'losing sight resumes the decay immediately')
  assert.ok(broken.awareness < 0.9)
  // and `immune` (§8.1) is the extreme case: Act I is not silent, it is deaf
  const deaf = beast.awarenessStep(0.9, 1, {
    immune: true,
    seen: true,
    sightDistance: 0,
    sounds: [{ kind: 'sprint', distance: 0 }],
  })
  assert.equal(deaf.awareness, 0, 'an immune frame does not even decay')
  assert.equal(deaf.heard.length, 0)
  assert.equal(deaf.seen, false)
})

test('the meter decays only on a frame with no stimulus at all', () => {
  const silent = beast.awarenessStep(0.8, DT, {})
  assert.ok(Math.abs(silent.decayed - beast.AWARENESS_DECAY_PER_SEC * DT) < 1e-12)
  assert.ok(Math.abs(silent.awareness - (0.8 - beast.AWARENESS_DECAY_PER_SEC * DT)) < 1e-12)
  // a sound that did not reach the creature is not a stimulus
  assert.ok(beast.awarenessStep(0.8, DT, { sounds: [{ kind: 'walk', distance: 40 }] }).decayed > 0)
  // one that did, is
  assert.equal(beast.awarenessStep(0.8, DT, { sounds: [{ kind: 'sprint', distance: 5 }] }).decayed, 0)
  assert.equal(beast.awarenessStep(0.8, DT, { seen: true, sightDistance: 5 }).decayed, 0)
  // the decay floors at zero rather than going negative
  assert.equal(beast.awarenessStep(0.0005, DT, {}).awareness, 0)
  // and silence is a real escape: under 12 s of it a full chase is gone
  assert.ok(1 / beast.AWARENESS_DECAY_PER_SEC < 12, 'silence must be able to lose a chase')
  assert.ok(0.6 / beast.AWARENESS_DECAY_PER_SEC < 6, 'silence must drop an investigation in seconds')
})

test('the thresholds are 0.4 and 1.0, and crossing one is a transition', () => {
  assert.equal(beast.awarenessLevel(0), 'unaware')
  assert.equal(beast.awarenessLevel(0.3999999), 'unaware', 'a hair under 0.4 is still unaware')
  assert.equal(beast.awarenessLevel(0.4), 'investigate', '§6.2: 0.4-0.8 investigates')
  assert.equal(beast.awarenessLevel(0.7999), 'investigate')
  assert.equal(beast.awarenessLevel(0.9999999), 'investigate')
  assert.equal(beast.awarenessLevel(1), 'chase', '§6.2: 1.0 is the chase')
  assert.equal(beast.clampAwareness(beast.AWARENESS_INVESTIGATE), 0.4)
  // and the machine transitions on the frame the meter crosses, not a frame later
  let creature = beast.createCreature({ state: 'stalk' })
  let first = null
  for (let i = 0; i < 600 && first === null; i += 1) {
    const step = beast.creatureStep(creature, DT, { distance: 30, sounds: [{ kind: 'sprint', distance: 2 }] })
    creature = step.creature
    if (step.level === 'investigate') first = step
  }
  assert.ok(first, 'the meter never reached the investigate band')
  assert.ok(first.awareness >= beast.AWARENESS_INVESTIGATE, 'reported investigate below 0.4')
  assert.ok(first.awareness < 1)
  assert.equal(first.to, 'stalk', 'investigating is not yet a chase')
})

test('the meter clamps to [0, 1] and no event can overshoot a chase', () => {
  // a single loud event lands short of the ceiling
  const one = beast.awarenessStep(0.9, DT, { sounds: [{ kind: 'toll', distance: 0 }] }).awareness
  assert.ok(one <= 1 && one > 0.9, `one event gave ${one}`)
  // and no pile of them, or one enormous frame, gets past 1.0
  const flood = Array.from({ length: 500 }, () => ({ kind: 'toll', distance: 0 }))
  assert.equal(beast.awarenessStep(0.999, DT, { sounds: flood }).awareness, 1)
  assert.equal(beast.awarenessStep(0, 9999, { seen: true, sightDistance: 0, sightRange: 14 }).awareness, 1)
  assert.equal(beast.awarenessStep(0, 1e9, { sounds: flood, seen: true, sightDistance: 0 }).awareness, 1)
  // nonsense in, zero out — the meter is a game rule, not a source of NaN
  assert.equal(beast.awarenessStep(-5, DT, {}).awareness, 0)
  assert.equal(beast.awarenessStep(NaN, DT, {}).awareness, 0)
  assert.equal(beast.clampAwareness(1e9), 1)
  assert.equal(beast.clampAwareness(-1e9), 0)
  assert.equal(beast.clampAwareness(Infinity), 0)
})

test('sound falls off in metres and stops dead at the radius', () => {
  assert.equal(beast.soundStrength(0, 9), 1, 'at the source it is full strength')
  assert.equal(beast.soundStrength(4.5, 9), 0.5, 'half way out is half strength')
  assert.equal(beast.soundStrength(9, 9), 0, 'the edge of the radius is nothing')
  assert.equal(beast.soundStrength(9.01, 9), 0, 'past the radius is nothing')
  assert.equal(beast.soundStrength(-1, 9), 0)
  assert.equal(beast.soundStrength(5, 0), 0, 'a silent source has no strength to give')
  let previous = Infinity
  for (let distance = 0; distance <= 22; distance += 0.25) {
    const strength = beast.soundStrength(distance, 22)
    assert.ok(strength <= previous, `strength rose again at ${distance} m`)
    assert.ok(strength >= 0 && strength <= 1)
    previous = strength
  }
  // and the integration agrees with the table: one metre closer is a bigger bite
  const near = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 10 }] }).heard[0].step
  const far = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 11 }] }).heard[0].step
  assert.ok(near > far)
})

test('the fog curve only ever weakens a distant target', () => {
  assert.equal(beast.sightStrength(0, 14), 1)
  assert.equal(beast.sightStrength(14, 14), 0, 'the edge of the range is worth nothing')
  assert.equal(beast.sightStrength(20, 14), 0, 'past the range is worth nothing')
  assert.equal(beast.sightStrength(7, Infinity), 1, 'tier 3 has infinite vision (§11.1)')
  let previous = Infinity
  for (let distance = 0; distance <= 14; distance += 0.1) {
    const strength = beast.sightStrength(distance, 14)
    assert.ok(strength <= previous, `sight strength rose again at ${distance} m`)
    assert.ok(strength >= 0 && strength <= 1)
    previous = strength
  }
  // fog bites: the far end of the same range is worth less than the near end
  const half = 7
  assert.ok(beast.sightStrength(half, 14) < 1 - (half / 14), 'the fog term is doing nothing')
  assert.ok(beast.SIGHT_FOG_FALLOFF > 0 && beast.SIGHT_FOG_FALLOFF < 1)
})


test('line of sight is occlusion-aware, and only solid things occlude', () => {
  const hedge = { kind: 'hedge', x: 0, z: 0, w: 8, d: 1.2 }
  const car = { kind: 'car', x: 0, z: 0, w: 4.6, d: 2 }
  const house = { kind: 'house', x: 0, z: 0, w: 10, d: 8 }
  const south = { x: 0, z: -10 }
  const north = { x: 0, z: 10 }
  assert.equal(beast.lineOfSight(south, north, [hedge]), false, 'a hedge across the street blocks')
  assert.equal(beast.lineOfSight(south, north, [house]), false, 'a house volume blocks')
  assert.equal(beast.lineOfSight(south, { x: 30, z: 10 }, [hedge]), true, 'a line past the hedge is clear')
  assert.equal(beast.lineOfSight(south, north, [car]), true, 'a parked car is not a sight blocker (§6.3)')
  assert.equal(beast.lineOfSight(south, north, [{ ...hedge, occudes: false }]), true, 'and a caller can override')
  assert.equal(beast.lineOfSight(south, north, [{ ...car, occudes: true }]), false)
  // standing inside a hedge counts as blocked, and grazing past one does not
  assert.equal(beast.lineOfSight({ x: 0, z: 0 }, { x: 0, z: 5 }, [hedge]), false)
  assert.equal(beast.lineOfSight({ x: -4.01, z: -0.5 }, { x: 4.01, z: -0.5 }, [hedge]), false)
  assert.equal(beast.lineOfSight({ x: -4.01, z: 0.61 }, { x: 4.01, z: 0.61 }, [hedge]), true)
  assert.equal(beast.segmentHitsRect(south, north, { x: 0, z: 0, w: 0, d: 0 }), true, 'a point blocks too')
  assert.equal(beast.lineOfSight(south, north, []), true, 'an empty street is always clear')
  assert.equal(beast.lineOfSight(null, north, [hedge]), false, 'no point, no sightline')
  assert.equal(beast.lineOfSight(south, undefined, []), false)
  assert.equal(beast.lineOfSight(south, north, [null, undefined, hedge]), false)
  // the real footprint shape: one chunk's fixtures, with no neighbourhood walk
  const fixtures = hood.chunkFixtures(1337, 1, 2, 3, new Set())
  assert.ok(fixtures.length > 0, 'the chunk under test has no fixtures at all')
  for (const fixture of fixtures) {
    assert.equal(beast.isOccluder(fixture), beast.OCCLUDER_KINDS.includes(fixture.kind), `${fixture.kind} occludes`)
    const through = { x: fixture.x, z: fixture.z - 1 }
    assert.equal(beast.segmentHitsRect(through, { x: fixture.x, z: fixture.z + 1 }, fixture), true)
  }
})

test('the sight cone is ~70 degrees and yaw 0 faces -Z like the player', () => {
  assert.ok(Math.abs((beast.SIGHT_HALF_ANGLE * 180) / Math.PI - 35) < 1e-9, 'a 70 degree cone')
  // player.js: forward is (-sin yaw, -cos yaw), so yaw 0 looks down -Z.
  // `-Math.sin(0)` is -0, which is why these are compared by magnitude.
  assert.ok(Math.abs(beast.forwardOf(0).x) < 1e-15)
  assert.equal(beast.forwardOf(0).z, -1)
  assert.ok(Math.abs(beast.forwardOf(Math.PI / 2).x + 1) < 1e-12, 'and turns toward -X')
  const offAxis = (degrees, distance) => {
    const radians = (degrees * Math.PI) / 180
    const f = beast.forwardOf(0)
    const right = { x: -f.z, z: f.x }
    return {
      x: (f.x * Math.cos(radians) + right.x * Math.sin(radians)) * distance,
      z: (f.z * Math.cos(radians) + right.z * Math.sin(radians)) * distance,
    }
  }
  const eye = { x: 0, z: 0, yaw: 0 }
  assert.equal(beast.inSightCone(eye, offAxis(0, 10)), true)
  assert.equal(beast.inSightCone(eye, offAxis(30, 10)), true, '30 degrees off is inside a 35 degree half-angle')
  assert.equal(beast.inSightCone(eye, offAxis(-30, 10)), true)
  assert.equal(beast.inSightCone(eye, offAxis(40, 10)), false)
  assert.equal(beast.inSightCone(eye, offAxis(180, 10)), false, 'directly behind is not in the cone')
  assert.equal(beast.inSightCone(eye, { x: 0, z: 0 }), true, 'a target on top of it is in the cone')
  // yawBetween round-trips, so the view layer can point the creature at a target
  const target = offAxis(-22, 30)
  const f = beast.forwardOf(beast.yawBetween(eye, target))
  assert.ok(Math.abs((f.x * target.x + f.z * target.z) / 30 - 1) < 1e-9)
  // and canSee is all three tests at once
  assert.equal(beast.canSee(eye, offAxis(0, 10), { range: 14 }), true)
  assert.equal(beast.canSee(eye, offAxis(0, 15), { range: 14 }), false, 'out of range at tier 0 (§11.1)')
  assert.equal(beast.canSee(eye, offAxis(0, 15), { range: 17 }), true, 'the same target at tier 1')
  assert.equal(beast.canSee(eye, offAxis(0, 40), { range: Infinity }), true, 'tier 3 always knows (§10.2)')
  assert.equal(beast.canSee(eye, offAxis(40, 10), { range: Infinity }), false, 'even at infinite range the cone holds')
  assert.equal(
    beast.canSee(eye, offAxis(0, 10), { range: Infinity, occluders: [{ kind: 'hedge', x: 0, z: -5, w: 8, d: 1.2 }] }),
    false,
    'and a hedge still blocks at infinite range',
  )
  assert.equal(beast.canSee(null, offAxis(0, 1), {}), false)
})

// ---------------------------------------------------------------------------
// v2 slice 06 — the scripted run, and the state machine it drives
// ---------------------------------------------------------------------------

const CREATURE_DT = 1 / 60
// the player's real cadences, from player.js: a 1.7 m stride at 3.6 and 6.0 m/s
const WALK_STRIDE_FRAMES = Math.round(0.47 / CREATURE_DT)
const SPRINT_STRIDE_FRAMES = Math.round(0.28 / CREATURE_DT)
// a continuous source emits one event per integration window, not one per frame
const SHUTDOWN_FRAMES = Math.round(beast.SOUND_EVENT_SECONDS / CREATURE_DT)

/**
 * creatureScript — one Act I to Act III run, as a fixed list of frames.
 *
 * Every phase is a legal thing a player can do, and between them they exercise
 * every edge in `TRANSITIONS`, so the machine's data table can be checked
 * against the machine itself rather than against itself. The distances and
 * cadences are the real ones from §6.2 and player.js: a 9 m whisper, a 22 m
 * sprint, a 25 m shutdown at its documented window rate, and a 30 m toll.
 */
function creatureScript() {
  const where = { x: 4, z: 4 } // the player, parked at a lot corner
  const script = []
  let frame = 0
  const phase = (label, frames, make) => {
    for (let i = 0; i < frames; i += 1) {
      script.push({ at: frame, label, frame: typeof make === 'function' ? make(i, frame) : make })
      frame += 1
    }
  }
  // a gait at its real cadence: footsteps on a stride, a shutdown on its window
  const gait = (label, kind, soundDistance, distance, every, frames) => {
    phase(label, frames, (i, at) => ({
      distance,
      sounds: at % every === 0 ? [{ kind, distance: soundDistance, position: where }] : [],
    }))
  }
  const quiet = (label, frames, distance = 40, extra = {}) => phase(label, frames, { distance, ...extra })

  // Act I. The player walks up to the apparition: in its cone, on top of it,
  // sprinting, with the hammer tolling, all at once. §8.1 says none of that
  // matters, and this is where that promise is spent.
  phase('act I in its face', 90, () => ({
    sighting: true,
    seen: true,
    sightDistance: 0.2,
    playerPosition: where,
    distance: 0.2,
    sounds: [
      { kind: 'sprint', distance: 0.2 },
      { kind: 'toll', distance: 0.2, position: where },
    ],
  }))

  // §7.2: the pickup tolls once, at maximum radius, and Act II begins.
  phase('hammer pickup', 1, {
    sighting: true,
    distance: 30,
    hammerPickup: true,
    sounds: [{ kind: 'toll', distance: 0, position: where }],
  })

  // Act II. First the player tries the quiet option: walking at 4 m. Over five
  // seconds of it the meter barely twitches, because a footstep is a 9 m whisper
  // and the creature is four metres away with something else to listen to. This
  // is §6.2's "kill your footsteps" clause, and the phase is in the script so the
  // claim is measured rather than asserted.
  gait('walking quietly', 'walk', 4, 4, WALK_STRIDE_FRAMES, 300)
  // then the player panics, which is the loudest thing available
  gait('sprinting past', 'sprint', 5, 5, SPRINT_STRIDE_FRAMES, 360)
  // it breaks contact, and the meter bleeds the rest of the way down
  quiet('breaking contact', 4)
  quiet('silence', 620)
  // the path layer works out the last-heard street and asks for a new one
  quiet('search exhausted', 1, 40, { searchExhausted: true })
  quiet('the search fails', 300)
  quiet('search exhausted again', 1, 40, { searchExhausted: true })
  quiet('new origin offered', 1, 40, { searchPosition: { x: -60, z: 8 } })
  // a portal shutdown at 12 m: heard, committed to, worked out — and not enough,
  // which is the whole reason the hammer has to exist
  gait('portal shutdown', 'portal', 12, 12, SHUTDOWN_FRAMES, 240)
  quiet('search exhausted once more', 1, 12, { searchExhausted: true })
  quiet('new origin again', 1, 12, { searchPosition: { x: -60, z: 8 } })
  // §7.4: the swing connects. STAGGER is the recoil, DORMANT is the removal.
  quiet('swing connects', 1, 2, { swing: true })
  quiet('banished', 120, 60)
  quiet('gone', 60, 60)
  quiet('re-emergence', 1, 60, { reemerge: true })
  // a second Act II, heard at 3 m, and this time it does become a chase — released
  // the one way §6.3 allows, which is by going quiet and letting the meter bleed,
  // because every phase after it is only reachable from STALK and REPOSITION
  gait('heard at three metres', 'sprint', 3, 3, SPRINT_STRIDE_FRAMES, 300)
  quiet('breaking contact again', 4, 40)
  quiet('silence again', 300, 40)
  // the search, worked out and given up on, twice more: REPOSITION is the state
  // the design spends the most prose on and the one a careless refactor loses.
  // Each portal is heard and then answered with silence, because a chase hides
  // every other state behind it and §6.3 is the only way out of one.
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('quiet after the portal', 300, 40)
  quiet('out of options', 1, 8, { searchExhausted: true })
  quiet('new origin again', 1, 8, { searchPosition: { x: -60, z: 8 } })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('quiet again', 300, 40)
  quiet('out of options again', 1, 8, { searchExhausted: true })
  // §7.4 out of REPOSITION: the hammer works from every hunting state, and this
  // is the one a careless refactor would forget because nothing else lands here
  quiet('swing while searching', 1, 2, { swing: true })
  quiet('banished', 120, 60)
  quiet('re-emergence', 1, 60, { reemerge: true })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('quiet once more', 300, 40)
  // the meter is brought up *before* the search is given up on, so that the creature
  // is still working out where you were when it commits — §6.2's meter does not
  // care which of the two hunting states it is in, and REPOSITION is where a chase
  // is entered from when the search is what gave the thing its last fix on you
  gait('heard again', 'sprint', 3, 3, SPRINT_STRIDE_FRAMES, 150)
  quiet('out of options once more', 1, 8, { searchExhausted: true })
  gait('heard while it searches', 'sprint', 3, 3, SPRINT_STRIDE_FRAMES, 300)
  // §8.2, and the only way to reach DORMANT without a hammer in the air: twelve
  // seconds of unbroken pursuit. The meter never dips, so nothing else can end
  // this chase, and at CHASE_MAX_SECONDS the creature gives it up and is gone.
  gait('a chase that will not end', 'sprint', 6, 6, SPRINT_STRIDE_FRAMES, 900)
  quiet('silence while it is gone', 120, 60)
  quiet('re-emergence after the phase-out', 1, 60, { reemerge: true })
  gait('it finds the street again', 'sprint', 2, 2, SPRINT_STRIDE_FRAMES, 300)
  // a swing thrown mid-chase with the creature in view. This is the only way a
  // CHASE reaches STAGGER: break the sightline on the swing frame and the meter
  // drops out of the chase on that same frame instead.
  quiet('swing in the chase', 1, 1.5, { swing: true, seen: true, sightDistance: 1.5 })
  quiet('banished at the end', 120, 60)
  quiet('re-emergence after the last banish', 1, 60, { reemerge: true })
  // §10.1: the third portal, mid-chase, and the last phase of the run. The flag
  // is run-long (§10.5 — "a `finale: true` flag, not a new PHASE"), which is why
  // every edge above had to be taken before this frame: the script used to shut
  // the third portal in the middle of Act II and go on hunting afterwards, and
  // the balance simulation is what made that impossible to leave in. Everything
  // from here is the finale — ENRAGED, and the edges that exist only because
  // §10.2 suspends the ladder rather than the banish.
  quiet('the third portal', 1, 3, { finale: true })
  quiet('enraged knowledge', 240, 30)
  quiet('swing in the finale', 1, 1.5, { swing: true })
  quiet('banished in the finale', 120, 60)
  quiet('flat re-emergence', 1, 60, { reemerge: true })
  quiet('swing in the finale again', 1, 1.5, { swing: true })
  quiet('banished once more', 120, 60)
  quiet('fourth re-emergence', 1, 60, { reemerge: true })
  quiet('it knows where you are', 240, 30)
  quiet('swing in the finale once more', 1, 1.5, { swing: true })
  quiet('banished the last time', 120, 60)
  return script
}

/**
 * The three ways into §10.2's ENRAGED, one frame each, run from a chosen state.
 *
 * §10.5's flag is run-long, so the long script above can only ever take whichever
 * of the three enrage edges it happens to be standing in when the third portal
 * shuts — and it is standing in a chase, so the other two need asking for
 * explicitly. This is what `runCreatureScript`'s `start` argument is for.
 */
function finaleEntryScript() {
  return [{ at: 0, label: 'third portal', frame: { distance: 30, finale: true } }]
}

/** A sighting that ends: the one Act I exit the run above does not need. */
function sightingScript() {
  return [
    { at: 0, label: 'apparition', frame: { sighting: true, distance: 60 } },
    { at: 1, label: 'looked away', frame: { sighting: false, distance: 60 } },
    { at: 2, label: 'gone', frame: { distance: 60 } },
  ]
}


// ---------------------------------------------------------------------------
// the swap (v2 slice 09): what the view layer draws, and the rule it draws it from
// ---------------------------------------------------------------------------

section('The swap (v2 slice 09)')

/**
 * The canonical draw window, restated from `neighborhood.js` rather than from the
 * view layer, so this is a specification of the wrap and not an echo of the code
 * that implements it: the tile that is drawn is one period wide, starting at the
 * western face of block 0.
 */
const WINDOW_MIN = hood.roadAxisToWorld(0)
const WINDOW_MAX = WINDOW_MIN + hood.WORLD_EXTENT

/** The AABB a structural fixture contributes to the collider set. */
function fixtureBox(fixture) {
  return {
    x0: fixture.x - fixture.w / 2,
    x1: fixture.x + fixture.w / 2,
    z0: fixture.z - fixture.d / 2,
    z1: fixture.z + fixture.d / 2,
    kind: fixture.kind,
  }
}

test('the wrapped copies cover the player in all four directions', () => {
  // the rule: after snapping, the player's position in the copy's own frame is
  // inside the tile that copy draws. `round(x / WORLD_EXTENT)` is 32 m out, and
  // the error hides in one strip of the tile, which is exactly why it is asserted
  // over a grid rather than at four hand-picked points
  for (let i = -30; i <= 30; i += 1) {
    for (const x of [i * 15, i * 15.5 + 0.25, i * 63.9]) {
      const periods = Math.floor((x - 2 * WINDOW_MIN) / hood.WORLD_EXTENT)
      const origin = WINDOW_MIN + periods * hood.WORLD_EXTENT
      const local = x - origin
      assert.ok(
        local >= WINDOW_MIN && local < WINDOW_MAX,
        `x=${x} folded to ${local}, outside the drawn tile [${WINDOW_MIN}, ${WINDOW_MAX})`,
      )
    }
  }
  // and the four directions, by hand, because this is the check the manual pass
  // for this slice is looking at
  for (const x of [240, -240, 0, 1, -1, hood.WORLD_HALF, -hood.WORLD_HALF, 896, -896]) {
    const periods = Math.floor((x - 2 * WINDOW_MIN) / hood.WORLD_EXTENT)
    const local = x - (WINDOW_MIN + periods * hood.WORLD_EXTENT)
    assert.ok(local >= WINDOW_MIN && local < WINDOW_MAX, `x=${x} is not inside the drawn tile`)
  }
  // the fold window and the draw window really are 32 m out of step, so a check
  // written against the fold would not have caught the bug
  assert.notEqual(WINDOW_MIN, -hood.WORLD_HALF, 'the draw window is not the fold window')
  assert.equal(WINDOW_MAX - WINDOW_MIN, hood.WORLD_EXTENT, 'and the tile is exactly one period')
})

test('the collider set is correct after a fixture permutation', () => {
  for (const loop of VERIFY_LOOPS) {
    const pass = hood.fixturePass(1337, loop)
    const boxes = pass.fixtures.filter((fixture) => fixture.collides).map(fixtureBox)
    assert.ok(boxes.length > 40, `loop ${loop} produced only ${boxes.length} colliders`)
    // and the pass dresses all four frontages of the block, not two of them: a
    // fixture pass that skips a side is invisible in a screenshot and is the
    // shape a "half the world is empty" bug takes
    for (const side of hood.SIDE_NAMES) {
      const dressed = pass.fixtures.filter((fixture) => fixture.collides && fixture.lot === side).length
      assert.ok(dressed > 8, `loop ${loop}: only ${dressed} colliders on the ${side} lots`)
    }
    for (const box of boxes) {
      // rule 1, as a collider rather than as a fixture: nothing solid may stand
      // in a road, in any of the four directions
      for (let axis = 0; axis < hood.GRID; axis += 1) {
        const line = hood.roadAxisToWorld(axis)
        for (const [lo, hi] of [
          [line - hood.STREET_HALF_WIDTH, line + hood.STREET_HALF_WIDTH],
          [-hood.WORLD_HALF, hood.WORLD_HALF],
        ]) {
          const inRoad = box.z1 > lo && box.z0 < hi
          if (!inRoad) continue
          const acrossX = box.x0 < line + hood.STREET_HALF_WIDTH && box.x1 > line - hood.STREET_HALF_WIDTH
          const acrossZ = box.z0 < line + hood.STREET_HALF_WIDTH && box.z1 > line - hood.STREET_HALF_WIDTH
          assert.ok(!(acrossX || acrossZ), `loop ${loop}: a ${box.kind} is standing in the road at x=${line}`)
        }
      }
    }
    // rules 2 and 3, restated against the boxes the view layer actually builds
    for (const anchor of pass.objectives.all) {
      const approach = hood.lotApproach(anchor.lot)
      for (const box of boxes) {
        assert.ok(
          !hood.rectsOverlap(box, approach),
          `loop ${loop}: a ${box.kind} blocks the approach to ${anchor.id}`,
        )
      }
    }
    // rule 4: nothing the player can be inside of, at the point they wake up
    const spawn = hood.SPAWN.position
    for (const box of boxes) {
      const inside =
        spawn.x > box.x0 - 0.36 && spawn.x < box.x1 + 0.36 && spawn.z > box.z0 - 0.36 && spawn.z < box.z1 + 0.36
      assert.ok(!inside, `loop ${loop}: a ${box.kind} is on the spawn point`)
    }
  }
})

test('the collider set is a function of the loop and not of the build order', () => {
  const boxesFor = (order) =>
    order
      .flatMap(({ cx, cz }) => hood.chunkFixtures(1337, 2, cx, cz, hood.reservedLots(hood.placeObjectives(1337))))
      .filter((fixture) => fixture.collides)
      .map(fixtureBox)
      .map((box) => `${box.x0},${box.z0},${box.x1},${box.z1},${box.kind}`)
  const inOrder = []
  for (let cx = 0; cx < hood.GRID; cx += 1) for (let cz = 0; cz < hood.GRID; cz += 1) inOrder.push({ cx, cz })
  const forward = boxesFor(inOrder)
  // as a SET, not as a sequence: §3.2's contract is that the world a run draws
  // does not depend on the order the chunks were built in, and instance indices
  // are exactly the thing that legitimately changes
  const shuffled = boxesFor([...inOrder].reverse()).sort()
  assert.deepEqual(shuffled, [...forward].sort(), 'generation order changed the collider set')
  assert.equal(new Set(forward).size, forward.length, 'two fixtures share a footprint')

  // and the permuted loop really is a different world: a fixture pass that never
  // changes is a silent failure, and the collider set is where it would show
  const loop1 = hood.fixturePass(1337, 1)
  const loop2 = hood.fixturePass(1337, 2)
  assert.notEqual(hood.fixtureSignature(loop1), hood.fixtureSignature(loop2), 'loops 1 and 2 are identical')
  assert.notEqual(
    loop1.fixtures.filter((f) => f.collides).map(fixtureBox).map((b) => b.kind).join(''),
    loop2.fixtures.filter((f) => f.collides).map(fixtureBox).map((b) => b.kind).join(''),
    'the two loops have the same structural dressing',
  )
  // the geometry underneath is fixed for the run, which is the whole point
  assert.equal(hood.placeObjectives(1337, 1).signature, hood.placeObjectives(1337, 2).signature)
})

test('the fog closes as the run advances', () => {
  // one stage per portal shut, plus the stage the run opens in
  const stages = [0, 1, 2, 3].map((shut) => rules.fogDensityForDusk(shut / hood.PORTAL_IDS.length))
  assert.equal(stages.length, 4, 'three portals, four stages')
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i] > stages[i - 1], `fog did not close at portal ${i}: ${stages}`)
  }
  const open = rules.fogVisibility(stages[0])
  const finale = rules.fogVisibility(stages[stages.length - 1])
  assert.ok(Number.isFinite(open) && open > 60, `Act I should see at least 60 m, got ${open}`)
  assert.ok(open / finale > 2, `the finale should close the world by half, got ${open / finale}`)
  // the exact values a player would see, and the clamp
  assert.equal(rules.fogDensityForDusk(0), rules.DUSK_FOG[0].density)
  assert.equal(rules.fogDensityForDusk(1), rules.DUSK_FOG[3].density)
  assert.equal(rules.fogDensityForDusk(-4), rules.DUSK_FOG[0].density, 'a negative dusk is clamped')
  assert.equal(rules.fogDensityForDusk(9), rules.DUSK_FOG[3].density, 'a dusk past the end is clamped')
  assert.equal(rules.fogVisibility(0), Infinity, 'no fog means no horizon')
  // §3.7: the fog is keyed to progress, so a capture cannot reopen the world
  const state = rules.createInitialState(hood.placeObjectives(1337))
  const shut = rules.applyPortalHold({ ...state, progress: { A: 0.999 } }, 'A', 1 / 60, true)
  assert.equal(shut.dusk > 0, true, 'the first portal advanced dusk')
  const caught = rules.applyCapture(shut)
  assert.equal(caught.dusk, shut.dusk, 'a capture changed the dusk')
  assert.equal(rules.fogDensityForDusk(caught.dusk), rules.fogDensityForDusk(shut.dusk))
})

const STREET_VIEW_SOURCE = readFileSync(new URL('./src/game/streetView.js', import.meta.url), 'utf8')
// Iteration 2, pass 7: the one claim that is about the PURE module rather than the
// view, and it needs its own source string for the same reason the creature's does — a
// mutation of `streetView.js` cannot break a claim about `hash.js`.
const HASH_SOURCE = readFileSync(new URL('./src/game/hash.js', import.meta.url), 'utf8')
const WORLD_SOURCE = readFileSync(new URL('./src/game/world.js', import.meta.url), 'utf8')
const APP_SOURCE = readFileSync(new URL('./src/App.jsx', import.meta.url), 'utf8')
// Read as text, not imported: `creatureView.js` touches Three.js, and §15.2's
// seam is the reason `verify.mjs` is a pure module that never constructs a
// renderer. A source read costs nothing and keeps it that way.
const CREATURE_VIEW_SOURCE = readFileSync(new URL('./src/game/creatureView.js', import.meta.url), 'utf8')
// Iteration 2, pass 10: the same treatment for the creature's PURE half. A mutation
// of `creature.js` cannot break a claim about `creatureView.js` and vice versa, and
// the pass-10 table has one row of each kind — the seeded mark's shape lives in the
// pure module, the buffer that draws it lives in the view.
const CREATURE_SOURCE = readFileSync(new URL('./src/game/creature.js', import.meta.url), 'utf8')
// PASS 12. The pure module this pass's numbers live in, read as text for the
// mutation harness. The claims themselves import `rules` directly — a contract
// about a number is a contract about the module, not about a copy of the number —
// so this is used ONLY by the mutation list, which has to know what the real text
// says in order to break it. Pass 11's mutation list has the same third argument
// for the same reason.
const RULES_SOURCE = readFileSync(new URL('./src/game/rules.js', import.meta.url), 'utf8')

test('the view layer is drawn from the pure modules and never from v1', () => {
  // §15.1's split, asserted rather than described: `streetView.js` may reach for
  // the generator and the AI's occluder table, and for nothing else
  assert.equal(/from ['"]\.\/maze\.js['"]/.test(STREET_VIEW_SOURCE), false, 'streetView imports v1 maze.js')
  assert.equal(/from ['"]\.\/loop\.js['"]/.test(STREET_VIEW_SOURCE), false, 'streetView imports v1 loop.js')
  assert.equal(/from ['"]three['"]/.test(STREET_VIEW_SOURCE), true, 'streetView should be the Three.js half')
  for (const module of ['./neighborhood.js', './creature.js']) {
    assert.ok(STREET_VIEW_SOURCE.includes(`from '${module}'`), `streetView should import ${module}`)
  }
  // and the world adopted the v2 simulation rather than the v1 one
  assert.equal(/from ['"]\.\/maze\.js['"]/.test(WORLD_SOURCE), false, 'world.js still imports v1 maze.js')
  for (const module of ['./streetView.js', './creature.js', './rules.js', './neighborhood.js']) {
    assert.ok(WORLD_SOURCE.includes(`from '${module}'`), `world.js should import ${module}`)
  }
  // v1 reached this file from nowhere at all, and since slice 16 there is nothing
  // left in the repository to reach for
  assert.equal(/from ['"]\.\/maze\.js['"]/.test(APP_SOURCE), false, 'App.jsx still imports v1 maze.js')
  // a comment may say "shrines" — this file's own header does — but no code may
  assert.equal(/SHRINE_IDS/.test(WORLD_SOURCE), false, 'world.js still uses the v1 shrine ids')
  assert.equal(/this\.shrines\b/.test(WORLD_SOURCE), false, 'world.js still holds shrines')
  assert.equal(/isInsideChamber\(/.test(WORLD_SOURCE), false, 'world.js still calls v1 win geometry')
})

test('the swap is one line of App.jsx', () => {
  // §15.1: the React side changes at the line that constructs the game class and
  // nowhere else, which is what makes the whole build revertible
  const constructions = APP_SOURCE.match(/new\s+\w*Game\s*\(/g) ?? []
  assert.equal(constructions.length, 1, `App.jsx constructs a game ${constructions.length} times`)
  const worldImports = APP_SOURCE.match(/from '\.\/game\/world\.js'/g) ?? []
  assert.equal(worldImports.length, 1, 'App.jsx imports world.js once')
  const localName = /import\s*\{\s*(\w+)(?:\s+as\s+(\w+))?\s*\}\s*from\s*'\.\/game\/world\.js'/.exec(APP_SOURCE)
  assert.ok(localName, 'App.jsx imports the game class from world.js')
  const bound = localName[2] ?? localName[1]
  assert.ok(
    new RegExp(`new\\s+${bound}\\s*\\(`).test(APP_SOURCE),
    `App.jsx binds ${localName[1]} but constructs ${bound}`,
  )
})

test('a scripted run: three portals, a capture in the middle, and the exit', () => {
  // the §10.5 shape end to end, in pure functions: progress survives a capture,
  // the finale opens on the third portal and only the third, and the win needs
  // both the geometry and the flag
  let state = rules.createInitialState(hood.placeObjectives(1337))
  assert.equal(state.finale, false)
  const shutIn = []
  for (const id of hood.PORTAL_IDS) {
    // a capture halfway through the run, between the first and second portal
    if (id === 'B') {
      state = rules.applyCapture(state)
      assert.equal(state.loop, 2, 'the capture counter advanced')
      assert.equal(state.portals.A, true, '§5.3: a shut portal is permanent')
    }
    // hold E long enough to finish the shutdown
    let guard = 0
    while (!state.portals[id] && guard < 600) {
      state = rules.applyPortalHold(state, id, 1 / 60, true)
      guard += 1
    }
    assert.equal(state.portals[id], true, `portal ${id} never shut`)
    assert.equal(state.finale, id === 'C', `the finale state after ${id} is wrong`)
    shutIn.push(id)
    state = { ...state, progress: { ...state.progress, [id]: 0 } }
  }
  assert.deepEqual(shutIn, [...hood.PORTAL_IDS], 'all three, in order')
  assert.equal(state.dusk, 1, 'the run is as dark as it gets')
  assert.equal(state.finale, true)
  // the exit: geometry alone is not the win, and the flag alone is not either
  const exit = state.exitAnchor.position
  assert.equal(rules.checkExitWin(state, { x: exit.x, z: exit.z }), true, 'standing in the exit did not win')
  assert.equal(rules.checkExitWin(state, { x: exit.x + 3, z: exit.z }), false, 'won from three metres away')
  assert.equal(
    rules.checkExitWin({ ...state, finale: false }, { x: exit.x, z: exit.z }),
    false,
    'won without the finale',
  )
  // and a replay of the same run produces the same state object, field for field
  const replay = (() => {
    let next = rules.createInitialState(hood.placeObjectives(1337))
    for (const id of hood.PORTAL_IDS) {
      if (id === 'B') next = rules.applyCapture(next)
      let guard = 0
      while (!next.portals[id] && guard < 600) {
        next = rules.applyPortalHold(next, id, 1 / 60, true)
        guard += 1
      }
      next = { ...next, progress: { ...next.progress, [id]: 0 } }
    }
    return next
  })()
  assert.equal(JSON.stringify(replay), JSON.stringify(state), 'the same script produced a different run')
})


// ---------------------------------------------------------------------------
// PRNG + determinism (the learnable pattern)
// ---------------------------------------------------------------------------

/**
 * runCreatureScript — replay a script and record what happened, as both a
 * readable trace and the set of edges the machine actually took.
 */
function runCreatureScript(script, start) {
  let creature = start ?? beast.createCreature()
  const lines = []
  const edges = new Set()
  const history = []
  for (const entry of script) {
    const step = beast.creatureStep(creature, CREATURE_DT, entry.frame)
    if (step.changed) edges.add(`${step.from}>${step.to}`)
    // the meter is a game rule, not a float: assert it on every frame of every run
    assert.ok(step.awareness >= 0 && step.awareness <= 1, `frame ${entry.at}: awareness ${step.awareness}`)
    assert.ok(beast.CREATURE_STATES.includes(step.to), `frame ${entry.at}: state ${step.to}`)
    lines.push(
      [
        String(entry.at).padStart(4, '0'),
        entry.label,
        `${step.from}>${step.to}`,
        step.awareness.toFixed(6),
        step.level,
        `heard=${step.heard.length}`,
        `toll=${step.creature.hammerToll ? 1 : 0}`,
        `captured=${step.captured ? 1 : 0}`,
      ].join(' '),
    )
    history.push({ ...entry, ...step })
    creature = step.creature
  }
  return { creature, trace: lines.join('\n'), edges, history, frames: lines.length }
}

section('Creature state machine (v2 slice 06)')

test('TELEGRAPH has no capture path at all (§8.1)', () => {
  // the exhaustive statement: only a chase or the finale can end a run
  assert.deepEqual([...beast.CAPTURE_STATES].sort(), ['chase', 'enraged'])
  for (const state of beast.CREATURE_STATES) {
    for (const distance of [0, 0.001, 0.5, 1, 1.1, 1.2, 5, 100]) {
      const expected = beast.CAPTURE_STATES.includes(state) && distance <= beast.CAPTURE_RADIUS
      const label = `${state} at ${distance} m`
      assert.equal(beast.canCapture(state, distance), expected, label)
      assert.equal(beast.canCapture({ state, awareness: 1 }, distance), expected, `${label}, full meter`)
    }
  }
  assert.equal(beast.canCapture('telegraph', 0, 1000), false, 'not even at a kilometre')
  assert.equal(beast.canCapture('telegraph', NaN), false)
  assert.equal(beast.canCapture(null, 0), false)
  assert.equal(beast.canCapture(undefined, 0), false)
  assert.equal(beast.canCapture('stalk', 0), false, 'a creature that does not know where you are cannot grab you')
  assert.equal(beast.canCapture('reposition', 0), false)
  assert.equal(beast.canCapture('stagger', 0), false, `${beast.STAGGER_SECONDS} s of relief per connected swing`)
  assert.equal(beast.canCapture('dormant', 0), false, 'and it is gone entirely afterwards')
  // the whole of Act I, run as hard as it can be run
  let creature = beast.createCreature()
  for (let i = 0; i < 400; i += 1) {
    const step = beast.creatureStep(creature, DT, {
      sighting: true,
      seen: true,
      sightDistance: 0,
      playerPosition: { x: 4, z: 4 },
      distance: 0,
      sounds: [{ kind: 'sprint', distance: 0 }, { kind: 'toll', distance: 0 }],
    })
    assert.equal(step.captured, false, `Act I caught the player on frame ${i}`)
    assert.equal(step.awareness, 0, `Act I learned something on frame ${i}`)
    assert.equal(step.to, 'telegraph')
    creature = step.creature
  }
  // §6.1: it cannot be banished either
  const swing = beast.creatureStep(creature, DT, { sighting: true, distance: 0, swing: true, sounds: [] })
  assert.equal(swing.swing.result, 'immune', 'TELEGRAPH must not be banishable')
  assert.equal(swing.to, 'telegraph')
  assert.equal(swing.captured, false)
  // and no documented edge out of TELEGRAPH lands anywhere that can capture
  for (const edge of beast.TRANSITIONS.filter((row) => row.from === 'telegraph')) {
    assert.ok(!beast.CAPTURE_STATES.includes(edge.to), `TELEGRAPH -> ${edge.to} is a capture path`)
  }
  assert.equal(beast.resolveSwing('telegraph', 0).result, 'immune')
  assert.equal(beast.resolveSwing('dormant', 0).result, 'immune')
})

test('capture is the end of a chase, and only of a chase', () => {
  const chasing = beast.createCreature({ state: 'chase', awareness: 1 })
  assert.equal(beast.canCapture(chasing, beast.CAPTURE_RADIUS), true)
  assert.equal(beast.canCapture(chasing, beast.CAPTURE_RADIUS + 0.01), false, 'one centimetre further is safe')
  assert.equal(beast.canCapture(chasing, 0), true, 'standing in it is a capture')
  const caught = beast.creatureStep(chasing, DT, { distance: 0.4, seen: true, sightDistance: 0.4 })
  assert.equal(caught.captured, true)
  assert.equal(caught.to, 'chase', 'a capture is not a transition; the world handles the reset (§9.1)')
  // and the reset it hands back to is a state this module agrees with
  const run = rules.createInitialState(hood.placeObjectives(1337, 1))
  run.hammerHeld = true
  const after = rules.applyCapture(run)
  assert.equal(after.creature.state, 'stalk', 'a capture returns the creature to STALK in Act II')
  assert.equal(after.creature.awareness, 0, 'and takes its knowledge with it')
  // the finale ignores range for the meter but not for its own reach
  const enraged = beast.createCreature({ state: 'enraged' })
  assert.equal(beast.canCapture(enraged, 3), false, '§10.2 buys knowledge and speed, not reach')
  assert.equal(beast.canCapture(enraged, 0.5), true)
})

test('a connected swing is a full removal, never a stagger-only outcome', () => {
  // §7.4, exhaustively: inside the range is a banish, outside it is a miss
  assert.equal(beast.resolveSwing('chase', 0).result, 'banish')
  assert.equal(beast.resolveSwing('chase', beast.BANISH_RANGE).result, 'banish')
  assert.equal(beast.resolveSwing('chase', beast.BANISH_RANGE + 0.01).result, 'miss')
  assert.equal(beast.resolveSwing('chase', Infinity).result, 'miss')
  assert.equal(beast.resolveSwing('chase', NaN).result, 'miss')
  assert.equal(beast.resolveSwing('stalk', 1).flat, false)
  assert.equal(beast.resolveSwing('enraged', 1).flat, true, '§10.2: the ladder is ignored in the finale')
  // and from every state a swing can land in, the run ends in DORMANT. STAGGER
  // is the recoil on the way, never a place the creature gets to stay.
  const driving = {
    stalk: (creature) => creature,
    chase: (creature) => ({ ...creature, state: 'chase', awareness: 1 }),
    reposition: (creature) => ({ ...creature, state: 'reposition', awareness: 0.5 }),
  }
  for (const [state, prepare] of Object.entries(driving)) {
    const start = prepare(beast.createCreature({ state: 'stalk' }))
    const swing = beast.creatureStep(start, DT, { distance: 1, swing: true, sounds: [{ kind: 'sprint', distance: 1 }] })
    assert.equal(swing.swing.result, 'banish', `${state}: a connected swing must banish`)
    assert.equal(swing.to, 'stagger', `${state}: the recoil`)
    assert.equal(swing.creature.banishPending, true)
    assert.equal(swing.captured, false, `${state}: the recoil is also the 1.6 s of relief`)
    // and it leaves for DORMANT, not back into the hunt
    let creature = swing.creature
    let left = null
    for (let i = 0; i < 200 && left === null; i += 1) {
      const step = beast.creatureStep(creature, DT, { distance: 30, sounds: [] })
      creature = step.creature
      if (step.changed) left = step
    }
    assert.ok(left, `${state}: the banish never completed`)
    assert.equal(left.to, 'dormant', `${state}: a banish must end in DORMANT`)
    assert.equal(creature.awareness, 0, `${state}: a removal takes its knowledge with it`)
    assert.equal(creature.banishPending, false)
    assert.equal(beast.canCapture(creature, 0), false, `${state}: and it cannot catch you on its way out`)
  }
  // a miss changes nothing but the toll, which the world plays on its own
  const missed = beast.creatureStep(beast.createCreature({ state: 'stalk' }), DT, {
    distance: beast.BANISH_RANGE + 1,
    swing: true,
    sounds: [],
  })
  assert.equal(missed.swing.result, 'miss')
  assert.equal(missed.to, 'stalk')
  assert.equal(missed.changed, false)
})

test('the hammer pickup is the only awakening (§7.2)', () => {
  const asleep = beast.createCreature()
  assert.equal(asleep.state, 'telegraph')
  const tolled = beast.creatureStep(asleep, DT, { sighting: true, distance: 60, hammerPickup: true, sounds: [] })
  assert.equal(tolled.to, 'stalk', 'the toll is the awakening')
  assert.equal(tolled.creature.hammerToll, true, 'and it is recorded for the view and audio layers')
  assert.equal(tolled.awareness, 0, 'the awakening is not a sighting')
  // nothing else wakes it: noise, sight and contact, in Act I, do nothing
  for (let i = 0; i < 120; i += 1) {
    const step = beast.creatureStep(asleep, DT, {
      sighting: true,
      seen: true,
      sightDistance: 0,
      distance: 0,
      sounds: [{ kind: 'sprint', distance: 0 }, { kind: 'toll', distance: 0 }],
    })
    assert.equal(step.to, 'telegraph', `frame ${i} woke the creature without the hammer`)
  }
  // a sighting that ends goes back to DORMANT, which is "pre-awakening" (§6.1)
  const faded = runCreatureScript(sightingScript())
  assert.deepEqual([...faded.edges], ['telegraph>dormant'])
  assert.equal(faded.creature.awareness, 0)
  // and DORMANT only re-emerges when the path layer says so — *and* the awakening
  // has tolled. §8.1 is a promise about Act I, and slice 15's balance simulation
  // broke it here: an apparition that had been dismissed came back as a STALKER,
  // a stalker hunts, and a hunter captures, so a player who ran at the thing
  // before the hammer could be caught sixteen times in a phase the design says
  // cannot kill you. The awakening is a state for exactly that reason.
  const still = beast.creatureStep(faded.creature, DT, { distance: 60, sounds: [] })
  assert.equal(still.to, 'dormant')
  const refused = beast.creatureStep(faded.creature, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(refused.to, 'dormant', '§8.1: nothing comes back as a hunter before the hammer')
  assert.equal(refused.creature.reemergenceCount, 0, '§11.2: nothing comes back at all')
  assert.equal(refused.creature.awakened, false)
  // the same frame, after the toll: §8.3 — a distance the world chooses, and
  // nothing it knew before
  const woken = beast.creatureStep(faded.creature, DT, { distance: 60, hammerPickup: true, sounds: [] })
  assert.equal(woken.creature.awakened, true, '§7.2: the toll is the awakening')
  const back = beast.creatureStep(woken.creature, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(back.to, 'stalk', '§8.3: it comes back, at a distance the world chooses')
  assert.equal(back.creature.reemergenceCount, 1)
  assert.equal(back.creature.awareness, 0)
})

test('REPOSITION asks for a new origin and gives up when the meter empties', () => {
  const searching = beast.createCreature({ state: 'reposition', awareness: 0.5 })
  // the path layer offers an origin and the search resumes (§6.1)
  const offered = beast.creatureStep(searching, DT, { distance: 30, searchPosition: { x: -60, z: 8 }, sounds: [] })
  assert.equal(offered.to, 'stalk')
  assert.deepEqual(offered.creature.lastHeard, { x: -60, z: 8 }, 'STALK commits to the position it was given')
  // STALK is what asks for the new origin in the first place
  const asked = beast.creatureStep(beast.createCreature({ state: 'stalk', awareness: 0.5 }), DT, {
    distance: 30,
    searchExhausted: true,
    sounds: [],
  })
  assert.equal(asked.to, 'reposition')
  // with no offer and a louder stimulus it commits instead of asking
  let hunting = searching
  let committed = null
  for (let i = 0; i < 300 && committed === null; i += 1) {
    const step = beast.creatureStep(hunting, DT, { distance: 30, sounds: [{ kind: 'sprint', distance: 1 }] })
    hunting = step.creature
    if (step.changed) committed = step
  }
  assert.ok(committed, 'a searching creature never committed to a chase')
  assert.equal(committed.from, 'reposition', 'and it must have been the one searching')
  assert.equal(committed.to, 'chase')
  // and the quiet is what makes it give up: below 0.4 there is nothing to search for
  let wandering = searching
  let gaveUp = null
  for (let i = 0; i < 300 && gaveUp === null; i += 1) {
    const step = beast.creatureStep(wandering, DT, { distance: 30, sounds: [] })
    wandering = step.creature
    if (step.changed) gaveUp = step
  }
  assert.ok(gaveUp, 'a searching creature never gave up')
  assert.equal(gaveUp.from, 'reposition')
  assert.equal(gaveUp.to, 'stalk')
  assert.equal(gaveUp.creature.lastHeard, null, 'a wander has no position to commit to')
  assert.ok(gaveUp.awareness < beast.AWARENESS_INVESTIGATE, `gave up at ${gaveUp.awareness}`)
  // a repositioning creature is not a chasing one, whatever the distance
  assert.equal(beast.canCapture({ state: 'reposition', awareness: 1 }, 0), false)
})

test('the finale edge cannot fire into or out of Act I (§6.1, §10.2)', () => {
  for (const state of ['stalk', 'reposition', 'chase']) {
    const step = beast.creatureStep(beast.createCreature({ state, awareness: 0.9 }), DT, { distance: 30, finale: true })
    assert.equal(step.to, 'enraged', `${state} should enrage`)
  }
  // and it never rescues a pre-awakening or a banished creature
  for (const state of ['telegraph', 'dormant']) {
    const step = beast.creatureStep(beast.createCreature({ state }), DT, { distance: 30, finale: true })
    assert.equal(step.to, state, `${state} must not be reachable from the finale`)
  }
  // a banish in flight is not cancelled by the finale
  const stunned = beast.creatureStep(
    { ...beast.createCreature({ state: 'stagger', awareness: 0.8 }), staggerSeconds: 1, banishPending: true },
    DT,
    { distance: 30, finale: true, sounds: [] },
  )
  assert.equal(stunned.to, 'stagger', 'a banish in flight is not cancelled by the finale')
  // §10.2: permanent position knowledge, and no decay at all
  const enraged = beast.createCreature({ state: 'enraged' })
  let creature = enraged
  for (let i = 0; i < 600; i += 1) creature = beast.creatureStep(creature, DT, { distance: 200, sounds: [] }).creature
  assert.equal(creature.state, 'enraged', 'it never gives up searching')
  assert.equal(creature.awareness, 1, '§10.2: no awareness decay, it always knows')
  // and it is still banishable, because the hammer has to stay relevant (§10.2)
  const hit = beast.creatureStep({ ...enraged }, DT, { distance: 1, swing: true, sounds: [] })
  assert.equal(hit.swing.result, 'banish')
  assert.equal(hit.swing.flat, true, 'the ladder is ignored, so re-emergence is a flat delay')
})

test('every documented transition is real, and every real transition is documented', () => {
  const observed = new Set([
    ...runCreatureScript(creatureScript()).edges,
    ...runCreatureScript(sightingScript()).edges,
    // §10.5: the flag is run-long, so the two enrage edges the long script
    // cannot reach are asked for from their own states
    ...runCreatureScript(finaleEntryScript(), beast.createCreature({ state: 'stalk' })).edges,
    ...runCreatureScript(finaleEntryScript(), beast.createCreature({ state: 'reposition' })).edges,
    ...runCreatureScript(finaleEntryScript(), beast.createCreature({ state: 'chase', awareness: 1 })).edges,
  ])
  const documented = new Set(beast.TRANSITIONS.map((row) => `${row.from}>${row.to}`))
  for (const edge of documented) {
    assert.ok(observed.has(edge), `TRANSITIONS documents ${edge}, which the machine never does. Observed: ${[...observed].join(' ')}`)
    assert.ok(beast.CREATURE_STATES.includes(edge.split('>')[0]), `${edge} starts outside the state list`)
    assert.ok(beast.CREATURE_STATES.includes(edge.split('>')[1]), `${edge} ends outside the state list`)
  }
  for (const edge of observed) {
    assert.ok(documented.has(edge), `the machine takes ${edge}, which TRANSITIONS does not document`)
  }
  assert.equal(observed.size, documented.size, 'the two descriptions of the machine disagree')
  // no duplicates in the table either: one row per edge, or the check above lies
  assert.equal(documented.size, beast.TRANSITIONS.length, 'TRANSITIONS has a duplicated row')
})

test('a chase survives a lapse of noise instead of flickering (the 0.8 release)', () => {
  // the commit threshold and the release threshold are different numbers, and the
  // release one is §6.2's own investigate ceiling
  assert.equal(beast.AWARENESS_CHASE_RELEASE, 0.8)
  assert.ok(beast.AWARENESS_CHASE_RELEASE < beast.AWARENESS_CHASE)
  assert.ok(beast.AWARENESS_CHASE_RELEASE > beast.AWARENESS_INVESTIGATE)
  // a chase that is tracking a sprinting player must not drop out between strides
  let creature = beast.createCreature({ state: 'chase', awareness: 1 })
  for (let at = 0; at < 240; at += 1) {
    const step = beast.creatureStep(creature, DT, {
      distance: 6,
      sounds: at % SPRINT_STRIDE_FRAMES === 0 ? [{ kind: 'sprint', distance: 6 }] : [],
    })
    assert.equal(step.to, 'chase', `the chase flickered to ${step.to} on frame ${at}`)
  }
  // and it releases on the documented frame, not a stride later
  creature = beast.createCreature({ state: 'chase', awareness: beast.AWARENESS_CHASE_RELEASE })
  const held = beast.creatureStep(creature, DT, { distance: 60, seen: true, sightDistance: 60, sightRange: 14 })
  assert.equal(held.to, 'chase', 'exactly at the release threshold is still a chase')
  assert.equal(beast.creatureStep(creature, DT, { distance: 60, sounds: [] }).to, 'stalk')
  // silence is what gets it out of the chase, and the meter says how long that is
  creature = beast.createCreature({ state: 'chase', awareness: 0.95 })
  let heldFrames = 0
  while (heldFrames < 600) {
    const step = beast.creatureStep(creature, DT, { distance: 60, sounds: [] })
    creature = step.creature
    heldFrames += 1
    if (step.to !== 'chase') break
  }
  assert.equal(creature.state, 'stalk')
  assert.ok(heldFrames > 30, `silence released the chase after only ${heldFrames} frames`)
  const expected = (0.95 - beast.AWARENESS_CHASE_RELEASE) / beast.AWARENESS_DECAY_PER_SEC
  assert.ok(Math.abs(heldFrames * DT - expected) < 0.05, `released after ${(heldFrames * DT).toFixed(2)}s, expected ${expected.toFixed(2)}s`)
  assert.ok((1 - beast.AWARENESS_CHASE_RELEASE) / beast.AWARENESS_DECAY_PER_SEC < 2, 'a chase must be losable')
  // §8.2: the chase clock runs while it is chasing, and slice 07 is what ends it.
  // The meter here is pinned by sight, so nothing else can end this chase — which
  // is exactly the situation the pressure valve exists for.
  creature = beast.createCreature({ state: 'chase', awareness: 1 })
  for (let i = 0; i < 720; i += 1) {
    creature = beast.creatureStep(creature, DT, { distance: 6, seen: true, sightDistance: 6 }).creature
  }
  assert.equal(creature.state, 'dormant', 'a chase that cannot be shaken off must phase out')
  assert.equal(creature.awareness, 0)
  assert.equal(creature.chaseSeconds, 0, 'and the clock is reset by the phase-out, not left running')
})

test('a scripted event sequence replays byte-identically (§15.3)', () => {
  const script = creatureScript()
  const first = runCreatureScript(script)
  const second = runCreatureScript(script)
  const encode = new TextEncoder()
  // byte-identical, not "close enough": the whole trace, encoded
  assert.deepEqual(encode.encode(second.trace), encode.encode(first.trace), 'the trace drifted on replay')
  assert.ok(first.frames > 2000, `the scripted run is only ${first.frames} frames long`)
  // and it survives other work happening in between, which is where a
  // module-level cache or a leaked global would show up
  hood.placeObjectives(4242, 7)
  beast.awarenessStep(0.5, 1, { sounds: [{ kind: 'sprint', distance: 2 }] })
  beast.creatureStep(beast.createCreature(), DT, { hammerPickup: true, sighting: true })
  runCreatureScript(sightingScript())
  const third = runCreatureScript(script)
  assert.deepEqual(encode.encode(third.trace), encode.encode(first.trace), 'other work changed the trace')
  // the comparison means something only if the trace depends on the sequence:
  // reordered frames, one extra noise event, and a swing that lands half a metre
  // too far must each change it
  const reversed = runCreatureScript(script.slice().reverse())
  assert.notDeepEqual(encode.encode(reversed.trace), encode.encode(first.trace), 'the trace ignored the order')
  const nudge = 400
  const noised = script.map((entry, i) =>
    i === nudge ? { ...entry, frame: { ...entry.frame, sounds: [{ kind: 'toll', distance: 1 }] } } : entry,
  )
  assert.notDeepEqual(encode.encode(runCreatureScript(noised).trace), encode.encode(first.trace), 'one event changed nothing')
  // a swing that lands half a metre too far is a miss, and a miss is a different run
  const swingAt = script.findIndex((entry) => entry.label === 'swing connects')
  const missed = script.map((entry, i) =>
    i === swingAt ? { ...entry, frame: { ...entry.frame, distance: beast.BANISH_RANGE + 1 } } : entry,
  )
  assert.notDeepEqual(encode.encode(runCreatureScript(missed).trace), encode.encode(first.trace), 'a missed swing changed nothing')
  // and the tier the world carries makes no difference here, because the meter
  // reads no tier-dependent constant: the §11.1 ramp and the §11.2 ladder arrive
  // in full in slice 07 as `detectionRange(tier, reemergenceCount)`, which the
  // world resolves and hands in per frame as `sightRange`
  const tiered = runCreatureScript(script, beast.createCreature({ state: 'telegraph', tier: 3 }))
  assert.deepEqual(encode.encode(tiered.trace), encode.encode(first.trace), 'the tier leaked into the meter')
  // which is not the same as saying range is ignored — it is an input, and the
  // run above never relies on it (the player is not seen outside Act I), so it
  // gets its own script here
  const watching = (range) =>
    runCreatureScript(
      Array.from({ length: 60 }, (i, at) => ({ at, label: 'watched', frame: { distance: 8, seen: true, sightDistance: 8, sightRange: range } })),
      beast.createCreature({ state: 'stalk' }),
    )
  const near = watching(14)
  const tiered3 = watching(3)
  assert.ok(
    near.creature.awareness > tiered3.creature.awareness,
    `tier 1 saw ${near.creature.awareness.toFixed(4)}, tier 0 saw ${tiered3.creature.awareness.toFixed(4)}`,
  )
  assert.notDeepEqual(encode.encode(tiered3.trace), encode.encode(near.trace))
})

test('the scripted run tells the §6 and §7 story without breaking a rule', () => {
  const run = runCreatureScript(creatureScript())
  const at = (label) => run.history.find((row) => row.label === label)
  const awake = at('hammer pickup')
  // §8.1: everything before the hammer is inert, whatever the player does
  for (const row of run.history.filter((entry) => entry.at < awake.at)) {
    assert.equal(row.from, 'telegraph', `frame ${row.at} left Act I early`)
    assert.equal(row.awareness, 0, `frame ${row.at} learned something in Act I`)
    assert.equal(row.captured, false, `frame ${row.at} was a capture in Act I`)
  }
  // §7.2: the toll is the awakening, and it costs the player nothing
  assert.equal(awake.from, 'telegraph')
  assert.equal(awake.to, 'stalk')
  assert.equal(awake.creature.hammerToll, true)
  assert.equal(run.history[awake.at + 1].level, 'unaware', 'the awakening is not a sighting')
  // §6.2: the hunt escalates — sprinting brings it to a chase, silence loses it
  const firstInvestigate = run.history.find((row) => row.level === 'investigate')
  assert.ok(firstInvestigate.at > awake.at, 'it was investigating before the hammer')
  // and the quiet option is a real one: five seconds of walking at 4 m does not
  // even reach the investigate band, which is what "kill your footsteps" means
  const quiet = run.history.filter((row) => row.label === 'walking quietly')
  assert.ok(quiet.length > 200, 'the walk phase is too short to prove anything')
  for (const row of quiet) {
    assert.equal(row.to, 'stalk', 'walking quietly started something')
    assert.equal(row.level, 'unaware', `walking quietly reached ${row.level} at ${row.awareness.toFixed(3)}`)
  }
  const firstChase = run.history.find((row) => row.to === 'chase')
  assert.ok(firstChase.at > firstInvestigate.at, 'it chased before it investigated')
  assert.equal(firstChase.awareness, 1, 'and a chase is entered at exactly 1.0')
  assert.ok(firstChase.from === 'stalk' || firstChase.from === 'reposition')
  const losingIt = run.history.find((row) => row.at > firstChase.at && row.from === 'chase' && row.to === 'stalk')
  assert.ok(losingIt, 'the chase never ended')
  assert.ok(losingIt.awareness < beast.AWARENESS_CHASE_RELEASE, `released at ${losingIt.awareness}`)
  assert.equal(losingIt.heard.length, 0, 'and it ended because the player went quiet')
  // §7.4: every connected swing ends in a banish, and the banish completes
  const swings = run.history.filter((row) => row.swing && row.swing.result === 'banish')
  assert.equal(swings.length, 6, 'the run contains six connected swings')
  for (const swing of swings) {
    assert.equal(swing.to, 'stagger', `frame ${swing.at}: a banish that did not stagger`)
    const banishEnd = run.history.find((row) => row.at > swing.at && row.to === 'dormant')
    assert.ok(banishEnd, `frame ${swing.at}: a banish that never completed`)
    const between = run.history.filter((row) => row.at > swing.at && row.at < banishEnd.at)
    for (const row of between) {
      assert.equal(row.to, 'stagger', `frame ${row.at}: it was hunting during its own banish`)
      assert.equal(row.captured, false, `frame ${row.at}: caught during the recoil`)
    }
  }
  // §9.1: a banish does not advance the capture counter, and this run never
  // caught anybody at all. Six banishes, six re-emergences, and one of the six is
  // the §8.2 phase-out's rather than a swing's — the run ends on its last banish.
  assert.ok(run.history.every((row) => row.captured === false), 'the scripted player was caught')
  assert.equal(run.creature.reemergenceCount, 6, 'six re-emergences for six banishes')
  // §10.2: the finale takes the knowledge away for good
  const finale = at('the third portal')
  assert.equal(finale.to, 'enraged')
  const afterFinale = run.history.filter((row) => row.at > finale.at)
  assert.ok(afterFinale.length > 0)
  for (const row of afterFinale) {
    if (row.to === 'enraged') assert.equal(row.awareness, 1, `frame ${row.at}: an enraged creature forgot`)
  }
  // and the run ends banished rather than mid-hunt, with the meter empty
  assert.equal(run.creature.state, 'dormant')
  assert.equal(run.creature.awareness, 0)
})

// ---------------------------------------------------------------------------
// v2 slice 07 — street-graph pathing and the two ladders
// ---------------------------------------------------------------------------

/** The player positions a re-emergence has to work around: streets, and lots. */
const REEMERGE_SPOTS = [
  { x: 0, z: 0, yaw: 0 },
  { x: -192, z: -192, yaw: 1.2 },
  { x: 96, z: -32, yaw: 3.9 },
  { x: 32, z: 32, yaw: -2.4 },
  { x: 9, z: 9, yaw: 0.7 },
  { x: -40, z: 120, yaw: 2.2 },
  { x: 168, z: 168, yaw: 5.1 },
]

section('Pathing and the two ladders (v2 slice 07)')

test('the slice 07 constants match the design', () => {
  assert.equal(beast.CHASE_MAX_SECONDS, 12, '§8.2 puts CHASE_MAX_SECONDS at ~12 s')
  assert.equal(beast.REEMERGE_MIN_GRAPH_DISTANCE, 2, '§8.3 promises a distance, not a next street')
  // §7.4's table, cell for cell, cap included
  assert.deepEqual([...beast.BANISH_TABLE], [8, 12, 16, 20, 24])
  assert.equal(beast.BANISH_DURATION_CAP, 24)
  assert.equal(beast.BANISH_TABLE[beast.BANISH_TABLE.length - 1], beast.BANISH_DURATION_CAP)
  // §11.1's ramp, row for row
  assert.deepEqual(
    beast.RAMP_TABLE.map((row) => [row.portals, row.speed, row.sight]),
    [[0, 2.2, 14], [1, 2.8, 17], [2, 3.4, 20], [3, 5.2, Infinity]],
  )
  // and the player's own gaits, because §8.6 and §11.2 are both about them
  assert.equal(beast.PLAYER_WALK_SPEED, 3.6)
  assert.equal(beast.PLAYER_SPRINT_SPEED, 6.0)
  assert.ok(
    beast.SPEED_CEILING < beast.PLAYER_SPRINT_SPEED,
    '§8.6: the player must always be able to outrun it',
  )
  assert.equal(beast.SPEED_CEILING, beast.RAMP_TABLE[3].speed, 'the ceiling is the enraged speed, no more')
  // an encounter has to fit inside one chase window, or the §8.2 valve would
  // answer every encounter before the player could swing at it
  assert.ok(beast.HUNT_SECONDS_PER_ENCOUNTER > beast.STAGGER_SECONDS)
  assert.ok(
    beast.HUNT_SECONDS_PER_ENCOUNTER < beast.CHASE_MAX_SECONDS,
    'a whole encounter must fit inside CHASE_MAX_SECONDS',
  )
  // and §16.3's open question is answered at its documented candidate
  assert.equal(beast.ENRAGED_REEMERGENCE_SECONDS, 1.5)
})

test('every street routes to every street, by the shortest walk', () => {
  let longest = 0
  let seamRoutes = 0
  for (let from = 0; from < hood.INTERSECTIONS; from += 1) {
    for (let to = 0; to < hood.INTERSECTIONS; to += 1) {
      const route = beast.streetRoute(from, to)
      const label = `${from} -> ${to}`
      assert.ok(route.length > 0, `${label} is unreachable on a connected torus`)
      assert.equal(route[0], from, `${label} starts at the wrong end`)
      assert.equal(route[route.length - 1], to, `${label} ends at the wrong place`)
      // a connected walk: every hop is a real edge of the wrapped graph
      for (let i = 1; i < route.length; i += 1) {
        assert.ok(hood.STREET_ADJ[route[i - 1]].includes(route[i]), `${label} teleports at hop ${i}`)
      }
      assert.equal(new Set(route).size, route.length, `${label} visits a node twice`)
      // and the shortest one, checked against the graph's own BFS
      assert.equal(route.length - 1, hood.streetPathLength(from, to), `${label} is not a shortest walk`)
      assert.equal(beast.graphDistance(from, to), route.length - 1, label)
      assert.equal(beast.graphMetres(from, to), (route.length - 1) * hood.BLOCK, label)
      longest = Math.max(longest, route.length - 1)
      if (route.some((id) => {
        const node = hood.streetNodeCoords(id)
        return node.ax === 0 || node.az === 0
      })) seamRoutes += 1
    }
  }
  // 7 x 7 torus: the far corner is three blocks the other way, not 448 m away
  assert.equal(longest, 6, 'the diameter of a 7 x 7 torus is 6 hops')
  assert.ok(seamRoutes > 1000, `only ${seamRoutes} routes cross the wrap seam`)
  assert.deepEqual(beast.streetRoute(7, 7), [7], 'already there is a route of length one')
})

test('nextHop closes exactly one step of distance, so a route always arrives', () => {
  assert.equal(beast.nextHop(5, 5), null, 'already there is no next hop')
  assert.equal(beast.graphDistance(5, 5), 0)
  for (let from = 0; from < hood.INTERSECTIONS; from += 1) {
    for (let to = 0; to < hood.INTERSECTIONS; to += 1) {
      if (from === to) continue
      const hop = beast.nextHop(from, to)
      const here = beast.graphDistance(from, to)
      assert.equal(beast.graphDistance(hop, to), here - 1, `${from} -> ${to}: the hop did not close the gap`)
      assert.equal(beast.graphDistance(hop, to), hood.streetPathLength(hop, to), 'the hop is not on a shortest path')
    }
  }
  // and following the hops arrives: the contract the view layer runs every frame,
  // checked end to end once
  let cursor = 0
  let steps = 0
  while (cursor !== 45) {
    const next = beast.nextHop(cursor, 45)
    assert.ok(next !== null, `stuck at ${cursor}`)
    cursor = next
    steps += 1
    assert.ok(steps <= 6, 'a walk that does not arrive is not a route')
  }
  assert.equal(steps, beast.graphDistance(0, 45))
})

test('in a wrapping world, far means nothing (the wrap the pathing rests on)', () => {
  // the classic failure this file exists to prevent: treating a torus as a plane,
  // which makes the creature walk 400 m the long way round to a node 48 m behind
  assert.equal(beast.wrapDelta(200, -200), -48)
  assert.equal(beast.wrapDelta(-200, 200), 48)
  assert.equal(beast.wrapDelta(0, 0), 0)
  assert.equal(beast.wrapDelta(224, 0), 224, 'antipodal points are exactly half a world apart either way')
  for (let a = -600; a <= 600; a += 7) {
    for (const b of [-300, -1, 0, 1, 224, 300]) {
      const delta = beast.wrapDelta(a, b)
      assert.ok(Math.abs(delta) <= hood.WORLD_EXTENT / 2, `wrapDelta(${a}, ${b}) = ${delta} is off the torus`)
    }
  }
  // snapping is done on the torus, so a point ten kilometres outside the world
  // resolves to the node its wrapped twin does.
  //
  // SLICE 15: these spots are WORLD positions, which is the frame `nodeId` and
  // `nearestIntersection` read — the player's body never wraps, so a live caller
  // never has a canonical one to give. They used to be read as canonical, which is
  // the mistake the balance simulation found: differencing a world coordinate
  // against the canonical node table lets `wrapDelta` fold the frame offset away
  // along with the wrap, and the answer comes back three blocks out. So the
  // distance is now measured in the canonical frame, which is where the node table
  // lives, and the fold itself is pinned by the loop underneath.
  for (const spot of REEMERGE_SPOTS) {
    const there = beast.nearestIntersection(spot)
    const wrapped = beast.nearestIntersection({ x: spot.x + hood.WORLD_EXTENT * 3, z: spot.z - hood.WORLD_EXTENT * 5 })
    assert.equal(wrapped, there, 'a point outside the world must resolve like its wrapped twin')
    // and it really is the closest node, measured the short way round
    const canonical = { x: hood.canonicalCoord(spot.x), z: hood.canonicalCoord(spot.z) }
    let best = Infinity
    for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
      const node = hood.streetNodeToWorld(id)
      best = Math.min(best, Math.hypot(beast.wrapDelta(canonical.x, node.x), beast.wrapDelta(canonical.z, node.z)))
    }
    assert.ok(best <= hood.BLOCK, `snapped ${best.toFixed(1)} m from the nearest node`)
  }
  // a point on an intersection snaps to itself, and a node id stays a node id.
  // The intersection is named canonically and handed over in the player's frame,
  // which is the one crossing the whole seam story turns on: `worldPointOf` and
  // `canonicalCoord` are inverses inside the window, and a node is a torus point,
  // so every intersection resolves to itself from *any* copy of the world.
  for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
    const here = hood.worldPointOf(hood.streetNodeToWorld(id))
    assert.equal(beast.nearestIntersection(here), id, `node ${id} does not resolve to itself`)
    for (const periods of [-2, -1, 1, 3]) {
      const elsewhere = {
        x: here.x + hood.WORLD_EXTENT * periods,
        z: here.z - hood.WORLD_EXTENT * periods,
      }
      assert.equal(beast.nearestIntersection(elsewhere), id, `node ${id} moved ${periods} periods and stopped being itself`)
    }
  }
  assert.equal(beast.nearestIntersection(hood.intersectionToWorld(3, 5)), hood.streetNodeId(6, 1), 'and a canonical point handed over unfolded lands three blocks north-east, which is the bug')
  assert.equal(beast.nearestIntersection(hood.worldPointOf(hood.intersectionToWorld(-4, 9))), hood.streetNodeId(3, 2), 'while its world copy folds to the node itself')
  assert.equal(beast.nodeId(11), 11)
  assert.equal(beast.nodeId(-1), 48, 'a negative node id folds like a negative coordinate')
  assert.equal(beast.nearestIntersection(null), 0, 'and no question is a question about node 0')
  // the straight-line cost of the distance floor: two hops can be as close as one
  // diagonal block, and that is still further than anything can see
  let closest = Infinity
  for (let a = 0; a < hood.INTERSECTIONS; a += 1) {
    for (let b = 0; b < hood.INTERSECTIONS; b += 1) {
      if (beast.graphDistance(a, b) !== beast.REEMERGE_MIN_GRAPH_DISTANCE) continue
      closest = Math.min(closest, beast.distanceBetween(hood.streetNodeToWorld(a), hood.streetNodeToWorld(b)))
    }
  }
  assert.ok(
    Math.abs(closest - hood.BLOCK * Math.SQRT2) < 1e-6,
    `two hops can be as close as ${closest.toFixed(2)} m`,
  )
  assert.ok(closest > 4 * beast.detectionRange(2, 0), '§8.3: never inside a detection range, even the last one')
})

test('nearestImage puts a canonical point in the copy the player is nearest to', () => {
  // THE SIXTH FRAME BUG, and the one the balance simulation found by refusing to
  // believe its own numbers. `creaturePosition` is canonical and the walk moves it
  // by folded deltas, so a chase across the seam walks the creature clean out of the
  // window it is drawn in: one whole 448 m period from the copy the player is
  // standing in, with `wrapDelta` correctly reporting the two as coincident and
  // `worldOf` drawing the figure 448 m away on the far side of the map. Every
  // distance the world derives from the pair then reads a period of nothing —
  // `CAPTURE_RADIUS`, `BANISH_RANGE`, the awareness meter, §6.4's breath — which is
  // how an ENRAGED creature spent 508 s standing inside a player that the game could
  // not see. This is the fold that fixes it, and it is pure, so it is pinned here.
  const EXTENT = hood.WORLD_EXTENT
  for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
    const node = hood.streetNodeToWorld(id)
    // a point already in the window, with the player standing on it, is itself
    const onIt = hood.nearestImage(node, node)
    assert.ok(
      Math.hypot(beast.wrapDelta(onIt.x, node.x), beast.wrapDelta(onIt.z, node.z)) < 1e-9,
      `node ${id} moved when the player was standing on it`,
    )
    // IDEMPOTENT, which is what makes it safe to apply every frame: folding an
    // already folded point is itself, so the position cannot drift.
    for (const periods of [-2, -1, 1, 3]) {
      const away = hood.nearestImage(
        { x: node.x + EXTENT * periods, z: node.z - EXTENT * periods },
        node,
      )
      assert.ok(
        Math.hypot(beast.wrapDelta(away.x, node.x), beast.wrapDelta(away.z, node.z)) < 1e-9,
        `node ${id}, ${periods} periods out, did not fold onto the player`,
      )
    }
  }
  // and it is the NEAREST image, not merely a nearer one: the fold may put the
  // point outside the canonical window, and the answer must be the image at most a
  // half period away in both axes — which is the property `worldOf` then inherits,
  // because the view's origin is a whole-period shift of the player's own.
  for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
    const node = hood.streetNodeToWorld(id)
    for (const target of [0, 17, 64, 200, -150, 300]) {
      const player = { x: node.x + target, z: node.z - target * 0.5 }
      const image = hood.nearestImage({ x: node.x + EXTENT * 2, z: node.z - EXTENT * 3 }, player)
      const got = Math.hypot(beast.wrapDelta(image.x, player.x), beast.wrapDelta(image.z, player.z))
      let best = Infinity
      for (const periods of [-1, 0, 1]) {
        const candidate = { x: node.x + EXTENT * periods, z: node.z }
        best = Math.min(
          best,
          Math.hypot(beast.wrapDelta(candidate.x, player.x), beast.wrapDelta(candidate.z, player.z)),
        )
      }
      assert.ok(got <= best + 1e-9, `node ${id} at ${target} m: ${got.toFixed(1)} m away, and ${best.toFixed(1)} m was available`)
      assert.ok(got <= hood.WORLD_HALF + 1e-9, `node ${id} at ${target} m: ${got.toFixed(1)} m is over a half period away`)
    }
  }
  // the player's own wrap cannot change the answer, because `canonicalCoord` is a
  // function of the position alone: a player two periods east folds to the same place
  const node = hood.streetNodeToWorld(5)
  const base = hood.nearestImage({ x: node.x + EXTENT, z: node.z }, node)
  for (const periods of [-3, -1, 1, 4]) {
    const moved = hood.nearestImage(
      { x: node.x + EXTENT, z: node.z },
      { x: node.x + EXTENT * periods, z: node.z },
    )
    assert.ok(
      Math.hypot(beast.wrapDelta(moved.x, base.x), beast.wrapDelta(moved.z, base.z)) < 1e-9,
      `the player moving ${periods} periods changed which copy the creature is in`,
    )
  }
})

test('the creature walks streets, and the graph never asks it to walk a diagonal', () => {
  // §6.1 routes along the streets, so every edge has to BE a street: two adjacent
  // nodes share an axis, and the run between them sits on a road centreline. This
  // is also the invariant that makes pathing need no obstacle avoidance, because
  // slice 04's rule 1 keeps every fixture clear of both centrelines.
  for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
    const here = hood.streetNodeToWorld(id)
    const hereCoords = hood.streetNodeCoords(id)
    for (const next of hood.STREET_ADJ[id]) {
      const there = hood.streetNodeToWorld(next)
      const thereCoords = hood.streetNodeCoords(next)
      assert.ok(
        hereCoords.az === thereCoords.az || hereCoords.ax === thereCoords.ax,
        `edge ${id} -> ${next} changes both axes`,
      )
      const middle = { x: (here.x + there.x) / 2, z: (here.z + there.z) / 2 }
      assert.ok(
        distanceToNearestRoad(middle.x, middle.z) < 1e-6,
        `the middle of edge ${id} -> ${next} is not on a road`,
      )
    }
    // and the node itself is on a centreline, which is what makes the placement
    // rule's "at a distance" mean distance
    assert.ok(distanceToNearestRoad(here.x, here.z) < 1e-6, `node ${id} is off the grid`)
  }
  assert.equal(beast.routePositions(beast.streetRoute(0, 1)).length, 2, 'positions mirror the node route')
  assert.equal(beast.routePositions(beast.streetRoute(0, 24)).length, 7, 'a diagonal is six blocks, not one')
  assert.deepEqual(beast.routePositions(null), [])
})

test('REPOSITION asks for a new street, never the one it just left (§6.1)', () => {
  const from = 0
  const avoid = 24
  const previous = 7
  const toward = beast.nextHop(from, avoid)
  const seen = new Set()
  for (let count = 0; count < 12; count += 1) {
    const origin = beast.searchOrigin({ from, avoid, previous, seed: 1337, count })
    assert.equal(origin.from, from)
    assert.ok(hood.STREET_ADJ[from].includes(origin.id), 'a search origin must be one street away')
    assert.notEqual(origin.id, previous, 'it must not go back where it came from')
    assert.notEqual(origin.id, toward, 'and not back down the street it was working out')
    assert.equal(origin.hopsToTarget, beast.graphDistance(origin.id, avoid))
    assert.deepEqual(origin.position, hood.streetNodeToWorld(origin.id))
    // deterministic, and it moves around: twelve searches are not one street
    assert.deepEqual(
      beast.searchOrigin({ from, avoid, previous, seed: 1337, count }),
      origin,
      'a search origin is a function of (from, avoid, previous, seed, count)',
    )
    seen.add(origin.id)
  }
  assert.ok(seen.size >= 2, `twelve searches visited ${seen.size} street(s)`)
  // with no history to avoid it still has somewhere to go, and with nothing but a
  // last-heard point it still excludes the street toward it
  const blind = beast.searchOrigin({ from, seed: 7 })
  assert.ok(hood.STREET_ADJ[from].includes(blind.id))
  assert.equal(blind.hopsToTarget, null)
  assert.notEqual(beast.searchOrigin({ from, avoid, seed: 7 }).id, toward)
  assert.equal(beast.searchOrigin({ from: hood.worldPointOf(hood.intersectionToWorld(3, 3)), seed: 7 }).from, 24, 'a position is accepted too')
  assert.equal(beast.nodeId(4.9), 4, 'and a fractional id is floored, not used as an index')
})

test('re-emergence is never near and never in sight (§8.3)', () => {
  assert.equal(beast.reemergeNode({}), null, 'no player, no placement')
  // §8.3 in two halves, and both are checked against a world that actually has
  // houses in it: the literal fixture pass, not a synthetic occluder.
  //
  // SLICE 15: the spots are WORLD positions — the player's body never wraps, so
  // that is the frame `reemergeNode` is handed, and it now folds them itself. The
  // two comparisons below that cross the frame do the same fold explicitly, because
  // `distanceBetween` and `canSee` are pure geometry with no opinion about frames
  // and will happily measure 448 m of nothing. `worldPointOf` and `canonicalCoord`
  // are inverses, so the folded player and the returned placement are the same
  // numbers the function used.
  const world = hood.fixturePass(1337, 1)
  assert.ok(world.fixtures.length > 200, `only ${world.fixtures.length} fixtures to hide behind`)
  const seen = new Set()
  let tightest = Infinity
  for (const seed of [1, 2, 3, 7]) {
    for (let count = 0; count < 8; count += 1) {
      for (const spot of REEMERGE_SPOTS) {
        const player = { ...spot }
        const folded = { x: hood.canonicalCoord(spot.x), z: hood.canonicalCoord(spot.z), yaw: spot.yaw }
        const placement = beast.reemergeNode({
          playerPosition: player,
          occluders: world.fixtures,
          seed,
          reemergenceCount: count,
        })
        const label = `seed ${seed}, re-emergence ${count}, player at ${spot.x},${spot.z}`
        // 1. the distance floor, and it is graph distance from the *player's* node
        assert.ok(placement.hops >= beast.REEMERGE_MIN_GRAPH_DISTANCE, `${label}: only ${placement.hops} hops away`)
        tightest = Math.min(tightest, beast.distanceBetween(folded, placement.position))
        // 2. never in line of sight, against the real occluders — and the level
        //    that decided it, so a rule that quietly stopped applying is visible
        assert.equal(placement.level, 'sight', `${label}: hid behind the distance floor instead of a house`)
        assert.equal(placement.sighted, false, `${label}: it re-emerged in a clear line`)
        // and the player cannot see it at any range §11.1 ever offers
        for (let tier = 0; tier < beast.RAMP_TABLE.length; tier += 1) {
          assert.equal(
            beast.canSee(folded, { ...placement.position, yaw: 0 }, {
              range: beast.detectionRange(tier, count),
              occluders: world.fixtures,
            }),
            false,
            `${label}: visible to tier ${tier}`,
          )
        }
        // reproducible, and a function of the count rather than of the clock
        assert.deepEqual(
          beast.reemergeNode({ playerPosition: player, occluders: world.fixtures, seed, reemergenceCount: count }),
          placement,
          `${label}: placement is not deterministic`,
        )
        seen.add(`${count}:${placement.id}`)
      }
    }
  }
  // the hop floor is the guarantee, and in metres it survives the player standing
  // off their own node: a Voronoi cell is 64 m square, so the player is at most
  // BLOCK * sqrt(2) / 2 from it, and 2 hops is at least BLOCK * sqrt(2) from it
  assert.ok(
    tightest >= hood.BLOCK * (Math.SQRT2 / 2) - 1e-6,
    `a re-emergence landed ${tightest.toFixed(1)} m away`,
  )
  assert.ok(seen.size > 20, `only ${seen.size} distinct placements across 224 of them`)
  // with the world stripped away — the degenerate case, nothing to hide behind —
  // the promise still holds, because the cone filter is the one that cannot fail
  let faced = 0
  for (const spot of REEMERGE_SPOTS) {
    for (let count = 0; count < 8; count += 1) {
      const placement = beast.reemergeNode({ playerPosition: { ...spot }, seed: 5, reemergenceCount: count })
      assert.ok(placement.hops >= beast.REEMERGE_MIN_GRAPH_DISTANCE, 'distance holds with no occluders at all')
      assert.equal(placement.level, 'facing')
      if (placement.faced) faced += 1
    }
  }
  assert.equal(faced, 0, "it re-emerged in the player's own sight cone")
  // the floor is a floor: a caller may ask for less, and the filters still answer
  const near = beast.reemergeNode({ playerPosition: { x: 0, z: 0, yaw: 0 }, seed: 1, reemergenceCount: 0, minDistance: 0 })
  assert.equal(near.level, 'facing', 'with no distance floor, the cone is the filter that decides')
  assert.equal(near.faced, false, 'and it still does not appear in front of you')
  assert.ok(beast.reemergeNode({ playerPosition: { x: 0, z: 0 }, minDistance: -4 }).hops >= 0)
  assert.ok(beast.reemergeNode({ playerPosition: { x: 0, z: 0 }, minDistance: NaN }).hops >= 0)
})

test('banishDuration is §7.4\'s table, monotonic, and capped', () => {
  // the table, exactly, including the two rows that are equal because the cap is
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(beast.banishDuration),
    [8, 12, 16, 20, 24, 24, 24, 24],
  )
  // monotonically non-decreasing, over a range far longer than any run
  for (let n = 1; n <= 64; n += 1) {
    const now = beast.banishDuration(n)
    const before = beast.banishDuration(n - 1)
    assert.ok(now >= before, `banish ${n} (${now}s) is shorter than banish ${n - 1} (${before}s)`)
    assert.ok(now <= beast.BANISH_DURATION_CAP, `banish ${n} exceeds the cap`)
    assert.equal(now, beast.banishDuration(n), 'and it is a pure function of its argument')
  }
  // §7.4: the counter is run-long, so the fifth banish is the end of the ladder
  assert.equal(beast.banishDuration(5), beast.BANISH_DURATION_CAP)
  assert.equal(beast.banishDuration(500), beast.BANISH_DURATION_CAP)
  // a count that has not happened yet asks what the first one buys
  assert.equal(beast.banishDuration(0), 8)
  assert.equal(beast.banishDuration(-3), 8)
  assert.equal(beast.banishDuration(NaN), 8)
  assert.equal(beast.banishDuration(Infinity), 8)
  assert.equal(beast.banishDuration(2.9), 12, 'a fractional count is a count that has happened')
  // the ladder is strictly increasing *before* the cap and flat after it, which
  // is the shape §11.3's exposure trend has to be read with. Rung 0 is not a rung:
  // there is no removal before the first swing, so the first step is 0.
  const steps = [1, 2, 3, 4, 5, 6, 7].map((n) => beast.banishDuration(n) - beast.banishDuration(n - 1))
  assert.deepEqual(steps, [0, 4, 4, 4, 4, 0, 0], 'the cap is where the ladder stops paying')
})

test('aggressionAt rises strictly with the re-emergence count (§11.2)', () => {
  let previous = beast.aggressionAt(0)
  assert.deepEqual(previous, { count: 0, speed: 0, sight: 0, delay: beast.REEMERGE_DELAY_CEILING, threat: 0 })
  for (let count = 1; count <= 64; count += 1) {
    const now = beast.aggressionAt(count)
    assert.equal(now.count, count)
    // §11.2: "Each time the creature comes back it is faster" — strictly, so that
    // §11.3's "damage per encounter → increasing" is a fact and not a tendency
    assert.ok(now.speed > previous.speed, `re-emergence ${count} is not faster than ${count - 1}`)
    assert.ok(now.sight > previous.sight, `re-emergence ${count} does not see further than ${count - 1}`)
    // and "...its re-emergence delay is shorter"
    assert.ok(now.delay < previous.delay, `re-emergence ${count} waits longer than ${count - 1}`)
    assert.ok(now.delay >= beast.REEMERGE_DELAY_FLOOR, 'and the delay never reaches zero')
    // threat is the product of a rising and a falling quantity, so it rises
    assert.ok(now.threat > previous.threat, `threat did not rise at ${count}`)
    assert.equal(now.threat, now.speed / now.delay, 'threat is closing speed times return rate')
    assert.deepEqual(now, beast.aggressionAt(count), 'and it is a pure function of its argument')
    previous = now
  }
  // the delay is bounded, so a hundred re-emergences is not an instant return
  assert.ok(beast.aggressionAt(1e6).delay < beast.REEMERGE_DELAY_FLOOR + 0.001, 'the floor is an asymptote')
  // rubbish in is clamped rather than propagated
  assert.deepEqual(beast.aggressionAt(-2), beast.aggressionAt(0))
  assert.deepEqual(beast.aggressionAt(NaN), beast.aggressionAt(0))
  assert.equal(beast.aggressionAt(2.7).count, 2)
  // §10.2: the finale takes the ladder out of the re-emergence delay entirely
  assert.equal(beast.reemergeDelay(0, { enraged: true }), beast.ENRAGED_REEMERGENCE_SECONDS)
  assert.equal(beast.reemergeDelay(40, { enraged: true }), beast.ENRAGED_REEMERGENCE_SECONDS)
  assert.equal(beast.reemergeDelay(40, { flat: true }), beast.ENRAGED_REEMERGENCE_SECONDS)
  // §10.2: the finale takes the ladder out of the re-emergence delay entirely, and
  // what is left is short and constant — the finale banish buys 1.5 s, not a row
  assert.ok(beast.ENRAGED_REEMERGENCE_SECONDS < beast.reemergeDelay(0), 'a flat delay beats a whole ladder')
  assert.ok(beast.ENRAGED_REEMERGENCE_SECONDS >= beast.REEMERGE_DELAY_FLOOR, 'but it is still a delay')
})

test('both axes compose, and neither can outrun the player (§8.6)', () => {
  for (let tier = 0; tier < beast.RAMP_TABLE.length; tier += 1) {
    let previousSpeed = 0
    let previousSight = -Infinity
    for (let count = 0; count <= 12; count += 1) {
      const speed = beast.creatureSpeed(tier, count)
      const sight = beast.detectionRange(tier, count)
      assert.ok(speed >= previousSpeed, `tier ${tier}: pressure axis made it slower`)
      assert.ok(sight >= previousSight, `tier ${tier}: pressure axis shortened its sight`)
      if (count > 0 && Number.isFinite(sight)) {
        assert.ok(sight > previousSight, `tier ${tier}: re-emergence ${count} does not extend its range`)
      }
      assert.ok(speed <= beast.SPEED_CEILING, `tier ${tier}: ${speed} m/s outruns §8.6`)
      assert.ok(speed < beast.PLAYER_SPRINT_SPEED, 'and the player must always be able to leave')
      previousSpeed = speed
      previousSight = sight
    }
    // the progress axis is monotonic in the tier as well
    assert.ok(beast.creatureSpeed(tier, 0) <= beast.creatureSpeed(tier + 1, 0) || tier === 3)
  }
  // the finale's range is infinite and stays infinite, whatever the pressure axis
  assert.equal(beast.detectionRange(3, 0), Infinity)
  assert.equal(beast.detectionRange(3, 999), Infinity)
  assert.equal(beast.creatureSpeed(3, 999), beast.SPEED_CEILING, 'the finale speed is the ceiling')
  // and out-of-range tiers clamp rather than read past the table
  assert.equal(beast.creatureSpeed(99, 0), beast.SPEED_CEILING)
  assert.equal(beast.creatureSpeed(-4, 0), beast.RAMP_TABLE[0].speed)
  assert.equal(beast.detectionRange(NaN, NaN), beast.RAMP_TABLE[0].sight)
  // the axes are additive rather than one blended difficulty, and they stay in a
  // fixed ratio to each other — which is the whole reason §11.2 can be modelled
  // separately from the progress axis at all. The ratio is *derived*, from
  // §11.1's own table and the tuned step, and not written down: slice 15 retuned
  // AGGRESSION_SPEED_STEP from 0.25 to 0.45 because at a quarter of a metre per
  // re-emergence a tier-2 creature walked at 3.4 m/s against a 3.6 m/s walk and could
  // not cross a street in §8.2's twelve-second window, which made the whole of
  // Act II unlosable. Hardcoding the old ratio here is how a tuning pass would
  // have been told it was illegal; deriving it is how the tuning pass stays
  // legal and the relationship stays asserted.
  const tierSteps = [
    beast.RAMP_TABLE[1].speed - beast.RAMP_TABLE[0].speed,
    beast.RAMP_TABLE[2].speed - beast.RAMP_TABLE[1].speed,
  ]
  assert.ok(Math.abs(tierSteps[0] - tierSteps[1]) < 1e-9, '§11.1 is linear in the tier, and the finale is the only row that is not')
  assert.equal(beast.creatureSpeed(0, 3), beast.RAMP_TABLE[0].speed + 3 * beast.AGGRESSION_SPEED_STEP)
  // the two axes are commensurate, and the ratio is a real one: a tier of §11.1
  // is worth `tierSteps[0] / AGGRESSION_SPEED_STEP` re-emergences, so §11.2's ladder
  // is a slower climb than §11.1's and the player can out-pace the second axis
  // with the first
  assert.ok(beast.AGGRESSION_SPEED_STEP > 0 && beast.AGGRESSION_SPEED_STEP <= tierSteps[0], 'a tier is worth at least one re-emergence')
  assert.equal(beast.creatureSpeed(2, 40), beast.SPEED_CEILING, 'and eventually the ceiling, and only then')
  assert.equal(beast.detectionRange(2, 40), beast.RAMP_TABLE[2].sight + 40 * beast.AGGRESSION_SIGHT_STEP, 'range is uncapped')
})

test('a chase cannot last forever (§8.2)', () => {
  // a chase with the meter pinned by sight can end in exactly one way, and this
  // is it: the clock, at CHASE_MAX_SECONDS, and not one frame later
  const frames = Math.round(beast.CHASE_MAX_SECONDS / DT)
  let creature = beast.createCreature({ state: 'chase', awareness: 1 })
  let out = null
  for (let at = 0; at <= frames; at += 1) {
    const step = beast.creatureStep(creature, DT, { distance: 6, seen: true, sightDistance: 6 })
    if (step.phaseOut) out = { at, steps: at + 1, step, previous: creature.state }
    creature = step.creature
  }
  assert.ok(out, 'the phase-out never fired')
  // the 720th frame of the chase is the one that ends it: the clock reads
  // CHASE_MAX_SECONDS exactly on that frame, and `>=` is what makes that the bound
  assert.equal(out.steps, frames, `it ended on frame ${out.steps}, not ${frames}`)
  assert.equal(out.previous, 'chase', 'and the frame before it was still a chase')
  assert.equal(out.step.from, 'chase')
  assert.equal(out.step.to, 'dormant', '§8.2: it returns to DORMANT, elsewhere')
  assert.ok(out.step.chaseSeconds >= beast.CHASE_MAX_SECONDS, 'at the bound, not past it')
  assert.ok(out.step.awareness === 0, 'and it takes the meter with it')
  assert.equal(creature.state, 'dormant')
  assert.equal(creature.chaseSeconds, 0, 'the clock is reset by the phase-out')
  assert.equal(creature.lastSeen, null, 'and so is what it knew')
  // the edge is a documented one, and the scripted run is what proves that the
  // documentation and the machine still describe each other
  assert.ok(
    beast.TRANSITIONS.some((row) => row.from === 'chase' && row.to === 'dormant'),
    'the phase-out edge is missing from TRANSITIONS',
  )
  assert.ok(runCreatureScript(creatureScript()).edges.has('chase>dormant'), 'and the run never takes it')
  // a chase that is shaken off early never reaches the clock at all
  let shaken = beast.createCreature({ state: 'chase', awareness: 1 })
  let phasedOut = false
  for (let at = 0; at < frames - 1; at += 1) {
    const step = beast.creatureStep(shaken, DT, { distance: 60, sounds: [] })
    if (step.phaseOut) phasedOut = true
    shaken = step.creature
  }
  assert.equal(phasedOut, false)
  assert.equal(shaken.state, 'stalk', 'a losable chase is a stalk again')
  // the pressure valve is not a reward: it advances neither ladder
  const valved = out.step.creature
  assert.equal(valved.banishCount, 0, '§7.4: a chase that ran out of clock is not a banish')
  assert.equal(valved.reemergenceCount, 0, 'and it is not a re-emergence either')
  assert.equal(out.step.banishSeconds, beast.BANISH_TABLE[0], 'so the next window is the first one')
  // and the finale has no valve at all (§11.1's last row, §10.2)
  let finale = beast.createCreature({ state: 'enraged' })
  for (let at = 0; at < frames * 3; at += 1) {
    const step = beast.creatureStep(finale, DT, { distance: 200, sounds: [] })
    assert.equal(step.phaseOut, false, `frame ${at}: the finale phase-outs`)
    finale = step.creature
  }
  assert.equal(finale.state, 'enraged', 'thirty-six seconds later it is still coming')
})

test('a banish does not advance the capture counter (§9.2)', () => {
  // the ledger, which is the only place the two counters can be confused: the
  // capture counter moves on `captured` and on nothing else, ever
  let captures = 0
  let banishes = 0
  const ledger = runCreatureScript(creatureScript())
  for (const row of ledger.history) {
    if (row.captured) captures += 1
    if (row.swing && row.swing.result === 'banish') banishes += 1
  }
  assert.equal(banishes, 6, 'the scripted run lands six hammers')
  assert.equal(captures, 0, 'and is never caught, so the counter never moves')
  assert.equal(ledger.creature.banishCount, 6, 'while the banish ladder is on its sixth rung')
  // a single banish, isolated: the ladder moves and the capture counter does not
  const state = rules.createInitialState(hood.placeObjectives(1337, 1))
  const hit = beast.creatureStep(beast.createCreature({ state: 'stalk' }), DT, { distance: 2, swing: true })
  assert.equal(hit.swing.result, 'banish')
  assert.equal(hit.creature.banishCount, 1, '§7.4: the banish ladder advances')
  assert.equal(hit.banishSeconds, beast.banishDuration(1), 'and the window it buys is the first one')
  assert.equal(state.loop, 1, '§9.2: the capture counter is untouched by a banish')
  assert.equal(state.banishCount, 0, 'and so is the run-level copy, which the world mirrors')
  // only a capture moves it, and §9.1 keeps the banish counter across that capture
  const caught = rules.applyCapture({ ...state, banishCount: hit.creature.banishCount, hammerHeld: true })
  assert.equal(caught.loop, 2, 'a capture is the only thing that advances it')
  assert.equal(caught.banishCount, 1, 'while the banish counter survives the reset (§9.1)')
  assert.equal(caught.creature.reemergenceCount, 0, 'and the pressure axis is the thing that resets')
  // a phase-out is a removal too, and it too is not a capture
  const valved = beast.creatureStep(
    beast.createCreature({ state: 'chase', awareness: 1, chaseSeconds: beast.CHASE_MAX_SECONDS - DT }),
    DT,
    { distance: 30 },
  )
  assert.equal(valved.phaseOut, true)
  assert.equal(valved.captured, false, '§8.2 is a relief, not an ending')
  assert.equal(valved.creature.banishCount, 0, 'and it earns nothing')
})

test('a removal takes what it knew with it (§7.4, §8.3)', () => {
  // §7.4: a connected swing is a *full removal*, not a stagger. Anything the
  // creature had worked out goes with it, or "full" is a word and not a rule.
  // `awakened` because this is an Act II creature: §7.2's toll has rung, and the
  // re-emergence below is the one that matters. §8.1's pre-awakening case — a
  // dismissed apparition that never comes back — is asserted in §7.2's own check
  let creature = beast.createCreature({ state: 'chase', awareness: 1, banishCount: 2, awakened: true })
  creature = { ...creature, lastSeen: { x: 4, z: 4 }, lastHeard: { x: 5, z: 5 } }
  const hit = beast.creatureStep(creature, DT, { distance: 2, swing: true })
  assert.equal(hit.to, 'stagger', 'the recoil is not the removal')
  assert.equal(hit.creature.banishCount, 3, 'the banish that caused it advanced the ladder')
  assert.deepEqual(hit.creature.lastSeen, { x: 4, z: 4 }, 'and it still knows things while it reels')
  let done = hit.creature
  for (let at = 0; at < Math.round(beast.STAGGER_SECONDS / DT) + 2; at += 1) {
    done = beast.creatureStep(done, DT, { distance: 60, sounds: [] }).creature
  }
  assert.equal(done.state, 'dormant')
  assert.equal(done.lastHeard, null, '§7.4: what it knew went with it')
  assert.equal(done.lastSeen, null)
  assert.equal(done.awareness, 0)
  assert.equal(done.banishPending, false)
  assert.equal(done.banishCount, 3, 'and the removal itself did not advance the ladder again')
  // and a re-emergence starts from nothing, wherever §8.3 puts it
  const back = beast.creatureStep(done, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(back.to, 'stalk')
  assert.equal(back.creature.reemergenceCount, 1)
  assert.equal(back.creature.lastHeard, null, 'a creature that comes back knowing where you are is a wallhack')
  assert.equal(back.creature.lastSeen, null)
  assert.equal(back.creature.awareness, 0)
  // the window it is owed, and both ends of that window
  // the window it is owed, read off the run-long counter (§7.4), and both ends of it
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => beast.banishWindow({ state: 'dormant', banishCount: n })),
    [8, 12, 16, 20, 24],
    'the window it is owed is §7.4\'s table, read off the banish counter',
  )
  assert.equal(beast.banishWindow(done), 16, 'and this one is owed its own third banish')
  assert.equal(beast.banishWindow({ state: 'dormant', banishCount: 2, finale: true }), beast.ENRAGED_REEMERGENCE_SECONDS)
  assert.equal(beast.banishWindow({ state: 'enraged', banishCount: 9 }), beast.ENRAGED_REEMERGENCE_SECONDS)
  assert.equal(beast.banishWindow(null), beast.BANISH_TABLE[0])
  assert.equal(beast.reemergeReady(done, 15.9), false, 'not one frame early')
  assert.equal(beast.reemergeReady(done, 16), true, 'and the boundary is inclusive')
  assert.equal(beast.reemergeReady(done, 999), true)
  assert.equal(beast.reemergeReady(done, NaN), false, 'an unknown elapsed time is not a finished one')
  assert.equal(beast.banishRemainder(done, 4), 12)
  assert.equal(beast.banishRemainder(done, 40), 0, 'floored at zero, never negative')
  assert.equal(beast.banishRemainder(done, NaN), 16)
})

test('§11.3: less exposure and more threat, sampled across a run', () => {
  // §11.3, in its pure form. The design states two trends and says the gate must
  // prove the net of them; this is that, from the tables, with no simulation —
  // the encounter-by-encounter version arrives in slice 15 and this one stays,
  // because a trend proved from the constants costs nothing to re-check.
  const samples = beast.balanceTrend(8)
  assert.equal(samples.length, 8)
  for (let i = 1; i < samples.length; i += 1) {
    const now = samples[i]
    const before = samples[i - 1]
    const label = `encounter ${now.encounter}`
    // TREND 1: "expected seconds of creature-on-field per encounter → decreasing"
    assert.ok(now.onField <= before.onField, `${label}: more creature on the field than at ${before.encounter}`)
    assert.ok(now.cycle >= before.cycle, `${label}: the cycle got shorter`)
    // TREND 2: "damage per encounter → increasing"
    assert.ok(now.threat > before.threat, `${label}: less threat than at ${before.encounter}`)
    assert.ok(now.reemergeDelay < before.reemergeDelay, `${label}: it waited longer than before`)
    // and the rows are the two ladders, not a copy of them
    assert.equal(now.banishSeconds, beast.banishDuration(now.banishes))
    assert.equal(now.threat, beast.threatPerEncounter(now.reemergences))
  }
  // the first trend is *strict* before the cap and flat at it: 8, 12, 16, 20, 24,
  // 24 — §7.4's cap is exactly the reason exposure stops falling
  const exposures = samples.map((row) => row.onField)
  for (let i = 1; i < beast.BANISH_TABLE.length; i += 1) {
    assert.ok(exposures[i] < exposures[i - 1], `exposure did not fall at encounter ${i + 1}, before the cap`)
  }
  assert.equal(exposures[5], exposures[6], 'past the cap the exposure is flat, and that is the cap doing its job')
  assert.ok(exposures[0] > exposures[4], 'across the ladder it nearly halves')
  // the cap's argument, measured rather than asserted (§7.4: "a run-long ladder
  // plus the speed ramp would otherwise walk the game into triviality")
  assert.ok(
    samples[samples.length - 1].threat > samples[4].threat,
    'past the cap the threat is still climbing, so the game is not trivial',
  )
  // the whole run, in one number: the share of a player's seconds spent with the
  // creature in the world falls encounter over encounter
  let runExposure = 0
  let runSeconds = 0
  for (const sample of samples) {
    runExposure += beast.HUNT_SECONDS_PER_ENCOUNTER
    runSeconds += sample.cycle
  }
  assert.ok(runExposure / runSeconds < samples[0].onField, 'the run average beats its first encounter')
  // the trend holds for any plausible hunt length, which is what makes the single
  // constant above safe rather than load-bearing
  for (const hunt of [4, 6, beast.HUNT_SECONDS_PER_ENCOUNTER, 11, 11.9]) {
    const shares = [1, 2, 3, 4, 5, 6].map((n) => beast.onFieldShare(hunt, n))
    for (let i = 1; i < shares.length; i += 1) assert.ok(shares[i] <= shares[i - 1], `hunt ${hunt}s: exposure rose`)
    assert.ok(shares[4] < shares[0], `hunt ${hunt}s: the ladder did nothing`)
  }
  assert.equal(beast.onFieldShare(9, 1), 9 / 17)
  assert.equal(beast.onFieldShare(0, 1), 0, 'no hunt is no exposure')
  assert.equal(beast.encounterCycleSeconds(9, 7), 33, 'a capped banish is still 24 s of banish')
  // and a run that is *not* a clean sequence of banishes is the one the numbers
  // are pessimistic about, which is the direction §11.3 wants: every encounter the
  // player ends with a hammer is an encounter they survived
  assert.ok(beast.balanceTrend(1).length === 1)
  assert.ok(beast.balanceTrend(0).length >= 1, 'a zero-encounter run still samples')
})

// ---------------------------------------------------------------------------
// v2 slice 08 — the player: breath, the lockout, and the two verbs
// ---------------------------------------------------------------------------

section('Player breath and the two verbs (v2 slice 08)')

const PLAYER_SOURCE = readFileSync(new URL('./src/game/player.js', import.meta.url), 'utf8')

/** `_applyCamera` writes to `position.set` / `rotation.set` and nothing else. */
function stubCamera() {
  return { position: { set() {} }, rotation: { set() {} } }
}

/**
 * A headless PlayerController. No DOM element, no renderer, no clock — and the same
 * `pressKey` / `pressButton` door the browser listeners use, so a check cannot pass
 * against a path the game does not take.
 */
function makePlayer(options = {}) {
  return new PlayerController(stubCamera(), null, options)
}

/**
 * Run a player for `frames` at 60 Hz and collect every §6.2 sound event it emitted.
 *
 * @param {PlayerController} player
 * @param {number} frames
 * @param {(frame: number, player: PlayerController) => void} [hold] input per frame
 */
function collectSounds(player, frames, hold = () => {}) {
  const events = []
  for (let frame = 0; frame < frames; frame += 1) {
    hold(frame, player)
    player.update(DT)
    events.push(...player.drainSounds())
  }
  return events
}

function distinct(values) {
  return [...new Set(values)]
}

test('player.js is in the pure harness: no three, and no DOM outside the browser methods', () => {
  // The only reason player.js could not be imported here before was `three`, for
  // two vector objects. If that import comes back, this is the check that says so —
  // a renderer stack has no business in the pure gate.
  assert.equal(/from ['"]three['"]/.test(PLAYER_SOURCE), false, 'player.js imports three again')
  // and the rules it needs are the shared ones, not local copies
  assert.match(PLAYER_SOURCE, /import \{ breathStep \} from '\.\/rules\.js'/)
  assert.match(PLAYER_SOURCE, /import \{ soundRadius, SOUND_EVENT_SECONDS \} from '\.\/creature\.js'/)

  // Nothing above the class may touch the browser: module-scope code is what a node
  // import actually executes, so that is the line that has to hold.
  const head = PLAYER_SOURCE.slice(0, PLAYER_SOURCE.indexOf('export class PlayerController'))
  for (const global of ['window', 'document', 'navigator', 'requestAnimationFrame']) {
    assert.equal(head.includes(global), false, `${global} is reachable at module scope`)
  }
  // the browser surface is the three methods, and the game still calls all of them
  for (const method of ['attach', 'dispose', 'requestLock']) {
    assert.ok(
      new RegExp(`\\n  ${method}\\(`).test(PLAYER_SOURCE),
      `player.js no longer has a ${method}() for the game to call`,
    )
  }
  // the module really is constructible here, which is the live version of all of
  // the above: no renderer, no document, no canvas
  const player = makePlayer()
  assert.equal(player.breath, 1)
  assert.equal(player.exhausted, false)
  assert.equal(player.sounds.length, 0)
  assert.equal(player.pos.clone().z, 0, 'pos must still be clonable — world.js clones it')
  player.teleport(4, -7, 0.5)
  assert.equal(player.pos.z, -7)
})

test('breath integration is rules.breathStep, not a second copy of it', () => {
  // The structural half. §7.3's numbers are defined once, in rules.js; a second copy
  // here would be a tuning change that silently applies to half the game.
  for (const name of [
    'BREATH_DRAIN_PER_SEC',
    'BREATH_RECOVER_PER_SEC',
    'BREATH_RECOVERY_THRESHOLD',
    'EXHAUSTED_BREATH_SOUND_BONUS',
  ]) {
    // a *declaration* is the duplication. Naming a constant in a comment is not.
    assert.equal(
      new RegExp(`(const|let|var)\\s+${name}\\b`).test(PLAYER_SOURCE),
      false,
      `player.js re-declares ${name}`,
    )
  }

  // The behavioural half, which is the one that counts. Drive the controller and
  // integrate the rule independently, over a script that sprints, recovers, locks
  // out and locks back in — the two must agree on every frame, to the bit.
  const player = makePlayer({ breath: 1 })
  let rule = { breath: 1, exhausted: false }
  let sawLockout = false
  let sawRecovery = false
  for (let frame = 0; frame < 1200; frame += 1) {
    const wantsSprint = frame % 120 < 80 // 1.3 s of sprint, 0.67 s of walking
    if (wantsSprint) player.pressKey('ShiftLeft')
    else player.releaseKey('ShiftLeft')
    player.update(DT)

    // the same integration, written out here against rules.js rather than reusing
    // whatever the controller thinks the answer was
    const effective = wantsSprint && !rule.exhausted
    rule = rules.breathStep(rule.breath, rule.exhausted, effective, DT)
    assert.equal(player.breath, rule.breath, `breath drifted on frame ${frame}`)
    assert.equal(player.exhausted, rule.exhausted, `the lockout drifted on frame ${frame}`)
    if (player.exhausted) sawLockout = true
    if (sawLockout && !player.exhausted) sawRecovery = true
  }
  // ...and the script has to have actually exercised both, or the equality above is
  // an equality between two things that never moved
  assert.equal(sawLockout, true, 'the script never exhausted the player')
  assert.equal(sawRecovery, true, 'the script never recovered from a lockout')
  assert.ok(player.breath <= 1 && player.breath >= 0, `breath left [0, 1]: ${player.breath}`)

  // a disabled player is not running a meter at all — pause, the reset wipe and the
  // death freeze all freeze the breath along with everything else
  const frozen = makePlayer({ breath: 0.5 })
  frozen.enabled = false
  for (let frame = 0; frame < 120; frame += 1) frozen.update(DT)
  assert.equal(frozen.breath, 0.5, 'breath drained while the player was disabled')
  assert.equal(frozen.commandSpeed, 0)
})

test('sprint lockout cannot be bypassed by holding the key', () => {
  const player = makePlayer({ breath: 0.05 })
  player.pressKey('ShiftLeft') // and it stays down for the whole check

  let framesToLock = 0
  while (!player.exhausted && framesToLock < 60) {
    player.update(DT)
    framesToLock += 1
  }
  assert.equal(player.exhausted, true, 'sprinting on almost no breath never locked out')
  const expectedFrames = Math.ceil(0.05 / (rules.BREATH_DRAIN_PER_SEC * DT))
  assert.equal(
    framesToLock,
    expectedFrames,
    `lockout took ${framesToLock} frames, expected ${expectedFrames} at the §7.3 drain rate`,
  )
  assert.equal(player.sprinting, false, 'the frame the meter empties still bought a sprint')

  // From here on, holding the key down buys nothing at all. Each of these is a way a
  // careless implementation leaks the lockout: the flag is still true, the speed is
  // still the sprint speed, or the meter is quietly draining again.
  const atLockout = player.breath
  let breach = null
  for (let frame = 0; frame < 300; frame += 1) {
    player.update(DT)
    if (!player.exhausted) continue
    if (player.sprinting) breach ??= `frame ${frame}: still sprinting`
    if (player.commandSpeed > player.walkSpeed) breach ??= `frame ${frame}: sprinting at ${player.commandSpeed} m/s`
    if (player.breath < atLockout - 1e-12) breach ??= `frame ${frame}: breath fell to ${player.breath}`
  }
  assert.equal(breach, null, `holding the key beat the lockout — ${breach}`)

  // The lockout is state, not key state: what decides whether it has lifted is where
  // the meter is, and nothing else.
  assert.equal(
    player.exhausted,
    player.breath < rules.BREATH_RECOVERY_THRESHOLD,
    'the lockout and the recovery threshold disagree',
  )

  // And the speed really was gated, not just the flag: with the key released the
  // player settles at a walk and never at a sprint.
  player.releaseKey('ShiftLeft')
  player.pressKey('KeyW')
  for (let frame = 0; frame < 180; frame += 1) player.update(DT)
  const settled = Math.hypot(player.vel.x, player.vel.y)
  assert.ok(Math.abs(settled - player.walkSpeed) < 1e-3, `settled at ${settled.toFixed(3)} m/s`)
  assert.ok(settled < player.sprintSpeed, 'a locked-out player still moved at sprint speed')
})

test('sprint-bobbing at the bottom of the meter does not buy a sprint (§7.3)', () => {
  // Without hysteresis, mashing the key at 0.01 breath flickers the lockout every
  // frame and hands the player an unlimited sprint out of two alternating inputs.
  // The lockout has to ignore the key until the threshold.
  const player = makePlayer({ breath: 0.34, exhausted: true })
  const startBreath = player.breath
  let drained = null
  let liftedAt = null
  for (let frame = 0; frame < 180; frame += 1) {
    if (frame % 2 === 0) player.pressKey('ShiftLeft')
    else player.releaseKey('ShiftLeft')
    player.update(DT)
    if (player.exhausted && player.breath < startBreath - 1e-12) drained ??= frame
    if (!player.exhausted && liftedAt === null) liftedAt = frame
  }
  assert.equal(drained, null, `bobbing drained the meter during the lockout on frame ${drained}`)
  assert.equal(player.sprinting, false, 'bobbing was sprinting')
  // ...and bobbing must not prevent recovery either. Measured from where the meter
  // actually starts, which is under the threshold, not from zero.
  assert.ok(liftedAt !== null, 'bobbing kept the player locked out forever')
  const expected =
    (rules.BREATH_RECOVERY_THRESHOLD - startBreath) / rules.BREATH_RECOVER_PER_SEC / DT
  assert.ok(
    Math.abs(liftedAt - expected) < 2,
    `bobbing lifted the lockout on frame ${liftedAt}, expected about ${Math.round(expected)}`,
  )
  // The same is true with the key never touched at all: the lock is not a key state.
  const alone = makePlayer({ breath: 0, exhausted: true })
  let held = 0
  while (alone.exhausted && held < 600) {
    alone.update(DT)
    held += 1
  }
  const seconds = rules.BREATH_RECOVERY_THRESHOLD / rules.BREATH_RECOVER_PER_SEC
  assert.ok(
    Math.abs(held * DT - seconds) < DT * 2,
    `an idle lockout lasted ${(held * DT).toFixed(3)}s, expected about ${seconds.toFixed(3)}s`,
  )
})

test('standing still emits no footstep sound event', () => {
  // §6.2: "standing perfectly still emits nothing, so 'kill your footsteps and let it
  // lose you' is a real, learnable strategy." This is the check that the strategy is
  // available at all.
  let audioCalls = 0
  const idle = makePlayer({
    onFootstep: () => {
      audioCalls += 1
    },
  })
  const events = collectSounds(idle, 600) // ten seconds
  assert.equal(events.length, 0, 'ten seconds of standing still produced sound events')
  assert.equal(audioCalls, 0, 'ten seconds of standing still produced footsteps')
  assert.equal(idle.travelled, 0, 'a still player should not accumulate stride distance')
  assert.equal(idle.speedRatio, 0)
  assert.equal(idle.pos.x, 0)
  assert.equal(idle.pos.z, 0)

  // Leaning on something is the same case, and the one a player will actually hit:
  // the key is down, the intent is movement, and the world says no.
  const walled = makePlayer()
  walled.setColliders([{ cx: 0, cz: -2, hx: 8, hz: 0.5 }]) // a wall across −Z, yaw 0 faces it
  const wallFace = -2 + 0.5 + walled.radius
  walled.pressKey('KeyW')
  const blocked = collectSounds(walled, 600)
  assert.equal(blocked.length, 0, 'a player pressed against a wall is not silent')
  assert.ok(walled.pos.z >= wallFace, `the wall was walked through: z=${walled.pos.z}`)
  assert.ok(walled.pos.z < -1, 'the player never reached the wall')
  walled.releaseKey('KeyW')

  // ...and stopping is silence, once the glide to a halt is over. Sprint, release,
  // wait: the coast may stride, because the feet really are still moving, but a
  // player standing still afterwards is the case §6.2 is about.
  const runner = makePlayer()
  const sprinting = collectSounds(runner, 60, (frame, player) => {
    player.pressKey('KeyW')
    player.pressKey('ShiftLeft')
  })
  assert.ok(sprinting.length > 0, 'a sprinting player made no sound at all')
  runner.releaseKey('ShiftLeft')
  runner.releaseKey('KeyW')
  const coasting = collectSounds(runner, 90)
  const stopped = collectSounds(runner, 300)
  assert.equal(stopped.length, 0, 'a stopped player kept making noise')
  assert.ok(Math.hypot(runner.vel.x, runner.vel.y) < 1e-3, 'the player never actually stopped')
  assert.ok(coasting.length <= sprinting.length, 'the glide out-loudened the sprint')
})

test('footsteps and exhausted breathing are priced by the creature sound table', () => {
  // Every radius the player emits is `soundRadius(kind, { exhausted })` — the
  // creature's own table, which is `rules.breathSoundRadius` applied to the §6.2
  // rows. If these ever stop matching, the player and the AI disagree about how loud
  // the player is, and nothing else in the game can catch that.
  const walking = collectSounds(makePlayer(), 120, (frame, player) => player.pressKey('KeyW'))
  assert.ok(walking.length > 0, 'walking produced no footsteps')
  assert.deepEqual(distinct(walking.map((event) => event.kind)), ['walk'])
  assert.deepEqual(distinct(walking.map((event) => event.radius)), [beast.SOUND_RADII.walk])
  assert.equal(walking[0].radius, rules.breathSoundRadius(beast.SOUND_RADII.walk, false))

  const sprinting = collectSounds(makePlayer(), 120, (frame, player) => {
    player.pressKey('KeyW')
    player.pressKey('ShiftLeft')
  })
  assert.ok(sprinting.length > 0, 'sprinting produced no footsteps')
  assert.deepEqual(distinct(sprinting.map((event) => event.kind)), ['sprint'])
  assert.deepEqual(distinct(sprinting.map((event) => event.radius)), [beast.SOUND_RADII.sprint])
  assert.equal(sprinting[0].radius, rules.breathSoundRadius(beast.SOUND_RADII.sprint, false))

  // §7.3: the same gait, six metres louder, because the state is the punishment.
  // One second, so the player is still locked out at the end of it: 0.18 m/s of
  // recovery from zero is still under the 0.35 threshold, so this is one continuous
  // exhausted second rather than a window that straddles the recovery.
  const spent = makePlayer({ breath: 0, exhausted: true })
  const spentWalk = collectSounds(spent, 60, (frame, player) => player.pressKey('KeyW'))
  assert.ok(spentWalk.length > 0, 'an exhausted walk produced no sound')
  assert.equal(spent.exhausted, true, 'the player recovered out of the lockout mid-check')
  assert.deepEqual(distinct(spentWalk.map((event) => event.kind)).sort(), ['still', 'walk'])
  for (const event of spentWalk) {
    assert.equal(event.exhausted, true)
    assert.equal(event.radius, beast.soundRadius(event.kind, { exhausted: true }))
  }
  assert.ok(
    spentWalk.some(
      (event) => event.radius === beast.SOUND_RADII.walk + rules.EXHAUSTED_BREATH_SOUND_BONUS,
    ),
    'the exhausted walk is not six metres louder',
  )
  // The breath event is a different row, not a quieter footstep: a *gait* step while
  // exhausted is never quieter than the same step fresh.
  const spentGait = spentWalk.filter((event) => event.kind !== 'still')
  assert.ok(spentGait.length > 0, 'an exhausted walk emitted no footsteps at all')
  assert.ok(
    !spentGait.some((event) => event.radius < beast.SOUND_RADII.walk),
    'exhaustion made the footsteps quieter, which is the opposite of §7.3',
  )

  // Standing still while spent is the case the design is built around: you have
  // stopped to listen, and it can still hear you.
  const hiding = makePlayer({ breath: 0, exhausted: true })
  const gasps = collectSounds(hiding, 60)
  assert.ok(gasps.length > 0, 'hiding out of breath emitted nothing')
  assert.deepEqual(distinct(gasps.map((event) => event.kind)), ['still'], 'a still player emitted a footstep')
  for (const event of gasps) {
    assert.equal(event.radius, beast.soundRadius('still', { exhausted: true }))
    assert.equal(event.radius, rules.EXHAUSTED_BREATH_SOUND_BONUS, 'the last row of §6.2 is +6 m')
    assert.equal(event.radius, rules.breathSoundRadius(0, true))
  }

  // A continuous source emits one event per integration window, not one per frame.
  const windows = Math.floor((60 * DT) / beast.SOUND_EVENT_SECONDS)
  assert.ok(gasps.length >= windows - 1, `only ${gasps.length} gasps in ${windows} windows`)
  assert.ok(gasps.length <= windows + 1, `${gasps.length} gasps in ${windows} windows`)

  // Fresh, the same standing player is at a radius of zero — which is why nothing is
  // queued at all, and why the table has a 0 in it and not a 1.
  assert.equal(beast.soundRadius('still', { exhausted: false }), 0)

  // The event carries no distance. Only the listener knows where it is, and a
  // player-side distance would be a lie the moment the creature moves.
  for (const event of [...walking, ...sprinting, ...gasps]) {
    assert.equal(event.distance, undefined, 'the player must not invent a distance')
    assert.equal(typeof event.position.x, 'number')
    assert.equal(typeof event.position.z, 'number')
  }

  // The radii a player can ever emit, exhaustively: the three §6.2 rows that belong
  // to the player, fresh and spent. Nothing else is reachable.
  const reachable = new Set()
  for (const kind of ['walk', 'sprint', 'still']) {
    for (const exhausted of [false, true]) reachable.add(beast.soundRadius(kind, { exhausted }))
  }
  for (const event of [...walking, ...sprinting, ...spentWalk, ...gasps]) {
    assert.equal(reachable.has(event.radius), true, `unreachable radius ${event.radius}`)
  }
  assert.deepEqual([...reachable].sort((a, b) => a - b), [0, 6, 9, 15, 22, 28])
})

test('E interacts and LMB swings: two verbs, two keys (§5.2)', () => {
  const player = makePlayer()

  // E is a hold, and it is never a swing.
  player.pressKey('KeyE')
  assert.equal(player.interactHeld(), true)
  assert.equal(player.swingHeld(), false)
  assert.equal(player.consumeSwing(), false, 'E produced a swing')
  for (let frame = 0; frame < 120; frame += 1) player.update(DT) // hold it through the verb
  assert.equal(player.consumeSwing(), false, 'holding E produced a swing')
  player.releaseKey('KeyE')
  assert.equal(player.interactHeld(), false)

  // LMB is a press, and it is never an interact hold.
  player.pressButton(0)
  assert.equal(player.swingHeld(), true, 'button 0 did not map to the swing verb')
  assert.equal(player.interactHeld(), false, 'LMB produced an interact hold')
  assert.equal(player.consumeSwing(), true)
  assert.equal(player.consumeSwing(), false, 'one press produced two swings')

  // Holding the button is not more swings, and neither is keyboard auto-repeat
  for (let frame = 0; frame < 60; frame += 1) {
    player.pressKey('Mouse0')
    player.update(DT)
  }
  assert.equal(player.consumeSwing(), false, 'holding LMB kept swinging')
  player.releaseButton(0)
  assert.equal(player.swingHeld(), false)
  player.pressButton(0)
  assert.equal(player.consumeSwing(), true, 'a second press is a second swing')
  player.releaseButton(0)

  // The two verbs are independent, which is §5.2's whole point: a player committed
  // to a shutdown can still choose to swing, and a player who swings cannot
  // accidentally be holding an interact.
  player.pressKey('KeyE')
  player.pressButton(0)
  assert.equal(player.interactHeld(), true)
  assert.equal(player.swingHeld(), true)
  assert.equal(player.consumeSwing(), true)
  player.releaseKey('KeyE')
  player.releaseButton(0)

  // The callback fires once per consumed swing, and not before it is consumed.
  let swings = 0
  const hooked = makePlayer({
    onSwing: () => {
      swings += 1
    },
  })
  hooked.pressButton(0)
  hooked.pressButton(0)
  hooked.pressButton(0) // three repeat events, one intent
  assert.equal(swings, 0, 'the swing fired on the press instead of on consumption')
  assert.equal(hooked.consumeSwing(), true)
  assert.equal(swings, 1)
  assert.equal(hooked.consumeSwing(), false)
  assert.equal(swings, 1, 'the swing fired twice for one press')

  // the other mouse buttons are not the verb
  const other = makePlayer()
  other.pressButton(1)
  other.pressButton(2)
  assert.equal(other.swingHeld(), false, 'the right button swung the hammer')
  assert.equal(other.interactHeld(), false)
  assert.equal(other.consumeSwing(), false)

  // and no movement key grew a third verb
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ArrowUp']) {
    const walker = makePlayer()
    walker.pressKey(code)
    assert.equal(walker.interactHeld(), false, `${code} raised the interact verb`)
    assert.equal(walker.swingHeld(), false, `${code} raised the swing verb`)
    assert.equal(walker.consumeSwing(), false, `${code} raised the swing verb`)
  }
})

test('scripted run: the same input script produces the same trace (§15.3)', () => {
  // A 510-frame script that walks, sprints into the lockout, stops to listen while
  // out of breath, walks it off, strafes, swings, and stands still again. §15.3
  // wants a scripted-run assertion per subsystem: non-determinism in a benchmark
  // game is a correctness bug even when it looks fine on screen, and this is the
  // trace the balance simulation in slice 15 will lean on.
  const SCRIPT = [
    { frames: 30, keys: ['KeyW'] },
    { frames: 60, keys: ['KeyW', 'ShiftLeft'] },
    { frames: 30, keys: [] }, // stop: half a second of recovery
    { frames: 200, keys: ['KeyW', 'ShiftLeft'] }, // long enough to empty the meter
    { frames: 30, keys: [] }, // out of breath and standing still: the gasping case
    { frames: 60, keys: ['KeyW'] }, // walk it off, and let the lockout lift
    { frames: 30, keys: ['KeyW', 'KeyD'] },
    { frames: 40, keys: [] },
    { frames: 30, keys: ['KeyW'] }, // one swing, pressed on this step's first frame
  ]

  const play = () => {
    const player = makePlayer()
    const trace = []
    for (const step of SCRIPT) {
      for (const code of step.keys) player.pressKey(code)
      for (let frame = 0; frame < step.frames; frame += 1) {
        if (frame === 0 && step.keys.includes('KeyW')) player.pressButton(0)
        player.update(DT)
        player.consumeSwing()
        for (const event of player.drainSounds()) {
          trace.push(`SOUND ${event.kind}@${event.radius} ${event.exhausted ? 'spent' : 'fresh'}`)
        }
        trace.push(
          `FRAME ${player.pos.x.toFixed(9)} ${player.pos.z.toFixed(9)} ${player.breath.toFixed(12)} ` +
            `${player.exhausted ? 1 : 0} ${player.sprinting ? 1 : 0} ${player.commandSpeed.toFixed(6)}`,
        )
      }
      for (const code of step.keys) player.releaseKey(code)
    }
    return trace
  }

  const first = play()
  assert.equal(play().join('\n'), first.join('\n'), 'a replayed input script diverged')
  const soundLines = first.filter((line) => line.startsWith('SOUND'))
  const frameLines = first.filter((line) => line.startsWith('FRAME'))
  assert.equal(frameLines.length, 510, 'the script did not run 510 frames')

  // the script has to have exercised the parts that matter, or the equality above is
  // an equality between two traces that never moved
  assert.ok(soundLines.length > 20, `only ${soundLines.length} sound events in the script`)
  assert.ok(soundLines.includes('SOUND walk@9 fresh'), 'never heard a fresh walk')
  assert.ok(soundLines.includes('SOUND sprint@22 fresh'), 'never heard a fresh sprint')
  assert.ok(soundLines.includes('SOUND walk@15 spent'), 'never heard an exhausted walk')
  assert.ok(soundLines.includes('SOUND still@6 spent'), 'never heard the exhausted player breathe')
  assert.ok(frameLines.some((line) => line.endsWith(' 0 1 6.000000')), 'never sprinted')
  assert.ok(frameLines.some((line) => line.endsWith(' 0 0 3.600000')), 'never walked')
  assert.ok(frameLines.some((line) => line.includes(' 1 0 3.600000')), 'never was locked out and walking')
  // no frame may be both locked out and sprinting, in any replay
  assert.equal(
    frameLines.some((line) => line.includes(' 1 1 ')),
    false,
    'a frame was locked out and sprinting',
  )
  // the run starts at spawn, on a full meter, walking — and ends somewhere else
  assert.ok(
    frameLines[0].endsWith(' 1.000000000000 0 0 3.600000'),
    `the script did not start at spawn on a full meter: ${frameLines[0]}`,
  )
  assert.notEqual(frameLines[frameLines.length - 1], frameLines[0], 'the run ended where it began')
})


// ---------------------------------------------------------------------------
// the creature's presentation and the capture loop (v2 slice 10)
// ---------------------------------------------------------------------------
//
// WHAT IS ASSERTED HERE, AND WHY IT IS HERE AT ALL
// -------------------------------------------------
// Slice 10 is a *world* slice by the V2-PLAN's own gate vocabulary, and its checks
// are supposed to live in `verify-world.mjs` — which does not run, and which slice
// 14 owns. Taken literally that would leave the whole of the creature's visual
// design unverified for five more slices, in a project whose defining constraint
// (§16.1) is that it cannot be playtested.
//
// So the slice splits itself along §15.2's seam on purpose. `creatureView.js` draws,
// and its checks are the world list parked at the bottom of `verify-world.mjs`; the
// *policy* — which state reads as what, how big the eyes must be to survive fog,
// when a removal is visible — is in `creature.js`, because it is numbers, and
// numbers are testable in node today. Every assertion below is about a decision,
// not about a triangle.

section('Creature view and the capture loop (v2 slice 10)')

/**
 * The camera, restated from `world.js` rather than read out of a Three.js object,
 * so this is a specification of the frame and not an echo of the code that reads
 * it: a 72-degree *vertical* field at 16:9, which is what the gate's captures are
 * taken at and therefore what §6.1's edge-of-vision angle is defined against.
 */
const VIEW_FOV = 72
const VIEW_ASPECT = 16 / 9
const VIEW_HALF_FOV = Math.atan(Math.tan((VIEW_FOV * Math.PI) / 360) * VIEW_ASPECT)

/**
 * The closest a §6.1 apparition or a §8.3 re-emergence can ever legally be, in
 * metres: `REEMERGE_MIN_GRAPH_DISTANCE` hops of a 64 m grid taken diagonally, which
 * is the *minimum* straight-line distance the graph allows. Every "reads at
 * distance" claim in this section is measured here, at the worst range the design
 * permits, because a promise checked at 20 m is not a promise at all.
 */
const FARTHEST_EVER = hood.BLOCK * Math.SQRT2 * beast.REEMERGE_MIN_GRAPH_DISTANCE

test('the silhouette is a tall thin figure, built from one set of numbers', () => {
  const S = beast.CREATURE_SHAPE
  // §12.1's silhouette: thin IS the legibility argument, and 7:1 is twice as thin
  // as a person. A body at this ratio still reads at FARTHEST_EVER; a body at a
  // person's 3:1 does not, and the gate is the only place that can say so
  assert.ok(Math.abs(S.height / S.shoulder - 7) < 1e-9, `the figure is ${(S.height / S.shoulder).toFixed(3)}:1, not 7:1`)
  assert.ok(S.shoulder < 0.5, 'and that means genuinely narrow, not "roughly narrow"')
  // the parts add up to the height, so the rig cannot be built twice and disagree
  assert.ok(Math.abs(S.legLength + S.torsoLength - S.armRoot) < 1e-9, 'the shoulder line is leg + torso')
  assert.equal(S.headCentre + S.headRadius, S.height, 'the crown is the stated height')
  // and it stands clear of the two things it is always seen against, both from
  // `streetView.js`: the 1.1–1.3 m frontage and the 5.2 m house wall
  assert.ok(S.height > 1.3 * 2, 'twice the frontage, so it reads over the hedges')
  assert.ok(S.height < 5.2, 'and under the roofline, because a landmark is not a horror')
  // the eyes are on the head, and they are small
  assert.ok(Math.abs(S.eyeHeight - S.headCentre) < S.headRadius, 'the eyes are inside the skull')
  assert.ok(S.eyeSpread * 2 < S.headRadius * 2, 'and inside its width')
  assert.ok(S.eyeRadius < 0.05, 'an eye, not a headlight')
})

test('every §6.1 state has a presentation, and the five tells are there', () => {
  // the table covers the whole state list plus the two removals, so the view can
  // never meet a state it has no row for
  for (const state of beast.CREATURE_STATES) {
    assert.ok(beast.PRESENTATION_STATES.includes(state), `${state} has no presentation row`)
  }
  assert.ok(beast.PRESENTATION_STATES.includes('dismissing'), 'a departure needs a row of its own')
  // an unknown name is answered, not thrown: the render loop calls this 60x a second
  assert.equal(beast.presentationFor('widdershins'), beast.presentationFor('dormant'))
  assert.equal(beast.presentationFor(undefined), beast.presentationFor('dormant'))
  // and a departure is the one row that draws while the state says it should not
  assert.equal(beast.presentationFor('dormant').present, 0, 'dormant draws nothing')
  assert.equal(beast.presentationFor('dismissing').present, 1, 'a departure draws')
  // frozen, so art cannot drift at runtime
  assert.ok(Object.isFrozen(beast.CREATURE_PRESENTATION))
  assert.ok(Object.isFrozen(beast.CREATURE_PRESENTATION.telegraph.flicker))
  // the five tells from the brief, one assertion each
  assert.ok(beast.presentationFor('telegraph').flicker !== null, 'TELEGRAPH flickers')
  assert.ok(beast.presentationFor('stalk').sway > 0 && beast.presentationFor('stalk').scan > 0, 'STALK ranges and scans')
  assert.ok(beast.presentationFor('chase').sway < beast.presentationFor('stalk').sway, 'CHASE drifts less than a ranging creature')
  assert.equal(beast.presentationFor('chase').scan, 0, 'and does not scan')
  assert.equal(beast.presentationFor('stagger').recoil, 1, 'STAGGER recoils')
  assert.equal(beast.presentationFor('enraged').redden, 1, 'ENRAGED is reddened')
  // `edge` belongs to the ranging states and to nothing else — see the table's note
  // on why it is a column rather than a test on `sway`
  for (const state of beast.PRESENTATION_STATES) {
    const expected = state === 'stalk' || state === 'reposition' ? 1 : 0
    assert.equal(beast.presentationFor(state).edge, expected, `${state} must ${expected ? '' : 'not '}take the edge offset`)
  }
  for (const state of beast.PRESENTATION_STATES) {
    if (state === 'enraged') continue
    assert.equal(beast.presentationFor(state).redden, 0, `${state} must not be reddened`)
  }
})

test('the five states do not read as one state — the tells are separated', () => {
  // The whole premise of a per-state presentation is that a player can tell them
  // apart in fog, in a second, without a HUD. That is a claim about *distances
  // between numbers*, so it is asserted as distances and not as vibes.
  const at = (state) => {
    const pose = beast.creaturePose({ state }, { time: 2.5, distance: 30, viewHalfFov: VIEW_HALF_FOV })
    return [pose.presence, pose.scale, Math.abs(pose.pitch), pose.eye]
  }
  const states = ['telegraph', 'stalk', 'chase', 'stagger', 'enraged']
  for (const a of states) {
    for (const b of states) {
      if (a === b) continue
      const [pa, sa, la, ea] = at(a)
      const [pb, sb, lb, eb] = at(b)
      const gap = Math.max(Math.abs(pa - pb), Math.abs(sa - sb), Math.abs(la - lb), Math.abs(ea - eb))
      assert.ok(gap >= 0.05, `${a} and ${b} are only ${gap.toFixed(3)} apart in the frame`)
    }
  }
  // and the ordering the brief asks for is a strict one, not a set of near-ties
  const presence = states.map((s) => beast.presentationFor(s).presence)
  assert.ok(
    presence[0] < presence[1] && presence[1] < presence[2] && presence[2] <= presence[4],
    `presence must rise telegraph < stalk < chase <= enraged: ${presence.join(', ')}`,
  )
  assert.equal(beast.presentationFor('chase').presence, 1, 'a chase is the full form')
  assert.equal(beast.presentationFor('chase').flicker, null, 'and it never flickers')
  // which is why CHASE and ENRAGED are told apart by scale and lean rather than by
  // opacity — the finale is *more* solid, not differently solid
  assert.ok(beast.presentationFor('enraged').scale > beast.presentationFor('chase').scale, 'the finale is bigger')
  assert.ok(beast.presentationFor('enraged').lean > beast.presentationFor('chase').lean, 'and it is coming harder')
  assert.ok(beast.presentationFor('enraged').eye > beast.presentationFor('chase').eye, 'with hotter eyes')
})

test('TELEGRAPH is mostly absent, and its beat is not a pulse a player can time', () => {
  // a single sine is a machine: watch two apparitions and you have learned its
  // period. The gate cannot prove a player will not learn it, but it can prove the
  // signal is aperiodic over a sighting and mostly near zero
  let near = 0
  let total = 0
  let peak = 0
  for (let t = 0; t < 60; t += 1 / 60) {
    const v = beast.apparitionFlicker(t)
    assert.ok(v >= 0 && v <= 1, `out of range at ${t}: ${v}`)
    if (v < 0.1) near += 1
    peak = Math.max(peak, v)
    total += 1
  }
  assert.ok(near / total > 0.2, `only ${((near / total) * 100).toFixed(0)}% of the time is it gone`)
  assert.ok(peak > 0.8, `and it never actually appears: peak ${peak.toFixed(2)}`)
  // a phase offset gives two sightings different beats, so a scene with two of
  // them is not two things blinking in lockstep
  let differs = 0
  for (let t = 0; t < 10; t += 1 / 60) {
    if (Math.abs(beast.apparitionFlicker(t, 0) - beast.apparitionFlicker(t, 1.3)) > 0.02) differs += 1
  }
  assert.ok(differs > 300, `two offsets are nearly identical (${differs} samples differ)`)
  // and the telegraph's own row never lets it be fully solid
  const row = beast.presentationFor('telegraph').flicker
  assert.ok(row.depth > 0.5, 'it swings most of its range')
  assert.ok(row.floor < 0.1, 'down to nearly nothing')
  assert.equal(beast.apparitionFlicker(NaN), 0, 'and a missing clock is simply absent')
})

test('§6.1: a stalk sits at the edge of the frame and outside its own sight cone', () => {
  // One number has to satisfy two rules at once, and this is where it is proven.
  const edge = beast.stalkEdgeAngle(VIEW_HALF_FOV)
  // inside the frame, or §6.1's STALK is a state the player never learns to read
  assert.ok(edge < VIEW_HALF_FOV, `${((edge * 180) / Math.PI).toFixed(1)}deg is off-screen`)
  assert.ok(edge > VIEW_HALF_FOV * 0.5, 'and it is at the edge, not in the middle of the frame')
  // outside the creature's own cone, or the thing at the edge of your vision can
  // see you — the one thing §6.1 says a stalk never does
  assert.ok(edge > beast.SIGHT_HALF_ANGLE, 'the stalk must be outside the sight cone that found it')
  // The margin has to be real, and it has to survive the narrowest window any real
  // screen ships at — which is why the angle is a fraction of the half-field rather
  // than a fixed number. `stalkEdgeAspectFloor` is where the two promises stop
  // being simultaneously satisfiable, and the gate asserts the floor rather than
  // pretending a square window keeps the design intact.
  const floor = beast.stalkEdgeAspectFloor(VIEW_FOV)
  assert.ok(floor > 1, `the floor is ${floor.toFixed(3)}:1, so a square window cannot hold both promises`)
  assert.ok(floor < 4 / 3, `and 4:3 (${(4 / 3).toFixed(3)}) must be inside it, or every 4:3 monitor breaks the design`)
  for (const aspect of [16 / 9, 16 / 10, 5 / 3, 3 / 2, 4 / 3]) {
    assert.ok(aspect > floor, `the fixture aspect ${aspect.toFixed(3)} is below the floor ${floor.toFixed(3)}`)
    const half = Math.atan(Math.tan((VIEW_FOV * Math.PI) / 360) * aspect)
    const a = beast.stalkEdgeAngle(half)
    assert.ok(a < half, `off-screen at ${aspect.toFixed(2)}:1`)
    assert.ok(a > beast.SIGHT_HALF_ANGLE, `visible to itself at ${aspect.toFixed(2)}:1`)
  }
  // below the floor the figure still has to be *in* the frame — §6.1's promise is
  // that the player sees it, and that promise does not have a minimum aspect
  for (const aspect of [1, 3 / 4, 9 / 16]) {
    const half = Math.atan(Math.tan((VIEW_FOV * Math.PI) / 360) * aspect)
    assert.ok(beast.stalkEdgeAngle(half) < half, `off-screen at ${aspect.toFixed(2)}:1`)
  }
  // a nonsense camera is answered, not propagated
  for (const bad of [0, NaN, -1]) {
    assert.ok(Number.isFinite(beast.stalkEdgeAngle(bad)), `stalkEdgeAngle(${bad})`)
  }
  // and the pose applies it, proportionally to how near the frame edge the creature
  // already is, and signed by which side it is on
  const rolled = (bearing) => beast.creaturePose({ state: 'stalk' }, { bearing, viewHalfFov: VIEW_HALF_FOV }).roll
  assert.equal(rolled(0), 0, 'a thing dead ahead is already being looked at, and is not dressed up')
  assert.ok(rolled(-0.4) < 0, 'to the left rolls left')
  assert.ok(rolled(0.4) > 0, 'and to the right rolls right')
  assert.ok(Math.abs(rolled(-0.4) + rolled(0.4)) < 1e-12, 'and the two sides mirror')
  // full effect at the frame edge, and never more than that
  assert.ok(Math.abs(Math.abs(rolled(VIEW_HALF_FOV)) - edge) < 1e-12, 'by the documented angle, at the edge')
  assert.ok(Math.abs(rolled(VIEW_HALF_FOV * 3)) === edge, 'and never more than it, however far off-axis')
  // growing towards the edge, and linear in between
  assert.ok(Math.abs(rolled(0.2)) < Math.abs(rolled(0.4)), 'the closer the edge, the harder the presentation')
  assert.ok(Math.abs(Math.abs(rolled(0.4)) - Math.abs(rolled(0.2))) > 0.05, 'by a visible amount')
  // a creature dead ahead is not rolled, and a chase is never rolled at all
  assert.equal(beast.creaturePose({ state: 'chase' }, { bearing: -0.8, viewHalfFov: VIEW_HALF_FOV }).roll, 0, 'a chase is squared up to you')
  for (const state of beast.PRESENTATION_STATES) {
    if (beast.presentationFor(state).edge > 0) continue
    assert.equal(rolled(0.7), rolled(0.7), 'sanity')
    assert.equal(beast.creaturePose({ state }, { bearing: 0.7, viewHalfFov: VIEW_HALF_FOV }).roll, 0, `${state} must not take the edge offset`)
  }
})

test('the eyes hold a pixel floor at the worst range the design permits', () => {
  // "emissive eyes" and "reads at distance in fog" are one requirement, and this
  // is the number that welds them together. At FARTHEST_EVER an anatomical eye is
  // half a pixel; a half-pixel eye is not a dim eye, it is no eye.
  const camera = { fov: VIEW_FOV, viewportHeight: 720 }
  const base = beast.eyeWorldSize(0, camera)
  const far = beast.eyeWorldSize(FARTHEST_EVER, camera)
  assert.ok(far > base * 4, `at ${FARTHEST_EVER.toFixed(1)}m the eye is only ${far.toFixed(3)}m across`)
  // and it really is at least EYE_PIXEL_FLOOR pixels, recomputed here rather than
  // read back from the function under test
  const pixels = (far * 720) / (2 * FARTHEST_EVER * Math.tan((VIEW_FOV * Math.PI) / 360))
  assert.ok(pixels >= beast.EYE_PIXEL_FLOOR - 1e-9, `only ${pixels.toFixed(2)}px at ${FARTHEST_EVER.toFixed(1)}m`)
  // close up it is a real eye and not a headlight, and the floor never engages
  for (const d of [1, 2, 3, 5, 6]) {
    assert.equal(beast.eyeWorldSize(d, camera), base, `the floor engaged at ${d}m`)
  }
  // past the crossover it grows linearly with distance and never dips
  let previous = 0
  for (let d = 6; d <= 140; d += 1) {
    const size = beast.eyeWorldSize(d, camera)
    assert.ok(size >= previous - 1e-12, `the eye shrank at ${d}m`)
    previous = size
  }
  // the promise is about pixels, so it survives a different window
  for (const height of [360, 720, 1080, 1440]) {
    const size = beast.eyeWorldSize(FARTHEST_EVER, { fov: VIEW_FOV, viewportHeight: height })
    const px = (size * height) / (2 * FARTHEST_EVER * Math.tan((VIEW_FOV * Math.PI) / 360))
    assert.ok(Math.abs(px - beast.EYE_PIXEL_FLOOR) < 1e-9, `${height}px tall: ${px.toFixed(3)}px`)
  }
  // a degenerate camera gets the base size rather than an infinity
  for (const bad of [0, -5, NaN, Infinity]) {
    const size = beast.eyeWorldSize(bad, { viewportHeight: 0 })
    assert.ok(Number.isFinite(size) && size > 0, `eyeWorldSize(${bad}) = ${size}`)
  }
})

test('§7.4: the recoil is the banish window, not a second clock', () => {
  // The displacement is read off `staggerSeconds`, the clock the state machine
  // already keeps. A timer of its own could outlive the banish, and a figure
  // flying away from a hammer that is no longer holding anything is the most
  // obvious way this could have been built wrong.
  const full = beast.STAGGER_SECONDS
  assert.equal(beast.staggerRecoil({ state: 'stagger', staggerSeconds: full }), 1, 'full at the moment of the hit')
  assert.equal(beast.staggerRecoil({ state: 'stagger', staggerSeconds: 0 }), 0, 'and nothing once it ends')
  // monotonically down as the window runs out, and never negative past the end.
  // `staggerSeconds` counts *down* from STAGGER_SECONDS, so elapsed time is the
  // window minus it — walking the window forwards is walking the recoil backwards
  let previous = Infinity
  for (let elapsed = 0; elapsed <= full; elapsed += 0.05) {
    const k = beast.staggerRecoil({ state: 'stagger', staggerSeconds: full - elapsed })
    assert.ok(k <= previous + 1e-12, `the recoil grew at ${elapsed.toFixed(2)}s`)
    assert.ok(k >= 0, `the recoil went negative at ${elapsed.toFixed(2)}s`)
    previous = k
  }
  // Front-loaded but continuous: it snaps out, then decelerates into a stop, and
  // reaches nothing only at the end. A linear slide reads as a fade rather than a
  // hit, so the *shape* is asserted rather than assumed.
  const atElapsed = (fraction) =>
    beast.staggerRecoil({ state: 'stagger', staggerSeconds: full * (1 - fraction) })
  assert.ok(beast.RECOIL.shape > 1, 'a struck body decelerates into a stop; the curve is convex')
  assert.ok(atElapsed(0.1) > 0.75, `a tenth of the window in, only ${atElapsed(0.1).toFixed(2)} of the throw is left`)
  assert.ok(atElapsed(0.5) < 0.5, `the halfway point has already recovered ${((1 - atElapsed(0.5)) * 100).toFixed(0)}% of it`)
  assert.ok(atElapsed(0.9) < 0.05, `and the last tenth is the settle: ${atElapsed(0.9).toFixed(3)}`)
  assert.equal(atElapsed(1), 0, 'and nothing once the window is spent')
  assert.equal(atElapsed(2), 0, 'past the end as well')
  // a creature that is not recoiling has no recoil, whatever else it is
  for (const state of ['telegraph', 'stalk', 'chase', 'enraged', 'dormant']) {
    assert.equal(beast.staggerRecoil({ state, staggerSeconds: full }), 0, `${state} must not recoil`)
  }
  assert.equal(beast.staggerRecoil(null), 0)
  assert.equal(beast.staggerRecoil({ state: 'stagger', staggerSeconds: NaN }), 0)
  // and the pose turns it into a throw, backwards, off the same number
  const pose = beast.creaturePose({ state: 'stagger', staggerSeconds: full }, { time: 0 })
  assert.equal(pose.push, beast.RECOIL.push)
  assert.equal(pose.lift, beast.RECOIL.lift)
  assert.equal(pose.spin, beast.RECOIL.spin)
  assert.ok(pose.pitch < 0, 'thrown backwards, not forwards')
})

test('§8.2 and §7.4: a removal and an arrival are both drawn, and both are finite', () => {
  // A banish the player cannot watch reads as a stutter, and §8.2 is the most
  // important rule in the anti-frustration section: the reason being cornered is
  // survivable is that you *watch* the thing that cornered you give up.
  const d = beast.FADE_SECONDS.dismiss
  assert.equal(beast.fadeOut(0), 1, 'a departure starts fully drawn')
  assert.equal(beast.fadeOut(d / 2), 0.5)
  assert.equal(beast.fadeOut(d), 0)
  assert.equal(beast.fadeOut(d * 3), 0, 'and it does not come back')
  // §9.3's cross-fade is 1.1 s, so the figure finishes leaving exactly as the
  // screen starts going down. The two lengths are equal on purpose.
  assert.equal(d, 1.1)
  // the arrival is the same idea in reverse: §8.3's placement is instant, so the
  // *drawing* of it is what stops it being a teleport
  const r = beast.FADE_SECONDS.reemerge
  assert.equal(beast.fadeIn(0), 0, 'an arrival starts invisible')
  assert.equal(beast.fadeIn(r), 1)
  assert.equal(beast.fadeIn(r * 4), 1)
  assert.ok(r < d, 'arriving is quicker than leaving, or §8.3 costs the player patience')
  // and the two are used exactly where §6.1 / §7.4 / §8.2 / §8.3 say they are
  const leaving = beast.creaturePose({ state: 'dormant' }, { dismiss: 1, elapsed: 0 })
  assert.equal(leaving.present, true, 'a banished creature is still visible on the frame it leaves')
  assert.ok(leaving.presence > 0.5, 'and solid at the start of it')
  assert.equal(leaving.state, 'dormant', 'while reporting its state honestly')
  assert.equal(beast.creaturePose({ state: 'dormant' }, { dismiss: 1, elapsed: d }).present, false, 'and gone after')
  assert.equal(beast.creaturePose({ state: 'dormant' }).present, false, 'a plain dormant draws nothing')
  // the arrival only fades a stalk, because only a stalk is a re-emergence
  assert.equal(beast.creaturePose({ state: 'stalk' }, { sinceReemerge: 0 }).presence, 0, 'nothing at the instant of placement')
  assert.ok(beast.creaturePose({ state: 'stalk' }, { sinceReemerge: r }).presence > 0.5, 'and the figure once it has arrived')
  assert.equal(
    beast.creaturePose({ state: 'chase' }, { sinceReemerge: 0 }).presence,
    beast.presentationFor('chase').presence,
    'a chase was never placed, so it does not fade',
  )
})

test('a chase fades towards §8.2\'s valve without ever reaching it', () => {
  // The state machine owns the phase-out. The figure only *shows* the pressure
  // building, and it must not get all the way to gone — a chase that visually
  // vanished before the rule fired would be a second, silent phase-out, and one
  // the player could not see coming.
  const at = (seconds) => beast.creaturePose({ state: 'chase' }, { chaseSeconds: seconds }).presence
  assert.equal(at(0), beast.presentationFor('chase').presence, 'a fresh chase is the full form')
  const last = at(beast.CHASE_MAX_SECONDS)
  assert.ok(last < at(0), 'and the last of one is dimmer')
  assert.ok(last > beast.presentationFor('chase').presence * 0.7, `but not gone: ${last.toFixed(3)}`)
  assert.ok(last > 0, 'never zero — the phase-out belongs to the state machine, not the pose')
  // monotonic, and untouched when the clock is not running
  let previous = Infinity
  for (let s = 0; s <= beast.CHASE_MAX_SECONDS; s += 0.5) {
    const v = at(s)
    assert.ok(v <= previous + 1e-12, `the chase brightened at ${s}s`)
    previous = v
  }
  assert.equal(beast.creaturePose({ state: 'chase' }).presence, at(0), 'an absent clock means an untouched pose')
})

test('creaturePose is total: no creature, no state, no camera, no clock, no number', () => {
  // The render loop calls this sixty times a second behind everything else, and a
  // throw here is a frozen tab rather than a missing shadow. Every hole has an
  // answer, and the answers are the *safe* ones.
  assert.equal(beast.creaturePose(null).present, false, 'no creature is no figure')
  assert.equal(beast.creaturePose(undefined).state, 'dormant')
  assert.equal(beast.creaturePose({}).state, 'dormant', 'a creature with no state is dormant')
  assert.equal(beast.creaturePose({ state: 42 }).state, 'dormant', 'and so is a state that is not a string')
  const hostile = {
    time: NaN, distance: NaN, elapsed: NaN, offset: NaN,
    bearing: NaN, viewHalfFov: NaN, chaseSeconds: NaN, sinceReemerge: NaN,
    view: { fov: NaN, viewportHeight: NaN },
  }
  for (const state of beast.PRESENTATION_STATES) {
    const pose = beast.creaturePose({ state }, hostile)
    for (const [key, value] of Object.entries(pose)) {
      if (typeof value === 'boolean' || key === 'state') continue
      assert.ok(Number.isFinite(value), `${state}.${key} = ${value} is not a finite number`)
      if (key === 'presence' || key === 'eye') {
        assert.ok(value >= 0 && value <= 1, `${state}.${key} = ${value} left [0, 1]`)
      }
    }
  }
  // and no combination of absurd input can produce an absurd pose
  for (const state of beast.PRESENTATION_STATES) {
    for (const distance of [0, -1, 1e9, Infinity, NaN]) {
      for (const time of [0, -1e9, Infinity, NaN]) {
        const pose = beast.creaturePose({ state, staggerSeconds: time }, { distance, time })
        assert.ok(pose.presence >= 0 && pose.presence <= 1, `${state} @ ${distance}m / ${time}s`)
        assert.ok(pose.eyeSize > 0, `${state}: the eyes vanished @ ${distance}m`)
        assert.ok(Number.isFinite(pose.pitch) && Number.isFinite(pose.roll), `${state}: a non-finite rotation`)
      }
    }
  }
  // a caller that passes nothing at all gets a usable pose, not a crash
  const bare = beast.creaturePose({ state: 'chase' })
  assert.equal(bare.present, true)
  assert.ok(bare.eyeSize > 0)
  assert.equal(bare.roll, 0, 'with no bearing there is no edge offset to apply')
})

test('creaturePose is a pure function — no clock of its own, no randomness', () => {
  // §6.5's rule extended to the presentation: the same creature and the same frame
  // give byte-identical numbers, forever. A pose that quietly read a clock or
  // `Math.random` would make every capture a different screenshot and would put
  // this code outside the reach of `verify.mjs` entirely.
  const creature = beast.createCreature({ state: 'stagger', staggerSeconds: 0.8, awareness: 0.5 })
  const frame = {
    time: 7.25, distance: 33.5, elapsed: 0.2, offset: 1.1, sinceReemerge: 0.3,
    chaseSeconds: 4, bearing: -0.3, viewHalfFov: VIEW_HALF_FOV,
    view: { fov: VIEW_FOV, viewportHeight: 720 },
  }
  const first = beast.creaturePose(creature, frame)
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(beast.creaturePose(creature, frame), first, `pose ${i} differed`)
  }
  // a fresh clone of the creature is the same creature
  assert.deepEqual(beast.creaturePose({ ...creature }, frame), first)
  // and the pose mutates nothing it was handed
  const creatureBefore = JSON.stringify(creature)
  beast.creaturePose(creature, frame)
  assert.equal(JSON.stringify(creature), creatureBefore, 'creaturePose mutated the creature')
  const frameBefore = JSON.stringify(frame)
  beast.creaturePose(creature, frame)
  assert.equal(JSON.stringify(frame), frameBefore, 'creaturePose mutated the frame')
  // the tables it reads are frozen, so no amount of calling can drift the art
  assert.ok(Object.isFrozen(beast.CREATURE_PRESENTATION.chase))
  assert.ok(Object.isFrozen(beast.CREATURE_SHAPE))
  assert.ok(Object.isFrozen(beast.RECOIL))
  assert.ok(Object.isFrozen(beast.FADE_SECONDS))
})

test('§7.2: the awakening toll is the only door from Act I into Act II', () => {
  // §8.1 says Act I cannot kill you, and §6.1 says a telegraph cannot be
  // banished either — so the *only* edge out of TELEGRAPH that leads to a hunter
  // is the pickup, and it must fire on the pickup and on nothing else ever.
  // Asserted as a scan of the machine rather than as one example, because "and
  // not before" is the half that is easy to get wrong.
  const step = (creature, frame) => beast.creatureStep(creature, DT, { sounds: [], distance: 60, ...frame })
  assert.equal(beast.inSightCone({ x: 0, z: 0, yaw: 0 }, { x: 0, z: -60 }), true, 'the fixture is a sighting in view')
  for (let i = 0; i < 600; i++) {
    const held = step(beast.createCreature({ state: 'telegraph' }), { sighting: true })
    assert.equal(held.to, 'telegraph', `Act I ended on its own at frame ${i}`)
    assert.equal(held.captured, false, '§8.1: Act I cannot kill you')
    assert.equal(held.swing, null, 'and cannot be banished')
  }
  // the pickup toll is the awakening, and it is the one that works
  const woken = step(beast.createCreature({ state: 'telegraph' }), { sighting: true, hammerPickup: true })
  assert.equal(woken.to, 'stalk', '§7.2: the toll is the awakening')
  assert.equal(woken.creature.hammerToll, true, 'and the flag rides on the creature, so it can toll once')
  // and it cannot be repeated, because the creature is no longer in TELEGRAPH
  assert.equal(step(woken.creature, { sighting: true, hammerPickup: true }).to, 'stalk', 'a second toll changes nothing')
  // looking away is the *other* Act I exit, and it goes the other way
  assert.equal(step(beast.createCreature({ state: 'telegraph' }), { sighting: false }).to, 'dormant', '§6.1: gone when you look back')
  // and once awake, nothing puts it back to sleep: there is no edge into Act I
  assert.notEqual(step(woken.creature, { sighting: false, hammerPickup: true }).to, 'telegraph', 'no edge back into Act I')
})

test('§9.1: a capture keeps the left column, resets the right, and permutes only the dressing', () => {
  // The persistence table is the contract, and the easiest half to break by a
  // careless refactor is the *right* column: a capture that quietly took a
  // shuttered portal or the banish ladder with it would erase progress, and §8.5
  // is explicit that it may not.
  const earned = {
    ...rules.createInitialState(hood.placeObjectives(1337, 1)),
    portals: { A: true, B: true, C: false },
    hammerHeld: true,
    banishCount: 4,
  }
  earned.dusk = rules.duskForPortals(earned.portals)
  const caught = rules.applyCapture(earned)
  // keeps
  assert.deepEqual(caught.portals, earned.portals, '§9.1: shuttered portals are permanent')
  assert.equal(caught.hammerHeld, true, '§9.1: the hammer is not dropped')
  assert.equal(caught.banishCount, 4, '§9.1: the banish ladder is run-long')
  assert.equal(caught.dusk, earned.dusk, '§3.7: dusk tracks portals, never the loop')
  // resets
  assert.deepEqual(caught.player, { x: hood.SPAWN.position.x, z: hood.SPAWN.position.z }, 'and position returns to spawn')
  assert.equal(caught.creature.reemergenceCount, 0, '§9.1: the pressure axis is the thing that resets')
  assert.equal(caught.creature.awareness, 0)
  assert.equal(caught.creature.state, 'stalk', '§9.1: back to STALK, because the hammer is still held')
  assert.deepEqual(caught.sounds, [])
  // increments
  assert.equal(caught.loop, earned.loop + 1, '§9.2: the capture counter counts captures only')
  // and the creature follows the same predicate the state does
  const beforeHammer = rules.applyCapture({ ...earned, hammerHeld: false })
  assert.equal(beforeHammer.creature.state, 'telegraph', 'Act I again, if the hammer was never collected')
  assert.equal(beforeHammer.hammerHeld, false, 'and the hammer is still not held')
  // the fixture pass is keyed on exactly that counter, so a capture permutes the
  // dressing and nothing else — the streets and the objectives do not move
  const pass1 = hood.fixturePass(1337, earned.loop)
  const pass2 = hood.fixturePass(1337, caught.loop)
  assert.notEqual(hood.fixtureSignature(pass2), hood.fixtureSignature(pass1), '§3.6: the dressing moves')
  assert.equal(
    hood.objectivesSignature(earned.objectives),
    hood.objectivesSignature(caught.objectives),
    'and the objectives do not',
  )
  assert.equal(hood.fixtureSignature(hood.fixturePass(1337, caught.loop)), hood.fixtureSignature(pass2), 'a loop is a fixed point')
})

test('the §7.4 ladder survives the mirror the world writes it back through', () => {
  // This guards a real bug that shipped in slice 09: the world mirrored
  // `state.banishCount` onto the creature every frame, silently overwriting the
  // increment `creatureStep` had just made — so the ladder never moved and every
  // banish in the run bought the first rung's eight seconds. The invariant that
  // closes it is that the mirror is idempotent: writing the creature's own count
  // back into the run is a no-op, and doing it twice cannot double-count.
  const mirror = (creature, state) => ({ state, creature: { ...creature, banishCount: state.banishCount } })
  let creature = beast.createCreature({ state: 'stalk', banishCount: 0 })
  let state = { banishCount: 0 }
  for (let rung = 1; rung <= 6; rung++) {
    const step = beast.creatureStep(creature, DT, { distance: 2, swing: true })
    assert.equal(step.swing.result, 'banish', `swing ${rung} did not connect`)
    assert.equal(step.creature.banishCount, rung, `the ladder is on rung ${rung}`)
    // the world's order: adopt the creature's count, *then* mirror
    state = { banishCount: step.creature.banishCount }
    creature = mirror(step.creature, state).creature
    assert.equal(creature.banishCount, rung, 'the mirror clobbered the increment')
    // and the mirror is idempotent, which is what makes the write-back safe
    assert.equal(mirror(creature, state).creature.banishCount, state.banishCount)
    // §7.4's window follows the rung, and the cap holds
    assert.equal(step.banishSeconds, beast.banishDuration(rung), `rung ${rung} bought the wrong window`)
    assert.ok(step.banishSeconds <= beast.BANISH_DURATION_CAP)
    // run the removal out, then put a fresh hunter back in reach for the next swing
    let elapsed = 0
    while (elapsed < beast.STAGGER_SECONDS + DT) {
      creature = beast.creatureStep(creature, DT, { distance: 60, sounds: [] }).creature
      elapsed += DT
    }
    assert.equal(creature.state, 'dormant', `rung ${rung} did not complete its removal`)
    creature = beast.createCreature({ ...creature, state: 'stalk' })
    creature = mirror(creature, { banishCount: creature.banishCount }).creature
  }
  assert.equal(creature.banishCount, 6)
  assert.equal(rules.applyCapture({ banishCount: creature.banishCount }).banishCount, 6, '§9.1: it survives a capture')
  // and a swing at nothing moves no rung at all
  const miss = beast.creatureStep(beast.createCreature({ state: 'stalk', banishCount: 3 }), DT, {
    distance: beast.BANISH_RANGE + 0.1, swing: true,
  })
  assert.equal(miss.swing.result, 'miss')
  assert.equal(miss.creature.banishCount, 3, 'a swing at the dark buys nothing')
})

// ---------------------------------------------------------------------------
// v2 slice 11 — §13: the audio as data
// ---------------------------------------------------------------------------

section('Audio: the routing table and the three tolls (v2 slice 11)')

const AUDIO_SOURCE = readFileSync(new URL('./src/game/audio.js', import.meta.url), 'utf8')

/** A frame that is in a run, playing, and otherwise completely uneventful. */
const PLAYING_FRAME = Object.freeze({ started: true, playing: true })

/** The ids `routeAudio` produced, which is what every check below is about. */
function routed(frame) {
  return audio.routeAudio(frame).map((cue) => cue.id)
}

/** The one-shot ids only — the sustained rows are always present. */
function events(frame) {
  return routed(frame).filter((id) => audio.routeFor(id).mode === 'once')
}

/**
 * stripProse — a source file with its comments and string literals removed.
 *
 * A check that greps a module for a browser global has to read the module's *code*:
 * this project's comments are dense with words like "window" and "documented", and
 * a gate that fails on prose is a gate that gets deleted rather than fixed.
 */
function stripProse(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
}

test('the §13 sound list is here, as a table, and nothing is missing from it', () => {
  // §13's seven rows, restated rather than read back out of the table, so this
  // check is a specification and not an echo. If a sound is added to the design
  // without a row, this is where it is caught; if a row is added without a design
  // entry, the deepEqual is.
  //
  // PASS 13 ADDED FOUR, and they are listed separately rather than folded into the
  // seven so the two claims stay separable: the seven are slice 11's contract with
  // §13, and the four are the world bed — what the PLACE makes, not what the player
  // and the creature make. `GAMEDESIGN.md` §13 carries the same split, and the
  // second list is as much a specification as the first.
  const section13 = ['bell toll', 'ambient drone', 'footstep tick', 'breathing', 'portal hum', 'creature breath', 'portal shutdown']
  const worldBed = ['room tone', 'haze wind', 'distant facility', 'water drip']
  const sounds = distinct(audio.AUDIO_ROUTES.map((row) => row.sound))
  assert.deepEqual([...sounds].sort(), [...section13, ...worldBed].sort(), 'the sound list and the table disagree')

  // every row is a complete row: nothing the router or the gate depends on may
  // be missing, and a row with no voice is a sound nobody can hear
  for (const row of audio.AUDIO_ROUTES) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.voice, 'string', `${row.id} names no voice`)
    assert.ok(row.mode === 'once' || row.mode === 'sustained', `${row.id} has no mode`)
    assert.ok(row.gate.length > 10, `${row.id} has no documented gate`)
    if (row.tuning !== null) {
      assert.ok(audio.BELL_TUNING_IDS.includes(row.tuning), `${row.id} names an unknown tuning`)
    }
  }
  // ids are unique, or one row could shadow another
  assert.equal(audio.AUDIO_ROUTE_IDS.length, new Set(audio.AUDIO_ROUTE_IDS).size, 'two rows share an id')
  // and every row's voice is a method the file actually has
  for (const row of audio.AUDIO_ROUTES) {
    assert.equal(
      typeof audio.AudioManager.prototype[row.voice],
      'function',
      `AUDIO_ROUTES names ${row.voice}() and AudioManager has no such method`,
    )
  }
  // frozen, so art cannot drift at runtime — the same rule the creature's
  // presentation table is held to
  assert.ok(Object.isFrozen(audio.AUDIO_ROUTES))
  assert.ok(Object.isFrozen(audio.BELL_TUNINGS))
  assert.equal(audio.routeFor('widdershins'), null, 'an unknown row is answered, not thrown')
})

test('every creature-facing radius is the creature\'s own table, not a typed number', () => {
  // This is the assertion §7.3 actually needs: the player's idea of how loud a
  // footstep is and the AI's idea of how far it carries are one number, taken from
  // `creature.soundRadius`. The row is built from a §6.2 kind and the kind is one of
  // §6.2's own rows, so neither half can drift without the gate noticing.
  const kinds = new Set([...Object.keys(beast.SOUND_RADII), 'still'])
  for (const row of audio.AUDIO_ROUTES) {
    const expected = row.kind == null ? 0 : beast.soundRadius(row.kind, { exhausted: row.exhausted === true })
    assert.equal(audio.cueRadius(row), expected, `${row.id} is priced at ${audio.cueRadius(row)}, not ${expected}`)
    if (row.kind != null) assert.ok(kinds.has(row.kind), `${row.id} names a §6.2 row that does not exist`)
  }
  // the numbers themselves, restated from §6.2, so a drift in either module shows
  // up as a disagreement rather than as a table that agrees with itself
  assert.equal(audio.cueRadius(audio.routeFor('walk')), 9)
  assert.equal(audio.cueRadius(audio.routeFor('sprint')), 22)
  assert.equal(audio.cueRadius(audio.routeFor('exhausted')), 9 + rules.EXHAUSTED_BREATH_SOUND_BONUS)
  assert.equal(audio.cueRadius(audio.routeFor('portalShutdown')), rules.PORTAL_SOUND_RADIUS)
  assert.equal(audio.cueRadius(audio.routeFor('awakening')), beast.SOUND_RADII.toll)
  assert.equal(audio.cueRadius(audio.routeFor('banish')), beast.SOUND_RADII.toll)
  assert.equal(audio.cueRadius(audio.routeFor('breath')), rules.EXHAUSTED_BREATH_SOUND_BONUS)
  // §7.3: exhaustion is the *state*, priced on top of the gait. The exhausted row
  // is a walk plus the bonus because the lockout means a winded player is never
  // sprinting, so an "exhausted sprint" is a gait the game cannot produce.
  assert.equal(audio.routeFor('exhausted').kind, 'walk')
  assert.ok(
    audio.cueRadius(audio.routeFor('exhausted')) > audio.cueRadius(audio.routeFor('walk')),
    '§7.3: exhaustion makes you louder',
  )
  // a swing is loud whether or not it lands: §7.4 demoted the toll to feedback
  // but kept its 30 m, so a miss cannot be quieter to the creature than a hit
  assert.equal(audio.cueRadius(audio.routeFor('whiff')), audio.cueRadius(audio.routeFor('banish')))
  // and the readouts are not stimuli at all
  for (const id of ['creatureBreath', 'portalHum', 'drone', 'reset']) {
    assert.equal(audio.cueRadius(audio.routeFor(id)), 0, `${id} is a stimulus to the creature`)
  }
})

test('the three tunings are one bell, and they can be told apart', () => {
  // §13's "three distinct tunings" is a claim about *audibility*, so it is checked
  // as one: three names, three pitches, three (pitch, decay) pairs, because a set
  // of tunings that collapsed into one another would be three tolls that all sound
  // like the same toll.
  assert.equal(audio.BELL_TUNING_IDS.length, 3)
  assert.deepEqual([...audio.BELL_TUNING_IDS], ['awakening', 'banish', 'reset'])
  const voices = new Set()
  for (const id of audio.BELL_TUNING_IDS) {
    const tuning = audio.BELL_TUNINGS[id]
    assert.equal(tuning.id, id, 'a tuning is filed under the wrong name')
    assert.ok(tuning.f0 > 0 && tuning.level > 0 && tuning.decay > 0 && tuning.damp > 0, `${id} has a dead parameter`)
    assert.ok(tuning.f0 < 1000, `${id} is not a bell`)
    voices.add(`${tuning.f0}|${tuning.decay}`)
  }
  assert.equal(voices.size, 3, 'two of the three tunings sound the same')

  // a stack of two fourths — D3, G3, C4 — spanning a compound fifth. Three tolls
  // have to be distinguishable in half a second of panic, and pitch is the only
  // channel that survives fog, a compressor and a laptop speaker.
  const cents = (a, b) => 1200 * Math.log2(a / b)
  const { reset, awakening, banish } = audio.BELL_TUNINGS
  assert.ok(Math.abs(cents(awakening.f0, reset.f0) - 500) < 10, 'the lowest two tunings are not a fourth apart')
  assert.ok(Math.abs(cents(banish.f0, awakening.f0) - 500) < 10, 'the highest two tunings are not a fourth apart')
  assert.ok(cents(banish.f0, reset.f0) > 950, 'the three tunings do not span a compound fifth')

  // and the shapes are chosen for their jobs, in the order §13 gives them
  assert.ok(awakening.decay > reset.decay, 'the act break should ring longest')
  assert.ok(reset.decay > banish.decay, 'a banish has to punch, not toll')
  assert.ok(banish.f0 > awakening.f0 && awakening.f0 > reset.f0, 'the pickup is the middle of the three')
  assert.ok(banish.damp > awakening.damp && awakening.damp > reset.damp, 'and the brightest-to-darkest order follows')
  // the reset sting sags and nothing else does, and it is the only one with no echo
  assert.equal(audio.BELL_TUNINGS.reset.drop < 0, true, 'the reset sting should sag')
  assert.equal(audio.BELL_TUNINGS.awakening.drop, 0)
  assert.equal(audio.BELL_TUNINGS.banish.drop, 0)
  assert.equal(audio.BELL_TUNINGS.reset.echo, false, '§13: the sting is one strike, not a transition')
  assert.equal(audio.BELL_TUNINGS.awakening.echo, true)
  assert.equal(audio.BELL_TUNINGS.banish.echo, true)
  // and the whiff is the banish's recipe with the top taken off: the difference
  // between a hit and a miss is one number
  assert.equal(audio.routeFor('whiff').tuning, 'banish')
  assert.ok(audio.BELL_WHIFF_DAMP < audio.BELL_TUNINGS.banish.damp / 4, 'a whiff is not muffled enough to read as a miss')
})

test('the awakening toll fires once, on the pickup, and never again', () => {
  // §7.2: "Picking up the hammer tolls once, at maximum radius". Once is the whole
  // word, so it is checked three ways — the edge, the edge with the hammer already
  // in hand, and the frame after, where nothing at all is allowed to happen.
  const pickup = { ...PLAYING_FRAME, hammerPickup: true, hammerHeldBefore: false }
  assert.ok(events(pickup).includes('awakening'))
  // §6.2's "swing or pickup" is two rows and not one: the pickup is the awakening
  // and a swing is the banish or the whiff
  assert.equal(audio.routeFor('awakening').kind, 'toll', 'the pickup is the loudest event in the game')
  // a pickup edge while the hammer was *already* held is a caller bug, and the bug
  // has to be silent rather than a second toll. This is the field the world got
  // wrong first: it reported the present tense, and since `_takeHammer` flips
  // `hammerHeld` on the very frame it raises the edge, the toll could never ring.
  assert.equal(events({ ...pickup, hammerHeldBefore: true }).includes('awakening'), false, 'the toll fired twice')
  // and the flag cannot outlive the frame: the world's `_updateAudio` clears it
  // every frame, and this is the shape of what it clears
  let frame = { ...pickup }
  const firstPass = events(frame)
  frame = { ...frame, hammerPickup: false, hammerHeldBefore: true }
  const secondPass = events(frame)
  assert.equal(firstPass.filter((id) => id === 'awakening').length, 1)
  assert.equal(secondPass.length, 0, 'a frame with no action is not allowed to make a sound')
  // it survives a capture, so "once" is once per *run* and not once per life
  const state = rules.createInitialState(hood.placeObjectives(1337))
  assert.equal(rules.applyCapture({ ...state, hammerHeld: true }).hammerHeld, true, '§9.1: the hammer is never dropped')
})

test('the banish toll fires only on a connected swing, and a miss is the same bell damped', () => {
  // §7.4: the outcomes are exhaustive — a banish, a miss, or Act I immunity — so
  // the three of them are the three cases here, and the banish is only one of them.
  for (const result of ['banish', 'miss', 'immune']) {
    const ids = events({ ...PLAYING_FRAME, swing: result })
    assert.equal(ids.length, 1, `a swing (${result}) made ${ids.length} sounds`)
    if (result === 'banish') {
      assert.equal(ids[0], 'banish', 'a connected swing did not toll')
      assert.equal(audio.cueRadius(audio.routeFor('banish')), beast.SOUND_RADII.toll)
    } else {
      // a miss is a swing the hammer swung at nothing: the whiff, not the toll
      assert.equal(ids[0], 'whiff', `${result} was answered with the wrong sound`)
      assert.equal(
        audio.cueRadius(audio.routeFor('whiff')),
        beast.SOUND_RADII.toll,
        'but the creature still hears it',
      )
    }
  }
  // no swing, no sound
  assert.equal(events({ ...PLAYING_FRAME, swing: null }).length, 0)
  assert.equal(events(PLAYING_FRAME).length, 0, 'an empty frame made a sound')
  // and the three outcomes are exactly the three `resolveSwing` can return, so a
  // fourth outcome added in slice 13 lands on a row rather than on silence
  const outcomes = new Set()
  for (const state of beast.CREATURE_STATES) {
    for (const distance of [0, beast.BANISH_RANGE, beast.BANISH_RANGE + 1]) {
      outcomes.add(beast.resolveSwing(state, distance).result)
    }
  }
  assert.deepEqual([...outcomes].sort(), ['banish', 'immune', 'miss'], 'a swing outcome has no row')
})

test('the footstep set is gated on moving, and the three gaits are the three voices', () => {
  // §6.2: "Standing perfectly still emits nothing, so 'kill your footsteps and let it
  // lose you' is a real, learnable strategy". The world only reports a stride when
  // the player really took one; the table prices it.
  assert.equal(audio.footstepGaitFor(null), null, 'no stride, no gait, no sound')
  assert.equal(audio.footstepGaitFor({ sprinting: false, exhausted: false }), 'walk')
  assert.equal(audio.footstepGaitFor({ sprinting: true, exhausted: false }), 'sprint')
  assert.equal(audio.footstepGaitFor({ sprinting: false, exhausted: true }), 'exhausted')
  // §7.3's lockout means the winded gait outranks the sprint key
  assert.equal(audio.footstepGaitFor({ sprinting: true, exhausted: true }), 'exhausted')
  assert.deepEqual([...audio.FOOTSTEP_GAITS], ['walk', 'sprint', 'exhausted'])
  // the gated set really is the §13 row: "gait-dependent: walk, sprint, and an
  // exhausted variant"
  assert.deepEqual(
    audio.AUDIO_ROUTE_IDS.filter((id) => audio.routeFor(id).sound === 'footstep tick').sort(),
    ['exhausted', 'sprint', 'walk'],
  )
  for (const gait of audio.FOOTSTEP_GAITS) {
    assert.equal(audio.routeFor(gait).voice, 'footstep', `${gait} is not a footstep voice`)
    assert.ok(audio.FOOTSTEP_VOICES[gait], `${gait} has no voice of its own`)
  }
  // and the winded footfall is the low, heavy one, so exhaustion is audible in the
  // step itself and not only in the creature's awareness meter
  const { walk, sprint, exhausted } = audio.FOOTSTEP_VOICES
  assert.ok(exhausted.band < walk.band && walk.band < sprint.band, 'the winded step is not the lowest of the three')
  assert.ok(exhausted.thud < walk.thud, 'and it is not the heaviest thud')
  // and the router is the only thing that turns a stride into a cue
  assert.deepEqual(events({ ...PLAYING_FRAME, footstep: { sprinting: true } }), ['sprint'])
  assert.deepEqual(events({ ...PLAYING_FRAME, footstep: { exhausted: true } }), ['exhausted'])
  assert.deepEqual(events({ ...PLAYING_FRAME }), [])
})

test('breathing does double duty: the meter and the proximity readout, on one voice', () => {
  // §13: breathing is "simultaneously the stamina meter and the creature-proximity
  // meter, which is what allows both to exist on screen without any bar". Both
  // inputs have to move the voice, and they have to move it in *opposite*
  // directions on depth — louder, shallower — or the readout says the wrong thing.
  const calm = audio.breathVoice({ ...PLAYING_FRAME, breath: 1, creatureDistance: 200 })
  const winded = audio.breathVoice({ ...PLAYING_FRAME, breath: 0, exhausted: true, creatureDistance: 200 })
  const close = audio.breathVoice({ ...PLAYING_FRAME, breath: 1, creatureDistance: 2 })

  // §7.3: "Being out of breath raises your sound radius" — and the voice is where
  // the player learns it, so exhaustion is louder, shallower and faster
  assert.ok(winded.level > calm.level, '§7.3: exhaustion is not louder')
  assert.ok(winded.depth < calm.depth, '§7.3: exhaustion is not shallower')
  assert.ok(winded.rate > calm.rate, '§7.3: exhaustion is not faster')
  assert.ok(winded.sharp > calm.sharp, 'and it does not change character')
  assert.equal(winded.exhausted, true)
  assert.equal(calm.exhausted, false)

  // §6.4: "breathing that grows louder and shallower with proximity" — the other
  // half of the same voice, and the half the player reads as the creature
  assert.ok(close.level > calm.level, '§6.4: proximity does not make the breath louder')
  assert.ok(close.depth < calm.depth, '§6.4: proximity does not make the breath shallower')
  assert.ok(close.rate > calm.rate, 'and it does not quicken')

  // monotonic in both, over a range rather than at two hand-picked points
  for (const step of [0.05, 0.1, 0.25, 0.5]) {
    assert.ok(
      audio.breathVoice({ ...PLAYING_FRAME, breath: 1 - step, creatureDistance: 0 }).level > calm.level,
      `level fell at breath ${1 - step}`,
    )
    // and the distance sweep runs *inward* from the edge of the range, because
    // past it there is nothing to be closer than
    assert.ok(
      audio.breathVoice({
        ...PLAYING_FRAME, breath: 1, creatureDistance: audio.BREATH_PROXIMITY_RANGE * (1 - step),
      }).level > calm.level,
      `level fell at ${(audio.BREATH_PROXIMITY_RANGE * (1 - step)).toFixed(1)}m`,
    )
  }
  // the bottom of the ladder is a whisper, not a sound: §13 makes breathing a
  // readout, and a readout that is always audible is a meter in disguise
  assert.ok(calm.level < audio.BREATH_WINDED_LEVEL / 4, 'a fresh player is not nearly silent')
  // the player's own lungs are the *earlier* of the two tells, so proximity has to
  // start tightening the breath outside the range the creature's breath carries on
  assert.ok(
    audio.BREATH_PROXIMITY_RANGE > audio.CREATURE_BREATH_RANGE,
    '§13: the player should hear themselves panic before they hear it',
  )
  // §9.3: a capture has one sound and it is the toll, so the breath is silent
  // through the black
  assert.equal(audio.breathVoice({ breath: 0, exhausted: true, playing: false }).level, 0)
  // a missing distance is "not close", not "panicking": the far end and the unknown
  // end are both zero, because the creature is somewhere else nine times a second
  assert.equal(audio.proximityAt(undefined, 30), 0)
  assert.equal(audio.proximityAt(NaN, 30), 0)
  assert.equal(audio.proximityAt(0, 30), 1, 'on top of the player is not maximum proximity')
  assert.equal(audio.proximityAt(15, 30), 0.5)
  assert.equal(audio.proximityAt(30, 30), 0)
  assert.equal(audio.proximityAt(1000, 30), 0, 'a creature in the next district is close')
  assert.equal(audio.proximityAt(-5, 30), 1, 'a negative distance is not close')
  // and depth has a floor: a breath has to be a breath at 0.1, or the voice stops
  // being a breath and starts being a click
  assert.ok(winded.depth >= audio.BREATH_FLOOR_DEPTH)
})

test('the creature is audible before it is visible, and only while it is there', () => {
  // §6.4: "distance-attenuated; sharper as awareness rises", and §13: it is "the
  // awareness readout". Two separable facts, and both have to be separable — the
  // volume says where it is, the character says how much it knows.
  const near = audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: 0, creatureAwareness: 0 })
  const edge = audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: audio.CREATURE_BREATH_RANGE })
  assert.ok(near.level > 0, 'it is not audible at arm\'s length')
  assert.equal(edge.level, 0, 'and it is audible at the edge of its range')
  assert.equal(audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: 400 }).level, 0)
  // distance only, monotonically
  let previous = Infinity
  for (let d = 0; d <= audio.CREATURE_BREATH_RANGE; d += 0.5) {
    const level = audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: d }).level
    assert.ok(level <= previous + 1e-12, `it got louder at ${d}m`)
    previous = level
  }
  // awareness moves the *character* and the rate, and not the volume: a creature
  // that knows exactly where you are breathes differently at the same distance
  for (const distance of [0, 5, 15]) {
    let last = -1
    for (const awareness of [0, 0.25, 0.5, 0.75, 1]) {
      const voice = audio.creatureBreathVoice({
        ...PLAYING_FRAME, creatureDistance: distance, creatureAwareness: awareness,
      })
      assert.ok(voice.sharp > last, `sharpness did not rise at ${awareness} (${distance}m)`)
      assert.ok(voice.rate > last, `it did not quicken at ${awareness} (${distance}m)`)
      last = voice.sharp
    }
  }
  assert.equal(
    audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: 5, creatureAwareness: 0.5 }).level,
    audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: 5, creatureAwareness: 1 }).level,
    'awareness changed the volume',
  )
  // §7.4: a banished creature is off the field, and a breath that followed the
  // player home would undo the one moment the design promises relief in
  assert.equal(audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: 0, creaturePresent: false }).level, 0)
  // §6.4's fallback: if we do not know where it is, it is not breathing on us
  assert.equal(audio.creatureBreathVoice({ ...PLAYING_FRAME }).level, 0)
  assert.equal(audio.creatureBreathVoice({ ...PLAYING_FRAME, creatureDistance: NaN }).level, 0)
  // and silent through the black, like the player's own breath
  assert.equal(audio.creatureBreathVoice({ creatureDistance: 0, playing: false }).level, 0)
})

test('the portal hum falls as the shutdown runs, and swells past the threshold', () => {
  // §13: "per-portal, pitch falls as it is shut down", and §5.2's promise that the
  // second half of a hold is a promise rather than a maybe. Both are these numbers.
  assert.equal(audio.portalHumPitch(0), audio.PORTAL_HUM_PITCH)
  assert.equal(audio.portalHumPitch(1), audio.PORTAL_HUM_PITCH / 2, 'the hum does not fall an octave across a shutdown')
  let previous = Infinity
  for (let p = 0; p <= 1; p += 0.01) {
    const pitch = audio.portalHumPitch(p)
    assert.ok(pitch < previous, `the hum rose at ${p}`)
    previous = pitch
  }
  assert.equal(audio.portalHumPitch(-1), audio.portalHumPitch(0), 'a negative hold did something')
  assert.equal(audio.portalHumPitch(9), audio.portalHumPitch(1))
  assert.equal(audio.portalHumPitch(NaN), audio.portalHumPitch(0), 'an unknown hold did something')

  // a shut portal is silent, but its pitch is still the pitch it died on, so the
  // progress is recoverable from the data after the sound has gone
  const dead = audio.portalHumVoice({ id: 'A', progress: 1, shut: true, distance: 2 })
  assert.equal(dead.level, 0)
  assert.equal(dead.pitch, audio.portalHumPitch(1))

  // the level falls off with distance over the hum's own range and is exactly zero
  // outside it — §13's "progress feedback in-world", not a readout on a ring
  assert.equal(audio.portalHumVoice({ id: 'A', distance: audio.PORTAL_HUM_RANGE }).level, 0)
  assert.equal(audio.portalHumVoice({ id: 'A', distance: 1e6 }).level, 0)
  assert.equal(audio.portalHumVoice({ id: 'A', distance: NaN }).level, 0, 'an unknown distance is a hum')
  previous = Infinity
  for (let d = 0; d <= audio.PORTAL_HUM_RANGE; d += 0.5) {
    const level = audio.portalHumVoice({ id: 'A', distance: d }).level
    assert.ok(level <= previous + 1e-12, `the hum got louder at ${d}m`)
    previous = level
  }
  // and the commitment tell: past the noise threshold the same hum swells, on the
  // very threshold `rules.js` emits the 25 m event from
  const threshold = rules.PORTAL_NOISE_THRESHOLD
  const below = audio.portalHumVoice({ id: 'A', progress: threshold - 0.01, distance: 5 })
  const above = audio.portalHumVoice({ id: 'A', progress: threshold + 0.01, distance: 5 })
  assert.equal(below.level, audio.PORTAL_HUM_LEVEL * beast.soundStrength(5, audio.PORTAL_HUM_RANGE))
  assert.ok(above.level > below.level, '§5.2: the second half of a hold is not louder')
  assert.equal(
    audio.portalHumVoice({ id: 'A', progress: 1, distance: 5 }).level,
    audio.PORTAL_HUM_LEVEL * audio.PORTAL_HUM_SWELL * beast.soundStrength(5, audio.PORTAL_HUM_RANGE),
  )
  // a shut portal is the one case where the swell does not apply
  assert.equal(audio.portalHumVoice({ id: 'A', progress: 1, shut: true, distance: 5 }).level, 0)
})

test('the reset sting is one toll, and it is the only sound of a capture', () => {
  // §13: "v1's reset was a screen fade under three bell tolls; v2's is one toll and a
  // shorter fade". One toll, so the check counts cues rather than trusting a name.
  const capture = { started: true, playing: false, loopReset: true }
  assert.deepEqual(events(capture), ['reset'], 'a capture made more or fewer than one sound')
  // it is a toll: a bell tuning, the one that is a strike and not a sequence
  const [sting] = audio.routeAudio(capture)
  assert.equal(sting.sound, 'bell toll')
  assert.equal(sting.tuning, 'reset')
  assert.equal(audio.routeFor('reset').voice, 'resetSting')
  // a toll and not a fade cue: no echo, a sag, and the lowest prime in the game
  assert.equal(audio.BELL_TUNINGS[sting.tuning].echo, false)
  assert.ok(audio.BELL_TUNINGS[sting.tuning].drop < 0)
  // and nothing else speaks through the black. The breath, the rasp and the hums
  // all arrive on this frame with a level of zero, which is the whole reason the
  // router emits sustained rows even when they are silent.
  const black = audio.routeAudio(capture)
  assert.deepEqual(black.filter((cue) => cue.mode === 'once').map((cue) => cue.id), ['reset'])
  assert.equal(black.find((cue) => cue.id === 'breath').params.level, 0)
  assert.equal(black.find((cue) => cue.id === 'creatureBreath').params.level, 0)
  assert.deepEqual(black.find((cue) => cue.id === 'portalHum').params.hums, [])
  // the drone pulls back for the same reason, and the win takes it further down
  assert.equal(audio.droneLevelFor({ started: true, playing: false }), audio.DRONE_LEVEL_BLACK)
  assert.equal(audio.droneLevelFor({ started: true, playing: true }), audio.DRONE_LEVEL)
  assert.equal(audio.droneLevelFor({ started: true, won: true }), audio.DRONE_LEVEL_WON)
  assert.ok(audio.DRONE_LEVEL_WON < audio.DRONE_LEVEL_BLACK, 'the win is not the quietest the drone gets')
  // and the win's quiet is v1's own number, restated rather than retyped
  assert.ok(Math.abs(audio.DRONE_TUNING.gain * audio.DRONE_LEVEL_WON - audio.DUCK_LEVEL) < 1e-12)
  // §9.3's timeline: the black is short because there is no wall rise to cover, and
  // the sting still rings — it is the only thing that does
  assert.ok(audio.BELL_TUNINGS.reset.decay > 0, 'the sting does not ring at all')
})

test('the router is pure, total, and deterministic', () => {
  // §15.2's seam, in the direction that matters: a router that read a clock or a
  // random number would make the game's audio non-reproducible, and a router that
  // threw on a missing field would take the render loop down sixty times a second.
  const frame = {
    ...PLAYING_FRAME,
    breath: 0.3, exhausted: true, creatureDistance: 6, creatureAwareness: 0.7,
    swing: 'banish', footstep: { sprinting: true, exhausted: true }, portalNoise: true,
    portals: [{ id: 'A', progress: 0.8, distance: 4 }, { id: 'B', progress: 0, shut: true, distance: 4 }],
  }
  const first = audio.routeAudio(frame)
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(audio.routeAudio(frame), first, `replay ${i} routed differently`)
  }
  // byte-identical, not merely equal: the ordering is part of the contract
  assert.equal(JSON.stringify(audio.routeAudio(frame)), JSON.stringify(first))
  // total: every documented field, no field, and a bag of nonsense
  for (const candidate of [
    {},
    { started: true },
    { started: true, playing: true },
    { started: true, playing: true, hammerPickup: true, swing: 'banish', footstep: {}, portalNoise: true, loopReset: true },
    { started: true, playing: 'yes', won: 1, breath: 'full', creatureDistance: {}, portals: 'A' },
    { started: true, playing: true, portals: [null, 7, { id: 'A' }] },
  ]) {
    const cues = audio.routeAudio(candidate)
    assert.ok(Array.isArray(cues), 'the router did not return a list')
    for (const cue of cues) {
      const row = audio.routeFor(cue.id)
      assert.equal(typeof audio.AudioManager.prototype[row.voice], 'function', `${cue.id} has no voice`)
      assert.ok(Number.isFinite(cue.radius), `${cue.id} has a radius that is not a number`)
    }
  }
  // the title screen is silent, and so is a run that has not begun: §13's opening
  // toll was the *world's* clock and v2 has no clock
  assert.deepEqual(audio.routeAudio({}), [])
  assert.deepEqual(audio.routeAudio({ started: false, playing: true, loopReset: true, swing: 'banish' }), [])
  // and no action cue fires outside a run in progress, whatever the flags say
  for (const phase of [{}, { playing: false }, { won: true }]) {
    const ids = events({
      started: true, ...phase, hammerPickup: true, swing: 'banish',
      footstep: { sprinting: true }, portalNoise: true,
    })
    assert.deepEqual(ids, [], `an action fired outside PLAYING (${JSON.stringify(phase)})`)
  }
  // every sustained row is on every started frame, which is what stops a voice
  // from being left running by a frame that forgot to mention it
  for (const other of [{}, { playing: false }, { won: true }, PLAYING_FRAME]) {
    const ids = routed({ started: true, ...other })
    for (const id of audio.SUSTAINED_ROUTE_IDS) {
      assert.ok(ids.includes(id), `${id} was skipped on a started frame`)
    }
  }
})

test('the world hands the table facts and never a sound', () => {
  // The one discipline that makes the rest of this section worth anything:
  // `world.js` holds no audio decisions. It is whitelisted to the router, the win
  // chord (slice 13's, still v1's) and a teardown, and every other sound it could
  // have wanted has to exist in `AUDIO_ROUTES` before it can be asked for.
  const calls = [...WORLD_SOURCE.matchAll(/this\.audio\?\.\s*(\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(calls)].sort(),
    // `setSeed` is pass 13's addition, and it is the one that is not a decision:
    // the world owns the run's seed and hands it over once, in its constructor,
    // exactly the way it hands over `_audioFrame`'s facts sixty times a second. A
    // gate that forbade it would be forbidding the world from knowing its own
    // seed, and the alternative — the audio inventing one — is the bug the
    // shared `DEFAULT_SEED` exists to prevent.
    ['setSeed', 'stopPortalHums', 'update', 'winChord'],
    'the world calls the audio directly somewhere new',
  )
  assert.equal(calls.filter((name) => name === 'update').length, 1, 'the router is called more than once per frame')
  // the frame is built in exactly one place, and it fills in every documented field
  assert.equal((WORLD_SOURCE.match(/_audioFrame\(\)/g) ?? []).length, 2, 'the audio frame is not built in one place')
  for (const field of audio.AUDIO_FRAME_FIELDS) {
    assert.ok(new RegExp(`\\b${field}:`).test(WORLD_SOURCE), `the world never fills in ${field}`)
  }
  // §7.2's "tolls once" and §9.3's one-toll sting are both *flags cleared in
  // `_updateAudio`*, and that is the only thing standing between them and a toll a
  // second. The method body is read rather than the whole file, because the
  // constructor initialises the same fields and would satisfy a file-wide grep.
  const clear = WORLD_SOURCE.slice(
    WORLD_SOURCE.indexOf('_updateAudio(dt) {'),
    WORLD_SOURCE.indexOf('\n  }', WORLD_SOURCE.indexOf('_updateAudio(dt) {')),
  )
  for (const flag of ['_loopReset', '_hammerPickup', '_portalNoise', '_footstep', '_swingResult']) {
    assert.ok(
      new RegExp(`this\\.${flag} = (false|null)`).test(clear),
      `${flag} is never cleared, so its cue could repeat every frame`,
    )
  }
  // v1's three-toll reset and its opening toll are gone from the file entirely
  assert.equal(/bellSequence|bellToll/.test(WORLD_SOURCE), false, 'world.js still reaches for a v1 bell')
})

test('§7.3: a winded stride says so, and the world is told', () => {
  // The third footstep voice exists only if the player's stride carries the
  // exhaustion flag with it, and that is a one-line contract between two files that
  // nothing else checks. The pure harness can check it because `player.js` is in it
  // (slice 08 removed its `three` import, which is the only reason it can be).
  const heard = []
  const player = new PlayerController(stubCamera(), null, {
    onFootstep: (sprinting, exhausted) => heard.push({ sprinting, exhausted }),
  })
  player.pressKey('KeyW')
  for (let frame = 0; frame < 120; frame += 1) player.update(DT)
  player.releaseKey('KeyW')
  assert.ok(heard.length > 0, 'the player reported no strides at all')
  assert.deepEqual(distinct(heard.map((step) => step.sprinting)), [false], 'a walk reported itself as a sprint')
  assert.deepEqual(distinct(heard.map((step) => step.exhausted)), [false], 'a fresh walk reported itself as winded')

  // and now winded: the same player, the meter empty. §7.3's lockout means it is
  // not sprinting, which is exactly why the audio's gait choice has to prefer
  // `exhausted` over `sprinting`.
  heard.length = 0
  const tired = new PlayerController(stubCamera(), null, {
    breath: 0,
    exhausted: true,
    onFootstep: (sprinting, exhausted) => heard.push({ sprinting, exhausted }),
  })
  tired.pressKey('KeyW')
  tired.pressKey('ShiftLeft')
  for (let frame = 0; frame < 180; frame += 1) tired.update(DT)
  assert.ok(heard.length > 0, 'a winded player reported no strides at all')
  // §7.3's lockout, in one assertion: no stride is ever both winded and sprinting.
  // The whole reason the audio's gait choice prefers `exhausted` is that this
  // combination cannot happen, and a combination that cannot happen is exactly the
  // kind of thing a future edit will quietly reintroduce.
  for (const step of heard) {
    assert.equal(step.sprinting === true && step.exhausted === true, false, 'a stride was both winded and sprinting')
  }
  // The lockout lifts as the meter refills (§7.3's hysteresis), and the *audio*
  // follows the meter rather than a latch: the early strides are the winded voice
  // and the late ones are not. A version that reported the first frame's flag
  // forever would sound winded for the rest of the run.
  assert.equal(heard[0].exhausted, true, 'the first stride was not winded')
  assert.equal(heard[0].sprinting, false, 'and it was sprinting')
  assert.equal(audio.footstepGaitFor(heard[0]), 'exhausted', 'and the audio did not choose the winded gait')
  const last = heard[heard.length - 1]
  assert.equal(last.exhausted, false, 'the lockout never lifted')
  assert.equal(audio.footstepGaitFor(last), last.sprinting ? 'sprint' : 'walk', 'and the gait did not follow the meter')
  // (the meter's own hysteresis is slice 05's check; here it is only the audio's
  // fidelity to it, and the player is still holding Shift so it is oscillating
  // around the threshold by the end rather than sitting above it)
})

test('the audio module is in the pure harness, and every sound is synthesized', () => {
  // §15.1 lists `audio.js` as a pure module, which it can only be if nothing above
  // the `AudioManager` boundary reaches for a browser — and the module-scope half is
  // what a node import actually executes. Comments and string literals are stripped
  // first, so this reads the module's *code*: a routing table that says "once per
  // sound window" in a gate string has not reached for `window`.
  const head = stripProse(AUDIO_SOURCE.slice(0, AUDIO_SOURCE.indexOf('export class AudioManager')))
  for (const global of ['window', 'document', 'navigator', 'AudioContext', 'requestAnimationFrame']) {
    assert.equal(new RegExp(`\\b${global}\\b`).test(head), false, `${global} is reachable at module scope`)
  }
  assert.equal(/from ['"]three['"]/.test(AUDIO_SOURCE), false, 'audio.js imports three')
  // the rules it needs are the shared ones, not private copies. PASS 13 took the
  // distance model, the wrap and the PRNG from the modules that already own them:
  // `wrapDelta` is `world.js`'s fold, `soundStrength` is `creature.js`'s curve,
  // and `hash32`/`mulberry32`/`streamAt` are §3.2's foundation. An audio file
  // with its own PRNG would be a second definition of what a seed means.
  assert.match(AUDIO_SOURCE, /import \{ soundRadius, soundStrength, wrapDelta \} from '\.\/creature\.js'/)
  assert.match(AUDIO_SOURCE, /import \{ PORTAL_NOISE_THRESHOLD, BREATH_RECOVERY_THRESHOLD \} from '\.\/rules\.js'/)
  assert.match(AUDIO_SOURCE, /import \{ hash32, mulberry32, streamAt, DEFAULT_SEED \} from '\.\/hash\.js'/)
  assert.match(AUDIO_SOURCE, /import \{ WORLD_HALF \} from '\.\/neighborhood\.js'/)
  // zero downloaded assets: nothing fetches and nothing loads a file
  const code = stripProse(AUDIO_SOURCE)
  for (const loader of ['fetch(', 'XMLHttpRequest', 'new Audio(', 'new Image(', 'createMediaElement', '.mp3', '.wav', '.ogg', 'decodeAudioData']) {
    assert.equal(code.includes(loader), false, `audio.js reaches for ${loader}`)
  }
  // the whole synthesis surface is WebAudio node factories. `createStereoPanner`
  // is pass 13's addition and it is listed for the reason the rest are: a
  // spatialised sound built out of two gain nodes is not spatialisation, so the
  // factory that does it is part of what this file is allowed to reach for.
  for (const factory of ['createOscillator', 'createGain', 'createBiquadFilter', 'createBufferSource', 'createDynamicsCompressor', 'createStereoPanner']) {
    assert.ok(AUDIO_SOURCE.includes(factory), `audio.js stopped using ${factory}`)
  }
  // and a manager that was never unlocked is a no-op rather than a throw: the
  // browser hands this object to a render loop long before the first click
  const manager = new audio.AudioManager()
  assert.equal(manager.ready, false)
  for (const frame of [{}, PLAYING_FRAME, { started: true, playing: true, swing: 'banish', footstep: { sprinting: true } }]) {
    manager.update(1 / 60, frame)
  }
  const cues = audio.routeAudio({ ...PLAYING_FRAME, loopReset: true, hammerPickup: true, swing: 'banish' })
  for (const row of audio.AUDIO_ROUTES) {
    const voice = manager[row.voice]
    assert.equal(typeof voice, 'function')
    voice.call(manager, cues.find((cue) => cue.id === row.id), 1 / 60)
  }
  manager.duckAmbient()
  manager.stopPortalHums()
  assert.equal(manager.ready, false, 'a headless manager built an AudioContext')
})

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 13 — Sound I: the world bed
// ---------------------------------------------------------------------------
//
// WHAT THIS SECTION OWNS, AND WHY IT IS MOSTLY ABOUT THE SEED
// ------------------------------------------------------------
// The pass has four parts (a room tone, a haze-following wind, seeded facility
// noise, and a portal hum that damps with distance) and one property worth more
// than any of them: **every sound in the file is a function of the run's seed.**
// That is a claim about the absence of a thing — no `Math.random`, no
// `setTimeout`, no wall clock — and claims about absences rot, because the next
// person to reach for the obvious three-character shortcut brings one back and
// every other check in this file still passes.
//
// So the checks here are in four groups:
//   - the ROWS: four new sounds, all continuous, all priced at zero for the
//     creature, all silent off a run;
//   - the TABLES: the retuned numbers against the relationships that make them
//     safe (the bed under one footstep, the wind's floor, the hum's two ends);
//   - the SCHEDULE: gaps, placement, seeding, and the claim that a backlog does
//     not arrive as a burst;
//   - the ABSENCES: `Math.random`, `setTimeout`, and a private PRNG, read out of
//     the file's code with the prose stripped.
//
// The last group is why `stripProse` is used on the WHOLE file here rather than on
// the module-scope half: `Math.random` was a runtime-only habit, and the class is
// where it lived.

section('Sound I: the world bed (iteration 2, pass 13)')

/** The four rows pass 13 added, restated so this is a specification. */
const BED_ROWS = Object.freeze(['roomTone', 'hazeWind', 'facility', 'drip'])

/** A player standing at the origin, looking down −Z (yaw 0). */
const LISTENER = Object.freeze({ position: Object.freeze({ x: 0, z: 0 }), yaw: 0 })

test('the world bed is four continuous rows, and none of them is a stimulus', () => {
  // The claim: the bed exists on every begun run, never on an unstarted one, and
  // is invisible to the creature. The last is the one that matters — §6.2 prices
  // sounds by the radius they carry, and a row with a `kind` would hand the AI a
  // stimulus for a noise the player did not make.
  for (const id of BED_ROWS) {
    const row = audio.routeFor(id)
    assert.ok(row, `${id} is not in the routing table`)
    assert.equal(row.mode, 'sustained', `${id} is an event rather than a layer`)
    assert.equal(row.tuning, null, `${id} is a bell`)
    assert.equal(row.kind, null, `${id} carries a §6.2 kind, so the creature can hear it`)
    assert.equal(audio.cueRadius(row), 0, `${id} is a stimulus to the creature`)
    assert.ok(audio.SUSTAINED_ROUTE_IDS.includes(id), `${id} is not on every started frame`)
  }
  // and the title screen is silent: no bed row, no drone, nothing
  assert.deepEqual(audio.routeAudio({}), [], 'the bed runs before the run has begun')
  assert.deepEqual(
    audio.routeAudio({ started: false, playing: true, haze: 1, position: { x: 1, z: 2 }, yaw: 3 }),
    [],
    'the bed runs on a frame that says it has not begun',
  )
  // the scheduled rows carry the listener and the gate; a cue that dropped
  // `position` would be a facility noise with no place to be, and the checks
  // above would not see it
  const playing = audio.routeAudio({ ...PLAYING_FRAME, position: { x: 4, z: -9 }, yaw: 1.2, haze: 0.5 })
  const facility = playing.find((cue) => cue.id === 'facility')
  const drip = playing.find((cue) => cue.id === 'drip')
  assert.deepEqual(facility.params.position, { x: 4, z: -9 }, 'the facility row lost the listener')
  assert.equal(facility.params.yaw, 1.2)
  assert.equal(facility.params.playing, true)
  assert.equal(drip.params.playing, true)
  // and a frame with no listener at all is still routed, with a null position —
  // the row is the world's business, and `facilityVoice` is what reads as silent
  const bare = audio.routeAudio({ ...PLAYING_FRAME }).find((cue) => cue.id === 'facility')
  assert.equal(bare.params.position, null, 'a missing listener was replaced with a guess')
  // the bed ducks with the phase ladder, so a won run is quiet
  const won = audio.routeAudio({ ...PLAYING_FRAME, won: true })
  for (const id of BED_ROWS) {
    assert.equal(won.find((entry) => entry.id === id).radius, 0)
  }
  assert.ok(
    audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 1, won: true }).level < audio.hazeWindVoice(PLAYING_FRAME).level,
    'the win card does not quiet the wind',
  )
})

test('the whole bed fits under one ordinary footstep', () => {
  // §13 makes the footstep the primary sound-radius tell, and the bed is the only
  // other thing on that bus, so the bed is held below the quietest thing the
  // player MUST be able to hear. The sum is recomputed here from the tables rather
  // than read out of a comment, which is the whole point: a retune of any one
  // layer that breaks the ceiling fails the build.
  const peak = audio.DRONE_TUNING.gain * audio.DRONE_LEVEL
    + audio.ROOM_TONE.level
    + audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 1 }).level
  assert.equal(audio.WORLD_BED_CEILING, audio.FOOTSTEP_VOICES.walk.level, 'the ceiling is not a footstep')
  assert.ok(
    peak <= audio.WORLD_BED_CEILING,
    `the bed peaks at ${peak.toFixed(4)}, over the ${audio.WORLD_BED_CEILING} ceiling`,
  )
  // with room left, because a ceiling met exactly is a ceiling one retune away
  // from being broken
  assert.ok(peak < audio.WORLD_BED_CEILING * 0.95, 'the bed is at its ceiling')
  // and each layer is individually quiet, which is the other half: one layer at
  // 0.09 and two at 0.001 would pass the sum and fail the ear
  for (const level of [audio.ROOM_TONE.level, audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 1 }).level]) {
    assert.ok(level <= audio.WORLD_BED_CEILING * 0.5, `a bed layer is at ${level}`)
  }
  // the room tone's own numbers have to make a bed rather than a filter sweep
  assert.ok(audio.ROOM_TONE.highpass < audio.ROOM_TONE.cutoff, 'the room tone filters a band of negative width')
  assert.ok(audio.ROOM_TONE.lfoDepth < audio.ROOM_TONE.cutoff, 'the LFO can push the cutoff below the highpass')
  assert.ok(audio.ROOM_TONE.lfoRate > 0 && audio.ROOM_TONE.lfoRate < 0.1, 'a 6 s "breath" is not a breath')
  assert.ok(audio.ROOM_TONE.cutoff < 1000, 'a room tone at 2 kHz is a hiss, not a room')
})

test('the room tone rides the drone\'s ladder and is silent off a run', () => {
  const playing = audio.roomToneVoice(PLAYING_FRAME)
  assert.equal(playing.level, audio.ROOM_TONE.level)
  // one ladder, three users: the black and the win levels are the drone's own, so
  // a capture cannot leave the bed at full while the drone ducks
  assert.equal(
    audio.roomToneVoice({ started: true, playing: false }).level,
    audio.ROOM_TONE.level * audio.DRONE_LEVEL_BLACK,
  )
  assert.equal(
    audio.roomToneVoice({ ...PLAYING_FRAME, won: true }).level,
    audio.ROOM_TONE.level * audio.DRONE_LEVEL_WON,
  )
  assert.ok(audio.DRONE_LEVEL_BLACK < audio.DRONE_LEVEL, 'the black is not quieter than playing')
  assert.ok(audio.DRONE_LEVEL_WON < audio.DRONE_LEVEL_BLACK, 'the win is not quieter than the black')
  // and no run, no bed — stated in the voice rather than left to the router, so a
  // caller that reaches past `routeAudio` still gets silence
  for (const frame of [{}, { started: false }, { started: true, playing: false, won: false }]) {
    const voice = audio.roomToneVoice(frame)
    if (frame.started === true) assert.ok(voice.level > 0, `a started frame got a silent bed: ${JSON.stringify(frame)}`)
    else assert.equal(voice.level, 0, `a frame with no run got level ${voice.level}`)
  }
  // the LFO's rate and depth travel with the voice rather than being read from the
  // table by the graph, so the two cannot describe different filters
  assert.equal(playing.lfoRate, audio.ROOM_TONE.lfoRate)
  assert.equal(playing.lfoDepth, audio.ROOM_TONE.lfoDepth)
  assert.equal(playing.cutoff, audio.ROOM_TONE.cutoff)
})

test('the wind follows the sky\'s haze, and only the sky\'s haze', () => {
  // THE COUPLING. `hazeWindVoice` takes a number and nothing else, so the wind's
  // level is a function of the sky's reading and of the frame — not of a clock of
  // its own. Two frames with the same haze must give the same wind whatever else
  // differs, and that is the whole anti-drift claim.
  const a = audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 0.42 })
  const b = audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 0.42, creatureDistance: 900, breath: 0 })
  assert.deepEqual(a, b, 'the wind is not a pure function of the frame')
  // monotone in both channels, over a grid rather than at two points
  let previousLevel = -1
  let previousCutoff = -1
  for (let haze = 0; haze <= 1.0001; haze += 0.05) {
    const voice = audio.hazeWindVoice({ ...PLAYING_FRAME, haze })
    assert.ok(voice.level >= previousLevel - 1e-12, `the wind fell at haze ${haze.toFixed(2)}`)
    assert.ok(voice.cutoff >= previousCutoff - 1e-12, `the wind dulled at haze ${haze.toFixed(2)}`)
    assert.ok(voice.level <= audio.WORLD_BED_CEILING, `the wind is over the ceiling at haze ${haze.toFixed(2)}`)
    previousLevel = voice.level
    previousCutoff = voice.cutoff
  }
  // a floor, not an absence: a wind that stopped when the sky was clear would make
  // the sky's own animation a fault in the audio
  const clear = audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 0 })
  assert.equal(clear.level, audio.HAZE_WIND.floor)
  assert.ok(clear.level > 0, 'no haze is silence')
  const thick = audio.hazeWindVoice({ ...PLAYING_FRAME, haze: 1 })
  assert.equal(thick.level, audio.HAZE_WIND.floor + audio.HAZE_WIND.range)
  assert.ok(thick.cutoff > clear.cutoff, 'thick air is not duller than thin air')
  // and a bad reading is the thinnest air, never silence and never a spike
  for (const haze of [undefined, null, NaN, -5, 4, 'lots']) {
    const voice = audio.hazeWindVoice({ ...PLAYING_FRAME, haze })
    assert.ok(voice.level > 0 && voice.level <= thick.level, `haze ${haze} gave level ${voice.level}`)
    assert.ok(Number.isFinite(voice.cutoff) && voice.cutoff >= audio.HAZE_WIND.bandLo, `haze ${haze} gave a cutoff off the table`)
  }
  // the two ends of the band are the table's, and the Q is a band rather than a
  // notch
  assert.equal(clear.cutoff, audio.HAZE_WIND.bandLo)
  assert.equal(thick.cutoff, audio.HAZE_WIND.bandHi)
  assert.ok(audio.HAZE_WIND.resonance > 0 && audio.HAZE_WIND.resonance < 2, 'the wind band is not a band')
  // THE COUPLING REACHES THE ONE-SHOTS, and the number that says so is the ratio
  // the wind voice uses to scale its gusts (`applyHazeWind`): the bed level over
  // the floor. It is 1 at no haze — so a gust is exactly the absolute level it had
  // before this pass — and it is bounded, or a thick sky would produce a gust
  // louder than the ceiling.
  assert.equal(clear.level / audio.HAZE_WIND.floor, 1, 'a gust in clear air is not the level it had before')
  assert.ok(thick.level / audio.HAZE_WIND.floor < 6, 'a gust in thick air is louder than the whole bed')
  assert.ok(thick.level / audio.HAZE_WIND.floor > 2, 'the gusts do not follow the haze at all')
  assert.equal(audio.AMBIENCE_DRIP_LEVEL, 1, 'a drip now scales with the wind')
  // the drip's scale is the IDENTITY on purpose — a drain drips whatever the sky
  // is doing — so the two scales cannot quietly become one expression
  assert.ok(Number.isFinite(audio.AMBIENCE_DRIP_LEVEL) && audio.AMBIENCE_DRIP_LEVEL > 0)
})

test('the facility stream is seeded, spaced, and placed inside the world', () => {
  // THE SCHEDULE, which is the part of the pass a person can actually notice.
  const spec = audio.AMBIENCE_SPECS.facility
  assert.equal(spec.gap.min, 20, 'the brief asks for no more often than every 20 s')
  assert.equal(spec.gap.max, 60, 'the brief asks for no less often than every 60 s')
  const events = audio.ambienceStream('facility', 1337, 200)
  assert.equal(events.length, 200)
  let previous = -1
  const kinds = new Set()
  for (const event of events) {
    const gap = event.at - previous
    assert.ok(gap >= spec.gap.min - 1e-9 && gap <= spec.gap.max + 1e-9, `a gap of ${gap.toFixed(2)}s is outside the window`)
    assert.equal(event.id, 'facility')
    assert.ok(audio.FACILITY_KIND_IDS.includes(event.kind), `an unknown kind: ${event.kind}`)
    kinds.add(event.kind)
    assert.ok(Math.abs(event.x) <= hood.WORLD_HALF && Math.abs(event.z) <= hood.WORLD_HALF, 'a noise was placed off the world')
    previous = event.at
  }
  // all three kinds turn up, so the stream is not one sound on a timer wearing
  // three names
  assert.deepEqual([...kinds].sort(), [...audio.FACILITY_KIND_IDS].sort(), 'a kind never fires')
  // the first event is a full gap out: a run that opens with a random clank is a
  // run that opens wrong
  const first = audio.ambienceStart('facility', 1337)
  assert.equal(first.index, 0)
  assert.ok(first.at >= spec.gap.min, 'the first facility noise lands on the first frame')
  // the same seed is the same schedule, byte for byte, and it is a schedule
  // rather than a list, so the cursor and the walk agree at every index
  assert.equal(
    JSON.stringify(audio.ambienceStream('facility', 1337, 200)),
    JSON.stringify(events),
    'the same seed gave a different schedule',
  )
  const other = audio.ambienceStream('facility', 4242, 200)
  assert.ok(
    other.some((event, index) => Math.abs(event.at - events[index].at) > 1e-6),
    'two seeds produced the same timings',
  )
  // THE RANDOM-ACCESS CLAIM. A stream that can only be walked from zero is a
  // schedule array with extra steps, and an hour of drips would be an hour of
  // objects in memory. So: asking at index 90 gives the same event whether or not
  // anything was asked before it.
  let cursor = audio.ambienceStart('facility', 1337)
  for (let i = 0; i < 90; i += 1) cursor = audio.nextAmbienceEvent('facility', cursor, 1337).cursor
  assert.equal(cursor.index, 90)
  assert.deepEqual(
    audio.nextAmbienceEvent('facility', { index: 90, at: cursor.at }, 1337).event,
    events[90],
    'event 90 is not a function of 90',
  )
  // and an unknown stream is answered rather than thrown
  assert.equal(audio.ambienceStart('bagpipes', 1337), null)
  assert.equal(audio.nextAmbienceEvent('bagpipes', cursor, 1337), null)
})

test('a facility noise is placed in the world, not at the speaker', () => {
  // The event is a fixed point in the city, so the LISTENER moves and the sound
  // does not. Four consequences, and each one is a different bug if it breaks.
  const [event] = audio.ambienceStream('facility', 1337, 1)
  const kind = audio.FACILITY_KINDS[event.kind]
  // the listener is placed `d` metres along +X from the EVENT, not from the
  // origin, so "the level at 12 m" means 12 m from the thing making the noise
  const at = (d, yaw = 0) => audio.facilityVoice(event, { position: { x: event.x + d, z: event.z }, yaw })
  // 1. the level IS the shared distance model, and it is zero at the edge of it
  for (const distance of [0, 1, 10, 60, 120, 200]) {
    assert.equal(
      at(distance).level,
      kind.level * beast.soundStrength(distance, audio.FACILITY_RANGE),
      `the level at ${distance}m is not the distance model`,
    )
    assert.ok(Math.abs(at(distance).distance - distance) < 1e-9, `the distance at ${distance}m is wrong`)
  }
  assert.equal(at(audio.FACILITY_RANGE).level, 0, 'a noise is audible at the edge of its range')
  // and the torus has no "far away": a million metres is a NEARBY point on a
  // 448 m wrap. The inaudible case in this world is the ANTIPODE, half the world
  // away — and it is silent only because `FACILITY_RANGE` is inside the torus's
  // own reach, which is the constraint the range docblock argues for.
  const antipode = audio.facilityVoice(event, { position: { x: event.x + hood.WORLD_EXTENT / 2, z: event.z }, yaw: 0 })
  assert.equal(antipode.distance, hood.WORLD_EXTENT / 2, 'the antipode is not half the world away')
  assert.equal(antipode.level, 0, 'the far side of the world is audible')
  assert.ok(
    audio.FACILITY_RANGE < hood.WORLD_EXTENT / 2,
    `a range of ${audio.FACILITY_RANGE}m is outside the world's own reach of ${hood.WORLD_EXTENT / 2}m, so no placement can ever be silent`,
  )
  // 2. the WRAP. The world is 448 m of torus, and an event at −224 is three
  // metres from a player at +224 — not 448. An unwrapped distance would silence
  // the stream over two thirds of the map and still pass a check on a straight
  // line.
  const near = hood.WORLD_EXTENT - 1
  const wrapped = audio.facilityVoice(event, { position: { x: event.x - near, z: event.z }, yaw: 0 })
  assert.ok(wrapped.distance < 2, `the wrapped distance is ${wrapped.distance}`)
  assert.ok(wrapped.level > at(audio.FACILITY_RANGE).level, 'the wrap bought no level')
  // 3. the PAN is a pan, and it is signed by the player's RIGHT. At yaw 0 the
  // player faces −Z with their right hand on +X (`player.js` composes the camera
  // from that yaw), so a noise to the listener's +X is on their LEFT. Turning on
  // the spot must move it across the field, and the two ends must be hard.
  const east = at(20, 0)          // the noise lies to the +X of the listener
  const north = at(20, Math.PI)   // …and the listener has turned to face it
  assert.ok(Math.abs(Math.abs(east.pan) - 1) < 1e-6, 'a noise off the shoulder is not hard against that ear')
  assert.ok(Math.abs(Math.abs(north.pan) - 1) < 1e-6, 'a noise off the other shoulder is not hard against that ear')
  assert.ok(east.pan * north.pan < 0, 'turning on the spot did not move the sound across the field')
  // and dead ahead is centred, which is the yaw that points the player's forward
  // (−sin, −cos) at the event
  const ahead = at(20, Math.PI / 2)
  assert.ok(Math.abs(ahead.pan) < 1e-9, 'a noise dead ahead is not centred')
  // the honest limit of a stereo field, stated because it is a real one: a noise
  // DIRECTLY BEHIND is also centred, so the pan carries left/right and not
  // front/back. Distance is carried by the level and the damp instead, which is
  // the whole reason the pass spends a second channel on both.
  const behind = audio.facilityVoice(event, { position: { x: event.x, z: event.z - 20 }, yaw: 0 })
  assert.ok(Math.abs(behind.pan) < 1e-9, 'a noise behind you is off to one side')
  for (const voice of [east, north, ahead, behind]) {
    assert.ok(voice.pan >= -1 && voice.pan <= 1, `a pan of ${voice.pan} is off the field`)
    assert.ok(voice.damp >= audio.FACILITY_DAMP_FAR && voice.damp <= audio.FACILITY_DAMP_NEAR, 'the damp left its window')
  }
  // 4. distance DAMPENS as well as attenuates, and it is the same claim the
  // portal hum makes on its own pair of numbers
  assert.ok(at(0).damp > at(120).damp, 'a far noise is not duller')
  assert.equal(at(0).damp, audio.FACILITY_DAMP_NEAR)
  assert.ok(at(200).damp < audio.FACILITY_DAMP_NEAR * 0.6)
  // 5. and a source nobody can locate is SILENT, not loud. This is the one that
  // matters: a noise computed from a broken input is a noise out of nowhere.
  for (const frame of [{}, { position: null }, { position: {} }, { position: { x: NaN, z: 0 } }, { position: 'here' }]) {
    const voice = audio.facilityVoice(event, frame)
    assert.equal(voice.level, 0, `a listener of ${JSON.stringify(frame)} made a sound`)
    assert.equal(voice.pan, 0)
    assert.equal(voice.distance, null)
  }
  assert.equal(audio.facilityVoice(null, LISTENER).level, 0, 'no event is a sound')
  assert.equal(audio.facilityVoice({ ...event, kind: 'bagpipes' }, LISTENER).level, 0, 'an unknown kind is a sound')
  assert.equal(audio.facilityVoice({ ...event, x: NaN }, LISTENER).level, 0)
  // a source off the world is a *wrapped* one, not a silent one: 1e9 m folds to
  // somewhere in the city, and pretending otherwise would mean a second distance
  // model — the one this pass explicitly refused to write
  const offWorld = audio.facilityVoice({ ...event, x: 1e9 }, LISTENER)
  assert.ok(offWorld.distance <= hood.WORLD_EXTENT / 2, 'a wrapped distance left the world')
  assert.equal(offWorld.level, audio.FACILITY_KINDS[event.kind].level * beast.soundStrength(offWorld.distance, audio.FACILITY_RANGE))
})

test('the portal hum dims with distance as well as with level', () => {
  // §13: the hum is progress feedback IN-WORLD, and the player is meant to find a
  // portal by ear. The level already fell with distance (slice 11); pass 13 added
  // the second channel, because one channel is a volume knob and two is a
  // distance.
  const live = (distance) => audio.portalHumVoice({ id: 'A', progress: 0, distance })
  assert.equal(live(0).damp, audio.PORTAL_HUM_DAMP_NEAR, 'a hum at arm\'s length is not open')
  assert.equal(live(audio.PORTAL_HUM_RANGE).damp, audio.PORTAL_HUM_DAMP_FAR, 'a hum at the edge is not closed')
  assert.ok(audio.PORTAL_HUM_DAMP_FAR < audio.PORTAL_HUM_DAMP_NEAR)
  let previous = Infinity
  for (let d = 0; d <= audio.PORTAL_HUM_RANGE; d += 0.25) {
    const damp = live(d).damp
    assert.ok(damp < previous + 1e-9, `the hum got brighter at ${d}m`)
    previous = damp
  }
  // it is DISTANCE and nothing else: progress, the swell and a shutdown all leave
  // the damp alone, exactly as they leave the level alone
  for (const progress of [0, 0.5, rules.PORTAL_NOISE_THRESHOLD, 1]) {
    assert.equal(
      audio.portalHumVoice({ id: 'A', progress, distance: 12 }).damp,
      audio.portalHumVoice({ id: 'A', progress: 0, distance: 12 }).damp,
      'progress changed the damp',
    )
  }
  // a shut portal is silent but still reports the damping it died on, the way it
  // still reports the pitch it died on
  const dead = audio.portalHumVoice({ id: 'A', progress: 1, shut: true, distance: 5 })
  assert.equal(dead.level, 0)
  assert.equal(dead.damp, audio.portalHumVoice({ id: 'A', progress: 0, distance: 5 }).damp)
  assert.equal(audio.portalHumVoice({ id: 'A', distance: NaN }).damp, audio.PORTAL_HUM_DAMP_FAR, 'an unknown distance is a bright hum')
})

test('the noise floor and the draw streams are the seed and nothing else', () => {
  // `fillNoise` replaces `Math.random() * 2 - 1` over 96 000 samples, and the two
  // remaining draws come from per-voice streams. All three are claims about
  // reproducibility, so they are checked as reproducibility rather than as taste.
  const a = new Float32Array(4096)
  const b = new Float32Array(4096)
  assert.equal(audio.fillNoise(a, 1337), a, 'fillNoise does not return its target')
  audio.fillNoise(b, 1337)
  assert.deepEqual([...a], [...b], 'two runs of the same seed hum differently')
  audio.fillNoise(b, 4242)
  assert.notDeepEqual([...a], [...b], 'two seeds hum the same')
  // it is NOISE and not a tone: bounded, zero-mean, and uncorrelated with itself
  // one sample apart. A filter or a sine would fail the third of these.
  let sum = 0
  let lag = 0
  for (let i = 0; i < a.length; i += 1) {
    assert.ok(a[i] >= -1 && a[i] < 1, `sample ${i} is ${a[i]}, outside [-1, 1)`)
    sum += a[i]
    if (i > 0) lag += a[i] * a[i - 1]
  }
  const mean = sum / a.length
  assert.ok(Math.abs(mean) < 0.05, `the floor is not zero-mean: ${mean.toFixed(4)}`)
  const correlation = lag / (a.length - 1)
  assert.ok(Math.abs(correlation) < 0.05, `the floor is correlated with itself: ${correlation.toFixed(4)}`)
  // a different salt is a different floor, and that is the extension point a
  // future wet-street or louder-building caller needs
  const salted = new Float32Array(512)
  audio.fillNoise(salted, 1337, 0x0badf00d)
  assert.notDeepEqual([...salted.slice(0, 64)], [...a.slice(0, 64)], 'the salt does nothing')
  // the per-voice streams: same seed and channel is the same sequence, and two
  // channels of one run are independent, which is what stops a new sound from
  // retuning the footstep
  const take = (seed, channel, count = 8) => {
    const draw = audio.createDraw(seed, channel)
    return Array.from({ length: count }, () => draw())
  }
  const footstep = take(1337, audio.DRAW_CHANNELS.footstep)
  const echo = take(1337, audio.DRAW_CHANNELS.echo)
  for (const value of [...footstep, ...echo]) {
    assert.ok(value >= 0 && value < 1, `a draw of ${value} is outside [0, 1)`)
  }
  assert.deepEqual(footstep, take(1337, audio.DRAW_CHANNELS.footstep), 'a channel is not reproducible')
  assert.notDeepEqual(footstep, echo, 'two channels share a sequence')
  assert.notDeepEqual(footstep, take(4242, audio.DRAW_CHANNELS.footstep), 'a seed is not reproducible')
  // and the channels are a table, not a free integer, because a channel is a
  // voice and an unnamed voice cannot be found by whoever comes next
  assert.ok(Object.isFrozen(audio.DRAW_CHANNELS))
  for (const name of ['footstep', 'echo']) {
    assert.ok(Number.isInteger(audio.DRAW_CHANNELS[name]), `${name} has no channel`)
  }
  assert.equal(
    new Set(Object.values(audio.DRAW_CHANNELS)).size,
    Object.keys(audio.DRAW_CHANNELS).length,
    'two voices share a channel',
  )
})

test('a backlog does not arrive as a burst, and a pause freezes the bed', () => {
  // The cursor machine is driven on a REAL manager rather than a hand-made stub:
  // `_advanceAmbience` and `_cursor` touch nothing but `this.seed` and
  // `this.ambience`, and a real manager with no AudioContext is the honest way to
  // say "the clock, with none of the audio around it". The machine is where the
  // pause and the hidden-tab bugs live: three numbers and a `while`.
  const stub = () => {
    const manager = new audio.AudioManager()
    manager.setSeed(1337)
    return manager
  }
  const advance = (self, id, dt, fired) => self._advanceAmbience(id, dt, (event) => fired.push(event))
  // 1. one event at a time on an ordinary frame, and none at all before the gap
  {
    const self = stub()
    const fired = []
    assert.equal(advance(self, 'drip', 1 / 60, fired), 0, 'a drip landed on the first frame')
    // the first event's own time, from the pure schedule — not the gap's minimum,
    // which is only the earliest the seeded draw could have put it
    const first = audio.ambienceStart('drip', 1337).at
    for (let i = 0; i < Math.ceil(first * 60) + 4; i += 1) advance(self, 'drip', 1 / 60, fired)
    assert.equal(fired.length, 1, `${fired.length} drips landed in the first gap`)
    assert.equal(fired[0].kind, 'drip')
    assert.ok(Math.abs(fired[0].at - first) < 1e-9, 'the drip that fired was not the first one')
  }
  // 2. a frame that arrives after the tab was hidden drops the backlog instead of
  // playing it. Ten minutes of drips on the frame the player comes back is the
  // most audible way this could be wrong, and the cap is what prevents it.
  {
    const self = stub()
    const fired = []
    const oneFrame = advance(self, 'drip', 600, fired)
    assert.equal(oneFrame, audio.AMBIENCE_MAX_PER_FRAME, 'a hidden tab played its whole backlog')
    assert.equal(fired.length, audio.AMBIENCE_MAX_PER_FRAME)
    const cursor = self.ambience.get('drip')
    assert.equal(cursor.clock, 600, 'the clock did not advance by the frame')
    assert.ok(cursor.at >= 600, `the cursor is still behind the clock at ${cursor.at}`)
    // and the stream RESUMES from the new base rather than queueing
    const before = cursor.index
    for (let i = 0; i < 30; i += 1) advance(self, 'drip', 1 / 60, fired)
    assert.ok(cursor.index > before, 'the stream stopped after a dropped backlog')
  }
  // 3. a dt of zero or less is not time passing. The world's paused frame still
  // calls `_updateAudio`, and a cursor that advanced on it would keep the bed
  // breathing through the pause card.
  {
    const self = stub()
    for (const dt of [0, -1, NaN, undefined]) {
      assert.equal(advance(self, 'gust', dt, []), 0, `a dt of ${dt} moved the bed`)
      assert.equal(self.ambience.get('gust')?.clock ?? 0, 0, `a dt of ${dt} advanced the clock`)
    }
  }
  // 4. the fired events are the SCHEDULE's events, in the schedule's order, and
  // not a re-derivation: this is what ties the voice to the pure function the
  // checks above walk
  {
    const self = stub()
    const fired = []
    for (let i = 0; i < 3600; i += 1) advance(self, 'facility', 1 / 60, fired)
    const expected = audio.ambienceStream('facility', 1337, fired.length + 1)
    assert.deepEqual(fired, expected.slice(0, fired.length), 'the voice is not playing the schedule')
    // a minute of play is 60 s of a 20-60 s stream, so it is a FEW events and
    // never a stream of them: this is the assertion that a seeded schedule is
    // occasional rather than rhythmic
    assert.ok(fired.length >= 1, `no facility noise in a minute of play (${fired.length})`)
    assert.ok(fired.length <= 4, `${fired.length} facility noises in a minute of play is a rhythm, not a place`)
  }
  // 5. an unknown stream is a no-op rather than a throw
  {
    const self = stub()
    assert.equal(advance(self, 'bagpipes', 1, []), 0)
    assert.equal(advance(self, 'drip', 1, null), 0, 'a missing callback is a crash')
  }
})

test('the bed has no unseeded draw and no timer left in it', () => {
  // The absence claims, read out of the CODE (prose stripped, so a comment that
  // says "Math.random" in order to explain why there is none cannot satisfy this).
  //
  // This is the check that would have caught the pass not happening: before it,
  // every one of these greps was true, and every other check in this file passed
  // with them true.
  const code = stripProse(AUDIO_SOURCE)
  for (const forbidden of ['Math.random', 'setTimeout', 'setInterval', 'Date.now', 'performance.now', 'new Date']) {
    assert.equal(code.includes(forbidden), false, `audio.js still reaches for ${forbidden}`)
  }
  // the noise buffer is filled by the seeded function, not inline. This and the
  // two call-forms below are read from the RAW source, because `stripProse` is
  // about the absence claims and it blanks the string literals the stream ids
  // are written with.
  assert.ok(AUDIO_SOURCE.includes('fillNoise(buffer.getChannelData(0), this.seed)'), 'the noise floor is not the seeded one')
  // the ambience is on the world's clock: the cursors are advanced by the frame's dt
  for (const id of audio.AMBIENCE_IDS) {
    assert.ok(
      AUDIO_SOURCE.includes(`_advanceAmbience('${id}', dt`),
      `the ${id} stream is not driven by the frame clock`,
    )
  }
  // the old scheduler is gone by name, and so is the handle array it filled
  assert.equal(code.includes('_scheduleAmbient'), false, 'the setTimeout scheduler survived')
  assert.equal(code.includes('_ambientTimers'), false, 'the timer handle array survived')
  // and the world is the only thing that can hand the bed a position: the file
  // cannot read the camera or the scene, so it cannot place a noise any other way
  assert.equal(code.includes('this.scene'), false, 'the audio reached for the scene')
  assert.equal(code.includes('camera'), false, 'the audio reached for the camera instead of the frame')
})

test('a manager that was never unlocked still builds nothing, and knows its seed', () => {
  // The autoplay half of the brief, stated as a check: a manager that no gesture
  // has reached builds no AudioContext, no bed and no cursors, and every voice on
  // every row survives being called on it. `routeAudio` is given a frame with all
  // three pass-13 fields, so the new rows are exercised with real values rather
  // than with `undefined`.
  const manager = new audio.AudioManager()
  assert.equal(manager.ready, false)
  assert.equal(manager.seed, DEFAULT_SEED, 'the manager does not default to the shared seed')
  // `setSeed` takes the world's number, and drops what was derived from the old
  // one: a cursor or a noise buffer left behind would be the previous run's
  manager.setSeed(99)
  manager.ambience.set('drip', { index: 3, at: 12, clock: 30 })
  manager.draws.set(1, audio.createDraw(1, 1))
  assert.equal(manager.setSeed(101), 101)
  assert.equal(manager.seed, 101)
  assert.equal(manager.ambience.size, 0, 'setSeed kept a cursor from the old run')
  assert.equal(manager.draws.size, 0, 'setSeed kept a draw stream from the old run')
  assert.equal(manager.setSeed(NaN), 101, 'a bad seed was accepted')
  // `stopAmbience` is the cheap one: cursors only, no nodes touched, so it is
  // legal to call on a manager that never built anything
  manager.stopAmbience()
  // and the full frame through every row, still with no context
  const frame = { ...PLAYING_FRAME, position: { x: 3, z: 4 }, yaw: 0.5, haze: 0.7, portals: [{ id: 'A', distance: 4 }] }
  manager.update(1 / 60, frame)
  for (const row of audio.AUDIO_ROUTES) {
    manager[row.voice].call(manager, audio.routeAudio(frame).find((cue) => cue.id === row.id), 1 / 60)
  }
  assert.equal(manager.ready, false, 'a headless manager built an AudioContext')
  assert.equal(manager.bed, null, 'a headless manager built a bed')
  assert.equal(manager.ambience.size, 0, 'a headless manager advanced a cursor')
  assert.equal(manager.hums.size, 0, 'a headless manager built a hum')
})

test('the world and the audio read one seed, not two', () => {
  // `DEFAULT_SEED` is the seam that stops "the world defaults to 1337" and "the
  // audio defaults to 1337" from being two facts that agree today. Neither module
  // may name a literal.
  assert.equal(DEFAULT_SEED, 1337, 'the shared default moved')
  assert.ok(Number.isInteger(DEFAULT_SEED))
  const audioConstructor = AUDIO_SOURCE.slice(AUDIO_SOURCE.indexOf('constructor(options = {}) {'))
  const worldConstructor = WORLD_SOURCE.slice(WORLD_SOURCE.indexOf('constructor(container, options = {}) {'))
  assert.ok(
    /this\.seed = Number\.isFinite\(options\.seed\) \? options\.seed : DEFAULT_SEED/.test(audioConstructor),
    'the manager does not fall back to the shared seed',
  )
  assert.ok(
    /this\.seed = options\.seed \?\? DEFAULT_SEED/.test(worldConstructor),
    'the world does not fall back to the shared seed',
  )
  // the world hands it over, and does so after it knows its own seed and before
  // anything that could read it
  const handOver = worldConstructor.indexOf('this.audio?.setSeed?.(this.seed)')
  assert.ok(handOver > worldConstructor.indexOf('this.seed = options.seed'), 'the audio is seeded before the world knows its seed')
  assert.ok(handOver < worldConstructor.indexOf('this._buildLights()'), 'the audio is seeded after the world is built')
  assert.match(AUDIO_SOURCE, /import \{ hash32, mulberry32, streamAt, DEFAULT_SEED \} from '\.\/hash\.js'/)
})
// ---------------------------------------------------------------------------
// the store React subscribes to — v2's `src/game/store.js`
//
// WHAT SURVIVED v1's `loop.js` HERE, AND WHY
// ------------------------------------------
// The three v1 store tests are gone and one of them is the only one that was
// ever about a rule rather than about the game. "the store only notifies when a
// value actually changes" is not a claim about candles: it is the repaint
// budget. `world.js`'s `_syncHud` quantizes every continuous value onto
// `hud.STEPS` before it writes, and the whole reason that works is that a patch
// of identical values is not an event. Drop the rule and the HUD repaints sixty
// times a second to redraw three identical sigils, so the test is kept, restated
// against v2's own fields.
//
// The other two are gone with their reducers: `applyLightCandle` and `beginLoop`
// are a candle and a countdown, and the run that used them is the one that is
// deleted. `PHASE` is the survivor that matters, so it gets a test of its own
// now that it is no longer sharing a file with a bell.
// ---------------------------------------------------------------------------

section('Store')

test('the store only notifies when a value actually changes', () => {
  const store = createStore({ phase: PHASE.PLAYING, loop: 1 })
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  store.set({ phase: PHASE.PLAYING })
  assert.equal(notifications, 0, 'setting the same phase must not re-render React')
  store.set({ loop: 2 })
  assert.equal(notifications, 1)
  store.set({ loop: 2, awareness: 0.5 })
  assert.equal(notifications, 2)
  assert.equal(store.listenerCount(), 1)
  unsubscribe()
  assert.equal(store.listenerCount(), 0)
  store.set({ loop: 3 })
  assert.equal(notifications, 2, 'unsubscribed listeners must not fire')
  assert.equal(store.get().loop, 3)
})

test('store.update() is the atomic read-modify-write, and it merges nothing', () => {
  const store = createStore({ phase: PHASE.PLAYING, portals: { A: false, B: false, C: false } })
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })
  const first = store.get()
  store.update((state) => ({ ...state, portals: { ...state.portals, A: true } }))
  assert.equal(store.get().portals.A, true)
  assert.equal(store.get().phase, PHASE.PLAYING, 'update replaces the state, it does not patch it')
  assert.notEqual(store.get(), first, 'a reducer that returns a new object must be adopted')
  assert.equal(notifications, 1)
  // a reducer that returns the same object is a no-op, not an event
  store.update((state) => state)
  assert.equal(notifications, 1)
})

test('PHASE is still the four §10.5 moments, and the finale is not a fifth', () => {
  assert.deepEqual(Object.values(PHASE).sort(), ['playing', 'reset', 'start', 'won'])
  assert.deepEqual(Object.values(PHASE), ['start', 'playing', 'reset', 'won'])
  // §10.5: the finale is a flag on the run state, so the phase of a finished run
  // is `playing` until the player is inside the car. This is the sentence the
  // finale's whole rule set hangs on, and it is now checkable in one line
  // because the flag and the phase are in different objects.
  const objectives = hood.placeObjectives(1337, 1)
  const opening = rules.createInitialState(objectives, { loop: 1 })
  assert.equal(opening.phase, undefined, 'a run state carries no phase of its own')
  assert.equal(rules.triggersFinale(opening.portals), false)
  const finished = { ...opening, portals: { A: true, B: true, C: true }, finale: true }
  assert.equal(rules.triggersFinale(finished.portals), true, 'three and only three')
  assert.equal(finished.finale, true, 'and the flag is what the rest of the run reads')
  // the win still needs the geometry: the flag alone, standing in the street,
  // is not a win. That is §10.4's conjunction, and the finale flag is the half
  // a careless implementation forgets.
  assert.equal(
    rules.checkExitWin(finished, { x: objectives.exit.position.x, z: objectives.exit.position.z }),
    true,
  )
  assert.equal(rules.checkExitWin(finished, { x: 0, z: 0 }), false)
  assert.equal(rules.checkExitWin(opening, { x: 0, z: 0 }), false)
  assert.equal(PHASE.FINAL, undefined, 'a fifth phase crept back in')
})

test('createStartStore() is the title screen, and the HUD projects it', () => {
  const store = createStartStore()
  assert.deepEqual(store.get(), { phase: PHASE.START, loop: 1, fade: 1 })
  // `hudSnapshot` is total, and this is the call `App.jsx` makes before the world
  // exists: three fields in, a complete set of paint values out, nothing thrown
  // and no `undefined` where the overlay is about to be painted.
  const snapshot = hud.hudSnapshot(store.get())
  assert.equal(snapshot.phase, PHASE.START)
  assert.equal(snapshot.loop, 1)
  assert.equal(snapshot.fade, 1)
  assert.deepEqual(snapshot.sigils, hud.portalSigils({ A: false, B: false, C: false }))
  assert.equal(snapshot.hammer.state, hud.SIGIL_DARK, 'no hammer before the pickup')
  assert.equal(snapshot.hammer.flash, 0, 'and no §14.3 flash on the title screen')
  assert.equal(snapshot.vignette.clear, hud.VIGNETTE_CLEAR_OPEN, 'nothing is hunting yet')
  assert.equal(snapshot.prompt, null, '§14.1: the HUD never says a word')
})

// ---------------------------------------------------------------------------
// v2 slice 12 — the HUD and the accessibility layer
// ---------------------------------------------------------------------------

section('HUD and accessibility (v2 slice 12)')

const HUD_SOURCE = readFileSync(new URL('./src/ui/hud.js', import.meta.url), 'utf8')
const HUD_JSX_SOURCE = readFileSync(new URL('./src/ui/Hud.jsx', import.meta.url), 'utf8')
const PAUSE_JSX_SOURCE = readFileSync(new URL('./src/ui/PauseOverlay.jsx', import.meta.url), 'utf8')
const STYLES_SOURCE = readFileSync(new URL('./src/ui/styles.css', import.meta.url), 'utf8')

/** A state object shaped like the one the world writes, for the projection. */
function hudState(patch = {}) {
  return {
    phase: PHASE.PLAYING,
    loop: 1,
    fade: 0,
    prompt: null,
    fps: 0,
    showFps: false,
    portals: { A: false, B: false, C: false },
    hammerHeld: false,
    hammerFlash: 0,
    hold: 0,
    awareness: 0,
    breath: 1,
    exhausted: false,
    creaturePresent: false,
    finale: false,
    finaleLevel: 0,
    paused: false,
    motionPreference: null,
    reducedMotionSystem: false,
    ...patch,
  }
}

test('the projection returns a closed set of fields, and none of them is a meter', () => {
  // §6.4 "no awareness bar", §7.3's undrawn breath, §14.1's "no distance
  // readout": all three are claims about what the HUD is *able* to show, so they
  // are checked against the key set rather than against a stylesheet. Adding a
  // readout to this game now means adding a line to `HUD_FIELDS` first.
  const painted = hud.hudSnapshot(hudState())
  assert.deepEqual([...hud.HUD_FIELDS].sort(), Object.keys(painted).sort(), 'the projection grew a field')
  for (const forbidden of ['awareness', 'breath', 'distance', 'creatureDistance', 'awarenessLevel', 'stamina', 'meter']) {
    assert.equal(forbidden in painted, false, `the projection exposes ${forbidden}`)
  }
  // and the three sigils plus the hammer, which is the whole of §14.1
  assert.equal(painted.sigils.length, 3)
  assert.equal(painted.hammer.state, hud.SIGIL_DARK)
})

test('the projection is total over the store the title screen really has', () => {
  // `App.jsx` paints `hudSnapshot` of a three-field store before the world has
  // written a single frame, so a projection that assumed otherwise would take the
  // title screen down with it. Slice 16 deleted v1's `createInitialState`, which
  // used to stand in for that store here; `createStartStore()` is the real thing,
  // and this is the check that the projection survives both of its extremes — the
  // thinnest store the game ever has and a full run state.
  const painted = hud.hudSnapshot(createStartStore().get())
  assert.equal(painted.phase, PHASE.START)
  assert.equal(painted.loop, 1)
  assert.equal(painted.prompt, null)
  assert.equal(painted.reducedMotion, false)
  assert.deepEqual([...hud.HUD_FIELDS].sort(), Object.keys(painted).sort())
  // and the other extreme: a full v2 run state, which is the *thinnest* thing the
  // projection can be handed that still has every optional field missing
  const full = hud.hudSnapshot(rules.createInitialState(hood.placeObjectives(1337, 1)))
  assert.deepEqual([...hud.HUD_FIELDS].sort(), Object.keys(full).sort())
  assert.equal(full.hammer.state, hud.SIGIL_DARK)
  assert.equal(hud.hudSnapshot().phase, undefined, 'an absent phase stays absent, not invented')
})

test('every string the HUD can paint comes from a closed vocabulary', () => {
  // §14.1: "No new text is introduced." The loop counter is a *number* in a
  // dedicated slot. Everything else the projection can hand a renderer is a
  // token, and the whole set is written down here: the two prompt kinds, the
  // three portal ids, the two sigil states and the four inks. There is no string
  // in the projection from which a label could be assembled, which is the
  // checkable form of "no new text".
  const vocabulary = new Set([
    ...hud.HUD_STRING_VALUES,
    ...Object.values(PHASE),
    ...hood.PORTAL_IDS,
    hud.SIGIL_LIT,
    hud.SIGIL_DARK,
    hud.PORTAL_SIGIL_LIT,
    hud.PORTAL_SIGIL_DARK,
    hud.PORTAL_SIGIL_INK,
    hud.HAMMER_SIGIL_LIT,
    hud.HAMMER_SIGIL_DARK,
    hud.HAMMER_SIGIL_INK,
  ])
  const strings = new Set()
  const walk = (value) => {
    if (value === null) {
      strings.add(null)
      return
    }
    // a numeric string is SVG geometry (`strokeDashoffset`), not a label
    if (typeof value === 'string') {
      if (!Number.isFinite(Number(value))) strings.add(value)
      return
    }
    if (typeof value === 'object') for (const inner of Object.values(value)) walk(inner)
  }
  for (const state of [hudState(), hudState({ prompt: 'portal' }), hudState({ prompt: 'hammer' })]) {
    walk(hud.hudSnapshot(state))
  }
  for (const value of strings) {
    assert.ok(vocabulary.has(value), `the projection can paint an unvouched string: ${JSON.stringify(value)}`)
  }
  // and the two that are load-bearing are the prompt kinds, exactly
  assert.ok(strings.has('portal') && strings.has('hammer') && strings.has(null))
  // nothing in the vocabulary reads as a phrase: the only multi-word token the
  // HUD can emit is a phase, and §10.5 documents those four
  for (const value of strings) {
    if (value === null) continue
    assert.equal(value.includes(' '), false, `${JSON.stringify(value)} reads like a label`)
  }
  assert.deepEqual([...Object.values(PHASE)].sort(), ['playing', 'reset', 'start', 'won'])
})

test('a portal sigil goes DARK when its portal is shut, and lit while it is live', () => {
  // The one polarity in this slice that is genuinely easy to get backwards, and
  // §14.1 is explicit: "cyan and lit, dark and extinguished". `state.portals[id]`
  // is §5.3's *shut* flag, which is the opposite of v1's `candles[id]`, so the
  // v1 mirror lit its three flames on progress and this one must not.
  const shut = hud.portalSigils({ A: true, B: false, C: true })
  assert.deepEqual(shut.map((s) => s.state), [hud.SIGIL_DARK, hud.SIGIL_LIT, hud.SIGIL_DARK])
  assert.equal(hud.portalSigil(true), hud.SIGIL_DARK)
  assert.equal(hud.portalSigil(false), hud.SIGIL_LIT)
  // §5.3 is permanent, and the sigil has no way back: there is no `unshut`
  const live = hud.portalSigils({ A: false, B: false, C: false })
  assert.deepEqual(live.map((s) => s.state), [hud.SIGIL_LIT, hud.SIGIL_LIT, hud.SIGIL_LIT])
  // and the hammer is dark until pickup, in its own family
  assert.equal(hud.hammerMark(false).state, hud.SIGIL_DARK)
  assert.equal(hud.hammerMark(true).state, hud.SIGIL_LIT)
  assert.notEqual(hud.hammerMark(true).color, hud.portalSigils({})[0].color, 'the hammer is not a portal')
})

test('lit is a solid fill and extinguished is a hollow outline', () => {
  // §14.3's first bullet, as geometry: the two states differ in *shape* before
  // they differ in hue, which is what survives a greyscale screenshot.
  const palette = { lit: hud.PORTAL_SIGIL_LIT, dark: hud.PORTAL_SIGIL_DARK, rim: '#ffffff' }
  const lit = hud.sigilMark(hud.SIGIL_LIT, palette)
  const dark = hud.sigilMark(hud.SIGIL_DARK, palette)
  assert.equal(lit.filled, true)
  assert.equal(dark.filled, false, 'an extinguished sigil is not hollow')
  assert.notEqual(lit.glow, dark.glow)
})

test('every sigil state is legible in greyscale, on the shell background', () => {
  // §12.2's own extinguished cyan is 1.36:1 on `--bg` — a mark nobody can see —
  // so the HUD ink is a lifted member of the same family, and the two numbers
  // below are what make that a rule rather than an opinion.
  for (const ink of [hud.PORTAL_SIGIL_LIT, hud.PORTAL_SIGIL_DARK, hud.HAMMER_SIGIL_LIT, hud.HAMMER_SIGIL_DARK]) {
    assert.ok(
      hud.contrastRatio(ink, hud.HUD_BACKDROP) >= hud.SIGIL_MIN_CONTRAST,
      `${ink} is invisible on the HUD backdrop (${hud.contrastRatio(ink, hud.HUD_BACKDROP).toFixed(2)}:1)`,
    )
  }
  // the greyscale channel: with hue removed, lit and extinguished still separate
  assert.ok(hud.luminanceRatio(hud.PORTAL_SIGIL_LIT, hud.PORTAL_SIGIL_DARK) >= hud.SIGIL_MIN_LUMINANCE_RATIO)
  assert.ok(hud.luminanceRatio(hud.HAMMER_SIGIL_LIT, hud.HAMMER_SIGIL_DARK) >= hud.SIGIL_MIN_LUMINANCE_RATIO)
  // and the two families do not collide, so nothing in the game is two things
  assert.ok(hud.relativeLuminance(hud.PORTAL_SIGIL_LIT) < hud.relativeLuminance(hud.HAMMER_SIGIL_LIT))
  // a lit sigil's keyline is drawn *over* its body, so the edge it draws has to
  // clear 3:1 against the fill — otherwise the solid shape loses its outline and
  // the sigil is a coloured blob with no edge in greyscale
  assert.ok(hud.contrastRatio(hud.PORTAL_SIGIL_INK, hud.PORTAL_SIGIL_LIT) >= hud.SIGIL_MIN_CONTRAST)
  assert.ok(hud.contrastRatio(hud.HAMMER_SIGIL_INK, hud.HAMMER_SIGIL_LIT) >= hud.SIGIL_MIN_CONTRAST)
  // and the outline ink is the *same* in both states, so the fill is the only
  // channel carrying the state at all
  const litMark = hud.portalSigils({})[0]
  const darkMark = hud.portalSigils({ A: true })[0]
  assert.equal(litMark.stroke, darkMark.stroke, 'the outline ink changes with the state')
  assert.notEqual(litMark.color, darkMark.color)
  // §12.2: cyan is the objective and amber is the neighbourhood, and they mix
  assert.equal(hud.PORTAL_SIGIL_LIT, '#3ad6d6')
  assert.notEqual(hud.PORTAL_SIGIL_DARK, '#0b2b2b', 'the world ink is not the HUD ink')
})

test('the colour maths is a real WCAG implementation, not a stand-in', () => {
  // white on black is the 21:1 anchor and black on black the 1:1 one; a broken
  // transfer function would still produce a plausible-looking number for cyan
  assert.ok(Math.abs(hud.contrastRatio('#ffffff', '#000000') - 21) < 1e-6)
  assert.ok(Math.abs(hud.contrastRatio('#000000', '#000000') - 1) < 1e-6)
  assert.ok(Math.abs(hud.relativeLuminance('#ffffff') - 1) < 1e-6)
  assert.equal(hud.relativeLuminance('#000000'), 0)
  assert.equal(hud.parseHex('nonsense'), null)
  // #abc is the short form of #aabbcc, and both are the same colour
  assert.equal(hud.relativeLuminance('#abc'), hud.relativeLuminance('#aabbcc'))
})

test('the hold ring reaches exactly 1, and its tick sits on the rule threshold', () => {
  // §14.2 and §5.2 together. The ring's midpoint tick is the noise threshold
  // communicated spatially, so the tick has to be at the same place the rule
  // charges for the sound — derived from `PORTAL_NOISE_THRESHOLD`, never a
  // literal, and asserted against the rule itself over the whole range.
  assert.equal(hud.HOLD_RING.tick, rules.PORTAL_NOISE_THRESHOLD)
  assert.equal(hud.holdRing(0).fraction, 0)
  assert.equal(hud.holdRing(1).fraction, 1, 'the ring does not close')
  assert.equal(hud.holdRing(1).loud, true)
  assert.equal(hud.holdRing(0).loud, false)
  // through the quantizer the world writes it on, 1 is still exactly 1
  for (const steps of [1, hud.STEPS.hold, 48, 96, 1000]) {
    assert.equal(hud.quantize(1, steps), 1, `quantize(1, ${steps}) is not 1`)
    assert.equal(hud.quantize(0, steps), 0, `quantize(0, ${steps}) is not 0`)
  }
  // and the midpoint lands on a whole step, so the tick cannot fall between two
  // painted frames
  assert.equal(hud.quantize(rules.PORTAL_NOISE_THRESHOLD, hud.STEPS.hold), rules.PORTAL_NOISE_THRESHOLD)
})

test('the ring is loud exactly when the rule starts charging for the sound', () => {
  // "emits its sound event only past the midpoint tick" — and "past" read as
  // `>=`, because `rules.js` compares with `>=` and the world's own gate uses
  // the same expression. One thousand fractions, compared against the rule's own
  // answer for the same fraction rather than against a restatement of it.
  for (let step = 0; step <= 1000; step += 1) {
    const fraction = step / 1000
    const rule = rules.portalShutProgress(0, fraction * rules.PORTAL_SHUT_SECONDS, true)
    assert.equal(hud.holdLoud(fraction), rule.soundEmitted, `the ring disagrees at ${fraction}`)
  }
  // the rule is the authority on the value itself, too
  assert.equal(rules.PORTAL_NOISE_THRESHOLD, 0.5)
})

test("the ring's geometry is a real 0 -> 1 -> 0 arc", () => {
  // a sweep of the offset has to be linear and complete: a ring that fills and
  // then empties is v1's heartbeat language, and §14.2 asks for that language
  const full = hud.HOLD_RING.circumference
  assert.ok(Math.abs(hud.holdRing(0).dashOffset - full) < 1e-9, 'a fresh ring is not empty')
  assert.ok(Math.abs(hud.holdRing(1).dashOffset) < 1e-9, 'a full ring still has an offset')
  assert.ok(Math.abs(hud.holdRing(0.5).dashOffset - full / 2) < 1e-9, 'the arc is not linear')
  // out-of-range input is clamped rather than drawn outside the circle
  assert.equal(hud.holdRing(-4).fraction, 0)
  assert.equal(hud.holdRing(9).fraction, 1)
  assert.equal(hud.holdRing(NaN).fraction, 0)
  // and the tick is where the threshold is, in degrees from twelve o'clock
  assert.equal(hud.holdRing(0).tickAngle, 180)
})

test('the ring is inactive without a prompt and active with one', () => {
  assert.equal(hud.holdRing(0, null).active, false)
  assert.equal(hud.holdRing(0, 'portal').active, true)
  assert.equal(hud.holdRing(0, 'hammer').active, true)
  // the projection carries the prompt through as the ring's kind, so the
  // component never has to decide what is in reach
  assert.equal(hud.hudSnapshot(hudState({ hold: 0.4, prompt: 'portal' })).ring.kind, 'portal')
  assert.equal(hud.hudSnapshot(hudState({ hold: 0.4 })).ring.active, false)
})

test('the awareness tell tightens and coarsens monotonically, and only while present', () => {
  // §6.4: the meter is read as a *trend* in two channels — a narrowing clear
  // radius and a coarsening grain — never as a number. Both must be monotone, or
  // the tell is unreadable, and the grain scale has to rise (bigger tiles =
  // coarser) rather than fall.
  let previous = null
  for (let step = 0; step <= 200; step += 1) {
    const value = step / 200
    const tell = hud.awarenessTell(value, { present: true })
    assert.ok(tell.vignette >= 0 && tell.vignette <= 1, `vignette out of range at ${value}`)
    assert.ok(tell.grain >= 0 && tell.grain <= 1, `grain out of range at ${value}`)
    assert.ok(tell.grainScale >= hud.AWARENESS_GRAIN_FINE, `the grain got finer at ${value}`)
    if (previous) {
      assert.ok(tell.vignette >= previous.vignette - 1e-12, `the vignette loosened at ${value}`)
      assert.ok(tell.grain >= previous.grain - 1e-12, `the grain cleared at ${value}`)
      assert.ok(tell.grainScale >= previous.grainScale - 1e-12, `the grain sharpened at ${value}`)
    }
    previous = tell
  }
  assert.equal(hud.awarenessTell(0, { present: true }).vignette, 0, 'an unaware creature darkens the screen')
  assert.ok(hud.awarenessTell(1, { present: true }).vignette > 0)
  // §6.4 plus §7.4: a banished or dormant creature is off the field, so a full
  // meter belonging to something that is not there reads as nothing at all
  assert.equal(hud.awarenessTell(1, { present: false }).vignette, 0)
  assert.equal(hud.awarenessTell(1, { present: false }).grainScale, hud.AWARENESS_GRAIN_FINE)
  // §6.2's own bands: investigating is visible, and a chase is more so
  assert.ok(hud.awarenessTell(beast.AWARENESS_INVESTIGATE, { present: true }).vignette > 0)
  assert.ok(
    hud.awarenessTell(1, { present: true }).vignette > hud.awarenessTell(beast.AWARENESS_INVESTIGATE, { present: true }).vignette,
  )
  // the input is clamped, so a pinned ENRAGED meter (§10.2) cannot blow past the layer
  assert.equal(hud.awarenessTell(5, { present: true }).vignette, hud.awarenessTell(1, { present: true }).vignette)
  assert.equal(hud.awarenessTell(NaN, { present: true }).vignette, 0)
})

test('the breath tell rises with exhaustion and its pulse stays slow enough to be safe', () => {
  // §7.3: the meter is a readout without a bar. The pulse period is the
  // photosensitivity number — §14.3 wants steady values, and a sub-1 Hz opacity
  // cycle is two orders of magnitude below the 3-30 Hz band that provokes
  // photosensitive seizures while still reading unmistakably as breathing.
  const fresh = hud.breathTell(1, false)
  const tired = hud.breathTell(0.5, false)
  const winded = hud.breathTell(0, true)
  assert.ok(winded.vignette > tired.vignette, 'exhaustion does not darken the screen')
  assert.ok(tired.vignette > fresh.vignette, 'tiring does not darken the screen')
  assert.ok(fresh.amplitude > 0, 'a rested player does not breathe')
  for (const tell of [fresh, tired, winded]) {
    assert.ok(tell.period >= 2, `${tell.period}s is too fast to be a breath`)
    assert.ok(1 / tell.period < 0.8, `${(1 / tell.period).toFixed(2)} Hz is a flicker, not a breath`)
    assert.ok(tell.vignette >= 0 && tell.vignette <= 1)
    assert.ok(tell.amplitude >= 0 && tell.amplitude <= 1)
  }
  // a winded player breathes faster than a rested one, and that is the only
  // thing §7.3's exhaustion changes about the rhythm
  assert.ok(winded.period < fresh.period)
  assert.equal(hud.breathTell(1, true).vignette, winded.vignette, 'the flag and the meter are one fact')
  // out-of-range breath clamps rather than inverting the readout, and it clamps
  // towards *tired*: a breath value the world could not read must not read as a
  // rested player
  assert.equal(hud.breathTell(0, true).vignette, hud.breathTell(-3, true).vignette)
  assert.equal(hud.breathTell(2, false).vignette, hud.breathTell(1, false).vignette)
  assert.equal(hud.breathTell(NaN, false).vignette, winded.vignette)
})

test('the two tells share one vignette and can only ever reinforce each other', () => {
  // §6.4's vignette and §7.3's vignette are the same layer. Two owners writing
  // two inline styles on one element is a fight; the composition is a sum with a
  // cap, so the worst case is a dark screen and never a layer past opaque, which
  // is where two overlaid alphas would start cancelling.
  const worst = hud.vignetteTell(hud.awarenessTell(1), hud.breathTell(0, true))
  assert.ok(worst.level <= 1, 'the vignette went past opaque')
  assert.ok(worst.breathAmplitude >= 0)
  assert.ok(worst.breathAmplitude <= 1 - worst.level + 1e-12, 'the pulse can push the layer past opaque')
  assert.equal(hud.vignetteTell(hud.awarenessTell(0), hud.breathTell(1, false)).level, 0)
  // the clear radius is the awareness tell's alone, and it tightens with it
  assert.equal(hud.vignetteTell(hud.awarenessTell(0), hud.breathTell(0, true)).clear, hud.VIGNETTE_CLEAR_OPEN)
  assert.equal(hud.vignetteTell(hud.awarenessTell(1), hud.breathTell(0, true)).clear, hud.VIGNETTE_CLEAR_TIGHT)
  assert.ok(hud.VIGNETTE_CLEAR_TIGHT < hud.VIGNETTE_CLEAR_OPEN, 'the vignette does not tighten')
  // the composition is a sum, so it is symmetric in its two arguments' order
  const a = hud.vignetteTell(hud.awarenessTell(0.8), hud.breathTell(0.3, false))
  const b = hud.vignetteTell(hud.awarenessTell(0.8), hud.breathTell(0.3, false))
  assert.equal(a.level, b.level)
})

test('the finale effect is rate-limited, monotone, and off under reduced motion', () => {
  // §14.3: v1's grain and desat layers are "retained but rate-limited during the
  // finale". A limiter is a claim about *time*, so it is driven here over a
  // thousand frames of simulated `dt` and the number of times the painted level
  // may move is counted.
  let hold = hud.finaleEffectInit()
  const seen = [hold.level]
  for (let frame = 0; frame < 1000; frame += 1) {
    hold = hud.finaleEffect(hold, 1 / 60, true)
    seen.push(hold.level)
  }
  // six steps at 1.5 s each is nine seconds to full, and never a partial value
  assert.equal(hold.level, 1, 'the finale never reached full')
  const distinct = [...new Set(seen)]
  assert.equal(distinct.length, hud.FINALE_EFFECT_STEPS + 1, 'the finale is not on its six-step grid')
  for (const level of distinct) {
    assert.ok(Math.abs(level * hud.FINALE_EFFECT_STEPS - Math.round(level * hud.FINALE_EFFECT_STEPS)) < 1e-9)
  }
  // and it is monotone: a screen effect that can go back down can flicker
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index] >= seen[index - 1], 'the finale level went backwards')
  }
  // the interval is respected: between two adoptions at least 1.5 s passes
  const stamps = []
  hold = hud.finaleEffectInit()
  let elapsed = 0
  for (let frame = 0; frame < 1000; frame += 1) {
    const before = hold.level
    elapsed += 1 / 60
    hold = hud.finaleEffect(hold, 1 / 60, true)
    if (hold.level !== before) stamps.push(elapsed)
  }
  for (let index = 1; index < stamps.length; index += 1) {
    assert.ok(
      stamps[index] - stamps[index - 1] >= hud.FINALE_EFFECT_INTERVAL - 1e-9,
      `two level changes ${(stamps[index] - stamps[index - 1]).toFixed(2)}s apart`,
    )
  }
  // §14.3's motion row: reduced motion removes the finale's effects entirely,
  // and does so without waiting out the interval
  const still = hud.finaleEffect({ level: 1, remaining: 0 }, 1 / 60, true, { reducedMotion: true })
  assert.equal(still.level, 0)
  // a target that is already met is not a change, however many frames pass
  const settled = hud.finaleEffect({ level: 1, remaining: 5 }, 1 / 60, true)
  assert.equal(settled.changed, false)
  assert.equal(settled.level, 1)
  // the limiter is pure, so it survives garbage history rather than NaN-ing
  assert.equal(hud.finaleEffect({}, 1 / 60, true).level, 1 / hud.FINALE_EFFECT_STEPS)
  assert.equal(hud.finaleEffect({ level: NaN, remaining: NaN }, 1 / 60, true).level, 1 / hud.FINALE_EFFECT_STEPS)
})

test("a run's finale level comes back down only through a full wipe", () => {
  // §10.4's BEGIN AGAIN is the one place a reset is correct, and the level is
  // part of that: the direction of travel is the only thing that is allowed to
  // change, and only when the target does.
  let hold = hud.finaleEffectInit()
  for (let frame = 0; frame < 700; frame += 1) hold = hud.finaleEffect(hold, 1 / 60, true)
  assert.equal(hold.level, 1)
  const down = []
  for (let frame = 0; frame < 700; frame += 1) {
    hold = hud.finaleEffect(hold, 1 / 60, false)
    down.push(hold.level)
  }
  assert.equal(hold.level, 0)
  for (let index = 1; index < down.length; index += 1) {
    assert.ok(down[index] <= down[index - 1], 'the wipe ramp is not monotone either')
  }
})

test('the sigil flash decays on a clock, and slower and dimmer under reduced motion', () => {
  // §14.3: the banish toll and §7.2's awakening both need a visual counterpart,
  // so a deaf player loses the atmosphere of a swing and none of its
  // information. It is a decaying *level* rather than an animation so the store
  // can carry it and the toggle can damp it.
  let level = 1
  const frames = Math.round(hud.SIGIL_FLASH_SECONDS * 60)
  for (let frame = 0; frame < frames; frame += 1) level = hud.flashDecay(level, 1 / 60).level
  assert.equal(level, 0, 'the flash outlived its window')
  assert.ok(hud.flashDecay(1, 1 / 60).level < 1, 'the flash does not fall at all')
  assert.equal(hud.flashDecay(1, 0).level, 1, 'a zero frame still decays the flash')
  assert.equal(hud.flashDecay(0, 1).level, 0)
  assert.equal(hud.flashDecay(NaN, 1).level, 0)
  // and the two answers compose where they meet — in the sigil, not the world —
  // so the dimmer peak is a pure function the gate can see
  assert.equal(hud.hammerMark(true, 1, 1).flash, 1)
  assert.equal(hud.hammerMark(true, 1, 0.45).flash, 0.45, 'the damped flash is not dimmer')
  assert.equal(hud.hammerMark(true, 0.5, 0.45).flash, 0.225)
  assert.equal(hud.hammerMark(true, 1).flash, 1, 'the default amplitude is not full')
  // reduced motion: the same information, longer and dimmer — never faster
  assert.ok(hud.flashDecay(1, 1 / 60, { reducedMotion: true }).level > hud.flashDecay(1, 1 / 60).level)
  assert.ok(hud.flashDecay(1, 1 / 60, { reducedMotion: true }).amplitude < 1)
  assert.equal(hud.flashDecay(1, 1 / 60).amplitude, 1)
  assert.ok(hud.SIGIL_FLASH_SECONDS_REDUCED > hud.SIGIL_FLASH_SECONDS)
  // and the window is bounded below by the swing cooldown, so a held mouse button
  // produces one flash per swing rather than one per frame
  assert.ok(hud.SIGIL_FLASH_SECONDS * 2 > 0.55, 'the flash is faster than the swing cooldown')
})

test('reduced motion resolves the OS preference unless the player has overridden it', () => {
  // §14.3 wants the toggle to be honest, and a single boolean cannot be honest
  // in both directions at once: a player whose OS asked for reduced motion and
  // who then presses the button in this game has expressed a preference this
  // game is entitled to honour, and a second press puts them back.
  assert.equal(hud.resolveReducedMotion({ system: true }), true)
  assert.equal(hud.resolveReducedMotion({ system: false }), false)
  assert.equal(hud.resolveReducedMotion({}), false, 'the default is motion on')
  assert.equal(hud.resolveReducedMotion({ preference: false, system: true }), false, 'the override cannot win')
  assert.equal(hud.resolveReducedMotion({ preference: true, system: false }), true, 'the override cannot be ignored')
  assert.equal(hud.resolveReducedMotion({ preference: null, system: true }), true)
  // it is a pure function of two arguments, and the media query is read by the
  // world — a pure module that reached for `window` could not be in this harness
  const code = HUD_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.equal(/\bwindow\b|\bdocument\b|matchMedia/.test(code), false, 'hud.js reached for a global')
})

test('reduced motion suppresses exactly three things', () => {
  // §14.3 names three: the head bob, the camera shake and the finale's screen
  // effects. The flags are the only channel to those three consumers, so a fourth
  // row here would be a fourth switch nobody asked for.
  assert.deepEqual(hud.motionFlags(false), { headBob: true, cameraShake: true, finaleEffects: true })
  assert.deepEqual(hud.motionFlags(true), { headBob: false, cameraShake: false, finaleEffects: false })
  assert.deepEqual(Object.keys(hud.motionFlags(true)).sort(), ['cameraShake', 'finaleEffects', 'headBob'])
})

test('the reduced-motion path through the tells keeps the information', () => {
  // the commitment is "a deaf player loses atmosphere, not information" and the
  // same has to be true for a player who cannot take the motion: the tells go
  // steady and dimmer, never to nothing
  const still = hud.awarenessTell(1, { present: true, reducedMotion: true })
  assert.ok(still.vignette > 0, 'a full meter is invisible under reduced motion')
  assert.ok(still.grain > 0)
  assert.equal(still.grainScale, hud.AWARENESS_GRAIN_FINE, 'the grain is still moving under reduced motion')
  assert.equal(hud.breathTell(0, true, { reducedMotion: true }).amplitude, 0, 'the breath still pulses')
  assert.ok(hud.breathTell(0, true, { reducedMotion: true }).vignette > 0, 'exhaustion is invisible')
  // and the projection agrees, because the world and the HUD resolve the same
  // preference through the same function
  const painted = hud.hudSnapshot(hudState({ awareness: 1, breath: 0, exhausted: true, reducedMotionSystem: true }))
  assert.equal(painted.reducedMotion, true)
  assert.equal(painted.breathPulse.amplitude, 0)
  assert.ok(painted.vignette.level > 0, 'the whole layer went dark under reduced motion')
  assert.ok(hud.hudSnapshot(hudState({ awareness: 1, breath: 0, exhausted: true })).breathPulse.amplitude > 0)
})

test('the quantizer is what keeps React from re-rendering sixty times a second', () => {
  // `createStore` skips notifying when every patched key is `===`, so the
  // quantizer is the whole mechanism. It has to land on exact endpoints (the
  // ring must still close at 1) and it has to map `NaN` to a stable 0, because
  // `NaN !== NaN` would re-notify every frame forever.
  for (const steps of [hud.STEPS.hold, hud.STEPS.awareness, hud.STEPS.breath, hud.STEPS.flash, hud.STEPS.finale]) {
    assert.ok(steps > 0, 'a zero-step quantizer was exported')
    assert.equal(hud.quantize(0.5, steps) * steps, Math.round(0.5 * steps))
    assert.equal(hud.quantize(NaN, steps), 0)
    assert.equal(hud.quantize(Infinity, steps), 0)
    assert.equal(hud.quantize(-Infinity, steps), 0)
    assert.equal(hud.quantize(undefined, steps), 0)
    assert.equal(hud.quantize(2, steps), 1)
    assert.equal(hud.quantize(-2, steps), 0)
  }
  assert.equal(hud.quantize(0.4, 0), 0.4, 'a zero-step quantizer must pass the value through')
  // the hold grid is *even*, so §5.2's 0.5 lands on a painted step rather than
  // between two frames — that is the whole reason it is 24 and not 20
  assert.equal(hud.STEPS.hold % 2, 0, 'the midpoint tick would fall between two frames')
  // the awareness grid has to resolve §6.2's two bands and still be coarse enough
  // to be a few repaints a second rather than sixty
  assert.ok(hud.STEPS.awareness >= beast.AWARENESS_INVESTIGATE * 16, 'the awareness grid cannot resolve the investigate band')
  assert.ok(hud.STEPS.awareness <= 64, 'the awareness grid is finer than a few repaints a second')
  // and the two decayed levels are small grids, because they are *held* values
  // rather than per-frame signals
  assert.ok(hud.STEPS.flash <= 12 && hud.STEPS.finale <= 8)
})

test('clamp01 is total, which is what lets the projection read raw frame values', () => {
  for (const value of [0, 0.5, 1, -1, 2, NaN, Infinity, -Infinity, undefined, null, '0.5']) {
    const clamped = hud.clamp01(value)
    assert.ok(clamped >= 0 && clamped <= 1, `clamp01(${String(value)}) escaped to ${clamped}`)
    assert.ok(Number.isFinite(clamped))
  }
  assert.equal(hud.clamp01(0.25), 0.25)
})

test('the HUD paints no text but the loop counter and the key hint', () => {
  // §14.1: "No new text is introduced." The two overlays are exempt by their own
  // argument (a menu that cannot say anything is not a menu), so this greps the
  // HUD's JSX for text nodes and asserts the exact set v1 was allowed: the
  // `LOOP` label, and the `E` key hint — which is a named constant, so a grep for
  // text nodes cannot see it and the constant is checked by value instead.
  const textNodes = [...HUD_JSX_SOURCE.matchAll(/>([^<>{}]+)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[a-z]/i.test(text))
  assert.deepEqual([...new Set(textNodes)].sort(), ['LOOP'])
  assert.match(HUD_JSX_SOURCE, /const PROMPT_KEY = 'E'/, 'the key hint is not a single named glyph')
  assert.match(HUD_JSX_SOURCE, /\{hud\.loop\}/, 'the loop counter is not the number §9.2 wants')
  // the awareness and breath numbers are read into the file only as tell levels
  assert.equal(/hud\.awareness|hud\.breath\b/.test(HUD_JSX_SOURCE), false, 'the HUD reads a meter')
  // and the FPS counter is a number in its own slot, not a label
  assert.match(HUD_JSX_SOURCE, /\{hud\.fps\}/)
})

test('the post layers are driven by variables, and reduced motion can stop them', () => {
  // the tells are painted as custom properties and oscillated by CSS, which is
  // what keeps a 2.2 s breath off the React path — and it is only reachable
  // because §14.3's switch arrives as a *class*: a store flag cannot reach a
  // running keyframe, and `animation: none` is the only thing that stops one.
  for (const layer of ['vignette', 'grain', 'desat']) {
    assert.match(STYLES_SOURCE, new RegExp(`\\.${layer} \\{`), `${layer} is gone from the stylesheet`)
    assert.match(HUD_JSX_SOURCE, new RegExp(`className=[{\`"][^\\n]*${layer}`), `${layer} is not painted by the HUD`)
  }
  for (const variable of ['--vignette', '--vignette-clear', '--breath-amp', '--breath-period', '--grain-opacity', '--grain-scale', '--finale']) {
    assert.ok(HUD_JSX_SOURCE.includes(variable), `the HUD never paints ${variable}`)
    assert.ok(STYLES_SOURCE.includes(variable), `${variable} is never read`)
  }
  assert.match(STYLES_SOURCE, /@property --pulse/, 'the breath pulse is not a registered property')
  assert.match(STYLES_SOURCE, /animation: none !important/, 'reduced motion cannot stop a keyframe')
  assert.match(HUD_JSX_SOURCE, /hud--still/, 'the HUD has no reduced-motion class')
  // the baseline grain is v1's, and the finale swaps it for something slower —
  // §14.3 rate-limits the finale, and rate-limiting a 4.5 Hz jitter means
  // replacing it, not merely dimming it
  assert.match(STYLES_SOURCE, /\.grain--finale \{[^}]*animation: grain-jitter 2\.2s/)
  assert.ok(/animation: grain-jitter 0\.66s/.test(STYLES_SOURCE), "v1's baseline grain animation was dropped")
  // and nothing new was added to the DOM: the same three layers, four sigils
  assert.equal((HUD_JSX_SOURCE.match(/<Sigil /g) ?? []).length, 2, 'the sigil row is not one map plus one hammer')
  // one owner per layer, which is the real claim: §6.4's vignette and §7.3's
  // vignette are the *same* element, so a second one would be the two tells
  // fighting over a layer instead of composing on it
  for (const layer of ['vignette', 'grain', 'desat']) {
    const owners = [...HUD_JSX_SOURCE.matchAll(new RegExp(`className=[{\`"][^\\n]*${layer}`, 'g'))]
    assert.equal(owners.length, 1, `${layer} has ${owners.length} owners in the HUD`)
  }
})

test("v1's flame sigils and heartbeat line are gone from the stylesheet and the HUD", () => {
  // §14.1 replaces three flames with three portals and the hammer; the heartbeat
  // line was a *countdown*, and v2 has no countdown (slice 09 pinned it full and
  // §9.2 counts captures instead). Keeping either would be keeping a v1 promise
  // this game does not make.
  for (const gone of ['flame-sigil', 'hud__candles', 'hud__timer', 'hud__heartbeat', 'heartbeat-throb']) {
    assert.equal(STYLES_SOURCE.includes(gone), false, `${gone} survived in the stylesheet`)
    assert.equal(HUD_JSX_SOURCE.includes(gone), false, `${gone} survived in the HUD`)
  }
  assert.equal(/timeFraction|candles|doorOpen/.test(HUD_JSX_SOURCE), false, 'the HUD still reads a v1 field')
})

test('the pause card is overlay chrome and the world owns the flag', () => {
  // §10.5: the finale is a flag rather than a fifth phase, and §14.3's pause is a
  // flag for the same reason — a player who pauses during a capture's black has
  // not invented a phase. `PHASE` therefore still has exactly four members, and
  // the card reads a store field rather than owning one.
  assert.equal(Object.keys(PHASE).length, 4, 'a fifth phase appeared')
  assert.equal(PHASE.PAUSED, undefined, 'pause became a phase')
  assert.match(WORLD_SOURCE, /setPaused\(paused\) \{/, 'the pause flag is not written in one place')
  assert.match(APP_SOURCE, /hud\.paused \?/, 'the card is not driven by the projection')
  // Esc is the documented key and pointer-lock loss is the documented trigger
  assert.match(WORLD_SOURCE, /e\.code === 'Escape'/)
  assert.match(WORLD_SOURCE, /pointerlockchange/)
  // and the card is a sibling of the other two overlays, not a fifth thing in
  // `.hud` — which is what keeps §14.1's "no new text" a HUD-scoped promise
  assert.match(PAUSE_JSX_SOURCE, /overlay--pause/)
  assert.match(APP_SOURCE, /PauseOverlay/)
  assert.equal(HUD_JSX_SOURCE.includes('PauseOverlay'), false, 'the pause card moved into the HUD')
})

test('the pause freezes the simulation before any of it runs', () => {
  // §14.3: "freezes the simulation completely, including the creature". The
  // early return has to be *before* `animTime` moves and before the phase
  // machine, or the creature's clocks keep running behind the card — which is
  // the one failure the design singles out by name.
  const start = WORLD_SOURCE.indexOf('  update(dt) {')
  const body = WORLD_SOURCE.slice(start, WORLD_SOURCE.indexOf('\n  }', start))
  const pauseAt = body.indexOf('if (this.paused)')
  const clockAt = body.indexOf('this.animTime += dt')
  const viewAt = body.indexOf('this._updateCreatureView(dt)')
  assert.ok(pauseAt > 0 && clockAt > 0 && viewAt > 0, 'update() no longer has the three landmarks')
  assert.ok(pauseAt < clockAt, 'the pause returns after the world clock has moved')
  assert.ok(pauseAt < viewAt, 'the pause returns after the creature has been ticked')
  // and it still mirrors the store, or the card would be shown over a HUD that
  // had stopped updating
  assert.match(body.slice(pauseAt), /this\._syncHud\(\)/)
})

test('the world quantizes what it writes, and writes the portals map only on a change', () => {
  // the store is the only channel to React, and `createStore` compares patched
  // keys with `!==`, so an unquantized awareness would repaint the HUD sixty
  // times a second and a fresh `portals` object every frame would do it even
  // with nothing changed at all
  assert.match(WORLD_SOURCE, /this\._awareness = hud\.quantize\(step\.awareness, hud\.STEPS\.awareness\)/, 'awareness is written unquantized')
  assert.match(WORLD_SOURCE, /hold: hud\.quantize\(/, 'the hold is written unquantized')
  assert.match(WORLD_SOURCE, /if \(key !== this\._sigilKey\)/, 'the sigil key guard is gone')
  assert.match(WORLD_SOURCE, /patch\.portals = \{ \.\.\.this\.state\.portals \}/)
  // and the world reaches into `src/ui/` for the grid, never for the projection:
  // the HUD's shape is the HUD's business
  assert.match(WORLD_SOURCE, /import \* as hud from '\.\.\/ui\/hud\.js'/)
  assert.equal(/hud\.hudSnapshot/.test(WORLD_SOURCE), false, 'the world projects the HUD itself')
  assert.equal(/hud\.portalSigils|hud\.awarenessTell|hud\.breathTell|hud\.vignetteTell/.test(WORLD_SOURCE), false, 'the world draws a tell')
})

test('the player takes a head-bob switch as a boolean and applies it at once', () => {
  // §14.3's motion row reaches the camera through one multiplier on both terms,
  // so the bob and the sway go together, and `bobPhase` is left running so that
  // turning motion back on resumes the gait rather than snapping the camera.
  const start = PLAYER_SOURCE.indexOf('  _applyCamera()')
  const camera = PLAYER_SOURCE.slice(start, PLAYER_SOURCE.indexOf('\n  }', start))
  // the comment in that method names `bobScale` too, so the code is read alone
  const code = camera.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.equal((code.match(/bobScale/g) ?? []).length, 2, 'the bob and the sway do not share one switch')
  assert.equal(/bobPhase = 0/.test(camera), false, 'the stride clock is being reset')
  assert.match(PLAYER_SOURCE, /  setHeadBob\(enabled\) \{/)
  assert.match(PLAYER_SOURCE, /this\.bobScale = enabled === false \? 0 : 1/)
  // and it is a boolean, not a scale: a comfort setting is on or off. The only
  // two writes in the file are the constructor's default and the setter, so
  // nothing else in the game can quietly scale the bob.
  const writes = [...PLAYER_SOURCE.matchAll(/bobScale = ([^\n;]+)/g)].map((m) => m[1].trim())
  assert.deepEqual(writes, ['1', 'enabled === false ? 0 : 1'])
  assert.match(PLAYER_SOURCE, /this\.bobScale = 1/)
})

test('pause drops the held keys and the pending swing', () => {
  // §5.2's hold is a commitment; a commitment that re-arms itself because a menu
  // was open is not a commitment, and a pause caught mid-click must not resume
  // as a banish the player never aimed
  const start = WORLD_SOURCE.indexOf('  setPaused(paused) {')
  const setPaused = WORLD_SOURCE.slice(start, WORLD_SOURCE.indexOf('\n  }', start))
  assert.match(setPaused, /this\.player\.releaseAllKeys\(\)/)
  // and it must NOT drain the swing through `consumeSwing`: that is the door that
  // *performs* a swing and fires the callback, so using it to throw one away
  // would banish something on the frame the player opened a menu
  assert.equal(/consumeSwing/.test(setPaused), false, 'the pause performs a swing instead of dropping it')
  assert.match(PLAYER_SOURCE, /releaseAllKeys\(\) \{[\s\S]*?this\.swingRequested = false/)
  // both halves of the lock dance, in the order that makes them safe: the flag
  // first so the lock-change it causes is a no-op, and the grace window before
  // the re-lock so a slow round trip cannot re-pause the game
  assert.ok(setPaused.indexOf('this.paused = next') < setPaused.indexOf('exitPointerLock'), 'the lock is released before the flag is set')
  assert.match(setPaused, /_lockGraceUntil/)
  assert.ok(setPaused.indexOf('_lockGraceUntil') < setPaused.indexOf('requestLock'), 'no grace window before the re-lock')
  // one-way: losing the lock pauses, and never resumes
  const lockStart = WORLD_SOURCE.indexOf('    this._onLockChange = ()')
  const onLockChange = WORLD_SOURCE.slice(lockStart, WORLD_SOURCE.indexOf('\n    }', lockStart))
  assert.match(onLockChange, /this\.setPaused\(true\)/)
  assert.equal(/setPaused\(false\)/.test(onLockChange), false, 'losing the lock can un-pause the game')
  // and Esc is a toggle, gated on a run actually being in progress
  assert.match(WORLD_SOURCE, /e\.code === 'Escape' && this\.startedOnce && this\.phase === PHASE\.PLAYING/)
  assert.match(WORLD_SOURCE, /  togglePause\(\) \{/)
  // the one-shot interact helper is frozen by the same flag
  assert.match(WORLD_SOURCE, /if \(this\.phase !== PHASE\.PLAYING \|\| this\.paused\) return false/)
})

test('a paused frame routes silence rather than freezing a rasp at its last gain', () => {
  // `routeAudio` sends every sustained row on every started frame, so a paused
  // world that simply stopped calling the router would hold a winded player's
  // breath for as long as they sat in the menu. The pause therefore answers with
  // the title screen's own frame — the one moment in the game where nothing is
  // playing at all — which drops every sustained voice and pulls the drone back.
  assert.match(WORLD_SOURCE, /if \(this\.paused\) return \{ started: false \}/)
  assert.equal((WORLD_SOURCE.match(/_audioFrame\(\)/g) ?? []).length, 2, 'the audio frame is not built in one place')
  assert.deepEqual(audio.routeAudio({ started: false }), [], 'the silence frame is not silent')
  // and the world's one audio call is still the router, on paused frames too
  assert.match(WORLD_SOURCE, /if \(this\.paused\) \{\n      this\._updateAudio\(dt\)/)
})

test('the world adds a sigil flash on both of the tolls §14.3 names', () => {
  // "the banish toll has a sigil flash" — and §7.2's awakening is the same sigil,
  // so the player's eye learns one place to look for "something rang"
  assert.match(WORLD_SOURCE, /if \(step\.swing && step\.swing\.result === 'banish'\) this\.hammerFlash = 1/)
  assert.equal((WORLD_SOURCE.match(/this\.hammerFlash = 1/g) ?? []).length, 2, 'the flash is raised somewhere other than the two tolls')
  // it decays on the world clock, because a decay needs one, and its dimmer peak
  // under reduced motion is a second number the projection composes with the level
  assert.match(WORLD_SOURCE, /hud\.flashDecay\(this\.hammerFlash, dt/)
  assert.match(WORLD_SOURCE, /hammerFlashAmplitude: this\._flashAmplitude/)
  assert.match(WORLD_SOURCE, /this\._flashAmplitude = flash\.amplitude/)
  // and a capture or a full wipe clears it
  assert.match(WORLD_SOURCE, /this\.hammerFlash = 0/)
})

test('the finale effect is owned by the world and reset by the wipe', () => {
  // §15.1 gives the world the post-processing role, and §10.4's wipe is the one
  // place a full reset is correct — the level goes back to zero with everything
  // else, and ramps up again on the new run's own clock
  assert.match(WORLD_SOURCE, /hud\.finaleEffect\(this\.finaleEffect, dt, this\.state\.finale/)
  // the constructor, a full wipe and a reduced-motion switch: three, no more
  assert.equal((WORLD_SOURCE.match(/this\.finaleEffect = hud\.finaleEffectInit\(\)/g) ?? []).length, 3)
  // and reduced motion stops it being advanced at all
  assert.match(WORLD_SOURCE, /if \(!this\._motion\.finaleEffects\) return/)
})

test('the camera shake is gated on both sides of reduced motion', () => {
  // the outbound gate is obvious; the inbound one is the one that bites. A
  // capture under reduced motion must not *accumulate* a shake that is then
  // never applied, or turning the setting back off mid-run would release a punch
  // the player was not there for
  assert.match(WORLD_SOURCE, /  addShake\(amount\) \{\n    if \(!this\._motion\.cameraShake\) return/)
  assert.match(WORLD_SOURCE, /_applyShake\(dt\) \{\n    if \(!this\._motion\.cameraShake\) \{/)
  // and the world still owns all three consumers of the preference
  assert.match(WORLD_SOURCE, /this\.player\?\.setHeadBob\(this\._motion\.headBob\)/)
  assert.match(WORLD_SOURCE, /if \(!this\._motion\.cameraShake\) this\.shake = 0/)
  assert.match(WORLD_SOURCE, /if \(!this\._motion\.finaleEffects\) this\.finaleEffect = hud\.finaleEffectInit\(\)/)
})

test('the motion preference is read from the world, guarded for the headless harness', () => {
  // `verify-world.mjs`'s window stub has no `matchMedia`, and this slice must
  // not change *how* that harness fails — slice 14 owns repairing it, and a
  // constructor that throws on a missing media query would replace a known
  // failure with a new one
  assert.match(WORLD_SOURCE, /typeof window\.matchMedia === 'function'/)
  assert.match(WORLD_SOURCE, /typeof document !== 'undefined'/)
  assert.match(WORLD_SOURCE, /document\.removeEventListener\?\./, 'teardown would throw on the stub')
  // and the teardown removes the two new listeners, or a restarted world leaks
  assert.match(WORLD_SOURCE, /_motionQuery\?\.removeEventListener\?\./)
  assert.match(WORLD_SOURCE, /document\.addEventListener\('pointerlockchange', this\._onLockChange\)/)
})

test('the world still makes exactly one audio call, and the router still owns the frame', () => {
  // §13's discipline, re-asserted: slice 12 added a pause branch and had no
  // business reaching for a voice from it
  const calls = [...WORLD_SOURCE.matchAll(/this\.audio\?\.\s*(\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(calls)].sort(),
    // `setSeed` is pass 13's addition and it is the one that is not a decision:
    // the world owns the run's seed and hands it over once, in the constructor,
    // the way it hands over `_audioFrame`'s facts sixty times a second. A gate
    // that forbade it would be forbidding the world from knowing its own seed.
    ['setSeed', 'stopPortalHums', 'update', 'winChord'],
  )
  assert.equal(calls.filter((name) => name === 'update').length, 1)
  // and it is handed over ONCE — a setSeed in the update path would be a world
  // re-seeding the audio sixty times a second, which would silently restart the
  // ambience cursors on every frame and make the bed fire every event at once.
  // The match is for the CALL, not the word: a comment that mentions `setSeed`
  // must not be able to satisfy a count.
  const constructor = WORLD_SOURCE.slice(
    WORLD_SOURCE.indexOf('constructor(container, options = {}) {'),
    WORLD_SOURCE.indexOf('this._buildLights()'),
  )
  assert.equal(
    (constructor.match(/this\.audio\?\.setSeed\?\.\(/g) ?? []).length,
    1,
    'setSeed is not called exactly once from the constructor',
  )
  assert.equal(
    (WORLD_SOURCE.match(/this\.audio\?\.setSeed\?\.\(/g) ?? []).length,
    1,
    'setSeed is called from somewhere other than the constructor',
  )
  for (const field of audio.AUDIO_FRAME_FIELDS) {
    assert.ok(new RegExp(`\\b${field}:`).test(WORLD_SOURCE), `the world never fills in ${field}`)
  }
})

// ---------------------------------------------------------------------------
// v2 slice 13 — the finale and the win
// ---------------------------------------------------------------------------
//
// WHAT THIS SECTION OWNS, AND WHY IT IS MOSTLY ABOUT SEAMS
// ---------------------------------------------------------------------------
// The finale was already *wired* before this slice: `rules.applyPortalHold` has
// latched the flag since slice 05, `creatureStep` has had the enrage edge since
// slice 06, the world's dusk step and headlights are slice 09, and §14.3's
// finale ramp is slice 12. What none of them could do is say the sentence the
// plan asks for — "third portal, and *only* the third; ENRAGED; headlights
// through fog; win; BEGIN AGAIN" — as one set of facts about one flag.
//
// So this section is about the seams rather than the pieces:
//   - the flag the headlights read is the same flag the creature reads, and only
//     the third portal can raise it (§10.1);
//   - the finale is a condition, not a phase (§10.5), so `PHASE` still has four
//     members and a won run is still a `PHASE.WON`;
//   - ENRAGED is a *chase*: it moves, at the ramp speed, and the sprint beats it
//     (§10.2, §8.6);
//   - the win is a freeze, a phase, one chord, and one line of text (§10.4);
//   - BEGIN AGAIN is a full wipe, and it is the only one (§9.1 vs §10.4).
//
// Two of these — the locomotion and the wipe — were not merely unproven. Both
// were wrong: see `PURSUING_STATES` and `wipeRun`.

section('The finale and the win (v2 slice 13)')

/** One method's source out of `world.js`, by name, including its opening line. */
function worldMethod(name) {
  const start = WORLD_SOURCE.indexOf(`  ${name}(`)
  assert.notEqual(start, -1, `world.js has no ${name}`)
  return WORLD_SOURCE.slice(start, WORLD_SOURCE.indexOf('\n  }', start))
}

/** Close a portal by holding the verb, the way the world does. */
function shutPortal(state, id) {
  let next = state
  for (let i = 0; i < 400 && !next.portals[id]; i += 1) next = rules.applyPortalHold(next, id, DT, true)
  assert.equal(next.portals[id], true, `${id} did not shut`)
  return next
}

/** A run with every portal down, and therefore the finale open. */
function finaleRun() {
  let state = rules.createInitialState(hood.placeObjectives(1337, 1))
  for (const id of hood.PORTAL_IDS) state = shutPortal(state, id)
  assert.equal(state.finale, true, 'the fixture run did not open the finale')
  return state
}

test('the finale opens on the third portal and only the third (§10.1)', () => {
  // the number, not the sentence: three portals, and the trigger is all of them
  assert.equal(rules.FINAL_PORTAL_COUNT, 3)
  assert.equal(rules.FINAL_PORTAL_COUNT, hood.PORTAL_IDS.length, 'the trigger is a count, so the two cannot drift')
  // every subset, because "only the third" is a claim about all eight
  for (let bits = 0; bits < 8; bits += 1) {
    const set = Object.fromEntries(hood.PORTAL_IDS.map((id, index) => [id, Boolean(bits & (1 << index))]))
    const shut = hood.PORTAL_IDS.filter((id) => set[id]).length
    assert.equal(rules.triggersFinale(set), shut === rules.FINAL_PORTAL_COUNT, `a subset of ${shut} triggered the finale`)
  }
  assert.equal(rules.triggersFinale({}), false)
  assert.equal(rules.triggersFinale(null), false, 'no portal set is not a finale')
  // and the verb cannot get there early, in any order, or by an id that is not a
  // portal — the three ways "only the third" is usually broken
  for (const order of [['A', 'B', 'C'], ['C', 'B', 'A'], ['B', 'C', 'A']]) {
    let state = rules.createInitialState(hood.placeObjectives(1337, 1))
    for (const [index, id] of order.entries()) {
      state = shutPortal(state, id)
      assert.equal(state.finale, index === order.length - 1, `the finale opened on ${id} of ${order.join('')}`)
    }
  }
  const fresh = rules.createInitialState(hood.placeObjectives(1337, 1))
  assert.equal(rules.applyPortalHold(fresh, 'Z', DT, true), fresh, 'a portal that does not exist was accepted')
  assert.equal(fresh.finale, false, 'and a non-portal opened the finale')
  // holding a shut portal again is not a second trigger: the verb is dead (§5.2)
  const held = rules.applyPortalHold(finaleRun(), 'C', DT, true)
  assert.equal(rules.portalsShut(held.portals), 3, 'a held portal scored twice')
  assert.equal(held.finale, true)
})

test('the finale is a condition, not a phase (§10.5)', () => {
  // four members, and none of them is the finale — this is the assertion that
  // stops a later refactor from "tidying" the flag into a PHASE.FINALE
  assert.deepEqual(Object.keys(PHASE).sort(), ['PLAYING', 'RESET', 'START', 'WON'])
  for (const name of Object.values(PHASE)) {
    assert.equal(String(name).includes('finale'), false, `PHASE grew a ${name}`)
  }
  // it is a boolean on the state, and a new run opens with the car dark
  const state = rules.createInitialState(hood.placeObjectives(1337, 1))
  assert.equal(typeof state.finale, 'boolean')
  assert.equal(state.finale, false)
  // §9.1: a capture in the finale keeps it, so the headlights do not go dark
  // because the player died two blocks from the exit
  const afterDeath = rules.applyCapture({ ...state, finale: true, loop: 4, banishCount: 3 })
  assert.equal(afterDeath.finale, true, 'a capture closed the exit')
  assert.equal(afterDeath.loop, 5)
})

test('the enrage is driven by the same flag the headlights read (§10.1, §10.2)', () => {
  // the seam this slice exists to close: one flag, four consequences, all read
  // from `state.finale` rather than from counters that can disagree
  const state = finaleRun()
  assert.match(WORLD_SOURCE, /this\.streetView\.setHeadlights\(this\.state\.finale\)/, 'the headlights read a different flag')
  assert.match(WORLD_SOURCE, /finale: this\.state\.finale,/, 'the creature is handed a different flag')
  assert.match(WORLD_SOURCE, /hud\.finaleEffect\(this\.finaleEffect, dt, this\.state\.finale/, 'the finale ramp reads a third flag')
  assert.match(WORLD_SOURCE, /if \(this\.state\.finale && this\._insideExit\(\)\)/, 'and the win reads a fourth')
  // and the flag the rules raise enrages the creature on the next frame, from
  // every state it can actually be hunting in (§6.1's edge list)
  for (const creatureState of beast.ENRAGE_FROM) {
    const step = beast.creatureStep(
      beast.createCreature({ state: creatureState, awareness: 0.5 }),
      DT,
      { distance: 60, finale: state.finale, sounds: [] },
    )
    assert.equal(step.to, 'enraged', `${creatureState} did not enrage on the finale flag`)
    assert.equal(step.awareness, beast.AWARENESS_CHASE, 'and it arrives already knowing where the player is')
  }
  // Act I and a banish in flight are untouched by the finale. This is the third
  // place that rule is asserted, and it is the one a "just promote it
  // everywhere" patch would break: it is what keeps the hammer's two-act
  // structure, and therefore Act I, from evaporating at the climax.
  for (const creatureState of ['telegraph', 'dormant']) {
    const step = beast.creatureStep(beast.createCreature({ state: creatureState }), DT, { distance: 60, finale: true })
    assert.equal(step.to, creatureState, `${creatureState} must not be reachable from the finale`)
  }
  // and a banish in flight is not cancelled by the finale either: the recoil is
  // already in motion, and §10.2's promise is that the hammer still works, not
  // that the finale is a mutagen
  const stunned = beast.creatureStep(
    { ...beast.createCreature({ state: 'stagger', awareness: 0.8 }), staggerSeconds: 1, banishPending: true },
    DT,
    { distance: 60, finale: true, sounds: [] },
  )
  assert.equal(stunned.to, 'stagger', 'the finale cancelled a banish in flight')
})

test('an enraged creature is a chase, not an omniscient statue (§10.2)', () => {
  // Every state that can END a run must be able to MOVE in it. Until this slice
  // the world's walk was gated on `step.to === 'stalk'`, so CHASE and ENRAGED
  // stood still while owning perfect knowledge: §10.2's 5.2 m/s was a number
  // with nothing to spend it on, and the climax was a stroll to the car.
  assert.deepEqual([...beast.PURSUING_STATES].sort(), ['chase', 'enraged'])
  for (const state of beast.CAPTURE_STATES) {
    assert.ok(beast.PURSUING_STATES.includes(state), `${state} can catch the player but cannot walk`)
  }
  // the world gates the walk on that list, in one place
  assert.equal((WORLD_SOURCE.match(/_walkCreature\(dt, player\)/g) ?? []).length, 2, 'the walk is called from somewhere new')
  assert.match(WORLD_SOURCE, /if \(step\.to === 'stalk' \|\| beast\.PURSUING_STATES\.includes\(step\.to\)\)/)
  // and the target is the pure rule, not an inline `??` in the world
  assert.match(WORLD_SOURCE, /const target = beast\.pursuitTarget\(this\.creature, player\)/)
  // §10.2: permanent position knowledge, spent on where the player IS. An
  // enraged creature holding a stale last-heard point must not walk to it.
  const player = { x: 12, z: -34 }
  const stale = { ...beast.createCreature({ state: 'enraged' }), lastHeard: { x: -200, z: 190 }, lastSeen: { x: 5, z: 5 } }
  assert.equal(beast.pursuitTarget(stale, player), player, 'the finale walks at a memory instead of at the player')
  // Act II is unchanged: heard beats seen beats the player
  const stalk = { ...beast.createCreature({ state: 'stalk' }), lastHeard: { x: 1, z: 1 }, lastSeen: { x: 2, z: 2 } }
  assert.deepEqual(beast.pursuitTarget(stalk, player), { x: 1, z: 1 })
  assert.deepEqual(beast.pursuitTarget({ ...stalk, lastHeard: null }, player), { x: 2, z: 2 })
  assert.deepEqual(beast.pursuitTarget(beast.createCreature({ state: 'stalk' }), player), player)
  assert.equal(beast.pursuitTarget(null, player), player, 'no creature is still a position')
  assert.equal(beast.pursuitTarget(beast.createCreature({ state: 'stalk' }), null), null)
})

test('sprint remains the escape, and the clamp is what makes it one (§8.6, §10.2)', () => {
  // §10.2: "top speed 5.2 m/s — deliberately just under the player's 6.0 sprint,
  // so the gap is real and crossable". A gap of zero is a coin flip and a
  // negative gap is a game nobody can finish, and neither is visible from a
  // screenshot — which is the whole argument for asserting it here.
  assert.equal(beast.rampAt(3).speed, 5.2, '§11.1 row 3')
  assert.equal(beast.SPEED_CEILING, 5.2, 'the ceiling IS the finale speed, not a rounded version of it')
  assert.ok(
    beast.SPEED_CEILING < beast.PLAYER_SPRINT_SPEED,
    `the creature (${beast.SPEED_CEILING}) must be slower than the sprint (${beast.PLAYER_SPRINT_SPEED})`,
  )
  // and the clamp holds however far the pressure axis is pushed: this is the
  // assertion that would fail first in a tuning pass that broke §8.6. Tier 2
  // reaches the ceiling after eight re-emergences and stops there, which is the
  // point — the pressure axis may narrow the gap to the sprint, never cross it.
  for (let reemergences = 0; reemergences <= 40; reemergences += 1) {
    assert.equal(beast.creatureSpeed(3, reemergences), beast.SPEED_CEILING, `tier 3 moved past the ceiling at ${reemergences}`)
    assert.ok(beast.creatureSpeed(2, reemergences) <= beast.SPEED_CEILING, 'tier 2 passed the ceiling')
    assert.ok(beast.creatureSpeed(3, reemergences) >= 5.2, 'the clamp must not slow the finale down')
    assert.equal(beast.detectionRange(3, reemergences), Infinity, '§11.1 row 3: the finale sees everything')
  }
  assert.equal(beast.creatureSpeed(3, 0), 5.2, 'and it is 5.2 on the first frame of the finale, not after a ramp')
  assert.ok(beast.creatureSpeed(2, 0) < beast.SPEED_CEILING, 'a fresh Act II creature is slower than the finale')
  assert.equal(beast.creatureSpeed(2, 40), beast.SPEED_CEILING, 'a very angry Act II creature is exactly the finale speed, not past it')
})

test('the finale ignores the banish ladder and returns in a flat short delay (§10.2)', () => {
  // "banish still works, but the ladder is ignored and re-emergence is a flat
  // short delay. The hammer must stay relevant or Act II's whole skill ceiling
  // evaporates at the climax; the enraged creature simply cannot be made to wait."
  for (let banishes = 0; banishes <= 12; banishes += 1) {
    assert.equal(
      beast.banishWindow({ state: 'enraged', banishCount: banishes, finale: true }),
      beast.ENRAGED_REEMERGENCE_SECONDS,
      `the ladder applied at banish ${banishes}`,
    )
  }
  assert.ok(beast.ENRAGED_REEMERGENCE_SECONDS < beast.BANISH_TABLE[0], 'the finale delay must be shorter than the first rung')
  assert.ok(beast.ENRAGED_REEMERGENCE_SECONDS >= 1, 'and long enough that a swing still costs something')
  // the window is closed a frame before its end and open on it
  const flat = { state: 'dormant', banishCount: 9, finale: true }
  assert.equal(beast.reemergeReady(flat, beast.ENRAGED_REEMERGENCE_SECONDS - 0.02), false)
  assert.equal(beast.reemergeReady(flat, beast.ENRAGED_REEMERGENCE_SECONDS), true)
  // and the whole cycle, walked frame by frame: a connected swing banishes, the
  // banish completes, it comes back on the flat delay, and it comes back angry
  const hit = beast.creatureStep(beast.createCreature({ state: 'enraged', awareness: 1, finale: true }), DT, {
    distance: 1,
    swing: true,
    sounds: [],
  })
  assert.equal(hit.swing.result, 'banish', '§10.2: the hammer must still work in the finale')
  assert.equal(hit.swing.flat, true)
  assert.equal(hit.banishSeconds, beast.ENRAGED_REEMERGENCE_SECONDS, 'and the window is the flat one from the first frame')
  let creature = hit.creature
  for (let i = 0; i < 10_000 && creature.state !== 'dormant'; i += 1) {
    creature = beast.creatureStep(creature, DT, { distance: 60, sounds: [], finale: true }).creature
  }
  assert.equal(creature.state, 'dormant', 'the banish never completed')
  assert.equal(creature.banishCount, 1, 'a connected swing advances the ladder even in the finale')
  const back = beast.creatureStep(creature, DT, {
    distance: 60,
    sounds: [],
    reemerge: beast.reemergeReady(creature, beast.ENRAGED_REEMERGENCE_SECONDS),
    finale: true,
  })
  assert.equal(back.to, 'enraged', 'and it comes back angry, not stalking')
  assert.equal(back.awareness, beast.AWARENESS_CHASE, 'with the meter already full')
  assert.equal(back.creature.reemergenceCount, 1, '§11.2: the pressure axis still counts a re-emergence')
})

test('the finale has no phase-out and no awareness decay (§8.2, §10.2)', () => {
  // §8.2's valve is suspended: "no phase-out — the §8.2 safety valve is
  // suspended". Walked as frames rather than asserted as a constant, because the
  // constant is not where the rule lives: the rule is that not one frame in a
  // long silent window reports a phase-out or lets the meter move.
  let creature = beast.createCreature({ state: 'enraged', finale: true })
  let phaseOuts = 0
  for (let seconds = 0; seconds < 60; seconds += DT) {
    const step = beast.creatureStep(creature, DT, { distance: 200, sounds: [], finale: true })
    creature = step.creature
    if (step.phaseOut) phaseOuts += 1
  }
  assert.equal(phaseOuts, 0, '§10.2: the valve is suspended in the finale')
  assert.equal(creature.state, 'enraged', 'a minute of silence and it gave up')
  assert.equal(creature.awareness, 1, '§10.2: permanent position knowledge, no decay')
  // §8.2 still fires everywhere else, or "suspended" would have meant "removed".
  // The meter is held up with sight, because a chase that lets go of the meter
  // is a chase that ends for the reason §6.3 gives and never reaches the clock.
  let chasing = beast.createCreature({ state: 'chase', awareness: 1 })
  let fired = false
  for (let seconds = 0; seconds < beast.CHASE_MAX_SECONDS + 1 && !fired; seconds += DT) {
    const step = beast.creatureStep(chasing, DT, { distance: 3, sounds: [], seen: true, sightDistance: 3, sightRange: 20 })
    chasing = step.creature
    if (step.phaseOut) fired = true
  }
  assert.equal(fired, true, '§8.2: the valve is gone for every state but the finale')
  // §8.6's other half, as the number the player actually feels. The finale is
  // 0.8 m/s slower than the sprint, and contact is 1.1 m, so the price of a
  // clean escape is CAPTURE_RADIUS / gap seconds of unbroken sprinting — more
  // than a second of running before you are even back in reach, and a couple of
  // seconds to open a real gap. That band is the whole tuning target of §11.3:
  // widen the gap and the climax stops being one, narrow it and it stops being
  // escapable, and neither end is visible in a screenshot.
  const gap = beast.PLAYER_SPRINT_SPEED - beast.SPEED_CEILING
  const secondsToClear = beast.CAPTURE_RADIUS / gap
  assert.ok(secondsToClear > 1, `one second of sprinting buys ${gap.toFixed(2)} m, which is still contact range`)
  assert.ok(secondsToClear < 4, `it takes ${secondsToClear.toFixed(1)} s to leave contact — the finale is not a chase you can never break`)
})

test('walking into the exit wins, freezes the world, and rings the chord once (§10.4)', () => {
  const state = finaleRun()
  const exit = state.exitAnchor.position
  const inside = { x: exit.x, z: exit.z }
  // the car is there from Act I (§10.3), so the geometry alone wins nothing
  assert.equal(rules.isInsideExit(inside, exit), true)
  assert.equal(rules.checkExitWin({ ...state, finale: false }, inside), false, 'won without the finale')
  assert.equal(rules.checkExitWin(state, inside), true, 'the finale did not open the exit')
  assert.equal(rules.checkExitWin(state, { x: exit.x + 2, z: exit.z }), false, 'won from two metres away')

  // the world's half of the win, which is a *phase* and a freeze
  const win = worldMethod('_win')
  assert.match(win, /this\.store\.set\(\{ phase: PHASE\.WON, prompt: null \}\)/, 'the win does not set PHASE.WON')
  assert.match(win, /this\.player\.enabled = false/, 'the win does not stop the player')
  assert.match(win, /this\.audio\?\.winChord\(\)/, 'the win does not ring the chord')
  assert.equal((win.match(/winChord\(\)/g) ?? []).length, 1, 'the chord is rung more than once in one win')
  assert.match(
    win,
    /if \(this\.store\.get\(\)\.phase === PHASE\.WON \|\| this\.paused\) return false/,
    'a second call in the same frame would ring it again',
  )
  // the phase machine routes WON to the frozen branch and nowhere else
  assert.match(WORLD_SOURCE, /case PHASE\.WON:\n        this\._updateWon\(dt\)/)
  const won = worldMethod('_updateWon')
  for (const forbidden of ['player.update', 'creatureStep', '_updateVerbs', '_updateCreature', '_walkCreature']) {
    assert.equal(won.includes(forbidden), false, `_updateWon runs ${forbidden}`)
  }
  assert.match(won, /this\.fade = Math\.min\(0\.6, this\.fade \+ dt \* 0\.8\)/, 'the fade stopped moving behind the card')
  // the exit is tested on the frame the verbs and the creature have already had
  // their turn, so winning on the way in skips nothing
  assert.match(WORLD_SOURCE, /if \(this\.state\.finale && this\._insideExit\(\)\) this\._win\(\)/)
  assert.match(WORLD_SOURCE, /_insideExit\(\) \{[\s\S]*?rules\.checkExitWin\(/)
  // §13's half of the win is routed even though the chord is not: `won` is a
  // field on the frame, and the drone comes down to v1's duck
  assert.equal(audio.droneLevelFor({ won: true }), audio.DRONE_LEVEL_WON)
  assert.ok(audio.DRONE_LEVEL_WON < audio.DRONE_LEVEL_BLACK, 'the win duck is above the capture black')
  assert.match(WORLD_SOURCE, /won: this\.phase === PHASE\.WON,/)
})

test('BEGIN AGAIN is a full wipe, and it is the only one (§10.4 against §9.1)', () => {
  const fresh = rules.createInitialState(hood.placeObjectives(1337, 1))
  // §10.4's whole claim: a wiped run is indistinguishable from a new one
  const dirty = {
    ...fresh,
    portals: { A: true, B: true, C: true },
    progress: { A: 1, B: 1, C: 0.6 },
    hammerHeld: true,
    banishCount: 4,
    finale: true,
    dusk: 1,
    breath: 0.31,
    exhausted: true,
    loop: 7,
    player: { x: 900, z: -900 },
    prompt: 'portal',
    creature: { state: 'enraged', reemergenceCount: 3, awareness: 1 },
    sounds: [{ kind: 'toll', radius: 30, position: { x: 0, z: 0 } }],
  }
  assert.deepEqual(rules.wipeRun(dirty), fresh, 'the wipe left something behind')
  // the anchors are geometry, not progress (§3.4), so they are the one exemption
  assert.deepEqual([...rules.WIPE_EXEMPT_FIELDS], ['objectives', 'exitAnchor'])
  // every field of the state is decided by one table or the other: a field added
  // to the state and to neither table is a rule nobody chose
  const decided = new Set([...rules.WIPE_TABLE.map((row) => row.field), ...rules.CAPTURE_TABLE.map((row) => row.field)])
  for (const field of Object.keys(fresh)) {
    assert.ok(decided.has(field) || rules.WIPE_EXEMPT_FIELDS.includes(field), `no table decides what '${field}' does`)
  }
  // and the contrast with §9.1 is the design's own sentence, checked as data:
  // everything CAPTURE_TABLE keeps, the wipe takes
  const keep = rules.CAPTURE_TABLE.filter((row) => row.mutation === 'keep').map((row) => row.field)
  assert.deepEqual(keep, ['portals', 'hammerHeld', 'banishCount', 'finale', 'dusk'])
  for (const field of keep) {
    assert.ok(
      rules.WIPE_TABLE.some((row) => row.field === field),
      `BEGIN AGAIN keeps ${field}, which §9.1 says a death must never do`,
    )
  }
  assert.equal(
    rules.WIPE_TABLE.some((row) => row.mutation === 'keep'),
    false,
    "there is no 'keep' on the only button in the game that may take things",
  )
  // each row, walked: dirty the one field, wipe, and check only that field moved
  for (const row of rules.WIPE_TABLE) {
    const after = rules.wipeRun({ ...fresh, [row.field]: 'DIRTY' })
    assert.notEqual(after[row.field], 'DIRTY', `the wipe skipped ${row.field}`)
  }
  assert.equal(rules.wipeRun(fresh, { loop: 5 }).loop, 5, 'the loop to return to is an argument, not a constant')
})

test('the world wipes the run, with the wipe and never the capture', () => {
  const restart = worldMethod('restart')
  assert.match(restart, /this\.state = rules\.wipeRun\(this\.state, \{ loop: 1 \}\)/, 'the world does not use §10.4\'s wipe')
  assert.equal(/applyCapture/.test(restart), false, 'BEGIN AGAIN runs the capture table, which keeps everything §9.1 protects')
  // the visible consequences are put back, not just the flags behind them
  for (const call of [
    'this.streetView.setHeadlights(false)',
    'this.streetView.setHammerTaken(false)',
    'this.streetView.applyLoop(1)',
    'this._applyDusk(0)',
    'this.hammerFlash = 0',
    'this.finaleEffect = hud.finaleEffectInit()',
  ]) {
    assert.ok(restart.includes(call), `BEGIN AGAIN does not call ${call}`)
  }
  assert.match(restart, /for \(const portal of this\.streetView\.portals\) this\.streetView\.setPortalShut\(portal\.id, false\)/)
  // the per-portal §5.2 windows and the per-portal hold readings are run state
  // too, and both are cleared here rather than surviving into the new run
  assert.match(restart, /this\.portalNoiseElapsed = Object\.fromEntries/)
  assert.match(restart, /this\._holdByPortal = Object\.fromEntries/)
  // the win card is the one screen the player was never holding the lock on, so
  // the wipe asks for it again from the click that pressed the button
  assert.match(restart, /this\.player\.requestLock\(\)/, 'a new run starts un-walkable')
  assert.match(restart, /this\.store\.set\(\{ phase: PHASE\.RESET, fade: 1 \}\)/)
  // the creature goes back to Act I, and the player's body to spawn
  assert.match(restart, /beast\.createCreature\(\{ state: 'telegraph' \}\)/)
  assert.match(restart, /this\.player\.teleport\(SPAWN\.position\.x, SPAWN\.position\.z, SPAWN_YAW\)/)
})

test('the exit car is a beacon that survives the fog (§10.3)', () => {
  // §10.3 is the detail the finale depends on: "Without it, the finale is a
  // random search across a wrapping 448 m neighborhood at maximum aggression,
  // which is a coin flip rather than a climax." Two properties make it a beacon,
  // and both are read out of the source because `streetView.js` imports Three.js
  // and the pure gate cannot import it (§15.1) — so the numbers come from the
  // pure half and the geometry from the text.
  assert.match(STREET_VIEW_SOURCE, /_glow\(color, options = \{\}\) \{[\s\S]*?fog: false/)
  assert.match(STREET_VIEW_SOURCE, /headlight: this\._glow\(PALETTE\.headlight\)/, 'the headlights are lit geometry, not a lit surface')
  assert.match(STREET_VIEW_SOURCE, /lamp\.visible = false/, '§10.3: the car is dark in Act I')
  // the one method that turns it on turns on both halves — the two lamp boxes
  // that read through the fog, and the beam that lights the pavement
  const setter = STREET_VIEW_SOURCE.slice(STREET_VIEW_SOURCE.indexOf('  setHeadlights(on) {'))
  assert.match(setter, /for \(const lamp of this\.exitCar\.lamps\) lamp\.visible = this\.exitCar\.lit/)
  assert.match(setter, /this\.exitCar\.beam\.intensity = this\.exitCar\.lit \? [\d.]+ : 0/)
  // the beam is pulled out of the source and compared against the fog, because
  // the comparison *is* the design: a beam shorter than the fog's half-visibility
  // lights nothing you can see
  const beam = STREET_VIEW_SOURCE.match(/new THREE\.PointLight\(PALETTE\.headlight, 0, ([\d.]+), 2\)/)
  assert.ok(beam, 'the headlight beam is not where it was')
  const range = Number(beam[1])
  const tightest = rules.fogVisibility(rules.fogDensityForDusk(1))
  assert.ok(range > tightest, `the beam reaches ${range} m and the fog is half opaque at ${tightest.toFixed(1)} m`)
  // the fog is at its tightest on exactly the frame the car lights up, and §3.7
  // keys it to portals rather than to captures, so dying never puts the beacon
  // back out of reach
  assert.equal(rules.duskForPortals({ A: true, B: true, C: true }), 1)
  assert.ok(rules.fogDensityForDusk(1) > rules.fogDensityForDusk(0))
  assert.equal(rules.applyCapture(finaleRun()).dusk, 1, 'a capture thinned the fog back out')
})

test('the win card says §10.4, and v1 never comes back', () => {
  const winCard = readFileSync(new URL('./src/ui/WinOverlay.jsx', import.meta.url), 'utf8')
  assert.match(winCard, /THE NEIGHBORHOOD WENT QUIET\./, '§10.4: the win screen')
  assert.match(winCard, /BEGIN AGAIN/, 'and the button that wipes the run')
  assert.match(APP_SOURCE, /hud\.phase === PHASE\.WON \? <WinOverlay onRestart=\{restart\} \/>/, 'the card is not on the won phase')
  // the v1 line is gone from the whole of `src/`, not just from the card: a
  // string that comes back in a comment is one refactor away from coming back
  // on screen
  const sources = readdirSync(new URL('./src', import.meta.url), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js') || name.endsWith('.jsx'))
  assert.ok(sources.length > 10, `only ${sources.length} sources found — is the walk broken?`)
  for (const name of sources) {
    const text = readFileSync(new URL(`./src/${name}`, import.meta.url), 'utf8')
    assert.equal(text.includes('BELL STOPPED'), false, `v1's win line is back in ${name}`)
  }
  // §14.1's "no new text" is still true of the HUD: the card is chrome, the HUD
  // is not, and the finale reaches the HUD as levels rather than as words
  assert.match(HUD_JSX_SOURCE, /finaleActive/)
  assert.equal(hud.HUD_FIELDS.includes('finaleActive'), true, 'the HUD no longer projects the finale')
  assert.equal(hud.HUD_FIELDS.includes('winText'), false, '§14.1: the win line is a card, not a HUD field')
})

// ---------------------------------------------------------------------------
// iteration 2, pass 1 — the sodium retune: sky, fog, hemisphere, exposure
//
// The player report this section exists for was "the world is too dark to see
// things", with a reference to the Backrooms video (67ktSmxCniA) and a request
// for a mono-yellow sodium haze that is *lighter* than what shipped.
//
// WHY THE CHECKS BELOW ARE ARITHMETIC AND NOT ECHOES
// --------------------------------------------------
// `streetView.js` imports Three.js, so `verify.mjs` cannot import `PALETTE` and
// read it (§15.1's seam). The obvious workaround — assert the literal hex — is
// worthless: it restates the file back at itself, passes the moment someone edits
// a hex, and fails the moment someone edits it in a *good* way. So the values are
// read out of the source the way §15.1 already reads it, and what is asserted is
// the four *properties* the retune was for:
//
//   1. every stop is warm and sodium (R > G > B) — the hue complaint
//   2. every stop is lighter than the violet it replaced — the "too dark" complaint
//   3. the ramp still closes, and the mid stop is still the crest — §3.7
//   4. the fog is darker than the sky at every stop — the silhouette rule
//
// A future pass that retunes the palette again passes these as long as the world
// is still warm, still legible, still a clock, and still has a dark thing to be a
// hole in. Only a regression fails, which is the entire job.
// ---------------------------------------------------------------------------

section('Sodium dusk (iteration 2, pass 1)')

/** Rec. 709 relative luminance of a 24-bit hex, 0-255. */
function relLuma(hex) {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The three stops of one of §12.3's ramps, read out of `streetView.js`'s source.
 *
 * Comment-stripped first, and that is the whole reason: the retune's own comments
 * quote the old hexes (`0x2a2233 / 0x4a3550 / 0x12101a`) so a reader of the file
 * can see what changed without a git log, which means a naive source grep for hex
 * literals returns nine values instead of three and silently reads the comment.
 * `stripProse` is the existing answer to exactly this problem (the audio-module
 * checks use it for the same reason), so it is reused rather than reinvented.
 */
function paletteStops(key) {
  const code = stripProse(STREET_VIEW_SOURCE)
  const line = new RegExp(`${key}:\\s*Object\\.freeze\\(\\[([^\\]]+)\\]\\)`).exec(code)
  assert.ok(line, `${key} is not a frozen three-stop array in streetView.js`)
  const stops = [...line[1].matchAll(/0x([0-9a-fA-F]{6})/g)].map((m) => Number.parseInt(m[1], 16))
  assert.equal(stops.length, 3, `${key} has ${stops.length} stops, not the three §3.7 slides between`)
  return stops
}

const SKY_STOPS = paletteStops('skyStops')
const FOG_STOPS = paletteStops('fogStops')

test('the palette is the six stops this pass chose (iteration 2, pass 1)', () => {
  // The four tests after this one are *properties*, and a property gate is
  // deliberately loose: swapping 0x6b5836 for a brighter ochre leaves every one of
  // them green while visibly changing the look of the game. Nothing about "warm",
  // "lighter than the violet", "still closes" or "fog under sky" says which amber
  // was picked, so on their own they would let the next mood pass drift the
  // benchmark's whole subject without a single failure.
  //
  // The two are not in tension, and the split is the point. An *accidental*
  // regression fails the property tests and is caught by anyone, thinking about
  // colour or not. A *deliberate* retune is expected to fail this one, and the
  // remedy is to move the pin in the same commit that moves the colour — which is
  // precisely the moment a reviewer gets told the world got brighter, rather than
  // the moment they notice on a screenshot three passes later.
  assert.deepEqual(
    SKY_STOPS,
    [0x6b5836, 0x7a6440, 0x3f3320],
    `skyStops is now ${SKY_STOPS.map((s) => `0x${s.toString(16)}`).join(' / ')}, ` +
      'not the sodium ramp this pass selected — move this pin in the same commit as the colour',
  )
  assert.deepEqual(
    FOG_STOPS,
    [0x574a30, 0x6a5938, 0x332a1c],
    `fogStops is now ${FOG_STOPS.map((s) => `0x${s.toString(16)}`).join(' / ')}, ` +
      'not the sodium ramp this pass selected — move this pin in the same commit as the colour',
  )
})

test('the sky and fog are sodium ochre, not violet (iteration 2, pass 1)', () => {
  // The hue claim, as a comparison rather than a comment. R > G > B on every stop
  // is what "warm" means numerically; the old ramp was 0x2a2233, which is
  // R < G < B, i.e. blue-violet, and a blue-violet sky is what made a sodium-lit
  // street read as two unrelated colour schemes meeting in the middle of frame.
  for (const [key, stops] of [['skyStops', SKY_STOPS], ['fogStops', FOG_STOPS]]) {
    for (const stop of stops) {
      const r = (stop >> 16) & 0xff
      const g = (stop >> 8) & 0xff
      const b = stop & 0xff
      assert.ok(r > g, `${key} stop 0x${stop.toString(16)}: red is not above green — that is not a warm hue`)
      assert.ok(g > b, `${key} stop 0x${stop.toString(16)}: green is not above blue — the stop is cold, not sodium`)
    }
  }
  // and the two ramps are the *same* hue family, which is what makes the world
  // read as one lit thing rather than as a warm street under a foreign sky. The
  // ratios are close rather than identical because the fog is deliberately the
  // darker of the pair (the next test says why).
  const spread = [...SKY_STOPS, ...FOG_STOPS].map((stop) => {
    const r = (stop >> 16) & 0xff
    const g = (stop >> 8) & 0xff
    return g / r
  })
  const min = Math.min(...spread)
  const max = Math.max(...spread)
  assert.ok(max - min < 0.1, `the ramps disagree on hue: g/r spans ${min.toFixed(3)}-${max.toFixed(3)}`)
})

test('every stop is lighter than the violet it replaced (iteration 2, pass 1)', () => {
  // The "too dark to see things" half of the report, and the one that is easiest
  // to regress by accident: someone lifting the mid stop for a sunset and
  // dropping stop 2 for mood would satisfy every other test in this section.
  //
  // The pre-pass values are restated here as a specification rather than read
  // back out of git, so the floor is a claim the gate holds the palette to.
  const VIOLET_SKY = [0x2a2233, 0x4a3550, 0x12101a]
  const VIOLET_FOG = [0x241d2a, 0x1e1826, 0x141018]
  for (const [key, stops, before] of [
    ['skyStops', SKY_STOPS, VIOLET_SKY],
    ['fogStops', FOG_STOPS, VIOLET_FOG],
  ]) {
    for (const [index, stop] of stops.entries()) {
      const now = relLuma(stop)
      const then = relLuma(before[index])
      assert.ok(
        now > then * 1.5,
        `${key}[${index}] is ${now.toFixed(1)} luma against the old ${then.toFixed(1)} — the pass was to make the world lighter`,
      )
    }
  }
  // and a floor in absolute terms, because "1.5x a number that was nearly black"
  // is a ratio that can be satisfied by 3 luma. §12.1's dusk is lit: the darkest
  // sky the game ever draws has to be a colour a player can see the creature
  // against, and the capture floor (6% of the lower scene) is the same claim
  // measured on a photograph instead of on arithmetic.
  const darkestSky = Math.min(...SKY_STOPS.map(relLuma))
  const darkestFog = Math.min(...FOG_STOPS.map(relLuma))
  assert.ok(darkestSky > 45, `the darkest sky stop is ${darkestSky.toFixed(1)} luma — the finale is a black frame`)
  assert.ok(darkestFog > 35, `the darkest fog stop is ${darkestFog.toFixed(1)} luma — the finale is a black frame`)
})

test('the dusk ramp still closes, and its crest is still the middle (iteration 2, pass 1)', () => {
  // §3.7: dusk is keyed to portals shut, and its entire design purpose is to be a
  // clock the player can read without a number. A brighter palette makes that
  // easier to break, not harder — the temptation is to lift the whole ramp evenly
  // and end up with a world that never gets dark, which is §12.1's failure mode
  // ("a fully lit one would destroy it differently by removing the fog").
  for (const [key, stops] of [['skyStops', SKY_STOPS], ['fogStops', FOG_STOPS]]) {
    const lumas = stops.map(relLuma)
    assert.ok(lumas[0] > lumas[2], `${key}: stop 0 (${lumas[0].toFixed(1)}) is not lighter than stop 2 (${lumas[2].toFixed(1)}) — the world never closes`)
    // a real ratio, not just "greater": the dusk has to be *legible* as a ramp
    assert.ok(
      lumas[0] > lumas[2] * 1.5,
      `${key}: the ramp is only ${(lumas[0] / lumas[2]).toFixed(2)}x end to end, which is not a visible dusk`,
    )
    // the crest. A sodium overcast is brightest where the haze is thickest, and
    // the old ramp had it too (0x4a3550 was lighter than 0x2a2233). A monotone
    // ramp is a grey sky, so this is held deliberately rather than tidied away.
    assert.ok(lumas[1] > lumas[0], `${key}: the mid stop is no longer the crest — the sky went flat`)
  }
})

test('the fog is darker than the sky at every stop (§12.1 silhouettes)', () => {
  // Geometry fades *towards* `fog.color`, and `scene.background` is set to the
  // same colour. So the two are not two decorative choices: if the fog ever rose
  // above the sky, a distant roof would be lighter than the sky behind it and the
  // world would read inside-out. This was true of the old pair and it has to stay
  // true of the new one, which is why it is checked pairwise at all three stops
  // rather than only at the one the captures happen to show.
  for (const index of [0, 1, 2]) {
    const fog = relLuma(FOG_STOPS[index])
    const sky = relLuma(SKY_STOPS[index])
    assert.ok(fog < sky, `stop ${index}: the fog (${fog.toFixed(1)}) is not darker than the sky (${sky.toFixed(1)})`)
  }
})

test('the ambient and exposure curves are warmer, higher and flatter (iteration 2, pass 1)', () => {
  // The three numbers in `world.js`, read as numbers rather than as prose, and
  // then checked against the *claims* made about them. `EXPOSURE_BASE` and
  // `EXPOSURE_CUT` are named constants precisely so this can parse them; a
  // literal in a method body would be unreadable from outside without re-running
  // the renderer, which is the failure mode §15.1's seam is designed around.
  const code = stripProse(WORLD_SOURCE)
  const exposureBase = Number(/const EXPOSURE_BASE = ([\d.]+)/.exec(code)?.[1])
  const exposureCut = Number(/const EXPOSURE_CUT = ([\d.]+)/.exec(code)?.[1])
  assert.ok(Number.isFinite(exposureBase), 'EXPOSURE_BASE is not a readable constant')
  assert.ok(Number.isFinite(exposureCut), 'EXPOSURE_CUT is not a readable constant')

  // The expression `_applyDusk` actually evaluates, and the one the properties
  // below are reasoned about have to be the same expression. Without this the
  // whole test is a description of a curve that may not exist: restoring the old
  // `0.95 - 0.17 * t` in the method body while leaving the two constants at their
  // new values passes every numeric assertion here, because those assertions read
  // the constants and never the call site. That was a real hole — it was found by
  // reverting the curve and watching this test stay green.
  // `[^\n;]` rather than a character class of the legal tokens: the previous
  // version allowed whitespace in the class, which let the match run past the end
  // of the line and swallow the identifiers on the next one.
  const applied = /this\.renderer\.toneMappingExposure = ([^\n;]+)/g
  const expressions = [...code.matchAll(applied)].map((m) => m[1].trim())
  assert.equal(expressions.length, 2, `the exposure is written ${expressions.length} times, not the two writers §15.2 expects`)
  assert.ok(expressions.includes('EXPOSURE_BASE'), 'nothing seeds the renderer with the curve at t = 0')
  const curve = expressions.find((expression) => expression !== 'EXPOSURE_BASE')
  assert.equal(
    curve,
    'EXPOSURE_BASE - EXPOSURE_CUT * t * t',
    'the dusk curve is not the quadratic this section specifies — the quadratic *is* the fix',
  )

  // BEFORE `0.95 - 0.17t` / AFTER `1.02 - 0.14t^2`, restated so the gate holds the
  // shape rather than the numbers. The quadratic is the actual fix and it is the
  // part worth protecting: Act I and Act II are played between t = 0 and t = 0.66,
  // and the old curve was already charging the player for darkness during the
  // part of the run where the design wants them looking at the street.
  const oldAt = (t) => 0.95 - 0.17 * t
  const newAt = (t) => exposureBase - exposureCut * t * t
  for (const t of [0, 0.25, 0.5, 0.66, 1]) {
    assert.ok(newAt(t) > oldAt(t), `exposure at t = ${t} is ${newAt(t).toFixed(3)}, at or below the old ${oldAt(t).toFixed(3)}`)
  }
  // and it is still a curve, in the right direction: §3.7 wants the world to
  // tighten as the run advances, so a flat exposure would be as wrong as a
  // descending one that crushes.
  assert.ok(newAt(0) > newAt(1), 'exposure does not fall across a run at all — §3.7 dusk is no longer visible')
  assert.ok(exposureCut > 0, 'EXPOSURE_CUT is not positive, so the curve cannot fall')
  // the endpoints are bounded on both sides: not a wash, not a cellar
  assert.ok(newAt(1) >= 0.85, `the finale exposure is ${newAt(1).toFixed(3)} — the world crushes at dusk 1`)
  assert.ok(newAt(0) <= 1.15, `the opening exposure is ${newAt(0).toFixed(3)}, which is day, not dusk`)

  // the hemisphere, BEFORE 0.5 / AFTER 0.85, and its slope BEFORE 0.22 / AFTER 0.18
  const hemisphere = /new THREE\.HemisphereLight\(PALETTE\.skyStops\[0\], 0x[0-9a-fA-F]{6}, ([\d.]+)\)/.exec(code)
  assert.ok(hemisphere, 'the hemisphere light is not built from the sky stop any more')
  const ambient = Number(hemisphere[1])
  assert.equal(ambient, 0.85, 'the hemisphere intensity is not the 0.85 this pass set')
  assert.ok(ambient >= 0.75 && ambient <= 0.9, `the hemisphere is at ${ambient}, outside the 0.75-0.9 the brief asked for`)
  const falloff = /this\.hemisphere\.intensity = ([\d.]+) - ([\d.]+) \* t/.exec(code)
  assert.ok(falloff, 'the hemisphere no longer fades with dusk, so §3.7 has no clock')
  assert.equal(Number(falloff[1]), ambient, 'the constructor and the dusk curve disagree about the ambient level')
  assert.ok(Number(falloff[2]) > 0, 'the ambient does not fall with dusk')
  assert.ok(ambient - Number(falloff[2]) >= 0.6, 'the ambient at dusk 1 is under 0.6 — the finale is unlit again')

  // the sky the hemisphere casts has to be the retuned sky, not a private colour
  // that happens to be nearby. This is the line that keeps §12.3's table and the
  // light rig from drifting into two palettes.
  assert.match(code, /PALETTE\.skyStops\[0\]/)
  // and the directional key is no longer the mauve it shipped as
  const sunset = /new THREE\.DirectionalLight\(0x([0-9a-fA-F]{6}), ([\d.]+)\)/.exec(code)
  assert.ok(sunset, 'the horizon key light is gone')
  const keyR = Number.parseInt(sunset[1].slice(0, 2), 16)
  const keyB = Number.parseInt(sunset[1].slice(4, 6), 16)
  assert.ok(keyR > keyB, `the horizon key is 0x${sunset[1]}, which is violet against a sodium sky`)
  assert.ok(Number(sunset[2]) > 0.3, 'the horizon key is too dim to lift the rooflines')
})

test('the constructor exposure is the curve at dusk 0', () => {
  // `_applyDusk(0)` runs during construction, so the two writers are a few lines
  // apart and a literal in one of them is invisible to the reader of the other.
  // This is a one-line bug class and it is worth a test that the two agree.
  const code = stripProse(WORLD_SOURCE)
  const constructor = /this\.renderer\.toneMapping = THREE\.ACESFilmicToneMapping[\s\S]*?this\.renderer\.toneMappingExposure = ([A-Z_0-9]+)/.exec(code)
  assert.ok(constructor, 'the renderer exposure is not written next to the tone mapping any more')
  assert.equal(constructor[1], 'EXPOSURE_BASE', 'the constructor stopped using the named exposure constant')
  const base = /const EXPOSURE_BASE = ([\d.]+)/.exec(code)
  assert.equal(Number(base[1]), 1.02, 'EXPOSURE_BASE is not the 1.02 this pass set')
})


// ---------------------------------------------------------------------------
// iteration 2, pass 2 — the sodium family: pool width, bounce, reach, and the
// one gate the pass-1 review asked for by name
//
// THE REVIEW'S "MOST VALUABLE GATE TO ADD NEXT"
// --------------------------------------------
// `REVIEW-pass-1.md` closed with this, under residual risk:
//
//   "The creature silhouette is currently protected by a *source* property
//   (fog < sky) plus a *rendered* observation I made by hand. Nothing in the
//   gate measures creature-vs-background separation in a frame. A future pass
//   that lifts the fog without lifting the sky could satisfy every existing
//   check and still cost the subject its read. This is the most valuable gate
//   to add next."
//
// That is this section's first test, and it is written to fail for exactly the
// reason the review gives. `fog < sky` is a *palette* property; a pass can
// brighten the creature, or the bounce family introduced below can wash it,
// without moving a single hex. The only claim that survives that is measured on
// the rendered frame: the creature's population is darker than the background
// it stands in, by a margin, today.
//
// WHY IT READS THE COMMITTED PNG
// ------------------------------
// Because that is the artifact the benchmark ships. `main/README.md`'s result
// table is built from these files, so a separation property only ever measured
// on a frame nobody commits is a property of a local run. This is the same
// trade the anti-rotation check already makes, and it has the same known gap —
// a stale PNG passes. Capture runs close that gap, not this test.
// ---------------------------------------------------------------------------

section('Sodium light (iteration 2, pass 2)')

test('the creature still reads darker than its background (§12.1)', () => {
  // THE GATE THE PASS-1 REVIEW ASKED FOR — AND WHY IT WAS REWRITTEN IN PASS 2
  //
  // The first version of this test asserted `p0_1 / median` over the whole
  // lower scene, on the reasoning that the darkest thousandth was the creature
  // and the median was the lit road it stood on. It passed, and it was worth
  // nothing, for a reason that is easy to demonstrate and was checked before
  // anything was rewritten:
  //
  //   `street.png` — which contains NO creature — scored 0.14 on that ratio,
  //   against 0.18 for `creature-stalking.png`.
  //
  // A frame with no subject in it out-scored the frame with a subject in it. A
  // gate like that cannot fail, so whatever it was reporting, it was not
  // reporting the creature. The cause is that `p0_1` and `median` are
  // properties of the frame's HISTOGRAM: on this street that histogram is a
  // bright mass (the sodium pools) and a dark mass (the vignette, the unlit
  // house fronts), the darkest 460 px of 460,800 are the frame's own corners,
  // and brightening the pools lowers the ratio whether or not the creature
  // changed at all. The comment it shipped with — "p0_1 IS the creature" — was
  // simply false, and false in a way that made the gate decorative.
  //
  // The replacement measures the thing §12.1 actually claims. A "hole in the
  // fog" is a statement about a subject and its IMMEDIATE surround, so the
  // subject is located first (by its unfogged additive eye quad, the one mark
  // in a frame that is unambiguously the creature) and the body's own pixels
  // are compared against the pixels 10-30 px either side of them. Those two
  // populations are adjacent, so they share the fog, the dusk and the grade: a
  // pass that lifts the whole world moves both and the ratio holds, and a pass
  // that lifts the creature alone is caught. The percentile version had no such
  // property, which is the whole reason it could not fail.
  const file = new URL(`./${capture.CAPTURE_DIR}/creature-stalking.png`, import.meta.url)
  assert.equal(existsSync(file), true, 'creature-stalking.png is missing — run npm run capture')
  const measured = creatureContrast(readFileSync(file))
  // A frame with no creature in it cannot be a frame where the creature reads
  // as a hole. Stated first, and as its own assertion, because it is the
  // property the old gate lacked entirely: the ratio below is only meaningful
  // once there is something on the other side of it.
  assert.ok(measured.found, `no creature in creature-stalking.png: ${measured.reason}`)
  // §12.1: "it should read as a hole in the fog rather than an object in it."
  // A hole is darker than what surrounds it. The threshold is 0.62 and the
  // measured value is 0.57, so the margin is deliberately thin — this is the
  // one gate in the file with almost no headroom, and that is on purpose: the
  // subject is small, its background is a graded pool rather than a flat field,
  // and a loose threshold here would be the same decorative gate again, just
  // with a better formula. Both sides of the number are reported in the failure
  // message so a retune starts from the measurement rather than from a guess.
  assert.ok(
    measured.ratio < 0.62,
    `the creature is not a hole in the frame: ${describeCreatureContrast(measured)} (needs under 0.62)`,
  )
  // and the background it is a hole IN is actually lit. Without this half a
  // black shape on an unlit wall scores a perfect 0.0 and the test above is
  // satisfied by a frame with nothing in it worth silhouetting against — which
  // is not a hypothetical: at bearing 34 the stalk frame put the figure against
  // a dark house front, and it measured a ratio of 1.22, i.e. brighter than its
  // own background, while this same global gate called it 0.18. The floor is
  // `LIT_LUMA` — the same constant §16.5's own floor is built on, so "lit" means
  // one thing in this repository rather than two.
  assert.ok(
    measured.sides >= LIT_LUMA,
    `the creature is against an unlit background (luma ${measured.sides.toFixed(1)}), so there is ` +
      `nothing for it to be a silhouette against — reframe it into the pool rather than darkening the world`,
  )
})

test('the creature gate cannot be satisfied by a frame with no creature in it', () => {
  // The control for the test above, and the one the percentile gate could not
  // have had. `street.png` is shot from the SAME viewpoint as
  // `creature-stalking.png` — both are `goto lamp`, with the creature absent in
  // one of them — so it is the exact frame the old measure scored 0.14 on. If
  // `creatureContrast` reports a creature in it, the anchor has stopped being an
  // anchor and every other number in this section is about something else.
  //
  // This is asserted rather than assumed because the failure it guards against
  // is silent and self-flattering: a measure that finds "a creature" in every
  // frame will pass this section forever while measuring nothing at all.
  const street = new URL(`./${capture.CAPTURE_DIR}/street.png`, import.meta.url)
  assert.equal(existsSync(street), true, 'street.png is missing — run npm run capture')
  const measured = creatureContrast(readFileSync(street))
  assert.equal(
    measured.found,
    false,
    `street.png contains no creature, but the gate found one: ${describeCreatureContrast(measured)}`,
  )
})

test('the eye-finder\'s own numbers hold on the shipped gallery, and brightness is not what does the work', () => {
  // WHY THIS EXISTS
  // ---------------
  // `tools/png-luma.mjs` justifies `EYE_MIN` 150 and `EYE_MAX_SPAN` 14 in prose, and
  // until pass 11's review that prose was the only place the numbers lived. It had
  // also gone stale: the comment claimed "the brightest thing anywhere in
  // `street.png` — a lamp head — peaks at 167", and pass 11's lamp strobe took the
  // peak of that frame to 249. The THRESHOLD did not move and the FINDER did not
  // move, because brightness was never the discriminator — the span, fill and area
  // tests are — but a reader had no way to know that from the file, and no gate
  // would have noticed if it had stopped being true.
  //
  // So the comment's three claims are read off the committed PNGs here and asserted:
  //
  //   1. every creature frame resolves an eye, and that eye clears `EYE_MIN` with
  //      room rather than by a hair (the pass-11 measurement is `banish` at 171,
  //      which is 21 luma over the floor — a margin worth stating, because the
  //      comment previously quoted only the two comfortable frames);
  //   2. every one of those blobs is inside `EYE_MAX_SPAN`, and the TIGHTEST of
  //      them is reported, because `banish` is 12 px tall against a 14 px ceiling
  //      and a re-shot that pushed it to 15 would silently stop resolving a
  //      creature that is plainly in the picture;
  //   3. and `street.png` is BRIGHTER THAN THE FLOOR and still reports no eye —
  //      which is the claim the stale comment made and could not have been
  //      supporting. If that frame's peak ever falls under `EYE_MIN`, the
  //      "brightness is not the discriminator" argument goes untested and this
  //      test fails rather than quietly becoming true again.
  //
  // The constants are IMPORTED, not restated, for the reason pass 7's gate gives: a
  // check that writes 150 next to a module that owns 150 is a check that will still be
  // green the day one of them is retuned. The relations below are all stated against the
  // imported values, so the relations cannot drift from the implementation.
  //
  // AND THEY ARE PINNED AS WELL, which looks like the opposite mistake and is not. The
  // first version of this test imported all three and every relation scaled with them,
  // so raising `EYE_MAX_SPAN` 14 -> 60 — the exact mutation that lets scenery pass as a
  // creature — left 252/252 green, and dropping `EYE_MIN_AREA` 24 -> 1 did the same.
  // A relation against a constant proves the two agree, not that either is right. These
  // three ARE the contract rather than a derived value, so their values are the claim,
  // and a retune has to say so here. A future pass that genuinely wants a different
  // number changes this line and the comment above it in the same commit.
  assert.equal(EYE_MIN, 150, `EYE_MIN is ${EYE_MIN}; the threshold this whole file is calibrated to is 150`)
  assert.equal(EYE_MAX_SPAN, 14, `EYE_MAX_SPAN is ${EYE_MAX_SPAN}; the banish frame's 12 px eye has 2 px of room and no more`)
  assert.equal(EYE_MIN_AREA, 24, `EYE_MIN_AREA is ${EYE_MIN_AREA}; the largest square impostor in the gallery is 9 px`)
  const frames = ['creature-stalking', 'creature-chasing', 'banish']
  const readings = []
  for (const id of frames) {
    const file = new URL(`./${capture.CAPTURE_DIR}/${id}.png`, import.meta.url)
    assert.equal(existsSync(file), true, `${id}.png is missing — run npm run capture`)
    const measured = creatureContrast(readFileSync(file))
    assert.ok(measured.found, `${id}.png holds no creature: ${measured.reason}`)
    const eye = measured.eye
    const spanX = eye.maxX - eye.minX
    const spanY = eye.maxY - eye.minY
    assert.ok(eye.mean >= EYE_MIN, `${id}.png resolves an eye at ${eye.mean.toFixed(1)} mean, under EYE_MIN ${EYE_MIN}`)
    assert.ok(eye.n >= EYE_MIN_AREA, `${id}.png resolves a ${eye.n} px eye, under EYE_MIN_AREA ${EYE_MIN_AREA}`)
    assert.ok(
      spanX <= EYE_MAX_SPAN && spanY <= EYE_MAX_SPAN,
      `${id}.png resolves a ${spanX}x${spanY} px eye, and EYE_MAX_SPAN is ${EYE_MAX_SPAN} — a creature is in the picture and the finder cannot see it`,
    )
    readings.push({ id, mean: eye.mean, spanX, spanY, n: eye.n, luma: eye.mean - EYE_MIN })
  }
  // 1b. THE MARGIN IS A MARGIN. Ten luma under the floor is a frame that passes by
  // rounding, and a pass-11 note that quotes only the comfortable frames is how a
  // 21-luma margin became an unstated 4-luma one.
  const tightest = readings.reduce((a, b) => (a.luma <= b.luma ? a : b))
  assert.ok(
    tightest.luma >= 10,
    `${tightest.id}.png's eye is only ${tightest.luma.toFixed(1)} luma over EYE_MIN ${EYE_MIN}, which is a margin a retune can cross silently`,
  )
  // 3. THE CONTROL, and the one that makes the argument real.
  const streetFile = new URL(`./${capture.CAPTURE_DIR}/street.png`, import.meta.url)
  assert.equal(existsSync(streetFile), true, 'street.png is missing — run npm run capture')
  const streetBytes = readFileSync(streetFile)
  const street = creatureContrast(streetBytes)
  const peak = luma(streetBytes).max
  assert.ok(
    peak > EYE_MIN,
    `street.png peaks at ${peak}, which is under EYE_MIN ${EYE_MIN}, so the frame no longer proves that the ` +
      'finder rejects scenery on shape rather than on brightness — re-shoot it and re-derive the claim',
  )
  assert.equal(
    street.found,
    false,
    `street.png peaks at ${peak} — well over EYE_MIN ${EYE_MIN} — and still resolves an eye, so the shape tests are not doing the work`,
  )
  console.log(
    `\n  eye finder on the shipped gallery: ${readings.map((r) => `${r.id} ${r.mean.toFixed(0)} luma / ${r.spanX}x${r.spanY} px`).join(', ')} ` +
      `against EYE_MIN ${EYE_MIN} and EYE_MAX_SPAN ${EYE_MAX_SPAN} (tightest ${tightest.id} at +${tightest.luma.toFixed(0)} luma, ` +
      `${EYE_MAX_SPAN - Math.max(...readings.map((r) => Math.max(r.spanX, r.spanY)))} px of span); ` +
      `street.png peaks at ${peak} and resolves nothing`,
  )
})

test('a creature washed toward its background loses contrast, monotonically', () => {
  // WHY A MUTATION TEST, AND WHY IT BUILDS ITS OWN IMAGES
  // ------------------------------------------------------
  // Everything above reads a committed PNG, which means the gate is only ever
  // exercised against frames that happen to exist. A gate that would have passed
  // the old `creature-stalking.png` is precisely a gate that looks green on the
  // one artifact nobody re-examined — so the honest way to know this one works
  // is to hand it frames where the answer is known by construction.
  //
  // `repaintBody` fills the creature's trunk with a flat grey and leaves the eye
  // and the entire rest of the frame alone. That is the smallest edit that
  // isolates the quantity under test: the anchor still resolves in the same
  // place, so the only thing varying between rows is how the body compares to
  // the background around it.
  //
  // The expectation is stated as a DIRECTION, not as a pair of thresholds, and
  // that is the point. A gate that passes frame A and fails frame B can be
  // satisfied by a constant; a gate whose measurement moves the right way as the
  // subject is washed toward its background cannot.
  const chase = new URL(`./${capture.CAPTURE_DIR}/creature-chasing.png`, import.meta.url)
  assert.equal(existsSync(chase), true, 'creature-chasing.png is missing — run npm run capture')
  const bytes = readFileSync(chase)
  const committed = creatureContrast(bytes)
  assert.ok(committed.found, `creature-chasing.png should hold a creature: ${committed.reason}`)

  // The ladder, washed to progressively lighter greys. 0 is the near-black body
  // `creatureView.js` actually draws; 120 is a creature well on its way to being
  // lost.
  //
  // The top rung stops at 120 rather than going to white for a reason that is
  // about the ANCHOR, not the threshold: `EYE_MIN` is 150, so a body painted at
  // 200 joins the eye quad, the flood fill swallows it, and the frame reports no
  // creature at all. That is the measure behaving correctly — a body as bright
  // as the eye is not a silhouette, it is a smudge — but it makes such a row
  // evidence about the anchor rather than about contrast, so the ladder is
  // held below it and every rung answers the same question.
  const ladder = [120, 90, 60, 40, 20, 0]
  const readings = ladder.map((value) => creatureContrast(repaintBody(bytes, committed, value)))
  for (const [i, reading] of readings.entries()) {
    assert.ok(reading.found, `washing to ${ladder[i]} lost the eye anchor, so that row proved nothing`)
  }
  // Falling, every step. A single non-decreasing step would be a band in which a
  // washed-out creature still passes, which is precisely the failure the old
  // gate had across its whole range.
  for (let i = 1; i < readings.length; i += 1) {
    assert.ok(
      readings[i].ratio < readings[i - 1].ratio,
      `contrast did not fall monotonically as the creature was washed toward its background: ` +
        `${ladder.map((_, k) => readings[k].ratio.toFixed(2)).join(' > ')} — ` +
        'a pass could hide in the band where this goes the wrong way',
    )
  }
  // And the two ends agree with the gate the other tests apply, so the ladder is
  // anchored to the real thresholds rather than merely being tidy.
  assert.ok(
    readings[readings.length - 1].ratio < 0.62,
    `a creature at luma 0 must read as a hole in anything, and it does not: ` +
      `${describeCreatureContrast(readings[readings.length - 1])}`,
  )
  assert.ok(
    readings[0].ratio >= 0.62,
    `a creature washed to luma 200 must not pass the gate, and it does: ${describeCreatureContrast(readings[0])}`,
  )
})

test('the portal swirl reads as structure in the frame, not a flat cyan disc', () => {
  // Iteration 2, pass 3. The defect was never the portal's geometry — the rim,
  // the core disc and the doorway all read correctly. The defect was that the
  // swirl *texture* held everything inside the core at a floor of 0.25, so the
  // arms and the gaps between them sat close together and the disc averaged out
  // to a single field of cyan. The rim around it stayed correct, which is
  // exactly why the frame still looked composed in a thumbnail and nobody
  // caught it by looking at the picture.
  //
  // So this asserts the SPREAD of luma inside the swirl band, not a brightness
  // and not a brightness relative to the rim. A flat disc at full cyan is
  // brighter than a structured one and still washed out; a gate that measured
  // how much light the portal emits would call the broken render the good one.
  //
  // The threshold is 28 and the measured value is 36.5. The margin is
  // deliberately thin on the same grounds the creature gate's 0.62 is: this is a
  // small subject against a graded scene, and a loose threshold here would be the
  // same decorative gate again with a different formula. The number that fails it
  // is reported below, because it is the reason the threshold is where it is: the
  // flat core this pass replaced measured sd 1.9, p10 26 and a pupil of 28, so it
  // failed this threshold and the pupil ceiling together, and anyone can re-measure
  // it with `git show fc1ab19:benchmark/screenshots/portal-located.png`.
  const file = new URL(`./${capture.CAPTURE_DIR}/portal-located.png`, import.meta.url)
  assert.equal(existsSync(file), true, 'portal-located.png is missing — run npm run capture')
  const measured = swirlContrast(readFileSync(file))
  // A frame with no portal in it cannot be a frame where the swirl reads. Its
  // own assertion, because without it the sd below is a number about a
  // rectangle of nothing.
  assert.ok(measured.found, `no portal in portal-located.png: ${measured.reason}`)
  assert.ok(
    measured.band.sd >= 28,
    `the swirl inside the portal is washed out: ${describeSwirlContrast(measured)} (needs sd 28 or more)`,
  )
  // And the structure has to be structure with a dark end, not noise scattered
  // through a bright field. A band whose 10th percentile is itself bright has no
  // gaps in it no matter how high its sd goes, so the floor is checked
  // separately rather than left to the spread.
  assert.ok(
    measured.band.p10 <= 32,
    `the swirl has no dark gaps left in it: ${describeSwirlContrast(measured)} (needs p10 at or under 32)`,
  )
  // The pupil is the other half of the claim. The portal is a hole, and a hole
  // is the darkest thing in the frame; the swirl tuning must not have
  // brightened the middle to pay for the arms.
  assert.ok(
    measured.pupil <= 20,
    `the portal's pupil is not a hole any more: luma ${measured.pupil} — ` +
      'the core is supposed to be near-black so the arms have something to read against',
  )
})

test('the swirl gate cannot be satisfied by a frame with no portal in it', () => {
  // The control for the test above, and the one the gate needs to be worth
  // anything. `street.png` is shot from the lamp viewpoint and the portal is
  // nowhere near it, so it is a frame with a night street in it and no portal in
  // it. If `swirlContrast` reports a portal here, the anchor has stopped being an
  // anchor and every number in the section above is about something else.
  //
  // Asserted rather than assumed, because the failure is silent and
  // self-flattering: a measure that finds "a portal" in every frame passes this
  // section forever while measuring nothing at all.
  const street = new URL(`./${capture.CAPTURE_DIR}/street.png`, import.meta.url)
  assert.equal(existsSync(street), true, 'street.png is missing — run npm run capture')
  const measured = swirlContrast(readFileSync(street))
  assert.equal(
    measured.found,
    false,
    `street.png contains no portal, but the gate found one: ${describeSwirlContrast(measured)}`,
  )
})

test('a portal washed toward a flat disc loses swirl structure, monotonically', () => {
  // The same reasoning as the creature mutation above, applied to the swirl,
  // and for the same reason: everything above reads a committed PNG, so the
  // gate is only ever exercised against a frame that happens to exist. A gate
  // that would have passed the washed-out render is precisely a gate that looks
  // green on the one artifact nobody re-examined.
  //
  // `repaintSwirl` washes the band toward a flat grey and leaves the rim and
  // the entire rest of the frame alone. The rim is the anchor, so it has to
  // survive untouched for every row to answer the same question — the only
  // thing varying between rows is how much structure the swirl holds.
  //
  // The expectation is a DIRECTION, not a pair of thresholds. A gate that
  // passes frame A and fails frame B can be satisfied by a constant; one whose
  // measurement moves the right way as the subject is washed cannot.
  const file = new URL(`./${capture.CAPTURE_DIR}/portal-located.png`, import.meta.url)
  assert.equal(existsSync(file), true, 'portal-located.png is missing — run npm run capture')
  const bytes = readFileSync(file)
  const committed = swirlContrast(bytes)
  assert.ok(committed.found, `portal-located.png should hold a portal: ${committed.reason}`)

  // The ladder is two fixed points and the wash between them, and the first rung
  // is 0.1 rather than 0.25 for a measured reason rather than a round one: the
  // band spread falls almost exactly linearly with the mix (36.5 at none, 32.8
  // at 0.1, 27.4 at 0.25), so 0.1 is the last rung that still clears the 28 the
  // gate applies and 0.25 is the first that does not. That crossing is the
  // sensitivity claim, and it is worth stating precisely instead of picking a
  // number that happened to pass: this gate tolerates a portal losing a tenth
  // of its swirl and rejects one that has lost a quarter.
  const ladder = [0.1, 0.25, 0.5, 0.75, 0.9, 1]
  const readings = ladder.map((mix) => swirlContrast(repaintSwirl(bytes, committed, 60, mix)))
  // The anchor must hold through the whole ladder, or the later rows are
  // evidence about a vanished portal rather than about swirl contrast.
  for (const [i, reading] of readings.entries()) {
    assert.ok(reading.found, `washing to mix ${ladder[i]} lost the rim anchor, so that row proved nothing`)
  }
  // Falling, every step. A single non-decreasing step is a band in which a
  // washed-out portal still passes, which is the entire class of failure this
  // gate was written to close.
  for (let i = 1; i < readings.length; i += 1) {
    assert.ok(
      readings[i].band.sd < readings[i - 1].band.sd,
      `swirl structure did not fall monotonically as the portal was washed toward a flat disc: ` +
        `${readings.map((r) => r.band.sd.toFixed(1)).join(' > ')} — ` +
        'a pass could hide in the band where this goes the wrong way',
    )
  }
  // And the ends agree with the gate the first test applies, so the ladder is
  // anchored to the real threshold rather than merely being tidy.
  assert.ok(
    readings[readings.length - 1].band.sd < 28,
    `a perfectly flat disc must not pass the swirl gate, and it does: ` +
      `${describeSwirlContrast(readings[readings.length - 1])}`,
  )
  // A tenth of the swirl washed away is still a legible swirl. This is the
  // assertion that keeps the threshold from being decorative in the other
  // direction: a gate set so high that only a pristine frame clears it would
  // fail the real gallery on a re-render and get loosened, and the way to stop
  // that is to say out loud how much the portal is allowed to change.
  assert.ok(
    readings[0].band.sd >= 28,
    `a tenth of the swirl washed away is still legible and must pass, and it does not: ` +
      `${describeSwirlContrast(readings[0])}`,
  )
  // ...and the very next rung down does not, which is the sensitivity this gate
  // actually buys. Asserted rather than assumed, because a gate with no
  // documented crossover point is a gate nobody can tell how close it is to
  // passing a frame nobody has looked at.
  assert.ok(
    readings[1].band.sd < 28,
    `a quarter of the swirl washed away must NOT pass, and it does: ` +
      `${describeSwirlContrast(readings[1])} — the crossover is supposed to sit between mix 0.1 and 0.25`,
  )
})

test('the pools are wide enough to read as pools, and still a grid (§4)', () => {
  // Iteration 2, pass 2: `LAMP_POOL_DIAMETER` 12 -> 18, plus a new
  // `LAMP_POOL_RIM`. Both are read out of the source for the reason the pass-1
  // section gives: `streetView.js` imports Three.js, so the gate cannot import
  // its constants, and reading a number back at itself is worthless. What is
  // asserted is the two *properties* the brief asked for — broader pools, and a
  // grid you can still steer by — before the value pin at the end.
  const code = stripProse(STREET_VIEW_SOURCE)
  const diameter = /const LAMP_POOL_DIAMETER = ([\d.]+)/.exec(code)
  assert.ok(diameter, 'the pool diameter is not a named constant any more')
  const pool = Number(diameter[1])
  // "Broader warm pools." The carriageway is `2 * STREET_HALF_WIDTH` = 12 m, so
  // a 12 m pool exactly inscribes the road and stops dead at the kerb. The
  // complaint was small hot circles, and a pool that does not reach the kerb is
  // the definition of one.
  assert.ok(pool > 12, `the pool is ${pool} m, which still stops at the kerb (the road is 12 m wide)`)
  // ...and the grid survives. Lamps are one per intersection, intersections are
  // 64 m apart, so neighbouring rims are `64 - pool` apart. §4's second
  // navigation mechanism is a *grid*, and a grid is spacing: at 32 m the discs
  // would touch and the road would be a continuous orange sheet.
  assert.ok(
    64 - pool > 20,
    `pools are ${pool} m across on a 64 m spacing — the discs nearly touch and §4's grid is gone`,
  )
  // the rim: a floor under the falloff, so a 1.5x-wider pool does not read as a
  // smudge. Asserted as a range rather than a value because its whole job is to
  // be *less than* a lift and *more than* nothing.
  const rim = /const LAMP_POOL_RIM = ([\d.]+)/.exec(code)
  assert.ok(rim, 'the pool has no rim constant — a wider pool from the same falloff is a smudge')
  assert.ok(Number(rim[1]) > 0.5 && Number(rim[1]) < 1, `the rim is ${rim[1]}, which is not a plateau`)
  // and the rim has to actually reach the sodium pool, while the portal's is
  // left alone: `makePoolTexture`'s default is 0 precisely so the cyan apron is
  // unchanged, because a doorway has hard edges and a rimmed disc around one
  // reads as a glowing puddle.
  assert.match(code, /map: makePoolTexture\(\{ rim: LAMP_POOL_RIM \}\)/, 'the sodium pool is not using its rim')
  assert.match(code, /portalPool: this\._glow\(PALETTE\.portal, \{\s*map: makePoolTexture\(\)/, 'the portal pool grew a rim it should not have')
  // the value pin, deliberately separate, for the reason pass 1's hex pins are:
  // a *deliberate* retune is expected to fail this, and the remedy is to move
  // the pin in the commit that moves the number.
  assert.equal(pool, 18, `LAMP_POOL_DIAMETER is ${pool} — move this pin in the same commit as the pool`)
  assert.equal(Number(rim[1]), 0.82, `LAMP_POOL_RIM is ${rim[1]} — move this pin in the same commit as the pool`)
})

test('the bounce is a fill and not a second key (§12.1)', () => {
  // The four `LAMP_BOUNCE_*` constants and the one property that makes them a
  // bounce. A bounce light that competes with its source is a second key, and
  // at that point the pool's shape is being drawn by the fill — which spends
  // §4's "steer by the sodium grid" affordance on the thing this pass exists to
  // improve.
  const code = stripProse(WORLD_SOURCE)
  const read = (name) => {
    const found = new RegExp(`const ${name} = ([\\d.]+)`).exec(code)
    assert.ok(found, `${name} is not a named constant any more`)
    return Number(found[1])
  }
  const key = read('LAMP_LIGHT_INTENSITY')
  const bounce = read('LAMP_BOUNCE_INTENSITY')
  assert.ok(bounce > 0, 'there is no bounce at all, so the walls are still black')
  assert.ok(
    bounce < key * 0.2,
    `the bounce is ${((bounce / key) * 100).toFixed(1)}% of the key (${bounce} vs ${key}) — that is a second key`,
  )
  // the count is bounded by the key count for the same reason: more bounces
  // than keys means some of them are lighting a lamp nothing else is lighting.
  assert.ok(read('LAMP_BOUNCE_LIGHTS') <= read('LAMP_LIGHTS'), 'there are more bounces than keys')
  // low and wide. A bounce comes *off* a horizontal road, so it travels roughly
  // horizontally: at road level it would light the underside of nothing and the
  // tops of everything. The height is also below the lamp head (5.1 m) on
  // purpose — two lights at one position are one light.
  const height = read('LAMP_BOUNCE_HEIGHT')
  assert.ok(height > 1 && height < 5.1, `the bounce sits at ${height} m, neither a wall wash nor a second head`)
  const reach = read('LAMP_BOUNCE_DISTANCE')
  const pool = Number(/const LAMP_POOL_DIAMETER = ([\d.]+)/.exec(stripProse(STREET_VIEW_SOURCE))[1])
  assert.ok(reach > pool, `the bounce throws ${reach} m, inside the ${pool} m pool it stands in`)
  // and the four constants are *used*, which is the check a reviewer probes for
  // when a paragraph of rationale has no reader. A constant that describes a
  // feature nobody wired up is a comment that believes it is a feature.
  assert.match(code, /new THREE\.PointLight\(PALETTE\.bounce, 0, LAMP_BOUNCE_DISTANCE, 2\)/, 'the bounce lights are never built')
  assert.match(code, /bounce\.position\.set\(lamp\.x, LAMP_BOUNCE_HEIGHT, lamp\.z\)/, 'the bounce is never aimed at a lamp')
  assert.match(code, /bounce\.intensity = LAMP_BOUNCE_INTENSITY/, 'the bounce is never lit')
  // aimed off the same nearest-lamp list as the key, which is the only way it
  // can be a bounce rather than an independent opinion about where the road is.
  const aimed = worldMethod('_updateLampPool')
  assert.equal((aimed.match(/lamps\[i\]/g) ?? []).length, 2, 'the key and the bounce are not aimed off the same list')
})

test('a lamp reaches the next lamp, and the search finds it (§4)', () => {
  // `LAMP_RADIUS` (the search) and `LAMP_LIGHT_DISTANCE` (the throw) are two
  // different numbers and the old relationship between them was a bug: a 60 m
  // throw fed by a 40 m search meant the outer 20 m of every lamp's reach was
  // lit only if the player happened to be standing next to that lamp, so pools
  // faded out mid-frame for no reason a viewer could name. Pass 2: search 96,
  // throw 92.
  const code = stripProse(WORLD_SOURCE)
  const read = (name) => {
    const found = new RegExp(`const ${name} = ([\\d.]+)`).exec(code)
    assert.ok(found, `${name} is not a named constant any more`)
    return Number(found[1])
  }
  const search = read('LAMP_RADIUS')
  const reach = read('LAMP_LIGHT_DISTANCE')
  // the search must cover the throw, or the far half of the throw is
  // unreachable. This is the relationship that was inverted, and it is the
  // reason the two numbers exist separately.
  assert.ok(
    search >= reach,
    `the search (${search} m) is shorter than the throw (${reach} m): the far half of every pool is unreachable`,
  )
  // and the throw has to cover the gap between lamps, or the midpoint of every
  // avenue is the darkest point on the road twice per 64 m — a stripe of unlit
  // tarmac down the centre, which is what "a row of isolated coins" looks like.
  assert.ok(reach > 64, `a lamp throws ${reach} m, so pools do not meet across a 64 m spacing`)
  // the beam outlasts the fog it has to be seen through (§10.3). Pass 2 thinned
  // the fog and lengthened the beam to match; the exit-car test asserts the same
  // relationship, and it is restated here so the two numbers are read together.
  const beam = /new THREE\.PointLight\(PALETTE\.headlight, 0, ([\d.]+), 2\)/.exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(beam, 'the headlight beam is gone')
  const tightest = rules.fogVisibility(rules.fogDensityForDusk(1))
  assert.ok(
    Number(beam[1]) > tightest,
    `the beam reaches ${beam[1]} m and the fog is half opaque at ${tightest.toFixed(1)} m`,
  )
})

test('fog is a depth cue, not a wall (§4, §3.7)', () => {
  // The checklist item in one test: "Fog should be a depth cue, not a wall:
  // lower density close to lamps." Pass 2 thinned every stop — dusk 1 went from
  // half opacity 32.0 m to 47.6 m — and these are the properties thinning has to
  // satisfy without spending the dusk clock it was thinned for.
  const stages = [0, 1 / 3, 2 / 3, 1].map((dusk) => rules.fogVisibility(rules.fogDensityForDusk(dusk)))
  // still a clock: §3.7's dusk is legible as a closing world, and it still
  // closes by more than half across the run.
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i] < stages[i - 1], `fog did not close at stage ${i}: ${stages.map((s) => s.toFixed(1))}`)
  }
  assert.ok(stages[0] / stages[3] > 2, `the finale must close the world by half, got ${(stages[0] / stages[3]).toFixed(2)}x`)
  // and not a wall: the tightest fog in the game has to leave a road in it.
  // 47.6 m is the measured value; the floor is 40 because the honest question
  // is not "is 47.6 the right number" but "can the player still see the thing
  // hunting them", and §11.3's detection range is 20 m.
  assert.ok(stages[3] > 40, `the tightest fog is half opaque at ${stages[3].toFixed(1)} m — a wall, not a depth cue`)
  // the before/after of this pass, which is what a reviewer will look for.
  assert.ok(rules.fogDensityForDusk(1) < 0.026, `dusk 1 density is ${rules.fogDensityForDusk(1)} — pass 2 was meant to thin the fog`)
  assert.ok(rules.fogDensityForDusk(0) < 0.01, 'Act I fog was not thinned')
})


// ---------------------------------------------------------------------------
// iteration 2, pass 3 — the portal as a hole rather than a halo
//
// WHY THIS SECTION IS SOURCE-CONTRACT AND NOT A RENDER
// ----------------------------------------------------
// The same seam as pass 1: `streetView.js` imports Three.js, so `verify.mjs`
// cannot construct a portal and can only read the file. The pass-2 answer to
// that — read the numbers out of the source, assert the *properties* they were
// chosen for, and pin the values separately — is the answer used again here, and
// `verify-world.mjs` is where the same claims are made against the real scene
// graph instead, which is the only place the geometry of a hole can be asked
// about rather than described.
//
// WHAT PASS 3 CLAIMS
// ------------------
//   1. the opening is a disc with a thin lit lip on its edge, and the disc is
//      *behind* the lip — a hole, not a halo (§12.2 unchanged: still the only
//      cold light in the game)
//   2. the disc is dark enough to be a hole, wide enough to be cropped by the
//      doorway that frames it, and seated in that doorway rather than floating
//      in it
//   3. the swirl turns on the world's own clock, slowly, against itself, and
//      only while the portal is live
//   4. §5.3's shutdown puts the disc out as well as the lip: cold, dim, inert
//
// Every claim above is a *property*, so a future pass that rebuilds the portal
// again passes as long as it is still a hole in a doorway with something turning
// slowly inside it. Only a regression fails, which is the job.
// ---------------------------------------------------------------------------

section('The portal gate (iteration 2, pass 3)')

/** A named number, read out of the source. Pass 2's `read`, with a name. */
function portalNumber(name) {
  const found = new RegExp(`const ${name} = ([\\d.]+)`).exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, `${name} is not a named constant any more`)
  return Number(found[1])
}

/** A frozen table of numbers, read out of the source, in its own order. */
function portalTable(name) {
  const found = new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]+)\\]\\)`).exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, `${name} is not a frozen table any more`)
  const values = [...found[1].matchAll(/-?[\d.]+/g)].map((entry) => Number(entry[0]))
  assert.ok(values.length > 0, `${name} is empty, so there is nothing for the geometry to be made of`)
  return values
}

/** A `PALETTE` hex, read out of the source. Pass 1's stops in scalar form. */
function paletteHex(key) {
  // `\b` and the whole key matter: `portal:` must not match `portalCore:`, and
  // neither may match the other. The pass-3 palette has all three, they are one
  // character apart, and a looser pattern silently compares a hole's colour
  // against its lip's — which makes every luma assertion below a tautology.
  const found = new RegExp(`\\b${key}: 0x([0-9a-fA-F]{6})`).exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, `PALETTE.${key} is not a six-digit hex any more`)
  return Number.parseInt(found[1], 16)
}

test('the opening is a disc with a lit lip, and the disc is behind it', () => {
  const code = stripProse(STREET_VIEW_SOURCE)
  // the geometry that is built, at the granularity it is built at
  assert.match(code, /new THREE\.CircleGeometry\(PORTAL_CORE_RADIUS, \d+\)/, 'there is no disc in the opening')
  assert.match(
    code,
    /new THREE\.TorusGeometry\(PORTAL_CORE_RADIUS, PORTAL_RIM_TUBE, \d+, \d+\)/,
    "the lip is not a torus on the disc's own radius — the cyan has floated off the hole it lights",
  )
  assert.match(code, /disc\.position\.z = -PORTAL_CORE_INSET/, 'the disc is not set back behind its own lip')
  assert.match(code, /gate\.scale\.setScalar\(PORTAL_GATE_SCALE\[index\]\)/, 'the gate is not sized per structure')
  // The disc is on the gate and not merely in the record. This pair of lines is
  // here because of the one mutation of the ten that §16.1's testing of this pass
  // did not kill: deleting `gate.add(disc)` left a disc that is built, named,
  // stored on the portal, measured by every geometry check and never drawn —
  // because a mesh that is not in the scene graph is still a perfectly good
  // object, and nothing in the pure gate can tell the difference.
  assert.match(code, /gate\.add\(disc\)/, 'the disc is never added to the gate, so there is no hole in the opening')
  // The wiring. This is the mutation that matters: `root.add(ring)` is the line
  // that put a floating hoop in the middle of a shell rather than a hole in its
  // doorway, so its absence is asserted rather than assumed, and everything in
  // the opening is now a child of the gate.
  assert.doesNotMatch(code, /root\.add\(ring\)/, 'a bare ring is still being hung on the shell root')
  assert.match(code, /root\.add\(gate\)/, 'and the gate is not on the shell root either')
  // the parts are named, which is what lets `verify-world.mjs` and any future
  // capture find them by name rather than by traversal order
  for (const [owner, name] of [
    ['disc', 'portal-core-${id}'],
    ['rim', 'portal-rim-${id}'],
    ['mesh', 'portal-swirl-${id}-${layer}'],
  ]) {
    assert.ok(
      STREET_VIEW_SOURCE.includes(`${owner}.name = \`${name}\``),
      `the ${name} is unnamed, so nothing downstream can address it`,
    )
  }
  // ...and exposed on the record, so the disc and the swirl are reachable from a
  // check, a capture or a future §5.3 without walking the scene graph
  assert.match(
    code,
    /gate,\s*disc,\s*rim,\s*swirl,\s*gateScale: PORTAL_GATE_SCALE\[index\]/,
    'the portal record does not expose the four parts of the gate',
  )
  // the materials, and why they are three and not one: §5.3 shuts one portal at
  // a time and permanently, so "the disc" is not a state a shared material holds
  assert.match(code, /portalCore: this\._glow\(PALETTE\.portalCore\)/, 'there is no live core material')
  assert.match(code, /portalCoreDead: this\._glow\(PALETTE\.portalCoreDead\)/, 'and no dead one, so §5.3 has nothing to put out')
  assert.match(
    code,
    /swirl: this\._glow\(PALETTE\.portal, \{[^}]*blending: THREE\.AdditiveBlending/s,
    'the swirl is not additive, so two layers would paint over one another',
  )
  assert.match(code, /makeSwirlTexture\(/, 'the swirl has no procedural texture, so there is no swirl')
})

test('the hole is dark, cropped, and seated in the doorway that frames it', () => {
  const core = portalNumber('PORTAL_CORE_RADIUS')
  const tube = portalNumber('PORTAL_RIM_TUBE')
  const y = portalNumber('PORTAL_CORE_Y')
  const inset = portalNumber('PORTAL_CORE_INSET')
  // the lip is a lip: BEFORE the tube was 0.08 on a 0.78 radius, 10.3%, and a
  // band that thick is a ring whatever is behind it
  assert.ok(
    tube / core < 0.06,
    `the lip is ${((tube / core) * 100).toFixed(1)}% of the disc's radius — a hoop, not a lip`,
  )
  // the hole is a hole, measured in the same luma pass 1's palette is measured
  // in and on the same scale, so "darker than the lip" is a number and not an
  // adjective. §12.2 is untouched: this is not a second lamp, it is the dark
  // inside the one cold light the game has.
  const lip = paletteHex('portal')
  const hole = paletteHex('portalCore')
  assert.ok(
    relLuma(hole) < relLuma(lip) * 0.12,
    `the hole is ${((relLuma(hole) / relLuma(lip)) * 100).toFixed(1)}% of the lip's luma — a dark lamp`,
  )
  // the hole is cropped: the shed's two flank panels leave 1.3 m of opening, and
  // a disc with a margin inside it is a porthole hung in a wall
  assert.ok(core > 0.65, `the disc is ${(core * 2).toFixed(2)} m across, which its 1.3 m doorway frames whole`)
  // and seated *in* the doorway rather than floating in the shed. The opening is
  // 1.3 m wide and 1.9 m tall about y = 0.95, so the disc has to *fill* the
  // height it is given — reaching the lintel at 1.9 m — while the doorway crops
  // it at the sides. A disc that stops short leaves a band of lit shed above the
  // hole, and that band is the one thing that would make it a decal again.
  assert.ok(
    Math.abs(y + core - 1.9) < 0.05,
    `the disc reaches ${(y + core).toFixed(2)} m against a 1.9 m opening, so it does not fill the frame`,
  )
  assert.ok(y - core > 0.2, `the disc's bottom is at ${(y - core).toFixed(2)} m, so it is a hole in the air`)
  // and set back from the lip by something a camera at 4.5 m could see, which is
  // the whole difference between a hole and a decal
  assert.ok(inset > 0.01 && inset < 0.1, `the disc is set back ${inset} m, which is either nothing or a shadow`)
  // the per-structure tables, in `PORTAL_STRUCTURES` order and both three long
  const offsets = portalTable('PORTAL_GATE_OFFSET')
  const scales = portalTable('PORTAL_GATE_SCALE')
  assert.equal(offsets.length, 3, `${offsets.length} gate offsets for three shells`)
  assert.equal(scales.length, 3, `${scales.length} gate scales for three shells`)
  // the shed's gate is in its doorway, 1.25 m of flank out, and not at the
  // middle of the shell, which is where BEFORE pass 3 left it
  assert.ok(
    offsets[0] > 1.0,
    `the shed's gate is ${offsets[0]} m out, so it is floating in the shed rather than standing in its doorway`,
  )
  // the phone box's is proud of a 1.1 m cube, i.e. past its 0.55 m half-depth.
  // This is the assertion that would have caught the ring being sealed inside
  // solid metal for the whole of the benchmark.
  assert.ok(
    offsets[2] > 0.55,
    `the phone box's gate is ${offsets[2]} m out, which is inside its own 1.1 m cube — the third portal is sealed in a metal box`,
  )
  // and scaled to fit the face it is stuck to: 0.68 * 1.44 = 0.98 m of hole
  assert.ok(
    scales[2] * core * 2 < 1.1,
    `the phone box's hole is ${(scales[2] * core * 2).toFixed(2)} m across a 1.1 m face, so the booth is a disc with a booth behind it`,
  )
})

test('the swirl turns on the world clock, slowly, against itself', () => {
  const code = stripProse(STREET_VIEW_SOURCE)
  const rates = portalTable('PORTAL_SWIRL_RATES')
  const radii = portalTable('PORTAL_SWIRL_RADII')
  const depths = portalTable('PORTAL_SWIRL_DEPTHS')
  const core = portalNumber('PORTAL_CORE_RADIUS')
  const inset = portalNumber('PORTAL_CORE_INSET')
  assert.equal(radii.length, 2, `${radii.length} radii: one layer is a painted disc, not a swirl`)
  assert.equal(rates.length, radii.length, 'a layer with no rate is a decal')
  assert.equal(depths.length, radii.length, 'a layer with no depth is behind the hole or in front of the lip')
  // driven by the view's own clock and not by a frame count: `update(dt)` is
  // handed a delta and keeps a `t`, so a rotation written as an INTEGRAL of a rate
  // is frame-rate independent and one written as a per-frame increment is not.
  //
  // **THE FORM CHANGED TWICE IN PASS 12 and the gate changed with it both times,
  // which is the only correct response and worth saying why.**
  //
  // Pass 3 wrote `rotation.z = t * PORTAL_SWIRL_RATES[layer]` and forbade `+=`. Pass
  // 12 made the rate a function of how near the player is, and the product form is
  // then a DISCONTINUITY: `t * rate` jumps by `t * d(rate)` whenever the rate
  // changes, so crossing the 8 m boundary at 143 s teleports the arms eighteen
  // radians. The world check found it in one run. The integral form is the same
  // animation when the rate is constant — which is all pass 3's comment was ever
  // arguing — and continuous when it is not.
  //
  // SO WHAT IS FORBIDDEN NOW, and the answer is narrower and more specific than
  // what was here before. Forbidden is an increment that does not carry `dt`:
  // `+= rate` or `+= 0.21` is a frame COUNT, which is frame-rate dependence in the
  // sense pass 3 meant. Permitted is `+= rate * dt`, a rectangle rule on an
  // integral that converges to the right answer at any step size. The old gate
  // could not tell those two apart, and the reason it could not is that the
  // difference only matters once something else makes the rate vary.
  assert.match(
    code,
    /const rate = rules\.portalSwirlRate\(PORTAL_SWIRL_RATES\[layer\], near\)/,
    'the swirl is not taking its rate from the pure module, so the near field cannot be applied to it',
  )
  assert.match(
    code,
    /portal\.swirl\[layer\]\.rotation\.z \+= rate \* dt/,
    'the swirl is not integrating a rate against dt, so it is a frame count rather than an animation',
  )
  assert.doesNotMatch(
    code,
    /portal\.swirl\[[^\]]*\]\.rotation\.z \+= (?!rate \* dt)/,
    'the swirl is incremented by something that is not `rate * dt` — a frame count, and a different animation on every machine',
  )
  assert.doesNotMatch(
    code,
    /portal\.swirl\[[^\]]*\]\.rotation\.z = t \* /,
    "the swirl is a product of the view clock and a rate that now VARIES with the player, which is a discontinuity of `t * d(rate)` every time the player moves",
  )
  // and the loop that turns it is *inside* the `if (portal.shut) continue`, so a
  // dead portal is inert rather than merely dark. The tick is located first
  // because `nearestPortal` opens a loop over the same array with the same
  // header, and a search that found that one first would be measuring §5.2.
  //
  // PASS 12 ADDED A SECOND PORTAL LOOP TO THE TICK — the collapse, which runs
  // for the portals that ARE shut. So "the first loop" is no longer the live one,
  // and the gate now finds the loop that actually turns the swirl and requires
  // THAT one to be the guarded one. Searching for the first loop would have
  // silently started measuring the collapse, which is the failure mode pass 11's
  // review recorded as "a claim scoped to one function silently testing the
  // empty string, which fails every predicate and so looks like a broken source".
  const tick = /update\(dt\) \{([\s\S]*?)\n  \}\n/.exec(code)
  assert.ok(tick, 'the view update tick is gone')
  const loops = [...tick[1].matchAll(/for \(const portal of this\.portals\) \{([\s\S]*?)\n    \}\n/g)].map((entry) => entry[1])
  const spinning = loops.filter((body) => body.includes('rotation.z += rate * dt'))
  assert.equal(spinning.length, 1, `${spinning.length} portal loops in the update turn the swirl; the live one has to be identifiable`)
  const body = spinning[0]
  assert.match(body, /if \(portal\.shut\) continue/, 'the loop that turns the swirl no longer skips a shut portal')
  assert.ok(
    body.indexOf('if (portal.shut) continue') < body.indexOf('rotation.z += rate * dt'),
    'the swirl turns in a portal that has been shut',
  )
  // inside the hole, or it draws an edge the hole does not have
  for (const radius of radii) {
    assert.ok(radius < core, `a swirl layer of ${radius} m is wider than the ${core} m hole it turns in`)
  }
  // in front of the disc and behind the lip, which is the only band in which a
  // transparent layer can add to the hole without floating in front of the world
  for (const depth of depths) {
    assert.ok(depth > -inset, `a swirl layer at ${depth} m is behind its own disc`)
    assert.ok(depth < 0, `a swirl layer at ${depth} m is proud of the lip`)
  }
  assert.notEqual(depths[0], depths[1], 'the two layers are coincident, so one of them is a decal')
  // slow: a revolution has to outlast §5.3's hold, or the opening is a machine
  for (const rate of rates) {
    assert.notEqual(rate, 0, 'a rate of zero is a static texture')
    assert.ok(
      Math.abs(rate) < 0.35,
      `a layer comes round once every ${(2 / Math.abs(rate)).toFixed(1)} s — that is machinery, not a hole`,
    )
  }
  // and against itself, which is the property that makes two layers worth
  // having at all: the same way round, they read as one disc with a pattern on it
  assert.notEqual(
    Math.sign(rates[0]),
    Math.sign(rates[1]),
    'both layers turn the same way, so the pair is one painted disc',
  )
})

test('a shut portal is a cold, dim, inert disc (§5.3)', () => {
  const code = stripProse(STREET_VIEW_SOURCE)
  const shut = /setPortalShut\(id, shut = true\) \{([\s\S]*?)\n  \}/.exec(code)
  assert.ok(shut, 'setPortalShut is gone')
  const body = shut[1]
  // the lip and the hole both go out, and the swirl stops
  assert.match(
    body,
    /portal\.rim\.material = shut \? this\._materials\.portalDead : this\._materials\.portal/,
    "a shut portal is still wearing the live material on its lip",
  )
  assert.match(
    body,
    /portal\.disc\.material = shut \? this\._materials\.portalCoreDead : this\._materials\.portalCore/,
    'a shut portal is still wearing the live material in its hole',
  )
  assert.match(body, /for \(const layer of portal\.swirl\) layer\.visible = !shut/, 'and its swirl never stops')
  // cold and dim as two measured properties of two hexes rather than as an
  // adjective: a dead lip is under a quarter of the live one, and it is the one
  // *blue* thing left in a world that is otherwise entirely sodium
  const liveLip = paletteHex('portal')
  const deadLip = paletteHex('portalDead')
  assert.ok(
    relLuma(deadLip) < relLuma(liveLip) * 0.25,
    `a shut lip is ${((relLuma(deadLip) / relLuma(liveLip)) * 100).toFixed(1)}% of the live one — the portal is still lit`,
  )
  assert.ok((deadLip >> 16) < (deadLip >> 8), `a shut lip is 0x${deadLip.toString(16)}, which is not cold`)
  // and the dead hole is *colder* than the live one, not merely darker: a light
  // going out leaves a blue hole, and that is the only hue change §5.3 is given
  const liveHole = paletteHex('portalCore')
  const deadHole = paletteHex('portalCoreDead')
  assert.ok(relLuma(deadHole) < relLuma(liveHole), 'the dead hole is brighter than the live one')
  assert.ok(
    (deadHole & 0xff) >= ((deadHole >> 8) & 0xff),
    `the dead hole is 0x${deadHole.toString(16)}, which warmed up instead of going cold`,
  )
})

test('the gate is the size this pass chose (iteration 2, pass 3)', () => {
  // Deliberately separate from the four property tests above, and for pass 1's
  // reason: swapping 0x3ad6d6 for a hotter cyan, or 0.72 for a wider disc, leaves
  // every property green while visibly changing the game. A *deliberate* retune
  // is expected to fail this one, and the remedy is to move the pin in the same
  // commit that moves the number — which is the moment a reviewer is told the
  // portal changed, rather than the moment they notice on a screenshot.
  assert.equal(portalNumber('PORTAL_CORE_RADIUS'), 0.72, 'PORTAL_CORE_RADIUS — move this pin in the commit that moves the disc')
  assert.equal(portalNumber('PORTAL_RIM_TUBE'), 0.028, 'PORTAL_RIM_TUBE — move this pin in the commit that moves the lip')
  assert.equal(portalNumber('PORTAL_CORE_Y'), 1.18, 'PORTAL_CORE_Y — move this pin in the commit that moves the hole')
  assert.equal(portalNumber('PORTAL_CORE_INSET'), 0.03, 'PORTAL_CORE_INSET — move this pin in the commit that sets the hole back')
  assert.deepEqual(portalTable('PORTAL_SWIRL_RADII'), [0.66, 0.4], 'PORTAL_SWIRL_RADII — move this pin with the swirl')
  assert.deepEqual(portalTable('PORTAL_SWIRL_DEPTHS'), [-0.008, -0.016], 'PORTAL_SWIRL_DEPTHS — move this pin with the swirl')
  assert.deepEqual(portalTable('PORTAL_SWIRL_RATES'), [0.21, -0.13], 'PORTAL_SWIRL_RATES — move this pin with the swirl')
  assert.deepEqual(portalTable('PORTAL_GATE_OFFSET'), [1.25, 0, 0.62], 'PORTAL_GATE_OFFSET — move this pin with the shells')
  assert.deepEqual(portalTable('PORTAL_GATE_SCALE'), [1, 1, 0.68], 'PORTAL_GATE_SCALE — move this pin with the shells')
  assert.equal(paletteHex('portalCore'), 0x04100f, 'PALETTE.portalCore — move this pin in the commit that moves the hole')
  assert.equal(paletteHex('portalCoreDead'), 0x050b0d, 'PALETTE.portalCoreDead — move this pin with it')
  // and the seed, because the swirl is the one texture in the game a player sees
  // rotating: a retune of its noise has to be a decision and not a side effect
  assert.match(
    stripProse(STREET_VIEW_SOURCE),
    /swirl: 0x[0-9a-fA-F]+/,
    'SURFACE_SEEDS.swirl is gone, so the swirl has no seed of its own',
  )
})

// ---------------------------------------------------------------------------
// BUILDING DEPTH — ITERATION 2, PASS 5
//
// WHAT THIS SECTION IS FOR
// -----------------------
// The pass has one headline defect (a pool's single material slot being
// reassigned per lot, so 588 houses took the colour of whichever was built last)
// and four art claims: T3's window stack in depth order, mechanism 1's roofline,
// T-notes item 4's entrance, and T11's emissive ladder.
//
// `verify-world.mjs` builds the real scene and measures the first of those and
// most of the others. This section covers what only a source reading can do, and
// it does it in a way the previous three passes did not: every property is a
// PREDICATE over the source, the real source is asserted to satisfy all of them,
// and then the source is MUTATED seven ways and each mutation is asserted to
// break a specific one. A gate that has only ever been run against the file it
// was written for is a gate of unknown strength, and pass 3's review already
// caught this file doing exactly that — the luma gate passed a picture of a wall.
// ---------------------------------------------------------------------------

section('Building depth (iteration 2, pass 5)')

// Rec. 709 luminance comes from pass 1's `relLuma` above, deliberately rather
// than as a second copy: two copies of a luma formula in one file is two numbers
// that can disagree, and pass 1 measured the whole sky ramp with that one.

/** A named number, read out of the stripped source. Pass 3's `portalNumber`. */
function buildingNumber(name) {
  const found = new RegExp(`const ${name} = ([\\d.]+)`).exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, `${name} is not a named constant any more`)
  return Number(found[1])
}

/**
 * A frozen table of numbers, read out of the stripped source, in its order.
 *
 * Two shapes are accepted because two things are frozen tables in this file: a
 * top-level `const X = Object.freeze([...])` and a `PALETTE` entry written
 * `key: Object.freeze([...])`. `\\b` on the key matters for the same reason
 * `paletteHex`'s does: `siding` must not match `outbuildingSiding` if a future
 * pass adds one.
 */
function buildingTable(name) {
  const code = stripProse(STREET_VIEW_SOURCE)
  const found = new RegExp(`(?:const ${name} = |\\b${name}: )Object\\.freeze\\(\\[([^\\]]+)\\]\\)`).exec(code)
  assert.ok(found, `${name} is not a frozen table any more`)
  // Hexes are matched WHOLE, not digit by digit. `0x3a3540` read as
  // `-?[\d.]+` yields `0`, `3` and `3540` — three numbers instead of one — which
  // is how the first version of this helper reported a four-entry palette as
  // having twelve. The alternation puts the hex branch first so `0x` is consumed
  // before the decimal branch can start at the same `0`.
  return [...found[1].matchAll(/-?0x[0-9a-fA-F]+|-?[\d.]+/g)].map((entry) => (
    entry[0].startsWith('0x') || entry[0].startsWith('-0x') ? Number(entry[0]) : Number(entry[0])
  ))
}

/** A frozen object literal's numeric fields, read out of the stripped source. */
function buildingFields(name) {
  const found = new RegExp(`const ${name} = Object\\.freeze\\(\\{([^\\}]+)\\}\\)`).exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, `${name} is not a frozen object any more`)
  const out = {}
  for (const [, key, value] of found[1].matchAll(/(\w+):\s*([\d.]+)/g)) out[key] = Number(value)
  assert.ok(Object.keys(out).length > 0, `${name} has no numeric fields`)
  return out
}

/**
 * The properties this pass claims, as predicates over a SOURCE STRING.
 *
 * Written as a list of named predicates rather than as assertions so that the
 * mutation test below can ask a question of a mutated file: "does this still hold?"
 * A gate expressed as bare `assert.ok` calls can only ever be run on the real
 * file. Each predicate returns `ok` and a `why`, so a mutation reports the claim
 * it broke rather than "something changed".
 *
 * @param {string} source `streetView.js`, comments NOT yet stripped
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function buildingClaims(source) {
  const code = stripProse(source)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  // 1. THE HEADLINE FIX. Not "the material is defined" — AESTHETIC-NOTES §4 is
  // explicit that such a check passes the old code. The claim is that nothing in
  // the file writes to a pool's material slot at all, because an `InstancedMesh`
  // has exactly one and a per-lot write to it is a per-lot write for all of them.
  claim(
    'no pool has its material reassigned',
    !/\.mesh\.material\s*=/.test(code),
    'something still writes pool.mesh.material, which is the pre-pass-5 defect',
  )
  // ...and the mechanism that replaces it is present in BOTH halves. A `setColorAt`
  // with no `needsUpdate` renders every instance at the first one's colour, which
  // is the same bug in a different attribute.
  claim('per-instance colour is written', /setColorAt\(/.test(code), 'nothing calls setColorAt')
  claim(
    'per-instance colour is uploaded',
    /instanceColor\.needsUpdate\s*=\s*true/.test(code),
    'commit() never flags instanceColor for upload, so every house takes the first colour',
  )
  claim(
    'place() takes a colour',
    /place\(x, y, z, w, h, d, yaw = 0, color = null\)/.test(code),
    'place() has no colour parameter, so the instance colour cannot be set per lot',
  )
  // 2. THE CONE IS GONE FROM THE ROOF. Mechanism 1's argument as a source fact: a
  // house's outline is made of horizontal edges, and a four-sided cone's is a
  // triangle. Scoped to the roof pool rather than to the file, because a cone is
  // still CORRECT somewhere in it — the `cone` traffic fixture, which is a traffic
  // cone and is supposed to be one. A file-wide ban would be a claim about the
  // wrong thing, and it is the kind of claim that gets "fixed" by deleting a
  // traffic cone.
  // `stripProse` blanks string literals to `""`, so the pool's name is not
  // matchable in a claim — only the shape of the call around it, which is the
  // thing being claimed. The mutation test below works on the RAW source, so its
  // `from`/`to` pairs can still name the pool.
  claim('the roof is not a cone', /pools\.roofs = this\._streetPool\(names, "", box\(\)/.test(code), 'the roof pool is not a box')
  claim(
    'the only remaining cone is the traffic cone',
    !/ConeGeometry/.test(code.replace(/ConeGeometry\(0\.3, 1, 8\)/g, '')),
    'a ConeGeometry is somewhere other than the cone fixture',
  )
  claim('ROOF_HEIGHT is gone', !/const ROOF_HEIGHT\b/.test(code), 'ROOF_HEIGHT came back')
  // 3. T3's STACK, as an ORDER rather than a presence. The pane's offset into the
  // wall is negative and the frame's is positive — which is the whole of "deepest
  // thing first, frame proud of it".
  // The pane's offset is an EXPRESSION (`-WINDOW.depth / 2`), not a literal, which
  // is what makes retuning `WINDOW` retune the whole stack. So the claim is on the
  // SIGN and the mutation flips the sign, rather than on a number that has to be
  // copied here.
  const paneAt = /isLit \? this\.pools\.windowLit : this\.pools\.windowGlass,\s*entry\.wall, u, y, ([^,\n]+)/.exec(code)
  claim('the window pane is set INTO the wall', Boolean(paneAt) && paneAt[1].trim().startsWith('-'), 'the pane is not placed at a negative offset, so the frame has nothing to be proud of')
  // The frame and the sill are placed at the window's own constants rather than at
  // literals, which is what makes retuning one number retune the stack.
  claim(
    'the frame stands WINDOW.frame proud',
    /windowFrames, entry\.wall, u, y, WINDOW\.frame \/ 2/.test(code),
    'the frame is not placed at WINDOW.frame',
  )
  claim(
    'the sill stands WINDOW.sill proud',
    /windowSills, entry\.wall, u, y - WINDOW\.h \/ 2 - [\d.]+,\s*WINDOW\.sill \/ 2/.test(code),
    'the sill is not placed at WINDOW.sill',
  )
  // 4. THE ENTRANCE, as a count. Reveal, leaf, surround, canopy, lamp and steps is
  // a door; one of those is a panel on a wall.
  const entranceAt = code.indexOf('  _addEntrance(wall, side) {')
  const entrance = entranceAt >= 0 ? code.slice(entranceAt) : ''
  claim('the entrance is a method', entranceAt >= 0, '_addEntrance is gone')
  claim(
    'the entrance is a stack, not a panel',
    ['doorReveals', 'doorLeaves', 'doorFrames', 'canopies', 'entryLamps', 'steps'].every(
      (pool) => entrance.includes(`this.pools.${pool}`),
    ),
    'one of the reveal / leaf / surround / canopy / lamp / steps is missing',
  )
  claim(
    'the door reveal is set INTO the wall',
    /doorReveals, wall, u, DOOR_LEAF_H \/ 2, -DOOR_RECESS \/ 2/.test(code),
    'the reveal is not recessed, so the door is a panel on a wall',
  )
  // 5. T6, as a single owner of "which way does this wall point". The value of the
  // sub-frame is that there is ONE place with the trigonometry in it, and the
  // measurable form of that is that the two façade methods contain no arithmetic
  // on a world axis at all.
  const windowsAt = code.indexOf('  _addFacadeWindows(')
  const windows = windowsAt >= 0 && entranceAt >= windowsAt ? code.slice(windowsAt, entranceAt) : ''
  // **A BARE IDENTIFIER, AND THE LOOKBEHIND IS THE WHOLE OF THE FIX.** Pass 12 put
  // `portal.swirl[layer].rotation.z += rate * dt` into the tail of this file, and
  // `\b[xyz]\s*[+\-*/]=` matches the `z` of `rotation.z` because a full stop is a
  // word boundary. So the pass-5 façade gate went red on a swirl integration and
  // reported "a façade method is doing world-axis arithmetic", which is not a thing
  // that happened.
  //
  // `(?<![.\w])` is the correct narrowing rather than a convenient one: the claim
  // has always been about the LOCAL axis variables `x`, `y` and `z` that a façade
  // method would be doing world-space arithmetic with, and a member expression
  // ending in one of those letters is a property of some object, not an axis. The
  // mutation below proves the narrowed pattern still catches the real thing, and
  // it is a bare `z =` on a façade method — the exact shape the sub-frame exists
  // to prevent.
  const AXIS_ARITHMETIC = /(?<![.\w])[xyz]\s*[+\-*/]=/
  claim(
    'façade placement contains no x/z trigonometry',
    !AXIS_ARITHMETIC.test(windows) && !AXIS_ARITHMETIC.test(entrance),
    'a façade method is doing world-axis arithmetic, so the sub-frame is not the only owner of it',
  )
  claim('the sub-frame exists', /function facadeFrame\(/.test(code), 'facadeFrame is gone')
  claim('the wall frames exist', /function houseFaces\(/.test(code), 'houseFaces is gone')
  claim('placement goes through onFacade', /function onFacade\(/.test(code), 'onFacade is gone')
  // 6. THE FRAME IS ONE ANNULUS, THREE USES. T3's budget note — "ours should be
  // four parts, not nine" — taken further: a frame of four bars is four
  // instances, and 588 lots x 4 windows x 4 bars is 9,400 instances on four
  // rectangles. Four mentions is the definition plus three call sites.
  claim(
    'one annulus geometry serves every frame',
    (code.match(/makeFrameGeometry\(/g) ?? []).length >= 4,
    'the annulus is not used by the parapet, the window frames and the door surround alike',
  )
  // 7. THE FRONTAGE IS SPLIT. The same single-slot defect as the siding, and the
  // one per-instance colour could NOT fix, because a hedge has a texture and a
  // fence does not and one material is not both.
  claim('the frontage pool is split', !/pools\.frontage\b/.test(code), 'the combined frontage pool is back')
  claim(
    'hedge and fence are separate pools',
    /pools\.frontageHedge/.test(code) && /pools\.frontageFence/.test(code),
    'one of the two frontage halves is missing',
  )
  // 8. T5 IS INSTRUMENTED, not estimated. A hand-maintained tally is a number a
  // future pass forgets to increment, which is the failure mode T5 names.
  claim('the part budget is instrumented', /partBudget\(\)/.test(code), 'partBudget is gone')
  claim(
    'the part count is a diff, not a tally',
    /_partsUsed\(\) - partsBefore/.test(code),
    'the part count is not measured as a difference across a lot, so it can drift',
  )
  // 9. THE DETAIL IS A FUNCTION OF THE LOT, NOT OF BUILD ORDER. §3.2's contract is
  // that a shuffled `buildChunks` produces the same world, and a window that lit
  // itself from a counter would break it silently.
  claim(
    'the detail uses the chunk-addressed stream',
    /streamAt\(this\.seed, chunk\.cx, chunk\.cz\)/.test(code),
    'the façade detail has no stream of its own',
  )
  return claims
}

test('the source claims this pass makes are all there, in the order it makes them', () => {
  const claims = buildingClaims(STREET_VIEW_SOURCE)
  assert.ok(claims.length >= 18, `only ${claims.length} claims are defined, which is fewer than this pass needs`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name}: ${entry.why}`)
  }
})

test('every claim above can actually fail, and a mutation names the one it breaks', () => {
  // The control for the test above, and the reason it is not decorative. Each
  // mutation is the smallest edit that breaks ONE claim and nothing else, so a
  // failure names the claim rather than "something changed" — and so a mutation
  // that breaks the WRONG claim is itself visible, which is how a gate stops being
  // a gate and becomes a fingerprint of one file.
  //
  // The first row is the pre-pass-5 defect, put back verbatim. It is not a
  // hypothetical: it is `git show HEAD:src/game/streetView.js`, and the point of
  // the row is that the real file of two commits ago fails this section.
  const rows = [
    ['the original defect: a per-lot material write', 'the material slot is written per lot', '  _addLot(chunk, lot, isAnchor, copy) {', '  _addLot(chunk, lot, isAnchor, copy) {\n    void (p) => { p.mesh.material = 0 }', 'no pool has its material reassigned'],
    ['setColorAt removed', 'the per-instance write is gone', 'this.mesh.setColorAt(this.used, color)', 'void color', 'per-instance colour is written'],
    ['needsUpdate removed', 'the per-instance upload is gone', 'if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true', '', 'per-instance colour is uploaded'],
    ['the cone comes back', 'the roof is a pyramid again', "names, 'roofs', box()", "names, 'roofs', new THREE.ConeGeometry(0.72, 1, 4)", 'the roof is not a cone'],
    ['the pane goes flush with the wall', 'the glass has no reveal', 'entry.wall, u, y, -WINDOW.depth / 2', 'entry.wall, u, y, WINDOW.depth / 2', 'the window pane is set INTO the wall'],
    ['the reveal goes flush with the wall', 'the door is a panel again', 'wall, u, DOOR_LEAF_H / 2, -DOOR_RECESS / 2', 'wall, u, DOOR_LEAF_H / 2, DOOR_RECESS / 2', 'the door reveal is set INTO the wall'],
    ['the frontage is merged again', 'hedge and fence share a pool', "this.pools.frontageHedge = this._streetPool(names, 'frontageHedge'", "this.pools.frontage = this._streetPool(names, 'frontageHedge'", 'the frontage pool is split'],
    // PASS 12 ADDED THIS ROW, and it is here because of what it cost to learn. The
    // claim "façade placement contains no x/z trigonometry" was a bare
    // `\b[xyz]\s*[+\-*/]=`, and a full stop is a word boundary, so pass 12's
    // `portal.swirl[layer].rotation.z += rate * dt` — three thousand lines away from
    // any façade — turned a pass-5 gate red with a message about world-axis
    // arithmetic that never happened. The pattern is now a bare identifier with a
    // `(?<![.\w])` lookbehind, and this row is the proof that the narrowed pattern
    // still catches the thing it was written for: a façade method doing world-axis
    // arithmetic on a local `x`, `y` or `z`. Without it, "narrowed" and "deleted"
    // look identical from the gate's output.
    ['a façade method doing its own world-axis arithmetic', 'the sub-frame is supposed to be the only owner of "which way does this wall points", and a bare `z =` in a façade method is exactly the second owner this claim exists to forbid',
      '  _addFacadeWindows(rng, faces) {', '  _addFacadeWindows(rng, faces) {\n    let z = faces[0][1]; z += 0', 'façade placement contains no x/z trigonometry'],
  ]
  for (const [label, why, from, to, expected] of rows) {
    assert.ok(STREET_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches the file, so it is not testing anything`)
    const broken = buildingClaims(STREET_VIEW_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(broken.length > 0, `"${label}" changed the file and broke NO claim — ${why}, and the section is not measuring it`)
    assert.ok(
      broken.some((entry) => entry.name === expected),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${expected}" — ` +
        'the gate is measuring something other than what it says',
    )
  }
})

test('the window stack is ordered deepest-first with the sill proudest (T3)', () => {
  // The three depths, read as NUMBERS and compared, because T3's claim is an
  // ordering and a presence check cannot state an ordering. `WINDOW.depth` is the
  // pane's thickness and the pane is set half of it INTO the wall; the frame
  // stands `WINDOW.frame` out; the sill stands `WINDOW.sill` out.
  const window = buildingFields('WINDOW')
  assert.ok(window.depth > 0, 'the window has no depth, so there is no stack')
  assert.ok(window.frame >= 0.03, `the frame stands ${(window.frame * 1000).toFixed(0)} mm proud, which is a line rather than a reveal`)
  assert.ok(window.sill > window.frame, `the sill (${window.sill}) is not prouder than the frame (${window.frame}) — T3 says the sill is proudest`)
  // ...and the glass is set back by a real amount, so the frame has something to
  // be proud OF rather than sitting on the wall's surface.
  assert.ok(window.depth >= 0.05, `the glass is only ${(window.depth * 1000).toFixed(0)} mm deep, so the reveal is a shadowless gap`)
  // A window is a person's window: 0.8-1.2 m wide and 1.0-1.4 m tall, which is the
  // residential range and not a porthole.
  assert.ok(window.w > 0.8 && window.w < 1.3, `the window is ${window.w} m wide, which is not a window a person looks out of`)
  assert.ok(window.h > 0.9 && window.h < 1.5, `the window is ${window.h} m tall, which is not a window a person looks out of`)
  // The inset is a FRACTION, because a 26 m frontage and a 5.5 m flank are the
  // two walls this pass puts windows on and a fixed metre inset puts a flank's
  // window outside the flank.
  assert.ok(buildingNumber('WINDOW_INSET') > 0.15 && buildingNumber('WINDOW_INSET') < 0.45, 'the window inset is not a fraction of the wall')
  // T3's four-part stack, of which this file builds three — the lit pane REPLACES
  // the dark one rather than adding to it. Stated so a future pass knows the
  // shortfall is deliberate and which part it is.
  assert.match(stripProse(STREET_VIEW_SOURCE), /isLit \? this\.pools\.windowLit : this\.pools\.windowGlass/, 'a lit window is now a fourth part rather than a replacement for the pane')
  // The lit RATE, and why it is a fraction of the WALLS and not of the windows:
  // one roll per wall, one bit, so a two-window façade can never light both. T11's
  // inversion puts the ceiling on it and D3's "some lit warm, most dark" the
  // floor. Measured at 16.2% on the default seed, which is 1-in-6 to within a
  // binomial's own noise.
  const oneIn = buildingNumber('LIT_WINDOW_ONE_IN')
  assert.ok(oneIn >= 4, `one window in ${oneIn} is lit, which is not enough variance to read as windows`)
  assert.ok(oneIn <= 12, `one window in ${oneIn} is lit, which is an office park and breaks T11's inversion`)
  // ...and the roll is PER WALL, not per window. That is what makes "never two on
  // the same façade" true BY CONSTRUCTION, and the shape of the loop is the only
  // place that fact lives. `verify-world.mjs` re-derives it from the built scene.
  const code = stripProse(STREET_VIEW_SOURCE)
  const start = code.indexOf('for (const entry of faces) {')
  const loop = start >= 0 ? code.slice(start, code.indexOf('  _addEntrance(')) : ''
  assert.match(loop, /const lit = rng\(\) < 1 \/ LIT_WINDOW_ONE_IN/, 'the lit roll is not one bit per wall')
  assert.ok(
    !/for \(let i = 0; i < entry\.count; i \+= 1\) \{\s*const lit =/.test(loop),
    'the lit roll is inside the per-window loop, so one façade can light two windows',
  )
})

test('the entrance is built from real dimensions, and the lamp is under its hood', () => {
  // Every number in the entrance is a real one, and this is where they are held
  // to it, because a comment saying "a real riser is 170 mm" beside a constant
  // reading 0.2 is a lie the comment cannot prevent.
  const riser = buildingNumber('STEP_RISER')
  const tread = buildingNumber('STEP_TREAD')
  const leafW = buildingNumber('DOOR_LEAF_W')
  const leafH = buildingNumber('DOOR_LEAF_H')
  // T-notes item 4's own list, pinned. 150 mm recess, 400 mm canopy, two steps.
  assert.equal(buildingNumber('DOOR_RECESS'), 0.15, 'DOOR_RECESS — move this pin in the commit that changes the reveal')
  assert.equal(buildingNumber('CANOPY_DEPTH'), 0.4, 'CANOPY_DEPTH — move this pin in the commit that changes the canopy')
  assert.equal(riser, 0.17, 'STEP_RISER — move this pin in the commit that changes the steps')
  assert.equal(tread, 0.28, 'STEP_TREAD — move this pin with the riser')
  assert.equal(buildingNumber('STEP_COUNT'), 2, 'STEP_COUNT — move this pin in the commit that changes the entrance')
  // A riser is 100-200 mm by any building code and a tread 200-350. Asserted as
  // ranges as well as pinned, because a pin can be moved deliberately and a range
  // cannot be moved by accident.
  assert.ok(riser > 0.1 && riser < 0.2, `a ${(riser * 1000).toFixed(0)} mm riser is not a step a person climbs`)
  assert.ok(tread > 0.2 && tread < 0.35, `a ${(tread * 1000).toFixed(0)} mm tread is not a step a person stands on`)
  // The oversail is the number doing VISUAL work rather than structural work: two
  // identical slabs read as one slab, and it is the only part of the entrance
  // that has to read at 40 m through fog.
  assert.ok(buildingNumber('STEP_OVERSAIL') >= 0.04, 'the steps do not step outward, so they read as one slab')
  // A door is a door: 2.0 x 0.85 m is the reference's own scale table, and ours
  // is within a few centimetres of it.
  assert.ok(leafW > 0.8 && leafW < 1.1, `the door is ${leafW.toFixed(2)} m wide, which is not a door`)
  assert.ok(leafH > 1.9 && leafH < 2.2, `the door is ${leafH.toFixed(2)} m tall, which is not a door`)
  // The reveal is WIDER than the leaf, which is what makes it a reveal: a dark
  // border has to be visible either side of the door for the hole to read.
  assert.ok(buildingNumber('DOOR_REVEAL_SCALE') > 1, 'the reveal is not wider than the door it reveals')
  // The lamp is UNDER the canopy and ABOVE the door head, and both halves are
  // arithmetic on three constants rather than a picture. Both are needed and they
  // pull in opposite directions, which is why the canopy's lift is a tuned number:
  //   - too high and the fitting's top is through the hood it is meant to light
  //     (the first version of this pass, at the textbook 2.3 m, and
  //      `verify-world.mjs` caught it on the first run);
  //   - too low and the fitting's top is below the door head, so it lights the
  //     doorstep and not the door (the second version, at 1.98 m, which the check
  //     below caught and the check above had let through).
  const lampY = buildingNumber('ENTRY_LAMP_Y')
  const lampH = buildingNumber('ENTRY_LAMP_H')
  const lampTop = lampY + lampH / 2
  const canopyBottom = leafH + buildingNumber('CANOPY_LIFT') - buildingNumber('CANOPY_THICK') / 2
  assert.ok(
    lampTop < canopyBottom,
    `the lamp's top is at ${lampTop.toFixed(3)} m and the canopy's underside at ` +
      `${canopyBottom.toFixed(3)} m — the lamp is sticking through its own hood`,
  )
  assert.ok(
    lampTop > leafH,
    `the lamp's top is at ${lampTop.toFixed(3)} m and the door head at ${leafH.toFixed(3)} m — ` +
      'the lamp lights the doorstep rather than the door',
  )
  // ...with room on both sides, because a number that satisfies two constraints
  // exactly is a number the next retune breaks. 50 mm of daylight is the floor.
  assert.ok(canopyBottom - lampTop > 0.05, `only ${((canopyBottom - lampTop) * 1000).toFixed(0)} mm between the lamp and its hood`)
  assert.ok(lampTop - leafH > 0.1, `only ${((lampTop - leafH) * 1000).toFixed(0)} mm between the lamp and the door head`)
  // ...and it hangs to one SIDE of the door, far enough not to read as part of the
  // frame and near enough that its light still falls on the leaf.
  const side = buildingNumber('ENTRY_LAMP_SIDE')
  assert.ok(side > 0.15 && side < leafW, `the lamp hangs ${side.toFixed(2)} m from the door's centre, which is neither beside it nor on it`)
  // The door is OFFSET along its wall rather than centred, because a door in the
  // middle of an 18 m frontage is a door on a hangar. As a fraction, because the
  // same number has to work on a 5.5 m flank.
  const offset = buildingNumber('ENTRANCE_OFFSET')
  assert.ok(offset > 0.1 && offset < 0.4, 'the door is not offset along its wall by a sane fraction')
})

test('the roofline is made of horizontal edges, and the pyramid is gone', () => {
  // Mechanism 1: "the reference spends its detail budget on things that change a
  // building's OUTLINE ... A flat box in fog is a flat box." The measurable form is
  // that a house's silhouette is a DECK and an UPRIGHT, both horizontal, and that
  // the three heights COMPOSE rather than replace one another.
  const wall = buildingNumber('WALL_HEIGHT')
  const deck = buildingNumber('ROOF_DECK_THICK')
  const parapet = buildingNumber('PARAPET_HEIGHT')
  const proud = buildingNumber('PARAPET_PROUD')
  const setback = buildingNumber('PARAPET_SETBACK')
  // The deck is thin and the parapet tall, which is the composition the old single
  // `ROOF_HEIGHT` could not express. A deck thicker than its parapet would put the
  // building's detail back in the wrong place.
  assert.ok(deck < 0.3, `the roof deck is ${deck} m thick, which is a second wall rather than a deck`)
  assert.ok(parapet > 0.25, `the parapet is ${parapet} m tall, which is a lip rather than an upstand`)
  assert.ok(deck < parapet, 'the deck is taller than the parapet standing on it')
  // The parapet PROJECTS, which is the entire reason it exists: a horizontal edge
  // 0 mm proud catches no light and changes no outline. 40-80 mm is a real cill.
  assert.ok(proud > 0.03 && proud < 0.1, `the parapet stands ${(proud * 1000).toFixed(0)} mm proud, which is not a rim`)
  // ...and it stands on a deck that is SET BACK, so the upstand is a wall at the
  // edge of a roof rather than a lid on a box. Without the set-back the cap's
  // outer face and the wall's outer face are the same plane and there is no rim.
  assert.ok(setback > 0.15, 'the roof deck is not set back, so the parapet has nothing to stand on')
  // ...and the composed silhouette: a house's roofline is higher than its wall by
  // more than a hand's width, which is what `verify-world.mjs` reads off the real
  // instance matrices.
  assert.ok(wall + deck + parapet > wall + 0.3, 'the house does not rise above its own wall by a visible amount')
  // The clutter is on the DECK, and both boxes are real sizes: a residential
  // condenser is 0.9 x 0.6 x 0.45 and a vent cowl 0.5 x 0.4 x 0.3.
  assert.deepEqual(buildingTable('AC_BOX'), [0.9, 0.6, 0.45], 'AC_BOX — move this pin in the commit that resizes the roof kit')
  assert.deepEqual(buildingTable('VENT_BOX'), [0.5, 0.4, 0.3], 'VENT_BOX — move this pin with the AC box')
  // The annulus bar is a FRACTION of a unit shape, so it has to be small: 0.02 on
  // an 18 m roof is 360 mm of upstand and 0.1 would be 1.8 m.
  const bar = buildingNumber('PARAPET_BAR')
  assert.ok(bar > 0.005 && bar < 0.05, `the parapet's bar is ${bar} of the roof's width, which is not an upstand`)
  // The belt is a real belt course: 100-200 mm tall, 25-75 mm proud, at the storey
  // line — and the storey line is half the wall, so a two-storey wall reads as two
  // storeys, which is T-notes item 5's whole claim.
  const beltH = buildingNumber('BELT_HEIGHT')
  const beltP = buildingNumber('BELT_PROUD')
  assert.ok(beltH > 0.1 && beltH < 0.2, 'the belt course is not a belt course')
  assert.ok(beltP > 0.02 && beltP < 0.08, 'the belt course does not stand proud enough to catch light')
  const storey = /const STOREY_HEIGHT = WALL_HEIGHT \/ (\d+)/.exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(storey, 'STOREY_HEIGHT is no longer derived from the wall, so the two can drift')
  assert.equal(Number(storey[1]), 2, 'the wall is no longer two storeys')
  // A window head has to clear the belt or the band cuts the building in half
  // through its own openings. The windows sit at 0.55 of the storey.
  const window = buildingFields('WINDOW')
  const windowTop = (wall / 2) * 0.55 + window.h / 2
  const beltBottom = wall / 2 - beltH / 2
  assert.ok(
    windowTop < beltBottom,
    `a window's head is at ${windowTop.toFixed(2)} m and the belt starts at ${beltBottom.toFixed(2)} m — the band cuts through the windows`,
  )
})

test('the emissive ladder has four rungs, and they are ranked (T11)', () => {
  // T11 asks for a ladder rather than "some windows glow", and a ladder is an
  // ORDER. The order is not one total order — a lit window is legitimately
  // brighter than a lamp head, because one is a source seen through glass and the
  // other is a reflector — so it is stated as the claims that are actually true and
  // measured in Rec. 709 off the palette, as pass 1 measured its ramps.
  const rungs = ['portal', 'sodium', 'windowLit', 'entryLamp'].map((key) => [key, paletteHex(key)])
  assert.equal(rungs.length, 4, 'the ladder does not have four rungs')
  const luma = new Map(rungs.map(([key, hex]) => [key, relLuma(hex)]))
  // The entry lamp is the LOWEST rung. T-notes item 4 puts it there explicitly:
  // "on the emissive ladder, at the *lowest* rung, dimmer than any window."
  for (const key of ['sodium', 'windowLit', 'portal']) {
    assert.ok(
      luma.get('entryLamp') < luma.get(key),
      `the entry lamp (${luma.get('entryLamp').toFixed(1)}) is not below ${key} (${luma.get(key).toFixed(1)}) — ` +
        "the ladder's lowest rung is not the lowest",
    )
  }
  // ...and by a real margin. A rung one luma below another is the same light.
  assert.ok(
    luma.get('sodium') - luma.get('entryLamp') > 40,
    `the entry lamp is only ${(luma.get('sodium') - luma.get('entryLamp')).toFixed(1)} luma below a lamp head`,
  )
  // The two families are still two families: §12.2's portal is the only cold light
  // in the game, and a warm ramp that swallowed it would be a different game.
  // Measured as which channel dominates, not as luma, because a cyan and an amber
  // can share a luma and be opposite families.
  assert.equal(((paletteHex('portal') & 0xff) > ((paletteHex('portal') >> 16) & 0xff)), true, 'the portal is no longer the cold family')
  assert.equal(((paletteHex('entryLamp') >> 16) & 0xff) > (paletteHex('entryLamp') & 0xff), true, 'the entry lamp is no longer the warm family')
  // T11's other half: these are the ONLY saturated light sources in the frame. The
  // set that matters is the set the renderer treats as emissive, which is the set
  // handed to `_glow`, so that is what is counted.
  const code = stripProse(STREET_VIEW_SOURCE)
  const glowed = new Set([...code.matchAll(/(\w+): this\._glow\(/g)].map((m) => m[1]))
  assert.ok(glowed.has('entryLamp'), 'the entry lamp is not a glow material, so it is a lit surface rather than a light')
  assert.ok(glowed.has('windowLit'), 'the lit window is not a glow material')
  // T11's inversion is "we use saturated colour on four things, not a dozen
  // signs" — and it is deliberately NOT asserted as a count of materials, because
  // pass 7 is going to add a lit vending machine and a count would make this gate
  // fail the next pass for doing the thing the notes ask for. What is asserted
  // instead is the half that cannot change: the LADDER is closed, in that nothing
  // outside these four rungs is a warm emissive, and the joinery around a lit
  // window is a lit SURFACE. The second is the half the renderer cares about —
  // `_glow` is unfogged, so a light survives distance, and `_material` is fogged,
  // so the frame around it does not. A window whose joinery glowed too would be
  // four lights where the ladder says one.
  assert.match(code, /entryLamp: this\._glow\(PALETTE\.entryLamp\)/, 'the entry lamp is not built from the palette rung it is ranked on')
  assert.match(code, /trim: this\._material\(\{ color: 0x4a4750/, 'the joinery material is gone, so a lit window has nothing around it that is not a light')
  // `stripProse` blanks string literals to `""`, so the pool's NAME is not matchable
  // here — only the shape of the call around it, which is the thing being claimed.
  assert.match(
    code,
    /pools\.windowFrames = this\._streetPool\(names, "", makeFrameGeometry\(\), this\._materials\.trim/,
    'the window frames are not the joinery material, so a lit window has no frame to sit in',
  )
  // The value pins, deliberately separate for the reason pass 1's hex pins are: a
  // deliberate retune is expected to fail this, and the remedy is to move the pin
  // in the commit that moves the number.
  assert.equal(paletteHex('windowLit'), 0xffbe72, 'PALETTE.windowLit — move this pin in the commit that retunes the ladder')
  assert.equal(paletteHex('entryLamp'), 0x6b4520, 'PALETTE.entryLamp — move this pin in the commit that retunes the ladder')
})

test('the siding table is four tints, and every one of them is a dark', () => {
  // §12.3's per-lot colour, which was two entries the renderer never used and is
  // now four it uses every one of. The second claim is the one that matters: these
  // are VARIATIONS ON A DARK, not a palette. A building that is not darker than
  // the sodium haze behind it stops being a silhouette, and §12.1's whole reading
  // of the creature depends on there being silhouettes.
  const siding = buildingTable('siding')
  assert.equal(siding.length, 4, `the siding table has ${siding.length} entries, and \`lot.tint\` is drawn from 0-3`)
  // `lot.tint` is `Math.floor(rng() * 4)`, so four entries cover the whole range
  // and the modulo in `_addLot` folds nothing away. Asserted against the generator
  // rather than against a second constant in this file.
  assert.match(
    readFileSync(new URL('./src/game/neighborhood.js', import.meta.url), 'utf8'),
    /tint: Math\.floor\(rng\(\) \* 4\)/,
    'lot.tint is no longer a 0-3 draw, so a four-entry table is not covering the range',
  )
  const lumas = siding.map(relLuma)
  const spread = Math.max(...lumas) - Math.min(...lumas)
  for (const [hex, luma] of siding.map((hex, i) => [hex, lumas[i]])) {
    assert.ok(luma < 90, `a siding tint is ${luma.toFixed(1)} luma (0x${hex.toString(16)}) — it is not a dark`)
  }
  // And the spread is a spread: four entries that are all the same value is a table
  // with one entry written four times, and the defect this pass closed would be
  // invisible behind it.
  assert.ok(spread > 4, `the four siding tints span ${spread.toFixed(1)} luma, which is not a variation`)
  assert.ok(spread < 40, `the four siding tints span ${spread.toFixed(1)} luma, which is a palette rather than a variation on a dark`)
  // Two pairs, cold and warm, and the pairing is what makes a street read as built
  // rather than as noise: a warm tint has more red than blue and a cold one more
  // blue than red, and there are two of each.
  const warm = siding.filter((hex) => ((hex >> 16) & 0xff) > (hex & 0xff))
  assert.equal(warm.length, 2, 'the siding table is not half warm and half cold')
  // The two BEFORE values are kept EXACTLY, so the pass does not move the value
  // every wall already had. A 20% darkening would not fail a luma gate and would
  // be visible in every capture.
  assert.equal(siding[0], 0x3a3540, 'the cold grey changed — move this pin in the commit that changes it')
  assert.equal(siding[1], 0x4a4038, 'the warm grey changed — move this pin in the commit that changes it')
  // ...and the material is ONE, white, with the tint in the instance colour. An
  // array of materials is the pre-pass-5 shape and would invite the material-slot
  // write straight back.
  const code = stripProse(STREET_VIEW_SOURCE)
  assert.match(code, /siding: this\._material\(\{ color: 0xffffff, map: siding \}\)/, 'the siding material is not a single white material the instance colour can tint')
  assert.equal(/siding: \[/.test(code), false, 'the siding material is an array again, which is what the material-slot write needs')
})

test('the part budget is declared, and a maximal lot fits inside it', () => {
  // T5's ceiling, pinned. The measurement of the actual worst lot is in
  // `verify-world.mjs`, which can read the built scene; this is the DECLARATION,
  // and it is here so a pass that wants to raise the ceiling has to say so in the
  // same commit that spends the parts.
  const budget = buildingNumber('LOT_PART_BUDGET')
  assert.equal(budget, 52, 'LOT_PART_BUDGET — move this pin in the commit that spends the parts')
  // ...and the ceiling has to be above what the pass actually spends, or the gate
  // is asserting a budget the world is already over. The worst lot is 46 parts,
  // measured by `verify-world.mjs` on the default seed. ITERATION 2, PASS 7 moved the
  // pin from 40 to 52 in the same commit that added the dressing; before that pass the
  // worst lot was 31 and the headroom rule below was written for passes 6-12.
  const worst = 46
  assert.ok(worst < budget, `the worst lot is ${worst} parts and the ceiling is ${budget}`)
  assert.ok(budget - worst >= 4, `only ${budget - worst} parts of headroom per lot, so the next pass must raise the ceiling before it adds anything`)
  // The pool capacities are derived per lot rather than typed, and the derivation
  // is the thing that has to survive: a capacity written as a literal is a
  // capacity somebody has to remember, and the first version of this block was one
  // literal per pool and lost 96 window frames.
  const code = stripProse(STREET_VIEW_SOURCE)
  assert.match(code, /const per = \(partsPerLot\) => lot \* partsPerLot/, 'the façade pool capacities are not derived per lot')
  // ...and the commit loop is driven by the CREATION list rather than a second
  // hand-written one, because a pool created and not named is a pool whose
  // instances are never uploaded and whose only symptom is that it is missing.
  assert.match(code, /for \(const name of names\) this\.pools\[name\]\.commit\(\)/, 'the commit loop is not driven by the creation list')
})

// v2 slice 16 — the captures of §16.5, and the deletion of v1
//
// WHAT THIS SECTION IS FOR
// ------------------------
// Two claims, both of which are only worth anything if they are checked:
//
//   1. **v1 is really gone.** Sixteen slices of comments said "slice 16 deletes
//      it". A comment is not a deletion, and a repository that still has a 438-line
//      maze generator and a 220-line rule module nothing imports is a repository
//      whose next contributor will extend the wrong one. The walk below is over
//      every file in `src/`, so "nothing reaches for v1" is a fact about the tree
//      and not about three greps that were known to pass.
//
//   2. **the gallery is a build output, not a memory.** `capture.js` says which
//      fourteen views exist and in what order; `tools/capture.mjs` is what
//      produces them; the PNGs and the run report are what proves it ran. The
//      checks below tie the three together, and the size floor is the one that
//      matters most: a 2 KB PNG is a black frame, and a gallery that silently
//      decays into black frames is worse than a gallery with a visible hole.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// STREET FURNITURE I (iteration 2, pass 6)
//
// WHAT PASS 6 CLAIMS
// ------------------
//   1. **the wires sag** (T7) — a parabola, three tiers, and one span in five
//      that hangs visibly lower than its neighbours
//   2. **the ribbon is a screen-space quantity** (T8) — the pixel width divides
//      by clip-space `p.w`, never by `-p.z`, and the near plane is clipped
//      against in view space FIRST so that division is safe by construction
//   3. **one buffer, one mesh, one draw call** for the whole overhead of the map
//   4. **the hardware is real**: poles on the pavement, crossarms at 93% of the
//      shaft, six conductors, signs at driver height, gullies in the gutter
//
// (2) is the one this section exists for. `-p.z` is a perfectly ordinary-looking
// divisor — it is the z component of the same `vec4` — and it is wrong: clip Z is
// a non-linear function of depth, and it goes NEGATIVE for geometry nearer than
// the near plane's z-midpoint. A negative divisor is a negative pixel width, and
// `clamp()` pins that to the cap: every wire in the world becomes a 3-28 px
// black band at full coverage, ruled across the amber sky. Nothing else in this
// repository can catch that, because nothing else in it divides by `p.z`.
// ---------------------------------------------------------------------------

section('Street furniture I (iteration 2, pass 6)')

/**
 * `furnitureClaims` — pass 6's claims, as predicates over a source string.
 *
 * Written as named predicates, not bare assertions, for the same reason pass 5's
 * `buildingClaims` is: a gate expressed as `assert.ok` can only ever be run on
 * the real file, and a gate that can only be run on the real file cannot be
 * asked whether it would have caught the bug. Each returns `ok` and a `why`, so
 * a mutation names the claim it broke.
 *
 * @param {string} source `streetView.js`, comments NOT yet stripped
 * @param {string} [creature] `creatureView.js`, for the one claim in this pass
 *   that is about the creature rather than about the furniture
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function furnitureClaims(source, creature = CREATURE_VIEW_SOURCE) {
  const code = stripProse(source)
  // The wire's claims are read from a source with its COMMENTS removed and its
  // strings intact, which is the opposite of `stripProse` and for one reason:
  // the shader lives inside a template literal, which `stripProse` blanks whole,
  // while the comments around it quote the very thing being claimed ("and never
  // -p.z"). A negative claim over raw prose fails on prose, and a positive claim
  // over a blanked template literal is vacuously true.
  const glsl = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  // 1. THE HEADLINE, named exactly as the contract in the file names it.
  // Both halves: the divisor is `p.w`, AND the segment is clipped against the
  // near plane before it is projected. The second is not a nicety — a segment
  // straddling the near plane has a `w` approaching zero at one end, so the
  // width goes to infinity, and a segment wholly behind has a `w` that is
  // NEGATIVE, which is the same pinning bug from the other direction.
  claim(
    'the wire shader clips against the near plane',
    /float near = projectionMatrix\[3\]\[2\] \/ \(projectionMatrix\[2\]\[2\] - 1\.0\)/.test(glsl)
      && /if \(mvPosition\.z > -near && mvEnd\.z > -near\)/.test(glsl)
      && /if \(mvPosition\.z > -near\) \{\s*mvPosition\.xyz = mix\(/.test(glsl)
      && /else if \(mvEnd\.z > -near\) \{\s*mvEnd\.xyz = mix\(/.test(glsl),
    'a segment is projected before it is clipped against the near plane, so its w can approach zero or go negative',
  )
  claim(
    'the wire width divides by p.w, never by -p.z',
    /float depth = clip\.w;/.test(glsl)
      && /float worldPx = aWidth \* uResolution\.y \* projectionMatrix\[1\]\[1\] \/ \(2\.0 \* depth\)/.test(glsl)
      && /gl_Position = clip \+ vec4\(normal \* px \* aSide \* 2\.0 \/ uResolution \* depth, 0\.0, 0\.0\)/.test(glsl)
      && !/-p\.z/.test(glsl)
      && !/-clip\.z/.test(glsl),
    'the pixel width is not computed from clip-space w, or something has reintroduced a -p.z divisor',
  )
  // T8's other half: a sub-pixel wire is drawn at the minimum width and at
  // partial opacity, rather than aliasing at its true width or vanishing.
  claim(
    'the wire fades sub-pixel geometry by coverage',
    /vCoverage = clamp\(worldPx \/ max\(uMinPx, 1e-6\), uCovFloor, 1\.0\)/.test(glsl),
    'coverage is not derived from the shortfall against the minimum pixel width',
  )
  // ...and a `ShaderMaterial` gets NO fog unless the chunks are included by
  // hand, which is a different failure: far wires hanging over the amber at
  // full strength, which is what makes a wire system read as a wireframe.
  // `fog: true` is scoped to the wire's own material block, because three other
  // materials in the file also ask for it and a file-wide test would pass with
  // the wire's fog switched off.
  claim(
    'the wire carries the fog chunks by hand',
    /#include <fog_pars_vertex>/.test(glsl)
      && /#include <fog_vertex>/.test(glsl)
      && /#include <fog_pars_fragment>/.test(glsl)
      && /#include <fog_fragment>/.test(glsl)
      && /THREE\.UniformsLib\.fog/.test(code)
      && /new THREE\.ShaderMaterial\(\{[\s\S]*?\n    fog: true,/.test(glsl),
    'the wire is a ShaderMaterial with no fog, so every far span hangs at full strength',
  )
  // 2. ONE BUFFER, ONE MESH, ONE CALL. The claim is the shape of the build, not
  // the presence of a function: a `LineSegments` per span would also "have a
  // wire geometry" and would draw 252 calls at one pixel of width.
  claim(
    'every span lands in one wire mesh',
    /const wire = new THREE\.Mesh\(makeWireGeometry\(this\.wireSpans\), this\._materials\.wire\)/.test(code)
      && /this\.group\.add\(wire\)/.test(code)
      && (code.match(/makeWireGeometry\(/g) ?? []).length === 2,
    'the wire mesh is not built from the whole span list, or makeWireGeometry is called from more than one place',
  )
  claim(
    'the wire is not culled',
    /wire\.frustumCulled = false/.test(code),
    'the wire is frustum-culled, and its bounds are the bounds of the whole world',
  )
  // 2b. THE RIBBON'S TWO TABLES — the pair this pass got wrong first and the
  // reason the gate could not see it. The gate above proves the wire has an
  // `aEnd` ATTRIBUTE, which is not the same claim as every corner carrying the
  // OTHER end of its own segment, and the difference is the whole failure: a
  // corner whose `aEnd` is its own position gives the shader a zero-length
  // segment, `dir` falls back to a hardcoded `(1, 0)`, and the ribbon is extruded
  // down the screen instead of perpendicular to the wire. Same class for the
  // index base: an INDEX cursor and a VERTEX cursor drift apart by two per quad,
  // so the first quad still looks right and every one after it spans two quads'
  // world positions.
  //
  // Neither defect is visible in a screenshot. Both rasterise as "a handful of
  // screen-filling wedges", which is also what a healthy wire can look like from
  // the wrong angle — so a comment describing the correct table is a claim about
  // the source, never evidence about the buffer. `verify-world.mjs` re-derives
  // both from the built geometry; these two are the pure-side fingerprint, and
  // the mutation table below is what keeps them honest.
  claim(
    'every ribbon corner is paired with the other end of its own segment',
    /const quadOther = \[q, p, p, q\]/.test(code) && !/k < 2 \? q : p/.test(code),
    'aEnd is not the OTHER sample of the segment, so half the corners are handed their OWN position and the shader has no direction to expand along',
  )
  claim(
    'each wire quad is indexed from its own four corners',
    /const base = corner - 4/.test(code) && !/const base = face/.test(code),
    'the index base is read off the INDEX cursor rather than the VERTEX one, and the two drift apart by two per quad, so every triangle spans three unrelated world positions',
  )
  // 3. T7. A parabola, and a sag that is a FRACTION of the span rather than a
  // metre count — a fixed count droops to the pavement on a short span and barely
  // bends on a long one.
  claim(
    'every span is a catenary',
    /p\.y \+= \(b\.y - a\.y\) \* t - sag \* 4 \* t \* \(1 - t\)/.test(code)
      || /y: a\.y \+ \(b\.y - a\.y\) \* t - sag \* 4 \* t \* \(1 - t\)/.test(code),
    'a span is not a parabola, and a straight line between two poles reads as a mistake (T7)',
  )
  claim(
    'the sag is a fraction of the span',
    /sag: tier\.sag \* run \* \(low \? LOW_SPAN_SAG_MULT : 1\)/.test(code),
    'the sag is not derived from the horizontal distance, so a short span droops to the pavement',
  )
  claim(
    'one span in five hangs lower',
    /Math\.floor\(rng\(\) \* LOW_SPAN_ONE_IN\) === 0/.test(code) && /low \? LOW_SPAN_SAG_MULT : 1/.test(code),
    'every span sags the same amount, which is a ruled grid rather than a street',
  )
  // 4. THE HARDWARE, against real dimensions and the pavement.
  claim(
    'the pole stands on the pavement',
    /const POLE_STANDOFF = STREET_HALF_WIDTH \+ POLE_KERB_SETBACK/.test(code),
    'the pole offset is a literal rather than a derived one, so widening the road leaves the poles in the tarmac',
  )
  claim(
    'the pole corner is the district',
    /CORNER_SIGNS\[districtOf\(ax, az\)\]/.test(code),
    'the pole corner is not a function of the district, so "per district placement" is a comment',
  )
  claim(
    'the furniture is a function of the intersection, not of build order',
    /const rng = streamAt\(this\.seed, ax, az\)/.test(code)
      && /streamAt\(this\.seed, ax, az \+ \(axis \+ 1\) \* GRID\)/.test(code),
    'the furniture has no stream of its own, so it moves when the build order does',
  )
  claim(
    'the gully is in the gutter',
    /STREET_HALF_WIDTH \+ KERB_WIDTH - DRAIN_SETBACK/.test(code),
    'the grate is not set against the kerb face, so it is either on the pavement or in the middle of the lane',
  )
  claim(
    'the signs are capped per intersection',
    /for \(let sign = 0; sign < SIGNS_PER_INTERSECTION; sign \+= 1\)/.test(code)
      && /const \[sx, sz\] = free\[corner % free\.length\]/.test(code),
    'a sign is placed on every corner, which is a picket fence rather than a street',
  )
  // 5. THE RESOLUTION, and the teardown. Both are one-line claims that are
  // invisible in a screenshot and impossible to reconstruct afterwards.
  claim(
    'the wire resolution is device pixels and follows a resize',
    /wire: makeWireMaterial\(this\.resolution\.x, this\.resolution\.y\)/.test(code)
      && /setResolution\(x, y\)/.test(code)
      && /this\.streetView\.setResolution\(buffer\.x, buffer\.y\)/.test(stripProse(WORLD_SOURCE))
      && /Math\.round\(w \* this\.pixelRatio\)/.test(stripProse(WORLD_SOURCE)),
    'the wire is sized once, in CSS pixels, and is the wrong width in a resized window',
  )
  claim(
    'the wire geometry is disposed with the rest',
    /if \(this\.wireMesh\) this\.wireMesh\.geometry\.dispose\(\)/.test(code),
    'the wire mesh is not a pool, so nothing in the pool loop can release it',
  )
  // 6. THE ONE CLAIM IN THIS PASS THAT IS ABOUT SOMETHING ELSE ENTIRELY.
  //
  // Every claim above is a claim about the furniture. This one is about the
  // creature, and it exists because the furniture broke the creature: a cable
  // two metres from the lens is sorted AFTER an eye at thirty, and a luma-17.6
  // silhouette over a luma-226 additive quad cut `creature-stalking.png`'s one
  // solid 9x7 eye into two fragments and made `creatureContrast` report that a
  // frame with a creature in it had no creature in it.
  //
  // Three.js sorts transparents back-to-front unless `renderOrder` says
  // otherwise, so the fix is a number on the eye quads, and the claim is that
  // the number exists, is above zero, and is set on the MESH rather than on the
  // `eyes` group — a `Group` is never queued for rendering, so a `renderOrder`
  // left there is a comment that reads like a fix.
  claim(
    'the eye is lifted out of the transparent depth sort',
    /const EYE_RENDER_ORDER = ([1-9]\d*)/.exec(creature) !== null
      && /eye\.renderOrder = EYE_RENDER_ORDER/.test(creature)
      && !/this\.eyes\.renderOrder/.test(creature)
      // The other half, and the half that keeps the claim from being a cheat:
      // `depthTest` must stay on, or an eye renders through a house and §8.3
      // stops being a rule the AI enforces.
      && /blending: THREE\.AdditiveBlending/.test(creature)
      && !/depthTest: false/.test(creature),
    'the eye is depth-sorted with the street furniture, so any transparent thing between the camera and the creature erases the one mark the creature gate anchors on',
  )
  return claims
}

test('the wire shader clips against the near plane, and its width is clip-space w', () => {
  const claims = furnitureClaims(STREET_VIEW_SOURCE)
  assert.ok(claims.length >= 19, `only ${claims.length} claims are defined, which is fewer than this pass needs`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name}: ${entry.why}`)
  }
})

test('every wire claim can actually fail, and a mutation names the one it breaks', () => {
  // The control for the test above, and the reason the section is a gate rather
  // than a fingerprint of one file. Each row is the smallest edit that breaks ONE
  // claim, and the row that matters most is the first: the pre-pass file is
  // `git show HEAD~1:src/game/streetView.js` and it has no wire shader at all, so
  // the divisor bug is a HYPOTHETICAL — except that it is the default state
  // anyone porting T8 writes, which is why it is here as a mutation rather than
  // as a historical defect.
  const rows = [
    ['the wrong divisor', 'the pixel width is computed from -p.z again', 'float depth = clip.w;', 'float depth = -clip.z;', 'the wire width divides by p.w, never by -p.z'],
    ['the near-plane clip is gone', 'a segment is projected before it is clipped', 'if (mvPosition.z > -near && mvEnd.z > -near) {', 'if (false) {', 'the wire shader clips against the near plane'],
    ['coverage is a constant', 'sub-pixel wires alias instead of fading', 'vCoverage = clamp(worldPx / max(uMinPx, 1e-6), uCovFloor, 1.0);', 'vCoverage = 1.0;', 'the wire fades sub-pixel geometry by coverage'],
    ['the fog is dropped', 'a ShaderMaterial with no fog hangs over the amber at full strength', '    fog: true,\n  })', '    fog: false,\n  })', 'the wire carries the fog chunks by hand'],
    ['the spans stop sagging', 'a straight line between two poles', 'y: a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t),', 'y: a.y + (b.y - a.y) * t,', 'every span is a catenary'],
    ['the low spans are gone', 'every span sags the same amount, which is a ruled grid', 'sag: tier.sag * run * (low ? LOW_SPAN_SAG_MULT : 1),', 'sag: tier.sag * run,', 'the sag is a fraction of the span'],
    ['the pole is in the road', 'the offset is a literal rather than a derived one', 'const POLE_STANDOFF = STREET_HALF_WIDTH + POLE_KERB_SETBACK', 'const POLE_STANDOFF = POLE_KERB_SETBACK', 'the pole stands on the pavement'],
    ['the gully is on the pavement', 'the grate is not set against the kerb face', 'const gutter = STREET_HALF_WIDTH + KERB_WIDTH - DRAIN_SETBACK', 'const gutter = STREET_HALF_WIDTH - DRAIN_SETBACK', 'the gully is in the gutter'],
    ['a sign on every corner', 'uniformity is what makes a generated street read as generated', 'for (let sign = 0; sign < SIGNS_PER_INTERSECTION; sign += 1) {', 'for (let sign = 0; sign < 4; sign += 1) {', 'the signs are capped per intersection'],
    ['one mesh per span', 'a LineSegments per span is 252 calls at one pixel of width', 'const wire = new THREE.Mesh(makeWireGeometry(this.wireSpans), this._materials.wire)', 'const wire = new THREE.Group(makeWireGeometry(this.wireSpans), this._materials.wire)', 'every span lands in one wire mesh'],
    // The two rows the review added. Both were live defects, both were described
    // at length in the source as fixed, and NEITHER broke a single claim — 218
    // pure and 61 world checks stayed green with each of them reverted, which is
    // the shape of a fix that only exists in a comment.
    ['aEnd is paired as an alternation', 'half the corners get their own position, so the ribbon is extruded down the screen', 'const quadOther = [q, p, p, q]', 'const quadOther = [q, q, p, p]', 'every ribbon corner is paired with the other end of its own segment'],
    ['the index base reads the wrong cursor', 'the base drifts two per quad, so every triangle spans three unrelated world positions', 'const base = corner - 4', 'const base = face', 'each wire quad is indexed from its own four corners'],
  ]
  for (const [label, why, from, to, expected] of rows) {
    assert.ok(STREET_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches the file, so it is not testing anything`)
    const broken = furnitureClaims(STREET_VIEW_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(broken.length > 0, `"${label}" changed the file and broke NO claim — ${why}, and the section is not measuring it`)
    assert.ok(
      broken.some((entry) => entry.name === expected),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${expected}" — ` +
        'the gate is measuring something other than what it says',
    )
  }

  // The eye claim reads a DIFFERENT file, so it gets its own rows rather than
  // being smuggled into the table above — a mutation that edited
  // `streetView.js` could never break it, and a gate with a row that cannot
  // fail is worse than no row because it counts.
  //
  // These are the three ways this fix can be written wrong, and all three are
  // edits somebody would plausibly make while tidying up the eye rig.
  const EYE_CLAIM = 'the eye is lifted out of the transparent depth sort'
  const eyeRows = [
    ['the order is zero', 'the eye is back in the depth sort with the street furniture', 'const EYE_RENDER_ORDER = 1', 'const EYE_RENDER_ORDER = 0'],
    ['the assignment is dropped', 'a constant nobody assigns is a constant doing nothing', '      eye.renderOrder = EYE_RENDER_ORDER\n', ''],
    ['it is set on the Group', 'a Group is never queued for rendering, so this is a comment that reads like a fix', '      eye.renderOrder = EYE_RENDER_ORDER', '      this.eyes.renderOrder = EYE_RENDER_ORDER'],
  ]
  for (const [label, why, from, to] of eyeRows) {
    assert.ok(CREATURE_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches creatureView.js, so it is not testing anything`)
    const broken = furnitureClaims(STREET_VIEW_SOURCE, CREATURE_VIEW_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === EYE_CLAIM),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${EYE_CLAIM}" — ${why}`,
    )
  }
})

// ===========================================================================
// STREET FURNITURE II (iteration 2, pass 7)
//
// WHAT PASS 7 CLAIMS, AND WHY ANY OF IT IS HERE RATHER THAN IN THE WORLD HARNESS
// ---------------------------------------------------------------------------
// Every claim below is one the built scene CANNOT answer. A world check can measure
// that the flickering machine exists, that the poster is 0.42 x 0.60 and that nothing
// stands within 12 m of a portal; it cannot tell whether the flicker would survive the
// next person tidying `update()`, whether the lit liner would still be fogged if
// somebody moved it back to `_glow`, or whether the dressing stream would still be the
// pass's OWN region after a well-meaning refactor. Those are the defects this
// repository's last two reviews actually found — both described at length in the
// source as fixed, and both invisible to every measurement.
//
// (1) the ballast is HASHED, not summed, and it is stepped — a fourth sine would pass
//     every world check and fail this one
// (2) the flicker is written to `emissiveIntensity`, never to `color`
// (3) the lit liner is a `MeshStandardMaterial` with fog ON, not a `_glow`
// (4) the poster is `alphaTest`ed and not blended
// (5) the dressing reads its OWN region of the mix, so it cannot move pass 5's lit
//     windows or pass 6's poles
// (6) EVERY family is filtered against the portal exclusion, including the poster —
//     which the first version of the pass forgot, and which is how a poster ended up
//     2.5 m from a gate
// (7) the world's one flickering machine is a MINIMUM over the map, not a roll, so the
//     count is exactly one on every seed rather than one on average
// (8) `flickerAt` is pure: no clock, no `Math.random`, bounded output
// (9) the machine's clock is incommensurate with the sodium's three sines
// ===========================================================================

section('Street furniture II (iteration 2, pass 7)')

/**
 * `methodBody` — one method's source, braces balanced, for a claim that is ABOUT a
 * method rather than about a file.
 *
 * Two of pass 7's claims are negative over a method ("the dressing does not read the
 * stream an earlier pass spends") and both were first written as negatives over the
 * WHOLE FILE, where they fail on `_addFacadeDetail` and `makeWireMaterial` — pass 5's
 * legitimate use of the shared stream and pass 6's legitimately transparent wire. A
 * negative claim written too wide measures the other four thousand lines, and the
 * failure it reports is not the failure it means.
 *
 * @param {string} code comment-stripped source
 * @param {string} name the method's name, without the keyword
 * @returns {string} the body including its braces, or '' if there is no such method
 */
function methodBody(code, name) {
  // THREE SHAPES, because pass 11 needed a top-level `export function` and the old
  // two-space-only search returned the empty string for it — which reads as "the claim
  // failed" rather than as "the helper could not find the function", the same way a
  // default parameter read as a two-character body. A helper that fails silently is
  // worse than no helper.
  const shapes = [`\n  ${name}(`, `\n  static ${name}(`, `\nexport function ${name}(`, `\nfunction ${name}(`]
  let at = -1
  for (const shape of shapes) {
    at = code.indexOf(shape)
    if (at >= 0) break
  }
  if (at < 0) return ''
  // THE OPENING BRACE IS THE FIRST ONE AT PAREN DEPTH ZERO, and finding it that way is
  // not a nicety. `code.indexOf('{', at)` finds the `{` of a DEFAULT PARAMETER — and
  // every method in this repository that takes a context object writes
  // `(context = {})`, so the old version returned the two characters `{}` for all of
  // them and every claim scoped to one silently tested the empty string, which fails
  // every predicate and so looks like a broken source rather than a broken helper. It
  // was found by pass 11's first claim run, which failed five claims at once on an
  // unmutated tree.
  let parens = 0
  let open = -1
  for (let i = at; i < code.length; i += 1) {
    if (code[i] === '(') parens += 1
    else if (code[i] === ')') parens -= 1
    else if (code[i] === '{' && parens === 0) { open = i; break }
  }
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return ''
}

/**
 * `dressingClaims` — pass 7's claims, as predicates over a source string.
 *
 * The same shape as `furnitureClaims` and `buildingClaims`, and for the same reason: a
 * gate expressed as `assert.ok` can only ever run on the real file, and a gate that can
 * only run on the real file cannot be asked whether it would have caught the bug. Each
 * returns `ok` and a `why`, so a mutation names the claim it broke.
 *
 * @param {string} source `streetView.js`, comments NOT yet stripped
 * @param {string} hash `hash.js`, for the one claim that is about the pure module
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function dressingClaims(source, hash = HASH_SOURCE) {
  const code = stripProse(source)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  claim(
    'the ballast is hashed, not summed',
    /return flickerAt\(seed, Math\.floor\(t \* VENDING_FLICKER_HZ\), VENDING_FLICKER_TICK_SALT, \{/.test(code)
      && /const tick = Math\.floor\(t \* VENDING_FLICKER_HZ\)/.test(code) === false
      && !/function vendingFlicker[\s\S]{0,400}Math\.sin/.test(code),
    'the machine reuses the sodium\'s trigonometry, so a player who watched the lamps can predict the machine',
  )
  claim(
    'the flicker is written to the emissive, never to the colour',
    /vendingFaceFlicker\.emissiveIntensity = VENDING_FACE_EMISSIVE \* vendingFlicker\(t\)/.test(code)
      && !/vendingFaceFlicker\.color/.test(code),
    'multiplying the colour darkens the panel\'s albedo as well as its output, so a failing machine reads as a dirty one',
  )
  claim(
    'the lit liner is a fogged standard material, not a glow',
    /vendingFaceLit: this\._material\(\{/.test(code)
      && /vendingFaceFlicker: this\._material\(\{/.test(code)
      && /emissive: PALETTE\.vendingGlow/.test(code)
      && !/vendingFaceLit: this\._glow/.test(code)
      && !/vendingFaceFlicker: this\._glow/.test(code),
    '`_glow` is `fog: false`, so a lit panel 40 m down a street punches through the amber haze into the creature\'s corridor',
  )
  // SCOPED TO THE POSTER MATERIALS, and the first version of this claim was a bare
  // `!/transparent:/` over the whole file — which fails, correctly, on pass 6's wire
  // `ShaderMaterial`, where `transparent: true` is the entire mechanism. A negative
  // claim written over a whole file measures the other 4,000 lines.
  const posterBlocks = [...code.matchAll(/(?:poster|posterTorn): this\._material\(\{([\s\S]*?)\}\),/g)].map(([, body]) => body)
  claim(
    'the poster is alpha-tested, not blended',
    posterBlocks.length === 2
      && posterBlocks.every((body) => /alphaTest: POSTER_ALPHA_TEST/.test(body) && !/\btransparent:/.test(body)),
    'a blended torn sheet is a second transparent surface to sort against the wall, and a depth-sorted edge shimmers as the camera moves',
  )
  const dressing = methodBody(code, '_addLotDressing') + methodBody(code, '_addCornerDressing')
  claim(
    'the dressing reads its OWN region of the mix',
    /streamAt\(hash32\(seed, cx \+ DRESSING_SALT, cz\), sideIndex, 0\)/.test(code)
      && /streamAt\(hash32\(seed \+ VENDING_SALT, cx, cz\), sideIndex, 0\)/.test(code)
      && /dressingStream\(this\.seed, chunk\.cx, chunk\.cz, SIDE_NAMES\.indexOf\(lot\.side\)\)/.test(dressing)
      && /vendingDraw\(this\.seed, chunk\.cx, chunk\.cz, SIDE_NAMES\.indexOf\(lot\.side\)\)/.test(dressing)
      && /streamAt\(hash32\(this\.seed, ax, az \+ DRESSING_SALT\), 0, 0\)/.test(dressing)
      && !/streamAt\(this\.seed/.test(dressing),
    'the dressing draws from a stream an earlier pass already spends, so every object added here moves every window and pole after it',
  )
  claim(
    'every family is filtered against the portal exclusion',
    (code.match(/this\._portalClear\(/g) || []).length >= 6 && /PORTAL_FURNITURE_CLEAR/.test(code),
    'one unfiltered family is one object standing in a portal\'s stand-off, which is where the pass-3 pupil luma is measured',
  )
  claim(
    'the one flickering machine is a minimum over the map, not a roll',
    /if \(candidate < rank\)/.test(code)
      && /if \(this\.anchorLots\.has\(key\)\) continue/.test(code)
      && /const draw = vendingDraw\(this\.seed, cx, cz, side\)/.test(code),
    'a roll gives an EXPECTED count of one, and on the wrong seed the pass delivers none while every comment still claims one',
  )
  claim(
    'the machine gets its own liner pool, so a flicker is not shared',
    /const face = flicker\s*\n\s*\? this\.pools\.vendingFlickerFaces\s*\n\s*: lit \? this\.pools\.vendingLitFaces : this\.pools\.vendingFaces/.test(code),
    'one material slot per pool: a shared liner means `update()` gutters every lit machine in the district at once',
  )
  claim(
    'flickerAt is pure, seeded and bounded',
    /export function flickerAt\(seed, tick, salt, options = \{\}\)/.test(hash)
      && !/function flickerAt[\s\S]{0,900}Math\.random/.test(hash)
      && !/function flickerAt[\s\S]{0,900}Date\.now/.test(hash)
      && /return Math\.max\(floor, 1 - depth \* wobble\)/.test(hash),
    'an unseeded or clocked flicker is D10, and an unbounded one can produce a negative colour channel',
  )
  claim(
    'the machine and the lamps run on different clocks',
    /const VENDING_FLICKER_HZ = 11/.test(code) && /sin\(t \* 7\.3\)/.test(code) && /sin\(t \* 17\.7\)/.test(code),
    'a flicker that lands on one of the sodium\'s three sines is a shared metronome, and a player can hear the two beating together',
  )
  return claims
}

test('the street furniture II claims hold, and each one is a claim a comment would not', () => {
  const claims = dressingClaims(STREET_VIEW_SOURCE)
  assert.ok(claims.length >= 10, `only ${claims.length} claims are defined, which is fewer than this pass needs`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name}: ${entry.why}`)
  }
})

test('flickerAt is a pure function of (seed, tick): same answer, bounded, stepped', () => {
  // The numeric half of the claim, and the reason `flickerAt` lives in `hash.js` at
  // all: `streamAt` returns a GENERATOR, so it cannot be re-read at an arbitrary
  // point, and a flicker asked for the same tick twice in one frame has to give the
  // same answer both times.
  const a = flickerAt(0x56454e44, 7, 0x5449434b, { phaseSalt: 0x50484153, floor: 0.3, depth: 0.42, oneIn: 8 })
  const b = flickerAt(0x56454e44, 7, 0x5449434b, { phaseSalt: 0x50484153, floor: 0.3, depth: 0.42, oneIn: 8 })
  assert.equal(a, b, 'the same seed and tick gave two different levels')
  // ...and a different tick does NOT give the same level, which is the other half.
  const levels = new Set()
  for (let tick = 0; tick < 400; tick += 1) {
    levels.add(flickerAt(0x56454e44, tick, 0x5449434b, { phaseSalt: 0x50484153, floor: 0.3, depth: 0.42, oneIn: 8 }))
  }
  assert.ok(levels.size > 40, `400 ticks produced ${levels.size} levels, which is not a hashed ball`)
  for (const level of levels) {
    assert.ok(level >= 0.3 && level <= 1, `a level of ${level} is outside the [floor, 1] band a colour can be multiplied by`)
  }
  // About one dropout in eight, and the dropout is EXACTLY the floor rather than a
  // value that happens to be near it.
  let dropouts = 0
  for (let tick = 0; tick < 800; tick += 1) {
    if (flickerAt(0x56454e44, tick, 0x5449434b, { floor: 0.3, depth: 0.42, oneIn: 8 }) === 0.3) dropouts += 1
  }
  assert.ok(dropouts > 60 && dropouts < 140, `${dropouts} dropouts in 800 ticks, which is not about one in eight`)
  // The default floor is a floor and not a zero, which is the difference between a
  // FAILING machine and a DEAD one — and a default is what a second caller gets.
  assert.equal(flickerAt(1, 0, 1) >= 0.18, true, 'the default floor is not 0.18')
  // The phase salt is derived from the salt when it is not given, so two callers
  // cannot accidentally share a wobble, and giving it explicitly changes the answer
  // (which is what proves the two halves are really independent).
  assert.notEqual(
    flickerAt(9, 3, 5),
    flickerAt(9, 3, 5, { phaseSalt: 6 }),
    'the phase salt is not doing anything, so the dropout pattern and the wobble are one number',
  )
})

test('every street furniture II claim can fail, and a mutation names the one it breaks', () => {
  // The control for the test above, and the reason this section is a gate rather than
  // a fingerprint of one file. Each row is the smallest edit that breaks ONE claim and
  // a row that breaks none is worse than no row, because it counts.
  const rows = [
    ['the machine reuses the lamps\' sines', 'a second sine sum is a shared metronome', 'return flickerAt(seed, Math.floor(t * VENDING_FLICKER_HZ), VENDING_FLICKER_TICK_SALT, {', 'return 0.9 + Math.sin(t * 9.1) * 0.1; //', 'the ballast is hashed, not summed'],
    ['the flicker is written to the colour', 'a failing machine reads as a dirty one', 'this._materials.vendingFaceFlicker.emissiveIntensity = VENDING_FACE_EMISSIVE * vendingFlicker(t)', 'this._materials.vendingFaceFlicker.color.setHex(0x111111)', 'the flicker is written to the emissive, never to the colour'],
    ['the liner is a glow again', 'fog off, so the panel punches through the haze', 'vendingFaceLit: this._material({', 'vendingFaceLit: this._glow(PALETTE.vendingGlow, {', 'the lit liner is a fogged standard material, not a glow'],
    ['the poster is blended', 'a torn sheet sorts against the wall and shimmers', 'alphaTest: POSTER_ALPHA_TEST,', 'transparent: true, alphaTest: 0,', 'the poster is alpha-tested, not blended'],
    ['the dressing shares a stream', 'every bin moves a window three lots away', 'dressingStream(this.seed, chunk.cx, chunk.cz, SIDE_NAMES.indexOf(lot.side))', 'streamAt(this.seed, chunk.cx, chunk.cz)', 'the dressing reads its OWN region of the mix'],
    ['the poster skips the exclusion', 'a poster 2.5 m from a gate, in the pupil stand-off', '      if (this._portalClear(px, pz, copy)) {', '      if (true) {', 'every family is filtered against the portal exclusion'],
    ['the flickering lot is a maximum', 'the pass claims one machine and delivers the far end of the map', 'if (candidate < rank) {', 'if (candidate > rank) {', 'the one flickering machine is a minimum over the map, not a roll'],
    ['the liner pools are merged', 'every lit machine in the district gutters together', '      ? this.pools.vendingFlickerFaces\n      : lit ? this.pools.vendingLitFaces : this.pools.vendingFaces', '      ? this.pools.vendingLitFaces\n      : lit ? this.pools.vendingLitFaces : this.pools.vendingFaces', 'the machine gets its own liner pool, so a flicker is not shared'],
    ['the machine shares the lamp clock', 'the two misbehaviours beat against each other', 'const VENDING_FLICKER_HZ = 11', 'const VENDING_FLICKER_HZ = 7.3', 'the machine and the lamps run on different clocks'],
  ]
  for (const [label, why, from, to, expected] of rows) {
    assert.ok(STREET_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches the file, so it is not testing anything`)
    const broken = dressingClaims(STREET_VIEW_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(broken.length > 0, `"${label}" changed the file and broke NO claim — ${why}, and the section is not measuring it`)
    assert.ok(
      broken.some((entry) => entry.name === expected),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${expected}" — the gate is measuring something other than what it says`,
    )
  }
  // ...and the one claim that is about `hash.js` gets its own rows, because a mutation
  // of `streetView.js` could never break it and a row that cannot fail is worse than
  // no row at all.
  const hashRows = [
    ['the ballast is unseeded', 'the same world gives every player a different machine', 'if (hash32(seed, tick, salt) % oneIn === 0) return floor', 'if (Math.random() < 1 / oneIn) return floor'],
    ['the floor is a zero', 'a fully dark panel is a dead machine, not a failing one', 'return Math.max(floor, 1 - depth * wobble)', 'return Math.max(0, 1 - depth * wobble)'],
  ]
  for (const [label, why, from, to] of hashRows) {
    assert.ok(HASH_SOURCE.includes(from), `the mutation "${label}" no longer matches hash.js, so it is not testing anything`)
    const broken = dressingClaims(STREET_VIEW_SOURCE, HASH_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === 'flickerAt is pure, seeded and bounded'),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] — ${why}`,
    )
  }
})

/** The three wire tiers, read out of the source as data. */
function wireTiers() {
  const found = [...STREET_VIEW_SOURCE.matchAll(
    /Object\.freeze\(\{ name: '(\w+)', y: ([\d.]+), sag: ([\d.]+), width: ([\d.]+), arms: Object\.freeze\(\[([-\d, ]+)\]\) \}\)/g,
  )]
  assert.equal(found.length, 3, 'the wire tier table is not three rows any more')
  return found.map(([, name, y, sag, width, arms]) => ({
    name,
    y: Number(y),
    sag: Number(sag),
    width: Number(width),
    arms: arms.split(',').map((entry) => Number(entry.trim())),
  }))
}

test('the wire is a real span on a real pole, and every dimension is one', () => {
  // Every number the pass introduced is held to a real range, because a comment
  // saying "a real riser is 170 mm" beside a constant reading 0.2 is a lie the
  // comment cannot prevent. Ranges rather than pins where the range IS the claim,
  // pins where a specific value is.
  const between = (name, low, high) => {
    const value = buildingNumber(name)
    assert.ok(value >= low && value <= high, `${name} is ${value}, which is not between ${low} and ${high}`)
    return value
  }
  // A distribution pole: 8-10 m is the plan's own figure and 190-250 mm the
  // real diameter, which is also what makes it a POLE and not a lamp post.
  const height = between('POLE_HEIGHT', 8, 10)
  between('POLE_DIAMETER', 0.16, 0.28)
  // The crossarm: a real LV arm is 1.6-2.0 m of 80-100 mm timber, and it sits at
  // 88-94% of the shaft — high enough to be clear of the drop.
  const armY = height * between('POLE_ARM_FRACTION', 0.88, 0.95)
  between('POLE_ARM_LENGTH', 1.6, 2)
  between('POLE_ARM_THICKNESS', 0.07, 0.12)
  between('POLE_INSULATOR_SPACING', 0.6, 1)
  between('POLE_INSURATOR_SIZE', 0.08, 0.15)
  // T8's width: a floor of about 1.15 px (the reference's own number) and a cap
  // well under the width the wrong divisor produces, which is 13-28 px.
  const minPx = between('WIRE_MIN_PX', 1, 1.5)
  const maxPx = between('WIRE_MAX_PX', 2, 5)
  assert.ok(maxPx > minPx, 'the width cap is below the minimum width, so the clamp is upside down')
  between('WIRE_COVERAGE_FLOOR', 0.1, 0.3)
  // T7: enough samples that a 64 m span is a curve, and a low span that is
  // VISIBLY low rather than marginally low.
  between('CATENARY_SEGMENTS', 8, 16)
  const lowOneIn = between('LOW_SPAN_ONE_IN', 4, 8)
  const lowMult = between('LOW_SPAN_SAG_MULT', 1.4, 2.2)
  assert.ok(lowOneIn <= 6 && lowMult >= 1.5, 'the low span is one in too many, or not much lower than the rest')
  // The small furniture, at the real dimensions of each.
  between('SIGN_POST_HEIGHT', 2.2, 2.6)
  const plateY = between('SIGN_PLATE_Y', 1.9, 2.2)
  between('SIGN_PLATE_W', 0.4, 0.8)
  between('SIGN_PLATE_H', 0.3, 0.6)
  between('HYDRANT_BODY_H', 0.5, 0.7)
  between('HYDRANT_BONNET_H', 0.1, 0.25)
  between('DRAIN_W', 0.3, 0.5)
  between('DRAIN_D', 0.3, 0.5)
  const bars = buildingNumber('DRAIN_BAR_COUNT')
  assert.ok(bars >= 3 && bars <= 7, `a grate with ${bars} bars is a slot, not a grate`)
  // The gully is in the GUTTER, which means its setback is less than a kerb is
  // wide: anything larger and the grate is on the pavement, which is the single
  // placement mistake this check can make.
  assert.ok(buildingNumber('DRAIN_SETBACK') < 0.4, 'the gully is set back further than the kerb is wide')
  // ...and the sign face is on a post, above the player's eyeline and below the
  // top of it: 2.05 m on a 2.55 m post.
  assert.ok(plateY < buildingNumber('SIGN_POST_HEIGHT'), 'the sign face is above the top of its own post')
  // THE THREE CIRCUITS, as the table rather than as prose. T7's claim is an
  // ORDER — heavier trunk cables sag more than telecom — and an ordering cannot
  // be stated by a presence check.
  const tiers = wireTiers()
  assert.deepEqual(tiers.map((tier) => tier.name), ['trunk', 'secondary', 'telecom'], 'the tiers are not the three T7 names, in order')
  for (const tier of tiers) {
    assert.ok(tier.y > 5.6, `the ${tier.name} tier is at ${tier.y} m, which is down among the rooflines`)
    assert.ok(tier.y < armY, `the ${tier.name} tier at ${tier.y} m is above its own crossarm at ${armY.toFixed(2)} m`)
    assert.ok(tier.sag > 0.005 && tier.sag < 0.05, `the ${tier.name} tier sags ${tier.sag} of its span, which is not a cable`)
    assert.ok(tier.width > 0.01 && tier.width < 0.08, `the ${tier.name} tier is ${(tier.width * 1000).toFixed(0)} mm across`)
  }
  for (let i = 1; i < tiers.length; i += 1) {
    assert.ok(tiers[i - 1].y > tiers[i].y, `${tiers[i - 1].name} is not above ${tiers[i].name} on the pole`)
    assert.ok(tiers[i - 1].sag > tiers[i].sag, `${tiers[i - 1].name} does not sag more than ${tiers[i].name}`)
    assert.ok(tiers[i - 1].width > tiers[i].width, `${tiers[i - 1].name} is not thicker than ${tiers[i].name}`)
  }
  // Six conductors, and the two ends of the arm are carried by exactly one tier
  // each so the top tier's three insulators are not fighting the bottom's.
  const conductors = tiers.reduce((total, tier) => total + tier.arms.length, 0)
  assert.equal(conductors, 6, `the pole carries ${conductors} conductors, and the plan asks for six`)
  // ...and the top tier hangs JUST under the arm, which is the whole of
  // POLE_ARM_FRACTION: the insulator is as tall as the gap.
  const insulator = buildingNumber('POLE_INSURATOR_SIZE')
  assert.ok(armY - tiers[0].y < insulator, 'the top tier is not hanging off the crossarm')
})

test('the six furniture colours are variations on a dark, and none of them is a light', () => {
  // AESTHETIC-NOTES §4: "a surface is a variation on a dark, not a palette", and
  // §12.1's silhouette rule needs every one of them to stay a dark shape against
  // a sodium haze. D6 caps a frame at four saturated things, and the wire is
  // dark because T8's whole argument is that a wire is a silhouette and nothing
  // else — so the values are held to a range rather than admired.
  const luma = (hex) => {
    const r = (hex >> 16) & 0xff
    const g = (hex >> 8) & 0xff
    const b = hex & 0xff
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const keys = ['wire', 'pole', 'poleArm', 'sign', 'hydrant', 'drain']
  const values = keys.map((key) => [key, luma(paletteHex(key))])
  for (const [key, value] of values) {
    assert.ok(value > 10, `PALETTE.${key} is at luma ${value.toFixed(1)}, which is a hole rather than a surface`)
    // Under half the sky (89 after pass 1), or the furniture stops being a
    // silhouette and starts being a light source it was never meant to be.
    assert.ok(value < 89, `PALETTE.${key} is at luma ${value.toFixed(1)}, which is brighter than the sky it is seen against`)
  }
  const wire = values.find(([key]) => key === 'wire')[1]
  const sign = values.find(([key]) => key === 'sign')[1]
  // The wire is the darkest thing in the world after the creature, and the sign
  // is the brightest piece of furniture: the two ends of the pass, stated as an
  // ordering because that is what the palette comment claims.
  for (const [key, value] of values) {
    if (key !== 'wire') assert.ok(value > wire, `PALETTE.${key} is darker than the wire, which is the darkest thing in the world`)
    if (key !== 'sign') assert.ok(value < sign, `PALETTE.${key} is brighter than the sign, which is the brightest furniture`)
  }
  assert.ok(sign - wire < 60, `the furniture spans ${(sign - wire).toFixed(1)} luma, which is a palette rather than a family`)
  // ...and NONE of them is built with `_glow`. A surface that is tone-mapped as
  // if it were lit is a light source on T11's ladder, which has four rungs and
  // no room for a fifth (D6).
  const code = stripProse(STREET_VIEW_SOURCE)
  for (const key of ['pole', 'poleArm', 'painted', 'hydrant', 'drain']) {
    assert.match(
      code,
      new RegExp(`${key}: this\\._material\\(\\{`),
      `the ${key} material is not a lit surface`,
    )
  }
  // The wire is the only `ShaderMaterial` in the file, and the only material
  // whose width is not metres.
  assert.equal((code.match(/new THREE\.ShaderMaterial\(/g) ?? []).length, 1, 'something other than the wire is a ShaderMaterial')
})

section('Water and reflections (iteration 2, pass 8)')

/** Rec. 709 luma of a `PALETTE` key, the measure every palette comment quotes. */
function paletteLuma(key) {
  const hex = paletteHex(key)
  return 0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)
}

/**
 * `waterClaims` — pass 8's claims, as predicates over a source string.
 *
 * The same shape as `dressingClaims` and `furnitureClaims`, and for the same
 * reason: a gate expressed as `assert.ok` can only ever run on the real file, and
 * a gate that can only run on the real file cannot be asked whether it would
 * have caught the bug. Each returns `ok` and a `why`, so a mutation names the
 * claim it broke.
 *
 * These are ABOUT THE SOURCE because three of this pass's properties are
 * invisible to any measurement of the built world: the reflection is DRAWN rather
 * than sampled, so "there is no render target" can only be read out of the file;
 * the shimmer is a function of `this._time` and not of a frame counter, which is
 * visible only as a pattern of what is written; and the streak shares
 * `makePoolTexture` with the sodium pool it reflects, so that a later edit to one
 * cannot leave the other behind.
 *
 * @param {string} source `streetView.js`, comments NOT yet stripped
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function waterClaims(source) {
  const code = stripProse(source)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  // 1. THE HEADLINE, and the only whole-file negative in the set. It is safe as
  // one because the words are unique to the technique and appear nowhere else:
  // pass 6's wire is a `ShaderMaterial` and pass 3's portal is geometry, and
  // neither has ever had a render target. A second camera would be the other way
  // to do a reflection, so both are named.
  claim(
    'the reflection is drawn, not sampled: no render target, no second pass',
    !/WebGLRenderTarget|new THREE\.WebGLRenderTarget|renderTarget/.test(code)
      && !/setRenderTarget/.test(code)
      && !/ReflectionProbe|PMREMGenerator/.test(code),
    'a render target or a second camera is a real reflection, which costs a second pass and breaks the draw-call budget this world is measured against',
  )
  // 2. THE STREAK IS ADDITIVE, and it is the reflection rather than a decal. A
  // `MeshStandardMaterial` streak would be lit by the four point lights and read
  // as a painted stripe; the sodium family is additive everywhere else in this
  // file and this is the one place it has to be again.
  claim(
    'the streak is additive and shares the sodium pool falloff curve',
    /streak: this\._glow\(PALETTE\.waterStreak, \{/.test(code)
      && /map: makePoolTexture\(\{ rim: STREAK_RIM, peak: STREAK_PEAK \}\)/.test(code)
      && /blending: THREE\.AdditiveBlending/.test(code)
      && /fog: true/.test(code),
    'a lit streak is a painted stripe, and a streak with its own falloff curve is a second law of optics for one quad — a reflection and the light it reflects have the same angular falloff',
  )
  // 3. WARM, and this is the AESTHETIC-NOTES authority the brief names: §12.2 is
  // explicit that cyan belongs to the portals alone.
  claim(
    'the reflection is warm, and never the portal colour',
    /waterStreak: 0x([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.test(code)
      && (() => {
        // `parseInt(_, 16)` and NOT `Number(_)`: the capture is the two hex
        // DIGITS as a string, and `Number('ff')` is NaN, so the first version of
        // this claim compared NaN > NaN and reported every reflection cold —
        // including the real one. A gate whose predicate is always false is
        // indistinguishable from a gate that is always green, which is why the
        // mutation below swaps the colour to a genuinely cold one: it has to fail
        // for a reason, not for a NaN.
        const [, r, g, b] = /waterStreak: 0x([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(code)
        return Number.parseInt(r, 16) > Number.parseInt(g, 16) && Number.parseInt(g, 16) > Number.parseInt(b, 16)
      })()
      && !/streak:[\s\S]{0,120}PALETTE\.portal/.test(code),
    'a blue reflection is a second cold light family in a game whose §12.2 contract is that cyan belongs to the portals alone',
  )
  // 4. THE EYE GATE, as source rather than as arithmetic: the peak has to be a
  // named constant applied to the texture, and not a literal. A literal `peak: 1`
  // is a streak at full lamp brightness — a warm additive quad on the ground at
  // the exact luma `tools/png-luma.mjs` flood-fills to find a creature's eye.
  claim(
    'the streak is drawn at a named peak, never at full brightness',
    /peak: STREAK_PEAK/.test(code)
      && /const STREAK_PEAK = 0\.[0-9]+/.test(code)
      && !/makePoolTexture\(\{[^}]*peak: 1[^}]*\}\)/.test(code),
    'a reflection at full `waterStreak` luma is a warm additive blob on the road, and the eye finder takes the brightest compact blob in the frame — so it would measure the reflection and report no creature',
  )
  // 5. THE SHIMMER IS A FUNCTION OF THE CLOCK. An accumulator that sums `dt`
  // drifts by a different amount every run, and `verify-world.mjs` drives the
  // world to the same time twice and requires the offset back bit-identical — an
  // assertion that could not exist at all if this were false.
  claim(
    'the shimmer is a function of the clock, and divides by the tile length',
    /const shimmer = \(t \* CANAL_SHIMMER_MPS\) \/ \(CANAL_LEN \/ CANAL_SHIMMER_TILES\)/.test(code)
      && /this\._materials\.canalWater\.map\.offset\.x = shimmer % 1/.test(code)
      && !/canalWater\.map\.offset\.x \+=/.test(code),
    'a scroll in texture units is 3.7x too fast (one unit is CANAL_LEN / CANAL_SHIMMER_TILES metres) and an accumulator drifts against this._time by a different amount every run',
  )
  // 6. NO UNSEEDED RANDOM, which is D10 stated as a claim over the pass's own
  // methods rather than over the file. `Math.random` appears nowhere in
  // `streetView.js` today, so a whole-file negative would pass for the wrong
  // reason; scoping it to the water methods is what makes it mean "this pass did
  // not add one".
  const water = ['_buildWater', '_addPuddles', '_addPuddle', '_addStreak', '_addCanal', '_waterClear']
    .map((name) => methodBody(code, name)).join('\n')
  claim(
    'the water reads a seeded stream and never an unseeded one',
    water.length > 0
      && /streamAt\(hash32\(this\.seed, ax, az \+ WATER_SALT\), 0, 0\)/.test(water)
      && /hash32\(0x5354524b, ax, az\) % 2 === 0/.test(water)
      && !/Math\.random|Date\.now|performance\.now/.test(water),
    'an unseeded or clocked draw is D10, and it also means a shuffled build produces a different street',
  )
  // 7. EVERY FAMILY IS FILTERED AGAINST THE PORTAL EXCLUSION, which is the
  // structural form of the pass-3 pupil gate (luma <= 20, measured in
  // `portal-located.png` from 4.5 m). A bright additive streak on the road
  // between that camera and the gate does not merely look wrong — it invalidates
  // the gate the whole iteration is measured against.
  claim(
    'both puddles and streaks are filtered against the portal exclusion',
    (code.match(/this\._waterClear\(/g) || []).length >= 2
      && /_waterClear\(x, z, copy\) \{/.test(code)
      && /PORTAL_FURNITURE_CLEAR/.test(methodBody(code, '_waterClear')),
    'the streak is the ADDITIVE element, so filtering only the puddles leaves the one surface that can raise a portal pupil past 20 unfiltered',
  )
  // 8. THE PUDDLE BANDS ARE THE ONLY BANDS, and each band's room is the constant
  // that positioned it. The first version drew one global radius for all three
  // and put a third of the world's puddles on the pavement; the fix is visible
  // here as `room` travelling with the candidate.
  //
  // AND NONE OF THESE PATTERNS MAY NAME A STRING. `stripProse` blanks every
  // literal in the file — it is the same function pass 3 and pass 7's claims use,
  // and it is what lets a negative claim fail on prose instead of on code — so a
  // pattern like `/'gutter',\s*PUDDLE_GUTTER_INSET,/` is matching text that no
  // longer exists and the claim is false for every input. The band NAME is
  // matched by `verify-world.mjs` against `waterLog`, where it is data; here the
  // claim is about the number that travels with it, and the number is enough.
  claim(
    "each band's radius is drawn into the room that band was given",
    /\[cx, cz, yaw, band, room\] of candidates/.test(water)
      && /const span = Math\.max\(0, room - PUDDLE_R_MIN\)/.test(water)
      && /PUDDLE_GUTTER_INSET,\s*\n\s*\]\)/.test(water)
      && /PUDDLE_CROSSING_OFFSET,\s*\n\s*\]\)/.test(water)
      && /PUDDLE_CANAL_SETBACK,\s*\n\s*\]\)/.test(water),
    'one global radius fits the crossing band and overruns the gutter band, and a puddle that reaches past the kerb face is a pond lying on the footway',
  )
  // 9. THE CANAL CROSSES A STREET rather than running along one, which is the
  // brief's own wording and the bug the first version shipped. The claim is on
  // the placement: the channel's LENGTH goes on the axis it runs along and its
  // WIDTH on the axis it is offset by, so swapping the two is a visible edit.
  claim(
    'the canal runs ACROSS a street, not along one',
    /const cx = node\.x \+ CANAL_CANAL_OFFSET/.test(code)
      && /canalWater\.place\(\s*x, waterY, node\.z, CANAL_W, 1, CANAL_LEN,/.test(code)
      && !/const cz = node\.z \+ CANAL_CANAL_OFFSET/.test(code),
    "a channel parallel to the road it drains is a puddle field wearing a channel's name, and this one ran 21 m from the nearest centreline — in a block, between two houses",
  )
  // 10. THE RENDER ORDERS ARE SET, and this is the property no measurement of the
  // built world can find: three.js sorts transparent objects by depth, and at
  // 11 m the four water surfaces are within 2 m of each other. Left to the
  // automatic sort the additive streak lands UNDER the dark halo on about half
  // the frames — a reflection that vanishes as the camera moves, which no single
  // screenshot shows.
  claim(
    'the four water surfaces are given an explicit render order',
    /wetSheen\.mesh\.renderOrder = 1/.test(code)
      && /puddles\.mesh\.renderOrder = 2/.test(code)
      && /canalWater\.mesh\.renderOrder = 3/.test(code)
      && /streaks\.mesh\.renderOrder = 4/.test(code),
    'three.js sorts transparents by depth, so the additive streak lands under the dark halo on some frames and the reflection disappears when the camera moves',
  )
  // 11. THE HALO AND THE WATER SHARE ONE GEOMETRY, which is the second half of
  // the cost argument and the one a triangle count alone would not catch: two
  // pools holding one `BufferGeometry` is one upload, and two pools holding two
  // is two.
  claim(
    'the halo and the water share one geometry object',
    /const wetDisc = disc\(\)/.test(code)
      && /wetDisc, this\._materials\.wetSheen/.test(code)
      && /wetDisc, this\._materials\.puddle/.test(code),
    'two identical 10-gons are two uploads and two VRAM copies for the same 20 triangles',
  )
  // 12. THE SHIMMER MAP REPEATS, because `update()` scrolls it and a clamped edge
  // is a hard seam travelling down the canal. Asserted on the shimmer's own
  // constructor rather than as a file-wide negative, since `makePoolTexture` has
  // the opposite requirement: a radial falloff was never written to tile.
  claim(
    'the shimmer map repeats on both axes, because it is scrolled',
    /function makeShimmerTexture[\s\S]{0,2600}?texture\.wrapS = THREE\.RepeatWrapping\s*\n\s*texture\.wrapT = THREE\.RepeatWrapping/.test(code)
      && /function makeShimmerTexture[\s\S]{0,2600}?texture\.repeat\.set\(repeat, 1\)/.test(code),
    'a clamped edge on a scrolled map is a hard seam travelling down the canal, and the shimmer is the one texture in this file whose offset is animated',
  )
  // 13. THE TILE ACTUALLY TILES, and this is the claim a wrap mode cannot make on
  // its own. Claim 12 says the map is `RepeatWrapping` and repeated 7 times; a
  // texture that does not tile at its own edges produces exactly the hard seam
  // that wrap mode exists to prevent, once per tile, sliding at 0.06 m/s. The
  // wrap mode is the ENABLER of the seam, not the prevention of it.
  //
  // `makeShimmerTexture` is a sum of sines, and a sine tiles seamlessly only at a
  // whole number of cycles across the tile. The pass shipped 2.3 and 4.1 cycles
  // across the width and 1.7 along it — non-integers, chosen so the pattern
  // "does not visibly repeat" — which at `SURFACE_SEEDS.water` leaves the tile
  // wrapping by 70/255 on the scrolled axis against a 7/255 interior step, and
  // 38/255 across it against 20. Seven of those down a 26 m channel.
  //
  // Asserted on the FREQUENCIES rather than on the pixels, because this is a pure
  // gate and the generator is not exported: the source of the shimmer's period
  // is a literal, and an integer is the whole of the claim. The numeric
  // consequence (0 and 255/255 steps) is what the world suite's tileability
  // check measures off the built texture.
  const shimmer = /function makeShimmerTexture[\s\S]*?\n}/.exec(code)
  const cycles = shimmer
    ? [...shimmer[0].matchAll(/Math\.sin\(([uv]) \* Math\.PI \* 2 \* ([\d.]+)/g)]
      .map((match) => ({ axis: match[1], cycles: Number(match[2]) }))
    : []
  claim(
    'the shimmer\'s sine frequencies are whole cycles, so the tile has no seam',
    cycles.length >= 4 && cycles.every((entry) => Number.isInteger(entry.cycles)),
    'a sine at a fractional number of cycles does not meet itself at the tile edge, and on a scrolled RepeatWrapping map that discontinuity is a hard line once per tile — seven down the canal — which is the artefact claim 12 exists to prevent',
  )
  // 14. THE CANAL'S U AXIS IS THE LONG ONE, which is the other half of "the
  // shimmer scrolls down the channel". `update()` scrolls `offset.x`, a
  // texture's U is its X, and `PlaneGeometry(1,1).rotateX(-PI/2)` puts U on the
  // local X — the 1.1 m WIDTH, not the 26 m length. The scroll ran sideways
  // across the channel, 23.6x slower than `CANAL_SHIMMER_MPS` claims.
  //
  // The yaw is asserted here because this is a source-level property of how the
  // pool's geometry is built; `verify-world.mjs` measures the same thing back off
  // the built geometry's UVs, so neither file can be edited alone to make the
  // other agree with a flat plane.
  //
  // The pattern is on the GEOMETRY EXPRESSION and not on the pool's name,
  // because `stripProse` blanks every string literal to `""` and a regex that
  // quoted `'canalWater'` could never match its own file.
  claim(
    'the canal water plane is yawed so its U axis runs along the channel',
    /new THREE\.PlaneGeometry\(1, 1\)\.rotateX\(-Math\.PI \/ 2\)\.rotateY\(Math\.PI \/ 2\)/.test(code),
    'the shimmer scrolls offset.x, and a flat plane puts U across the 1.1 m channel, so the water moves sideways at a twenty-third of the speed the constant promises',
  )
  return claims
}

test('the water and reflections claims hold, and each one is a claim a comment would not', () => {
  const claims = waterClaims(STREET_VIEW_SOURCE)
  assert.ok(claims.length >= 14, `only ${claims.length} claims are defined, which is fewer than this pass needs`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name}: ${entry.why}`)
  }
})

test('every water claim can fail, and a mutation names the one it breaks', () => {
  // Twelve mutations for twelve claims, and the third field says which claim each
  // is expected to break. Asserting the SPECIFIC claim and not merely "some
  // claim" is the part that matters: a mutation that trips an unrelated predicate
  // still proves the suite has teeth, but it does not prove the claim under test
  // has any.
  const mutations = [
    ['a render target', 'a real reflection is a second pass', 'the reflection is drawn, not sampled: no render target, no second pass',
      'wire: makeWireMaterial(this.resolution.x, this.resolution.y),', 'wire: new THREE.WebGLRenderTarget(4, 4),'],
    ['a lit streak', 'a lit streak is a painted stripe', 'the streak is additive and shares the sodium pool falloff curve',
      'streak: this._glow(PALETTE.waterStreak, {', 'streak: this._material({ color: PALETTE.waterStreak,'],
    ['a cold reflection', 'cyan belongs to the portals alone', 'the reflection is warm, and never the portal colour',
      'waterStreak: 0xffb877,', 'waterStreak: 0x6fd8e8,'],
    ['a full-brightness streak', 'a reflection at full luma is a candidate eye', 'the streak is drawn at a named peak, never at full brightness',
      'peak: STREAK_PEAK }', 'peak: 1 }'],
    ['a frame-counted shimmer', 'an accumulator drifts against the clock', 'the shimmer is a function of the clock, and divides by the tile length',
      'const shimmer = (t * CANAL_SHIMMER_MPS) / (CANAL_LEN / CANAL_SHIMMER_TILES)', 'const shimmer = (this._frames++ * CANAL_SHIMMER_MPS) / (CANAL_LEN / CANAL_SHIMMER_TILES)'],
    ['an unseeded draw', 'D10, and a shuffled build changes the street', 'the water reads a seeded stream and never an unseeded one',
      'const rng = streamAt(hash32(this.seed, ax, az + WATER_SALT), 0, 0)', 'const rng = streamAt(Math.random(), 0, 0)'],
    ['an unfiltered streak', 'the additive element is the one that raises a pupil', 'both puddles and streaks are filtered against the portal exclusion',
      'if (!this._waterClear(x, z, copy)) continue', 'if (x + z === 0) continue', 2],
    ['one global puddle radius', 'a gutter puddle is a pond on the footway', "each band's radius is drawn into the room that band was given",
      'const span = Math.max(0, room - PUDDLE_R_MIN)', 'const span = PUDDLE_CROSSING_OFFSET - PUDDLE_R_MIN'],
    ['a canal along the street', 'a channel parallel to its road is a pond in a block', 'the canal runs ACROSS a street, not along one',
      'this.pools.canalWater.place(\n        x, waterY, node.z, CANAL_W, 1, CANAL_LEN,\n      )', 'this.pools.canalWater.place(\n        node.x, waterY, x, CANAL_LEN, 1, CANAL_W,\n      )'],
    ['no render order', 'the streak sorts under the halo', 'the four water surfaces are given an explicit render order',
      'this.pools.streaks.mesh.renderOrder = 4', 'this.pools.streaks.mesh.renderOrder = 0'],
    ['two geometries', 'the same 20 triangles uploaded twice', 'the halo and the water share one geometry object',
      "names, 'puddles', wetDisc, this._materials.puddle", "names, 'puddles', disc(), this._materials.puddle"],
    ['a clamped shimmer', 'a hard seam travels down the canal', 'the shimmer map repeats on both axes, because it is scrolled',
      'texture.wrapS = THREE.RepeatWrapping\n  texture.wrapT = THREE.RepeatWrapping\n  texture.repeat.set(repeat, 1)', 'texture.wrapS = THREE.ClampToEdgeWrapping\n  texture.wrapT = THREE.ClampToEdgeWrapping\n  texture.repeat.set(repeat, 1)'],
    ['a fractional shimmer cycle', 'a sine at 2.3 cycles does not meet itself at the tile edge', "the shimmer's sine frequencies are whole cycles, so the tile has no seam",
      'Math.sin(v * Math.PI * 2 * 2.0 + phase * 1.7) * 0.32', 'Math.sin(v * Math.PI * 2 * 2.3 + phase * 1.7) * 0.32'],
    ['a flat canal plane', 'the shimmer scrolls sideways across the channel', 'the canal water plane is yawed so its U axis runs along the channel',
      "names, 'canalWater', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2)", "names, 'canalWater', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)"],
  ]
  for (const [label, why, claim, from, to, expectedHits = 1] of mutations) {
    assert.ok(STREET_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches streetView.js, so it is not testing anything`)
    // EXACTLY `expectedHits`, and this is not pedantry. `replace` with a string
    // pattern rewrites the FIRST match, and `STREET_VIEW_SOURCE` is the raw file,
    // so a fragment quoted in a doc comment is rewritten instead of the code and
    // the mutation is a no-op — `waterClaims` then reports the mutated build as
    // clean, and the test fails with "broke [nothing]", which reads like the
    // claim is unbreakable when in fact nothing was changed. The first version of
    // the unseeded-draw mutation quoted the `streamAt(hash32(...))` call that
    // its own WATER_SALT doc comment also quotes, and did exactly this.
    //
    // The one mutation that declares 2 is 'an unfiltered streak': the call it
    // removes is in `_addPuddles` AND in `_addStreak`, the claim counts them, and
    // dropping one of two is the failure. That is a fact about the code and not a
    // licence, so the count is stated per mutation and every other one stays at 1.
    const hits = STREET_VIEW_SOURCE.split(from).length - 1
    assert.equal(hits, expectedHits, `the mutation "${label}" matches ${hits} places in streetView.js, not ${expectedHits}; \`replace\` would rewrite only the first, which may be a comment`)
    const broken = waterClaims(STREET_VIEW_SOURCE.replace(from, to)).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === claim),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ') || 'nothing'}] rather than [${claim}] — ${why}`,
    )
  }
})

test('the water constants are real dimensions, and the streak cannot out-shine an eye', () => {
  // Every number this pass introduced is held to a real range, for the reason
  // pass 6's are: a comment saying "a real 側溝 is 300-600 mm" beside a constant
  // reading 1.1 is a lie the comment cannot prevent.
  const between = (name, low, high) => {
    const value = buildingNumber(name)
    assert.ok(value >= low && value <= high, `${name} is ${value}, which is not between ${low} and ${high}`)
    return value
  }
  // A drainage channel (側溝) is 300-900 mm of water in a precast U, so the OUTSIDE
  // is 450-1,200 mm and 1.1 m is the real figure. It is also the minimum that
  // reads at 11 m: below about 0.8 m a channel is a line, and above about 2 m it
  // is a river the player has to walk around.
  const width = between('CANAL_W', 0.8, 1.6)
  const length = between('CANAL_LEN', 12, 40)
  assert.ok(length > width * 10, `the channel is ${length} m long and ${width} m wide, which is a puddle rather than a crossing`)
  // The lips have HEIGHT and the water sits below them: a flat dark line on a
  // road is a painted line, and no amount of shimmer makes it water.
  const lip = between('CANAL_LIP_H', 0.06, 0.2)
  const depth = between('CANAL_DEPTH', 0.03, lip)
  assert.ok(depth < lip, `the channel is ${depth} m deep inside a ${lip} m lip, so the water is above its own walls`)
  // A 10-gon: below about 8 the silhouette is visibly a polygon at 11 m, and
  // above about 16 the extra triangles buy a sub-pixel improvement.
  between('PUDDLE_SEGMENTS', 8, 16)
  // The three ROOMS, and they are the whole of the size story now that there is
  // no global `PUDDLE_R_MAX`. Each is the same constant that positioned its band,
  // and each has to be small: the biggest is the crossing band's, and a puddle
  // wider than the road it stands in is a lake.
  const gutterRoom = between('PUDDLE_GUTTER_INSET', 0.3, 1.2)
  between('PUDDLE_CROSSING_OFFSET', 1.2, 3.0)
  between('PUDDLE_CANAL_SETBACK', 0.4, 1.5)
  assert.ok(buildingNumber('PUDDLE_R_MIN') < gutterRoom, `the smallest puddle is ${buildingNumber('PUDDLE_R_MIN')} m and the gutter band has ${gutterRoom} m of room, so every gutter puddle is the same size`)
  // The ELONGATION: 1.9 is an ellipse and 4x would be a lens. Below 1.4 a gutter
  // puddle is a circle in a straight channel, which is a painted disc.
  between('PUDDLE_ELONGATION', 1.4, 3.0)
  // The streak: long, narrow, and inside the carriageway. The inset is measured
  // from the kerb face, so it has to be under the half-width or the streak is on
  // the footway — which is exactly where the first version put all 147 of them.
  const len = between('STREAK_LEN', 4, 14)
  const wide = between('STREAK_W', 0.6, 2.5)
  assert.ok(len > wide * 4, `the streak is ${len} x ${wide} m, which is a smear and not a streak`)
  between('STREAK_ROAD_INSET', 0.5, 3)
  // The halo spread and opacity: below about 1.5 the halo is invisible against
  // the puddle it is meant to extend, and above 2.2 it is a second, larger
  // puddle. The opacity is a BLEND, so it can never reach 1.
  between('PUDDLE_HALO_SPREAD', 1.5, 2.2)
  const opacity = between('PUDDLE_HALO_OPACITY', 0.3, 0.7)
  assert.ok(opacity < 1, 'the halo is opaque, so a wet road is a painted circle of wetSheen')
  // The two LIFTS and the gap between them. The halo has to be above the road
  // plane or it z-fights with it, and the water above the halo or the halo draws
  // over the puddle. Four millimetres is 8% of the camera's 0.05 m near plane,
  // which is well outside the depth buffer's error at any distance a player
  // stands — and pass 6's grate is the thing this must not float above.
  const haloLift = between('PUDDLE_HALO_LIFT', 0.005, 0.02)
  between('PUDDLE_LIFT_GAP', 0.002, 0.02)
  assert.ok(haloLift > buildingNumber('DRAIN_LIFT'), "the water sits higher than pass 6's drain grate, so this pass raised the ground")
  // THE SHIMMER RATE, and it is the number the brief's "slow" hangs on. 0.06 m/s
  // takes 433 s to move the channel's own length, so the loop is unobservable;
  // above about 0.5 m/s a player watching for four seconds sees a whole tile.
  const mps = between('CANAL_SHIMMER_MPS', 0.02, 0.2)
  const tiles = between('CANAL_SHIMMER_TILES', 3, 12)
  assert.ok(length / mps > 120, `the canal takes ${(length / mps).toFixed(0)} s to move its own length, which a player can watch`)
  assert.ok(tiles > 2, `${tiles} tiles along the canal is not enough structure to read as moving water at 11 m`)
  // THE STREAK'S PEAK IS THE EYE GATE, asserted here as arithmetic against the
  // same 150 `tools/png-luma.mjs` flood-fills to, as well as against the built
  // material in `verify-world.mjs`. Two places, because a streak that out-greened
  // the creature's eye would make `creatureContrast` measure the body of nothing
  // and report no creature in `creature-stalking.png`.
  const peak = paletteLuma('waterStreak') * buildingNumber('STREAK_PEAK')
  assert.ok(peak < 150, `a streak peaks at luma ${peak.toFixed(1)} and EYE_MIN is 150`)
  // ...and a FLOOR, because a ceiling alone is satisfied by a streak too dim to
  // see, which is the same vacuous pass in the other direction.
  assert.ok(peak > 60, `a streak peaks at luma ${peak.toFixed(1)}, too dim to read as a reflection of a ${paletteLuma('sodium').toFixed(0)} lamp head`)
  assert.ok(buildingNumber('STREAK_PEAK') <= 1, 'STREAK_PEAK is above 1, so the streak ADDS light to itself')
  // The reflection is a paler sodium than the lamp, which is what a second
  // interface does to it — and it is a NEW colour rather than `sodium` reused, so
  // a later edit to the lamp cannot silently repaint the reflection.
  assert.notEqual(paletteHex('waterStreak'), paletteHex('sodium'), 'the reflection reuses the lamp colour, so editing one repaints the other')
  assert.ok(paletteLuma('waterStreak') > paletteLuma('sodium'), 'a reflection is paler than its source, so waterStreak must be lighter than sodium')
  // The three dark values, and the ORDER of them: a puddle is darker than the
  // road, the wet halo darker than the puddle, and all three darker than the
  // asphalt. A wet road lighter than a dry one is a rendering error.
  for (const key of ['puddle', 'wetSheen', 'canalBed']) {
    assert.ok(paletteLuma(key) < paletteLuma('asphalt'), `PALETTE.${key} is luma ${paletteLuma(key).toFixed(1)} and the asphalt is ${paletteLuma('asphalt').toFixed(1)}, so water is lighter than the road it sits in`)
  }
  assert.ok(paletteLuma('wetSheen') < paletteLuma('puddle'), 'the wet halo is lighter than the water, so a wet road reads as a dry one with a stain on it')
  console.log(`\n  water constants: streak peak luma ${peak.toFixed(1)} (EYE_MIN 150), channel ${length} x ${width} m, shimmer ${mps} m/s over ${(length / mps).toFixed(0)} s`)
})

section('Captures and cleanup (v2 slice 16)')


const SRC_SOURCES = readdirSync(new URL('./src', import.meta.url), {
  recursive: true,
  encoding: 'utf8',
}).filter((name) => name.endsWith('.js') || name.endsWith('.jsx'))

test('v1 is deleted, and nothing in src/ can reach for it', () => {
  for (const name of ['game/maze.js', 'game/loop.js']) {
    assert.equal(existsSync(new URL(`./src/${name}`, import.meta.url)), false, `${name} is still on disk`)
  }
  // BEFORE 18 / AFTER 19 (iteration 2, pass 9). The pin is EXACT rather than a
  // floor, and that is what makes it useful: a floor would still be satisfied by
  // a walk that found half the tree, and this number is the claim that it did
  // not. Adding a module is therefore a deliberate act — the pin moves in the
  // same commit as the file, which is the whole point of pinning it. Pass 9's
  // `skyView.js` is the nineteenth: the sky, in the same §15.1 split as
  // `streetView` and `creatureView`, and the first view whose frame of reference
  // is the camera rather than the world.
  assert.equal(SRC_SOURCES.length, 19, `src/ has ${SRC_SOURCES.length} sources — the walk may be broken, or a module arrived without moving this pin`)
  for (const name of SRC_SOURCES) {
    const text = readFileSync(new URL(`./src/${name}`, import.meta.url), 'utf8')
    // an import is a failure; a sentence remembering v1 is not, and there are
    // quite a few of those left in the headers
    assert.equal(
      /from\s+['"][^'"]*(maze|loop)\.js['"]/.test(text),
      false,
      `${name} imports a deleted v1 module`,
    )
  }
})

test('PHASE and the store survived v1 in a module that owns nothing else', () => {
  // the two things `loop.js` still had at the end, and the reason they are in
  // their own file rather than in `hud.js` (a projection holds no state) or in
  // `world.js` (which imports Three.js, so the gate could not assert §10.5)
  const store = readFileSync(new URL('./src/game/store.js', import.meta.url), 'utf8')
  assert.equal(/^import /m.test(store), false, 'store.js imports something, and must stay pure')
  for (const name of ['PHASE', 'createStore', 'createStartStore']) {
    assert.match(store, new RegExp(`export (?:function|const) ${name}\\b`))
  }
  // and the three entry points that need them all read the same module
  for (const [file, pattern] of [
    ['./src/App.jsx', /from '\.\/game\/store\.js'/],
    ['./src/ui/Hud.jsx', /from '\.\.\/game\/store\.js'/],
    ['./src/game/world.js', /from '\.\/store\.js'/],
  ]) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), pattern, `${file} does not read store.js`)
  }
})

test("the capture set is §16.5's twelve, in order, plus responsive and pause", () => {
  assert.deepEqual(
    [...capture.CAPTURE_IDS],
    [
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
      'responsive',
      'pause',
    ],
  )
  assert.deepEqual([...capture.TWELVE_CAPTURE_IDS], [...capture.CAPTURE_IDS].slice(0, 12))
  assert.deepEqual([...capture.EXTRA_CAPTURE_IDS], ['responsive', 'pause'])
  assert.equal(capture.CAPTURE_VIEWS.length, 14, 'a view was added or lost')
  assert.equal(new Set(capture.CAPTURE_IDS).size, 14, 'two views share an id')
  assert.equal(new Set(capture.CAPTURE_VIEWS.map((view) => view.label)).size, 14, 'two views share a label')
  for (const view of capture.CAPTURE_VIEWS) {
    assert.ok(view.label.length > 20, `${view.id} has no label a reviewer can read`)
    assert.ok(view.steps.length > 0, `${view.id} has no steps`)
    // twelve of the fourteen are the comparison size; the responsive one is the
    // exception and it is the only exception
    const expected = view.id === 'responsive' ? capture.RESPONSIVE_VIEWPORT : capture.CAPTURE_VIEWPORT
    assert.deepEqual({ ...view.viewport }, { ...expected }, `${view.id} is captured at the wrong size`)
  }
  assert.equal(capture.CAPTURE_DIR, 'benchmark/screenshots')
  // The lit floor is a calibrated constant, not a tunable, and the calibration
  // only holds if it stays inside a gap that was measured rather than assumed:
  // the bug's frames reached 3.09%, the fixed world starts at 13.96%. Both sides
  // are in `benchmark/captures.json` next to the constant they justify.
  assert.ok(
    capture.CAPTURE_MIN_LIT > 0.0309 && capture.CAPTURE_MIN_LIT < 0.1396 * 0.5,
    'the lit floor has drifted out of the gap between the broken frames and the fixed world',
  )
  // §16.5.1's title is a full-bleed card over the street, so it is measured
  // against its own floor. Two things have to hold for that to be an exception
  // rather than a hole: the number still rejects every frame the original bug
  // produced (3.09% was the worst of them), and no other view may ask for it —
  // a floor that spreads is a floor that has stopped meaning anything.
  assert.ok(
    capture.TITLE_MIN_LIT > 0.0309 && capture.TITLE_MIN_LIT < capture.CAPTURE_MIN_LIT,
    'the title floor must still reject a black frame, and must be lower than the street floor',
  )
  const lowered = capture.CAPTURE_VIEWS.filter((view) => view.minLit !== undefined)
  assert.deepEqual(
    lowered.map((view) => view.id),
    ['title'],
    'only the title view may carry its own floor',
  )
  assert.equal(capture.captureView('title').minLit, capture.TITLE_MIN_LIT)
  for (const view of capture.CAPTURE_VIEWS) {
    if (view.id === 'title') continue
    assert.equal(
      view.minLit,
      undefined,
      `${view.id} declares a floor of ${view.minLit} instead of the street's ${capture.CAPTURE_MIN_LIT}`,
    )
  }
  assert.equal(capture.captureView('street').id, 'street')
  assert.equal(capture.captureView('nope'), null, 'an unknown id must answer null, not throw')
})

test('every capture step is a verb the interpreter implements, and nothing else', () => {
  // the vocabulary and the interpreter are allowed to drift from each other only
  // in one direction: an op nobody implements is a view that cannot be taken, and
  // a case the interpreter handles that is not in the vocabulary is a rule with no
  // written-down meaning. Both are read off the source, because the interpreter is
  // browser code the gate cannot import.
  const page = readFileSync(new URL('./capture/main.jsx', import.meta.url), 'utf8')
  const used = new Set(capture.allSteps().map((entry) => entry.step.op))
  for (const op of used) {
    assert.ok(capture.CAPTURE_OPS.includes(op), `capture.js uses an op outside the vocabulary: ${op}`)
  }
  for (const op of capture.CAPTURE_OPS) {
    assert.match(page, new RegExp(`case '${op}'`), `capture/main.jsx does not implement the op ${op}`)
  }
  // and the shape of each step is the shape the interpreter switches on
  for (const { view, step } of capture.allSteps()) {
    const keys = Object.keys(step).filter((key) => key !== 'op')
    switch (step.op) {
      case 'wait':
        assert.ok(step.seconds > 0, `${view}: a wait of ${step.seconds} s`)
        assert.deepEqual(keys, ['seconds'], `${view}: wait takes only seconds`)
        break
      case 'frames':
        assert.ok(step.count >= 1, `${view}: a wait of ${step.count} frames`)
        assert.deepEqual(keys, ['count'], `${view}: frames takes only count`)
        break
      case 'hold':
        assert.match(step.key, /^Key[A-Z]$/, `${view}: ${step.key} is not a key code`)
        assert.ok(step.seconds > 0, `${view}: a hold of ${step.seconds} s`)
        break
      case 'goto':
        assert.ok(
          ['node', 'avenue', 'lamp', 'hammer', 'portal', 'exit', 'spawn'].includes(step.target),
          `${view}: unknown target`,
        )
        assert.ok(step.back >= 0, `${view}: a negative stand-off distance`)
        if (step.target === 'portal') {
          assert.ok(hood.PORTAL_IDS.includes(step.id), `${view}: ${step.id} is not a portal`)
        }
        break
      case 'creature':
        assert.ok(beast.CREATURE_STATES.includes(step.state), `${view}: ${step.state} is not a §6.1 state`)
        assert.ok(step.metres > 0, `${view}: a creature at ${step.metres} m`)
        // §7.4's reach and §6.6's capture radius are the two numbers a
        // hand-placed figure has to respect or the shot is not what it says
        if (step.state === 'stalk') {
          assert.ok(step.metres > beast.CAPTURE_RADIUS, `${view}: a stalk inside the capture radius`)
        }
        break
      default:
        assert.deepEqual(keys, [], `${view}: ${step.op} takes no arguments`)
    }
  }
})

test('no capture does an Act II thing before the hammer is held (§8.1)', () => {
  // §8.1: the Act I creature is a telegraph with no capture path, so a view that
  // swings, banishes or gets caught without the pickup has photographed a state
  // the game cannot reach. This is the check that keeps the gallery honest about
  // the game's own rules rather than about what the interpreter can force.
  for (const view of capture.CAPTURE_VIEWS) {
    const ops = view.steps.map((step) => step.op)
    const hammerAt = ops.indexOf('takeHammer')
    if (hammerAt < 0) {
      // Act I views are fine — a portal hold and a dark street are Act I — but
      // none of them may reach for a hunter, a swing or a capture
      for (const actII of ['creature', 'caught', 'swing']) {
        assert.equal(ops.includes(actII), false, `${view.id} reaches into Act II with no hammer in it`)
      }
      continue
    }
    for (const actII of ['creature', 'caught', 'swing']) {
      const at = ops.indexOf(actII)
      if (at < 0) continue
      assert.ok(hammerAt < at, `${view.id}: ${actII} comes before the pickup`)
    }
  }
  // the finale is reached through real shutdowns, never by writing the flag
  for (const view of capture.CAPTURE_VIEWS) {
    const ops = view.steps.map((step) => step.op)
    if (!ops.includes('win')) continue
    assert.ok(ops.includes('shut'), `${view.id}: wins without shutting three portals down`)
    assert.ok(ops.indexOf('shut') < ops.indexOf('win'), `${view.id}: wins before the shutdowns`)
  }
  // and the title screen is the one view that must never have pressed START
  assert.equal(capture.captureView('title').steps.some((step) => step.op === 'begin'), false)
})

test('at least one view in the gallery is staged so the creature lays a trail', () => {
  // THE PASS-10 REVIEW FINDING, as a gate.
  //
  // Pass 10 built the viscous trail and wrote nineteen mutations and four world
  // checks for it, and every one of them passed — against a gallery in which the
  // trail appears NOWHERE. `creature-chasing` photographed a chase after 0.3 s,
  // and a mark needs `DRIP_STRIDE_METRES` 0.9 m of walking, which at tier 0's
  // 2.2 m/s is 1.48 s: the one frame named for the chase was the frame in which
  // the feature was arithmetically impossible. `creature-stalking` (0.35 s) was
  // 0.05 m short of the same line.
  //
  // And `banish` is the trap this check has to be careful about, because it DOES
  // cross the line — 0.45 s is 0.99 m, just over the 0.9 m stride — and its one
  // mark is still in no picture. It is laid at the creature's own feet, 1.0 m
  // from a camera 1.6 m up, which projects to y=1213 in a 720-tall frame: 493 px
  // BELOW the bottom edge. Time alone is therefore not the property. A mark laid
  // under the camera is a mark nobody has ever seen, and a gate that counted
  // seconds would have passed `banish` and declared pass 10 photographed.
  //
  // So the floor here is deliberately the weaker of the two claims — enough
  // world-time for the reducer to lay a mark AT ALL — and `verify-world.mjs` owns
  // the stronger one, on the built world, where it can project the mark and ask
  // whether it lands inside the frame. Splitting them that way is the point: the
  // pure side cannot see a camera, and pretending otherwise is how a feature ends
  // up measured by a gate that cannot fail.
  //
  // WHY "AT LEAST ONE" AND NOT "EVERY VIEW"
  // ---------------------------------------
  // Because the three creature views photograph three different beats and only one
  // of them is a moment where a trail belongs. `creature-stalking` is a silhouette
  // held at the edge of vision, framed to a measured contrast ratio of 0.607
  // against a 0.62 floor — 0.013 of headroom, the tightest margin in the
  // repository. Making it walk would move the figure out of the sodium pool that
  // view exists to stand it in. `banish` is a connected swing at 1.9 m and §7.4's
  // beat is the dismissal, not a decal. Demanding a trail of both would be a gate
  // only satisfiable by wrecking two good frames.
  const views = capture.CAPTURE_VIEWS.filter((view) => view.steps.some((step) => step.op === 'creature'))
  assert.ok(views.length > 0, 'no view stages a creature, so this check can never fire')
  // The world-time a view hands the creature AFTER it is placed. `begin` settles
  // 1.5 s before the player exists and the creature is placed after that, so only
  // the waits following the placement count.
  const walkSeconds = (view) => {
    const at = view.steps.findIndex((step) => step.op === 'creature')
    return view.steps.slice(at + 1)
      .filter((step) => step.op === 'wait')
      .reduce((total, step) => total + step.seconds, 0)
  }
  // The speed is §11.1's own ramp read through its own accessor rather than a
  // literal, because a literal here is a second copy of the chase speed that
  // drifts from the table the moment §11.1 is retuned — and a gate whose constant
  // is a copy of the thing it gates can be green and wrong at once. Every
  // creature view is a tier-0 staging (none shuts a portal first), so this is the
  // row the captures actually run at.
  const speed = beast.rampAt(0).speed
  const carriers = views.filter((view) => speed * walkSeconds(view) >= beast.DRIP_STRIDE_METRES)
  assert.ok(
    carriers.length > 0,
    'no view in the gallery is staged long enough for the creature to lay a single trail ' +
      `mark, so pass 10's viscous trail is in no frame of the set: a creature view needs ` +
      `at least ${(beast.DRIP_STRIDE_METRES / speed).toFixed(2)} s of walk after the creature is ` +
      `placed (DRIP_STRIDE_METRES ${beast.DRIP_STRIDE_METRES} m at tier 0's ${speed} m/s). ` +
      views.map((view) => `${view.id}: ${walkSeconds(view).toFixed(2)} s`).join(', '),
  )
  const carried = walkSeconds(carriers[0])
  console.log(
    `\n  capture staging: long enough to lay a mark in ${carriers.map((view) => view.id).join(', ')} ` +
      `(${carried.toFixed(2)} s = ${(speed * carried).toFixed(2)} m against a ` +
      `${beast.DRIP_STRIDE_METRES} m stride); whether those marks land inside the frame is ` +
      "verify-world.mjs's 'the trail is in a picture' check",
  )
})

test('the gallery in the repository is the gallery the design asks for', () => {
  // the anti-rotation check. A view that stops being photographed leaves a stale
  // PNG behind, and a stale PNG in a results README is a claim about a build that
  // no longer exists — so the file has to be there, and it has to be a frame.
  // 20 KB is well under any real 1280x720 night-street capture (they land around
  // 300-700 KB) and well over a solid-colour one (a few KB).
  const MIN_PNG_BYTES = 20 * 1024
  for (const id of capture.CAPTURE_IDS) {
    const file = new URL(`./${capture.CAPTURE_DIR}/${id}.png`, import.meta.url)
    assert.equal(existsSync(file), true, `${id}.png is missing — run npm run capture`)
    const bytes = statSync(file).size
    assert.ok(bytes > MIN_PNG_BYTES, `${id}.png is ${bytes} bytes, which is a blank frame, not a capture`)
  }
  // and the report the harness writes has to agree with the same list, so a run
  // that captured eleven of fourteen cannot be presented as fourteen
  const report = new URL('./benchmark/captures.json', import.meta.url)
  assert.equal(existsSync(report), true, 'benchmark/captures.json is missing — run npm run capture')
  const parsed = JSON.parse(readFileSync(report, 'utf8'))
  assert.deepEqual(
    parsed.captures.map((entry) => entry.id),
    [...capture.CAPTURE_IDS],
    'the capture report does not match §16.5',
  )
  for (const entry of parsed.captures) {
    assert.equal(entry.status, 'captured', `${entry.id} is ${entry.status}: ${entry.error ?? ''}`)
  }
  assert.equal(parsed.failed, 0, `${parsed.failed} captures failed`)
})

test('every view in the gallery photographs street furniture, and the report proves it', () => {
  // The pass-7 finding, in the place it has to be enforced.
  //
  // Pass 7 shipped fifteen pools of street furniture and six world checks, and
  // every one of those checks reads a COUNT or a placement RULE. Both are blind to
  // the camera: "a machine has exactly one liner" is true of a machine standing
  // in the next district with its back to the lens, and "nothing stands in a
  // carriageway" is a statement about the kerb rather than about the photograph.
  // So the pass satisfied all six of its own gates while the fourteen committed
  // frames showed a street with no dumpster, no bike, no machine, no shelter and
  // no poster anywhere in frame — and the only evidence in the repository said
  // "15 pools, 0 overflow, all families placed".
  //
  // This gate reads the counts the photographer measured through the real camera
  // (`sightline` in `capture/main.jsx`) back out of the committed report, so the
  // gallery's furniture claim is checkable by a machine and not by a reader who
  // happens to open fourteen PNGs. Three things are asserted, and they are
  // asserted SEPARATELY on purpose:
  //
  //   1. the measurement is PRESENT — a report from before this gate existed has
  //      no `furniture` key, and "the check silently passed because the field was
  //      missing" is the exact failure this whole review is about. `undefined`
  //      compared against a number fails loudly, which is the point.
  //   2. the counts clear the floors in `capture.js`, which the harness ALSO
  //      enforced at capture time. Redundant by design: the harness stops a bad
  //      frame being written, and this stops a bad report being committed.
  //   3. the gallery as a whole shows EVERY family, so "two pieces of two kinds"
  //      cannot be satisfied fourteen times by the same lit vending machine. This
  //      is the claim that is really being made by the word "street furniture",
  //      and it is the one a per-view floor structurally cannot express.
  const report = new URL('./benchmark/captures.json', import.meta.url)
  assert.equal(existsSync(report), true, 'benchmark/captures.json is missing — run npm run capture')
  const parsed = JSON.parse(readFileSync(report, 'utf8'))
  // TWO sets, because "in frame" and "legible" are different claims and one
  // variable cannot honestly hold both — see the set-theoretic section below.
  const seenInFrame = new Set()
  const seenLegible = new Set()
  for (const entry of parsed.captures) {
    const measured = entry.furniture
    assert.ok(measured, `${entry.id} has no furniture measurement — the report predates the pass-7 gate; run npm run capture`)
    assert.equal(
      measured.pools,
      capture.FURNITURE_POOLS.length,
      `${entry.id} measured ${measured.pools} pools, and the list is ${capture.FURNITURE_POOLS.length}`,
    )
    assert.ok(
      measured.legible >= capture.FURNITURE_MIN_ON_SCREEN,
      `${entry.id} shows ${measured.legible} legible piece(s) of pass-7 furniture, floor ${capture.FURNITURE_MIN_ON_SCREEN}: ` +
        capture.describeSightline(measured),
    )
    assert.ok(
      measured.kinds >= capture.FURNITURE_MIN_FAMILIES,
      `${entry.id} shows furniture of ${measured.kinds} kind(s), floor ${capture.FURNITURE_MIN_FAMILIES}: ` +
        capture.describeSightline(measured),
    )
    for (const [kind, counts] of Object.entries(measured.byKind)) {
      // `ok` and not `equal`, because this file's `assert.equal` is
      // (actual, expected, message) — a boolean inequality written through it
      // becomes a comparison of `true` against the MESSAGE STRING, which fails
      // with a diff between `true` and the sentence explaining the failure. The
      // first version of this line did exactly that.
      assert.ok(
        counts.legible <= counts.pieces,
        `${entry.id}: ${kind} reports ${counts.legible} legible out of ${counts.pieces} pieces, so legible is not a subset`,
      )
      if (counts.pieces > 0) seenInFrame.add(kind)
      if (counts.legible > 0) seenLegible.add(kind)
    }
    // A piece at zero distance would be a division by zero in the probe, and one
    // at exactly the near plane would be a piece the lens cannot see. The probe
    // rejects both, so a `nearest` of null is the honest "nothing in the frustum"
    // and must not be silently read as a number.
    if (measured.legible > 0) {
      assert.ok(measured.nearest > 0, `${entry.id} reports furniture at ${measured.nearest} m, which is not a distance`)
    }
  }
  // And the set-theoretic claim, in TWO parts, because the measurement says two
  // different things and conflating them is how a gate starts lying.
  //
  // Every family must be IN FRAME somewhere. That is the claim the pass actually
  // makes about the map, and a gallery that never puts a bicycle in a single
  // frame is not evidence that this pass put a bicycle on a street.
  //
  // But "in frame" is NOT "legible", and the difference is the whole point of the
  // 3 px floor. Measured on this seed: a trash bag peaks at 1.66 px of radius and
  // a bicycle frame at 1.93 px, in ANY of the fourteen views, because the nearest
  // bag is 46 m out and the nearest bike is 121 m — while a bin reaches 18.74 px
  // and a bollard 19.48 px from the same corners. So the legible set is FIVE
  // families and the in-frame set is SEVEN, and a gate demanding legibility from
  // all seven would be demanding a re-composition of the entire gallery to pass a
  // correctness check. Demanding the impossible is not a stricter gate; it is a
  // gate that gets deleted the first time it is inconvenient.
  //
  // So: all seven in frame (the pass's claim), and the legible ones enumerated
  // (the floor's claim). If a future pass brings a bike close enough to read, the
  // list below is the place to notice and the assertion below is the one to
  // tighten — and tightening it will fail on the measured `maxPx`, not on a
  // comment, because the number is in the report.
  for (const family of capture.FURNITURE_FAMILIES) {
    assert.ok(
      seenInFrame.has(family.kind),
      `no view in the gallery puts a ${family.kind} in frame at all: the fourteen frames between them never show one of the ` +
        `${family.pools.join('/')}, so the pass placed it somewhere nobody photographed`,
    )
  }
  for (const kind of ['dumpster', 'vending', 'shelter', 'bollard', 'poster']) {
    assert.ok(
      seenLegible.has(kind),
      `the gallery no longer shows a legible ${kind}: it was in at least one view when this gate was written, ` +
        'and a piece that has dropped below the legibility floor is furniture the reader cannot see',
    )
  }
  // ...and the two that are legitimately in frame but not legible are named, with
  // their measured best, so "no view shows a bicycle legibly" is a recorded fact
  // about this build rather than a gap a reader has to notice on their own.
  for (const kind of ['trashBag', 'bike']) {
    assert.ok(
      seenInFrame.has(kind),
      `a ${kind} is in no view at all, so this is a placement change and not a legibility one`,
    )
  }
  // The floors themselves are floors, not zeroes. A gate whose threshold is 0
  // asserts nothing and reads as coverage; these are the numbers a reviewer would
  // otherwise have to take on trust, and `verify.mjs` has no business trusting a
  // constant it is also the only consumer of.
  assert.ok(capture.FURNITURE_MIN_ON_SCREEN >= 2, 'the furniture floor is under two pieces, so one object passes a view')
  assert.ok(capture.FURNITURE_MIN_FAMILIES >= 1, 'the furniture floor is zero kinds, so a view needs no furniture at all')
  assert.ok(
    capture.FURNITURE_MIN_LEGIBLE_PX >= 2,
    'the legibility floor is under two pixels of radius, so a sub-pixel smudge counts as furniture',
  )
  // The families and the pools are derived from each other, and the gate above
  // reads both, so a family that lists a pool twice would double-count one pool's
  // pieces into two kinds and manufacture coverage.
  assert.equal(
    new Set(capture.FURNITURE_POOLS).size,
    capture.FURNITURE_POOLS.length,
    'two furniture families claim the same pool, so one object can satisfy two kinds',
  )
  for (const family of capture.FURNITURE_FAMILIES) {
    assert.ok(family.pools.length > 0, `the ${family.kind} family lists no pool, so it can never be measured`)
  }
})



// ---------------------------------------------------------------------------
// iteration 2, pass 9 — SKY & ATMOSPHERE
//
// WHY THIS SECTION IS MOSTLY SOURCE
// ---------------------------------
// Three of the pass's four properties are invisible to any measurement of the
// built world, and the two harnesses between them cannot reach all of them.
//
//  - The horizon is `fog: false` and hazed BY HAND. Whether that hand-mix is
//    `HORIZON_HAZE` or a hard-coded 0.5 is a property of a line of code; the
//    built world only shows the result, and a result can be reached two ways.
//  - The render ORDER is what makes the moon "occluded by haze" and what keeps
//    the whole sky behind the world. Both are assignments, not geometry.
//  - The ash's exclusion from the portal's pupil ray is a HEIGHT, and the
//    relationship between that height and the gate's is arithmetic on two
//    constants that live in two different files.
//
// So the claims live here as `skyClaims`, the same shape as `waterClaims`, with
// the same mutation table, and the two properties that ARE properties of the
// built scene — the ring's radius and the measured luma budget — are measured in
// `verify-world.mjs` instead of being asserted here a second time.
// ---------------------------------------------------------------------------

section('Sky and atmosphere (iteration 2, pass 9)')

/** `skyView.js` read as text: it touches Three.js, so §15.1's seam holds here too. */
const SKY_VIEW_SOURCE = readFileSync(new URL('./src/game/skyView.js', import.meta.url), 'utf8')

/**
 * `skyNumber` — a named constant out of `skyView.js`, read from the source.
 *
 * The same reason `waterNumber` exists in `verify-world.mjs` and `paletteHex`
 * exists here: a check that re-derives the number it is checking is checking
 * itself. These are READ, and the properties below are asserted about them.
 *
 * @param {string} name the constant's name, without `const`
 * @returns {number} its value
 */
function skyNumber(name) {
  const found = new RegExp(`const ${name} = (-?[\\d.]+)`).exec(SKY_VIEW_SOURCE)
  assert.ok(found, `${name} is not a named constant any more, so this check is reading nothing`)
  return Number(found[1])
}

/** The pass's named render orders, read from the source rather than restated. */
const SKY_ORDERS = {
  moon: skyNumber('MOON_RENDER_ORDER'),
  horizon: skyNumber('HORIZON_RENDER_ORDER'),
  band: skyNumber('BAND_RENDER_ORDER_BASE'),
  ash: skyNumber('ASH_RENDER_ORDER'),
}

/** The pass's named geometry/drift numbers. */
const SKY_NUMBERS = {
  radius: skyNumber('HORIZON_RADIUS'),
  haze: skyNumber('HORIZON_HAZE'),
  moonPeak: skyNumber('MOON_PEAK'),
  moonDistance: skyNumber('MOON_DISTANCE'),
  moonRadius: skyNumber('MOON_RADIUS'),
  ashPeak: skyNumber('ASH_PEAK'),
  ashMinY: skyNumber('ASH_MIN_Y'),
  ashSize: skyNumber('ASH_SIZE'),
  ashCount: skyNumber('ASH_COUNT'),
  ashBox: skyNumber('ASH_BOX'),
  horizonCount: skyNumber('HORIZON_COUNT'),
}

/** `PALETTE.<key>`, the same reader `paletteHex` uses, reached through `stripProse`. */
function skyPaletteHex(key) {
  const code = stripProse(STREET_VIEW_SOURCE)
  const found = new RegExp(`${key}:\\s*0x([0-9a-fA-F]{6})`).exec(code)
  assert.ok(found, `PALETTE.${key} is not a six-digit hex any more`)
  return Number.parseInt(found[1], 16)
}

test('the four sky colours are sodium, and the silhouettes are darker than every sky stop', () => {
  // The warmth claim as arithmetic, on the same footing as §12.3's own ramps: R > G
  // > B on all four, and the g/r spread inside the ramps' 0.1 window. A moon at
  // R=G=B is a white moon, and a white moon in a mono-yellow world is a fifth
  // colour family — which is the exact defect §12.2 exists to prevent.
  const spread = []
  for (const key of ['skyHaze', 'skyMoon', 'horizonShape', 'skyAsh']) {
    const hex = skyPaletteHex(key)
    const r = (hex >> 16) & 0xff
    const g = (hex >> 8) & 0xff
    const b = hex & 0xff
    assert.ok(r > g, `PALETTE.${key} is not red-dominant (${r}, ${g}, ${b}) — §12.2 gives cold light to the portals alone`)
    assert.ok(g > b, `PALETTE.${key} is not amber (${r}, ${g}, ${b})`)
    spread.push(g / r)
  }
  const min = Math.min(...spread)
  const max = Math.max(...spread)
  assert.ok(max - min < 0.1, `the sky colours disagree on hue: g/r spans ${min.toFixed(3)}-${max.toFixed(3)}, and §12.3's ramps hold 0.1`)
})

test('no sky element is bright enough to be a creature eye, and the whole pass is counted', () => {
  // THE headline property of the pass, and the one the brief's "NOT bright" is
  // really about. `tools/png-luma.mjs` finds the creature's eye by flood-filling
  // every compact blob at or above `EYE_MIN` 150, and §11.3's whole balance rests
  // on that finder resolving the figure. A sky that can manufacture a 150-luma
  // blob does not just look wrong: it can make the eye gate pass on a frame with
  // no creature in it, and can make a frame with a creature in it report the
  // wrong contrast.
  //
  // So the budget is a SUM, not a per-element ceiling. Every additive element
  // contributes its material colour's luma scaled by its own peak, and the sum
  // has to stay clear of the threshold even in the frame where the moon, all
  // three bands and the brightest mote are all in view at once.
  const EYE_MIN = 150
  // THE COLOUR SPACE, and it is the whole of the difference between this harness
  // and `verify-world.mjs`. A `THREE.Color` holds LINEAR components, a peak is
  // applied to those, and only then is the result encoded to sRGB. So
  // `lumaOf(colour) * peak` — multiplying in sRGB — understates the contribution
  // badly, because sRGB encoding is steep near black: this harness read the moon
  // at 3.3 luma where the renderer produces 21.4, and disagreed with a check that
  // reads the built material. `scaledLuma` below reproduces the renderer's model
  // in eight-bit, and the two harnesses now agree by construction rather than by
  // coincidence.
  const toLinear = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const toSrgb = (linear) => (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055)
  /** The luma a colour contributes once a peak is applied the way three.js does. */
  const scaledLuma = (hex, peak) => {
    const r = toSrgb(toLinear(((hex >> 16) & 0xff) / 255) * peak)
    const g = toSrgb(toLinear(((hex >> 8) & 0xff) / 255) * peak)
    const b = toSrgb(toLinear((hex & 0xff) / 255) * peak)
    return 0.2126 * r * 255 + 0.7152 * g * 255 + 0.0722 * b * 255
  }
  const moon = scaledLuma(skyPaletteHex('skyMoon'), SKY_NUMBERS.moonPeak)
  // Read the three peaks out of the frozen table rather than restating them, so
  // retuning a peak in `skyView.js` moves this number with it.
  const peaks = [...SKY_VIEW_SOURCE.matchAll(/drift: -?[\d.]+, peak: ([\d.]+)/g)].map((m) => Number(m[1]))
  assert.equal(peaks.length, 3, `the haze table has ${peaks.length} peaks, not the three the luma budget assumes`)
  const bands = peaks.reduce((sum, peak) => sum + scaledLuma(skyPaletteHex('skyHaze'), peak), 0)
  const ash = scaledLuma(skyPaletteHex('skyAsh'), SKY_NUMBERS.ashPeak)

  const total = moon + bands + ash
  assert.ok(
    total < EYE_MIN * 0.5,
    `the whole sky pass adds ${total.toFixed(1)} luma at worst (moon ${moon.toFixed(1)} + bands ${bands.toFixed(1)} + ash ${ash.toFixed(1)}), and that is over half of EYE_MIN ${EYE_MIN} — it could be found as a creature's eye`,
  )
  // And the half-way mark is not a soft target: the same sum against the sky
  // itself is the legibility claim. 89.6 is `skyStops[0]`, so a full-strength
  // worst case may lift the sky by at most this much before the pass stops being
  // an atmosphere and becomes a light source.
  const skyLow = relLuma(SKY_STOPS[0])
  assert.ok(
    total < skyLow * 0.8,
    `the sky pass can add ${total.toFixed(1)} luma to a ${skyLow.toFixed(1)}-luma sky, a ${(total / skyLow).toFixed(2)}x lift — the brief asked for "dim" and this is a light rig`,
  )
  // The moon on its own, because the brief named IT specifically: it must be
  // visible AND it must be dim, and those are two different bounds on the same
  // number. The floor of 12 luma is `verify-world.mjs`'s, read here so the two
  // harnesses cannot drift on where "barely visible" begins.
  assert.ok(moon > 12, `the moon adds ${moon.toFixed(1)} luma, so it is not visible at all and the brief's "pale disc" is a smudge`)
  assert.ok(moon < 40, `the moon adds ${moon.toFixed(1)} luma, which is a light rather than a disc`)
  console.log(`\n  sky budget: moon ${moon.toFixed(1)} + bands ${bands.toFixed(1)} + ash ${ash.toFixed(1)} = ${total.toFixed(1)} luma worst case, ${(total / skyLow * 100).toFixed(0)}% of skyStops[0] and ${(total / 150 * 100).toFixed(0)}% of EYE_MIN`)
})

test('the moon is a disc at a fixed bearing, not a sun, a smudge, or a thing below the street', () => {
  // THE GEOMETRY BUDGET, and it exists because the luma budget above cannot see
  // any of it.
  //
  // `MOON_RADIUS`, `MOON_DISTANCE` and `ASH_SIZE` were read into `SKY_NUMBERS` by
  // this harness and then only echoed into a log line — a number that is printed
  // is not a gate. A 45-mutation run against `skyView.js` found the consequence:
  // `MOON_RADIUS = 34` (6.5x), `MOON_DISTANCE = 30` and `ASH_SIZE = 0.9` all left
  // BOTH harnesses green, and each of those is a visible defect:
  //
  //   - radius 34 at 236 m is 16.4 degrees of arc, 6.5x the 2.5 degrees the
  //     module's own comment calls "about five times the real moon". The comment
  //     says outright that "past about 6 degrees it stops reading as a moon and
  //     starts reading as a light", and at 16.4 it covers a fifth of the frame.
  //   - distance 30 puts the disc INSIDE the built street and inside the fog, so
  //     a tower no longer occludes it and the one arrangement that reads as far
  //     away is gone. `MOON_DISTANCE > HORIZON_RADIUS` is the module's stated
  //     reason for the number ("236 m puts it BEYOND `HORIZON_RADIUS`").
  //   - elevation -0.4 puts it under the road. Nothing asserts it is above the
  //     horizon at all.
  //
  // So the three are asserted here, as ARC and as GEOMETRY rather than as the raw
  // constants: a check that restated "5.2" would fail the next legitimate retune
  // and teach the next pass to delete it, and the property being defended is the
  // apparent size, which is what a player sees.
  const FOV_DEG = 72
  const FRAME_PX = 720  // `CAPTURE_VIEWPORT`'s height; the arc is reported in both
  // The apparent arc, which is the property. `2 * atan(r / d)` is the angle the
  // disc subtends, and the module's own 6-degree limit is a limit on THAT.
  const arcDeg = (r, d) => (2 * Math.atan(r / d) * 180) / Math.PI
  const moonArc = arcDeg(SKY_NUMBERS.moonRadius, SKY_NUMBERS.moonDistance)
  // Past 6 degrees it is a light, by the module's own sentence. 2.52 is
  // committed, so this is a real bound with room to move, not a restatement.
  assert.ok(
    moonArc < 6,
    `the moon subtends ${moonArc.toFixed(2)} degrees of arc (r ${SKY_NUMBERS.moonRadius} m at ${SKY_NUMBERS.moonDistance} m), and past about 6 it reads as a light rather than a disc — §12.1's silhouette rule forbids exactly that`,
  )
  // And the floor, because the same reasoning runs the other way: a true-scale
  // moon is 0.25 degrees and 3 px, which `skyView.js` calls "a rounding
  // artefact". The brief asked for a "pale disc" and a disc has to resolve.
  const moonPx = (moonArc / FOV_DEG) * FRAME_PX
  assert.ok(
    moonPx >= 8,
    `the moon subtends ${moonPx.toFixed(1)} px of a ${FRAME_PX}-px frame, so it is not a disc but a rounding artefact — the brief asked for a "pale disc"`,
  )
  // The distance is a CLAIM about the ring, and `HORIZON_RADIUS` is right here in
  // the same object, so this is a comparison between two numbers the harness has
  // already read rather than a restated constant.
  assert.ok(
    SKY_NUMBERS.moonDistance > SKY_NUMBERS.radius,
    `the moon hangs at ${SKY_NUMBERS.moonDistance} m, inside the ${SKY_NUMBERS.radius} m horizon ring, so the silhouettes no longer stand in front of it and it stops reading as distant`,
  )
  // Fog, as a real bound rather than a vibe. The moon's material is `fog: false`
  // (asserted elsewhere), so it would be drawn at full strength from any range;
  // keeping it far out is what stops it competing with a street lamp.
  const moonY = Math.sin(skyNumber('MOON_ELEVATION')) * SKY_NUMBERS.moonDistance
  assert.ok(
    moonY > 0,
    `the moon sits at ${moonY.toFixed(1)} m, at or below the horizon, so it is behind the street and never seen`,
  )
  // The ash's size is stated in the frame the same way, because 0.055 m is a
  // claim about a mote at 4 m ("about 3 px ... at 20 px a mote is a floating
  // blob"). `ASH_BOX` is the near field the motes live in, so a mote at that
  // distance is the honest worst case for apparent size.
  const motePx = (2 * Math.atan(SKY_NUMBERS.ashSize / SKY_NUMBERS.ashBox) * 180 / Math.PI / FOV_DEG) * FRAME_PX
  assert.ok(
    motePx < 20,
    `a mote at the ${SKY_NUMBERS.ashBox} m box edge is ${motePx.toFixed(1)} px across, and at 20 px a mote is a floating blob rather than drifting dust`,
  )
  console.log(`\n  moon geometry: ${moonArc.toFixed(2)} deg arc, ${moonPx.toFixed(1)} px, ${SKY_NUMBERS.moonDistance} m (ring ${SKY_NUMBERS.radius} m), ${moonY.toFixed(0)} m up; motes ${motePx.toFixed(1)} px at ${SKY_NUMBERS.ashBox} m`)
})

test('the horizon ring is a constant radius, past the built world and inside the far plane', () => {
  // THE "outside the street grid" claim, as arithmetic rather than as a picture.
  // `neighborhood.js` owns the numbers that decide how far the street can reach,
  // and they are read from it rather than restated, so a change to `SETBACK` or
  // `LOT_DEPTH` moves this bound instead of silently invalidating it.
  const built = ((hood.GRID - 1) / 2) * hood.BLOCK + hood.SETBACK + hood.LOT_DEPTH
  assert.ok(
    SKY_NUMBERS.radius > built,
    `the horizon ring is at ${SKY_NUMBERS.radius} m and the street can build to ${built.toFixed(0)} m, so a silhouette is inside the grid`,
  )
  // ...and with margin, because a ring that merely clears the roofline is a ring
  // that clips into one the moment a roof gets taller.
  assert.ok(
    SKY_NUMBERS.radius > built + 10,
    `the ring clears the built world by only ${(SKY_NUMBERS.radius - built).toFixed(1)} m, which is not enough margin for a taller building`,
  )
  // The far plane is the other side. `world.js` writes 260 into a camera literal
  // and the ring has to be inside it or the horizon is simply not drawn — which
  // is the failure a screenshot catches and a number does not, so the number is
  // what gets asserted.
  // The camera is `PerspectiveCamera(fov, aspect, near, far)` and the aspect
  // argument is a CALL (`this._aspect()`), so a regex that balances one level of
  // parentheses reads the wrong pair. Match the TAIL instead: `near, far)` is the
  // end of the argument list, and both are literals in the source. A far plane
  // that became an expression would fail this read loudly, which is the right
  // failure — a gate that silently read the wrong number is worse than one that
  // stops.
  const farPlane = /,\s*([\d.]+),\s*([\d.]+)\s*\)\s*$/.exec(
    /new THREE\.PerspectiveCamera\([\s\S]*?\n/.exec(stripProse(WORLD_SOURCE))[0],
  )
  assert.ok(farPlane, 'world.js no longer constructs a THREE.PerspectiveCamera with two literal plane distances, so the far plane cannot be read')
  const far = Number(farPlane[2])
  assert.ok(
    SKY_NUMBERS.radius < far,
    `the ring is at ${SKY_NUMBERS.radius} m and the camera's far plane is ${far} m, so the horizon is clipped away`,
  )
  // And past the fog at its LOOSEST, which is the property that makes `fog: false`
  // honest rather than lazy: a ring inside the readable range would be a fogged
  // smudge, and the comment claiming otherwise would be the bug.
  const halfVis = rules.fogVisibility(rules.DUSK_FOG[0].density)
  assert.ok(
    SKY_NUMBERS.radius > halfVis * 2,
    `the ring is at ${SKY_NUMBERS.radius} m and the world is half-fogged at ${halfVis.toFixed(0)} m, so the horizon is inside the readable range and \`fog: false\` is hiding it`,
  )
  // 14 on a 360° ring: the largest gap between bearings is 2*pi/14 = 25.7°, and at
  // the ring's radius that is a 104 m hole. A ring with a 104 m gap reads as a
  // gap; this one is a distribution, and the count is what says so.
  const gap = (2 * Math.PI * SKY_NUMBERS.radius) / SKY_NUMBERS.horizonCount
  assert.ok(gap < 130, `the widest gap in the horizon ring is ${gap.toFixed(0)} m, which reads as a hole rather than a skyline`)
  console.log(`\n  horizon: ${SKY_NUMBERS.horizonCount} silhouettes at ${SKY_NUMBERS.radius} m, ${(SKY_NUMBERS.radius - built).toFixed(0)} m past the built world (${built.toFixed(0)} m) and ${(far - SKY_NUMBERS.radius).toFixed(0)} m inside the far plane (${far} m); gaps ${gap.toFixed(0)} m`)
})

test('the sky is drawn BEFORE the world, and the moon before the bands that veil it', () => {
  // This is the safety property the brief asked for by name, and it is a
  // RENDER ORDER rather than a filter. That distinction is the whole design: a
  // `PORTAL_FURNITURE_CLEAR`-style exclusion has to be re-applied to every new
  // thing placed in the world, and a future pass that forgets is a pass that
  // photographs a tower through a portal. A negative renderOrder cannot be
  // forgotten, because it is not consulted by anything.
  const worldLowest = 1  // `wetSheen`, set by pass 8 and read back in verify-world
  for (const [name, order] of Object.entries(SKY_ORDERS)) {
    assert.ok(
      order < 0,
      `the ${name} render order is ${order}, so the sky is drawn after the world's lowest order (${worldLowest}) and can appear in front of a portal`,
    )
  }
  // The relative order is the other half, and it is the literal reading of the
  // brief's "occluded by haze": the moon at -100, the bands from -98 down. A band
  // drawn BEFORE the moon would brighten it rather than veil it, which is the
  // exact opposite of what a moon behind overcast is.
  assert.ok(SKY_ORDERS.moon < SKY_ORDERS.band, 'the moon is drawn after the haze bands, so the disc no longer has its own slot before the strata')
  assert.ok(SKY_ORDERS.band < SKY_ORDERS.ash, 'the ash is drawn before the bands, so the motes are not last in the sky')
  // The bands ASCEND from the base, near band last. The SIGN is the assertion:
  // three.js draws the LOWER renderOrder first, so `- index` would put the far
  // band in front of the near one — and, at three bands, would run the third band
  // up onto the moon's -100 and TIE with it. A tie is not an order; three.js
  // breaks it by material id. The world check asserts the distinctness, and this
  // one asserts the derivation, because the two fail differently: a changed sign
  // here, a duplicated slot there.
  // COMMENT-STRIPPED, and the first version of this assertion did not strip. The
  // check has to read the module's CODE, and this project's comments quote their
  // own code — including the *wrong* form, because explaining the bug means
  // writing the bug down. `stripProse` is the established answer (it is what the
  // pass-8 shimmer claim uses for exactly this) and a gate that fails on prose is a
  // gate that gets deleted rather than fixed.
  const skyCode = stripProse(SKY_VIEW_SOURCE)
  const bandOrders = [...skyCode.matchAll(/BAND_RENDER_ORDER_BASE \+ index/g)]
  assert.equal(
    bandOrders.length,
    1,
    'the bands no longer ascend from the base, so the near band is not drawn last and the third may collide with the moon',
  )
  assert.equal(
    /BAND_RENDER_ORDER_BASE - index/.test(skyCode),
    false,
    'the bands subtract from the base again, which runs the third band onto the moon\'s render order',
  )
  // And the sky is a SIBLING of the street, not a child of it. This is the
  // architectural claim in the file's header and it is one word in `world.js`:
  // `streetView.group` translates by whole 448 m periods as the player walks, and
  // a sky inside it would swim across the frame every time the wrap fired.
  assert.match(
    WORLD_SOURCE,
    /this\.skyView = new SkyView\(this\.scene, this\.camera/,
    'the sky is not constructed from the scene and the camera, so it is not camera-relative',
  )
  assert.equal(
    /streetView\.group\.add\(\s*this\.skyView/.test(WORLD_SOURCE),
    false,
    'the sky was added to the street group, which translates by whole periods — the horizon would swim',
  )
})

test('the ash cannot cross a portal gate, and the exclusion is geometric rather than a budget', () => {
  // §16.5.5 photographs a portal from `PORTAL_GATE_OFFSET` 4.5 m away and the
  // pass-3 gate measures the luma at the exact centre of the rim's bounding box,
  // requiring it at or under 20. The committed frame measures 9, so there is 11
  // luma of headroom — and an ADDITIVE mote bright enough to be worth drawing is
  // 27. A mote drifting between that camera and that gate would therefore break
  // the gate, not tint it.
  //
  // The fix is a HEIGHT, not a dimmer: the ash's floor sits above the eye, and a
  // ray from the eye to a gate centred below it DESCENDS, so the box cannot
  // intersect the ray however the ash is retuned. This test is the geometry.
  const EYE_HEIGHT = 1.6
  const GATE_CENTRE = 1.18
  const STANDOFF = 4.5
  const ashFloor = EYE_HEIGHT + SKY_NUMBERS.ashMinY
  assert.ok(
    ashFloor > EYE_HEIGHT,
    `the ash's floor is at ${ashFloor.toFixed(2)} m, which is not above the ${EYE_HEIGHT} m eye, so a mote can cross the gate ray`,
  )
  // The descent is the part that makes it a proof rather than an assertion: the
  // gate is BELOW the eye, so the sightline's highest point is the eye itself.
  assert.ok(GATE_CENTRE < EYE_HEIGHT, 'the gate centre is above the eye, so the sightline ascends and the height exclusion does not hold')
  const sightlineCeiling = Math.max(EYE_HEIGHT, GATE_CENTRE)
  assert.ok(ashFloor > sightlineCeiling, `the ash floor (${ashFloor.toFixed(2)} m) is below the highest point of the gate ray (${sightlineCeiling} m)`)
  // And the box is bounded, so "above the eye" is not an unbounded claim: a mote
  // that drifted 400 m up would be a different problem, and the fall is what
  // keeps it near.
  assert.ok(SKY_NUMBERS.ashBox < 20, `the ash box is ${SKY_NUMBERS.ashBox} m across, so the near field is a fog of motes rather than drifting dust`)
  assert.ok(
    SKY_NUMBERS.ashMinY < SKY_NUMBERS.ashBox,
    `the ash floor (${SKY_NUMBERS.ashMinY} m) is above its own box (${SKY_NUMBERS.ashBox} m), so the drift cannot stay in the box`,
  )
  // The motes are additive and drawn in the opaque queue's negative order, so the
  // portal — which is a `_glow` with `fog: false` and a positive order — paints
  // over them. That is a second, independent line of defence, and it is why the
  // pass does not need a portal exclusion for its ash at all.
  assert.match(
    SKY_VIEW_SOURCE,
    /blending: THREE\.AdditiveBlending,\s*\n\s*sizeAttenuation: true,\s*\n[\s\S]*?fog: false,/,
    'the ash material is no longer an unfogged additive point sprite',
  )
  console.log(`\n  ash: ${SKY_NUMBERS.ashCount} motes, floor ${ashFloor.toFixed(2)} m (eye ${EYE_HEIGHT} m, gate centre ${GATE_CENTRE} m at ${STANDOFF} m), peak ${SKY_NUMBERS.ashPeak} x skyAsh, ${SKY_NUMBERS.ashSize} m`)
})

test('the horizon is a silhouette: hazed, unfogged, dark, and varied in profile', () => {
  // Three properties of the ring, each of which has exactly one failure mode
  // that a screenshot would show as "fine".
  //
  // 1. UNFOGGED. At 232 m the fog is 99.9997% opaque, so a fogged silhouette is
  //    a shape you cannot see, and `fog: false` is what makes the ring exist.
  // 2. HAZED. The opposite failure: at full contrast the eye reads the shapes
  //    as NEAR, because contrast is how depth is seen, and a 232 m tower at full
  //    contrast reads as a thing 20 m away. `HORIZON_HAZE` is the fix, and its
  //    value has a window rather than a preference.
  // 3. DARK. §12.1's silhouette rule: a shape has to stay darker than the air in
  //    front of it or it is not a shape. The hazed colour is compared against the
  //    DARKEST sky stop, which is the binding case — at dusk 2 the sky is 52.2 and
  //    a ring hazed to 60 would be lighter than the air it stands in.
  const shape = skyPaletteHex('horizonShape')
  const skyLow = relLuma(SKY_STOPS[0])
  const skyDarkest = Math.min(...SKY_STOPS.map(relLuma))
  // three.js `Color.lerp` mixes in the LINEAR working space, so this reproduces
  // the built material rather than approximating it in 8-bit sRGB.
  const encode = (linear) => (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055)
  const channel = (hex, shift) => {
    const srgb = ((hex >> shift) & 0xff) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const mix = (shift) => {
    const from = channel(shape, shift)
    const to = channel(SKY_STOPS[0], shift)
    return encode(from + (to - from) * SKY_NUMBERS.haze)
  }
  const hazed = 0.2126 * mix(16) + 0.7152 * mix(8) + 0.0722 * mix(0)
  assert.ok(
    hazed < skyDarkest,
    `the hazed silhouette is luma ${hazed.toFixed(1)} and the darkest sky stop is ${skyDarkest.toFixed(1)}, so the ring is lighter than the air in front of it and reads as a stain rather than a shape`,
  )
  assert.ok(
    hazed < skyLow * 0.85,
    `the hazed silhouette is luma ${hazed.toFixed(1)} against a ${skyLow.toFixed(1)} sky — that is not enough separation to read as a skyline`,
  )
  // The window on the haze itself. Below 0.2 the ring is a hard black cut-out
  // pasted on the sky; above 0.45 the shapes dissolve into a band. Both are
  // failures of the same kind and the value has to stay between them.
  assert.ok(SKY_NUMBERS.haze > 0.2, `HORIZON_HAZE is ${SKY_NUMBERS.haze}, so the ring is a hard cut-out and not a distant shape`)
  assert.ok(SKY_NUMBERS.haze < 0.45, `HORIZON_HAZE is ${SKY_NUMBERS.haze}, so the ring dissolves into a band of slightly-darker sky`)
  // PROFILE. Three kinds, and a ring of one profile is a fence. The claim is that
  // all three are BUILT, not merely named — a kind with no branch in
  // `_horizonParts` would render a tower's legs for every silhouette on the ring.
  for (const kind of ['tower', 'mast', 'crane']) {
    assert.ok(
      SKY_VIEW_SOURCE.includes(`'${kind}'`),
      `HORIZON_SHAPES has a ${kind} recipe but \`_horizonParts\` never names it, so the ring is missing a profile`,
    )
  }
  // And the crane is not a FALL-THROUGH. It was one until this gate found it: the
  // first version of `_horizonParts` had branches for `tower` and `mast` and let
  // `crane` be "whatever is left", which renders correctly right up until a
  // fourth kind is added to `HORIZON_KINDS` and silently draws as a crane. The
  // throw is the fix and the presence of the throw is the claim.
  assert.match(
    SKY_VIEW_SOURCE,
    /if \(kind !== 'crane'\) \{\s*\n\s*throw new Error\(`no horizon shape for kind/,
    "the crane is a fall-through return again, so an unknown kind draws as a crane instead of failing",
  )
  // A crane's jib is what breaks the vertical, and without it all three kinds are
  // upright. It is the one claim about the ring that is about SHAPE rather than
  // about colour, and it is the difference between a skyline and a fence.
  assert.match(SKY_VIEW_SOURCE, /jib: 15/, 'the crane has no jib, so it is a mast and the ring is a fence')
  // EXACTLY THREE sky materials are unfogged — the moon, the ring and the ash —
  // and each for its own reason: the first two are at 232+ m where the fog is
  // opaque, and the ash is 2-15 m away where fogging it would ADD the whole fog
  // colour to an additive quad. The count is exact rather than a floor because the
  // FOURTH is the bug: a band set to `fog: false` would be a stratum that does not
  // thicken with the dusk, and `skyClaims` mutation 8 is what catches that.
  assert.equal(
    (stripProse(SKY_VIEW_SOURCE).match(/fog: false/g) ?? []).length,
    3,
    'the moon, the horizon and the ash are the only three unfogged sky materials, and the count has moved',
  )
  console.log(`\n  silhouette: horizonShape luma ${relLuma(shape).toFixed(1)} hazed ${(SKY_NUMBERS.haze * 100).toFixed(0)}% toward skyStops[0] = ${hazed.toFixed(1)}, against a darkest sky of ${skyDarkest.toFixed(1)}`)
})

test('the sky is procedural, camera-relative, and driven by the clock', () => {
  // D10 and the determinism contract, as source. This module is not a rule
  // module, so `verify.mjs` cannot import it (§15.1's seam) and these three are
  // the claims only a source read can make.
  //
  // NO RANDOM. A mote that drifted by `Math.random()` would be a mote a capture
  // cannot reproduce, and §16.5's gallery is fourteen frames that must each be
  // the same frame twice.
  assert.equal(
    /Math\.random/.test(stripProse(SKY_VIEW_SOURCE)),
    false,
    'the sky draws from Math.random, so a capture of it is not reproducible',
  )
  // NO CLOCK. `this._time` accumulated from `dt` is the same clock the rest of
  // the world uses; `performance.now()` would be a second one, and a second clock
  // is how the canal shimmer's "drifts against the clock" bug is born again.
  assert.equal(
    /performance\.now|Date\.now|new Date/.test(stripProse(SKY_VIEW_SOURCE)),
    false,
    'the sky reads a wall clock, so it cannot be stepped to a known time by a capture',
  )
  // NO ACCUMULATOR on the animated values. The whole of `update` is a pure
  // function of `this._time`, and the gate drives the world to the same time
  // twice in verify-world. An accumulator would satisfy a screenshot and fail that.
  assert.match(
    SKY_VIEW_SOURCE,
    /update\(dt\) \{\s*\n\s*this\._time \+= dt\s*\n\s*const t = this\._time/,
    'the sky does not accumulate its own clock the way streetView does, so the gate cannot step it to a known time',
  )
  // NO SECOND RENDER PASS. Pass 8's claims table makes "the reflection is drawn,
  // not sampled" a headline for exactly this reason, and a sky is the temptation:
  // a gradient dome is trivially done with a second camera. One pass, one camera.
  assert.equal(/setRenderTarget|WebGLRenderTarget/.test(stripProse(SKY_VIEW_SOURCE)), false, 'the sky renders to a target, so the world is drawn twice')
  // NO EXTERNAL ASSET. Both textures are canvas-built through `createImageData`,
  // which is also what lets the headless 2D stub construct them.
  assert.match(SKY_VIEW_SOURCE, /ctx\.createImageData\(size, size\)/, 'the sky textures are not written per-pixel, so the headless canvas stub cannot build them')
  assert.equal(/new THREE\.TextureLoader|TextureLoader|\.png|\.jpg|\.hdr/.test(SKY_VIEW_SOURCE), false, 'the sky loads an external asset')
  // And the root copies the camera in X and Z and pins Y, which is the wrap
  // immunity stated in the header. A root that followed the camera in Y would put
  // a skyline at eye level and the ash through the road.
  assert.match(
    SKY_VIEW_SOURCE,
    /this\.root\.position\.set\(this\.camera\.position\.x, 0, this\.camera\.position\.z\)/,
    'the sky root does not copy the camera in X and Z with Y pinned to zero, so it is either wrapped or floating',
  )
})

/**
 * `skyClaims` — the source contracts, as a table with a mutation per claim.
 *
 * The same shape and the same purpose as `waterClaims`: a gate that has never
 * been shown to fail on a broken world is a gate that looks green on the one
 * artifact nobody re-examined, which is the failure REVIEW-pass-1 found in the
 * creature gate. Each mutation below is a real edit to `skyView.js` that a
 * future pass could plausibly make, and each has to be caught by the test above.
 *
 * @param {string} source `skyView.js`, comments NOT yet stripped
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function skyClaims(source) {
  const code = stripProse(source)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  // 1. THE HEADLINE, and the only one that is a whole-file negative. The words
  // are unique to this technique: pass 3's portal is geometry, pass 6's wire is a
  // `ShaderMaterial`, and neither has a render target — but a gradient sky dome
  // is *classically* done with a second camera and a second pass, and it is the
  // one thing in this pass that could double the frame cost.
  claim(
    'the sky is drawn in the world\'s own pass, with no second camera and no render target',
    !/setRenderTarget|WebGLRenderTarget|renderTarget/.test(code) && !/new THREE\.PerspectiveCamera/.test(code),
    'a sky dome wants a second camera, and a second camera is a second pass over every draw call in §17\'s budget',
  )
  // 2. THE RENDER ORDER IS THE SAFETY ARGUMENT, so it is a claim about numbers
  // rather than about a string: the four constants must exist and all be
  // negative. `verify-world` reads them back off the BUILT scene; this is the
  // cheap half that says they were never positive in the first place.
  claim(
    'every sky render order is negative, so the world always paints over the sky',
    /const MOON_RENDER_ORDER = -\d/.test(code)
      && /const HORIZON_RENDER_ORDER = -\d/.test(code)
      && /const ASH_RENDER_ORDER = -\d/.test(code)
      && /const BAND_RENDER_ORDER_BASE = -\d/.test(code),
    'a sky element with a positive render order is drawn after the world and can appear in front of a portal',
  )
  // 3. THE MOON IS VEILED, not brightened. The moon has to be the FIRST of the
  // sky, because the brief's "occluded by haze" is only true if the bands are
  // drawn over the disc.
  // The DERIVATION is in this claim, not only the two constants, because the sign
  // of `+ index` is what the constants cannot see. The first version asserted
  // `-100` and `-98` and its mutation for the reversed sign passed green — a claim
  // that cannot be broken by the bug it names is not a claim.
  claim(
    'the moon is drawn before the haze bands that veil it',
    /const MOON_RENDER_ORDER = -100/.test(code)
      && /const BAND_RENDER_ORDER_BASE = -98/.test(code)
      && /BAND_RENDER_ORDER_BASE \+ index/.test(code)
      && !/BAND_RENDER_ORDER_BASE - index/.test(code),
    'a moon drawn after the bands is a sticker on the sky, and a band run built by SUBTRACTING reaches -100 and ties with it — a tie is ordered by material id, not by this file',
  )
  // 3b. THE DISC IS A DISC. The luma budget can see how BRIGHT the moon is and
  // is blind to how BIG it is, so "dim" and "disc" are independent properties and
  // a pass that only budgets one has not defended the other. The 45-mutation run
  // that motivated this claim put `MOON_RADIUS` at 6.5x, `MOON_DISTANCE` inside
  // the horizon ring and `ASH_SIZE` at 16x, and every one of them stayed green in
  // both harnesses. The arc bound is the module's own sentence — "past about 6
  // degrees it stops reading as a moon and starts reading as a light" — and the
  // floor is its other one: a 0.25-degree moon is 3 px, "a rounding artefact".
  //
  // The comparison is a RELATION (`MOON_DISTANCE > HORIZON_RADIUS`, an arc in
  // degrees) rather than a restated 5.2, so a legitimate retune does not fail it
  // and the claim cannot be satisfied by editing the number it is checking.
  const moonRadius = Number(/const MOON_RADIUS = ([\d.]+)/.exec(code)?.[1])
  const moonDistance = Number(/const MOON_DISTANCE = ([\d.]+)/.exec(code)?.[1])
  const ringRadius = Number(/const HORIZON_RADIUS = ([\d.]+)/.exec(code)?.[1])
  const moonElevation = Number(/const MOON_ELEVATION = (-?[\d.]+)/.exec(code)?.[1])
  const ashSize = Number(/const ASH_SIZE = ([\d.]+)/.exec(code)?.[1])
  const ashBox = Number(/const ASH_BOX = ([\d.]+)/.exec(code)?.[1])
  const arcOf = (r, d) => (2 * Math.atan(r / d) * 180) / Math.PI
  claim(
    'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
    [moonRadius, moonDistance, ringRadius, moonElevation, ashSize, ashBox].every(Number.isFinite)
      && arcOf(moonRadius, moonDistance) < 6
      && arcOf(moonRadius, moonDistance) >= 1.28
      && moonDistance > ringRadius
      && Math.sin(moonElevation) * moonDistance > 0
      && (2 * Math.atan(ashSize / ashBox) * 180) / Math.PI / 72 * 720 < 20,
    'a moon past ~6 degrees of arc reads as a light rather than a disc, under ~1.3 it is a 3-px rounding artefact, inside the horizon ring nothing stands in front of it, and a mote over 20 px is a floating blob',
  )
  // 3c. THE STRATA ARE STRATA. Three bands at three radii is the whole idea — the
  // same texture at one radius three times is one band drawn three times, and the
  // brief's "occluded by haze" would be a single smear. The radii are also what
  // make `fog: true` readable at all, since the file's own table says the fog is
  // 18% opaque at 52 m and 78% at 86 m: collapse the radii and the bands are
  // eaten together, and the dusk loses its depth cue.
  //
  // The frozen-drift mutant is the same defect from the other side. A band that no
  // longer turns is a pasted texture — the exact thing the `fog: true` note above
  // rejects — and a sky that is static between two frames of the same walk is
  // indistinguishable from a still image.
  //
  // ASCENDING radii and heights are asserted, not restated, and the drift is
  // required to be non-zero for every band rather than merely present: `+0` and
  // `-0` both satisfy "has a drift field" and both freeze the sky.
  //
  // AND THE USE SITE, which is the half this claim was missing when the external
  // run caught it. Checking the table alone is a claim about a literal: an
  // `update()` that wrote `Math.cos(angle) * 86` instead of `* band.radius`, or
  // placed every band at the hard-coded eye height `1.6`, leaves a perfectly
  // ordered table and ignores it. Both survived the first version of this claim
  // for exactly that reason — the table was never wrong, the code reading it was.
  // So the derivation is asserted the same way the render-order claim asserts
  // `BAND_RENDER_ORDER_BASE + index` rather than `-98`: the position call has to
  // read BOTH axes of `band`, and every height has to clear the 1.6 m eye.
  const bandTable = [...code.matchAll(/\{ radius: ([\d.]+), height: ([\d.]+), width: ([\d.]+), aspect: ([\d.]+), drift: (-?[\d.]+), peak: ([\d.]+) \}/g)]
    .map((m) => ({ radius: Number(m[1]), height: Number(m[2]), width: Number(m[3]), aspect: Number(m[4]), drift: Number(m[5]), peak: Number(m[6]) }))
  const radii = bandTable.map((band) => band.radius)
  const heights = bandTable.map((band) => band.height)
  const EYE_Y = 1.6
  claim(
    'the three haze strata are at three distinct, ascending radii and never stop drifting',
    bandTable.length === 3
      && new Set(radii).size === 3
      && radii.every((r, i) => i === 0 || r > radii[i - 1])
      && heights.every((h, i) => i === 0 || h > heights[i - 1])
      && heights.every((h) => h > EYE_Y)
      && bandTable.every((band) => band.drift !== 0)
      && /const angle = t \* band\.drift/.test(code)
      && /mesh\.position\.set\(\s*Math\.cos\(angle\) \* band\.radius,\s*band\.height,\s*Math\.sin\(angle\) \* band\.radius/.test(code),
    'bands sharing a radius are one smear drawn three times, a descending radius puts the far band in front of the near one, a zero drift freezes the sky into a pasted texture, a band at or below the 1.6 m eye sits on the horizon line, and an ordered table nothing reads is not a strata',
  )
  // 4. THE ASH EXCLUSION IS A HEIGHT. The pupil gate is a measurement OF THE HOLE
  // and a mote in the stand-off invalidates it; the fix has to be geometric
  // because a brightness budget is retuned by the next pass that wants a brighter
  // sky.
  claim(
    'the ash is held above the eye, so it cannot cross the portal gate ray',
    /const ASH_MIN_Y = 2\.2/.test(code) && /y: ASH_MIN_Y \+ 1\.6/.test(code),
    'the ash is no longer pinned above the eye, so a mote can drift into the §16.5.5 pupil stand-off and break the pass-3 luma gate',
  )
  // 5. THE HORIZON IS UNFOGGED, and for the one reason that is true of all three
  // unfogged materials in this game: at 232 m the fog is opaque. A fogged ring is
  // a ring nobody can see.
  claim(
    'the moon, the horizon and the ash are unfogged, and the bands are not',
    (code.match(/fog: false/g) ?? []).length === 3 && /fog: true,/.test(code),
    'a fogged horizon at 232 m is a 0.0003%-opacity shape, a fogged moon at 236 m is worse, and a fogged additive band adds the whole fog colour to itself',
  )
  // 6. D10 AND THE DETERMINISM CONTRACT, in one claim because they are the same
  // claim: a sky that cannot be reproduced cannot be photographed.
  claim(
    'the sky is seeded and clock-driven, so a capture of it is reproducible',
    !/Math\.random|performance\.now|Date\.now/.test(code)
      && /this\._time \+= dt/.test(code)
      && /hash32\(seed, index/.test(code),
    'an unseeded or wall-clocked sky is a frame no capture can reproduce, and §16.5 is fourteen frames that must each be the same frame twice',
  )
  // 7. THE HAZE IS A FOG-AFFECTED STRATUM, not a decal. `fog: true` on an
  // additive band is the whole of why the bands thin as the world closes.
  claim(
    'the haze bands are fog-affected, so they are eaten as the dusk advances',
    /blending: THREE\.AdditiveBlending,\s*\n\s*fog: true,/.test(code),
    'an unfogged haze band does not thicken with the dusk, so it is a texture pasted over the sky and §3.7\'s clock loses a limb',
  )
  return claims
}

test('the sky claims are the source contracts, and each one fails when its code is broken', () => {
  const claims = skyClaims(SKY_VIEW_SOURCE)
  assert.ok(claims.length >= 7, `only ${claims.length} claims, so the table is short`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name} — ${entry.why}`)
  }

  // THE MUTATIONS, and the reason this test exists. Each row is a real edit a
  // future pass could make, each must be caught, and the expected hit count is
  // declared because `replace` rewrites the FIRST match: a fragment quoted in
  // this file's own doc comments is a mutation that changes nothing and a claim
  // that then reports the broken build as clean. `waterClaims` hit exactly that
  // and the expected-count column is how it was caught.
  const mutations = [
    ['a second camera for the dome', 'the frame is drawn twice and §17\'s budget is gone',
      'the sky is drawn in the world\'s own pass, with no second camera and no render target',
      '    this.root = new THREE.Group()',
      '    this._domeCamera = new THREE.PerspectiveCamera(72, 1, 1, 900)\n    this.root = new THREE.Group()'],
    ['a positive render order', 'a sky element lands in front of a portal',
      'every sky render order is negative, so the world always paints over the sky',
      'const ASH_RENDER_ORDER = -95', 'const ASH_RENDER_ORDER = 5'],
    ['the moon drawn last', 'the moon no longer has its own slot before the strata',
      'the moon is drawn before the haze bands that veil it',
      'const MOON_RENDER_ORDER = -100', 'const MOON_RENDER_ORDER = -94'],
    // The four below are the survivors of the 45-mutation run this review ran
    // against `skyView.js`. Each is a visible defect, and each was green in BOTH
    // harnesses before this pass because the number was read and logged and never
    // compared to anything. They are here now so the claim cannot quietly rot
    // back into a comment.
    ['the moon is a sun, not a disc', '16.4 degrees of arc, past the 6 the module itself calls a light',
      'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
      'const MOON_RADIUS = 5.2', 'const MOON_RADIUS = 34'],
    ['the moon inside the horizon ring', 'nothing stands in front of the disc any more, so it stops reading as distant',
      'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
      'const MOON_DISTANCE = 236', 'const MOON_DISTANCE = 30'],
    ['the moon under the road', 'a negative elevation puts the disc below the horizon, where it is never seen',
      'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
      'const MOON_ELEVATION = 0.62', 'const MOON_ELEVATION = -0.4'],
    ['motes the size of saucers', 'a 0.9 m mote is a floating blob in the near field, not drifting dust',
      'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
      'const ASH_SIZE = 0.055', 'const ASH_SIZE = 0.9'],
    ['the moon a rounding artefact', 'a true-scale disc is 3 px, which the module calls an artefact and the brief did not ask for',
      'the moon stays a resolvable disc beyond the ring, and the motes stay dust',
      'const MOON_RADIUS = 5.2', 'const MOON_RADIUS = 0.9'],
    ['the bands all at one radius', 'three strata collapse into one smear, and the fog eats them together',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'radius: 52, height: 26, width: 150', 'radius: 86, height: 26, width: 150'],
    ['the strata descending', 'the far band is drawn in front of the near one, which inverts the depth the fog encodes',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'radius: 68, height: 41, width: 210', 'radius: 48, height: 41, width: 210'],
    ['a frozen stratum', 'a band that no longer turns is a pasted texture, which is what the `fog: true` note rejects',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'const angle = t * band.drift', 'const angle = 0 * band.drift'],
    ['a stratum with no drift at all', '`+0` passes a check that only asks the field exists, and freezes the sky',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'drift: 0.0031, peak: 0.01', 'drift: 0, peak: 0.01'],
    ['a stratum at eye level', 'the haze sits on the horizon line instead of stacking above it',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'radius: 86, height: 58, width: 280', 'radius: 86, height: 26, width: 280'],
    // The two below are the survivors that caught the first version of this claim
    // being wrong rather than the world being wrong: both leave the table perfectly
    // ordered and change only the code that READS it. A claim about a literal is
    // not a claim about behaviour, which is the same lesson as the render-order
    // sign above.
    ['an ordered table nothing reads (radius)', 'the table still says 52/68/86 and the sky puts all three bands at 86',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      'Math.cos(angle) * band.radius', 'Math.cos(angle) * 86'],
    ['an ordered table nothing reads (height)', 'the table still says 26/41/58 and the sky puts every band on the horizon',
      'the three haze strata are at three distinct, ascending radii and never stop drifting',
      '        band.height,\n        Math.sin(angle) * band.radius,', '        1.6,\n        Math.sin(angle) * band.radius,'],
    ['the bands run the wrong way', 'the third band lands on the moon\'s render order and the two are ordered by material id',
      'the moon is drawn before the haze bands that veil it',
      '      mesh.renderOrder = BAND_RENDER_ORDER_BASE + index',
      '      mesh.renderOrder = BAND_RENDER_ORDER_BASE - index'],
    ['the ash at knee height', 'a mote drifts into the §16.5.5 pupil stand-off',
      'the ash is held above the eye, so it cannot cross the portal gate ray',
      'const ASH_MIN_Y = 2.2', 'const ASH_MIN_Y = 0.2'],
    ['a fogged horizon', 'the ring is a 0.0003%-opacity shape and reads as an empty sky',
      'the moon, the horizon and the ash are unfogged, and the bands are not',
      '      fog: false,\n    })\n\n    this.horizonCount', '      fog: true,\n    })\n\n    this.horizonCount'],
    ['an unseeded mote', 'a capture of the ash is not reproducible',
      'the sky is seeded and clock-driven, so a capture of it is reproducible',
      'const mix = hash32(seed, index, 0x5f3a)', 'const mix = Math.random() * 0xffffffff'],
    ['a wall clock', 'the sky cannot be stepped to a known time by a capture',
      'the sky is seeded and clock-driven, so a capture of it is reproducible',
      'this._time += dt', 'this._time = performance.now() / 1000'],
    ['unfogged haze', 'the bands stop thickening with the dusk and the clock loses a limb',
      'the haze bands are fog-affected, so they are eaten as the dusk advances',
      '        blending: THREE.AdditiveBlending,\n        fog: true,', '        blending: THREE.AdditiveBlending,\n        fog: false,'],
  ]
  for (const [label, why, claimName, from, to] of mutations) {
    assert.ok(SKY_VIEW_SOURCE.includes(from), `the mutation "${label}" no longer matches skyView.js, so it is not testing anything`)
    const mutated = SKY_VIEW_SOURCE.replace(from, to)
    assert.notEqual(mutated, SKY_VIEW_SOURCE, `the mutation "${label}" was a no-op`)
    const broken = skyClaims(mutated)
    const survivor = broken.find((entry) => entry.name === claimName)
    assert.ok(survivor, `the mutation "${label}" removed the claim "${claimName}" instead of breaking it`)
    assert.equal(
      survivor.ok,
      false,
      `the mutation "${label}" left "${claimName}" green — ${why}`,
    )
  }
  console.log(`\n  sky claims: ${claims.length} source contracts, ${mutations.length} mutations, every one caught`)
})

// ---------------------------------------------------------------------------
// iteration 2, pass 10 — the creature beyond the silhouette
//
// WHAT THIS SECTION CLAIMS, AND WHY EACH CLAIM IS HERE RATHER THAN IN THE WORLD
// ---------------------------------------------------------------------------
// Four features, split across the two harnesses by what each one is ABOUT rather
// than by convenience:
//
//  1. the idle micro-motion and the limb articulation are FUNCTIONS, and a function
//     can be swept. `idleBreath` and `limbGait` are pure, so "the elbow peaks 0.66
//     rad after the shoulder" is a measurement of a phase relationship and not a
//     claim about a screenshot. Both are asserted here with the properties that
//     make them motion rather than noise: bounded, slow, seeded, deterministic, and
//     on periods that share no factor.
//  2. the trail is a REDUCER, so "a walk of N metres lays floor(N / stride) marks,
//     a standing creature lays none, the cap holds, and the cap evicts the oldest"
//     are four short loops. The frame-rate independence is the interesting one: the
//     same walk in 60 frames and in 600 frames has to produce the same trail, and an
//     accumulator-based version of this fails it.
//  3. the eye flare is an ENVELOPE plus one boolean, and the interesting claim is
//     the SYNC: the brief asks the flare to land on the existing audio, and the
//     only audio that changes on that frame is the routed creature breath sharpening
//     as awareness crosses 1.0. Both are read here through the real router, so "the
//     eye flares on the same frame the breath reaches its hunting timbre" is a fact
//     about two pieces of code rather than an intention.
//  4. the parts that are about DRAWING — one mesh, an RGBA vertex colour, the
//     render order, the eye's colour rather than its opacity — cannot be swept, so
//     they are `creatureFidelityClaims` over the source with mutations, and the
//     built results are measured in `verify-world.mjs`.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM
// ----------------------------------
// That the trail is visible in the gallery. §16.5's chase view stands the creature
// 9 m out and waits 0.3 s, which at tier 0's 2.2 m/s is 0.66 m of road and not
// quite the 0.9 m a drip needs — so `creature-chasing.png` photographs a creature
// whose trail is a few centimetres old or not yet started. Re-staging a §16.5 view
// to make a pass's feature legible is a worse trade than the feature being
// measurable, and the check that walks the creature twenty metres lives in the
// world harness instead.
// ---------------------------------------------------------------------------

section('Creature fidelity I (iteration 2, pass 10)')

/** The gait phase's own input, restated: §6.1's chase bob amplitude. */
const CHASE_HEAVE = 1.5

test('the arm split did not lengthen the arm, and the elbow is a hinge not a wing', () => {
  const S = beast.CREATURE_SHAPE
  // The whole of §12.1's silhouette claim is that the rig is built from one set of
  // numbers, and pass 10 added two of them. The invariant is the SUM, not either
  // value: the claw has to hang at `armLength`, or the 7:1 ratio and the crown
  // height become two claims and the figure is quietly 8 cm longer than it was.
  assert.ok(
    Math.abs(S.armUpper + S.armFore - S.armLength) < 1e-9,
    `the arm is ${(S.armUpper + S.armFore).toFixed(3)} m and the shape table says ${S.armLength}`,
  )
  assert.ok(S.armUpper > 0 && S.armFore > 0, 'one of the two bones is zero, so there is no arm')
  // A hinge, not a wing and not a flagpole. Below a third the "elbow" is a wrist and
  // the limb reads as a hand on a long stick; above two thirds the forearm is a stump
  // and the bend is at the shoulder, which is the rigid case this pass exists to fix
  // wearing a different name.
  const share = S.armFore / S.armLength
  assert.ok(share > 1 / 3 && share < 2 / 3, `the forearm is ${(share * 100).toFixed(0)}% of the arm`)
  // and the split is not the only invariant: the shoulder is still where the two
  // trunk lengths put it, or the arm is on the wrong torso
  assert.ok(Math.abs(S.legLength + S.torsoLength - S.armRoot) < 1e-9)
})

test('the idle motion is slow, bounded, seeded, and it does not lock to one loop', () => {
  // 1. BOUNDED. A breath is a scale DELTA and it may not be able to shrink the
  // figure, which is why its amplitude is a constant rather than a two-sided range.
  for (let t = 0; t < 40; t += 1 / 37) {
    const idle = beast.idleBreath(t, 0.61)
    assert.ok(Math.abs(idle.breath) <= beast.IDLE_BREATH_DEPTH + 1e-12, `breath ${idle.breath} at t=${t}`)
    assert.ok(Math.abs(idle.sway) <= beast.IDLE_SWAY_RADIANS + 1e-12, `sway ${idle.sway} at t=${t}`)
  }
  // 2. SLOW, and slow is a number. A cycle a player can count is a metronome, and the
  // whole claim of this feature is that the figure moves too little to time. The
  // measurement is the MEAN interval between up-crossings over a minute, and not a
  // single interval, because the second partial at `IDLE_BREATH_RATIO` is there
  // precisely to make the crossings uneven — a breath with a constant period is a
  // pulse, and a pulse is a machine. The band is ±25% rather than ±2% for the same
  // reason: the crossings bunch, the mean is what the constant is about.
  const rising = []
  let wasLow = beast.idleBreath(0, 0).breath <= 0
  for (let t = 1 / 600; t < 60; t += 1 / 600) {
    const now = beast.idleBreath(t, 0).breath <= 0
    if (now && !wasLow) rising.push(t)
    wasLow = now
  }
  assert.ok(rising.length >= 8, `the breath rose through zero ${rising.length} times in 60 s, which is not slow`)
  const mean = (rising[rising.length - 1] - rising[0]) / (rising.length - 1)
  assert.ok(
    Math.abs(mean - beast.IDLE_BREATH_SECONDS) < beast.IDLE_BREATH_SECONDS * 0.25,
    `the breath's mean cycle is ${mean.toFixed(2)} s and the constant says ${beast.IDLE_BREATH_SECONDS}`,
  )
  // and the two crossings of a single cycle are NOT evenly spaced, which is the
  // measurable form of "a player cannot time it"
  const gapA = rising[1] - rising[0]
  const gapB = rising[2] - rising[1]
  assert.ok(Math.abs(gapA - gapB) > 0.05, `the breath's gaps are ${gapA.toFixed(2)} and ${gapB.toFixed(2)} s, which is a metronome`)
  // 3. THE TWO MOTIONS SHARE NO FACTOR. Breath at 4.2 s and sway at 5.9 s: if they
  // agreed, the composite would repeat every 4.2 s and the figure would rock. A
  // ratio near an integer is the same problem with extra steps, so the RATIO is
  // asserted and not merely the difference.
  const ratio = beast.IDLE_SWAY_SECONDS / beast.IDLE_BREATH_SECONDS
  assert.ok(ratio > 1.05 && ratio < 1.95, `the two periods are in a ratio of ${ratio.toFixed(3)}, which repeats or nests`)
  let swaySwings = 0
  let wasSwayLow = beast.idleBreath(0, 0).sway <= 0
  for (let t = 1 / 600; t < 60; t += 1 / 600) {
    const now = beast.idleBreath(t, 0).sway <= 0
    if (now !== wasSwayLow) swaySwings += 1
    wasSwayLow = now
  }
  assert.ok(swaySwings >= 4, 'the shoulder sway is not a slow drift')
  // 4. SEEDED, AND ONLY SEEDED. Two creatures in one scene must not breathe in
  // lockstep, and the same creature on a replayed seed must breathe identically.
  assert.notEqual(
    beast.idleBreath(3.3, 0).breath,
    beast.idleBreath(3.3, 1.7).breath,
    'two creatures with different offsets breathe identically',
  )
  assert.equal(beast.idleBreath(3.3, 0.61).breath, beast.idleBreath(3.3, 0.61).breath, 'the breath is not deterministic')
  // 5. PER STATE, through the pose — and the direction is the readable one. A
  // ranging creature sways more than a closing one, because a thing that drifts
  // while it is chasing you is a thing that is not sure it has you.
  const swayPeak = (state) => {
    let peak = 0
    for (let t = 0; t < 12; t += 1 / 120) peak = Math.max(peak, Math.abs(beast.creaturePose({ state }, { time: t }).sway))
    return peak
  }
  const stalk = swayPeak('stalk')
  const chase = swayPeak('chase')
  const telegraph = swayPeak('telegraph')
  assert.ok(stalk > chase * 1.8, `a stalk sways ${stalk.toFixed(4)} rad and a chase ${chase.toFixed(4)}`)
  assert.ok(telegraph < stalk, 'the apparition at ninety metres sways as much as a ranging thing')
  assert.equal(swayPeak('dormant'), 0, 'a creature that is not there is breathing')
  // 6. And the breath REACHES the pose, which is the only way the view ever sees it.
  assert.ok(Math.abs(beast.creaturePose({ state: 'stalk' }, { time: 2.2 }).breath) > 0, 'the pose carries no breath')
  // 7. And it is small enough to be micro-motion rather than a pulse: at the crown,
  //    IDLE_BREATH_DEPTH on a 2.8 m figure is the number a player cannot point at.
  const crown = beast.IDLE_BREATH_DEPTH * beast.CREATURE_SHAPE.height
  assert.ok(crown > 0.02 && crown < 0.08, `the crown moves ${(crown * 100).toFixed(1)} cm per breath`)
  console.log(`\n  pass-10 idle: breath ±${beast.IDLE_BREATH_DEPTH} (crown ${(crown * 100).toFixed(1)} cm) over ${beast.IDLE_BREATH_SECONDS} s, sway ±${beast.IDLE_SWAY_RADIANS} rad over ${beast.IDLE_SWAY_SECONDS} s (ratio ${ratio.toFixed(3)}); stalk ${stalk.toFixed(4)} rad, chase ${chase.toFixed(4)}, telegraph ${telegraph.toFixed(4)}`)
})

test('the stride is per state, and the elbow peaks behind the shoulder', () => {
  // 1. THE PER-STATE DRIVE is the pass's actual claim about the arms. BEFORE: one
  // amplitude (0.7) for every state, so a telegraph's arms swung exactly as hard as
  // a chase's. The number is a RATIO, asserted as one, because the two amplitudes
  // are separately tunable and the ratio is the property that survives a retune.
  const swingPeak = (state) => {
    const drive = beast.presentationFor(state).stride
    let peak = 0
    for (let phase = 0; phase < Math.PI * 2; phase += 0.001) {
      peak = Math.max(peak, Math.abs(beast.limbGait(phase, drive).swing))
    }
    return peak
  }
  const chase = swingPeak('chase')
  const stalk = swingPeak('stalk')
  const telegraph = swingPeak('telegraph')
  const enraged = swingPeak('enraged')
  assert.ok(chase / telegraph > 10, `a chase swings ${chase.toFixed(3)} rad and a telegraph ${telegraph.toFixed(3)}`)
  assert.ok(stalk > telegraph && stalk < chase, 'the three states are not ordered rumour, ranging, hunting')
  assert.ok(enraged > chase, 'the finale does not drive the same rig harder than a chase')
  assert.equal(swingPeak('dormant'), 0, 'a creature that is not there is walking')
  assert.equal(swingPeak('dismissing'), 0, 'a departing figure is walking away from its own banish')
  // 2. THE ELBOW LAGS THE SHOULDER, measured rather than restated: sweep a stride,
  // find the phase at which the arm reaches furthest forward, and the phase at which
  // the elbow is most bent, and require the second to be later by `ELBOW_LAG`.
  const peakPhase = (fn) => {
    let best = -Infinity
    let at = 0
    for (let phase = 0; phase < Math.PI * 2; phase += 0.0005) {
      const value = fn(phase)
      if (value > best) {
        best = value
        at = phase
      }
    }
    return at
  }
  const drive = beast.presentationFor('chase').stride
  const shoulder = peakPhase((phase) => -beast.limbGait(phase, drive).swing)
  const elbow = peakPhase((phase) => -beast.limbGait(phase, drive).elbow)
  const lag = elbow - shoulder
  assert.ok(
    Math.abs(lag - beast.ELBOW_LAG) < 0.01,
    `the elbow peaks ${lag.toFixed(3)} rad after the shoulder and ELBOW_LAG is ${beast.ELBOW_LAG}`,
  )
  // ...and it is a LAG and not a coincidence. The two peaks are in different halves
  // of the stride, and a mutation that set `ELBOW_LAG` to 0 or to pi fails HERE
  // while passing every amplitude check above — which is the whole reason this is a
  // phase measurement and not a restatement of the constant.
  assert.ok(lag > 0.1 && lag < Math.PI * 0.75, `the lag is ${lag.toFixed(3)} rad, which is in phase or inverted`)
  // 3. THE BEND IS NEVER ZERO, which is the other half of "articulated": a forearm
  // that straightened once per stride is a mechanism, and a mechanism is a machine.
  let straightest = Infinity
  for (let phase = 0; phase < Math.PI * 2; phase += 0.001) {
    straightest = Math.min(straightest, beast.limbGait(phase, drive).elbow)
  }
  assert.ok(Math.abs(straightest) > 0.05, `the elbow fully straightens (${straightest.toFixed(4)} rad)`)
  // 4. THE PHASE IS STILL THE ONE THE VIEW USED, derived from the pose. The RATE is
  //    unchanged from before this pass, and it is MEASURED rather than derived: the
  //    `heave * 26` term is a phase OFFSET, not a rate, because `heave` itself is
  //    oscillating — the stride's speed is the derivative of the bob, and reading
  //    `STRIDE_ARC * heave` as a frequency is a mistake this comment now records.
  assert.ok(
    Math.abs(beast.stridePhase(CHASE_HEAVE, 'chase') - (CHASE_HEAVE * 26 + 5 * 0.7)) < 1e-9,
    'the gait phase is no longer the heave x 26 the view used to compute',
  )
  const crossingsOf = (state) => {
    let count = 0
    let wasLow = beast.creaturePose({ state }, { time: 0 }).legSwing <= 0
    for (let t = 1 / 600; t < 6; t += 1 / 600) {
      const now = beast.creaturePose({ state }, { time: t }).legSwing <= 0
      if (now && !wasLow) count += 1
      wasLow = now
    }
    return count / 6
  }
  const hz = crossingsOf('chase')
  const stalkHz = crossingsOf('stalk')
  assert.ok(hz > 0.25 && hz < 0.9, `a chase strides at ${hz.toFixed(2)} Hz, which is neither a walk nor a lope`)
  assert.ok(stalkHz < hz, 'a ranging thing strides faster than a hunting one, so the rate is not coming from the phase')
  // 5. TOTAL, because a NaN in a joint angle is a limb at ninety degrees for ever.
  for (const bad of [NaN, Infinity, 'x', undefined, null]) {
    const gait = beast.limbGait(bad, bad)
    assert.ok(
      Number.isFinite(gait.leg) && Number.isFinite(gait.swing) && Number.isFinite(gait.elbow),
      `limbGait(${bad}) produced ${JSON.stringify(gait)}`,
    )
  }
  console.log(`\n  pass-10 gait: shoulder swing chase ${chase.toFixed(3)} / stalk ${stalk.toFixed(3)} / telegraph ${telegraph.toFixed(3)} rad (${(chase / telegraph).toFixed(1)}x), elbow lag ${lag.toFixed(3)} rad, stride ${hz.toFixed(2)} Hz`)
})

test('the trail lays one mark per stride of ground, and lays none for standing still', () => {
  // The carrier is METRES, not frames and not the drawn gait, so the first claim is
  // the one an accumulator gets wrong: the same walk has to produce the same trail
  // whether it is delivered in 60 frames or in 600.
  const walk = (metres, frames, seed = 1337) => {
    let trail = beast.createDripTrail()
    const step = metres / frames
    for (let i = 0; i < frames; i += 1) {
      trail = beast.dripStep(trail, {
        walked: step,
        dx: step,
        dz: 0,
        x: i * step,
        z: 0,
        time: i / 60,
        present: true,
        seed,
      }).trail
    }
    return trail
  }
  const coarse = walk(40, 60)
  const fine = walk(40, 600)
  const expected = Math.floor(40 / beast.DRIP_STRIDE_METRES)
  assert.equal(coarse.dropped, expected, `40 m at ${beast.DRIP_STRIDE_METRES} m a mark is ${expected} marks, not ${coarse.dropped}`)
  assert.equal(fine.dropped, coarse.dropped, 'the trail depends on the frame rate')
  // The SHAPES are identical, because they are hashed from the drop's own index and
  // not from the frame. The POSITIONS are not, and cannot be: a mark is laid at
  // wherever the creature happened to be when the stride completed, so a finer frame
  // resolves the footfall to a different millimetre. The bound is ONE COARSE FRAME of
  // travel, because that is the coarsest frame's own resolution of where the foot
  // landed, and it is asserted rather than assumed.
  assert.deepEqual(
    fine.marks.map((mark) => [mark.radius.toFixed(9), mark.spin.toFixed(9)]),
    coarse.marks.map((mark) => [mark.radius.toFixed(9), mark.spin.toFixed(9)]),
    'the same walk lays differently SHAPED marks at 600 fps than at 60',
  )
  for (let i = 0; i < coarse.marks.length; i += 1) {
    const gap = Math.abs(fine.marks[i].x - coarse.marks[i].x)
    assert.ok(gap < 40 / 60, `mark ${i} is ${gap.toFixed(4)} m apart between the two frame rates`)
  }
  // the marks are STRIDE-SCALED, i.e. they are spread down the road rather than
  // stacked on the spot the creature finished on. Measured on a walk short enough to
  // fit inside the cap, because on the 40 m walk above the list is the LAST
  // TRAIL_MAX of 44 and the first survivors are already 26 m down the road — which is
  // the cap working, not the marks bunching.
  const short = walk(12, 60)
  const shortXs = short.marks.map((mark) => mark.x)
  assert.equal(short.marks.length, Math.floor(12 / beast.DRIP_STRIDE_METRES))
  assert.ok(Math.min(...shortXs) < 2.5 && Math.max(...shortXs) > 10.5, `a 12 m walk laid marks from ${Math.min(...shortXs).toFixed(1)} m to ${Math.max(...shortXs).toFixed(1)} m`)
  // and the remainder is CARRIED, not floored. Nine frames of 0.11 m is 0.99 m — one
  // stride SHORT of a mark, so nothing is laid; the tenth frame carries it over.
  let carried = beast.createDripTrail()
  for (let i = 0; i < 8; i += 1) {
    carried = beast.dripStep(carried, { walked: 0.11, present: true, seed: 1 }).trail
  }
  assert.equal(carried.dropped, 0, 'eight frames short of a stride laid a mark anyway')
  carried = beast.dripStep(carried, { walked: 0.02, present: true, seed: 1 }).trail
  assert.equal(carried.dropped, 1, 'the sub-stride remainder is dropped instead of carried')
  // STANDING STILL. The drawn gait advances for a motionless creature, so a version
  // keyed to it would drip in place for ever; a version keyed to metres does not.
  let still = beast.createDripTrail()
  for (let i = 0; i < 600; i += 1) {
    still = beast.dripStep(still, { walked: 0, present: true, time: i / 60, seed: 1 }).trail
  }
  assert.equal(still.dropped, 0, 'a stationary creature leaves a trail')
  assert.equal(still.marks.length, 0)
  // and a creature that is not on the field lays nothing at all, however far it is
  // notionally moved — that is the §7.4 banish and the Act I telegraph
  const gone = beast.dripStep(beast.createDripTrail(), { walked: 20, present: false, seed: 1 })
  assert.equal(gone.dropped, null)
  assert.equal(gone.trail.marks.length, 0, 'a banished creature dripped on the road')
  // TOTAL, because this runs sixty times a second inside a render loop.
  for (const bad of [NaN, Infinity, 'x', undefined, null]) {
    const out = beast.dripStep(beast.createDripTrail(), { walked: bad, present: true, seed: 1 })
    assert.equal(out.trail.marks.length, 0, `dripStep with walked=${bad} laid marks`)
    assert.equal(out.dropped, null)
  }
  assert.ok(Array.isArray(beast.createDripTrail().marks), 'the empty trail has no marks list')
})

test('the trail caps at TRAIL_MAX, and the cap evicts the oldest — the faintest', () => {
  // 1. THE CAP HOLDS, and it is load-bearing: at the finale's 5.2 m/s and a 3.2 s
  //    life the trail wants 18.6 marks and gets 16, so the overflow is not a
  //    hypothetical. The walk below is 400 m, which is 444 marks' worth of attempts.
  let trail = beast.createDripTrail()
  for (let i = 0; i < 2400; i += 1) {
    trail = beast.dripStep(trail, {
      walked: 1 / 6,
      dx: 1 / 6,
      dz: 0,
      x: i / 6,
      z: 0,
      time: i / 60,
      present: true,
      seed: 5,
    }).trail
  }
  assert.equal(trail.marks.length, beast.TRAIL_MAX, `a 400 m walk left ${trail.marks.length} marks`)
  assert.ok(trail.dropped > beast.TRAIL_MAX, 'the walk did not overflow the cap at all')
  // 2. THE OLDEST IS THE ONE THAT GOES. `marks` is oldest-first by construction, so
  //    the survivors must be the LAST TRAIL_MAX drops and the first drop must be
  //    gone — and so must the second, which is the second oldest.
  const firsts = trail.marks.slice(0, 2)
  assert.ok(firsts.every((mark) => mark.x > 380), `the trail kept marks from the start of a 400 m walk: ${firsts[0].x.toFixed(1)} m`)
  assert.ok(trail.marks[trail.marks.length - 1].x > trail.marks[0].x, 'the survivor list is not ordered oldest-first')
  // 3. "OLDEST FADES FIRST" IS A PROPERTY OF THE ALPHA FUNCTION, so it is asserted
  //    there and not here: among marks PAST THE SPREAD, the oldest is the faintest.
  //    It is stated with that qualification because it is true with it and false
  //    without it — a mark in its first 120 ms is rising, and a trail's newest mark is
  //    almost always in its first 120 ms. The two claims together are the brief's
  //    sentence; either one alone would be a different, weaker claim.
  for (let i = 0; i < 40; i += 1) {
    const ages = [beast.DRIP_SPREAD + 0.05, 0.4, 1.1, 2.0, 2.9]
    const alphas = ages.map(beast.dripAlpha)
    for (let k = 1; k < alphas.length; k += 1) {
      assert.ok(alphas[k] < alphas[k - 1], `a mark aged ${ages[k]} s is at ${alphas[k]} and an older one at ${alphas[k - 1]}`)
    }
    // ...and the other half, which is what makes it a mark that LANDED rather than a
    // decal that switched on
    assert.ok(beast.dripAlpha(beast.DRIP_SPREAD * 0.5) < beast.dripAlpha(beast.DRIP_SPREAD), 'the spread does not rise')
  }
  assert.equal(beast.dripAlpha(beast.DRIP_LIFE), 0, 'a mark is still visible at the end of its life')
  assert.equal(beast.dripAlpha(beast.DRIP_LIFE * 2), 0)
  assert.equal(beast.dripAlpha(0), 0, 'a mark is at full strength the instant it lands, which is a decal that switches on')
  assert.equal(beast.dripAlpha(-1), 0, 'a mark from the future is visible')
  assert.equal(beast.dripAlpha(NaN), 0, 'a mark of unknown age is visible')
  assert.equal(beast.dripAlpha(beast.DRIP_SPREAD), 1, 'the spread never reaches full strength')
  // 4. AND THE LIST NEVER HOLDS A DEAD MARK. The cap is by RECENCY, so a list that were
  //    not capped would eventually hold marks past `DRIP_LIFE`, and a view that trusted
  //    the list would draw them at their last alpha for ever. The one mark that CAN be
  //    listed with no strength is the newest, inside its spread window — which is the
  //    whole of what `dripAlpha(0) === 0` buys.
  const now = trail.marks[trail.marks.length - 1].born
  let spreading = 0
  for (const mark of trail.marks) {
    const age = now - mark.born
    assert.ok(age < beast.DRIP_LIFE, `a listed mark is ${age.toFixed(2)} s old, which is past its life`)
    if (beast.dripAlpha(age) <= 0) spreading += 1
  }
  assert.ok(spreading <= 1, `${spreading} listed marks have no strength, so the list is holding dead marks`)
  // 5. THE MARKS ALTERNATE SIDES, because a trail down the middle of a road is a
  //    dotted line drawn by a machine and one down each side is a pair of feet.
  const sides = trail.marks.map((mark) => Math.sign(mark.z)).filter((sign) => sign !== 0)
  assert.ok(sides.includes(1) && sides.includes(-1), 'the marks do not alternate sides')
})

test('the eyes flare on the frame the creature spots you — and on the same frame the breath turns', () => {
  // 1. THE SPOT IS AN EDGE, and the three transitions it must NOT be are each a
  //    failure somebody would ship. `chase -> chase` is every frame of a chase, so
  //    asking "is it chasing" would hold the eye bright permanently; `-> enraged` is
  //    §10.2's finale, where the creature is GIVEN knowledge and has nothing to
  //    discover; and `telegraph` cannot see at all.
  assert.equal(beast.isSpot({ from: 'stalk', to: 'chase' }), true, 'the sighting does not flare')
  assert.equal(beast.isSpot({ from: 'reposition', to: 'chase' }), true)
  assert.equal(beast.isSpot({ from: 'chase', to: 'chase' }), false, 'the flare re-arms every frame of a chase')
  assert.equal(beast.isSpot({ from: 'stalk', to: 'enraged' }), false, 'the finale is not a spotting')
  assert.equal(beast.isSpot({ from: 'telegraph', to: 'stalk' }), false, 'Act I wakes into a stalk, not a sighting')
  assert.equal(beast.isSpot({ from: 'stalk', to: 'dormant' }), false)
  assert.equal(beast.isSpot(null), false)
  assert.equal(beast.isSpot(undefined), false)
  assert.equal(beast.isSpot({}), false)
  assert.equal(beast.isSpot('chase'), false)

  // 2. THE SPOT IS THE AWARENESS EDGE, which is what makes the audio sync below a
  //    fact rather than a coincidence: the state only becomes `chase` at
  //    `AWARENESS_CHASE`, so on the spotting frame the meter is exactly full.
  const look = { seen: true, sightDistance: 2, sightRange: 14, distance: 2, playerPosition: { x: 2, z: 0 } }
  let state = beast.createCreature({ state: 'stalk', awareness: 0.1 })
  let reached = null
  let meter = 0
  for (let frames = 0; frames < 3000 && state.state !== 'chase'; frames += 1) {
    const next = beast.creatureStep(state, 1 / 60, look)
    if (beast.isSpot(next)) reached = next
    state = next.creature
    meter = next.awareness
  }
  assert.ok(reached, 'a creature looking straight at the player never reached a chase in 50 s')
  assert.equal(reached.to, 'chase')
  assert.ok(Math.abs(meter - beast.AWARENESS_CHASE) < 1e-9, `the chase began at awareness ${meter}, not 1.0`)

  // 3. THE SYNC — the part the brief actually asks for. §13's table has no dedicated
  //    "it has seen you" sting, and inventing one would be a NEW sound rather than
  //    this feature syncing with an existing one. The audio that does change on this
  //    frame is the routed `creatureBreath`, whose `rate` and `sharp` are functions
  //    of awareness and reach their hunting values at exactly 1.0. So the flare and
  //    the breath's turn are the same event read twice, and it is asserted through
  //    the real router rather than by calling `creatureBreathVoice` directly.
  const breathCue = (awareness) => audio
    .routeAudio({
      started: true,
      playing: true,
      creaturePresent: true,
      creatureDistance: 6,
      creatureAwareness: awareness,
      portals: [],
    })
    .find((cue) => cue.id === 'creatureBreath')
  const onSpot = breathCue(meter)
  assert.ok(onSpot, 'the creature breath is not routed on a frame with the creature six metres away')
  assert.equal(onSpot.params.sharp, 1, 'the breath is not at its sharpest on the frame the creature spots you')
  assert.equal(onSpot.params.rate, audio.CREATURE_BREATH_CHASE_RATE)
  // ...and it is a TRANSITION and not a level: half a meter ago the same voice was
  // still halfway between the two timbres, so the frame carries the information.
  const earlier = breathCue(meter - 0.5)
  assert.ok(earlier.params.sharp < 1, 'the breath is as sharp a moment before the spotting as on it')
  assert.ok(earlier.params.rate < audio.CREATURE_BREATH_CHASE_RATE)
  console.log(`\n  pass-10 flare: ${beast.EYE_FLARE_SECONDS} s window, peak ${(beast.EYE_FLARE_GAIN + 1).toFixed(1)}x colour and ${beast.EYE_FLARE_GROWTH}x size; breath sharp ${earlier.params.sharp.toFixed(2)} -> ${onSpot.params.sharp.toFixed(2)} on the same frame`)
})

test('the flare settles, and it cannot cost the creature gate its anchor', () => {
  // 1. THE ENVELOPE. Peak on the spotting frame, exactly zero at the end of the
  //    window, strictly falling, and bright enough to be seen for most of it.
  assert.equal(beast.eyeFlare(0), 1, 'the flare does not peak on the frame the creature spots you')
  assert.equal(beast.eyeFlare(beast.EYE_FLARE_SECONDS), 0, 'the eye never settles back to its normal glow')
  assert.equal(beast.eyeFlare(beast.EYE_FLARE_SECONDS * 2), 0)
  assert.equal(beast.eyeFlare(-0.1), 0, 'the eye flares before the creature has spotted anything')
  assert.equal(beast.eyeFlare(null), 0)
  assert.equal(beast.eyeFlare(NaN), 0)
  let previous = Infinity
  for (let t = 0; t <= beast.EYE_FLARE_SECONDS; t += 0.01) {
    const value = beast.eyeFlare(t)
    assert.ok(value <= previous, `the flare rose again at ${t.toFixed(2)} s`)
    assert.ok(value >= 0 && value <= 1)
    previous = value
  }
  assert.ok(beast.eyeFlare(beast.EYE_FLARE_SECONDS / 4) > 0.5, 'the flare is a slow swell rather than a flash')
  // ...and the window is a FRACTION of the meter that fills it, which is what stops
  // two chases inside one §8.2 cycle from reading as a single long bright eye.
  assert.ok(
    beast.EYE_FLARE_SECONDS < 1 / beast.SIGHT_FILL_PER_SEC,
    `the flare lasts ${beast.EYE_FLARE_SECONDS} s and §6.2 fills the meter in ${(1 / beast.SIGHT_FILL_PER_SEC).toFixed(1)} s`,
  )
  // 2. AND THE POSE CARRIES IT — and carries NOTHING before the spot, which is what
  //    keeps the flare off every Act I frame and every banish.
  assert.equal(beast.creaturePose({ state: 'stalk' }, { time: 3 }).eyeFlare, 0, 'a stalking eye is flaring')
  assert.equal(beast.creaturePose({ state: 'telegraph' }, { time: 3 }).eyeFlare, 0, 'the apparition is flaring')
  assert.equal(beast.creaturePose(null, {}).eyeFlare, 0)
  const flaring = beast.creaturePose({ state: 'chase' }, { time: 3, sinceSpot: 0 })
  assert.equal(flaring.eyeFlare, 1)
  assert.equal(beast.creaturePose({ state: 'chase' }, { time: 3, sinceSpot: beast.EYE_FLARE_SECONDS }).eyeFlare, 0)

  // 3. THE REGRESSION GUARD THE BRIEF NAMES. A brighter eye is fine for the creature
  //    gate — `EYE_MIN` 150 in `tools/png-luma.mjs` is a FLOOR, and the brief's own
  //    instruction was to verify rather than assume. But the flare also GROWS the
  //    quad, and the same module rejects any eye-shaped blob past `EYE_MAX_SPAN` 14 px
  //    precisely so a lamp head cannot pass as a creature's eye. The eye is held at
  //    `EYE_PIXEL_FLOOR` 7 px, so the worst case this pass can produce is
  //    7 x EYE_FLARE_GROWTH, and it has to stay under that ceiling with room to
  //    spare — the margin is the claim, not the pass.
  const worst = beast.EYE_PIXEL_FLOOR * beast.EYE_FLARE_GROWTH
  assert.ok(worst < 14, `a flaring eye is ${worst.toFixed(1)} px against the eye-finder's 14 px ceiling`)
  assert.ok(worst < 14 * 0.75, `a flaring eye is ${worst.toFixed(1)} px, which eats the eye-finder's margin`)
  assert.ok(beast.EYE_FLARE_GAIN > 1, 'the flare does not brighten the eye at all')
  assert.ok(beast.EYE_FLARE_GAIN + 1 < 5, `the eye is ${(beast.EYE_FLARE_GAIN + 1).toFixed(1)}x its own colour, which is a headlight`)
  // 4. THE EYE'S OWN COLUMN IS UNTOUCHED. `pose.eye` is still the flicker's to spend
  //    and is still clamped to one unit, so the flash lives entirely in the gain —
  //    which is what lets a `stagger` flicker a flaring eye instead of fighting it.
  assert.equal(flaring.eye, 1, 'the flare leaks into the eye opacity the flicker also spends')
  const stagger = beast.creaturePose({ state: 'stagger' }, { time: 3, sinceSpot: 0 })
  assert.equal(stagger.eyeFlare, 1, 'the flare is not drawn on a staggering creature')
  assert.equal(stagger.eye, 1, "a stagger's own eye column already clamps to 1, so this is a fact about §7.4's row")
  // The flicker is `pose.eye`'s to spend, and it is spent on TELEGRAPH: a stagger's
  // 1.2 clamps to 1 whatever the flicker does, which is a property of that row and not
  // of the flare. Sampled across a telegraph's beat so the assertion is about the
  // column being live rather than about one lucky instant.
  let dimmed = 0
  let brightest = 0
  for (let t = 0; t < 6; t += 1 / 240) {
    const value = beast.creaturePose({ state: 'telegraph' }, { time: t, sinceSpot: 0 }).eye
    assert.ok(value > 0 && value <= 1, `a telegraph's eye is at ${value}, which the clamp should not allow`)
    if (value < brightest) dimmed += 1
    brightest = Math.max(brightest, value)
  }
  assert.ok(dimmed > 100 && brightest < 0.55, 'the flicker no longer scales the eye at all')
  // ...and the eye's WORLD SIZE is untouched by the flare's brightness, because the
  // two are separate terms: `eyeSize` is the pixel floor's answer and the swell is
  // `EYE_FLARE_GROWTH` on top of it, in the view.
  assert.equal(flaring.eyeSize, beast.creaturePose({ state: 'chase' }, { time: 3, sinceSpot: 9 }).eyeSize)
})

/**
 * `creatureFidelityClaims` — pass 10's source contracts, as predicates over a
 * source string.
 *
 * The same shape as `waterClaims` and `skyClaims`, for the same reason: a gate
 * expressed as `assert.ok` can only ever run on the real file, and a gate that can
 * only run on the real file cannot be asked whether it would have caught the bug.
 *
 * These are ABOUT THE SOURCE because six of this pass's properties are invisible to
 * any measurement of the pure module and are only visible as a pattern of what is
 * written: that the trail is ONE mesh rather than sixteen, that its per-mark alpha
 * rides on a FOUR-component vertex colour (three.js sets `USE_COLOR_ALPHA` from
 * `itemSize === 4`, so a three-component attribute silently throws the alpha away —
 * a fade that does not fade, which every other check in this file would pass), that
 * the eyes are given the breath's inverse so a pixel promise does not wobble, and
 * that the flare is applied to the eye's COLOUR and not to the opacity the flicker
 * has already spent.
 *
 * @param {string} view `creatureView.js`, comments NOT yet stripped
 * @param {string} world `world.js`
 * @param {string} street `streetView.js`
 * @param {string} creature `creature.js`
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function creatureFidelityClaims(view, world, street, creature) {
  const code = stripProse(view)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })

  // 1. THE ARM HAS TWO JOINTS, and both are driven by the pose. A rig that builds an
  //    elbow and then animates the shoulder alone is the pass-9 finding in
  //    miniature: the geometry exists and nothing reads it.
  claim(
    'the arm is a shoulder and an elbow, and the elbow is driven',
    /const elbow = new THREE\.Group\(\)/.test(code)
      && /elbow\.position\.y = -S\.armUpper/.test(code)
      && /this\.elbows\.push\(elbow\)/.test(code)
      && /this\.elbows\[0\]\.rotation\.x = pose\.armElbow/.test(code)
      && /this\.elbows\[1\]\.rotation\.x = pose\.armElbow/.test(code)
      && /this\._limb\(0\.03, 0\.022, S\.armFore\)/.test(code),
    "an elbow that exists but is never rotated is a decorative joint, and a forearm at the upper bone's own radius is a long limb with a seam in the middle of it",
  )
  // 2. THE BREATH IS ON `lean` AND THE EYES ARE DIVIDED BACK OUT. The first half is
  //    the feature; the second is the reason it can be added at all. `EYE_PIXEL_FLOOR`
  //    is a promise about pixels, and a ±1.6% volume change that also moved the eye
  //    would be a promise that breathes.
  claim(
    'the breath scales the rig and is divided back out of the eyes',
    /this\.lean\.scale\.setScalar\(1 \+ pose\.breath\)/.test(code)
      && /this\.lean\.rotation\.y = pose\.sway/.test(code)
      && /const breath = 1 \/ Math\.max\(0\.001, 1 \+ pose\.breath\)/.test(code)
      && /const inverse = breath \/ Math\.max\(0\.001, pose\.scale\)/.test(code),
    'a breath on the body that also moves the eye breaks EYE_PIXEL_FLOOR, and a sway computed in the view rather than read off the pose is a number no check can see',
  )
  // 3. THE TRAIL IS ONE MESH WITH A REAL PER-MARK ALPHA. The `itemSize === 4` is the
  //    load-bearing half: three.js enables `USE_COLOR_ALPHA` from it, and a
  //    three-component attribute compiles, runs, and discards the alpha.
  //
  //    SCOPED TO `_buildTrail`'s OWN BODY, and that scoping is not tidiness — it is the
  //    fix for a mutation that went quiet. Pass 11 added `_buildHaze` and `_buildPuffs`,
  //    which are the same shape (one `BufferGeometry`, a four-component `colours`
  //    attribute, `vertexColors: true`), so the `BufferAttribute(colours, 4)` regex used
  //    to be searched against the whole file found a SECOND unmutated occurrence after
  //    the trail's was broken, and the "a three-component vertex colour" mutation broke
  //    no claim at all. `verify.mjs` reported it as caught by nothing; the harness was
  //    right and the claim was about the wrong text. A whole-file regex in a file that
  //    has grown two more instances of the same idiom is a claim about the idiom.
  const trailBody = methodBody(code, '_buildTrail')
  claim(
    'the whole trail is one mesh, and its fade is a real per-mark alpha',
    /new Float32Array\(TRAIL_MAX \* 4 \* 4\)/.test(trailBody)
      && /new THREE\.BufferAttribute\(colours, 4\)/.test(trailBody)
      && /vertexColors: true/.test(trailBody)
      && (code.match(/new THREE\.Mesh\(geometry, this\.trailMaterial\)/g) ?? []).length === 1
      && !/InstancedMesh/.test(trailBody),
    "sixteen marks as sixteen meshes is sixteen draw calls for something the eye reads as a stain, and an instanced pool has no per-instance alpha in stock three.js so the fade would silently become nothing",
  )
  // 4. THE MARK IS A DARK BLEND ON THE ROAD, not a light and not a hole. It is
  //    asserted against pass 8's own water numerically below; here the claim is the
  //    the three material properties that make it a a decal at all. The additive
  //    exclusion is scoped to `_buildTrail`'s own body, because the EYE in the same
  //    file is additive and a whole-file negative would be a claim about nothing.
  claim(
    'the mark is a dark, blended, fogged decal',
    /color: DRIP_COLOUR/.test(trailBody)
      && /opacity: DRIP_OPACITY/.test(trailBody)
      && /fog: true/.test(trailBody)
      && !/AdditiveBlending/.test(trailBody),
    "an additive mark adds light and could sit above the eye-finder's own EYE_MIN floor as a false eye, and an unfogged one is a black hole in the haze at eighty metres",
  )
  // 5. THE TRAIL IS DRAWN BEFORE THE EYE, and the RELATION is the claim rather than
  //    the number. This is pass 6's finding turned against pass 10: a near, dark,
  //    `depthWrite: false` decal given a slot after the eye erases the creature gate's
  //    only anchor, exactly as a luma-17.6 cable did.
  claim(
    'the trail is drawn before the eye, and the eye keeps its lift out of the depth sort',
    /const TRAIL_RENDER_ORDER = 0/.test(code)
      && /this\.trail\.renderOrder = TRAIL_RENDER_ORDER/.test(code)
      && /const EYE_RENDER_ORDER = ([1-9]\d*)/.exec(code) !== null
      && /eye\.renderOrder = EYE_RENDER_ORDER/.test(code),
    'a dark decal sorted after the additive eye paints over the one mark the creature gate anchors on, which is the pass-6 wire bug wearing a decal',
  )
  // 6. THE FLARE IS A COLOUR, not an opacity. `pose.eye` is clamped to 1 and is
  //    already the flicker's to spend, so an opacity flare would be invisible (the
  //    clamp eats it) and would then stop `stagger` from dimming anything.
  claim(
    'the flare multiplies the eye colour and leaves the flicker alone',
    /this\.eyeMaterial\.color\.multiplyScalar\(1 \+ EYE_FLARE_GAIN \* pose\.eyeFlare\)/.test(code)
      && /this\.eyeMaterial\.opacity = pose\.eye/.test(code)
      && /const flare = 1 \+ \(EYE_FLARE_GROWTH - 1\) \* pose\.eyeFlare/.test(code),
    'an opacity flare is eaten by `clampUnit(pose.eye)` and then by the flicker, so the eye would never brighten, and a size flare on its own is a decal moving rather than an eye flaring',
  )
  // 7. THE WORLD'S SPOT EDGE IS THE PURE ONE, and its trail is the pure reducer. A
  //    second `step.to === 'chase'` in `world.js` would be a second definition of one
  //    moment, and it is exactly the kind that ends up meaning something slightly
  //    different from the one the tests read.
  claim(
    'the world arms the flare from the pure spot test, and the trail from the pure reducer',
    /if \(beast\.isSpot\(step\)\) this\.spotElapsed = 0/.test(world)
      && /if \(!beast\.PURSUING_STATES\.includes\(step\.to\)\) this\.spotElapsed = null/.test(world)
      && /beast\.dripStep\(this\.creatureTrail, \{/.test(world)
      && /this\.creatureTrail = beast\.createDripTrail\(\)/.test(world)
      && /sinceSpot: this\.spotElapsed/.test(world),
    'a second definition of "the creature has spotted you" in the world is a second moment, and a trail the world builds for itself is a trail the pure harness cannot test',
  )
  // 8. THE MARKS ARE FOLDED ON THE WAY OUT, in the drawn copy, and the stand-off is
  //    asked of `streetView`. A mark stored in drawn coordinates is 448 m from its
  //    own road after the first wrap, and a mark inside the §16.5.5 stand-off is a
  //    decal between the gate and the camera the portal gate measures.
  // 8. THE MARKS ARE FOLDED ON THE WAY OUT, in the drawn copy, and the stand-off is
  //    asked of `streetView`. A mark stored in drawn coordinates is 448 m from its
  //    own road after the first wrap, and a mark inside the §16.5.5 stand-off is a
  //    decal between the gate and the camera the portal gate measures.
  //
  //    The world's two halves are scoped to `_advanceTrail` for the second time in this
  //    pass, and for the same reason as claim 3: pass 11's `_advancePuffs` is the same
  //    five decisions written a second time, so a whole-file search for the stand-off
  //    call finds `_advancePuffs`'s copy after `_advanceTrail`'s is mutated away, and
  //    the mutation silently stops proving anything. The claim is about the trail's
  //    fold, so it reads the trail's fold.
  const trailWorld = methodBody(world, '_advanceTrail')
  claim(
    'the trail is folded into the drawn copy and kept out of the portal stand-off',
    /mark\.x \+ origin\.x, z: mark\.z \+ origin\.z/.test(trailWorld)
      && /clear: this\.streetView\.clearOfPortals\(drawn\.x, drawn\.z\)/.test(trailWorld)
      && /clearOfPortals\(x, z\) \{/.test(street)
      && /const cx = x - this\.origin\.x/.test(street)
      && /const cz = z - this\.origin\.z/.test(street)
      && /PORTAL_FURNITURE_CLEAR/.test(street),
    'a mark in the wrong frame is 448 m from its own road, and a mark inside PORTAL_FURNITURE_CLEAR is a dark decal in the pupil stand-off the pass-3 gate photographs',
  )
  // 9. THE TRAIL IS RELEASED. §15's teardown is a definition of done, and this is a
  //    SIBLING of `root` rather than a child, so `root.parent.remove(root)` does not
  //    take it with it: a 16-quad buffer and a material left on a dead scene, which
  //    never shows up as a bug and is exactly the debt pass 19 exists to sweep.
  claim(
    'the trail is removed from the scene on dispose',
    /this\.scene\?\.remove\(this\.trail\)/.test(code) && /this\._materials\.push\(this\.trailMaterial\)/.test(code),
    "the trail is a sibling of the figure, so disposing the figure does not dispose it, and §15's teardown is exactly the check that would notice",
  )
  // 10. AND NOTHING NEW IS UNSEEDED OR WALL-CLOCKED. D10 is the repository's rule and
  //     §16.5 needs fourteen frames that are each the same frame twice. The whole of
  //     this pass is motion, so this is the claim with the most ways to fail quietly.
  claim(
    'the rig is seeded and clock-driven, so a capture of it is reproducible',
    !/Math\.random|performance\.now|Date\.now/.test(code)
      && !/Math\.random|performance\.now|Date\.now/.test(stripProse(world))
      && /dripAlpha\(time - mark\.born\)/.test(code)
      && /hash32\(seed, droppedCount, DRIP_SALT\)/.test(stripProse(creature)),
    'an unseeded or wall-clocked mark is a frame no capture can reproduce, and a trail whose shapes are rolled rather than hashed is a different street on every run',
  )
  return claims
}

test('the creature-fidelity claims are the source contracts, and every one holds', () => {
  const claims = creatureFidelityClaims(CREATURE_VIEW_SOURCE, WORLD_SOURCE, STREET_VIEW_SOURCE, CREATURE_SOURCE)
  assert.ok(claims.length >= 10, `only ${claims.length} claims, so the table is short`)
  for (const entry of claims) {
    assert.ok(entry.ok, `${entry.name} — ${entry.why}`)
  }
  // THE NUMBERS, and they are in this file rather than in the view because the view
  // cannot be imported. Each is a RELATION between two modules, which is the shape of
  // claim that survives a legitimate retune on either side.
  const dripLuma = (hex) => 0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)
  // a WET mark, so it is darker than the water it sits in and darker than the road.
  // Pass 8 established the ordering (halo < puddle < asphalt) and the trail joins the
  // bottom of it rather than inventing a new relation.
  assert.ok(dripLuma(beast.DRIP_COLOUR) < paletteLuma('puddle'), `the mark is luma ${dripLuma(beast.DRIP_COLOUR).toFixed(1)} and the water is ${paletteLuma('puddle').toFixed(1)}, so it is a shadow on a puddle`)
  assert.ok(dripLuma(beast.DRIP_COLOUR) < paletteLuma('asphalt'))
  // and it is a BLEND, never an opaque hole cut in the road
  assert.ok(beast.DRIP_OPACITY > 0.25 && beast.DRIP_OPACITY < 0.8, `the mark peaks at opacity ${beast.DRIP_OPACITY}`)
  // the LIFT clears pass 8's water, or a third of the road swallows the trail
  const halo = buildingNumber('PUDDLE_HALO_LIFT')
  const gap = buildingNumber('PUDDLE_LIFT_GAP')
  assert.ok(beast.DRIP_LIFT > halo + gap, `the mark sits at ${beast.DRIP_LIFT} m and pass 8's water tops out at ${(halo + gap).toFixed(3)} m, so a drip on a wet patch is invisible`)
  assert.ok(beast.DRIP_LIFT < 0.05, `the mark sits at ${beast.DRIP_LIFT} m, which is most of the camera's 0.05 m near plane`)
  // the CAP IS THE DENSITY, and both halves are derived from the finale's own speed
  const perSecond = beast.SPEED_CEILING / beast.DRIP_STRIDE_METRES
  const wanted = perSecond * beast.DRIP_LIFE
  assert.ok(wanted > beast.TRAIL_MAX, `a 5.2 m/s chase wants ${wanted.toFixed(1)} marks and the cap is ${beast.TRAIL_MAX}, so the cap is not doing anything`)
  assert.ok(wanted < beast.TRAIL_MAX * 1.8, `a 5.2 m/s chase wants ${wanted.toFixed(1)} marks, so the cap is truncating a trail that fits`)
  // and the mark is small enough to read as a stain AND too big to be mistaken for an
  // eye even if it were bright: at §16.5.8's 9 m a mark spans ~16 px, which is past
  // `tools/png-luma.mjs`'s own `EYE_MAX_SPAN` 14. So the creature gate rejects it
  // twice over — too DARK to clear the 150 luma floor, and too WIDE to pass the span
  // ceiling — and a mark that somehow became bright would still not be an eye.
  const px = ((beast.DRIP_RADIUS * 2) * 720) / (2 * 9 * Math.tan((VIEW_FOV * Math.PI) / 360))
  assert.ok(dripLuma(beast.DRIP_COLOUR) < 150 * 0.2, `the mark is luma ${dripLuma(beast.DRIP_COLOUR).toFixed(1)} against the eye-finder's 150 floor`)
  assert.ok(px > 14, `a mark is ${px.toFixed(1)} px at the chase capture's 9 m, which does not clear the eye-finder's own 14 px span ceiling`)
  console.log(`\n  pass-10 constants: mark luma ${dripLuma(beast.DRIP_COLOUR).toFixed(1)} (puddle ${paletteLuma('puddle').toFixed(1)}, asphalt ${paletteLuma('asphalt').toFixed(1)}), opacity ${beast.DRIP_OPACITY}, lift ${beast.DRIP_LIFT} m over pass 8's ${(halo + gap).toFixed(3)} m, ${px.toFixed(1)} px at 9 m; the finale wants ${wanted.toFixed(1)} marks and the cap is ${beast.TRAIL_MAX}`)
})

test('every creature-fidelity claim can actually fail, and a mutation names the one it breaks', () => {
  // The control for the test above, and the reason the table is a gate rather than a
  // fingerprint of one file. Each row is a real edit somebody would plausibly make
  // while tidying this rig up, and each must break exactly one named claim.
  const mutations = [
    ['an elbow that is built and never turned', 'the limb is a rigid stick with a decorative joint',
      'the arm is a shoulder and an elbow, and the elbow is driven',
      '    this.elbows[0].rotation.x = pose.armElbow\n    this.elbows[1].rotation.x = pose.armElbow', '    // the elbow follows the shoulder'],
    ["a forearm at the upper bone's radius", 'two identical radii read as one long limb with a seam',
      'the arm is a shoulder and an elbow, and the elbow is driven',
      'this._limb(0.03, 0.022, S.armFore)', 'this._limb(0.042, 0.03, S.armFore)'],
    ['the breath left on the eyes', 'EYE_PIXEL_FLOOR is a promise about pixels and a promise that breathes is not one',
      'the breath scales the rig and is divided back out of the eyes',
      'const inverse = breath / Math.max(0.001, pose.scale)', 'const inverse = 1 / Math.max(0.001, pose.scale)'],
    ['the sway dropped', 'the shoulder drift is the half of the micro-motion that reads at ninety metres',
      'the breath scales the rig and is divided back out of the eyes',
      '    this.lean.rotation.y = pose.sway\n', ''],
    ['a three-component vertex colour', 'three.js enables USE_COLOR_ALPHA from itemSize 4, so the fade is discarded and the trail never fades',
      'the whole trail is one mesh, and its fade is a real per-mark alpha',
      'new THREE.BufferAttribute(colours, 4)', 'new THREE.BufferAttribute(colours.subarray(0, 3), 3)'],
    ['an instanced pool instead of one mesh', 'sixteen draw calls for a stain, and no per-instance alpha in stock three.js',
      'the whole trail is one mesh, and its fade is a real per-mark alpha',
      'this.trail = new THREE.Mesh(geometry, this.trailMaterial)', 'this.trail = new THREE.InstancedMesh(geometry, this.trailMaterial, 2)'],
    ['an additive mark', "an additive decal adds light and could be found as the creature's eye by the gate that anchors on it",
      'the mark is a dark, blended, fogged decal',
      '      vertexColors: true,\n    })', '      vertexColors: true,\n      blending: THREE.AdditiveBlending,\n    })'],
    ['an unfogged mark', "a dark unfogged decal at eighty metres is a hole in the haze, which is the creature's own job",
      'the mark is a dark, blended, fogged decal',
      '      fog: true,\n      // `vertexColors` is what makes the four-component', '      fog: false,\n      // `vertexColors` is what makes the four-component'],
    ['the trail drawn after the eye', "a dark decal sorted after the additive eye erases the creature gate's only anchor, which is the pass-6 wire bug again",
      'the trail is drawn before the eye, and the eye keeps its lift out of the depth sort',
      'const TRAIL_RENDER_ORDER = 0', 'const TRAIL_RENDER_ORDER = 2'],
    ['the eye put back in the depth sort', 'the pass-6 claim is about the eye and this pass must not undo it',
      'the trail is drawn before the eye, and the eye keeps its lift out of the depth sort',
      'const EYE_RENDER_ORDER = 1', 'const EYE_RENDER_ORDER = 0'],
    ['the flare applied to the opacity', 'the clamp eats it and then the flicker cannot dim anything',
      'the flare multiplies the eye colour and leaves the flicker alone',
      'this.eyeMaterial.color.multiplyScalar(1 + EYE_FLARE_GAIN * pose.eyeFlare)', 'this.eyeMaterial.opacity = 1'],
    ['the size half of the flare dropped', 'a brighter eye with no swell is a light going on rather than an eye dilating',
      'the flare multiplies the eye colour and leaves the flicker alone',
      'const flare = 1 + (EYE_FLARE_GROWTH - 1) * pose.eyeFlare', 'const flare = 1'],
    ['the spot edge re-typed in the world', 'a second definition of one moment is how two files end up disagreeing about it',
      'the world arms the flare from the pure spot test, and the trail from the pure reducer',
      'if (beast.isSpot(step)) this.spotElapsed = 0', "if (step.to === 'chase') this.spotElapsed = 0"],
    ['the spot clock never cleared', 'leaving a chase re-arms the flare, so the second sighting of a run never announces itself',
      'the world arms the flare from the pure spot test, and the trail from the pure reducer',
      'if (!beast.PURSUING_STATES.includes(step.to)) this.spotElapsed = null', ''],
    ['the marks stored where they were laid', "a mark in the drawn frame is 448 m from its own road after the first wrap",
      'the trail is folded into the drawn copy and kept out of the portal stand-off',
      'mark.x + origin.x, z: mark.z + origin.z', 'mark.x, z: mark.z'],
    ['the portal stand-off dropped', 'a dark decal inside PORTAL_FURNITURE_CLEAR sits in the pupil stand-off §16.5.5 photographs',
      'the trail is folded into the drawn copy and kept out of the portal stand-off',
      'clear: this.streetView.clearOfPortals(drawn.x, drawn.z)', 'clear: true'],
    ['the stand-off folded on one axis', 'origin is per-axis, so a single shift puts the query 448 m from every portal',
      'the trail is folded into the drawn copy and kept out of the portal stand-off',
      'const cz = z - this.origin.z', 'const cz = z - this.origin.x'],
    ['the trail left on the scene', "a sibling of the figure is not removed with it, and §15's teardown is the check that would notice",
      'the trail is removed from the scene on dispose',
      'this.scene?.remove(this.trail)', ''],
    ['an unseeded mark', "D10 is the repository's rule and §16.5 needs each of fourteen frames twice",
      'the rig is seeded and clock-driven, so a capture of it is reproducible',
      'const salt = hash32(seed, droppedCount, DRIP_SALT)', 'const salt = Math.random() * 0xffffffff'],
  ]
  for (const [label, why, claimName, from, to] of mutations) {
    // A mutation has to exist in AT LEAST ONE of the four sources, and the "no claim
    // broke" assertion below is what catches the other failure mode the pass-9 review
    // found: a fragment that only appears in a COMMENT, which `replace` rewrites and
    // `stripProse` then ignores, leaving every claim green.
    const sources = [[CREATURE_VIEW_SOURCE, 'creatureView.js'], [WORLD_SOURCE, 'world.js'], [STREET_VIEW_SOURCE, 'streetView.js'], [CREATURE_SOURCE, 'creature.js']]
    if (!sources.some(([source]) => source.includes(from))) {
      throw new Error(`the mutation "${label}" matches none of the four sources, so it is not testing anything`)
    }
    const broken = creatureFidelityClaims(
      CREATURE_VIEW_SOURCE.replace(from, to),
      WORLD_SOURCE.replace(from, to),
      STREET_VIEW_SOURCE.replace(from, to),
      CREATURE_SOURCE.replace(from, to),
    ).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === claimName),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${claimName}" — ${why}`,
    )
  }
  assert.ok(mutations.length >= 18, `only ${mutations.length} mutations, which is fewer than this pass needs`)
  console.log(`\n  pass-10 claims: 10 source contracts, ${mutations.length} mutations, every one caught`)
})

// ---------------------------------------------------------------------------
// iteration 2, pass 11 — the presence that is not the body
//
// WHAT THIS SECTION CLAIMS, AND WHY EACH CLAIM IS HERE RATHER THAN IN THE WORLD
// ---------------------------------------------------------------------------
// Four effects, split by what each one is ABOUT rather than by convenience:
//
//  1. the HEAT HAZE is two functions — a falloff and a table of six bands — so
//     "it dies at 30 m", "it is C1 at both ends of the ramp", "it is a column and
//     not a box", "it is a pale COOL grey in a world whose only warm thing is the
//     sodium" and "the worst pixel it can make is a shimmer and not a light" are all
//     measurements of arithmetic. The last one is a real luma budget in the
//     renderer's own colour space, and it is the same model pass 9's sky budget uses
//     so the two cannot disagree about what "bright" means.
//  2. the LAMP DREAD is a function of (distance, time, seed), so "it strobes", "it
//     recovers", "the same tick twice agrees", "two lamps are not in step" and "it is
//     exactly 1 outside the radius" are five short sweeps.
//  3. the LAMP PULSE is an IDENTITY — `lampPulse(flare) === 1 + GAIN * eyeFlare(...)`
//     — and that identity is the audio-visual sync claim. Asserted as an identity over
//     the whole window rather than restated as arithmetic, because a second envelope
//     with its own length and peak would be two events near each other rather than one.
//  4. the PUFF FIELD is a REDUCER, so "one puff per footfall", "none for standing
//     still", "the cap holds and evicts the oldest", "the same walk in 60 frames and in
//     600 lays the same puffs" and "a gate suppresses the ones at a portal" are the
//     same five short loops the trail already has, which is why this is a copy rather
//     than a new idea.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM
// ------------------------------------
// That any of the four is in a photograph. §16.5's creature views are staged at 1.9 m,
// 9 m and 17 m, which are inside the shimmer's radius and inside one lamp's dread
// radius, but "the camera can see it" is a projection, a camera, and `creature.js` has
// none of those three. It is measured in `verify-world.mjs` against the real capture
// staging, and the check there reports pixel coordinates rather than a threshold on
// alpha — the pass-10 review's finding, which is that a mark can be at full strength
// and still be under the camera.
// ---------------------------------------------------------------------------

section('Creature fidelity II (iteration 2, pass 11)')

/** The surround the haze's budget is measured against: 19 of 255, as measured. */
const HAZE_SURROUND = 19 / 255

/**
 * The renderer's own colour model, re-derived rather than shared.
 *
 * A `THREE.Color` holds LINEAR components, a peak is applied to those, and only then is
 * the result encoded to sRGB — so multiplying a hex's luma in sRGB and calling it a
 * contribution understates the result badly, because the sRGB curve is steep near
 * black. Pass 9's budget comment records the version of this mistake reading that sky's
 * moon at 3.3 where the renderer produces 21.4. Two harnesses sharing a colour helper
 * is a shared bug waiting to be found by whichever one is edited, so this section has
 * its own pair with that history written on it.
 */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)
/** The Rec.709 luma of a hex, in LINEAR light. */
const linearLuma = (hex) =>
  0.2126 * toLinear(((hex >> 16) & 0xff) / 255) +
  0.7152 * toLinear(((hex >> 8) & 0xff) / 255) +
  0.0722 * toLinear((hex & 0xff) / 255)
/** 0..255 as the renderer would encode a linear light. */
const encodeLuma = (linear) => (0.2126 * toSrgb(linear) + 0.7152 * toSrgb(linear) + 0.0722 * toSrgb(linear)) * 255

/**
 * HAZE_INNER — the view's `HAZE_INNER_FRACTION`, read out of the source.
 *
 * The band is an annulus and this is the hole in the middle of it, and the claim is
 * that the figure never comes near the hole. That is a claim about the VIEW's geometry
 * and a claim about the pure module's `HAZE_HALF_WIDTH`, and neither harness can import
 * the other: `verify.mjs` may not import `creatureView.js` because that file touches
 * Three.js. So the number is read from the source the way pass 7 reads `LIT_ONE_IN` and
 * pass 8 reads the water constants, and a view that retuned the fraction without
 * updating this gate fails rather than quietly widening the gap.
 */
const HAZE_INNER = (() => {
  const found = /const HAZE_INNER_FRACTION = ([\d.]+)/.exec(stripProse(CREATURE_VIEW_SOURCE))
  assert.ok(found, 'creatureView.js no longer has a HAZE_INNER_FRACTION, so the shimmer has no hole in it')
  return Number(found[1])
})()

test('the shimmer is a column that dies at 30 m, and its worst pixel is a shimmer', () => {
  // 1. THE RADIUS, which is the brief's ~30 m and the number §6.1's apparition depends
  // on. The interesting assertion is the NEGATIVE one: `hazeAmount` is exactly 0 at
  // and beyond the radius, so the ninety-metre telegraph has no shimmer by
  // construction rather than by a test that could be retuned past.
  assert.equal(beast.hazeAmount(beast.HAZE_RADIUS), 0, 'the shimmer is still on at its own radius')
  assert.equal(beast.hazeAmount(beast.HAZE_RADIUS + 0.001), 0)
  assert.equal(beast.hazeAmount(1e6), 0)
  for (let d = beast.HAZE_RADIUS; d <= 200; d += 1) {
    assert.equal(beast.hazeAmount(d), 0, `the shimmer reaches ${d} m`)
  }
  assert.equal(beast.hazeAmount(0), 1, 'a creature in your face has no shimmer')
  // 2. C1 AT BOTH ENDS. A curve that arrives at 1 with a non-zero slope and departs to
  // 0 with one has a corner in its derivative, and a corner in a distance falloff is a
  // circle in the frame that switches on. Sampled rather than asserted symbolically,
  // because the smoothstep's virtue IS the shape of the derivative.
  const inside = beast.HAZE_RADIUS - beast.HAZE_FADE_METRES
  const slope = (d) => Math.abs((beast.hazeAmount(d + 0.01) - beast.hazeAmount(d - 0.01)) / 0.02)
  assert.ok(Math.abs(slope(inside)) < 0.02, `the shimmer arrives at ${inside} m with a slope of ${slope(inside).toFixed(4)}`)
  assert.ok(Math.abs(slope(beast.HAZE_RADIUS - 0.01)) < 0.02, `and leaves at the radius with a slope of ${slope(beast.HAZE_RADIUS - 0.01).toFixed(4)}`)
  // 3. MONOTONE, because a shimmer that brightens as you walk AWAY from it is not a
  // falloff. The whole ramp, sampled at a fifth of the fade's finest step.
  let previous = 2
  for (let d = 0; d <= beast.HAZE_RADIUS; d += 0.05) {
    const amount = beast.hazeAmount(d)
    assert.ok(amount <= previous + 1e-12, `the shimmer rises from ${amount} to ${previous} between ${d.toFixed(2)} and ${(d + 0.05).toFixed(2)} m`)
    assert.ok(amount >= 0 && amount <= 1, `hazeAmount(${d.toFixed(2)}) is ${amount}`)
    previous = amount
  }
  // 4. AND THE POSE CARRIES IT, multiplied by the FINAL presence, so a figure fading
  // out of the world takes its shimmer with it. The half that matters is the `dormant`
  // one: `hazeAmount(0)` is 1, so nothing but the presence test stands between a
  // banished creature and a column of hot air over an empty road.
  assert.equal(beast.creaturePose({ state: 'chase' }, { time: 1, distance: 9 }).haze, 1)
  assert.equal(beast.creaturePose({ state: 'chase' }, { time: 1, distance: 90 }).haze, 0, 'a chase at 90 m still shimmers')
  assert.equal(beast.creaturePose({ state: 'telegraph' }, { time: 1, distance: 90 }).haze, 0, "§6.1's apparition shimmers")
  assert.equal(beast.creaturePose({ state: 'dormant' }, { time: 1, distance: 0 }).haze, 0, 'a creature that is not there is shimmering')
  assert.equal(beast.creaturePose(null, { distance: 0 }).haze, 0)
  // ...and it rides the DISMISSAL, which is the interesting half: a dismissing creature
  // is `present` and its presence is decaying, so a shimmer that ignored the fade
  // would be the last thing to leave the frame.
  const fading = beast.creaturePose({ state: 'dormant' }, { time: 1, distance: 0, dismiss: 1, elapsed: 0.3 })
  assert.ok(fading.present, 'a dismissing figure is not drawn at all')
  assert.ok(fading.haze < 1 && fading.haze > 0, `a dismissing figure's shimmer is ${fading.haze}`)
})

test('the shimmer is six bands of one additive column, and none of them can be an eye', () => {
  const layers = beast.hazeLayers({ time: 3.3, offset: 0.61, amount: 1, scale: 1 })
  // 1. THE BAND COUNT, the brief's "4-6" read as a bound rather than a suggestion. It
  // fails if a later edit takes the effect up to seven "because one more reads better".
  assert.equal(layers.length, beast.HAZE_LAYERS, 'the column is not the documented number of bands')
  assert.ok(beast.HAZE_LAYERS >= 4 && beast.HAZE_LAYERS <= 6, `HAZE_LAYERS is ${beast.HAZE_LAYERS}, outside the brief's 4-6`)
  // 2. IT IS A COLUMN, not a box: a band near the floor is NARROWER than a band near the
  // crown, because hot air spreads as it rises. A constant width is a curtain, and a
  // curtain hanging beside a figure is a wall.
  const floor = layers[0].halfWidth
  const crown = layers[layers.length - 1].halfWidth
  assert.ok(crown > floor * 1.5, `the column is ${(floor * 100).toFixed(0)} cm at the floor and ${(crown * 100).toFixed(0)} cm at the crown, which is a curtain`)
  // 3. AND IT CLEARS THE FIGURE. This is the load-bearing geometric claim: the shimmer
  // is ADDITIVE and `creatureContrast` measures a body against its local surround, and
  // `creature-stalking.png` has 0.013 of headroom on that number.
  //
  //    THE COMPARISON IS PER HEIGHT, and that is a correction rather than a refinement.
  //    The first version of this check asked every band to clear the SHOULDER half-span
  //    (0.20 m), which is the wrong question twice over: the narrowest band is the one at
  //    the FLOOR, where the only part of the rig with any width at all is the leg pair at
  //    `hip / 2` 0.12 m, and the widest part of the figure is at 2.32 m where the bands
  //    are 60% wider. Measured against the shoulder the floor band came out 0.085 m
  //    clear and the check failed its own 0.1 m floor — a number that is right about the
  //    body and wrong about the question. What a curtain may not touch is the body AT
  //    ITS OWN HEIGHT, so that is what is compared, at every scale in the table.
  const bodyRadiusAt = (y) =>
    (y <= beast.CREATURE_SHAPE.armRoot ? beast.CREATURE_SHAPE.hip / 2 : beast.CREATURE_SHAPE.shoulder / 2)
  let tightest = Infinity
  for (const state of beast.PRESENTATION_STATES) {
    const { scale } = beast.presentationFor(state)
    for (const layer of beast.hazeLayers({ time: 0, offset: 0, amount: 1, scale })) {
      const inner = layer.halfWidth * HAZE_INNER
      const gap = inner - bodyRadiusAt(layer.y) * scale
      if (gap < tightest) tightest = gap
      assert.ok(
        gap > 0.05,
        `${state} at scale ${scale}: the band at ${layer.y.toFixed(2)} m has an inner edge ${inner.toFixed(3)} m from the axis and the body is ${(bodyRadiusAt(layer.y) * scale).toFixed(3)} m wide there`,
      )
    }
  }
  // ...and the conservative bound as well, because a retune that widened every band
  // could satisfy the per-height test at the floor and still close on the shoulder. At
  // the narrowest band this is 0.085 m, and at the 17 m the stalking view uses 0.085 m
  // is 2.5 px — which is why the number is checked rather than assumed.
  const narrowest = Math.min(...beast.hazeLayers({ time: 0, offset: 0, amount: 1, scale: 1 }).map((l) => l.halfWidth * HAZE_INNER))
  assert.ok(
    narrowest > beast.CREATURE_SHAPE.shoulder / 2,
    `the narrowest band's inner edge is ${narrowest.toFixed(3)} m from the axis and the widest part of the figure is ${(beast.CREATURE_SHAPE.shoulder / 2).toFixed(3)} m`,
  )
  // 4. DETERMINISTIC, and a pure function of its four inputs. The same four numbers
  // give the same six bands, and a shimmer driven by an accumulator would not.
  for (const t of [0, 1.7, 12.25]) {
    assert.deepEqual(
      beast.hazeLayers({ time: t, offset: 0.61, amount: 0.7, scale: 1.04 }),
      beast.hazeLayers({ time: t, offset: 0.61, amount: 0.7, scale: 1.04 }),
      `the shimmer at t=${t} is not reproducible`,
    )
  }
  // 5. IT MOVES, and slowly. The brief said "shimmer" and a shimmer that does not move
  // is a fog patch: over two seconds the bands have to travel, they have to stay inside
  // their own drift bound, and their ALPHA has to move too — a band that slides at a
  // constant brightness is a sliding rectangle, and a rectangle is what this avoids.
  const start = beast.hazeLayers({ time: 0, offset: 0, amount: 1, scale: 1 })
  let moved = 0
  let breathe = 0
  for (let t = 0; t < 2; t += 1 / 120) {
    const now = beast.hazeLayers({ time: t, offset: 0, amount: 1, scale: 1 })
    for (let i = 0; i < now.length; i += 1) {
      moved = Math.max(moved, Math.abs(now[i].warp - start[i].warp))
      breathe = Math.max(breathe, Math.abs(now[i].alpha - start[i].alpha))
      assert.ok(Math.abs(now[i].warp) <= beast.HAZE_DRIFT_METRES + 1e-9, `a band travelled ${now[i].warp} m`)
      assert.ok(now[i].alpha > 0, `a band at t=${t} is at zero alpha inside the column`)
    }
  }
  assert.ok(moved > 0.05, `the shimmer moved ${moved.toFixed(4)} m in two seconds, which is a fog patch`)
  assert.ok(breathe > 0, 'the bands slide at a constant brightness, which is a sliding rectangle')
  // 6. THE LUMA BUDGET, in the renderer's own colour space. The worst pixel is the
  // brightest single band multiplied by the number of bands one pixel can be inside, and
  // the COVERAGE is re-derived from the bands' own extents rather than read off
  // `HAZE_OVERLAP`, so a retune of `HAZE_BAND_FILL` that pushed a third band over one
  // pixel would fail here rather than quietly making the documented budget wrong.
  let coverage = 0
  for (let y = 0; y <= beast.HAZE_SPAN; y += 0.002) {
    let count = 0
    for (const layer of beast.hazeLayers({ time: 0, offset: 0, amount: 1, scale: 1 })) {
      if (Math.abs(y - (layer.y - beast.HAZE_BASE_Y)) <= layer.halfHeight) count += 1
    }
    if (count > coverage) coverage = count
  }
  assert.equal(coverage, beast.HAZE_OVERLAP, `a pixel is inside ${coverage} bands and HAZE_OVERLAP says ${beast.HAZE_OVERLAP}`)
  let peak = 0
  for (let t = 0; t < 6; t += 1 / 240) {
    for (const layer of beast.hazeLayers({ time: t, offset: 0.61, amount: 1, scale: 1 })) {
      peak = Math.max(peak, layer.alpha)
    }
  }
  const hazeLin = linearLuma(beast.HAZE_COLOUR)
  const added = peak * coverage * hazeLin
  const before = encodeLuma(toLinear(HAZE_SURROUND))
  const after = encodeLuma(toLinear(HAZE_SURROUND) + added)
  assert.ok(after - before > 2, `the shimmer adds ${(after - before).toFixed(2)} levels, which is too faint to read`)
  assert.ok(after - before < 12, `the shimmer adds ${(after - before).toFixed(2)} levels, which is a grey pillar rather than a shimmer`)
  // 7. AND THE CEILING THAT MATTERS IS `EYE_MIN` 150. The shimmer alone has to stay far
  // below the luma the eye-finder flood-fills at, or a creature frame could report an
  // eye where there is only a column of hot air.
  const alone = encodeLuma(peak * coverage * hazeLin)
  assert.ok(alone < 60, `the shimmer on its own is luma ${alone.toFixed(1)}, and EYE_MIN is 150`)
  // 8. COOL, and §12.2's rule is that the two light families never mix. A warm shimmer
  //    would put a second orange in a frame whose orange all belongs to the sodium —
  //    and the sodium is about to start flickering because of the creature in it.
  const hex = beast.HAZE_COLOUR
  const r = (hex >> 16) & 255
  const g = (hex >> 8) & 255
  const b = hex & 0xff
  assert.ok(b >= g && g >= r, `HAZE_COLOUR 0x${hex.toString(16)} is warm (${r}, ${g}, ${b}), and the sodium family owns the warm end`)
  assert.notEqual(hex, 0x0a0a0d, 'the shimmer is painted in the creature body colour')
  console.log(
    `\n  pass-11 shimmer: ${beast.HAZE_LAYERS} bands over ${beast.HAZE_SPAN} m, radius ${beast.HAZE_RADIUS} m with a ` +
      `${beast.HAZE_FADE_METRES} m C1 ramp, coverage ${coverage} band(s), worst pixel +${(after - before).toFixed(2)} luma on a ` +
      `19-level surround (${alone.toFixed(1)} alone, EYE_MIN 150)`,
  )
})

test('the lamp the creature stands under strobes, and recovers when it walks on', () => {
  const seed = beast.lampDreadSeed(1337, 0)
  // 1. IT IS 1 OUTSIDE THE RADIUS, exactly, and the word is "exactly": the recovery
  // claim is a fact about the function rather than about a frame somebody watched, and a
  // function that returned 0.999 there would leave every lamp on the street 0.1% wrong.
  for (const d of [beast.LAMP_DREAD_RADIUS, beast.LAMP_DREAD_RADIUS + 0.01, 40, 1e6]) {
    assert.equal(beast.lampDread(d, 1.0, { seed }), 1, `a lamp ${d} m away is at ${beast.lampDread(d, 1.0, { seed })}`)
  }
  // 2. IT STROBES UNDER THE LAMP. "Strobes" is a claim about a RATE and a DEPTH, so
  // both are measured over four seconds: the level has to reach the floor (a dropout is
  // an event, and a smooth curve would pass a monotonicity test), and it has to come
  // back up (a lamp that only ever went down would be a lamp that had failed, not one
  // that is being disturbed).
  // SWEPT OVER TICKS, not over samples, and that is a correction rather than a
  // restatement. The first version of this check sampled at 240 Hz and counted the
  // SAMPLES sitting on the floor, which measures the fraction of TIME the lamp is dark
  // (103.75 samples a second) rather than the number of EVENTS (3.67 ticks a second).
  // Both numbers are true and they are not the claim: `flickerAt` is stepped, so a
  // dropout is a tick and a tick is what a player sees as a flash. Counting ticks is
  // also what makes the rate comparable with `LAMP_DREAD_HZ` at all.
  let lowest = 1
  let highest = 0
  let dropouts = 0
  const ticks = Math.round(4 * beast.LAMP_DREAD_HZ)
  for (let tick = 0; tick < ticks; tick += 1) {
    // Three samples inside the tick, and the tick's level is whichever of them the
    // stepped function returned — which is all three, by the assertion below.
    for (const inside of [0.1, 0.5, 0.9]) {
      const level = beast.lampDread(0.5, (tick + inside) / beast.LAMP_DREAD_HZ, { seed })
      lowest = Math.min(lowest, level)
      highest = Math.max(highest, level)
    }
    if (beast.lampDread(0.5, tick / beast.LAMP_DREAD_HZ, { seed }) <= beast.LAMP_DREAD_FLOOR + 1e-9) dropouts += 1
  }
  assert.ok(lowest <= beast.LAMP_DREAD_FLOOR + 1e-9, `the strobe bottoms out at ${lowest.toFixed(3)} against a floor of ${beast.LAMP_DREAD_FLOOR}`)
  assert.ok(highest > 0.95, `the strobe never comes back up (best ${highest.toFixed(3)}), so it is a failing lamp and not a flickering one`)
  // The RATE, read off the same sweep rather than off the constant: at `LAMP_DREAD_HZ`
  // 11 with one dropout in three, roughly 3.7 dropouts a second is what the function
  // produces, and a fixture that drops three times a second is a strobe. Below about one
  // it is a bad ballast — which is the vending machine, and §12.2's rule is that the two
  // families do not share a character — and above about eight it is a fault nobody can
  // look at.
  const rate = dropouts / 4
  assert.ok(rate > 1 && rate < 8, `the lamp drops out ${rate.toFixed(2)} times a second, which is neither a flicker nor a strobe`)
  // ...and the rate is the DOCUMENTED one, not merely a plausible one: `LAMP_DREAD_HZ`
  // ticks a second with one in `LAMP_DREAD_ONE_IN` a dropout is
  // `HZ / ONE_IN` = 3.67, and `flickerAt` is a hash so the count is a binomial around it.
  // Asserted as a window because a hash's exact count is not a constant, which is the
  // difference between "seeded" and "written down".
  const expected = beast.LAMP_DREAD_HZ / beast.LAMP_DREAD_ONE_IN
  assert.ok(Math.abs(rate - expected) < expected * 0.35, `the lamp drops out ${rate.toFixed(2)} times a second against a documented ${expected.toFixed(2)}`)
  // 3. IT IS STEPPED, and that is the property that makes it testable at all: the same
  // tick asked for twice — once to build the frame, once to measure it — has to agree,
  // because `flickerAt` is a function of the tick INDEX and a level that moved inside a
  // tick would be a level the renderer and the gate could each see differently.
  const tick = 1 / beast.LAMP_DREAD_HZ
  for (let i = 0; i < 40; i += 1) {
    const t = 3 + i * tick * 0.5
    assert.equal(beast.lampDread(0.5, t, { seed }), beast.lampDread(0.5, t + tick * 0.4, { seed }), `the level moved inside tick ${i}`)
  }
  // ...and it is a function of the SEED, which is the whole of D10 for this effect: two
  // lamps under two creatures never share a pattern, and the seed is DERIVED rather than
  // typed at the call site, for pass 7's reason.
  const other = beast.lampDreadSeed(1337, 1)
  assert.notEqual(seed, other, 'two lamps in the pool share a seed, so they strobe in lockstep')
  // The claim is about the DROPOUT PATTERN, and it is measured as one. The first version
  // of this check counted how many of 200 samples the two lamps agreed on, which came out
  // at 22 and read as a failure: two independent 1-in-3 strobes agree on about a third
  // of their ticks by chance, because most agreement is both of them sitting at their
  // own maximum. What "two lamps" means is that they do not drop out on the same TICKS,
  // and that is what is compared.
  const dark = (s2, tick) => (beast.lampDread(0.5, tick / beast.LAMP_DREAD_HZ, { seed: s2 }) <= beast.LAMP_DREAD_FLOOR + 1e-9)
  let bothDark = 0
  let eitherDark = 0
  for (let tick = 0; tick < 60; tick += 1) {
    const a = dark(seed, tick)
    const b = dark(other, tick)
    if (a && b) bothDark += 1
    if (a || b) eitherDark += 1
  }
  assert.ok(eitherDark > 0, 'neither lamp ever drops out, so there is no pattern to differ')
  assert.notEqual(bothDark, 0, 'the two lamps are in step on every tick, which is one lamp with two meshes')
  // ...and the overlap is consistent with independence rather than with a shared stream:
  // two 1-in-3 patterns of length 60 give ~6.7 coincident dark ticks in the mean, and a
  // shared seed gives 20.
  assert.ok(bothDark < eitherDark * 0.6, `${bothDark} of ${eitherDark} dark ticks coincide, which is a shared stream`)
  // 4. AND IT RECOVERS MONOTONICALLY as the creature walks out, which is the brief's
  // "recovering after it leaves". Monotone in the ENVELOPE rather than in the value —
  // the strobe is a square wave and its own max/min are not monotone, so the assertion
  // is on the window mean, which is what a player perceives as the lamp coming back.
  let previous = -1
  for (let d = 0; d <= beast.LAMP_DREAD_RADIUS + 2; d += 0.25) {
    let sum = 0
    for (let t = 0; t < 2; t += 1 / 11) sum += beast.lampDread(d, t, { seed })
    const mean = sum / (2 * 11)
    assert.ok(mean >= previous - 1e-9, `the lamp's mean level FELL from ${previous.toFixed(3)} to ${mean.toFixed(3)} as the creature walked from ${(d - 0.25).toFixed(2)} m to ${d.toFixed(2)} m away`)
    previous = mean
  }
  assert.ok(previous > 0.99, `a lamp at ${beast.LAMP_DREAD_RADIUS + 2} m is at a mean of ${previous.toFixed(3)}, not fully recovered`)
  // 5. AND IT IS LOCAL: a lamp twice the radius away is untouched, which is the
  // difference between a presence in a place and a global dimmer.
  const near = beast.lampDread(2, 1.0, { seed })
  const far = beast.lampDread(beast.LAMP_DREAD_RADIUS * 2, 1.0, { seed })
  assert.ok(near < far, `a lamp 2 m away reads ${near.toFixed(3)} and one ${beast.LAMP_DREAD_RADIUS * 2} m away reads ${far.toFixed(3)}`)
  // 6. TOTAL, because a NaN distance in a render loop is a lamp that never comes back.
  for (const bad of [NaN, Infinity, -3, 'x', undefined, null]) {
    const value = beast.lampDread(bad, 1.0, { seed })
    assert.ok(Number.isFinite(value) && value >= beast.LAMP_DREAD_FLOOR - 1e-9 && value <= 1, `lampDread(${bad}) is ${value}`)
  }
  console.log(
    `\n  pass-11 lamp dread: radius ${beast.LAMP_DREAD_RADIUS} m with a ${beast.LAMP_DREAD_FADE} m ramp, ` +
      `${beast.LAMP_DREAD_HZ} Hz, floor ${beast.LAMP_DREAD_FLOOR}, ${rate.toFixed(2)} dropouts/s, ` +
      `range ${lowest.toFixed(2)}-${highest.toFixed(2)} under the lamp and exactly 1 outside it`,
  )
})

test('the eye flare pulses the lamp with its own envelope, once', () => {
  // THE IDENTITY, over the whole window rather than at two sampled instants, because
  // this is the audio-visual sync claim and a sync claim is about a CURVE. A second
  // envelope with its own length and its own peak would be two events that happen to be
  // near each other; `lampPulse` is the flare's envelope with a gain on it, so the two
  // are the same number read twice and they cannot drift.
  for (let t = 0; t < beast.EYE_FLARE_SECONDS * 1.5; t += 1 / 240) {
    const flare = beast.eyeFlare(t)
    const pulse = beast.lampPulse(flare)
    assert.equal(pulse, 1 + beast.LAMP_PULSE_GAIN * flare, `at t=${t.toFixed(3)} the lamp is at ${pulse} for a flare of ${flare}`)
  }
  // 1. EXACTLY 1 outside the window, on both sides. A pulse that never returned to 1
  // would be a lamp left 45% bright for ever after one sighting, and a run has four of
  // those.
  assert.equal(beast.lampPulse(beast.eyeFlare(null)), 1, 'a null flare pulses the lamp')
  assert.equal(beast.lampPulse(beast.eyeFlare(beast.EYE_FLARE_SECONDS)), 1, 'the pulse outlives the window')
  assert.equal(beast.lampPulse(beast.eyeFlare(beast.EYE_FLARE_SECONDS + 5)), 1)
  assert.equal(beast.lampPulse(0), 1)
  // 2. THE PEAK IS `1 + GAIN` and the gain is under half, because the ceiling is the
  // creature's own eye: `EYE_FLARE_GAIN` 2.2 arrives on a 7 px unfogged additive quad
  // and this arrives across a whole pool of road. The lamp is the echo and the eye is
  // the event, and the order of those two is the composition.
  assert.equal(beast.lampPulse(1), 1 + beast.LAMP_PULSE_GAIN)
  assert.ok(beast.LAMP_PULSE_GAIN > 0.2, 'the lamp does not move at all, which is not a sync')
  assert.ok(beast.LAMP_PULSE_GAIN < 0.5, `the lamp gains ${(beast.LAMP_PULSE_GAIN * 100).toFixed(0)}%, which is louder than the eye it is echoing`)
  assert.ok(beast.LAMP_PULSE_GAIN < beast.EYE_FLARE_GAIN / 4, 'the echo is louder than the event')
  // 3. ONE PULSE, not a beat: the envelope is strictly falling after its first frame,
  // so a player cannot be shown a second brightening inside the window.
  let rising = 0
  for (let t = 0; t < beast.EYE_FLARE_SECONDS; t += 1 / 240) {
    if (beast.lampPulse(beast.eyeFlare(t + 1 / 120)) > beast.lampPulse(beast.eyeFlare(t))) rising += 1
  }
  assert.equal(rising, 0, 'the lamp pulse rises again inside the window, so it beats')
  // 4. AND IT COMPOSES WITH THE STROBE rather than fighting it. The two are multiplied
  // in `world.js`, and the reason that is safe is that a GAIN cannot exceed a base it
  // is applied to: the brightest a drodded lamp ever gets is `1 + GAIN` times its own
  // top tick, which is a lamp surging to its own maximum, never a lamp exceeding it.
  const seed = beast.lampDreadSeed(1337, 0)
  let worst = 0
  let reached = 0
  let plainSum = 0
  let pulsedSum = 0
  let samples = 0
  for (let t = 0; t < beast.EYE_FLARE_SECONDS; t += 1 / 480) {
    const plain = beast.lampDread(0.5, t, { seed })
    const composed = plain * beast.lampPulse(beast.eyeFlare(t))
    worst = Math.max(worst, composed)
    if (composed > plain) reached += 1
    plainSum += plain
    pulsedSum += composed
    samples += 1
  }
  // A GAIN cannot exceed the base it is applied to, so the composed level never rises
  // above the lamp's own top tick: a strobing lamp surges to its maximum and no further.
  assert.ok(worst <= 1 + beast.LAMP_PULSE_GAIN + 1e-9, `the composed lamp level reached ${worst.toFixed(3)}, above its own top tick`)
  // ...and it does not get SWALLOWED either, which is the failure a multiplier can have:
  // if the strobe's dropouts always landed on the flare's bright frames, the pulse would
  // be arithmetic that never reaches the screen. Sampled at 480 Hz — twice the strobe
  // rate — so a window of one tick cannot hide between two samples.
  // A proportion rather than a count, and the reason is worth recording: the window's
  // last sample is a float accumulation away from the envelope's zero, so `eyeFlare` can
  // return exactly 0 one step before the loop's bound and cost one sample its lift. The
  // claim is "the pulse is applied across the window", not "every single sample of it".
  assert.ok(reached >= samples * 0.95, `the pulse lifted the lamp on only ${reached} of ${samples} samples of the window`)
  const meanLift = pulsedSum / plainSum
  assert.ok(meanLift > 1.05, `the pulse lifts the lamp's mean level by ${((meanLift - 1) * 100).toFixed(1)}%, which is under the eye's own 120% and too small to read`)
  console.log(
    `\n  pass-11 lamp pulse: 1 -> ${(1 + beast.LAMP_PULSE_GAIN).toFixed(2)} on the same envelope as the eye flare ` +
      `(${beast.EYE_FLARE_SECONDS} s, peak ${beast.EYE_FLARE_GAIN} on the eye)`,
  )
})

test('a footfall lays one puff, and a standing creature lays none', () => {
  // THE CARRIER IS METRES, not frames and not the drawn gait, and the first claim is
  // the one an accumulator gets wrong: the same walk has to produce the same field in
  // 60 frames and in 600. `dripStep` above is the same test on the same model and this
  // one is a copy of it deliberately — two reducers that are the same kind of thing
  // should be gated the same way, or the second one is the one nobody re-reads.
  const walk = (seconds, fps) => {
    const steps = Math.round(seconds * fps)
    const dt = 1 / fps
    const speed = 2.2
    let field = beast.createPuffField()
    for (let i = 0; i < steps; i += 1) {
      const x = i * speed * dt
      field = beast.puffStep(field, {
        walked: speed * dt,
        dx: speed * dt,
        dz: 0,
        x,
        z: 0,
        time: i * dt,
        present: true,
        clear: true,
        seed: 1337,
      }).field
    }
    return field
  }
  const sixty = walk(3, 60)
  const sixHundred = walk(3, 600)
  assert.equal(sixty.laid, Math.floor((2.2 * 3) / beast.FOOTFALL_STRIDE_METRES), `a 6.6 m walk laid ${sixty.laid} puffs`)
  assert.equal(sixHundred.laid, sixty.laid, 'the dust depends on the frame rate')
  // The SHAPES are identical, because they are hashed from the puff's own index and not
  // from the frame. The POSITIONS are not, and cannot be: a puff is laid where the
  // creature happened to be when the footfall completed, so a finer frame resolves the
  // foot to a different millimetre. The bound is ONE COARSE FRAME of travel, which is
  // the coarse frame's own resolution of where the foot landed, and it is asserted rather
  // than assumed. (This is the trail's frame-rate test above, on the same model and for
  // the same reason; the first version of this one compared positions exactly and failed
  // by 3 cm, which is 1/60th of a second of walking and not a defect.)
  assert.deepEqual(
    sixty.puffs.map((p) => [p.radius.toFixed(9), p.spin.toFixed(9)]),
    sixHundred.puffs.map((p) => [p.radius.toFixed(9), p.spin.toFixed(9)]),
    'the same walk lays differently SHAPED puffs at 600 fps than at 60',
  )
  const oneFrame = (2.2 * 3) / 60
  for (let i = 0; i < sixty.puffs.length; i += 1) {
    const gap = Math.abs(sixHundred.puffs[i].x - sixty.puffs[i].x)
    assert.ok(gap < oneFrame, `puff ${i} is ${gap.toFixed(4)} m apart between the two frame rates`)
  }
  // 2. AND THE STRIDE IS HALF THE TRAIL'S, which is the claim that makes it dust and not
  // a stain: two feet, one puff each, per stride.
  assert.equal(beast.FOOTFALL_STRIDE_METRES * 2, beast.DRIP_STRIDE_METRES, 'a puff is not laid once per footfall')
  // 3. NOTHING FOR STANDING STILL, and the reason is the carrier rather than a test: a
  // present and motionless creature accumulates nothing, and the drawn stride — which
  // advances for a standing creature — is not what it is keyed to.
  let still = beast.createPuffField()
  for (let i = 0; i < 600; i += 1) {
    still = beast.puffStep(still, { walked: 0, x: 0, z: 0, time: i / 60, present: true, clear: true, seed: 1337 }).field
  }
  assert.equal(still.laid, 0, 'a standing creature is breathing dust')
  // ...and nothing while it is not there at all, which is §7.4's banish and the Act I
  // telegraph: a telegraph that dusts a road it has not walked to is the bug this
  // reducer exists to prevent.
  let absent = beast.createPuffField()
  for (let i = 0; i < 600; i += 1) {
    absent = beast.puffStep(absent, { walked: 2.2 / 60, x: i, z: 0, time: i / 60, present: false, clear: true, seed: 1337 }).field
  }
  assert.equal(absent.laid, 0, 'a banished creature is still dusting the road')
  // 4. THE CAP, and the eviction order. §10.2's finale wants 5.2 / 0.45 x 0.95 = 11
  // puffs alive and gets `PUFF_MAX` 10, so the cap is load-bearing and the oldest is
  // the one that goes — which `puffAlpha` has already made the faintest, so "oldest
  // fades first" and "oldest goes first" are the same statement.
  let over = beast.createPuffField()
  for (let i = 0; i < beast.PUFF_MAX + 40; i += 1) {
    over = beast.puffStep(over, { walked: 0.5, x: i * 0.5, z: 0, time: i / 60, present: true, clear: true, seed: 1337 }).field
  }
  assert.equal(over.puffs.length, beast.PUFF_MAX, `the field holds ${over.puffs.length} puffs, not PUFF_MAX`)
  // The order is NON-DECREASING, not strictly increasing, and the first version of this
  // assertion said `>` and failed on a tie that is not a defect. Two footfalls can land
  // inside one frame: `walked: 0.5` per frame against a 0.45 m stride carries a spare, and
  // once the spare reaches 0.9 a single frame lays two puffs at the same `born`. Their
  // alphas are then equal too, so "the oldest is the faintest" is still true as a
  // non-strict statement — and a strict reading of it would have pushed for a tie-break
  // the design does not have and does not need.
  const ages = over.puffs.map((p) => p.born)
  for (let i = 1; i < ages.length; i += 1) {
    assert.ok(ages[i] >= ages[i - 1], 'the survivor list is not oldest-first, so the cap could evict the faintest and keep the darkest')
  }
  assert.equal(ages[0], Math.min(...ages), 'the head of the list is not the oldest puff in it')
  // ...and the evictions really were evictions, read against the cap rather than against
  // the list. 50 frames of `walked: 0.5` lay 55 puffs, not 50: 0.5 m per frame against a
  // 0.45 m stride leaves a 0.05 m spare every frame, and every ninth frame that spare
  // crosses a whole stride and lays a second. The count is arithmetic and is asserted as
  // such rather than assumed, because "it laid more than I asked for" is exactly the
  // sentence a reviewer should not have to take on trust.
  assert.equal(over.laid, 55, `the over-cap walk laid ${over.laid}, not the 55 its own stride arithmetic gives`)
  // 5. AND A GATE SUPPRESSES THEM, which for dust matters MORE than for the trail: a
  // trail mark is a dark decal and a puff is a bright one, and the pass-3 gate measures
  // the luma of the HOLE in `portal-located.png`.
  let gated = beast.createPuffField()
  for (let i = 0; i < 60; i += 1) {
    gated = beast.puffStep(gated, { walked: 2.2 / 60, x: i * 0.1, z: 0, time: i / 60, present: true, clear: false, seed: 1337 }).field
  }
  assert.equal(gated.laid, 0, 'a puff was laid inside the portal stand-off')
  assert.ok(gated.suppressed > 0, 'the stand-off fired and counted nothing, so the rule cannot be required')
  // 6. DETERMINISTIC, and the form of the claim is the point: the same walk, driven
  // twice, has to produce the same field down to the last seeded radius. A
  // `Math.random` in a puff's shape, or a clock read in the view, would pass every check
  // above and fail this one.
  assert.deepEqual(walk(2, 60), walk(2, 60), 'the same walk laid two different fields')
  // 7. THE PUFF'S OWN CURVES, and the two that make it dust rather than a decal: it
  // GROWS over its life and it RISES, and it fades with no corner in the tail.
  assert.equal(beast.puffRadius(0), beast.PUFF_RADIUS, 'a puff does not start at its own radius')
  assert.ok(
    Math.abs(beast.puffRadius(beast.PUFF_LIFE * 0.999) - beast.PUFF_RADIUS * (1 + beast.PUFF_SPREAD)) < 1e-3,
    'a puff does not end at PUFF_RADIUS x (1 + PUFF_SPREAD)',
  )
  // Sampled just short of the end, and the reason is in the next two lines: a dead puff
  // is placed at the GROUND (`puffLift(PUFF_LIFE)` is 0), so the two endpoints of the
  // life are 0.06 and 0 and the curve between them is what "rises" means.
  assert.ok(beast.puffLift(beast.PUFF_LIFE * 0.99) > beast.puffLift(0) * 2, 'dust does not rise')
  assert.equal(beast.puffRadius(beast.PUFF_LIFE), 0, 'a dead puff still has a radius')
  assert.equal(beast.puffLift(beast.PUFF_LIFE), 0)
  assert.equal(beast.puffAlpha(beast.PUFF_LIFE), 0)
  assert.equal(beast.puffAlpha(-1), 0)
  assert.ok(beast.puffAlpha(beast.PUFF_FADE) > 0.9, 'a puff never reaches full strength')
  let previous = 2
  for (let age = beast.PUFF_FADE; age < beast.PUFF_LIFE; age += 0.005) {
    const alpha = beast.puffAlpha(age)
    assert.ok(alpha <= previous + 1e-12, `the puff's alpha rose from ${previous.toFixed(4)} to ${alpha.toFixed(4)} at ${age.toFixed(3)} s`)
    previous = alpha
  }
  // 8. AND IT CANNOT BE FOUND AS THE CREATURE'S EYE. `tools/png-luma.mjs` rejects any
  // blob spanning more than `EYE_MAX_SPAN` 14 px, and at the 7.8 m the chase view puts
  // the creature's feet a 0.48 m puff is about 30 px across — so the shape test alone
  // rejects it, before the luma floor is consulted. This is `DRIP_RADIUS`'s bound in the
  // other direction: a dark 15 px mark is invisible to the finder, and a bright 30 px one
  // is too big to be an eye.
  const pixels = (metres, distance, viewportHeight, fov = 72) =>
    (metres / distance) * (viewportHeight / 2) / Math.tan((fov * Math.PI) / 360)
  const widest = pixels(beast.PUFF_RADIUS * 2 * (1 + beast.PUFF_SPREAD), 7.8, 720)
  assert.ok(widest > 14, `a puff at 7.8 m spans ${widest.toFixed(1)} px, which is INSIDE EYE_MAX_SPAN 14 and could be read as an eye`)
  // ...and it is a BLEND, so it can never reach 1 and can never be a hole cut in the
  // road. The composite is what matters and it is checked as a composite.
  assert.ok(beast.PUFF_OPACITY < 1, 'an opaque puff is a hole cut in the road')
  assert.ok(beast.PUFF_OPACITY > 0.15, 'a puff too faint to see is not a footfall')
  const puffLin = linearLuma(beast.PUFF_COLOUR)
  const composite = encodeLuma(toLinear(HAZE_SURROUND) * (1 - beast.PUFF_OPACITY) + puffLin * beast.PUFF_OPACITY)
  assert.ok(composite > 30, `a puff over a 19-level surround composites to luma ${composite.toFixed(1)}, which is too faint to see`)
  assert.ok(composite < 150, `a puff composites to luma ${composite.toFixed(1)}, and EYE_MIN is 150`)
  // ...and it is COOLER than the sodium it stands in, because a puff that is the same
  // colour as the lamp it is standing in is a lamp.
  assert.ok(paletteLuma('sodium') > encodeLuma(puffLin), 'the dust is brighter than the lamp above it')
  // 9. TOTAL, for the same reason `lampDread` is: a NaN in a render loop is a puff that
  // never dies and a field that never stops growing.
  for (const bad of [NaN, Infinity, -1, 'x', undefined, null]) {
    const out = beast.puffStep(beast.createPuffField(), { walked: bad, x: bad, z: bad, dx: bad, dz: bad, time: bad, present: true, seed: bad })
    assert.ok(Number.isFinite(out.field.laid) && Number.isFinite(out.field.spare), `puffStep walked ${bad} produced ${JSON.stringify(out.field)}`)
    assert.ok(
      Number.isFinite(beast.puffAlpha(bad)) && Number.isFinite(beast.puffRadius(bad)) && Number.isFinite(beast.puffLift(bad)),
      `the puff curves of ${bad} are not finite`,
    )
  }
  console.log(
    `\n  pass-11 dust: one puff per ${beast.FOOTFALL_STRIDE_METRES} m (half the trail's ${beast.DRIP_STRIDE_METRES}), ` +
      `cap ${beast.PUFF_MAX} (the finale wants ${(beast.SPEED_CEILING / beast.FOOTFALL_STRIDE_METRES * beast.PUFF_LIFE).toFixed(1)}), ` +
      `life ${beast.PUFF_LIFE} s, a ${widest.toFixed(0)} px blob at 7.8 m compositing to luma ${composite.toFixed(0)} of 255`,
  )
})

/**
 * `creaturePresenceClaims` — pass 11's source contracts, as predicates over a source
 * string.
 *
 * The same shape as `creatureFidelityClaims` and for the same reason: a gate expressed
 * as `assert.ok` can only ever run on the real file, and a gate that can only run on the
 * real file cannot be asked whether it would have caught the bug.
 *
 * ELEVEN OF THIS PASS'S PROPERTIES ARE INVISIBLE TO ANY MEASUREMENT OF THE PURE MODULE,
 * and they are all visible as a pattern of what is written: that the shimmer is ONE mesh
 * of `HAZE_LAYERS` x 4 quads rather than six of them; that its per-band alpha rides on a
 * FOUR-component vertex colour (three.js sets `USE_COLOR_ALPHA` from `itemSize === 4`, so
 * a three-component attribute compiles, runs, and silently throws the alpha away — which
 * for the shimmer is a column of solid grey, at 48 triangles, in every frame); that it is
 * `AdditiveBlending` and `fog: false`, which are the two halves of "a shimmer is light
 * and is a depth cue of its own"; that the dust is the opposite on both counts
 * (`NormalBlending`, `fog: true`) and is therefore not a floor-level light source; that
 * both new surfaces sit at `renderOrder` 0 and the eye keeps its lift; that the WORLD
 * asks `creature.js` for the lamp level rather than computing one, and asks for the
 * pulse from the pose's `eyeFlare` rather than from a second clock; that the two fields
 * share ONE measurement of the creature's move; and that all three new scene objects are
 * removed on dispose.
 *
 * EVERY REGEX IS SCOPED TO A METHOD BODY, and that is the lesson of this pass's first two
 * repair mutations rather than a style preference: `creatureFidelityClaims` had two
 * whole-file searches that found a SECOND copy of the text they were looking for the
 * moment pass 11 wrote the second copy, and both of those mutations went quiet without
 * either one failing. A claim about one method is written against that method.
 *
 * @param {string} view `creatureView.js`, comments NOT yet stripped
 * @param {string} world `world.js`
 * @param {string} creature `creature.js`
 * @returns {{name: string, ok: boolean, why: string}[]}
 */
function creaturePresenceClaims(view, world, creature) {
  const code = stripProse(view)
  // The other two are stripped too, and pass 10's version of this function did not strip
  // them — it had no whole-file negative over `creature.js` to make it matter. Pass 11
  // has one ("nothing in the pass is unseeded"), and it fired on pass 11's OWN PROSE:
  // `puffStep`'s comment says a `Math.random` in a puff's shape would break the field, and
  // an unstripped search for `Math.random` cannot tell that sentence from the bug it
  // describes. A negative claim over source has to be made over the CODE.
  const worldCode = stripProse(world)
  const creatureCode = stripProse(creature)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })
  const haze = methodBody(code, '_buildHaze')
  const puffs = methodBody(code, '_buildPuffs')
  const presentHaze = methodBody(code, '_presentHaze')
  const presentPuffs = methodBody(code, '_presentPuffs')
  const presentAll = methodBody(code, 'present')
  const dread = methodBody(worldCode, '_writeLampDread')
  const advance = methodBody(worldCode, '_advancePuffs')
  const trailAdvance = methodBody(worldCode, '_advanceTrail')
  const walk = methodBody(worldCode, '_measureWalk')

  // 1. THE SHIMMER IS ONE MESH of `HAZE_LAYERS` bands of four quads, and the band count
  //    is read out of the pure module rather than typed here. Six meshes would be six
  //    draw calls for something the eye integrates into one column.
  claim(
    'the shimmer is one mesh of HAZE_LAYERS bands, with a real per-vertex alpha',
    /const quads = HAZE_LAYERS \* 4/.test(haze)
      && /new Float32Array\(quads \* 4 \* 4\)/.test(haze)
      && /new THREE\.BufferAttribute\(colours, 4\)/.test(haze)
      && /vertexColors: true/.test(haze)
      && (code.match(/new THREE\.Mesh\(geometry, this\.hazeMaterial\)/g) ?? []).length === 1
      && !/InstancedMesh/.test(haze),
    "six bands as six meshes is six draw calls for one column, an instanced pool has no per-instance alpha in stock three.js so the fade would become nothing, and a three-component colour attribute compiles and discards the alpha — which for the shimmer is a column of solid grey",
  )
  // 2. IT IS ADDITIVE AND UNFOGGED, which are two halves of one claim. Additive because a
  //    shimmer is refracted light; a blended pale grey over near-black asphalt is a grey
  //    stain. `fog: false` because additive plus fog is a fog-coloured ADD, and the
  //    shimmer's own `hazeAmount` falloff — exactly 0 at 30 m — is the better depth cue.
  claim(
    'the shimmer is additive and unfogged, and the eye keeps its lift',
    /blending: THREE\.AdditiveBlending/.test(haze)
      && /fog: false/.test(haze)
      && /side: THREE\.DoubleSide/.test(haze)
      && /const HAZE_RENDER_ORDER = 0/.test(code)
      && /this\.haze\.renderOrder = HAZE_RENDER_ORDER/.test(haze)
      && /const EYE_RENDER_ORDER = ([1-9]\d*)/.exec(code) !== null
      && /eye\.renderOrder = EYE_RENDER_ORDER/.test(code),
    'a blended shimmer is a grey stain, a fogged additive one adds the fog colour, and a single-sided ring vanishes from half the bearings — while any of the three landing after EYE_RENDER_ORDER would be the pass-6 wire bug wearing a column of hot air',
  )
  // 3. THE BAND IS AN ANNULUS, and this is the claim the creature gate rests on: the
  //    alpha is 0 on the inner edge and 1 on the outer, and the inner edge is a FRACTION
  //    of the outer rather than a second number. An additive curtain painted over the
  //    figure raises the body's own luma against its local surround, and
  //    `creature-stalking.png` has 0.013 of headroom on that measurement.
  claim(
    'a band is an annulus, and its inner edge is a fraction of the outer',
    /const alpha = \[0, 1, 1, 0\]/.test(presentHaze)
      && /colours\[at4 \+ 3\] = layer\.alpha \* alpha\[i\]/.test(presentHaze)
      && /const inner = outer \* HAZE_INNER_FRACTION/.test(presentHaze)
      && /const HAZE_INNER_FRACTION = (0\.[1-9])/.test(code),
    'a band with alpha across its middle is a curtain painted over the creature, and the one measurement in the repository that cannot afford it is a body against its own local surround',
  )
  // 4. AND THE SHIMMER IS A SIBLING OF THE FIGURE, positioned from the frame rather than
  //    parented: a shimmer parented to `root` would travel with the creature, and this is
  //    supposed to be air standing where the creature is standing.
  claim(
    'the shimmer and the dust are siblings of the figure, not children',
    /this\.haze\.position\.set\(position\.x, 0, position\.z\)/.test(presentHaze)
      && /this\.haze\.rotation\.y = context\.yaw/.test(presentHaze)
      && /scene\.add\(this\.haze\)/.test(haze)
      && /scene\.add\(this\.puffs\)/.test(puffs)
      && !/this\.root\.add\(this\.(haze|puffs)\)/.test(code),
    'a shimmer parented to the creature is a property of the creature and travels with it, and a puff parented to it is a puff that follows the thing that kicked it up',
  )
  // 5. THE DUST IS THE OPPOSITE ON BOTH COUNTS, and the pair is the reason it is dust.
  //    `NormalBlending` because dust occludes and does not emit — an additive puff is a
  //    light source at floor level, which is exactly what the eye-finder is looking for
  //    — and `fog: true` because a puff is a depth cue over the road, and an unfogged
  //    bright billboard at 40 m is a floating light.
  claim(
    'the dust is a blended, fogged, billboarded decal and not an additive one',
    /new Float32Array\(PUFF_MAX \* 4 \* 4\)/.test(puffs)
      && /new THREE\.BufferAttribute\(colours, 4\)/.test(puffs)
      && /blending: THREE\.NormalBlending/.test(puffs)
      && /opacity: PUFF_OPACITY/.test(puffs)
      && /color: PUFF_COLOUR/.test(puffs)
      && /fog: true/.test(puffs)
      && /const PUFF_RENDER_ORDER = 0/.test(code)
      && /this\.puffs\.renderOrder = PUFF_RENDER_ORDER/.test(puffs)
      && /applyQuaternion\(camera\.quaternion\)/.test(presentPuffs)
      && /puffRadius\(time - puff\.born\)/.test(presentPuffs)
      && /puffLift\(time - puff\.born\)/.test(presentPuffs)
      && /puffAlpha\(time - puff\.born\)/.test(presentPuffs)
      && !/AdditiveBlending/.test(puffs),
    "additive dust is a floor-level light the eye-finder can find, an unfogged one floats in the distance, and a puff laid in the ground plane instead of on the camera's basis is a sliver edge-on rather than a puff",
  )
  // 6. THE WORLD ASKS `creature.js` for the lamp level, and for the pulse off the POSE.
  //    This is the most important contract in the pass: a level computed in `world.js`
  //    would be a second definition of a moment the pure harness tests, and a pulse read
  //    from a clock of its own would be two events that happen to be near each other
  //    rather than one.
  claim(
    'the world asks the pure module for the lamp level, the pulse and the seeds',
    /beast\.lampDread\(distance, this\.animTime, \{ seed: beast\.lampDreadSeed\(this\.seed, i\) \}\)/.test(dread)
      && /beast\.lampPulse\(pose\.eyeFlare\)/.test(dread)
      && /distance < beast\.LAMP_DREAD_RADIUS/.test(dread)
      && /LAMP_LIGHT_INTENSITY \* level \* \(near \? pulse : 1\)/.test(dread)
      && /LAMP_BOUNCE_INTENSITY \* level \* \(near \? pulse : 1\)/.test(dread),
    'a lamp level computed in the world is a second definition of a moment the pure harness tests, a pulse off a clock of its own is two events rather than one sync, and a bounce left steady under a drodded key is sodium returning off a road that has gone dark',
  )
  // 7. AND THE PULSE REACHES ONLY A LAMP THE CREATURE IS NEAR, because the brief said
  //    "nearby" and a lamp across the street swelling on the creature's behalf is a lie
  //    about where the light came from.
  //
  //    IT IS GATED ON TWO THINGS, and the pass-11 review added the second. The radius is
  //    the original half. The `drawn !== null` half is there because every current call
  //    site passes no pose when it passes no figure, so the term is `pulse` of 1 today
  //    and the guard reads as redundant — and a reviewer removed it and 94/94 world
  //    checks still passed. It is the only thing between a caller that passes a pose
  //    and a lamp surging at an absence, so the claim is written to fail if it goes.
  claim(
    'the pulse is gated on the same radius the drodd is, and on there being a figure',
    /const near = drawn !== null && distance < beast\.LAMP_DREAD_RADIUS/.test(dread)
      && (dread.match(/\(near \? pulse : 1\)/g) ?? []).length === 2,
    'an ungated pulse is every lamp on the street answering one sighting, and a radius the two terms do not share is a rule with two numbers',
  )
  // 8. THE TWO FIELDS SHARE ONE MEASUREMENT of the creature's move, and the cache is keyed
  //    on the frame's own `drawn` object. Two measurements of one move is one too many:
  //    the second reads the record the first has just advanced and lays nothing at all.
  claim(
    'the trail and the dust share one measurement of the frame\'s move',
    /const \{ dx, dz, walked, jumped \} = this\._measureWalk\(drawn, dt\)/.test(advance)
      && /const \{ dx, dz, walked, jumped \} = this\._measureWalk\(drawn, dt\)/.test(trailAdvance)
      && /if \(this\._walkFor === drawn\) return this\._walk/.test(walk)
      && /walked > beast\.SPEED_CEILING \* step \* 1\.5/.test(walk),
    "the trail would be laid from this frame's move and the dust from zero, and the two would drift a frame apart for the whole run; a cache keyed on anything but the frame's own object hands back a measurement taken against the last run's position after a wipe",
  )
  // 9. THE DUST IS THE PURE REDUCER'S, folded into the drawn copy and kept out of the
  //    portal stand-off — which for a BRIGHT decal matters more than for a dark one,
  //    because the pass-3 gate measures the luma of the hole.
  claim(
    'the dust is the pure reducer\'s, folded into the drawn copy and out of the pupil',
    /beast\.puffStep\(this\.creaturePuffs, \{/.test(advance)
      && /this\.creaturePuffs = beast\.createPuffField\(\)/.test(worldCode)
      && /puff\.x \+ origin\.x, z: puff\.z \+ origin\.z/.test(advance)
      && /clear: this\.streetView\.clearOfPortals\(drawn\.x, drawn\.z\)/.test(advance)
      && /puffs: this\._advancePuffs\(drawn, pose\.present, dt\)/.test(worldCode),
    'a field the world builds for itself is a field the pure harness cannot test, a puff in drawn coordinates is 448 m from its own road after the first wrap, and a bright puff standing in the pupil stand-off fills the hole the pass-3 gate measures',
  )
  // 10. AND ALL THREE NEW OBJECTS ARE RELEASED. §15's teardown is a definition of done,
  //     and every one of these is a SIBLING of `root` rather than a child, so removing
  //     the figure does not remove them.
  claim(
    'the shimmer, the dust and their materials are released on dispose',
    /this\.scene\?\.remove\(this\.haze\)/.test(code)
      && /this\.scene\?\.remove\(this\.puffs\)/.test(code)
      && /this\._materials\.push\(this\.hazeMaterial\)/.test(haze)
      && /this\._materials\.push\(this\.puffMaterial\)/.test(puffs)
      && /this\.haze\.visible = false/.test(presentAll)
      && /this\.puffs\.visible = false/.test(presentAll),
    "three siblings of the figure are left attached to a dead scene, which never shows up as a bug and is exactly the debt pass 19 exists to sweep; and a shimmer left hanging in the air where a banished creature stood is the one artefact this pass could ship that nothing else would notice",
  )
  // 11. AND NOTHING NEW IS UNSEEDED OR WALL-CLOCKED. D10 is the repository's rule and
  //     §16.5 needs each of fourteen frames to be reproducible twice.
  claim(
    'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
    !/Math\.random/.test(code + worldCode + creatureCode)
      && !/Date\.now|performance\.now|new Date/.test(code + worldCode + creatureCode)
      && /const salt = hash32\(seed, laid, PUFF_SALT\)/.test(creatureCode)
      && /flickerAt\(seed, Math\.floor\(t \* LAMP_DREAD_HZ\)/.test(creatureCode)
      // Scoped to `lampDreadSeed`'s own body, which is the third time in this pass that a
      // whole-file search has found a second copy of the text it was looking for: the
      // file already had a `return hash32(` at line 796 from an earlier slice, so
      // mutating this pass's own `return hash32(` left the regex satisfied and the
      // mutation proved nothing. The claim is about this function's seed, so it reads
      // this function.
      && /return hash32\(/.test(methodBody(creatureCode, 'lampDreadSeed')),
    'D10 is the rule and §16.5 needs each of fourteen frames reproducible twice, so an unseeded puff shape or a wall-clock drift is a frame that cannot be re-taken',
  )
  return claims
}

test('the presence claims are the source contracts, and every one holds', () => {
  const claims = creaturePresenceClaims(CREATURE_VIEW_SOURCE, WORLD_SOURCE, CREATURE_SOURCE)
  const broken = claims.filter((entry) => !entry.ok)
  assert.deepEqual(broken, [], `${broken.map((entry) => `${entry.name} — ${entry.why}`).join(' | ')}`)
  assert.ok(claims.length >= 11, `the presence section has ${claims.length} claims, fewer than the ${11} it needs`)
  console.log(`\n  pass-11 claims: ${claims.length} source contracts, every one holding`)
})

test('every presence claim can actually fail, and a mutation names the one it breaks', () => {
  // TWELVE MUTATIONS, and the choice of which properties to break is the point: each
  // one is a way this pass could have shipped a feature that exists, is pure, is
  // deterministic, and is invisible.
  const mutations = [
    ['the shimmer drawn as two meshes', 'two draw calls for a column the eye integrates into one, and the bands would sort against each other',
      'the shimmer is one mesh of HAZE_LAYERS bands, with a real per-vertex alpha',
      'this.haze = new THREE.Mesh(geometry, this.hazeMaterial)', 'this.haze = new THREE.Mesh(geometry, this.hazeMaterial); this.haze2 = new THREE.Mesh(geometry, this.hazeMaterial)'],
    ['the shimmer colour buffer sized for RGB', 'the vertex colour array is three floats per vertex, so the four-component attribute cannot be filled and three.js discards the alpha — which for the shimmer is a column of solid grey, at 48 triangles, in every frame',
      'the shimmer is one mesh of HAZE_LAYERS bands, with a real per-vertex alpha',
      'const colours = new Float32Array(quads * 4 * 4)', 'const colours = new Float32Array(quads * 4 * 3)'],
    ['the puff colour buffer sized for RGB', 'the same for the dust, where it means ten puffs that never fade',
      'the dust is a blended, fogged, billboarded decal and not an additive one',
      'const colours = new Float32Array(PUFF_MAX * 4 * 4)', 'const colours = new Float32Array(PUFF_MAX * 4 * 3)'],
    ['an instanced shimmer', 'a pool has no per-instance alpha in stock three.js, so the bands would not fade at all',
      'the shimmer is one mesh of HAZE_LAYERS bands, with a real per-vertex alpha',
      'this.haze = new THREE.Mesh(geometry, this.hazeMaterial)', 'this.haze = new THREE.InstancedMesh(geometry, this.hazeMaterial, 2)'],
    ['a blended shimmer', "a blended pale grey over near-black asphalt is a grey stain with an edge, not light. The replacement spans the comment above it because `blending: THREE.AdditiveBlending,` appears THREE times in this file — the eyes and the portal rings are additive too — and a one-line from mutates whichever comes first, which is the eye, and then the shimmer claim passes on a broken tree",
      'the shimmer is additive and unfogged, and the eye keeps its lift',
      '      // Additive is the mechanism: a shimmer is light, and a blended pale grey over\n      // near-black asphalt is a grey stain with an edge.\n      blending: THREE.AdditiveBlending,',
      '      // Additive is the mechanism: a shimmer is light, and a blended pale grey over\n      // near-black asphalt is a grey stain with an edge.\n      blending: THREE.NormalBlending,'],
    ['a fogged shimmer', 'additive plus fog is a fog-coloured ADD, and hazeAmount is a better depth cue',
      'the shimmer is additive and unfogged, and the eye keeps its lift',
      '      fog: false,\n      vertexColors: true,\n    })\n    this._materials.push(this.hazeMaterial)', '      fog: true,\n      vertexColors: true,\n    })\n    this._materials.push(this.hazeMaterial)'],
    ['a one-sided ring', 'the two far sides of the column vanish and the shimmer is only ever on one bearing',
      'the shimmer is additive and unfogged, and the eye keeps its lift',
      '      side: THREE.DoubleSide,', '      side: THREE.FrontSide,'],
    ['the shimmer drawn after the eye', 'a bright additive column sorted after the eye washes the one mark the creature gate anchors on',
      'the shimmer is additive and unfogged, and the eye keeps its lift',
      'const HAZE_RENDER_ORDER = 0', 'const HAZE_RENDER_ORDER = 2'],
    ['the eye put back in the depth sort', 'the pass-6 claim is about the eye and pass 11 must not undo it',
      'the shimmer is additive and unfogged, and the eye keeps its lift',
      'const EYE_RENDER_ORDER = 1', 'const EYE_RENDER_ORDER = 0'],
    ['alpha across the middle of the band', 'the curtain is painted over the creature, and creature-stalking has 0.013 of headroom',
      'a band is an annulus, and its inner edge is a fraction of the outer',
      'const alpha = [0, 1, 1, 0]', 'const alpha = [1, 1, 1, 1]'],
    ['the inner edge promoted to its own number', 'a second number for the hole is a second number to retune, and the gate reads the fraction',
      'a band is an annulus, and its inner edge is a fraction of the outer',
      'const inner = outer * HAZE_INNER_FRACTION', 'const inner = outer * 0.98'],
    ['the shimmer parented to the creature', 'a shimmer that travels with the creature is a property of the creature, not air standing where it is',
      'the shimmer and the dust are siblings of the figure, not children',
      '    this.scene.add(this.haze)', '    this.root.add(this.haze)'],
    ['additive dust', 'additive dust is a light source at floor level, which is exactly what the eye-finder looks for',
      'the dust is a blended, fogged, billboarded decal and not an additive one',
      '      color: PUFF_COLOUR,\n      transparent: true,\n      opacity: PUFF_OPACITY,\n      depthWrite: false,\n      blending: THREE.NormalBlending,',
      '      color: PUFF_COLOUR,\n      transparent: true,\n      opacity: PUFF_OPACITY,\n      depthWrite: false,\n      blending: THREE.AdditiveBlending,'],
    ['an unfogged puff', 'a bright unfogged billboard at 40 m is a floating light',
      'the dust is a blended, fogged, billboarded decal and not an additive one',
      '      fog: true,\n      vertexColors: true,\n    })\n    this._materials.push(this.puffMaterial)', '      fog: false,\n      vertexColors: true,\n    })\n    this._materials.push(this.puffMaterial)'],
    ['puffs laid in the ground plane', 'a ground quad edge-on is a sliver, not a puff',
      'the dust is a blended, fogged, billboarded decal and not an additive one',
      'this._puffRight.set(1, 0, 0).applyQuaternion(camera.quaternion)\n      this._puffUp.set(0, 1, 0).applyQuaternion(camera.quaternion)',
      'this._puffRight.set(1, 0, 0)\n      this._puffUp.set(0, 1, 0)'],
    ['the puff size frozen at birth', 'a puff that does not grow is a decal that shrinks, and `puffRadius` is the growth curve',
      'the dust is a blended, fogged, billboarded decal and not an additive one',
      'const radius = puffRadius(time - puff.born) * (seeded / PUFF_RADIUS)', 'const radius = seeded'],
    ['the lamp level computed in the world', 'a second definition of a moment the pure harness tests, which is the bug this pass had to avoid',
      'the world asks the pure module for the lamp level, the pulse and the seeds',
      'beast.lampDread(distance, this.animTime, { seed: beast.lampDreadSeed(this.seed, i) })', '1'],
    ['the pulse off a clock of its own', 'two events that happen to be near each other are not a sync',
      'the world asks the pure module for the lamp level, the pulse and the seeds',
      'beast.lampPulse(pose.eyeFlare)', '1'],
    ['the per-lamp seed dropped', 'one seed for four slots is one lamp with four meshes',
      'the world asks the pure module for the lamp level, the pulse and the seeds',
      'beast.lampDreadSeed(this.seed, i)', 'this.seed'],
    ['the bounce left steady', 'sodium returning off a road that has gone dark',
      'the world asks the pure module for the lamp level, the pulse and the seeds',
      'bounce.intensity = LAMP_BOUNCE_INTENSITY * level * (near ? pulse : 1)', 'bounce.intensity = LAMP_BOUNCE_INTENSITY'],
    ['the pulse ungated', 'every lamp on the street answers one sighting',
      'the pulse is gated on the same radius the drodd is, and on there being a figure',
      'const near = drawn !== null && distance < beast.LAMP_DREAD_RADIUS', 'const near = drawn !== null'],
    ['the pulse ungated on the figure', 'a lamp with nothing standing in it surges on a frame with no creature in the picture at all',
      'the pulse is gated on the same radius the drodd is, and on there being a figure',
      'const near = drawn !== null && distance < beast.LAMP_DREAD_RADIUS', 'const near = distance < beast.LAMP_DREAD_RADIUS'],
    ['the walk measured twice', 'the trail is laid from this frame and the dust from zero, and they drift a frame apart for the whole run',
      "the trail and the dust share one measurement of the frame's move",
      'const { dx, dz, walked, jumped } = this._measureWalk(drawn, dt)\n    this.creaturePuffs',
      'const previous = this._creatureDrawn\n    this._creatureDrawn = { x: drawn.x, z: drawn.z }\n    const dx = previous ? drawn.x - previous.x : 0\n    const dz = previous ? drawn.z - previous.z : 0\n    const walked = Math.hypot(dx, dz)\n    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0\n    const jumped = walked > beast.SPEED_CEILING * step * 1.5\n    this.creaturePuffs'],
    ['the jump test dropped', "a §8.3 re-emergence lays ninety metres of dust in one frame, and the cap would hide it rather than stop it",
      "the trail and the dust share one measurement of the frame's move",
      'walked > beast.SPEED_CEILING * step * 1.5', 'false'],
    ['the cache keyed on the clock', "after a §10.4 wipe the first frame would be handed a measurement taken against the last run's position",
      "the trail and the dust share one measurement of the frame's move",
      'if (this._walkFor === drawn) return this._walk', 'if (false) return this._walk'],
    ['a world-built puff field', 'a field the world builds for itself is a field the pure harness cannot test',
      "the dust is the pure reducer's, folded into the drawn copy and out of the pupil",
      'beast.puffStep(this.creaturePuffs, {', 'this.creaturePuffs.puffs.concat([])'],
    ['the puffs stored in drawn coordinates', "a puff in drawn coordinates is 448 m from its own road after the first wrap",
      "the dust is the pure reducer's, folded into the drawn copy and out of the pupil",
      'puff.x + origin.x, z: puff.z + origin.z', 'puff.x, z: puff.z'],
    ['the stand-off dropped for the dust', 'a bright puff standing in the pupil stand-off fills the hole the pass-3 gate measures',
      "the dust is the pure reducer's, folded into the drawn copy and out of the pupil",
      'clear: this.streetView.clearOfPortals(drawn.x, drawn.z),\n      seed: this.seed,\n    }).field', 'clear: true,\n      seed: this.seed,\n    }).field'],
    ['the shimmer left on the scene', "a sibling of the figure is not removed with it, and §15's teardown is the check that would notice",
      'the shimmer, the dust and their materials are released on dispose',
      'this.scene?.remove(this.haze)', ''],
    ['the dust left on the scene', 'a 40-vertex buffer and a material attached to a dead scene',
      'the shimmer, the dust and their materials are released on dispose',
      'this.scene?.remove(this.puffs)', ''],
    ['the shimmer left hanging after a banish', 'a column of hot air standing where a creature used to be',
      'the shimmer, the dust and their materials are released on dispose',
      '      this.haze.visible = false\n      this.puffs.visible = false', ''],
    ['an unseeded puff shape', 'D10 is the rule, and an unseeded puff is a frame that cannot be re-taken',
      'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
      'const salt = hash32(seed, laid, PUFF_SALT)', 'const salt = Math.floor(Math.random() * 0xffffffff)'],
    ['a wall-clock drodd', 'a level read from a clock that does not replay is a lamp nobody can re-photograph',
      'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
      'flickerAt(seed, Math.floor(t * LAMP_DREAD_HZ)', 'flickerAt(seed, Math.floor(performance.now()),'],
    ['the per-lamp seed made up at the call site', 'a seed typed at the call site is a seed two people will change differently (pass 7)',
      'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
      '  return hash32(\n    Number.isFinite(seed) ? seed : 0,', '  return (\n    Number.isFinite(seed) ? seed : 0,'],
  ]
  for (const [label, why, claimName, from, to] of mutations) {
    // A mutation has to exist in AT LEAST ONE of the three sources, and the "no claim
    // broke" assertion below is what catches the other failure mode: a fragment that
    // only appears in a COMMENT, which `replace` rewrites and `stripProse` then ignores,
    // leaving every claim green.
    const sources = [[CREATURE_VIEW_SOURCE, 'creatureView.js'], [WORLD_SOURCE, 'world.js'], [CREATURE_SOURCE, 'creature.js']]
    if (!sources.some(([source]) => source.includes(from))) {
      throw new Error(`the mutation "${label}" matches none of the three sources, so it is not testing anything`)
    }
    const broken = creaturePresenceClaims(
      CREATURE_VIEW_SOURCE.replace(from, to),
      WORLD_SOURCE.replace(from, to),
      CREATURE_SOURCE.replace(from, to),
    ).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === claimName),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${claimName}" — ${why}`,
    )
  }
  assert.ok(mutations.length >= 20, `only ${mutations.length} mutations, which is fewer than this pass needs`)
  console.log(`\n  pass-11 mutations: ${mutations.length} mutations, every one caught`)
})

// ---------------------------------------------------------------------------
// iteration 2, pass 12 — the portal's descent
// ---------------------------------------------------------------------------
//
// WHAT THIS PASS IS, AND WHY IT IS FOUR CLAIMS AND NOT ONE
// --------------------------------------------------------
// A swirl that turns at the same rate from 70 m as from the hold distance, a
// doorway with nothing in it but a hole, a hole that blinks out in one frame, and
// a black disc that gives the eye nothing to grip against the wall around it.
// Four separate complaints, and four fixes that could each have shipped alone.
// They are one pass because they are all the same complaint — the portal is a
// painted disc rather than a place.
//
// THE ORDER OF THE SECTION, and it is the order of the exposure:
//   1. the near field, the only one of the four that changes what a LIVE portal
//      looks like at distance, and so the one that can move a committed PNG's
//      swirl contrast;
//   2. the debris ring, for the same reason, and because it is the only new
//      GEOMETRY in the aperture and geometry is what the pupil gate can see;
//   3. the collapse, the only one that draws anything BRIGHT, and the only one
//      that is not on screen in a committed capture;
//   4. the lens, the only one that touches the background.
//
// AND THEN the four regression guards the pass is most exposed to — pupil, swirl,
// eye finder, capture floor — restated as measurements against the shipped
// gallery rather than as prose, because "it is only near the rim" is a sentence
// and the pupil gate is a number.
// ---------------------------------------------------------------------------

section('Portal descent (iteration 2, pass 12)')

/** The view's own `PORTAL_CORE_RADIUS`, read out of the source. */
const PORTAL_CORE = (() => {
  const found = /const PORTAL_CORE_RADIUS = ([\d.]+)/.exec(stripProse(STREET_VIEW_SOURCE))
  assert.ok(found, 'streetView.js no longer has a PORTAL_CORE_RADIUS, so the pupil has no radius')
  return Number(found[1])
})()

test('the near field is a distance ramp inside a facing gate, and both gates are hard', () => {
  // 1. THE RAMP'S SHAPE, and the reason it is a smoothstep rather than a line. A
  //    linear `1 - d/8` arrives at 1 with slope -1/8, a step in velocity as you
  //    cross 8 m: the arms jump from their idle rate to their near rate in one
  //    frame. C1 means zero slope at both ends, and C1 is asserted by sampling the
  //    derivative rather than by pattern-matching the polynomial, because the
  //    smoothstep's virtue IS the shape of its derivative.
  const slope = (d) => Math.abs((rules.portalNearness(d - 0.01, 1) - rules.portalNearness(d + 0.01, 1)) / 0.02)
  assert.ok(Math.abs(slope(0.01)) < 0.01, `the near field arrives at the gate with a slope of ${slope(0.01).toFixed(5)}`)
  assert.ok(
    Math.abs(slope(rules.PORTAL_NEAR_METRES - 0.01)) < 0.01,
    `and leaves at ${rules.PORTAL_NEAR_METRES} m with a slope of ${slope(rules.PORTAL_NEAR_METRES - 0.01).toFixed(5)}`,
  )
  // 2. MONOTONE, because a hole that answers you MORE the further off you stand is
  //    not a near field. Sampled, not symbolic, for the same reason.
  for (let d = 0; d < rules.PORTAL_NEAR_METRES; d += 0.1) {
    assert.ok(
      rules.portalNearness(d, 1) >= rules.portalNearness(d + 0.1, 1),
      `the near field rises with distance at ${d.toFixed(1)} m`,
    )
  }
  // 3. THE HARD CUT AT THE RADIUS. A soft tail would mean the hole reacts to the
  //    player from across the map, and the first version had a cosine to 20 m.
  assert.equal(rules.portalNearness(rules.PORTAL_NEAR_METRES, 1), 0, 'the near field is still on at its own radius')
  assert.equal(rules.portalNearness(rules.PORTAL_NEAR_METRES * 10, 1), 0)
  assert.equal(rules.portalNearness(1e6, 1), 0)
  // 4. THE FACING GATE IS A GATE AND NOT A WEIGHT. The docblock's claim is about
  //    the ORDER — close first, facing second — and the order is observable from
  //    outside: a player 20 m away staring at the portal and a player 2 m away
  //    staring away both read 0, for different reasons.
  assert.equal(rules.portalNearness(20, 1), 0, 'a portal across the street is answering the player')
  assert.equal(rules.portalNearness(2, -1), 0, 'a portal behind the player is answering the player')
  // the gate is `facing < THRESHOLD`, so the threshold itself is the first value
  // that is ALLOWED — 60 degrees is "still unambiguously in front of you", and
  // one degree further is not. Asserted as the two sides of the comparison
  // rather than as a value, because which side the boundary sits on is a design
  // decision and a gate that hard-codes it would fail a retune that is an
  // improvement.
  assert.equal(rules.portalNearness(2, rules.PORTAL_NEAR_FACING - 1e-9), 0, 'the facing gate is not closed just below its own threshold')
  assert.ok(rules.portalNearness(2, rules.PORTAL_NEAR_FACING) > 0, 'the facing gate is closed at its own threshold')
  assert.ok(rules.portalNearness(2, 1) > 0, 'standing at it and looking at it does nothing, which is the feature')
  // ...and it is a MONOTONE function of facing, so a gaze crossing the edge of a
  // portal ramps it rather than snapping it.
  for (let f = rules.PORTAL_NEAR_FACING; f <= 1; f += 0.05) {
    assert.ok(
      rules.portalNearness(2, f) >= rules.portalNearness(2, f - 0.05),
      `the near field rises as the gaze turns away, at a dot of ${f.toFixed(2)}`,
    )
  }
  // 5. NULL-SAFE ON BOTH ARGUMENTS, and in the SAFE direction. This is called from
  //    a render loop with values off a camera and a projection; a predicate that
  //    throws on NaN takes the frame down, and one that returns NaN takes the
  //    swirl rate with it.
  assert.equal(rules.portalNearness(NaN, 1), 0)
  assert.equal(rules.portalNearness(2, NaN), 0)
  assert.equal(rules.portalNearness(Infinity, 1), 0)
  assert.equal(rules.portalNearness(NaN, NaN), 0)
  // a negative distance is not "very close", it is a caller that has lost the fold
  assert.equal(rules.portalNearness(-1, 1), 0, 'a negative distance has a near field')
  // 6. AND THE OUTPUT IS A FRACTION, because `portalSwirlRate` multiplies by it
  //    and an out-of-range value is a multiplier outside `[1, SPIN]`.
  for (let d = 0; d <= 12; d += 0.05) {
    const near = rules.portalNearness(d, 1)
    assert.ok(near >= 0 && near <= 1, `nearness is ${near} at ${d} m`)
  }
})

test('the near field is a multiplier on the swirl, and it cannot make the swirl machinery', () => {
  const rates = [
    .../const PORTAL_SWIRL_RATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(stripProse(STREET_VIEW_SOURCE))[1].matchAll(/-?[\d.]+/g),
  ].map(Number)
  assert.equal(rates.length, 2)
  // 1. THE PASS-3 CEILING HAS TO HOLD AT THE NUMBER THE NEAR FIELD PRODUCES. The
  //    docblock's argument is about the idle table; the claim is about the fastest
  //    the arms ever turn, which is that table times `PORTAL_NEAR_SPIN` at zero
  //    distance. §16.5.5's `portal-located` stands at 4.5 m — inside the radius —
  //    so the committed PNG is drawn at the near rate, and the gate that reads it
  //    has to hold there rather than only on the table.
  for (const rate of rates) {
    assert.ok(Math.abs(rate) < 0.35, `an idle rate of ${rate} is machinery before the pass touches it`)
    const near = rules.portalNearness(0, 1)
    const spun = rules.portalSwirlRate(rate, near)
    assert.ok(
      Math.abs(spun) < 0.35,
      `standing at the gate a layer turns at ${spun.toFixed(3)} rad/s — a full turn every ${(2 / Math.abs(spun)).toFixed(1)} s, which is the pass-3 ceiling broken`,
    )
    // and the sign survives, which is the structural half of the pass-3 claim: the
    // two layers turn OPPOSITE ways, and a multiplier that dropped a sign would
    // turn them the same way at the one moment the player is close enough to see it
    assert.equal(Math.sign(rules.portalSwirlRate(rate, near)), Math.sign(rate), 'the near field flipped a swirl layer')
    // and it is a MULTIPLIER, so nearness 0 is exactly the table's own rate
    assert.equal(rules.portalSwirlRate(rate, 0), rate, 'a hole at distance is not turning at the rate pass 3 pinned')
  }
  assert.notEqual(Math.sign(rates[0]), Math.sign(rates[1]), 'the two layers agree, so the table itself is wrong')
  // 2. MONOTONE IN NEARNESS AND BOUNDED BY SPIN — the two properties that make it
  //    a ramp rather than a switch. Sampled, because the shape is the claim.
  for (const rate of rates) {
    let previous = -Infinity
    for (let n = 0; n <= 1.0001; n += 0.02) {
      const value = Math.abs(rules.portalSwirlRate(rate, n))
      assert.ok(value >= previous - 1e-12, `a layer's rate fell at nearness ${n.toFixed(2)}`)
      assert.ok(
        value <= Math.abs(rate) * rules.PORTAL_NEAR_SPIN + 1e-12,
        `a layer's rate ran past PORTAL_NEAR_SPIN at nearness ${n.toFixed(2)}`,
      )
      previous = value
    }
  }
  // 3. AND IT CLAMPS, the second lock. `portalNearness` cannot emit 1.5, but a
  //    caller that computes nearness its own way can, and an unclamped multiplier
  //    would put the arms at 4.3 rad/s — a hole that reads as a turbine.
  assert.equal(rules.portalSwirlRate(rates[0], 5), rules.portalSwirlRate(rates[0], 1))
  assert.equal(rules.portalSwirlRate(rates[0], -5), rules.portalSwirlRate(rates[0], 0))
  // 4. NULL-SAFE, for the reason the nearness predicate is: a bad rate is a dead
  //    layer, and a dead layer is not a spinning one.
  assert.equal(rules.portalSwirlRate(NaN, 1), 0)
  assert.equal(rules.portalSwirlRate(0.21, NaN), 0)
  assert.equal(rules.portalSwirlRate(Infinity, 1), 0)
})

test('the debris ring is fourteen hashed rocks outside the pupil, and it is reproducible', () => {
  // 1. DETERMINISM, and this is the whole reason `hash32` is imported and
  //    `Math.random` is not. Pass 11's review finding 4 was about an effect on a
  //    clock the capture harness could not re-take, and a random orbit is the
  //    extreme case: not one frame, but every frame.
  const a = rules.portalDebrisRing(8, 0)
  const b = rules.portalDebrisRing(8, 0)
  assert.deepEqual(a, b, 'the same seed and portal drew a different ring twice')
  // ...a function of BOTH arguments: two portals in one run must not wear the same
  // ring, or the ring is wallpaper, and a different run must not wear it either.
  assert.notDeepEqual(rules.portalDebrisRing(8, 0), rules.portalDebrisRing(8, 1), 'two portals share a ring')
  assert.notDeepEqual(rules.portalDebrisRing(8, 0), rules.portalDebrisRing(9, 0), 'the ring does not depend on the seed')
  // 2. THE COUNT, read from the module rather than restated, and against the
  //    ceiling the docblock's eye-span argument is written against.
  assert.equal(a.length, rules.PORTAL_DEBRIS_COUNT, 'the ring is not the documented number of rocks')
  assert.ok(
    rules.PORTAL_DEBRIS_COUNT <= rules.PORTAL_DEBRIS_MAX,
    `${rules.PORTAL_DEBRIS_COUNT} rocks is over the ${rules.PORTAL_DEBRIS_MAX} the eye-span argument allows`,
  )
  assert.ok(rules.PORTAL_DEBRIS_COUNT >= 8, 'a ring of fewer than eight is a bracelet, not debris')
  // 3. **THE PUPIL ARGUMENT, MEASURED.** This is the load-bearing geometric claim
  //    of the debris feature, and it is a comparison between two modules that
  //    cannot import each other: `PORTAL_DEBRIS_RING` is in `rules.js` and
  //    `PORTAL_CORE_RADIUS` is in `streetView.js`, so the second is read out of the
  //    first's neighbour's source. A rock crossing the centre of the aperture is a
  //    5-11 px speck sitting exactly where the pass-3 gate says there must be
  //    nothing but the hole's own near-black.
  const [inner, outer] = rules.PORTAL_DEBRIS_RING
  assert.ok(
    inner > PORTAL_CORE,
    `a rock on its innermost orbit is at ${inner} m and the hole is ${PORTAL_CORE} m, so a rock can cross the pupil`,
  )
  // ...and the margin is not accidental tightness. The docblock claims 8% and the
  // gate holds it to a centimetre, because a 1 cm margin is a rounding difference
  // between two files rather than a design decision.
  assert.ok(
    inner - PORTAL_CORE > 0.05,
    `the inner orbit clears the hole by ${((inner - PORTAL_CORE) * 100).toFixed(1)} cm, which is inside the error of the two files disagreeing`,
  )
  // 4. EVERY ROCK IS INSIDE THE RING, and concentric with the hole.
  for (const rock of a) {
    assert.ok(rock.radius >= inner && rock.radius <= outer, `a rock is orbiting at ${rock.radius} m, outside the ring`)
    assert.ok(rock.size >= rules.PORTAL_DEBRIS_SIZE[0] && rock.size <= rules.PORTAL_DEBRIS_SIZE[1], `a rock is ${rock.size} m, outside the size range`)
    assert.ok(rock.phase >= 0 && rock.phase < Math.PI * 2, `a rock is at phase ${rock.phase}, which is not a phase`)
    assert.ok(Number.isFinite(rock.rate) && rock.rate !== 0, 'a rock is not turning')
  }
  // 4b. **AND THE NEAREST ANY ROCK EVER COMES TO THE CENTRE IS OUTSIDE THE HOLE.**
  //     This is the check that was MISSING, and its absence is how a real defect
  //     shipped: the assertion above compares `rock.radius` with the core radius,
  //     and `rock.radius` is the orbit's MAJOR axis. If the orbit is squashed — and
  //     it was, by 0.62, for reasons that all turned out to be about the doorway
  //     rather than about the pupil — then the nearest a rock comes to the centre is
  //     `radius * FLATTEN`, which at 0.78 and 0.62 is 0.48 m on a 0.72 m hole. The
  //     feature sat a third of the way into the pupil and this gate was green the
  //     whole time. `verify-world.mjs` found it on its first run, by reading the
  //     built instance matrices; this is the pure half of that finding.
  //
  //     The fix is to sweep the ORBIT and not the parameter. A parameter check
  //     cannot see this class of error, because the parameter and the geometry it
  //     produces are different numbers and only one of them is drawn.
  for (const rock of a) {
    const orbit = (Math.PI * 2) / Math.abs(rock.rate)
    let nearest = Infinity
    for (let t = 0; t < orbit; t += orbit / 180) {
      const pose = rules.portalDebrisPose(rock, t)
      nearest = Math.min(nearest, Math.hypot(pose.x, pose.y))
    }
    assert.ok(
      nearest > PORTAL_CORE,
      `a rock orbiting at ${rock.radius} m comes within ${nearest.toFixed(3)} m of the gate's centre on a ${PORTAL_CORE} m hole — the orbit's MINOR axis, not its radius, is what reaches the pupil`,
    )
  }
  // ...and the margin is the same 5 cm the radius check demands, because the two
  // are now the same claim and a gate that checked one and not the other is exactly
  // how the first one was green over a broken feature.
  const closest = Math.min(...a.map((rock) => rock.radius * rules.PORTAL_DEBRIS_FLATTEN))
  assert.ok(closest - PORTAL_CORE > 0.05, `the ring's nearest approach is ${((closest - PORTAL_CORE) * 100).toFixed(1)} cm outside the hole`)
  // 5. THE RATES ARE SLOWER THAN THE SWIRL, which is the docblock's "the debris is
  //    the quiet layer" turned into a number. The comparison is against the
  //    FASTEST the swirl ever turns — the idle table times `PORTAL_NEAR_SPIN` —
  //    and NOT against the idle 0.21, because the first version of this check
  //    used 0.21 and passed at a 0.34 fast end while the near field was spinning
  //    the swirl at 0.46. The quiet layer has to be quieter than the loudest
  //    version of the thing it is quiet against, or the two swap roles.
  const rates = [
    .../const PORTAL_SWIRL_RATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(stripProse(STREET_VIEW_SOURCE))[1].matchAll(/-?[\d.]+/g),
  ].map((entry) => Math.abs(Number(entry)))
  const loudestSwirl = Math.max(...rates) * rules.PORTAL_NEAR_SPIN
  const fastestRock = Math.max(...a.map((rock) => Math.abs(rock.rate)))
  assert.ok(fastestRock < loudestSwirl, `a rock turns at ${fastestRock.toFixed(3)} and the swirl's fastest near-field rate is ${loudestSwirl.toFixed(3)}: the debris is not the quiet layer`)
  assert.ok(fastestRock < 0.35, `a rock turns at ${fastestRock.toFixed(3)} rad/s, which is the pass-3 swirl ceiling`)
  // 6. **THE RING IS TWO-DIRECTIONAL**, which is what the separate sign draw exists
  //    for. A belt where every rock turns the same way is a clock face, and the
  //    sign is a SEPARATE hash draw precisely so the rock that drew a low rate is
  //    not also the rock that went the other way.
  const signs = new Set(a.map((rock) => Math.sign(rock.rate)))
  assert.equal(signs.size, 2, 'the ring turns one way, and one way is a clock face')
  // and the correlation the separate draw prevents: no radius band is one-signed
  const mid = (inner + outer) / 2
  for (const [half, label] of [[a.filter((rock) => rock.radius < mid), 'inner'], [a.filter((rock) => rock.radius >= mid), 'outer']]) {
    assert.ok(
      half.length >= 3 && new Set(half.map((rock) => Math.sign(rock.rate))).size === 2,
      `every rock on the ${label} half of the ring turns the same way, so the sign IS correlated with the radius`,
    )
  }
  // 7. AND IT IS SPREAD, not clustered. Fourteen rocks from one hash coordinate can
  //    land in one band and read as a clump, so the radii must occupy both halves
  //    and at least three fifths. A distribution claim, so it is sampled.
  const fifths = new Set(a.map((rock) => Math.floor(((rock.radius - inner) / (outer - inner)) * 5)))
  assert.ok(fifths.size >= 3, `the ring's rocks occupy ${fifths.size} fifths of the band, so the ring is a clump`)
  assert.equal(new Set(a.map((rock) => rock.phase)).size, a.length, 'two rocks share a phase, so they are welded together')
  // 8. AND ACROSS EVERY SEED AND EVERY PORTAL, because a property that holds for
  //    seed 8 portal 0 and not for seed 3 portal 2 is a coincidence.
  for (let seed = 1; seed <= 8; seed += 1) {
    for (let index = 0; index < 3; index += 1) {
      const ring = rules.portalDebrisRing(seed, index)
      assert.equal(ring.length, rules.PORTAL_DEBRIS_COUNT, `seed ${seed} portal ${index} drew the wrong count`)
      assert.ok(ring.every((rock) => rock.radius > PORTAL_CORE), `seed ${seed} portal ${index} put a rock inside the hole`)
      assert.equal(new Set(ring.map((rock) => Math.sign(rock.rate))).size, 2, `seed ${seed} portal ${index} drew a one-way ring`)
    }
  }
})

test('a rock is a function of time, and the pose it reaches is on its own orbit', () => {
  const rock = rules.portalDebrisRing(8, 0)[0]
  // 1. THE CLOCK, NOT A FRAME COUNT. `update(dt)` is handed a delta, so a pose
  //    written from an accumulator is a different picture on every machine.
  assert.deepEqual(
    rules.portalDebrisPose(rock, 12.5),
    rules.portalDebrisPose(rock, 12.5),
    'the same time drew a different pose',
  )
  // 2. AND THE POSE IS ON THE ORBIT, which is what the flatten is written for: the
  //    ellipse is `radius x radius*FLATTEN`, so every sample satisfies
  //    `hypot(x/r, y/(r*flatten)) === 1`. A rock off its ellipse is a bob or a
  //    mistake, and there is no bob in this design.
  for (let t = 0; t < 90; t += 1.7) {
    const pose = rules.portalDebrisPose(rock, t)
    const on = Math.hypot(pose.x / rock.radius, pose.y / (rock.radius * rules.PORTAL_DEBRIS_FLATTEN))
    assert.ok(Math.abs(on - 1) < 1e-9, `at ${t} s a rock is at ${on.toFixed(6)} of its own orbit`)
  }
  // 3. THE FLATTEN IS ON THE ORBIT AND NOT ON THE MESH, so a flake stays a REGULAR
  //    tetrahedron. Measured as the ellipse's SEMI-AXES over a full revolution —
  //    the first version of this check compared `|y|` to `|x|` at ONE time, which
  //    is not a property of the ellipse at all: at some phases on a squashed
  //    orbit `y` is larger than `x` and at others it is smaller, and the check
  //    passed or failed on where the sample happened to land. The semi-axes are
  //    the max of each coordinate over a full period, and the ratio between them
  //    is what "squashed" means.
  const period = (Math.PI * 2) / Math.abs(rock.rate)
  let maxX = 0
  let maxY = 0
  for (let t = 0; t < period; t += period / 360) {
    const p = rules.portalDebrisPose(rock, t)
    maxX = Math.max(maxX, Math.abs(p.x))
    maxY = Math.max(maxY, Math.abs(p.y))
  }
  assert.ok(Math.abs(maxX - rock.radius) < 1e-4, `the orbit is ${maxX.toFixed(4)} m wide rather than the rock's ${rock.radius.toFixed(4)} m`)
  assert.ok(
    Math.abs(maxY - rock.radius * rules.PORTAL_DEBRIS_FLATTEN) < 1e-4,
    `the orbit is ${maxY.toFixed(4)} m tall rather than ${(rock.radius * rules.PORTAL_DEBRIS_FLATTEN).toFixed(4)} m`,
  )
  // `<=`, not `<`, and the reason is the whole history of this number. The orbit
  // USED to be squashed (`PORTAL_DEBRIS_FLATTEN` 0.62) and this assertion was the
  // one that said so; a squashed ellipse centred on a LARGER circle is inside that
  // circle at the top and the bottom, which put a third of a rock inside the pupil.
  // The value is 1 now, so the two axes are equal, and `<` would fail on a ring that
  // is exactly right. The assertion is kept in the non-strict form because it is
  // about the ring not being TALLER than it is wide, and a retune that made it
  // taller should fail here.
  assert.ok(maxY <= maxX, 'the orbit is taller than it is wide, so the doorway crop argument is inverted')
  const pose = rules.portalDebrisPose(rock, 3.3)
  assert.equal(pose.size, rock.size, 'the pose retunes the rock rather than applying its size')
  // The squash is 1, and asserting a RANGE rather than the value is the deliberate
  // choice: a retune that squashes the ring again has to clear the 4b sweep above
  // first, and that sweep is the check that matters. What is asserted here is only
  // that the value is a usable number, because a gate that pinned `=== 1` would
  // fail a future ring that is squashed CORRECTLY and say nothing useful when it
  // failed.
  assert.ok(rules.PORTAL_DEBRIS_FLATTEN > 0 && rules.PORTAL_DEBRIS_FLATTEN <= 1, `the ring's flatten is ${rules.PORTAL_DEBRIS_FLATTEN}, which is not a usable fraction`)
  // 4. THE SPIN IS ITS OWN AXIS AND NOT A SECOND CLOCK: `angle * 3`, so a flake is
  //    never tidily aligned with its own orbit. The testable part is that its
  //    period is not the orbit's, so the flake does not return to its starting
  //    attitude at the moment it returns to its starting position.
  assert.ok(Math.abs(period / 3 - period) > 1e-9, 'the flake spins once per orbit, so it is a hand on a clock face')
  // 5. NULL-SAFE TIME, for the reason the rest of the section is null-safe.
  assert.deepEqual(rules.portalDebrisPose(rock, NaN), rules.portalDebrisPose(rock, 0))
  assert.deepEqual(rules.portalDebrisPose(rock, -5), rules.portalDebrisPose(rock, 0), 'a rock in the future is elsewhere on its orbit')
  // 6. AND THE TABLE IS NOT MUTATED BY A POSE, because the view reads the same
  //    table every frame and a pose that wrote back into it would slowly walk every
  //    rock to phase 0 over a run.
  const before = { ...rock }
  for (let t = 0; t < 200; t += 1) rules.portalDebrisPose(rock, t)
  assert.deepEqual(rock, before, 'posing a rock wrote back into the table')
})

test('the collapse is 0.8 s of aftermath, and it cannot start before the hold is over', () => {
  // 1. THE DURATION, and it is the brief's "~0.8 s" read as a number rather than a
  //    suggestion. Exactly 0 at exactly 0.8 s, and 0 after.
  assert.equal(rules.PORTAL_COLLAPSE.seconds, 0.8, 'the collapse is not 0.8 s')
  assert.equal(rules.portalCollapse(0.8).scale, 0, 'the aperture is still open at the end of the collapse')
  assert.equal(rules.portalCollapse(5).scale, 0, 'the aperture reopens after the collapse')
  assert.equal(rules.portalCollapse(1e6).scale, 0)
  // 2. MONOTONE AND BOUNDED, because a collapse that overshoots or bounces is a
  //    different animation.
  let previous = Infinity
  for (let t = 0; t <= 0.8; t += 0.01) {
    const frame = rules.portalCollapse(t)
    assert.ok(frame.scale >= 0 && frame.scale <= 1, `the aperture is scaled to ${frame.scale} at ${t.toFixed(2)} s`)
    assert.ok(frame.scale <= previous + 1e-12, `the aperture grew at ${t.toFixed(2)} s`)
    assert.ok(frame.u >= 0 && frame.u <= 1, `u is ${frame.u} at ${t.toFixed(2)} s`)
    previous = frame.scale
  }
  // 3. THE EASE IS A HOLD AND THEN A SNAP, and the shape is the claim rather than
  //    the formula. `1 - u^4` has a zero derivative at `u = 0` and a slope of -4
  //    at `u = 1`, so the aperture hangs and then goes. The two numbers that
  //    matter are the one at the FLASH — the flash has to be lighting something
  //    that is still recognisably a hole — and the one at three quarters, which is
  //    where a reader can tell "closing" from "shutting".
  assert.ok(rules.portalCollapse(0.27).scale > 0.9, `at the flash the aperture is already ${(100 * (1 - rules.portalCollapse(0.27).scale)).toFixed(1)}% closed — the flash has nothing to interrupt`)
  assert.ok(rules.portalCollapse(0.16).scale > 0.99, 'the aperture is closing through the flash')
  assert.ok(rules.portalCollapse(0.4).scale > 0.9, 'the aperture is more than a tenth shut at the halfway mark, which is a zoom rather than a hold')
  assert.ok(rules.portalCollapse(0.6).scale < 0.75, 'the aperture is still three quarters open at three quarters of the way through, which is a hold with no snap')
  // ...and the slope at t=0 is zero to floating point, which is the C1 the quartic
  // buys and the thing a `u^3` or a `(1-u)^3` both fail. The tolerance is 1e-12
  // and not `assert.equal`: `1 - 0.125 ** 4` is 0.9999999999999998 in binary, and
  // a gate that demanded the exact double would be a gate about the FPU.
  assert.ok(Math.abs(rules.portalCollapse(0.0001).scale - 1) < 1e-12, 'the collapse starts with a velocity step')
  // 4. THE FLASH IS A SYMMETRIC BELL, and the symmetry is why §14.3's
  //    reduced-motion rule is not engaged by it: a one-sided flash is a switch and a
  //    switch is a strobe. Asserted as the profile's own mirror symmetry, which is
  //    the property rather than a restatement of the formula.
  const centre = rules.PORTAL_COLLAPSE.flash
  const width = rules.PORTAL_COLLAPSE.flashWidth
  for (const offset of [0.01, 0.03, 0.05, 0.07, 0.089]) {
    assert.ok(
      Math.abs(rules.portalCollapse(centre + offset).flash - rules.portalCollapse(centre - offset).flash) < 1e-12,
      `the flash is ${rules.portalCollapse(centre + offset).flash.toFixed(4)} after its centre and ${rules.portalCollapse(centre - offset).flash.toFixed(4)} before it`,
    )
  }
  // 5. IT IS EXACTLY 0 OUTSIDE ITS WIDTH, which is what makes the end of it a fade
  //    rather than a cut, and 0 at the very edge is what makes the fade C1.
  assert.equal(rules.portalCollapse(0).flash, 0, 'the flash is already lit on frame 0')
  assert.equal(rules.portalCollapse(centre + width).flash, 0, 'the flash has a step at its outer edge')
  assert.equal(rules.portalCollapse(centre - width).flash, 0)
  assert.equal(rules.portalCollapse(0.16 - 0.09).flash, 0)
  // and the peak IS the gain, once, in the middle
  assert.equal(rules.portalCollapse(centre).flash, rules.PORTAL_COLLAPSE.flashGain)
  assert.ok(rules.PORTAL_COLLAPSE.flashGain > 1, 'the flash is not brighter than the thing it flashes')
  // 6. THE SPIN RAMPS 1 -> 7 ON u^2, so the acceleration itself accelerates and the
  //    aperture is still at its live rate on frame 0.
  assert.equal(rules.portalCollapse(0).spin, 1, 'the collapse starts at a spin the live hole was not turning at')
  assert.equal(rules.portalCollapse(0.8).spin, rules.PORTAL_COLLAPSE.spin)
  assert.ok(rules.PORTAL_COLLAPSE.spin > 3, 'the spin-up is not fast enough to read as machinery')
  for (let t = 0; t <= 0.8; t += 0.01) {
    assert.ok(
      rules.portalCollapse(t).spin >= rules.portalCollapse(Math.max(0, t - 0.01)).spin - 1e-12,
      `the spin dipped at ${t.toFixed(2)} s`,
    )
  }
  // 7. **THE TIMING CLAIM THE PASS EXISTS NOT TO VIOLATE.** §5.2's hold is 1.2 s and
  //    the collapse starts after it, so the 0.8 s is strictly AFTER every
  //    gameplay-visible event it could disturb. The simulation version of this is
  //    in verify-world.mjs, because that is the harness that can run one; this is
  //    the arithmetic underneath it.
  assert.ok(
    rules.PORTAL_COLLAPSE.seconds + 0.2 < rules.PORTAL_SHUT_SECONDS,
    `the collapse (${rules.PORTAL_COLLAPSE.seconds} s) ends only ${(rules.PORTAL_SHUT_SECONDS - rules.PORTAL_COLLAPSE.seconds).toFixed(2)} s before the hold would have finished, so the two windows overlap`,
  )
  // 8. NULL-SAFE AND CLAMPED, for the same reason as everything else here.
  assert.deepEqual(rules.portalCollapse(NaN), rules.portalCollapse(0))
  assert.deepEqual(rules.portalCollapse(-3), rules.portalCollapse(0), 'a collapse from the future is not a collapse')
})

test('the lens is a dark radial gradient on the annulus, and it is exactly zero on the hole', () => {
  // THIS IS THE PUPIL GATE'S ONLY REASON TO EXIST FOR THE LENS, and it is written
  // as a property of `portalLensAlpha` rather than as a measurement of a frame,
  // because the property is what makes the measurement pass. The measurement of
  // `portal-located.png` is in the regression guards below, on the real PNG.
  //
  // 1. **EXACTLY ZERO ACROSS THE WHOLE DISC**, and "exactly" is the word. The
  //    pass-3 pupil gate reads the luma at the centre of the rim's bounding box
  //    and requires it at or under 20; the swirl gate reads the band the two swirl
  //    layers occupy. The disc is 1.0 of the core radius and the swirl's outer
  //    layer is at 0.66 m on a 0.72 m hole, i.e. 0.917 — so "zero for every radius
  //    at or inside 1.0" is zero over the pupil AND over both swirl layers, in one
  //    assertion, with no dependence on where the swirl happens to sit.
  //
  //    The sweep is to 1.0 INCLUSIVE and the boundary is asserted from both sides,
  //    because the first version of this function ran its ramp from 0.55 and the
  //    only way that passed was a test that sampled 0.0 and 0.3 and stopped. A gate
  //    that samples two points on a radial profile is a gate about two points.
  assert.equal(rules.portalLensAlpha(0), 0, 'the lens darkens the pupil')
  assert.equal(rules.portalLensAlpha(0.0001), 0)
  assert.equal(rules.portalLensAlpha(NaN), 0)
  for (let r = 0; r <= 1.0; r += 0.001) {
    assert.equal(rules.portalLensAlpha(r), 0, `the lens darkens the hole at ${r.toFixed(3)} of the radius`)
  }
  assert.equal(rules.portalLensAlpha(1), 0, 'the lens darkens the lip itself')
  // and the outer swirl layer is inside that swept range, read out of the view's
  // own table so the sweep cannot quietly stop short of it
  const swirlRadii = [
    .../const PORTAL_SWIRL_RADII = Object\.freeze\(\[([^\]]+)\]\)/.exec(stripProse(STREET_VIEW_SOURCE))[1].matchAll(/[\d.]+/g),
  ].map(Number)
  for (const radius of swirlRadii) {
    assert.equal(rules.portalLensAlpha(radius / PORTAL_CORE), 0, `the lens darkens the swirl layer at ${radius} m`)
  }
  // 2. **ZERO AT ITS OWN OUTER EDGE**, so the overlay has no rim of its own. A disc
  //    that stops at a visible circle is a decal, and the claim here is haze.
  assert.equal(rules.portalLensAlpha(rules.PORTAL_LENS.outer), 0, 'the lens has an edge of its own')
  assert.equal(rules.portalLensAlpha(rules.PORTAL_LENS.outer + 1), 0)
  assert.equal(rules.portalLensAlpha(1e6), 0)
  // 3. AND C1 AT BOTH ENDS, sampled rather than asserted symbolically — a corner in
  //    a radial profile is a ring in the frame that switches on.
  const slope = (r) => Math.abs((rules.portalLensAlpha(r + 0.002) - rules.portalLensAlpha(r - 0.002)) / 0.004)
  assert.ok(slope(1.002) < 0.5, `the lens arrives at its inner edge with a slope of ${slope(1.002).toFixed(4)}`)
  assert.ok(
    slope(rules.PORTAL_LENS.outer - 0.002) < 0.5,
    `and leaves at its outer edge with a slope of ${slope(rules.PORTAL_LENS.outer - 0.002).toFixed(4)}`,
  )
  // 4. **IT DEEPENS TOWARD THE RIM**, which is the brief's own words: the alpha
  //    rises monotonically from the lip to a crest just outside it, and the crest
  //    is `PORTAL_LENS.crest` — outside the disc, so the deepening is on
  //    BACKGROUND and the lip itself is not dimmed.
  assert.ok(rules.PORTAL_LENS.crest > 1, 'the lens crests inside the disc, so it darkens the hole')
  assert.ok(rules.PORTAL_LENS.crest < rules.PORTAL_LENS.outer, 'the lens crests past its own edge, so the edge is a cliff')
  let peakValue = -1
  for (let r = 1; r < rules.PORTAL_LENS.outer; r += 0.0005) {
    const value = rules.portalLensAlpha(r)
    assert.ok(value >= 0 && value <= rules.PORTAL_LENS.peak, `the lens alpha is ${value} at ${r.toFixed(4)}`)
    if (value > peakValue) peakValue = value
  }
  // ...and it rises monotonically all the way there, with no dip in between. The
  // upper bound is the crest MINUS a step, because at the crest the profile turns
  // around — a loop that ran to the crest inclusive would compare the crest
  // against the first sample past it and call the turn a non-monotonicity.
  for (let r = 1.0; r < rules.PORTAL_LENS.crest - 0.001; r += 0.0005) {
    assert.ok(
      rules.portalLensAlpha(r) <= rules.portalLensAlpha(r + 0.0005) + 1e-12,
      `the lens does not deepen monotonically at ${r.toFixed(4)} of the radius`,
    )
  }
  // 5. **AND IT REACHES EXACTLY ITS DECLARED PEAK.** The peak is a CEILING and the
  //    profile reaches it, so this is an equality: a retune that lowered `peak`
  //    without moving the profile would be a gate that never noticed.
  assert.equal(rules.portalLensAlpha(rules.PORTAL_LENS.crest), rules.PORTAL_LENS.peak, 'the lens is not exactly its own declared peak at its own crest')
  assert.ok(rules.PORTAL_LENS.peak > 0.2, 'the lens is too faint to be a lens')
  assert.ok(rules.PORTAL_LENS.peak < 0.5, 'the lens is dark enough to read as a hole rather than as haze')
  // 6. AND THE GEOMETRY MATCHES THE CLAIM: "just larger than the disc", so `outer`
  //    is above 1 — at 1.0 it would be a second disc exactly on the first — and
  //    below 1.6, because at 1.6 it is a visible dark halo, which is the pass-3
  //    "reads as a HALO" failure all over again.
  assert.ok(rules.PORTAL_LENS.outer > 1, 'the lens is not larger than the disc it lenses')
  assert.ok(rules.PORTAL_LENS.outer < 1.6, 'the lens is a halo, which is the failure pass 3 was built to remove')
  // 7. AND EVERY VALUE IS INSIDE ITS BOUND over the whole sampled domain, because
  //    the function is called once per texel by the texture builder, so a single
  //    out-of-range sample is a clamped byte and a visible ring.
  for (let r = 0; r < 1.6; r += 0.001) {
    const value = rules.portalLensAlpha(r)
    assert.ok(value >= 0 && value <= rules.PORTAL_LENS.peak, `the lens alpha is ${value} at ${r.toFixed(3)}`)
  }
})

// ---------------------------------------------------------------------------
// the pass's source contracts, and their mutations
// ---------------------------------------------------------------------------

/**
 * `portalDescentClaims` — pass 12's source contracts, as predicates over a source.
 *
 * The pass-11 shape exactly, and the reason it is that shape is §15.1: this file
 * may not import `streetView.js` because it imports Three.js, so every claim about
 * the view is a claim about its TEXT. Passes 1/2/3 accepted that and wrote prose;
 * passes 9/10/11 moved the numbers into the pure module and made these contracts
 * about the wiring rather than about the arithmetic, which is the only kind that
 * survives a retune. This is pass 12's version of that.
 *
 * Every NUMBER in these claims is read from the live `rules` module or out of the
 * view's own source, never restated. A contract that writes `0.35` next to a
 * module that owns `0.35` is a contract that stays green the day one of them moves.
 *
 * The `rules` THIRD ARGUMENT exists only so the mutation list can break a number
 * in `rules.js` and see the claim that depends on it go red. Two of the eleven
 * mutations are in that file rather than in the view, and a function that read
 * `rules.js` off disk instead of taking it would have reported them as "no claim
 * broke" and told the reader the pass was untested.
 */
function portalDescentClaims(view, world, rulesSource = RULES_SOURCE) {
  const code = stripProse(view)
  const worldCode = stripProse(world)
  const claims = []
  const claim = (name, ok, why) => claims.push({ name, ok: Boolean(ok), why })
  const buildPortals = methodBody(code, '_buildPortals')
  const setShut = methodBody(code, 'setPortalShut')
  const setViewer = methodBody(code, 'setViewer')
  const near = methodBody(code, '_portalNear')
  const facing = methodBody(code, '_portalFacing')
  const writeDebris = methodBody(code, '_writeDebris')
  const collapseOne = methodBody(code, '_collapsePortal')
  const makeLens = methodBody(code, 'makeLensTexture')
  const tick = methodBody(code, 'update')
  // Declared here rather than beside claim 10, its first use, because claim 1 reads
  // it too. A `const` read above its own declaration is a ReferenceError, and a
  // ReferenceError inside a claims function is a claim that fails for a reason that
  // has nothing to do with the claim.
  const rulesCode = stripProse(rulesSource)

  // 1. THE NEAR FIELD IS ASKED FOR IN THE VIEW AND DECIDED IN THE PURE MODULE. This
  //    is the pass-9/10/11 architecture applied to the portal: a `Math.min(8, ...)`
  //    in the view is a second definition of a moment the pure harness tests, and
  //    the pure harness is the only thing here that can prove a ramp is C1.
  claim(
    'the near field is asked of the pure module, by both helpers, and applied as a rate multiplier',
    /const near = rules\.portalNearness\(this\._portalNear\(portal\), this\._portalFacing\(portal\)\)/.test(tick)
      && /const rate = rules\.portalSwirlRate\(PORTAL_SWIRL_RATES\[layer\], near\)/.test(tick)
      && /if \(!viewer\) return Infinity/.test(near)
      && /if \(!viewer\) return -1/.test(facing)
      && /!Number\.isFinite\(distance\) \|\| !Number\.isFinite\(facing\)\) return 0/.test(rulesCode),
    'a nearness computed in the view is a second definition of a moment this file can test, and a null viewer that is not short-circuited is a `Math.hypot` of undefined, which is a NaN that silently holds the swirl at its own rate for the rest of the run',
  )
  // 2. **THE FOLD IS THE FOLD, IN BOTH HELPERS.** `worldOf` and not
  //    `portal.position`, and the two are asserted separately because a version that
  //    folded the distance but not the bearing produces a near field that is right
  //    about how far and wrong about which way — the worst of the two failures,
  //    because it still looks plausible.
  claim(
    'distance and bearing are both measured in the folded frame',
    /const world = this\.worldOf\(portal\.position\)/.test(near)
      && /const world = this\.worldOf\(portal\.position\)/.test(facing)
      && /Math\.hypot\(world\.x - viewer\.x, world\.z - viewer\.z\)/.test(near)
      && /const length = Math\.hypot\(dx, dz\)/.test(facing)
      && /if \(length < 1e-6\) return -1/.test(facing)
      && !/portal\.position\.x - viewer/.test(code),
    'an unfolded distance is 448 m out on the far side of a seam, and a bearing with no zero-length guard is a NaN that silently stops the swirl at its own rate for ever',
  )
  // 3. **THE NEAR FIELD IS INTEGRATED, NOT MULTIPLIED INTO THE CLOCK.** This is
  //    pass 3's claim restated for pass 12's form, and the negative half is the
  //    half that matters. The bug this pass actually shipped and then fixed was
  //    `rotation.z = t * rate` with a rate that VARIES: `t * d(rate)` is a
  //    discontinuity, and at 143 s crossing the 8 m boundary moved the arms eighteen
  //    radians. So the gate now forbids the product form explicitly as well as
  //    forbidding an increment that omits `dt` — the two are the two ways this can
  //    be wrong, and the old gate could only see one of them because the other did
  //    not exist yet.
  claim(
    'the swirl integrates a rate against dt, and never multiplies a varying one by the clock',
    /portal\.swirl\[layer\]\.rotation\.z \+= rate \* dt/.test(tick)
      && !/portal\.swirl\[[^\]]*\]\.rotation\.z \+= (?!rate \* dt)/.test(code)
      && !/portal\.swirl\[[^\]]*\]\.rotation\.z = t \* /.test(code),
    'a product of the clock and a rate that varies with the player is a discontinuity of `t * d(rate)` — eighteen radians of teleport when you cross 8 m at the two-minute mark — and an increment without `dt` is a frame count rather than an animation',
  )
  // 4. THE DEBRIS IS ONE INSTANCED MESH PER PORTAL, sized by the cap and drawn by
  //    the count. The `capacity`/`count` PAIR is the part that is easy to get
  //    wrong, and the first version of this pass set them to the same number —
  //    which is a mesh that cannot grow without a rebuild and a cap that has
  //    stopped meaning anything, because a cap equal to the count constrains
  //    nothing.
  claim(
    'the debris is one instanced mesh per portal, sized by the cap and drawn by the count',
    /new THREE\.InstancedMesh\(\s*new THREE\.TetrahedronGeometry\(1, PORTAL_FLAKE_DETAIL\),\s*this\._materials\.portalDebris,\s*PORTAL_DEBRIS_CAPACITY,\s*\)/s.test(buildPortals)
      && /debris\.count = rules\.PORTAL_DEBRIS_COUNT/.test(buildPortals)
      && /debris\.frustumCulled = false/.test(buildPortals)
      && /debris\.instanceMatrix\.setUsage\(THREE\.DynamicDrawUsage\)/.test(buildPortals)
      && /portal\.debris\.instanceMatrix\.needsUpdate = true/.test(writeDebris)
      && /portal\.debris\.setMatrixAt\(i, dummy\.matrix\)/.test(writeDebris)
      && /const PORTAL_DEBRIS_CAPACITY = rules\.PORTAL_DEBRIS_MAX/.test(code)
      && rules.PORTAL_DEBRIS_COUNT < rules.PORTAL_DEBRIS_MAX,
    'fourteen Meshes is fourteen draw calls for fourteen specks, an InstancedMesh with no needsUpdate renders every flake at the first one\'s matrix, and a frustum-culled pool built from a geometry whose instances are all at the origin vanishes the moment the camera looks at the doorway from an angle',
  )
  // 5. **THE POSE IS THE PURE ONE, ON THE GATE'S OWN AXES, AND NEVER ON THE
  //    MESH.** A flake billboarded to the camera is the thing AESTHETIC-NOTES §6
  //    rules out, and it is also a second way for the pupil argument to be true in
  //    one direction and false in another.
  claim(
    'a rock is posed by the pure module, unrotated to face the camera, from one shared scratch object',
    /const pose = rules\.portalDebrisPose\(portal\.rocks\[i\], t\)/.test(writeDebris)
      && /dummy\.position\.set\(pose\.x, pose\.y, 0\)/.test(writeDebris)
      && /dummy\.rotation\.set\(0, 0, pose\.angle\)/.test(writeDebris)
      && /dummy\.scale\.setScalar\(pose\.size\)/.test(writeDebris)
      && /if \(!portal\.debris\.visible\) return/.test(writeDebris)
      && /this\._debrisMatrix = new THREE\.Object3D\(\)/.test(code)
      && !/new THREE\.Object3D\(\)/.test(writeDebris)
      && !/applyQuaternion|camera\.quaternion/.test(writeDebris),
    'a pose written in the view is a second definition of an orbit the pure harness tests, a billboard is a flake whose shape changes with the bearing, a per-rock `new THREE.Object3D()` is 42 allocations a frame, and composing matrices for a hidden mesh is 42 matrix composes a frame for the rest of the run',
  )
  // 6. **THE LENS NORMAL-BLENDS A NEAR-BLACK OVER THE PURE PROFILE.** Three claims in
  //    one, because each of the three is a separate way to brighten the pupil: an
  //    ADDITIVE material can only add light, a profile written in the view is a
  //    profile nothing can prove is zero at the centre, and a hand-typed texture is
  //    a texture whose centre is whatever the author typed.
  claim(
    'the lens is a normal-blended near-black over the pure profile, and it is never drawn over the rim',
    /portalLens: this\._glow\(0x000000, \{/.test(code)
      && !/portalLens: this\._glow\(0x000000, \{[\s\S]{0,240}?AdditiveBlending/.test(code)
      && /map: lens,/.test(code)
      && /depthWrite: false/.test(code)
      && /rules\.portalLensAlpha\(ratio\)/.test(makeLens)
      && /new THREE\.CircleGeometry\(PORTAL_CORE_RADIUS \* rules\.PORTAL_LENS\.outer, PORTAL_LENS_SEGMENTS\)/.test(buildPortals)
      && /const PORTAL_LENS_RENDER_ORDER = 0\b/.test(code)
      && /lens\.renderOrder = PORTAL_LENS_RENDER_ORDER/.test(buildPortals),
    'an additive lens can only ADD light, so it can brighten the exact pixel the pass-3 pupil gate measures; a profile written in the view is a profile nothing can prove is zero at the centre; and a lens lifted above renderOrder 0 is one `renderOrder = 3` on some other feature away from being painted over the lip, which is the only thing marking where the hole is',
  )
  // 7. **THE COLLAPSE IS A SECOND APERTURE, NOT THE LIVE GATE.** §5.3 says a shut
  //    portal is dark INSTANTLY and for ever, so the live gate has to be dead on
  //    the frame the hold completes — and a collapse that animated the live gate
  //    would be a lit hole for 0.8 s, which is the rule being a lie for exactly as
  //    long as a player is closest to it.
  //
  //    The two COUNTS are the load-bearing part. Three portals write
  //    `portal.collapse.visible` in two places — the arm in `setPortalShut` and the
  //    kill in `_collapsePortal` — and the build's `collapse.visible = false` is a
  //    third, on a local rather than on the record. A fourth is a second door.
  claim(
    'the collapse is a second aperture over a dead one, and setPortalShut is the only door to it',
    /const collapse = new THREE\.Group\(\)/.test(buildPortals)
      && /collapse\.visible = false/.test(buildPortals)
      && /gate\.add\(collapse\)/.test(buildPortals)
      && /portal\.collapse\.visible = shut/.test(setShut)
      && /portal\.collapseAt = shut \? this\._time : null/.test(setShut)
      // THREE writes, and all three are accounted for rather than merely counted:
      // the arm in `setPortalShut`, the kill in `_collapsePortal`, and the wipe in
      // `resetMotion`. The assertion is that the count is exactly those three AND
      // that each is where it is claimed to be, because "three" on its own is a
      // number and a fourth door would be a fourth line. `resetMotion` is pass 12's
      // own addition and the reason the count moved from two.
      && (code.match(/portal\.collapse\.visible = /g) ?? []).length === 3
      && /portal\.collapse\.visible = false/.test(methodBody(code, 'resetMotion')),
    'a collapse that animated the live gate would put a lit hole over a lit one for 0.8 s and §5.3 would be a lie for exactly as long as the player is standing at the door; and a third line that unhides the collapse is a second way for a dead portal to start turning',
  )
  // 8. **AND THE COLLAPSE RUNS IN A LOOP THAT IS NOT THE LIVE ONE.** The live loop
  //    opens with `if (portal.shut) continue`, which is §5.3's inertness, so the
  //    collapse cannot live inside it without either moving that `continue` — which
  //    is the pass-3 gate's own assertion — or running for a live portal. Two loops
  //    is the honest shape, and the second one is keyed on `collapseAt === null`
  //    rather than on `shut`, because a portal that finished collapsing thirty
  //    seconds ago is still shut and must not be animated.
  claim(
    'the collapse is a separate loop, keyed on collapseAt rather than on shut',
    /for \(const portal of this\.portals\) \{\s*if \(portal\.collapseAt === null\) continue\s*this\._collapsePortal\(portal, t\)\s*\}/s.test(tick)
      && /const elapsed = t - portal\.collapseAt/.test(collapseOne)
      && /rules\.portalCollapse\(elapsed\)/.test(collapseOne)
      && /if \(collapse\.scale === 0\) portal\.collapse\.visible = false/.test(collapseOne)
      // a group scaled to zero is still drawn as a degenerate triangle at the
      // origin, which for a portal standing in a doorway is a flicker on the road
      && /portal\.collapse\.scale\.setScalar\(collapse\.scale\)/.test(collapseOne)
      // ...and the spin is a product of elapsed, never an accumulator, for the
      // reason the swirl is: a rate written onto a clock is frame-rate independent
      && /portal\.collapse\.rotation\.z = elapsed \* collapse\.spin \* PORTAL_COLLAPSE_TWIST/.test(collapseOne),
    'a collapse loop inside the `if (portal.shut) continue` loop is a loop that either runs for a live portal or moves that continue, and keying it on `shut` instead of `collapseAt` re-runs the 0.8 s for ever on a portal that shut half a minute ago; a zero-scaled group left visible is a degenerate triangle drawn at the world origin',
  )
  // 9. **THE WORLD HANDS THE VIEW AN EYE, ONCE A FRAME, FROM THE CAMERA.** Three
  //    claims: that the wiring exists at all (without it `this.viewer` is null for
  //    ever, the near field is 0 everywhere, and that is a feature which is
  //    completely absent with every check in this file green); that it is the
  //    CAMERA and not the player, because the camera carries the bob, the sway and
  //    the shake; and that it is the camera's YAW, which is what `setViewer` turns
  //    into the forward vector the bearing is dotted with.
  claim(
    'the world hands the view the eye once a frame, from the camera, before the view ticks',
    /this\.streetView\.setViewer\(this\.camera\.position\.x, this\.camera\.position\.z, this\.camera\.rotation\.y\)/.test(worldCode)
      && /this\.viewer\.dx = -Math\.sin\(yaw\)/.test(setViewer)
      && /this\.viewer\.dz = -Math\.cos\(yaw\)/.test(setViewer)
      && worldCode.indexOf('this.streetView.setViewer(') < worldCode.indexOf('this.streetView.update(dt)'),
    'a `setViewer` nobody calls leaves the near field permanently at zero, and a near field permanently at zero is a feature no gate in the repository can see; and a view handed `player.pos` answers the BODY, which is a frame early and a third of a metre low through a chase shake',
  )
  // 10. AND NOTHING IN THE PASS IS UNSEEDED OR WALL-CLOCKED. D10 is the rule and
  //     §16.5 needs each of fourteen frames re-takeable, and this pass added
  //     geometry and an animation to the aperture — the two things most likely to
  //     arrive with a `Math.random` in them.
  //
  //     The whole-file negative runs over the STRIPPED source, which is the
  //     pass-11 lesson restated: an unstripped search for `Math.random` cannot
  //     tell this pass's own prose describing the choice from the bug it
  //     describes, and pass 11's version of this claim fired on pass 11's own
  //     comment before it was fixed.
  claim(
    'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
    !/Math\.random/.test(code + worldCode + rulesCode)
      && !/Date\.now|performance\.now|new Date/.test(code + worldCode + rulesCode)
      && /hash32\(seed \+ salt \* 2654435761, index \* 31 \+ i, salt \* 7 \+ 3\)/.test(rulesCode)
      && /rocks: rules\.portalDebrisRing\(this\.seed, index\)/.test(buildPortals),
    'D10 is the rule and §16.5 needs each of fourteen frames reproducible twice, so a random orbit is not one un-reproducible frame but every frame of the run',
  )
  return claims
}

test('the descent claims are the source contracts, and every one holds', () => {
  const claims = portalDescentClaims(STREET_VIEW_SOURCE, WORLD_SOURCE)
  const broken = claims.filter((entry) => !entry.ok)
  assert.deepEqual(broken, [], `${broken.map((entry) => `${entry.name} — ${entry.why}`).join(' | ')}`)
  assert.ok(claims.length >= 10, `the descent section has ${claims.length} claims, fewer than the 10 it needs`)
  console.log(`\n  pass-12 claims: ${claims.length} source contracts, every one holding`)
})

test('every descent claim can actually fail, and a mutation names the one it breaks', () => {
  // TWELVE MUTATIONS, and the choice of which properties to break is the point:
  // each one is a way this pass could have shipped a feature that exists, is pure,
  // is deterministic, and is invisible. Pass 10 shipped a trail in no frame with no
  // gate able to see that; pass 11 answered it with a check that projects a puff
  // into the frame and mutates. This is the same discipline applied to four
  // features at once.
  const mutations = [
    ['the near field never asked for', 'the whole feature is absent and every number in rules.js is dead code, which is a green gate over a hole',
      'the near field is asked of the pure module, by both helpers, and applied as a rate multiplier',
      'view', 'const near = rules.portalNearness(this._portalNear(portal), this._portalFacing(portal))', 'const near = 0'],
    ['the near field\'s DISTANCE measured unfolded', 'the third structure gets no near field at all and the two that do look fine, so a screenshot review finds nothing to report',
      'distance and bearing are both measured in the folded frame',
      // TWO-LINE anchors, and the reason is pass 11's `lampDreadSeed` finding
      // verbatim: `const world = this.worldOf(portal.position)` appears THREE times
      // in this file, and the first is `nearestPortal`'s — §5.2's reach test. A
      // one-line `replace` therefore mutated the hold verb's stand-off and reported
      // "no claim broke", which is a mutation that proves nothing and looks like a
      // pass. The `return` and the `const dx` lines are what make each unique.
      'view', 'const world = this.worldOf(portal.position)\n    return Math.hypot(world.x - viewer.x, world.z - viewer.z)',
      'const world = portal.position\n    return Math.hypot(world.x - viewer.x, world.z - viewer.z)'],
    ['the near field\'s BEARING measured unfolded', 'distance right and bearing wrong is the worst of the two failures, because it still looks plausible: the swirl answers you when you are 3 m away and at an angle that has nothing to do with where you are facing',
      'distance and bearing are both measured in the folded frame',
      'view', 'const world = this.worldOf(portal.position)\n    const dx = world.x - viewer.x',
      'const world = portal.position\n    const dx = world.x - viewer.x'],
    ['the near field written as a product of the clock', '`t * rate` with a rate that VARIES is a discontinuity of `t * d(rate)`: crossing 8 m at the two-minute mark teleports the arms eighteen radians instead of speeding them up. This is the bug this pass shipped and this world check found',
      'the swirl integrates a rate against dt, and never multiplies a varying one by the clock',
      'view', 'portal.swirl[layer].rotation.z += rate * dt', 'portal.swirl[layer].rotation.z = t * rate'],
    ['the swirl advanced by a frame COUNT', 'frame-rate dependence in the sense pass 3 meant, and the reason its gate forbade `+=` in the first place — it just could not tell this from a dt-scaled integral until the rate started varying',
      'the swirl integrates a rate against dt, and never multiplies a varying one by the clock',
      'view', 'portal.swirl[layer].rotation.z += rate * dt', 'portal.swirl[layer].rotation.z += rate'],
    ['the debris count set to nothing', 'the mesh is built, named, stored on the portal and measured by every geometry check, and draws no flakes — the pass-3 `gate.add(disc)` mutation, wearing a ring',
      'the debris is one instanced mesh per portal, sized by the cap and drawn by the count',
      'view', 'debris.count = rules.PORTAL_DEBRIS_COUNT', 'debris.count = 0'],
    ['the instance matrices never uploaded', "every one of the fourteen flakes renders at the first flake's matrix, so the ring is a single tetrahedron orbiting the hole",
      'the debris is one instanced mesh per portal, sized by the cap and drawn by the count',
      'view', 'portal.debris.instanceMatrix.needsUpdate = true', 'portal.debris.instanceMatrix.needsUpdate = false'],
    ['a billboarded flake', "the flake turns to face the camera, so the ring's silhouette changes with the bearing — and a billboarded bright quad is exactly what the eye finder looks for",
      'a rock is posed by the pure module, unrotated to face the camera, from one shared scratch object',
      'view', 'dummy.rotation.set(0, 0, pose.angle)', 'dummy.rotation.set(0, 0, pose.angle); dummy.quaternion.copy(this.camera.quaternion)'],
    ['an additive lens', 'an additive material can only ADD light, so this is the one change in the pass that could brighten the exact pixel the pass-3 pupil gate measures — and nothing in the pure module can see it happen',
      'the lens is a normal-blended near-black over the pure profile, and it is never drawn over the rim',
      'view', 'portalLens: this._glow(0x000000, {', 'portalLens: this._glow(0x000000, { blending: THREE.AdditiveBlending,'],
    ['the lens profile reimplemented in the view', 'a second definition of a radial profile, and the only gate that can prove the centre is zero is the one on the pure function',
      'the lens is a normal-blended near-black over the pure profile, and it is never drawn over the rim',
      'view', 'rules.portalLensAlpha(ratio)', 'Math.max(0, 0.34 * (1 - ratio))'],
    ['the collapse hung on the street root instead of the gate', 'the collapse is at the world origin rather than in the doorway — the pass-3 "a floating hoop instead of a hole in a shell" failure, in a new costume, and it is the ONLY mutation here that changes where a thing is drawn rather than how it is drawn',
      'the collapse is a second aperture over a dead one, and setPortalShut is the only door to it',
      'view', 'gate.add(collapse)', 'this.group.add(collapse)'],
    ['the collapse keyed on `shut`', 'a portal that shut half a minute ago is still shut, so its 0.8 s collapse re-runs for ever and a dead hole keeps spinning',
      'the collapse is a separate loop, keyed on collapseAt rather than on shut',
      'view', 'if (portal.collapseAt === null) continue', 'if (!portal.shut) continue'],
    ['`setViewer` wired to the body, with the yaw dropped', 'the near field answers the BODY — a frame early and a third of a metre low through a chase shake — and a view handed a yaw instead of a forward vector is a rotation somebody has to do by hand on the way in',
      'the world hands the view the eye once a frame, from the camera, before the view ticks',
      'world', 'this.streetView.setViewer(this.camera.position.x, this.camera.position.z, this.camera.rotation.y)',
      'this.streetView.setViewer(this.player.pos.x, this.player.pos.z, 0)'],
    ['an unseeded orbit', 'a random orbit is not one un-reproducible frame, it is every frame of the run, and §16.5 needs each of fourteen captured twice',
      'nothing in the pass is unseeded, wall-clocked, or read from a second clock',
      'rules', 'const pick = (salt) => (hash32(seed + salt * 2654435761, index * 31 + i, salt * 7 + 3) >>> 8) / 0x00ffffff',
      'const pick = (salt) => Math.random()'],
  ]
  // The three sources, addressed by the tag each mutation carries. This is the same
  // third-argument arrangement pass 11 uses for `creature.js`, and it is why two of
  // the twelve are tagged `rules`: an unseeded orbit is a change in the PURE module,
  // and a claims function that only ever read the view could not see it happen.
  const sources = { view: STREET_VIEW_SOURCE, world: WORLD_SOURCE, rules: RULES_SOURCE }
  for (const [label, why, claimName, file, from, to] of mutations) {
    assert.ok(sources[file].includes(from), `"${label}" mutated text that is not in ${file}.js: ${from}`)
    const broken = portalDescentClaims(
      file === 'view' ? STREET_VIEW_SOURCE.replace(from, to) : STREET_VIEW_SOURCE,
      file === 'world' ? WORLD_SOURCE.replace(from, to) : WORLD_SOURCE,
      file === 'rules' ? RULES_SOURCE.replace(from, to) : RULES_SOURCE,
    ).filter((entry) => !entry.ok)
    assert.ok(
      broken.some((entry) => entry.name === claimName),
      `"${label}" broke [${broken.map((entry) => entry.name).join(', ')}] but should have broken "${claimName}" — ${why}`,
    )
  }
  assert.ok(mutations.length >= 12, `only ${mutations.length} mutations, which is fewer than this pass needs`)
  console.log(`\n  pass-12 mutations: ${mutations.length} mutations, every one caught`)
})

test('pass 12 moved the frame without moving the four gates that measure it', () => {
  // THE FOUR REGRESSION GUARDS, AND WHY THEY ARE HERE RATHER THAN IN THE
  // SECTIONS THAT OWN THEM.
  // ---------------------------------------------------------------
  // Pass 12 added GEOMETRY to an aperture that four existing gates measure: the
  // pupil (`swirlContrast().pupil <= 20`), the swirl's spread and its dark gaps,
  // the eye-finder's brightness/span/area, and §16.5's lit floor. All four already
  // have sections of their own, three with mutation harnesses, and all four run
  // under `npm run check`.
  //
  // So this is deliberately NOT a fifth copy of them. It is ONE measurement that
  // reads the same committed PNGs and reports all four numbers together, because
  // what a fidelity pass has to demonstrate is that its features moved the frame
  // and did not move the gates — and four gates being green separately does not
  // tell a reader WHICH frame they moved. The margins printed at the end are the
  // number worth reviewing: a pass that ate a third of a gate's margin is a pass
  // that needs a reviewer, and a pass that ate none is a pass that changed nothing
  // a human would notice.
  const report = new URL('./benchmark/captures.json', import.meta.url)
  assert.equal(existsSync(report), true, 'benchmark/captures.json is missing — run npm run capture')
  const parsed = JSON.parse(readFileSync(report, 'utf8'))
  // `entry.luma` is an OBJECT — `{lit, litPct, mean, max}` — not the number the
  // harness printed, and `entry.minLit` is the floor. A first version of this test
  // read `entry.luma` as a scalar and got `NaN < floor`, which is `false` for every
  // frame at once, and then read `minLit` off `captureView()` where it does not
  // live. Both halves are written out below because both were tried and both were
  // wrong, and a reader who repeats either of them gets a confusing error rather
  // than an obvious one.
  // 1. THE PUPIL, in every frame the swirl finder resolves a portal in. This is the
  //    gate the whole pass was written to survive: the debris is geometry IN the
  //    aperture and the lens is a dark quad in FRONT of it, and a rock on the
  //    pupil or a lens profile not quite zero at the centre would show up here and
  //    nowhere else.
  //
  //    `portal-shutdown` is the interesting one: it stands at 2.2 m, inside both
  //    `PORTAL_NEAR_METRES` and `streetView.portalRange`, so it is the most
  //    near-field-saturated frame in the gallery.
  const pupilReadings = []
  const swirlReadings = []
  for (const id of ['portal-located', 'portal-shutdown']) {
    const measured = swirlContrast(readFileSync(new URL(`./${capture.CAPTURE_DIR}/${id}.png`, import.meta.url)))
    assert.equal(measured.found, true, `${id}.png resolves no portal, so the pupil cannot be read from it`)
    assert.ok(
      measured.pupil <= 20,
      `pass 12 put light in the hole: ${id}.png's pupil is ${measured.pupil} against a ceiling of 20 — ${describeSwirlContrast(measured)}`,
    )
    // ...and the swirl's STRUCTURE on the same two frames, because the near field
    // changed the rate a live portal turns at and the rate is what the spiral's
    // contrast is a function of. `band.sd` is the spread inside the band and
    // `band.p10` is the dark gap that keeps it from being a painted disc.
    assert.ok(measured.band.sd >= 28, `${id}.png has lost its swirl structure (sd ${measured.band.sd}) — ${describeSwirlContrast(measured)}`)
    assert.ok(measured.band.p10 <= 32, `${id}.png has no dark gaps left in the swirl (p10 ${measured.band.p10}) — ${describeSwirlContrast(measured)}`)
    pupilReadings.push({ id, pupil: measured.pupil })
    swirlReadings.push({ id, sd: measured.band.sd, p10: measured.band.p10 })
  }
  // 2. NO FALSE EYE. The debris is dark by construction and the lens is
  //    normal-blended, so neither can manufacture a finder hit on its own — but
  //    the eye finder is the one gate a BRIGHT new object mid-frame can trip, and
  //    the portal frames are in the gallery too. So the finder runs on the three
  //    creature frames for pass 2's claim (every creature still resolves an eye)
  //    and on the two portal frames for pass 12's claim (the ring and the lens are
  //    not one).
  const eyes = []
  for (const id of ['creature-stalking', 'creature-chasing', 'banish']) {
    const measured = creatureContrast(readFileSync(new URL(`./${capture.CAPTURE_DIR}/${id}.png`, import.meta.url)))
    const eye = measured.eye
    // The span is the BOUNDING BOX, derived here rather than read off the eye,
    // because `png-luma.mjs` reports the box and pass 2's section derives the
    // span from it. A second reader of a field that does not exist reads
    // `undefined`, and `undefined <= 14` is false — so a typo in a field name
    // fails the gate, which is the right direction, but it fails with a number
    // that means nothing. Deriving it here is one subtraction and a legible error.
    const spanX = eye.maxX - eye.minX
    const spanY = eye.maxY - eye.minY
    assert.ok(eye.mean >= EYE_MIN, `${id}.png resolves an eye at ${eye.mean.toFixed(1)}, under the ${EYE_MIN} floor`)
    assert.ok(eye.n >= EYE_MIN_AREA, `${id}.png resolves a ${eye.n} px eye, under the ${EYE_MIN_AREA} px area floor`)
    assert.ok(spanX <= EYE_MAX_SPAN && spanY <= EYE_MAX_SPAN, `${id}.png resolves a ${spanX}x${spanY} px eye against a ${EYE_MAX_SPAN} px ceiling`)
    eyes.push({ id, mean: eye.mean })
  }
  // The two portal frames, asserted the other way round. `creatureContrast` does
  // not return an `eye` object at all when it finds nothing — it returns
  // `{found: false, reason}`, and there is no `eye` key to read. So the claim is
  // `found === false` and NOT `eye.n === 0`: the first version of this line read
  // `.eye.n` off a frame with no eye in it and threw a TypeError, which is a
  // failure that looks like a broken harness rather than a broken frame.
  for (const id of ['portal-located', 'portal-shutdown']) {
    const measured = creatureContrast(readFileSync(new URL(`./${capture.CAPTURE_DIR}/${id}.png`, import.meta.url)))
    assert.equal(
      measured.found,
      false,
      `${id}.png now resolves an eye (${measured.eye?.n} px at ${measured.eye?.mean.toFixed(1)} luma) — a 14-rock ring and a lensing overlay have become a creature`,
    )
  }
  // 3. AND THE LIT FLOOR, on all fourteen, against the number the capture module
  //    owns. The lens is the only element this pass added that can take light OUT
  //    of a frame, and it takes it off the shell wall behind a portal — which is
  //    `portal-located`'s background, so that is the one frame whose floor could
  //    move. `title` carries its own lower floor and is checked against that.
  // ...and the floor comes off the REPORT rather than off the view definition,
  // which is the right way round and not an accident of where the fields happen to
  // live. `capture.captureView(id)` returns `{id, label, viewport, steps}` — there
  // is no `minLit` on it, because a floor is a property of what was MEASURED
  // (the PNG on disk, at 1280x720, in this run) and not of what was ASKED FOR
  // (a list of steps). The report carries `minLit` because that is where the
  // harness resolved the view's declared floor against the frame it got. Reading
  // it from the report means a view that declares a floor and a run that measured
  // against a different one cannot disagree without this test noticing.
  const litReadings = []
  for (const id of capture.CAPTURE_IDS) {
    const entry = parsed.captures.find((row) => row.id === id)
    assert.ok(entry, `${id} is not in the capture report`)
    const lit = entry.luma.lit
    const floor = entry.minLit
    assert.ok(
      Number.isFinite(floor),
      `${id}.png has no floor on its own report row, so "is it lit enough" has nothing to answer against`,
    )
    assert.ok(lit >= floor, `${id}.png is ${(lit * 100).toFixed(2)}% lit against its own ${(floor * 100).toFixed(2)}% floor — a darker frame than the pass before it`)
    litReadings.push({ id, lit, floor, margin: lit / floor })
  }
  const tightest = litReadings.reduce((a, b) => (a.margin < b.margin ? a : b))
  const worstPupil = pupilReadings.reduce((a, b) => (a.pupil > b.pupil ? a : b))
  const tightestEye = eyes.reduce((a, b) => (a.mean < b.mean ? a : b))
  const tightestSwirl = swirlReadings.reduce((a, b) => (a.sd < b.sd ? a : b))
  console.log(
    `\n  pass-12 regression margins — pupil ${worstPupil.pupil}/20 (${worstPupil.id}), ` +
      `swirl sd ${tightestSwirl.sd}/28 (${tightestSwirl.id}), ` +
      `eye ${tightestEye.mean}/${EYE_MIN} (${tightestEye.id}), ` +
      `lit ${(tightest.lit * 100).toFixed(2)}%/${(tightest.floor * 100).toFixed(2)}% (${tightest.id})`,
  )
})

// PASS12_SECTION

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

let total = 0
for (const group of sections) {
  console.log(`\n${group.title}`)
  for (const entry of group.tests) {
    total += 1
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.ok) console.log(`        ${entry.error}`)
  }
}
console.log(`\n${passed}/${total} checks passed${failed ? ` — ${failed} FAILED` : ' — all green'}`)
if (failed > 0) process.exitCode = 1
