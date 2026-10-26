/**
 * @fileoverview SSE framing for the AG-UI stream.
 *
 * The stream Lambda writes one AG-UI event per `data: <json>\n\n` frame. A
 * network chunk can end anywhere — mid-line, mid-JSON, mid-UTF-8 sequence — so
 * the reader buffers until a newline and decodes with `stream: true`.
 *
 * Every parsed payload is validated against `@ag-ui/core`'s own event schemas.
 * Anything that fails (malformed JSON, an unknown event type, a known type with
 * the wrong shape) is DROPPED rather than thrown: one bad frame must not kill a
 * run whose other events are fine, and the reducer only ever sees typed events.
 *
 * @module assistant/agui/sse
 */
import { EventSchemas } from '@ag-ui/core/schemas'
import type { z } from 'zod/v4'

/** A validated AG-UI event, typed from the schema that validated it. */
export type AguiEvent = z.infer<typeof EventSchemas>

const DATA_PREFIX = 'data:'

/** Parse one SSE line into an AG-UI event, or `null` when it is not one. */
export function parseSseLine(line: string): AguiEvent | null {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith(DATA_PREFIX)) return null
  const payload = trimmed.slice(DATA_PREFIX.length).trimStart()
  if (payload === '') return null
  try {
    const parsed = EventSchemas.safeParse(JSON.parse(payload))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Split a buffer into complete lines' events and the trailing partial line. */
export function parseSseBuffer(buffer: string): { events: AguiEvent[]; remainder: string } {
  const lines = buffer.split('\n')
  const remainder = lines.pop() ?? ''
  const events = lines
    .map(parseSseLine)
    .filter((event): event is AguiEvent => event !== null)
  return { events, remainder }
}

/** Read an SSE body to the end, yielding validated AG-UI events. */
export async function* readSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<AguiEvent> {
  const decoder = new TextDecoder()
  const buffer = { value: '' }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer.value += decoder.decode(value, { stream: true })
      const { events, remainder } = parseSseBuffer(buffer.value)
      buffer.value = remainder
      yield* events
    }
    // A final frame without its trailing newline is still a frame.
    const last = parseSseLine(buffer.value + decoder.decode())
    if (last !== null) yield last
  } finally {
    reader.releaseLock()
  }
}
