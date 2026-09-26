# AESTHETIC-NOTES — pass 4: aesthetic study of the sakuragaoka reference

**Status:** research and writing only. No game code is changed by this pass, and
`npm run check` is unaffected. The single file added is this one.

**Source.** `https://github.com/Kenton-GMI/sakuragaoka-station`, read at commit
`4112f57` ("Sakuragaoka Station: walkable anime cel-shaded sakura station town in
three.js"), shallow-cloned and read locally rather than skimmed through the web
UI: 140 JS files / 43,727 lines, plus `docs/DESIGN.md` (a 192-line builder guide
that is the closest thing the repo has to an aesthetic statement) and the eight
gallery renders in `docs/images/`.

**Read for contrast.** Our `src/game/streetView.js` (1,963 lines) and
`benchmark/screenshots/street.png` as it stands after passes 1–3, plus
`src/game/world.js` for the light rig.

**What was read closely:** `core/materials.js`, `core/geo.js`, `core/sky.js`,
`core/renderer.js`, `core/batch.js`, `core/batch2.js`, `core/ctx.js`,
`world/layout.js`, `world/street.js`, `world/street/mesh.js`,
`world/street/textures.js`, `world/street/furniture.js`,
`world/houses/house.js`, `world/houses/gb.js`, `world/houses/tex.js`,
`world/environment/far.js`, `world/environment/shaders.js`, `world/poles.js`,
`tools/check.mjs`, `tools/shot.mjs`.

---

## 0. The diagnosis, in one paragraph

The reference is a hand-composed town, not a generated one, and it reads as a
place for a reason that has almost nothing to do with modelling quality. Nothing
in it is high-poly. What it has is **a large number of small, cheap interruptions
at human scale**: a wire on every pole crossing the street, a shutter box beside
every window, a 30 mm sill standing proud of the wall, a stain under every
downpipe, a bracket every couple of metres along a gutter, a nameplate beside
every door. Each interruption is 8–40 triangles. The believability is a *density*
property, not a fidelity property. Our street currently has the opposite profile:
a small number of large, clean primitives — a box, a four-sided cone, two hedge
runs — and essentially nothing between them, so the eye reads the gaps as
unfinished rather than as space.

The corollary is the part that is actually useful for passes 5–12: **the gap
between "boxes" and "place" is filled by detail that is silhouette-thin, mostly
mid-distance, and attachable to something already in the scene.** Almost none of
it needs a new texture, and almost none of it needs a light. That is why nine
passes of fidelity work can be scoped without touching the fog model, the
exposure curve, or the four point lights that passes 1–2 tuned.

---

## 1. The seven mechanisms, in the order they matter to us

1. **Silhouette first, surface second.** The reference spends its detail budget
   on things that change the *outline* of a building — eaves, ridges, verge
   boards, parapets, gutters, downpipes, AC units, awnings, sign brackets
   (`house.js` builds hip / gable / shed / pent roofs with ridge, fascia, soffit,
   verge, gable vent, gutter, downpipe with elbow and brackets and a ground
   shoe). A flat box in fog is a flat box. A box with a 180 mm eave overhang and
   a downpipe is a building.
2. **A reserved vocabulary of real-world dimensions.** `DESIGN.md` §4 prints a
   scale table — door 2.0 × 0.85 m, storey 2.9 m, handrail 0.9–1.1 m, bench seat
   0.44 m, vending machine 1.83 × 1.0 × 0.75 m, bicycle 1.75 m, utility pole
   10–12 m. Nothing is "about right"; every dimension is a real one. This is the
   single cheapest believability lever available to us and it costs nothing but
   discipline.
3. **Wires.** In the hero render the overhead cables crossing the street are the
   first thing the eye finds, and they are the strongest single "this is a real
   street" cue in the frame. The reference has 50 `wires.add(...)` call sites and
   they all land in **one draw call** for the whole scene.
4. **Interior behind glass, from a distribution.** Every window in
   `house.js` is a recessed interior quad (dark room / curtain / blind / louver /
   shoji) *plus* a glass pane *plus* a proud frame. The interior is picked from a
   weighted table (`INTERIORS`, `int_lace` twice, `int_blind` twice) and — this is

## 2. Techniques we can port, procedurally

Each is stated as: what the reference does, where it lives, how we would apply it
to the amber-haze night version, and what it costs. Ordered roughly by
believability per unit of risk.

### T1 — Per-instance colour, so one material serves every building
**What.** `houses/tex.js` opens with the whole trick in one line: *"All textures
are neutral/light so vertex colours tint them (one material serves every wall
colour)."* `gb.js` then bins geometry by `mat.uuid|shadow|noOutline|receive` and
carries the colour as a per-vertex attribute, so hundreds of differently-coloured
parts collapse into a handful of draw calls.
**How we apply it.** We are already instancing (`InstancePool`), so the equivalent
is `InstancedMesh.setColorAt` — one `houses` pool, one material, per-lot tint in
the instance colour. This costs one `Float32Array` and removes our need for a
second material per variant. See §4: we need this before pass 5 can mean
anything.
**Cost.** Trivial. One buffer upload at `commit()`.

### T2 — World-scale UVs (metres per tile), not repeat counts
**What.** `gb.js` takes `uv: { world: s }` and computes UVs as
`dimension / s`, so a siding texture is 1.2 m wide *regardless of how big the wall
is*. `street.js` does the same with `ATILE = 4.0` and the comment
`asphalt canvas tile (m): texels stay below a screen pixel in close-ups` — the
tile size is chosen so that at the closest the player can stand, one texel is
just under one pixel.
**How we apply it.** Our `makeSurfaceTexture({ repeat: 180 })` is a bare number
with no unit. Pass 11 should restate every surface texture as *metres per tile*
and derive `repeat` from the mesh's real extent, so a 4 m garage wall and a 12 m
apartment wall show the same board pitch. The texel-density argument also tells us
the resolution to author: at 4 m per 256 px tile, a texel is 15 mm.
**Cost.** Small change to `makeSurfaceTexture` callers; no new textures needed.

### T3 — Build every window as a stack, in depth order
**What.** `house.js` `placeWindows` emits, per window: a recessed interior quad at
z = 0.02 → a glass pane at z = 0.036 → four frame bars spanning z = 0…0.065 (plus
a meeting stile and sometimes a transom) → a sill `w+0.1 × 0.03 × 0.10` standing
proud at z = 0.05 → then optionally a shutter box, a roll-shutter box, a
rain hood, a grille, an upper-floor railing, a rain-streak decal, a flower pot.
**How we apply it.** This is pass 5's core deliverable. The order is the point:
*deepest thing is a dark interior, glass sits in front of it, the frame is proud
of both, and the sill is proudest of all.* A flat lit rectangle on a wall reads
as a sticker; four boxes at four depths reads as a window. Ours should be four
parts, not nine: interior quad, glass, frame, sill — with the frame and sill
proud by 5–8 cm so the silhouette catches the sodium.
**Cost.** ~4 instanced parts per window. At 588 lot instances × 2 windows × 4
parts that is ~4.7k instances — trivial for instancing, and the per-lot count is
where we must be careful (see T5).

### T4 — World-space paint noise, so no surface is flat and nothing tiles
**What.** `patchPaint` (`materials.js`) injects 3D value noise into every toon
material via `onBeforeCompile`, sampled at **world position**, in two octaves
(≈2.2 m and ≈0.5 m features). It multiplies albedo by `1 + paint * n` and mixes
up to `2 * paint` toward a cool grey `(0.93, 0.93, 0.97)` on the positive lobe.
The amount is a material argument (`paint`, default 0.05; the world modules use
0.02–0.035) and it costs **zero** texture memory.
**How we apply it.** This is the single best value in the whole list for a night
scene. Amber sodium light on a clean flat wall is the definition of "3D test
scene"; the same light on a wall with ±4% albedo variation and cool grime in the
lobes reads as damp plaster. It also means we never have to author a
dirt-per-building texture, and it cannot tile because it is not in UV space.
**Cost.** One `onBeforeCompile` patch on our `MeshStandardMaterial` in
`_material()`, plus a `paint` option threaded through. Note it must not fight
pass 2's warm bounce — the grime lobe should be *cool*, so it reads as damp, and
it is the only cool thing allowed on a wall.

### T5 — A per-lot part budget, enforced
**What.** The reference enforces triangle budgets per module and *warns*
(`check.mjs`: `houses: 700e3`, `environment: 350e3`, …; plus a 24 Mpx canvas
budget and a NaN-position check).
**How we apply it.** Our multiplier is brutal and specific: 49 chunks × 4 lots ×
**3 wrapped copies** = 588 lot instances, so every per-lot part costs 3× before
anyone sees it, and the wrap means the count is fixed at build time, not at
runtime. Passes 5–12 should add a stated per-lot part budget (proposal: ≤ 40
instanced parts per lot) and a check that measures the worst lot rather than the
mean, because the mean hides the block that has four facades all facing a street.
**Cost.** One assertion in `verify.mjs`. This is the difference between a fidelity
pass and a 3× memory regression that only shows up on integrated GPUs in pass 17.

### T6 — Facade sub-frames, so all placement is 2D
**What.** Every face of every volume gets a sub-frame (`F.sub(x, 0, z, ry)`) whose
local +Z points out of the wall. Windows, doors, meters and AC units are then
placed in `(u, floor)` coordinates and the sub-frame handles the world transform.
`layout.js` has the same idea at lot scale: origin at the frontage centre, local
+Z faces the street, and `lotToWorld(lot, lx, lz)` converts.
**How we apply it.** We already have `lotFrame(lot)` and `atDepth(frame, o, d)`.
Passes 5–9 should add a per-facade local frame and place against it, because
windows on a 64 m block's four different lot orientations otherwise need four
copies of the placement maths and four chances to be wrong. It also makes
"which side faces the street" a data question instead of a trigonometry question.
**Cost.** A small helper. High leverage, low risk.

### T7 — Catenary spans
**What.** `geo.js` `catenary(a, b, sag, segments)` — a parabola,
`p.y -= sag * 4t(1 - t)` — and 50 call sites hang it between poles.
**How we apply it.** Pass 6, and it is the highest believability-per-line in the
list. Wires must **sag**; a straight line between two poles reads as a mistake,
and a sagging one reads as a span that has been there for thirty years. Our spans
should not all sag the same amount: heavier trunk cables sag more than telecom,
and one span in five should be noticeably lower than its neighbours.
**Cost.** ~14 segments per span, one buffer.

### T8 — A screen-space wire ribbon
**What.** The reference's wire system projects each segment and expands it to a
minimum of ~1.15 px on screen, clips the segment against the near plane so a
wire behind the camera cannot smear, and **fades sub-pixel wires by coverage
rather than letting them alias** (`vCov = clamp(pxWorld / uMinPx, 0.18, 1.0)`).
Everything lands in one mesh, `frustumCulled = false`, no outline pass.
**How we apply it.** Port as-is. Thin geometry is the classic way wires disappear
at distance and shimmer up close; the reference's answer is to make width a
*screen-space* quantity and let opacity carry sub-pixel geometry. In our fog this
matters more, not less: a wire that fades with distance is a wire that reads as
depth, and a wire that shimmers is a wire that reads as a bug.
**Cost.** One shader, one draw call, 50-ish spans' worth of vertices.

### T9 — Atlas with a reserved white texel
**What.** `houses/tex.js` packs ~40 canvas items into a 1024² atlas with padded,
stretched gutters (to stop mip bleed) and rewrites UVs into the cell; faces that
should be plain sample a reserved near-white texel. `street/textures.js` does the
same at 1024 for road glyphs, utility decals and sign faces, with a
`uvOf(cell, u, v)` helper.
**How we apply it.** Pass 5 and 8 both want many small distinct faces (window
interiors, nameplates, manhole covers, sign faces, ad panels). One atlas plus one
material beats N materials, and the white texel is what lets an atlas-backed
material also serve plain surfaces.
**Cost.** One shelf-packing helper plus a rect table. Procedural, no assets.

### T10 — Worn paint, and the decal discipline that goes with it
**What.** `mat.decal` is a toon material with `polygonOffset: -2` and
`depthWrite: false`, and the guide is explicit that it must *still* be lifted
3–10 mm off the surface. The road-marking texture is then drawn worn: `wear(g,
…)` abrades the paint, `wash()` lays an uneven tone over it, and the tile is
anisotropic (`anisotropy: 16`) because it is seen at a grazing angle.
**How we apply it.** Pass 8, and the lift matters: a centre dash coplanar with the
road is a z-fight, and a z-fight in a still capture is a defect a reader will
find instantly. Worn paint also does narrative work — **faded** markings say a
street nobody has resurfaced, which is exactly our premise. The 2 cm apron we
already use under the portal is the same rule and should become a named constant.
**Cost.** Near zero. Highest legibility-per-triangle in the entire list.

### T11 — An emissive ladder
**What.** `mat.emissive(colour, intensity)` is a `MeshBasicMaterial` with the
colour multiplied by intensity; the guide notes that above ~1.1 it blooms softly.
Vending machines run 0.86–1.0 across their liner, back panel, IC face, product
rows and rails; the door lamp is `emissive('#ffd9a0', …)`. Lit signs are
emissive; the surfaces around them are not.
**How we apply it.** We already have `_glow` with `fog: false`, which is right.
Passes 5/7 should formalise the ladder — portal cyan (brightest, by far),
sodium lamp head, the single lit vending machine, one or two lit windows, the exit
car's plate — and let it be the **only** saturated light in the frame. The
reference uses saturated colour on a dozen signs; we use it on four things, and
that is a deliberate inversion (§3).
**Cost.** Nothing. It is a discipline, not a feature.

### T12 — A sky dome that lives on the far plane and agrees with the fog
**What.** A 1800 m sphere with `gl_Position = p.xyww` (pinned to the far plane,
so it is always behind everything), `renderOrder = -10`, `frustumCulled = false`,
position copied from the camera each frame, and a fragment shader whose
**below-horizon region mixes to the fog colour** over `h ∈ [-0.12, 0.02]`. That
last line is why their sky, terrain and distant geometry never show a seam.
**How we apply it.** Pass 10. Ours is a flat background colour today, which is why
the current `street.png` has a hard band at the horizon. The dome is also where
"faint cloud bands catching sodium glow" belongs: in the reference, cloud colour
is `mix(cLit, warm, pow(sd, 5))` — the cloud is *lit by the sun*, not tinted
independently. Ours should be lit by the **sodium** below and by nothing above.
Keep it hazed and starless; `PASS 10` already says so and it is right.
**Cost.** One shader, one draw call.

### T13 — Layered distance with a per-layer fog multiplier
**What.** `far.js` builds three ridge rings as 420-column swept ribbons with a
7-row cross-section (`shape = [-0.18, 0.3, 0.72, 0.97, 1.0, 0.7, 0.15]` — a
soft crest, not a wall), peaks from `fbm` + `ridged` noise, per-ring `haze`,
`hazeMin`, `mist` and `fogMul`.
**How we apply it.** Pass 10, with one change: ours should be a **single** ring, a
few degrees above the fog line, almost entirely fog-coloured, so it reads as
"there is more city out there and you cannot see it". The reference's three
legible bands would *improve* the picture and destroy the fear — see §3 D5. The
technique to keep is the per-layer `fogMul` idea in miniature: the skyline ring
should be pulled slightly *out* of the fog so it does not vanish, and it should
be the only thing permitted above the fog line.
**Cost.** One ring, one shader, ~3k triangles.

### T14 — The verification loop
**What.** `DESIGN.md` §8 is a procedure, not a vibe: run the budget check; then
shoot from **close-ups (1–3 m), mid shots, the hero view and a high overview**;
then *"look at every PNG with the Read tool and fix what you see: floating/sunken
objects, z-fighting, mirrored text, wrong scale, missing faces, harsh colours,
clutter, dull areas. Iterate several times."* `shot.mjs` takes a `--t` so the
screenshot is at a **deterministic sim time**.
**How we apply it.** We already have the stronger half of this: `tools/capture.mjs`
with a fixed view table and the §16.5 luma gate. What we lack is the *close-up*
and *overview* pair. Passes 5–12 should add three non-gallery probe cameras (a 1.5 m
close-up of a wall, a mid shot down an avenue, a high overview) that are rendered
during the pass and *looked at*, and — this is the part worth copying — the
explicit failure list. "Dull areas" is in their list and it is the one we are
most likely to hit: a darker frame with a higher mean luma is not the same as a
frame with more to look at.
**Cost.** Camera rows in `capture.js` and a few minutes per pass.

---

## 3. What we deliberately keep different

The reference is 16:00 on a spring afternoon: hemisphere 1.62, sun 2.75, pastel
albedos, saturated accents on a dozen signs, ~4M triangles, and 30+ townspeople,
cats, sparrows and two trains on a two-minute timetable. Ours is the checklist's
"yellow-tinted cinematic dusk" — night-horror, lit — with a hemisphere at 0.85
and four point lights doing the real work. The techniques in §2 are portable; the
*result* is not the goal. These are the differences we keep on purpose, and each
one is a design decision rather than a shortfall.

- **D1 — No cel ramp, no outlines, no painted sky.** Their look is a 16-texel
  toon `gradientMap` plus a screen-space colour-aware outline pass and a film
  grade. We use `MeshStandardMaterial` with ACES filmic. Porting cel shading to a
  horror game would make the creature's silhouette *less* legible, which is the one
  thing §4 and pass 15 cannot afford. Not porting it.
- **D2 — Empty.** No pedestrians, no animals, no birds, no trains, no shop
  interiors. This is the single largest deliberate divergence and it is the
  correct one: a populated street is a street you feel safe in, and every extra
  life in the frame is a life the player will look for. The absence is the tell.
  It also means the reference's *life* budget — characters 200k, trains 350k,
  petals 250k — is budget we do not have to spend on fidelity.
- **D3 — Most windows dark, and the lit ones ambiguous.** The reference lights
  interiors with p = 0.04 in a bright afternoon. Ours should be lower still, and
  each lit window should sit in a building with no other sign of occupancy. A lit
  window is a question — *is someone home?* — and that question is the mechanic.
  Two lit windows on the same facade is a mistake.
- **D4 — Ambient stays low; the sodium does the reading.** Our hemisphere is 0.85
  and our sunset directional is 0.34 (passes 1–2). Their ambient does the work and
  their lamps are accents. Inverting that is what makes our pools read as pools,
  and it is why the fidelity passes must **not** raise ambient — detail has to be
  found in the light we already have, not in light we add.
- **D5 — Distance is a wall, not a vista.** Our `FogExp2` is heavier than theirs
  (0.0026). Three legible ridge rings at 745/900/1120 m would make the world feel
  *small and surveyed*. We want one suggestion of a skyline that the fog is
  eating. Keep the fog; spend the saved complexity budget on the near field.
- **D6 — Four saturated things, not a dozen.** Portal cyan, sodium amber, the one
  lit vending machine, and the exit car's headlights. Everything else in the frame
  is desaturated. This inverts the reference's `signBlue/signRed/signYellow/
  signGreen` habit, and it is deliberate: when only four things in the world are
  coloured, the eye goes to them, and one of them is the thing hunting them.
- **D7 — Flicker stays.** Their lamps are steady. Ours flicker, because a street
  light that misbehaves is a warning and a steady one is furniture. If a fidelity
  pass makes the lamps look calmer, that is a regression.
- **D8 — Parametric variety, not authored uniqueness.** They hand-placed a hero
  view and wrote "keep that view corridor readable" into the contract. We have 588
  instances across four lot orientations, so we cannot have a hero view — we have
  to make *every* avenue photographable. Variety must come from seeded per-lot
  parameters, and the wrap is a feature to hide, not a seam to apologise for.
- **D9 — No interiors, no shops, no shrine, no level crossing.** Each of those is a
  place-that-is-occupied, and each would be a lit, warm, inviting pocket. Our
  liminal structures (shed, bus shelter, phone box) are the right version of that
  idea for this game and they already exist.
- **D10 — Determinism and the wrap are non-negotiable.** They have neither
  `hash32` nor a toroidal map, and they can afford a `?t=` fast-forward. We
  cannot: the maze seed, the loop rules and the win condition must stay
  comparable between runs (AGENTS.md), and every capture must be reproducible.
  Any technique whose output depends on iteration order or unseeded randomness is
  out.

---

## 4. A prerequisite finding, and why it blocks pass 5

While reading `_addLot` against the reference's colour strategy, one thing in our
own code turned up. It is reported here rather than fixed, because this pass is
research-only — but it should be the first thing pass 5 fixes, and it is worth
being precise about why, because the failure is invisible rather than loud.

`streetView.js:1187` does this, inside the per-lot loop:

```js
this.pools.houses.mesh.material = this._materials.siding[tint]
this.pools.houses.place(cx, wall / 2, cz, w, wall, d)
```

An `InstancedMesh` has exactly one material slot. Assigning to it once per lot
means every instance in the pool renders with whatever material was assigned
*last*, not with the one its lot asked for. `PALETTE.siding` is a two-entry array
and `lot.tint` alternates, so the intended effect — a block whose houses agree
with each other while two blocks differ — is not what is on screen. The comment
above it describes the intent, and the intent is not implemented.

`streetView.js:1207` has the same shape and a worse consequence:

```js
this.pools.frontage.mesh.material = kind === 'hedge' ? hedge : fence
```

Hedge and fence instances are placed into the *same* pool (chosen by
`(chunk.cx + chunk.cz + SIDE_NAMES.indexOf(lot.side)) % 2`), so a single material
cannot render both. Every hedge in the world is drawn as a fence or vice versa.

I checked the obvious alternatives: there is no `setColorAt`, no `instanceColor`
and no `vertexColors` anywhere under `src/game/`. So today we have no
per-instance colour facility at all, and the two `mesh.material` reassignments
are doing nothing except making the last lot in build order win.

**Why this is pass 5's problem and not a cleanup item.** Pass 5's brief is
"buildings stop being flat extrusions", and roughly half of what makes a
building not-flat is that it is not the same colour as the one across the street.
The reference solves this once, structurally, and states it as a rule: *neutral
textures, colour in the vertices, one material serves every wall colour*
(`houses/tex.js` line 1). Our equivalent under instancing is
`InstancedMesh.setColorAt`, which is the same idea with the tint moved from a
vertex attribute to an instance attribute.

So pass 5 should, in this order:

1. add `setColorAt` to `InstancePool` and set `instanceColor.needsUpdate` in
   `commit()`;
2. fold `_materials.siding` down to a single material and set per-instance colour
   instead of reassigning `mesh.material`;
3. split the frontage pool into `frontageHedge` and `frontageFence`, or give it
   per-instance colour — one of the two, not the current "both, in one pool, one
   material";
4. add a check that asserts **every instance in a pool resolves to the colour its
   lot asked for**. A check that only asserts the material is not `undefined`
   would pass vacuously here, which is the trap the pass-3 reviewer already caught
   once (`the luma gate passed a picture of a wall`).

This is a genuine latent defect, not a nit: it is currently costing us the
per-block colour variety that §12.3 of GAMEDESIGN claims the world has.

---

## 5. Prioritised plan for passes 5–12

The checklist's own order is right and I am not proposing to change it. What
follows is the order *within* each pass, the technique each item comes from, and
the one dependency that is not obvious from the brief.

### Pass 5 — Building depth  *(P0: the highest-leverage pass in the run)*
Everything after this puts objects *against* buildings, and they inherit the
buildings' credibility. Do this one properly.
1. **Per-instance colour (§4).** Non-negotiable and first; it is the enabler for
   everything else in the pass.
2. **The window stack (T3, T6, T9).** Interior quad → glass → frame → sill, at
   four depths, against a facade sub-frame. Two windows per street-facing facade
   plus one per flank, not four per facade — see the budget note below.
3. **Roofline silhouette (mechanism 1).** Replace the `ConeGeometry(0.72, 1, 4)`
   pyramid with a **parapet**: a cap box set 60 mm proud and a set-back top
   course. A four-sided cone at 1.9 m is the single most toy-like object on the
   current street; a flat cap with a lip is a building. Add one AC box and one
   vent box per building, on the street facade, at storey height.
4. **Door recess + steps + canopy + entry lamp.** The entry is what tells a player
   a building is a building. Recess 15 cm, two steps at real riser heights
   (170 mm), a 400 mm canopy, and one warm lamp over the door — on the emissive
   ladder (T11), at the *lowest* rung, dimmer than any window.
5. **Belt band** at the storey line, 140 mm, standing 50 mm proud, so a two-storey
   wall reads as two storeys.
6. **Emissive variance (D3).** Roughly one window in eight is lit, never two on
   the same facade, and the lit interior gets a *dim* warm emissive rather than a
   bright one — it should be visible, not inviting.

**Budget note.** 588 lot instances is already paid; the discipline that matters is
per-lot part count (T5). If the above lands at ~30 parts per lot — comfortably
under T5's ceiling of 40 — the whole pass costs ~17.6k instances across a
handful of pools, which is nothing. The failure mode is not size, it is that
somebody adds a fourth window per facade on all four facades and nobody notices
until pass 17.

### Pass 6 — Street furniture I  *(P0: best believability per line in the run)*
1. **The wire ribbon (T8) first, before anything is placed on it.** Build the
   screen-space ribbon and the one-mesh buffer, then hang content on it. Doing it
   second means retrofitting a second representation.
2. **Catenary spans (T7).** Trunk, secondary and telecom at three heights and
   three sag amounts, running along the block edges and zigzagging across the
   avenue at the intersections. Poles go at block corners, 8–10 m, with a
   crossarm and two insulators.
3. **Then** traffic signs at intersections, hydrants, drain grates — all small,
   all cheap, all placed against the new facade sub-frames from pass 5.

**Why first among the furniture passes:** in the reference's hero render the
wires are the first thing the eye finds, they cost one draw call, and they are
the only pass-6 item that changes how an *empty* street reads. Poles without
wires look like lamp posts, which we already have 49 of.

### Pass 7 — Street furniture II
Dumpsters, bollards, trash bags, bus-shelter ad panels (dim), and the **one lit
vending machine**. Per-district placement rules, because uniformity is what makes
a generated street read as generated. The vending machine is the only saturated
object permitted here (D6) and it should be far from spawn, seen down an avenue
before the player reaches it — that is the "sightline accent" pass 12 formalises.

### Pass 8 — Ground detail  *(P1: the biggest legibility win for the §16.5 gate)*
Right now the road is a flat plane and the only things on it are the sodium pools.
1. **Take the paint-noise and worn-paint half of pass 11 now (T4, T10).** The
   checklist puts 11 after 8; the *material-variation* half should stay there, but
   the world-space noise and the decal discipline have to exist before the first
   marking is laid down, or the ground gets painted twice.
2. Faded centre dashes, crosswalks at intersections, kerb joints, sidewalk seam
   lines, manholes, patch repairs — all decals at the 2 cm lift, all worn.
3. Yard variety: a different fence type per district, which is also the cheapest
   way to make four districts feel like four places.

### Pass 9 — Vehicles
Hatchback / sedan / van profiles in muted colours, wheel arches instead of box
wheels, one set of hazards blinking far off. The exit car gets mirrors and a plate
that glows in the headlight wash. Keep the palette desaturated (D6) — a red car
would be the fifth saturated thing and would cost us the ladder.

### Pass 10 — Sky volume  *(P1, and it depends on pass 6)*
1. **Sky dome (T12).** Gradient, pinned to the far plane, below-horizon mixing to
   the fog colour so the current hard band at the horizon goes away.
2. **Faint cloud bands lit by the sodium from below**, hazed, starless.
3. **One skyline ring (T13)**, just above the fog line, pulled slightly out of the
   fog so it does not vanish. Not three rings (D5).
4. The wires from pass 6 crossing the dome are what make this read as *sky* rather
   than as a gradient — which is why 10 wants 6 to be finished, not started.

### Pass 11 — Materials pass (the remaining half)
Per-building roughness and colour variation (T1 + T2, restated as *metres per
tile*), asphalt wear, damp patches near drains, grime streaks under windows via
canvas textures. By this point the atlas (T9) already exists from passes 5 and 8,
so this pass is about the *surfaces*, not the plumbing.

### Pass 12 — Composition
Vary setbacks and heights per district; put exactly one lit window at the end of
each of three named avenues and check the three captures as photographs. Prune
anything that clutters. This is where the reference's authored hero view (its
"keep this view corridor readable" rule, see D8) becomes "every avenue is a
photograph", which is the version we can actually afford.

### Cross-cutting, owned by whichever pass touches it
- **T5** per-lot part budget assertion (introduced in pass 5).
- **T14** the three probe cameras — 1.5 m close-up, mid shot down an avenue, high
  overview — rendered and *looked at* every pass from 5 onward, against the
  reference's failure list: floating/sunken objects, z-fighting, wrong scale,
  missing faces, clutter, dull areas.
- **Per §16.5, re-run the luma gate on every capture pass and replace the gallery
  PNGs; never hand-edit one.** The risk across passes 5–12 is that added detail
  brightens the mean and quietly invalidates a floor that was justified against a
  darker world.

---

## 6. What we looked at and are not taking, and why

Stated so a later pass does not "discover" it and spend a pass on it.

- **The geometry accumulator (`gb.js`) and the merge pass (`batch2.js`).** Both
  exist to serve ~4M triangles of hand-placed geometry in a scene that is
  authored once and never shuffled. We are instanced, wrapped 3×, and permuted
  per loop (§3.3) — a baked accumulator is the wrong data structure for a world
  that has to be re-derivable from a seed. The *idea* behind it (one material,
  many colours) is taken as T1; the machinery is not.
- **The 4096² atlas and 48 m / 200 m spatial cells.** Correct at their scale,
  premature at ours. Our atlas (§2 T9) is 1024², which is the right order.
- **The normal+depth prepass, outline pass, bloom chain and film grade.** A
  second render pass and three post buffers to make edges inked. Ours needs the
  creature's edge to stay clean, and ACES plus a real silhouette does that at a
  fraction of the cost. Revisit only if pass 15 finds the creature not reading.
- **Vehicles, trains, characters, petals, foliage, the river, the levee, the
  shrine, the level crossing.** Roughly 2.2M of their 4M triangles, and all of it
  is D2/D9.
- **Shadow-box-follows-camera snapped to texels (`sky.js` 99–113).** Correct and
  cheap, and worth revisiting *only* if pass 17 finds shadow shimmer; we have one
  directional light at 0.34 intensity casting soft shadows over a scene whose
  point lights do the real work, so shimmer is currently not a visible problem.

---

## 7. One-line summary for the reviewer

The reference reads as a place because of *density of small silhouette-changing
interruptions* — wires, sills, sills-and-frames at four depths, parapets,
gutters, worn paint — not because of modelling quality. Ports 4, 6 and 10 carry
most of the value per line of code; §4 is a real defect that pass 5 must fix
before "buildings stop being flat extrusions" can mean anything; and the ten
differences in §3 are the reason we are not trying to reproduce the reference's
picture, only its method.

   the detail worth stealing — a *warm-lit* interior appears with probability
   **0.04**. The lit windows are rare enough to be events.
5. **Placement by reservation, not by rejection sampling.** `house.js` gives every
   volume four faces, and each face keeps a `res` list of `[floor, u0, u1]` spans
   it has already given away. The entrance reserves its span first, the balcony
   second, then windows are placed into what is left, via `free()` / `reserve()`.
   Volumes that touch auto-occlude each other's faces, and a wing roof marks its
   own span `'low'` so no window is placed on the roof line. This is why nothing
   ever intersects and nothing ever looks randomly placed.
6. **The ground is a designed surface, not a plane.** Gutters, drainage channels
   with grates and lids, manhole covers, repair patches, trenches, seals, oil
   stains, worn tyre paths, centre dashes, stop lines, crossings, tactile paving.
   All of it is decals and a few millimetres of geometry on a base plane.
7. **Distance is layered, not fogged.** Three ridge rings at 745 / 900 / 1120 m,
   each with its own height band, crown noise, haze colour, haze floor, and a
   `fogMul` of 0.36 / 0.30 / 0.26. The far ring is *deliberately pulled back out
   of the fog* so it does not dissolve. The sky dome's below-horizon region fades
   to exactly the fog colour, so the sky, the terrain and the far geometry all
   agree at the seam.

---
