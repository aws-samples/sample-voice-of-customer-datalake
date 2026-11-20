/**
 * @fileoverview The whole form checked as the server checks it (UX §3.6, the contract's limits): errors block Save
 * and Publish; warnings (a missing translation, a question no path reaches, a rule that never runs…) are listed but
 * never block. Each problem names where it is, so the problems popover can go to it, and a message key under
 * `feedbackForms:problems.<code>`.
 *
 * A matrix's own checks are model/matrixProblems.ts's; recall's (a `{{…}}` that cannot be filled where it stands: an
 * error that blocks Save, or one that blocks only Publish where recall never works) model/recallProblems.ts's.
 *
 * The theme's contrast (theme/contrast.ts, the server's rules in lambda/shared/form_theme.py), for every palette
 * that can be shown: text under 3:1 on its background is an error that blocks only Publish and Update live form
 * (`blocks: 'publish'`; Save still works, so nothing is lost while the colours are fixed); text from 3 to 4.5:1, a
 * primary under 3:1 and a button label under 4.5:1 are warnings.
 *
 * This is the frontend's copy of the contract's rules; `formTemplates.test.ts` checks the twelve templates against
 * it. The server's validator stays the authority (its 400 is mapped onto the same list).
 *
 * @module pages/FeedbackForms/model/validateForm
 */
import type { ChoiceQuestion, FormTheme, FormV2, OpenTextQuestion, Question, StatementQuestion } from './formsV2'
import { LIMITS, isChoice } from './formsV2'
import { keptLiveTheme, palettePairs, paletteOf, shownPalettes } from '../theme/contrast'
import type { PairId } from '../theme/contrast'
import { hasText, textIn } from './i18nText'
import { isReservedCode, isReservedHiddenId, isValidCode, isValidEndingId, isValidHiddenId, isValidQuestionId } from './codes'
import { ruleProblems } from './ruleProblems'
import type { ProblemSeverity, RuleProblemCode } from './ruleProblems'
import { formPaths } from './paths'
import { missingTexts } from './translatable'
import { reshapedIds } from './removals'
import { matrixProblems } from './matrixProblems'
import type { MatrixProblemCode } from './matrixProblems'
import { recallProblems } from './recallProblems'
import type { RecallProblemCode } from './recallProblems'

type FormProblemCode = RuleProblemCode | MatrixProblemCode | RecallProblemCode
  | 'noQuestions' | 'tooManyQuestions' | 'noEndings' | 'tooManyEndings' | 'tooManyHidden'
  | 'headlineEmpty' | 'optionEmpty' | 'endingTitleEmpty' | 'welcomeTitleEmpty' | 'consentLabelEmpty'
  | 'duplicateQuestionId' | 'invalidQuestionId' | 'retiredQuestionId' | 'answeredReshaped' | 'duplicateEndingId' | 'invalidEndingId'
  | 'duplicateHiddenId' | 'invalidHiddenId' | 'reservedHiddenId' | 'duplicateCode' | 'reservedCode' | 'invalidCode'
  | 'noOptions' | 'tooManyOptions' | 'minOverMax' | 'maxOverChoices' | 'minOverChoices'
  | 'buttonUrl' | 'buttonLabelEmpty' | 'ctaUrl' | 'contactNoField' | 'contactTwice' | 'maxCharsRange' | 'facesRange'
  | 'aiAddress' | 'missingTranslations' | 'unreachableQuestion' | 'unreachableEnding' | 'chipsLong' | 'dropdownFew'
  | 'noCategory' | 'themeUnreadable' | 'themeUnreadableLive' | 'themeTextLow' | 'themePrimaryLow' | 'themeLabelLow'

/** Where a problem is: what the popover's Go to selects, and the field it focuses. */
export interface ProblemLocation {
  /** `theme`: the form's Style, `id` the palette (`light` | `dark`), `field` its colour. */
  readonly kind: 'question' | 'ending' | 'welcome' | 'hidden' | 'language' | 'form' | 'theme'
  readonly id?: string
  readonly field?: string
  readonly ruleIndex?: number
  readonly optionIndex?: number
}

