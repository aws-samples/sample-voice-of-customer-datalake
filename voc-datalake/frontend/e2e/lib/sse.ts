/**
 * Taps the assistant's `/chat/stream` SSE inside the page: an init script wraps
 * `window.fetch`, tees the response body and records every chunk with its
 * arrival time. That gives the real time-to-first-byte (first body chunk, not
 * just headers), time to the first answer token, the total, and the AG-UI
 * events themselves (tool calls, their arguments and results) to judge an
 * answer by what the assistant actually looked up.
 *
 * Request headers are never read, so the Authorization token is never captured.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { isRecord } from './guards'
import { OUT_DIR } from './env'

/** What the page records per stream run (`window.__e2eSse`). */
export interface RawStreamRun {
  threadId: string | null
  runId: string | null
  sentAtEpochMs: number
  status: number | null
  headersMs: number | null
  chunks: Array<{ ms: number; text: string }>
  endMs: number | null
  error: string | null
}

declare global {
  interface Window {
    /** Stream runs recorded by the tap (this document only). */
    __e2eSse?: RawStreamRun[]
  }
}

/** Installs the tap; call before the first navigation of the page. */
export async function installSseTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const runs: RawStreamRun[] = []
    window.__e2eSse = runs
    const original = window.fetch.bind(window)
    const urlOf = (input: RequestInfo | URL): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(urlOf(input), window.location.href)
      if (!/\/chat\/stream$/.test(url.pathname)) return original(input, init)
      const ids = (() => {
        try {
          const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
          const field = (key: string): string | null => {
            if (typeof body !== 'object' || body === null || !(key in body)) return null
            const value: unknown = Reflect.get(body, key)
            return typeof value === 'string' ? value : null
          }
          return { threadId: field('threadId'), runId: field('runId') }
        } catch {
          return { threadId: null, runId: null }
        }
      })()
      const t0 = performance.now()
      const run: RawStreamRun = { ...ids, sentAtEpochMs: Date.now(), status: null, headersMs: null, chunks: [], endMs: null, error: null }
      runs.push(run)
      const response = await original(input, init)
      run.status = response.status
      run.headersMs = Math.round(performance.now() - t0)
      if (response.body === null) {
        run.endMs = run.headersMs
        return response
      }
      const [forApp, forTap] = response.body.tee()
      void (async () => {
        const reader = forTap.getReader()
        const decoder = new TextDecoder()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            run.chunks.push({ ms: Math.round(performance.now() - t0), text: decoder.decode(value, { stream: true }) })
          }
          run.endMs = Math.round(performance.now() - t0)
        } catch (error) {
          run.error = String(error).slice(0, 200)
        }
      })()
      return new Response(forApp, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  })
}

function isRawRun(value: unknown): value is RawStreamRun {
  return isRecord(value) && typeof value['sentAtEpochMs'] === 'number' && Array.isArray(value['chunks'])
}

/** Every stream run of the current document (a reload starts a new list). */
export async function streamRuns(page: Page): Promise<RawStreamRun[]> {
  const raw: unknown = await page.evaluate(() => window.__e2eSse ?? [])
  return Array.isArray(raw) ? raw.filter(isRawRun) : []
}

/** Waits until run number `index` (0-based, this document) has finished or failed. */
export async function waitForRunEnd(page: Page, index: number, timeoutMs: number): Promise<RawStreamRun> {
  await page.waitForFunction((i) => {
    const run = (window.__e2eSse ?? [])[i]
    return run !== undefined && (run.endMs !== null || run.error !== null)
  }, index, { timeout: timeoutMs, polling: 250 })
  const run = (await streamRuns(page))[index]
  if (run === undefined) throw new Error(`stream run ${index} vanished`)
  return run
}

export interface ToolCall {
  id: string
  name: string
  args: string
  result: string | null
}

export interface StreamSummary {
  threadId: string | null
  runId: string | null
  status: number | null
  headersMs: number | null
  /** First body chunk. */
  ttfbMs: number | null
  /** First TEXT_MESSAGE_CONTENT (the first visible answer token). */
  firstTokenMs: number | null
  totalMs: number | null
  /** Longest silence between two chunks: a run "without streaming progress". */
  maxGapMs: number
  eventCounts: Record<string, number>
  toolCalls: ToolCall[]
  answer: string
  interrupted: boolean
  runError: string | null
  context: unknown
  error: string | null
}

