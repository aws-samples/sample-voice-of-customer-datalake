---
inclusion: fileMatch
fileMatchPattern: "frontend/**/*.{ts,tsx}"
---

# Frontend Patterns

This guide applies when working with React/TypeScript files in the frontend.

## Import Order

1. React and hooks
2. Third-party libraries
3. Local components
4. Types (with `type` keyword)
5. Styles/assets

```typescript
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Search, Filter } from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

import FeedbackCard from '../components/FeedbackCard'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { useAuthStore } from '../store/authStore'

import type { FeedbackItem } from '../api/client'
```

## Type-Only Imports

Always use `type` keyword for type-only imports (required by verbatimModuleSyntax):

```typescript
// ✅ Correct
import type { FeedbackItem } from '../api/client'
import type { ReactNode } from 'react'

// ❌ Wrong - will cause build errors
import { FeedbackItem } from '../api/client'
```


## Component Structure

```typescript
interface Props {
  feedback: FeedbackItem
  showActions?: boolean
  onSelect?: (id: string) => void
}

export default function MyComponent({ feedback, showActions = true, onSelect }: Props) {
  // 1. Hooks (state, queries, effects)
  const [isOpen, setIsOpen] = useState(false)
  const { config } = useConfigStore()
  const { isAuthenticated } = useAuthStore()
  
  const { data, isLoading, error } = useQuery({
    queryKey: ['feedback', feedback.feedback_id],
    queryFn: () => api.getFeedbackById(feedback.feedback_id),
    enabled: isAuthenticated && !!config.apiEndpoint,
  })
  
  // 2. Event handlers
  const handleClick = () => {
    onSelect?.(feedback.feedback_id)
  }
  
  // 3. Early returns for loading/error states
  if (isLoading) {
    return <div className="animate-pulse">Loading...</div>
  }
  
  if (error) {
    return <div className="text-red-500">Error loading data</div>
  }
  
  // 4. Main render
  return (
    <div className={clsx('card', isOpen && 'ring-2 ring-blue-500')}>
      {/* Content */}
    </div>
  )
}
```

## Data Fetching with TanStack Query

```typescript
// Basic query
const { data, isLoading, error } = useQuery({
  queryKey: ['feedback', days, source],  // Cache key
  queryFn: () => api.getFeedback({ days, source }),
  enabled: !!config.apiEndpoint,  // Only run when configured
  staleTime: 30000,  // Consider fresh for 30s
})

// Mutation
const mutation = useMutation({
  mutationFn: (data: CreateInput) => api.create(data),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['feedback'] })
  },
})
```

##
 State Management

### Local State (useState)
For component-specific state:
```typescript
const [search, setSearch] = useState('')
const [isOpen, setIsOpen] = useState(false)
```

### Global State (Zustand)
For app-wide state like config:
```typescript
import { useConfigStore } from '../store/configStore'

const { config, timeRange, setTimeRange } = useConfigStore()
```

### Server State (TanStack Query)
For API data - handles caching, refetching, loading states.

## Styling with Tailwind

Use utility classes directly:
```tsx
<div className="bg-white rounded-lg shadow-sm p-4 hover:shadow-md transition-shadow">
  <h2 className="text-lg font-semibold text-gray-900">Title</h2>
  <p className="text-sm text-gray-500 mt-1">Description</p>
</div>
```

Use `clsx` for conditional classes:
```tsx
<button className={clsx(
  'px-4 py-2 rounded-lg font-medium',
  isActive ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700',
  disabled && 'opacity-50 cursor-not-allowed'
)}>
  Click me
</button>
```

## Common Patterns

### Loading State
```tsx
if (isLoading) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  )
}
```

### Empty State
```tsx
if (!data?.items.length) {
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">No feedback found</p>
    </div>
  )
}
```

### Error State
```tsx
if (error) {
  return (
    <div className="bg-red-50 text-red-700 p-4 rounded-lg">
      <p>Failed to load data. Please try again.</p>
    </div>
  )
}
```

### Configuration Check
```tsx
if (!config.apiEndpoint) {
  return (
    <div className="text-center py-12">
      <p className="text-gray-500 mb-4">Please configure your API endpoint</p>
      <Link to="/settings" className="btn btn-primary">Go to Settings</Link>
    </div>
  )
}
```

### Authentication Check
```tsx
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

const { isAuthenticated } = useAuthStore()

if (!isAuthenticated) {
  return <Navigate to="/login" replace />
}
```

## File Naming

- Components: `PascalCase.tsx` (e.g., `FeedbackCard.tsx`)
- Utilities: `camelCase.ts` (e.g., `client.ts`)
- Stores: `camelCase.ts` (e.g., `configStore.ts`)
- Pages: `PascalCase.tsx` (e.g., `Dashboard.tsx`)