export interface FormProblem {
  readonly severity: ProblemSeverity
  readonly code: FormProblemCode
  readonly params: Readonly<Record<string, string | number>>
  readonly at: ProblemLocation
  /** `publish`: an error that blocks only Publish and Update live form; Save still works (an unreadable theme). */
  readonly blocks?: 'publish'
}

/** What the form's checks need to know beyond the form: the AI's unconfirmed addresses, the live form's theme. */
export interface ValidationContext {
  /** The `ProblemLocation`s of the https addresses the AI suggested that the person has not confirmed yet. */
  readonly unconfirmedAddresses?: readonly ProblemLocation[]
  /** The theme the stored form has while it is live (theme/contrast.ts `liveThemeOf`): kept as it is, unreadable text
   * is a warning (`themeUnreadableLive`) and never blocks Update live form; changed, it is the error again. */
  readonly liveTheme?: FormTheme
  /** The stored form's retired question ids (`retired_ids`): a question that takes one is an error, as the server's
   * 400 `question_id_reused` (an AI draft's or Improve's, or one typed in Advanced). */
  readonly retiredIds?: readonly string[]
  /** The stored form when it has a real response: a question it has whose type or range changed is an error, as the
   * server's 409 `answers_locked` (`changed`; an AI's Improve may propose one). */
  readonly answered?: FormV2 | null
}

const CHIP_LABEL_MAX = 30
const AUTO_LIST_ROWS = 6
/** An https address with a host name (an ending's or a statement's button: the contract keeps only https). */
export function isFormAddress(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' && parsed.hostname.includes('.')
  } catch {
    return false
  }
}

const formProblem = (severity: ProblemSeverity, code: FormProblemCode, at: ProblemLocation, params: Record<string, string | number> = {}): FormProblem =>
  ({ severity, code, at, params })

/** The rows a choice shows: its options, plus Other and None when on (the Auto rule counts these). */
export function choiceRows(question: ChoiceQuestion): number {
  const none = question.type === 'multi_select' && question.none.enabled ? 1 : 0
  return question.options.length + (question.other.enabled ? 1 : 0) + none
}

function choiceProblems(form: FormV2, q: ChoiceQuestion): FormProblem[] {
  const at = (field: string, optionIndex?: number): ProblemLocation => ({ kind: 'question', id: q.id, field, optionIndex })
  const found: FormProblem[] = []
  if (q.options.length === 0) found.push(formProblem('error', 'noOptions', at('options')))
  if (q.options.length > LIMITS.options) found.push(formProblem('error', 'tooManyOptions', at('options')))
  const seen = new Set<string>()
  q.options.forEach((option, index) => {
    if (!hasText(option.label, form.language)) found.push(formProblem('error', 'optionEmpty', at('option', index), { number: index + 1 }))
    if (isReservedCode(option.code)) found.push(formProblem('error', 'reservedCode', at('code', index), { code: option.code }))
    else if (!isValidCode(option.code)) found.push(formProblem('error', 'invalidCode', at('code', index), { code: option.code }))
    else if (seen.has(option.code)) found.push(formProblem('error', 'duplicateCode', at('code', index), { code: option.code }))
    seen.add(option.code)
    if (q.display === 'chips' && textIn(option.label, form.language).length > CHIP_LABEL_MAX) {
      found.push(formProblem('warning', 'chipsLong', at('display', index)))
    }
  })
  if (q.type === 'multi_select') found.push(...minMaxProblems(q, at('min')))
  if (q.type === 'multi_select' && q.display === 'dropdown' && choiceRows(q) <= AUTO_LIST_ROWS) found.push(formProblem('warning', 'dropdownFew', at('display')))
  return found
}

