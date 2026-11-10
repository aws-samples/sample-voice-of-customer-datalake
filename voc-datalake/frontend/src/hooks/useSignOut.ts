/**
 * @fileoverview Sign-out shared by the sidebar and the Account page.
 * @module hooks/useSignOut
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { authService } from '../services/auth'

export function useSignOut(): () => void {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return useCallback(() => {
    // Sign-out is an in-app navigation, so the QueryClient outlives it and
    // every cached authenticated response — urgent counts, feedback, projects
    // — would render for whoever signs in next while their own data loads.
    // The expired-session path does a full document load and so drops the
    // cache implicitly; this one has to be explicit.
    queryClient.clear()
    authService.signOut()
    void navigate('/login')
  }, [navigate, queryClient])
}
