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
 *
 * PASS 10 — WHAT THIS FILE NOW DRAWS THAT IT USED NOT TO
 * ------------------------------------------------------
 * Four things, all decided in `creature.js` and applied here:
 *
 *  1. a BREATH — `pose.breath` scales the whole rig from the floor up by ±1.6%,
 *     and `pose.sway` yaws it by 1.7°, so a figure standing in fog is a figure
 *     rather than a cut-out. The eyes are divided back out of it, because their
 *     size is a pixel promise and a promise does not wobble.
 *  2. TWO JOINTS per arm — a shoulder and an elbow, with the elbow's peak
 *     `ELBOW_LAG` behind the shoulder's. Before this pass the arm was one cylinder
 *     on one pivot, which swings but does not articulate.
 *  3. THE TRAIL — one `BufferGeometry` of `TRAIL_MAX` quads with an RGBA vertex
 *     colour, holding the whole viscous trail in one draw call. It hangs off the
 *     SCENE rather than off `root`, because a mark parented to the creature would
 *     follow it around for ever.
 *  4. THE FLARE — `pose.eyeFlare` scales the eye's COLOUR and its size on the frame
 *     the creature first spots the player, and `EYE_RENDER_ORDER` is untouched: the
 *     flare makes the eye brighter, never a different object in the queue.
 */
import * as THREE from 'three'
import { PALETTE } from './streetView.js'
import {
  CREATURE_SHAPE,
  DRIP_ASPECT,
  DRIP_COLOUR,
  DRIP_LIFT,
  DRIP_OPACITY,
  EYE_FLARE_GAIN,
  EYE_FLARE_GROWTH,
  // ITERATION 2, PASS 11. The haze's grid and colour and the puff field's cap and
  // colour all come from the pure module, for the same reason every other number in
  // this file does: there is no art decision here that the gate cannot see.
  HAZE_BAND_FILL,
  HAZE_BAND_HEIGHT,
  HAZE_COLOUR,
  HAZE_LAYERS,
  PUFF_COLOUR,
  PUFF_MAX,
  PUFF_OPACITY,
  PUFF_RADIUS,
  TRAIL_MAX,
  creaturePose,
  dripAlpha,
  hazeLayers,
  puffAlpha,
  puffLift,
  puffRadius,
} from './creature.js'

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
 * EYE_RENDER_ORDER — the eye quad is the last transparent thing drawn in a frame,
 * and this one number is what makes it so.
 *
 * ITERATION 2, PASS 6. The wire system is the first thing in this project that
 * puts a large, near, DARK, `depthWrite: false` transparent surface between the
 * lens and a creature standing thirty metres away. Three.js sorts the transparent
 * queue back-to-front, so a cable two metres from the camera is drawn *after* an
 * eye at thirty, and a silhouette at luma 17.6 paints straight over an additive
 * quad at luma 226.
 *
 * The loss is not subtle and it was measured rather than guessed. On
 * `creature-stalking.png` at the start of this pass, three spans crossed the head
 * and cut one solid 9x7 eye — 62 lit pixels, fill 0.98, mean 226 — into an 8x1
 * and an 8x4. Twenty-nine lit pixels between them, the brightest of them 186
 * instead of 226. `creatureContrast` then reported `found: false`, "no eye quad
 * anywhere in the frame", which is the one sentence about that picture that could
 * not be less true: the creature was standing in the middle of it.
 *
 * So the eye is lifted out of the depth sort, and the lift is a decision rather
 * than a patch: it is the SAME decision as `fog: false`, one layer further out.
 * The eye is not a surface on the model, it is a *signal* — the one mark in a
 * frame that is unfogged, distance-invariant and small, and `png-luma.mjs` has
 * anchored the whole creature gate on precisely those three properties. A 2 px
 * cable is allowed to be a silhouette against the sky; it is not allowed to be a
 * silhouette against the thing the player has to be able to see.
 *
 * Additive blending is what makes this nearly free. The wire contributes luma
 * 17.6 — very nearly black — so adding the eye *over* it lands within a couple of
 * levels of adding it over anything else dark. The signal survives because the
 * thing crossing it is a shadow, not a highlight.
 *
 * `depthTest` is deliberately left alone, and that is the half that keeps the
 * claim honest. A render ORDER cannot defeat an opaque depth buffer, so an eye
 * behind a house is still an eye behind a house and §8.3 remains a rule the AI
 * enforces rather than one the renderer quietly waives. Only the transparent queue
 * is reordered, and the only thing lifted out of it is a cable.
 */
const EYE_RENDER_ORDER = 1

/**
 * TRAIL_RENDER_ORDER — the viscous trail's slot in the transparent queue: 0.
 *
 * ITERATION 2, PASS 10. BEFORE: there was no trail. AFTER: 0, which is the default
 * and is the point — three.js draws the transparent queue back-to-front, so a render
 * order of 0 is drawn before `EYE_RENDER_ORDER` 1 and a dark decal can never paint
 * over the eye.
 *
 * That is not tidiness, it is the pass-6 finding turned against this pass. A wire
 * two metres from the lens is sorted after an eye at thirty, and the luma-17.6
 * silhouette erased the creature gate's only anchor; a trail is a `depthWrite: false`
 * dark decal on the ground and is exactly as capable of the same erasure if it is
 * given a slot after the eye. It is a named constant rather than a bare `0` so that
 * the ordering is a claim a check can read instead of a default.
 */
