/**
 * player.js — first-person controller: pointer lock, WASD, capsule-vs-AABB
 * collision against the maze walls, subtle head bob, footstep callbacks.
 *
 * The player is modelled as a vertical capsule: for movement we only need its
 * XZ circle (radius ~0.36m), and every wall is an axis-aligned box, so the
 * test is circle-vs-AABB against each box expanded by the radius. Movement is
 * resolved one axis at a time, which is what lets you slide along walls
 * instead of sticking to them.
 *
 * v2 (slice 08) adds the three things §5.2 and §7.3 ask of this file: the breath
 * meter with its sprint lockout, the exhausted-breathing sound event, and the two
 * verb keys — `E` interacts, `LMB` swings. None of the *rules* live here.
 * `breathStep` is imported from `rules.js` and the sound radii come from
 * `creature.js`'s §6.2 table, so the meter has one definition and the sound table
 * has one definition. What this file adds is the wiring: when the player is really
 * sprinting, when they are allowed to, and what the world hears them do.
 *
 * WHY IT IS STILL PURE ENOUGH FOR verify.mjs
 * ------------------------------------------
 * v2's pure harness imports this module directly, and the one thing that made that
 * impossible was the `three` import — for two vector objects. `Vec3`/`Vec2` below
 * are all the movement code ever needed, and they carry the two methods anything
 * outside this file calls (`set`, `clone`). The browser surface is now three
 * methods — `attach`, `dispose`, `requestLock` — which no simulation path calls:
 * the DOM listeners translate events into `pressKey` / `pressButton`, and that is
 * the same door the tests walk through, so a check cannot pass against a path the
 * game does not use.
 */
import { breathStep } from './rules.js'
import { soundRadius, SOUND_EVENT_SECONDS } from './creature.js'

/** A three-component vector. The only one v1's movement code ever used from THREE. */
class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }

  set(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  clone() {
    return new Vec3(this.x, this.y, this.z)
  }
}

/** Velocity is two-dimensional; `y` carries the Z component, as it always has. */
class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  set(x, y) {
    this.x = x
    this.y = y
    return this
  }

  clone() {
    return new Vec2(this.x, this.y)
  }
}

const KEY_FORWARD = ['KeyW', 'ArrowUp']
const KEY_BACK = ['KeyS', 'ArrowDown']
const KEY_LEFT = ['KeyA', 'ArrowLeft']
const KEY_RIGHT = ['KeyD', 'ArrowRight']
const KEY_SPRINT = ['ShiftLeft', 'ShiftRight']

/**
 * §5.2: the two verbs, and the reason they are two keys.
 *
 * `E` interacts — the portal shutdown is a *hold* (rules.js), and so is the hammer
 * pickup. `LMB` swings the hammer, and a swing is a *press*. One key cannot be both,
 * because the worst possible moment to attempt a banish is while already committed
 * to a portal shutdown — a single key would have to mean "shut this down" and "drive
 * it off" in the same breath. Keeping them apart makes the player choose which
 * commitment they are in.
 */
const KEY_INTERACT = ['KeyE']
const KEY_SWING = ['Mouse0'] // DOM button 0, the left button

/** DOM `MouseEvent.button` values, as pseudo-codes so keys and buttons share one set. */
const MOUSE_CODES = ['Mouse0', 'Mouse1', 'Mouse2']

