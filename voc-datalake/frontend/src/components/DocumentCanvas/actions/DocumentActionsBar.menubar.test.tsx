/**
 * The document page's menu bar (menuBar.ts, canvasMenus.ts): Document · Edit · Format · Insert · View on an editable
 * canvas, Document and View for a viewer, and Review (before View) while the AI flows are offered; each entry
 * dispatches the canvas's own action (the editor's commands through its handle, the View switches, Rename, the AI
 * flows with the toolbar's state and reasons); the menus are WAI-ARIA menu buttons and the bar's arrow keys walk
 * them; the toolbar's Comments button toggles the panel and counts the open threads.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import enDocuments from '../../../../public/locales/en/documents.json'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { canvasState } from './canvas-state-fixtures'
import DocumentActionsBar from './DocumentActionsBar'
import type { CanvasCommand } from '../../Document/edit/editor/commands'
import type { CanvasEditorHandle } from '../../Document/edit/editor/CanvasEditor'
import type { CanvasViewControls } from './canvasMenus'
import type { ReviewActions } from './toolbarItems'
import type { ProjectDocument } from '../../../api/types'

vi.mock('../../../api/projectsApi', () => ({ projectsApi: { getDocumentVersions: vi.fn(), restoreDocumentVersion: vi.fn() } }))

const bar = enDocuments.menubar
const project = makeProject({ project_id: 'p1' })
const custom: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'text', created_at: '2026-10-01T00:00:00Z',
}

const run = vi.fn<(command: CanvasCommand) => boolean>(() => true)
const can = vi.fn<(command: CanvasCommand) => boolean>(() => true)
const handle: CanvasEditorHandle = {
  root: () => null, getMarkdown: () => '', setMarkdown: vi.fn(), scrollToHeading: vi.fn(), focus: vi.fn(), clearSelection: vi.fn(),
  run, can,
}

function viewControls(overrides: Partial<CanvasViewControls> = {}): CanvasViewControls {
  return {
    comments: { on: true, toggle: vi.fn() }, outline: { on: true, toggle: vi.fn() }, fullWidth: { on: false, toggle: vi.fn() },
    ...overrides,
  }
}

interface BarOptions {
  readonly editable?: boolean
  readonly canEdit?: boolean
  readonly view?: CanvasViewControls
  readonly openThreads?: number
  readonly titleEditable?: boolean
  readonly review?: ReviewActions | null
}

function renderBar({
  editable = true, canEdit = true, view = viewControls(), openThreads = 2, titleEditable = true, review = null,
}: BarOptions = {}) {
  const focus = { active: false, toggle: vi.fn() }
  const onRename = vi.fn()
  const state = canvasState({ editable, titleEditable, handleRef: { current: handle } })
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DocumentActionsBar project={project} document={custom} canEdit={canEdit} state={state} share={null} threads={null}
        onDeleteDoc={vi.fn()} isDeleting={false} focus={focus} focusButtonRef={createRef()} view={view}
        openThreads={openThreads} onRename={onRename} viewing={null} onChooseVersion={vi.fn()} review={review} />
    </QueryClientProvider>,
  )
  return { focus, onRename, view, user: userEvent.setup() }
}

/** The AI flows as the review view reports them: the project's personas, a rewrite ready to start. */
function reviewActions({ review = {}, rewrite = {} }: {
  review?: Partial<ReviewActions['review']>; rewrite?: Partial<NonNullable<ReviewActions['rewrite']>>
} = {}): ReviewActions {
  return {
    review: { running: false, personas: 'project', again: false, start: vi.fn(), addPersonas: vi.fn(), ...review },
    rewrite: { running: false, reason: null, start: vi.fn(), ...rewrite },
  }
}

const menuButton = (name: string) => screen.getByRole('button', { name })
const menuBar = () => screen.getByRole('group', { name: bar.label })

async function choose(user: ReturnType<typeof userEvent.setup>, menu: string, item: string) {
  await user.click(menuButton(menu))
  await user.click(within(screen.getByRole('menu', { name: menu })).getByRole('menuitem', { name: item }))
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockImplementation(() => true)
  can.mockImplementation(() => true)
})

