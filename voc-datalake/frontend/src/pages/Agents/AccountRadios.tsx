/**
 * @fileoverview The one choice of a GitHub account, a person's own or an organization's: where the deployment's GitHub
 * App is made (GitHubAppPanel) and where a fork goes (ContributeDialog, 7.57.00). Radios in a fieldset, its legend and
 * each choice's label given by the caller; and, for an organization, its login's field (`OrganizationField`).
 *
 * @module pages/Agents/AccountRadios
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

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

/** The organization's login (typed as GitHub spells it), with its hint, or why it is not one once refused. */
export function OrganizationField({ org, invalid, hint, onOrg }: Readonly<{
  org: string
  invalid: boolean
  /** What to type there, said under the field until it is refused. */
  hint: string
  onOrg: (org: string) => void
}>) {
  const { t } = useTranslation('agents')
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">{t('connections.githubApp.orgLabel')}</label>
      <input id={id} className="input font-mono" value={org} autoComplete="off" spellCheck={false} aria-invalid={invalid}
        onChange={(event) => { onOrg(event.target.value) }} />
      <p className={invalid ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
        {invalid ? t('connections.githubApp.orgInvalid') : hint}
      </p>
    </div>
  )
}
