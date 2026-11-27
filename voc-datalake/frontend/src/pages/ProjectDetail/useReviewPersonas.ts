/**
 * @fileoverview Who a persona review of a PR/FAQ or PRD asks, as the toolbar and the Review menu say it
 * (docs/document-review.md → Ask personas to review): the project's own personas; when it has none, the company's,
 * the library the server falls back to (`GET /company-personas`, the Company page's query, read only then); with
 * neither, nobody, and the review becomes "Add personas". While the library loads, or when it could not be read, it
 * is not known (null): the review is offered and the server decides (a 400 `no_personas` says why).
 *
 * @module pages/ProjectDetail/useReviewPersonas
 */
import { useQuery } from '@tanstack/react-query'
import { companyPersonasApi, companyPersonasKey } from '../../api/companyPersonasApi'
import type { ReviewPersonas } from '../../components/DocumentCanvas/actions/toolbarItems'

/** `hasProjectPersonas`: the project holds personas of its own; `enabled`: the caller may ask (else nothing is read). */
export function useReviewPersonas(hasProjectPersonas: boolean, enabled: boolean): ReviewPersonas {
  const library = useQuery({
    queryKey: companyPersonasKey(), queryFn: companyPersonasApi.list, enabled: enabled && !hasProjectPersonas,
  })
  if (hasProjectPersonas) return 'project'
  if (!library.isSuccess) return null
  return library.data.personas.length > 0 ? 'company' : 'none'
}