const TRAIL_RENDER_ORDER = 0

/**
 * HAZE_RENDER_ORDER / PUFF_RENDER_ORDER — 0 for both, i.e. the default slot, and
 * for the same reason `TRAIL_RENDER_ORDER` is.
 *
 * ITERATION 2, PASS 11. Two new transparent surfaces enter a scene whose one
 * unbreakable ordering rule is "the eye is drawn last" (`EYE_RENDER_ORDER` 1, the
 * pass-6 finding). Both are additive or blended quads that can sit in front of the
 * figure, so giving either a slot after the eye would reintroduce exactly the bug
 * pass 6 fixed: a shimmer that washes over the eye raises its luma and, worse, can
 * widen the blob past `EYE_MAX_SPAN` 14 and make `findEyes` reject the creature's own
 * eye. `verify.mjs` asserts both constants are `0` and that the eye keeps `1`.
 */
const HAZE_RENDER_ORDER = 0
const PUFF_RENDER_ORDER = 0

/**
 * HAZE_INNER_FRACTION — where a haze band's inner edge sits, as a fraction of its
 * outer radius. 0.6.
 *
 * BEFORE: n/a. AFTER 0.6.
 *
 * The band is an annulus and this is the hole in the middle of it, and the number is
 * a GEOMETRY decision rather than a design one: it is the distance from the column's
 * axis at which a band stops existing, and the claim is that the figure never comes
 * near it. At `HAZE_HALF_WIDTH` 0.62 m and `CREATURE_SHAPE.shoulder / 2` 0.20 m the
 * inner edge is at 0.372 m, and the widest the rig ever gets is `enraged`'s
 * `pose.scale` 1.08 — 0.216 m of half-shoulder and 0.216 m of crown half-width. The
 * clearance is therefore 0.156 m at the shoulder and more at the crown, and
 * `verify.mjs` asserts the inequality rather than the numbers.
 *
 * 0.6 and not 0.8 because a 0.124 m gap at 0.62 m is a hairline: at the 17 m the
 * stalking view uses, 0.124 m is under two pixels, and an additive curtain two pixels
 * from the body IS painted on the body as far as the frame is concerned.
 */