describe('DocumentActionsBar: the menu bar', () => {
  it('offers Document, Edit, Format, Insert and View on an editable canvas, each a menu button', () => {
    renderBar()
    const buttons = within(menuBar()).getAllByRole('button')
    expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-haspopup')])).toStrictEqual([
      [enDocuments.menu.trigger, 'menu'], [bar.edit, 'menu'], [bar.format, 'menu'], [bar.insert, 'menu'], [bar.view, 'menu'],
    ])
  })

  it('offers a read-only canvas (a viewer) Document and View only', () => {
    renderBar({ editable: false, canEdit: false })
    expect(within(menuBar()).getAllByRole('button').map((button) => button.textContent))
      .toStrictEqual([enDocuments.menu.trigger, bar.view])
  })

  it('runs Edit → Redo on the editor and closes the menu with focus back on Edit; Undo with nothing to undo is inert', async () => {
    can.mockImplementation((command) => command !== 'undo')
    const { user } = renderBar()
    await user.click(menuButton(bar.edit))
    const undo = screen.getByRole('menuitem', { name: bar.undo })
    expect(undo).toHaveAttribute('aria-disabled', 'true')
    await user.click(undo)
    expect(run).not.toHaveBeenCalled()
    await user.click(screen.getByRole('menuitem', { name: bar.redo }))
    expect(run.mock.calls).toStrictEqual([['redo']])
    expect([screen.queryByRole('menu'), document.activeElement === menuButton(bar.edit)]).toStrictEqual([null, true])
  })

  it('shows each Format entry with the shortcut the editor answers, and runs the one chosen', async () => {
    const { user } = renderBar()
    await user.click(menuButton(bar.format))
    const bold = screen.getByRole('menuitem', { name: enDocuments.editor.format.bold })
    expect(bold).toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B')
    expect(bold).toHaveTextContent('Ctrl+B')
    await user.click(screen.getByRole('menuitem', { name: enDocuments.editor.blocks.heading2 }))
    await choose(user, bar.format, enDocuments.editor.blocks.bulletList)
    expect(run.mock.calls).toStrictEqual([['heading2'], ['bulletList']])
  })

  it('inserts a link, an image, a table, a divider and a callout through the editor', async () => {
    const { user } = renderBar()
    const blocks = enDocuments.editor.blocks
    for (const item of [bar.link, bar.image, blocks.table, blocks.divider, blocks.callout]) await choose(user, bar.insert, item)
    expect(run.mock.calls).toStrictEqual([['link'], ['image'], ['table'], ['divider'], ['callout']])
  })

  it('switches the comments panel, the outline, the width and full screen from View, each a checkbox item', async () => {
    const toggles = { comments: vi.fn(), outline: vi.fn(), fullWidth: vi.fn() }
    const { user, focus } = renderBar({
      view: {
        comments: { on: true, toggle: toggles.comments }, outline: { on: true, toggle: toggles.outline },
        fullWidth: { on: true, toggle: toggles.fullWidth },
      },
    })
    await user.click(menuButton(bar.view))
    const checked = screen.getAllByRole('menuitemcheckbox').map((item) => [item.textContent, item.getAttribute('aria-checked')])
    expect(checked).toStrictEqual([
      [bar.comments, 'true'], [enDocuments.page.contents, 'true'], [bar.fullWidth, 'true'],
      [expect.stringContaining(enDocuments.focus.button), 'false'],
    ])
    await user.click(screen.getByRole('menuitemcheckbox', { name: bar.comments }))
    for (const name of [enDocuments.page.contents, bar.fullWidth, enDocuments.focus.button]) {
      await user.click(menuButton(bar.view))
      await user.click(screen.getByRole('menuitemcheckbox', { name }))
    }
    expect([toggles.comments, toggles.outline, toggles.fullWidth, focus.toggle].map((spy) => spy.mock.calls.length))
      .toStrictEqual([1, 1, 1, 1])
  })

  it('offers no Comments in View for a document without a comments panel, and no comments button', async () => {
    const { user } = renderBar({ view: viewControls({ comments: undefined }) })
    expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument()
    await user.click(menuButton(bar.view))
    expect(screen.queryByRole('menuitemcheckbox', { name: bar.comments })).not.toBeInTheDocument()
  })

  it('walks the menu buttons with the arrow keys, wrapping', async () => {
    const { user } = renderBar()
    menuButton(enDocuments.menu.trigger).focus()
    await user.keyboard('{ArrowLeft}')
    expect(menuButton(bar.view)).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(menuButton(bar.edit)).toHaveFocus()
  })

  it('moves from an open menu to the next one with ArrowRight, on its first item; Escape goes back to its button', async () => {
    const { user } = renderBar()
    menuButton(bar.edit).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: bar.undo })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getAllByRole('menu').map((menu) => menu.getAttribute('aria-labelledby') === menuButton(bar.format).id))
      .toStrictEqual([true])
    expect(screen.getByRole('menuitem', { name: enDocuments.editor.blocks.paragraph })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(menuButton(bar.format)).toHaveFocus()
  })

  it('renames from Document → Rename while the title is the document\'s own', async () => {
    const { user, onRename } = renderBar()
    await user.click(menuButton(enDocuments.menu.trigger))
    await user.click(screen.getByRole('menuitem', { name: enDocuments.menu.rename }))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('offers no Rename for a title that is its series\' own (a PRD / PR/FAQ)', async () => {
    const { user } = renderBar({ titleEditable: false })
    await user.click(menuButton(enDocuments.menu.trigger))
    expect(screen.queryByRole('menuitem', { name: enDocuments.menu.rename })).not.toBeInTheDocument()
  })
})

