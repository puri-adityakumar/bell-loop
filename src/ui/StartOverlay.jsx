/**
 * Title screen (loop 10): THE BELL LOOP in big spaced serif over the live
 * world — the render loop keeps running through START, so cold fog drifts
 * behind the title. A slow breath-drift on the camera sells "asleep". The
 * click is also what unlocks WebAudio and pointer lock, so this overlay is a
 * functional gate, not decoration.
 */
export default function StartOverlay({ onBegin }) {
  return (
    <div className="overlay overlay--start">
      <div className="title-veil" aria-hidden="true" />
      <h1 className="title title--start">
        <span>THE</span>
        <span>BELL</span>
        <span>LOOP</span>
      </h1>
      <div className="title-sub" aria-hidden="true">
        <span className="title-sub__rule" />
        <span className="title-sub__text">the corridors will not remember you</span>
        <span className="title-sub__rule" />
      </div>
      <button type="button" className="brass-button" onClick={onBegin} autoFocus>
        CLICK TO WAKE UP
      </button>
      <div className="title-controls" aria-hidden="true">
        <span className="title-controls__key">W A S D</span>
        <span className="title-controls__word">move</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">MOUSE</span>
        <span className="title-controls__word">look</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">E</span>
        <span className="title-controls__word">light candles</span>
      </div>
    </div>
  )
}
