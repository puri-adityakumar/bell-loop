#!/usr/bin/env node
/**
 * verify.mjs — node-side assertions over the PURE game modules
 * (`src/game/maze.js` and the reducers in `src/game/loop.js`).
 *
 * The browser game cannot be clicked by a script, so this file proves the parts
 * that are testable headlessly:
 *   - the PRNG is deterministic and the seed really is the loop number
 *   - every loop's maze is fully connected and byte-identical on re-generation
 *   - the centre chamber always has exactly one doorway, matching centerApproach
 *   - the three shrines are always one per documented zone, distinct, clear of
 *     the landmarks, and reachable inside a single 60s loop
 *   - wall segments exactly cover every closed edge (no gaps, no phantoms)
 *   - the candle / door / timer / bell-timeline rules in loop.js
 *
 * Run: node verify.mjs   (exit code 0 = all green)
 */
import assert from 'node:assert/strict'
import {
  generateMaze,
  mulberry32,
  mazeSignature,
  reachableCells,
  hasPath,
  pathLength,
  distanceMap,
  openEdgeCount,
  hasWall,
  cellKey,
  cellToWorld,
  chebyshev,
  GRID,
  CELL_SIZE,
  WALL_HEIGHT,
  WALL_THICKNESS,
  MAX_ENTRANCE_DEPTH,
  MIN_EXTRA_CARVES,
  EXTRA_CARVE_BUDGET,
  LANDMARK_CLEARANCE,
  MIN_SHRINE_DISTANCE,
  SHRINE_POOL,
  ZONES,
  SHRINE_IDS,
  ENTRANCE,
  CENTER,
  DIRS,
  E,
  S,
  APPROACH_YAW,
} from './src/game/maze.js'
// v2 slice 01. `maze.js` still exports its own `mulberry32` for v1 and that is
// untouched until slice 16 deletes it, so the two are imported under distinct
// names here — the temporary duplication stays visible instead of silent.
import {
  hash32,
  streamAt,
  mulberry32 as mulberry32V2,
} from './src/game/hash.js'
// v2 slice 02. Imported as a namespace because GRID, BLOCK and the BFS helper
// names all collide with v1's maze.js exports; slice 16 removes that overlap for
// good, and until then the v2 world reads `hood.*` beside v1's flat names.
import * as hood from './src/game/neighborhood.js'
// v2 slice 05. Namespace again: `breath`, `portals` and friends are game-state
// names as well as rule names, and flat imports would read ambiguously.
import * as rules from './src/game/rules.js'
// v2 slice 06. Namespace for the same reason, twice over: `state`, `distance`,
// `sounds` and `captured` are all frame fields *and* all rule names, and the
// creature's states would sit next to v1's PHASE table looking like one thing.
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
// half of them collide with things already imported flat. It is also the module
// that *replaced* v1's `hudSnapshot` in `loop.js`, so nothing here has to be
// renamed when slice 16 deletes `loop.js`.
import * as hud from './src/ui/hud.js'
import { readFileSync } from 'node:fs'
import {
  LOOP_SECONDS,
  PHASE,
  RESET_TIMELINE,
  RESET_SWAP_AT,
  createInitialState,
  candlesLit,
  allCandlesLit,
  shouldDoorOpenAtLoopStart,
  applyLightCandle,
  advanceTimer,
  beginLoop,
  restartState,
  resetFade,
  wallRiseProgress,
  wallRiseDelay,
  createStore,
  DOOR_WIN_RADIUS,
  isInsideChamber,
} from './src/game/loop.js'

const VERIFY_LOOPS = [1, 2, 3, 4, 5, 6, 7, 8]
const WALK_SPEED = 3.6 // m/s, PlayerController default

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
  const direct = mulberry32V2(hash32(1337, 6, 6))
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

