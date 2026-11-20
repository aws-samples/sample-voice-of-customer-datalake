/**
 * What the picker's two ways do (UX §2.1, §12.1): "Use this template" opens the builder with the template as an unsaved
 * new form, and while the AI drafts it asks first, then stops the draft. "Draft it" opens the builder only with a
 * draft: a stopped draft (ai/StopDraftButton.tsx) answers null, and nothing opens.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, renderHook, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AiDraftRequest } from '../ai/useAiDraftRequest'
import type { TemplateFlow } from '../templates/templateKit'
import { templateById } from '../formTemplates'
import { BuilderStandIn } from '../test/pickerRoutes'
import { sampleForm } from '../test/draftHarness'
import { defined } from '../../../test/defined'
import { createQueryWrapper } from '../../../test/query-client'
import type { CreateInCopy } from './useCreateInCopy'
import { usePickerActions } from './usePickerActions'

const OLD_UI = defined(templateById('old_ui'), 'old_ui')

/** The picker's route, and the builder's where `use` and `draft` go. */
function PickerRoutes({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <MemoryRouter initialEntries={['/feedback-forms/new']}>
      <Routes>
        <Route path="/feedback-forms/new" element={children} />
        <Route path="/feedback-forms/new/questions" element={<BuilderStandIn />} />
      </Routes>
    </MemoryRouter>
  )
}

function renderActions({ flow = OLD_UI, ready = true, busy = false }: Readonly<{ flow?: TemplateFlow | null; ready?: boolean; busy?: boolean }> = {}) {
  const request = {
    busy, refusal: null, waitMinutes: 0,
    run: vi.fn<AiDraftRequest['run']>().mockResolvedValue(null), cancel: vi.fn<() => void>(), clear: vi.fn<() => void>(),
  }
  const copy: CreateInCopy = { ready, lookup: (key) => key, formOf: (picked) => sampleForm({ name: `Form of ${picked.id}` }) }
  // (a query client too: the form brand a new form starts on is read through it)
  const Queries = createQueryWrapper()
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => <Queries><PickerRoutes>{children}</PickerRoutes></Queries>
  const { result } = renderHook(() => usePickerActions({ flow, copy, language: 'pl', request }), { wrapper })
  return { result, request }
}

/** What the stand-in builder was handed, or null while the picker is still open. */
const handoff = () => screen.queryByTestId('handoff')?.textContent ?? null

describe('usePickerActions: Use this template', () => {
  it('opens the builder with the template at once while nothing is drafting', () => {
    const { result } = renderActions()
    act(() => result.current.use())
    expect(handoff()).toContain('"templateId":"old_ui"')
    expect(handoff()).toContain('"name":"Form of old_ui"')
  })

  it('asks first while the AI drafts, and opens nothing until asked to stop the draft', () => {
    const { result, request } = renderActions({ busy: true })
    act(() => result.current.use())
    expect(result.current.stopDraft).toBe(true)
    expect(request.cancel).not.toHaveBeenCalled()
    expect(handoff()).toBeNull()
  })

  it('stops the draft and opens the template once the stop is confirmed', () => {
    const { result, request } = renderActions({ busy: true })
    act(() => result.current.use())
    act(() => result.current.confirmStop())
    expect(request.cancel).toHaveBeenCalledTimes(1)
    expect(result.current.stopDraft).toBe(false)
    expect(handoff()).toContain('"templateId":"old_ui"')
  })

  it('keeps drafting, and stays on the picker, when the stop is cancelled', () => {
    const { result, request } = renderActions({ busy: true })
    act(() => result.current.use())
    act(() => result.current.cancelStop())
    expect(result.current.stopDraft).toBe(false)
    expect(request.cancel).not.toHaveBeenCalled()
    expect(handoff()).toBeNull()
  })

  it('does nothing without a template, or before the "Create in" language is loaded', () => {
    const none = renderActions({ flow: null })
    act(() => none.result.current.use())
    const loading = renderActions({ ready: false })
    act(() => loading.result.current.use())
    expect(handoff()).toBeNull()
  })
})

describe('usePickerActions: Draft it', () => {
  it('asks the AI in the "Create in" language, and stays on the picker when no draft came back', async () => {
    const { result, request } = renderActions()
    const answer = Promise.resolve(null)
    request.run.mockReturnValue(answer)
    act(() => result.current.draft({ description: 'Ask why they cancel', channel: 'in_app' }))
    await act(() => answer)
    expect(request.run).toHaveBeenCalledWith({ description: 'Ask why they cancel', language: 'pl', channel: 'in_app' })
    expect(handoff()).toBeNull()
  })

  it('opens the builder with the draft, not a template, and what the AI said about it', async () => {
    const { result, request } = renderActions()
    request.run.mockResolvedValue({ form: sampleForm({ name: 'Drafted' }), notes: [{ message: 'Reasons are shuffled.' }], warnings: [] })
    act(() => result.current.draft({ description: 'Ask why they cancel', channel: 'link' }))
    const handed = await screen.findByTestId('handoff')
    expect(handed.textContent).toContain('"templateId":null')
    expect(handed.textContent).toContain('"notes":[{"message":"Reasons are shuffled."}]')
  })
})
