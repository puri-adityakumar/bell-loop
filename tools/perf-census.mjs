#!/usr/bin/env node
/**
 * perf-census.mjs — the scene graph, counted, with no browser.
 *
 *   npm run capture -- --budget     # the LIVE half: renderer.info, frame times
 *   node tools/perf-census.mjs      # this half: the graph, from a bare Scene
 *
 * WHY A SECOND INSTRUMENT WHEN `--budget` ALREADY COUNTS THINGS
 * ------------------------------------------------------------
 * Because this one runs at ANY COMMIT and the other one cannot.
 *
 * `tools/capture.mjs --budget` needs a Vite dev server, a headless Chrome and a
 * page that builds the real `LongQuietGame` — which is exactly what makes it
 * trustworthy (it reads `renderer.info.render.calls` off a frame a driver
 * actually drew) and exactly what stops it being run against a checkout from
 * last month. The other question pass 17 asks is "what did the fidelity passes
 * cost relative to where we started", and that has only one answer, which is to
 * point the same census at the old tree:
 *
 *     git worktree add /tmp/bell-base bede4ed
 *     ln -s "$PWD/node_modules" /tmp/bell-base/node_modules
 *     node tools/perf-census.mjs --tree /tmp/bell-base
 *
 * `bede4ed` is `feat(v2): slice 16` — the checkpoint iteration 2 branched from,
 * before any of passes 5-12 added geometry. Both numbers come out of this file,
 * so they are comparable by construction rather than by two people remembering
 * to count the same things.
 *
 * WHAT IT IS NOT
 * --------------
 * NOT a draw-call count. Without a WebGL context there is no driver, and
 * `renderer.info` is the only honest draw-call number. What this reports is the
 * scene GRAPH: objects, instanced pools, instance counts, resident triangles,
 * distinct geometries, materials, and the culling exemption. `InstancedMesh` is
 * one object and one draw call for any instance count, so a graph census
 * OVERSTATES the calls and UNDERSTATES nothing — which is why `--budget` is the
 * gate and this is the comparison. The two agree on the shape and the budget is
 * judged on the other one.
 *
 * WHY IT USES A BARE `THREE.Scene` AND THE REAL VIEWS
 * ---------------------------------------------------
 * Because the views are the thing being measured. `StreetView`, `SkyView` and
 * `CreatureView` all take a scene and a small options bag and build into it;
 * none of them reads `document`, and `neighborhood.js`/`hash.js` are pure. So
 * the world is constructed exactly as `world.js` constructs it — same seed, same
 * loop, same three view classes — and the only things missing are the renderer
 * and the nine lights, and the lights are `world.js`'s rather than the views'.
 *
 * @param {string[]} argv `--tree <path>` to census another checkout, `--seed <n>`
 */
import * as THREE from 'three'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The seed the gallery and the budget both use, so the three agree. */
const DEFAULT_SEED = 1337

