import { PHASE } from '../game/store.js'
import { HOLD_RING, SIGIL_DARK, SIGIL_LIT } from './hud.js'

/**
 * HUD (v2, slice 12): three portal sigils, a hammer sigil, the loop counter, and
 * the radial hold ring — plus the three post-processing layers the awareness and
 * breath tells drive.
 *
 * THE ONE RULE IN THIS FILE
 * -------------------------
 * It paints `hudSnapshot` and nothing else. There is no state here, no effect,
 * no timer and no subscription; every value below arrives as a prop that the
 * store produced, and the store is the only thing that knows anything. That is
 * why the sigils cannot lag the simulation, why the reduced-motion class arrives
 * with the frame it belongs to, and why adding a readout to this game is a change
 * to `hud.js`'s closed field list rather than a change to a component.
 *
 * TEXT-FREE, AND THE LOOP COUNTER IS THE EXCEPTION
 * ------------------------------------------------
 * §14.1: "No new text is introduced." The only glyphs on screen are `LOOP` and
 * its number, which §9.2 kept in its existing slot, and the `E` key hint v1
 * already drew. `verify.mjs` greps this file's JSX for text nodes and asserts
 * exactly that set, so "the HUD is text-free" is a check rather than a habit.
 *
 * WHY THE SIGNALS ARE CSS VARIABLES AND NOT INLINE STYLES
 * -------------------------------------------------------
 * The tells are *levels* — 0..1 amounts of darkness, coarseness, breath — and
 * the oscillation that turns them into something moving is a stylesheet
 * animation. React therefore paints a number and the browser does the animating.
 * That is what lets a 2.2 s breath run at 60 Hz for the cost of one repaint per
 * breath-level change, and it is what lets §14.3's toggle turn the whole thing
 * off with `animation: none` instead of a stack of `if`s.
 */

/** §5.2's verb, and the only key hint the HUD has ever drawn. */
const PROMPT_KEY = 'E'

/**
 * The portal sigil: a doorway arch. Lit is a solid body; extinguished is the
 * same arch with nothing in it — §14.3's colour-blind commitment drawn as
 * geometry rather than as a colour swap, so the two states survive a greyscale
 * screenshot and a player who is not looking at the hue.
 */
const PORTAL_PATH = 'M3 15 V7.5 A3 3 0 0 1 9 7.5 V15 Z'

/** The hammer: head and haft, one path, so it reads at 16 px. */
const HAMMER_PATH = 'M2.6 5.4 L6.2 1.8 H14.2 V5.4 H9.6 L5.4 9.2 H2.6 Z M7.2 8.2 L9.2 10.2 L4.4 15 H1.6 Z'

/** Inline SVG presentation, so React owns both halves of the sigil's paint. */
function sigilStyle(mark) {
  return {
    // §14.3: `fill` is the whole of the state. `none` is an extinguished sigil.
    fill: mark.filled ? mark.color : 'none',
    stroke: mark.stroke,
    strokeWidth: 1,
    filter: mark.glow > 0 ? `drop-shadow(0 0 ${Math.round(mark.glow * 7)}px ${mark.color})` : 'none',
  }
}

function Sigil({ mark, d, viewBox, flash = 0 }) {
  return (
    <span
      className={`sigil sigil--${mark.state}${flash > 0 ? ' sigil--flash' : ''}`}
      style={{ '--flash': flash.toFixed(3) }}
    >
      <svg viewBox={viewBox} className="sigil__mark" style={sigilStyle(mark)} aria-hidden="true">
        <path d={d} />
      </svg>
    </span>
  )
}

