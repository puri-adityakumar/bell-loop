/**
 * hash.js — the random-access PRNG foundation for THE LONG QUIET (v2, slice 01).
 *
 * WHY THIS EXISTS
 * ---------------
 * v1 seeds a *sequential* stream per loop: `mulberry32(loopNumber)`, with values
 * pulled in order. That cannot generate a chunk-addressed world, because chunk
 * (cx, cz) has to be generatable WITHOUT generating its neighbours first.
 * Sequential streams structurally cannot do random access — this is the blocker
 * that made deferred streaming a rewrite, and it is why it is settled here
 * instead of later (GAMEDESIGN.md §3.2).
 *
 * So v2 derives an INDEPENDENT stream per chunk from a 32-bit avalanche mix of
 * that chunk's own coordinates:
 *
 *     hash32(seed, cx, cz)   ->  32-bit mix
 *     streamAt(seed, cx, cz) ->  mulberry32(mix)  ->  a private stream
 *
 * Nothing is shared between chunks, so generation order cannot affect content.
 * `verify.mjs` asserts exactly that by generating every chunk in a shuffled
 * order and comparing signatures.
 *
 * Pure: no DOM, no Three.js, no globals, no clock. `verify.mjs` imports this
 * file directly in node.
 *
 * NOTE: `maze.js` carried its own copy of `mulberry32` for v1, and slice 16
 * deleted that file. This module is the only one left, and `verify.mjs` no longer
 * has to import two of anything to prove it.
 */

// ---------------------------------------------------------------------------
// 32-bit avalanche mix
// ---------------------------------------------------------------------------

/**
 * fmix32 — the murmur3 finalizer: xor-shifts and odd multiplies arranged so
 * every input bit reaches every output bit.
 *
 * One round is deliberately not enough. `hash32` folds two coordinates in
 * sequence, so a single round would leave the second fold correlated with the
 * first; running it twice is what makes `cx` and `cz` interchangeable and makes
 * neighbouring chunk coordinates produce unrelated output.
 *
 * @param {number} h any integer; truncated to 32 bits
 * @returns {number} an unsigned 32-bit integer
 */
function fmix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * DEFAULT_SEED — the seed a run gets when nobody names one.
 *
 * BEFORE: the literal `1337` written out in `world.js`. AFTER: this constant, read
 * by `world.js` AND by `audio.js`.
 *
 * Pass 13 is why it moved. The world bed is *seeded* — a run's distant facility
 * noises, its noise floor and its ambience schedule are a function of the run's
 * seed and of nothing else — and the audio cannot invent a seed the world did not
 * choose, so the two had to stop being two independent defaults that happen to
 * agree. One named constant is that agreement, and `verify.mjs` asserts both
 * modules read *this* name rather than a literal.
 *
 * @type {number}
 */
export const DEFAULT_SEED = 1337

/**
 * hash32 — mix a base seed and a chunk coordinate into one 32-bit seed.
 *
 * Every chunk gets its own seed, so two chunks never share a stream even when
 * they are adjacent. Adjacency is the failure mode that matters here: a weak
 * mix leaves neighbouring chunks a couple of bits apart, which shows up in game
 * as visibly repeating streets down every row. `verify.mjs` asserts the mean
 * Hamming distance between adjacent `cx` values sits near 16 of 32 bits.
 *
 * Coordinates are truncated to 32 bits, so values congruent modulo 2**32 alias
 * (`-1` and `4294967295` are the same input). This is by design and irrelevant
 * in practice: chunk coordinates are small, and the wrap in §3.3 folds them into
 * range before they ever reach here.
 *
 * WHY ADDITION, NOT XOR — the seed and each coordinate are combined with `+`,
 * not `^`. XOR looks like the obvious mixer and it is wrong here: it has trivial
 * collisions across argument pairs, because `a ^ x` is symmetric in the low bits
 * of `a` and `x`. Folding with XOR made `hash32(0, -3, cz)` and
 * `hash32(1, -4, cz)` identical for every `cz` — `0 ^ -3` and `1 ^ -4` are both
 * `4294967293` — so two different chunks silently shared a stream. `verify.mjs`
 * caught it. Addition has no such symmetry: `seed + cx * K` can only collide when
 * the seed difference exactly cancels the coordinate difference times `K`, which
 * the odd multipliers make impossible for distinct small coordinates.
 *
 * @param {number} seed the run's base seed
 * @param {number} cx chunk x
 * @param {number} cz chunk z
 * @returns {number} an unsigned 32-bit integer
 */
