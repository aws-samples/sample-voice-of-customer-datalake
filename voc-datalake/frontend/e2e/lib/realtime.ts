/**
 * A minimal AppSync Events WebSocket client for the realtime spec (docs/realtime.md), speaking the
 * protocol the SPA's aws-amplify client speaks: subprotocols `aws-appsync-event-ws` +
 * `header-<base64url({host, Authorization})>`, `connection_init` → `connection_ack`, then
 * `subscribe` → `subscribe_success` | `subscribe_error`. Node's global WebSocket (not `fetch`).
 * The token is sent only to the Event API and never logged.
 */
import { isRecord } from './guards'
import { siteUrl } from './env'
import { e2eFetch } from './trafficTag'

export interface RealtimeHosts {
  httpDns: string
  realtimeDns: string
}

/** The `realtime` block of `<site>/config.json` (raw, so the spec can judge its shape). */
export async function fetchRealtimeConfig(): Promise<unknown> {
  const response = await e2eFetch(`${siteUrl()}/config.json`)
  if (!response.ok) throw new Error(`GET /config.json answered ${response.status}`)
  const body: unknown = await response.json()
  return isRecord(body) ? body['realtime'] : undefined
}

export function realtimeHostsOf(raw: unknown): RealtimeHosts {
  const httpDns = isRecord(raw) ? raw['httpDns'] : undefined
  const realtimeDns = isRecord(raw) ? raw['realtimeDns'] : undefined
  if (typeof httpDns !== 'string' || typeof realtimeDns !== 'string') throw new Error('config.json has no realtime hosts')
  return { httpDns, realtimeDns }
}

export interface ServerMessage {
  type: string
  id?: string
  event?: unknown
  errors?: unknown
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function messageOf(data: unknown): ServerMessage | undefined {
  if (typeof data !== 'string') return undefined
  const parsed = parseJson(data)
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return undefined
  return {
    type: parsed['type'],
    id: typeof parsed['id'] === 'string' ? parsed['id'] : undefined,
    event: parsed['event'],
    errors: parsed['errors'],
  }
}

const TIMEOUT: ServerMessage = { type: 'timeout' }

export class RealtimeClient {
  private readonly socket: WebSocket
  private readonly messages: ServerMessage[] = []
  private readonly listeners = new Set<() => void>()
  private closedCode: number | undefined

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (m) => {
      const msg = messageOf(m.data)
      if (msg !== undefined && msg.type !== 'ka') this.messages.push(msg)
      for (const listener of this.listeners) listener()
    })
    socket.addEventListener('close', (e) => {
      this.closedCode = e.code
      for (const listener of this.listeners) listener()
    })
  }

  /** Opens the socket; `token: null` connects with no Authorization at all. */
  static open(hosts: RealtimeHosts, token: string | null): Promise<{ client: RealtimeClient; opened: boolean }> {
    const authorization: Record<string, string> = { host: hosts.httpDns }
    if (token !== null) authorization['Authorization'] = token
    const header = Buffer.from(JSON.stringify(authorization)).toString('base64url')
    const socket = new WebSocket(`wss://${hosts.realtimeDns}/event/realtime`, ['aws-appsync-event-ws', `header-${header}`])
    const client = new RealtimeClient(socket)
    return new Promise((resolve) => {
      socket.addEventListener('open', () => resolve({ client, opened: true }), { once: true })
      socket.addEventListener('error', () => resolve({ client, opened: false }), { once: true })
      socket.addEventListener('close', () => resolve({ client, opened: false }), { once: true })
    })
  }

  get closed(): number | undefined {
    return this.closedCode
  }

  /** Every non-keepalive message received so far. */
  received(): readonly ServerMessage[] {
    return this.messages
  }

  /** Resolves with the first message (seen or future) matching `match`, else `{type:'timeout'}`. */
  waitFor(match: (msg: ServerMessage) => boolean, ms: number): Promise<ServerMessage> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        const found = this.messages.find(match)
        if (found !== undefined) { done(found); return true }
        if (this.closedCode !== undefined) { done({ type: 'closed', errors: this.closedCode }); return true }
        return false
      }
      const timer = setTimeout(() => done(TIMEOUT), ms)
      const listener = (): void => { check() }
      const done = (msg: ServerMessage): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(msg)
      }
      if (!check()) this.listeners.add(listener)
    })
  }

  init(ms = 10_000): Promise<ServerMessage> {
    this.socket.send(JSON.stringify({ type: 'connection_init' }))
    return this.waitFor((m) => m.type === 'connection_ack' || m.type === 'connection_error' || m.type === 'error', ms)
  }

  subscribe(id: string, channel: string, hosts: RealtimeHosts, token: string, ms = 10_000): Promise<ServerMessage> {
    this.socket.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: { host: hosts.httpDns, Authorization: token } }))
    return this.waitFor((m) => m.id === id && (m.type === 'subscribe_success' || m.type === 'subscribe_error'), ms)
  }

  close(): void {
    this.socket.close()
  }
}

/** The `errorType`s of a `subscribe_error` (`errors: [{errorType, message}]`). */
export function errorTypesOf(msg: ServerMessage): string[] {
  return Array.isArray(msg.errors)
    ? msg.errors.flatMap((e) => (isRecord(e) && typeof e['errorType'] === 'string' ? [e['errorType']] : []))
    : []
}

/** A `data` message's event as an object (AppSync sends it as a JSON string). */
export function eventOf(msg: ServerMessage): Record<string, unknown> | undefined {
  const raw = msg.event
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw
  return isRecord(parsed) ? parsed : undefined
}
