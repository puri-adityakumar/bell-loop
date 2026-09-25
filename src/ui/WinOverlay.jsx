/** "THE BELL STOPPED." — the only text the game speaks. */
export default function WinOverlay({ onRestart }) {
  return (
    <div className="overlay overlay--win" role="dialog" aria-modal="true" aria-labelledby="win-title">
      <h1 id="win-title" className="title title--win">THE BELL STOPPED.</h1>
      <button type="button" className="brass-button" onClick={onRestart} autoFocus>
        BEGIN AGAIN
      </button>
    </div>
  )
}
