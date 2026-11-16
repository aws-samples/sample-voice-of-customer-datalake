/**
 * A document card's menu in the documents list (DocumentCard, DocumentCardMenu): it opens on a right-click (at the
 * pointer, kept inside the viewport), on the ContextMenu key or Shift+F10 and on the card's "⋯"; it is a WAI-ARIA
 * menu (arrows, Home / End, Escape back to what opened it, Tab out, a press outside or a scroll closes it); an editor
 * gets Open, Rename (by kind) and Delete, a viewer Open only; Rename edits the card's title in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentList from './DocumentList'
import { makeDocument } from './project-detail-fixtures'
import { ApiError } from '../../lib/errors'
import { defined } from '@test/defined'
import en from '../../../public/locales/en/projectDetail.json'
import type { DocumentCardActions } from './DocumentCard'
import type { ProjectDocument } from '../../api/types'

const NOTES = makeDocument({ document_id: 'notes', document_type: 'research', title: 'Interview notes', created_at: '2026-05-01T00:00:00Z' })
const PRD = makeDocument({ document_id: 'prd-1', document_type: 'prd', title: 'Launch (v1)', version: 1, created_at: '2026-01-01T00:00:00Z' })
const PLAN = makeDocument({ document_id: 'plan', document_type: 'custom', title: 'Plan', created_at: '2026-04-01T00:00:00Z' })
const DOCUMENTS: ProjectDocument[] = [NOTES, PRD, PLAN]

const card = en.documents.card

function editorActions(overrides: Partial<DocumentCardActions> = {}) {
  return {
    rename: vi.fn<DocumentCardActions['rename']>(() => Promise.resolve()),
    remove: vi.fn<DocumentCardActions['remove']>(),
    deleting: false,
    ...overrides,
  }
}

function renderList(cardActions?: DocumentCardActions) {
  const onSelectDoc = vi.fn<(doc: ProjectDocument) => void>()
  const user = userEvent.setup()
  render(<DocumentList documents={DOCUMENTS} selectedDoc={null} onSelectDoc={onSelectDoc} cardActions={cardActions} />)
  return { onSelectDoc, user }
}

/** The card (the button that selects the document) titled `title`. */
const cardOf = (title: string) => screen.getByRole('button', { name: new RegExp(`${title}$`) })
const menuOf = (title: string) => screen.getByRole('menu', { name: `Actions for “${title}”` })
const itemNames = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.textContent)
/** The "⋯" of the card titled `title` (beside the card, in its wrapper). */
const moreButtonOf = (title: string) =>
  within(defined(cardOf(title).parentElement ?? undefined, `the ${title} card's wrapper`)).getByRole('button', { name: card.more })

afterEach(() => { vi.restoreAllMocks() })