function parseArgs(argv) {
  const options = { tree: null, seed: DEFAULT_SEED }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tree') options.tree = argv[(index += 1)]
    else if (arg.startsWith('--tree=')) options.tree = arg.slice('--tree='.length)
    else if (arg === '--seed') options.seed = Number(argv[(index += 1)])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * census — the whole of the traversal, once, in the shape both callers want.
 *
 * Written out rather than imported from the page, on purpose: this file has to
 * run inside a checkout that predates `tools/perf-census.mjs` existing, so
 * anything it shares with `capture/main.jsx` has to be a copy. Twelve lines of
 * duplication is the price of being able to point this at `bede4ed`.
 *
 * @param {THREE.Object3D} root
 * @returns {object} counts, plus `heaviest` for the triangle breakdown
 */
function census(root) {
  const kinds = { instanced: 0, mesh: 0, points: 0, line: 0, sprite: 0, light: 0 }
  let visible = 0
  let unculled = 0
  let instances = 0
  let triangles = 0
  const geometries = new Set()
  const materials = new Set()
  const byName = new Map()
  root.updateMatrixWorld(true)
  root.traverse((object) => {
    if (object.isInstancedMesh) kinds.instanced += 1
    else if (object.isMesh) kinds.mesh += 1
    else if (object.isPoints) kinds.points += 1
    else if (object.isLine) kinds.line += 1
    else if (object.isSprite) kinds.sprite += 1
    else if (object.isLight) kinds.light += 1
    else return
    if (object.visible) visible += 1
    if (object.frustumCulled === false) unculled += 1
    if (!object.geometry) return
    const geometry = object.geometry
    geometries.add(geometry.uuid)
    const material = object.material
    if (Array.isArray(material)) material.forEach((entry) => materials.add(entry.uuid))
    else if (material) materials.add(material.uuid)
    const per = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
    const count = object.isInstancedMesh ? object.count : 1
    instances += count
    triangles += per * count
    const name = object.name || object.type
    const row = byName.get(name) ?? { name, objects: 0, instances: 0, triangles: 0, unculled: false }
    row.objects += 1
    row.instances += count
    row.triangles += per * count
    row.unculled = row.unculled || object.frustumCulled === false
    byName.set(name, row)
  })
  return {
    kinds,
    objects: Object.values(kinds).reduce((sum, n) => sum + n, 0),
    visible,
    unculled,
    instances,
    triangles: Math.round(triangles),
    geometries: geometries.size,
    materials: materials.size,
    heaviest: [...byName.values()]
      .map((row) => ({ ...row, triangles: Math.round(row.triangles) }))
      .sort((a, b) => b.triangles - a.triangles)
      .slice(0, 12),
  }
}


/**
 * A canvas that draws nothing.
 *
 * `StreetView` builds six `CanvasTexture`s from 2d contexts at construction —
 * the asphalt, the concrete, the poster sheets — and a census cares about NONE
 * of them: it is counting objects, not pixels. What it does need is for those
 * six constructions not to throw.
 *
 * So this is a `Proxy` that answers every method call with a no-op and every
 * property read with `0`, rather than a hand-written stub of the forty-odd
 * `CanvasRenderingContext2D` members the texture code touches between them. A
 * hand-written stub is a second list of what `streetView.js` happens to call
 * today, and it would fail on the next texture rather than on the next version
 * of node — which is the failure mode `verify-world.mjs`'s own `makeContext2d`
 * was written to avoid, and the reason this one is a proxy instead.
 *
 * `getImageData` is the one method that has to RETURN something, because its
 * result is read; a 1x1 transparent pixel is the truthful answer for a canvas
 * that painted nothing.
 */
function makeBlankCanvas() {
  const context = new Proxy(
    {
      canvas: null,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
      // `createImageData` is the one that MATTERS and it is not `getImageData`:
      // `makeSurfaceTexture` in `streetView.js` allocates the buffer itself and
      // writes every pixel of a 128x128 noise field into it. Returning a real
      // (transparent) buffer of the requested size is the truthful answer for a
      // canvas that will not paint, and it is what lets the six surface
      // textures build without this stub knowing a single colour value.
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
      measureText: () => ({ width: 0 }),
    },
    {
      get: (target, key) => (key in target ? target[key] : () => undefined),
    },
  )
  const canvas = {
    nodeName: 'CANVAS',
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    dataset: {},
    getContext: (type) => {
      if (type !== '2d') throw new Error(`perf-census's canvas stub only answers '2d' (asked for ${type})`)
      context.canvas = canvas
      return context
    },
    toDataURL: () => 'data:image/png;base64,perf-census',
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }),
  }
  return canvas
}

/**
 * The three globals `three` and the views read, and nothing else.
 *
 * `verify-world.mjs` stubs a much larger surface because it drives the real
 * `LongQuietGame` — a renderer, a player, pointer lock, a media query. A census
 * builds three VIEWS and never starts a game, so the whole requirement is
 * `document.createElement('canvas')` returning something drawable-on, plus
 * `window.devicePixelRatio` for anything that asks. Declaring the smaller set is
 * the honest thing: if a future `StreetView` reaches for a fourth global, this
 * file fails with a `ReferenceError` naming it, and that is a better outcome than
 * a stub quietly absorbing it.
 */
function installStubs() {
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 }
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`perf-census's document stub only creates canvases (asked for ${tag})`)
      return makeBlankCanvas()
    },
  }
}

