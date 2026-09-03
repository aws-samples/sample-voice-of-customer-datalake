import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { ProjectDocument } from '../../api/types'
import { useMentions } from './chatTabHooks'

const documents: ProjectDocument[] = [
  {
    document_id: 'prd-1',
    document_type: 'prd',
    title: 'Checkout requirements (v1)',
    content: '# Requirements',
    created_at: '2026-09-01T00:00:00Z',
  },
  {
    document_id: 'prototype-1',
    document_type: 'prototype',
    title: 'Checkout prototype (v1)',
    content: '<html><body>Checkout</body></html>',
    created_at: '2026-09-02T00:00:00Z',
  },
]

describe('useMentions document candidates', () => {
  it('excludes prototypes from a matching #document mention list', () => {
    const { result } = renderHook(() => {
      const [chatInput, setChatInput] = useState('')
      return useMentions([], documents, chatInput, setChatInput)
    })

    act(() => result.current.handleInputChange('#checkout'))

    expect(result.current.getMentionItems()).toEqual([documents[0]])
  })
})
