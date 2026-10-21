/**
 * @fileoverview Query + mutations behind the Settings → Data Quality tab.
 *
 * One query reads the snapshot, registry fields and recent jobs, and polls only
 * while a job is running. Starting or cancelling a job invalidates it so the new
 * state shows at once, and a refusal is mapped to a message key: a 409 is a fact
 * about stored state (a job already runs for that target / the job already
 * stopped), not a failure worth retrying, so it gets its own copy.
 *
 * @module pages/Settings/useDataQuality
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import {
  cancelDataQualityJob,
  getDataQuality,
  startDataQualityJob,
} from '../../api/dataQualityApi'
import type { StartDataQualityJobBody } from '../../api/dataQualityApi'
import { DATA_QUALITY_POLL_MS, DATA_QUALITY_QUERY_KEY, hasRunningJob } from './dataQualityUtils'

export type DataQualityActionError = 'startConflict' | 'startFailed' | 'cancelConflict' | 'cancelFailed'

const CONFLICT = 409

export function useDataQuality(enabled: boolean) {
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<DataQualityActionError | null>(null)

  const query = useQuery({
    queryKey: DATA_QUALITY_QUERY_KEY,
    queryFn: () => getDataQuality(),
    enabled,
    refetchInterval: (q) => (hasRunningJob(q.state.data?.jobs ?? []) ? DATA_QUALITY_POLL_MS : false),
  })

  // Returned (not voided) from onSettled, so the mutation stays pending until
  // the refetch lands — the buttons cannot re-enable in the gap before the new
  // running job appears in the list.
  const refresh = () => queryClient.invalidateQueries({ queryKey: DATA_QUALITY_QUERY_KEY })

  const startMutation = useMutation({
    mutationFn: (body: StartDataQualityJobBody) => startDataQualityJob(body),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(apiErrorStatus(error) === CONFLICT ? 'startConflict' : 'startFailed'),
    // Also on error: a 409 means another job holds the target, and reading the
    // jobs list again is what shows it (and starts polling it).
    onSettled: refresh,
  })

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => cancelDataQualityJob(jobId),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(apiErrorStatus(error) === CONFLICT ? 'cancelConflict' : 'cancelFailed'),
    onSettled: refresh,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    actionError,
    startJob: startMutation.mutate,
    isStarting: startMutation.isPending,
    cancelJob: cancelMutation.mutate,
    cancellingJobId: cancelMutation.isPending ? cancelMutation.variables : undefined,
  }
}
