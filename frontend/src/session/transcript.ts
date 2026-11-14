/** Pure updates to the on-screen transcript. Each returns a new array, or the same one if nothing changed. */
import type { TranscriptLine } from '../types'

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
