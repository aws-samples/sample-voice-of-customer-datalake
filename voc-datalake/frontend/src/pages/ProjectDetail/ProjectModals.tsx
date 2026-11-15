/**
 * ProjectModals - Renders all modals for the project detail page
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DocumentModal from './DocumentModal'
import type { DocumentEditorProps } from './DocumentModal'
import ImportPersonaModal from './ImportPersonaModal'
import CopyPersonasModal from './CopyPersonasModal'
import PersonaEditModal from './PersonaEditModal'
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
      isImporting={isImporting}
      onTypeChange={onTypeChange}
      onContentChange={onContentChange}
      onFileChange={onFileChange}
      onClose={onClose}
      onImport={onImport}
    />
  )
}

/** "Copy from…" (the company library or another project), mounted only while open so each opening starts fresh. */
export function CopyPersonasModalWrapper({ showModal, projectId, onClose, onCopied }: Readonly<{
  showModal: boolean
  projectId: string
  onClose: () => void
  onCopied: (copies: ProjectPersona[]) => void
}>) {
  if (!showModal) return null
  return <CopyPersonasModal projectId={projectId} onClose={onClose} onCopied={onCopied} />
}

interface DocumentModalWrapperProps extends DocumentEditorProps {
  readonly showModal: boolean
}

/** The New document dialog (create only: an existing document is edited in place on its canvas). */
export function DocumentModalWrapper({ showModal, ...editor }: DocumentModalWrapperProps) {
  if (!showModal) return null
  return <DocumentModal {...editor} />
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
