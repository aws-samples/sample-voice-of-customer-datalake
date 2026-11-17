/**
 * The document page's menu bar (menuBar.ts, canvasMenus.ts): Document · Edit · Format · Insert · View on an editable
 * canvas, Document and View for a viewer; each entry dispatches the canvas's own action (the editor's commands
 * through its handle, the View switches, Rename); the menus are WAI-ARIA menu buttons and the bar's arrow keys walk
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

function renderBar({ editable = true, canEdit = true, view = viewControls(), openThreads = 2, titleEditable = true } = {}) {
  const focus = { active: false, toggle: vi.fn() }
  const onRename = vi.fn()
  const state = canvasState({ editable, titleEditable, handleRef: { current: handle } })
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DocumentActionsBar project={project} document={custom} canEdit={canEdit} state={state} share={null} threads={null}
        onDeleteDoc={vi.fn()} isDeleting={false} focus={focus} focusButtonRef={createRef()} view={view}
        openThreads={openThreads} onRename={onRename} viewing={null} onChooseVersion={vi.fn()} review={null} />
    </QueryClientProvider>,
  )
  return { focus, onRename, view, user: userEvent.setup() }
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
