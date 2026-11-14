import type { Block, Deck, Slide } from '../types'

/** One block with the slide it sits on. The presentation walks these in order. */
export interface FlatBlock {
  slide: Slide
  block: Block
}

/** Every block in the deck, in presentation order. */
export function flattenDeck(deck: Deck): FlatBlock[] {
  return deck.slides.flatMap((slide) => slide.blocks.map((block) => ({ slide, block })))
}

/** Index of a slide's first block, or -1 if there is no such slide. */
export function firstBlockOfSlide(deck: Deck, slideId: string | undefined): number {
  return flattenDeck(deck).findIndex((entry) => entry.slide.id === slideId)
}
