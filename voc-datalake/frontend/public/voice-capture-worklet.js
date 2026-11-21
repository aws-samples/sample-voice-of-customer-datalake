/**
 * The voice personas' microphone (7.69.00, docs/voice-personas.md): an AudioWorklet processor that turns the
 * microphone's samples (the AudioContext's own rate, often 48 kHz) into the frames the relay forwards to Nova Sonic:
 * 16-bit signed little-endian PCM, mono, at `targetRate` (16 kHz), `frameSamples` (1,024: 64 ms) per frame.
 *
 * Each output sample is the mean of the input samples it stands for (a box filter, so a 48 kHz voice is not
 * aliased into the 16 kHz band); the ratio need not be whole (44.1 kHz). Every finished frame is posted to the page
 * with its RMS level (0 to 1, the meter) and transferred, never copied. It writes nothing to its output: the page
 * hears only the persona. The audio is never stored: the page sends each frame on the session's WebSocket and drops it.
 *
 * Published as is (src/publicAssets.test.ts PUBLISHED_SCRIPTS): a worklet runs in the audio thread's own global scope,
 * loaded by URL with `audioWorklet.addModule`, and the CSP (`script-src 'self'`) admits no blob: module. Pinned by
 * src/pages/ProjectDetail/voice/captureWorklet.test.ts.
 */
const PROCESSOR_NAME = 'voc-voice-capture'
const INT16_MAX = 0x7fff
const INT16_MIN = -0x8000

class VocVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const settings = (options && options.processorOptions) || {}
    const targetRate = Number(settings.targetRate) || 16000
    this.frameSamples = Number(settings.frameSamples) || 1024
    // Input samples per output sample (sampleRate is the AudioWorkletGlobalScope's).
    this.step = sampleRate / targetRate
    this.boundary = this.step
    this.read = 0
    this.sum = 0
    this.count = 0
    this.frame = new Int16Array(this.frameSamples)
    this.filled = 0
    this.squares = 0
  }

  emit(value) {
    const sample = Math.max(-1, Math.min(1, value))
    this.frame[this.filled] = sample < 0 ? Math.round(sample * -INT16_MIN) : Math.round(sample * INT16_MAX)
    this.filled += 1
    this.squares += sample * sample
    if (this.filled < this.frameSamples) return
    const level = Math.sqrt(this.squares / this.frameSamples)
    const pcm = this.frame.buffer
    this.port.postMessage({ pcm, level }, [pcm])
    this.frame = new Int16Array(this.frameSamples)
    this.filled = 0
    this.squares = 0
  }

  consume(channel) {
    for (const value of channel) {
      this.sum += value
      this.count += 1
      this.read += 1
      if (this.read >= this.boundary) {
        this.emit(this.sum / this.count)
        this.sum = 0
        this.count = 0
        this.boundary += this.step
      }
    }
  }

  // Always true: the processor lives as long as the page keeps its node.
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.consume(channel)
    return true
  }
}

registerProcessor(PROCESSOR_NAME, VocVoiceCapture)
