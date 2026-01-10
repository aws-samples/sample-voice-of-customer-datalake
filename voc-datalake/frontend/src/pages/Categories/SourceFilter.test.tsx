import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SourceFilter } from './SourceFilter'

const defaultProps = {
  selectedSource: null as string | null,
  onSourceChange: vi.fn(),
  allSources: ['twitter', 'trustpilot', 'google_reviews'],
}

describe('SourceFilter', () => {
  it('renders all sources in dropdown', () => {
    render(<SourceFilter {...defaultProps} />)

    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('All Sources')).toBeInTheDocument()
    expect(screen.getByText('twitter')).toBeInTheDocument()
    expect(screen.getByText('trustpilot')).toBeInTheDocument()
    expect(screen.getByText('google_reviews')).toBeInTheDocument()
  })

  it('calls onSourceChange when source selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceFilter {...defaultProps} onSourceChange={onChange} />)

    await user.selectOptions(screen.getByRole('combobox'), 'twitter')
    expect(onChange).toHaveBeenCalledWith('twitter')
  })

  it('calls onSourceChange with null when All Sources selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceFilter {...defaultProps} selectedSource="twitter" onSourceChange={onChange} />)

    await user.selectOptions(screen.getByRole('combobox'), '')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('shows clear button when source is selected', () => {
    render(<SourceFilter {...defaultProps} selectedSource="twitter" />)
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
  })

  it('hides clear button when no source selected', () => {
    render(<SourceFilter {...defaultProps} selectedSource={null} />)
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
  })

  it('calls onSourceChange with null when clear clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SourceFilter {...defaultProps} selectedSource="twitter" onSourceChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /clear/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('shows selected source badge', () => {
    render(<SourceFilter {...defaultProps} selectedSource="trustpilot" />)
    expect(screen.getAllByText('trustpilot')).toHaveLength(2) // dropdown + badge
  })
})
