/**
 * The run report's and the template source's adapter contracts (§6.4 [52] step 4; gap S): a report read as agent text,
 * named by its level, subject and version, read again at that version (a version never changes; one never written:
 * none), its versions newest first and a newer one said, never shown by itself; a template's SKILL.md read as Markdown
 * with its front-matter split off, its YAML as code, both read only as the template's, named by their digest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { defined } from '@test/defined'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { newerReport, reportDocumentOf, reportVersions, runReportAdapter } = await import('./runReportDocument')
const { sourceDocumentOf, templateSourceAdapter } = await import('./templateSourceDocument')

const ENTRY = { level: 'goal', subject: 'RUN1', latest_version: 3 }
const REPORT = 'GET /agents/engineering/RUN1/reports/goal/RUN1?version=2'

beforeEach(() => { resetFetchApi() })

describe('a run\'s report as a document', () => {
  it('reads as agent text, with nothing a person could change', () => {
    expect(runReportAdapter('RUN1', ENTRY)).toMatchObject({ contentType: 'markdown', policy: 'model', permissions: { edit: true } })
    expect(runReportAdapter('RUN1', ENTRY)).not.toHaveProperty('save')
  })

  it('is named by its level, subject and version, and read again at that version', async () => {
    const adapter = runReportAdapter('RUN1', ENTRY)
    const stored = reportDocumentOf(ENTRY, 2, { markdown: '# Goal v1' })
    routeFetchApi({ [REPORT]: () => ({ report: { built_at: '2026-11-16T09:00:00Z' }, markdown: '# Goal v2' }) })
    expect(adapter.versionOf(stored)).toStrictEqual({ token: 'goal/RUN1/v2', number: 2 })
    expect(defined(await adapter.load(stored), 'report').content).toBe('# Goal v2')
    expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/RUN1/reports/goal/RUN1?version=2', undefined)
  })

  it('reads a version never written as none', async () => {
    routeFetchApi({ [REPORT]: () => { throw new ApiError(404, 'no') } })
    expect(await runReportAdapter('RUN1', ENTRY).load(reportDocumentOf(ENTRY, 2, { markdown: '' }))).toBeUndefined()
  })

  it('lists its versions newest first, and says a newer one than the one on screen', () => {
    expect(reportVersions(ENTRY)).toStrictEqual([3, 2, 1])
    expect([newerReport(ENTRY, 2), newerReport(ENTRY, 3)]).toStrictEqual([3, null])
  })
})

describe('a template\'s source as a document (gap S)', () => {
  const SKILL = { kind: 'skill', id: 'fixer', path: 'agents/fixer/SKILL.md', text: '---\nname: fixer\n---\n## Role\n', digest: 'sha256:1',
    template_version: 3 }

  it('reads a SKILL.md as Markdown with its front-matter split off, a YAML as code, both the template\'s', () => {
    expect(templateSourceAdapter('skill', 'fixer')).toMatchObject({ contentType: 'markdown', frontMatter: 'split',
      permissions: { edit: 'managedByTemplate' } })
    expect(templateSourceAdapter('card', 'fixer')).toMatchObject({ contentType: 'code', permissions: { edit: 'managedByTemplate' } })
    expect(templateSourceAdapter('card', 'fixer')).not.toHaveProperty('frontMatter')
  })

  it('is named by its digest and template version, and read again from the bundle (none: gone)', async () => {
    const adapter = templateSourceAdapter('skill', 'fixer')
    routeFetchApi({ 'GET /agents/engineering/templates/skill/fixer/source': () => SKILL })
    const stored = defined(await adapter.load(sourceDocumentOf({ ...SKILL, kind: 'skill' })), 'source')
    expect([stored.content, adapter.versionOf(stored)]).toStrictEqual([SKILL.text, { token: 'sha256:1', number: 3 }])
    routeFetchApi({ 'GET /agents/engineering/templates/skill/fixer/source': () => { throw new ApiError(404, 'no skill template') } })
    expect(await adapter.load(stored)).toBeUndefined()
  })
})
