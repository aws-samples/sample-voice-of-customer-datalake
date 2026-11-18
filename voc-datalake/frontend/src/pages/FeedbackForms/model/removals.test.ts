import { describe, expect, it } from 'vitest'
import type { ChoiceQuestion, FormV2, OpenTextQuestion, Question } from './formsV2'
import { blankForm } from '../test/blankForm'
import { removalsOf } from './removals'

const reason: ChoiceQuestion = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true,
  options: [{ code: 'price', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
}
const comment: OpenTextQuestion = {
  id: 'q_comment', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text',
}

function form(questions: Question[]): FormV2 {
  return { ...blankForm('en'), name: 'Churn', questions, endings: [{ id: 'end_thanks', title: { en: 'Thanks' } }] }
}

describe('removalsOf (what a save of an answered form must name, D9)', () => {
  it('is null when the save drops nothing (an added question or option needs no naming)', () => {
    const more: ChoiceQuestion = { ...reason, options: [...reason.options, { code: 'slow', label: { en: 'Slow' } }] }
    expect(removalsOf(form([reason, comment]), form([more, comment, { ...comment, id: 'q_new' }]))).toBeNull()
  })

  it('names the question ids the save leaves out', () => {
    expect(removalsOf(form([reason, comment]), form([reason]))).toStrictEqual({ questions: ['q_comment'] })
  })

  it('names the option codes it leaves out of a question it keeps: a renamed code is a drop (plus an add)', () => {
    const renamed: ChoiceQuestion = { ...reason, options: [{ code: 'cost', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }] }
    expect(removalsOf(form([reason, comment]), form([renamed, comment]))).toStrictEqual({ options: { q_reason: ['price'] } })
  })

  it('names every code of a kept question that is no longer a choice, and a removed question only as the question', () => {
    const asText: OpenTextQuestion = { ...comment, id: 'q_reason' }
    expect(removalsOf(form([reason, comment]), form([asText]))).toStrictEqual({
      questions: ['q_comment'], options: { q_reason: ['price', 'bugs'] },
    })
    expect(removalsOf(form([reason, comment]), form([comment]))).toStrictEqual({ questions: ['q_reason'] })
  })
})
