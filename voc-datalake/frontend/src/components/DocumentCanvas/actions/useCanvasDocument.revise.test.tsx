/**
 * The canvas's save of changes accepted from "Revise from comments" (markRevised): a PR/FAQ / PRD save whose text
 * keeps them names the pass (its job id as `revise_job_id`; the server checks it and records a revise, D4); a plain
 * edit, a research / custom document, or a draft the accepted changes left names none. When the server will not
 * record the save as a revise (400 with the code `revise_refused`) nothing is saved: the draft stays, the server's reason is said in an alert, and
 * "Save as my own edit" saves the same text as a plain edit, with the revision check.
 */
import { act, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/errors'
import enProjectDetail from '../../../../public/locales/en/projectDetail.json'
import { keptChanges, NOTHING_PLACED, placeChange } from '../revise/reviseChanges'
import { canvas, custom, mount, prd, project, putStores } from './canvas-document-fixtures'
import type { ProjectDocument } from '../../../api/types'
import type { UpdateDocument } from './canvas-document-fixtures'

// Every PUT here answers its version (or refuses): the project is never read back.
const updateDocument = vi.hoisted(() => vi.fn<UpdateDocument>())
vi.mock('../../../api/projectsApi', () => ({ projectsApi: { updateDocument } }))
const api = { updateDocument }

beforeEach(() => { updateDocument.mockReset() })

/** Each PUT's revise_job_id (projectsApi.updateDocument's 4th argument; "none": absent). */
const reviseJobIds = () => api.updateDocument.mock.calls.map((call) => call[3] ?? 'none')

/** `document` typed on, marked revised (the pass "job-7"), then saved; resolves once the first PUT went out. */
async function saveRevised(document: ProjectDocument) {
  const mounted = mount(document)
  await mounted.user.type(canvas(), '!')
  await mounted.user.click(screen.getByRole('button', { name: 'revised' }))
  await mounted.user.click(screen.getByRole('button', { name: 'save' }))
  await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1))
  return mounted
}

describe('a save holding changes accepted from "Revise from comments" (markRevised)', () => {
  it('names the pass: the PRD\'s PUT carries the pass\'s job id as revise_job_id', async () => {
    putStores(api.updateDocument, prd)
    await saveRevised(prd)
    await waitFor(() => expect(reviseJobIds()).toStrictEqual(['job-7']))
  })

  it('a plain edit, or one after the accepted changes left the draft, names no pass', async () => {
    putStores(api.updateDocument, prd)
    const { user } = mount(prd)
    await user.type(canvas(), '!')
    await user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(screen.getByTestId('last-saved')).toHaveTextContent('prd-2:# PRD!'))
    await user.click(screen.getByRole('button', { name: 'revised' }))
    await user.click(screen.getByRole('button', { name: 'not revised' }))
    await user.type(canvas(), '?')

    await user.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(reviseJobIds()).toStrictEqual(['none', 'none']))
  })

  describe('a proposal of deletions only (an empty `after`: the server holds it when its `before` is gone)', () => {
    const DELETION = { change_id: 'ch_1', thread_ids: ['t1'], before: ' (draft)', after: '', reason: 'Say it plainly' }
    const page: ProjectDocument = { ...prd, content: '# PRD (draft)' }
    const placed = placeChange({ ...NOTHING_PLACED, draft: page.content }, DELETION)
    // As useRevisePass marks the canvas: the pass's job id, kept while the saved text keeps the accepted deletion.
    const deletionPass = { jobId: 'job-del', keeps: (text: string) => placed !== null && keptChanges([DELETION], placed, text).length > 0 }

    /** The page with the deletion accepted into the draft (then `typed`), marked revised, and saved. */
    async function saveAccepted(typed = '') {
      putStores(api.updateDocument, page)
      const { user } = mount(page, project, deletionPass)
      await user.clear(canvas())
      await user.type(canvas(), `# PRD${typed}`)
      await user.click(screen.getByRole('button', { name: 'revised' }))
      await user.click(screen.getByRole('button', { name: 'save' }))
      await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1))
    }

    it('names the pass: the save holding the accepted deletion carries revise_job_id', async () => {
      await saveAccepted()
      expect([reviseJobIds(), api.updateDocument.mock.calls[0]?.[2].content]).toStrictEqual([['job-del'], '# PRD'])
    })

    it('a draft that typed the deleted text back names no pass', async () => {
      await saveAccepted(' (draft)!')
      expect(reviseJobIds()).toStrictEqual(['none'])
    })
  })

  it('never on a research / custom document (only a PR/FAQ / PRD is revised from comments)', async () => {
    putStores(api.updateDocument, custom)
    await saveRevised(custom)
    await waitFor(() => expect(reviseJobIds()).toStrictEqual(['none']))
  })
})

