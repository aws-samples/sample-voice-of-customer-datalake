/**
 * TabContent - Renders the active tab content
 */
import type { Project, ProjectPersona, ProjectDocument, ProjectJob } from '../../api/client'
import type { Tab, NoteItem } from './types'
import OverviewTab from './OverviewTab'
import PersonasTab from './PersonasTab'
import DocumentsTab from './DocumentsTab'
import ChatTab from './ChatTab'

interface TabContentProps {
  readonly activeTab: Tab
  readonly project: Project
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly jobs: ProjectJob[]
  readonly selectedPersona: ProjectPersona | null
  readonly selectedDoc: ProjectDocument | null
  readonly chatMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  readonly isChatPending: boolean
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
  readonly onGeneratePersonas: () => void
  readonly onGenerateDoc: () => void
  readonly onRunResearch: () => void
  readonly onRemixDocuments: () => void
  readonly onDismissJob: (jobId: string) => void
  readonly onSaveKiroPrompt: (prompt: string) => void
  readonly onProcessAnalysis?: () => void
  readonly onFlowStepClick?: (step: string) => void
  readonly onSelectPersona: (p: ProjectPersona | null) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onImportPersona: () => void
  readonly onSelectDoc: (d: ProjectDocument | null) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  readonly onSendChat: (message: string, personaIds: string[], documentIds: string[]) => void
  readonly onSaveAsDocument: (content: string) => void
}

export default function TabContent({
  activeTab,
  project,
  personas,
  documents,
  jobs,
  selectedPersona,
  selectedDoc,
  chatMessages,
  isChatPending,
  isDeleting,
  isSavingNotes,
  onGeneratePersonas,
  onGenerateDoc,
  onRunResearch,
  onRemixDocuments,
  onDismissJob,
  onSaveKiroPrompt,
  onProcessAnalysis,
  onFlowStepClick,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onImportPersona,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  onSendChat,
  onSaveAsDocument,
}: TabContentProps) {
  if (activeTab === 'overview') {
    return (
      <OverviewTab
        project={project}
        personas={personas}
        documents={documents}
        jobs={jobs}
        onGeneratePersonas={onGeneratePersonas}
        onGenerateDoc={onGenerateDoc}
        onRunResearch={onRunResearch}
        onRemixDocuments={onRemixDocuments}
        onDismissJob={onDismissJob}
        onSaveKiroPrompt={onSaveKiroPrompt}
        onProcessAnalysis={onProcessAnalysis}
        onFlowStepClick={onFlowStepClick}
      />
    )
  }

  if (activeTab === 'personas') {
    return (
      <PersonasTab
        personas={personas}
        selectedPersona={selectedPersona}
        onSelectPersona={onSelectPersona}
        onEditPersona={onEditPersona}
        onDeletePersona={onDeletePersona}
        onSaveNotes={onSaveNotes}
        onGeneratePersonas={onGeneratePersonas}
        onImportPersona={onImportPersona}
        isDeleting={isDeleting}
        isSavingNotes={isSavingNotes}
      />
    )
  }

  if (activeTab === 'documents') {
    return (
      <DocumentsTab
        project={project}
        documents={documents}
        selectedDoc={selectedDoc}
        onSelectDoc={onSelectDoc}
        onEditDoc={onEditDoc}
        onDeleteDoc={onDeleteDoc}
        onCreateDoc={onCreateDoc}
        isDeleting={isDeleting}
      />
    )
  }

  if (activeTab === 'chat') {
    return (
      <ChatTab
        personas={personas}
        documents={documents}
        messages={chatMessages}
        isPending={isChatPending}
        onSendMessage={onSendChat}
        onSaveAsDocument={onSaveAsDocument}
      />
    )
  }

  return null
}