test('isInsideExit mirrors v1 isInsideChamber, negatives included', () => {
  assert.equal(rules.EXIT_WIN_RADIUS, DOOR_WIN_RADIUS)
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
    assert.equal(
      rules.isInsideExit(position, centre, radius),
      isInsideChamber(position, centre, radius),
      `isInsideExit disagreed with isInsideChamber at ${JSON.stringify(position)}`,
    )
  }
  assert.equal(
    rules.isInsideExit({ x: 0, z: 0 }, { x: 0, z: 0 }),
    isInsideChamber({ x: 0, z: 0 }, { x: 0, z: 0 }),
  )
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
  // a second Act II, heard at 3 m, and this time it does become a chase
  gait('heard at three metres', 'sprint', 3, 3, SPRINT_STRIDE_FRAMES, 300)
  // the finale, mid-chase (§6.1, §10.2): it stops searching and simply knows
  quiet('third portal', 1, 3, { finale: true })
  quiet('enraged knowledge', 240, 30)
  // §10.2: the hammer still works in the finale, it just does not wait
  quiet('swing in the finale', 1, 1.5, { swing: true })
  quiet('banished in the finale', 120, 60)
  quiet('flat re-emergence', 1, 60, { reemerge: true })
  // and the enrage edge again, out of a stalk rather than out of a chase
  quiet('third portal from a stalk', 1, 40, { finale: true })
  quiet('swing to put it back to sleep', 1, 1.5, { swing: true })
  quiet('banished again', 120, 60)
  quiet('third re-emergence', 1, 60, { reemerge: true })
  // the last three edges, all of them out of REPOSITION: it is the state the
  // design spends the most prose on and the one a careless refactor loses
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options', 1, 8, { searchExhausted: true })
  quiet('the last portal', 1, 8, { finale: true })
  quiet('swing in the finale again', 1, 1.5, { swing: true })
  quiet('banished once more', 120, 60)
  quiet('fourth re-emergence', 1, 60, { reemerge: true })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options again', 1, 8, { searchExhausted: true })
  quiet('swing while searching', 1, 2, { swing: true })
  quiet('banished', 120, 60)
  quiet('fifth re-emergence', 1, 60, { reemerge: true })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options once more', 1, 8, { searchExhausted: true })
  gait('it finds the street', 'sprint', 2, 2, SPRINT_STRIDE_FRAMES, 300)
  // §8.2, and the only way to reach DORMANT without a hammer in the air: thirteen
  // seconds of unbroken pursuit at 6 m. The meter never dips, so nothing else can
  // end this chase, and at CHASE_MAX_SECONDS the creature gives it up and is gone.
  gait('a chase that will not end', 'sprint', 6, 6, SPRINT_STRIDE_FRAMES, 780)
  quiet('silence while it is gone', 120, 60)
  quiet('re-emergence after the phase-out', 1, 60, { reemerge: true })
  gait('it finds the street again', 'sprint', 2, 2, SPRINT_STRIDE_FRAMES, 300)
  // the last swing of the run, thrown mid-chase with the creature in view. This
  // is the only way a CHASE reaches STAGGER: break the sightline on the swing
  // frame and the meter drops out of the chase on that same frame instead.
  quiet('swing in the chase', 1, 1.5, { swing: true, seen: true, sightDistance: 1.5 })
  quiet('banished at the end', 120, 60)
  return script
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
const WORLD_SOURCE = readFileSync(new URL('./src/game/world.js', import.meta.url), 'utf8')
const APP_SOURCE = readFileSync(new URL('./src/App.jsx', import.meta.url), 'utf8')

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
  // v1 is still on disk (slice 16 deletes it) and nothing reaches it any more
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
  // and DORMANT only re-emerges when the path layer says so
  const still = beast.creatureStep(faded.creature, DT, { distance: 60, sounds: [] })
  assert.equal(still.to, 'dormant')
  const back = beast.creatureStep(faded.creature, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(back.to, 'stalk', '§8.3: it comes back, at a distance the world chooses')
  assert.equal(back.creature.reemergenceCount, 1)
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
  const observed = new Set([...runCreatureScript(creatureScript()).edges, ...runCreatureScript(sightingScript()).edges])
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
  // caught anybody at all. Six banishes, six re-emergences: one of them after the
  // §8.2 phase-out rather than after a swing. The run ends banished.
  assert.ok(run.history.every((row) => row.captured === false), 'the scripted player was caught')
  assert.equal(run.creature.reemergenceCount, 6, 'six re-emergences for six banishes')
  // §10.2: the finale takes the knowledge away for good
  const finale = at('third portal')
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
  // resolves to the node its wrapped twin does
  for (const spot of REEMERGE_SPOTS) {
    const there = beast.nearestIntersection(spot)
    const wrapped = beast.nearestIntersection({ x: spot.x + hood.WORLD_EXTENT * 3, z: spot.z - hood.WORLD_EXTENT * 5 })
    assert.equal(wrapped, there, 'a point outside the world must resolve like its wrapped twin')
    // and it really is the closest node, measured the short way round
    let best = Infinity
    for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
      const node = hood.streetNodeToWorld(id)
      best = Math.min(best, Math.hypot(beast.wrapDelta(spot.x, node.x), beast.wrapDelta(spot.z, node.z)))
    }
    assert.ok(best <= hood.BLOCK, `snapped ${best.toFixed(1)} m from the nearest node`)
  }
  // a point on an intersection snaps to itself, and a node id stays a node id
  assert.equal(beast.nearestIntersection(hood.intersectionToWorld(3, 5)), hood.streetNodeId(3, 5))
  assert.equal(beast.nearestIntersection(hood.intersectionToWorld(-4, 9)), hood.streetNodeId(3, 2), 'and folds')
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
  assert.equal(beast.searchOrigin({ from: hood.intersectionToWorld(3, 3), seed: 7 }).from, 24, 'a position is accepted too')
  assert.equal(beast.nodeId(4.9), 4, 'and a fractional id is floored, not used as an index')
})

