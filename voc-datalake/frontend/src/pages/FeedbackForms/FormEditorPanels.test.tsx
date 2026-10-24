import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient as render } from '../../test/query-client'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { CategoryPanel } from './FormEditorPanels'
import type { EditorCategory } from './FormEditorPanels'
import { defaultFormConfig } from './formTemplates'

type Props = ComponentProps<typeof CategoryPanel>

// Ids in the Categories page's `cat_…` / `sub_…` form, deliberately unlike the
// names, so a test cannot pass by an id happening to equal a name.
const CATEGORIES: EditorCategory[] = [
  {
    id: 'cat_1',
    name: 'ease_of_use',
    description: 'Ease of use',
    subcategories: [{ id: 'sub_1', name: 'onboarding_flow' }],
  },
  { id: 'cat_2', name: 'api_automation', subcategories: [] },
]

function renderPanel(formData: Partial<Props['formData']>, onChange: Props['onChange'] = vi.fn()) {
  const draft = { ...defaultFormConfig, category: '', subcategory: '', ...formData }
  return render(<CategoryPanel formData={draft} onChange={onChange} fieldId="f" categories={CATEGORIES} />)
}

describe('CategoryPanel routing options', () => {
  // Regression: the processor copies the form's category verbatim onto every
  // submission, and every reader filters on the category NAME. Storing the id
  // tagged submissions `cat_<uuid>`, a category no filter or chart matches.
  it('labels each category while the option value is the name submissions are tagged with', async () => {
    const onChange = vi.fn()
    renderPanel({}, onChange)

    expect(screen.getByRole('option', { name: 'Ease of use' })).toHaveValue('ease_of_use')
    expect(screen.getByRole('option', { name: 'API automation' })).toHaveValue('api_automation')

    await userEvent.setup().selectOptions(screen.getByLabelText(/^category/i), 'Ease of use')
    expect(onChange).toHaveBeenCalledWith({ category: 'ease_of_use', subcategory: '' })
  })

  it('labels subcategories and sends the name when one is picked', async () => {
    const onChange = vi.fn()
    renderPanel({ category: 'ease_of_use' }, onChange)

    await userEvent.setup().selectOptions(screen.getByLabelText(/subcategory/i), 'Onboarding flow')
    expect(onChange).toHaveBeenCalledWith({ subcategory: 'onboarding_flow' })
  })

  it('still resolves a form saved with config ids, and previews the name it will store', () => {
    renderPanel({ category: 'cat_1', subcategory: 'sub_1' })

    expect(screen.getByLabelText(/^category/i)).toHaveValue('ease_of_use')
    expect(screen.getByLabelText(/subcategory/i)).toHaveValue('onboarding_flow')
    expect(screen.getByText(/category: "ease_of_use"/)).toBeInTheDocument()
  })
})