type SseEvent = Record<string, unknown> & { type: string }

function parseEvents(chunks: RawStreamRun['chunks']): Array<{ ms: number; event: SseEvent }> {
  const out: Array<{ ms: number; event: SseEvent }> = []
  let buffer = ''
  for (const chunk of chunks) {
    buffer += chunk.text
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (data === '') continue
      try {
        const parsed: unknown = JSON.parse(data)
        if (isRecord(parsed) && typeof parsed['type'] === 'string') out.push({ ms: chunk.ms, event: { ...parsed, type: parsed['type'] } })
      } catch {
        // a non-JSON frame (keep-alive comment) carries no event
      }
    }
  }
  return out
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function summarize(run: RawStreamRun): StreamSummary {
  const events = parseEvents(run.chunks)
  const eventCounts: Record<string, number> = {}
  const calls = new Map<string, ToolCall>()
  let answer = ''
  let firstTokenMs: number | null = null
  let interrupted = false
  let runError: string | null = null
  let context: unknown = null
  for (const { ms, event } of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
    const id = str(event['toolCallId'])
    if (event.type === 'TOOL_CALL_START') calls.set(id, { id, name: str(event['toolCallName']), args: '', result: null })
    if (event.type === 'TOOL_CALL_ARGS') { const c = calls.get(id); if (c) c.args += str(event['delta']) }
    if (event.type === 'TOOL_CALL_RESULT') { const c = calls.get(id); if (c) c.result = str(event['content']) }
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      firstTokenMs ??= ms
      answer += str(event['delta'])
    }
    if (event.type === 'RUN_FINISHED' && isRecord(event['outcome']) && event['outcome']['type'] === 'interrupt') interrupted = true
    if (event.type === 'RUN_FINISHED' && Array.isArray(event['interrupts']) && event['interrupts'].length > 0) interrupted = true
    if (event.type === 'RUN_ERROR') runError = str(event['message']) || 'RUN_ERROR'
    if (event.type === 'CUSTOM' && event['name'] === 'assistant.context') context = event['value']
  }
  let maxGapMs = 0
  run.chunks.forEach((c, i) => {
    const prev = i === 0 ? run.headersMs ?? 0 : run.chunks[i - 1]?.ms ?? 0
    maxGapMs = Math.max(maxGapMs, c.ms - prev)
  })
  return {
    threadId: run.threadId,
    runId: run.runId,
    status: run.status,
    headersMs: run.headersMs,
    ttfbMs: run.chunks[0]?.ms ?? null,
    firstTokenMs,
    totalMs: run.endMs,
    maxGapMs,
    eventCounts,
    toolCalls: [...calls.values()],
    answer,
    interrupted,
    runError,
    context,
    error: run.error,
  }
}

/** Writes the summary (tool results trimmed) to OUT_DIR/sse/<label>.json. */
export function writeStreamEvidence(label: string, summary: StreamSummary): string {
  const dir = path.join(OUT_DIR, 'sse')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${label.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`)
  const trimmed = {
    ...summary,
    toolCalls: summary.toolCalls.map((c) => ({ ...c, result: c.result === null ? null : c.result.slice(0, 4000) })),
  }
  fs.writeFileSync(file, JSON.stringify(trimmed, null, 2))
  return file
}

/** One line for step notes. */
export function streamLine(s: StreamSummary): string {
  const tools = s.toolCalls.map((c) => c.name).join(',') || 'none'
  return `stream ${s.status ?? '?'} headers=${s.headersMs ?? '?'}ms ttfb=${s.ttfbMs ?? '?'}ms firstToken=${s.firstTokenMs ?? '?'}ms total=${s.totalMs ?? '?'}ms maxGap=${s.maxGapMs}ms tools=[${tools}] interrupted=${s.interrupted} answerChars=${s.answer.length}${s.runError === null ? '' : ` RUN_ERROR=${s.runError}`}`
}
