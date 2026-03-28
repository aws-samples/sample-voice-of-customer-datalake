/**
 * @fileoverview Tests for PageLoader component
 * @module components/PageLoader/PageLoader.test
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PageLoader from './PageLoader'

describe('PageLoader', () => {
  it('renders loading spinner', () => {
    render(<PageLoader />)

    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('renders centered container', () => {
    render(<PageLoader />)

    const spinner = screen.getByRole('status')
    // eslint-disable-next-line testing-library/no-node-access
    expect(spinner.parentElement).toHaveClass('flex', 'items-center', 'justify-center')
  })

  it('has correct height', () => {
    render(<PageLoader />)

    const spinner = screen.getByRole('status')
    // eslint-disable-next-line testing-library/no-node-access
    expect(spinner.parentElement).toHaveClass('h-64')
  })

  it('spinner has correct styling', () => {
    render(<PageLoader />)

    expect(screen.getByRole('status')).toHaveClass('rounded-full', 'h-8', 'w-8', 'border-b-2', 'border-blue-600')
  })
})
