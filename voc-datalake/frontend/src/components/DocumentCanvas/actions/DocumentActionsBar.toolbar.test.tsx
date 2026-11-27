/**
 * The document page's toolbar (DocumentToolbar, in the bar): a WAI-ARIA toolbar (one Tab stop, the arrow keys,
 * Home and End), every icon named with its tooltip, the AI flows' names shown beside their icons, the toggles
 * `aria-pressed` and in step with the View menu (one state, two doors: the page's stored view preferences), the open
 * comments counted in the Comments button's name, the version picker (the page's own version checked, the latest
 * marked), Share and the AI flows for an editor only ("Add personas" with nobody to ask, the company's personas said
 * when they would review), and on a narrow screen the "⋯" menu, the AI flows in it with their names.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRef, useState } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import enDocuments from '../../../../public/locales/en/documents.json'
import { projectsApi } from '../../../api/projectsApi'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { usePageView, useDocumentViewStore } from '../page/usePageView'
import { canvasState } from './canvas-state-fixtures'
import DocumentActionsBar from './DocumentActionsBar'
import type { ReviewActions } from './toolbarItems'
import type { VersionChoice } from './versionChoices'
import type { DocumentShareControls } from './DocumentMenu'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

vi.mock('../../../api/projectsApi', () => ({ projectsApi: { getDocumentVersions: vi.fn(), restoreDocumentVersion: vi.fn() } }))

const bar = enDocuments.menubar
const tools = enDocuments.toolbar
const project = makeProject({ project_id: 'p1' })
const prfaq: ProjectDocument = {
  document_id: 'prfaq_4', document_type: 'prfaq', title: 'Refunds (v4)', base_title: 'Refunds', content: 'text',
  created_at: '2026-10-01T00:00:00Z', version: 4,
}
const share: DocumentShareControls = { share: null, createShare: vi.fn(), revokeShare: vi.fn() }

function version(n: number, current = false): DocumentVersion {
  return {
    version_id: `prfaq_${String(n)}`, document_id: `prfaq_${String(n)}`, version: n, title: `Refunds (v${String(n)})`,
    content: `v${String(n)} text`, created_at: '2026-10-01T00:00:00Z', current,
  }
}

function reviewActions(overrides: Partial<ReviewActions> = {}): ReviewActions {
  return {
    review: { running: false, personas: 'project', again: false, start: vi.fn(), addPersonas: vi.fn() },
    rewrite: { running: false, reason: null, start: vi.fn() },
    ...overrides,
  }
}

/** The persona review's half of the flows, with `review`'s fields. */
function personaReview(review: Partial<ReviewActions['review']>): ReviewActions {
  const actions = reviewActions()
  return { ...actions, review: { ...actions.review, ...review } }
}

/** The bar as the page wires it: the view from the stored preferences, full screen in state. */
function Harness({ canEdit, review, onChooseVersion, viewing }: Readonly<{
  canEdit: boolean; review: ReviewActions | null; onChooseVersion: (choice: VersionChoice) => void; viewing: number | null
}>) {
  const view = usePageView(true)
  const [fullScreen, setFullScreen] = useState(false)
  const state = canvasState({ editable: canEdit })
  return (
    <DocumentActionsBar project={project} document={prfaq} canEdit={canEdit} state={state} share={share} threads={[]}
      onDeleteDoc={vi.fn()} isDeleting={false} focus={{ active: fullScreen, toggle: () => setFullScreen((on) => !on) }}
      focusButtonRef={createRef()} view={view} openThreads={3} viewing={viewing} onChooseVersion={onChooseVersion}
      review={review} />
  )
}

interface BarCase {
  readonly canEdit?: boolean
  readonly review?: ReviewActions | null
  readonly viewing?: number | null
}

function renderBar({ canEdit = true, review = reviewActions(), viewing = null }: BarCase = {}) {
  const onChooseVersion = vi.fn<(choice: VersionChoice) => void>()
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Harness canEdit={canEdit} review={canEdit ? review : null} onChooseVersion={onChooseVersion} viewing={viewing} />
    </QueryClientProvider>,
  )
  return { onChooseVersion, user: userEvent.setup() }
}

const toolbar = () => screen.getByRole('toolbar', { name: tools.label })
const tool = (name: string | RegExp) => within(toolbar()).getByRole('button', { name })

beforeEach(() => {
  useDocumentViewStore.setState({ comments: false, outline: true, fullWidth: true })
  vi.mocked(projectsApi.getDocumentVersions).mockResolvedValue([version(4, true), version(3), version(2), version(1)])
})

