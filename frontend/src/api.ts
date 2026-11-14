import type { AppConfig, Deck, LoggedEvent, SessionInfo } from './types'

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
  } catch {
    // not JSON; fall through
  }
  return `Request failed (${response.status})`
}

export async function fetchDeck(): Promise<Deck> {
  const response = await fetch('/api/deck')
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export async function fetchConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config')
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export async function createSession(accessCode: string): Promise<SessionInfo> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_code: accessCode }),
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export function postEvents(sessionId: string, events: LoggedEvent[]): void {
  if (events.length === 0) return
  // keepalive lets the final flush survive the page closing.
  void fetch(`/api/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {})
}
