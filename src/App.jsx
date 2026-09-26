import { useEffect, useRef, useState } from 'react'
import { AudioManager } from './game/audio.js'
import { PHASE, createInitialState, createStore } from './game/loop.js'
// §14.1/§14.3: the projection moved out of `loop.js` in slice 12, and with it the
// last thing v1's store module did for the screen. Everything the HUD paints
// comes from here, and everything the HUD knows is in `hud.js`'s closed field
// list.
import { hudSnapshot } from './ui/hud.js'
import { LongQuietGame as BellLoopGame } from './game/world.js'
import Hud from './ui/Hud.jsx'
import PauseOverlay from './ui/PauseOverlay.jsx'
import StartOverlay from './ui/StartOverlay.jsx'
import WinOverlay from './ui/WinOverlay.jsx'
import './ui/styles.css'

/**
 * The whole React side of the game: one canvas div, the HUD, and the three
 * overlays. The simulation lives in `BellLoopGame` and writes into a plain
 * store; this component only re-renders the handful of HUD values.
 *
 * The v1 layers (`.vignette`, `.grain`, `.desat`) are not here any more: §14.3's
 * tells drive them, and the HUD is what holds the tells, so they moved into
 * `Hud.jsx` with their class names intact rather than being duplicated. Nothing
 * was added — the same three elements, painted from the same place as
 * everything else on screen.
 */
export default function App() {
  const containerRef = useRef(null)
  const gameRef = useRef(null)

  // one store + one AudioManager for the lifetime of the component; the
  // AudioContext itself is still only created on the first click
  const [store] = useState(() => createStore(createInitialState(1, PHASE.START)))
  const [audio] = useState(() => new AudioManager())

  const [hud, setHud] = useState(() => hudSnapshot(store.get()))

  useEffect(() => {
    const game = new BellLoopGame(containerRef.current, { store, audio })
    gameRef.current = game
    const unsubscribe = store.subscribe((state) => setHud(hudSnapshot(state)))
    return () => {
      unsubscribe()
      game.dispose()
      gameRef.current = null
    }
  }, [store, audio])

  const begin = () => {
    audio.unlock()
    audio.startAmbient()
    gameRef.current?.start()
  }

  const restart = () => {
    audio.unlock()
    audio.startAmbient()
    gameRef.current?.restart()
  }

  // §14.3: the card's buttons are gestures, and the browser only grants pointer
  // lock inside one, which is why RESUME re-requests the lock from here rather
  // than from the world's own resume path
  const resume = () => {
    if (!gameRef.current) return
    audio.unlock()
    gameRef.current.setPaused(false)
  }

  const toggleMotion = () => {
    gameRef.current?.setReducedMotion(!hud.reducedMotion)
  }

  return (
    <div className="app">
      <div className="scene" ref={containerRef} />
      <Hud hud={hud} />
      {hud.phase === PHASE.START ? <StartOverlay onBegin={begin} /> : null}
      {hud.paused ? (
        <PauseOverlay reducedMotion={hud.reducedMotion} onResume={resume} onToggleMotion={toggleMotion} />
      ) : null}
      {hud.phase === PHASE.WON ? <WinOverlay onRestart={restart} /> : null}
    </div>
  )
}
