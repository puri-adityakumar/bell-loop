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
 * `PHASE` and `createStore` only, from `loop.js`. §10.5 is explicit that `PHASE`
 * keeps its meaning — start / playing / reset / won — and that the finale is a
 * flag rather than a fifth phase, so re-typing four string constants here to make
 * a module look clean would be the worst of both worlds: a second definition of
 * the phase machine, and an `App.jsx` diff larger than the one line the design
 * promised. `LOOP_SECONDS` was the third import until slice 12: it existed only
 * to pin the v1 countdown full, because v2 has no countdown. Everything else in
 * `loop.js` — candles, the door, the wall rise, the heartbeat projection — is
 * dead code, and so is all of `maze.js`. Slice 16 deletes both files and folds
 * `PHASE` into wherever the HUD ends up.
 */
import * as THREE from 'three'
import { createStore, PHASE } from './loop.js'
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

/** Point lights given to the sodium lamps; the rest of the grid is unlit. */
const LAMP_LIGHTS = 4
/** How far a lamp light reaches before the pool stops looking for another. */
const LAMP_RADIUS = 40

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
    // which wants slightly more of it, and the dusk curve takes it down from there
    this.renderer.toneMappingExposure = 0.95
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
    // `loop.js`: the phase machine is the game's four moments and the world
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
    this.hemisphere = new THREE.HemisphereLight(PALETTE.skyStops[0], 0x0d0b12, 0.5)
    this.scene.add(this.hemisphere)

    this.sunset = new THREE.DirectionalLight(0x6b4a6b, 0.32)
    this.sunset.position.set(-1, 0.28, -0.6)
    this.scene.add(this.sunset)

    this.lampLights = []
    for (let i = 0; i < LAMP_LIGHTS; i += 1) {
      const light = new THREE.PointLight(PALETTE.sodium, 0, 30, 2)
      light.visible = false
      this.scene.add(light)
      this.lampLights.push(light)
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
    this.hemisphere.intensity = 0.5 - 0.22 * t
    this.sunset.intensity = 0.32 - 0.2 * t
    this.renderer.toneMappingExposure = 0.95 - 0.17 * t
  }

  /**
   * _updateLampPool — the sodium family, re-aimed every frame.
   *
   * Only re-aimed when the set of nearest lamps changes, which for a player
   * walking at 3.6 m/s is a couple of times a second rather than 60 times.
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
      light.intensity = 16
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
    this.fade = Math.max(0, this.fade - dt * 0.7)
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
    if (this.state.finale && this._insideExit()) this._win()
  }

  /**
   * _recentre — hand the world the copy the player is standing in.
   *
   * Once per frame, and a no-op unless the player has crossed a half-period
   * boundary, which is every 448 m of walking. This is the only place the wrap
   * moves, and the reason the player never has to: their coordinates run
   * monotonically and the world slides behind them instead.
   */
  _recentre() {
    this.streetView.recentre(this.player.pos.x, this.player.pos.z)
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
   * §5.4's permanent record of progress. The dusk step and the headlights are the
   * finale's *visible* consequences; the enraged creature that follows them is
   * slice 13's business, and it is entirely inside `creatureStep`.
   */
  _onPortalShut(id) {
    this.streetView.setPortalShut(id, true)
    this._applyDusk(this.state.dusk)
    this.streetView.setHeadlights(this.state.finale)
    // §13 gives a portal shutdown no bell of its own: the sound of a shutdown is
    // its hum falling an octave and stopping, which the routed `portalHum` row does
    // from `state.progress` and `state.portals` on the very next frame. v1 rang a
    // toll here, and v1's toll was a *timer* — a fourth source for the one sound
    // §13 says has three.
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
    const dx = beast.wrapDelta(from.x, player.x)
    const dz = beast.wrapDelta(from.z, player.z)
    const distance = Math.hypot(dx, dz)
    const occluders = this.streetView.canonicalOccluders()
    const range = beast.detectionRange(this.creature.tier, this.creature.reemergenceCount)

    // §6.2: whatever the player queued, plus whatever the world queued
    for (const event of this.player.drainSounds()) this.soundEvents.push(event)
    const sounds = this.soundEvents
    this.soundEvents = []

    const removed = this.creature.state === 'dormant' || this.creature.state === 'stagger'
    if (removed) this.banishElapsed += dt
    else this.banishElapsed = 0

    const step = beast.creatureStep(this.creature, dt, {
      sounds,
      seen: beast.canSee(from, player, { range, occluders }),
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
      sighting: beast.inSightCone(player, from),
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

    if (step.to === 'stalk' && this.creature.state === 'stalk') this._walkCreature(dt, player)
    if (step.to === 'dormant' && step.from !== 'dormant') this.banishElapsed = 0
    if (step.to === 'stalk' && step.from === 'dormant') {
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
   * module hands over, and that choice is already made by the time we get here.
   * The creature is on the roads and never off them, which is what makes the
   * street graph the right thing to path on at all.
   */
  _walkCreature(dt, player) {
    const target = this.creature.lastHeard ?? player
    const hop = beast.nextHop(this.creaturePosition, target)
    if (hop == null) return
    const next = streetNodeToWorld(hop)
    const dx = beast.wrapDelta(this.creaturePosition.x, next.x)
    const dz = beast.wrapDelta(this.creaturePosition.z, next.z)
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
   * The pick is hashed, not random, because a run's first apparition should be the
   * same apparition every time it is replayed with the same seed.
   */
  _firstSightingPoint() {
    const from = beast.nodeId(SPAWN.position)
    const hops = hood.streetDistanceMap(from)
    const facing = { x: SPAWN.position.x, z: SPAWN.position.z, yaw: SPAWN_YAW }
    const candidates = []
    for (let id = 0; id < hood.INTERSECTIONS; id += 1) {
      if (hops[id] < beast.REEMERGE_MIN_GRAPH_DISTANCE) continue
      const position = streetNodeToWorld(id)
      if (beast.inSightCone(facing, position)) candidates.push(position)
    }
    if (candidates.length === 0) return { ...SPAWN.position }
    const pick = Math.floor(streamAt(this.seed ^ 0x7e1e6a01, from, 0)() * candidates.length)
    return { x: candidates[pick].x, z: candidates[pick].z }
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
      tier: rules.portalsShut(this.state.portals),
      banishCount: this.state.banishCount,
      finale: this.state.finale,
    })
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
    this.streetView.recentre(SPAWN.position.x, SPAWN.position.z)
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
   */
  _win() {
    this.player.enabled = false
    this.store.set({ phase: PHASE.WON, prompt: null })
    this.audio?.winChord()
  }

  /** The world holds still behind the win card; only the fade keeps moving. */
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
   * Portals, the hammer, the banish ladder and the loop counter all go back to
   * their opening values, the fixtures permute back to loop 1, and the creature
   * goes back to the Act I sighting. The player goes back to spawn.
   */
  restart() {
    this.startedOnce = true
    this.state = rules.createInitialState(this.objectives, { loop: 1 })
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
    this._awareness = 0
    this._creaturePresent = false
    for (const portal of this.streetView.portals) this.streetView.setPortalShut(portal.id, false)
    this.streetView.setHammerTaken(false)
    this.streetView.setHeadlights(false)
    this.streetView.applyLoop(1)
    this.streetView.recentre(SPAWN.position.x, SPAWN.position.z)
    this._refreshColliders()
    this.player.teleport(SPAWN.position.x, SPAWN.position.z, SPAWN_YAW)
    this.player.enabled = false
    this._applyDusk(0)
    this.resetElapsed = 0
    this.fade = 1
    this.store.set({ phase: PHASE.RESET, fade: 1 })
    // the same beat as the capture (§13): the loop starts over, so it says so with
    // the loop's own voice. This is the *only* other caller of the reset cue, and
    // it is a caller because §10.4's wipe is a capture in everything but name.
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
