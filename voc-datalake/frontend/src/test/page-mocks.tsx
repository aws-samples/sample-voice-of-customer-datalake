/**
 * @fileoverview `vi.mock` factories the page specs used to restate verbatim:
 * the `useConfigStore` hook, `react-router-dom` with a spied `useNavigate`, and
 * a ConfirmModal stand-in.
 *
 * `vi.mock` is hoisted above imports, so a spec reaches these through a
 * dynamic import inside the factory (the same convention as `./api-mocks`):
 *
 * ```ts
 * vi.mock('../../store/configStore', () => import('@test/page-mocks').then((m) => m.configStoreHookMock(STATE)))
 * vi.mock('react-router-dom', () => import('@test/page-mocks').then((m) => m.routerWithNavigateSpy()))
 * vi.mock('../../components/ConfirmModal/ConfirmModal', () => import('@test/page-mocks').then((m) => m.confirmModalMock('Confirm Delete')))
 * ```
 */
import { vi } from 'vitest'

/** `useConfigStore()` (the hook form) answering `state` on every render. */
export function configStoreHookMock(state: Readonly<Record<string, unknown>>) {
  return { useConfigStore: vi.fn(() => state) }
}

/**
 * The real `react-router-dom`, except `useNavigate` returns {@link navigateSpy}.
 * The spy lives here, not in the spec, because the factory can run while a
 * spec-level `const mockNavigate = vi.fn()` is still in its temporal dead zone
 * (any hoisted import of the router triggers it). A spec imports the spy to
 * assert on it; each spec file gets its own module instance.
 */
export const navigateSpy = vi.fn()

export async function routerWithNavigateSpy() {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateSpy }
}

interface ConfirmModalStubProps {
  readonly isOpen: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly title: string
}

/** A ConfirmModal that renders its title and two plain buttons while open. */
export function confirmModalMock(confirmLabel: string) {
  return {
    default: ({ isOpen, onConfirm, onCancel, title }: ConfirmModalStubProps) =>
      isOpen ? (
        <div data-testid="confirm-modal">
          <span>{title}</span>
          <button onClick={onConfirm}>{confirmLabel}</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      ) : null,
  }
}
