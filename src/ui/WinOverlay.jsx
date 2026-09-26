/**
 * The win card (§10.4) — the only text the game has ever spoken, and slice 13
 * changed what it says.
 *
 * v1 rang a bell and printed a line about the bell stopping when three candles
 * were lit. v2 has no candles, no bell on a clock, and a different ending: the
 * third portal goes down, the headlights come on at the far side of a wrapping
 * neighbourhood, and the only way out is the car that was standing there the
 * whole time. So the sentence changed with the game — THE NEIGHBORHOOD WENT
 * QUIET is §10.4's, and `verify.mjs` greps `src/` to fail on v1's line coming
 * back into any of it.
 *
 * §14.1's "no new text" is scoped to the HUD, and this is not the HUD: it is the
 * same overlay chrome as the title and the pause card, and a card with a button
 * on it may say what the button is for.
 */
export default function WinOverlay({ onRestart }) {
  return (
    <div className="overlay overlay--win">
      <h1 className="title title--win">THE NEIGHBORHOOD WENT QUIET.</h1>
      <button type="button" className="brass-button" onClick={onRestart}>
        BEGIN AGAIN
      </button>
    </div>
  )
}
