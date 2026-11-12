/**
 * One "Revise from comments" pass: the three outcomes (recommendations: nothing written; a proposal to review; an
 * applied version: the canvas reloads on it); accepting a change puts its exact replacement into the draft, once; an
 * out-of-date change is never applied; Accept all / Reject all; after the canvas's next save the accepted changes'
 * threads are marked addressed by the saved version (a change the save lost is pending again, nothing marked); a draft
 * replaced without a save (Discard, Load the latest) puts accepted changes back to pending; Undo checks the head
 * (asks first when a version was saved since), restores the version the pass read through History's restore route,
 * selects it and takes the pass's "addressed" marks off its threads. Closing a proposal keeps its accepted, unsaved
 * changes for the next save (and a new pass waits for that save); while they are in the draft the canvas's next save
 * is a revise (markRevised).
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryWrapper } from '@test/query-client'
import { ApiError } from '../../../lib/errors'
import { useRevisePass } from './useRevisePass'
import type { ReviseCanvas, RevisePass } from './useRevisePass'
import type { ReviseChange, ReviseFromCommentsResult } from '../../../api/documentReviewSchema'
import type { ProjectDocument } from '../../../api/types'

const api = vi.hoisted(() => ({
  restoreDocumentVersion: vi.fn<(projectId: string, documentId: string, versionId: string, editId: string) => Promise<unknown>>(),
  getDocumentVersions: vi.fn<(projectId: string, documentId: string) => Promise<readonly { version: number; current: boolean }[]>>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: api }))

const BASE = 'Quiet hours are 21:00 to 08:00.\n\nWe message at most once a day.\n'
const QUIET: ReviseChange = { change_id: 'ch_1', thread_ids: ['t1'], before: 'Quiet hours are 21:00 to 08:00', after: 'Quiet hours are 21:00 to 07:00', reason: 'Answers t1' }
const ONCE: ReviseChange = { change_id: 'ch_2', thread_ids: ['t2', 't3'], before: 'at most once a day', after: 'at most once a day per parcel', reason: '' }

function result(outcome: ReviseFromCommentsResult['outcome'], extra: Partial<ReviseFromCommentsResult> = {}): ReviseFromCommentsResult {
  return {
    outcome, base_document_id: 'prd_3', base_version: 3, recommendations: [{ thread_id: 't1', text: 'Say 07:00.' }],
    changes: outcome === 'recommendations' ? [] : [QUIET, ONCE], applied_version: null, addressed_thread_ids: [], dropped: 0, ...extra,
  }
}

const saved = (content: string, version = 4): NonNullable<ReviseCanvas['lastSaved']> => ({
  document: { document_id: `prd_${String(version)}`, document_type: 'prd', title: 'Plan', content, created_at: '', version },
  content,
})

function setup(answer: ReviseFromCommentsResult) {
  const draft = { text: BASE }
  const run = vi.fn(() => Promise.resolve(answer))
  const markAddressed = vi.fn((_documentId: string, _threadIds: readonly string[]) => Promise.resolve())
  const clearAddressed = vi.fn((_documentId: string, _threadIds: readonly string[]) => Promise.resolve())
  const putDraft = vi.fn((next: string) => { draft.text = next })
  const canvas: ReviseCanvas = {
    lastSaved: null, generation: 0, reloadLatest: vi.fn(), selectDoc: vi.fn<(doc: ProjectDocument) => void>(),
    markRevised: vi.fn<(revised: ((content: string) => boolean) | null) => void>(),
  }
  const hook = renderHook((props: { canvas: ReviseCanvas }) => useRevisePass({
    projectId: 'proj_1', run, markAddressed, clearAddressed, draft: () => draft.text, putDraft, canvas: props.canvas,
  }), { initialProps: { canvas }, wrapper: createQueryWrapper() })
  const startPass = async () => { await act(() => hook.result.current.start()) }
  const now = { canvas }
  const moveTo = (next: Partial<ReviseCanvas>) => {
    now.canvas = { ...now.canvas, ...next }
    hook.rerender({ canvas: now.canvas })
  }
  const saveAs = (next: NonNullable<ReviseCanvas['lastSaved']>) => { moveTo({ lastSaved: next }) }
  /** The draft replaced without a save (Discard, Load the latest): the text back to `text`, a new generation. */
  const replaceDraft = (text: string) => {
    draft.text = text
    moveTo({ generation: now.canvas.generation + 1 })
  }
  return { ...hook, draft, run, markAddressed, clearAddressed, putDraft, canvas, startPass, saveAs, replaceDraft }
}

