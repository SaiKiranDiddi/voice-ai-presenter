import type { CSSProperties } from 'react'
import type { Deck, FocusMode, Slide, View } from '../types'
import { BlockBody } from './Blocks'

interface CanvasProps {
  deck: Deck
  slide: Slide
  slideIndex: number
  /** The highlighted block, if any, and why it is highlighted. */
  focusId?: string | null
  mode?: FocusMode
  onBlockClick?: (blockId: string) => void
}

/**
 * One slide, drawn at whatever size its container is: every measurement inside
 * is in container units, so the same markup serves the stage and the thumbnails.
 */
export function SlideCanvas({ deck, slide, slideIndex, focusId = null, mode = 'manual', onBlockClick }: CanvasProps) {
  const hasFocus = focusId !== null && slide.blocks.some((block) => block.id === focusId)
  const answering = hasFocus && mode === 'answering'

  return (
    <div
      className={`slide-inner layout-${slide.layout} mode-${mode} ${hasFocus ? 'has-focus' : ''} ${answering ? 'is-answering' : ''}`}
    >
      <header className="slide-header">
        <div>
          {slide.subtitle && <p className="eyebrow">{slide.subtitle}</p>}
          <h2 className="slide-title">{slide.title}</h2>
        </div>
        <div className="slide-meta">
          {answering && <span className="answer-chip">Answering from: {slide.nav}</span>}
          <span className="slide-count">
            {String(slideIndex + 1).padStart(2, '0')}
            <span> / {String(deck.slides.length).padStart(2, '0')}</span>
          </span>
        </div>
      </header>

      <div className="blocks">
        {slide.blocks.map((block, index) => (
          <section
            key={block.id}
            data-block-id={block.id}
            className={`block block--${block.type} block-${index + 1} ${focusId === block.id ? 'is-focus' : ''}`}
            style={{ '--i': index } as CSSProperties}
            onClick={onBlockClick ? () => onBlockClick(block.id) : undefined}
          >
            <BlockBody block={block} />
          </section>
        ))}
      </div>

      <footer className="slide-footer">
        <span>{deck.disclaimer}</span>
        <span className="slide-footer-brand">{deck.name}</span>
      </footer>
    </div>
  )
}

interface Props {
  deck: Deck
  view: View
  /** How far through the deck the presentation is, 0 to 1. */
  progress?: number
  /** Set when no call is live, so blocks can be highlighted by clicking. */
  onBlockClick?: (blockId: string) => void
}

export function SlideView({ deck, view, progress, onBlockClick }: Props) {
  const slide = deck.slides[view.slideIndex]
  return (
    <div className="stage">
      {/* The key remounts the slide so the enter animation replays on every change. */}
      <article key={slide.id} className={`slide slide--enter-${view.transition}`}>
        <SlideCanvas
          deck={deck}
          slide={slide}
          slideIndex={view.slideIndex}
          focusId={view.blockId}
          mode={view.mode}
          onBlockClick={onBlockClick}
        />
      </article>
      {progress !== undefined && (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
