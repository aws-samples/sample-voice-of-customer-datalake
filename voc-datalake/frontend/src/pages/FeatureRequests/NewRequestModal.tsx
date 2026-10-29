/**
 * @fileoverview "New request": the title and description (its hint and whether it is required by
 * the board's template), the board's template fields (kind,
 * severity, area, …) and the board's own support fields of the reporter (customer and revenue on a
 * sales board). Only enabled fields show; a required one says so. The name is prefilled from the
 * viewer or this browser.
 *
 * @module pages/FeatureRequests/NewRequestModal
 */
import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModalShell from '../../components/ModalShell/ModalShell'
import { REQUEST_LIMITS, emptySupportDraft, rememberName, supportSpecOf, supportValuesOf } from './boardFormat'
import SupportFields from './SupportFields'
import TemplateFields from './TemplateFields'
import DescriptionField from './DescriptionField'
import { TextField } from './FormFields'
import WriteError from './WriteError'
import { useCurrentBoard } from './boardContext'
import { useBoardWrite } from './useBoardQueries'
import { useSupportDraft } from './useSupportDraft'
import { descriptionError, templateValuesOf, validateTemplateFields } from './templateDraft'
import type { BoardTemplate } from '../../api/boardFields'
import type { NewRequestInput } from '../../api/featureRequestsApi'
import type { TemplateDraft } from './templateDraft'
import { FORM_ERRORS } from './boardLabels'

/** Title/description errors as message keys, once the visitor tried to send (the description by the board's template). */
function requestErrors(title: string, description: string, template: BoardTemplate): { title?: string; description?: string } {
  const descriptionKey = descriptionError(description, template)
  return {
    ...(title.trim() === '' ? { title: FORM_ERRORS.title.messageKey } : {}),
    ...(descriptionKey === undefined ? {} : { description: descriptionKey }),
  }
}

/** The draft of everything but the reporter's support fields, validated on submit. */
function useRequestDraft() {
  const board = useCurrentBoard()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<TemplateDraft>({})
  const [tried, setTried] = useState(false)
  const errors = tried ? requestErrors(title, description, board.template) : {}
  const templateErrors = tried ? validateTemplateFields(template, board.fields) : {}
  return {
    title, setTitle, description, setDescription, template, setTemplate, errors, templateErrors,
    /** Marks the draft as submitted; true when it may be sent. */
    attempt: (): boolean => {
      setTried(true)
      return Object.keys(requestErrors(title, description, board.template)).length === 0
        && Object.keys(validateTemplateFields(template, board.fields)).length === 0
    },
  }
}

export default function NewRequestModal({ initialName, onCreated, onClose }: Readonly<{
  initialName: string
  onCreated: (requestId: string) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  const headingId = useId()
  const board = useCurrentBoard()
  const spec = supportSpecOf(board.fields, 'request')
  const request = useRequestDraft()
  const support = useSupportDraft(emptySupportDraft(initialName, spec), spec)
  const create = useBoardWrite(
    (api, input: NewRequestInput) => api.createRequest(input),
    (result) => onCreated(result.request.request_id),
  )
  const submit = () => {
    const supportValid = support.attempt()
    if (!request.attempt() || !supportValid) return
    rememberName(support.draft.name)
    create.mutate({
      title: request.title.trim(),
      description: request.description.trim(),
      name: support.draft.name.trim(),
      board: board.board_id,
      fields: { ...supportValuesOf(support.draft, spec), ...templateValuesOf(request.template, board.fields) },
    })
  }
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={headingId} panelClassName="w-full max-w-2xl">
      <div className="dialog-header">
        <div>
          <h2 id={headingId} className="dialog-title">{t('new.title')}</h2>
          <p className="dialog-description">{t('new.description', { board: board.name })}</p>
        </div>
      </div>
      <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="dialog-body space-y-3">
          <TextField label={t('form.title')} value={request.title} maxLength={REQUEST_LIMITS.title} error={request.errors.title} onChange={request.setTitle} />
          <DescriptionField template={board.template} rows={4} value={request.description}
            error={request.errors.description} onChange={request.setDescription} />
          <TemplateFields fields={board.fields} draft={request.template} errors={request.templateErrors} onChange={request.setTemplate} />
          {spec.keys.length > 0 ? <h3 className="text-sm font-medium text-text pt-2">{t('new.impactHeading')}</h3> : null}
          <SupportFields draft={support.draft} errors={support.errors} spec={spec} onChange={support.setDraft} />
          <WriteError error={create.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('actions.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {t('new.submit')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