describe('a revise save refused by the server (400, code revise_refused: the text no longer holds a change of the pass)', () => {
  const reason = 'This save does not hold a change from that revision'
  const REFUSED = 'revise_refused'
  const refused = enProjectDetail.canvas.revise.refused
  const banner = () => screen.getByTestId('canvas-revise-refused')
  /** The PRD's revise save refused: the banner is on screen, nothing saved. */
  async function refusedRevise() {
    api.updateDocument.mockRejectedValueOnce(new ApiError(400, reason, REFUSED))
    const mounted = await saveRevised(prd)
    await screen.findByTestId('canvas-revise-refused')
    return mounted
  }

  it('keeps the draft unsaved and says why, as an alert, with "Save as my own edit"', async () => {
    const { onSelectDoc } = await refusedRevise()

    expect([banner().getAttribute('role'), banner().textContent]).toStrictEqual(['alert', `${reason} ${refused.explain}${refused.saveAsOwn}`])
    expect([screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls]).toStrictEqual(['true', []])
    expect(canvas()).toHaveValue('# PRD!')
    expect(within(banner()).getByRole('button', { name: refused.saveAsOwn })).toBeEnabled()
  })

  it('"Save as my own edit" (by keyboard) saves the same text as a plain edit, with the revision check; the banner goes', async () => {
    const { user, onSelectDoc } = await refusedRevise()
    putStores(api.updateDocument, prd)

    within(banner()).getByRole('button', { name: refused.saveAsOwn }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(onSelectDoc).toHaveBeenCalledWith({ ...prd, content: '# PRD!', revision: 1 }))
    expect(reviseJobIds()).toStrictEqual(['job-7', 'none'])
    expect(api.updateDocument.mock.calls[1]?.[2]).toMatchObject({ content: '# PRD!', expected_revision: 2 })
    expect([screen.queryByTestId('canvas-revise-refused'), screen.getByTestId('dirty').textContent]).toStrictEqual([null, 'false'])
  })

  it('without a reason from the server it still says what happened', async () => {
    api.updateDocument.mockRejectedValueOnce(new ApiError(400, undefined, REFUSED))
    await saveRevised(prd)

    expect(await screen.findByTestId('canvas-revise-refused')).toHaveTextContent(`${refused.fallback} ${refused.explain}`)
  })

  it('Discard takes the banner away with the draft', async () => {
    const { user } = await refusedRevise()

    await user.click(screen.getByRole('button', { name: 'discard' }))

    expect(screen.queryByTestId('canvas-revise-refused')).not.toBeInTheDocument()
  })

  it('a revise save\'s other 400 (no revise_refused code) is the save\'s normal error: no banner, the draft unsaved', async () => {
    api.updateDocument.mockRejectedValueOnce(new ApiError(400, 'content too long'))
    await saveRevised(prd)
    await act(() => Promise.resolve())

    expect(reviseJobIds()).toStrictEqual(['job-7'])
    expect([screen.queryByTestId('canvas-revise-refused'), screen.getByTestId('dirty').textContent]).toStrictEqual([null, 'true'])
  })

  it('a 400 for a plain save (no pass named) offers nothing of the kind', async () => {
    api.updateDocument.mockRejectedValueOnce(new ApiError(400, 'content too long'))
    const { user } = mount(prd)
    await user.type(canvas(), '!')
    await user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1))
    await act(() => Promise.resolve())

    expect(screen.queryByTestId('canvas-revise-refused')).not.toBeInTheDocument()
  })
})
