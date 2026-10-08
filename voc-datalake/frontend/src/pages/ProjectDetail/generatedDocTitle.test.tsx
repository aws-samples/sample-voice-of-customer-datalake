/**
 * QA s3 Low: a PRD and a PR/FAQ generated together from one wizard title both came
 * back titled "Title (v1)". The request titles are now distinct by type when more
 * than one type is generated at once, and unchanged for a single type.
 *
 * Production QA (F2): a series is (base title, type). A single PRD 'X' after a dual
 * generation of 'X' (or the reverse) continues the existing PRD series under that
 * series' title instead of starting another one.
 */
import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestQueryClient } from '../../test/query-client'
import { documentSeriesKey, generatedDocTitle, type SeriesDocument } from './generatedDocTitle'
import { useProjectMutations } from './useProjectData'
import { useProjectWizardState } from './useProjectWizardState'

const generateDocument = vi.hoisted(() => vi.fn<(projectId: string, body: { doc_type: string; title: string }) => Promise<unknown>>())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { generateDocument } }))

function wrapper({ children }: { readonly children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

function useWizardWithMutations(documents: readonly SeriesDocument[]) {
  const wizard = useProjectWizardState()
  const mutations = useProjectMutations({
    id: 'proj_1', ...wizard, documents, onSuccess: () => undefined, onError: () => undefined,
  })
  return { wizard, mutations }
}

async function requestedTitles(
  docTypes: Array<'prd' | 'prfaq'>, title: string, documents: readonly SeriesDocument[] = [],
): Promise<Record<string, string>> {
  generateDocument.mockClear()
  const { result } = renderHook(() => useWizardWithMutations(documents), { wrapper })
  act(() => {
    result.current.wizard.setDocConfig((config) => ({ ...config, docTypes, title }))
  })
  await act(async () => {
    await result.current.mutations.docMut.mutateAsync()
  })
  return Object.fromEntries(generateDocument.mock.calls.map(([, body]) => [body.doc_type, body.title]))
}

describe('generated document titles', () => {
  beforeEach(() => {
    generateDocument.mockReset()
    generateDocument.mockResolvedValue({ success: true, job_id: 'job_1', status: 'pending', message: '' })
  })

  it('gives a PRD and a PR/FAQ generated together distinct titles', async () => {
    expect(await requestedTitles(['prd', 'prfaq'], 'Checkout revamp')).toStrictEqual({
      prd: 'Checkout revamp — PRD',
      prfaq: 'Checkout revamp — PR/FAQ',
    })
  })

  it('keeps a single type on the title as typed, so it continues that series', async () => {
    expect(await requestedTitles(['prd'], 'Checkout revamp')).toStrictEqual({ prd: 'Checkout revamp' })
  })

  it('does not repeat a type the title already ends with, and labels a blank title', () => {
    expect(generatedDocTitle('Checkout PRD', 'prd', 2)).toBe('Checkout PRD')
    expect(generatedDocTitle('  ', 'prfaq', 2)).toBe('PR/FAQ')
  })
})

// MIRRORED by SERIES_KEY_CASES in
// lambda/shared/test/test_document_series_identity.py — change both together.
const SERIES_KEY_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['X', 'prd', 'x'],
  ['X — PRD', 'prd', 'x'],
  ['X — PRD (v1)', 'prd', 'x'],
  ['X (v3)', 'prd', 'x'],
  ['x - prd', 'prd', 'x'],
  ['  X   —   PRD  ', 'prd', 'x'],
  ['X — PR/FAQ', 'prfaq', 'x'],
  ['X — PR/FAQ (v2)', 'prfaq', 'x'],
  ['X – PRFAQ', 'prfaq', 'x'],
  ['X — PR/FAQ', 'prd', 'x — pr/faq'],
  ['X — PRD', 'prfaq', 'x — prd'],
  ['X — PRD', 'prototype', 'x — prd'],
  ['X — PRDs', 'prd', 'x — prds'],
  ['Checkout PRD', 'prd', 'checkout prd'],
  ['PRD', 'prd', 'prd'],
  ['PR/FAQ', 'prfaq', 'pr/faq'],
]

describe('document series identity', () => {
  it.each(SERIES_KEY_CASES)('keys %j (%s) as %j', (title, docType, expected) => {
    expect(documentSeriesKey(title, docType)).toBe(expected)
  })

  beforeEach(() => {
    generateDocument.mockReset()
    generateDocument.mockResolvedValue({ success: true, job_id: 'job_1', status: 'pending', message: '' })
  })

  it('continues the PRD series a dual generation started when a single PRD follows', async () => {
    // (a) Dual 'Checkout' first: the backend stored these two series.
    const afterDual: SeriesDocument[] = [
      { document_type: 'prd', title: 'Checkout — PRD (v1)', base_title: 'Checkout — PRD' },
      { document_type: 'prfaq', title: 'Checkout — PR/FAQ (v1)', base_title: 'Checkout — PR/FAQ' },
    ]
    expect(await requestedTitles(['prd'], 'Checkout', afterDual)).toStrictEqual({ prd: 'Checkout — PRD' })
  })

  it('continues a single PRD series and starts the PR/FAQ series when a dual generation follows', async () => {
    // (b) Single PRD 'Checkout' first.
    const afterSingle: SeriesDocument[] = [
      { document_type: 'prd', title: 'Checkout (v1)', base_title: 'Checkout' },
    ]
    expect(await requestedTitles(['prd', 'prfaq'], 'Checkout', afterSingle)).toStrictEqual({
      prd: 'Checkout',
      prfaq: 'Checkout — PR/FAQ',
    })
  })

  it('recognises a legacy type-suffixed title without base_title, and never crosses types', () => {
    const legacy: SeriesDocument[] = [
      { document_type: 'prd', title: 'Checkout — PRD (v1)' },
      { document_type: 'prfaq', title: 'Other (v1)', base_title: 'Other' },
    ]
    expect(generatedDocTitle('checkout', 'prd', 1, legacy)).toBe('Checkout — PRD')
    expect(generatedDocTitle('Other', 'prd', 1, legacy)).toBe('Other')
  })
})
