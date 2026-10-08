/**
 * @fileoverview Guards the wizard against re-hardcoding English.
 *
 * Every other test in this folder runs under `en`, where a hardcoded literal and
 * its translation are the same string — so those tests pass whether or not the
 * component is wired to i18next. This one renders under `de` and asserts the
 * German catalogue values reach the DOM, which is the only assertion that fails
 * if someone puts a literal back.
 *
 * Expected strings are read from the shipped `de` catalogue rather than written
 * out here, so rewording a translation does not break the test — only unwiring
 * a component does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sparkles } from 'lucide-react'
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages'
import { useLocale } from '../../test/i18n-locale'
import { renderWithQueryClient } from '../../test/query-client'
import DataSourceWizard from './DataSourceWizard'
import { DataSourcesStep, FeedbackFiltersStep } from './DataSourceSteps'
import { ItemSelectionStep } from './ItemSelectionStep'
import ContextSummary from './ContextSummary'
import { textsMissingFromScreen, textsPresentOnScreen } from '../component-spec-fixtures'
import { defaultContextConfig } from './types'
import {
  accentColors as colors, contextConfig, splitDocuments, wizardApiMocks,
  wizardDocuments as documents, wizardPersonas as personas,
} from './dataSourceWizard-fixtures'
import deComponents from '../../../public/locales/de/components.json'
import deCommon from '../../../public/locales/de/common.json'
// All 8 catalogues, imported statically so the separator check cannot silently
// skip a locale the way a dynamic import path could.
import enComponents from '../../../public/locales/en/components.json'
import esComponents from '../../../public/locales/es/components.json'
import frComponents from '../../../public/locales/fr/components.json'
import jaComponents from '../../../public/locales/ja/components.json'
import koComponents from '../../../public/locales/ko/components.json'
import ptComponents from '../../../public/locales/pt/components.json'
import zhComponents from '../../../public/locales/zh/components.json'

vi.mock('../../api/client', () => import('./dataSourceWizard-fixtures').then(m => m.wizardApiClientMock()))
vi.mock('../../store/configStore', () => import('./dataSourceWizard-fixtures').then(m => m.wizardConfigStoreMock()))

const de = deComponents.dataSourceWizard

describe('DataSourceWizard localization', () => {
  useLocale('de', { components: deComponents, common: deCommon })

  beforeEach(() => {
    wizardApiMocks.getSources.mockResolvedValue({ sources: {} })
    wizardApiMocks.getCategoriesConfig.mockResolvedValue({ categories: [] })
  })

  it('translates the data sources step', () => {
    render(
      <DataSourcesStep
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        showFeedback
        showPersonas
        showDocuments
        showResearch
        combineDocuments={false}
        personasCount={2}
        documentsCount={3}
        otherDocsCount={2}
        researchDocsCount={1}
      />,
    )

    expect(textsMissingFromScreen([
      de.dataSources,
      de.dataSourcesDescription,
      de.customerFeedback,
      de.customerFeedbackDescription,
      de.existingDocumentsDescription,
    ])).toStrictEqual([])
    expect(textsPresentOnScreen(['Data Sources', 'Customer Feedback'])).toStrictEqual([])
  })

  it('translates the feedback filters step, including sentiment labels shared with the summary', () => {
    render(
      <FeedbackFiltersStep
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        sources={[]}
        categories={[]}
        loadingCategories={false}
        colors={colors}
      />,
    )

    expect(textsMissingFromScreen([
      de.sources,
      de.leaveEmptyForAllSources,
      de.sentiments,
      de.timeRange,
      // Time-range options come from one interpolated key, not seven literals.
      de.lastDays.replace('{{days}}', '30'),
      de.lastYear,
      de.allTime,
      // common:sentiment.*, previously hardcoded lowercase English.
      deCommon.sentiment.positive,
      deCommon.sentiment.negative,
    ])).toStrictEqual([])
    expect(textsPresentOnScreen(['positive', 'Last 30 days'])).toStrictEqual([])
  })

  it('translates the persona and document selection step', () => {
    render(
      <ItemSelectionStep
        contextConfig={contextConfig({ usePersonas: true, useResearch: true })}
        onContextChange={vi.fn()}
        personas={personas}
        documents={documents}
        {...splitDocuments(documents)}
        combineDocuments={false}
      />,
    )

    expect(textsMissingFromScreen([
      de.selectPersonas,
      de.leaveEmptyForAllPersonas,
      de.selectResearchDocuments,
      de.leaveEmptyForAllResearch,
    ])).toStrictEqual([])
    expect(screen.queryByText('Select Personas')).not.toBeInTheDocument()
  })

  it('translates the context summary, including its "all N" fallbacks', () => {
    render(
      <ContextSummary
        config={contextConfig({ useFeedback: true, usePersonas: true, useResearch: true })}
        personas={personas}
        documents={documents}
      />,
    )

    expect(textsMissingFromScreen([
      de.contextSummary,
      // Separator is translated too, so this also pins that the ASCII colon is no
      // longer concatenated in code.
      `${de.sources}${de.labelSeparator}`,
      `${de.personas}${de.labelSeparator}`,
      de.allPersonas_other.replace('{{count}}', '2'),
      // One research doc in the fixture ⇒ the singular variant.
      de.allResearch_one.replace('{{count}}', '1'),
    ])).toStrictEqual([])
    expect(textsPresentOnScreen(['Context Summary', 'All 2 personas'])).toStrictEqual([])
  })

  // Asserted against the catalogue rather than the DOM on purpose: Testing
  // Library's default text matcher normalizes whitespace, so a rendered
  // assertion cannot tell U+00A0 from a plain space — and a plain space is
  // exactly the bug (it lets the colon wrap to the next line).
  it('uses locale-correct separator codepoints in every supported locale', () => {
    // Both tables are keyed by SupportedLanguage and the loop is driven by
    // `supportedLanguages`, so adding a locale to the app without a catalogue or
    // an expected separator is a TYPECHECK failure — stronger than asserting the
    // table's length, which pins its size but not its membership.
    const catalogues: Record<SupportedLanguage, { dataSourceWizard: { labelSeparator: string } }> = {
      en: enComponents,
      es: esComponents,
      fr: frComponents,
      de: deComponents,
      pt: ptComponents,
      ja: jaComponents,
      zh: zhComponents,
      ko: koComponents,
    }
    const expected: Record<SupportedLanguage, string> = {
      en: ':',
      es: ':',
      de: ':',
      pt: ':',
      ko: ':',
      // French sets a space before the colon, and it must not be a break
      // opportunity — hence U+00A0 rather than U+0020.
      fr: '\u00A0:',
      ja: '\uFF1A', // Full-width colon.
      zh: '\uFF1A',
    }
    for (const lang of supportedLanguages) {
      expect(
        catalogues[lang].dataSourceWizard.labelSeparator,
        `${lang} labelSeparator codepoints`,
      ).toBe(expected[lang])
    }
  })

  it('translates the wizard chrome', async () => {
    renderWithQueryClient(
      <DataSourceWizard
        title="Test Wizard"
        accentColor="accent"
        icon={<Sparkles />}
        personas={personas}
        documents={documents}
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        renderFinalStep={() => <div />}
        finalStepValid
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting={false}
        submitLabel="Generate"
      />,
    )

    // Settle the mocked getSources/getCategoriesConfig queries before asserting,
    // so their resolution can't land outside act().
    await screen.findByText(de.customerFeedback)

    // Asserted per literal fragment between the placeholders, so it neither
    // pins the step count (useWizardState's concern) nor assumes the locale
    // orders {{step}} before {{total}}.
    const stepFragments = de.stepOf.split(/\{\{\w+\}\}/).filter(f => f.trim())
    expect(textsMissingFromScreen(stepFragments, { exact: false })).toStrictEqual([])
    expect(screen.getByLabelText(de.closeWizard)).toBeInTheDocument()
    expect(textsMissingFromScreen([de.back, de.next])).toStrictEqual([])
    expect({
      englishNext: screen.queryByText('Next'),
      englishClose: screen.queryByLabelText('Close wizard'),
    }).toStrictEqual({ englishNext: null, englishClose: null })
  })
})
