/**
 * DocumentSurface through an adapter: its modes (read with Rendered / Source and Contents, compare, edit), its read-only
 * reasons as visible text, its states (loading, empty), a split front-matter kept byte for byte through a save, and the
 * adapter contract of a save: the version it was made on, a 409 as the conflict, Compare and merge taking the latest
 * version's changes into the draft, and the next save checked against the latest.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/errors'
import DocumentSurface from './DocumentSurface'
import type { DocumentSurfaceProps } from './DocumentSurface'
import type { ContentType, DocumentAdapter, DocumentPermissions } from './types'

interface Doc { readonly title: string; readonly content: string; readonly rev: number }

function adapterOf(overrides: Partial<DocumentAdapter<Doc>> = {}, edit: DocumentPermissions['edit'] = true,
  contentType: ContentType = 'markdown'): DocumentAdapter<Doc> {
  return {
    id: 'test:doc', contentType, permissions: { edit },
    versionOf: (stored) => ({ token: String(stored.rev), number: stored.rev }),
    load: (stored) => Promise.resolve(stored),
    ...overrides,
  }
}

function renderSurface(props: Partial<DocumentSurfaceProps<Doc>>) {
  const all: DocumentSurfaceProps<Doc> = {
    adapter: adapterOf(), variant: 'page', title: 'Launch plan', headingLevel: 1, meta: null,
    stored: { title: 'Launch plan', content: '# Plan\n\nShip it.', rev: 1 }, mode: 'read', compare: null, comments: null,
    onSaved: vi.fn(), fullPath: null, footer: null, onClose: null, page: null, children: null, ...props,
  }
  return render(<MemoryRouter><DocumentSurface {...all} /></MemoryRouter>)
}

const SECTIONS = '# Plan\n\n## Goals\n\nA.\n\n## Risks\n\nB.\n\n## Owners\n\nC.'

describe('DocumentSurface: read', () => {
  it('renders the text under its heading, with Contents from three headings', () => {
    renderSurface({ stored: { title: 'Launch plan', content: SECTIONS, rev: 1 } })

    expect(screen.getByRole('region', { name: 'Launch plan' })).toHaveAttribute('data-variant', 'page')
    expect(screen.getByRole('heading', { level: 2, name: 'Goals' })).toHaveAttribute('id', 'h-goals')
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument()
  })

  it('opens a sheet on the app\'s side sheet, whose title, description and footer are the sheet\'s (SideSheet, wide)', async () => {
    const onClose = vi.fn()
    renderSurface({ variant: 'sheet', headingLevel: 2, meta: 'Saved on 17 November', onClose,
      footer: <button type="button">Close</button> })

    const sheet = screen.getByRole('dialog', { name: 'Launch plan' })
    expect(sheet).toHaveClass('sheet-panel', 'sm:max-w-[44rem]')
    expect([
      within(sheet).getByText('Saved on 17 November').classList.contains('dialog-description'),
      sheet.querySelector('.dialog-footer')?.contains(within(sheet).getByRole('button', { name: 'Close' })),
      within(sheet).getByRole('region', { name: 'Launch plan' }).dataset.variant,
    ]).toStrictEqual([true, true, 'sheet'])
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the text as stored under Source', async () => {
    const user = userEvent.setup()
    renderSurface({})

    await user.click(screen.getByRole('button', { name: 'Source' }))

    expect(screen.getByRole('region', { name: 'Source of Launch plan' })).toHaveTextContent('# Plan')
  })

  it.each([
    ['managedByTemplate', 'From the template. It changes with a release, in templates/orchestration.'],
    ['proposalOnly', 'Changes to this are proposed, then accepted by an administrator.'],
    ['decided', 'Accepted. An accepted version never changes.'],
    ['viewer', 'You can read this and comment.'],
  ] as const)('says why it is read only (%s) as text, with no field', (reason, line) => {
    renderSurface({ adapter: adapterOf({}, reason), mode: 'edit' })

    expect(screen.getByRole('note')).toHaveTextContent(line)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('says an empty text has nothing written yet, and shows lines while it loads', () => {
    const { rerender } = renderSurface({ stored: { title: 'Launch plan', content: ' ', rev: 1 } })
    expect(screen.getByText('Nothing written yet.')).toBeInTheDocument()

    rerender(<MemoryRouter><DocumentSurface adapter={adapterOf()} variant="panel" title="Launch plan" headingLevel={3} meta={null}
      stored={undefined} mode="read" compare={null} comments={null} onSaved={vi.fn()} fullPath="/docs/1" footer={null} onClose={null} page={null}>
      {null}
    </DocumentSurface></MemoryRouter>)

    expect(screen.getByRole('status', { name: 'Loading the document…' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/docs/1')
  })

  it('shows a split front-matter as Properties above the body, never in the text', () => {
    renderSurface({
      adapter: adapterOf({ frontMatter: 'split' }),
      stored: { title: 'SKILL.md', content: '---\nname: fixer\n---\n## Role\n\nFix one bug.', rev: 1 },
    })

    expect(within(screen.getByRole('region', { name: 'Properties' })).getByText('fixer')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Role' })).toBeInTheDocument()
    expect(screen.queryByText(/name: fixer/u)).not.toBeInTheDocument()
  })
})

describe('DocumentSurface: compare', () => {
  it('compares the stored version with the other side, rendered first', () => {
    const { container } = renderSurface({
      mode: 'compare', compare: { before: '# Plan\n\nShip later.', beforeLabel: 'v1', afterLabel: 'Current', identicalText: 'Same.' },
    })

    expect([...container.querySelectorAll('[data-diff="add"], [data-diff="del"]')].map((block) => block.textContent))
      .toStrictEqual(['Removed: Ship later.', 'Added: Ship it.'])
  })
})

describe('DocumentSurface: edit', () => {
  it('edits a prompt as written, counts it against its limit, and waits to save past it', async () => {
    const user = userEvent.setup()
    const save = vi.fn((draft: { content: string }, on: Doc) => Promise.resolve({ ...on, content: draft.content, rev: on.rev + 1 }))
    renderSurface({ adapter: adapterOf({ save, limits: { maxChars: 12 } }, true, 'plain'), mode: 'edit', stored: { title: 'Prompt', content: 'Be brief.', rev: 1 } })

    await user.type(screen.getByRole('textbox', { name: 'Launch plan' }), ' Always.')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Too long: shorten it to save.')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('saves a split document with its front-matter joined back byte for byte, checked against its version', async () => {
    const user = userEvent.setup()
    const save = vi.fn((draft: { title: string; content: string }, on: Doc) => Promise.resolve({ ...on, ...draft, rev: on.rev + 1 }))
    renderSurface({
      adapter: adapterOf({ save, frontMatter: 'split' }, true, 'plain'), mode: 'edit',
      stored: { title: 'Notes', content: '---\r\nname: x\r\n---\r\nBody', rev: 3 },
    })

    await user.type(screen.getByRole('textbox', { name: 'Launch plan' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1) })
    expect(save).toHaveBeenCalledWith({ title: 'Notes', content: '---\r\nname: x\r\n---\r\nBody!' },
      expect.objectContaining({ rev: 3 }), { checked: true, mark: null })
  })

  it('meets a 409 as the conflict, merges the latest version\'s change, and saves on top of the latest', async () => {
    const user = userEvent.setup()
    const latest: Doc = { title: 'Notes', content: 'Intro.\n\nShip on Tuesday.\n\nOwner: Sam.', rev: 2 }
    const save = vi.fn<NonNullable<DocumentAdapter<Doc>['save']>>()
      .mockRejectedValueOnce(new ApiError(409, 'stale'))
      .mockImplementation((draft, on) => Promise.resolve({ ...on, ...draft, rev: on.rev + 1 }))
    renderSurface({
      adapter: adapterOf({ save, load: () => Promise.resolve(latest) }, true, 'plain'), mode: 'edit',
      stored: { title: 'Notes', content: 'Intro.\n\nShip on Monday.\n\nOwner: Sam.', rev: 1 },
    })
    const field = screen.getByRole('textbox', { name: 'Launch plan' })
    await user.clear(field)
    await user.type(field, 'Intro.\n\nShip on Monday.\n\nOwner: Alex.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await within(await screen.findByRole('alert')).findByRole('button', { name: 'Compare and merge' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Merge into my draft' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
    expect(save).toHaveBeenLastCalledWith({ title: 'Notes', content: 'Intro.\n\nShip on Tuesday.\n\nOwner: Alex.' },
      latest, { checked: true, mark: null })
  })
})