test('re-emergence is never near and never in sight (§8.3)', () => {
  assert.equal(beast.reemergeNode({}), null, 'no player, no placement')
  // §8.3 in two halves, and both are checked against a world that actually has
  // houses in it: the literal fixture pass, not a synthetic occluder
  const world = hood.fixturePass(1337, 1)
  assert.ok(world.fixtures.length > 200, `only ${world.fixtures.length} fixtures to hide behind`)
  const seen = new Set()
  let tightest = Infinity
  for (const seed of [1, 2, 3, 7]) {
    for (let count = 0; count < 8; count += 1) {
      for (const spot of REEMERGE_SPOTS) {
        const player = { ...spot }
        const placement = beast.reemergeNode({
          playerPosition: player,
          occluders: world.fixtures,
          seed,
          reemergenceCount: count,
        })
        const label = `seed ${seed}, re-emergence ${count}, player at ${spot.x},${spot.z}`
        // 1. the distance floor, and it is graph distance from the *player's* node
        assert.ok(placement.hops >= beast.REEMERGE_MIN_GRAPH_DISTANCE, `${label}: only ${placement.hops} hops away`)
        tightest = Math.min(tightest, beast.distanceBetween(player, placement.position))
        // 2. never in line of sight, against the real occluders — and the level
        //    that decided it, so a rule that quietly stopped applying is visible
        assert.equal(placement.level, 'sight', `${label}: hid behind the distance floor instead of a house`)
        assert.equal(placement.sighted, false, `${label}: it re-emerged in a clear line`)
        // and the player cannot see it at any range §11.1 ever offers
        for (let tier = 0; tier < beast.RAMP_TABLE.length; tier += 1) {
          assert.equal(
            beast.canSee(player, { ...placement.position, yaw: 0 }, {
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
  // the axes are additive rather than one blended difficulty, and two and a half
  // re-emergences is worth one tier of §11.1 — which is the whole reason §11.2 can
  // be modelled separately from the progress axis at all
  assert.equal(beast.creatureSpeed(0, 3), beast.RAMP_TABLE[0].speed + 3 * beast.AGGRESSION_SPEED_STEP)
  assert.ok(Math.abs(beast.RAMP_TABLE[1].speed - beast.RAMP_TABLE[0].speed - 2.4 * beast.AGGRESSION_SPEED_STEP) < 1e-9)
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
  let creature = beast.createCreature({ state: 'chase', awareness: 1, banishCount: 2 })
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
  const section13 = ['bell toll', 'ambient drone', 'footstep tick', 'breathing', 'portal hum', 'creature breath', 'portal shutdown']
  const sounds = distinct(audio.AUDIO_ROUTES.map((row) => row.sound))
  assert.deepEqual([...sounds].sort(), [...section13].sort(), '§13\'s seven sounds and the table disagree')

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
    ['stopPortalHums', 'update', 'winChord'],
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
  // the rules it needs are the shared ones, not private copies
  assert.match(AUDIO_SOURCE, /import \{ soundRadius, soundStrength \} from '\.\/creature\.js'/)
  assert.match(AUDIO_SOURCE, /import \{ PORTAL_NOISE_THRESHOLD, BREATH_RECOVERY_THRESHOLD \} from '\.\/rules\.js'/)
  // zero downloaded assets: nothing fetches and nothing loads a file
  const code = stripProse(AUDIO_SOURCE)
  for (const loader of ['fetch(', 'XMLHttpRequest', 'new Audio(', 'new Image(', 'createMediaElement', '.mp3', '.wav', '.ogg', 'decodeAudioData']) {
    assert.equal(code.includes(loader), false, `audio.js reaches for ${loader}`)
  }
  // the whole synthesis surface is WebAudio node factories
  for (const factory of ['createOscillator', 'createGain', 'createBiquadFilter', 'createBufferSource', 'createDynamicsCompressor']) {
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
// PRNG + determinism (the learnable pattern)
// ---------------------------------------------------------------------------

section('PRNG + deterministic layouts')

test('mulberry32 is reproducible and stays inside [0, 1)', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  for (let i = 0; i < 1000; i++) {
    const value = a()
    assert.equal(value, b())
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

test('different seeds explore different streams', () => {
  const seen = new Set()
  for (let seed = 1; seed <= 16; seed++) {
    const rng = mulberry32(seed)
    seen.add(Array.from({ length: 10 }, () => rng().toFixed(6)).join(','))
  }
  assert.equal(seen.size, 16)
})

test('the maze seed IS the loop number', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.equal(maze.seed, loop)
    assert.equal(maze.loop, loop)
  }
})

test('same loop number => byte-identical maze, even after other loops ran', () => {
  const first = JSON.stringify(generateMaze(3))
  for (const loop of VERIFY_LOOPS) generateMaze(loop)
  assert.equal(JSON.stringify(generateMaze(3)), first)
  assert.equal(JSON.stringify(generateMaze(3)), JSON.stringify(generateMaze(3)))
  assert.equal(mazeSignature(generateMaze(6)), mazeSignature(generateMaze(6)))
})

test('loops 1..8 are all different layouts', () => {
  const signatures = new Set(VERIFY_LOOPS.map((loop) => mazeSignature(generateMaze(loop))))
  assert.equal(signatures.size, VERIFY_LOOPS.length)
})

test('PLAN constants are honoured', () => {
  assert.equal(GRID, 15)
  assert.equal(CELL_SIZE, 3.0)
  assert.equal(WALL_HEIGHT, 2.8)
  assert.equal(WALL_THICKNESS, 0.34)
  assert.equal(LOOP_SECONDS, 60)
  assert.equal(ENTRANCE.r, 0)
  assert.equal(ENTRANCE.c, 0)
  assert.equal(CENTER.r, 7)
  assert.equal(CENTER.c, 7)
})

// ---------------------------------------------------------------------------
// connectivity / solvability
// ---------------------------------------------------------------------------

section('Solvability')

test('every cell is reachable from the entrance', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.equal(reachableCells(maze).size, GRID * GRID, `loop ${loop} is not fully connected`)
  }
})

test('entrance -> centre chamber is always solvable', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.ok(hasPath(maze, maze.entrance, maze.center), `loop ${loop}`)
  }
})

test('entrance -> every shrine is always solvable', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    for (const id of SHRINE_IDS) {
      assert.ok(hasPath(maze, maze.entrance, maze.shrineCells[id]), `loop ${loop} shrine ${id}`)
    }
  }
})

test('the deepest cell of a loop is still walkable inside one loop', () => {
  // MAX_ENTRANCE_DEPTH is the target of the carve rule; the carve budget can be
  // exhausted first, so allow a small documented margin.
  for (let loop = 1; loop <= 60; loop++) {
    const maze = generateMaze(loop)
    const distances = distanceMap(maze, maze.entrance)
    let deepest = 0
    for (const value of distances.values()) deepest = Math.max(deepest, value)
    assert.ok(
      deepest <= MAX_ENTRANCE_DEPTH + 8,
      `loop ${loop} is ${deepest} steps deep (limit ${MAX_ENTRANCE_DEPTH + 8})`,
    )
  }
})

test('shrines and the chamber are reachable within one 60s loop at walk speed', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const toCentre = pathLength(maze, maze.entrance, maze.center)
    const walkSeconds = (toCentre * CELL_SIZE) / WALK_SPEED
    assert.ok(walkSeconds <= LOOP_SECONDS, `loop ${loop}: chamber is a ${walkSeconds.toFixed(1)}s walk`)
    for (const id of SHRINE_IDS) {
      const steps = pathLength(maze, maze.entrance, maze.shrineCells[id])
      const seconds = (steps * CELL_SIZE) / WALK_SPEED
      assert.ok(seconds <= LOOP_SECONDS, `loop ${loop} shrine ${id}: ${seconds.toFixed(1)}s walk`)
    }
  }
})

// ---------------------------------------------------------------------------
// extra carves + the centre chamber
// ---------------------------------------------------------------------------

section('Extra carves + chamber')

test('carve count stays inside the documented budget', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.ok(maze.extraCarved >= MIN_EXTRA_CARVES, `loop ${loop}: ${maze.extraCarved} carves`)
    assert.ok(maze.extraCarved <= EXTRA_CARVE_BUDGET, `loop ${loop}: ${maze.extraCarved} carves`)
  }
})

