/**
 * @fileoverview "New board": a name, a template (each with one line on what it starts with) and the
 * share-link slug the name gives. Everything the template sets stays editable after creation.
 * @module pages/Settings/boards/CreateBoardDialog
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import ModalShell from '../../../components/ModalShell/ModalShell'
import { BOARD_LIMITS, BOARD_TEMPLATES } from '../../../api/boardFields'
import type { BoardTemplate } from '../../../api/boardFields'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'
import { afterBoardWrite, boardAdminApi } from './boardAdminQueries'
import { TEMPLATE_COPY, boardErrorMessage } from './boardCopy'
import { slugFromName } from './boardDraft'
import DescribedRadios from './DescribedRadios'

function TemplateChoice({ value, onChange }: Readonly<{ value: BoardTemplate; onChange: (next: BoardTemplate) => void }>) {
  const { t } = useTranslation('settings')
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted mb-1">{t('boards.create.template')}</legend>
      <DescribedRadios<BoardTemplate> options={BOARD_TEMPLATES} copy={TEMPLATE_COPY} value={value} className="space-y-2"
        onChange={onChange} />
    </fieldset>
  )
}

export default function CreateBoardDialog({ onClose, onCreated }: Readonly<{
  onClose: () => void
  onCreated: (board: FeatureBoard) => void
}>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const titleId = useId()
  const nameId = useId()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<BoardTemplate>('sales')
  const slug = slugFromName(name)
  const create = useMutation({
    // A name with no ASCII letters gives no slug: the server then derives one.
    mutationFn: () => boardAdminApi.createBoard({ name: name.trim(), template, ...(slug === '' ? {} : { slug }) }),
    onSuccess: async (board) => {
      await afterBoardWrite(queryClient, board)
      onCreated(board)
    },
  })
  const ready = name.trim() !== '' && !create.isPending
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg">
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">{t('boards.create.title')}</h2>
          <p className="dialog-description">{t('boards.create.hint')}</p>
        </div>
      </div>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate() }}>
        <div className="dialog-body space-y-3">
          <div className="space-y-1">
            <label htmlFor={nameId} className="block text-[12px] font-medium text-muted">{t('boards.editor.name')}</label>
            <input id={nameId} className="input w-full" value={name} maxLength={BOARD_LIMITS.name}
              onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted break-all">
              {slug === '' ? t('boards.create.slugLater') : t('boards.create.slugPreview', { slug })}
            </p>
          </div>
          <TemplateChoice value={template} onChange={setTemplate} />
          {create.isError ? <p role="alert" className="text-[12px] text-danger">{boardErrorMessage(create.error, t)}</p> : null}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('boards.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {create.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {t('boards.create.submit')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
