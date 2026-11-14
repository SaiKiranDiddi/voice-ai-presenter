import type { Deck, View } from '../types'
import { BlockBody } from './Blocks'

interface Props {
  deck: Deck
  view: View
  /** Set when no call is live, so blocks can be highlighted by clicking. */
  onBlockClick?: (blockId: string) => void
}

export function SlideView({ deck, view, onBlockClick }: Props) {
  const slide = deck.slides[view.slideIndex]
  const hasFocus = view.blockId !== null && slide.blocks.some((block) => block.id === view.blockId)
  const answering = hasFocus && view.mode === 'answering'

  return (
    <div className="stage">
      {/* The key remounts the slide so the enter animation replays on every change. */}
      <article
        key={slide.id}
        className={`slide slide--enter-${view.transition} layout-${slide.layout} ${hasFocus ? 'has-focus' : ''} ${answering ? 'is-answering' : ''}`}
      >
        <div className="slide-inner">
          <header className="slide-header">
            <div>
              {slide.subtitle && <p className="eyebrow">{slide.subtitle}</p>}
              <h2 className="slide-title">{slide.title}</h2>
            </div>
            <div className="slide-meta">
              {answering && <span className="answer-chip">Answering from: {slide.nav}</span>}
              <span className="slide-count">
                {view.slideIndex + 1} / {deck.slides.length}
              </span>
            </div>
          </header>

          <div className="blocks">
            {slide.blocks.map((block, index) => (
              <section
                key={block.id}
                data-block-id={block.id}
                className={`block block--${block.type} block-${index + 1} ${view.blockId === block.id ? 'is-focus' : ''}`}
                onClick={onBlockClick ? () => onBlockClick(block.id) : undefined}
              >
                <BlockBody block={block} />
              </section>
            ))}
          </div>

          <footer className="slide-footer">{deck.disclaimer}</footer>
        </div>
      </article>
    </div>
  )
}
