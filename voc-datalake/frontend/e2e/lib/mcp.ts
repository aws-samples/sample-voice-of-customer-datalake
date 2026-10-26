/**
 * The global MCP endpoint (`POST /mcp/global`, docs/mcp.md) called the way an
 * assistant calls it: JSON-RPC 2.0 with `Authorization: Bearer voc_…` and no
 * Origin header. The token is a secret: it is never logged, written or returned.
 */
import { apiUrl } from './env'
import { isRecord } from './guards'

export interface McpAnswer {
  status: number
  /** `result.tools.length` of a `tools/list` answer, null when there is none. */
  toolCount: number | null
  /** JSON-RPC `error.code`, null when there is none. */
  errorCode: number | null
  wwwAuthenticate: string | null
}

/** The fields a spec judges, from an HTTP status and a JSON-RPC body (pure, for the unit checks). */
export function readMcpAnswer(status: number, body: unknown, wwwAuthenticate: string | null): McpAnswer {
  const result = isRecord(body) ? body['result'] : undefined
  const tools = isRecord(result) ? result['tools'] : undefined
  const error = isRecord(body) ? body['error'] : undefined
  const code = isRecord(error) ? error['code'] : undefined
  return {
    status,
    toolCount: Array.isArray(tools) ? tools.length : null,
    errorCode: typeof code === 'number' ? code : null,
    wwwAuthenticate,
  }
}

/** `tools/list` with `token`. */
export async function mcpToolsList(token: string): Promise<McpAnswer> {
  const response = await fetch(`${apiUrl()}/mcp/global`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const text = await response.text()
  const body: unknown = (() => {
    try { return JSON.parse(text) } catch { return null }
  })()
  return readMcpAnswer(response.status, body, response.headers.get('www-authenticate'))
}
