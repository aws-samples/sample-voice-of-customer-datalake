/**
 * The skill document's adapter contract (§6.3, §6.4 [52] step 1; gap M): a version reads as a SKILL.md whose
 * front-matter (its model, harness and tools) is split off and joined back byte for byte, read only by its status, its
 * version named per scope, read again (a 404: gone); and a person's own version: what to fix first, the body it sends
 * (on the version the screen showed), the examples it adds and removes, and a 409 as a stale base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import { joinFrontMatter, splitFrontMatter } from '../../../components/Document/text/frontMatter'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const {
  exampleChanges, isStaleBase, proposalIssues, proposeBody, skillAdapter, skillDocumentOf, skillMarkdown,
} = await import('./skillDocument')
const { parseDetail } = await import('../../../api/engineeringSkillsApi')

const RECORD = {
  instructions: '## Role\n\nYou are the fixer.\n\n- Plan the smallest fix.\n', examples: [{ situation: 'A flaky test.', action: 'Report it.' }],
  tool_policy: ['read_file', 'run'], model: 'global.anthropic.claude-sonnet-5-5', harness: 'converse',
}
const raw = (version: number, status: string) => ({ version: {
  version, status, summary: 's', proposed_by: 'alice', proposed_by_kind: 'person', proposed_at: '2026-11-10T09:00:00Z',
  base: null, record: RECORD, diff: { first: true },
} })
const title = (version: number) => `Fixer · v${String(version)}`

beforeEach(() => { resetFetchApi() })

describe('a skill version as a SKILL.md', () => {
  it('puts its properties in a flat front-matter, split off and joined back byte for byte', () => {
    const markdown = skillMarkdown(RECORD)
    const { frontMatter, body } = splitFrontMatter(markdown)
    expect(frontMatter).toBe('---\nmodel: global.anthropic.claude-sonnet-5-5\nharness: converse\ntools: read_file, run\n---\n')
    expect(body).toBe(RECORD.instructions)
    expect(joinFrontMatter(frontMatter, body)).toBe(markdown)
  })

  it('has an empty body when it has no instructions, its front-matter still there', () => {
    expect(splitFrontMatter(skillMarkdown({ ...RECORD, instructions: '', tool_policy: [] })).body).toBe('')
  })

  it('is read only by its status: an accepted or rejected version decided, a proposal changed only by proposing', () => {
    expect(['accepted', 'rejected', 'proposed'].map((status) => skillAdapter('', 'fixer', status, title).permissions.edit))
      .toStrictEqual(['decided', 'decided', 'proposalOnly'])
    expect(skillAdapter('', 'fixer', 'proposed', title)).toMatchObject({ contentType: 'markdown', frontMatter: 'split', policy: 'model' })
  })

  it('names each version by its scope, its role and its number', () => {
    const stored = skillDocumentOf('storefront', 'fixer', parseDetail(raw(4, 'accepted')), title(4))
    expect(skillAdapter('storefront', 'fixer', 'accepted', title).versionOf(stored)).toStrictEqual({ token: 'storefront/fixer/v4', number: 4 })
  })

  it('reads the same version again, and a version gone from the scope as none', async () => {
    const adapter = skillAdapter('', 'fixer', 'accepted', title)
    const stored = skillDocumentOf('', 'fixer', parseDetail(raw(3, 'accepted')), title(3))
    routeFetchApi({ 'GET /agents/engineering/skills/fixer/versions/3?connection=': () => raw(3, 'accepted') })
    expect((await adapter.load(stored))?.content).toBe(stored.content)
    routeFetchApi({ 'GET /agents/engineering/skills/fixer/versions/3?connection=': () => { throw new ApiError(404, 'no such skill version') } })
    expect(await adapter.load(stored)).toBeUndefined()
    expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/skills/fixer/versions/3?connection=', undefined)
  })
})

describe('a person\'s own version (gap M)', () => {
  const proposal = (fields: Record<string, unknown> = {}) => ({
    summary: 'Run the new test first', instructions: `${RECORD.instructions}- Run the new test first.\n`, examples: RECORD.examples,
    reason: '', ...fields,
  })

  it('may be sent once it has a one-line summary and changes something', () => {
    expect(proposalIssues(proposal(), RECORD)).toStrictEqual([])
    expect(proposalIssues(proposal({ summary: ' ', instructions: RECORD.instructions }), RECORD)).toStrictEqual(['summaryMissing', 'unchanged'])
  })

  it('refuses an "## Examples" heading in the instructions, and examples without both halves or past the bound', () => {
    const examples = Array.from({ length: 21 }, (_, n) => ({ situation: `s${String(n)}`, action: n === 0 ? ' ' : 'a' }))
    expect(proposalIssues(proposal({ instructions: '## Examples\n\nWhen this, do that.', examples }), RECORD))
      .toStrictEqual(['examplesHeading', 'examplesTooMany', 'exampleMissing'])
    expect(proposalIssues(proposal({ summary: 'one\ntwo', instructions: 'x'.repeat(20_001) }), RECORD))
      .toStrictEqual(['summaryLines', 'instructionsLong'])
  })

  it('sends the version it is written on as the screen showed it, the trimmed examples, and the reason only when given', () => {
    expect(proposeBody(proposal({ reason: '  Because the gate kept failing.  ', examples: [{ situation: ' A. ', action: ' B. ' }] }), 4))
      .toStrictEqual({ base_version: 4, instructions: proposal().instructions, examples: [{ situation: 'A.', action: 'B.' }],
        summary: 'Run the new test first', reason: 'Because the gate kept failing.' })
    expect(proposeBody(proposal(), 0)).not.toHaveProperty('reason')
  })

  it('lists the examples it removes and adds, by their text', () => {
    expect(exampleChanges(RECORD.examples, [{ situation: 'A lint failure.', action: 'Leave it.' }])).toStrictEqual([
      ['-', { situation: 'A flaky test.', action: 'Report it.' }], ['+', { situation: 'A lint failure.', action: 'Leave it.' }]])
  })

  it('reads a 409 as a stale base (another version is in use now), anything else as not', () => {
    expect([new ApiError(409, 'it changed since you opened it'), new ApiError(400, 'bad'), new Error('x')].map(isStaleBase))
      .toStrictEqual([true, false, false])
  })
})