export default function Hud({ hud }) {
  const visible = hud.phase === PHASE.PLAYING || hud.phase === PHASE.RESET
  // §14.3's motion switch, as a class: the store flag cannot reach a keyframe,
  // and `animation: none` is the only thing that reliably stops one. Each block
  // carries its own modifier — the grain is not part of `.hud`, and a class that
  // outlives its own block is how a stylesheet grows two spellings of one idea.
  return (
    <>
      <div className="fade" style={{ opacity: hud.fade }} aria-hidden="true" />
      {/*
        §14.3's awareness and breath tells drive v1's own three post layers —
        retained, as the design asks, and driven by variables rather than replaced
        with new ones. The vignette is the *shared* layer both tells compose onto
        in `hud.vignetteTell`, so there is one element here and not two owners
        fighting over it.
      */}
      <div
        className="vignette"
        aria-hidden="true"
        style={{
          '--vignette': hud.vignette.level.toFixed(3),
          '--vignette-clear': `${hud.vignette.clear.toFixed(1)}%`,
          '--breath-amp': hud.breathPulse.amplitude.toFixed(3),
          '--breath-period': `${hud.breathPulse.period.toFixed(2)}s`,
        }}
      />
      <div
        className={`grain${hud.finaleActive && hud.finaleLevel > 0 ? ' grain--finale' : ''}${hud.reducedMotion ? ' grain--still' : ''}`}
        aria-hidden="true"
        style={{
          '--grain-opacity': hud.grain.opacity.toFixed(3),
          '--grain-scale': hud.grain.scale.toFixed(3),
          '--finale': hud.finaleLevel.toFixed(3),
        }}
      />
      <div className="desat" aria-hidden="true" style={{ '--finale': hud.finaleLevel.toFixed(3) }} />
      <div className={`hud${visible ? '' : ' hud--hidden'}${hud.reducedMotion ? ' hud--still' : ''}`}>
        <div className="hud__loop">
          <span className="hud__loop-label">LOOP</span>
          <span className="hud__loop-value">{hud.loop}</span>
        </div>
        {/* §14.1: v1's three flame sigils are three portal sigils. The count and
            the slot are the same; what they mean is not — and they are dark, not
            lit, once their portal is shut. */}
        <div className="hud__sigils" aria-hidden="true">
          {hud.sigils.map((mark) => (
            <Sigil key={mark.id} mark={mark} d={PORTAL_PATH} viewBox="0 0 12 16" />
          ))}
          <span className="hud__sigil-divider" />
          <Sigil mark={hud.hammer} d={HAMMER_PATH} viewBox="0 0 16 16" flash={hud.hammer.flash} />
        </div>
        {/*
          §14.2: the one new piece of HUD geometry. The `E` prompt is v1's and
          keeps its slot; the ring is drawn around it, and its tick sits at the
          §5.2 threshold, so the player is told which half of the hold is the
          expensive one without reading anything.
        */}
        <div
          className={`hud__prompt${hud.ring.active ? ' hud__prompt--on' : ''}${hud.ring.loud ? ' hud__prompt--loud' : ''}`}
          aria-hidden="true"
        >
          <svg className="hud__ring" viewBox={`0 0 ${HOLD_RING.size} ${HOLD_RING.size}`}>
            <circle
              className="hud__ring-track"
              cx={HOLD_RING.size / 2}
              cy={HOLD_RING.size / 2}
              r={HOLD_RING.radius}
            />
            <circle
              className="hud__ring-fill"
              cx={HOLD_RING.size / 2}
              cy={HOLD_RING.size / 2}
              r={HOLD_RING.radius}
              strokeDasharray={hud.ring.dashArray}
              strokeDashoffset={hud.ring.dashOffset}
            />
            {/* the midpoint tick: the noise threshold, communicated spatially */}
            <line
              className={`hud__ring-tick${hud.ring.tickPassed ? ' hud__ring-tick--passed' : ''}`}
              x1={HOLD_RING.size / 2}
              y1={HOLD_RING.size / 2 - HOLD_RING.radius - 2.5}
              x2={HOLD_RING.size / 2}
              y2={HOLD_RING.size / 2 - HOLD_RING.radius + 1.5}
              transform={`rotate(${hud.ring.tickAngle} ${HOLD_RING.size / 2} ${HOLD_RING.size / 2})`}
            />
          </svg>
          <span className="hud__prompt-key">{PROMPT_KEY}</span>
        </div>
        {hud.showFps && hud.phase !== PHASE.START ? (
          <div className="hud__fps" aria-hidden="true">
            {hud.fps}
          </div>
        ) : null}
      </div>
    </>
  )
}

export { SIGIL_LIT, SIGIL_DARK }

