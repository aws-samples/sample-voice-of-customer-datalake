/**
 * @fileoverview A stand-in `XMLHttpRequest` for specs of a presigned upload (api/libraryApi.ts `putLibraryFile`):
 * it records each request's method, URL, headers and body, and the spec finishes it by hand: progress, a status, or
 * a network failure.
 *
 * ```ts
 * const xhr = fakeXhrPerTest()       // at the top of the spec: installed before each test, restored after
 * …
 * xhr.last().progress(5, 10)
 * xhr.last().respond(200)
 * ```
 */
import { afterEach, beforeEach, vi } from 'vitest'

class FakeRequest {
  method = ''
  url = ''
  readonly headers: Record<string, string> = {}
  body: unknown = undefined
  status = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }

  private readonly sent: FakeRequest[]

  constructor(sent: FakeRequest[]) {
    this.sent = sent
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(body: unknown): void {
    this.body = body
    this.sent.push(this)
  }

  /** Report `loaded` of `total` bytes sent. */
  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ lengthComputable, loaded, total })
  }

  /** Finish with an HTTP status. */
  respond(status: number): void {
    this.status = status
    this.onload?.()
  }

  /** Fail as a network error does (no status). */
  fail(): void {
    this.onerror?.()
  }
}

export interface FakeXhr {
  /** Every request sent, in order. */
  readonly sent: FakeRequest[]
  /** The last request sent; fails the spec when none was. */
  last: () => FakeRequest
}

/** Replace `XMLHttpRequest` in each test of the calling suite (a fresh list of requests each time; restored after). */
export function fakeXhrPerTest(): FakeXhr {
  const sent: FakeRequest[] = []
  beforeEach(() => {
    sent.length = 0
    vi.stubGlobal('XMLHttpRequest', class extends FakeRequest {
      constructor() {
        super(sent)
      }
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })
  return {
    sent,
    last: () => {
      const request = sent.at(-1)
      if (request === undefined) throw new Error('No request was sent')
      return request
    },
  }
}
