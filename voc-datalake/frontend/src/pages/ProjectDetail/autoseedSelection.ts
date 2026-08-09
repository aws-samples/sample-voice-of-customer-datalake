/**
 * Selection → autoseed request rules, shared by both Kiro delivery paths.
 *
 * Lives in its own module rather than in McpAccessTab.tsx because a `.tsx` that
 * exports helpers alongside components trips `react-refresh/only-export-components`,
 * and because both the Export card's clipboard copy and Card 2's `curl` URL build
 * their request from these functions — one definition, not two drifting copies.
 */

/**
 * Builds the `personaIds` / `documentIds` filter params for the autoseed API.
 *
 * A filter is sent only when the selection is a strict subset: the server returns
 * everything when the param is absent, which is correct for "all selected".
 *
 * ⚠️ It is NOT correct for "none selected", and the API cannot express that —
 * `persona_ids=` is falsy server-side and read as "all". So a zero-size selection
 * for a non-empty section would silently export the very items the user
 * deselected. **Callers must prevent that state**; `canCopyExport` is the check.
 */
export function buildAutoseedParams(
  selectedPersonaIds: ReadonlySet<string>,
  totalPersonas: number,
  selectedDocumentIds: ReadonlySet<string>,
  totalDocuments: number,
): { personaIds?: string[]; documentIds?: string[] } {
  return {
    personaIds: selectedPersonaIds.size > 0 && selectedPersonaIds.size < totalPersonas
      ? [...selectedPersonaIds]
      : undefined,
    documentIds: selectedDocumentIds.size > 0 && selectedDocumentIds.size < totalDocuments
      ? [...selectedDocumentIds]
      : undefined,
  }
}

/**
 * Whether the export selection can be sent safely.
 *
 * Every NON-EMPTY section must have at least one item selected. A section with
 * zero available items imposes nothing, but a section that has items and none
 * selected is unsendable: per `buildAutoseedParams`, the API reads an absent
 * filter as "all", so exporting in that state would include the items the user
 * just deselected.
 *
 * Shared so the button, the copy handler, the curl URL and the tests all use one
 * definition of the rule rather than four drifting copies.
 */
export function canCopyExport(
  selectedPersonaIds: ReadonlySet<string>,
  totalPersonas: number,
  selectedDocumentIds: ReadonlySet<string>,
  totalDocuments: number,
): boolean {
  const personasOk = totalPersonas === 0 || selectedPersonaIds.size > 0
  const documentsOk = totalDocuments === 0 || selectedDocumentIds.size > 0
  const hasAnything = totalPersonas > 0 || totalDocuments > 0
  return hasAnything && personasOk && documentsOk
}