/** A proposal's decisions (null for any other pass). */
const decisionsOf = (pass: RevisePass) => (pass.kind === 'proposal' ? pass.decisions : null)

/** A proposal pass with `changeId` accepted into the draft (not saved yet). */
async function accepted(changeId: string) {
  const pass = setup(result('proposal'))
  await pass.startPass()
  act(() => pass.result.current.accept(changeId))
  return pass
}

/** The save just seen marked nothing, and every accepted change is pending again. */
async function expectPendingAgain({ result: hook, markAddressed }: ReturnType<typeof setup>) {
  await act(() => Promise.resolve())
  expect(markAddressed).not.toHaveBeenCalled()
  expect(decisionsOf(hook.current.pass)).toStrictEqual({})
}

// Braces: a function returned from beforeEach would run as its teardown.
beforeEach(() => {
  api.restoreDocumentVersion.mockReset()
  api.getDocumentVersions.mockReset()
  api.getDocumentVersions.mockResolvedValue([{ version: 4, current: true }, { version: 3, current: false }])
})

describe('the outcomes', () => {
  it('recommendations: shown, nothing put into the draft, the canvas not reloaded', async () => {
    const { result: hook, startPass, putDraft, canvas } = setup(result('recommendations'))

    await startPass()

    expect(hook.current.pass).toMatchObject({ kind: 'recommendations', result: { recommendations: [{ thread_id: 't1' }] } })
    expect(hook.current.passed).toBe(true)
    expect(putDraft).not.toHaveBeenCalled()
    expect(canvas.reloadLatest).not.toHaveBeenCalled()
  })

  it('proposal: every change pending, nothing applied yet', async () => {
    const { result: hook, startPass, putDraft } = setup(result('proposal'))

    await startPass()

    expect(hook.current.pass).toMatchObject({ kind: 'proposal', decisions: {}, marked: null })
    expect(putDraft).not.toHaveBeenCalled()
  })

  it('applied: the canvas reloads on the version the server wrote', async () => {
    const answer = result('applied', { applied_version: { document_id: 'prd_4', version: 4 }, addressed_thread_ids: ['t1'] })
    const { result: hook, startPass, canvas } = setup(answer)

    await startPass()

    expect(hook.current.pass).toStrictEqual({ kind: 'applied', result: answer, undo: 'idle' })
    expect(canvas.reloadLatest).toHaveBeenCalledTimes(1)
  })

  it('an "applied" answer without a version wrote nothing: read as recommendations', async () => {
    const { result: hook, startPass, canvas } = setup(result('applied', { changes: [] }))

    await startPass()

    expect(hook.current.pass.kind).toBe('recommendations')
    expect(canvas.reloadLatest).not.toHaveBeenCalled()
  })

  it('a failure keeps the server\'s reason (no threads to revise from yet)', async () => {
    const { result: hook, run, startPass } = setup(result('proposal'))
    run.mockRejectedValueOnce(new ApiError(400, 'No comments to revise from yet: reply to a comment or resolve it first'))

    await startPass()

    expect(hook.current.pass).toStrictEqual({ kind: 'failed', message: 'No comments to revise from yet: reply to a comment or resolve it first' })
    expect(hook.current.passed).toBe(false)
  })

  it('a failure without a reason of its own says nothing specific (the button says it failed)', async () => {
    const { result: hook, run, startPass } = setup(result('proposal'))
    run.mockRejectedValueOnce(new Error('network down'))

    await startPass()

    expect(hook.current.pass).toStrictEqual({ kind: 'failed', message: null })
  })
})

