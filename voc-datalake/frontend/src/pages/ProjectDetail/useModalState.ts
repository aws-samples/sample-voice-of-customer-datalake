/**
 * Custom hook for managing modal state in ProjectDetail
 */
import {
  useState, useCallback,
} from 'react'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

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

  const openSaveAsModal = useCallback((content: string) => {
    setNewDocTitle(`Chat Response - ${new Date().toLocaleDateString()}`)
    setNewDocContent(content)
    setShowDocModal(true)
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
    openSaveAsModal,
    closeModal,
    resetAfterSave,
  }
}

export function useImportModalState() {
  const [showImportModal, setShowImportModal] = useState(false)
  const [importType, setImportType] = useState<'pdf' | 'image' | 'text'>('text')
  const [importContent, setImportContent] = useState('')
  const [importMediaType, setImportMediaType] = useState('')
  const [importFileName, setImportFileName] = useState('')

  const handleTypeChange = useCallback((type: 'pdf' | 'image' | 'text') => {
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
        const base64 = result.split(',')[1]
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
