/**
 * Turns a tool call from the model into an action for the presenter.
 * Pure: no side effects, so every routing rule is unit-tested.
 */
import type { Deck } from '../types'
import { firstBlockOfSlide, flattenDeck } from './deck'

export interface ToolCall {
  call_id: string
  name: string
  /** JSON text, exactly as the model sent it. */
  arguments: string
}

export type ToolAction =
  /** Show this block and answer from its facts. */
  | { kind: 'answer'; slideId: string; blockId: string; facts: string[] }
  /** Carry on from where the presentation was interrupted. */
  | { kind: 'resume' }
  /** Present from this block index. */
  | { kind: 'jump'; index: number }
  /** The call could not be acted on; send `output` back so the model can recover. */
  | { kind: 'invalid'; output: Record<string, unknown> }

/** "dosing_schedule", "Dosing.Schedule" and "dosing.schedule" all compare equal. */
const loose = (id: string | undefined) => (id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function parseArgs(text: string): { slide_id?: string; block_id?: string } {
  try {
    const value = JSON.parse(text || '{}')
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

export function resolveToolCall(deck: Deck, call: ToolCall): ToolAction {
  const args = parseArgs(call.arguments)

  switch (call.name) {
    case 'show_answer': {
      // The block id is the source of truth: a mismatched slide_id is ignored,
      // and near-miss block ids are accepted. Failing that, use the slide's first block.
      const wanted = loose(args.block_id)
      const blocks = flattenDeck(deck)
      const match =
        blocks.find(({ block }) => loose(block.id) === wanted) ??
        blocks.find(({ slide }) => slide.id === args.slide_id)
      if (!match) {
        return {
          kind: 'invalid',
          output: {
            ok: false,
            error: 'unknown slide_id or block_id',
            valid_block_ids: blocks.map(({ block }) => block.id),
          },
        }
      }
      return { kind: 'answer', slideId: match.slide.id, blockId: match.block.id, facts: match.block.facts }
    }

    case 'continue_presentation':
      return { kind: 'resume' }

    case 'present_slide': {
      const index = firstBlockOfSlide(deck, args.slide_id)
      if (index === -1) {
        return {
          kind: 'invalid',
          output: { ok: false, error: 'unknown slide_id', valid_slide_ids: deck.slides.map((s) => s.id) },
        }
      }
      return { kind: 'jump', index }
    }

    default:
      return { kind: 'invalid', output: { ok: false, error: `unknown tool ${call.name}` } }
  }
}
