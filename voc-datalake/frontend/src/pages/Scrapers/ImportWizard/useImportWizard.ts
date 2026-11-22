/**
 * @fileoverview The import wizard's state and its calls (7.67.00, docs/import-wizard.md): Upload (read the file, ask
 * the server what each column holds), Map (the target and each column's kind, every one overridable), Confirm (the
 * inferred questions of a survey; a reviews file's mapping) and First insights (the import, then its results).
 *
 * @module pages/Scrapers/ImportWizard/useImportWizard
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { importWizardApi } from '../../../api/importWizardApi'
import type { DetectRequest } from '../../../api/importWizardApi'
import type {
  ColumnKind, DateOrder, DetectAnswer, ImportTarget, InferredForm, RowRefusal, RowsImported,
} from '../../../api/importWizardSchema'
import { useInvalidateFeedbackData } from '../../../api/invalidateFeedbackData'
import { useDimensionsConfig } from '../../../hooks/useDimensions'
import { isSupportedLanguage } from '../../../i18n/languages'
import { serverReason } from '../../../lib/errors'
import { inferredQuestions } from './inferredQuestions'
import { MAX_SURVEY_BYTES, distinctValues, pickProblem, readWizardFile, sampleOf, tableOf, toCsv } from './wizardFile'
import type { FilePickProblem, Table, WizardFile } from './wizardFile'
import { ROWS_PER_CALL, chunksOf, formName, importTag, wizardMappingProblem, reviewsMapping } from './wizardMapping'
import type { MappingProblem } from './wizardMapping'

export type WizardStep = 'upload' | 'map' | 'confirm' | 'insights'

/** Where the imported rows can be read back: this import's tag (reviews) or the form's channel (a survey). */
export interface ImportOutcome {
  readonly target: ImportTarget
  readonly accepted: number
  readonly refused: readonly RowRefusal[]
  readonly refusedCount: number
  readonly filter: { readonly tag?: string; readonly channel?: string }
  readonly source: string
  readonly formId?: string
  /** A survey's NPS questions (First insights reads the NPS from the form's Results). */
  readonly npsQuestionIds: readonly string[]
}

interface Detected {
  readonly file: WizardFile
  readonly answer: DetectAnswer
  readonly table: Table
}

interface ImportProgress {
  readonly done: number
  readonly total: number
}

export type ConfirmProblem = MappingProblem | 'surveyTooLarge' | 'noForm'

const MANUAL_IMPORT_SOURCE = 'manual_import'
const FORM_SOURCE = 'feedback_form'

