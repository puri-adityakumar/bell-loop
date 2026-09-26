/**
 * world.js — the scene, the lights, the fog, the phase machine and the whole v2
 * simulation loop.
 *
 * THIS IS THE SWAP (slice 09)
 * ---------------------------
 * v1's file drew a maze: walls that rose out of the floor, three shrines with
 * candles, a double door, and a 60-second bell. Every one of those is gone. What
 * is left is the half of the game that is not the street — §15.1's split, with
 * the street itself in `streetView.js` and (from slice 10) the creature in
 * `creatureView.js`.
 *
 * The world owns the clock, the state object and the verbs. The rules are not in
 * this file and must not be: `rules.js` owns the portal hold, the breath, the
 * capture table and the win test, `creature.js` owns awareness and the state
 * machine, and `neighborhood.js` owns the geometry and the wrap. This file's job
 * is to hand them a frame and then draw the answer.
 *
 * WHY THE DUSK IS HERE AND NOT IN THE RULES
 * ------------------------------------------
 * §3.7 makes dusk a function of portals shut and never of captures, because
 * keying darkness to the loop would make dying cost you visibility — a death
 * spiral in a game you have already died in. The *number* is
 * `rules.fogDensityForDusk` and the gate asserts it; the *colours* are §12.3's
 * palette and they are art, so they interpolate here, in one place, from three
 * stops.
 *
 * WHAT IS STILL IMPORTED FROM v1
 * -----------------------------
 * Nothing. `PHASE` and `createStore` were the last two names v1's `loop.js` still
 * owned, and slice 16 deleted the file; they now live in `src/game/store.js`, a
 * module with no rule in it at all. §10.5 is explicit that `PHASE` keeps its
 * meaning — start / playing / reset / won — and that the finale is a flag rather
 * than a fifth phase, so re-typing four string constants here to make a module look
 * clean would have been the worst of both worlds: a second definition of the phase
 * machine, and an `App.jsx` diff larger than the one line the design promised.
 * `LOOP_SECONDS` was the third import until slice 12, and it existed only to pin
 * the v1 countdown full, because v2 has no countdown.
 */
import * as THREE from 'three'
import { createStore, PHASE } from './store.js'
import { PlayerController } from './player.js'
import { PALETTE, StreetView } from './streetView.js'
import { CreatureView } from './creatureView.js'
import * as beast from './creature.js'
import * as rules from './rules.js'
import { streamAt } from './hash.js'
import * as hood from './neighborhood.js'
import { SPAWN, placeObjectives, streetNodeToWorld } from './neighborhood.js'
// §14.1/§14.2/§14.3. The one place a game module reaches into `src/ui/`, and it
// reaches for the *quantizer* and the rate limiter rather than for the
// projection: the simulation writes numbers into the store, and `hud.js` is
// what decides how finely they are written. Keeping the grid in the view module
// is what stops the world and the HUD from disagreeing about how often React is
// allowed to re-render, and there is no cycle because `hud.js` imports only
// `neighborhood.js` and `rules.js`.
import * as hud from '../ui/hud.js'

export { PALETTE }

/** Facing north-west, into the corner intersection the player spawns beside. */
const SPAWN_YAW = Math.PI * 0.25

/** The cross-fade at a capture, seconds. §9.3's beat, and the only one v2 has. */
const CAPTURE_FADE_SECONDS = 1.1

/**
 * How fast a fade nobody owns falls, per second, and so how long BEGIN's dissolve
 * lasts: `1 / 0.7` = 1.43 s.
 *
 * A named rate rather than a literal repeated in two phases, because the bug this
 * replaces was a literal written in only one of them.
 */
const FADE_LIFT_PER_SECOND = 0.7

/**
 * The pathing walk's own two constants, and both of them exist because a Voronoi
 * boundary is a place where a correct function of position gives a different answer
 * for two positions a centimetre apart.
 *
 * `LEG_REACHED_METRES` is how close counts as arrived: the creature re-plans from
 * wherever it stopped, and the graph does not care that it is 4 m short of the
 * intersection it was aiming at. `REPLAN_SECONDS` is the floor on how often a
 * *chase* may re-plan when the player's own node changes, for the same reason: the
 * player crosses boundaries too, and a chase that re-plans on a wobble is a chase
 * that ping-pongs.
 */
const LEG_REACHED_METRES = 4
const REPLAN_SECONDS = 0.8

/**
 * DIRECT_APPROACH_HOPS — how close is "walk at it", in street steps.
 *
 * §6.1's CHASE is a "direct approach at the tier's top speed", and the graph can
 * only offer that when there is an edge left to walk. One is the number: inside a
 * street the player and the creature are either in the same cell or in neighbouring
 * ones, and in neighbouring ones the route says "sixty metres via the next
 * intersection" while the player is two metres away across a cell boundary — so a
 * pure graph walk turns around at the kerb and lets them go. The fourth thing the
 * simulation found, and the last one: without it an enraged creature loses a walker
 * it was already touching, every time, which is why the finale was a walk to the
 * car.
 */
const DIRECT_APPROACH_HOPS = 1

/** Point lights given to the sodium lamps; the rest of the grid is unlit. */
const LAMP_LIGHTS = 4

/**
 * How far a lamp light reaches before the pool stops looking for another.
 *
 * BEFORE 40, AFTER 96 (iteration 2, pass 2). This is the radius of the *search*
 * — how far `streetView.lampsNear` will go looking for a lamp to put one of the
 * four lights on — and it is not the same number as `LAMP_LIGHT_DISTANCE`, which
 * is how far the light itself throws. The two have to be related, and the old
 * relationship was the bug: a 60 m throw fed by a 40 m search means the outer
 * 20 m of every lamp's reach is only ever lit if the player happens to be standing
 * next to that lamp, so a pool faded out in the middle of the frame for no reason
 * a viewer could name.
 *
 * 96 m is 1.5 lamp spacings, so the search can always see the next two lamps down
 * the road. It is bounded above by the light count, not by taste: four lights
 * cannot cover 96 m of 64 m-spaced grid from anywhere, and pretending otherwise
 * would be a comment rather than a behaviour. What it buys is that the four
 * lights are always the four *nearest*, including while walking between them,
 * which is what keeps the grid regular instead of flickering between lamps as the
 * player crosses an intersection.
 */
const LAMP_RADIUS = 96

/**
 * §12.1's exposure curve, as two numbers instead of two literals.
 *
 * ITERATION 2, PASS 1. BEFORE the pair `(0.95, 0.17)`, read in `_applyDusk` as
 * `0.95 - 0.17 * t` — a linear 18% cut across a run. AFTER `(1.02, 0.14)`, read
 * as `1.02 - 0.14 * t * t`.
 *
 * Two things changed and they are different in kind. The base is up 7% because
 * the sky ramp itself came up 1.6x to 3.0x in 8-bit luma (3.0x to 6.2x linear)
 * and ACES at the old 0.95 was compressing a palette that no longer needed
 * compressing. The *shape* is the actual fix: the cut is now quadratic, so it is
 * almost free through Act I and Act II (`t = 0.5` costs 3.5% of the 1.02 base
 * where the old curve cost 8.9% of its 0.95) and lands almost
 * all of itself on the last third, which is the only stretch of the run where
 * §3.7 wants the world visibly tightening.
 *
 * These are named because there are now two readers — the constructor and
 * `_applyDusk` — and the constructor's value has to be the curve's value at
 * `t = 0` or the first frame is a different exposure from every frame after it.
 * The gate asserts they agree.
 */
const EXPOSURE_BASE = 1.02
const EXPOSURE_CUT = 0.14

/**
 * How bright a lamp head is, in the units a Three.js point light wants.
 *
 * The number is calibrated, not chosen, and this is the comment that has to
 * survive the next person who decides 16 "looked fine in the editor". Measured
 * over the lower half of the `street` view — the road, where the light has to
 * land — holding every other variable still, the fraction of road pixels at or
 * above luma 18 went: 1.64% at 16, 3.57% at 120, 13.96% at 400, 34.08% at 900.
 *
 * Sixteen was the bug and 400 is the fix, for a geometric reason rather than an
 * aesthetic one. `streetView.js` puts a lamp head 5.1 m up with a 12 m painted
 * pool under it, but a 16-candela point light at decay 2 falls to 16/64 of its
 * value by the time it is 8 m from the head, and a 12 m pool lit only by a
 * fading inverse square is a pool you cannot see. Lamps are one per
 * intersection, 64 m apart, so a pool that only reaches its own kerb leaves 52 m
 * of road between pools with nothing on it at all: the avenue read as a row of
 * isolated coins on a black table rather than a lit street. The gap has to be
 * closed by the *lights*, because the painted pools cannot be made to overlap —
 * §4 needs them to read as a grid, and a grid is spacing.
 *
 * 900 is measurably brighter still and visibly wrong: the whole carriageway goes
 * to a uniform orange and the sodium stops being a pool you steer by, which is
 * the navigation affordance the pools exist for. 400 is the top of the legible
 * range without spending that affordance.
 *
 * ITERATION 2, PASS 2 — 400 stays 400, and that is a decision rather than an
 * omission. Three things changed underneath this number and none of them is the
 * brightness: the painted pool got 1.5x wider (`streetView.js`), the throw got
 * 1.5x longer (`LAMP_LIGHT_DISTANCE`), and the world got a dedicated bounce
 * family (`LAMP_BOUNCE_*`) whose entire job is the *road between* pools. Raising
 * the key as well would have spent §4's "steer by the sodium grid" affordance on
 * the change that was supposed to be about the pools' shape instead of their
 * reach, and the measurement that calibrated 400 in the first place — 34% of the
 * lower scene lit at 900, where the pools stop being pools — is the measurement
 * that would have caught it. The gate re-runs that comparison.
 */
const LAMP_LIGHT_INTENSITY = 400

/**
 * How far one lamp light throws, in metres.
 *
 * BEFORE 60, AFTER 92 (iteration 2, pass 2). The old comment said "just over half
 * the 64 m lamp spacing, so adjacent pools overlap slightly at the midpoint" —
 * and that was true, and it is the reason the old street read as a row of isolated
 * coins. Slight overlap at the midpoint means the *midpoint* is the darkest point
 * on the road, twice per 64 m, which is a stripe of unlit tarmac running down the
 * centre of every avenue. The pools were not too small; they were too *short*.
 *
 * 92 m is 1.44 spacings, so each lamp's reach covers the whole gap to its
 * neighbour's and the pools overlap by 28 m rather than 4 m. It is bounded above
 * by the same thing `LAMP_RADIUS` is bounded above by: beyond about 1.5 spacings
 * the inverse square has done essentially all the work it can do, and past that
 * point a longer throw is indistinguishable from raising `LAMP_LIGHT_INTENSITY`,
 * which is the number §4's affordance lives on.
 */
const LAMP_LIGHT_DISTANCE = 92

/**
 * The warm bounce: how many extra lights stand in for light that has come off the
 * road and the walls and gone back up onto them.
 *
 * BEFORE zero — there was no bounce of any kind, and the sodium family consisted
 * of a hot disc under each head, an unfogged head above it, and black everywhere
 * else. AFTER 2 (iteration 2, pass 2), aimed at the same nearest lamps as the key
 * lights but sitting low, wide and very dim.
 *
 * The count is 2 rather than 4 for a reason that is about the look and not about
 * the budget. A bounce is a *fill*: it is what stops the underside of a roofline
 * and the face of a wall from being black while the road under them is orange, and
 * that job is done by the two biggest sources nearest the camera. Four bounce
 * lights would have started to compete with the key for the road, and a bounce
 * that competes with its own source is a second key.
 */
const LAMP_BOUNCE_LIGHTS = 2

/**
 * How bright a bounce light is. BEFORE nothing / AFTER 46.
 *
 * It has to be small against `LAMP_LIGHT_INTENSITY` (400) and it is: 11.5% of the
 * key. That ratio is the whole design. A bounce that is a large fraction of its
 * key stops being a bounce and becomes the light, at which point the pool's shape
 * is being drawn by the fill and §4's grid goes soft. At 11.5% the key still owns
 * the pool's centre and the bounce owns everything the key cannot reach — the
 * kerb, the pavement, the lower two metres of a wall — which is precisely the
 * "tint the road and nearby walls amber" the brief asked for.
 */
const LAMP_BOUNCE_INTENSITY = 46

