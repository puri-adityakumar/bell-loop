import { PHASE } from '../game/loop.js'
import { SHRINE_IDS } from '../game/maze.js'

/**
 * HUD (loop 8 redesign): thin letter-spaced uppercase type, three small flame
 * sigils that ignite as shrines light, and a thin failing-heartbeat timer line
 * that retracts and reddens as the bell approaches. Deliberately text-free
 * apart from the loop number.
 */

const FLAME_PATH = 'M6 0.5 C7.6 3.6 10.6 5.8 10.6 9.6 A4.6 4.6 0 0 1 1.4 9.6 C1.4 5.8 4.4 3.6 6 0.5 Z'

export default function Hud({ hud }) {
  const visible = hud.phase === PHASE.PLAYING || hud.phase === PHASE.RESET
  // the heartbeat line: retracts with the timer and reddens as the bell nears
  const danger = 1 - hud.timeFraction
  const critical = hud.timeFraction < 0.18
  const traceColor = `rgba(${Math.round(150 + 105 * danger)}, ${Math.round(198 - 138 * danger)}, ${Math.round(164 - 104 * danger)}, 0.85)`
  const traceGlow = `0 0 ${Math.round(4 + 8 * danger)}px rgba(${Math.round(180 + 75 * danger)}, 60, 40, ${0.25 + 0.45 * danger})`
  return (
    <>
      <div className="fade" style={{ opacity: hud.fade }} aria-hidden="true" />
      <div className={`hud${visible ? '' : ' hud--hidden'}`}>
        <div className="hud__loop">
          <span className="hud__loop-label">LOOP</span>
          <span className="hud__loop-value">{hud.loop}</span>
        </div>
        <div className="hud__candles" aria-hidden="true">
          {SHRINE_IDS.map((id) => (
            <span key={id} className={`flame-sigil${hud.candles[id] ? ' flame-sigil--lit' : ''}`}>
              <svg viewBox="0 0 12 16" className="flame-sigil__flame">
                <path d={FLAME_PATH} />
              </svg>
              <svg viewBox="0 0 12 16" className="flame-sigil__core">
                <ellipse cx="6" cy="10.4" rx="1.7" ry="2.4" />
              </svg>
              <span className="flame-sigil__wick" />
            </span>
          ))}
        </div>
        <div className={`hud__timer${critical ? ' hud__timer--critical' : ''}`} aria-hidden="true">
          <span
            className="hud__heartbeat"
            style={{ transform: `scaleX(${hud.timeFraction})` }}
          >
            <svg viewBox="0 0 200 12" preserveAspectRatio="none" className="hud__heartbeat-svg">
              <path
                d="M0 6 H36 L40 2 L44 10 L48 3 L51 6 H86 L90 2 L94 10 L98 3 L101 6 H136 L140 2 L144 10 L148 3 L151 6 H186 L190 2 L194 10 L198 6 H200"
                fill="none"
                stroke={traceColor}
                strokeWidth="1.1"
                style={{ filter: traceGlow }}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </span>
        </div>
        <div className={`hud__prompt${hud.prompt === 'light' ? ' hud__prompt--on' : ''}`} aria-hidden="true">
          <span className="hud__prompt-key">E</span>
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
