/**
 * ProjectModals - Renders all modals for the project detail page
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
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
  /** The persona's voice is editable (a project persona with `features.voice`, 7.69.00). */
  readonly showVoice?: boolean
}

export function PersonaEditModalWrapper({
  editingPersona,
  isSaving,
  onChange,
  onSave,
  onClose,
  showVoice,
}: PersonaEditModalWrapperProps) {
  if (!editingPersona) return null

  return (
    <PersonaEditModal
      persona={editingPersona}
      onChange={onChange}
      onSave={onSave}
      onClose={onClose}
      isSaving={isSaving}
      showVoice={showVoice}
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
