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
    
    // Check for the spinner element with animation class
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeTruthy()
  })

  it('renders centered container', () => {
    const { container } = render(<PageLoader />)
    
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'items-center', 'justify-center')
  })

  it('has correct height', () => {
    const { container } = render(<PageLoader />)
    
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('h-64')
  })

  it('spinner has correct styling', () => {
    render(<PageLoader />)
    
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toHaveClass('rounded-full', 'h-8', 'w-8', 'border-b-2', 'border-blue-600')
  })
})
