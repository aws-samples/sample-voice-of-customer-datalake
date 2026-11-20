/**
 * The setup guide's knowledge and tenets steps (7.52.00): the prerequisites first with no connection; one connection
 * named; several in a select, the review following the repository chosen.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defined } from '@test/defined'
import { parseConnection } from '../../../api/engineeringConnectionsApi'
import { RepositoryReviewStep } from './RepositoryReviewStep'

vi.mock('./KnowledgeReview', () => ({ KnowledgeReview: ({ connection }: { connection: string }) => <p>The knowledge pack of {connection}</p> }))
vi.mock('./TenetsReview', () => ({ TenetsReview: ({ connection }: { connection: string }) => <p>The tenets of {connection}</p> }))

const connection = (id: string) => defined(parseConnection({
  connection_id: id, host: 'github', repository: `example-org/${id}`, credential: { kind: 'app_reference', set: true },
}) ?? undefined, id)

describe('RepositoryReviewStep', () => {
  it('asks for a repository connection first when there is none', () => {
    render(<RepositoryReviewStep kind="knowledge" connections={[]} />)
    expect(screen.getByText('Connect a repository first (Prerequisites): its knowledge and tenets come here.')).toBeInTheDocument()
  })

  it('names the one repository it reviews', () => {
    render(<RepositoryReviewStep kind="tenets" connections={[connection('storefront')]} />)
    expect(screen.getByText('For example-org/storefront')).toBeInTheDocument()
    expect(screen.getByText('The tenets of storefront')).toBeInTheDocument()
  })

  it('reviews the repository chosen among several', async () => {
    render(<RepositoryReviewStep kind="knowledge" connections={[connection('storefront'), connection('payments')]} />)
    expect(screen.getByText('The knowledge pack of storefront')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Repository'), 'payments')
    expect(screen.getByText('The knowledge pack of payments')).toBeInTheDocument()
  })
})
