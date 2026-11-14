import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from '../types'
import { markAgentInterrupted, removeLine, upsertLine } from './transcript'

const lines: TranscriptLine[] = [
  { id: 'a1', role: 'agent', text: 'Hello' },
  { id: 'u1', role: 'user', text: 'Hi' },
]

describe('transcript', () => {
  it('upsertLine appends a new line or updates an existing one', () => {
    const added = upsertLine(lines, 'a2', 'agent', (l) => ({ ...l, text: 'New' }))
    expect(added.at(-1)).toEqual({ id: 'a2', role: 'agent', text: 'New' })
    const updated = upsertLine(lines, 'a1', 'agent', (l) => ({ ...l, text: l.text + '!' }))
    expect(updated[0].text).toBe('Hello!')
    expect(lines[0].text).toBe('Hello') // input untouched
  })

  it('markAgentInterrupted flags only the latest agent line, once', () => {
    const marked = markAgentInterrupted(lines)
    expect(marked[0].interrupted).toBe(true)
    expect(markAgentInterrupted(marked)).toBe(marked)
  })

  it('removeLine drops a line by id', () => {
    expect(removeLine(lines, 'u1').map((l) => l.id)).toEqual(['a1'])
  })
})