test('the graph has cycles (multiple routes), not a bare tree', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    // spanning tree + the single chamber doorway + the extra carves
    assert.equal(maze.treePassages, GRID * GRID - 2)
    assert.equal(openEdgeCount(maze), maze.treePassages + 1 + maze.extraCarved)
  }
})

test('the chamber has exactly one doorway, and it is centerApproach', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const approach = DIRS.find((dir) => dir.name === maze.centerApproach)
    assert.ok(approach, `loop ${loop}: unknown approach ${maze.centerApproach}`)
    assert.ok(Object.hasOwn(APPROACH_YAW, maze.centerApproach))
    for (const dir of DIRS) {
      const bit = maze.open[CENTER.r][CENTER.c] & dir.bit
      if (dir.name === maze.centerApproach) assert.ok(bit, `loop ${loop}: doorway is walled`)
      else assert.equal(bit, 0, `loop ${loop}: chamber is open to the ${dir.name}`)
    }
  }
})

test('the entrance corner and the centre never move, shrines keep clear', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.deepEqual(maze.entrance, { r: 0, c: 0 })
    assert.deepEqual(maze.center, { r: 7, c: 7 })
    for (const id of SHRINE_IDS) {
      const cell = maze.shrineCells[id]
      assert.notDeepEqual(cell, ENTRANCE)
      assert.notDeepEqual(cell, CENTER)
      assert.ok(chebyshev(cell, ENTRANCE) >= LANDMARK_CLEARANCE, `${id} too close to the entrance`)
      assert.ok(chebyshev(cell, CENTER) >= LANDMARK_CLEARANCE, `${id} too close to the door`)
    }
  }
})