describe('reviewing a proposal', () => {
  it('accepting a change replaces its exact passage once in the draft', async () => {
    const { result: hook, startPass, putDraft } = setup(result('proposal'))
    await startPass()

    act(() => hook.current.accept('ch_1'))

    expect(putDraft).toHaveBeenCalledExactlyOnceWith('Quiet hours are 21:00 to 07:00.\n\nWe message at most once a day.\n')
    expect(hook.current.pass).toMatchObject({ decisions: { ch_1: 'accepted' } })
  })

  it('never applies an out-of-date change: the passage was edited since', async () => {
    const { result: hook, startPass, putDraft, draft } = setup(result('proposal'))
    await startPass()
    draft.text = 'Quiet hours start at nine.\n'

    act(() => hook.current.accept('ch_1'))

    expect(putDraft).not.toHaveBeenCalled()
    expect(decisionsOf(hook.current.pass)).toStrictEqual({})
  })

  it('Accept all applies every pending change in one draft; an out-of-date one stays pending', async () => {
    const { result: hook, startPass, putDraft, draft } = setup(result('proposal'))
    await startPass()
    draft.text = 'Quiet hours start at nine.\n\nWe message at most once a day.\n'

    act(() => hook.current.acceptAll())

    expect(putDraft).toHaveBeenCalledExactlyOnceWith('Quiet hours start at nine.\n\nWe message at most once a day per parcel.\n')
    expect(hook.current.pass).toMatchObject({ decisions: { ch_2: 'accepted' } })
  })

  it('Reject all turns down every pending change, and a rejected one is not accepted later', async () => {
    const { result: hook, startPass, putDraft } = setup(result('proposal'))
    await startPass()

    act(() => hook.current.rejectAll())
    act(() => hook.current.accept('ch_1'))

    expect(hook.current.pass).toMatchObject({ decisions: { ch_1: 'rejected', ch_2: 'rejected' } })
    expect(putDraft).not.toHaveBeenCalled()
  })
})

describe('after the save', () => {
  it('marks the accepted changes\' threads addressed by the saved version, not the rejected one\'s', async () => {
    const { result: hook, startPass, saveAs, markAddressed, draft } = setup(result('proposal'))
    await startPass()
    act(() => hook.current.accept('ch_2'))
    act(() => hook.current.reject('ch_1'))

    saveAs(saved(draft.text, 4))

    await waitFor(() => expect(markAddressed).toHaveBeenCalledExactlyOnceWith('prd_4', ['t2', 't3']))
    await waitFor(() => expect(hook.current.pass).toMatchObject({
      decisions: { ch_1: 'rejected', ch_2: 'addressed' }, marked: { count: 2, version: 4 },
    }))
  })

  it('marks nothing for a save made before any change was accepted', async () => {
    const { startPass, saveAs, markAddressed } = setup(result('proposal'))
    await startPass()

    saveAs(saved(BASE, 4))

    await act(() => Promise.resolve())
    expect(markAddressed).not.toHaveBeenCalled()
  })

  it('a change the save no longer holds (discarded first) is pending again and marks nothing', async () => {
    const pass = await accepted('ch_1')

    pass.saveAs(saved('Something else entirely.\n', 5))

    await expectPendingAgain(pass)
  })

  it('says when the threads could not be marked', async () => {
    const { result: hook, startPass, saveAs, markAddressed, draft } = setup(result('proposal'))
    markAddressed.mockRejectedValueOnce(new Error('API Error: 500'))
    await startPass()
    act(() => hook.current.accept('ch_1'))

    saveAs(saved(draft.text, 4))

    await waitFor(() => expect(hook.current.pass).toMatchObject({ marked: 'failed' }))
  })

  it('a save that lost the accepted text where it was put (a copy of it elsewhere is not it) marks nothing', async () => {
    const pass = await accepted('ch_2')
    const elsewhere = `${pass.draft.text.replace('at most once a day per parcel', 'whenever it suits us')}\nSomeone said: at most once a day per parcel.\n`

    pass.saveAs(saved(elsewhere, 4))

    await expectPendingAgain(pass)
  })
})

describe('closing the proposal with accepted changes not saved yet', () => {
  it('keeps them: after Close, the next save still marks their threads addressed by the saved version', async () => {
    const pass = await accepted('ch_2')

    act(() => pass.result.current.close())
    expect([pass.result.current.pass.kind, pass.result.current.holdsAccepted]).toStrictEqual(['idle', true])
    pass.saveAs(saved(pass.draft.text, 4))

    await waitFor(() => expect(pass.markAddressed).toHaveBeenCalledExactlyOnceWith('prd_4', ['t2', 't3']))
    expect(pass.result.current.holdsAccepted).toBe(false)
  })

  it('a draft replaced after Close (Discard) drops them: the next save marks nothing', async () => {
    const pass = await accepted('ch_1')
    act(() => pass.result.current.close())

    pass.replaceDraft(BASE)
    pass.saveAs(saved(BASE, 4))

    await act(() => Promise.resolve())
    expect([pass.markAddressed.mock.calls, pass.result.current.holdsAccepted]).toStrictEqual([[], false])
  })

  it('a new pass waits until they are saved (open or closed): starting again runs nothing, then runs after the save', async () => {
    const pass = await accepted('ch_1')

    await pass.startPass()
    expect(pass.result.current.pass).toMatchObject({ kind: 'proposal', decisions: { ch_1: 'accepted' } })
    act(() => pass.result.current.close())
    await pass.startPass()
    expect([pass.run.mock.calls.length, pass.result.current.pass.kind]).toStrictEqual([1, 'idle'])

    pass.saveAs(saved(pass.draft.text, 4))
    await waitFor(() => expect(pass.markAddressed).toHaveBeenCalledExactlyOnceWith('prd_4', ['t1']))
    await pass.startPass()

    expect(pass.run).toHaveBeenCalledTimes(2)
  })
})

