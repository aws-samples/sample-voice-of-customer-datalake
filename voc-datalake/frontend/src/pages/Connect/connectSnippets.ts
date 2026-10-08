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

/** The skill with this deployment's endpoint in every placeholder. */
export function fillSkill(template: string, endpointUrl: string): string {
  return template.split(ENDPOINT_PLACEHOLDER).join(endpointUrl)
}

/** Absolute URL of the static skill on this site. */
export function skillUrl(origin: string): string {
  return `${stripTrailingSlashes(origin)}${SKILL_PATH}`
}
