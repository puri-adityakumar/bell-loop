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
  hudSnapshot,
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

test('hudSnapshot exposes exactly what the HUD paints', () => {
  const state = createInitialState(4)
  state.timeLeft = LOOP_SECONDS / 2
  state.candles.A = true
  const hud = hudSnapshot(state)
  assert.equal(hud.loop, 4)
  assert.equal(hud.timeFraction, 0.5)
  assert.equal(hud.candlesLit, 1)
  assert.equal(hud.candles.A, true)
  assert.equal(hud.fade, 0)
  assert.equal(hud.prompt, null)
  assert.equal(hudSnapshot(createInitialState(2)).timeFraction, 1)
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
