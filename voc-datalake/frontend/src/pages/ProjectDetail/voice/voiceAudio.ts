/**
 * @fileoverview The browser's side of a voice session's audio (docs/voice-personas.md): the microphone, through the
 * capture worklet (`public/voice-capture-worklet.js`, 16 kHz PCM16 frames of `MIC_FRAME_SAMPLES`), and the persona's
 * voice, 24 kHz PCM16 chunks scheduled back to back on one AudioContext. `flush` is barge-in: every scheduled chunk
 * stops and the queue is dropped, so the persona falls silent the moment the person speaks over it. `close` releases
 * the microphone at once and the context after what is queued has played, for as long as it is given (the goodbye at
 * a limit: voiceConnection.ts), else at once.
 *
 * Nothing is recorded: a frame goes to `onFrame` (the session's WebSocket) and nowhere else; a played chunk is gone
 * once it has played.
 *
 * `openVoiceAudio` is called from the Start press (a user gesture) and asks for the microphone before any session is
 * started, so a refused microphone never spends one of the person's sessions for the day.
 *
 * @module pages/ProjectDetail/voice/voiceAudio
 */
import { MIC_FRAME_SAMPLES, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from '@stream/voice/protocol'

const WORKLET_URL = '/voice-capture-worklet.js'
const PROCESSOR_NAME = 'voc-voice-capture'
/** A little headroom before the first chunk, so jitter does not clip its start. */
const START_LEAD_SECONDS = 0.05
const SECOND_MS = 1000

export interface VoiceAudio {
  /** Start sending microphone frames to `onFrame` and the meter to `onLevel` (0 to 1). */
  readonly startCapture: (onFrame: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void) => void
  /** Queue one chunk of the persona's voice (PCM16LE mono at 24 kHz). */
  readonly play: (pcm: ArrayBuffer) => void
  /** Barge-in: stop what is playing and drop what is queued. */
  readonly flush: () => void
  /** Release the microphone now, and the audio context once the queued voice has played (at most `drainMs`). */
  readonly close: (drainMs?: number) => Promise<void>
}

interface CaptureMessage {
  readonly pcm: ArrayBuffer
  readonly level: number
}

function isCaptureMessage(value: unknown): value is CaptureMessage {
  if (typeof value !== 'object' || value === null) return false
  return 'pcm' in value && value.pcm instanceof ArrayBuffer && 'level' in value && typeof value.level === 'number'
}

/** PCM16LE → the [-1, 1] floats Web Audio plays. */
function pcm16ToFloat(pcm: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(pcm)
  return Float32Array.from({ length: Math.floor(pcm.byteLength / 2) }, (_, index) => view.getInt16(index * 2, true) / 0x8000)
}

/** The persona's voice: chunks scheduled one after another, every live one stoppable at once, and how many seconds
 *  of it are still to play. */
function playbackOn(context: AudioContext): Pick<VoiceAudio, 'play' | 'flush'> & { readonly queuedSeconds: () => number } {
  const live = new Set<AudioBufferSourceNode>()
  const clock = { next: 0 }
  return {
    play: (pcm) => {
      const samples = pcm16ToFloat(pcm)
      if (samples.length === 0) return
      const buffer = context.createBuffer(1, samples.length, VOICE_OUTPUT_SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const at = Math.max(clock.next, context.currentTime + START_LEAD_SECONDS)
      source.addEventListener('ended', () => { live.delete(source) })
      source.start(at)
      live.add(source)
      clock.next = at + buffer.duration
    },
    flush: () => {
      for (const source of live) source.stop()
      live.clear()
      clock.next = 0
    },
    queuedSeconds: () => Math.max(0, clock.next - context.currentTime),
  }
}

/** Ask for the microphone and set up the audio; rejects (NotAllowedError, …) when the person refuses it. */
export async function openVoiceAudio(): Promise<VoiceAudio> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const context = new AudioContext()
  try {
    await context.audioWorklet.addModule(WORKLET_URL)
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    await context.close()
    throw error
  }
  const source = context.createMediaStreamSource(stream)
  const capture = new AudioWorkletNode(context, PROCESSOR_NAME, {
    processorOptions: { targetRate: VOICE_INPUT_SAMPLE_RATE, frameSamples: MIC_FRAME_SAMPLES },
  })
  source.connect(capture)
  // Pulled by the graph only when connected; the processor writes silence.
  capture.connect(context.destination)
  const playback = playbackOn(context)
  return {
    startCapture: (onFrame, onLevel) => {
      capture.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!isCaptureMessage(event.data)) return
        onFrame(event.data.pcm)
        onLevel(event.data.level)
      }
      void context.resume()
    },
    play: playback.play,
    flush: playback.flush,
    close: async (drainMs = 0) => {
      capture.port.onmessage = null
      source.disconnect()
      capture.disconnect()
      for (const track of stream.getTracks()) track.stop()
      const wait = Math.min(drainMs, playback.queuedSeconds() * SECOND_MS)
      if (wait > 0) await new Promise((resolve) => { globalThis.setTimeout(resolve, wait) })
      playback.flush()
      await context.close()
    },
  }
}
