/**
 * @fileoverview Render helpers for the ProblemRow and SubcategoryRow specs.
 *
 * Kept apart from `problem-analysis-fixtures.tsx` because this file imports
 * the components under test, and a module that both feeds the specs' `vi.mock`
 * factories and imports the mocked module's consumer cannot finish evaluating.
 */
import { vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ComponentProps } from 'react'
import { ProblemRow } from './ProblemRow'
import { SubcategoryRow } from './SubcategoryRow'
import { makeProblemGroup, SHIPPING_SPEED_SUBCATEGORY } from './problem-analysis-fixtures'

/** Renders a collapsed "Slow delivery times" row under a MemoryRouter; every prop can be overridden. */
export function renderProblemRow(overrides: Partial<ComponentProps<typeof ProblemRow>> = {}) {
  return render(
    <MemoryRouter>
      <ProblemRow
        problemGroup={makeProblemGroup()}
        problemKey="delivery:shipping:slow"
        isExpanded={false}
        onToggle={vi.fn()}
        onToggleResolved={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  )
}

/** Renders a collapsed `delivery / shipping_speed` row under a MemoryRouter; every prop can be overridden. */
export function renderSubcategoryRow(overrides: Partial<ComponentProps<typeof SubcategoryRow>> = {}) {
  return render(
    <MemoryRouter>
      <SubcategoryRow
        categoryName="delivery"
        subcategoryGroup={SHIPPING_SPEED_SUBCATEGORY}
        isExpanded={false}
        onToggle={vi.fn()}
        expandedProblems={new Set()}
        onToggleProblem={vi.fn()}
        onToggleResolved={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  )
}
