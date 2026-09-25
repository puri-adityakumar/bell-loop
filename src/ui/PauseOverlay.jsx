export default function PauseOverlay({ onResume }) {
  return (
    <div
      className="overlay overlay--pause"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-title"
      aria-describedby="pause-copy"
    >
      <div className="pause-kicker">THE CORRIDOR IS STILL</div>
      <h1 id="pause-title" className="title title--pause">PAUSED</h1>
      <p id="pause-copy" className="pause-copy">Mouse look was released. The loop is waiting for you.</p>
      <button type="button" className="brass-button" onClick={onResume} autoFocus>
        RESUME
      </button>
      <div className="pause-hint">Click resume to return to the dark.</div>
    </div>
  )
}
