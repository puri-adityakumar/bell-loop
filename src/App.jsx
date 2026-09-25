import { useEffect, useRef, useState } from 'react'
import { AudioManager } from './game/audio.js'
import { PHASE, createInitialState, createStore, hudSnapshot } from './game/loop.js'
import { BellLoopGame } from './game/world.js'
import Hud from './ui/Hud.jsx'
import PauseOverlay from './ui/PauseOverlay.jsx'
import StartOverlay from './ui/StartOverlay.jsx'
import WinOverlay from './ui/WinOverlay.jsx'
import './ui/styles.css'

/**
 * The whole React side of the game: one canvas div, the HUD, and the
 * lifecycle overlays. The simulation lives in `BellLoopGame` and writes into a plain
 * store; this component only re-renders the handful of HUD values.
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

  const resume = () => {
    gameRef.current?.resume()
  }

  const restart = () => {
    audio.unlock()
    gameRef.current?.restart()
    audio.startAmbient()
  }

  const sceneActive = hud.phase === PHASE.PLAYING || hud.phase === PHASE.RESET

  return (
    <div className="app">
      <div
        className="scene"
        ref={containerRef}
        aria-hidden={sceneActive ? undefined : 'true'}
        inert={!sceneActive}
      />
      <Hud hud={hud} />
      <div className="vignette" aria-hidden="true" />
      <div className="desat" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      {hud.phase === PHASE.START ? <StartOverlay onBegin={begin} /> : null}
      {hud.phase === PHASE.PAUSED ? <PauseOverlay onResume={resume} /> : null}
      {hud.phase === PHASE.WON ? <WinOverlay onRestart={restart} /> : null}
    </div>
  )
}