describe('DocumentCard menu: opening', () => {
  it('opens on a right-click, at the pointer, instead of the browser\'s menu, with focus on its first item', () => {
    renderList(editorActions())
    const notPrevented = fireEvent.contextMenu(cardOf('Interview notes'), { clientX: 120, clientY: 80 })
    const menu = menuOf('Interview notes')
    expect(notPrevented).toBe(false)
    expect([menu.style.left, menu.style.top]).toStrictEqual(['120px', '84px'])
    expect(within(menu).getByRole('menuitem', { name: card.open })).toHaveFocus()
  })

  it('keeps a right-click\'s menu inside the viewport, above the pointer when there is no room below', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
      const size = this.getAttribute('role') === 'menu' ? { width: 180, height: 120 } : { width: 0, height: 0 }
      return DOMRect.fromRect(size)
    })
    renderList(editorActions())
    fireEvent.contextMenu(cardOf('Interview notes'), { clientX: window.innerWidth - 4, clientY: window.innerHeight - 20 })
    const menu = menuOf('Interview notes')
    expect([menu.style.left, menu.style.top])
      .toStrictEqual([`${String(window.innerWidth - 8 - 180)}px`, `${String(window.innerHeight - 20 - 4 - 120)}px`])
  })

  it.each([
    ['Shift+F10', '{Shift>}{F10}{/Shift}'],
    ['the ContextMenu key', '{ContextMenu}'],
  ])('opens from the keyboard on a focused card: %s', async (_name, keys) => {
    const { user } = renderList(editorActions())
    cardOf('Plan').focus()
    await user.keyboard(keys)
    expect(within(menuOf('Plan')).getByRole('menuitem', { name: card.open })).toHaveFocus()
  })

  it('ignores the key\'s own contextmenu event once the key has opened the menu', async () => {
    const { user } = renderList(editorActions())
    cardOf('Plan').focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const opened = menuOf('Plan')
    expect(fireEvent.contextMenu(cardOf('Plan'), { clientX: 0, clientY: 0 })).toBe(false)
    expect(menuOf('Plan')).toBe(opened)
    expect(within(opened).getByRole('menuitem', { name: card.open })).toHaveFocus()
  })

  it('opens from the card\'s "⋯", a menu button described by the card\'s title; a second press closes it', async () => {
    const { user } = renderList(editorActions())
    const more = moreButtonOf('Plan')
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    expect(more).toHaveAccessibleDescription('Plan')

    await user.click(more)
    expect([more.getAttribute('aria-expanded'), more.getAttribute('aria-controls')]).toStrictEqual(['true', menuOf('Plan').id])
    await user.click(more)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens from the "⋯" on its last item with ArrowUp', async () => {
    const { user } = renderList(editorActions())
    moreButtonOf('Plan').focus()
    await user.keyboard('{ArrowUp}')
    expect(within(menuOf('Plan')).getByRole('menuitem', { name: en.documents.deleteDocument })).toHaveFocus()
  })
})

