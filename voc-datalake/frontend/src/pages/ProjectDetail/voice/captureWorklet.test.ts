/**
 * Pins public/voice-capture-worklet.js (plain JS, run in the audio thread) to the wire contract: it registers
 * `voc-voice-capture`, and turns the context's samples into PCM16LE frames of MIC_FRAME_SAMPLES at
 * VOICE_INPUT_SAMPLE_RATE, each posted (transferred) with its RMS level. The script is imported with the
 * AudioWorkletGlobalScope's globals stubbed, so importing it IS running it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIC_FRAME_SAMPLES, VOICE_INPUT_SAMPLE_RATE } from '@stream/voice/protocol'

const SCRIPT_PATH = '../../../../public/voice-capture-worklet.js'
const BLOCK = 128
const runs = { count: 0 }

type PostMessage = (message: unknown, transfer?: unknown) => void
interface Processor {
  port: { postMessage: ReturnType<typeof vi.fn<PostMessage>> }
  process: (inputs: Float32Array[][]) => boolean
}
interface Posted { pcm: ArrayBuffer; level: number; transfer: unknown }

function isFrame(value: unknown): value is { pcm: ArrayBuffer; level: number } {
  return typeof value === 'object' && value !== null && 'pcm' in value && value.pcm instanceof ArrayBuffer
    && 'level' in value && typeof value.level === 'number'
}

/** What the processor posted, each frame with its transfer list. */
function posted(processor: Processor): Posted[] {
  return processor.port.postMessage.mock.calls.map(([message, transfer]) => {
    if (!isFrame(message)) throw new Error('the worklet posted something else than a frame')
    return { pcm: message.pcm, level: message.level, transfer }
  })
}
type ProcessorClass = new (options?: { processorOptions?: Record<string, number> }) => Processor

/** The processor class the script registers, under a context at `rate`. */
async function loadProcessor(rate: number): Promise<{ name: string; Processor: ProcessorClass }> {
  const registered: Array<[string, ProcessorClass]> = []
  class Base { port = { postMessage: vi.fn<PostMessage>() } }
  vi.stubGlobal('AudioWorkletProcessor', Base)
  vi.stubGlobal('sampleRate', rate)
  vi.stubGlobal('registerProcessor', (name: string, processor: ProcessorClass) => { registered.push([name, processor]) })
  runs.count += 1
  await import(/* @vite-ignore */ `${SCRIPT_PATH}?run=${String(runs.count)}`)
  const [entry] = registered
  if (entry === undefined) throw new Error('the worklet registered nothing')
  return { name: entry[0], Processor: entry[1] }
}

/** Feed `seconds` of a constant `value` in 128-sample blocks; the frames it posted. */
function feed(processor: Processor, rate: number, seconds: number, value: number): Int16Array[] {
  const blocks = Math.round((rate * seconds) / BLOCK)
  Array.from({ length: blocks }, () => processor.process([[new Float32Array(BLOCK).fill(value)]]))
  return posted(processor).map((frame) => new Int16Array(frame.pcm))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('voice-capture-worklet.js', () => {
  it('registers voc-voice-capture and downsamples 48 kHz to 16 kHz frames of 1,024 samples', async () => {
    const { name, Processor } = await loadProcessor(48_000)
    const processor = new Processor({ processorOptions: { targetRate: VOICE_INPUT_SAMPLE_RATE, frameSamples: MIC_FRAME_SAMPLES } })
    const frames = feed(processor, 48_000, 0.192, 0.5)
    expect(name).toBe('voc-voice-capture')
    expect(frames.map((one) => one.length)).toStrictEqual([MIC_FRAME_SAMPLES, MIC_FRAME_SAMPLES, MIC_FRAME_SAMPLES])
    expect(new Set(frames.flatMap((one) => [...one]))).toStrictEqual(new Set([Math.round(0.5 * 0x7fff)]))
  })

  it('handles a ratio that is not whole (44.1 kHz), clamps, and posts the RMS level with the frame transferred', async () => {
    const { Processor } = await loadProcessor(44_100)
    const processor = new Processor({ processorOptions: { targetRate: VOICE_INPUT_SAMPLE_RATE, frameSamples: MIC_FRAME_SAMPLES } })
    const frames = feed(processor, 44_100, 0.07, -2)
    const [first] = posted(processor)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.every((sample) => sample === -0x8000)).toBe(true)
    expect([first?.level, first?.transfer]).toStrictEqual([1, [first?.pcm]])
  })

  it('keeps running without an input and falls back to 16 kHz frames of 1,024', async () => {
    const { Processor } = await loadProcessor(16_000)
    const processor = new Processor()
    expect(processor.process([])).toBe(true)
    expect(feed(processor, 16_000, 0.064, 0)).toHaveLength(1)
  })
})
