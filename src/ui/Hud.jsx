import { PHASE } from '../game/loop.js'
import { SHRINE_IDS } from '../game/maze.js'

/**
 * HUD: loop counter, three candle lights, the thin depleting timer bar, the
 * fade-to-black layer and the "in reach" prompt. Deliberately text-free apart
 * from the loop number.
 */
export default function Hud({ hud }) {
  const visible = hud.phase === PHASE.PLAYING || hud.phase === PHASE.RESET
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
            <span key={id} className={`candle-dot${hud.candles[id] ? ' candle-dot--lit' : ''}`} />
          ))}
        </div>
        <div className="hud__timer" aria-hidden="true">
          <span className="hud__timer-fill" style={{ transform: `scaleX(${hud.timeFraction})` }} />
        </div>
        <div className={`hud__prompt${hud.prompt === 'light' ? ' hud__prompt--on' : ''}`} aria-hidden="true">
          <span className="hud__prompt-key">E</span>
        </div>
      </div>
    </>
  )
}
