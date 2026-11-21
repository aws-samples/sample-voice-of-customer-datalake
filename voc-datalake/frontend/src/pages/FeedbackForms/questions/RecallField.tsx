/**
 * @fileoverview A text field where recall works (7.61.00, docs/feedback-forms.md "Recall"): the welcome's title and
 * description, a question's headline and subheader, an ending's title and description. Beside its label, "Insert a
 * value" (`{}`) lists what the text may recall where it stands (model/recall.ts `recallChoices`: the hidden fields,
 * then the earlier scores and single choices) and inserts `{{id}}` at the caret; under it, while the text holds a
 * placeholder, how respondents read it with a value (each shown as ‹its name›, `renderRecall`). How it reads without
 * one is the widget's preview's (the widget tidies the text around the gap). Labels, buttons and addresses use the
 * plain `TextField`: recall never works there.
 *
 * @module pages/FeedbackForms/questions/RecallField
 */
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Braces } from 'lucide-react'
import type { FormV2 } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { placeholders, recallChoices, renderRecall } from '../model/recall'
import ActionsMenu from '../ui/ActionsMenu'
import type { MenuAction } from '../ui/ActionsMenu'
import { useDraft } from '../builder/formDraftContext'
import { TextField } from './fields'
import type { TextFieldProps } from './fields'
import type { FormProblem } from '../model/validateForm'

type Field = HTMLInputElement & HTMLTextAreaElement

/** The sample values of the preview: each hidden field and earlier question the text may recall, as ‹its name›. */
function sampleValues(form: FormV2, before: number): Record<string, string> {
  const { hidden, questions } = recallChoices(form, before)
  return Object.fromEntries([
    ...hidden.map((field) => [field.id, `‹${field.label ?? field.id}›`] as const),
    ...questions.map((q) => [q.id, `‹${textIn(q.headline, form.language) || q.id}›`] as const),
  ])
}

/** What the menu offers: each value the text may recall where it stands (its id and its words). */
function insertChoices(t: TFunction<'feedbackForms'>, form: FormV2, before: number): { readonly id: string; readonly label: string }[] {
  const { hidden, questions } = recallChoices(form, before)
  return [
    ...hidden.map((field) => ({ id: field.id, label: t('recall.hiddenItem', { name: field.label ?? field.id }) })),
    ...questions.map((q) => ({
      id: q.id, label: t('recall.questionItem', { number: form.questions.indexOf(q) + 1, headline: textIn(q.headline, form.language) || q.id }),
    })),
  ]
}

/** The one item of an empty menu, which is off: ActionsMenu never selects an item with a `disabledReason`. */
function selectNothing(): void {
  // (nothing to insert: the item only says why)
}

/** A recall text's field: a text field's own props (never an address, a hint or the slots this field fills itself), its
 * problems always given, and where the text stands. */
type RecallFieldProps = Omit<TextFieldProps, 'action' | 'below' | 'hint' | 'mono' | 'type' | 'problems'> & Readonly<{
  problems: readonly FormProblem[]
  /** The questions placed before the text (the welcome: 0; question n: n - 1; an ending: all of them). */
  before: number
}>

export default function RecallField({ before, ...props }: RecallFieldProps) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  // (the field is found in its wrapper when a value is inserted: the caller's `inputRef` stays the field's own)
  const wrapper = useRef<HTMLDivElement>(null)
  const { value, onChange } = props
  const insert = (id: string) => {
    const element = wrapper.current?.querySelector<Field>('input, textarea') ?? null
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? start
    const token = `{{${id}}}`
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`)
    window.requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const recalls = placeholders(value).length > 0
  const below = recalls ? (
    <p className="mt-1 text-[12px] text-muted">{t('recall.preview', { text: renderRecall(value, sampleValues(form, before)) })}</p>
  ) : undefined
  const choices = insertChoices(t, form, before)
  const items: MenuAction[] = choices.length === 0
    ? [{ label: t('recall.nothing'), disabledReason: t('recall.nothingHint'), onSelect: selectNothing }]
    : choices.map((choice) => ({ label: choice.label, onSelect: () => insert(choice.id) }))
  return (
    <div ref={wrapper}>
      <TextField {...props} below={below} action={<ActionsMenu label={t('recall.insert')} icon={Braces} items={items} />} />
    </div>
  )
}