describe('the toolbar: its items', () => {
  it('offers an editor the versions, History, the AI flows, the panels, Full screen and Share, in that order', () => {
    renderBar()
    expect(within(toolbar()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
      .toStrictEqual([
        'Version v4', enDocuments.actions.history, tools.aiReview, tools.aiRewrite, 'Comments, 3 open',
        enDocuments.page.contents, bar.fullWidth, enDocuments.focus.button, tools.share,
      ])
  })

  it('offers a viewer no Share and no AI flow (the menus offer them to an editor only)', () => {
    renderBar({ canEdit: false })
    const names = within(toolbar()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names).toStrictEqual([
      'Version v4', enDocuments.actions.history, 'Comments, 3 open', enDocuments.page.contents,
      bar.fullWidth, enDocuments.focus.button,
    ])
  })

  it('names every icon and gives it a tooltip (its description)', () => {
    renderBar()
    for (const button of within(toolbar()).getAllByRole('button')) {
      const tip = button.querySelector('[role="tooltip"]')
      expect(tip, button.textContent).not.toBeNull()
      expect(button.getAttribute('aria-describedby')).toBe(tip?.id)
      expect(button).toHaveAccessibleName()
    }
    expect(tool(enDocuments.page.contents)).toHaveAccessibleDescription(tools.contentsHint)
  })

  it('counts the open comments in the Comments button\'s name (announced) and its badge', () => {
    renderBar()
    expect(within(tool('Comments, 3 open')).getByTestId('toolbar-badge')).toHaveTextContent('3')
  })

  it('says why AI rewrite cannot start yet, focusable but inert; AI review runs the personas', async () => {
    const review = reviewActions({ rewrite: { running: false, reason: 'Reply to a comment or resolve it first.', start: vi.fn() } })
    const { user } = renderBar({ review })
    const rewrite = tool(tools.aiRewrite)
    expect(rewrite).toHaveAttribute('aria-disabled', 'true')
    expect(rewrite).toHaveAccessibleDescription('Reply to a comment or resolve it first.')
    await user.click(rewrite)
    expect(review.rewrite?.start).not.toHaveBeenCalled()
    await user.click(tool(tools.aiReview))
    expect(review.review.start).toHaveBeenCalledTimes(1)
  })

  /** The words a button shows beside its icon (its tooltip aside), or null. */
  const shown = (button: HTMLElement) => within(button).queryByText(button.getAttribute('aria-label') ?? '')?.textContent ?? null

  it('shows the AI flows\' names beside their icons, the other buttons as icons', () => {
    renderBar()
    expect([tool(tools.aiReview), tool(tools.aiRewrite), tool(enDocuments.page.contents)].map(shown))
      .toStrictEqual(['Persona review', 'Rewrite from comments', null])
  })

  it('offers "Add personas" with nobody to ask (no persona in the project or the company), opening the Personas tab', async () => {
    const review = personaReview({ personas: 'none' })
    const { user } = renderBar({ review })
    const add = tool(tools.addPersonas)
    expect([shown(add), add.getAttribute('aria-disabled')]).toStrictEqual(['Add personas', null])
    expect(add).toHaveAccessibleDescription(tools.addPersonasHint)
    await user.click(add)
    expect([vi.mocked(review.review.addPersonas).mock.calls.length, vi.mocked(review.review.start).mock.calls.length])
      .toStrictEqual([1, 0])
  })

  it('says the company\'s personas review a project without its own', () => {
    renderBar({ review: personaReview({ personas: 'company' }) })
    expect(tool(tools.aiReview)).toHaveAccessibleDescription(tools.companyPersonasHint)
  })

  it('offers the review while it is not known who would review (the server decides)', () => {
    renderBar({ review: personaReview({ personas: null }) })
    expect(tool(tools.aiReview)).not.toHaveAttribute('aria-disabled')
  })

  it('opens the review link from Share', async () => {
    const { user } = renderBar()
    await user.click(tool(tools.share))
    expect(screen.getByRole('dialog', { name: 'Share for review' })).toBeInTheDocument()
  })

  it('hides the editor\'s menus and the AI flows while an older version is on screen', () => {
    renderBar({ review: null, viewing: 2 })
    expect(screen.queryByRole('button', { name: bar.edit })).not.toBeInTheDocument()
    expect(within(toolbar()).queryByRole('button', { name: tools.aiReview })).not.toBeInTheDocument()
    expect(tool('Version v2')).toBeInTheDocument()
  })
})

describe('the toolbar and the View menu: one state', () => {
  it('starts with the panel closed, Contents shown and the full width on (no stored choice)', async () => {
    const { user } = renderBar()
    expect([tool('Comments, 3 open'), tool(enDocuments.page.contents), tool(bar.fullWidth)]
      .map((button) => button.getAttribute('aria-pressed'))).toStrictEqual(['false', 'true', 'true'])
    await user.click(screen.getByRole('button', { name: bar.view }))
    expect(screen.getAllByRole('menuitemcheckbox').slice(0, 3).map((item) => item.getAttribute('aria-checked')))
      .toStrictEqual(['false', 'true', 'true'])
  })

  it('shows a switch made in one door in the other', async () => {
    const { user } = renderBar()
    await user.click(tool('Comments, 3 open'))
    await user.click(tool(bar.fullWidth))
    await user.click(screen.getByRole('button', { name: bar.view }))
    const view = within(screen.getByRole('menu', { name: bar.view }))
    expect([bar.comments, bar.fullWidth].map((name) => view.getByRole('menuitemcheckbox', { name }).getAttribute('aria-checked')))
      .toStrictEqual(['true', 'false'])
    await user.click(view.getByRole('menuitemcheckbox', { name: enDocuments.page.contents }))
    expect(tool(enDocuments.page.contents)).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: bar.view }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(enDocuments.focus.button) }))
    expect(tool(enDocuments.focus.button)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the toolbar: the keyboard', () => {
  /** The name of the focused item. */
  const focused = () => document.activeElement?.getAttribute('aria-label')

  it('is one Tab stop, the item last used', async () => {
    const { user } = renderBar()
    const buttons = within(toolbar()).getAllByRole('button')
    expect(buttons.map((button) => button.tabIndex)).toStrictEqual([0, -1, -1, -1, -1, -1, -1, -1, -1])
    buttons[0]?.focus()
    await user.keyboard('{End}')
    expect(within(toolbar()).getAllByRole('button').filter((button) => button.tabIndex === 0)).toStrictEqual([tool(tools.share)])
  })

  it('moves with the arrows (wrapping), Home and End going to the ends', async () => {
    const { user } = renderBar()
    tool('Version v4').focus()
    const seen: (string | null | undefined)[] = []
    for (const key of ['{ArrowRight}', '{ArrowLeft}{ArrowLeft}', '{Home}', '{End}']) {
      await user.keyboard(key)
      seen.push(focused())
    }
    expect(seen).toStrictEqual([enDocuments.actions.history, tools.share, 'Version v4', tools.share])
  })

  it('leaves the arrows to an open menu of the row', async () => {
    const { user } = renderBar()
    tool('Version v4').focus()
    await user.keyboard('{ArrowDown}')
    const versions = await screen.findAllByRole('menuitemradio')
    expect(versions[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(versions[1]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(versions[1]).toHaveFocus()
  })
})

describe('the version picker', () => {
  it('lists every version newest first, the page\'s own checked, the latest marked', async () => {
    const { user } = renderBar()
    await user.click(tool('Version v4'))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((item) => [item.textContent.slice(0, 2), item.getAttribute('aria-checked')]))
      .toStrictEqual([['v4', 'true'], ['v3', 'false'], ['v2', 'false'], ['v1', 'false']])
    expect(within(items[0] ?? document.body).getByText(tools.latest)).toBeInTheDocument()
  })

  it('chooses an older version (shown read-only by the page), and the page\'s own', async () => {
    const { user, onChooseVersion } = renderBar()
    await user.click(tool('Version v4'))
    await user.click(await screen.findByRole('menuitemradio', { name: /^v2/ }))
    await user.click(tool('Version v4'))
    await user.click(await screen.findByRole('menuitemradio', { name: /^v4/ }))
    expect(onChooseVersion.mock.calls).toStrictEqual([[{ kind: 'older', number: 2 }], [{ kind: 'own' }]])
  })

  it('checks the older version on screen', async () => {
    const { user } = renderBar({ viewing: 2 })
    await user.click(tool('Version v2'))
    expect(await screen.findByRole('menuitemradio', { name: /^v2/ })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('on a narrow screen', () => {
  it('keeps the versions, Comments, Full screen and Share in the row, the rest in "⋯"', async () => {
    const narrow = (query: string) => Object.assign(new EventTarget(), { matches: query.includes('max-width'), media: query })
    vi.stubGlobal('matchMedia', narrow)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const { user } = renderBar()
    expect(within(toolbar()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
      .toStrictEqual(['Version v4', 'Comments, 3 open', enDocuments.focus.button, tools.more, tools.share])
    await user.click(tool(tools.more))
    const more = within(screen.getByRole('menu', { name: tools.more }))
    expect(more.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual([
      enDocuments.actions.history, 'Persona review', 'Rewrite from comments',
    ])
    await user.click(more.getByRole('menuitemcheckbox', { name: bar.fullWidth }))
    expect(useDocumentViewStore.getState().fullWidth).toBe(false)
  })
})
