/**
 * Page context mapping, plus coverage against the real route table: every
 * protected route must have a pattern, or the assistant would call it "other".
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '@test/TestRouter'
import { agentsKeys } from '../../api/agentsApi'
import { routes } from '../../routes'
import { MAX_FACET_FILTER_CHARS, MAX_ID_LENGTH, MAX_PAGE_FILTER_CHARS, NO_MATCH_FILTER_VALUE } from '@stream/assistant/contract'
import { PAGE_PATTERNS, pageContextFromLocation, selectedDocumentId } from './pageContext'
import { usePageContext } from './usePageContext'
import type { ReactNode } from 'react'

describe('pageContextFromLocation', () => {
  it.each([
    ['/', '', { kind: 'home', path: '/' }],
    ['/dashboard', '', { kind: 'dashboard', path: '/dashboard' }],
    ['/feedback/f-1', '', { kind: 'feedback', path: '/feedback/f-1', feedbackId: 'f-1' }],
    ['/projects', '', { kind: 'projects', path: '/projects' }],
    ['/projects/p1/personas', '', { kind: 'project', path: '/projects/p1/personas', projectId: 'p1', tab: 'personas' }],
    // The query names no tab (no old `?tab=` link is read): the project's own path is its Overview.
    ['/projects/p1', '?tab=personas', { kind: 'project', path: '/projects/p1', projectId: 'p1', tab: 'overview' }],
    ['/feedback-forms', '', { kind: 'feedback-forms', path: '/feedback-forms' }],
    ['/settings', '?tab=a%20b', { kind: 'settings', path: '/settings' }],
    ['/agents/workflows', '', { kind: 'agents', path: '/agents/workflows', tab: 'workflows' }],
    ['/agents/workflows/wf_1', '', { kind: 'agents', path: '/agents/workflows/wf_1' }],
    ['/agents/skills/fixer/versions/2', '', { kind: 'agents', path: '/agents/skills/fixer/versions/2', tab: 'skills' }],
    ['/agents/ag_1/runs', '', { kind: 'agent', path: '/agents/ag_1/runs', agentId: 'ag_1', tab: 'runs' }],
    ['/agents/ag_1', '?tab=runs', { kind: 'agent', path: '/agents/ag_1', agentId: 'ag_1' }],
    ['/admin/platform/deployment-brand', '', { kind: 'settings', path: '/admin/platform/deployment-brand', tab: 'platform' }],
    ['/memory/personal', '', { kind: 'memory', path: '/memory/personal', tab: 'personal' }],
    ['/company/design', '', { kind: 'company', path: '/company/design', tab: 'design' }],
    ['/account/access', '', { kind: 'other', path: '/account/access', tab: 'access' }],
    ['/data-explorer/processed', '', { kind: 'data-explorer', path: '/data-explorer/processed', tab: 'processed' }],
    ['/participants/people', '', { kind: 'participants', path: '/participants/people', tab: 'people' }],
    ['/feature-requests/insights', '', { kind: 'other', path: '/feature-requests/insights', tab: 'insights' }],
    ['/feature-requests/beta-feedback/fr_1', '', { kind: 'other', path: '/feature-requests/beta-feedback/fr_1' }],
    ['/agents/ag_1', '', { kind: 'agent', path: '/agents/ag_1', agentId: 'ag_1' }],
    ['/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3', '', { kind: 'agents',
      path: '/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3', engineeringRunId: '01JDA7K3M9Q2R5T8V0W4X6Y1Z3' }],
    // (7.51.00) An agent open in the run's workspace: the run is still the one on screen.
    ['/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3/a/fixer-3', '', { kind: 'agents',
      path: '/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3/a/fixer-3', engineeringRunId: '01JDA7K3M9Q2R5T8V0W4X6Y1Z3' }],
    ['/agents/runs', '?month=2026-11', { kind: 'agents', path: '/agents/runs', tab: 'runs' }],
    // (not a run id: the run monitor answers not found, and the context names no run)
    ['/agents/engineering/run-1', '', { kind: 'agents', path: '/agents/engineering/run-1' }],
    ['/radar', '', { kind: 'radar', path: '/radar' }],
    ['/participants', '?tab=lists', { kind: 'participants', path: '/participants' }],
    ['/feature-requests', '', { kind: 'other', path: '/feature-requests' }],
    ['/feature-requests/beta-feedback', '', { kind: 'other', path: '/feature-requests/beta-feedback' }],
    ['/nowhere', '', { kind: 'other', path: '/nowhere' }],
  ])('%s%s', (pathname, search, expected) => {
    expect(pageContextFromLocation({ pathname, search })).toStrictEqual(expected)
  })

  it('reads the open document from a project\'s path (never its query), within MAX_ID_LENGTH', () => {
    const project = { kind: 'project' } as const
    const at = (pathname: string, search = '') => ({ pathname, search })
    const longest = 'x'.repeat(MAX_ID_LENGTH)
    expect([
      at('/projects/p1/documents/proto_3'), at('/projects/p1/documents/proto_3/v/2/focus'),
      at('/projects/p1', '?tab=documents&doc=proto_3'), at(`/projects/p1/documents/${longest}`),
      at(`/projects/p1/documents/${longest}x`), at('/projects/p1/personas'),
    ].map((location) => selectedDocumentId(project, location))).toStrictEqual(['proto_3', 'proto_3', undefined, longest, undefined, undefined])
    expect(selectedDocumentId({ kind: 'feedback' }, at('/projects/p1/documents/proto_3'))).toBeUndefined()
  })

  it.each([
    ['/projects/p1/documents', 'documents'],
    ['/projects/p1/documents/prd_1/v/2/focus', 'documents'],
    ['/projects/p1/decisions', 'decisions'],
    ['/projects/p1', 'overview'],
  ])('names the tab of %s from its path', (pathname, tab) => {
    expect(pageContextFromLocation({ pathname, search: '' })).toMatchObject({ kind: 'project', projectId: 'p1', tab })
  })

  it('drops over-long ids', () => {
    expect(pageContextFromLocation({ pathname: `/projects/${'x'.repeat(200)}`, search: '' })).not.toHaveProperty('projectId')
  })

  it.each([
    ['/categories', '?category=delivery&review=fb_9', { kind: 'categories', path: '/categories', filters: { category: 'delivery' }, feedbackId: 'fb_9' }],
    ['/projects/p1/decisions', '?review=fb_9', { kind: 'project', path: '/projects/p1/decisions', projectId: 'p1', tab: 'decisions', feedbackId: 'fb_9' }],
    // A Radar review is not one of ours: no feedbackId for the assistant to look up.
    ['/radar', '?review=acme-r01&reviewBrand=acme', { kind: 'radar', path: '/radar' }],
  ])('an open review modal on %s%s reports the review', (pathname, search, expected) => {
    expect(pageContextFromLocation({ pathname, search })).toStrictEqual(expected)
  })

  // 5.35 (E2E 5.34): on /categories the assistant could not see the open category filter.
  describe('the filters on screen', () => {
    it('reports every Categories filter in the URL', () => {
      const search = '?q=refund&source=trustpilot&sentiment=negative&category=billing,support&subcategory=refunds'
        + '&rating=2&rating_dir=below&urgent=1&channel=web&dims=plan:pro&tag=late'
      expect(pageContextFromLocation({ pathname: '/categories', search }).filters).toStrictEqual({
        q: 'refund', source: 'trustpilot', sentiment: 'negative', category: 'billing,support', subcategory: 'refunds',
        rating: '2', rating_dir: 'below', urgent: '1', channel: 'web', dims: 'plan:pro', tag: 'late',
      })
    })

    it('reports the Problem Analysis filters, and only that page\'s keys', () => {
      const search = '?source=app_store&category=billing&urgent=1&resolved=1&similarity=high&q=ignored&review=fb_1'
      expect(pageContextFromLocation({ pathname: '/problems', search }).filters).toStrictEqual({
        source: 'app_store', category: 'billing', urgent: '1', resolved: '1', similarity: 'high',
      })
    })

    it.each([['/categories', ''], ['/categories', '?q=&category='], ['/dashboard', '?category=billing']])(
      'sends no filters for %s%s (none set, or a page without URL filters)',
      (pathname, search) => {
        expect(pageContextFromLocation({ pathname, search })).not.toHaveProperty('filters')
      },
    )

    it('cuts a value to the contract bound', () => {
      const page = pageContextFromLocation({ pathname: '/categories', search: `?q=${'x'.repeat(MAX_PAGE_FILTER_CHARS + 1)}` })
      expect(page.filters?.q).toBe('x'.repeat(MAX_PAGE_FILTER_CHARS))
    })

    it('keeps an overlong single category as a value nothing matches, so the floor stays', () => {
      const page = pageContextFromLocation({ pathname: '/categories', search: `?category=${'c'.repeat(MAX_FACET_FILTER_CHARS + 1)}` })
      expect(page.filters?.category).toBe(NO_MATCH_FILTER_VALUE)
    })

    it('keeps a long category list whole up to the facet bound', () => {
      const categories = Array.from({ length: 50 }, (_, n) => `cat${n}`).join(',')
      const page = pageContextFromLocation({ pathname: '/categories', search: `?category=${categories}` })
      expect(page.filters?.category).toBe(categories)
    })
  })

  it('has a pattern for every protected route in routes.tsx', () => {
    const layout = routes.find((r) => r.path === '/')
    const childPaths = (layout?.children ?? []).map((c) => (c.index === true ? '' : c.path ?? ''))
    expect(childPaths.length).toBeGreaterThan(10)
    const known = new Set(PAGE_PATTERNS.map((p) => p.route))
    // '*' is the catch-all NotFound route, not a page: the assistant reports it as "other".
    expect(childPaths.filter((p) => p !== '*' && !known.has(p))).toStrictEqual([])
  })
})

describe('usePageContext', () => {
  function renderAt(entry: string, client = new QueryClient()) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <TestRouter initialEntries={[entry]}>{children}</TestRouter>
      </QueryClientProvider>
    )
    return renderHook(() => usePageContext(), { wrapper }).result
  }

  it('titles a project page from the cached project, without fetching', () => {
    const client = new QueryClient()
    client.setQueryData(['project', 'p1'], { project: { name: 'Checkout revamp' }, personas: [], documents: [] })
    const result = renderAt('/projects/p1/documents', client)
    expect(result.current).toStrictEqual({ kind: 'project', path: '/projects/p1/documents', projectId: 'p1', tab: 'documents', title: 'Checkout revamp' })
  })

  it('has no title when the project is not cached', () => {
    const result = renderAt('/projects/p2')
    expect(result.current).toStrictEqual({ kind: 'project', path: '/projects/p2', projectId: 'p2', tab: 'overview' })
  })

  // docs/prototype-builder.md, part 2: the open prototype is the panel's subject ("Editing: …").
  const PROJECT_WITH_DOCS = {
    project: { name: 'Checkout revamp' }, personas: [],
    documents: [
      { document_id: 'proto_3', document_type: 'prototype', title: 'Checkout flow (v3)' },
      { document_id: 'prd_1', document_type: 'prd', title: 'Checkout PRD (v1)' },
    ],
  }
  const cached = () => {
    const client = new QueryClient()
    client.setQueryData(['project', 'p1'], PROJECT_WITH_DOCS)
    return client
  }

  it('names the prototype open on the Documents tab as documentId, titled by it', () => {
    const result = renderAt('/projects/p1/documents/proto_3', cached())
    expect(result.current).toStrictEqual({
      kind: 'project', path: '/projects/p1/documents/proto_3', projectId: 'p1', tab: 'documents', documentId: 'proto_3',
      title: 'Checkout flow (v3)',
    })
  })

  it('cuts a long prototype title to the contract bound', () => {
    const client = new QueryClient()
    client.setQueryData(['project', 'p1'], { ...PROJECT_WITH_DOCS, documents: [{ document_id: 'proto_3', document_type: 'prototype', title: 'x'.repeat(300) }] })
    expect(renderAt('/projects/p1/documents/proto_3', client).current.title).toBe('x'.repeat(120))
  })

  it.each([
    ['another document type open', '/projects/p1/documents/prd_1'],
    ['an id the project does not list', '/projects/p1/documents/gone_1'],
    ['another tab', '/projects/p1/overview'],
    ['no document open', '/projects/p1/documents'],
    ['a document named only by the query (no old `?doc=` link is read)', '/projects/p1?tab=documents&doc=proto_3'],
  ])('sets no documentId with %s', (_case, entry) => {
    const result = renderAt(entry, cached())
    expect(result.current.documentId).toBeUndefined()
    expect(result.current.title).toBe('Checkout revamp')
  })

  it('sets no documentId before the project is cached, nor on another page', () => {
    expect(renderAt('/projects/p1/documents/proto_3').current.documentId).toBeUndefined()
    expect(renderAt('/feedback/proto_3', cached()).current.documentId).toBeUndefined()
  })

  it("titles an agent page with the cached agent's name, not its id", () => {
    const client = new QueryClient()
    client.setQueryData(agentsKeys.detail('ag_1'), { agent_id: 'ag_1', name: 'Weekly churn watch' })
    const result = renderAt('/agents/ag_1', client)
    expect(result.current).toStrictEqual({ kind: 'agent', path: '/agents/ag_1', agentId: 'ag_1', title: 'Weekly churn watch' })
  })
})
