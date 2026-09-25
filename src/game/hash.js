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
 * NOTE: `maze.js` still carries its own copy of `mulberry32` for v1. That
 * duplication is deliberate and temporary — slice 16 deletes `maze.js`, and this
 * module is the canonical one. `verify.mjs` imports the two under distinct names
 * so the duplication stays visible rather than silent.
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
