/**
 * The header chrome and the time-range selector translate.
 *
 * A deployed browser run switched the app to German and found four surfaces still
 * in English on every page: the header title, its subtitle, the date-basis
 * selector, and the time-range labels including the custom-range dialog. Each was
 * an English literal in JSX, so no catalogue key existed to translate — and half
 * the keys that DID exist (`timeRange.24hFull` and its siblings) were read by
 * nothing.
 *
 * Asserted in German, not English: an English assertion passes against a
 * hardcoded literal, which is exactly the defect. The catalogue is loaded from the
 * shipped `de` files rather than a fixture, so a key added to `en` alone fails
 * here as well as in `localeParity.test.ts`.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next, { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import TimeRangeSelector from './TimeRangeSelector'
import { useConfigStore } from '../../store/configStore'
import commonDe from '../../../public/locales/de/common.json'
import commonEn from '../../../public/locales/en/common.json'

vi.mock('../../store/configStore', () => ({ useConfigStore: vi.fn() }))

const german = createInstance()

beforeAll(async () => {
  // NOT `.use(initReactI18next)`: that plugin re-points the shared `i18next`
  // singleton, which `src/test/setup.ts` initialized in English for the whole
  // suite — the English case below (and every other file in a shared worker)
  // would then render in German. `I18nextProvider` passes this instance
  // explicitly, so the plugin is unnecessary as well as harmful.
  await german.init({
    lng: 'de',
    fallbackLng: false,
    defaultNS: 'common',
    ns: ['common'],
    resources: { de: { common: commonDe } },
    interpolation: { escapeValue: false },
  })
})

const store = (overrides: Record<string, unknown> = {}) => {
  ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    timeRange: '7d',
    setTimeRange: vi.fn(),
    customDays: null,
    setCustomDays: vi.fn(),
    dateBasis: 'imported',
    setDateBasis: vi.fn(),
    ...overrides,
  })
}

const renderInGerman = () => render(
  <I18nextProvider i18n={german}><TimeRangeSelector /></I18nextProvider>,
)

beforeEach(() => {
  vi.clearAllMocks()
  store()
})

describe('the time-range selector in German', () => {
  it('names the date basis in German rather than "Imported date"', () => {
    renderInGerman()

    const toggle = screen.getByTestId('date-basis-toggle')
    expect(toggle).toHaveTextContent(commonDe.timeRange.basisImported)
    expect(toggle).not.toHaveTextContent(commonEn.timeRange.basisImported)
  })

  it('describes what the basis filters on in German', () => {
    renderInGerman()

    expect(screen.getByTestId('date-basis-toggle'))
      .toHaveAttribute('title', commonDe.timeRange.basisImportedTooltip)
  })

  it('labels the basis picker and both options in German', async () => {
    const user = userEvent.setup()
    renderInGerman()

    await user.click(screen.getByTestId('date-basis-toggle'))

    const picker = screen.getByRole('listbox', { name: commonDe.timeRange.basisLabel })
    expect(within(picker).getByText(commonDe.timeRange.basisImported)).toBeInTheDocument()
    expect(within(picker).getByText(commonDe.timeRange.basisReview)).toBeInTheDocument()
    expect(within(picker).getByText(commonDe.timeRange.basisReviewDescription))
      .toBeInTheDocument()
  })

  it('renders the 90-day preset from its own key rather than the literal "90d"', () => {
    // `all` IS the 90-day preset, and the two catalogue keys for it were unused.
    renderInGerman()

    expect(screen.getAllByRole('button', { name: commonDe.timeRange['90d'] }).length)
      .toBeGreaterThan(0)
  })

  it('translates the custom-range dialog, its field and its buttons', async () => {
    const user = userEvent.setup()
    renderInGerman()

    await user.click(screen.getAllByRole('button', {
      name: commonDe.timeRange.custom,
    })[0])

    const dialog = screen.getByRole('dialog', {
      name: commonDe.timeRange.selectCustomRange,
    })
    expect(within(dialog).getByText(commonDe.timeRange.customRange)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(commonDe.timeRange.lastNDays)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: commonDe.timeRange.apply }))
      .toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: commonDe.timeRange.cancel }))
      .toBeInTheDocument()
    expect(within(dialog).getByText(
      commonDe.timeRange.daysHint.replace('{{max}}', '90'),
    )).toBeInTheDocument()
  })

  it('renders the chosen custom window in German', () => {
    store({ timeRange: 'custom', customDays: 14 })

    renderInGerman()

    expect(screen.getAllByRole('button', {
      name: commonDe.timeRange.lastDays.replace('{{count}}', '14'),
    }).length).toBeGreaterThan(0)
  })
})

describe('the custom-days field', () => {
  it('carries a stable id and name, and a label bound to that id', async () => {
    // Screen readers and password managers both read `name`; without it the field
    // has an id nothing references from the form's perspective.
    const user = userEvent.setup()
    render(<TimeRangeSelector />)

    await user.click(screen.getAllByRole('button', {
      name: commonEn.timeRange.custom,
    })[0])

    const field = screen.getByLabelText(commonEn.timeRange.lastNDays)
    expect(field).toHaveAttribute('id', 'custom-days')
    expect(field).toHaveAttribute('name', 'custom-days')
  })
})

describe('the shipped catalogues', () => {
  it('keeps the default English instance untouched by the German fixture', () => {
    // Guards the guard: `createInstance` must not have re-pointed the shared
    // `i18next` singleton that every other test in this suite renders through.
    expect(i18next.language).not.toBe('de')
  })
})