export function hash32(seed, cx, cz) {
  let h = seed >>> 0
  h = fmix32((h + Math.imul(cx >>> 0, 0x9e3779b1)) | 0)
  h = fmix32((h + Math.imul(cz >>> 0, 0x85ebca77)) | 0)
  return h >>> 0
}

/**
 * mulberry32 — tiny, fast, well-distributed 32-bit PRNG.
 *
 * Identical to v1's copy, promoted here as the canonical one. Each chunk gets
 * its own generator instance, so two chunks can never interfere.
 *
 * @param {number} seed
 * @returns {() => number} generator returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * streamAt — the random-access entry point: a fresh private stream for one
 * chunk. This is the only function the rest of v2 should need for chunk
 * randomness; `hash32` and `mulberry32` are exposed for verification and for the
 * fixture key in §3.6, which mixes a loop salt into the same mix.
 *
 * @param {number} seed
 * @param {number} cx
 * @param {number} cz
 * @returns {() => number} generator returning floats in [0, 1)
 */
export function streamAt(seed, cx, cz) {
  return mulberry32(hash32(seed, cx, cz))
}

/**
 * `flickerAt` — ONE TICK of a failing fluorescent ballast, as a pure function.
 *
 * ITERATION 2, PASS 7. The vending machine's bad tube is the only flicker in the
 * world that is not a sum of sines, and this function is why it can be checked at
 * all: `streamAt` returns a GENERATOR, so it cannot be re-read at an arbitrary
 * point, and a flicker asked for the same tick twice in one frame — once to build
 * and once to measure — has to give the same answer both times. `hash32` is
 * stateless and can, so the level is a pure function of `(seed, tick)`.
 *
 * FOUR PROPERTIES, and each is a decision rather than a style:
 *
 *  - **Stepped.** The output is a function of the TICK INDEX and not of a
 *    continuous clock, so a dropout is an EVENT the renderer cannot interpolate
 *    away. `verify.mjs` drives the tick index over a thousand steps and requires
 *    that the level actually changes, which a smooth curve also does — the test
 *    that matters is the one that requires the *same* tick twice to agree.
 *  - **Hashed, not summed.** Nothing trigonometric happens here, so the bad tube
 *    shares no period with the sodium's three sines. A player who watched the
 *    lamps for a minute can predict a sine; nobody can predict an avalanche.
 *  - **Seeded, and only seeded.** No `Math.random`, no `Date`, no clock read, and
 *    therefore D10 — "any technique whose output depends on iteration order or
 *    unseeded randomness is out" — holds by construction rather than by review.
 *  - **Bounded.** The result is always in `[floor, 1]`, so a caller can multiply a
 *    colour by it and never produce a negative channel.
 *
 * THE DEFAULT FLOOR IS 0.18, not 0, and that is the whole difference between a
 * FAILING machine and a DEAD one. A tube that goes fully out is a machine that has
 * finished; a tube that drops to an ember and comes back is a machine that might
 * work, and that is the one worth having on a street where nothing else moves. The
 * floor is a parameter rather than a constant because a second caller with a
 * different ballast should not have to edit this function.
 *
 * @param {number} seed the documented seed for this fitting
 * @param {number} tick the tick index, i.e. `floor(t * hz)` at the caller
 * @param {number} salt the region of the mix that owns the DROPOUT pattern
 * @param {object} [options]
 * @param {number} [options.phaseSalt] the region that owns the within-band
 *   wobble; derived from `salt` by default, and passed explicitly by a caller
 *   that wants the two provably independent
 * @param {number} [options.floor] the level a dropout falls to; 0.18 by default
 * @param {number} [options.depth] how far the bright ticks wander below 1
 * @param {number} [options.oneIn] one tick in this many is a dropout
 * @returns {number} a multiplier in `[floor, 1]`
 */
export function flickerAt(seed, tick, salt, options = {}) {
  const phaseSalt = options.phaseSalt ?? ((salt ^ 0x9e3779b9) >>> 0)
  const floor = options.floor ?? 0.18
  const depth = options.depth ?? 0.42
  const oneIn = options.oneIn ?? 8
  // The dropout is tested FIRST and returns outright, so a dropout is exactly the
  // floor rather than a value that happens to be near it — which is what makes
  // "one tick in eight is dark" a fact about the function rather than a tendency.
  if (hash32(seed, tick, salt) % oneIn === 0) return floor
  // Two DIFFERENT regions of the same mix, so the dropout pattern and the wobble
  // cannot correlate: a dropout never lands on the brightest tick, which is what
  // stops the band looking like a sawtooth with holes in it.
  const wobble = hash32(seed, tick, phaseSalt) / 4294967296
  return Math.max(floor, 1 - depth * wobble)
}