function minMaxProblems(q: ChoiceQuestion, at: ProblemLocation): FormProblem[] {
  const choices = q.options.length + (q.other.enabled ? 1 : 0)
  const found: FormProblem[] = []
  if (q.min !== undefined && q.max !== undefined && q.min > q.max) found.push(formProblem('error', 'minOverMax', at))
  if (q.max !== undefined && q.max > choices) found.push(formProblem('error', 'maxOverChoices', { ...at, field: 'max' }, { count: choices }))
  if (q.min !== undefined && q.min > choices) found.push(formProblem('error', 'minOverChoices', at, { count: choices }))
  return found
}

const fieldAt = (q: Question, field: string): ProblemLocation => ({ kind: 'question', id: q.id, field })
/** `found` as a one-problem list when `wrong`, else none. */
const problemsWhen = (wrong: boolean, found: () => FormProblem): FormProblem[] => (wrong ? [found()] : [])

const textLimitWrong = (q: OpenTextQuestion): boolean => q.max_chars !== undefined && (q.max_chars < 1 || q.max_chars > LIMITS.maxChars)
const ctaWrong = (q: StatementQuestion): boolean => {
  const url = q.cta?.url ?? ''
  return url !== '' && !isFormAddress(url)
}

function ownProblems(form: FormV2, q: Question): FormProblem[] {
  if (isChoice(q)) return choiceProblems(form, q)
  switch (q.type) {
    case 'open_text': return problemsWhen(textLimitWrong(q), () => formProblem('error', 'maxCharsRange', fieldAt(q, 'max_chars')))
    case 'rating': return problemsWhen(q.scale === 'smiley' && q.range > 5, () => formProblem('error', 'facesRange', fieldAt(q, 'range')))
    case 'consent': return problemsWhen(!hasText(q.label, form.language), () => formProblem('error', 'consentLabelEmpty', fieldAt(q, 'label')))
    case 'statement': return problemsWhen(ctaWrong(q), () => formProblem('error', 'ctaUrl', fieldAt(q, 'cta_url')))
    case 'contact_info': return problemsWhen(!Object.values(q.fields).some((field) => field.show), () => formProblem('error', 'contactNoField', fieldAt(q, 'fields')))
    case 'matrix': return matrixProblems(form, q)
    case 'nps': case 'csat': case 'ces': return []
  }
}

function questionProblems(form: FormV2, retired: readonly string[]): FormProblem[] {
  const ids = new Set<string>()
  const removed = new Set(retired)
  const found: FormProblem[] = []
  form.questions.forEach((q, index) => {
    const at = (field: string): ProblemLocation => ({ kind: 'question', id: q.id, field })
    if (!isValidQuestionId(q.id)) found.push(formProblem('error', 'invalidQuestionId', at('id'), { id: q.id }))
    else if (ids.has(q.id)) found.push(formProblem('error', 'duplicateQuestionId', at('id'), { id: q.id }))
    else if (removed.has(q.id)) found.push(formProblem('error', 'retiredQuestionId', at('id'), { id: q.id }))
    ids.add(q.id)
    if (!hasText(q.headline, form.language)) found.push(formProblem('error', 'headlineEmpty', at('headline'), { number: index + 1 }))
    found.push(...ownProblems(form, q))
    found.push(...ruleProblems(form, index).map((rule) => formProblem(rule.severity, rule.code, { kind: 'question', id: q.id, field: 'logic', ruleIndex: rule.ruleIndex }, rule.params)))
  })
  const contacts = form.questions.filter((q) => q.type === 'contact_info')
  contacts.slice(1).forEach((q) => found.push(formProblem('error', 'contactTwice', { kind: 'question', id: q.id })))
  return found
}

