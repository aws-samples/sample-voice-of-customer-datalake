/**
 * @fileoverview Open as a pull request (7.52.00; gap O): the approved docs' preview file by file, each read as a
 * document from its text (one past the preview's bound is in the patch); the publish sends the preview's digest and
 * says the pull request is ready for review and only a person merges it; a Human-driven administrator gets the patch
 * to apply (Download), a version published before says so, another rendering offers to read it again, and nothing
 * approved yet says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { DocsPublishSheet } = await import('./DocsPublishSheet')

const PREVIEW_PATH = 'GET /agents/engineering/docs/storefront/preview?kind=knowledge'
const PUBLISH = '/agents/engineering/docs/storefront/publish'
const DIGEST = 'd'.repeat(64)
const PREVIEW = {
  connection: 'storefront', kind: 'knowledge', version: 3, branch: 'voc-agent/docs/knowledge-v3', digest: DIGEST,
  approved_digest: DIGEST, matches: true, patch: '--- /dev/null\n+++ b/docs/agents/index.md\n+# What the agents know\n',
  patch_truncated: false, texts_truncated: true,
  files: [
    { path: 'docs/agents/index.md', sha256: 'a'.repeat(64), bytes: 2048, text: '# What the agents know\n\n- The repository\n' },
    { path: 'docs/agents/repository.md', sha256: 'b'.repeat(64), bytes: 3_000_000, text: null },
  ],
}

function renderSheet(routes: Record<string, RouteHandler> = {}) {
  routeFetchApi({ [PREVIEW_PATH]: () => PREVIEW, ...routes }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><DocsPublishSheet connection="storefront" kind="knowledge" onClose={vi.fn()} /></TestRouter>)
  return screen.findByRole('dialog', { name: 'Open the knowledge docs as a pull request' })
}

const publish = async (sheet: HTMLElement) => {
  await userEvent.click(await within(sheet).findByRole('button', { name: 'Open the pull request' }))
}

beforeEach(() => { resetFetchApi() })

describe('the approved docs\' preview', () => {
  it('lists every file the approval renders to, and reads one as a document from its text', async () => {
    const sheet = await renderSheet()
    expect(await within(sheet).findByText('Branch voc-agent/docs/knowledge-v3, from approved version 3. Only a person merges it.')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: /docs\/agents\/index\.md/ }))
    expect(await within(sheet).findByRole('heading', { name: 'What the agents know' })).toBeInTheDocument()
  })

  it('says a file past the preview\'s bound is in the patch', async () => {
    const sheet = await renderSheet()
    await userEvent.click(await within(sheet).findByRole('button', { name: /docs\/agents\/repository\.md/ }))
    expect(within(sheet).getByText('This file is too large to show here: it is in the patch.')).toBeInTheDocument()
  })

  it('says nothing is approved yet when the preview has none (404)', async () => {
    const sheet = await renderSheet({ [PREVIEW_PATH]: () => { throw new ApiError(404, 'no knowledge docs are approved for the connection yet') } })
    expect(await within(sheet).findByText('Nothing of this is approved yet: approve a version first.')).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Open the pull request' })).toBeNull()
  })
})

describe('the publish', () => {
  it('sends the preview\'s digest, and says the pull request is ready for review and only a person merges it', async () => {
    const sheet = await renderSheet({ [`POST ${PUBLISH}`]: () => ({ pr: { url: 'https://github.com/o/r/pull/41', number: 41,
      branch: 'voc-agent/docs/knowledge-v3' }, kind: 'knowledge', version: 3, digest: DIGEST, draft: false }) })
    await publish(sheet)
    expect(await within(sheet).findByRole('status')).toHaveTextContent('Pull request #41 opened, ready for review.')
    expect(within(sheet).getByText('Only a person merges it, on the host.')).toBeInTheDocument()
    expect(sentFetchApiBody(PUBLISH, 'POST')).toStrictEqual({ kind: 'knowledge', digest: DIGEST })
  })

  it('gives a Human-driven administrator the patch to apply, with Download', async () => {
    const sheet = await renderSheet({ [`POST ${PUBLISH}`]: () => { throw new ApiError(409, 'You work Human-driven', 'human_driven') } })
    await publish(sheet)
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('You work Human-driven: the platform pushes nothing for you.')
    expect(within(sheet).getByRole('region', { name: 'The patch adding the docs' })).toHaveTextContent('+++ b/docs/agents/index.md')
    expect(within(sheet).getByRole('button', { name: 'Download the patch' })).toBeInTheDocument()
  })

  it('says a version published before has its pull request already', async () => {
    const sheet = await renderSheet({ [`POST ${PUBLISH}`]: () => { throw new ApiError(409, 'repeated', 'already_published') } })
    await publish(sheet)
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('This version of the docs has its pull request already')
  })

  it('reads the preview again when the docs changed since it (digest_mismatch)', async () => {
    const sheet = await renderSheet({ [`POST ${PUBLISH}`]: () => { throw new ApiError(409, 'the docs changed', 'digest_mismatch') } })
    await publish(sheet)
    await userEvent.click(await within(sheet).findByRole('button', { name: 'Read it again' }))
    await waitFor(() => { expect(fetchApi.mock.calls.filter(([path]) => path.includes('/preview?kind=knowledge'))).toHaveLength(2) })
    expect(within(sheet).queryByRole('alert')).toBeNull()
  })
})
