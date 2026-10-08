/**
 * ProjectModals - Renders all modals for the project detail page
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DocumentModal from './DocumentModal'
import type { DocumentEditorProps } from './DocumentModal'
import { isVersionManagedDocument } from '../../api/documentLineage'
import { documentRevision } from './documentEdit'
import ImportPersonaModal from './ImportPersonaModal'
import PersonaEditModal from './PersonaEditModal'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  ProjectPersona,
} from '../../api/projectTypes'

interface PersonaEditModalWrapperProps {
  readonly editingPersona: ProjectPersona | null
  readonly isSaving: boolean
  readonly onChange: (p: ProjectPersona | null) => void
  readonly onSave: () => Promise<unknown>
  readonly onClose: () => void
}

export function PersonaEditModalWrapper({
  editingPersona,
  isSaving,
  onChange,
  onSave,
  onClose,
}: PersonaEditModalWrapperProps) {
  if (!editingPersona) return null

  return (
    <PersonaEditModal
      persona={editingPersona}
      onChange={onChange}
      onSave={onSave}
      onClose={onClose}
      isSaving={isSaving}
    />
  )
}

interface ImportPersonaModalWrapperProps {
  readonly showModal: boolean
  readonly importType: 'image' | 'text'
  readonly importContent: string
  readonly importFileName: string
  readonly importMediaType: string
  readonly isImporting: boolean
  readonly onTypeChange: (type: 'image' | 'text') => void
  readonly onContentChange: (content: string) => void
  readonly onFileChange: (file: File) => void
  readonly onClose: () => void
  readonly onImport: () => void
}

export function ImportPersonaModalWrapper({
  showModal,
  importType,
  importContent,
  importFileName,
  importMediaType,
  isImporting,
  onTypeChange,
  onContentChange,
  onFileChange,
  onClose,
  onImport,
}: ImportPersonaModalWrapperProps) {
  if (!showModal) return null

  return (
    <ImportPersonaModal
      importType={importType}
      importContent={importContent}
      importFileName={importFileName}
      importMediaType={importMediaType}
      isImporting={isImporting}
      onTypeChange={onTypeChange}
      onContentChange={onContentChange}
      onFileChange={onFileChange}
      onClose={onClose}
      onImport={onImport}
    />
  )
}

interface DocumentModalWrapperProps extends DocumentEditorProps {
  readonly showModal: boolean
  readonly editingDoc: ProjectDocument | null
}

export function DocumentModalWrapper({
  showModal,
  editingDoc,
  title,
  content,
  isSaving,
  onTitleChange,
  onContentChange,
  onSave,
  onClose,
  conflict,
}: DocumentModalWrapperProps) {
  if (!showModal && !editingDoc) return null

  return (
    <DocumentModal
      // A new key per loaded revision: "Load the latest" reopens the editor on fresh
      // text, which its unsaved-changes guard must take as the new baseline.
      key={editingDoc === null ? 'new' : `${editingDoc.document_id}:${documentRevision(editingDoc) ?? 0}`}
      isEditing={!!editingDoc}
      title={title}
      titleReadOnly={editingDoc != null && isVersionManagedDocument(editingDoc)}
      content={content}
      isSaving={isSaving}
      onTitleChange={onTitleChange}
      onContentChange={onContentChange}
      onSave={onSave}
      onClose={onClose}
      conflict={conflict}
    />
  )
}

interface ConfirmModalWrapperProps {
  readonly type: 'persona' | 'document' | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmModalWrapper({
  type,
  onConfirm,
  onCancel,
}: ConfirmModalWrapperProps) {
  const { t } = useTranslation('projectDetail')
  if (!Boolean(type)) return null

  const title = type === 'persona' ? t('confirmDelete.personaTitle') : t('confirmDelete.documentTitle')
  const message = type === 'persona' ? t('confirmDelete.personaMessage') : t('confirmDelete.documentMessage')

  return (
    <ConfirmModal
      isOpen={type != null}
      title={title}
      message={message}
      confirmLabel={t('confirmDelete.confirm')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
