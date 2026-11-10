import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { normalizeDimensionsConfig } from '../../api/dimensionsSchema'
import { dimensionsWire } from '@test/dimensionFixtures'
import { AttributeFilterControls } from './AttributeFilterControls'

const dimensions = normalizeDimensionsConfig(dimensionsWire).dimensions

function renderControls(overrides: Partial<Parameters<typeof AttributeFilterControls>[0]> = {}) {
  const props = {
    channels: ['review', 'app_store'], channel: null, onChannelChange: vi.fn(),
    tags: ['vip'], tag: null, onTagChange: vi.fn(),
    dimensions, dimensionFilter: {}, onDimensionFilterChange: vi.fn(),
    ...overrides,
  }
  render(<AttributeFilterControls {...props} />)
  return props
}

describe('AttributeFilterControls', () => {
  it("narrows a child dimension's options by the parent's value", () => {
    renderControls({ dimensionFilter: { product: 'mobile_app' } })
    const options = Array.from(screen.getByLabelText('Module').querySelectorAll('option')).map((o) => o.value)
    expect(options).toStrictEqual(['', 'login', 'search'])
  })

  it('drops a child value that no longer fits when the parent changes', async () => {
    const user = userEvent.setup()
    const props = renderControls({ dimensionFilter: { product: 'mobile_app', module: 'login' } })
    await user.selectOptions(screen.getByLabelText('Product'), 'web_shop')
    expect(props.onDimensionFilterChange).toHaveBeenCalledWith({ product: 'web_shop' })
  })

  it('reports channel and tag choices, and keeps a linked value the window lacks', async () => {
    const user = userEvent.setup()
    const props = renderControls({ tag: 'from_link' })
    await user.selectOptions(screen.getByLabelText('Filter by channel'), 'app_store')
    expect(props.onChannelChange).toHaveBeenCalledWith('app_store')
    expect(screen.getByLabelText('Filter by tag')).toHaveValue('from_link')
  })

  it('renders nothing when there is nothing to filter by', () => {
    renderControls({ channels: [], tags: [], dimensions: [] })
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })
})