function endingProblems(form: FormV2): FormProblem[] {
  const ids = new Set<string>()
  return form.endings.flatMap((ending) => {
    const at = (field: string): ProblemLocation => ({ kind: 'ending', id: ending.id, field })
    const found: FormProblem[] = []
    if (!isValidEndingId(ending.id)) found.push(formProblem('error', 'invalidEndingId', at('id'), { id: ending.id }))
    else if (ids.has(ending.id)) found.push(formProblem('error', 'duplicateEndingId', at('id'), { id: ending.id }))
    ids.add(ending.id)
    if (!hasText(ending.title, form.language)) found.push(formProblem('error', 'endingTitleEmpty', at('title')))
    if (ending.button !== undefined) {
      if (!isFormAddress(ending.button.url)) found.push(formProblem('error', 'buttonUrl', at('button_url')))
      if (!hasText(ending.button.label, form.language)) found.push(formProblem('error', 'buttonLabelEmpty', at('button_label')))
    }
    return found
  })
}

function hiddenProblems(form: FormV2): FormProblem[] {
  const ids = new Set<string>()
  const found: FormProblem[] = form.hidden_fields.length > LIMITS.hiddenFields ? [formProblem('error', 'tooManyHidden', { kind: 'hidden' })] : []
  form.hidden_fields.forEach((field) => {
    const at: ProblemLocation = { kind: 'hidden', id: field.id }
    // (a reserved name, which the widget never fills, as the server refuses it: a form stored with one before
    // 7.58.00 still opens, and asks for another name before its next save)
    if (isReservedHiddenId(field.id)) found.push(formProblem('error', 'reservedHiddenId', at, { id: field.id }))
    else if (!isValidHiddenId(field.id)) found.push(formProblem('error', 'invalidHiddenId', at, { id: field.id }))
    else if (ids.has(field.id)) found.push(formProblem('error', 'duplicateHiddenId', at, { id: field.id }))
    ids.add(field.id)
  })
  return found
}

function countProblems(form: FormV2): FormProblem[] {
  const at: ProblemLocation = { kind: 'form' }
  return [
    form.questions.length === 0 ? formProblem('error', 'noQuestions', at) : null,
    form.questions.length > LIMITS.questions ? formProblem('error', 'tooManyQuestions', at) : null,
    form.endings.length === 0 ? formProblem('error', 'noEndings', at) : null,
    form.endings.length > LIMITS.endings ? formProblem('error', 'tooManyEndings', at) : null,
    form.welcome.enabled && !hasText(form.welcome.title, form.language) ? formProblem('error', 'welcomeTitleEmpty', { kind: 'welcome', field: 'title' }) : null,
  ].filter((found) => found !== null)
}

function reachProblems(form: FormV2): FormProblem[] {
  const paths = formPaths(form)
  const questions = form.questions.slice(1).filter((q) => (paths.questionWays.get(q.id) ?? 0) === 0)
    .map((q) => formProblem('warning', 'unreachableQuestion', { kind: 'question', id: q.id }))
  const endings = form.endings.slice(1).filter((e) => (paths.endingWays.get(e.id) ?? 0) === 0)
    .map((e) => formProblem('warning', 'unreachableEnding', { kind: 'ending', id: e.id }))
  return [...questions, ...endings]
}

function translationProblems(form: FormV2): FormProblem[] {
  return form.languages.filter((language) => language !== form.language).flatMap((language) => {
    const count = missingTexts(form, language).length
    return count === 0 ? [] : [formProblem('warning', 'missingTranslations', { kind: 'language', id: language }, { language, primary: form.language, count })]
  })
}

function categoryProblems(form: FormV2): FormProblem[] {
  const choices = form.questions.filter(isChoice)
  const mapped = choices.some((q) => q.options.some((option) => option.category !== undefined))
  return choices.length > 0 && !mapped && form.category === '' ? [formProblem('warning', 'noCategory', { kind: 'form', field: 'category' })] : []
}

const THEME_WARNINGS: Readonly<Record<Exclude<PairId, 'edge'>, FormProblemCode>> = {
  text: 'themeTextLow', primary: 'themePrimaryLow', label: 'themeLabelLow',
}

/**
 * A ratio as the words show it, to one decimal: rounded down when it is under its minimum, so a failing pair never
 * reads as meeting it ("2.96" is "2.9:1, below 3:1").
 */