/** The key (no `s3://bucket/`) of the original file the first import call kept, if it kept one. */
function keptKey(first: RowsImported | undefined): string | undefined {
  const uri = first?.raw_s3_key
  return typeof uri === 'string' && uri !== '' ? uri.replace(/^s3:\/\/[^/]+\//u, '') : undefined
}

function failure(error: unknown, fallback: string): string {
  return serverReason(error) ?? fallback
}

function reviewsCsv(detected: Detected): { text: string; delimiter: string } {
  const { file, answer, table } = detected
  return file.format === 'csv' || file.format === 'tsv' ? { text: file.content, delimiter: answer.delimiter }
    : { text: toCsv(table), delimiter: ',' }
}

export function useImportWizard() {
  const { t, i18n } = useTranslation('scrapers')
  const { data: dimensionsConfig } = useDimensionsConfig()
  const invalidateFeedbackData = useInvalidateFeedbackData()
  const [step, setStep] = useState<WizardStep>('upload')
  const [pickError, setPickError] = useState<FilePickProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detected, setDetected] = useState<Detected | null>(null)
  const [kinds, setKinds] = useState<Record<string, ColumnKind>>({})
  const [target, setTarget] = useState<ImportTarget>('reviews')
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy')
  const [form, setForm] = useState<InferredForm | null>(null)
  const [name, setName] = useState('')
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const language = isSupportedLanguage(i18n.language) ? i18n.language : 'en'

  const detect = useCallback((file: WizardFile, extra: Partial<DetectRequest>) =>
    importWizardApi.detect({ format: file.format, ...sampleOf(file), language, ...extra }), [language])

  const pick = useCallback(async (picked: File | null) => {
    setError(null)
    setPickError(null)
    setDetected(null)
    if (picked === null) return
    const problem = pickProblem(picked)
    if (problem !== null) {
      setPickError(problem)
      return
    }
    setBusy(true)
    try {
      const file = await readWizardFile(picked)
      const answer = await detect(file, {})
      setDetected({ file, answer, table: tableOf(file, answer.delimiter, answer.table) })
      setKinds({ ...answer.suggested.mapping })
      setTarget(answer.suggested.target)
      setDateOrder(answer.suggested.date_order)
      setForm(answer.suggested.form)
      setName(formName(file.name))
    } catch (e) {
      setError(failure(e, t('importWizard.errors.detect')))
    } finally {
      setBusy(false)
    }
  }, [detect, t])

  const setKind = useCallback((header: string, kind: ColumnKind) => {
    setKinds((current) => ({ ...current, [header]: kind }))
  }, [])

  /** To Confirm: a survey's form inferred again from the kinds chosen and the whole file's values. */
  const toConfirm = useCallback(async () => {
    if (detected === null) return
    setError(null)
    if (target === 'reviews') {
      setStep('confirm')
      return
    }
    setBusy(true)
    try {
      const answer = await detect(detected.file, {
        delimiter: detected.answer.delimiter, mapping: kinds, values: distinctValues(detected.table, kinds),
        target, date_order: dateOrder,
      })
      setForm(answer.suggested.form)
      setStep('confirm')
    } catch (e) {
      setError(failure(e, t('importWizard.errors.detect')))
    } finally {
      setBusy(false)
    }
  }, [dateOrder, detect, detected, kinds, t, target])

  const importReviews = useCallback(async (current: Detected): Promise<ImportOutcome> => {
    const tag = importTag(new Date())
    const { text, delimiter } = reviewsCsv(current)
    setProgress({ done: 0, total: current.table.rows.length })
    const result = await importWizardApi.uploadReviews({
      csv_text: text, delimiter, mapping: reviewsMapping(kinds, dimensionsConfig?.dimensions ?? []),
      date_order: dateOrder, import_tag: tag,
    })
    setProgress({ done: current.table.rows.length, total: current.table.rows.length })
    return { target: 'reviews', accepted: result.imported_count, refused: [], refusedCount: 0, filter: { tag },
             source: MANUAL_IMPORT_SOURCE, npsQuestionIds: [] }
  }, [dateOrder, dimensionsConfig?.dimensions, kinds])

  const importSurvey = useCallback(async (current: Detected, inferred: InferredForm): Promise<ImportOutcome> => {
    const formId = await importWizardApi.createImportedForm({
      name, definition: inferred.definition,
      imported: { from: 'file', at: new Date().toISOString(), filename: current.file.name },
    })
    const results: RowsImported[] = []
    const total = current.table.rows.length
    for (const chunk of chunksOf(current.table.rows, ROWS_PER_CALL)) {
      setProgress({ done: chunk.offset, total })
      // The original file rides the first call; every later one names the object the first kept.
      const kept = keptKey(results[0])
      results.push(await importWizardApi.importRows(formId, {
        rows: chunk.items, mapping: inferred.mapping, date_order: dateOrder, offset: chunk.offset,
        ...(results.length === 0 ? { file: { name: current.file.name, format: current.file.format,
                                             content: current.file.content } } : {}),
        ...(kept === undefined ? {} : { file_key: kept }),
      }))
    }
    setProgress({ done: total, total })
    const accepted = results.reduce((sum, result) => sum + result.accepted, 0)
    const refusedCount = results.reduce((sum, result) => sum + result.refused_count, 0)
    const refused = results.flatMap((result) => result.refused)
    return { target: 'survey', accepted, refused, refusedCount, filter: { channel: `form_${formId}` },
             source: FORM_SOURCE, formId,
             npsQuestionIds: inferredQuestions(inferred).filter((q) => q.type === 'nps').map((q) => q.id) }
  }, [dateOrder, name])

  const start = useCallback(async () => {
    if (detected === null) return
    setBusy(true)
    setError(null)
    try {
      const result = target === 'survey' && form !== null ? await importSurvey(detected, form)
        : await importReviews(detected)
      setOutcome(result)
      if (result.accepted > 0) invalidateFeedbackData({ afterIngest: true })
      setStep('insights')
    } catch (e) {
      setError(failure(e, t('importWizard.errors.import')))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [detected, form, importReviews, importSurvey, invalidateFeedbackData, t, target])

  const confirmProblem = ((): ConfirmProblem | null => {
    const problem = wizardMappingProblem(kinds, target)
    if (problem !== null) return problem
    if (target !== 'survey') return null
    if ((detected?.file.size ?? 0) > MAX_SURVEY_BYTES) return 'surveyTooLarge'
    return form === null ? 'noForm' : null
  })()

  const reset = useCallback(() => {
    setStep('upload')
    setDetected(null)
    setOutcome(null)
    setError(null)
    setPickError(null)
  }, [])

  return {
    step, setStep, pick, pickError, busy, error, detected, kinds, setKind, target, setTarget, dateOrder, setDateOrder,
    form, name, setName, toConfirm, start, progress, outcome, confirmProblem, reset,
  }
}

export type ImportWizardState = ReturnType<typeof useImportWizard>
