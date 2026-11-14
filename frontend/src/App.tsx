import { useCallback, useEffect, useState } from 'react'
import { fetchConfig, fetchDeck } from './api'
import { PulseIcon } from './components/Icons'
import { Controls, Transcript, VoiceStatus } from './components/Panel'
import { SlideView } from './components/SlideView'
import { useRealtimeSession } from './hooks/useRealtimeSession'
import type { AppConfig, Deck, FocusMode, View } from './types'

const INITIAL_VIEW: View = { slideIndex: 0, blockId: null, mode: 'manual', transition: 'none' }

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>(INITIAL_VIEW)
  const [accessCode, setAccessCode] = useState('')

  useEffect(() => {
    Promise.all([fetchDeck(), fetchConfig()])
      .then(([loadedDeck, loadedConfig]) => {
        setDeck(loadedDeck)
        setConfig(loadedConfig)
      })
      .catch((cause: Error) => setLoadError(cause.message))
  }, [])

  const showSlide = useCallback((slideIndex: number, blockId: string | null, mode: FocusMode) => {
    setView((current) => {
      let transition: View['transition'] = 'none'
      if (slideIndex !== current.slideIndex) {
        // A jump to answer a question crossfades; walking the deck slides sideways.
        transition = mode === 'answering' ? 'jump' : slideIndex > current.slideIndex ? 'next' : 'prev'
      }
      return { slideIndex, blockId, mode, transition }
    })
  }, [])

  const onFocus = useCallback(
    (slideId: string, blockId: string, mode: FocusMode) => {
      const index = deck?.slides.findIndex((slide) => slide.id === slideId) ?? -1
      if (index >= 0) showSlide(index, blockId, mode)
    },
    [deck, showSlide],
  )

  const onClearHighlight = useCallback(() => {
    setView((current) => (current.blockId === null ? current : { ...current, blockId: null, transition: 'none' }))
  }, [])

  const session = useRealtimeSession({ deck, onFocus, onClearHighlight })
  const { live, presentSlide } = session

  const goTo = useCallback(
    (index: number) => {
      if (!deck || index < 0 || index >= deck.slides.length || index === view.slideIndex) return
      showSlide(index, null, 'manual')
      presentSlide(deck.slides[index])
    },
    [deck, presentSlide, showSlide, view.slideIndex],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'ArrowRight') goTo(view.slideIndex + 1)
      if (event.key === 'ArrowLeft') goTo(view.slideIndex - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, view.slideIndex])

  if (loadError) {
    return (
      <main className="fatal">
        <h1>Could not load the presentation</h1>
        <p>{loadError}</p>
        <p>Check that the backend is running, then reload.</p>
      </main>
    )
  }
  if (!deck || !config) return <main className="fatal">Loading…</main>

  const canStart = !live && session.state !== 'connecting'
  const toggleBlock = (blockId: string) =>
    setView((current) => ({
      ...current,
      blockId: current.blockId === blockId ? null : blockId,
      mode: 'manual',
      transition: 'none',
    }))

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <PulseIcon />
          </span>
          <span className="brand-name">{deck.product}</span>
          <span className="brand-tag">Voice-led detail aid</span>
        </div>
        <div className="topbar-right">
          {session.secondsLeft !== null && (
            <span className="clock" title="Time left in this call">
              {formatClock(session.secondsLeft)}
            </span>
          )}
          <span className="demo-badge">Fictional product, demo only</span>
        </div>
      </header>

      <main className="workspace">
        <div className="stage-column">
          <SlideView deck={deck} view={view} onBlockClick={live ? undefined : toggleBlock} />

          <nav className="slide-nav" aria-label="Slides">
            <button
              type="button"
              className="nav-arrow"
              onClick={() => goTo(view.slideIndex - 1)}
              disabled={view.slideIndex === 0}
              aria-label="Previous slide"
            >
              ←
            </button>
            <ol className="thumbs">
              {deck.slides.map((slide, index) => (
                <li key={slide.id}>
                  <button
                    type="button"
                    className={`thumb ${index === view.slideIndex ? 'is-current' : ''}`}
                    aria-current={index === view.slideIndex ? 'true' : undefined}
                    onClick={() => goTo(index)}
                  >
                    <span className="thumb-number">{index + 1}</span>
                    {slide.nav}
                  </button>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="nav-arrow"
              onClick={() => goTo(view.slideIndex + 1)}
              disabled={view.slideIndex === deck.slides.length - 1}
              aria-label="Next slide"
            >
              →
            </button>
          </nav>
        </div>

        <aside className="panel">
          <VoiceStatus state={session.state} latencyMs={session.latencyMs} secondsLeft={session.secondsLeft} />

          {canStart && (
            <form
              className="start"
              onSubmit={(event) => {
                event.preventDefault()
                setView(INITIAL_VIEW)
                void session.start(accessCode)
              }}
            >
              {config.access_code_required && (
                <label className="field">
                  Access code
                  <input
                    type="password"
                    value={accessCode}
                    onChange={(event) => setAccessCode(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              )}
              <button type="submit" className="primary">
                {session.state === 'idle' ? 'Start presentation' : 'Start again'}
              </button>
              <p className="start-note">
                An AI presenter walks you through {deck.slides.length} slides. Interrupt at any time with a
                question and it jumps to the slide that answers it. Uses your microphone; headphones work best.
                Calls are limited to {Math.round(config.session_max_seconds / 60)} minutes.
              </p>
            </form>
          )}

          {session.notice && (
            <p className="notice" role="status">
              {session.notice}
            </p>
          )}

          {session.error && (
            <p className="error" role="alert">
              {session.error}
            </p>
          )}

          <Controls
            live={live}
            speaking={session.state === 'speaking'}
            muted={session.muted}
            paused={session.paused}
            onPause={session.pause}
            onResume={session.resume}
            onStopSpeaking={session.stopSpeaking}
            onToggleMute={session.toggleMute}
            onEnd={session.stop}
          />

          <Transcript lines={session.transcript} />
        </aside>
      </main>
    </div>
  )
}
