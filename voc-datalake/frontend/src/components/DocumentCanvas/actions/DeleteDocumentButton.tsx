/**
 * @fileoverview Delete a document: the icon button of the page's action bar (a prose
 * document) and of a prototype's preview pane, with a spinner while the delete runs.
 * The caller asks first (its confirm dialog) and only shows it to an editor.
 *
 * @module components/DocumentCanvas/actions/DeleteDocumentButton
 */
import { Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../../Tooltip/Tooltip'

export default function DeleteDocumentButton({ isDeleting, onDeleteDoc }: Readonly<{ isDeleting: boolean; onDeleteDoc: () => void }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <Tooltip kind="label" content={t('documents.deleteDocument')}>
      <button type="button" onClick={onDeleteDoc} disabled={isDeleting} className="icon-btn p-2 hover:text-danger"
        aria-label={t('documents.deleteDocument')}>
        {isDeleting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
      </button>
    </Tooltip>
  )
}
