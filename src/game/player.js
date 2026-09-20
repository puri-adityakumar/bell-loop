/**
 * player.js — first-person controller: pointer lock, WASD, capsule-vs-AABB
 * collision against the maze walls, subtle head bob, footstep callbacks.
 *
 * The player is modelled as a vertical capsule: for movement we only need its
 * XZ circle (radius ~0.36m), and every wall is an axis-aligned box, so the
 * test is circle-vs-AABB against each box expanded by the radius. Movement is
 * resolved one axis at a time, which is what lets you slide along walls
 * instead of sticking to them.
 */
import * as THREE from 'three'

const KEY_FORWARD = ['KeyW', 'ArrowUp']
const KEY_BACK = ['KeyS', 'ArrowDown']
const KEY_LEFT = ['KeyA', 'ArrowLeft']
const KEY_RIGHT = ['KeyD', 'ArrowRight']
const KEY_SPRINT = ['ShiftLeft', 'ShiftRight']

export class PlayerController {
  /**
   * @param {THREE.PerspectiveCamera} camera
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

    this.pos = new THREE.Vector3(0, 0, 0) // y unused (the floor is flat)
    this.vel = new THREE.Vector2(0, 0)
    this.yaw = 0
    this.pitch = 0
    this.enabled = true
    this.locked = false
    this.travelled = 0 // metres since the last footstep
    this.bobPhase = 0
    this.speedRatio = 0

    this.keys = new Set()
    this.colliders = [] // pre-expanded XZ AABBs
    this._onKeyDown = (e) => this.keys.add(e.code)
    this._onKeyUp = (e) => this.keys.delete(e.code)
    this._onMouseMove = (e) => this._look(e)
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
    document.addEventListener('pointerlockchange', this._onLockChange)
    this._bound = true
  }

  dispose() {
    if (!this._bound) return
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('mousemove', this._onMouseMove)
    document.removeEventListener('pointerlockchange', this._onLockChange)
    this._bound = false
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
   * @param {number} dt seconds
   * @returns {number} metres travelled this frame
   */
  update(dt) {
    const startX = this.pos.x
    const startZ = this.pos.z
    let sprinting = false

    if (this.enabled) {
      const forward = (this._pressed(KEY_FORWARD) ? 1 : 0) - (this._pressed(KEY_BACK) ? 1 : 0)
      const strafe = (this._pressed(KEY_RIGHT) ? 1 : 0) - (this._pressed(KEY_LEFT) ? 1 : 0)
      sprinting = this._pressed(KEY_SPRINT)
      const speed = sprinting ? this.sprintSpeed : this.walkSpeed

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
        if (this.onFootstep && this.travelled >= this.stepDistance) {
          this.travelled -= this.stepDistance
          this.onFootstep(sprinting)
        }
      }
      // a blocked player still has to stop bobbing
      if (moved < 1e-4) this.speedRatio *= 0.7
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
