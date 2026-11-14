import { describe, expect, it } from 'vitest'
import { testDeck } from './testDeck'
import { resolveToolCall } from './tools'

const call = (name: string, args: unknown) => ({ call_id: 'c1', name, arguments: JSON.stringify(args) })

describe('resolveToolCall', () => {
  it('show_answer resolves to the block and its facts', () => {
    expect(resolveToolCall(testDeck, call('show_answer', { slide_id: 'dosing', block_id: 'dosing.renal' }))).toEqual({
      kind: 'answer',
      slideId: 'dosing',
      blockId: 'dosing.renal',
      facts: ['No renal adjustment.'],
    })
  })

  it('show_answer accepts near-miss block ids, as the mini model sends them', () => {
    const action = resolveToolCall(testDeck, call('show_answer', { slide_id: 'dosing', block_id: 'dosing_schedule' }))
    expect(action).toMatchObject({ kind: 'answer', blockId: 'dosing.schedule' })
  })

  it('show_answer trusts the block id over a wrong slide id', () => {
    const action = resolveToolCall(testDeck, call('show_answer', { slide_id: 'intro', block_id: 'dosing.renal' }))
    expect(action).toMatchObject({ kind: 'answer', slideId: 'dosing', blockId: 'dosing.renal' })
  })

  it('show_answer falls back to the first block of a known slide', () => {
    const action = resolveToolCall(testDeck, call('show_answer', { slide_id: 'dosing', block_id: 'nope' }))
    expect(action).toMatchObject({ kind: 'answer', blockId: 'dosing.schedule' })
  })

  it('show_answer with unknown ids lists the valid ones', () => {
    const action = resolveToolCall(testDeck, call('show_answer', { slide_id: 'x', block_id: 'y' }))
    expect(action).toMatchObject({ kind: 'invalid', output: { valid_block_ids: ['intro.what', 'dosing.schedule', 'dosing.renal'] } })
  })

  it('present_slide jumps to the first block of that slide', () => {
    expect(resolveToolCall(testDeck, call('present_slide', { slide_id: 'dosing' }))).toEqual({ kind: 'jump', index: 1 })
  })

  it('present_slide with an unknown slide is invalid', () => {
    expect(resolveToolCall(testDeck, call('present_slide', { slide_id: 'nope' }))).toMatchObject({ kind: 'invalid' })
  })

  it('continue_presentation resumes', () => {
    expect(resolveToolCall(testDeck, call('continue_presentation', {}))).toEqual({ kind: 'resume' })
  })

  it('malformed arguments and unknown tools are invalid, not crashes', () => {
    expect(resolveToolCall(testDeck, { call_id: 'c', name: 'present_slide', arguments: '{oops' })).toMatchObject({ kind: 'invalid' })
    expect(resolveToolCall(testDeck, call('dance', {}))).toMatchObject({ kind: 'invalid' })
  })
})
