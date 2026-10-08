/**
 * Custom hook for managing modal state in ProjectDetail
 */
import {
  useState, useCallback,
} from 'react'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  ProjectPersona,
} from '../../api/projectTypes'

export function useSelectionState() {
  const [selectedPersona, setSelectedPersona] = useState<ProjectPersona | null>(null)
  const [editingPersona, setEditingPersona] = useState<ProjectPersona | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<ProjectDocument | null>(null)

  return {
    selectedPersona,
    setSelectedPersona,
    editingPersona,
    setEditingPersona,
    selectedDoc,
    setSelectedDoc,
  }
}

export function useDocModalState() {
  const [showDocModal, setShowDocModal] = useState(false)
  const [editingDoc, setEditingDoc] = useState<ProjectDocument | null>(null)
  const [newDocTitle, setNewDocTitle] = useState('')
  const [newDocContent, setNewDocContent] = useState('')

  const openCreateModal = useCallback(() => {
    setShowDocModal(true)
  }, [])

  const openEditModal = useCallback((doc: ProjectDocument) => {
    setEditingDoc(doc)
    setNewDocTitle(doc.title)
    setNewDocContent(doc.content)
  }, [])

  const closeModal = useCallback(() => {
    setShowDocModal(false)
    setEditingDoc(null)
    setNewDocTitle('')
    setNewDocContent('')
  }, [])

  const resetAfterSave = useCallback(() => {
    setEditingDoc(null)
    setNewDocTitle('')
    setNewDocContent('')
  }, [])

  return {
    showDocModal,
    setShowDocModal,
    editingDoc,
    newDocTitle,
    setNewDocTitle,
    newDocContent,
    setNewDocContent,
    openCreateModal,
    openEditModal,
    closeModal,
    resetAfterSave,
  }
}

export function useImportModalState() {
  const [showImportModal, setShowImportModal] = useState(false)
  // 'text' remains the default and is still a valid type, so the modal always
  // opens on a rendered section rather than a blank one.
  const [importType, setImportType] = useState<'image' | 'text'>('text')
  const [importContent, setImportContent] = useState('')
  const [importMediaType, setImportMediaType] = useState('')
  const [importFileName, setImportFileName] = useState('')

  const handleTypeChange = useCallback((type: 'image' | 'text') => {
    setImportType(type)
    setImportContent('')
    setImportFileName('')
  }, [])

  const handleFileChange = useCallback((file: File) => {
    setImportFileName(file.name)
    setImportMediaType(file.type)
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        // A data URL always carries the comma; '' only if a reader ever answers without one.
        const base64 = result.split(',').at(1) ?? ''
        setImportContent(base64)
      }
    }
    reader.readAsDataURL(file)
  }, [])

  const closeModal = useCallback(() => {
    setShowImportModal(false)
    setImportContent('')
    setImportFileName('')
    setImportMediaType('')
  }, [])

  return {
    showImportModal,
    setShowImportModal,
    importType,
    importContent,
    setImportContent,
    importMediaType,
    importFileName,
    handleTypeChange,
    handleFileChange,
    closeModal,
  }
}

export function useConfirmModalState() {
  const [confirmModal, setConfirmModal] = useState<{
    type: 'persona' | 'document' | null;
    id: string | null
  }>({
    type: null,
    id: null,
  })

  const openPersonaConfirm = useCallback((id: string) => {
    setConfirmModal({
      type: 'persona',
      id,
    })
  }, [])

  const openDocumentConfirm = useCallback((id: string) => {
    setConfirmModal({
      type: 'document',
      id,
    })
  }, [])

  const closeConfirm = useCallback(() => {
    setConfirmModal({
      type: null,
      id: null,
    })
  }, [])

  return {
    confirmModal,
    openPersonaConfirm,
    openDocumentConfirm,
    closeConfirm,
  }
}
