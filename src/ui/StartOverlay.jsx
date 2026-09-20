/**
 * Title card. The click is also what unlocks WebAudio and pointer lock, so this
 * overlay is a functional gate, not decoration.
 */
export default function StartOverlay({ onBegin }) {
  return (
    <div className="overlay overlay--start">
      <h1 className="title">THE BELL LOOP</h1>
      <button type="button" className="brass-button" onClick={onBegin} autoFocus>
        BEGIN
      </button>
    </div>
  )
}
