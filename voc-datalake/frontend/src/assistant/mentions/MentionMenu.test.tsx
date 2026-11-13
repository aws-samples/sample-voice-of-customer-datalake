/**
 * The `#document` list groups its options by the project's sections (PRD, PR/FAQ, Documents), each a named group of
 * the one listbox, with the option ids (the textbox's aria-activedescendant) in reading order across the groups.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import MentionMenu from './MentionMenu'
import { documentMentionOptions, personaMentionOptions } from './mentionModel'
import type { MentionMenuState } from './useMentions'

const DOCUMENTS = [
  { document_id: 'notes', document_type: 'research', title: 'Interview notes', created_at: '2026-04-01T00:00:00Z' },
  { document_id: 'faq', document_type: 'prfaq', title: 'Launch FAQ', version: 2, created_at: '2026-03-01T00:00:00Z' },
  { document_id: 'prd', document_type: 'prd', title: 'Launch', version: 1, created_at: '2026-02-01T00:00:00Z' },
  { document_id: 'proto', document_type: 'prototype', title: 'Checkout', created_at: '2026-05-01T00:00:00Z' },
]

function menu(kind: 'document' | 'persona'): MentionMenuState {
  const options = kind === 'document'
    ? documentMentionOptions(DOCUMENTS, '', [])
    : personaMentionOptions([{ persona_id: 'p1', name: 'Dana' }, { persona_id: 'p2', name: 'Victor' }], '', [], 'Every persona')
  return { trigger: { kind, start: 0, query: '' }, options, active: 1, limited: false, loading: false }
}

describe('MentionMenu', () => {
  it('lists documents in named section groups, in order, the option ids in reading order', () => {
    render(<MentionMenu listId="list" menu={menu('document')} onChoose={vi.fn()} />)
    const groups = within(screen.getByRole('listbox', { name: 'Documents' })).getAllByRole('group')
    expect(groups.map((group) => [
      group.getAttribute('aria-labelledby') === null ? '' : document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
      within(group).getAllByRole('option').map((option) => `${option.id}:${option.textContent}`),
    ])).toStrictEqual([
      ['PRD', ['list-option-0:Launch (v1)']],
      ['PR/FAQ', ['list-option-1:Launch FAQ (v2)']],
      ['Documents', ['list-option-2:Interview notes']],
    ])
    expect(screen.getByRole('option', { name: 'Launch FAQ (v2)' })).toHaveAttribute('aria-selected', 'true')
  })

  it('names each group for a screen reader', () => {
    render(<MentionMenu listId="list" menu={menu('document')} onChoose={vi.fn()} />)
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-labelledby'))).toStrictEqual([
      'list-section-prd', 'list-section-prfaq', 'list-section-documents',
    ])
    expect(screen.getByRole('group', { name: 'PR/FAQ' })).toBeInTheDocument()
  })

  it('lists personas without groups', () => {
    render(<MentionMenu listId="list" menu={menu('persona')} onChoose={vi.fn()} />)
    expect([screen.queryAllByRole('group'), screen.getAllByRole('option').map((option) => option.id)])
      .toStrictEqual([[], ['list-option-0', 'list-option-1', 'list-option-2']])
  })
})
