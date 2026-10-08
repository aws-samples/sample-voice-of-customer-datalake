/**
 * TabContent - Renders the active tab content
 */
import DocumentsTab from './DocumentsTab'
import OverviewTab from './OverviewTab'
import PersonasTab from './PersonasTab'
import ProductTab from './ProductTab'
import CompanyContextStrip from './CompanyContextStrip'
import type {
  Tab, NoteItem,
} from './types'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  Project,
  ProjectPersona,
  ProductContext,
  ProductDoc,
} from '../../api/projectTypes'

interface TabContentProps {
  readonly activeTab: Tab
  readonly project: Project
  /**
   * `canEditProject(project)`, decided once by the page. Passed to the tabs that
   * have no `project` of their own (Personas, Product); the others derive it from
   * the project they already receive.
   */
  readonly canEdit: boolean
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  /** For the Overview card's completeness display; undefined until it loads. */
  readonly productContext?: ProductContext
  /** For the prototype card's visual picker; undefined until it loads, or if it failed. */
  readonly productDocs?: ProductDoc[]
  readonly selectedPersona: ProjectPersona | null
  readonly selectedDoc: ProjectDocument | null
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
  readonly onGeneratePersonas: () => void
  readonly onGenerateDoc: () => void
  readonly onRunResearch: () => void
  readonly onRemixDocuments: () => void
  readonly onOpenProductTool: () => void
  readonly onSelectPersona: (p: ProjectPersona | null) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onImportPersona: () => void
  readonly onSelectDoc: (d: ProjectDocument | null) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  /** The Product tab saved the context; the Overview card's copy needs the new one. */
  readonly onContextSaved?: (context: ProductContext) => void
  /** A long-running job was kicked off; the Background Jobs panel takes it from here. */
  readonly onJobStarted?: () => void
}

export default function TabContent({
  activeTab,
  project,
  canEdit,
  personas,
  documents,
  productContext,
  productDocs,
  selectedPersona,
  selectedDoc,
  isDeleting,
  isSavingNotes,
  onGeneratePersonas,
  onGenerateDoc,
  onRunResearch,
  onRemixDocuments,
  onOpenProductTool,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onImportPersona,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  onContextSaved,
  onJobStarted,
}: TabContentProps) {
  if (activeTab === 'overview') {
    return (
      <OverviewTab
        project={project}
        personas={personas}
        documents={documents}
        productContext={productContext}
        productDocs={productDocs}
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
        projectId={project.project_id}
        personas={personas}
        canEdit={canEdit}
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
      <div className="space-y-4">
        <CompanyContextStrip />
        <ProductTab
          projectId={project.project_id}
          canEdit={canEdit}
          onContextSaved={onContextSaved}
          onJobStarted={onJobStarted}
        />
      </div>
    )
  }

  return (
    <DocumentsTab
      project={project}
      documents={documents}
      // Only so a revision can drop a visual that has since been deleted —
      // the API 404s on an id it cannot resolve, which would make a
      // visually-grounded prototype unrevisable for good.
      productDocs={productDocs}
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
