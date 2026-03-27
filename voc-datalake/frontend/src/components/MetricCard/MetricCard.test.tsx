/**
 * @fileoverview Tests for MetricCard component.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageSquare } from 'lucide-react'
import MetricCard from './MetricCard'

describe('MetricCard', () => {
  describe('basic rendering', () => {
    it('renders title and numeric value', () => {
      render(<MetricCard title="Total Feedback" value={1234} />)
      
      expect(screen.getByText('Total Feedback')).toBeInTheDocument()
      expect(screen.getByText('1234')).toBeInTheDocument()
    })

    it('renders title and string value', () => {
      render(<MetricCard title="Status" value="Active" />)
      
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Active')).toBeInTheDocument()
    })
  })

  describe('trend indicators', () => {
    it('displays positive change with up trend', () => {
      render(<MetricCard title="Feedback" value={100} change={15} trend="up" />)
      
      expect(screen.getByText('+15%')).toBeInTheDocument()
      expect(screen.getByLabelText(/increased by 15%/i)).toBeInTheDocument()
    })

    it('displays negative change with down trend', () => {
      render(<MetricCard title="Feedback" value={100} change={-10} trend="down" />)
      
      expect(screen.getByText('-10%')).toBeInTheDocument()
      expect(screen.getByLabelText(/decreased by 10%/i)).toBeInTheDocument()
    })

    it('displays zero change with neutral trend', () => {
      render(<MetricCard title="Feedback" value={100} change={0} trend="neutral" />)
      
      expect(screen.getByText('0%')).toBeInTheDocument()
      expect(screen.getByLabelText(/no change by 0%/i)).toBeInTheDocument()
    })

    it('does not display change when not provided', () => {
      render(<MetricCard title="Feedback" value={100} />)
      
      expect(screen.queryByText(/%/)).not.toBeInTheDocument()
    })
  })

  describe('icon and color themes', () => {
    it('renders icon with blue color theme by default', () => {
      render(
        <MetricCard 
          title="Messages" 
          value={50} 
          icon={<MessageSquare data-testid="icon" />}
        />
      )
      
      // eslint-disable-next-line testing-library/no-node-access
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-blue-50', 'text-blue-600')
    })

    it('renders icon with green color theme', () => {
      render(
        <MetricCard 
          title="Positive" 
          value={80} 
          icon={<MessageSquare data-testid="icon" />}
          color="green"
        />
      )
      
      // eslint-disable-next-line testing-library/no-node-access
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-green-50', 'text-green-600')
    })

    it('renders icon with red color theme', () => {
      render(
        <MetricCard 
          title="Urgent" 
          value={5} 
          icon={<MessageSquare data-testid="icon" />}
          color="red"
        />
      )
      
      // eslint-disable-next-line testing-library/no-node-access
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-red-50', 'text-red-600')
    })

    it('renders icon with orange color theme', () => {
      render(
        <MetricCard 
          title="Pending" 
          value={12} 
          icon={<MessageSquare data-testid="icon" />}
          color="orange"
        />
      )
      
      // eslint-disable-next-line testing-library/no-node-access
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-orange-50', 'text-orange-600')
    })

    it('renders without icon when not provided', () => {
      render(<MetricCard title="Simple" value={42} />)
      
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument()
    })
  })
})
