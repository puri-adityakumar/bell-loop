/**
 * creatureView.js — the creature's visual representation (v2 slice 10).
 *
 * Procedural geometry only. There is not one external asset, no texture, no
 * `document.createElement`, and not a single line that reads a clock or a random
 * number. Every dimension comes from `CREATURE_SHAPE` in `creature.js` and every
 * per-state behaviour comes from `creaturePose` in the same file, so this module
 * is a renderer and nothing else: there is no art decision here that the gate
 * cannot see, and no rule here that the gate cannot check.
 *
 * WHY A SEPARATE FILE (§15.1)
 * ----------------------------
 * `creature.js` is pure because that is the only reason a hunting AI is testable
 * in a project that cannot be playtested (§16.1). This file is the other half of
 * that split: it touches Three.js, so `verify.mjs` may not import it, and the
 * `verify-world.mjs` checks that would exercise it stay blocked until slice 14
 * repairs that harness. That is a real cost, and the way to pay it without paying
 * it twice is that *nothing is decided here*. The state machine decides, the pure
 * module computes, and this file draws the answer.
 *
 * THE FIGURE
 * ----------
 * A 2.80 m figure on a 0.40 m shoulder — 7:1, and twice as thin as a person. §6.1's
 * apparition has to be noticed across ninety metres of fog, and at that range a
 * human-proportioned body is a smudge. Thin is the legible choice.
 *
 * The body is `PALETTE.creature`, near-black, and near-black is doing real work
 * rather than being an absence: every fog stop in §12.3 is *lighter* than the
 * body, so the figure reads as a darker shape than the air in front of it, at any
 * distance and at any dusk. That is what lets a near-black figure survive a
 * transparent material — a 30%-opacity apparition is a hole in the fog rather than
 * a faint grey smudge painted on top of it.
 *
 * THE EYES
 * --------
 * Two unfogged additive quads, sized by `eyeWorldSize`. `fog: false` is
 * deliberate and is the same decision `streetView.js` already makes for the portal
 * rings and the sodium lamp heads: the three things §4 promises stay readable at
 * distance are the two lights and the thing hunting you, and a fogged emissive at
 * 90 m is not a light, it is a slightly brighter piece of fog. The camera's
 * quaternion is copied onto them every frame, because a creature facing you with
 * its eyes pointed at the world behind you is a creature whose face you cannot
 * read.
 */
import * as THREE from 'three'
import { PALETTE } from './streetView.js'
import { CREATURE_SHAPE, creaturePose } from './creature.js'

/**
 * CREATURE_COLORS — the four colours the figure is allowed.
 *
 * Art, and art lives in the view half of the split, but there are only four of
 * them and each one is a decision worth writing down. The enraged body is a very
 * dark arterial red rather than a red: §10.2's finale has to read against the
 * same fog as everything else, and a bright red figure in a dusk street reads as a
 * lit object rather than as a thing that has stopped pretending.
 */
export const CREATURE_COLORS = Object.freeze({
  body: PALETTE.creature,
  enraged: 0x3a0c11,
  eye: 0xcfe0ff,
  eyeEnraged: 0xff5a3c,
})

/** Segment counts. Low on purpose — a silhouette does not need a smooth hull. */
const SEGMENTS = Object.freeze({ limb: 6, torso: 8, head: 10, headHeight: 8 })

/**
 * CreatureView — one figure, added to the scene once and re-presented every frame.
 *
 * The scene graph is built for the four things the presentation actually moves and
 * nothing else gets a node: `root` carries the world position and the facing,
 * `lean` carries pitch / roll / heave and the §7.4 recoil, `head` carries the §6.1
 * search scan, and `eyes` carries the billboard. A flatter rig would have meant
 * writing the inverse of every parent transform by hand, which is the single most
 * common source of a limb that slowly detaches from a body as a scene is edited.
 */
