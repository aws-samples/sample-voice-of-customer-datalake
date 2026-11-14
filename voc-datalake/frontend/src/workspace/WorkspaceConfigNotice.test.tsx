/**
 * Whose categories, dimensions and source policies Administration's editors show: nothing outside a workspace;
 * inside one, that they are the deployment's (not the workspace's), with a link to the workspace's own page.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TestRouter } from '../test/TestRouter'
import { ACME } from '../test/workspaceFixtures'
import { setCurrentWorkspace } from './currentWorkspace'
import WorkspaceConfigNotice from './WorkspaceConfigNotice'

function renderNotice() {
  return render(<TestRouter initialEntries={['/admin']}><WorkspaceConfigNotice /></TestRouter>)
}

afterEach(() => { act(() => setCurrentWorkspace(null)) })

describe('WorkspaceConfigNotice', () => {
  it('says nothing outside a workspace', () => {
    const { container } = renderNotice()
    expect(container).toBeEmptyDOMElement()
  })

  it("says these are the deployment's settings, not the workspace's, and links to the workspace's page", () => {
    act(() => setCurrentWorkspace(ACME))
    renderNotice()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent("These are the deployment's own settings, not those of Acme Outfitters")
    expect(note).toHaveTextContent('The settings of Acme Outfitters are on its Workspace settings page')
    expect(screen.getByRole('link', { name: 'Workspace settings' })).toHaveAttribute('href', '/workspace-settings')
  })
})
