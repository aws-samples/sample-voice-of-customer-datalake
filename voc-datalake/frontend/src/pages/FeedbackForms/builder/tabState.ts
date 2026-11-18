/**
 * @fileoverview Which tab a form opens on, and how many problems each tab holds (its dot in the tab row).
 * @module pages/FeedbackForms/builder/tabState
 */
import type { FormProblem } from '../model/validateForm'
import type { BuilderTab } from './builderPaths'
import type { FormDraft } from './formDraftContext'

/** The tab a form opens on (UX §1, §3.1): Results for a Live form with responses, Questions otherwise. */
export function defaultBuilderTab(draft: Pick<FormDraft, 'form' | 'meta'>): BuilderTab {
  return draft.form.enabled && (draft.meta?.response_count ?? 0) > 0 ? 'results' : 'questions'
}

const ON_QUESTIONS: ReadonlySet<string> = new Set(['question', 'ending', 'welcome'])

/** How many problems a tab holds (errors and warnings; the Languages tab counts missing translations). */
export function tabProblemCount(tab: BuilderTab, problems: readonly FormProblem[]): number {
  const listed = problems.filter((problem) => problem.severity !== 'note')
  switch (tab) {
    case 'questions': return listed.filter((p) => ON_QUESTIONS.has(p.at.kind) || p.code === 'noQuestions' || p.code === 'noEndings').length
    case 'languages': return listed.filter((p) => p.at.kind === 'language').reduce((sum, p) => sum + Number(p.params['count'] ?? 0), 0)
    case 'hidden-fields': return listed.filter((p) => p.at.kind === 'hidden').length
    case 'settings': return listed.filter((p) => p.code === 'noCategory').length
    case 'flow': case 'test': case 'share': case 'results': return 0
  }
}
