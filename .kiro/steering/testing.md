---
inclusion: auto
name: testing
description: Testing patterns, anti-patterns, deployment validation, and synthetic data generation for this project.
---

# Writing Tests

How to write tests that catch bugs, document behavior, and remain maintainable for the VoC Data Lake project.

> Based on [BugMagnet](https://github.com/gojko/bugmagnet-ai-assistant) by Gojko Adzic. Adapted with attribution.

## Test Locations & Commands

### Running Tests

```bash
# Frontend Tests (TypeScript/React)
cd voc-datalake/frontend
npm test                         # Run all tests (vitest)
npm test -- --project=unit       # Unit tests only (node environment)
npm test -- --project=component  # Component tests only (jsdom environment)
npm run test:watch               # Watch mode
npm run test:coverage            # With coverage report

# Lambda Tests (Python)
cd voc-datalake
python -m pytest lambda/         # Run all Lambda tests
python -m pytest lambda/api/test/ -v  # API handler tests with verbose output
python -m pytest --cov=lambda    # With coverage report
```

### Test File Locations

| Location | Type | Environment |
|----------|------|-------------|
| `lambda/api/test/` | API Lambda unit tests | Python/pytest |
| `lambda/ingestors/test/` | Ingestor unit tests | Python/pytest |
| `lambda/processor/test/` | Processor unit tests | Python/pytest |
| `lambda/shared/test/` | Shared utilities tests | Python/pytest |
| `frontend/src/components/*.test.tsx` | Component unit tests | node |
| `frontend/src/components/*.component.test.tsx` | Component tests with RTL | jsdom |
| `frontend/src/store/*.test.ts` | Store unit tests | node |
| `frontend/src/api/*.test.ts` | API client tests | node |


### Test File Naming Conventions

| Suffix | Environment | Use Case |
|--------|-------------|----------|
| `*.test.ts` | node | Unit tests for logic, services, helpers |
| `*.test.tsx` | node | Unit tests for React hooks/logic (no rendering) |
| `*.component.test.tsx` | jsdom | Component tests with React Testing Library |
| `test_*.py` | pytest | Python Lambda unit tests |
| `*_test.py` | pytest | Alternative Python test naming |

---

## Python Lambda Testing (pytest)

### Setup

Install test dependencies:

```bash
cd voc-datalake
pip install pytest pytest-cov pytest-mock moto boto3
```

### Project Structure for Tests

```
lambda/
├── api/
│   ├── metrics_handler.py
│   ├── chat_handler.py
│   └── test/
│       ├── __init__.py
│       ├── conftest.py           # Shared fixtures
│       ├── test_metrics_handler.py
│       └── test_chat_handler.py
├── ingestors/
│   ├── base_ingestor.py
│   └── test/
│       ├── conftest.py
│       └── test_base_ingestor.py
├── processor/
│   ├── handler.py
│   └── test/
│       └── test_handler.py
└── shared/
    ├── aws.py
    └── test/
        └── test_aws.py
```

### conftest.py - Shared Fixtures

```python
"""Shared pytest fixtures for Lambda tests."""
import os
import pytest
from unittest.mock import MagicMock, patch

# Set environment variables before importing handlers
os.environ['FEEDBACK_TABLE'] = 'test-feedback'
os.environ['AGGREGATES_TABLE'] = 'test-aggregates'
os.environ['CONVERSATIONS_TABLE'] = 'test-conversations'
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-service'


@pytest.fixture
def mock_dynamodb_table():
    """Create a mock DynamoDB table."""
    table = MagicMock()
    table.query.return_value = {'Items': [], 'Count': 0}
    table.get_item.return_value = {}
    table.put_item.return_value = {}
    return table


@pytest.fixture
def mock_dynamodb_resource(mock_dynamodb_table):
    """Mock boto3 DynamoDB resource."""
    resource = MagicMock()
    resource.Table.return_value = mock_dynamodb_table
    return resource


@pytest.fixture
def mock_bedrock_client():
    """Mock Bedrock runtime client."""
    import json
    client = MagicMock()
    client.invoke_model.return_value = {
        'body': MagicMock(read=lambda: json.dumps({
            'content': [{'text': 'Test AI response'}]
        }).encode())
    }
    return client


@pytest.fixture
def api_gateway_event():
    """Create a sample API Gateway event."""
    def _create_event(
        method: str = 'GET',
        path: str = '/feedback',
        query_params: dict = None,
        body: dict = None,
        path_params: dict = None
    ):
        return {
            'httpMethod': method,
            'path': path,
            'queryStringParameters': query_params or {},
            'pathParameters': path_params or {},
            'body': json.dumps(body) if body else None,
            'headers': {'Content-Type': 'application/json'},
            'requestContext': {
                'authorizer': {'claims': {'sub': 'test-user'}}
            }
        }
    return _create_event


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-function'
    context.memory_limit_in_mb = 128
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test'
    context.aws_request_id = 'test-request-id'
    return context
```


### Lambda Handler Test Structure

```python
"""Tests for metrics_handler.py"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestListFeedback:
    """Tests for GET /feedback endpoint."""

    @patch('metrics_handler.feedback_table')
    def test_returns_empty_list_when_no_feedback_exists(self, mock_table, api_gateway_event, lambda_context):
        """Returns empty array when no feedback in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback', query_params={'days': '7'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['count'] == 0
        assert body['items'] == []

    @patch('metrics_handler.feedback_table')
    def test_filters_by_source_when_source_param_provided(self, mock_table, api_gateway_event, lambda_context):
        """Filters feedback by source platform."""
        # Arrange
        mock_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper', 'date': '2025-01-01'},
                {'feedback_id': '2', 'source_platform': 'webscraper', 'date': '2025-01-02'},
            ]
        }
        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback', query_params={'source': 'webscraper'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['count'] == 2
        mock_table.query.assert_called_once()
        call_args = mock_table.query.call_args
        assert 'SOURCE#webscraper' in str(call_args)

    @patch('metrics_handler.feedback_table')
    def test_limits_results_to_max_100(self, mock_table, api_gateway_event, lambda_context):
        """Enforces maximum limit of 100 items."""
        # Arrange
        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback', query_params={'limit': '500'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert - limit should be capped at 100
        assert response['statusCode'] == 200


class TestValidateDays:
    """Tests for validate_days helper function."""

    def test_returns_default_when_value_is_none(self):
        from metrics_handler import validate_days
        assert validate_days(None, default=7) == 7

    def test_returns_default_when_value_is_invalid_string(self):
        from metrics_handler import validate_days
        assert validate_days('invalid', default=7) == 7

    def test_clamps_to_min_value(self):
        from metrics_handler import validate_days
        assert validate_days(-5, default=7, min_val=1) == 1

    def test_clamps_to_max_value(self):
        from metrics_handler import validate_days
        assert validate_days(1000, default=7, max_val=365) == 365

    def test_accepts_valid_integer(self):
        from metrics_handler import validate_days
        assert validate_days(30, default=7) == 30

    def test_accepts_valid_string_integer(self):
        from metrics_handler import validate_days
        assert validate_days('30', default=7) == 30
```

### Mocking AWS Services with moto

```python
"""Tests using moto for realistic AWS mocking."""
import boto3
import pytest
from moto import mock_aws


@pytest.fixture
def dynamodb_table():
    """Create a real mock DynamoDB table with moto."""
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-feedback',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST'
        )
        table.wait_until_exists()
        yield table


@mock_aws
def test_stores_feedback_item_in_dynamodb(dynamodb_table):
    """Verifies feedback is stored with correct key structure."""
    # Arrange
    item = {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#123',
        'feedback_id': '123',
        'text': 'Great product!'
    }
    
    # Act
    dynamodb_table.put_item(Item=item)
    
    # Assert
    response = dynamodb_table.get_item(Key={'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#123'})
    assert response['Item']['feedback_id'] == '123'
    assert response['Item']['text'] == 'Great product!'
```


### Testing Bedrock Integration

```python
"""Tests for Bedrock AI integration."""
import json
import pytest
from unittest.mock import patch, MagicMock

BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'


@pytest.fixture
def mock_bedrock_response():
    """Create a mock Bedrock response."""
    def _create_response(text: str):
        return {
            'body': MagicMock(read=lambda: json.dumps({
                'content': [{'text': text}]
            }).encode())
        }
    return _create_response


class TestChatEndpoint:
    """Tests for POST /chat endpoint with Bedrock."""

    @patch('chat_handler.get_bedrock_client')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_ai_response_for_valid_message(
        self, mock_agg_table, mock_fb_table, mock_get_bedrock, 
        mock_bedrock_response, api_gateway_event, lambda_context
    ):
        """Returns AI-generated response based on feedback data."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = mock_bedrock_response(
            'Based on the feedback data, customers are generally satisfied.'
        )
        mock_get_bedrock.return_value = mock_bedrock
        mock_agg_table.get_item.return_value = {'Item': {'count': 100}}
        mock_fb_table.query.return_value = {'Items': []}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST', 
            path='/chat',
            body={'message': 'What do customers think about our product?'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'response' in body
        assert 'satisfied' in body['response']
        mock_bedrock.invoke_model.assert_called_once()
        call_kwargs = mock_bedrock.invoke_model.call_args.kwargs
        assert call_kwargs['modelId'] == BEDROCK_MODEL_ID

    @patch('chat_handler.get_bedrock_client')
    def test_returns_error_message_when_bedrock_fails(
        self, mock_get_bedrock, api_gateway_event, lambda_context
    ):
        """Returns graceful error when Bedrock service fails."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception('Service unavailable')
        mock_get_bedrock.return_value = mock_bedrock
        
        from chat_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/chat', body={'message': 'test'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200  # Graceful degradation
        assert 'error' in body or 'Error' in body.get('response', '')
```

### Lambda Test Checklist

**Pre-Test Setup:**
- [ ] Environment variables set in conftest.py
- [ ] AWS clients mocked at module level
- [ ] Fixtures for common test data

**Mocking Strategy:**
- [ ] Use `@patch` decorator for module-level mocks
- [ ] Mock at the import boundary (e.g., `chat_handler.get_bedrock_client`)
- [ ] Use `moto` for realistic DynamoDB testing when needed
- [ ] Return proper response shapes from mocks

**Test Categories:**
- [ ] Happy path: Valid inputs return expected outputs
- [ ] Validation: Invalid inputs are rejected with proper errors
- [ ] Edge cases: Empty results, boundary values
- [ ] Error handling: Service failures handled gracefully
- [ ] Integration: End-to-end handler tests with mocked AWS

---

## Frontend Testing (TypeScript/React)

### Setup

Add test dependencies to `frontend/package.json`:

```json
{
  "devDependencies": {
    "vitest": "^3.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/user-event": "^14.5.0",
    "jsdom": "^25.0.0",
    "@vitest/coverage-v8": "^3.0.0"
  },
  "scripts": {
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:coverage": "vitest --coverage"
  }
}
```


### Vitest Configuration

Create `frontend/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/'],
    },
    // Project-based configuration for different environments
    projects: [
      {
        name: 'unit',
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/store/**/*.test.ts'],
      },
      {
        name: 'component',
        environment: 'jsdom',
        include: ['src/**/*.component.test.tsx'],
        setupFiles: ['./src/test/setup-component.ts'],
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './src/test'),
    },
  },
})
```

### Test Setup Files

Create `frontend/src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))
```

Create `frontend/src/test/setup-component.ts`:

```typescript
import './setup'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Cleanup after each test
afterEach(() => {
  cleanup()
})
```

Create `frontend/src/test/test-utils.tsx`:

```typescript
import { ReactNode } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { MemoryRouter, MemoryRouterProps } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Create a fresh QueryClient for each test
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  })
}

interface TestRouterProps extends MemoryRouterProps {
  children: ReactNode
}

/**
 * TestRouter with React Router v7 future flags to prevent deprecation warnings.
 * Always use this instead of MemoryRouter directly in tests.
 */
export function TestRouter({ children, ...props }: TestRouterProps) {
  return (
    <MemoryRouter
      {...props}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      {children}
    </MemoryRouter>
  )
}

interface AllProvidersProps {
  children: ReactNode
  initialEntries?: string[]
}

function AllProviders({ children, initialEntries = ['/'] }: AllProvidersProps) {
  const queryClient = createTestQueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  initialEntries?: string[]
}

function customRender(ui: React.ReactElement, options: CustomRenderOptions = {}) {
  const { initialEntries, ...renderOptions } = options
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders initialEntries={initialEntries}>{children}</AllProviders>
    ),
    ...renderOptions,
  })
}

export * from '@testing-library/react'
export { customRender as render }
```


### Component Test Examples

#### Testing SentimentBadge Component

```typescript
// src/components/SentimentBadge.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SentimentBadge from './SentimentBadge'

describe('SentimentBadge', () => {
  it('renders positive sentiment with green styling', () => {
    render(<SentimentBadge sentiment="positive" />)
    
    const badge = screen.getByText('positive')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveClass('bg-green-100', 'text-green-800')
  })

  it('renders negative sentiment with red styling', () => {
    render(<SentimentBadge sentiment="negative" />)
    
    const badge = screen.getByText('negative')
    expect(badge).toHaveClass('bg-red-100', 'text-red-800')
  })

  it('renders neutral sentiment with gray styling', () => {
    render(<SentimentBadge sentiment="neutral" />)
    
    const badge = screen.getByText('neutral')
    expect(badge).toHaveClass('bg-gray-100', 'text-gray-800')
  })

  it('displays score when provided', () => {
    render(<SentimentBadge sentiment="positive" score={0.85} />)
    
    expect(screen.getByText('positive')).toBeInTheDocument()
    expect(screen.getByText('(0.85)')).toBeInTheDocument()
  })

  it('applies small size by default', () => {
    render(<SentimentBadge sentiment="positive" />)
    
    const badge = screen.getByText('positive')
    expect(badge).toHaveClass('px-2', 'py-0.5', 'text-xs')
  })

  it('applies medium size when specified', () => {
    render(<SentimentBadge sentiment="positive" size="md" />)
    
    const badge = screen.getByText('positive')
    expect(badge).toHaveClass('px-3', 'py-1', 'text-sm')
  })

  it('falls back to neutral styling for unknown sentiment', () => {
    render(<SentimentBadge sentiment="unknown" />)
    
    const badge = screen.getByText('unknown')
    expect(badge).toHaveClass('bg-gray-100', 'text-gray-800')
  })
})
```

#### Testing MetricCard Component

```typescript
// src/components/MetricCard.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageSquare } from 'lucide-react'
import MetricCard from './MetricCard'

describe('MetricCard', () => {
  it('renders title and value', () => {
    render(<MetricCard title="Total Feedback" value={1234} />)
    
    expect(screen.getByText('Total Feedback')).toBeInTheDocument()
    expect(screen.getByText('1234')).toBeInTheDocument()
  })

  it('displays positive change with up trend', () => {
    render(<MetricCard title="Feedback" value={100} change={15} trend="up" />)
    
    expect(screen.getByText('+15%')).toBeInTheDocument()
    expect(screen.getByLabelText(/increased by 15%/i)).toBeInTheDocument()
  })

  it('displays negative change with down trend', () => {
    render(<MetricCard title="Feedback" value={100} change={-10} trend="down" />)
    
    expect(screen.getByText('-10%')).toBeInTheDocument()
    expect(screen.getByLabelText(/decreased by 10%/i)).toBeInTheDocument()
  })

  it('renders icon with correct color theme', () => {
    render(
      <MetricCard 
        title="Messages" 
        value={50} 
        icon={<MessageSquare data-testid="icon" />}
        color="blue"
      />
    )
    
    const iconContainer = screen.getByTestId('icon').parentElement
    expect(iconContainer).toHaveClass('bg-blue-50', 'text-blue-600')
  })

  it('applies green color theme', () => {
    render(
      <MetricCard 
        title="Positive" 
        value={80} 
        icon={<MessageSquare data-testid="icon" />}
        color="green"
      />
    )
    
    const iconContainer = screen.getByTestId('icon').parentElement
    expect(iconContainer).toHaveClass('bg-green-50', 'text-green-600')
  })
})
```


#### Testing Components with API Calls

```typescript
// src/pages/Dashboard.component.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { TestRouter } from '@test/test-utils'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// STEP 1: Define stable mocks BEFORE imports
const mockGetSummary = vi.fn()
const mockGetSentiment = vi.fn()

vi.mock('../api/client', () => ({
  api: {
    getSummary: mockGetSummary,
    getSentiment: mockGetSentiment,
    getCategories: vi.fn().mockResolvedValue({ categories: {} }),
    getSources: vi.fn().mockResolvedValue({ sources: {} }),
    getUrgentFeedback: vi.fn().mockResolvedValue({ items: [] }),
    getFeedback: vi.fn().mockResolvedValue({ items: [] }),
  },
}))

// Mock auth store
vi.mock('../store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    isAuthenticated: true,
    user: { username: 'test', email: 'test@example.com', groups: ['admins'] },
  })),
}))

// Mock config store
vi.mock('../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
    timeRange: '7d',
    customDateRange: null,
  })),
}))

// STEP 2: Import component AFTER mocks
import Dashboard from './Dashboard'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={children} />
        </Routes>
      </TestRouter>
    </QueryClientProvider>
  )
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('displays summary metrics after loading', async () => {
    // Arrange
    mockGetSummary.mockResolvedValueOnce({
      total_feedback: 1234,
      avg_sentiment: 0.65,
      urgent_count: 5,
      daily_totals: [],
      daily_sentiment: [],
    })
    mockGetSentiment.mockResolvedValueOnce({
      breakdown: { positive: 60, negative: 20, neutral: 20 },
    })

    // Act
    render(<Dashboard />, { wrapper: createWrapper() })

    // Assert
    await waitFor(() => {
      expect(screen.getByText('1234')).toBeInTheDocument()
    })
    expect(mockGetSummary).toHaveBeenCalledWith(7, undefined)
  })

  it('shows loading state while fetching data', () => {
    // Arrange - never resolving promise
    mockGetSummary.mockReturnValue(new Promise(() => {}))
    mockGetSentiment.mockReturnValue(new Promise(() => {}))

    // Act
    render(<Dashboard />, { wrapper: createWrapper() })

    // Assert
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('displays urgent count badge when urgent items exist', async () => {
    // Arrange
    mockGetSummary.mockResolvedValueOnce({
      total_feedback: 100,
      avg_sentiment: 0.5,
      urgent_count: 12,
      daily_totals: [],
      daily_sentiment: [],
    })

    // Act
    render(<Dashboard />, { wrapper: createWrapper() })

    // Assert
    await waitFor(() => {
      expect(screen.getByText('12')).toBeInTheDocument()
    })
  })
})
```


#### Testing Zustand Stores

```typescript
// src/store/configStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useConfigStore } from './configStore'

describe('configStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConfigStore.setState({
      config: {
        apiEndpoint: '',
        brandName: '',
        brandHandles: [],
        hashtags: [],
        urlsToTrack: [],
        sources: {} as any,
      },
      timeRange: '7d',
      customDateRange: null,
    })
  })

  it('sets API endpoint correctly', () => {
    const { setConfig } = useConfigStore.getState()
    
    setConfig({ apiEndpoint: 'https://api.example.com' })
    
    const { config } = useConfigStore.getState()
    expect(config.apiEndpoint).toBe('https://api.example.com')
  })

  it('preserves existing config when updating partial config', () => {
    const { setConfig } = useConfigStore.getState()
    
    setConfig({ apiEndpoint: 'https://api.example.com', brandName: 'TestBrand' })
    setConfig({ brandName: 'UpdatedBrand' })
    
    const { config } = useConfigStore.getState()
    expect(config.apiEndpoint).toBe('https://api.example.com')
    expect(config.brandName).toBe('UpdatedBrand')
  })

  it('sets time range correctly', () => {
    const { setTimeRange } = useConfigStore.getState()
    
    setTimeRange('30d')
    
    const { timeRange } = useConfigStore.getState()
    expect(timeRange).toBe('30d')
  })

  it('sets custom date range correctly', () => {
    const { setCustomDateRange, setTimeRange } = useConfigStore.getState()
    
    setTimeRange('custom')
    setCustomDateRange({ start: '2025-01-01', end: '2025-01-31' })
    
    const { customDateRange, timeRange } = useConfigStore.getState()
    expect(timeRange).toBe('custom')
    expect(customDateRange).toEqual({ start: '2025-01-01', end: '2025-01-31' })
  })

  it('clears custom date range when set to null', () => {
    const { setCustomDateRange } = useConfigStore.getState()
    
    setCustomDateRange({ start: '2025-01-01', end: '2025-01-31' })
    setCustomDateRange(null)
    
    const { customDateRange } = useConfigStore.getState()
    expect(customDateRange).toBeNull()
  })
})
```

```typescript
// src/store/authStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useAuthStore } from './authStore'

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.getState().logout()
  })

  it('sets user and marks as authenticated', () => {
    const { setUser } = useAuthStore.getState()
    const user = { username: 'testuser', email: 'test@example.com', groups: ['admins'] }
    
    setUser(user)
    
    const state = useAuthStore.getState()
    expect(state.user).toEqual(user)
    expect(state.isAuthenticated).toBe(true)
  })

  it('clears authentication on logout', () => {
    const { setUser, setTokens, logout } = useAuthStore.getState()
    
    setUser({ username: 'test', email: 'test@example.com', groups: [] })
    setTokens({ accessToken: 'access', idToken: 'id', refreshToken: 'refresh' })
    logout()
    
    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.accessToken).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('stores all token types', () => {
    const { setTokens } = useAuthStore.getState()
    
    setTokens({
      accessToken: 'access-token-123',
      idToken: 'id-token-456',
      refreshToken: 'refresh-token-789',
    })
    
    const state = useAuthStore.getState()
    expect(state.accessToken).toBe('access-token-123')
    expect(state.idToken).toBe('id-token-456')
    expect(state.refreshToken).toBe('refresh-token-789')
    expect(state.isAuthenticated).toBe(true)
  })

  it('sets loading state', () => {
    const { setLoading } = useAuthStore.getState()
    
    setLoading(true)
    expect(useAuthStore.getState().isLoading).toBe(true)
    
    setLoading(false)
    expect(useAuthStore.getState().isLoading).toBe(false)
  })

  it('sets error message', () => {
    const { setError } = useAuthStore.getState()
    
    setError('Invalid credentials')
    expect(useAuthStore.getState().error).toBe('Invalid credentials')
    
    setError(null)
    expect(useAuthStore.getState().error).toBeNull()
  })
})
```


#### Testing API Client

```typescript
// src/api/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock stores before importing client
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({
      config: { apiEndpoint: 'https://api.example.com' },
    })),
  },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
}))

import { api } from './client'

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getFeedback', () => {
    it('fetches feedback with correct query parameters', async () => {
      const mockResponse = { count: 2, items: [{ feedback_id: '1' }, { feedback_id: '2' }] }
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getFeedback({ days: 7, source: 'webscraper' })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback?days=7&source=webscraper',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'mock-id-token',
          }),
        })
      )
      expect(result).toEqual(mockResponse)
    })

    it('throws error on non-ok response', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('API Error: 500')
    })
  })

  describe('getSummary', () => {
    it('fetches summary with days parameter', async () => {
      const mockSummary = { total_feedback: 100, avg_sentiment: 0.5 }
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSummary),
      })

      const result = await api.getSummary(30)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=30',
        expect.any(Object)
      )
      expect(result).toEqual(mockSummary)
    })

    it('includes source filter when provided', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      await api.getSummary(7, 'webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=7&source=webscraper',
        expect.any(Object)
      )
    })
  })

  describe('chat', () => {
    it('sends POST request with message body', async () => {
      const mockResponse = { response: 'AI response', sources: [] }
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.chat('What do customers think?')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'What do customers think?', context: undefined }),
        })
      )
      expect(result).toEqual(mockResponse)
    })
  })
})
```

### Component Test Checklist

**Pre-Test Setup:**
- [ ] File named `*.component.test.tsx` for jsdom tests
- [ ] Mocks defined BEFORE component import
- [ ] Mock functions declared OUTSIDE `vi.mock()` factory
- [ ] Reset mocks in `beforeEach`

**API Mocking:**
- [ ] Mock `../api/client` with all used API methods
- [ ] Handle ALL endpoints the component calls
- [ ] Return proper response shapes
- [ ] Mock stores (`authStore`, `configStore`) as needed

**Router Setup:**
- [ ] Wrap in `<TestRouter>` from `@test/test-utils` with `initialEntries`
- [ ] Define `<Routes>` with correct path pattern
- [ ] Never use `MemoryRouter` directly (causes v7 deprecation warnings)

**Test Categories:**
- [ ] Rendering: Content displays correctly after load
- [ ] Loading states: Spinner shown while fetching
- [ ] Error states: Error messages for API failures
- [ ] User interactions: Clicks, form inputs, navigation
- [ ] Edge cases: Empty data, missing optional props


---

## Critical Rules

**Test names describe outcomes, not actions.** "returns empty array when input is null" not "test null input". The name IS the specification.

**Assertions must match test titles.** If the test claims to verify "different IDs", assert on the actual ID values—not just count or existence.

**Assert specific values, not types.** `expect(result).toEqual(['First.', ' Second.'])` not `expect(result).toBeDefined()`. Specific assertions catch specific bugs.

**One concept per test.** Each test verifies one behavior. If you need "and" in your test name, split it.

**Bugs cluster together.** When you find one bug, test related scenarios. The same misunderstanding often causes multiple failures.

## Test Naming

**Pattern:** `[outcome] when [condition]`

### Good Names (Describe Outcomes)

```
returns empty array when input is null
throws ValidationError when email format invalid
calculates tax correctly for tax-exempt items
preserves original order when duplicates removed
displays loading spinner while fetching data
filters feedback by source when source param provided
```

### Bad Names (Describe Actions)

```
test null input           // What about null input?
should work               // What does "work" mean?
handles edge cases        // Which edge cases?
email validation test     // What's being validated?
```

## Assertion Best Practices

### Assert Specific Values

```typescript
// WEAK - passes even if completely wrong data
expect(result).toBeDefined()
expect(result.items).toHaveLength(2)
expect(user).toBeTruthy()

// STRONG - catches actual bugs
expect(result).toEqual({ status: 'success', items: ['a', 'b'] })
expect(user.email).toBe('test@example.com')
```

```python
# WEAK - Python
assert result is not None
assert len(items) == 2

# STRONG - Python
assert result == {'status': 'success', 'items': ['a', 'b']}
assert user['email'] == 'test@example.com'
```

### Match Assertions to Test Title

```typescript
// TEST SAYS "different IDs" BUT ASSERTS COUNT
it('generates different IDs for each call', () => {
  const id1 = generateId()
  const id2 = generateId()
  expect([id1, id2]).toHaveLength(2)  // WRONG: doesn't check they're different!
})

// ACTUALLY VERIFIES DIFFERENT IDs
it('generates different IDs for each call', () => {
  const id1 = generateId()
  const id2 = generateId()
  expect(id1).not.toBe(id2)  // RIGHT: verifies the claim
})
```

## Test Structure

### Arrange-Act-Assert

```typescript
it('calculates total with tax for non-exempt items', () => {
  // Arrange: Set up test data
  const item = { price: 100, taxExempt: false }
  const taxRate = 0.1

  // Act: Execute the behavior
  const total = calculateTotal(item, taxRate)

  // Assert: Verify the outcome
  expect(total).toBe(110)
})
```

```python
def test_calculates_total_with_tax_for_non_exempt_items():
    # Arrange
    item = {'price': 100, 'tax_exempt': False}
    tax_rate = 0.1

    # Act
    total = calculate_total(item, tax_rate)

    # Assert
    assert total == 110
```

### One Concept Per Test

```typescript
// MULTIPLE CONCEPTS - hard to diagnose failures
it('validates and processes order', () => {
  expect(validate(order)).toBe(true)
  expect(process(order).status).toBe('complete')
  expect(sendEmail).toHaveBeenCalled()
})

// SINGLE CONCEPT - clear failures
it('accepts valid orders', () => {
  expect(validate(validOrder)).toBe(true)
})

it('rejects orders with negative quantities', () => {
  expect(validate(negativeQuantityOrder)).toBe(false)
})

it('sends confirmation email after processing', () => {
  process(order)
  expect(sendEmail).toHaveBeenCalledWith(order.customerEmail)
})
```


## Edge Case Checklists

When testing a function, systematically consider these edge cases based on input types.

### Numbers

- [ ] Zero
- [ ] Negative numbers
- [ ] Very large numbers (near MAX_SAFE_INTEGER / sys.maxsize)
- [ ] Decimal precision (0.1 + 0.2)
- [ ] NaN / None
- [ ] Infinity / -Infinity
- [ ] Boundary values (off-by-one at limits)

### Strings

- [ ] Empty string `""`
- [ ] Whitespace only `"   "`
- [ ] Very long strings (10K+ characters)
- [ ] Unicode: emojis, RTL text, combining characters
- [ ] Special characters: quotes, backslashes, null bytes
- [ ] SQL/HTML/script injection patterns
- [ ] Leading/trailing whitespace

### Collections (Arrays, Objects, Lists, Dicts)

- [ ] Empty collection `[]`, `{}`
- [ ] Single element
- [ ] Duplicates
- [ ] Nested structures
- [ ] Very large collections (performance)

### Dates and Times

- [ ] Leap years (Feb 29)
- [ ] Daylight saving transitions
- [ ] Timezone boundaries
- [ ] Midnight (00:00:00)
- [ ] Year boundaries (Dec 31 -> Jan 1)
- [ ] Invalid dates (Feb 30, Month 13)

### Null and Undefined

- [ ] `null` / `None` input
- [ ] `undefined` input (TypeScript)
- [ ] Missing optional properties
- [ ] Explicit `undefined` vs missing key

### VoC Domain-Specific

- [ ] Feedback with no text
- [ ] Feedback with very long text (10K+ chars)
- [ ] Invalid sentiment values
- [ ] Missing source_platform
- [ ] Future dates in source_created_at
- [ ] Negative sentiment scores
- [ ] Rating outside 1-5 range
- [ ] Empty category
- [ ] Unicode in feedback text (emojis, RTL)

## Anti-Patterns to Avoid

```typescript
// ❌ Testing implementation details
expect(component.state.isLoading).toBe(true);

// ✅ Test visible behavior
expect(screen.getByText('Loading...')).toBeInTheDocument();

// ❌ Using container queries
const button = container.querySelector('.btn-primary');

// ✅ Use semantic queries
const button = screen.getByRole('button', { name: 'Submit' });

// ❌ Vague assertions
expect(result).toBeDefined();
expect(items).toHaveLength(2);

// ✅ Specific assertions
expect(result).toEqual({ status: 'success', count: 2 });
expect(items).toEqual(['Item 1', 'Item 2']);

// ❌ Multiple concepts per test
it('handles form', () => {
  expect(getError()).toBeInTheDocument();
  expect(mockSubmit).toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('/success');
});

// ✅ Separate tests for each behavior
it('shows validation error for invalid input', () => {});
it('calls submit handler with form data', () => {});
it('navigates to success page after submission', () => {});
```

```python
# ❌ Testing implementation details
assert handler._internal_cache == {}

# ✅ Test observable behavior
assert handler.get_cached_value('key') is None

# ❌ Vague assertions
assert result is not None
assert len(items) > 0

# ✅ Specific assertions
assert result == {'status': 'success', 'count': 2}
assert items == ['Item 1', 'Item 2']
```

## Query Priority (React Testing Library)

| Query | Use Case | Example |
|-------|----------|---------|
| `getByRole` | Semantic elements (preferred) | `getByRole('button', { name: 'Submit' })` |
| `getByLabelText` | Form fields with labels | `getByLabelText('Email Address')` |
| `getByPlaceholderText` | Inputs without labels | `getByPlaceholderText('Enter email...')` |
| `getByText` | Unique text content | `getByText('Welcome back!')` |
| `getAllByText` | Text appearing multiple times | `getAllByText('Home')` |
| `getByTestId` | Last resort for ambiguous elements | `getByTestId('submit-button')` |

## User Interactions

Use `userEvent` instead of `fireEvent`:

```typescript
// ✅ userEvent - simulates real interactions
await userEvent.click(button);
await userEvent.type(input, 'Hello');

// ❌ fireEvent - too low-level
fireEvent.click(button);
```


## Preventing Infinite Loops in Tests

When mocking hooks that return functions used in `useCallback` dependencies:

```typescript
// ❌ BAD - Creates new function on every render, triggers infinite useEffect
vi.mock('../hooks/useItems', () => ({
  useItems: () => ({
    addItem: vi.fn(),  // New function every render!
  }),
}));

// ✅ GOOD - Stable function reference across renders
const mockAddItem = vi.fn();
vi.mock('../hooks/useItems', () => ({
  useItems: () => ({
    addItem: mockAddItem,  // Same reference
  }),
}));
```

## Bug Clustering

When you discover a bug, don't stop—explore related scenarios:

1. **Same function, similar inputs** - If null fails, test undefined, empty string
2. **Same pattern, different locations** - If one endpoint mishandles auth, check others
3. **Same developer assumption** - If off-by-one here, check other boundaries
4. **Same data type** - If dates fail at DST, check other time edge cases

## When Tempted to Cut Corners

- If your test name says "test" or "should work": STOP. What outcome are you actually verifying? Name it specifically.

- If you're asserting `toBeDefined()` or `toBeTruthy()`: STOP. What value do you actually expect? Assert that instead.

- If your assertion doesn't match your test title: STOP. Either fix the assertion or rename the test. They must agree.

- If you're testing multiple concepts in one test: STOP. Split it. Future you debugging a failure will thank you.

- If you found a bug and wrote one test: STOP. Bugs cluster. What related scenarios might have the same problem?

- If you're skipping edge cases because "that won't happen": STOP. It will happen. In production. At 3 AM.

---

## Prompt Template for Creating Tests

### Python Lambda Tests

```
Create pytest tests for [handler_name] at lambda/api/[handler].py.

## Handler Purpose
[Brief description of what the handler does]

## Test Behaviors
### Happy Path
- [ ] Returns [expected response] for valid [input]
- [ ] Queries DynamoDB with correct key structure

### Validation
- [ ] Returns 400 for missing required parameters
- [ ] Clamps days parameter to valid range

### Error Handling
- [ ] Returns graceful error when DynamoDB fails
- [ ] Returns graceful error when Bedrock fails

## Dependencies to Mock
- DynamoDB tables: [table names]
- Bedrock client: [if AI features]
- Other AWS services: [list]
```

### React Component Tests

```
Create a component test for [ComponentName] at frontend/src/[path]/Component.tsx.

## Component Purpose
[Brief description of what the component does]

## Test Behaviors
### Happy Path
- [ ] Displays [content] after successful load
- [ ] Shows [element] when user clicks [button]

### Loading States
- [ ] Shows loading spinner while fetching

### Error States
- [ ] Displays error when API returns 404
- [ ] Shows validation error for invalid input

## Dependencies to Mock
- API calls: [endpoints from api/client.ts]
- Stores: [authStore, configStore]
- Router: [if uses useParams, useNavigate]
```
