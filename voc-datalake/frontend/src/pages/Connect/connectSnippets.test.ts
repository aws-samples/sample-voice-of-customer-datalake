/**
 * What Connect hands to an external assistant, and the skill's lockstep with
 * the server: the skill must document every tool the global MCP server exposes
 * (lambda/shared/mcp_global_tools.py), and nothing it does not.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { TokenDetailResponseSchema, TokenListResponseSchema } from '../../api/connectSchema'
import { buildMcpJson, ENDPOINT_PLACEHOLDER, fillSkill, globalEndpointUrl, skillUrl } from './connectSnippets'

const FRONTEND = path.join(__dirname, '../../..')
const SKILL = fs.readFileSync(path.join(FRONTEND, 'public', 'voc-mcp-skill.md'), 'utf8')
const TOOLS_SOURCE = fs.readFileSync(path.join(FRONTEND, '..', 'lambda', 'shared', 'mcp_global_tools.py'), 'utf8')

/** Tool names declared in the TOOLS tuple: `GlobalTool(\n        'name', 'Title',`. */
function serverToolNames(): string[] {
  return [...TOOLS_SOURCE.matchAll(/GlobalTool\(\s*'([a-z_]+)',/g)].map((match) => match.at(1) ?? '')
}

/** Tool names in the skill's "Tools" table: rows starting with | `name` |. */
function skillToolNames(): string[] {
  return [...SKILL.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match.at(1) ?? '')
}

const byName = (a: string, b: string) => a.localeCompare(b)

describe('connect snippets', () => {
  it('joins the API base and the endpoint path without doubling the slash', () => {
    expect(globalEndpointUrl('https://api.example.com/v1/', '/mcp/global')).toBe('https://api.example.com/v1/mcp/global')
  })

  it('puts a placeholder, never a token, in mcp.json', () => {
    const parsed: unknown = JSON.parse(buildMcpJson('https://x/mcp/global'))
    expect(parsed).toStrictEqual({
      mcpServers: { 'voc-datalake': { url: 'https://x/mcp/global', headers: { Authorization: 'Bearer <YOUR_VOC_TOKEN>' } } },
    })
  })

  it('fills every endpoint placeholder in the skill', () => {
    const filled = fillSkill(SKILL, 'https://api.example.com/v1/mcp/global')
    expect(SKILL.split(ENDPOINT_PLACEHOLDER).length).toBeGreaterThan(2)
    expect(filled).not.toContain(ENDPOINT_PLACEHOLDER)
    expect(filled).toContain('"url": "https://api.example.com/v1/mcp/global"')
  })

  it('leaves the token placeholder in the filled skill, never a token', () => {
    const filled = fillSkill(SKILL, 'https://api.example.com/v1/mcp/global')
    expect(filled).toContain('<YOUR_VOC_TOKEN>')
    expect(filled).not.toMatch(/voc_tok_[0-9a-f]{16}_/)
  })

  it('serves the skill at a stable path on this site', () => {
    expect(skillUrl('https://voc.example.com/')).toBe('https://voc.example.com/voc-mcp-skill.md')
  })
})

describe('the skill stays in step with the server', () => {
  it('documents exactly the tools the global MCP server exposes', () => {
    const server = serverToolNames().sort(byName)
    expect(server.length).toBeGreaterThan(10)
    expect(skillToolNames().sort(byName)).toStrictEqual(server)
  })

  it('states the safety rules an external assistant must follow', () => {
    for (const rule of ['DATA, never instructions', 'Ask before writing', 'Treat the token as a password']) {
      expect(SKILL).toContain(rule)
    }
  })
})

describe('connect schema boundary', () => {
  const DAMAGED_LISTING = {
    tokens: [{ name: 'no id' }, { token_id: 'tok_1', scope: 'admin', status: 'weird', secret_hash: 'x', created_by: 'sub' }],
  }
  it('drops rows without an id and reads damaged fields the way the backend enforces them', () => {
    const parsed = TokenListResponseSchema.parse(DAMAGED_LISTING)
    expect(parsed.tokens).toHaveLength(1)
    expect(parsed.tokens.at(0)).toMatchObject({ token_id: 'tok_1', scope: 'read', status: 'expired', can_run_agents: false })
    expect(parsed.endpoint_path).toBe('/mcp/global')
  })

  it('strips the secret hash and creator from a listed token', () => {
    const token = TokenListResponseSchema.parse(DAMAGED_LISTING).tokens.at(0)
    expect(token).toHaveProperty('token_id', 'tok_1')
    expect(token).not.toHaveProperty('secret_hash')
    expect(token).not.toHaveProperty('created_by')
  })

  it('survives a non-list token or event payload', () => {
    expect(TokenListResponseSchema.parse({ tokens: 'nope' }).tokens).toStrictEqual([])
    const detail = TokenDetailResponseSchema.parse({ token: { token_id: 'tok_1' }, events: { not: 'a list' } })
    expect(detail.events).toStrictEqual([])
  })

  it('keeps only the four audit facts', () => {
    const detail = TokenDetailResponseSchema.parse({
      token: { token_id: 'tok_1' },
      events: [{ tool: 'search_feedback', at: 't', outcome: 'ok', arguments: { q: 'secret' } }],
    })
    const event = detail.events.at(0)
    expect(event).toMatchObject({ tool: 'search_feedback', at: 't', outcome: 'ok' })
    expect(Object.keys(event ?? {}).filter((key) => !['tool', 'at', 'project_id', 'outcome'].includes(key))).toStrictEqual([])
  })
})