export class CreatureView {
  /**
   * @param {THREE.Scene} scene
   * @param {{ seed?: number, viewportHeight?: number }} [options] `seed` only
   *   phases the flicker, so two creatures sharing a scene never blink in lockstep
   */
  constructor(scene, options = {}) {
    this.disposed = false
    this.seed = options.seed ?? 0x5eed
    this.flickerOffset = (this.seed % 97) * 0.0647
    this.pose = creaturePose(null)
    this.viewportHeight = options.viewportHeight ?? 720
    this._worldQuaternion = new THREE.Quaternion()
    this._enragedColor = new THREE.Color(CREATURE_COLORS.enraged)
    this._eyeEnragedColor = new THREE.Color(CREATURE_COLORS.eyeEnraged)

    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: CREATURE_COLORS.body,
      roughness: 0.88,
      metalness: 0,
      // `transparent` is what carries `presence`. depthWrite is off because the
      // figure is translucent by design in four of its seven presentations, and a
      // translucent mesh that writes depth occludes itself — the back of the torso
      // punching through the front of it at exactly the moment the apparition is
      // supposed to be least solid
      transparent: true,
      depthWrite: false,
      fog: true,
    })
    this.eyeMaterial = new THREE.MeshBasicMaterial({
      color: CREATURE_COLORS.eye,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // §4's three distance-readable things: the portals, the lamps, and this
      fog: false,
    })
    this._geometries = []
    this._materials = [this.bodyMaterial, this.eyeMaterial]

    this.root = new THREE.Group()
    this.root.name = 'creature'
    this.root.visible = false
    scene.add(this.root)

    this.lean = new THREE.Group()
    this.root.add(this.lean)
    this.head = new THREE.Group()
    this.eyes = new THREE.Group()
    this.arms = []
    this.legs = []
    this._build()
  }

  /** Geometry constructors, pooled so `dispose` has one list to walk. */
  _geometry(make) {
    const geometry = make()
    this._geometries.push(geometry)
    return geometry
  }

  _limb(radiusTop, radiusBottom, length, segments = SEGMENTS.limb) {
    return this._geometry(
      () => new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments, 1, false),
    )
  }

  /**
   * _build — the figure, bottom-up.
   *
   * Built from `CREATURE_SHAPE` and read off it rather than retyped, so
   * `legLength + torsoLength` is the shoulder line because the two numbers add to
   * it and not because somebody typed 2.32 twice. Nothing is centred on its own
   * origin: every part is placed in figure-space from the floor up, which is why
   * the §7.4 recoil can lift and throw the whole figure by moving one group.
   */
  _build() {
    const S = CREATURE_SHAPE
    const shoulderY = S.armRoot
    const hipY = S.legLength

    // --- the trunk, narrow at the waist and widest at the shoulders
    const torso = new THREE.Mesh(
      this._limb((S.shoulder / 2) * 0.8, S.hip / 2, S.torsoLength, SEGMENTS.torso),
      this.bodyMaterial,
    )
    torso.position.y = hipY + S.torsoLength / 2
    this.lean.add(torso)

    // The shoulder bar. This one part is why the figure reads as thin rather than
    // as a post: a 0.40 m span on a 2.80 m body is the aspect ratio §12.1 asks
    // for, and it is what the eye measures before it has resolved a limb.
    const bar = new THREE.Mesh(this._limb(0.045, 0.045, S.shoulder), this.bodyMaterial)
    bar.rotation.z = Math.PI / 2
    bar.position.y = shoulderY
    this.lean.add(bar)

    // --- the arms, hung from pivots so the gait can swing them
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group()
      pivot.position.set((side * S.shoulder) / 2, shoulderY, 0)
      const upper = new THREE.Mesh(this._limb(0.042, 0.03, S.armLength), this.bodyMaterial)
      upper.position.y = -S.armLength / 2
      const claw = new THREE.Mesh(
        this._geometry(() => new THREE.ConeGeometry(0.035, 0.16, 4)),
        this.bodyMaterial,
      )
      claw.position.y = -S.armLength - 0.06
      claw.rotation.x = Math.PI
      pivot.add(upper, claw)
      this.lean.add(pivot)
      this.arms.push(pivot)
    }

    // --- the legs, from the hip down to the floor
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group()
      pivot.position.set((side * S.hip) / 2, hipY, 0)
      const leg = new THREE.Mesh(this._limb(0.055, 0.028, S.legLength), this.bodyMaterial)
      leg.position.y = -S.legLength / 2
      const foot = new THREE.Mesh(this._limb(0.03, 0.05, 0.09), this.bodyMaterial)
      foot.position.set(0, -S.legLength + 0.045, 0.035)
      pivot.add(leg, foot)
      this.lean.add(pivot)
      this.legs.push(pivot)
    }

    // --- the neck and the head
    const neck = new THREE.Mesh(this._limb(0.05, 0.062, S.neckLength), this.bodyMaterial)
    neck.position.y = shoulderY + S.neckLength / 2
    this.lean.add(neck)

    this.head.position.y = S.headCentre
    const skull = new THREE.Mesh(
      this._geometry(() => new THREE.SphereGeometry(S.headRadius, SEGMENTS.head, SEGMENTS.headHeight)),
      this.bodyMaterial,
    )
    // taller than wide, and narrower than deep: a skull, not a ball. At 90 m the
    // whole head is nine pixels and the silhouette is doing all of the work
    skull.scale.set(0.78, 1.18, 0.92)
    this.head.add(skull)

    // --- the eyes
    // Unit quads, scaled by `pose.eyeSize` and never by anything else. `depthTest`
    // stays on: an eye visible through a house would be a §8.3 violation committed
    // by the renderer rather than by the AI that was supposed to prevent it
    const quad = this._geometry(() => new THREE.PlaneGeometry(1, 1))
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(quad, this.eyeMaterial)
      eye.position.set(side * S.eyeSpread, S.eyeHeight - S.headCentre, 0.02)
      this.eyes.add(eye)
    }
    this.head.add(this.eyes)
    this.lean.add(this.head)
  }

  /**
   * present — apply one frame of the pure pose, and nothing else.
   *
   * Every number read here was computed in `creaturePose`; the only decisions in
   * this method are the two that are genuinely about rendering rather than about
   * the design — which colour the `redden` mix lands on, and the fact that the eye
   * quads have to be divided back out of the figure's own scale so that the pixel
   * floor `eyeWorldSize` promised is the pixel floor that reaches the screen.
   *
   * @param {object} pose from `creaturePose`
   * @param {object} [context]
   * @param {{x: number, z: number}} [context.position] world metres, already
   *   folded into the copy being drawn (§3.3)
   * @param {number} [context.yaw] the bearing the figure faces, radians
   * @param {THREE.Camera} [context.camera] for the eye billboard
   */
  present(pose, context = {}) {
    if (this.disposed) return
    this.pose = pose
    if (!pose || !pose.present) {
      this.root.visible = false
      return
    }
    this.root.visible = true
    const position = context.position
    if (position) this.root.position.set(position.x, 0, position.z)
    if (Number.isFinite(context.yaw)) this.root.rotation.y = context.yaw

    // §6.1's lean, §7.4's recoil and the gait, all on one group. `roll` carries the
    // stalk's edge-of-vision angle, so a searching creature is angled across the
    // frame rather than squared up to the player
    this.lean.rotation.x = pose.pitch
    this.lean.rotation.z = pose.roll
    this.lean.position.y = pose.heave + pose.lift
    this.lean.position.z = -pose.push

    // the head scans independently, and stops scanning the moment it is hunting
    this.head.rotation.y = pose.scan

    // the gait, as a stride rather than a bob. Walking is a leg thing, and the arms
    // counter-swing because a figure whose arms hang rigid while its legs stride
    // reads as a puppet, and a puppet is not frightening in the way this is
    const stride = Math.sin(this._gaitPhase(pose)) * 0.5
    this.legs[0].rotation.x = stride
    this.legs[1].rotation.x = -stride
    this.arms[0].rotation.x = -stride * 0.7
    this.arms[1].rotation.x = stride * 0.7

    // the silhouette itself: scale from the state row, alpha from `presence`
    this.root.scale.setScalar(pose.scale)
    this.bodyMaterial.opacity = pose.presence
    this.bodyMaterial.color.setHex(CREATURE_COLORS.body).lerp(this._enragedColor, pose.redden)
    this.eyeMaterial.color.setHex(CREATURE_COLORS.eye).lerp(this._eyeEnragedColor, pose.redden)

    // The eyes are the one part whose world size is a promise rather than a
    // proportion, so they are divided back out of the figure's scale and re-scaled
    // to the exact diameter the pure module solved for. Everything else keeps its
    // proportions and is scaled with the body.
    const S = CREATURE_SHAPE
    const inverse = 1 / Math.max(0.001, pose.scale)
    this.eyes.scale.setScalar(Math.max(0.001, pose.eyeSize) * inverse)
    for (const eye of this.eyes.children) {
      const side = eye.position.x < 0 ? -1 : 1
      eye.position.set(side * S.eyeSpread * inverse, (S.eyeHeight - S.headCentre) * inverse, 0.02)
    }
    this.eyeMaterial.opacity = pose.eye

    this._billboardEyes(context.camera)
  }

  /**
   * _gaitPhase — the stride phase, derived from the pose rather than from a clock.
   *
   * `heave` already moves with the walk and is driven by the world's own time, so
   * the legs are in step with the rest of the figure for free. A `this.clock += dt`
   * in this class would be the one place in the view that could drift away from
   * the pose it is drawing, and a limb that drifts is the first thing anyone
   * notices about a rig.
   */
  _gaitPhase(pose) {
    return pose.heave * 26 + pose.state.length * 0.7
  }

  /**
   * _billboardEyes — make the eyes face the camera, whatever the body is doing.
   *
   * The eyes are grandchildren of a body that is itself yawed, pitched, rolled and
   * scaled, so "make them face the camera" is a change of basis rather than an
   * assignment. The head's world quaternion is inverted and premultiplied onto the
   * camera's, which is the whole transform in two lines and needs no per-frame
   * allocation.
   */
  _billboardEyes(camera) {
    if (!camera) return
    this.head.updateWorldMatrix(true, false)
    this.head.getWorldQuaternion(this._worldQuaternion).invert()
    this.eyes.quaternion.copy(this._worldQuaternion).multiply(camera.quaternion)
  }

  /**
   * viewOf — the camera numbers `creaturePose` needs, gathered in one place.
   *
   * `viewHalfFov` is derived from the camera's own vertical fov and aspect rather
   * than stored here, so a capture taken at a different aspect moves the §6.1
   * stalk edge with it instead of pinning the figure to a 16:9 frame.
   */
  viewOf(camera) {
    const fallback = { fov: 72, aspect: 16 / 9, viewportHeight: this.viewportHeight, viewHalfFov: Math.PI / 4 }
    if (!camera) return fallback
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : fallback.aspect
    const fov = Number.isFinite(camera.fov) && camera.fov > 0 ? camera.fov : fallback.fov
    return {
      fov,
      aspect,
      viewportHeight: this.viewportHeight,
      viewHalfFov: Math.atan(Math.tan((fov * Math.PI) / 360) * aspect),
    }
  }

  /**
   * dispose — the whole slice's teardown, and it must not throw.
   *
   * §15's definition of done includes a clean teardown, because a `dispose` that
   * throws takes React's unmount down with it and leaves a WebGL context alive
   * behind the next mount. The root is removed from the scene *before* the
   * geometry is disposed, which also means `world.js`'s own scene traversal never
   * reaches these objects and disposes them a second time. It is idempotent,
   * because `dispose` may legitimately be called twice on the way out of a hot
   * reload.
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.root.parent?.remove(this.root)
    for (const geometry of this._geometries) geometry.dispose()
    for (const material of this._materials) material.dispose()
    this._geometries = []
    this._materials = []
    this.root.clear()
  }
}

export default CreatureView
