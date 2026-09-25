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
 * `PHASE`, `createStore` and `LOOP_SECONDS` only, from `loop.js`. §10.5 is
 * explicit that `PHASE` keeps its meaning — start / playing / reset / won — and
 * that the finale is a flag rather than a fifth phase, so re-typing four string
 * constants here to make a module look clean would be the worst of both worlds: a
 * second definition of the phase machine, and an `App.jsx` diff larger than the
 * one line the design promised. Everything else in `loop.js` — candles, the door,
 * the wall rise, the countdown — is dead code, and so is all of `maze.js`. Slice
 * 16 deletes both files and folds `PHASE` into wherever the HUD ends up.
 */
import * as THREE from 'three'
import { createStore, LOOP_SECONDS, PHASE } from './loop.js'
import { PlayerController } from './player.js'
import { PALETTE, StreetView } from './streetView.js'
import * as beast from './creature.js'
import * as rules from './rules.js'
import { streamAt } from './hash.js'
import * as hood from './neighborhood.js'
import { SPAWN, placeObjectives, streetNodeToWorld } from './neighborhood.js'

export { PALETTE }

/** Facing north-west, into the corner intersection the player spawns beside. */
const SPAWN_YAW = Math.PI * 0.25

/** The cross-fade at a capture, seconds. §9.3's beat, and the only one v2 has. */
const CAPTURE_FADE_SECONDS = 1.1

/** Point lights given to the sodium lamps; the rest of the grid is unlit. */
const LAMP_LIGHTS = 4
/** How far a lamp light reaches before the pool stops looking for another. */
const LAMP_RADIUS = 40

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
    this.player = new PlayerController(this.camera, this.canvas, {
      onFootstep: (sprinting) => this.audio?.footstep(sprinting),
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
    this.portalNoiseElapsed = 0
    /** One-frame flag: the hammer was picked up on this frame (§7.2's toll). */
    this._hammerToll = false
    this.creatureAwareness = 0
    this._lampKey = ''
    this._candleKey = ''
    this._prompt = null

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

    // --- input --------------------------------------------------------------
    // `E` and LMB are the two verbs of §5.2 and both belong to the player, which
    // is why neither is wired here: `player.js` turns them into an interact hold
    // and a swing edge, and the world consumes both once per frame.
    this._onKeyDown = (e) => {
      if (e.code === 'KeyF') this.store.update((state) => ({ ...state, showFps: !state.showFps }))
    }
    this._onMouseDown = () => {
      if (this.startedOnce && this.phase !== PHASE.WON && !this.player.locked) this.player.requestLock()
    }
    window.addEventListener('keydown', this._onKeyDown)
    this.canvas.addEventListener('mousedown', this._onMouseDown)

    this._onWindowResize = () => this.resize()
    window.addEventListener('resize', this._onWindowResize)
    this._resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this._resizeObserver?.observe(container)

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
    this._syncHud()
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
      if (!active) this.portalNoiseElapsed = 0
      if (!active || shutBefore) continue
      // §5.2: silent for the first half, then a 25 m sound event once per window
      // rather than once per frame
      this.portalNoiseElapsed += dt
      if (
        this.state.progress[entry.id] >= rules.PORTAL_NOISE_THRESHOLD &&
        this.portalNoiseElapsed >= beast.SOUND_EVENT_SECONDS
      ) {
        this.portalNoiseElapsed = 0
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

    // §7.4: a swing is a press, and the hammer answers to the creature, not the
    // world. With nothing in reach it is simply noise, which is the point —
    // swinging at the dark is how you get found.
    if (swing) {
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
    this.audio?.bellToll(0.1, 196, 0.5)
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
    this.audio?.bellToll(0.25, 330, 0.3)
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
   * Slice 10 adds the mesh. Until then this loop is invisible on purpose: §8.1's
   * promise is that Act I cannot kill you, and nothing in this method can end a
   * run while the hammer is untaken.
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
      swing: false,
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
    this.creature = step.creature
    this.creature = { ...this.creature, banishCount: this.state.banishCount, tier: rules.portalsShut(this.state.portals) }
    this.creatureAwareness = step.awareness

    if (step.to === 'stalk' && this.creature.state === 'stalk') this._walkCreature(dt, player)
    if (step.to === 'dormant' && step.from !== 'dormant') this.banishElapsed = 0
    if (step.to === 'stalk' && step.from === 'dormant') this._reemerge(player, occluders)
    if (step.captured) this._capture()
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
   * Act I opens with a sighting, and it is placed by the *opposite* rule to a
   * re-emergence.
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
    // §13 calls the capture sting a toll and not a fade cue, and a toll is the
    // only thing v1's audio manager can already play
    this.audio?.bellSequence(3, 0.7)
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

  /**
   * _syncHud — the slice of state the untouched v1 HUD happens to read.
   *
   * Slice 12 replaces all of this, and until it does there are two places where
   * v2 and the v1 HUD disagree and the world has to be the one that bends:
   *
   *  - `candles` is the three shrine sigils, and v2 has no shrines. The three
   *    portal sigils are the same three letters in the same order, so the HUD
   *    lights them as portals are shut. It is written only when the set changes,
   *    because a fresh object every frame would re-render React 60 times a
   *    second to redraw three identical flames.
   *  - `timeLeft` is the heartbeat line, and v2 has no countdown: the run ends
   *    when you are caught, not when a bell rings. It is pinned full, so the line
   *    sits still instead of reddening towards a deadline that does not exist.
   */
  _syncHud() {
    // the phase comes from the store, not from the field `update` read at the top
    // of the frame: a phase that changes *during* the frame — the cross-fade
    // finishing, a win — would otherwise be written straight back over
    const phase = this.store.get().phase ?? this.phase
    const patch = { phase, loop: this.state.loop, fade: this.fade, prompt: this._prompt }
    if (this.store.get().timeLeft !== LOOP_SECONDS) patch.timeLeft = LOOP_SECONDS
    const key = Object.keys(this.state.portals)
      .filter((id) => this.state.portals[id])
      .join('')
    if (key !== this._candleKey) {
      this._candleKey = key
      patch.candles = Object.fromEntries(Object.keys(this.state.portals).map((id) => [id, this.state.portals[id]]))
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
   * Slice 12's reduced-motion toggle suppresses this along with the head bob.
   */
  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount)
  }

  _applyShake(dt) {
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

  /** BEGIN: unfreeze, hand the camera to the player, first toll, pointer lock. */
  start() {
    if (this.startedOnce) return
    this.startedOnce = true
    this.player.enabled = true
    this.fade = 1
    this.store.set({ phase: PHASE.PLAYING, fade: 1, prompt: null })
    this.player.requestLock()
    this.audio?.bellToll(0, 220, 0.5)
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
    this._prompt = null
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
    this.audio?.bellSequence(3, 0.7)
  }

  /**
   * tryInteract — one frame of the interact verb, for callers that cannot hold a
   * key. The browser never needs it: holding `E` is the whole verb (§5.2), and a
   * one-shot interact would quietly turn a two-beat commitment into a tap.
   */
  tryInteract(dt = 1 / 60) {
    if (this.phase !== PHASE.PLAYING) return false
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
    this.canvas.removeEventListener('mousedown', this._onMouseDown)
    this._resizeObserver?.disconnect()
    this.player.dispose()
    this.streetView.dispose()
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