// ---------------------------------------------------------------------------
// shrines: the stable zone rule
// ---------------------------------------------------------------------------

section('Shrine zones')

test('exactly three shrines, one per documented zone', () => {
  for (let loop = 1; loop <= 60; loop++) {
    const maze = generateMaze(loop)
    assert.deepEqual(Object.keys(maze.shrineCells).sort(), [...SHRINE_IDS].sort())
    for (const zone of ZONES) {
      const cell = maze.shrineCells[zone.id]
      assert.ok(
        cell.r >= zone.minR && cell.r <= zone.maxR && cell.c >= zone.minC && cell.c <= zone.maxC,
        `loop ${loop}: shrine ${zone.id} left zone ${zone.name} (${cell.r},${cell.c})`,
      )
    }
  }
})

test('shrine cells are distinct and never on the doorstep', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const keys = SHRINE_IDS.map((id) => cellKey(maze.shrineCells[id].r, maze.shrineCells[id].c))
    assert.equal(new Set(keys).size, SHRINE_IDS.length, `loop ${loop}: shrines overlap`)
    const distances = distanceMap(maze, maze.entrance)
    for (const id of SHRINE_IDS) {
      const cell = maze.shrineCells[id]
      const steps = distances.get(cellKey(cell.r, cell.c))
      assert.ok(steps !== undefined && steps >= MIN_SHRINE_DISTANCE, `loop ${loop} ${id}: ${steps} steps`)
    }
  }
})

test('shrines are drawn from the closest SHRINE_POOL cells of their zone', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const distances = distanceMap(maze, maze.entrance)
    for (const zone of ZONES) {
      const pool = []
      for (let r = zone.minR; r <= zone.maxR; r++) {
        for (let c = zone.minC; c <= zone.maxC; c++) {
          if (r === CENTER.r && c === CENTER.c) continue
          if (chebyshev({ r, c }, ENTRANCE) < LANDMARK_CLEARANCE) continue
          if (chebyshev({ r, c }, CENTER) < LANDMARK_CLEARANCE) continue
          const d = distances.get(cellKey(r, c))
          if (d === undefined || d < MIN_SHRINE_DISTANCE) continue
          pool.push({ r, c, d })
        }
      }
      pool.sort((a, b) => a.d - b.d)
      const limit = pool[Math.min(SHRINE_POOL, pool.length) - 1].d
      const cell = maze.shrineCells[zone.id]
      const steps = distances.get(cellKey(cell.r, cell.c))
      assert.ok(steps <= limit, `loop ${loop} ${zone.id}: ${steps} steps vs pool limit ${limit}`)
    }
  }
})

// ---------------------------------------------------------------------------
// wall geometry fed to the InstancedMeshes + the collision AABBs
// ---------------------------------------------------------------------------

section('Wall segments')