/**
 * How far a bounce light throws, in metres. BEFORE nothing / AFTER 34.
 *
 * Wider than the pool it is standing in (18 m) and wider than the key's own
 * useful reach near the ground, on purpose: this is the light that has to get
 * onto the *walls*, and a wall 20 m down the road is 20 m from the lamp but
 * nowhere near the disc. 34 m is a little over half a lamp spacing, so a bounce
 * covers the frontage of its own intersection and the near half of the next one.
 */
const LAMP_BOUNCE_DISTANCE = 34

/**
 * How high a bounce light sits, in metres. BEFORE nothing / AFTER 2.2.
 *
 * Low, and the number is load-bearing in a way that is easy to get backwards. A
 * bounce comes *off* a horizontal road, so it travels roughly horizontally: a
 * point light at road level would light the underside of nothing and the tops of
 * everything. 2.2 m is a little under the shoulder line of a 2.80 m figure and
 * just above `world.js`'s 1.5 m camera fill, which puts it at the height a wall
 * is actually being washed at — the middle of the frontage, where the eye reads
 * "this surface is lit" rather than "this surface is in shadow".
 *
 * It is also below the lamp head (5.1 m) on purpose. Two lights on one lamp
 * should not be co-located, or the bounce is invisible: at the same position it
 * is the same light.
 */
const LAMP_BOUNCE_HEIGHT = 2.2

/**
 * How far away §6.1's first sighting has to stand, in metres.
 *
 * §8.3's floor is `REEMERGE_MIN_GRAPH_DISTANCE` graph steps, and `creature.js`
 * derives its own distance reading of that as `BLOCK * sqrt(2)` — the closest two
 * hops can lie on a 64 m grid. This is the same number, written down here
 * because `world.js` needs it for a test the pure module does not make: the
 * graph floor is a property of the *graph*, and a cone test in a wrapped frame
 * can put a node inside the cone at one hop's distance. "Appears at long range"
 * is a sentence about metres, so it is checked in metres.
 */
const MIN_SIGHTING_METRES = hood.BLOCK * Math.SQRT2 * beast.REEMERGE_MIN_GRAPH_DISTANCE

/**
 * How long after a resume a lost pointer lock is forgiven, seconds of world time.
 *
 * §14.3 pauses on losing the lock, and the pause *causes* a lock loss. Without a
 * grace window, resuming would ask for the lock, fail or lag for a frame, and
 * the `pointerlockchange` that follows would pause the game again — a pause menu
 * that cannot be left. Half a second is the width of a slow round trip and no
 * more: any longer and a genuine alt-tab in that window would be swallowed.
 */
const LOCK_GRACE_SECONDS = 0.5

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Linear interpolation across §12.3's three stops, clamped at both ends. */
function lerpStops(stops, t) {
  const span = stops.length - 1
  const k = clamp01(t) * span
  const index = Math.min(Math.max(0, stops.length - 2), Math.floor(k))
  return new THREE.Color(stops[index]).lerp(new THREE.Color(stops[index + 1]), k - index)
}


/**
 * LongQuietGame — THE LONG QUIET, constructed once by `App.jsx`.
 *
 * @param {HTMLElement} container
 * @param {{ store?: object, audio?: object, seed?: number,
 *           createRenderer?: (container: HTMLElement) => object }} [options]
 *   `createRenderer` exists so a headless smoke test can drive the whole
 *   simulation without a WebGL context; it is the same door v1 had.
 */
export class LongQuietGame {
  constructor(container, options = {}) {
    this.container = container
    this.store = options.store ?? createStore()
    this.audio = options.audio ?? null
    this.seed = options.seed ?? 1337
    this.disposed = false

    // --- renderer -----------------------------------------------------------
    this.renderer = options.createRenderer
      ? options.createRenderer(container)
      : new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 450, false)
    this.renderer.shadowMap.enabled = false
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // v1 sat at 0.92 for a cellar; §12.1 is a lit horizon over a dark street,
    // which wants slightly more of it, and the dusk curve takes it down from there.
    //
    // BEFORE a bare `0.95`; AFTER `EXPOSURE_BASE`, which is the same number named.
    // The reason to name it is that `_applyDusk(0)` runs a few lines below this,
    // the moment the scene exists, and it writes the curve's value at `t = 0`.
    // Leaving the constructor on a literal means the value a reader greps for is
    // not the value the first frame renders at, and the gate cannot tell.
    this.renderer.toneMappingExposure = EXPOSURE_BASE
    this.canvas = this.renderer.domElement
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    container.appendChild(this.canvas)

    // --- scene --------------------------------------------------------------
    this.scene = new THREE.Scene()
    // The far plane has to outlast the fog. At the tightest dusk the world is
    // opaque at about 40 m, and a far plane inside that would clip the fog into a
    // visible wall; 260 m is comfortably past the tightest visibility.
    this.camera = new THREE.PerspectiveCamera(72, this._aspect(), 0.05, 260)

    this.objectives = placeObjectives(this.seed, 1)
    this.streetView = new StreetView(this.scene, { seed: this.seed, objectives: this.objectives, loop: 1 })

    this._buildLights()
    this._applyDusk(0)

    // --- player -------------------------------------------------------------
    // slice 11: the player's stride is a *fact* for the audio frame, not a sound.
    // §6.2's gating stays here — a stride only happens when the player is really
    // moving — and §6.2's pricing moves into `audio.js`'s routing table, which
    // asks the creature's own `soundRadius` for the number. The one audio call in
    // this file is `_updateAudio`, and the gate holds it to that.
    this.player = new PlayerController(this.camera, this.canvas, {
      onFootstep: (sprinting, exhausted) => {
        this._footstep = { sprinting, exhausted }
      },
    })
    this.player.attach()
    this.player.enabled = false
    this.player.teleport(SPAWN.position.x, SPAWN.position.z, SPAWN_YAW)
    this.player.setColliders(this.streetView.colliders())
    this._colliderRevision = this.streetView.revision

    // --- the run ------------------------------------------------------------
    /** The v2 state object: `rules.js`'s, not v1's. */
    this.state = rules.createInitialState(this.objectives, { loop: 1 })
    this.creature = beast.createCreature({ state: 'telegraph' })
    this.creaturePosition = this._firstSightingPoint()
    this.banishElapsed = 0
    /**
     * The intersection the walk has committed to (§ the note on `_walkCreature`),
     * and the two pieces of state that decide when it may change its mind. A
     * teleport of the creature — a re-emergence, a capture — has to drop it, or the
     * creature would set off for an intersection that was chosen for a position it
     * no longer occupies.
     */
    this.creatureLeg = null
    this.creatureTargetNode = null
    this.creaturePlannedAt = 0
    /** §6.2 sound events the creature has not heard yet. */
    this.soundEvents = []
    this.hammerHold = 0
    /**
     * The §5.2 sound window, per portal. Slice 11: it was one number shared by all
     * three portals, and the loop zeroed it for every portal that was not the one
     * being held — so the 25 m event could never fire, and §5.2's second half was
     * never loud. The world check that found it is parked in `verify-world.mjs`.
     */
    this.portalNoiseElapsed = Object.fromEntries(hood.PORTAL_IDS.map((id) => [id, 0]))
    /** One-frame flag: the hammer was picked up on this frame (§7.2's toll). */
    this._hammerToll = false
    /**
     * One-frame flag: LMB went down this frame. §7.4's swing is the *only* door to
     * the banish ladder, and until slice 10 the world consumed the edge here and
     * then never handed it on, so the hammer rang and nothing ever answered.
     */
    this._swingPending = false
    /**
     * §7.4's swing *outcome*, which is what decides between the banish toll and the
     * whiff (§13). Recorded by `_updateCreature` and read by `_updateAudio` on the
     * same frame, which is the only frame the answer is on: `creatureStep` runs its
     * swing test before its capture test, so a hammer that connects on the frame
     * it would otherwise have caught you is answered by the banish toll, and one
     * that misses is answered by the whiff.
     */
    this._swingResult = null

    // --- audio (slice 11) -----------------------------------------------------
    //
    // Every fact §13 needs for this frame, and nothing else. The world decides
    // *what happened* — a stride, a swing, a capture, a portal's progress — and
    // `audio.routeAudio` decides what that sounds like. The flags below are all
    // one-frame and all consumed by `_updateAudio`, which is called once per
    // frame from `update` so that a flag cannot survive into a later frame and
    // ring a bell twice.
    this._footstep = null
    /** §7.2's pickup edge, for the awakening toll. Once per run. */
    this._hammerPickup = false
    /** §9.3's reset beat: a capture, or the full wipe on BEGIN AGAIN. */
    this._loopReset = false
    /** §5.2's 25 m event, set where the world pushes the sound event. */
    this._portalNoise = false

    // --- the creature's presentation (slice 10) -------------------------------
    //
    // Two clocks and a fade, all of them *presentation*. §6.1's states, §7.4's
    // removal windows and §8.2's phase-out are decided in `creature.js`; what the
    // world owns is how long the figure has been leaving, and how long ago it was
    // placed, because the world is what owns a clock.
    //
    // `dismissElapsed` starts already past the end of the window, so the creature
    // is absent on frame one and there is no opening apparition nobody asked for.
    this.creatureView = new CreatureView(this.scene, { seed: this.seed })
    this.dismissElapsed = beast.FADE_SECONDS.dismiss
    this.dismissing = false
    this.reemergeElapsed = beast.FADE_SECONDS.reemerge
    this._creatureFacing = 0
    this.creatureAwareness = 0
    // --- runtime ------------------------------------------------------------
    this.phase = this.store.get().phase ?? PHASE.START
    this.resetElapsed = 0
    this.startedOnce = false
    this.animTime = 0
    this.fade = this.phase === PHASE.START ? 1 : 0
    this.shake = 0
    this._fpsFrames = 0
    this._fpsAccum = 0
    this.clock = new THREE.Clock()

    // --- §14.3 pause and motion sensitivity ---------------------------------
    //
    // A pause is a *flag* and not a fifth `PHASE`, for §10.5's reason stated in
    // `store.js`: the phase machine is the game's four moments and the world
    // reads it; a pause is an overlay on top of whichever moment is running, and
    // a player who pauses during a capture's black has not invented a phase.
    // `paused` therefore freezes `update` outright rather than selecting a
    // different branch inside it.
    this.paused = false
    /** §14.3's toggle. `null` = "whatever the OS asked for", which is the default. */
    this.motionPreference = null
    /** Absolute time at which a pause-induced lock loss stops counting (§14.3). */
    this._lockGraceUntil = 0
    /** §14.3's banish/pickup flash, decaying; §11.3's counterpart to a toll. */
    this.hammerFlash = 0
    /** The §14.3 finale screen-effect rate limiter's own state. */
    this.finaleEffect = hud.finaleEffectInit()
    this.reducedMotion = false
    this._motion = hud.motionFlags(false)
    this._applyMotionPreference()
    this._lampKey = ''
    /** The mirror's value key: the sigil set *and* the per-portal hold. */
    this._sigilKey = ''
    this._hold = 0
    this._holdByPortal = Object.fromEntries(hood.PORTAL_IDS.map((id) => [id, '0']))
    this._awareness = 0
    this._creaturePresent = false
    this._flashAmplitude = 1
    this._prompt = null

    // --- input --------------------------------------------------------------
    // `E` and LMB are the two verbs of §5.2 and both belong to the player, which
    // is why neither is wired here: `player.js` turns them into an interact hold
    // and a swing edge, and the world consumes both once per frame.
    this._onKeyDown = (e) => {
      if (e.code === 'KeyF') this.store.update((state) => ({ ...state, showFps: !state.showFps }))
      // §14.3: Esc pauses. Gated on actually playing, because a title screen with
      // a pause card on it is a bug and a win screen with one is worse — the win
      // is already frozen, and §10.4's card owns the screen from there.
      if (e.code === 'Escape' && this.startedOnce && this.phase === PHASE.PLAYING) this.setPaused(!this.paused)
    }
    this._onMouseDown = () => {
      if (this.startedOnce && this.phase !== PHASE.WON && !this.paused && !this.player.locked) this.player.requestLock()
    }
    // §14.3: losing pointer lock *is* the pause. Alt-tabbing away from a game
    // that keeps hunting you is the single most hostile thing a first-person
    // game can do, and the browser fires this event whether the player meant it
    // or not. It is one-way — losing the lock pauses, it never resumes — because
    // a lock we failed to re-acquire must not be able to un-pause a game the
    // player has deliberately stopped.
    this._onLockChange = () => {
      const locked = typeof document !== 'undefined' && document.pointerLockElement === this.canvas
      if (locked || this.paused) return
      // the grace window covers the pause this very call caused: releasing the
      // lock to show a menu fires a second `pointerlockchange` a frame later
      if (this.startedOnce && this.animTime >= this._lockGraceUntil) this.setPaused(true)
    }
    window.addEventListener('keydown', this._onKeyDown)
    document.addEventListener('pointerlockchange', this._onLockChange)
    this.canvas.addEventListener('mousedown', this._onMouseDown)

