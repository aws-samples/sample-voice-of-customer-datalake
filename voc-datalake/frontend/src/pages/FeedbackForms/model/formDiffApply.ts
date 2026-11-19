/**
 * @fileoverview The form made of the AI changes the person accepted (UX §12.2), with the dependencies kept
 * consistent:
 *
 * - a rejected added question or ending takes with it the rules that go to it (`rulesTo` says which, for the sheet);
 * - a rejected removal keeps the question, and the rules that went to it (restored on the questions whose accepted
 *   new version dropped them);
 * - a rejected change keeps the item as it was; a rejected language keeps the form without its texts (and a rejected
 *   removal of one keeps them);
 * - everything outside questions, logic, endings, hidden fields, languages and the welcome card stays as it was.
 *
 * @module pages/FeedbackForms/model/formDiffApply
 */
import type { FormLanguage, FormV2, Question, Rule } from './formsV2'
import { textIn } from './i18nText'
import { removeLanguage, withoutRulesTo } from './mutations'
import { splitOtherwise, withLogic } from './rules'
import { translatableTexts } from './translatable'
import type { FormDiff } from './formDiff'
import { sameJson } from '../../../lib/sameJson'

interface Keyed {
  readonly id: string
}

type Decision = 'after' | 'before' | 'drop'

/**
 * The items in the proposal's order, with a removed item whose removal was rejected put back after the item it
 * followed; each taken from the proposal or from before as `decide` says.
 */
function assemble<T extends Keyed>(before: readonly T[], after: readonly T[], decide: (id: string, inBefore: boolean, inAfter: boolean) => Decision): T[] {
  const old = new Map(before.map((item) => [item.id, item]))
  const fresh = new Map(after.map((item) => [item.id, item]))
  const order = after.map((item) => item.id)
  before.forEach((item, index) => {
    if (fresh.has(item.id)) return
    const previous = before.slice(0, index).reverse().find((other) => order.includes(other.id))
    order.splice(previous === undefined ? 0 : order.indexOf(previous.id) + 1, 0, item.id)
  })
  return order.flatMap((id) => {
    const choice = decide(id, old.has(id), fresh.has(id))
    const item = choice === 'after' ? fresh.get(id) : old.get(id)
    return choice === 'drop' || item === undefined ? [] : [item]
  })
}

/** How one keyed item is taken: added/removed/changed by its change's acceptance, else the proposal's (= before). */
function decider(area: string, diff: FormDiff, accepted: ReadonlySet<string>) {
  const kinds = new Map(diff.changes.filter((change) => change.area === area).map((change) => [change.id, change.kind]))
  return (id: string, inBefore: boolean, inAfter: boolean): Decision => {
    const kind = kinds.get(id)
    const yes = accepted.has(`${area}:${id}`)
    if (kind === 'added') return yes ? 'after' : 'drop'
    if (kind === 'removed') return yes ? 'drop' : 'before'
    if (kind === 'changed') return yes ? 'after' : 'before'
    if (inAfter) return 'after'
    return inBefore ? 'before' : 'drop'
  }
}

/**
 * Fill `language` wherever `form` lacks it, from `source`'s texts (by translatable key), except on the items in
 * `skip` (a changed item's texts may not line up with its old ones: they show as missing instead).
 */
function carryLanguage(form: FormV2, source: FormV2, language: FormLanguage, skip: ReadonlySet<string>): FormV2 {
  const values = new Map(translatableTexts(source).map((entry) => [entry.key, textIn(entry.text, language)]))
  return translatableTexts(form).reduce((current, entry) => {
    const value = values.get(entry.key) ?? ''
    if (skip.has(entry.owner.id) || value === '' || textIn(entry.text, language) !== '') return current
    return entry.write(current, language, value)
  }, form)
}

/** The rules that `before`'s version of a question had to `target`, put back on the question when it lost them. */
function restoreRulesTo(form: FormV2, before: FormV2, target: string): FormV2 {
  return {
    ...form,
    questions: form.questions.map((question): Question => {
      const was = before.questions.find((q) => q.id === question.id)
      if (was === undefined) return question
      const old = splitOtherwise(was)
      const now = splitOtherwise(question)
      const lost: Rule[] = old.rules.filter((rule) => rule.then.jump_to === target && !now.rules.some((r) => sameJson(r, rule)))
      const otherwise = old.otherwise === target && now.otherwise !== target ? target : now.otherwise
      return lost.length === 0 && otherwise === now.otherwise ? question : withLogic(question, [...now.rules, ...lost], otherwise)
    }),
  }
}

/** Which questions' rules (in the proposal) go to `target`: "Not applied with it: the rule on 1." */
export function rulesTo(form: FormV2, target: string): number[] {
  return form.questions.flatMap((question, index) => {
    const split = splitOtherwise(question)
    return split.rules.some((rule) => rule.then.jump_to === target) || split.otherwise === target ? [index + 1] : []
  })
}

function languagesOf(before: FormV2, after: FormV2, accepted: ReadonlySet<string>): FormLanguage[] {
  const added = after.languages.filter((language) => !before.languages.includes(language) && accepted.has(`language:${language}`))
  const removed = new Set(before.languages.filter((language) => !after.languages.includes(language) && accepted.has(`language:${language}`)))
  return [...before.languages.filter((language) => !removed.has(language)), ...added]
}

/** `before` with the accepted changes of `diff` (from `before` to `after`) applied. */
export function applyChanges(before: FormV2, after: FormV2, diff: FormDiff, accepted: ReadonlySet<string>): FormV2 {
  const languages = languagesOf(before, after, accepted)
  const assembled: FormV2 = {
    ...before,
    languages: [...new Set([...before.languages, ...after.languages])],
    welcome: accepted.has('welcome') ? after.welcome : before.welcome,
    questions: assemble(before.questions, after.questions, decider('question', diff, accepted)),
    endings: assemble(before.endings, after.endings, decider('ending', diff, accepted)),
    hidden_fields: assemble(before.hidden_fields, after.hidden_fields, decider('hidden', diff, accepted)),
  }
  const rejectedAdds = diff.changes.filter((change) => change.kind === 'added' && (change.area === 'question' || change.area === 'ending') && !accepted.has(change.key))
  const keptRemovals = diff.changes.filter((change) => change.kind === 'removed' && change.area === 'question' && !accepted.has(change.key))
  const cleaned = rejectedAdds.reduce((form, change) => withoutRulesTo(form, change.id), assembled)
  const restored = keptRemovals.reduce((form, change) => restoreRulesTo(form, before, change.id), cleaned)
  // A language the AI removed and the person kept keeps its texts from before (an accepted new one came with the
  // proposal's items; an item kept as it was shows the new language as missing).
  const kept = before.languages.filter((language) => !after.languages.includes(language) && languages.includes(language))
  const changed = new Set(diff.changes.filter((change) => change.kind === 'changed' && accepted.has(change.key)).map((change) => change.id))
  const carried = kept.reduce((form, language) => carryLanguage(form, before, language, changed), restored)
  const dropped = carried.languages.filter((language) => !languages.includes(language))
  const stripped = dropped.reduce((form, language) => removeLanguage(form, language), carried)
  return { ...stripped, languages }
}
