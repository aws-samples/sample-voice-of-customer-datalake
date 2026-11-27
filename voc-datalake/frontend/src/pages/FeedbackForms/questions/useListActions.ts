/**
 * @fileoverview What the question list does to the draft (UX §3.3, §7): add a question of a type (selected, its
 * Question field focused), move one (announced), duplicate it, delete it (asking first only when rules jump to it or
 * it may have answers; otherwise at once with Undo), and the same for endings. A new question's id and a copy's are
 * never a removed question's (`draft.retiredIds`): the server refuses one taken again.
 *
 * @module pages/FeedbackForms/questions/useListActions
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FormV2, QuestionType } from '../model/formsV2'
import { LIMITS, isChoice, isMatrix } from '../model/formsV2'
import { newEnding, newQuestion } from '../model/defaults'
import { newEndingId, newQuestionId } from '../model/codes'
import { textIn } from '../model/i18nText'
import {
  duplicateQuestion, endingIds, insertEnding, insertQuestion, moveEnding, moveQuestion, questionIds, removeEnding, removeQuestion,
  rulesTargeting,
} from '../model/mutations'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { useAnnounce } from './statusLineContext'
import { requestFocus } from './focusRequest'
import { matrixFreshKey, withDefaultScale } from './matrixOps'

/** A delete that asks first: what goes, and why the dialog says what it says. */
export interface PendingDelete {
  readonly kind: 'question' | 'ending'
  readonly id: string
  readonly rules: number
  readonly answers: boolean
}

/**
 * Focus a card's main button once the list has re-rendered. One pending focus at a time, dropped when the list goes
 * (a focus asked for by a list that is gone must not land on another page's card).
 */
function useFocusCard(): (id: string) => void {
  const frame = useRef<number | null>(null)
  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
  }, [])
  return useCallback((id: string) => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus()
    })
  }, [])
}

export function useListActions() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { go } = useBuilderUi()
  const announce = useAnnounce()
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const focusCard = useFocusCard()
  const { form } = draft
  const headlineOf = (id: string) => textIn(form.questions.find((q) => q.id === id)?.headline, form.language)

  const addQuestion = (type: QuestionType, at: number = form.questions.length) => {
    if (form.questions.length >= LIMITS.questions) return
    const id = newQuestionId(type, new Set([...questionIds(form), ...draft.retiredIds]))
    const created = newQuestion(type, id)
    // (a new matrix gets a scale in the form's language; its rows are the author's)
    const question = isMatrix(created) ? withDefaultScale(created, form.language) : created
    draft.update((current) => insertQuestion(current, question, at))
    if (isChoice(question)) draft.setFreshCodes((keys) => new Set([...keys, ...question.options.map((o) => `${id}:${o.code}`)]))
    if (isMatrix(question)) draft.setFreshCodes((keys) => new Set([...keys, ...question.rows.map((row) => matrixFreshKey(id, 'rows', row.code))]))
    requestFocus(id)
    go('questions', [id])
  }

  const move = (id: string, to: number) => {
    draft.update((current) => moveQuestion(current, id, to))
    announce({ message: t('questionList.moved', { headline: headlineOf(id) || t('question.newQuestion'), position: to + 1, total: form.questions.length }) })
    focusCard(id)
  }

  const duplicate = (id: string) => {
    const { form: next, copyId } = duplicateQuestion(form, id, draft.retiredIds)
    if (copyId === null) return
    draft.update(() => next)
    go('questions', [copyId])
  }

  /** The card selected after `id` goes: the next one, else the previous. */
  const neighbour = (ids: readonly string[], id: string): string | null => {
    const at = ids.indexOf(id)
    return ids[at + 1] ?? ids[at - 1] ?? null
  }

  const deleteNow = (kind: 'question' | 'ending', id: string, offerUndo: boolean) => {
    const before: FormV2 = form
    const ids = kind === 'question' ? form.questions.map((q) => q.id) : form.endings.map((e) => e.id)
    draft.update((current) => (kind === 'question' ? removeQuestion(current, id) : removeEnding(current, id)))
    const next = neighbour(ids, id)
    if (next !== null) {
      go('questions', kind === 'question' ? [next] : ['end', next], { replace: true })
      focusCard(next)
    }
    if (offerUndo) announce({ message: t('questionList.deleted'), undo: () => draft.update(() => before) })
  }

  const requestDelete = (kind: 'question' | 'ending', id: string) => {
    const rules = rulesTargeting(form, id)
    const answers = kind === 'question' && draft.locked
    if (rules > 0 || answers) setPending({ kind, id, rules, answers })
    else deleteNow(kind, id, true)
  }

  const confirmDelete = () => {
    if (pending === null) return
    deleteNow(pending.kind, pending.id, false)
    setPending(null)
  }

  const addEnding = () => {
    if (form.endings.length >= LIMITS.endings) return
    const id = newEndingId('thanks', endingIds(form))
    draft.update((current) => insertEnding(current, newEnding(id, current.language, t('endings.newTitle'))))
    requestFocus(id)
    go('questions', ['end', id])
  }

  const moveEndingTo = (id: string, to: number) => {
    const wasDefault = form.endings[0]?.id
    const next = moveEnding(form, id, to)
    draft.update(() => next)
    const nowDefault = next.endings[0]
    if (nowDefault !== undefined && nowDefault.id !== wasDefault) {
      announce({ message: t('endings.nowDefault', { title: textIn(nowDefault.title, form.language) }) })
    } else {
      announce({ message: t('endings.moved', { title: textIn(next.endings[to]?.title, form.language), position: to + 1, total: next.endings.length }) })
    }
    focusCard(id)
  }

  return { addQuestion, move, duplicate, requestDelete, confirmDelete, cancelDelete: () => setPending(null), pending, addEnding, moveEndingTo }
}
