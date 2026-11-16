/**
 * The on-screen transcript: three pure updates (each returns a new array, or
 * the same one if nothing changed) and the Transcript class that applies them.
 */
import type { ServerEvent, TranscriptLine } from '../types'

/** Update line `id`, creating it (empty) first if it does not exist yet. */
export function upsertLine(
  lines: TranscriptLine[],
  id: string,
  role: TranscriptLine['role'],
  update: (line: TranscriptLine) => TranscriptLine,
): TranscriptLine[] {
  const index = lines.findIndex((line) => line.id === id)
  if (index === -1) return [...lines, update({ id, role, text: '' })]
  const next = lines.slice()
  next[index] = update(lines[index])
  return next
}

export function removeLine(lines: TranscriptLine[], id: string): TranscriptLine[] {
  return lines.filter((line) => line.id !== id)
}

/** Flag the latest agent line as cut off. */
export function markAgentInterrupted(lines: TranscriptLine[]): TranscriptLine[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role !== 'agent') continue
    if (lines[i].interrupted) return lines
    const next = lines.slice()
    next[i] = { ...lines[i], interrupted: true }
    return next
  }
  return lines
}

/**
 * The on-screen transcript of one call, built from Realtime server events.
 * It only records what was said; it decides nothing about the presentation.
 */
export class Transcript {
  private lines: TranscriptLine[] = []
  private readonly onChange: (lines: TranscriptLine[]) => void
  private readonly log: (type: string, data?: Record<string, unknown>) => void

  constructor(onChange: (lines: TranscriptLine[]) => void, log: (type: string, data?: Record<string, unknown>) => void) {
    this.onChange = onChange
    this.log = log
  }

  handle(event: ServerEvent): void {
    const id = event.item_id ?? ''
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // A placeholder until the transcription arrives.
        this.update((lines) => upsertLine(lines, id, 'user', (line) => ({ ...line, text: line.text || '…' })))
        break

      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? '').trim()
        if (text) {
          this.update((lines) => upsertLine(lines, id, 'user', (line) => ({ ...line, text })))
          this.log('user_transcript', { text })
        } else {
          // Noise, not speech: a cough, a door.
          this.update((lines) => removeLine(lines, id))
        }
        break
      }

      case 'response.output_audio_transcript.delta': {
        const delta = event.delta ?? ''
        this.update((lines) => upsertLine(lines, id, 'agent', (line) => ({ ...line, text: line.text + delta })))
        break
      }

      case 'response.output_audio_transcript.done': {
        const full = event.transcript
        this.update((lines) => upsertLine(lines, id, 'agent', (line) => ({ ...line, text: full ?? line.text })))
        this.log('agent_transcript', { text: full })
        break
      }
    }
  }

  /** Flag the agent's latest line as cut off. */
  markInterrupted(): void {
    this.update(markAgentInterrupted)
  }

  private update(change: (lines: TranscriptLine[]) => TranscriptLine[]): void {
    const next = change(this.lines)
    if (next === this.lines) return
    this.lines = next
    this.onChange(next)
  }
}
