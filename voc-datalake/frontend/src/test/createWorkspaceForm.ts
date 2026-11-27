/**
 * @fileoverview Fill in and send the create-workspace form (pages/Settings/CreateWorkspaceForm.tsx), as a person does:
 * shared by the platform console's spec and the workspace gate's, which show the same form.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** Type `name` and `slug` into the form, then press Create workspace. */
export async function submitCreateWorkspace(name: string, slug: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Name'), name)
  await userEvent.type(screen.getByLabelText('Address (slug)'), slug)
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
}
