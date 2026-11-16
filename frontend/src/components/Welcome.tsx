import type { ReactNode } from 'react'
import { DEFAULT_TAGLINE, type Deck } from '../types'
import { MicIcon, PlayIcon, PulseIcon } from './Icons'
import { SlideCanvas } from './SlideView'

interface Props {
  deck: Deck
  maxMinutes: number
  connecting: boolean
  error: string | null
  /** The access code field, when the server asks for one. */
  accessField: ReactNode
  onStart: () => void
}

/** The first thing a visitor sees: what this is, what will happen, and one button. */
export function Welcome({ deck, maxMinutes, connecting, error, accessField, onStart }: Props) {
  // The preview and the count are about the content slides; the title page is not one of them.
  const content = deck.slides.map((slide, index) => ({ slide, index })).filter(({ slide }) => slide.layout !== 'cover')
  const [front, , behind] = content
  return (
    <main className="welcome">
      <div className="welcome-copy">
        <span className="welcome-eyebrow">{deck.tagline ?? DEFAULT_TAGLINE}</span>
        <h1 className="welcome-title">
          {deck.name}, <em>presented by voice.</em>
        </h1>
        <p className="welcome-lead">
          An AI presenter walks you through {content.length} slides in about two minutes. Ask anything along the
          way, and it answers from the slide that holds the evidence.
        </p>

        <ul className="welcome-points">
          <li>
            <span className="point-icon">
              <PlayIcon />
            </span>
            <strong>It presents</strong>
            <span>The slides advance by themselves and the part being discussed is highlighted.</span>
          </li>
          <li>
            <span className="point-icon">
              <MicIcon />
            </span>
            <strong>You interrupt</strong>
            <span>Just start talking. It stops, listens, and picks up where it left off afterwards.</span>
          </li>
          <li>
            <span className="point-icon">
              <PulseIcon />
            </span>
            <strong>It shows its source</strong>
            <span>Every answer jumps to the slide it comes from and marks the exact block.</span>
          </li>
        </ul>

        <form
          className="welcome-start"
          onSubmit={(event) => {
            event.preventDefault()
            onStart()
          }}
        >
          {accessField}
          <button type="submit" className="primary" disabled={connecting}>
            {connecting ? <span className="spinner" aria-hidden="true" /> : <PlayIcon />}
            {connecting ? 'Connecting…' : 'Start presentation'}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="welcome-note">
            Uses your microphone; headphones work best. Calls are limited to {maxMinutes} minutes. {deck.disclaimer}
          </p>
        </form>
      </div>

      <div className="welcome-preview" aria-hidden="true">
        {behind && (
          <div className="stage stage--behind">
            <SlideCanvas deck={deck} slide={behind.slide} slideIndex={behind.index} />
          </div>
        )}
        {front && (
          <div className="stage stage--front">
            <SlideCanvas deck={deck} slide={front.slide} slideIndex={front.index} />
          </div>
        )}
      </div>
    </main>
  )
}
