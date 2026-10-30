/**
 * TabContent - Renders the active tab content
 */
import DocumentsTab from './DocumentsTab'
import DecisionsTab from './decisions/DecisionsTab'
import OverviewTab, { type OverviewTabProps } from './OverviewTab'
import PersonasTab from './PersonasTab'
import { projectPersonaScope } from './personaScope'
import ProductTab from './ProductTab'
import ParticipantsTab from './ParticipantsTab'
import type {
  Tab, NoteItem,
} from './types'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  ProjectPersona,
} from '../../api/projectTypes'

/** The fields the page hands straight through to the Overview tab. */
type OverviewPassThrough = Pick<OverviewTabProps,
  'project' | 'personas' | 'documents' | 'productContext' | 'productDocs' | 'designSystem'
  | 'onGeneratePersonas' | 'onGenerateDoc' | 'onRunResearch' | 'onRemixDocuments' | 'onOpenProductTool' | 'onJobStarted'>

interface TabContentProps extends OverviewPassThrough {
  readonly activeTab: Tab
  /**
   * `canEditProject(project)`, decided once by the page. Passed to the tabs that
   * have no `project` of their own (Personas, Product); the others derive it from
   * the project they already receive.
   */
  readonly canEdit: boolean
  readonly selectedPersona: ProjectPersona | null
  readonly selectedDoc: ProjectDocument | null
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
  readonly onSelectPersona: (p: ProjectPersona | null) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onImportPersona: () => void
  /** Opens "Copy from…" (the library or another project); editors only. */
  readonly onCopyPersonas: () => void
  readonly onSelectDoc: (d: ProjectDocument | null) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
}

export default function TabContent({
  activeTab,
  project,
  canEdit,
  personas,
  documents,
  productContext,
  productDocs,
  designSystem,
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
  onCopyPersonas,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
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
        designSystem={designSystem}
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
        scope={projectPersonaScope(project.project_id)}
        personas={personas}
        canEdit={canEdit}
        selectedPersona={selectedPersona}
        onSelectPersona={onSelectPersona}
        onEditPersona={onEditPersona}
        onDeletePersona={onDeletePersona}
        onSaveNotes={onSaveNotes}
        onGeneratePersonas={onGeneratePersonas}
        onImportPersona={onImportPersona}
        onCopyPersonas={canEdit ? onCopyPersonas : undefined}
        isDeleting={isDeleting}
        isSavingNotes={isSavingNotes}
      />
    )
  }

  if (activeTab === 'product') {
    return (
      <ProductTab projectId={project.project_id} canEdit={canEdit} onJobStarted={onJobStarted} />
    )
  }

  if (activeTab === 'participants') {
    return <ParticipantsTab projectId={project.project_id} canEdit={canEdit} />
  }

  if (activeTab === 'decisions') {
    return <DecisionsTab projectId={project.project_id} documents={documents} canEdit={canEdit} onJobStarted={onJobStarted} />
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