describe('DocumentCard menu: items', () => {
  it('gives an editor Open, Rename and Delete on a document renamed by its writers', () => {
    renderList(editorActions())
    fireEvent.contextMenu(cardOf('Interview notes'))
    expect(itemNames(menuOf('Interview notes'))).toStrictEqual([card.open, en.canvas.menu.rename, en.documents.deleteDocument])
  })

  it('leaves Rename out of a PRD\'s menu, whose title is its series\'', () => {
    renderList(editorActions())
    fireEvent.contextMenu(cardOf('Launch \\(v1\\)'))
    expect(itemNames(menuOf('Launch (v1)'))).toStrictEqual([card.open, en.documents.deleteDocument])
  })

  it('gives a viewer Open only, and no "⋯"', () => {
    renderList()
    fireEvent.contextMenu(cardOf('Interview notes'))
    expect(itemNames(menuOf('Interview notes'))).toStrictEqual([card.open])
    expect(screen.queryByRole('button', { name: card.more })).not.toBeInTheDocument()
  })

  it('keeps Delete in the menu, inert, while a delete is on its way', async () => {
    const actions = editorActions({ deleting: true })
    const { user } = renderList(actions)
    fireEvent.contextMenu(cardOf('Plan'))
    const remove = within(menuOf('Plan')).getByRole('menuitem', { name: en.documents.deleteDocument })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    await user.click(remove)
    expect(actions.remove).not.toHaveBeenCalled()
  })

  it('Open selects the document, as a click does, and puts focus back on its card', async () => {
    const { user, onSelectDoc } = renderList(editorActions())
    fireEvent.contextMenu(cardOf('Plan'))
    await user.click(within(menuOf('Plan')).getByRole('menuitem', { name: card.open }))
    expect(onSelectDoc).toHaveBeenCalledWith(PLAN)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(cardOf('Plan')).toHaveFocus()
  })

  it('Delete asks the page to delete the document (its confirmation, then the delete)', async () => {
    const actions = editorActions()
    const { user } = renderList(actions)
    fireEvent.contextMenu(cardOf('Plan'))
    await user.click(within(menuOf('Plan')).getByRole('menuitem', { name: en.documents.deleteDocument }))
    expect(actions.remove).toHaveBeenCalledWith(PLAN)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('DocumentCard menu: keyboard and closing', () => {
  async function openedOnPlan() {
    const rendered = renderList(editorActions())
    cardOf('Plan').focus()
    await rendered.user.keyboard('{Shift>}{F10}{/Shift}')
    return rendered
  }

  it('moves with the arrows (wrapping), Home and End', async () => {
    const { user } = await openedOnPlan()
    const focused: (string | null)[] = []
    for (const key of ['{ArrowDown}', '{End}', '{ArrowDown}', '{ArrowUp}', '{Home}']) {
      await user.keyboard(key)
      focused.push(document.activeElement?.textContent ?? null)
    }
    expect(focused).toStrictEqual([
      en.canvas.menu.rename, en.documents.deleteDocument, card.open, en.documents.deleteDocument, card.open,
    ])
  })

  it('closes on Escape, with focus back on the card', async () => {
    const { user } = await openedOnPlan()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(cardOf('Plan')).toHaveFocus()
  })

  it('closes on Escape with focus back on the "⋯" it was opened from', async () => {
    const { user } = renderList(editorActions())
    const more = moreButtonOf('Plan')
    await user.click(more)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
  })

  it('closes on Tab, moving on from the card (to its "⋯")', async () => {
    const { user } = await openedOnPlan()
    await user.tab()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(moreButtonOf('Plan')).toHaveFocus()
  })

  it('closes on a press outside it, and on a scroll', async () => {
    const { user } = await openedOnPlan()
    await user.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(cardOf('Plan'))
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('puts the "⋯" after each card in an editor\'s reading order', async () => {
    const { user } = renderList(editorActions())
    cardOf('Plan').focus()
    await user.tab()
    expect(moreButtonOf('Plan')).toHaveFocus()
  })
})

describe('DocumentCard Rename', () => {
  async function renaming(actions = editorActions()) {
    const rendered = renderList(actions)
    fireEvent.contextMenu(cardOf('Plan'))
    await rendered.user.click(within(menuOf('Plan')).getByRole('menuitem', { name: en.canvas.menu.rename }))
    const field = screen.getByRole('textbox', { name: en.canvas.page.titleLabel })
    return { ...rendered, actions, field }
  }

  it('edits the card\'s title in place, its text selected', async () => {
    const { field } = await renaming()
    expect(field).toHaveFocus()
    expect(field).toMatchObject({ value: 'Plan', selectionStart: 0, selectionEnd: 4 })
  })

  it('saves on Enter (trimmed), shows the new name at once and puts focus back on the card', async () => {
    const { user, actions } = await renaming()
    await user.keyboard('  Launch plan {Enter}')
    expect(actions.rename).toHaveBeenCalledWith(PLAN, 'Launch plan')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cardOf('Launch plan')).toHaveFocus()
  })

  it('cancels on Escape: nothing is saved, the name stays, focus is back on the card', async () => {
    const { user, actions } = await renaming()
    await user.keyboard('Something else{Escape}')
    expect(actions.rename).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cardOf('Plan')).toHaveFocus()
  })

  it('refuses an empty name on Enter, saying why, and saves nothing for the same name', async () => {
    const { user, actions, field } = await renaming()
    await user.clear(field)
    await user.type(field, '   {Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent(en.canvas.page.titleRequired)
    expect(field).toHaveAttribute('aria-invalid', 'true')

    await user.clear(field)
    await user.type(field, 'Plan{Enter}')
    expect(actions.rename).not.toHaveBeenCalled()
    expect(cardOf('Plan')).toHaveFocus()
  })

  it('saves when the field is left, as the page title does', async () => {
    const { user, actions, field } = await renaming()
    await user.clear(field)
    await user.type(field, 'Roadmap')
    await user.click(document.body)
    expect(actions.rename).toHaveBeenCalledWith(PLAN, 'Roadmap')
  })

  it.each([
    ['a failure', new Error('offline'), card.renameFailed],
    ['a 409 (the document changed meanwhile)', new ApiError(409, 'stale'), card.renameConflict],
  ])('puts the old name back on %s and says why under the card', async (_name, error, said) => {
    const { user } = await renaming(editorActions({ rename: vi.fn(() => Promise.reject(error)) }))
    await user.keyboard('Roadmap{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(said)
    await waitFor(() => expect(cardOf('Plan')).toBeInTheDocument())
  })
})