describe('DocumentActionsBar: the Review menu (the AI flows)', () => {
  const tools = enDocuments.toolbar
  const reviewMenu = () => within(screen.getByRole('menu', { name: bar.review }))
  const entry = (name: string) => reviewMenu().getByRole('menuitem', { name })
  const openReview = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(menuButton(bar.review)) }

  it('sits between Insert and View while the AI flows are offered', () => {
    renderBar({ review: reviewActions() })
    expect(within(menuBar()).getAllByRole('button').map((button) => button.textContent)).toStrictEqual([
      enDocuments.menu.trigger, bar.edit, bar.format, bar.insert, bar.review, bar.view,
    ])
  })

  it('is not offered without the AI flows (a viewer, an older version on screen)', () => {
    renderBar({ review: null })
    expect(screen.queryByRole('button', { name: bar.review })).not.toBeInTheDocument()
  })

  it('runs Persona review and Rewrite from comments, each with its icon', async () => {
    const review = reviewActions()
    const { user } = renderBar({ review })
    await openReview(user)
    const icon = (item: HTMLElement) => [...(item.querySelector('svg')?.classList ?? [])].find((name) => name.startsWith('lucide-'))
    expect(reviewMenu().getAllByRole('menuitem').map((item) => [item.textContent, icon(item)])).toStrictEqual([
      [tools.aiReview, 'lucide-users-round'], [tools.aiRewrite, 'lucide-wand-sparkles'],
    ])
    await user.click(entry(tools.aiReview))
    await openReview(user)
    await user.click(entry(tools.aiRewrite))
    expect([review.review.start, review.rewrite?.start].map((start) => vi.mocked(start)?.mock.calls.length)).toStrictEqual([1, 1])
  })

  it('shows Rewrite from comments inert with the toolbar\'s reason, and does nothing', async () => {
    const reason = 'Reply to a comment or resolve it first.'
    const review = reviewActions({ rewrite: { reason } })
    const { user } = renderBar({ review })
    await openReview(user)
    const rewrite = entry(tools.aiRewrite)
    expect(rewrite).toHaveAttribute('aria-disabled', 'true')
    expect(rewrite).toHaveAccessibleDescription(reason)
    await user.click(rewrite)
    expect(review.rewrite?.start).not.toHaveBeenCalled()
  })

  it('shows a running review busy: a spinner in place of the icon, inert, said under its name', async () => {
    const review = reviewActions({ review: { running: true } })
    const { user } = renderBar({ review })
    await openReview(user)
    const ask = entry(tools.aiReview)
    expect([ask.getAttribute('aria-disabled'), ask.querySelector('svg')?.classList.contains('animate-spin')])
      .toStrictEqual(['true', true])
    expect(ask).toHaveAccessibleDescription('Personas are reading…')
    await user.click(ask)
    expect(review.review.start).not.toHaveBeenCalled()
  })

  it('says under Persona review that the company\'s personas review a project without its own', async () => {
    const { user } = renderBar({ review: reviewActions({ review: { personas: 'company' } }) })
    await openReview(user)
    expect(entry(tools.aiReview)).toHaveAccessibleDescription(tools.companyPersonasNote)
  })

  it('offers Add personas with nobody to ask, which opens the Personas tab', async () => {
    const review = reviewActions({ review: { personas: 'none' } })
    const { user } = renderBar({ review })
    await openReview(user)
    expect(entry(tools.addPersonas)).toHaveAccessibleDescription(tools.addPersonasNote)
    await user.click(entry(tools.addPersonas))
    expect(review.review.addPersonas).toHaveBeenCalledTimes(1)
    expect(review.review.start).not.toHaveBeenCalled()
  })
})

describe('DocumentActionsBar: the toolbar\'s Comments button', () => {
  it('counts the open threads (in its name and its badge) and toggles the panel, pressed while it shows', async () => {
    const toggle = vi.fn()
    const { user } = renderBar({ openThreads: 3, view: viewControls({ comments: { on: true, toggle } }) })
    const button = screen.getByRole('button', { name: 'Comments, 3 open' })
    expect([button.getAttribute('aria-pressed'), within(button).getByTestId('toolbar-badge').textContent]).toStrictEqual(['true', '3'])
    await user.click(button)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('is not pressed while the panel is hidden', () => {
    renderBar({ view: viewControls({ comments: { on: false, toggle: vi.fn() } }) })
    expect(screen.getByRole('button', { name: 'Comments, 2 open' })).toHaveAttribute('aria-pressed', 'false')
  })
})
