/**
 * @fileoverview Test support for the builder's tabs and editors: renders a node inside a real draft (`useFormDraft`)
 * of a form, with the builder's UI context (its `go`, `openImprove` and `leave` spies), React Query and a router.
 *
 * `probe.current` is the draft as of the last render, so a spec reads what an editor wrote
 * (`harness.probe.current?.form`).
 *
 * @module pages/FeedbackForms/test/draftHarness
 */
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import type { FormV2, LoadedForm, StoredFormMeta } from '../model/formsV2'
import type { FormDraft } from '../builder/formDraftContext'
import type { BuilderUi } from '../builder/builderUi'
import type { NewFormHandoff } from '../builder/newFormHandoff'
import { blankForm } from './blankForm'
import DraftProvider from './DraftProvider'
import { testTokenKey } from '../tabs/testToken'

export const STORED_META: StoredFormMeta = {
  form_id: 'f_test', revision: 3, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-10T10:00:00Z', updated_by: 'ana',
  has_responses: false, response_count: 0, can_delete_test_responses: true, migrated_from_v1: false,
  language_unconfirmed: false,
}

/** A form in English with one long open question and one ending, both written. */
export function sampleForm(overrides: Partial<FormV2> = {}): FormV2 {
  return {
    ...blankForm('en'),
    name: 'Sample form',
    questions: [{ id: 'q_feedback', type: 'open_text', headline: { en: 'What would you like to tell us?' }, required: true, long: true, input_type: 'text' }],
    endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }],
    ...overrides,
  }
}

interface Probe {
  current: FormDraft | null
}

export interface DraftHarnessOptions {
  /** Overrides of the stored form's meta (a stored form is the default). */
  readonly meta?: Partial<StoredFormMeta>
  /** An unsaved new form instead of a stored one (with `handoff`'s template or AI origin). */
  readonly isNew?: boolean
  readonly handoff?: Partial<Omit<NewFormHandoff, 'form'>>
  /** The path segments after the tab. */
  readonly rest?: readonly string[]
  /** The test token `POST …/test-link` answered for the stored form (default `tk_test`; null: none read yet). */
  readonly testToken?: string | null
}

export interface DraftHarness {
  readonly probe: Probe
  readonly go: ReturnType<typeof vi.fn<BuilderUi['go']>>
  readonly openImprove: ReturnType<typeof vi.fn<() => void>>
  readonly onCreated: ReturnType<typeof vi.fn<(formId: string) => void>>
  readonly leave: ReturnType<typeof vi.fn<BuilderUi['leave']>>
}

/** Render `node` inside a draft of `form` (default: `sampleForm()`). */
export function renderWithDraft(node: ReactNode, form: FormV2 = sampleForm(), options: DraftHarnessOptions = {}): DraftHarness & ReturnType<typeof render> {
  const go = vi.fn<BuilderUi['go']>()
  const openImprove = vi.fn<() => void>()
  const onCreated = vi.fn<(formId: string) => void>()
  const leave = vi.fn<BuilderUi['leave']>()
  const isNew = options.isNew === true
  const ui: BuilderUi = { formId: isNew ? null : STORED_META.form_id, rest: options.rest ?? [], go, openImprove, leave }
  const loaded: LoadedForm | null = isNew ? null : { form, meta: { ...STORED_META, ...options.meta } }
  const handoff: NewFormHandoff | null = isNew ? { form, templateId: null, ai: null, ...options.handoff } : null
  const probe: Probe = { current: null }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const token = options.testToken === undefined ? 'tk_test' : options.testToken
  if (!isNew && token !== null) queryClient.setQueryData(testTokenKey(STORED_META.form_id), token)
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DraftProvider loaded={loaded} handoff={handoff} ui={ui} onCreated={onCreated} onDraft={(draft) => { probe.current = draft }}>
          {node}
        </DraftProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...rendered, probe, go, openImprove, onCreated, leave }
}
