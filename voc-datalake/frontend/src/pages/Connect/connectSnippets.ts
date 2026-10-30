/**
 * @fileoverview What the Connect page hands to an external assistant: the global
 * MCP endpoint URL, a ready `mcp.json`, and the skill (public/voc-mcp-skill.md,
 * served as-is at a stable URL, with the endpoint filled in client-side for the
 * download).
 *
 * The real token is NEVER embedded — every snippet carries a placeholder, so a
 * copied snippet or a downloaded skill can be shared without leaking anything.
 *
 * @module pages/Connect/connectSnippets
 */
import { stripTrailingSlashes } from '../../api/baseUrl'

/** Stable path of the skill template (frontend/public/voc-mcp-skill.md). */
export const SKILL_PATH = '/voc-mcp-skill.md'
export const SKILL_FILE_NAME = 'voc-datalake-skill.md'
/** The placeholder the template carries wherever the endpoint goes. */
export const ENDPOINT_PLACEHOLDER = '{{VOC_MCP_ENDPOINT}}'
const TOKEN_PLACEHOLDER = '<YOUR_VOC_TOKEN>'
const SERVER_KEY = 'voc-datalake'

/** The global endpoint's absolute URL from the API base and the path the API reports. */
export function globalEndpointUrl(apiEndpoint: string, endpointPath: string): string {
  return `${stripTrailingSlashes(apiEndpoint)}${endpointPath}`
}

export function buildMcpJson(endpointUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [SERVER_KEY]: { url: endpointUrl, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } },
    },
  }, null, 2)
}

/** The environment variable the env-var snippets read the token from. */
export const TOKEN_ENV_VAR = 'VOC_MCP_TOKEN'

/**
 * The clients Connect has an `mcp.json` for. The first three read the token from `VOC_MCP_TOKEN`
 * (each in its own substitution syntax), so the file holds no secret and can be committed; `inline`
 * is the paste-the-token variant for any other client. The first is the page's default.
 */
export const MCP_CLIENTS = ['claudeCode', 'cursor', 'kiro', 'inline'] as const
export type McpClient = (typeof MCP_CLIENTS)[number]

/** How each env-var client spells "the value of VOC_MCP_TOKEN" inside mcp.json. */
const ENV_REFERENCE: Record<Exclude<McpClient, 'inline'>, string> = {
  // Claude Code: `${VAR}` expansion in .mcp.json (url, headers, env).
  claudeCode: `\${${TOKEN_ENV_VAR}}`,
  // Cursor: `${env:NAME}` interpolation in mcp.json.
  cursor: `\${env:${TOKEN_ENV_VAR}}`,
  // Kiro: `${VAR}` in headers (kiro.dev/docs/mcp/configuration); the IDE expands only approved variables.
  kiro: `\${${TOKEN_ENV_VAR}}`,
}

export function isMcpClient(value: string): value is McpClient {
  return MCP_CLIENTS.some((client) => client === value)
}

/** The `mcp.json` for one client; the env-var variants carry no token, not even a placeholder. */
export function buildClientMcpJson(endpointUrl: string, client: McpClient): string {
  if (client === 'inline') return buildMcpJson(endpointUrl)
  const headers = { Authorization: `Bearer ${ENV_REFERENCE[client]}` }
  // Claude Code needs the transport named for a remote server in .mcp.json.
  const server = client === 'claudeCode' ? { type: 'http', url: endpointUrl, headers } : { url: endpointUrl, headers }
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: server } }, null, 2)
}

/** The shell line that sets the variable before starting the client (placeholder, never a token). */
export function tokenExportLine(): string {
  return `export ${TOKEN_ENV_VAR}='${TOKEN_PLACEHOLDER}'`
}

/** The skill with this deployment's endpoint in every placeholder. */
export function fillSkill(template: string, endpointUrl: string): string {
  return template.split(ENDPOINT_PLACEHOLDER).join(endpointUrl)
}

/** Absolute URL of the static skill on this site. */
export function skillUrl(origin: string): string {
  return `${stripTrailingSlashes(origin)}${SKILL_PATH}`
}
