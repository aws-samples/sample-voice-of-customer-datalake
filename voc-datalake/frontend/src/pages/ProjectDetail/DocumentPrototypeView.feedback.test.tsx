/**
 * The prototype page offers the Feedback view to project editors only: the route
 * behind it is EDIT, so a viewer is never shown a button that would answer 403.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithQueryClient } from '../../test/query-client'
import { PrototypeView } from './DocumentPrototypeView'

const EXTRA_SOURCES = { useProductContext: false, useResearch: false, researchIds: [], visualIds: [], designSystem: null }

function renderPrototype(canEdit: boolean) {
  return renderWithQueryClient(
    <PrototypeView projectId="proj_1" documentId="doc_v1" html="<!doctype html><html><body>Hi</body></html>"
      title="Checkout" prototypeFormat="html" sourcePrdId="" sourcePrfaqId="" sourcesDropped={false}
      extraSources={EXTRA_SOURCES} canEdit={canEdit} />,
  )
}

describe('PrototypeView feedback entry', () => {
  it('offers Feedback to an editor', () => {
    renderPrototype(true)
    expect(screen.getByRole('button', { name: 'Feedback' })).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('never shows it to a viewer', () => {
    renderPrototype(false)
    expect(screen.queryByRole('button', { name: 'Feedback' })).not.toBeInTheDocument()
  })
})
