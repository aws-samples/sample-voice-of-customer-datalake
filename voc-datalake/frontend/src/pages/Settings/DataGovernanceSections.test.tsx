/**
 * Taxonomy → Dimensions and Privacy & access → Source policies (7.59.00, DataGovernanceSections.tsx): each a card with
 * its heading and one line, the deployment's editor inside (the scope `deployment`, from any address), and the
 * erasure panels as the `#erasure` card a link focuses.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useConfigScope } from '../../workspace/configScope'

vi.mock('../../workspace/WorkspaceConfigNotice', () => ({ default: () => <p>Workspace notice</p> }))
vi.mock('../../components/DimensionsManager/DimensionsManager', () => ({
  default: function Dimensions() { return <p data-testid="dimensions">scope: {useConfigScope()}</p> },
}))
vi.mock('../../components/SourcesManager/SourcesManager', () => ({
  default: function Sources({ erasureId }: { readonly erasureId?: string }) {
    return <p data-testid="sources">scope: {useConfigScope()}, erasure: {erasureId}</p>
  },
}))

const { DimensionsSection, SourcePoliciesSection } = await import('./DataGovernanceSections')

describe('the data-governance sections', () => {
  it("heads Dimensions with its line and edits the deployment's", () => {
    render(<DimensionsSection />)
    expect(screen.getByRole('heading', { level: 2, name: 'Dimensions' })).toBeInTheDocument()
    expect(screen.getByTestId('dimensions')).toHaveTextContent('scope: deployment')
  })

  it("heads Source policies with its line, edits the deployment's, and anchors the erasure panels", () => {
    render(<SourcePoliciesSection />)
    expect(screen.getByRole('heading', { level: 2, name: 'Source policies' })).toBeInTheDocument()
    expect(screen.getByTestId('sources')).toHaveTextContent('scope: deployment, erasure: admin-card-erasure')
  })
})
