/**
 * @fileoverview Render helpers for the OverviewTab `prototype*` specs.
 *
 * Kept apart from `prototype-fixtures.ts` because this file imports the component
 * under test, whose module graph runs the specs' `vi.mock` factories — a module
 * that both feeds those factories and imports the mocked module's consumer cannot
 * finish evaluating.
 */
import { vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import OverviewTab from './OverviewTab'
import { PROTOTYPE_PROJECT } from './prototype-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { ProductContext, ProductDoc } from '../../api/projectTypes'

interface OverviewTabOptions {
  documents: ProjectDocument[]
  productContext?: ProductContext
  productDocs?: ProductDoc[]
  onJobStarted?: () => void
}

/** The tab for a given document set, so a test can re-render with a different one. */
export function overviewTab({
  documents, productContext, productDocs, onJobStarted = vi.fn(),
}: OverviewTabOptions) {
  return (
    <OverviewTab
      project={PROTOTYPE_PROJECT}
      personas={[]}
      documents={documents}
      productContext={productContext}
      productDocs={productDocs}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onJobStarted={onJobStarted}
    />
  )
}

/** Renders the Overview tab with every callback stubbed. */
export function renderOverviewTab(options: OverviewTabOptions) {
  return render(overviewTab(options))
}

/** The card's build trigger — opens the wizard, spends nothing. */
export function buildButton() {
  return screen.getByRole('button', { name: /configure & build prototype/i })
}
