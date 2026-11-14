/** Microphone input and level meters. The meters are display only: nothing else depends on them. */

export interface Analysers {
  agent: AnalyserNode | null
  user: AnalyserNode | null
}

/** The microphone, or a silent track when the URL has ?silent (run the deck with no mic). */
export async function openMicrophone(): Promise<MediaStream> {
  if (new URLSearchParams(window.location.search).has('silent')) return silentStream()
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
}

function silentStream(): MediaStream {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const gain = context.createGain()
  gain.gain.value = 0
  const oscillator = context.createOscillator()
  oscillator.connect(gain).connect(destination)
  oscillator.start()
  return destination.stream
}

/** An AudioContext for metering, or null if the browser refuses one. */
export function createMeterContext(): AudioContext | null {
  try {
    const context = new AudioContext()
    void context.resume()
    return context
  } catch {
    return null
  }
}

/** Tap a stream for its levels without playing it. Returns null if that fails. */
export function meter(context: AudioContext | null, stream: MediaStream): AnalyserNode | null {
  if (!context) return null
  try {
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.7
    context.createMediaStreamSource(stream).connect(analyser)
    return analyser
  } catch {
    return null
  }
}