test('wall segments cover every closed edge exactly once', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const seen = new Map()
    for (const wall of maze.walls) {
      const key = `${wall.r},${wall.c},${wall.edge}`
      assert.ok(!seen.has(key), `loop ${loop}: duplicate wall ${key}`)
      seen.set(key, wall)
    }
    let boundary = 0
    let closedInterior = 0
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const { x, z } = cellToWorld(r, c)
        const expectations = [
          ['N', r === 0, r === 0, { cx: x, cz: z - CELL_SIZE / 2 }],
          ['S', r === GRID - 1 || (maze.open[r][c] & S) === 0, r === GRID - 1, { cx: x, cz: z + CELL_SIZE / 2 }],
          ['W', c === 0, c === 0, { cx: x - CELL_SIZE / 2, cz: z }],
          ['E', c === GRID - 1 || (maze.open[r][c] & E) === 0, c === GRID - 1, { cx: x + CELL_SIZE / 2, cz: z }],
        ]
        for (const [edge, present, isBoundary, position] of expectations) {
          const wall = seen.get(`${r},${c},${edge}`)
          if (present) {
            assert.ok(wall, `loop ${loop}: missing ${edge} wall at ${r},${c}`)
            assert.equal(wall.cx, position.cx)
            assert.equal(wall.cz, position.cz)
            if (isBoundary) boundary += 1
            else closedInterior += 1
          } else {
            assert.equal(wall, undefined, `loop ${loop}: phantom ${edge} wall at ${r},${c}`)
          }
        }
      }
    }
    assert.equal(maze.walls.length, boundary + closedInterior)
    assert.equal(boundary, GRID * 4, 'the maze must be sealed on all four sides')
    // every interior edge is either an open passage or exactly one wall segment
    const interiorEdges = 2 * GRID * (GRID - 1)
    assert.equal(closedInterior, interiorEdges - openEdgeCount(maze))
  }
})

test('wall AABBs use the documented dimensions and stay inside the footprint', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const limit = (GRID * CELL_SIZE) / 2 + WALL_THICKNESS
    for (const wall of maze.walls) {
      const alongX = wall.axis === 'x'
      assert.equal(wall.hx, alongX ? (CELL_SIZE + WALL_THICKNESS) / 2 : WALL_THICKNESS / 2)
      assert.equal(wall.hz, alongX ? WALL_THICKNESS / 2 : (CELL_SIZE + WALL_THICKNESS) / 2)
      assert.ok(Math.abs(wall.cx) <= limit && Math.abs(wall.cz) <= limit)
    }
  }
})

