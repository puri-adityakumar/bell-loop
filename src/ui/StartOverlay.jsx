/**
 * Title screen (loop 10): THE BELL LOOP in big spaced serif over the live
 * world — the render loop keeps running through START, so cold fog drifts
 * behind the title. A slow breath-drift on the camera sells "asleep". The
 * click is also what unlocks WebAudio and pointer lock, so this overlay is a
 * functional gate, not decoration.
 */
export default function StartOverlay({ onBegin }) {
  return (
    <div
      className="overlay overlay--start"
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-title"
    >
      <div className="title-veil" aria-hidden="true" />
      <h1 id="start-title" className="title title--start">
        <span>THE</span>
        <span>BELL</span>
        <span>LOOP</span>
      </h1>
      <div className="title-sub">
        <div className="title-sub__rule" />
        <span className="title-sub__text">light all three shrines · the door waits for the next bell</span>
        <span className="title-sub__rule" />
      </div>
      <button type="button" className="brass-button" onClick={onBegin} autoFocus>
        START
      </button>
      <div className="title-controls">
        <span className="title-controls__key">W A S D</span>
        <span className="title-controls__word">move</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">MOUSE</span>
        <span className="title-controls__word">look</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">E / CLICK</span>
        <span className="title-controls__word">light candle</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">SHIFT</span>
        <span className="title-controls__word">sprint</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">J L I K</span>
        <span className="title-controls__word">look</span>
        <span className="title-controls__dot" />
        <span className="title-controls__key">P</span>
        <span className="title-controls__word">pause</span>
      </div>
    </div>
  )
}