describe('the canvas\'s next save is a revise while its text keeps an accepted change (markRevised)', () => {
  /** What the canvas would record a save of `content` as, now: a revise (true) or a plain edit (false). */
  const revisesNow = (pass: Awaited<ReturnType<typeof accepted>>, content: string) =>
    vi.mocked(pass.canvas.markRevised).mock.lastCall?.[0]?.(content) ?? false

  it('on from the first accepted change, through Close, off once the save settled them', async () => {
    const pass = await accepted('ch_1')
    expect(revisesNow(pass, pass.draft.text)).toBe(true)

    act(() => pass.result.current.close())
    expect(revisesNow(pass, pass.draft.text)).toBe(true)
    pass.saveAs(saved(pass.draft.text, 4))

    await waitFor(() => expect(revisesNow(pass, pass.draft.text)).toBe(false))
  })

  it('off for a text the accepted change was removed from by hand', async () => {
    const pass = await accepted('ch_1')

    expect(revisesNow(pass, BASE)).toBe(false)
  })

  it('off when the draft is replaced without a save (Discard): the accepted change is pending again', async () => {
    const pass = await accepted('ch_1')
    const text = pass.draft.text

    pass.replaceDraft(BASE)

    expect(revisesNow(pass, text)).toBe(false)
  })

  it('off before any change is accepted', async () => {
    const pass = setup(result('proposal'))
    await pass.startPass()

    expect(vi.mocked(pass.canvas.markRevised).mock.calls.every(([revised]) => revised === null)).toBe(true)
  })
})

describe('the draft replaced without a save', () => {
  it('Discard puts an accepted change back to pending, and it can be accepted again', async () => {
    const { result: hook, startPass, putDraft, replaceDraft } = setup(result('proposal'))
    await startPass()
    act(() => hook.current.accept('ch_1'))
    act(() => hook.current.reject('ch_2'))

    replaceDraft(BASE)

    expect(decisionsOf(hook.current.pass)).toStrictEqual({ ch_2: 'rejected' })
    act(() => hook.current.accept('ch_1'))
    expect(putDraft).toHaveBeenCalledTimes(2)
    expect(hook.current.pass).toMatchObject({ decisions: { ch_1: 'accepted' } })
  })

  it('Load the latest after a 409 (no save landed) puts the accepted change back to pending', async () => {
    const { result: hook, startPass, replaceDraft, markAddressed } = setup(result('proposal'))
    await startPass()
    act(() => hook.current.accept('ch_2'))

    replaceDraft(`${BASE}\nA teammate's paragraph.\n`)

    expect(decisionsOf(hook.current.pass)).toStrictEqual({})
    expect(markAddressed).not.toHaveBeenCalled()
  })

  it('keeps what a save already settled: an addressed change stays addressed', async () => {
    const { result: hook, startPass, saveAs, replaceDraft, draft } = setup(result('proposal'))
    await startPass()
    act(() => hook.current.accept('ch_2'))
    saveAs(saved(draft.text, 4))
    await waitFor(() => expect(hook.current.pass).toMatchObject({ decisions: { ch_2: 'addressed' } }))

    replaceDraft(draft.text)

    expect(hook.current.pass).toMatchObject({ decisions: { ch_2: 'addressed' } })
  })
})

