import { useCallback, useEffect, useState } from 'react'
import { fetchConfig, fetchDeck } from './api'
import { ArrowLeftIcon, ArrowRightIcon, PlayIcon, PulseIcon } from './components/Icons'
import { Controls, Transcript, VoiceStatus } from './components/Panel'
import { SlideCanvas, SlideView } from './components/SlideView'
import { Welcome } from './components/Welcome'
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

  // The welcome screen stays up until the first call connects.
  const [hasBeenLive, setHasBeenLive] = useState(false)
  if (live && !hasBeenLive) setHasBeenLive(true)

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
  const startCall = () => {
    setView(INITIAL_VIEW)
    void session.start(accessCode)
  }

  // How far through the deck the presentation is, counted in blocks.
  const blockIds = deck.slides.flatMap((slide) => slide.blocks.map((block) => block.id))
  const blockIndex = view.blockId ? blockIds.indexOf(view.blockId) : -1
  const progress =
    blockIndex >= 0 ? (blockIndex + 1) / blockIds.length : (view.slideIndex + 1) / deck.slides.length

  const accessField = config.access_code_required && (
    <label className="field">
      Access code
      <input
        type="password"
        value={accessCode}
        onChange={(event) => setAccessCode(event.target.value)}
        autoComplete="off"
      />
    </label>
  )

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

      {!hasBeenLive ? (
        <Welcome
          deck={deck}
          maxMinutes={Math.round(config.session_max_seconds / 60)}
          connecting={session.state === 'connecting'}
          error={session.error}
          accessField={accessField}
          onStart={startCall}
        />
      ) : (
        <main className="workspace">
          <div className="stage-column">
            <SlideView deck={deck} view={view} progress={progress} onBlockClick={live ? undefined : toggleBlock} />

            <nav className="slide-nav" aria-label="Slides">
              <button
                type="button"
                className="nav-arrow"
                onClick={() => goTo(view.slideIndex - 1)}
                disabled={view.slideIndex === 0}
                aria-label="Previous slide"
              >
                <ArrowLeftIcon />
              </button>
              <ol className="thumbs">
                {deck.slides.map((slide, index) => (
                  <li key={slide.id}>
                    <button
                      type="button"
                      className={`thumb ${index === view.slideIndex ? 'is-current' : ''}`}
                      aria-current={index === view.slideIndex ? 'true' : undefined}
                      aria-label={`Slide ${index + 1}: ${slide.nav}`}
                      onClick={() => goTo(index)}
                    >
                      <span className="thumb-preview" aria-hidden="true">
                        <SlideCanvas deck={deck} slide={slide} slideIndex={index} />
                      </span>
                      <span className="thumb-label">
                        <span className="thumb-number">{index + 1}</span>
                        {slide.nav}
                      </span>
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
                <ArrowRightIcon />
              </button>
            </nav>
          </div>

          <aside className="panel">
            <VoiceStatus state={session.state} latencyMs={session.latencyMs} getAnalysers={session.getAnalysers} />

            {canStart && (
              <form
                className="start"
                onSubmit={(event) => {
                  event.preventDefault()
                  startCall()
                }}
              >
                {accessField}
                <button type="submit" className="primary">
                  <PlayIcon />
                  Start again
                </button>
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
      )}
    </div>
  )
}
