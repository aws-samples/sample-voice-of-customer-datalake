/**
 * The Settings sections' shared parts: whether the brand is synced (nothing said before an endpoint or while it
 * loads, "Not synced" when its read failed), the four brand fields each writing its own value, and the categories
 * card asking for an API endpoint first.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrandFields, BrandSyncStatus, CategoriesSection } from './SettingsSections'
import type { BrandFieldValues } from './SettingsSections'

const API = 'https://api.example.com'

describe('BrandSyncStatus', () => {
  it('says nothing before an endpoint or while the brand loads', () => {
    const { container } = render(<><BrandSyncStatus apiEndpoint="" loadingSettings={false} loadFailed={false} />
      <BrandSyncStatus apiEndpoint={API} loadingSettings loadFailed={false} /></>)
    expect(container).toBeEmptyDOMElement()
  })

  it('says whether the brand reached the backend', () => {
    render(<><BrandSyncStatus apiEndpoint={API} loadingSettings={false} loadFailed />
      <BrandSyncStatus apiEndpoint={API} loadingSettings={false} loadFailed={false} /></>)
    expect(screen.getByText('Not synced')).toHaveClass('badge-warn')
    expect(screen.getByText('Synced to backend')).toHaveClass('badge-ok')
  })
})

describe('BrandFields', () => {
  it('writes each field\'s own value', async () => {
    const values: BrandFieldValues = {
      brandName: '', brandHandles: '', hashtags: '', urlsToTrack: '',
      setBrandName: vi.fn(), setBrandHandles: vi.fn(), setHashtags: vi.fn(), setUrlsToTrack: vi.fn(),
    }
    render(<BrandFields values={values} readOnly={false} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Brand Handles (comma-separated)'), '@')
    await user.type(screen.getByLabelText('Hashtags to Track (comma-separated)'), '#')
    await user.type(screen.getByLabelText('URLs to Track (one per line)'), 'h')
    expect([values.setBrandName, values.setBrandHandles, values.setHashtags, values.setUrlsToTrack].map((set) => vi.mocked(set).mock.calls))
      .toStrictEqual([[], [['@']], [['#']], [['h']]])
  })
})

describe('CategoriesSection', () => {
  it('asks for an API endpoint before it manages categories', () => {
    render(<CategoriesSection apiEndpoint="" />)
    expect(screen.getByRole('heading', { name: 'Feedback Categories' })).toBeInTheDocument()
    expect(screen.getByText('Configure the API endpoint under General → Advanced to manage categories.')).toBeInTheDocument()
  })
})
