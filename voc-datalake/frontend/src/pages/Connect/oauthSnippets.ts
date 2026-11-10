/**
 * @fileoverview "Sign in" snippets for MCP OAuth (docs/mcp.md → "OAuth sign-in"): what each client
 * needs to connect WITHOUT a token. The client finds the sign-in itself from the server's 401
 * (`WWW-Authenticate: Bearer resource_metadata=…`), registers, and opens the browser.
 *
 * @module pages/Connect/oauthSnippets
 */
const SERVER_KEY = 'voc-datalake'

/** Kiro and Cursor: an `mcp.json` entry with the URL only (no headers: the sign-in replaces the token). */
export function oauthMcpJson(endpointUrl: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: { url: endpointUrl } } }, null, 2)
}

/** Claude Code registers the server from the command line; `/mcp` in a session starts the sign-in. */
export function claudeCodeCommand(endpointUrl: string): string {
  return `claude mcp add --transport http ${SERVER_KEY} ${endpointUrl}`
}
