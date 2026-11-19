/**
 * @fileoverview The one choice of a GitHub account, a person's own or an organization's: where the deployment's GitHub
 * App is made (GitHubAppPanel) and where a fork goes (ContributeDialog, 7.57.00). Radios in a fieldset, its legend and
 * each choice's label given by the caller.
 *
 * @module pages/Agents/AccountRadios
 */
import type { ReactNode } from 'react'

/** A GitHub account kind, as the App manifest and the fork workflow take it. */
export type GitHubAccount = 'user' | 'organization'

const CHOICES: readonly GitHubAccount[] = ['user', 'organization']

export function AccountRadios({ legend, labels, name, account, onAccount }: Readonly<{
  legend: ReactNode
  labels: Readonly<Record<GitHubAccount, ReactNode>>
  /** The radios' group name (unique on the page). */
  name: string
  account: GitHubAccount
  onAccount: (account: GitHubAccount) => void
}>) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-text-strong">{legend}</legend>
      {CHOICES.map((choice) => (
        <label key={choice} className="flex items-center gap-2 text-sm text-text">
          <input type="radio" name={name} value={choice} checked={account === choice} onChange={() => { onAccount(choice) }} />
          {labels[choice]}
        </label>
      ))}
    </fieldset>
  )
}
