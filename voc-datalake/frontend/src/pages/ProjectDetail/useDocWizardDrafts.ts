/**
 * @fileoverview The document wizard's two AI drafts: the title + description brief and the
 * five Working-Backwards answers.
 *
 * Both send what the person already typed (the routes keep it as their intent and only
 * improve it) and the wizard's feedback selection. A failed or empty draft leaves every
 * field as it was; an answer the AI left blank keeps what was typed there.
 * @module pages/ProjectDetail/useDocWizardDrafts
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { lenientList } from '../../api/lenientFields'
import type { AiDraftFilters } from '../../api/aiDraft'
import type { ContextConfig } from '../../components/DataSourceWizard/types'
import type { DocToolConfig } from './types'

const ANSWER_COUNT = 5

const isString = (item: unknown): item is string => typeof item === 'string'
const answerList = lenientList(isString)

/** One AI draft's state: running, its last failure, and how to start it. */
export interface AiDraft {
  readonly busy: boolean
  readonly error: string | null
  readonly run: () => Promise<void>
}

/** The wizard's feedback selection, when the person chose to use feedback. */
function feedbackFilters(context: ContextConfig): AiDraftFilters | undefined {
  if (!context.useFeedback) return undefined
  return { days: context.days, sources: context.sources, categories: context.categories, sentiments: context.sentiments }
}

/** The five typed answers, '' for an empty one (always five, in order). */
function typedAnswers(questions: readonly string[]): string[] {
  return Array.from({ length: ANSWER_COUNT }, (_, index) => questions[index] ?? '')
}

/** The drafted answers, with an answer the AI left blank keeping what was typed. */
function mergedAnswers(drafted: unknown, typed: readonly string[]): string[] {
  const answers = answerList.parse(drafted)
  return typed.map((own, index) => {
    const answer = answers[index]?.trim() ?? ''
    return answer === '' ? own : answer
  })
}

/** Runs ``draft``; a thrown error becomes the message shown under the button. */
function useDraftRunner(fallbackError: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = useCallback(async (draft: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    try {
      setError(await draft())
    } catch (e: unknown) {
      setError(e instanceof Error && e.message !== '' ? e.message : fallbackError)
    } finally {
      setBusy(false)
    }
  }, [fallbackError])
  return { busy, error, start }
}

interface DocWizardDraftsInput {
  readonly projectId: string
  readonly docConfig: DocToolConfig
  readonly contextConfig: ContextConfig
  readonly onDocConfigChange: (c: DocToolConfig) => void
}

export function useDocWizardDrafts({ projectId, docConfig, contextConfig, onDocConfigChange }: DocWizardDraftsInput) {
  const { t, i18n } = useTranslation('projectDetail')
  const briefRunner = useDraftRunner(t('wizards.draftFailed'))
  const answersRunner = useDraftRunner(t('wizards.draftFailed'))
  const filters = feedbackFilters(contextConfig)

  const runBrief = useCallback(() => briefRunner.start(async () => {
    const r = await projectsApi.suggestDocumentBrief(projectId, {
      doc_type: docConfig.docTypes.includes('prd') ? 'prd' : 'prfaq',
      title: docConfig.title,
      feature_idea: docConfig.featureIdea,
      filters,
      response_language: i18n.language,
    })
    onDocConfigChange({
      ...docConfig,
      title: r.title || docConfig.title,
      featureIdea: r.feature_idea || docConfig.featureIdea,
    })
    return r.title === '' && r.feature_idea === '' ? t('wizards.briefEmpty') : null
  }), [briefRunner, projectId, docConfig, filters, i18n.language, onDocConfigChange, t])

  const runAnswers = useCallback(() => answersRunner.start(async () => {
    const typed = typedAnswers(docConfig.customerQuestions)
    const r = await projectsApi.autofillPrfaqQuestions(projectId, {
      title: docConfig.title,
      feature_idea: docConfig.featureIdea,
      answers: typed,
      filters,
      response_language: i18n.language,
    })
    onDocConfigChange({ ...docConfig, customerQuestions: mergedAnswers(r.answers, typed) })
    return null
  }), [answersRunner, projectId, docConfig, filters, i18n.language, onDocConfigChange])

  const brief: AiDraft = { busy: briefRunner.busy, error: briefRunner.error, run: runBrief }
  const answers: AiDraft = { busy: answersRunner.busy, error: answersRunner.error, run: runAnswers }
  return { brief, answers }
}
