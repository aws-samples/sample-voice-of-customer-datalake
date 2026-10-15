import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'
import { MergeWizard } from './Wizards'
import type { MergeToolConfig } from './types'

interface WizardProbeProps {
  readonly title: string
  readonly renderFinalStep: () => ReactNode
  readonly submitLabel: ReactNode
}

vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string) => `${namespace}:${key}`,
  }),
}))

vi.mock('../../components/DataSourceWizard', () => ({
  default: ({ title, renderFinalStep, submitLabel }: WizardProbeProps) => (
    <section>
      <h1>{title}</h1>
      {renderFinalStep()}
      <div>{submitLabel}</div>
    </section>
  ),
}))

const mergeConfig: MergeToolConfig = {
  outputType: 'prd',
  title: '',
  instructions: '',
}

describe('MergeWizard translations', () => {
  it('renders every user-facing wizard label through projectDetail translation keys', () => {
    render(
      <MergeWizard
        personas={[]}
        documents={[]}
        contextConfig={defaultContextConfig}
        mergeConfig={mergeConfig}
        generating={null}
        onContextChange={vi.fn()}
        onMergeConfigChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'projectDetail:wizards.remixDocuments' }))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'projectDetail:wizards.outputDocType' }))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'projectDetail:wizards.newDocTitle' }))
      .toBeInTheDocument()
    expect(screen.getByPlaceholderText('projectDetail:wizards.newDocTitlePlaceholder'))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'projectDetail:wizards.remixInstructions' }))
      .toBeInTheDocument()
    expect(screen.getByPlaceholderText('projectDetail:wizards.remixInstructionsPlaceholder'))
      .toBeInTheDocument()
    expect(screen.getByText('projectDetail:wizards.selectAtLeast2')).toBeInTheDocument()
    expect(screen.getByText('projectDetail:wizards.submitRemixDocuments')).toBeInTheDocument()
  })
})
