/**
 * @fileoverview What a draft changes against another version, in words: what an update of a live form removes that
 * respondents answered (UX §3.6's confirm), and what saving mine would change in theirs after a stale save (D7's
 * Compare).
 *
 * @module pages/FeedbackForms/builder/draftChanges
 */
import type { TFunction } from 'i18next'
import type { FormV2 } from '../model/formsV2'
import { isChoice } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { headlineShown } from '../model/recall'
import { languageNames } from '../../../i18n/languages'

/** What an edit removes that a live form's respondents answered: questions, options and endings. */
export function removedParts(t: TFunction<'feedbackForms'>, baseline: FormV2, form: FormV2): string[] {
  const lng = baseline.language
  const kept = new Map(form.questions.map((q) => [q.id, q]))
  const questions = baseline.questions.filter((q) => !kept.has(q.id))
    .map((q) => t('builder.confirmRemoval.question', { text: headlineShown(q.headline, lng) }))
  const options = baseline.questions.flatMap((q) => {
    const now = kept.get(q.id)
    if (!isChoice(q) || now === undefined || !isChoice(now)) return []
    const codes = new Set(now.options.map((o) => o.code))
    return q.options.filter((o) => !codes.has(o.code)).map((o) => t('builder.confirmRemoval.option', { text: textIn(o.label, lng) }))
  })
  const endingIds = new Set(form.endings.map((e) => e.id))
  const endings = baseline.endings.filter((e) => !endingIds.has(e.id))
    .map((e) => t('builder.confirmRemoval.ending', { text: headlineShown(e.title, lng) }))
  return [...questions, ...options, ...endings]
}

export interface ConflictDifference {
  readonly kind: 'added' | 'removed' | 'changed'
  readonly label: string
}

interface Keyed {
  readonly id: string
  readonly label: string
  readonly json: string
}

function keyedParts(t: TFunction<'feedbackForms'>, form: FormV2): Keyed[] {
  const lng = form.language
  return [
    ...form.questions.map((q, index) => ({ id: q.id, label: t('logic.target.question', { number: index + 1, headline: headlineShown(q.headline, lng) }), json: JSON.stringify(q) })),
    ...form.endings.map((e) => ({ id: e.id, label: t('logic.target.ending', { title: headlineShown(e.title, lng) }), json: JSON.stringify(e) })),
    ...form.hidden_fields.map((h) => ({ id: `hidden:${h.id}`, label: t('problems.where.hidden', { id: h.id }), json: JSON.stringify(h) })),
    ...form.languages.map((l) => ({ id: `language:${l}`, label: languageNames[l], json: l })),
    { id: 'welcome', label: t('types.welcome'), json: JSON.stringify(form.welcome) },
  ]
}

/** What saving `mine` would change in `theirs`, keyed by id (questions, endings, hidden fields, languages, welcome). */
export function conflictDifferences(t: TFunction<'feedbackForms'>, theirs: FormV2, mine: FormV2): ConflictDifference[] {
  const before = new Map(keyedParts(t, theirs).map((part) => [part.id, part]))
  const after = keyedParts(t, mine)
  const afterIds = new Set(after.map((part) => part.id))
  return [
    ...after.flatMap((part): ConflictDifference[] => {
      const old = before.get(part.id)
      if (old === undefined) return [{ kind: 'added', label: part.label }]
      return old.json === part.json ? [] : [{ kind: 'changed', label: part.label }]
    }),
    ...[...before.values()].filter((part) => !afterIds.has(part.id)).map((part): ConflictDifference => ({ kind: 'removed', label: part.label })),
  ]
}
