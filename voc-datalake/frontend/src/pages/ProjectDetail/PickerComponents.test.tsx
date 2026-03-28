import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PickerSection, CheckboxItem } from './PickerComponents'

describe('PickerSection', () => {
  const defaultProps = {
    title: 'Test Section',
    expanded: true,
    onToggle: vi.fn(),
    allSelected: false,
    onToggleAll: vi.fn(),
  }

  it('renders title and children when expanded', () => {
    render(
      <PickerSection {...defaultProps}>
        <span>Child content</span>
      </PickerSection>,
    )

    expect(screen.getByText('Test Section')).toBeInTheDocument()
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('hides children when collapsed', () => {
    render(
      <PickerSection {...defaultProps} expanded={false}>
        <span>Hidden content</span>
      </PickerSection>,
    )

    expect(screen.getByText('Test Section')).toBeInTheDocument()
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument()
  })

  it('calls onToggle when title is clicked', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()

    render(
      <PickerSection {...defaultProps} onToggle={onToggle}>
        <span>Content</span>
      </PickerSection>,
    )

    await user.click(screen.getByText('Test Section'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('calls onToggleAll when select all button is clicked', async () => {
    const onToggleAll = vi.fn()
    const user = userEvent.setup()

    render(
      <PickerSection {...defaultProps} onToggleAll={onToggleAll}>
        <span>Content</span>
      </PickerSection>,
    )

    const buttons = screen.getAllByRole('button')
    // Second button is the select/deselect all toggle
    await user.click(buttons[1])
    expect(onToggleAll).toHaveBeenCalledWith(true)
  })
})

describe('CheckboxItem', () => {
  const defaultProps = {
    id: 'item-1',
    label: 'Test Item',
    checked: false,
    onChange: vi.fn(),
  }

  it('renders label and checkbox', () => {
    render(<CheckboxItem {...defaultProps} />)

    expect(screen.getByText('Test Item')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('renders checked state', () => {
    render(<CheckboxItem {...defaultProps} checked />)

    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('renders sublabel when provided', () => {
    render(<CheckboxItem {...defaultProps} sublabel="extra info" />)

    expect(screen.getByText('(extra info)')).toBeInTheDocument()
  })

  it('does not render sublabel when empty', () => {
    render(<CheckboxItem {...defaultProps} sublabel="" />)

    expect(screen.queryByText('()')).not.toBeInTheDocument()
  })

  it('calls onChange when clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    render(<CheckboxItem {...defaultProps} onChange={onChange} />)

    await user.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledOnce()
  })
})
