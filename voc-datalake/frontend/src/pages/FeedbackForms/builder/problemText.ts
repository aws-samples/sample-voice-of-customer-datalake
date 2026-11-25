/**
 * @fileoverview A problem as the builder words it (ProblemsPopover, the editors' field errors): where it is ("Q4",
 * "Ending “Thank you”", "English"), its message (`problems.<code>`, languages by their names), and where Go to
 * takes the person.
 *
 * @module pages/FeedbackForms/builder/problemText
 */
import i18n from 'i18next'
import type { TFunction } from 'i18next'
import type { FormV2 } from '../model/formsV2'
import { isFormLanguage } from '../model/formsV2'
import { headlineShown } from '../model/recall'
import type { FormProblem, ProblemLocation } from '../model/validateForm'
import { languageNames } from '../../../i18n/languages'
import { formatDecimal } from '../../../utils/numberFormat'
import type { BuilderUi } from './builderUi'

/** A theme problem's place: the Style's palette it is in. */
const themePlace = (t: TFunction<'feedbackForms'>, palette: string | undefined): string =>
  (palette === 'dark' ? t('problems.where.themeDark') : t('problems.where.themeLight'))

/** Where a problem is, as the list names it ("Q4", "Ending “Thank you”", "English"). */
export function problemPlace(t: TFunction<'feedbackForms'>, form: FormV2, at: ProblemLocation): string {
  switch (at.kind) {
    case 'question': return t('problems.where.question', { number: form.questions.findIndex((q) => q.id === at.id) + 1 })
    case 'ending': return t('problems.where.ending', { title: headlineShown(form.endings.find((e) => e.id === at.id)?.title, form.language) })
    case 'welcome': return t('problems.where.welcome')
    case 'hidden': return t('problems.where.hidden', { id: at.id ?? '' })
    case 'language': return t('problems.where.language', { language: isFormLanguage(at.id) ? languageNames[at.id] : at.id ?? '' })
    case 'form': return t('problems.where.form')
    case 'theme': return themePlace(t, at.id)
  }
}

/** The message of a problem, its language parameters as names and a contrast ratio in the person's own digits. */
export function problemMessage(t: TFunction<'feedbackForms'>, problem: FormProblem): string {
  const params = { ...problem.params }
  for (const key of ['language', 'primary'] as const) {
    const value = params[key]
    if (isFormLanguage(value)) params[key] = languageNames[value]
  }
  const { ratio } = params
  if (typeof ratio === 'number') params.ratio = formatDecimal(ratio, i18n.language, 1)
  return t(`problems.${problem.code}`, params)
}

/** Select what a problem is about (its card, tab or field). */
export function goToProblem(ui: Pick<BuilderUi, 'go'>, at: ProblemLocation): void {
  switch (at.kind) {
    case 'question': ui.go('questions', [at.id ?? '']); return
    case 'ending': ui.go('questions', ['end', at.id ?? '']); return
    case 'welcome': ui.go('questions', ['welcome']); return
    case 'hidden': ui.go('hidden-fields'); return
    case 'language': ui.go('languages', at.id === undefined ? [] : [at.id]); return
    case 'form': ui.go('settings'); return
    case 'theme': ui.go('settings', ['appearance'])
  }
}

/** What the header's problems chip (ProblemsPopover) listens for, to open its list from elsewhere in the builder. */
export const OPEN_PROBLEMS_EVENT = 'voc-form-problems:open'

/** Open the header's list of problems ("Show problems" under a Save that problems block, tabs/linkParts.tsx). */
export function openProblemsList(): void {
  window.dispatchEvent(new Event(OPEN_PROBLEMS_EVENT))
}