export function shownRatio(ratio: number, minimum: number): number {
  return ratio < minimum ? Math.floor(ratio * 10) / 10 : Math.round(ratio * 10) / 10
}

/**
 * Each palette that can be shown, its pairs below their minimum (the option edge is derived from the text's). Text
 * under 3:1 is an error that blocks Publish and Update live form, except on a live form kept on the theme it already
 * has (`liveTheme`), where it is a warning, as the server only warns then.
 */
function themeProblems(form: FormV2, liveTheme: FormTheme | undefined): FormProblem[] {
  const kept = keptLiveTheme(form.theme, liveTheme)
  return shownPalettes(form.theme).flatMap((palette) => palettePairs(paletteOf(form.theme, palette)).flatMap((pair): FormProblem[] => {
    if (pair.level === 'ok' || pair.id === 'edge' || pair.ratio === null) return []
    const at: ProblemLocation = { kind: 'theme', id: palette, field: pair.colour }
    if (pair.level === 'error' && kept) return [formProblem('warning', 'themeUnreadableLive', at, { ratio: shownRatio(pair.ratio, 3) })]
    if (pair.level === 'error') {
      return [{ ...formProblem('error', 'themeUnreadable', at, { ratio: shownRatio(pair.ratio, 3) }), blocks: 'publish' }]
    }
    return [formProblem('warning', THEME_WARNINGS[pair.id], at, { ratio: shownRatio(pair.ratio, pair.minimum) })]
  }))
}

/** Every problem of the form: errors first, then warnings, then notes, each in form order. */
/** A question of an answered form given another type or range (its answers would be read anew): an error at it. */
function reshapedProblems(form: FormV2, answered: FormV2 | null): FormProblem[] {
  if (answered === null) return []
  return reshapedIds(answered, form).map((id) => formProblem('error', 'answeredReshaped', { kind: 'question', id, field: 'type' },
    { number: form.questions.findIndex((q) => q.id === id) + 1 }))
}

export function validateForm(form: FormV2, context: ValidationContext = {}): FormProblem[] {
  const all = [
    ...countProblems(form), ...questionProblems(form, context.retiredIds ?? []), ...endingProblems(form), ...hiddenProblems(form),
    ...(context.unconfirmedAddresses ?? []).map((at) => formProblem('error', 'aiAddress', at)),
    ...reshapedProblems(form, context.answered ?? null), ...recallProblems(form),
    ...themeProblems(form, context.liveTheme),
    ...reachProblems(form), ...translationProblems(form), ...categoryProblems(form),
  ]
  const rank: Record<ProblemSeverity, number> = { error: 0, warning: 1, note: 2 }
  return all.map((found, index) => ({ found, index }))
    .sort((a, b) => rank[a.found.severity] - rank[b.found.severity] || a.index - b.index)
    .map(({ found }) => found)
}

/** The problems that block Save (and so Publish too): every error but those that block only Publish. */
export const blockingProblems = (problems: readonly FormProblem[]): FormProblem[] =>
  problems.filter((found) => found.severity === 'error' && found.blocks !== 'publish')

/** The problems that block Publish and Update live form: every error, an unreadable theme's included. */
export const publishBlockingProblems = (problems: readonly FormProblem[]): FormProblem[] =>
  problems.filter((found) => found.severity === 'error')

/** The languages the form offers that are incomplete, with how many texts their respondents get in the primary. */
export function incompleteLanguages(problems: readonly FormProblem[]): readonly { readonly language: string; readonly count: number }[] {
  return problems.flatMap((found) => (found.code === 'missingTranslations' && typeof found.params.language === 'string'
    ? [{ language: found.params.language, count: Number(found.params.count) }] : []))
}

/** The problems located on one question, ending or the welcome card. */
export const problemsAt = (problems: readonly FormProblem[], kind: ProblemLocation['kind'], id?: string): FormProblem[] =>
  problems.filter((found) => found.at.kind === kind && (id === undefined || found.at.id === id))
