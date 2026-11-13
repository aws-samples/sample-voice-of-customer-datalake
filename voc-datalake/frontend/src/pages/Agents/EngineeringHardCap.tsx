/**
 * @fileoverview Agents → Spend: the administrators' opt-in hard cap (engineering/settings.py), off by default. On, a
 * run's first start with its flow's monthly budget gets a cost cap of what is left of the flow's month, and does not
 * start when nothing is left. The cap is set per run at its start (runs of one flow at once may together pass its
 * budget), and counts MicroVM time only until tokens are priced.
 *
 * @module pages/Agents/EngineeringHardCap
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import SwitchField from '../../components/SwitchField/SwitchField'
import { engineeringSettingsApi, engineeringSettingsKeys } from '../../api/engineeringSpendApi'
import { useConfigStore } from '../../store/configStore'
import type { EngineeringSettings } from '../../api/engineeringSpendApi'

export function EngineeringHardCap() {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const queryClient = useQueryClient()
  const read = useQuery({ queryKey: engineeringSettingsKeys.settings(), queryFn: engineeringSettingsApi.get, enabled: configured })
  const save = useMutation({
    mutationFn: engineeringSettingsApi.setHardCap,
    onSuccess: (saved: EngineeringSettings) => { queryClient.setQueryData(engineeringSettingsKeys.settings(), saved) },
  })
  const settings = read.data
  if (settings === undefined) {
    return read.isError
      ? <LoadFailed message={t('spend.hardCapUnread')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
      : null
  }
  return (
    <div className="card p-4 space-y-1">
      {/* (never disabled while a change is saved: a disabled switch would lose its keyboard focus; a click meanwhile
          is ignored) */}
      <SwitchField checked={settings.hard_cap} label={t('spend.hardCap')} hint={t('spend.hardCapHint')}
        onChange={(on) => { if (!save.isPending) save.mutate(on) }} />
      {save.isError && <p role="alert" className="text-[12px] text-danger">{t('spend.hardCapFailed')}</p>}
    </div>
  )
}
