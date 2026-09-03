/**
 * Every wizard field a browser run exercises has a programmatic name and a
 * stable identity.
 *
 * The fields were labelled by a styled `<h3>` sitting above them, which looks
 * like a label and is not one: no `htmlFor`, no `id`, so a screen reader
 * announced each as an unnamed "edit text", clicking the visible text did not
 * focus the field, and nothing addressed the field by id or name.
 *
 * Asserted through `getByLabelText` and `toHaveAccessibleName` — the accessibility
 * tree, not the DOM text. A `getByText` on the same heading passed before the fix,
 * which is why it proved nothing. `toHaveAttribute('id', …)` then pins the identity
 * a deployed browser check and a form serialization both need.
 */
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'
import { DocWizard, MergeWizard, PersonaWizard, ResearchWizard } from './Wizards'
import type { DocToolConfig, MergeToolConfig, PersonaToolConfig, ResearchToolConfig } from './types'

interface WizardProbeProps {
  readonly title: string
  readonly renderFinalStep: () => ReactNode
}

// The label text is what is under test, so a key with no `defaultValue` resolves
// to the KEY: an assertion against a key cannot accidentally match some other
// English string on the page. `i18n` is returned because DocWizard reads
// `i18n.language` in an effect dependency list.
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: { defaultValue?: string }) => (
      options?.defaultValue ?? `${namespace}:${key}`
    ),
    i18n: { language: 'en' },
  }),
}))

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestResearchQuestions: vi.fn(),
    suggestDocumentBrief: vi.fn(),
    autofillPrfaqQuestions: vi.fn(),
  },
}))

vi.mock('../../components/DataSourceWizard', () => ({
  default: ({ title, renderFinalStep }: WizardProbeProps) => (
    <section><h1>{title}</h1>{renderFinalStep()}</section>
  ),
}))

const personaConfig: PersonaToolConfig = { personaCount: 3, customInstructions: '' }
const researchConfig: ResearchToolConfig = {
  question: '', title: '', useWebSearch: false,
}
const docConfig: DocToolConfig = {
  docTypes: ['prfaq'], title: '', featureIdea: '', customerQuestions: [],
}
const mergeConfig: MergeToolConfig = { outputType: 'prd', title: '', instructions: '' }

const shared = {
  personas: [],
  documents: [],
  contextConfig: defaultContextConfig,
  generating: null,
  onContextChange: vi.fn(),
  onClose: vi.fn(),
  onSubmit: vi.fn(),
}

/** Every field, by the visible text that must be its accessible name. */
const FIELDS: ReadonlyArray<{
  readonly wizard: string
  readonly render: () => ReactNode
  readonly cases: ReadonlyArray<{ label: string | RegExp; id: string }>
}> = [
  {
    wizard: 'PersonaWizard',
    render: () => (
      <PersonaWizard
        {...shared}
        personaConfig={personaConfig}
        onPersonaConfigChange={vi.fn()}
      />
    ),
    cases: [
      { label: /Number of Personas/, id: 'persona-count' },
      { label: /Custom Instructions/, id: 'persona-instructions' },
    ],
  },
  {
    wizard: 'ResearchWizard',
    render: () => (
      <ResearchWizard
        {...shared}
        projectId="proj-1"
        researchConfig={researchConfig}
        onResearchConfigChange={vi.fn()}
      />
    ),
    cases: [
      { label: 'Research Question', id: 'research-question' },
      { label: 'Research Title', id: 'research-title' },
    ],
  },
  {
    wizard: 'DocWizard',
    render: () => (
      <DocWizard
        {...shared}
        projectId="proj-1"
        docConfig={docConfig}
        onDocConfigChange={vi.fn()}
      />
    ),
    cases: [
      { label: 'Feature/Product Title', id: 'doc-title' },
      { label: 'Feature Description', id: 'doc-feature-idea' },
    ],
  },
  {
    wizard: 'MergeWizard',
    render: () => (
      <MergeWizard {...shared} mergeConfig={mergeConfig} onMergeConfigChange={vi.fn()} />
    ),
    cases: [
      { label: 'projectDetail:wizards.newDocTitle', id: 'merge-title' },
      { label: 'projectDetail:wizards.remixInstructions', id: 'merge-instructions' },
    ],
  },
]

describe.each(FIELDS)('$wizard fields', ({ render: renderWizard, cases }) => {
  it.each(cases)('gives "$id" a programmatic name and a stable id', ({ label, id }) => {
    render(<>{renderWizard()}</>)

    const field = screen.getByLabelText(label)
    expect(field).toHaveAttribute('id', id)
    expect(field).toHaveAttribute('name', id)
    expect(field).toHaveAccessibleName()
  })
})

describe('clicking a wizard label', () => {
  it('moves focus into the field it names', async () => {
    // The property a detached heading cannot have, and the one a sighted user
    // with a large click target relies on.
    const user = userEvent.setup()
    render(
      <ResearchWizard
        {...shared}
        projectId="proj-1"
        researchConfig={researchConfig}
        onResearchConfigChange={vi.fn()}
      />,
    )

    await user.click(screen.getByText('Research Title'))

    expect(screen.getByLabelText('Research Title')).toHaveFocus()
  })
})

describe('the five Working Backwards questions', () => {
  it('name each answer field and describe it without folding the hint into the name', () => {
    render(
      <DocWizard
        {...shared}
        projectId="proj-1"
        docConfig={{ ...docConfig, docTypes: ['prfaq'] }}
        onDocConfigChange={vi.fn()}
      />,
    )

    const answers = screen.getAllByRole('textbox')
      .filter((field) => field.id.startsWith('customer-question-'))
    expect(answers.length).toBeGreaterThan(0)
    for (const answer of answers) {
      expect(answer).toHaveAttribute('name', answer.id)
      expect(answer).toHaveAccessibleName()
      expect(answer).toHaveAttribute('aria-describedby', `${answer.id}-hint`)
      // The description is guidance, so it must NOT be the name as well —
      // otherwise a screen reader reads the whole paragraph on every focus.
      expect(answer.getAttribute('aria-labelledby')).toBeNull()
    }
  })
})
