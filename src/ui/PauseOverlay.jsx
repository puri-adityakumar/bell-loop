import { useEffect, useRef } from 'react'

/**
 * The pause card — §14.3's "Esc / pointer-lock loss pauses and freezes the
 * simulation completely, including the creature".
 *
 * WHY THIS IS OVERLAY CHROME AND NOT HUD
 * ---------------------------------------
 * §14.1's "no new text is introduced" is about the *HUD*: the sigils, the
 * counter, the ring, the tells. A pause menu that could not say anything would
 * not be a menu — a player who cannot tell that the game has stopped, or that
 * the setting they just changed took effect, has been handed a dead screen. The
 * design's own §14.3 requires a *toggle*, and a toggle has to be a control with
 * a name. So the two commitments are kept apart deliberately: nothing is added to
 * the HUD, and the card is a sibling of the title and win overlays, in the same
 * `.overlay` shell, rather than a fifth thing inside `.hud`.
 *
 * The three words here are the smallest set that makes the card usable: what
 * state the game is in, how to leave it, and the one setting §14.3 promises.
 */
export default function PauseOverlay({ reducedMotion, onResume, onToggleMotion }) {
  // the card owns a ref so Esc can be handled from the *card* as well as from
  // the world: the world's key listener is gone if the game was never started,
  // and a player who pauses by alt-tabbing away still has to be able to leave
  // the way they came in
  const cardRef = useRef(null)
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code === 'Escape') {
        event.preventDefault()
        onResume()
      }
    }
    const node = cardRef.current
    node?.addEventListener('keydown', onKeyDown)
    return () => node?.removeEventListener('keydown', onKeyDown)
  }, [onResume])

  return (
    <div className="overlay overlay--pause" ref={cardRef}>
      <h1 className="pause-title">PAUSED</h1>
      <div className="pause-actions">
        <button type="button" className="brass-button" onClick={onResume} autoFocus>
          RESUME
        </button>
        <button
          type="button"
          className="brass-button brass-button--toggle"
          onClick={onToggleMotion}
          aria-pressed={reducedMotion}
        >
          {reducedMotion ? 'REDUCED MOTION ON' : 'REDUCED MOTION OFF'}
        </button>
      </div>
      <p className="pause-hint" aria-hidden="true">
        ESC
      </p>
    </div>
  )
}
