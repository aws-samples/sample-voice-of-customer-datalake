/**
 * TabContent - Renders the active tab content
 */
import ChatTab from './ChatTab'
import DocumentsTab from './DocumentsTab'
import McpAccessTab from './McpAccessTab'
import OverviewTab from './OverviewTab'
import PersonasTab from './PersonasTab'
import ProductTab from './ProductTab'
import type {
  Tab, NoteItem,
} from './types'
import type {
  Project, ProjectPersona, ProjectDocument, ProductContext,
} from '../../api/types'

interface TabContentProps {
  readonly activeTab: Tab
  readonly project: Project
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  /** For the Overview card's completeness display; undefined until it loads. */
  readonly productContext?: ProductContext
  readonly selectedPersona: ProjectPersona | null
  readonly selectedDoc: ProjectDocument | null
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
  readonly onGeneratePersonas: () => void
  readonly onGenerateDoc: () => void
  readonly onRunResearch: () => void
  readonly onRemixDocuments: () => void
  readonly onOpenProductTool: () => void
  readonly onSaveKiroPrompt: (prompt: string) => void
  readonly onSelectPersona: (p: ProjectPersona | null) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onImportPersona: () => void
  readonly onSelectDoc: (d: ProjectDocument | null) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  readonly onSaveAsDocument: (content: string) => void
  /** The Product tab saved the context; the Overview card's copy needs the new one. */
  readonly onContextSaved?: (context: ProductContext) => void
  readonly onDocumentChanged?: () => void
  /** A long-running job was kicked off; the Background Jobs panel takes it from here. */
  readonly onJobStarted?: () => void
}

export default function TabContent({
  activeTab,
  project,
  personas,
  documents,
  productContext,
  selectedPersona,
  selectedDoc,
  isDeleting,
  isSavingNotes,
  onGeneratePersonas,
  onGenerateDoc,
  onRunResearch,
  onRemixDocuments,
  onOpenProductTool,
  onSaveKiroPrompt,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onImportPersona,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  onSaveAsDocument,
  onContextSaved,
  onDocumentChanged,
  onJobStarted,
}: TabContentProps) {
  if (activeTab === 'overview') {
    return (
      <OverviewTab
        project={project}
        personas={personas}
        documents={documents}
        productContext={productContext}
        onGeneratePersonas={onGeneratePersonas}
        onGenerateDoc={onGenerateDoc}
        onRunResearch={onRunResearch}
        onRemixDocuments={onRemixDocuments}
        onOpenProductTool={onOpenProductTool}
        // Same callback DocumentsTab uses for prototype *revisions* — the build
        // now starts from the Overview card, so both ends of the prototype
        // lifecycle hand off to the one jobs panel.
        onJobStarted={onJobStarted}
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

  if (activeTab === 'product') {
    return (
      <ProductTab
        projectId={project.project_id}
        onContextSaved={onContextSaved}
        onJobStarted={onJobStarted}
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
        onJobStarted={onJobStarted}
        isDeleting={isDeleting}
      />
    )
  }

  if (activeTab === 'chat') {
    return (
      <ChatTab
        projectId={project.project_id}
        personas={personas}
        documents={documents}
        onSaveAsDocument={onSaveAsDocument}
        onDocumentChanged={onDocumentChanged}
      />
    )
  }

  return (
    <McpAccessTab
      projectId={project.project_id}
      project={project}
      personas={personas}
      documents={documents}
      onSaveKiroPrompt={onSaveKiroPrompt}
    />
  )
}