/**
 * loadViews — the three view classes, or `null` for one the tree does not have.
 *
 * The `null` is not defensive coding, it is the finding. `bede4ed` (slice 16)
 * has no `src/game/skyView.js` at all: the sky arrived in iteration 2's pass 9,
 * so at the baseline there is nothing to count and a loader that insisted on
 * finding one would have reported "the baseline could not be measured" for a
 * reason that has nothing to do with the budget. The row is printed as `absent`
 * and the number it would have held is genuinely not measurable in that tree,
 * which is a fact about the world and not a gap in the instrument.
 *
 * @param {string} tree absolute path to a checkout
 * @returns {Promise<{street: object, sky: object|null, creature: object|null, absent: string[]}>}
 */
async function loadViews(tree) {
  const absent = []
  const load = async (relative) => {
    try {
      return await import(pathToFileURL(path.join(tree, relative)).href)
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(relative)) {
        absent.push(relative)
        return null
      }
      throw error
    }
  }
  const [street, sky, creature] = await Promise.all([
    load('src/game/streetView.js'),
    load('src/game/skyView.js'),
    load('src/game/creatureView.js'),
  ])
  if (!street) throw new Error(`${tree} has no src/game/streetView.js, so it is not a bell-loop checkout`)
  return { street, sky, creature, absent }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const tree = options.tree
    ? path.resolve(options.tree)
    : new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  console.log(`perf-census: ${tree} (seed ${options.seed})`)
  installStubs()
  const { street, sky, creature, absent } = await loadViews(tree)
  const scene = new THREE.Scene()
  // The far plane and the FOV are `world.js`'s own numbers. The camera exists
  // only because `SkyView`'s root rides it; nothing here is projected, and the
  // census is a property of the graph rather than of where the camera stands.
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.05, 260)
  // THE SAME CONSTRUCTION `world.js` PERFORMS, in the same order, minus the
  // renderer. `StreetView` builds the fixtures and the colliders the other two
  // resolve against, so the order is load-bearing and not decorative.
  const streetView = new street.StreetView(scene, { seed: options.seed })
  const skyView = sky ? new sky.SkyView(scene, camera, { seed: options.seed }) : null
  const creatureView = creature ? new creature.CreatureView(scene, { seed: options.seed }) : null
  const whole = census(scene)
  const byView = {
    street: census(streetView.group),
    sky: skyView ? census(skyView.root) : null,
    creature: creatureView ? census(creatureView.root) : null,
  }
  console.log(
    `  scene      ${whole.objects} objects (${whole.kinds.instanced} instanced, ${whole.kinds.mesh} mesh, ` +
      `${whole.kinds.points} points, ${whole.kinds.line} line, ${whole.kinds.light} lights)`,
  )
  console.log(
    `            ${whole.instances} instances, ${whole.triangles} triangles, ${whole.geometries} geometries, ` +
      `${whole.materials} materials, ${whole.unculled} culling-exempt`,
  )
  for (const [name, part] of Object.entries(byView)) {
    if (!part) {
      console.log(`  ${name.padEnd(10)} ABSENT from this tree — the view class does not exist here`)
      continue
    }
    console.log(
      `  ${name.padEnd(10)} ${String(part.objects).padStart(4)} objects ` +
        `(${String(part.kinds.instanced).padStart(3)} instanced, ${String(part.kinds.mesh).padStart(3)} mesh, ` +
        `${String(part.kinds.points).padStart(2)} points), ${String(part.instances).padStart(6)} instances, ` +
        `${String(part.triangles).padStart(7)} triangles, ${String(part.geometries).padStart(3)} geometries, ` +
        `${String(part.unculled).padStart(4)} exempt`,
    )
  }
  console.log('  heaviest pools')
  for (const row of whole.heaviest) {
    console.log(
      `    ${String(row.triangles).padStart(7)}  ${row.name.padEnd(28)} ` +
        `${String(row.instances).padStart(6)} instance(s) over ${row.objects} object(s)` +
        `${row.unculled ? ', culling-exempt' : ''}`,
    )
  }
  // Teardown, because a census that leaked a `Float32Array` per pool into the
  // next one would be a census of a process rather than of a scene.
  if (creatureView) creatureView.dispose()
  if (skyView) skyView.dispose()
  streetView.dispose()
  if (absent.length > 0) {
    console.log(`  note: absent from this tree — ${absent.join(', ')}`)
  }
}

main().catch((error) => {
  console.error(`perf-census: ${error.stack ?? error}`)
  process.exitCode = 1
})
