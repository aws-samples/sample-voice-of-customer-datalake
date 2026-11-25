/**
 * The docs preview's adapter contract and a publish's answers (§6.4 [52] steps 2 and 3; gap O): each rendered file is
 * a document of its own from its text (Markdown, or code for anything else), read only (what was approved), named by
 * its sha256, read again from the preview; a file past the preview's bound has no document (it is in the patch); and a
 * publish's 409 codes read as what to tell the administrator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { at, defined } from '@test/defined'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { patchFileName, previewFileAdapter, previewFileDocumentOf, publishOutcomeOf } = await import('./docsPreviewDocument')
const { parsePreview } = await import('../../../api/engineeringKnowledgeApi')

const PREVIEW = {
  connection: 'storefront', kind: 'knowledge', version: 3, branch: 'voc-agent/docs-knowledge-v3', digest: 'd'.repeat(64),
  approved_digest: 'd'.repeat(64), matches: true, patch: '--- /dev/null\n+++ b/docs/agents/index.md\n', patch_truncated: false,
  texts_truncated: true,
  files: [
    { path: 'docs/agents/index.md', sha256: 'a'.repeat(64), bytes: 20, text: '# What the agents know\n' },
    { path: 'docs/agents/repository.md', sha256: 'b'.repeat(64), bytes: 3_000_000, text: null },
  ],
}
const PATH = 'GET /agents/engineering/docs/storefront/preview?kind=knowledge'

beforeEach(() => { resetFetchApi() })

describe('a rendered file as a document', () => {
  it('reads a Markdown file as agent text, anything else as code, never edited', () => {
    expect(previewFileAdapter('storefront', 'knowledge', 'docs/agents/index.md'))
      .toMatchObject({ contentType: 'markdown', policy: 'model', permissions: { edit: 'decided' } })
    expect(previewFileAdapter('storefront', 'tenets', 'docs/agents/map.json').contentType).toBe('code')
  })

  it('has no document past the preview\'s bound (it is in the patch), and is named by its sha256 otherwise', () => {
    const { files } = parsePreview(PREVIEW)
    expect(previewFileDocumentOf(at(files, 1))).toBeNull()
    expect(previewFileDocumentOf(at(files, 0)))
      .toMatchObject({ title: 'docs/agents/index.md', content: '# What the agents know\n' })
  })

  it('is read again from the preview, and a file gone from it as none', async () => {
    const adapter = previewFileAdapter('storefront', 'knowledge', 'docs/agents/index.md')
    routeFetchApi({ [PATH]: () => PREVIEW })
    const stored = defined(await adapter.load({ title: 'docs/agents/index.md', content: '', sha256: '' }), 'the file')
    expect(adapter.versionOf(stored)).toStrictEqual({ token: 'a'.repeat(64) })
    routeFetchApi({ [PATH]: () => ({ ...PREVIEW, files: [] }) })
    expect(await adapter.load({ title: 'docs/agents/index.md', content: '', sha256: '' })).toBeUndefined()
  })
})

describe('a publish\'s answer', () => {
  it.each([
    ['human_driven', 'You work Human-driven'],
    ['already_published', 'This version has its pull request already'],
    ['digest_mismatch', 'the docs changed since the preview'],
    ['not_approved', 'nothing is approved'],
  ])('reads a 409 %s as that refusal', (code, message) => {
    expect(publishOutcomeOf(new ApiError(409, message, code))).toStrictEqual({ kind: 'refused', code })
  })

  it('reads any other failure as failed, with the server\'s words when it gave some', () => {
    expect([publishOutcomeOf(new ApiError(409, 'the broker refused', 'refused')), publishOutcomeOf(new ApiError(503))])
      .toStrictEqual([{ kind: 'failed', message: 'the broker refused' }, { kind: 'failed', message: null }])
  })

  it('names the patch to download by its kind and version', () => {
    expect(patchFileName(parsePreview(PREVIEW))).toBe('voc-docs-knowledge-v3.patch')
  })
})