export class PlayerController {
  /**
   * @param {THREE.PerspectiveCamera} camera the real game passes a THREE camera;
   *   nothing here needs a renderer, so the tests pass a stub with `position.set`
   *   and `rotation.set`. Annotated, not imported — that is the point.
   * @param {HTMLElement} domElement element that owns pointer lock (the canvas)
   * @param {object} [options]
   */
  constructor(camera, domElement, options = {}) {
    this.camera = camera
    this.dom = domElement

    this.radius = options.radius ?? 0.36
    this.eyeHeight = options.eyeHeight ?? 1.6
    this.walkSpeed = options.walkSpeed ?? 3.6
    this.sprintSpeed = options.sprintSpeed ?? 6.0
    this.accel = options.accel ?? 16
    this.sensitivity = options.sensitivity ?? 0.0021
    this.bobAmount = options.bobAmount ?? 0.035
    this.stepDistance = options.stepDistance ?? 1.7
    this.onFootstep = options.onFootstep ?? null
    /** §7.4: a connected swing, raised by LMB and consumed by the world (slice 09). */
    this.onSwing = options.onSwing ?? null

    this.pos = new Vec3(0, 0, 0) // y unused (the floor is flat)
    this.vel = new Vec2(0, 0)
    this.yaw = 0
    this.pitch = 0
    this.enabled = true
    this.locked = false
    this.travelled = 0 // metres since the last footstep
    this.bobPhase = 0
    this.speedRatio = 0

    // --- v2 slice 08: breath (§7.3) and the two verbs (§5.2) ------------------
    // `breath` and `exhausted` are the same two fields rules.js carries in its
    // state object, so a capture that copies one can copy the other. The meter is
    // never drawn (§7.3) — audio and a vignette are the only readout, which is the
    // HUD's problem in slice 12, not this file's.
    this.breath = options.breath ?? 1
    this.exhausted = options.exhausted ?? false
    /** Effective sprint, *after* the lockout. Never the raw key state. */
    this.sprinting = false
    /** The speed the lockout selected this frame, m/s. What the lockout gates. */
    this.commandSpeed = 0
    /** Rising edge of LMB, drained by `consumeSwing()`. */
    this.swingRequested = false
    /** §6.2 sound events the world has not picked up yet. */
    this.sounds = []
    /** Time toward the next exhausted-breath event window (§6.2). */
    this.breathTimer = 0

    this.keys = new Set()
    this.colliders = [] // pre-expanded XZ AABBs
    this._onKeyDown = (e) => this.pressKey(e.code)
    this._onKeyUp = (e) => this.releaseKey(e.code)
    this._onMouseMove = (e) => this._look(e)
    // Pointer lock is the "I am playing" signal, so the click that *acquires* lock
    // is not a swing and neither is a click on the title screen. The keyboard needs
    // no such guard: E is a hold, and a hold has no such ambiguity.
    this._onMouseDown = (e) => {
      if (this.locked) this.pressButton(e.button)
    }
    this._onMouseUp = (e) => this.releaseButton(e.button)
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom
      if (!this.locked) this.vel.set(0, 0)
    }
    this._bound = false
  }

  attach() {
    if (this._bound) return
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('mousemove', this._onMouseMove)
    this.dom.addEventListener('mousedown', this._onMouseDown)
    this.dom.addEventListener('mouseup', this._onMouseUp)
    document.addEventListener('pointerlockchange', this._onLockChange)
    this._bound = true
  }

  dispose() {
    if (!this._bound) return
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('mousemove', this._onMouseMove)
    this.dom.removeEventListener('mousedown', this._onMouseDown)
    this.dom.removeEventListener('mouseup', this._onMouseUp)
    document.removeEventListener('pointerlockchange', this._onLockChange)
    this._bound = false
  }

  // ---------------------------------------------------------------------------
  // input — the single door. The DOM listeners above and the pure harness both
  // come through here, which is what stops a check from testing a path the game
  // does not use.
  // ---------------------------------------------------------------------------

  /** A key went down. Auto-repeat is a non-event: no second edge, no second verb. */
  pressKey(code) {
    if (this.keys.has(code)) return
    this.keys.add(code)
    if (KEY_SWING.includes(code)) this.swingRequested = true
  }

  releaseKey(code) {
    this.keys.delete(code)
  }

  /** A mouse button went down: DOM button index to the same pseudo-code space. */
  pressButton(button) {
    const code = MOUSE_CODES[button]
    if (!code) return
    this.pressKey(code)
  }

  releaseButton(button) {
    const code = MOUSE_CODES[button]
    if (!code) return
    this.releaseKey(code)
  }

  /** §5.2: the interact verb, a *hold*. True while E is down. */
  interactHeld() {
    return this._pressed(KEY_INTERACT)
  }

  /** §5.2: the swing verb, a *press*. LMB is not an interact hold. */
  swingHeld() {
    return this._pressed(KEY_SWING)
  }

  /**
   * Take the pending swing, if any. Edge, not state: holding the button down is
   * one swing, and the caller has to come back for the next one.
   *
   * @returns {boolean}
   */
  consumeSwing() {
    if (!this.swingRequested) return false
    this.swingRequested = false
    this.onSwing?.()
    return true
  }

  /** Pointer lock must be requested from a user gesture (a click). */
  requestLock() {
    const el = this.dom
    try {
      const result = el.requestPointerLock?.({ unadjustedMovement: true })
      if (result && typeof result.catch === 'function') {
        // some browsers reject unadjustedMovement — fall back to the plain API
        result.catch(() => {
          try {
            el.requestPointerLock()
          } catch {
            /* pointer lock unavailable (embedded/headless) — mouse look stays off */
          }
        })
      }
    } catch {
      try {
        el.requestPointerLock()
      } catch {
        /* ignore */
      }
    }
  }

  /** Rebuild the collider list from the maze wall segments (plain data). */
  setColliders(wallSegments) {
    this.colliders = wallSegments.map((w) => ({
      minX: w.cx - w.hx - this.radius,
      maxX: w.cx + w.hx + this.radius,
      minZ: w.cz - w.hz - this.radius,
      maxZ: w.cz + w.hz + this.radius,
    }))
  }

  /**
   * Put the player somewhere. Position only: breath and the lockout are untouched,
   * because §9.1's right-hand column is short on purpose and breath is in neither
   * column — being caught costs you where you were, not how tired you are. A capture
   * that wants a full breath says so explicitly, in slice 09.
   */
  teleport(x, z, yaw = this.yaw) {
    this.pos.set(x, 0, z)
    this.vel.set(0, 0)
    this.yaw = yaw
    this.pitch = 0
    this.bobPhase = 0
    this.travelled = 0
    this._applyCamera()
  }

  _look(e) {
    if (!this.locked || !this.enabled) return
    this.yaw -= e.movementX * this.sensitivity
    this.pitch -= e.movementY * this.sensitivity
    const limit = Math.PI / 2 - 0.08
    if (this.pitch > limit) this.pitch = limit
    if (this.pitch < -limit) this.pitch = -limit
  }

  _pressed(codes) {
    for (const code of codes) if (this.keys.has(code)) return true
    return false
  }

  /** Unit vector the player looks along (XZ only) — used for interaction. */
  forwardXZ() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }
  }

  /** Push the player out of any wall it overlaps (needed after a maze rebuild). */
  _resolvePenetration(iterations = 2) {
    for (let pass = 0; pass < iterations; pass++) {
      let moved = false
      for (const box of this.colliders) {
        const x = this.pos.x
        const z = this.pos.z
        if (x <= box.minX || x >= box.maxX || z <= box.minZ || z >= box.maxZ) continue
        const pushLeft = x - box.minX
        const pushRight = box.maxX - x
        const pushBack = z - box.minZ
        const pushFront = box.maxZ - z
        const minPush = Math.min(pushLeft, pushRight, pushBack, pushFront)
        if (minPush === pushLeft) this.pos.x = box.minX
        else if (minPush === pushRight) this.pos.x = box.maxX
        else if (minPush === pushBack) this.pos.z = box.minZ
        else this.pos.z = box.maxZ
        moved = true
      }
      if (!moved) break
    }
  }

  _moveAxis(dx, dz) {
    this.pos.x += dx
    this.pos.z += dz
    this._resolvePenetration(1)
  }

  /**
   * Queue one §6.2 sound event.
   *
   * The radius is taken from the creature's own table — `soundRadius`, which is
   * `rules.breathSoundRadius` applied to `SOUND_RADII` — and never typed here, so
   * the player's idea of how loud it is and the AI's idea of how far it carries
   * cannot drift apart. That is the whole point of §7.3: the *same* function that
   * runs the meter decides what the meter costs you in noise.
   *
   * There is deliberately no `distance` field. Only the listener knows where it is.
   *
   * @param {'walk'|'sprint'|'still'} kind a row of the §6.2 table
   */
  _emitSound(kind) {
    this.sounds.push({
      kind,
      radius: soundRadius(kind, { exhausted: this.exhausted }),
      exhausted: this.exhausted,
      position: { x: this.pos.x, z: this.pos.z },
    })
  }

  /**
   * The exhausted-breathing event — §7.3's synthesis, and §6.2's last row, "+6 m
   * on top of the gait radius".
   *
   * These are two rows of the table, not one sound counted twice: the gait is a
   * per-stride event and this is a continuous source, and §6.2's `still` row is
   * precisely the exhausted-breathing event standing on its own. The consequence
   * is the one §7.3 wants — the *state* is the punishment, not the act of running.
   * Panicking still works; you simply pay for it in noise while already too tired
   * to move quietly. And the reason it bites hardest is the case the design is
   * actually about: a player who has stopped to listen behind a hedge, out of
   * breath, is still audible.
   *
   * A continuous source emits one event per `SOUND_EVENT_SECONDS` window rather
   * than one per frame — the same rule the creature applies to an open portal.
   * At most one per frame, so a long frame cannot machine-gun the window, and the
   * accumulator is cleared while the player is fresh, so the first gasp after a
   * sprint lands a whole window later rather than on the frame the meter empties.
   *
   * @param {number} dt seconds
   */
  _emitBreath(dt) {
    if (!this.exhausted) {
      this.breathTimer = 0
      return
    }
    this.breathTimer += dt
    if (this.breathTimer < SOUND_EVENT_SECONDS) return
    this.breathTimer -= SOUND_EVENT_SECONDS
    this._emitSound('still')
  }

  /**
   * Hand over the queued §6.2 events and start a fresh window. The world owns the
   * creature's position, so it owns the distance and the awareness integration;
   * this file only says *what happened* and *how far it carries*.
   */
  drainSounds() {
    if (this.sounds.length === 0) return []
    const events = this.sounds
    this.sounds = []
    return events
  }

  /**
   * @param {number} dt seconds
   * @returns {number} metres travelled this frame
   */
  update(dt) {
    const startX = this.pos.x
    const startZ = this.pos.z

    if (this.enabled) {
      // --- breath and the sprint lockout (§7.3) -----------------------------
      // ONE flag feeds both the meter and the speed, and it is `wantsSprint &&
      // !this.exhausted` *before* the tick, so there is no frame in which the
      // lockout is a flag the movement code failed to read. Holding Shift cannot
      // buy a single frame of sprint speed: `breathStep` refuses to drain while
      // exhausted, and the line below drops the speed on the frame the meter hits
      // the floor. The lockout is state, not key state — it lifts at
      // `BREATH_RECOVERY_THRESHOLD` whether the key is down or not, which is the
      // hysteresis that stops sprint-bobbing at 0.01 breath forever.
      const wantsSprint = this._pressed(KEY_SPRINT)
      let sprinting = wantsSprint && !this.exhausted
      const breath = breathStep(this.breath, this.exhausted, sprinting, dt)
      this.breath = breath.breath
      this.exhausted = breath.exhausted
      if (this.exhausted) sprinting = false
      this.sprinting = sprinting
      const speed = sprinting ? this.sprintSpeed : this.walkSpeed
      this.commandSpeed = speed

      const forward = (this._pressed(KEY_FORWARD) ? 1 : 0) - (this._pressed(KEY_BACK) ? 1 : 0)
      const strafe = (this._pressed(KEY_RIGHT) ? 1 : 0) - (this._pressed(KEY_LEFT) ? 1 : 0)
      let dirX = 0
      let dirZ = 0
      if (forward !== 0 || strafe !== 0) {
        const sin = Math.sin(this.yaw)
        const cos = Math.cos(this.yaw)
        // forward is -Z rotated by yaw; right is +X rotated by yaw
        dirX = -sin * forward + cos * strafe
        dirZ = -cos * forward - sin * strafe
        const len = Math.hypot(dirX, dirZ) || 1
        dirX /= len
        dirZ /= len
      }

      const k = 1 - Math.exp(-this.accel * dt)
      this.vel.x += (dirX * speed - this.vel.x) * k
      this.vel.y += (dirZ * speed - this.vel.y) * k

      if (Math.abs(this.vel.x) > 1e-4) this._moveAxis(this.vel.x * dt, 0)
      if (Math.abs(this.vel.y) > 1e-4) this._moveAxis(0, this.vel.y * dt)

      const speedNow = Math.hypot(this.vel.x, this.vel.y)
      this.speedRatio = Math.min(1, speedNow / this.walkSpeed)
      const moved = Math.hypot(this.pos.x - startX, this.pos.z - startZ)
      if (this.speedRatio > 0.15 && moved > 1e-5) {
        this.bobPhase += (moved / this.stepDistance) * Math.PI
        this.travelled += moved
        if (this.travelled >= this.stepDistance) {
          this.travelled -= this.stepDistance
          this.onFootstep?.(sprinting)
          // §6.2: a footstep is a sound event, and while exhausted the table makes
          // it a louder one. Nothing is emitted when `speedRatio` is low or the
          // player is not actually moving — standing still, or leaning on a wall,
          // is silence, and that is the strategy §6.2 depends on. The event and v1's
          // audio callback share one threshold so they cannot drift apart.
          this._emitSound(sprinting ? 'sprint' : 'walk')
        }
      }
      // a blocked player still has to stop bobbing
      if (moved < 1e-4) this.speedRatio *= 0.7
      this._emitBreath(dt)
    } else {
      this.sprinting = false
      this.commandSpeed = 0
    }

    this._applyCamera()
    return Math.hypot(this.pos.x - startX, this.pos.z - startZ)
  }

  _applyCamera() {
    const bob = Math.sin(this.bobPhase) * this.bobAmount * this.speedRatio
    const sway = Math.cos(this.bobPhase * 0.5) * this.bobAmount * 0.4 * this.speedRatio
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    // sway runs along the player's right-hand axis so it reads as a real step
    this.camera.position.set(this.pos.x + sway * cos, this.eyeHeight + bob, this.pos.z - sway * sin)
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }
}

export default PlayerController
