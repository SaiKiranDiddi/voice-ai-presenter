/**
 * The system notes that tell the model what to say next. The app picks the
 * block; these notes only hand the model its talking point.
 */
import type { Deck } from '../types'
import { flattenDeck } from './deck'

/** How a block is introduced: opening the call, after a question, after a jump, or in sequence. */
export type Lead = 'greeting' | 'resume' | 'jump' | 'next'

/** The opening turn of the call, spoken over the deck's first block (the title page). */
function greetingNote(audience: string, talkingPoint: string): string {
  return (
    `GREET: Welcome the ${audience} and say what this presentation is about, in one sentence, from this: ${talkingPoint}\n` +
    'Then say in one short sentence that they can interrupt with a question at any time. ' +
    'Then stop. Do not list the topics, do not start on the next slide, and do not ask a question.'
  )
}

/**
 * Sent with every PRESENT note. Each note is a clean prompt, so the model
 * cannot see that the call is already under way; told nothing, a small model
 * sometimes greets again or asks where to start.
 */
function midCall(audience: string): string {
  return (
    `The call is already under way and you have already greeted the ${audience}. ` +
    `Nobody has just spoken: this is not a reply. Do not greet, do not offer help, and do not ask what the ${audience} wants.`
  )
}

export function closeNote(deck: Deck): string {
  const audience = deck.agent.audience
  return (
    `CLOSE: You have just finished presenting the last slide. Thank the ${audience} in one sentence and ask whether they have any questions. ` +
    'Do not greet, and do not offer to go through the deck.'
  )
}

/** The note for block `index`: PRESENT, or GREET when it opens the call. Only the talking point is sent: handing over every fact invites reciting it. */
export function presentNote(deck: Deck, index: number, lead: Lead): string {
  const { slide, block } = flattenDeck(deck)[index]
  const audience = deck.agent.audience
  if (lead === 'greeting') return greetingNote(audience, block.talking_point)
  const startsSlide = slide.blocks[0].id === block.id
  // Spoken, not read out: a small model otherwise says "Slide topic: ...".
  const nameTopic =
    'Begin by naming this slide\'s topic in three or four words, as a presenter would say it aloud ("Turning to safety."). Never say the words "slide topic".'
  // The opening is separate from the talking point. When they shared one
  // "sentence" budget, the model sometimes said only the opening and stopped.
  const opening = {
    resume: 'Begin with the words "Back to the presentation."',
    jump: startsSlide ? nameTopic : 'Present this now.',
    next: startsSlide ? `This starts a new slide. ${nameTopic} Do not recap.` : 'Carry straight on, with no lead-in or recap.',
  }[lead]
  return (
    `PRESENT: ${midCall(audience)}\n` +
    `${opening}\n` +
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
