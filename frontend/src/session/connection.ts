/**
 * The WebRTC call to the OpenAI Realtime API. Audio flows browser <-> OpenAI
 * directly; JSON events travel on the "oai-events" data channel. This file
 * knows nothing about slides.
 */
import type { ServerEvent } from '../types'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

export interface CallHandlers {
  /** The data channel is open: events can be sent. */
  onOpen: () => void
  onEvent: (event: ServerEvent) => void
  /** The agent's audio arrived. */
  onRemoteStream: (stream: MediaStream) => void
  /** The connection failed or dropped. */
  onDrop: () => void
}

export interface RealtimeCall {
  send: (event: Record<string, unknown>) => void
  close: () => void
}

/** Opens the call with the ephemeral secret from our backend. Throws if OpenAI refuses it. */
export async function openRealtimeCall(clientSecret: string, mic: MediaStream, handlers: CallHandlers): Promise<RealtimeCall> {
  const pc = new RTCPeerConnection()
  const dc = pc.createDataChannel('oai-events')
  const call: RealtimeCall = {
    send: (event) => {
      if (dc.readyState === 'open') dc.send(JSON.stringify(event))
    },
    close: () => {
      dc.close()
      pc.close()
    },
  }

  pc.ontrack = (event) => handlers.onRemoteStream(event.streams[0])
  pc.addTrack(mic.getAudioTracks()[0], mic)
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') handlers.onDrop()
  }
  dc.onopen = handlers.onOpen
  dc.onmessage = (message) => handlers.onEvent(JSON.parse(message.data))

  try {
    // Standard WebRTC offer/answer, with OpenAI as the other peer.
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await fetch(CALLS_URL, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
    })
    if (!answer.ok) throw new Error(`OpenAI rejected the call (${answer.status}).`)
    await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
  } catch (cause) {
    call.close()
    throw cause
  }
  return call
}