describe('undoing an applied revision', () => {
  const applied = result('applied', { applied_version: { document_id: 'prd_4', version: 4 }, addressed_thread_ids: ['t1'] })

  const restored: ProjectDocument = { document_id: 'prd_5', document_type: 'prd', title: 'Plan', content: BASE, created_at: '', version: 5 }

  it('restores the version the pass read (History\'s restore route, a fresh edit id) and selects it', async () => {
    api.restoreDocumentVersion.mockResolvedValue(restored)
    const { result: hook, startPass, canvas } = setup(applied)
    await startPass()

    await act(() => hook.current.undo())

    expect(api.getDocumentVersions).toHaveBeenCalledExactlyOnceWith('proj_1', 'prd_4')
    expect(api.restoreDocumentVersion).toHaveBeenCalledExactlyOnceWith('proj_1', 'prd_4', 'prd_3', expect.any(String))
    expect(canvas.selectDoc).toHaveBeenCalledExactlyOnceWith(restored)
    expect(hook.current.pass).toMatchObject({ kind: 'applied', undo: 'done' })
  })

  it('takes the "addressed" marks off the pass\'s threads once restored (Revise from comments may take them again)', async () => {
    api.restoreDocumentVersion.mockResolvedValue(restored)
    const { result: hook, startPass, clearAddressed } = setup(applied)
    await startPass()

    await act(() => hook.current.undo())

    expect(clearAddressed).toHaveBeenCalledExactlyOnceWith('prd_5', ['t1'])
  })

  it('a failed clear leaves the restore done (the threads stay marked, as they were)', async () => {
    api.restoreDocumentVersion.mockResolvedValue(restored)
    const { result: hook, startPass, clearAddressed } = setup(applied)
    clearAddressed.mockRejectedValueOnce(new Error('API Error: 500'))
    await startPass()

    await act(() => hook.current.undo())

    expect(hook.current.pass).toMatchObject({ undo: 'done' })
  })

  it('asks first when a version was saved after the revision: nothing restored until "Undo anyway"', async () => {
    api.getDocumentVersions.mockResolvedValue([{ version: 5, current: true }, { version: 4, current: false }])
    api.restoreDocumentVersion.mockResolvedValue({ ...restored, document_id: 'prd_6', version: 6 })
    const { result: hook, startPass, clearAddressed } = setup(applied)
    await startPass()

    await act(() => hook.current.undo())

    expect(hook.current.pass).toMatchObject({ kind: 'applied', undo: 'confirm', newer: 5 })
    expect(api.restoreDocumentVersion).not.toHaveBeenCalled()

    await act(() => hook.current.undoAnyway())

    expect(api.restoreDocumentVersion).toHaveBeenCalledExactlyOnceWith('proj_1', 'prd_4', 'prd_3', expect.any(String))
    expect({ checks: api.getDocumentVersions.mock.calls.length, cleared: clearAddressed.mock.calls, pass: hook.current.pass })
      .toMatchObject({ checks: 1, cleared: [['prd_6', ['t1']]], pass: { undo: 'done' } })
  })

  it('"Keep it" leaves the revision as it is: nothing restored, Undo offered again', async () => {
    api.getDocumentVersions.mockResolvedValue([{ version: 5, current: true }])
    const { result: hook, startPass } = setup(applied)
    await startPass()
    await act(() => hook.current.undo())

    act(() => hook.current.keepRevision())

    expect(hook.current.pass).toMatchObject({ kind: 'applied', undo: 'idle' })
    expect(api.restoreDocumentVersion).not.toHaveBeenCalled()
  })

  /** The applied pass, then its Undo; says it failed. */
  async function failedUndo() {
    const pass = setup(applied)
    await pass.startPass()
    await act(() => pass.result.current.undo())
    expect(pass.result.current.pass).toMatchObject({ undo: 'failed' })
    return pass
  }

  it('says it failed when the head cannot be read, and restores nothing', async () => {
    api.getDocumentVersions.mockRejectedValue(new Error('API Error: 500'))

    await failedUndo()

    expect(api.restoreDocumentVersion).not.toHaveBeenCalled()
  })

  it('says when the restore failed, and selects nothing', async () => {
    api.restoreDocumentVersion.mockRejectedValue(new Error('API Error: 500'))

    const { canvas } = await failedUndo()

    expect(canvas.selectDoc).not.toHaveBeenCalled()
  })

  it('Close leaves the pass, and the rail still offers the personas\' second look', async () => {
    const { result: hook, startPass } = setup(applied)
    await startPass()

    act(() => hook.current.close())

    expect([hook.current.pass.kind, hook.current.passed]).toStrictEqual(['idle', true])
  })
})
