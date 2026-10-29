/**
 * @fileoverview Tests for MetricCard component.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageSquare } from 'lucide-react'
import MetricCard from './MetricCard'
import { useLocale } from '../../test/i18n-locale'
import componentsDe from '../../../public/locales/de/components.json'

/** The decorative icon every production card passes. */
const ICON = <MessageSquare aria-hidden="true" />

describe('MetricCard', () => {
  describe('basic rendering', () => {
    it('renders title and a numeric value grouped in the app language', () => {
      render(<MetricCard icon={ICON} title="Total Feedback" value={26622} />)

      expect(screen.getByText('Total Feedback')).toBeInTheDocument()
      expect(screen.getByText('26,622')).toBeInTheDocument()
    })

    it('marks an approximate value with a leading "~"', () => {
      render(<MetricCard icon={ICON} title="Total Feedback" value={1234} approximate />)

      expect(screen.getByText('~1,234')).toBeInTheDocument()
    })

    it('renders title and string value', () => {
      render(<MetricCard icon={ICON} title="Status" value="Active" />)
      
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Active')).toBeInTheDocument()
    })
  })

  describe('trend indicators', () => {
    it('displays positive change with up trend', () => {
      render(<MetricCard icon={ICON} title="Feedback" value={100} change={15} trend="up" />)
      
      expect(screen.getByText('+15%')).toBeInTheDocument()
      expect(screen.getByLabelText(/increased by 15%/i)).toBeInTheDocument()
    })

    it('displays negative change with down trend', () => {
      render(<MetricCard icon={ICON} title="Feedback" value={100} change={-10} trend="down" />)
      
      expect(screen.getByText('-10%')).toBeInTheDocument()
      expect(screen.getByLabelText(/decreased by 10%/i)).toBeInTheDocument()
    })

    it('displays zero change with neutral trend', () => {
      render(<MetricCard icon={ICON} title="Feedback" value={100} change={0} trend="neutral" />)
      
      expect(screen.getByText('0%')).toBeInTheDocument()
      expect(screen.getByLabelText('No change (0%)')).toBeInTheDocument()
    })

    it('keeps a fractional change instead of rounding it away', () => {
      render(<MetricCard icon={ICON} title="Feedback" value={100} change={12.5} trend="up" />)

      expect(screen.getByText('+12.5%')).toBeInTheDocument()
      expect(screen.getByLabelText('Increased by 12.5%')).toBeInTheDocument()
    })

    it('does not display change when not provided', () => {
      render(<MetricCard icon={ICON} title="Feedback" value={100} />)
      
      expect(screen.queryByText(/%/)).not.toBeInTheDocument()
    })
  })

  describe('icon and color themes', () => {
    it('renders icon with the accent tone by default', () => {
      render(
        <MetricCard 
          title="Messages" 
          value={50} 
          icon={<MessageSquare data-testid="icon" />}
        />
      )
      
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-accent-subtle', 'text-accent')
    })

    it('renders icon with the ok tone', () => {
      render(
        <MetricCard 
          title="Positive" 
          value={80} 
          icon={<MessageSquare data-testid="icon" />}
          color="ok"
        />
      )
      
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-ok-subtle', 'text-ok')
    })

    it('renders icon with the danger tone', () => {
      render(
        <MetricCard 
          title="Urgent" 
          value={5} 
          icon={<MessageSquare data-testid="icon" />}
          color="danger"
        />
      )
      
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-danger-subtle', 'text-danger')
    })

    it('renders icon with the warn tone', () => {
      render(
        <MetricCard 
          title="Pending" 
          value={12} 
          icon={<MessageSquare data-testid="icon" />}
          color="warn"
        />
      )
      
      const iconContainer = screen.getByTestId('icon').parentElement
      expect(iconContainer).toHaveClass('bg-warn-subtle', 'text-warn')
    })
  })

  describe('partial-data hint', () => {
    it('exposes the hint as tooltip and accessible label on the value', () => {
      render(<MetricCard icon={ICON} title="Total Feedback" value="~1,234" hint="Approximate: counts are a lower bound" />)

      const value = screen.getByText('~1,234')
      expect(value).toHaveAttribute('title', 'Approximate: counts are a lower bound')
      expect(value).toHaveAttribute('aria-label', '~1,234 — Approximate: counts are a lower bound')
    })

    it('adds no tooltip or aria-label without a hint', () => {
      render(<MetricCard icon={ICON} title="Total Feedback" value={1234} />)

      const value = screen.getByText('1,234')
      expect(value).not.toHaveAttribute('title')
      expect(value).not.toHaveAttribute('aria-label')
    })
  })
})

// Owner request (wave 4): tiles showed "1,2…", "Bal…", "Averag…" at 1024 px and
// in de/fr/pt. Nothing in a tile may be cut off: it wraps instead.
describe('MetricCard never cuts its text', () => {
  it.each([
    ['label', 'Durchschnittliche Stimmung'],
    ['value', 'Ausgeglichen'],
    ['detail', '42 % positiv · +0.12'],
  ])('the %s wraps instead of truncating', (_part, text) => {
    render(<MetricCard icon={ICON} title="Durchschnittliche Stimmung" value="Ausgeglichen" detail="42 % positiv · +0.12" />)
    const element = screen.getByText(text)
    expect(element).toHaveClass('break-words')
    expect(element).not.toHaveClass('truncate')
  })

  it('is a size container whose decorative icon only shows in a wide tile', () => {
    const { container } = render(<MetricCard title="Reviews" value={1247} icon={<MessageSquare data-testid="icon" />} />)
    expect(container.firstElementChild).toHaveClass('@container', '!p-0')
    expect(container.firstElementChild?.firstElementChild).toHaveClass('p-3', '@[16rem]:p-6')
    expect(screen.getByTestId('icon').parentElement).toHaveClass('hidden', '@[12rem]:block')
  })

  it('never sets the value below 18 px (text-lg) in a narrow tile', () => {
    render(<MetricCard icon={ICON} title="Reviews" value={1247} />)
    expect(screen.getByText('1,247')).toHaveClass('text-lg', '@[13rem]:text-2xl')
  })
})

describe('MetricCard in German', () => {
  useLocale('de', { components: componentsDe })

  it('says the trend in German with the German percent and decimal mark', () => {
    render(<MetricCard icon={ICON} title="Feedback" value={26622} change={-4.5} trend="down" />)

    expect(screen.getByText('26.622')).toBeInTheDocument()
    expect(screen.getByText('-4,5 %')).toBeInTheDocument()
    expect(screen.getByLabelText('Gesunken um 4,5 %')).toBeInTheDocument()
  })
})
