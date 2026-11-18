/**
 * @fileoverview What a template card and its preview say about a template besides its copy: its question types with
 * their counts, where it runs, and the estimate.
 *
 * @module pages/FeedbackForms/picker/templateSummary
 */
import { useTranslation } from 'react-i18next'
import type { TemplateFlow } from '../templates/templateKit'
import type { Question } from '../model/formsV2'
import type { CopyLookup } from '../formTemplates'
import { templateForm } from '../formTemplates'
import { minutesToAnswer } from '../model/paths'
import { typeNameKey } from '../ui/typeIcons'

/** The template's question types in order of first use, each with how many questions have it. */
export function typeSummary(questions: readonly Question[]): { readonly question: Question; readonly count: number }[] {
  const groups = new Map<string, { question: Question; count: number }>()
  for (const question of questions) {
    const key = typeNameKey(question)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { question, count: 1 })
    else group.count += 1
  }
  return [...groups.values()]
}

/** No copy at all: the estimate reads only the flow. */
const NO_COPY: Readonly<Record<string, string>> = {}
const noCopy: CopyLookup = (key) => NO_COPY[key]

/** "~1 min": the longest path × 10 s (the flow's structure; its copy doesn't matter). */
export const templateMinutes = (flow: TemplateFlow): number => minutesToAnswer(templateForm(flow, 'en', noCopy))

/** "Link · Embed · In-app": where the template is meant to run, in its own order. */
export function useRunsLine(flow: TemplateFlow): string {
  const { t } = useTranslation('feedbackForms')
  return flow.runs.map((channel) => t(`picker.runs.${channel}`)).join(' · ')
}
