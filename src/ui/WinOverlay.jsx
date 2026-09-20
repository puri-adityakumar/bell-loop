/** "THE BELL STOPPED." — the only text the game speaks. */
export default function WinOverlay({ onRestart }) {
  return (
    <div className="overlay overlay--win">
      <h1 className="title title--win">THE BELL STOPPED.</h1>
      <button type="button" className="brass-button" onClick={onRestart}>
        BEGIN AGAIN
      </button>
    </div>
  )
}
