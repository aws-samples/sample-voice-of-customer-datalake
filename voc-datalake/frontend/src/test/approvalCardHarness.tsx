/**
 * @fileoverview A harness for the approval-card specs of the record-writing
 * tools (connectors, users): render one `ApprovalCard` for a tool call inside a
 * router and a query client, press Approve, then read the outcome, the REST
 * writes that went through the routed `fetchApi` double, and what the thread
 * would resume with.
 *
 * A spec wires `@test/fetchApiRoutes` in first (`vi.mock` of `api/client` and,
 * when it gates on admin rights, `store/authStore`), then imports this module.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { ReactNode } from 'react'
import ApprovalCard from '../assistant/approvals/ApprovalCard'
import { buildResume } from '../assistant/thread/resume'
import { approvalExpiresAt } from './assistantDoubles'
import { fetchApi } from './fetchApiRoutes'
import type { PageContext } from '../assistant/contract'
import type { ApprovalCardProps, ApprovalResolution, AssistantToolCall } from '../assistant/types'

type ResolveSpy = ReturnType<typeof vi.fn<(r: ApprovalResolution) => void>>
type User = ReturnType<typeof userEvent.setup>

export interface RenderedCard {
  onResolve: ResolveSpy
  user: User
  /** Spy on the query client's `invalidateQueries` (read `mock.calls.map(([f]) => f?.queryKey)`). */
  invalidate: MockInstance<QueryClient['invalidateQueries']>
}

/** Mount a pending, unexpired `write` approval card for `toolCall` on `page`. */
export function renderApprovalCard(toolCall: AssistantToolCall, page: PageContext, extra: Partial<ApprovalCardProps> = {}): RenderedCard {
  const onResolve = vi.fn<(r: ApprovalResolution) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></MemoryRouter>
  )
  const props: ApprovalCardProps = {
    interrupt: {
      id: `approval:${toolCall.id}`, toolCallId: toolCall.id, message: 'Proposed.', expiresAt: approvalExpiresAt(),
      metadata: { toolName: toolCall.name, risk: 'write' },
    },
    page,
    onResolve,
    toolCall,
    ...extra,
  }
  render(<ApprovalCard {...props} />, { wrapper })
  return { onResolve, user: userEvent.setup(), invalidate }
}

/** Queries scoped to the field-table row `key` (`data-testid="field-<key>"`). */
export const fieldOf = (key: string) => within(screen.getByTestId(`field-${key}`))

/** The outcome the card reported, once it has. */
export const outcomeOf = (onResolve: ResolveSpy) => onResolve.mock.calls.at(0)?.[0].outcome

function parsedBody(options: RequestInit | undefined): unknown {
  return typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
}

/** Every non-GET call that went through `fetchApi`, in order: `[path, method, parsed body]`. */
export function writes(): Array<[string, string | undefined, unknown]> {
  return fetchApi.mock.calls
    .filter(([, options]) => options?.method !== undefined && options.method !== 'GET')
    .map(([path, options]) => [path, options?.method, parsedBody(options)])
}

/** Press Approve and wait for the card to report its outcome. */
export async function approve(user: User, onResolve: ResolveSpy): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(onResolve.mock.calls).toHaveLength(1))
}

/** The parsed content of the `tool` message the thread resumes with after the card resolved. */
export function resumedToolMessage(onResolve: ResolveSpy, toolCallId: string): unknown {
  const resolution = onResolve.mock.calls.at(0)?.[0]
  const interruptId = `approval:${toolCallId}`
  const interrupt = { id: interruptId, toolCallId, expiresAt: approvalExpiresAt() }
  const { toolMessages } = buildResume([interrupt], resolution === undefined ? {} : { [interruptId]: resolution })
  return JSON.parse(String(toolMessages.at(0)?.content))
}
