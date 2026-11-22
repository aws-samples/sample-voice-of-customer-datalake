/**
 * The browser audio of a voice session, on stand-ins for getUserMedia and Web Audio: the microphone asked with echo
 * cancellation, the capture worklet loaded from the same origin, its frames and level handed on (anything else
 * ignored), the persona's PCM16 played back to back at 24 kHz, barge-in stopping every queued chunk, and everything
 * released on close (after the queued voice has played, when the close gives it time) or when the worklet cannot load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIC_FRAME_SAMPLES, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from '@stream/voice/protocol'
import { openVoiceAudio } from './voiceAudio'

type Mock = ReturnType<typeof vi.fn<(at?: number) => void>>
interface Source { start: Mock; stop: Mock; buffer: unknown; listeners: Array<() => void> }

function stubAudio({ workletFails = false } = {}) {
  const track = { stop: vi.fn() }
  const getUserMedia = vi.fn<(constraints: unknown) => Promise<unknown>>().mockResolvedValue({ getTracks: () => [track] })
  const sources: Source[] = []
  const buffers: Array<{ samples: Float32Array; rate: number }> = []
  const context = {
    currentTime: 1,
    destination: {},
    audioWorklet: { addModule: vi.fn<(url: string) => Promise<void>>(() => (workletFails ? Promise.reject(new DOMException('no', 'AbortError')) : Promise.resolve())) },
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_channels: number, length: number, rate: number) => {
      const entry = { samples: new Float32Array(length), rate }
      buffers.push(entry)
      return { duration: length / rate, copyToChannel: (samples: Float32Array) => entry.samples.set(samples) }
    },
    createBufferSource: () => {
      const source: Source = { start: vi.fn<(at?: number) => void>(), stop: vi.fn<(at?: number) => void>(), buffer: null, listeners: [] }
      sources.push(source)
      return { ...source, connect: vi.fn(), addEventListener: (_name: string, listener: () => void) => source.listeners.push(listener),
        set buffer(value: unknown) { source.buffer = value } }
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  }
  const nodes: Array<{ port: { onmessage: ((event: MessageEvent<unknown>) => void) | null }; options: unknown }> = []
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('AudioContext', function AudioContext() { return context })
  vi.stubGlobal('AudioWorkletNode', function AudioWorkletNode(_context: unknown, _name: string, options: unknown) {
    const node = { port: { onmessage: null }, options, connect: vi.fn(), disconnect: vi.fn() }
    nodes.push(node)
    return node
  })
  return { track, getUserMedia, context, sources, buffers, nodes }
}

/** PCM16LE of the given samples. */
function pcm(...samples: number[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true))
  return view.buffer
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openVoiceAudio', () => {
  it('asks for the microphone, loads the worklet and hands on its frames and level only', async () => {
    const stub = stubAudio()
    const audio = await openVoiceAudio()
    const onFrame = vi.fn()
    const onLevel = vi.fn()
    audio.startCapture(onFrame, onLevel)
    const port = stub.nodes[0]?.port
    port?.onmessage?.(new MessageEvent('message', { data: { pcm: new ArrayBuffer(4), level: 0.3 } }))
    port?.onmessage?.(new MessageEvent('message', { data: 'noise' }))
    expect(stub.getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: { echoCancellation: true, channelCount: 1 } })
    expect([stub.context.audioWorklet.addModule.mock.calls[0]?.[0], stub.nodes[0]?.options]).toStrictEqual([
      '/voice-capture-worklet.js', { processorOptions: { targetRate: VOICE_INPUT_SAMPLE_RATE, frameSamples: MIC_FRAME_SAMPLES } }])
    expect([onFrame.mock.calls.length, onLevel.mock.calls, stub.context.resume.mock.calls.length]).toStrictEqual([1, [[0.3]], 1])
  })

  it('plays the persona\'s chunks back to back at 24 kHz, and a flush stops every one still queued', async () => {
    const stub = stubAudio()
    const audio = await openVoiceAudio()
    audio.play(pcm(0x4000, -0x8000))
    audio.play(pcm(0x7fff))
    audio.play(new ArrayBuffer(0))
    audio.flush()
    expect(stub.buffers.map(({ samples, rate }) => [[...samples], rate])).toStrictEqual([
      [[0.5, -1], VOICE_OUTPUT_SAMPLE_RATE], [[0x7fff / 0x8000], VOICE_OUTPUT_SAMPLE_RATE]])
    expect(stub.sources.map((source) => source.start.mock.calls[0]?.[0])).toStrictEqual([1.05, 1.05 + 2 / VOICE_OUTPUT_SAMPLE_RATE])
    expect(stub.sources.map((source) => source.stop.mock.calls.length)).toStrictEqual([1, 1])
  })

  it('forgets a chunk once it has played, and releases the microphone and the context on close', async () => {
    const stub = stubAudio()
    const audio = await openVoiceAudio()
    audio.play(pcm(1))
    stub.sources[0]?.listeners.forEach((listener) => listener())
    await audio.close()
    expect([stub.sources[0]?.stop.mock.calls.length, stub.track.stop.mock.calls.length, stub.context.close.mock.calls.length])
      .toStrictEqual([0, 1, 1])
  })

  it('releases the microphone at once and the context once the queued voice has played, at most the drain given', async () => {
    vi.useFakeTimers()
    const stub = stubAudio()
    const audio = await openVoiceAudio()
    audio.play(new ArrayBuffer(2 * VOICE_OUTPUT_SAMPLE_RATE))
    const closing = audio.close(10_000)
    await vi.advanceTimersByTimeAsync(1000)
    const midway = [stub.track.stop.mock.calls.length, stub.context.close.mock.calls.length]
    await vi.advanceTimersByTimeAsync(100)
    await closing
    vi.useRealTimers()
    // One second of voice queued 50 ms ahead: the context closes 1,050 ms later, not after the drain's 10 s.
    expect([midway, stub.context.close.mock.calls.length]).toStrictEqual([[1, 0], 1])
  })

  it('releases the microphone when the worklet cannot load', async () => {
    const stub = stubAudio({ workletFails: true })
    await expect(openVoiceAudio()).rejects.toThrow('no')
    expect([stub.track.stop.mock.calls.length, stub.context.close.mock.calls.length]).toStrictEqual([1, 1])
  })
})
