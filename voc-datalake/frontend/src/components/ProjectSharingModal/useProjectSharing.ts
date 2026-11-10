/**
 * @fileoverview Members query + every sharing mutation for one project.
 *
 * Every mutation invalidates the project (whose key prefixes the members and
 * candidates keys) and the project list, because visibility, owner, member
 * count and the caller's own access are all shown there too.
 *
 * Leaving is the exception: afterwards the caller can no longer view the
 * project, so refetching it would only produce a 404 for the page still on
 * screen. `leave` instead REMOVES the project's queries (detail, members,
 * candidates — all prefixed by `projectKey`) before the caller navigates away.
 *
 * @module components/ProjectSharingModal/useProjectSharing
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { projectKey, projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import type { ProjectMemberRole, ProjectVisibility } from '../../api/projectTypes'

const projectMembersKey = (projectId: string) => [...projectKey(projectId), 'members'] as const

export const memberCandidatesKey = (projectId: string, q: string) =>
  [...projectKey(projectId), 'member-candidates', q] as const

export function useProjectSharing(projectId: string, enabled: boolean) {
  const queryClient = useQueryClient()
  const membersQuery = useQuery({
    queryKey: projectMembersKey(projectId),
    queryFn: () => projectsApi.getMembers(projectId),
    enabled,
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: projectsKey() }),
    ])
  }

  const setVisibility = useMutation({
    mutationFn: (visibility: ProjectVisibility) => projectsApi.setVisibility(projectId, visibility),
    onSettled: invalidate,
  })
  const addMember = useMutation({
    mutationFn: ({ sub, role }: { sub: string; role: ProjectMemberRole }) =>
      projectsApi.addMember(projectId, sub, role),
    onSettled: invalidate,
  })
  const updateRole = useMutation({
    mutationFn: ({ sub, role }: { sub: string; role: ProjectMemberRole }) =>
      projectsApi.updateMemberRole(projectId, sub, role),
    onSettled: invalidate,
  })
  const removeMember = useMutation({
    mutationFn: (sub: string) => projectsApi.removeMember(projectId, sub),
    onSettled: invalidate,
  })
  const leave = useMutation({
    mutationFn: (sub: string) => projectsApi.removeMember(projectId, sub),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: projectKey(projectId) })
      queryClient.removeQueries({ queryKey: projectKey(projectId) })
      await queryClient.invalidateQueries({ queryKey: projectsKey() })
    },
    onError: invalidate,
  })
  const transferOwnership = useMutation({
    mutationFn: (sub: string) => projectsApi.transferOwnership(projectId, sub),
    onSettled: invalidate,
  })

  const mutations = [setVisibility, addMember, updateRole, removeMember, leave, transferOwnership]
  const failed = mutations.find((m) => m.isError)

  return {
    membersQuery,
    setVisibility,
    addMember,
    updateRole,
    removeMember,
    leave,
    transferOwnership,
    isMutating: mutations.some((m) => m.isPending),
    mutationError: failed?.error ?? null,
    resetErrors: () => mutations.forEach((m) => m.reset()),
  }
}
