import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
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

vi.mock('../../components/DataSourceWizard/DataSourceWizard', () => ({
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

    // Keyed by catalogue key, so a failure names the label that went missing.
    const rendered = {
      'wizards.remixDocuments': screen.queryByRole('heading', { level: 1, name: 'projectDetail:wizards.remixDocuments' }),
      'wizards.outputDocType': screen.queryByRole('heading', { level: 3, name: 'projectDetail:wizards.outputDocType' }),
      'wizards.newDocTitle': screen.queryByRole('heading', { level: 3, name: 'projectDetail:wizards.newDocTitle' }),
      'wizards.newDocTitlePlaceholder': screen.queryByPlaceholderText('projectDetail:wizards.newDocTitlePlaceholder'),
      'wizards.remixInstructions': screen.queryByRole('heading', { level: 3, name: 'projectDetail:wizards.remixInstructions' }),
      'wizards.remixInstructionsPlaceholder': screen.queryByPlaceholderText('projectDetail:wizards.remixInstructionsPlaceholder'),
      'wizards.selectAtLeast2': screen.queryByText('projectDetail:wizards.selectAtLeast2'),
      'wizards.submitRemixDocuments': screen.queryByText('projectDetail:wizards.submitRemixDocuments'),
    }
    const missing = Object.entries(rendered).filter(([, element]) => element === null).map(([key]) => key)
    expect(missing).toStrictEqual([])
  })
})
