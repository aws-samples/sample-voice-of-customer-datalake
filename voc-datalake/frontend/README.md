# VoC Data Lake - Frontend Dashboard

React-based analytics dashboard for the Voice of Customer Data Lake platform.

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| React | 19.2 | UI framework |
| Vite | 7.2 | Build tool |
| Tailwind CSS | 4.1 | Styling |
| Zustand | 5.0 | State management (persisted) |
| TanStack Query | 5.90 | Data fetching/caching |
| React Router | 7.9 | Routing |
| Recharts | 3.5 | Charts (Line, Bar, Pie) |
| Lucide React | 0.554 | Icons |
| date-fns | 4.1 | Date formatting |
| clsx | 2.1 | Conditional classes |
| react-markdown | 10.1 | Markdown rendering |
| remark-gfm | 4.0 | GitHub Flavored Markdown |
| amazon-cognito-identity-js | 6.3 | Cognito authentication |
| jspdf + html2canvas | 3.0/1.4 | PDF export |
| TypeScript | 5.9 | Type safety |

## Pages

| Page | Route | Description |
|------|-------|-------------|
| Login | `/login` | Cognito authentication |
| Dashboard | `/` | Overview with charts, metrics, social feed, urgent issues |
| Feedback | `/feedback` | Filterable list of all feedback items |
| Feedback Detail | `/feedback/:id` | Single feedback item with full details |
| Categories | `/categories` | Category breakdown and analysis |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| Prioritization | `/prioritization` | Issue prioritization dashboard |
| AI Chat | `/chat` | Conversational interface for querying data (with streaming) |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Single project view with personas, PRDs, PR/FAQs |
| Data Explorer | `/data-explorer` | Browse S3 raw data and DynamoDB processed records |
| Scrapers | `/scrapers` | Configure custom web scrapers |
| Feedback Forms | `/feedback-forms` | Manage embeddable feedback forms |
| Settings | `/settings` | Brand config, integrations, user management |

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev    # http://localhost:5173

# Start mock API server (for offline development)
npm run mock   # http://localhost:3001

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

## Project Structure

```
frontend/
├── src/
│   ├── api/client.ts         # API client, types, fetch helpers
│   ├── services/auth.ts      # Cognito authentication service
│   ├── components/           # 22 reusable components
│   │   ├── Layout.tsx            # Main layout with sidebar navigation
│   │   ├── ProtectedRoute.tsx    # Auth-protected route wrapper
│   │   ├── FeedbackCard.tsx      # Feedback item display
│   │   ├── FeedbackCarousel.tsx  # Carousel for feedback items
│   │   ├── SocialFeed.tsx        # Live social media feed
│   │   ├── MetricCard.tsx        # Dashboard metric card
│   │   ├── SentimentBadge.tsx    # Sentiment indicator
│   │   ├── TimeRangeSelector.tsx # Date range picker
│   │   ├── Breadcrumbs.tsx       # Navigation breadcrumbs
│   │   ├── CategoriesManager.tsx # Category management UI
│   │   ├── ChatMessage.tsx       # Chat message component
│   │   ├── ChatSidebar.tsx       # Chat conversation sidebar
│   │   ├── ChatFilters.tsx       # Chat filter controls
│   │   ├── ChatExportMenu.tsx    # Export chat conversations
│   │   ├── DataSourceWizard.tsx  # Data source setup wizard
│   │   ├── DocumentExportMenu.tsx # Export documents
│   │   ├── PersonaExportMenu.tsx # Export personas
│   │   ├── FeedbackFormConfig.tsx # Feedback form configuration
│   │   ├── S3ImportExplorer.tsx  # S3 file browser
│   │   ├── UserAdmin.tsx         # User administration
│   │   ├── UserProfileModal.tsx  # User profile modal
│   │   └── ConfirmModal.tsx      # Confirmation dialog
│   ├── pages/                # 14 page components
│   ├── store/                # Zustand stores
│   │   ├── configStore.ts    # Config, time range, custom dates
│   │   ├── chatStore.ts      # Chat conversation state
│   │   └── authStore.ts      # Authentication state
│   ├── constants/
│   │   └── filters.ts        # Filter constants and options
│   └── config.ts             # Runtime configuration
├── public/                   # Static assets
├── index.html                # HTML entry point
├── vite.config.ts            # Vite configuration
├── tsconfig.json             # TypeScript configuration
└── package.json              # Dependencies
```

## Configuration

The frontend connects to the backend API via environment variables:

```bash
# .env.production (set during CDK deployment)
VITE_API_ENDPOINT=https://your-api.execute-api.region.amazonaws.com/v1
VITE_COGNITO_USER_POOL_ID=us-west-2_xxxxx
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxx
VITE_STREAM_URL=https://xxxxx.lambda-url.region.on.aws
```

## Authentication

Uses Amazon Cognito for authentication with two user groups:
- **admins**: Full access to all features including user management
- **viewers**: Read-only access to dashboards and feedback

## Deployment

The frontend is automatically deployed via CDK FrontendStack to:
- S3 bucket for static hosting
- CloudFront distribution for CDN and HTTPS