test('open passages are symmetric between neighbours', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        for (const dir of DIRS) {
          const nr = r + dir.dr
          const nc = c + dir.dc
          if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue
          const here = (maze.open[r][c] & dir.bit) !== 0
          const there = (maze.open[nr][nc] & dir.opposite) !== 0
          assert.equal(here, there, `loop ${loop}: ${r},${c} ${dir.name} disagrees`)
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// the loop rules: timer, candles, door, bell timeline
// ---------------------------------------------------------------------------

section('Loop rules (the win condition)')

test('the timer counts down and clamps at zero', () => {
  assert.equal(advanceTimer(LOOP_SECONDS, 1.5), LOOP_SECONDS - 1.5)
  assert.equal(advanceTimer(0.4, 1), 0)
  assert.equal(advanceTimer(10, 10), 0)
})

test('candle state is immutable, idempotent and persistent', () => {
  const start = createInitialState(1)
  assert.equal(candlesLit(start.candles), 0)
  const one = applyLightCandle(start, 'A')
  assert.equal(one.candles.A, true)
  assert.equal(start.candles.A, false, 'applyLightCandle must not mutate its input')
  assert.equal(applyLightCandle(one, 'A'), one, 'lighting a lit candle is a no-op')
  assert.equal(candlesLit(applyLightCandle(one, 'B').candles), 2)
})

test('the door opens on the loop AFTER the third candle, and stays open', () => {
  let state = createInitialState(1)
  state = applyLightCandle(state, 'A')
  state = applyLightCandle(state, 'B')
  assert.equal(shouldDoorOpenAtLoopStart(state.candles), false)
  assert.equal(allCandlesLit(state.candles), false)

  state = applyLightCandle(state, 'C')
  assert.equal(allCandlesLit(state.candles), true)
  // lighting the last candle mid-loop does NOT open the door in that loop
  assert.equal(state.doorOpen, false)

  state = beginLoop(state, 2)
  assert.equal(state.loop, 2)
  assert.equal(state.doorOpen, true, 'the door must stand open from loop 2 onward')
  assert.equal(state.timeLeft, LOOP_SECONDS)

  state = beginLoop(state, 3)
  assert.equal(state.doorOpen, true)
  assert.equal(candlesLit(state.candles), 3, 'shrines stay lit across resets')

  state = beginLoop(state, 4)
  assert.equal(state.doorOpen, true)
})

test('phases are the documented four', () => {
  assert.deepEqual(Object.values(PHASE).sort(), ['playing', 'reset', 'start', 'won'].sort())
  assert.equal(createInitialState().phase, PHASE.PLAYING)
  assert.equal(createInitialState(1, PHASE.START).phase, PHASE.START)
  assert.equal(createInitialState(1, PHASE.START).fade, 1, 'the start overlay sits behind black')
  const fresh = restartState(1)
  assert.equal(candlesLit(fresh.candles), 0)
  assert.equal(fresh.doorOpen, false)
  assert.equal(fresh.loop, 1)
})

test('beginLoop can hold the RESET phase (the swap happens behind black)', () => {
  const state = beginLoop(createInitialState(1), 2, PHASE.RESET)
  assert.equal(state.loop, 2)
  assert.equal(state.phase, PHASE.RESET)
})

test('the bell timeline fades to black, swaps, then clears', () => {
  assert.equal(resetFade(0), 0)
  assert.equal(resetFade(RESET_SWAP_AT), 1, 'full black at the moment of the swap')
  assert.ok(resetFade(RESET_SWAP_AT * 0.5) > 0)
  assert.ok(resetFade(RESET_SWAP_AT * 0.5) < 1)
  assert.equal(resetFade(RESET_TIMELINE.total), 0)
  assert.equal(resetFade(RESET_TIMELINE.total + 1), 0)
  assert.equal(resetFade(-1), 0)
  const rising = [...Array(6)].map((_, i) => resetFade((RESET_SWAP_AT * i) / 6))
  for (let i = 1; i < rising.length; i++) assert.ok(rising[i] >= rising[i - 1])
  const falling = [0.1, 0.3, 0.6, 0.9].map((k) => resetFade(RESET_SWAP_AT + RESET_TIMELINE.fadeIn * k))
  for (let i = 1; i < falling.length; i++) assert.ok(falling[i] <= falling[i - 1])
})

test('walls rise with a stagger and are all the way up by the end', () => {
  assert.equal(wallRiseProgress(RESET_SWAP_AT, 0), 0, 'nothing is up at the swap')
  assert.equal(wallRiseProgress(RESET_SWAP_AT - 0.2, 0.3), 0)
  assert.equal(wallRiseProgress(RESET_SWAP_AT + 5, 0.5), 1)
  const mid = wallRiseProgress(RESET_SWAP_AT + 0.5, 0)
  const late = wallRiseProgress(RESET_SWAP_AT + 0.5, 0.4)
  assert.ok(mid > late, 'walls near the entrance rise first')
  assert.equal(wallRiseDelay(0, 40), 0)
  assert.equal(wallRiseDelay(40, 40), 0.5)
  assert.ok(wallRiseDelay(20, 40) > 0 && wallRiseDelay(20, 40) < 0.5)
  assert.equal(wallRiseDelay(10, 0), 0)
})

test('the reset window is long enough for all three tolls', () => {
  assert.ok(RESET_TIMELINE.total > (RESET_TIMELINE.tolls - 1) * RESET_TIMELINE.tollSpacing)
  assert.ok(RESET_SWAP_AT > 0 && RESET_SWAP_AT < RESET_TIMELINE.total)
})

// ---------------------------------------------------------------------------
// the mutable store React subscribes to
// ---------------------------------------------------------------------------

section('Store')

test('the store only notifies when a value actually changes', () => {
  const store = createStore(createInitialState(1, PHASE.PLAYING))
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  store.set({ phase: PHASE.PLAYING })
  assert.equal(notifications, 0, 'setting the same phase must not re-render React')
  store.set({ loop: 2 })
  assert.equal(notifications, 1)
  store.set({ timeLeft: 59.5, loop: 2 })
  assert.equal(notifications, 2)
  assert.equal(store.listenerCount(), 1)
  unsubscribe()
  assert.equal(store.listenerCount(), 0)
  store.set({ loop: 3 })
  assert.equal(notifications, 2, 'unsubscribed listeners must not fire')
  assert.equal(store.get().loop, 3)
})

test('store.update() runs the pure reducers', () => {
  const store = createStore(createInitialState(1))
  store.update((state) => applyLightCandle(state, 'B'))
  assert.equal(store.get().candles.B, true)
  store.update((state) => beginLoop(state, 2))
  assert.equal(store.get().loop, 2)
  assert.equal(store.get().doorOpen, false, 'two candles is not enough')
  store.update((state) => applyLightCandle(state, 'A'))
  store.update((state) => applyLightCandle(state, 'C'))
  store.update((state) => beginLoop(state, 3))
  assert.equal(store.get().doorOpen, true)
})

test('loop.js no longer owns a HUD projection, and the v2 one lives in src/ui', () => {
  // slice 12 moved the projection into `src/ui/hud.js` and deleted the v1 one
  // from here, so this module no longer exports a `hudSnapshot` at all. The store
  // and the reducers around it are v1's and stay until slice 16 deletes them.
  const loopSource = readFileSync(new URL('./src/game/loop.js', import.meta.url), 'utf8')
  const hudSource = readFileSync(new URL('./src/ui/hud.js', import.meta.url), 'utf8')
  assert.equal(/export function hudSnapshot/.test(loopSource), false, 'loop.js grew a second HUD projection')
  assert.match(hudSource, /export function hudSnapshot/)
})

// ---------------------------------------------------------------------------
// end-to-end: a scripted run that wins (headless proof the game is beatable)
// ---------------------------------------------------------------------------

section('Scripted run')

test('one candle per loop, then the door opens and the chamber is a walk away', () => {
  let state = createInitialState(1)

  // loop 1: light shrine A, the bell rings
  state = applyLightCandle(state, 'A')
  assert.equal(state.doorOpen, false)
  state = beginLoop(state, 2)
  assert.equal(state.doorOpen, false, 'one candle is not enough')
  assert.equal(state.loop, 2)
  assert.equal(state.timeLeft, LOOP_SECONDS, 'the timer refills every loop')
  assert.equal(state.candles.A, true, 'the first shrine stays lit')

  // loop 2: shrine B
  state = applyLightCandle(state, 'B')
  state = beginLoop(state, 3)
  assert.equal(state.doorOpen, false, 'two candles are not enough')
  assert.equal(candlesLit(state.candles), 2)

  // loop 3: shrine C — the third and last one
  state = applyLightCandle(state, 'C')
  assert.equal(allCandlesLit(state.candles), true)
  state = beginLoop(state, 4)
  assert.equal(state.loop, 4)
  assert.equal(state.doorOpen, true, 'the door stands open on the loop after the third candle')

  // loop 4: walk to the chamber. Its only doorway is centerApproach, and the
  // closed-door blocking collider is gone, so the centre is reachable.
  const maze = generateMaze(state.loop)
  const steps = pathLength(maze, maze.entrance, maze.center)
  const seconds = (steps * CELL_SIZE) / WALK_SPEED
  assert.ok(steps > 0, 'the chamber must be reachable')
  assert.ok(seconds <= LOOP_SECONDS, `the walk takes ${seconds.toFixed(1)}s`)

  // three of the chamber's four edges are real walls; the fourth is the doorway
  const walled = DIRS.filter((dir) => hasWall(maze, CENTER.r, CENTER.c, dir))
  assert.equal(walled.length, 3, 'exactly three of the chamber edges are walls')
  assert.equal(walled.find((dir) => dir.name === maze.centerApproach), undefined)

  // and the win trigger itself: a pure rule — you must be inside the chamber
  const centre = cellToWorld(CENTER.r, CENTER.c)
  assert.ok(DOOR_WIN_RADIUS < CELL_SIZE / 2, 'the win radius must sit inside the chamber')
  assert.ok(isInsideChamber({ x: centre.x, z: centre.z }, centre))
  assert.ok(!isInsideChamber({ x: centre.x + CELL_SIZE, z: centre.z }, centre))
  assert.ok(!isInsideChamber(null, centre))
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

test('the projection is total over a v1-shaped store', () => {
  // the store is still built from v1's `createInitialState` until slice 16, so
  // every v2 field arrives as `undefined` on the first frame and a projection
  // that assumed otherwise would take the title screen down with it
  const painted = hud.hudSnapshot(createInitialState(1, PHASE.START))
  assert.equal(painted.phase, PHASE.START)
  assert.equal(painted.loop, 1)
  assert.equal(painted.prompt, null)
  assert.equal(painted.reducedMotion, false)
  assert.deepEqual([...hud.HUD_FIELDS].sort(), Object.keys(painted).sort())
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
  assert.deepEqual([...new Set(calls)].sort(), ['stopPortalHums', 'update', 'winChord'])
  assert.equal(calls.filter((name) => name === 'update').length, 1)
  for (const field of audio.AUDIO_FRAME_FIELDS) {
    assert.ok(new RegExp(`\\b${field}:`).test(WORLD_SOURCE), `the world never fills in ${field}`)
  }
})

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