    this._onWindowResize = () => this.resize()
    window.addEventListener('resize', this._onWindowResize)
    this._resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this._resizeObserver?.observe(container)

    this._motionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    this._onMotionChange = () => this._applyMotionPreference()
    this._motionQuery?.addEventListener?.('change', this._onMotionChange)
    this._applyMotionPreference()

    this.store.set({ fade: this.fade })
    this._syncHud()

    this._animate = this._animate.bind(this)
    this.rafId = requestAnimationFrame(this._animate)
  }

  _aspect() {
    return (this.container.clientWidth || 800) / Math.max(1, this.container.clientHeight || 450)
  }

  resize() {
    if (this.disposed) return
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 450
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  // -------------------------------------------------------------------------
  // scene construction — §12: two light families, and a dusk that closes
  // -------------------------------------------------------------------------

  /**
   * The lights.
   *
   * Three kinds, and the mix is the art direction rather than a budget:
   *
   *  - a hemisphere and one very dim directional, standing in for the *lit
   *    horizon* of §12.1. This is the reason the game is dusk and not night, and
   *    it is why a silhouette two blocks away is still a silhouette and not a
   *    hole. Both fade with dusk but never to nothing.
   *  - a pool of four point lights that snap to the nearest sodium lamps. Forty-
   *    nine lamps is a landmark grid; forty-nine *lights* is a shader bill the
   *    browser will not thank us for, and §4 only needs the nearest handful to
   *    read as "the streetlights have already come on".
   *  - a whisper of warm fill at the camera. §12.1 again: readable silhouettes,
   *    and the smallest possible admission that the player is the one thing in
   *    the world carrying a light source.
   *
   * The portal lights are the third family and they belong to `streetView.js`,
   * because they are attached to geometry rather than to the player.
   */
  _buildLights() {
    // §12.1's ambient term, and the half of this pass that is a *number* rather
    // than a colour.
    //
    // BEFORE 0.5 / AFTER 0.85. The hemisphere is standing in for the lit
    // overcast, and at 0.5 it was contributing almost nothing: a violet 15%-luma
    // sky at half strength is roughly 7% of white, which is below what ACES at
    // this exposure can resolve into anything a player can navigate by. §4 promises
    // the streetlight grid is the primary orientation mechanism and §12.1 promises
    // silhouettes survive at range; both of those need a world with a floor
    // under it, and 0.85 with a warm sky is that floor. It is deliberately below
    // the 1.0 that would flatten the lamps' pools into a wash — the sodium grid
    // has to stay the brightest thing on the road.
    this.hemisphere = new THREE.HemisphereLight(PALETTE.skyStops[0], 0x0d0b12, 0.85)
    this.scene.add(this.hemisphere)

    // BEFORE 0x6b4a6b / AFTER 0xffc27a, intensity 0.32 -> 0.34.
    //
    // The horizon key was the last violet thing left in the frame, and with a
    // sodium sky behind it a mauve key reads as a colour error rather than as
    // dusk. It is now the same family as `PALETTE.sodium` but a stop paler, so
    // it lifts the upper faces of roofs and hedges toward the sky without
    // competing with the lamps for the road.
    this.sunset = new THREE.DirectionalLight(0xffc27a, 0.34)
    this.sunset.position.set(-1, 0.28, -0.6)
    this.scene.add(this.sunset)

    this.lampLights = []
    for (let i = 0; i < LAMP_LIGHTS; i += 1) {
      const light = new THREE.PointLight(PALETTE.sodium, 0, LAMP_LIGHT_DISTANCE, 2)
      light.visible = false
      this.scene.add(light)
      this.lampLights.push(light)
    }

    // The warm bounce (iteration 2, pass 2), and the only lights in the scene
    // that are not a key.
    //
    // They are built here rather than lazily in `_updateLampPool` so the light
    // count is fixed at construction: a pool of lights that grows and shrinks
    // with the player is a shader recompile walking down the street, and §17's
    // budget is a budget precisely because it is knowable in advance.
    this.bounceLights = []
    for (let i = 0; i < LAMP_BOUNCE_LIGHTS; i += 1) {
      const bounce = new THREE.PointLight(PALETTE.bounce, 0, LAMP_BOUNCE_DISTANCE, 2)
      bounce.visible = false
      this.scene.add(bounce)
      this.bounceLights.push(bounce)
    }

    this.fill = new THREE.PointLight(0xffb877, 0.9, 9, 2)
    this.scene.add(this.fill)
  }

  /**
   * _applyDusk — §3.7 and §12.3, applied to the renderer in one place.
   *
   * The fog colour and the sky are the same colour on purpose. `FogExp2` fades
   * geometry towards `fog.color` but leaves `scene.background` alone, so any
   * difference between the two draws a hard horizon line across the world at
   * exactly the distance the fog is supposed to hide things. Matching them is the
   * whole trick of a fogged outdoor scene.
   */
  _applyDusk(dusk) {
    const t = clamp01(dusk)
    this.scene.fog = new THREE.FogExp2(lerpStops(PALETTE.fogStops, t).getHex(), rules.fogDensityForDusk(t))
    this.scene.background = this.scene.fog.color
    this.hemisphere.color.copy(lerpStops(PALETTE.skyStops, t))
    // BEFORE `0.5 - 0.22 * t` / AFTER `0.85 - 0.18 * t`. The slope comes down
    // because the palette did the darkening already: the stop-2 sky is 52 luma
    // where the old one was 17, so keeping the old falloff on top of the new
    // colour would have crushed the finale twice — once in the ramp and once in
    // the intensity — and the finale is the frame §11.3's balance assertion is
    // played out in. Ambient still fades (the dusk is a clock, §3.7) but it never
    // goes below 0.67, so the world at its darkest is still a lit world.
    this.hemisphere.intensity = 0.85 - 0.18 * t
    // BEFORE `0.32 - 0.2 * t` / AFTER `0.34 - 0.14 * t`, same reasoning.
    this.sunset.intensity = 0.34 - 0.14 * t
    // §12.1's exposure, and the second half of this pass.
    //
    // BEFORE `0.95 - 0.17 * t`, which spans 0.95 -> 0.78 and is a *linear* 18%
    // cut. Multiplied against the old violet ramp, the far end of a run rendered
    // at 0.78 exposure on a 7%-luma sky, which is the "can't see the street"
    // complaint reproduced as arithmetic.
    //
    // AFTER `EXPOSURE_BASE - EXPOSURE_CUT * t * t` — the same endpoints' intent
    // with the bite taken out of the middle. The quadratic matters more than the
    // endpoints: at t = 0.5 the old curve had already given up 8.9% of its 0.95
    // while the player is still in Act II hunting three portals, and the new one
    // has given up 3.5% of its 1.02. The curve is therefore *flat where the game
    // is played* and only closes in the last third, which is the finale's job —
    // and §3.7's promise that the world visibly tightens survives, just at 0.88
    // rather than 0.78.
    this.renderer.toneMappingExposure = EXPOSURE_BASE - EXPOSURE_CUT * t * t
  }

  /**
   * _updateLampPool — the sodium family, re-aimed every frame.
   *
   * Only re-aimed when the set of nearest lamps changes, which for a player
   * walking at 3.6 m/s is a couple of times a second rather than 60 times.
   *
   * The key lights and the bounce are aimed in the same pass and off the same
   * `lampsNear` list, which is the only arrangement where the bounce can be a
   * bounce: a fill that is allowed to choose its own lamps is a second key with
   * a different opinion about where the road is brightest. The bounce takes the
   * *first* `LAMP_BOUNCE_LIGHTS` entries — the nearest — and stands each one
   * directly under the key that owns it, at `LAMP_BOUNCE_HEIGHT` instead of the
   * key's 4.9 m.
   */
  _updateLampPool() {
    const lamps = this.streetView.lampsNear(this.player.pos.x, this.player.pos.z, LAMP_RADIUS)
    const key = lamps.map((lamp) => `${lamp.x},${lamp.z}`).join('|')
    if (key === this._lampKey) return
    this._lampKey = key
    for (let i = 0; i < this.lampLights.length; i += 1) {
      const light = this.lampLights[i]
      const lamp = lamps[i]
      if (!lamp) {
        light.visible = false
        light.intensity = 0
        continue
      }
      light.visible = true
      light.position.set(lamp.x, lamp.y - 0.2, lamp.z)
      light.intensity = LAMP_LIGHT_INTENSITY
    }
    // the bounce, aimed at the same lamps and lit by the same arrival
    for (let i = 0; i < this.bounceLights.length; i += 1) {
      const bounce = this.bounceLights[i]
      const lamp = lamps[i]
      if (!lamp) {
        bounce.visible = false
        bounce.intensity = 0
        continue
      }
      bounce.visible = true
      bounce.position.set(lamp.x, LAMP_BOUNCE_HEIGHT, lamp.z)
      bounce.intensity = LAMP_BOUNCE_INTENSITY
    }
  }

  // -------------------------------------------------------------------------
  // simulation
  // -------------------------------------------------------------------------

  _animate() {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this._animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    // the hidden frame counter, sampled over 0.5 s windows
    this._fpsFrames += 1
    this._fpsAccum += dt
    if (this._fpsAccum >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsAccum)
      this._fpsFrames = 0
      this._fpsAccum = 0
      if (this.store.get().showFps) this.store.set({ fps })
    }
    this.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * update — one frame of the world.
   *
   * The shape of this function is the shape of the design: the phase machine
   * picks what the world is *doing* (§10.5 — playing, resetting, won), and
   * whatever it is doing, the street breathes and the HUD mirrors. `update` is
   * the only door the render loop and the smoke test have, and both drive it
   * with a plain `dt`, which is why there is no clock read outside `_animate`.
   */
  update(dt) {
    // §14.3: "pauses and freezes the simulation *completely*, including the
    // creature". Complete means this returns before `animTime` moves, so every
    // clock in the world stops: the player, the hold, the creature's awareness
    // and its state machine, the dismissal and re-emergence windows, the shake
    // decay, and the lamps. The store is still mirrored below, because a paused
    // HUD that stopped updating would drop the pause card it is being shown
    // behind, and the one thing a pause must never do is look frozen-buggy.
    if (this.paused) {
      this._updateAudio(dt)
      this._syncHud()
      return
    }
    this.animTime += dt
    this.phase = this.store.get().phase ?? this.phase
    this.streetView.update(dt)
    this._recentre()
    this._updateLampPool()
    this.fill.position.set(this.player.pos.x, 1.5, this.player.pos.z)

    // The fade is the one piece of presentation that outlives a phase change, and
    // that is why it is lifted here rather than inside one phase's own updater.
    // `start()` puts `fade` back to 1 so the hand-off from the title card to the
    // player is a dissolve and not a cut, and it makes the phase PLAYING on that
    // same call — so a decay written only in the title updater runs for exactly
    // one frame of a real run. Two phases own the value outright and assign it,
    // so lifting it around them cannot disturb either: §9.3's cross-fade drives
    // it in both directions across 1.1 s, and §10.4's card ramps it up to its own
    // 0.6 ceiling. Every other phase lifts it.
    //
    // This does not fail like a lighting bug. `fade` is painted as a
    // full-viewport `background: #000` rect over the canvas, so a value still
    // standing at 1 is not a dark scene — it is a run nobody can see, at any
    // dusk, under any lamp. It hid behind a green gate because the gate asserted
    // that the mirror agreed with the world, which a permanently black world
    // satisfies perfectly.
    if (this.phase === PHASE.START || this.phase === PHASE.PLAYING) {
      this.fade = Math.max(0, this.fade - dt * FADE_LIFT_PER_SECOND)
    }

    switch (this.phase) {
      case PHASE.PLAYING:
        this._updatePlaying(dt)
        break
      case PHASE.RESET:
        this._updateReset(dt)
        break
      case PHASE.WON:
        this._updateWon(dt)
        break
      default:
        // START: the world is built and lit, and the player does not exist yet
        this._updateStart(dt)
        break
    }
    this._updateCreatureView(dt)
    this._updateHudTells(dt)
    this._updateAudio(dt)
    this._syncHud()
  }

  // -------------------------------------------------------------------------
  // audio (§13, slice 11)
  // -------------------------------------------------------------------------

  /**
   * _audioFrame — every fact §13 needs about this frame, and no decisions.
   *
   * The contract is `AUDIO_FRAME_FIELDS`, and this method is the only thing in
   * the codebase that fills it in. Four of the fields are one-frame edges set
   * elsewhere — the stride, the pickup, the swing outcome and the reset — and the
   * rest are *state* the world already knows: the breath meter off the player,
   * the creature's distance and awareness, each portal's progress and range.
   *
   * Nothing here asks what any of it should sound like. That is the whole design
   * of slice 11: the world is the only thing that knows what happened, and the
   * table is the only thing that knows what it costs.
   */
  _audioFrame() {
    // §14.3: a paused frame is not a frame the simulation had, so it never gets
    // one. What it gets instead is the *silence* frame — `started: false`, the
    // title screen's frame, and the title screen is the only moment in the game
    // where nothing is playing at all. That matters because `routeAudio` sends
    // every sustained row on every started frame: skip the frame entirely and a
    // winded player's rasp holds its last gain for as long as they sit in the
    // pause menu, which is exactly the sound a paused game must not make.
    // Routing silence instead drops the rasp, the hums and the proximity breath
    // to zero and pulls the drone back to its black level, so a pause is quiet
    // rather than frozen.
    if (this.paused) return { started: false }
    const player = { x: this.player.pos.x, z: this.player.pos.z }
    const from = this.creaturePosition
    const distance = Math.hypot(beast.wrapDelta(from.x, player.x), beast.wrapDelta(from.z, player.z))
    return {
      started: this.startedOnce,
      playing: this.phase === PHASE.PLAYING,
      won: this.phase === PHASE.WON,
      loopReset: this._loopReset === true,
      hammerPickup: this._hammerPickup === true,
      // past tense, because `_takeHammer` has already flipped the flag by the time
      // the frame is built: this is what the player had in hand *before* the pickup
      hammerHeldBefore: this.state.hammerHeld === true && this._hammerPickup !== true,
      swing: this._swingResult,
      footstep: this._footstep,
      portalNoise: this._portalNoise === true,
      breath: this.player.breath,
      exhausted: this.player.exhausted === true,
      creatureDistance: distance,
      // §7.4's removal is a *full* removal, so §6.4's readout stops with it: a
      // banished creature is off the field even while the view is still fading the
      // figure out, and a breath that followed the player home would undo the one
      // moment the design promises relief in
      creaturePresent: this.creature.state !== 'dormant' && this.creature.state !== 'stagger',
      creatureAwareness: this.creatureAwareness,
      portals: this.streetView.portals.map((entry) => {
        const world = this.streetView.worldOf(entry.position)
        return {
          id: entry.id,
          progress: this.state.progress[entry.id] ?? 0,
          shut: this.state.portals[entry.id] === true,
          distance: Math.hypot(beast.wrapDelta(world.x, player.x), beast.wrapDelta(world.z, player.z)),
        }
      }),
    }
  }

  /**
   * _updateAudio — the one call into `audio.js`, once per frame, in every phase.
   *
   * In every phase because that is how the voices get stopped: the capture's
   * black is 1.1 seconds during which `playing` is false, and the routed breath,
   * rasp and hum rows arrive with a level of zero on exactly those frames. A
   * voice that is only updated while playing is a voice that plays on through the
   * black.
   *
   * The one-frame flags are consumed here and cleared immediately after, so a
   * flag cannot survive a frame and toll twice — which is the entire failure mode
   * of §7.2's "tolls once" and §9.3's one-toll sting.
   */
  _updateAudio(dt) {
    this.audio?.update(dt, this._audioFrame())
    this._loopReset = false
    this._hammerPickup = false
    this._portalNoise = false
    this._footstep = null
    this._swingResult = null
  }

  /** The title screen still looks at the street, because it is behind the title. */
  _updateStart(dt) {
    // the title's own black is lifted in `update()`, which is where every phase
    // that does not own the fade lifts it
    this.camera.position.set(SPAWN.position.x, 1.75, SPAWN.position.z)
    this.camera.rotation.set(
      Math.sin(this.animTime * 0.31) * 0.03,
      SPAWN_YAW + Math.sin(this.animTime * 0.19) * 0.09,
      0,
      'YXZ',
    )
  }

  _updatePlaying(dt) {
    const moved = this.player.update(dt)
    this._applyShake(dt)
    // again after the move, so this frame's interaction ranges and this frame's
    // colliders are both measured against the copy the player is actually in
    this._recentre()
    this._refreshColliders()
    this._updateVerbs(dt)
    this._updateCreature(dt, moved)
    // §10.4. The win is the last thing that happens in a frame, deliberately: the
    // verbs and the creature have already had this frame, so nothing that should
    // have happened on the way into the car is skipped by winning on the way in.
    // `checkExitWin` carries the whole rule — the `state.finale` in front of it
    // is the short-circuit that keeps a two-point distance test off every frame
    // of a run in which the car is, correctly, doing nothing.
    if (this.state.finale && this._insideExit()) this._win()
  }

  /**
   * _recentre — hand the world the copy the player is standing in.
   *
   * Once per frame, and a no-op unless the player has crossed a half-period
   * boundary, which is every 448 m of walking. This is the only place the wrap
   * moves, and the reason the player never has to: their coordinates run
   * monotonically and the world slides behind them instead.
   *
   * THE CREATURE IS PART OF THE WORLD, AND IT WALKS
   * -----------------------------------------------
   * The creature is folded here too, and this is the fifth and last of the frame
   * bugs the balance simulation found — the four in `_walkCreature` and the one on
   * the distance above were all about which copy of the map a *number* was in, and
   * this one is about a *position* leaving the map entirely. `creaturePosition` is
   * canonical and the walk moves it by folded deltas, so a chase that crosses the
   * seam walks the creature straight out of the window it is being drawn in: in the
   * finale of seed 8 it ended up a whole 448 m period from the copy the player was
   * standing in, which put the drawn figure 448 m away on the far side of the map
   * while `wrapDelta` correctly said it was touching. The consequence was a
   * creature that stood inside the player for 508 s and could neither be captured
   * (the radius test read a period of nothing) nor be banished (the hammer's reach
   * read the same), and a competent run that could not win.
   *
   * Folding it here, once per frame, in the same place the map itself is folded, is
   * what makes `creaturePosition` mean one thing: "the image of the creature that
   * the player is nearest to". Everything downstream is then a plain Euclidean
   * distance between two things that are genuinely next to each other — the capture
   * test, `BANISH_RANGE`, the awareness meter, §6.4's breath, the sight cone and the
   * figure on screen — and the harness can measure the same pair the same way.
   */
  _recentre() {
    this.streetView.recentre(this.player.pos.x, this.player.pos.z)
    this.creaturePosition = hood.nearestImage(this.creaturePosition, this.player.pos)
  }

  // -------------------------------------------------------------------------
  // the two verbs (§5.2) and the hammer (§7.1)
  // -------------------------------------------------------------------------

  /**
   * _updateVerbs — hold to interact.
   *
   * `rules.applyPortalHold` is the whole of §5.2 and is called once per portal per
   * frame: the one being held gets `true`, and every other portal gets `false` so
   * that walking away from a half-finished shutdown bleeds it off rather than
   * freezing it at 60%. Decay is what makes aborting free, and a frozen ring
   * would be the cheapest way in the game to cheese the noise threshold.
   */
  _updateVerbs(dt) {
    const holding = this.player.interactHeld()
    const swing = this.player.consumeSwing()
    const portal = this.streetView.nearestPortal(this.player.pos)
    const hammer = this.streetView.nearestHammer(this.player.pos)
    this._prompt = portal ? 'portal' : hammer ? 'hammer' : null

    for (const entry of this.streetView.portals) {
      const active = Boolean(portal && portal.id === entry.id && holding)
      const shutBefore = this.state.portals[entry.id] === true
      this.state = rules.applyPortalHold(this.state, entry.id, dt, active)
      if (!active) this.portalNoiseElapsed[entry.id] = 0
      if (!active || shutBefore) continue
      // §5.2: silent for the first half, then a 25 m sound event once per window
      // rather than once per frame
      //
      // The window is kept PER PORTAL, and slice 11 found that it used to be one
      // number shared by all three: the loop zeroes it for every portal that is not
      // the one being held, so the two idle portals reset the accumulator at the end
      // of every frame and the event could never fire at all. §5.2's whole promise —
      // that the second half of a hold is loud — was silently never kept. The
      // parked world check in `verify-world.mjs` is the one that found it.
      this.portalNoiseElapsed[entry.id] += dt
      if (
        this.state.progress[entry.id] >= rules.PORTAL_NOISE_THRESHOLD &&
        this.portalNoiseElapsed[entry.id] >= beast.SOUND_EVENT_SECONDS
      ) {
        this.portalNoiseElapsed[entry.id] = 0
        // the same window that prices the 25 m event for the creature also hands
        // the audio its commitment tell (§5.2, §13), so the two can never be one
        // frame apart: the surge the player hears is the sound the creature hears
        this._portalNoise = true
        this.soundEvents.push({
          kind: 'portal',
          radius: rules.PORTAL_SOUND_RADIUS,
          position: this.streetView.worldOf(entry.position),
        })
      }
      if (this.state.portals[entry.id]) this._onPortalShut(entry.id)
    }

    if (hammer && holding) {
      this.hammerHold += dt
      if (this.hammerHold >= rules.PORTAL_SHUT_SECONDS) this._takeHammer()
    } else {
      this.hammerHold = Math.max(0, this.hammerHold - dt * rules.PORTAL_RELEASE_DECAY)
    }

    // §14.2's ring, read *after* the holds have been ticked so it shows this
    // frame's progress rather than last frame's. It reads whichever hold is
    // running, and the hammer pickup is the same verb on the same key for the
    // same 1.2 s — so it gets the same ring, because a second shape for the same
    // interaction would be new HUD geometry carrying no new meaning.
    this._hold = portal
      ? this.state.progress[portal.id] ?? 0
      : hammer
        ? hud.holdFraction(this.hammerHold)
        : 0
    for (const entry of this.streetView.portals) {
      this._holdByPortal[entry.id] = hud.quantize(this.state.progress[entry.id] ?? 0, hud.STEPS.hold).toFixed(4)
    }

    // §7.4: a swing is a press, and the hammer answers to the creature, not the
    // world. With nothing in reach it is simply noise, which is the point —
    // swinging at the dark is how you get found. The edge is *also* handed to
    // `_updateCreature` on this frame, because `creatureStep` runs its capture test
    // after the swing, and a hammer that connects on the frame it would otherwise
    // have caught you is §6.1's promise that STAGGER cannot touch you.
    if (swing) {
      this._swingPending = true
      this.soundEvents.push({
        kind: 'toll',
        radius: beast.SOUND_RADII.toll,
        position: { x: this.player.pos.x, z: this.player.pos.z },
      })
    }
  }

  /** §7.2: the pickup tolls the bell, and the toll is what wakes the creature. */
  _takeHammer() {
    if (this.state.hammerHeld) return false
    this.state = { ...this.state, hammerHeld: true }
    this.streetView.setHammerTaken(true)
    this.hammerHold = 0
    // the flag, not the transition: §6.1's telegraph -> stalk edge is fired by the
    // next `creatureStep`, so the pickup frame cannot skip a frame of the machine
    this._hammerToll = true
    // §14.3: the awakening has a visual counterpart too, and it is this same
    // sigil flash — one sigil, two tolls, so the player's eye learns where to
    // look for "something rang".
    this.hammerFlash = 1
    // §13's awakening toll is routed, not called: `routeAudio` gates it on this
    // edge *and* on the hammer not already being held, so "once per run" is
    // enforced twice — here, where the pickup happens, and in the table, where
    // the sound is decided
    this._hammerPickup = true
    return true
  }

  /**
   * A portal went down: darken the world one step and take its light out for good.
   *
   * §5.4's permanent record of progress. Two of the finale's three *visible*
   * consequences are here and are idempotent by construction: the dusk step
   * (§3.7) and the headlights (§10.3), both read off `state.finale` rather than
   * off a counter, so the second and third portal re-apply them and only the
   * third changes anything. The third consequence — the enraged creature — is
   * entirely inside `creatureStep`, which is handed the same flag every frame.
   */
  _onPortalShut(id) {
    this.streetView.setPortalShut(id, true)
    this._applyDusk(this.state.dusk)
    // §10.3. The car has been standing at the far side of the map since Act I,
    // dark, and this is the only line in the codebase that lights it. It is
    // written off `state.finale` rather than off a portal count so that the
    // "third and only the third" decision is made once, in `rules.js`.
    this.streetView.setHeadlights(this.state.finale)
    // §13 gives a portal shutdown no bell of its own: the sound of a shutdown is
    // its hum falling an octave and stopping, which the routed `portalHum` row does
    // from `state.progress` and `state.portals` on the very next frame. v1 rang a
    // toll here, and v1's toll was a *timer* — a fourth source for the one sound
    // §13 says has three. The finale has no row either: it is heard as the last
    // hum stopping and the drone carrying on underneath it.
  }

  _refreshColliders() {
    if (this.streetView.revision === this._colliderRevision) return
    this._colliderRevision = this.streetView.revision
    this.player.setColliders(this.streetView.colliders())
  }

  /**
   * _updateCreature — §6.1, one frame, driven entirely by the pure module.
   *
   * The world's whole job here is to answer three questions the module asks and
   * then get out of the way: what did the player just do that was loud, can the
   * creature see them, and how far away are they. Everything else — the meter, the
   * transitions, the capture test, the banish ladder — is `creature.js`.
   *
   * Positions are CANONICAL. `reemergeNode` and `streetNodeToWorld` both speak in
   * the folded frame, and so do the occluders the sight tests need, so the
   * creature's position is canonical too and every distance to the player goes
   * through `wrapDelta`. That is the seam §3.3's fold was built to leave.
   *
   * Slice 10 hands `frame.swing` over and reads three presentation signals off the
   * step: `phaseOut` for §8.2's departure, the banish for §7.4's, and the
   * `dormant -> stalk` edge for §8.3's arrival. None of them are decisions — every
   * one of them has already been made by the time this method is called.
   */
  _updateCreature(dt) {
    const player = { x: this.player.pos.x, z: this.player.pos.z, yaw: this.player.yaw }
    const from = this.creaturePosition
    // The drawn frame, and it is the *distance* that needs it, not just the sight.
    //
    // Slice 15's balance simulation found this one by noticing that the game could
    // not lose: an enraged creature at 5.2 m/s behind a walking player, and the
    // capture test still never fired. `creaturePosition` is canonical and the
    // player's is not, and the two frames are a half-period apart, so the
    // difference between them is inflated by up to 448 m — the capture radius is
    // 1.1 m, so the test was reading "not close" for a creature standing on the
    // player. Every number derived from it was wrong in the same direction: the
    // awareness meter's distance, the HUD's proximity tell, the hammer's reach.
    //
    // `worldOf(from, player)` is the copy of the creature that is drawn around the
    // player, so the distance measured from it to the player is the one both of
    // them can see. The note below on the sight tests is the same fact.
    const drawn = this.streetView.worldOf(from, player)
    const distance = beast.distanceBetween(drawn, player)
    // §8.3's re-emergence speaks the *canonical* frame, because that is the frame
    // its answer is in: `reemergeNode` returns `streetNodeToWorld(id)` and this
    // file stores that straight into `creaturePosition`, which is canonical by
    // the same contract. So its occluders are the canonical ones.
    //
    // The two sight tests below are the opposite case and want the *drawn* frame,
    // and the difference is the bug this slice fixed: a distance can cross the
    // seam because `wrapDelta` folds it, but a bearing cannot. See the note.
    const occluders = this.streetView.canonicalOccluders()
    const range = beast.detectionRange(this.creature.tier, this.creature.reemergenceCount)
    // The two *directional* tests need the drawn frame, and this is the same
    // mistake the placement had (slice 14). A distance can cross the seam because
    // `wrapDelta` folds it, but a bearing cannot: `inSightCone` and `canSee` take
    // two points and a yaw and subtract them, so handing them a canonical
    // creature and an unfolded player measures the angle between two different
    // copies of the same intersection. §3.3's seam is real, and a cone test is
    // exactly the kind of thing that walks straight off it. `worldOfNear` is the
    // same fold `_updateCreatureView` already applies to draw the figure, which
    // is the check that matters here: the AI must agree with the picture, or a
    // creature the player can plainly see is "behind" them.
    //
    // (The duplicate `drawn` that used to be computed here is gone: the fold above
    // is the same fold, and a second copy of the same number is a second thing to
    // keep right.)

    // §6.2: whatever the player queued, plus whatever the world queued
    for (const event of this.player.drainSounds()) this.soundEvents.push(event)
    // AND THE DISTANCE, which is the sixth and worst of the frame bugs, and the one
    // that made Act II unmeasurable rather than merely mis-tuned.
    //
    // `player.js` says it plainly: "The world owns the creature's position, so it
    // owns the distance and the awareness integration; this file only says what
    // happened and how far it carries." Every event is therefore `{kind, radius,
    // position}` and no more, and `awarenessStep` reads `event.distance` with a
    // default of 0 — so a footstep was heard at FULL STRENGTH from anywhere in a
    // 448 m neighbourhood. §6.2's whole table is distances: a walk carries 9 m, a
    // sprint 22, a toll 30, a shutdown 25, and every one of them was being applied
    // at 0 m. The creature therefore knew where the player was at all times, from
    // the first Act II footstep, which is §10.2's ENRAGED property handed to every
    // state in the game.
    //
    // It is invisible in code review because `awarenessStep`'s default is defensible
    // in isolation and every pure test passes a distance explicitly. It is visible
    // the moment anyone plays: the balance simulation logged a chase beginning at
    // 279 m, an awareness meter at 1.00 with the creature two hundred metres off, and
    // 88% of Act II spent with the thing on the field and unable to reach anyone.
    // §8.2's twelve-second valve fired before the creature could cross the gap it was
    // given, so the run was 17 seconds of on-field per 19-second cycle and no
    // contact ever — which is why the hammer was never swung and §7.4's ladder never
    // moved a rung. Sound acquires; it does not acquire across four blocks.
    //
    // The fold is the one below, not `distanceBetween`: the same seam, the same
    // reason, and `wrapDelta` is the module's own definition of proximity. The
    // listener is the creature, not the player — `soundStrength` is "how loud an
    // event is at `distance`", and the event is the player's footstep, so the
    // distance that prices it is the creature's.
    const sounds = this.soundEvents.map((event) => ({
      ...event,
      distance: event.position
        ? Math.hypot(beast.wrapDelta(event.position.x, drawn.x), beast.wrapDelta(event.position.z, drawn.z))
        : Infinity,
    }))
    this.soundEvents = []

    const removed = this.creature.state === 'dormant' || this.creature.state === 'stagger'
    if (removed) this.banishElapsed += dt
    else this.banishElapsed = 0

    const step = beast.creatureStep(this.creature, dt, {
      sounds,
      // `drawn`, not `from`: see the fold note above. The occluders come from
      // `occluders()` rather than `canonicalOccluders()` for the same reason —
      // `lineOfSight` is a segment test, and a segment between a folded creature
      // and an unfolded player tested against canonical rects is a segment
      // through the wrong map.
      seen: beast.canSee(drawn, player, { range, occluders: this.streetView.occluders() }),
      sightDistance: distance,
      sightRange: range,
      playerPosition: player,
      distance,
      hammerPickup: this._hammerToll === true,
      // §7.4. The edge is consumed here, once, and the toll sound was already
      // queued by `_updateVerbs` — the hammer is heard *and* applied, which is why
      // a connected swing still announces itself to a creature that is no longer
      // listening
      swing: this._swingPending === true,
      finale: this.state.finale,
      // §6.1 in one call: the telegraph "is gone when you look back", so the
      // sighting is the view cone and nothing else — not the creature's detection
      // range, which belongs to the hunter it becomes in Act II
      sighting: beast.inSightCone(player, drawn),
      reemerge: removed && beast.reemergeReady(this.creature, this.banishElapsed),
      searchExhausted: false,
      searchPosition: null,
    })
    this._hammerToll = false
    this._swingPending = false
    // §13's swing outcome, for the audio frame. `null` on a frame with no swing,
    // and the three possible strings are the three rows of the table: a connect is
    // the banish toll, a miss or an Act I immunity is the whiff. Recorded *after*
    // the step so it is the answer rather than the request.
    this._swingResult = step.swing ? step.swing.result : null
    this.creature = step.creature
    // §7.4's ladder is run-long, and `rules.js` owns the run-level copy that §9.1
    // keeps across a capture. A connected swing is the *only* thing that advances
    // it, so it has to be written back before the mirror runs — otherwise the
    // mirror overwrites the increment the step just made, the counter stays on
    // zero for the whole run, and every banish buys the first rung's eight seconds
    // forever. This is the one line in the file that makes the ladder exist.
    if (step.swing && step.swing.result === 'banish') {
      this.state = { ...this.state, banishCount: step.creature.banishCount }
    }
    this.creature = { ...this.creature, banishCount: this.state.banishCount, tier: rules.portalsShut(this.state.portals) }
    this.creatureAwareness = step.awareness
    // §6.4's readout, quantized on the way into the store. The vignette tightens
    // on the grid in `hud.STEPS.awareness` rather than every frame, which is what
    // makes it a repaint a few times a second instead of sixty.
    this._awareness = hud.quantize(step.awareness, hud.STEPS.awareness)
    // §6.4 plus §7.4: a banished or dormant creature is off the field, so the
    // vignette it drives stops with it rather than following the player home
    this._creaturePresent = this.creature.state !== 'dormant' && this.creature.state !== 'stagger'
    // §14.3's counterpart to §7.4's banish toll and §7.2's awakening: the one
    // sigil in the game that flashes, so a deaf player sees the swing land
    if (step.swing && step.swing.result === 'banish') this.hammerFlash = 1

    // §6.1's split between the two kinds of hunting, and §10.2's. STALK walks at
    // its evidence; CHASE and ENRAGED walk at the player (`PURSUING_STATES`).
    // The gate is the list rather than a second `if` because the list is also
    // what `verify.mjs` asserts against `CAPTURE_STATES`: a state that can end
    // the run and is not in this list is a creature that catches you from
    // wherever it was standing, which is how the finale arrived with a 5.2 m/s
    // speed and no locomotion to spend it on.
    if (step.to === 'stalk' || beast.PURSUING_STATES.includes(step.to)) this._walkCreature(dt, player)
    if (step.to === 'dormant' && step.from !== 'dormant') this.banishElapsed = 0
    // §8.3's placement is owed to *every* re-emergence, and §10.2's re-emergence
    // is one: a banished ENRAGED comes back as `enraged`, so a gate written for
    // `stalk` alone would leave it standing wherever the banish caught it — in the
    // player's face, with §10.2's permanent knowledge already on. The state, not
    // the destination, is what the removal is.
    if (step.from === 'dormant' && (step.to === 'stalk' || step.to === 'enraged')) {
      this._reemerge(player, occluders)
      // §8.3 places it instantly; the arrival is faded in by the view so that a
      // teleport two blocks away reads as something arriving rather than as a
      // figure being switched on
      this.reemergeElapsed = 0
    }
    if (step.phaseOut) this._beginDismissal()
    else if (step.to === 'dormant' && step.from === 'stagger') this._beginDismissal()
    if (step.captured) this._capture()
  }

  /**
   * _beginDismissal — the figure is leaving, and §8.2 / §7.4 both need it seen.
   *
   * A removal the player cannot watch is a removal they will read as a stutter, and
   * §8.2 is the single most important rule in the anti-frustration section: the
   * whole reason being cornered is survivable is that the player watches the thing
   * that cornered them give up. The clock is presentation, so it lives here and
   * not in `creatureStep`.
   */
  _beginDismissal() {
    this.dismissing = true
    this.dismissElapsed = 0
  }

  /**
   * _walkCreature — one hop along the street graph, at the tier's speed.
   *
   * §6.1's STALK "ranges around" the last-heard point and CHASE closes; both are
   * the same walk here, because the difference between them is *which* point the
   * module hands over, and that choice is already made by the time we get here
   * — `pursuitTarget` is where it is made, and it is pure, and it is why the
   * finale is a chase rather than a coincidence. The creature is on the roads and
   * never off them, which is what makes the street graph the right thing to path
   * on at all.
   *
   * The speed comes from `creatureSpeed(tier, reemergenceCount)`, which is §11.1
   * clamped by §8.6's `SPEED_CEILING`: 5.2 m/s at the finale, against a 6.0 m/s
   * sprint. That gap is the design's whole escape plan, and it is the reason
   * `verify.mjs` asserts the ceiling sits strictly under the sprint — a number
   * that drifts by 0.1 turns the climax into a coin flip with no way to see it
   * from a screenshot.
   */
  _walkCreature(dt, player) {
    const target = beast.pursuitTarget(this.creature, player)
    if (!target) return
    // Both arguments are in the player's frame, and both have to be: `nextHop`
    // snaps a point to a node with `nodeId`, which folds a *world* coordinate into
    // the canonical frame — so a canonical `from` would be folded a second time and
    // the route would start at a node three blocks from the creature. Slice 15's
    // balance simulation is what found it, and the symptom was a creature that
    // chased the player perfectly and then walked confidently in the wrong
    // direction, which reads on screen as an AI that has given up.
    // A LOCKED LEG, and this is the second thing the simulation found.
    //
    // `nextHop` is a correct function of the creature's position, and asking it
    // every frame is still wrong: a creature walking a straight line between two
    // intersections spends most of the run exactly on the perpendicular Voronoi
    // boundary between two *other* nodes, where a 0.2 m wobble flips which node it
    // is standing on, flips the route, and sends it back the way it came. Measured,
    // the finale's first enraged chase alternated between two intersections for
    // twenty seconds and gained 70 m on the player. Nothing was stuck and nothing
    // threw; the thing simply never arrived, which is the one failure mode the
    // design cannot have (§10.2: "the challenge becomes reaching it while the
    // fastest thing in the world is behind you").
    //
    // So the creature commits to an intersection and walks to it, the way a person
    // crossing a street commits to the far kerb, and re-plans when it arrives or
    // when the player's own intersection changes — rate-limited, because that flip
    // has the same Voronoi boundary in it and a chase must not re-plan on a wobble.
    const here = this.streetView.worldOf(this.creaturePosition)
    const toNode = beast.nodeId(target)
    const direct = beast.graphDistance(here, target) <= DIRECT_APPROACH_HOPS
    const leg = direct || this.creatureLeg === null ? null : streetNodeToWorld(this.creatureLeg)
    const arrived = direct || leg === null || Math.hypot(
      beast.wrapDelta(this.creaturePosition.x, leg.x),
      beast.wrapDelta(this.creaturePosition.z, leg.z),
    ) < LEG_REACHED_METRES
    const retargeted = toNode !== this.creatureTargetNode && this.animTime - this.creaturePlannedAt > REPLAN_SECONDS
    if (arrived || retargeted) {
      this.creatureLeg = direct ? null : beast.nextHop(here, target)
      this.creatureTargetNode = toNode
      this.creaturePlannedAt = this.animTime
    }
    // A `null` leg is not "stand still". It means the creature and the player are
    // within a street of each other and the graph has no edge left to offer, because
    // there is nowhere left to walk *to*. §6.1's CHASE is a "direct approach at the
    // tier's top speed", and this is the frame where the direct approach is the whole
    // rule: the third thing the simulation found, and the reason the finale was
    // survivable at a walk. Without it the creature stands in a doorway while the
    // player walks past it, which is what every unlosable game looks like from the
    // inside.
    //
    // Both the step and the delta are taken in the DRAWN frame, and that is not
    // tidiness: the direct target is the player's world position and a leg is
    // canonical, so a single frame for the arithmetic is the only way both cases can
    // share these six lines. A translation does not change a delta, so the step is
    // still applied to the canonical position the rest of the file speaks.
    const next = this.creatureLeg === null
      ? target
      : this.streetView.worldOf(streetNodeToWorld(this.creatureLeg))
    // The step TOWARD the node, and the sign is the whole line.
    //
    // `wrapDelta(a, b)` is `a - b` folded onto the torus, so the vector from the
    // creature to where it is going is `wrapDelta(where, here)` — and the version
    // this line had before slice 15 asked for the opposite, which walked the
    // creature directly away from every node it routed to. Four bugs in one
    // function, all of them invisible in code review and all of them found by
    // playing the game a few hundred times: the frame, the Voronoi wobble, the
    // "no hop means stop", and this. The world's own creature check never caught any
    // of them because it asserts how far the creature moved and not which way.
    const dx = beast.wrapDelta(next.x, here.x)
    const dz = beast.wrapDelta(next.z, here.z)
    const step = Math.hypot(dx, dz)
    if (step < 1e-6) return
    const speed = beast.creatureSpeed(this.creature.tier, this.creature.reemergenceCount)
    const travel = Math.min(step, speed * dt)
    this.creaturePosition = {
      x: this.creaturePosition.x + (dx / step) * travel,
      z: this.creaturePosition.z + (dz / step) * travel,
    }
  }

  /** §8.3: come back at a distance, out of sight, knowing nothing. */
  _reemerge(player, occluders) {
    const spot = beast.reemergeNode({
      player: player,
      occluders,
      seed: this.seed,
      reemergenceCount: this.creature.reemergenceCount,
    })
    if (!spot) return
    this.creaturePosition = { x: spot.position.x, z: spot.position.z }
    this.creatureLeg = null
    this.creatureTargetNode = null
    this.banishElapsed = 0
  }

  /**
   * _updateCreatureView — the whole of the Act I → Act II → capture → reset
   * *presentation* cycle, in one method.
   *
   * Everything below the switch in `update` is a simulation that the rules already
   * settled; this is the one place that turns the result into something on screen,
   * and it is deliberately a single method so that "what does the game look like
   * right now" has exactly one answer to read.
   *
   * The four frame channels and where each comes from:
   *
   *  - `distance` and `bearing` are measured to the *drawn* position, because the
   *    eyes' pixel floor and §6.1's edge-of-vision angle are both statements about
   *    what reaches the screen, not about the folded canonical frame;
   *  - `dismiss` is the §8.2 phase-out and the §7.4 banish, both of which leave
   *    the creature `dormant` — a state that draws nothing — and both of which have
   *    to be seen;
   *  - `sinceReemerge` is §8.3's arrival;
   *  - `chaseSeconds` is §8.2's clock, used for the last-of-a-chase fade.
   *
   * The pose is computed by the pure module and the view only applies it. If this
   * method ever starts deciding something, the gate has stopped being able to see
   * it.
   */
  _updateCreatureView(dt) {
    if (!this.creatureView || this.creatureView.disposed) return
    const view = this.creatureView

    // §9.3: the creature reset happens behind the black, and the world holds still
    // behind the win card. Neither phase may show a figure. The title screen *may*
    // show the Act I apparition, because §6.1's first sighting is the only thing on
    // that screen that says there is something out here.
    const phase = this.store.get().phase ?? this.phase
    if (phase === PHASE.RESET || phase === PHASE.WON) {
      view.present(beast.creaturePose(null))
      return
    }

    if (this.dismissing) {
      this.dismissElapsed += dt
      if (this.dismissElapsed >= beast.FADE_SECONDS.dismiss) this.dismissing = false
    }
    this.reemergeElapsed += dt

    // the creature's position is CANONICAL (slice 09's note) and everything drawn
    // is not, so the fold happens here, in the one file that owns the wrap
    const drawn = this.streetView.worldOf(this.creaturePosition)
    const toCreatureX = this.player.pos.x - drawn.x
    const toCreatureZ = this.player.pos.z - drawn.z
    const distance = Math.hypot(toCreatureX, toCreatureZ)
    const bearing = Math.atan2(toCreatureX, toCreatureZ) - this.player.yaw
    // shortest-arc bearing, so a creature a few degrees behind the player's left
    // shoulder is reported as a few degrees *left* and not as 350 degrees right
    const signed = Math.atan2(Math.sin(bearing), Math.cos(bearing))
    // it faces where it is going, and the camera is the only thing that knows
    // which way "forward" is
    this._creatureFacing = Math.atan2(-toCreatureX, -toCreatureZ)

    const pose = beast.creaturePose(this.creature, {
      time: this.animTime,
      distance,
      elapsed: this.dismissElapsed,
      dismiss: this.dismissing ? 1 : 0,
      sinceReemerge: this.creature.state === 'stalk' ? this.reemergeElapsed : null,
      offset: view.flickerOffset,
      chaseSeconds: this.creature.chaseSeconds ?? 0,
      bearing: signed,
      viewHalfFov: view.viewOf(this.camera).viewHalfFov,
      view: view.viewOf(this.camera),
    })
    view.present(pose, { position: drawn, yaw: this._creatureFacing, camera: this.camera })
  }

  /**
   * _firstSightingPoint — Act I opens with a sighting.
   *
   * Placed by the *opposite* rule to a re-emergence, which is the reason the method
   * exists at all and why it cannot be folded into `_reemerge`.
   *
   * §8.3 exists so that something coming back is never a jump scare: minimum graph
   * distance, never in line of sight. A telegraph is the deliberate exception —
   * §6.1 says it "appears at long range and is gone when you look back", which is
   * only a sentence if you can see it. So the distance floor is kept (§8.3's, so
   * the two never disagree about how far is far enough) and the sight rule is
   * inverted: the node must be inside the player's view cone.
   *
   * THE WRAP IS PART OF THE CONE TEST (slice 14)
   * --------------------------------------------
   * This method used to test `inSightCone` against the *canonical* node position
   * and fall back to the spawn point when nothing passed. That fallback is what
   * §6.1 cannot survive: a telegraph standing at distance zero is not a sighting
   * at long range, it is a shape inside the player's own head, and because
   * `inSightCone` returns `true` at zero distance ("it is standing on the
   * creature, and the cone question is moot") the sighting could then never end.
   * The Act I apparition stayed on screen for the whole of Act I, which is how a
   * world check caught it: §6.1's "gone when you look back" is an assertion, and
   * the creature it was written against never left.
   *
   * The cause is the fold. §3.3's canonical frame is 32 m out of step with the
   * draw window (see `streetView.js`'s `WINDOW_MIN`), so the canonical position of
   * a node two blocks *east* of the spawn is 380 m west of the player, and the
   * whole eastern half of the map is behind the spawn cone. Folding each
   * candidate into the copy the player is standing in before testing it is the
   * same arithmetic `worldOf` does everywhere else, and with it the pool is 42
   * nodes wide instead of 1.
   *
   * The position *stored* is still the canonical one, because that is the frame
   * the creature's position is canonical in and every distance to the player goes
   * through `wrapDelta` (§3.3's seam). Only the test needed the fold.
   *
   * The pick is hashed, not random, because a run's first apparition should be the
   * same apparition every time it is replayed with the same seed. It is hashed
   * over the *node id*, not over the position's index, so a seed replays the same
   * apparition even if the pool is later reordered.
   */
  _firstSightingPoint() {
    // `SPAWN.position` is canonical, and `nodeId` reads the frame the player is in,
    // so the sighting is placed from the spawn's *world* copy. It is the same
    // arithmetic `worldOf` does everywhere else, and it is the reason the pool
    // below is 42 nodes wide rather than one: fold it wrongly and the cone is
    // measured from a point on the other side of the map.
    const facing = { x: SPAWN.position.x, z: SPAWN.position.z, yaw: SPAWN_YAW }
    const from = beast.nodeId(this.streetView.worldOf(SPAWN.position))
    const hops = hood.streetDistanceMap(from)
    const candidates = []
    for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
      if (hops[id] < beast.REEMERGE_MIN_GRAPH_DISTANCE) continue
      const canonical = streetNodeToWorld(id)
      // the same three copies `streetView` draws, folded around the *spawn* rather
      // than around wherever the player happens to be standing: a placement is a
      // question about the world as it will be, and §3.3's seam means the two are
      // not the same question once the player has walked a period
      const folded = this.streetView.worldOfNear(canonical, facing)
      if (!beast.inSightCone(facing, folded)) continue
      // ...and the cone alone is not §6.1 either. "Appears at *long range*" is a
      // distance claim, and an intersection diagonally in front of the player is
      // 5.7 m away: close enough to be an ambush wearing a sighting's clothes.
      // The floor is the straight-line reading of §8.3's graph floor — the closest
      // `REEMERGE_MIN_GRAPH_DISTANCE` hops can lie is `BLOCK * sqrt(2)`, which is
      // the number `creature.js`'s own comment derives it from — so the two
      // placements cannot disagree about how far is far enough.
      if (Math.hypot(folded.x - facing.x, folded.z - facing.z) < MIN_SIGHTING_METRES) continue
      candidates.push({ id, position: canonical })
    }
    // §8.3's distance floor is the promise that is always satisfiable — it is a
    // property of the graph, not of where the player happens to be facing — so it
    // is what the fallback keeps, exactly as `reemergeNode` does. Returning the
    // spawn point here is what put a telegraph at distance zero.
    if (candidates.length === 0) return this._farthestSightingNode(hops)
    const pick = Math.floor(streamAt(this.seed ^ 0x7e1e6a01, from, 0)() * candidates.length)
    return { x: candidates[pick].position.x, z: candidates[pick].position.z }
  }

  /**
   * _farthestSightingNode — the last-resort placement, and it is a *distance*
   * one. §6.1 wants a sighting in view; §8.3's floor is the promise that cannot
   * fail, so when the cone is unsatisfiable the sighting goes to the far side of
   * the map and the player sees nothing until they walk. It is better to open Act
   * I with a silence than with a shape at zero metres.
   */
  _farthestSightingNode(hops) {
    let best = null
    let bestHops = -1
    for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
      if (hops[id] <= bestHops) continue
      bestHops = hops[id]
      best = streetNodeToWorld(id)
    }
    return best ? { x: best.x, z: best.z } : { ...SPAWN.position }
  }

  // -------------------------------------------------------------------------
  // capture (§9.1) and the win (§10.4)
  // -------------------------------------------------------------------------

  /**
   * _insideExit — §10.4's test, with the wrap translated.
   *
   * `checkExitWin` compares the player's position against `state.exitAnchor`, and
   * that anchor is canonical: the folded frame `neighborhood.js` places it in. The
   * player's position is not, because the player never wraps. So the frame is
   * translated here, in the one file that owns the wrap, and the rule itself stays
   * exactly the pure one slice 05 asserted and §10.4 promises is the same shape as
   * v1's `isInsideChamber`.
   */
  _insideExit() {
    const anchor = this.streetView.worldOf(this.state.exitAnchor.position)
    return rules.checkExitWin({ ...this.state, exitAnchor: { ...this.state.exitAnchor, position: anchor } }, this.player.pos)
  }

  /**
   * _capture — you were caught.
   *
   * `rules.applyCapture` is §9.1's table and it is applied wholesale: the run-long
   * ladder, the shut portals, the hammer and the finale all survive, the loop
   * counter goes up, and you go back to spawn. The two things this method adds
   * around it are the *churn* and the *time*: the fixture pass is permuted for
   * the new loop (§3.6 — the streets stay exactly where they were and every
   * car, hedge and bin moves), and the cross-fade covers the swap.
   *
   * Breath is deliberately untouched, and that is not an oversight: `teleport`
   * does not touch it either, because §9.1's right-hand column is short on
   * purpose and breath is in neither column. Being caught costs you where you
   * were, not how tired you are.
   *
   * The presentation resets with everything else, and it resets to *absent* rather
   * than to Act I's sighting. §9.3 says the creature reset happens behind the
   * black, and the cross-fade is 1.1 s — exactly the length of the dismissal
   * window — so the figure that hunted you is already gone before the screen
   * starts going down, and the apparition that greets you out of the black is
   * placed fresh, at the new loop's hashed sighting.
   */
  _capture() {
    this.state = rules.applyCapture(this.state)
    this.creature = beast.createCreature({
      state: this.state.hammerHeld ? 'stalk' : 'telegraph',
      // §7.2: the awakening survives a capture with the hammer, or the player would
      // come back out of the black as an apparition again
      awakened: this.state.hammerHeld === true,
      tier: rules.portalsShut(this.state.portals),
      banishCount: this.state.banishCount,
      finale: this.state.finale,
    })
    this.creaturePosition = this._firstSightingPoint()
    this.creatureLeg = null
    this.creatureTargetNode = null
    this.soundEvents = []
    this.hammerHold = 0
    this.banishElapsed = 0
    this._hammerToll = false
    this._swingPending = false
    this._swingResult = null
    this._footstep = null
    this._hammerPickup = false
    this._portalNoise = false
    // behind the black, per §9.3: no dismissal is drawn, the figure is simply not
    // there any more, and the arrival clock starts run-out so the next Act I
    // sighting is fully solid the moment the screen comes back
    this.dismissing = false
    this.dismissElapsed = beast.FADE_SECONDS.dismiss
    this.reemergeElapsed = beast.FADE_SECONDS.reemerge
    this.creatureView?.present(beast.creaturePose(null))
    // §6.4: the creature the vignette was reading is gone, so the readout is too
    this._awareness = 0
    this._creaturePresent = false
    // §14.2: a capture interrupts a hold, and the ring must not resume it
    this._hold = 0
    this.addShake(0.9)
    this.player.enabled = false
    this.player.teleport(SPAWN.position.x, SPAWN.position.z, SPAWN_YAW)
    // the streets do not move and the objectives do not move; the dressing does
    this.streetView.applyLoop(this.state.loop)
    // the whole world folds at once, creature included: see `_recentre`, and the
    // frame bug that made a finale capture invisible to the game that decided it
    this._recentre()
    this.resetElapsed = 0
    this.fade = 1
    this.store.set({ phase: PHASE.RESET, fade: 1 })
    this._applyDusk(this.state.dusk)
    // §13: the capture's sting is a toll and not a fade cue, and it is *routed* —
    // `_updateAudio` sees the flag on this same frame, after the phase has already
    // moved to the black, which is exactly why `loopReset` is the one cue that
    // does not require `playing`. v1 rang three tolls here under a 2.35 s fade;
    // §9.3 keeps almost the same timeline and the sting is now one strike.
    this._loopReset = true
  }

  _updateReset(dt) {
    this.resetElapsed += dt
    const half = CAPTURE_FADE_SECONDS / 2
    this.fade = this.resetElapsed < half ? this.resetElapsed / half : Math.max(0, 1 - (this.resetElapsed - half) / half)
    if (this.resetElapsed < CAPTURE_FADE_SECONDS) return
    this.player.enabled = true
    this.fade = 0
    this.store.set({ phase: PHASE.PLAYING, fade: 0 })
  }

  /**
   * _win — §10.4. Inside the exit, with the finale running, the run is over.
   *
   * The whole geometry is one call into `rules.checkExitWin`, deliberately the
   * same shape as v1's `isInsideChamber` so the benchmark's "keep the win
   * condition comparable between runs" is literally true. The freeze matters as
   * much as the chord: PHASE.WON is a simulation state, so `update` stops moving
   * the player and the world holds still behind the card.
   *
   * Three things happen, in this order, and the order is the whole method:
   *
   *  1. **the player stops.** `enabled = false` is what makes the freeze real
   *     rather than decorative — it is checked by `PlayerController.update`, and
   *     it also drops the held keys, so a walk into the car is not a walk that
   *     resumes behind the card.
   *  2. **the phase moves.** The store is the only place the phase lives, and
   *     `update` reads it at the top of every frame, so the very next frame is
   *     `_updateWon` and nothing else runs.
   *  3. **the chord rings.** Once, on this frame, and the guard below is what
   *     makes "once" a fact rather than an observation: a world that is inside
   *     the exit car keeps being inside the exit car for as long as the player
   *     would have stood there, and an unguarded `_win` would ring a C major
   *     chord on every one of those frames.
   *
   * §13's table has no win row, so this is the one sound the world reaches for
   * directly — v1's chord, kept, on the design's own instruction that the bell
   * "crosses as the *player's* instrument". The drone is still routed, not
   * called: `won` is a field on the frame, and `droneLevelFor` is what pulls it
   * down to v1's duck. The pure gate pins both halves of that.
   *
   * @returns {boolean} whether this call is the one that ended the run
   */
  _win() {
    // the store, not `this.phase`: `this.phase` is only refreshed at the top of a
    // frame, so it is still PLAYING on the frame this method sets WON and a
    // second call in the same frame would ring the chord twice
    if (this.store.get().phase === PHASE.WON || this.paused) return false
    this.player.enabled = false
    this.store.set({ phase: PHASE.WON, prompt: null })
    this.audio?.winChord()
    return true
  }

  /**
   * The world holds still behind the win card; only the fade keeps moving.
   *
   * §10.4's freeze, and it is a freeze of *everything*: no `player.update`, no
   * `creatureStep`, no hold, no re-emergence clock, no lamp flicker. The one
   * thing that moves is the fade, and it is the only thing that should — the
   * card is over a world that has stopped, and a world that kept running behind
   * a victory screen is a world that can still catch you.
   */
  _updateWon(dt) {
    this.fade = Math.min(0.6, this.fade + dt * 0.8)
  }

  // -------------------------------------------------------------------------
  // the HUD mirror
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // §14.3 — pause, motion sensitivity, and the tells that need a clock
  // -------------------------------------------------------------------------

  /**
   * setPaused — §14.3's pause, and the one place the flag is written.
   *
   * Two things happen here and neither of them is optional. Pointer lock is
   * *released* on the way in, because a game that is paused and still swallowing
   * mouse movement is a game the player cannot use the menu in; and the grace
   * window is armed on the way out, because asking for the lock again takes a
   * round trip that fires a second `pointerlockchange` on the way, which would
   * otherwise pause the game the instant the player resumed it.
   *
   * The held keys are dropped, and with them the pending swing, because a pause
   * caught mid-hold would otherwise resume as a shutdown the player never
   * finished, and one caught mid-click would resume as a banish. §8.2's whole
   * argument is that a removal is something the player watches happen; inventing
   * a removal they did not ask for is the same failure wearing a different hat.
   *
   * The swing is discarded through `releaseAllKeys` rather than through
   * `consumeSwing`, and that is not a detail: `consumeSwing` is the door that
   * *performs* a swing and fires the callback, so using it to throw one away
   * would banish something on the frame the player opened a menu. Dropping the
   * flag without taking the edge is the only version of this that is free.
   */
  setPaused(paused) {
    const next = paused === true
    if (next === this.paused) return false
    this.paused = next
    if (next) {
      this.player.releaseAllKeys()
      this._hold = 0
      this._prompt = null
      // `paused` first, so the lock-change this causes is a no-op
      this._lockGraceUntil = this.animTime + LOCK_GRACE_SECONDS
      if (typeof document !== 'undefined') document.exitPointerLock?.()
    } else {
      this._lockGraceUntil = this.animTime + LOCK_GRACE_SECONDS
      this.player.requestLock()
    }
    this.store.set({ paused: next })
    return true
  }

  /** Esc, and the pause card's RESUME. */
  togglePause() {
    return this.setPaused(!this.paused)
  }

  /**
   * setReducedMotion — §14.3's motion-sensitivity toggle, from the pause menu.
   *
   * The *preference* is stored and the *resolved* value is applied, and the
   * difference is the whole reason there are two fields: a player who has asked
   * their operating system for reduced motion and then pressed the button in this
   * game has expressed a preference this game is entitled to honour, and a
   * second press puts them back where the OS had them. Resolving both in
   * `hud.resolveReducedMotion` is what keeps the button's own label honest.
   */
  setReducedMotion(reduced) {
    this.motionPreference = reduced === true
    this._applyMotionPreference()
    this.store.set({ motionPreference: this.motionPreference })
  }

  /**
   * _applyMotionPreference — resolve, then push the result at everything that moves.
   *
   * The resolution itself is `hud.js`'s (it has to be, because the HUD needs the
   * same answer to decide whether to paint a pulse), and the three consumers are
   * the three rows of `motionFlags`: the head bob, the camera shake and the
   * finale effects. The player is told through its own setter so that the camera
   * updates on the same frame rather than on the next stride.
   */
  _applyMotionPreference() {
    const system = this._motionQuery?.matches === true
    this.reducedMotion = hud.resolveReducedMotion({ preference: this.motionPreference, system })
    this._motion = hud.motionFlags(this.reducedMotion)
    this.player?.setHeadBob(this._motion.headBob)
    if (!this._motion.cameraShake) this.shake = 0
    if (!this._motion.finaleEffects) this.finaleEffect = hud.finaleEffectInit()
    this.store.set({ motionPreference: this.motionPreference, reducedMotionSystem: system })
  }

  /**
   * _updateHudTells — the two §14.3 effects that need to be *ticked*.
   *
   * Everything else the HUD shows is state, read straight off the simulation.
   * These two are decays: the banish/pickup sigil flash, which has to fall away
   * on a clock, and the finale's screen-effect level, which §14.3 requires to be
   * rate-limited. Both are pure functions of their own state in `hud.js`, so this
   * method is the world's only job: own the clock, hand over `dt`, keep the
   * result.
   */
  _updateHudTells(dt) {
    const flash = hud.flashDecay(this.hammerFlash, dt, { reducedMotion: this.reducedMotion })
    this.hammerFlash = flash.level
    this._flashAmplitude = flash.amplitude
    if (!this._motion.finaleEffects) return
    this.finaleEffect = hud.finaleEffect(this.finaleEffect, dt, this.state.finale, {
      reducedMotion: this.reducedMotion,
    })
  }

  // -------------------------------------------------------------------------
  // the HUD mirror
  // -------------------------------------------------------------------------

  /**
   * _syncHud — the store write that is the only channel to React.
   *
   * The projection itself is `hud.js`'s, and so is the decision of *how often*
   * this runs: every continuous value is quantized to the grid in `hud.STEPS`
   * before it is written, because `createStore` skips notifying when every patched
   * key is `===` and a raw awareness number would re-render the whole HUD sixty
   * times a second to redraw three identical sigils.
   *
   * The `portals` map is the one object value, and a fresh object is never `===`
   * to the old one — so it is written only when its *contents* move, which is
   * what the key below tracks. That is v1's `_candleKey` trick generalised from
   * "which shrines are lit" to "which sigils are out and how far the hold has
   * got", and it is the reason the key is a value string and not a comparison of
   * objects.
   */
  _syncHud() {
    // the phase comes from the store, not from the field `update` read at the top
    // of the frame: a phase that changes *during* the frame — the cross-fade
    // finishing, a win — would otherwise be written straight back over
    const phase = this.store.get().phase ?? this.phase
    const patch = {
      phase,
      loop: this.state.loop,
      fade: this.fade,
      prompt: this._prompt,
      hammerHeld: this.state.hammerHeld === true,
      // §14.3's flash travels as two numbers, because its two answers are two
      // numbers: a slower decay (held in `hammerFlash`, the world clock's job) and
      // a dimmer peak (held here). `hud.hammerMark` is where they meet.
      hammerFlash: this.hammerFlash,
      hammerFlashAmplitude: this._flashAmplitude,
      hold: hud.quantize(this._hold, hud.STEPS.hold),
      awareness: this._awareness,
      breath: this.player.breath,
      exhausted: this.player.exhausted === true,
      // §6.4 plus slice 11's banish rule: a removed creature stops being a
      // readout, so the vignette it drives has to stop with it
      creaturePresent: this._creaturePresent,
      finale: this.state.finale === true,
      finaleLevel: this.finaleEffect.level,
      paused: this.paused,
      motionPreference: this.motionPreference,
      reducedMotion: this.reducedMotion,
    }
    const key = hood.PORTAL_IDS.map((id) => `${this.state.portals[id] ? 1 : 0}${this._holdByPortal[id]}`).join('')
    if (key !== this._sigilKey) {
      this._sigilKey = key
      patch.portals = { ...this.state.portals }
    }
    this.store.set(patch)
  }

  /**
   * addShake / _applyShake — a temporary camera offset on top of the pose the
   * player just wrote.
   *
   * v1's screenshake, kept because a capture has to land: the alternative is the
   * screen going black while the world quietly permutes itself, which reads as a
   * bug rather than as a death. The amplitude decays every frame and is applied
   * *after* `player.update`, so it never fights the controller for the camera.
   *
   * §14.3's motion-sensitivity toggle gates it in *both* directions, and the
   * inbound gate matters as much as the outbound one: a capture under reduced
   * motion must not accumulate a shake that is then never applied, or turning
   * the setting back off mid-run would release a punch the player was not there
   * for.
   */
  addShake(amount) {
    if (!this._motion.cameraShake) return
    this.shake = Math.min(1, this.shake + amount)
  }

  _applyShake(dt) {
    if (!this._motion.cameraShake) {
      this.shake = 0
      return
    }
    if (this.shake <= 0.0005) {
      this.shake = 0
      return
    }
    this.shake = Math.max(0, this.shake - dt * 1.6)
    const t = this.animTime
    this.camera.position.x += Math.sin(t * 47) * this.shake * 0.06
    this.camera.position.y += Math.sin(t * 61 + 1.3) * this.shake * 0.05
    this.camera.position.z += Math.cos(t * 53) * this.shake * 0.06
  }

  // -------------------------------------------------------------------------
  // public API used by React
  // -------------------------------------------------------------------------

  /**
   * BEGIN: unfreeze, hand the camera to the player, and point-lock. No bell.
   *
   * v1 rang a toll here to open the loop, and slice 11 removed it, which is §13's
   * continuity claim read the other way round. v1's opening toll was the *world's*
   * clock announcing a sixty seconds; §13 keeps the bell and changes what it is
   * for — "it crosses as the *player's* instrument rather than the world's timer",
   * and §9 says there is no timer and no bell on a clock. So BEGIN is answered by
   * the drone coming up (`applyDrone`, on the first routed frame) instead, and
   * the first toll in a run is the awakening, which is the hammer's.
   */
  start() {
    if (this.startedOnce) return
    this.startedOnce = true
    this.player.enabled = true
    this.fade = 1
    this.store.set({ phase: PHASE.PLAYING, fade: 1, prompt: null })
    this.player.requestLock()
  }

  /**
   * BEGIN AGAIN — the one place a full wipe is correct (§10.4).
   *
   * Portals, the hammer, the banish ladder, the finale and the loop counter all
   * go back to their opening values; the fixtures permute back to loop 1, the
   * creature goes back to the Act I sighting, the fog goes back to dusk 0, the
   * car's headlights go off; and the player goes back to spawn.
   *
   * The run state is wiped by `rules.wipeRun`, which is §10.4's table, rather
   * than by rebuilding the object from `createInitialState` — the difference is
   * invisible at run time and enormous in the gate, because the table is walked
   * by `verify.mjs` and a constructor call cannot be walked by anything. It is
   * emphatically NOT `applyCapture`: §9.1's right-hand column is the list of
   * things a death never takes, and this is the one button that does take them.
   *
   * Three presentation clocks are cleared with it because the finale's ramp and
   * the sigil flash are level meters on a *run*, and a new run is a new meter.
   *
   * The pointer lock is re-requested here, from the click that pressed the
   * button: without it a new run starts un-walkable, because the win card is the
   * one screen in the game the player was never holding the lock on, and a world
   * that waits for a click they have already made is a world that reads as
   * broken. It is the same gesture-lock reason §14.3 gives for RESUME.
   */
  restart() {
    this.startedOnce = true
    this.state = rules.wipeRun(this.state, { loop: 1 })
    this.creature = beast.createCreature({ state: 'telegraph' })
    this.creaturePosition = this._firstSightingPoint()
    this.soundEvents = []
    this.hammerHold = 0
    this.banishElapsed = 0
    this._hammerToll = false
    this._swingPending = false
    this._swingResult = null
    this._footstep = null
    this._hammerPickup = false
    this._portalNoise = false
    this.dismissing = false
    this.dismissElapsed = beast.FADE_SECONDS.dismiss
    this.reemergeElapsed = beast.FADE_SECONDS.reemerge
    this.creatureView?.present(beast.creaturePose(null))
    this._prompt = null
    // §14.3: the same two tells, wiped with everything else. The finale's level
    // goes back to zero because §10.4's wipe is the one place a full reset is
    // correct, and the level only ever ramps back up on a new run's own clock.
    this.hammerFlash = 0
    this.finaleEffect = hud.finaleEffectInit()
    this._hold = 0
    this._holdByPortal = Object.fromEntries(hood.PORTAL_IDS.map((id) => [id, '0']))
    this._awareness = 0
    this._creaturePresent = false
    this.portalNoiseElapsed = Object.fromEntries(hood.PORTAL_IDS.map((id) => [id, 0]))
    for (const portal of this.streetView.portals) this.streetView.setPortalShut(portal.id, false)
    this.streetView.setHammerTaken(false)
    // §10.3 in reverse. `wipeRun` cleared the flag; this is the one line in the
    // codebase that puts the car back to the dark thing it was in Act I, and it
    // has to be here rather than derived, or a new run would open with the
    // beacon already on and the backrooms beat with it.
    this.streetView.setHeadlights(false)
    this.streetView.applyLoop(1)
    // teleport first, then fold: the creature's image is chosen against the player,
    // so a recentre taken before the player is at the spawn would fold it against
    // where the player used to be standing
    this.player.teleport(SPAWN.position.x, SPAWN.position.z, SPAWN_YAW)
    this._recentre()
    this._refreshColliders()
    this.player.enabled = false
    this._applyDusk(0)
    this.resetElapsed = 0
    this.fade = 1
    this.store.set({ phase: PHASE.RESET, fade: 1 })
    // §9.3's beat, unchanged: a new run is a capture in everything but name, and
    // it says so with the loop's own voice. `_updateReset` re-enables the player
    // when the black lifts, and the lock is asked for here while the click that
    // got us here is still a gesture.
    this.player.requestLock()
    this._loopReset = true
  }

  /**
   * tryInteract — one frame of the interact verb, for callers that cannot hold a
   * key. The browser never needs it: holding `E` is the whole verb (§5.2), and a
   * one-shot interact would quietly turn a two-beat commitment into a tap.
   */
  tryInteract(dt = 1 / 60) {
    if (this.phase !== PHASE.PLAYING || this.paused) return false
    this.player.pressKey('KeyE')
    this._updateVerbs(dt)
    this.player.releaseKey('KeyE')
    return true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('resize', this._onWindowResize)
    // optional calls: the headless world harness's DOM stub has no
    // `removeEventListener` on `document`, and this teardown must not be the
    // thing that changes *how* that harness fails
    document.removeEventListener?.('pointerlockchange', this._onLockChange)
    this._motionQuery?.removeEventListener?.('change', this._onMotionChange)
    this.canvas.removeEventListener('mousedown', this._onMouseDown)
    this._resizeObserver?.disconnect()
    this.player.dispose()
    this.streetView.dispose()
    // the hums are oscillators this file started, and nothing else will ever stop
    // them: the game is gone and its per-portal voices go with it. The drone and
    // the ambience belong to the AudioManager's lifetime, not to the world's, so
    // they are deliberately left alone here
    this.audio?.stopPortalHums?.()
    // before the scene traversal below, and it removes its own root first, so the
    // traversal never sees these geometries and disposes them a second time
    this.creatureView?.dispose()
    const seenTextures = new Set()
    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
      for (const material of materials) {
        for (const key of ['map', 'bumpMap', 'roughnessMap']) {
          const texture = material[key]
          if (texture && !seenTextures.has(texture)) {
            seenTextures.add(texture)
            texture.dispose()
          }
        }
        material.dispose()
      }
    })
    this.renderer.dispose()
    this.canvas.parentNode?.removeChild(this.canvas)
  }
}

/**
 * v1's name, still exported.
 *
 * `App.jsx` imports the v2 class under this name so that the swap is a single
 * changed line (GAMEDESIGN §15.1), and `verify-world.mjs` still reaches for it —
 * that harness is broken at the base commit and slice 14 owns the repair, so
 * leaving the name resolvable keeps its failure the *same* failure rather than a
 * new one. Slice 16 deletes it with the rest of v1.
 */
export const BellLoopGame = LongQuietGame

export default LongQuietGame
