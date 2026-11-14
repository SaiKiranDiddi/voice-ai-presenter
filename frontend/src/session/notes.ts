/**
 * The system notes that tell the model what to say next. The app picks the
 * block; these notes only hand the model its talking point.
 */
import type { Deck } from '../types'
import { flattenDeck } from './deck'

/** How a block is introduced: the very first one, after a question, after a jump, or in sequence. */
export type Lead = 'greeting' | 'resume' | 'jump' | 'next'

export function closeNote(deck: Deck): string {
  return `CLOSE: The deck is finished. Thank the ${deck.agent.audience} in one sentence and ask whether they have any questions.`
}

/** The PRESENT note for block `index`. Only the talking point is sent: handing over every fact invites reciting it. */
export function presentNote(deck: Deck, index: number, lead: Lead): string {
  const { slide, block } = flattenDeck(deck)[index]
  const audience = deck.agent.audience
  const agenda = deck.slides.map((s) => s.nav.toLowerCase()).join(', ')
  const startsSlide = slide.blocks[0].id === block.id
  // The opening is separate from the talking point. When they shared one
  // "sentence" budget, the model sometimes said only the opening and stopped.
  const opening = {
    greeting: `First greet the ${audience} in one sentence that names what you will cover (${agenda}), and say in one short sentence that they can interrupt with questions at any time.`,
    resume: 'Begin with the words "Back to the presentation."',
    jump: startsSlide ? "Begin by naming this slide's topic in three or four words." : 'Present this now.',
    next: startsSlide
      ? "This starts a new slide. Begin by naming this slide's topic in three or four words, with no recap."
      : 'Carry straight on, with no lead-in or recap.',
  }[lead]
  return (
    `PRESENT: ${opening}\n` +
    `Slide: ${slide.title}\n` +
    `Talking point: ${block.talking_point}\n` +
    'Whatever the opening, always go on to say the talking point itself, in one sentence of 20 words or fewer: the headline only. ' +
    'The opening words never replace it. The slide shows the details, so do not list them or add anything. ' +
    'Then stop. Do not ask a question, do not ask whether to continue, and do not mention what comes next.'
  )
}

/** What the model is told to do with the facts returned by show_answer. */
export function answerInstruction(deckFinished: boolean): string {
  const base = 'Answer now in one or two short sentences using only these facts.'
  return deckFinished ? base : `${base} Give the point, not every number. End with: "Anything else, or shall I carry on?"`
}