const HAZE_INNER_FRACTION = 0.6

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
    // PASS 10. The scene is held rather than reached for through `root.parent`,
    // because the trail is a SIBLING of `root` and not a child of it: a mark that
    // were parented to the creature would follow it around for ever, and the trail
    // is a record of where the creature was. `dispose` needs it for the same reason.
    this.scene = scene

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
    this.elbows = []
    this.legs = []
    this._build()
    // PASS 11. The two new fields are built AFTER the figure, not inside it, and they
    // hang off the scene rather than off `root` for the reason the trail does: a puff
    // or a shimmer parented to the creature would travel with it.
    this._buildHaze()
    this._buildPuffs()
    // PASS 11. Two scratch vectors for the puff billboard, allocated once. A
    // `THREE.Vector3` per corner per frame would be 16 allocations a frame for a
    // ten-quad mesh, which is the kind of cost that is invisible in a profile and
    // obvious in a frame budget.
    this._puffRight = new THREE.Vector3()
    this._puffUp = new THREE.Vector3()
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
    //
    // ITERATION 2, PASS 10 — TWO JOINTS, not one. BEFORE: a single cylinder from
    // the shoulder to the claw, so the whole limb rotated rigidly and the arm read
    // as a stick oscillating rather than as an arm working. AFTER: an upper bone and
    // a forearm on their own pivot, and the lengths come from `CREATURE_SHAPE`
    // (`armUpper` + `armFore` === `armLength`) so the claw still hangs exactly
    // where §12.1's silhouette put it and the 7:1 ratio is untouched.
    //
    // The forearm is drawn a shade thinner than the upper bone, which is the only
    // cue that reads at 30 m: a limb of two identical radii looks like one long
    // limb with a joint in the middle of it, and a limb that tapers reads as an
    // elbow. Both numbers are before/after: 0.042/0.03 and 0.03/0.022.
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group()
      pivot.position.set((side * S.shoulder) / 2, shoulderY, 0)
      const upper = new THREE.Mesh(this._limb(0.042, 0.03, S.armUpper), this.bodyMaterial)
      upper.position.y = -S.armUpper / 2
      const elbow = new THREE.Group()
      elbow.position.y = -S.armUpper
      const fore = new THREE.Mesh(this._limb(0.03, 0.022, S.armFore), this.bodyMaterial)
      fore.position.y = -S.armFore / 2
      const claw = new THREE.Mesh(
        this._geometry(() => new THREE.ConeGeometry(0.035, 0.16, 4)),
        this.bodyMaterial,
      )
      claw.position.y = -S.armFore - 0.06
      claw.rotation.x = Math.PI
      elbow.add(fore, claw)
      pivot.add(upper, elbow)
      this.lean.add(pivot)
      this.arms.push(pivot)
      this.elbows.push(elbow)
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
      // Set per-mesh rather than on `this.eyes`, because `renderOrder` is read off
      // the object three.js actually queues and a `Group` is never queued — the
      // number on the group would be a comment.
      eye.renderOrder = EYE_RENDER_ORDER
      this.eyes.add(eye)
    }
    this.head.add(this.eyes)
    this.lean.add(this.head)

    this._buildTrail()
  }

  /**
   * `_buildTrail` — the viscous trail, as ONE mesh.
   *
   * ITERATION 2, PASS 10. BEFORE: nothing; the creature left no trace. AFTER: every
   * live mark is a quad in a single `BufferGeometry`, so the whole trail is one
   * draw call and one material no matter how many marks are alive, and `TRAIL_MAX`
   * of them cost 128 vertices.
   *
   * WHY ONE MESH AND NOT AN INSTANCED ONE. `streetView.js` uses `InstancedMesh` for
   * everything repeated, and this is the one place it is the wrong tool: the trail
   * needs a per-mark ALPHA, and an instanced mesh has no per-instance alpha in
   * stock three.js — `instanceColor` is RGB and `material.opacity` is global, so a
   * fading trail on an instanced pool would have to be faked by scaling every
   * instance, or by sixteen materials. A 16-quad geometry carries what a vertex
   * colour can: an RGBA `color` attribute (three.js sets `USE_COLOR_ALPHA` from
   * `itemSize === 4`, which is how the per-mark alpha is real rather than faked),
   * one mesh, one material, no shader patch, and the same `vertexColors` path the
   * facade system's lit windows already use.
   *
   * WHY IT IS NOT A CHILD OF `root`. `root` is translated to the creature's drawn
   * position every frame, so a mark parented to it would follow the creature around
   * for ever. The trail is a record of where the creature WAS, so it hangs off the
   * scene and the world hands over the marks already folded into the copy being
   * drawn — which is the same `worldOf` arithmetic every other consumer of
   * `creaturePosition` does, for the same §3.3 reason.
   *
   * `renderOrder` is 0, i.e. the default, and that is deliberate: three.js sorts the
   * transparent queue back-to-front and the eye sits at `EYE_RENDER_ORDER` 1, so the
   * trail is always drawn BEFORE the eye. A dark decal drawn after it would be
   * another near, dark, `depthWrite: false` surface painting over the one mark the
   * creature gate anchors on — which is the exact failure pass 6 fixed for the
   * wires, and it would have been reintroduced by a decal.
   */
  _buildTrail() {
    const positions = new Float32Array(TRAIL_MAX * 4 * 3)
    const colours = new Float32Array(TRAIL_MAX * 4 * 4)
    const index = new Uint16Array(TRAIL_MAX * 6)
    for (let mark = 0; mark < TRAIL_MAX; mark += 1) {
      const vertex = mark * 4
      for (let i = 0; i < 6; i += 1) index[mark * 6 + i] = vertex + [0, 1, 2, 0, 2, 3][i]
      // Every vertex starts at the origin with zero alpha. A mark that has never
      // been laid is INVISIBLE rather than absent, which is what lets the whole
      // pool be one static buffer: no reallocation, no draw-range juggling, and
      // the buffer's usage flags are the only per-frame cost.
      for (let i = 0; i < 4; i += 1) {
        positions[(vertex + i) * 3] = 0
        positions[(vertex + i) * 3 + 1] = DRIP_LIFT
        positions[(vertex + i) * 3 + 2] = 0
        colours[(vertex + i) * 4 + 3] = 0
      }
    }
    const geometry = this._geometry(() => {
      const made = new THREE.BufferGeometry()
      made.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
      made.setAttribute('color', new THREE.BufferAttribute(colours, 4).setUsage(THREE.DynamicDrawUsage))
      made.setIndex(new THREE.BufferAttribute(index, 1))
      return made
    })
    this.trailMaterial = new THREE.MeshBasicMaterial({
      color: DRIP_COLOUR,
      transparent: true,
      opacity: DRIP_OPACITY,
      depthWrite: false,
      // `fog: true` because the mark is ON the road: it is a depth cue and it has to
      // recede with everything else on the ground. An unfogged dark decal at 80 m
      // is a black hole in the fog, and a hole in the fog is what §12.1 reserves
      // the creature's body for.
      fog: true,
      // `vertexColors` is what makes the four-component `color` attribute legal; see
      // the note above on `USE_COLOR_ALPHA`.
      vertexColors: true,
    })
    this._materials.push(this.trailMaterial)
    this.trailGeometry = geometry
    this.trail = new THREE.Mesh(geometry, this.trailMaterial)
    this.trail.name = 'creatureTrail'
    this.trail.frustumCulled = false
    this.trail.visible = false
    this.trail.renderOrder = TRAIL_RENDER_ORDER
    this.scene.add(this.trail)
    this._trailPositions = positions
    this._trailColours = colours
    this._trailDirty = false
  }

  /**
   * `_buildHaze` — the creature's column of distorted air, as one mesh.
   *
   * ITERATION 2, PASS 11. THREE CONSTRUCTION DECISIONS, and each of them is the
   * answer to a question the brief left open:
   *
   *  1. **A column of BANDS, not a noise-textured cylinder.** The brief offered
   *     "a vertical column of 4-6 additive distorted quads or scrolling
   *     noise-textured cylinder"; the first half is taken. A scrolling texture would
   *     need a sampler and a UV set on a material that has neither, and the whole
   *     effect is 48 triangles of CPU-written vertices — cheap enough that the
   *     distortion can be GEOMETRY, which means it is a pure function of `(time,
   *     offset)` and therefore reproducible frame-for-frame, which a scroll offset
   *     accumulated per frame is not.
   *  2. **Each band is a RING of four quads, not a flat card.** A single camera-
   *     facing card is a billboard, and a billboard is only correct from one angle;
   *     walk four metres to the left and a creature that shimmered all the way round
   *     would shimmer on one side of itself. Four quads at 90 degrees is 48 triangles
   *     for the whole effect and it is symmetric from every bearing.
   *  3. **The middle of every band is TRANSPARENT and the four sides are not.** The
   *     alpha is `0` at the band's centre line and `1` at its two side edges, so the
   *     shimmer is a pair of standing curtains of hot air either side of the figure
   *     and nothing at all over it. `HAZE_HALF_WIDTH` 0.62 m is chosen against
   *     `CREATURE_SHAPE.shoulder` 0.40 m so the curtains are 0.42 m clear of the
   *     silhouette: this effect is additive, and a body measured against its local
   *     surround is the one measurement in the repository with 0.013 of headroom.
   *
   * `fog: false`, and this is the same decision `eyeMaterial` and the portal rings
   * make, for the same reason: additive plus fog is a fog-coloured ADD, and the
   * shimmer's own distance falloff (`hazeAmount`, which is exactly 0 at 30 m) is a
   * better depth cue than a fog term would be anyway.
   *
   * `frustumCulled` is off for `_buildTrail`'s reason — the buffer's vertices move
   * every frame and a stale bounds test would cull a shimmer that is plainly on
   * screen.
   */
  _buildHaze() {
    const quads = HAZE_LAYERS * 4
    const positions = new Float32Array(quads * 4 * 3)
    const colours = new Float32Array(quads * 4 * 4)
    const index = new Uint16Array(quads * 6)
    for (let quad = 0; quad < quads; quad += 1) {
      const vertex = quad * 4
      for (let i = 0; i < 6; i += 1) index[quad * 6 + i] = vertex + [0, 1, 2, 0, 2, 3][i]
      for (let i = 0; i < 4; i += 1) colours[(vertex + i) * 4 + 3] = 0
    }
    const geometry = this._geometry(() => {
      const made = new THREE.BufferGeometry()
      made.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
      made.setAttribute('color', new THREE.BufferAttribute(colours, 4).setUsage(THREE.DynamicDrawUsage))
      made.setIndex(new THREE.BufferAttribute(index, 1))
      return made
    })
    this.hazeMaterial = new THREE.MeshBasicMaterial({
      color: HAZE_COLOUR,
      transparent: true,
      // Opacity is 1 and the whole strength rides on the per-vertex alpha, exactly as
      // the trail's does. A material opacity here would be a second, constant term
      // multiplying the same thing, and there is one knob for this effect.
      opacity: 1,
      depthWrite: false,
      // Additive is the mechanism: a shimmer is light, and a blended pale grey over
      // near-black asphalt is a grey stain with an edge.
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexColors: true,
    })
    this._materials.push(this.hazeMaterial)
    this.hazeGeometry = geometry
    this.haze = new THREE.Mesh(geometry, this.hazeMaterial)
    this.haze.name = 'creatureHaze'
    this.haze.frustumCulled = false
    this.haze.visible = false
    this.haze.renderOrder = HAZE_RENDER_ORDER
    this.scene.add(this.haze)
    this._hazePositions = positions
    this._hazeColours = colours
  }

  /**
   * `_buildPuffs` — the footfall dust, as one mesh of `PUFF_MAX` camera-facing quads.
   *
   * ITERATION 2, PASS 11, and the structure is `_buildTrail`'s exactly: one
   * `BufferGeometry`, a FOUR-component vertex colour, one material, no per-frame
   * allocation, and a sibling of `root` so a puff is left where the footfall was
   * rather than following the creature around for ever.
   *
   * TWO THINGS DIFFER FROM THE TRAIL, and both are about what a puff is:
   *
   *  - **It is a BILLBOARD, not a ground quad.** The trail is a decal lying on the
   *    road and is built in the ground plane; dust hangs in the air and has to face
   *    the camera to be a puff rather than a sliver. The corners are therefore laid
   *    out on the camera's own right and up vectors, which `_presentPuffs` takes from
   *    `context.camera` — the same camera the eye billboards against.
   *  - **It is BLENDED, not additive.** Dust occludes; it does not emit. Additive dust
   *    is a light source at floor level, and a bright blob near the ground is exactly
   *    what `tools/png-luma.mjs`'s eye-finder is looking for.
   */
  _buildPuffs() {
    const positions = new Float32Array(PUFF_MAX * 4 * 3)
    const colours = new Float32Array(PUFF_MAX * 4 * 4)
    const index = new Uint16Array(PUFF_MAX * 6)
    for (let puff = 0; puff < PUFF_MAX; puff += 1) {
      const vertex = puff * 4
      for (let i = 0; i < 6; i += 1) index[puff * 6 + i] = vertex + [0, 1, 2, 0, 2, 3][i]
      for (let i = 0; i < 4; i += 1) colours[(vertex + i) * 4 + 3] = 0
    }
    const geometry = this._geometry(() => {
      const made = new THREE.BufferGeometry()
      made.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
      made.setAttribute('color', new THREE.BufferAttribute(colours, 4).setUsage(THREE.DynamicDrawUsage))
      made.setIndex(new THREE.BufferAttribute(index, 1))
      return made
    })
    this.puffMaterial = new THREE.MeshBasicMaterial({
      color: PUFF_COLOUR,
      transparent: true,
      opacity: PUFF_OPACITY,
      depthWrite: false,
      blending: THREE.NormalBlending,
      // `fog: true` for the trail's reason: a puff is a depth cue standing over the
      // road, and an unfogged bright billboard at 40 m is a floating light.
      fog: true,
      vertexColors: true,
    })
    this._materials.push(this.puffMaterial)
    this.puffGeometry = geometry
    this.puffs = new THREE.Mesh(geometry, this.puffMaterial)
    this.puffs.name = 'creaturePuffs'
    this.puffs.frustumCulled = false
    this.puffs.visible = false
    this.puffs.renderOrder = PUFF_RENDER_ORDER
    this.scene.add(this.puffs)
    this._puffPositions = positions
    this._puffColours = colours
    this._puffDirty = false
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
   * @param {object[]} [context.trail] the world's live marks, already folded into
   *   the drawn copy — the world owns the trail's state (`dripStep`) and this only
   *   draws it, which is the same split as everything else in the file
   * @param {number} [context.time] the world's clock, for the marks' ages
   */
  present(pose, context = {}) {
    if (this.disposed) return
    this.pose = pose
    if (!pose || !pose.present) {
      this.root.visible = false
      // PASS 11. The haze and the puff field are SIBLINGS of the figure rather than
      // children, so `root.visible` does not reach them, and a shimmer left hanging in
      // the air where a banished creature was standing is the one artefact this pass
      // could ship that nothing else would notice. Both are hidden on the frame the
      // figure goes, which is also the frame `pose.haze` is 0.
      this.haze.visible = false
      this.puffs.visible = false
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

    // THE MICRO-MOTION, and it is a YAW on the same group as the lean rather than a
    // second group. BEFORE: nothing moved while the creature stood still. AFTER:
    // `pose.breath` inflates the whole rig by ±1.6% from the floor up (it is a scale
    // on `lean`, whose origin is the figure's feet, so the crown moves and the feet
    // do not — a breath is a change of VOLUME, not of position) and `pose.sway` turns
    // the shoulders a degree and a half.
    //
    // The breath is applied AFTER the eye's inverse scale is taken below, and
    // divided back out of the eyes for the same reason the figure's own `scale` is:
    // `EYE_PIXEL_FLOOR` is a promise about pixels on screen, and a ±1.6% wobble in
    // the body would otherwise wobble the one thing in the frame whose size is
    // specified rather than proportioned.
    this.lean.scale.setScalar(1 + pose.breath)
    this.lean.rotation.y = pose.sway

    // THE GAIT, as three joint angles the pure module solved. BEFORE: one sine with
    // two hard-coded amplitudes (0.5 on the legs, 0.7 on the arms) applied to every
    // state, and no elbow at all. AFTER: the legs counter-phase as they always did,
    // the arms counter-phase against them, and the elbows bend a beat BEHIND the
    // shoulders (`ELBOW_LAG`), which is the difference between a limb that works and
    // a limb that slides.
    this.legs[0].rotation.x = pose.legSwing
    this.legs[1].rotation.x = -pose.legSwing
    this.arms[0].rotation.x = pose.armSwing
    this.arms[1].rotation.x = -pose.armSwing
    // Both elbows bend the same way: a forearm has one direction to fold, and
    // mirroring it would be a bird's wing.
    this.elbows[0].rotation.x = pose.armElbow
    this.elbows[1].rotation.x = pose.armElbow

    // the silhouette itself: scale from the state row, alpha from `presence`
    this.root.scale.setScalar(pose.scale)
    this.bodyMaterial.opacity = pose.presence
    this.bodyMaterial.color.setHex(CREATURE_COLORS.body).lerp(this._enragedColor, pose.redden)
    this.eyeMaterial.color.setHex(CREATURE_COLORS.eye).lerp(this._eyeEnragedColor, pose.redden)

    // The eyes are the one part whose world size is a promise rather than a
    // proportion, so they are divided back out of the figure's scale and re-scaled
    // to the exact diameter the pure module solved for. Everything else keeps its
    // proportions and is scaled with the body.
    //
    // The breath is divided out too, and that is the second half of applying it to
    // `lean` at all: `EYE_PIXEL_FLOOR` 7 is a promise about PIXELS, and a ±1.6%
    // volume change in the body would otherwise make the eye's size wobble by a
    // pixel and a tenth on a 7 px mark. The floor stays the floor.
    const S = CREATURE_SHAPE
    const breath = 1 / Math.max(0.001, 1 + pose.breath)
    const inverse = breath / Math.max(0.001, pose.scale)
    // THE FLARE, on both halves at once and for the same reason: a real eye that
    // flares dilates as well as brightens, and the two have to arrive together or
    // the swell reads as the eye moving towards you. `EYE_FLARE_GROWTH` is capped
    // against `EYE_MAX_SPAN` in `verify.mjs`, because a bigger eye is the one way
    // this pass could cost the creature gate its own anchor.
    const flare = 1 + (EYE_FLARE_GROWTH - 1) * pose.eyeFlare
    this.eyes.scale.setScalar(Math.max(0.001, pose.eyeSize) * inverse * flare)
    for (const eye of this.eyes.children) {
      const side = eye.position.x < 0 ? -1 : 1
      eye.position.set(side * S.eyeSpread * inverse, (S.eyeHeight - S.headCentre) * inverse, 0.02)
    }
    this.eyeMaterial.opacity = pose.eye
    // ...and the brightness, on the COLOUR rather than the opacity, because opacity is
    // already spent on `pose.eye` and on the telegraph/stagger flicker. A
    // `THREE.Color` above 1 is legal and is exactly what an additive unfogged quad
    // needs: the renderer tone-maps it, so a 3.2x peak arrives as a bright swell and
    // not as a flat clipped white disc. `setHex` above rewrites the colour every
    // frame, so there is no accumulation across frames.
    this.eyeMaterial.color.multiplyScalar(1 + EYE_FLARE_GAIN * pose.eyeFlare)

    this._billboardEyes(context.camera)
    this._presentTrail(context)
    // PASS 11. The shimmer is presented BEFORE the puffs and both are after the eye's
    // own transform, because the eye's lift out of the depth sort (`EYE_RENDER_ORDER`
    // 1) is a render-ORDER property and not a call-order one: all three sit at order
    // 0 or 1 in the transparent queue and the queue is what decides. The call order
    // here is only about which buffer is written last, and none of the three reads
    // another's buffer.
    this._presentHaze(context)
    this._presentPuffs(context)
  }

  /**
   * `_presentTrail` — write the live marks into the one buffer the trail owns.
   *
   * The world owns the trail's STATE (`dripStep` is a pure reducer and the world's
   * frame is what advances it) and this method owns only its DRAWING, which is the
   * same split as the rest of the file: the decisions are in `creature.js` and the
   * numbers arrive on `context.trail`.
   *
   * Three properties are decided here and are all about not spending anything:
   *
   *  - **the buffer is written only when something is alive or has just died.** A
   *    creature standing still on a street with a dry trail uploads nothing, which is
   *    the whole reason the pool is one geometry rather than 16 meshes with 16
   *    materials.
   *  - **a mark's alpha is written from `dripAlpha` rather than assumed.** The
   *    reducer already evicts the oldest, so by construction every mark in the list is
   *    inside its life — but "oldest fades first" has to be a fact about the drawn
   *    pixels and not about the reducer's list order, and a view that trusted the
   *    list would hold every mark at full strength for its whole life.
   *  - **`frustumCulled` is off**, exactly as the wire's is: the trail's bounding box
   *    is one static buffer whose vertices move every frame, and a stale bounds test
   *    would cull a trail that is plainly on screen.
   *
   * @param {object} [context] `context.trail` is the world-folded mark list and
   *   `context.time` is the world's clock
   */
  _presentTrail(context = {}) {
    const marks = Array.isArray(context.trail) ? context.trail : []
    const time = Number.isFinite(context.time) ? context.time : 0
    const positions = this._trailPositions
    const colours = this._trailColours
    // `slot` AND `index` are tracked separately, and the difference is the bug. A mark
    // in its first `DRIP_SPREAD` has no strength and is SKIPPED, and a version that
    // wrote it to its own list index would leave the previous frame's alpha sitting in
    // that quad: a mark that had died would stay on the road at whatever strength it
    // happened to be at when it stopped being drawn. Writing to a running slot instead
    // means the buffer is a dense list of the marks that are actually up, and the
    // clearing loop below can zero everything past the end of it unconditionally.
    let slot = 0
    for (let index = 0; index < marks.length && slot < TRAIL_MAX; index += 1) {
      const mark = marks[index]
      const alpha = dripAlpha(time - mark.born)
      if (alpha <= 0) continue
      const x = Number.isFinite(mark.x) ? mark.x : 0
      const z = Number.isFinite(mark.z) ? mark.z : 0
      const radius = Number.isFinite(mark.radius) && mark.radius > 0 ? mark.radius : 0
      const spin = Number.isFinite(mark.spin) ? mark.spin : 0
      // The quad is laid out in the mark's OWN rotated frame, so the seeded `spin` is
      // a rotation of the ellipse rather than a rotation of nothing.
      const cos = Math.cos(spin)
      const sin = Math.sin(spin)
      const rx = radius * DRIP_ASPECT
      const corners = [[-rx, -radius], [rx, -radius], [rx, radius], [-rx, radius]]
      const vertex = slot * 4
      for (let i = 0; i < 4; i += 1) {
        const ox = corners[i][0]
        const oz = corners[i][1]
        const at = (vertex + i) * 3
        positions[at] = x + ox * cos - oz * sin
        positions[at + 1] = DRIP_LIFT
        positions[at + 2] = z + ox * sin + oz * cos
        // The RGB stays at 1 and the mark's tint is the MATERIAL's, which is the point
        // of a vertex alpha: the whole trail is one colour and one material, and only
        // the fade varies per mark.
        colours[(vertex + i) * 4] = 1
        colours[(vertex + i) * 4 + 1] = 1
        colours[(vertex + i) * 4 + 2] = 1
        colours[(vertex + i) * 4 + 3] = alpha
      }
      slot += 1
    }
    // Everything past the marks that are up is explicitly cleared, because the list
    // shrinks as marks die and a stale quad left at its last alpha would be a mark that
    // outlived `DRIP_LIFE`.
    for (let index = slot; index < TRAIL_MAX; index += 1) {
      const vertex = index * 4
      for (let i = 0; i < 4; i += 1) colours[(vertex + i) * 4 + 3] = 0
    }
    this.trail.visible = slot > 0
    if (!this._trailDirty && slot === 0) return
    this._trailDirty = slot > 0
    this.trail.geometry.attributes.position.needsUpdate = true
    this.trail.geometry.attributes.color.needsUpdate = true
  }

  /**
   * `_presentHaze` — write the column's six bands into the one buffer it owns.
   *
   * ITERATION 2, PASS 11. Every distance, alpha and offset is `hazeLayers`' decision.
   * The two things decided here are the things that are genuinely about DRAWING a
   * band rather than about what the band is:
   *
   *  - **THE SHAPE: an annular quad.** A band is the strip between an inner radius and
   *    an outer one, from `-halfHeight` to `+halfHeight`, so the ring has a hole down
   *    the middle and the figure stands in the hole. `HAZE_HALF_WIDTH` is the outer
   *    radius and the inner one is a fixed fraction of it, which is what guarantees
   *    the curtains can never touch the body: §12.1's shoulder is 0.20 m in radius and
   *    the inner edge is at 0.60 of a 0.62 m outer, i.e. 0.37 m — a 0.17 m gap at the
   *    shoulder even at `pose.scale` 1.08, the widest the rig ever gets. The alpha is
   *    `0` on the inner edge and `1` on the outer one, so the gradient and the gap
   *    agree: there is no alpha anywhere near the figure to lift its luma.
   *  - **THE WARP: a twist, alternating per band.** The top edge moves `+warp` and the
   *    bottom `-warp`, so a band is a parallelogram rather than a rectangle, and the
   *    sign alternates up the column so the stack distorts instead of turning as one
   *    solid. `warp` is bounded by `HAZE_DRIFT_METRES` 0.2 m against a half-height of
   *    0.315 m, so the top edge can never cross the bottom one and the band can never
   *    invert.
   *
   * The mesh is a SIBLING of `root` and takes the creature's drawn position and
   * facing directly, for the reason the trail does: a shimmer parented to the figure
   * would travel with it, and this is supposed to be air standing where the creature
   * is standing rather than a property of the creature.
   *
   * @param {object} [context] `context.time` is the world's clock; `context.position`
   *   and `context.yaw` are the same drawn transform `root` is given
   */
  _presentHaze(context = {}) {
    const pose = this.pose
    const amount = pose && Number.isFinite(pose.haze) ? pose.haze : 0
    const on = pose?.present === true && amount > 0
    this.haze.visible = on
    if (!on) return
    const position = context.position
    if (position) this.haze.position.set(position.x, 0, position.z)
    if (Number.isFinite(context.yaw)) this.haze.rotation.y = context.yaw
    const time = Number.isFinite(context.time) ? context.time : 0
    const scale = Number.isFinite(pose.scale) && pose.scale > 0 ? pose.scale : 1
    const layers = hazeLayers({ time, offset: this.flickerOffset, amount, scale })
    const positions = this._hazePositions
    const colours = this._hazeColours
    for (let band = 0; band < HAZE_LAYERS; band += 1) {
      const layer = layers[band]
      const outer = layer.halfWidth
      const inner = outer * HAZE_INNER_FRACTION
      const twist = layer.warp * (band % 2 === 0 ? 1 : -1)
      // `HAZE_BAND_FILL` is the pure module's grid and the half-height came from it, so
      // this read is not arithmetic and is not a decision — it is the assertion that the
      // two halves of the pass agree about the same band. It is here rather than only in
      // a gate because a view that rebuilt the grid would then be silently disagreeing
      // with the luma budget rather than failing.
      const h = HAZE_BAND_FILL * HAZE_BAND_HEIGHT * scale
      for (let side = 0; side < 4; side += 1) {
        // The strip's own (radial, vertical) corners, ordered inner-top, outer-top,
        // outer-bottom, inner-bottom so the alpha ramp `0, 1, 1, 0` runs across the
        // two triangles' shared diagonal and the gradient is continuous.
        const corners = [
          [inner, h + twist],
          [outer, h + twist],
          [outer, -h - twist],
          [inner, -h - twist],
        ]
        const alpha = [0, 1, 1, 0]
        const angle = (side * Math.PI) / 2
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const vertex = (band * 4 + side) * 4
        for (let i = 0; i < 4; i += 1) {
          const radial = corners[i][0]
          const at = (vertex + i) * 3
          positions[at] = radial * cos
          positions[at + 1] = layer.y + corners[i][1]
          // `-sin` rather than `sin` so the four sides wind the same way round the
          // column. The material is `DoubleSide` so the winding cannot make a band
          // disappear from one bearing — that was the whole argument for a ring.
          positions[at + 2] = -radial * sin
          const at4 = (vertex + i) * 4
          colours[at4] = 1
          colours[at4 + 1] = 1
          colours[at4 + 2] = 1
          colours[at4 + 3] = layer.alpha * alpha[i]
        }
      }
    }
    this.hazeGeometry.attributes.position.needsUpdate = true
    this.hazeGeometry.attributes.color.needsUpdate = true
  }

  /**
   * `_presentPuffs` — write the live footfalls into the one buffer the field owns.
   *
   * ITERATION 2, PASS 11, and it is `_presentTrail` with one difference that is the
   * whole reason it is a separate method: a puff is a BILLBOARD, so its four corners
   * are laid out on the camera's right and up rather than in the ground plane. The
   * camera's own basis comes from `context.camera.quaternion` — the same quaternion
   * `_billboardEyes` uses — which is why the two scratch vectors are allocated once in
   * the constructor and reused.
   *
   * Without a camera the field falls back to world axes, so a harness that presents a
   * pose without one still writes a valid, visible buffer rather than writing NaNs.
   * That is the same "a missing camera must not stop the render loop" rule
   * `creaturePose` keeps for a missing creature.
   *
   * The per-puff numbers are all `creature.js`'s: `puffAlpha` for the fade,
   * `puffRadius` for the size and `puffLift` for the height. The mark's own seeded
   * `radius` multiplier and `spin` come on `context.puffs` from `puffStep`, and the
   * `spin` is what stops ten quads reading as ten identical stamps.
   *
   * @param {object} [context] `context.puffs` is the world-folded puff list,
   *   `context.time` the world's clock and `context.camera` the billboard basis
   */
  _presentPuffs(context = {}) {
    const puffs = Array.isArray(context.puffs) ? context.puffs : []
    const time = Number.isFinite(context.time) ? context.time : 0
    const camera = context.camera
    const positions = this._puffPositions
    const colours = this._puffColours
    if (camera && camera.quaternion) {
      this._puffRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
      this._puffUp.set(0, 1, 0).applyQuaternion(camera.quaternion)
    } else {
      this._puffRight.set(1, 0, 0)
      this._puffUp.set(0, 1, 0)
    }
    const right = this._puffRight
    const up = this._puffUp
    let slot = 0
    for (let index = 0; index < puffs.length && slot < PUFF_MAX; index += 1) {
      const puff = puffs[index]
      const alpha = puffAlpha(time - puff.born)
      if (alpha <= 0) continue
      const x = Number.isFinite(puff.x) ? puff.x : 0
      const z = Number.isFinite(puff.z) ? puff.z : 0
      const seeded = Number.isFinite(puff.radius) && puff.radius > 0 ? puff.radius : PUFF_RADIUS
      const spin = Number.isFinite(puff.spin) ? puff.spin : 0
      // The age drives the size and the height and the mark's own seeded radius scales
      // it, so a puff is `puffRadius(age) x (0.78..1.22)` across.
      const radius = puffRadius(time - puff.born) * (seeded / PUFF_RADIUS)
      const y = puffLift(time - puff.born)
      const cos = Math.cos(spin)
      const sin = Math.sin(spin)
      // The billboard basis, spun by the mark's own `spin` so no two stamps are
      // oriented alike: `r = right * cos + up * sin`, `u = -right * sin + up * cos`.
      const rx = right.x * cos + up.x * sin
      const ry = right.y * cos + up.y * sin
      const rz = right.z * cos + up.z * sin
      const ux = -right.x * sin + up.x * cos
      const uy = -right.y * sin + up.y * cos
      const uz = -right.z * sin + up.z * cos
      const vertex = slot * 4
      for (let i = 0; i < 4; i += 1) {
        const sx = i === 0 || i === 3 ? -1 : 1
        const sy = i < 2 ? 1 : -1
        const at = (vertex + i) * 3
        positions[at] = x + rx * radius * sx + ux * radius * sy
        positions[at + 1] = y + ry * radius * sx + uy * radius * sy
        positions[at + 2] = z + rz * radius * sx + uz * radius * sy
        // RGB stays at 1 and the tint is the MATERIAL's, exactly as the trail does: one
        // colour, one material, and only the fade varies per mark.
        const at4 = (vertex + i) * 4
        colours[at4] = 1
        colours[at4 + 1] = 1
        colours[at4 + 2] = 1
        colours[at4 + 3] = alpha
      }
      slot += 1
    }
    for (let index = slot; index < PUFF_MAX; index += 1) {
      const vertex = index * 4
      for (let i = 0; i < 4; i += 1) colours[(vertex + i) * 4 + 3] = 0
    }
    this.puffs.visible = slot > 0
    if (!this._puffDirty && slot === 0) return
    this._puffDirty = slot > 0
    this.puffGeometry.attributes.position.needsUpdate = true
    this.puffGeometry.attributes.color.needsUpdate = true
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
    // PASS 10. The trail is a SIBLING of `root` (see `_buildTrail`), so removing
    // `root` from the scene does not remove it, and §15's teardown is exactly the
    // check that would catch that: a 16-quad buffer and a material left attached to
    // a dead scene is a leak that never shows up as a bug and is the debt pass 19
    // exists to sweep. Its geometry and material are already in the two lists below,
    // so removing the object is the only new line.
    this.scene?.remove(this.trail)
    // PASS 11. The haze and the puff field are SIBLINGS of `root` for the same reason
    // the trail is, so removing the figure does not remove them, and §15's teardown is
    // the only check in the repository that would notice a 96-vertex buffer and a
    // 40-vertex buffer left attached to a dead scene. The release itself is already in
    // the two lists below; these two lines are the objects.
    this.scene?.remove(this.haze)
    this.scene?.remove(this.puffs)
    for (const geometry of this._geometries) geometry.dispose()
    for (const material of this._materials) material.dispose()
    this._geometries = []
    this._materials = []
    this.root.clear()
  }
}

export default CreatureView
