/**
 * ProjectModals - Renders all modals for the project detail page
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal'
import DocumentModal from './DocumentModal'
import ImportPersonaModal from './ImportPersonaModal'
import PersonaEditModal from './PersonaEditModal'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

interface PersonaEditModalWrapperProps {
  readonly editingPersona: ProjectPersona | null
  readonly isSaving: boolean
  readonly onChange: (p: ProjectPersona | null) => void
  readonly onSave: () => void
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
  readonly importType: 'pdf' | 'image' | 'text'
  readonly importContent: string
  readonly importFileName: string
  readonly importMediaType: string
  readonly isImporting: boolean
  readonly onTypeChange: (type: 'pdf' | 'image' | 'text') => void
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

interface DocumentModalWrapperProps {
  readonly showModal: boolean
  readonly editingDoc: ProjectDocument | null
  readonly title: string
  readonly content: string
  readonly isSaving: boolean
  readonly onTitleChange: (title: string) => void
  readonly onContentChange: (content: string) => void
  readonly onSave: () => void
  readonly onClose: () => void
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
}: DocumentModalWrapperProps) {
  if (!showModal && !editingDoc) return null

  return (
    <DocumentModal
      isEditing={!!editingDoc}
      title={title}
      content={content}
      isSaving={isSaving}
      onTitleChange={onTitleChange}
      onContentChange={onContentChange}
      onSave={onSave}
      onClose={onClose}
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
