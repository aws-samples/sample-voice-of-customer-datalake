# Voice of Customer (VoC) Data Lake

A fully serverless AWS platform that collects customer feedback from many sources, analyses every review with Amazon Bedrock, and turns the evidence into dashboards, research, product documents and prototypes, with an AI assistant and autonomous agents on top.

![Dashboard](docs/images/screenshots/dashboard.jpg)

## 📸 Screenshots

The screenshots come from the local mock (`npm run dev`), which serves fictional sample data for "Acme Outfitters".

| | |
|---|---|
| ![AI assistant](docs/images/screenshots/assistant.jpg) | ![Categories](docs/images/screenshots/categories.jpg) |
| **AI assistant**: one page-aware assistant on every page. It answers from your feedback and cites the reviews it used. | **Categories**: feedback by category, sentiment, keyword and source, filtered by channel, product, user type and tags. |
| ![Project](docs/images/screenshots/project.jpg) | ![Autonomous agents](docs/images/screenshots/agents.jpg) |
| **Projects**: describe the product, then generate personas, research, PRD / PR-FAQ documents and a clickable prototype from the evidence. | **Autonomous agents**: agents watch their feedback scope and, when a trigger fires, run a workflow from reviews to a reviewed prototype. |

## ✨ Features

- **Plugin-Based Architecture**: Extensible data source plugins, easily create your own
- **AI-Powered Analysis**: Amazon Bedrock (Claude) for sentiment, categorization, and insights
- **Unified AI Assistant**: one page-aware assistant (floating bubble → panel → full screen, and the `/chat` page) speaking AG-UI over `/chat/stream`. It can run for up to 15 minutes. Server tools only read; every write is shown as an approval card and runs with your own permissions. Sessions are saved per user
- **Long-running AI work**: model calls never sit on API Gateway's 29-second limit. AI routes start a background job, answer `202` with a job id, and the app polls for the result
- **Autonomous Agents**: agents with a feedback scope, triggers and a versioned workflow (research → personas → PR/FAQ → PRD → prototype → persona review), run on Step Functions with human decision points ([docs/autonomous-agents.md](docs/autonomous-agents.md))
- **Memory**: company and personal memory extracted from conversations and agent runs, reviewed before it is shared ([docs/memory.md](docs/memory.md))
- **Per-Surface Model Picker**: admins choose the Claude model per AI feature (Claude 5.5 generation by default: Sonnet 5.5 for the assistant and documents, Opus 5.5 for prototypes, Haiku 5.5 for enrichment) over a curated allowlist
- **Web Search**: AgentCore Gateway connector for chat and research — deployed by default, searches stay opt-in per request (opt out with `enableWebSearch: false`)
- **Project Research Workspace**: generate personas, research, PRDs, PR/FAQs, product reports, and prototypes from customer evidence
- **Managed Artifact Versions**: persistent PRD, PR/FAQ, and prototype series with revision and derivation lineage
- **Team Prioritization**: compose document sets into scoring rows, collect individual or room ballots, and surface stale or cross-generation selections
- **External-Agent Access**: one global MCP server (`/mcp/global`) with personal, expiring tokens minted on Connect that act as their minter — feedback, metrics, memory, project and document tools, plus admin-only agent runs ([docs/mcp.md](docs/mcp.md))
- **Dimensions, Tags and Channels**: admin-defined axes (product, module, user type, …) filled from imports, source defaults, categories or the model; filter feedback, metrics, the assistant and MCP by them ([docs/dimensions.md](docs/dimensions.md))
- **Source Policies**: per-source PII redaction or summary-only storage, restricted sources granted per user, opt-in retention and erasure ([docs/source-policies.md](docs/source-policies.md))
- **EU Deployment**: `-c inferenceScope=eu` keeps model inference in EU regions ([docs/eu-deployment.md](docs/eu-deployment.md))
- **Real-Time Processing**: Event-driven with SQS and DynamoDB Streams
- **Multi-Language Support**: Auto-detection and translation
- **React Dashboard**: Metrics, charts, AI assistant, projects, and prioritization
- **Secure**: Cognito authentication, least-privilege IAM, KMS encryption, signed private assets, and Secrets Manager

## 🏗️ Architecture

![VoC Data Lake architecture on AWS](docs/images/architecture.drawio.png)

Everything is serverless and pay-per-use: Lambda, DynamoDB on demand, S3, SQS, API Gateway, Step Functions and Bedrock. There are no servers or clusters to run, and no fixed monthly cost beyond storage. The diagram shows three flows. The editable source is [docs/images/architecture.drawio](docs/images/architecture.drawio); open it in [draw.io](https://app.diagrams.net).

**1. Ingest and enrich.** Each data source is a plugin with its own ingestor Lambda. EventBridge runs it on a schedule; some plugins also accept webhooks. Review pages that need a real browser are read through AgentCore Browser. The ingestor archives every raw item in the S3 data lake (`raw/{source}/{date}/`) before anything else, so nothing is lost and data can be reprocessed later. It then queues a reference on SQS. The processor Lambda detects the language and translates (Comprehend, Translate). Bedrock adds the category, urgency, persona and dimensions, and the result is written to the DynamoDB feedback table. A DynamoDB Stream drives the aggregator Lambda, which keeps the daily metrics behind the dashboard up to date in real time.

**2. Explore and act.** The React app is served from CloudFront, and every request is signed in with Cognito. API Gateway routes each path to a small domain Lambda (metrics, projects, settings, …). Each one holds only the permissions it needs (see [Lambda IAM split](.kiro/steering/coding-standards.md)). AI requests that can take longer than API Gateway's 29 seconds are handed to an assist worker, a 15-minute copy of the same Lambda. The route answers `202` with a job id at once and the app polls for the result. The AI assistant streams its answers from its own Lambda over server-sent events for up to 15 minutes. Its tools call the domain APIs as the signed-in user, so it can never see more than that user can. External agents reach the same APIs through the MCP server at `/mcp/global` with a personal token.

**3. Long-running work.** Research, persona generation, document generation, prototypes and autonomous agent runs are Step Functions workflows. Their job Lambdas call Bedrock and save results and progress to DynamoDB. An agent heartbeat checks agent triggers every 15 minutes. Credentials live in Secrets Manager, and all data is encrypted with a customer-managed KMS key.

The infrastructure is five CDK stacks: `VocCoreStack` (tables, buckets, Cognito, CloudFront), `VocIngestionStack` (plugins, schedules, queues), `VocProcessingStack` (processor, aggregator, Step Functions, agents), `VocApiStack` (API Gateway and its Lambdas) and `VocWebSearchStack` (web search gateway and Bedrock model access). Each plugin is self-contained with a `manifest.json` that defines its infrastructure, UI config and credentials. See [Plugin Architecture](docs/plugin-architecture.md), [Processing Pipeline](docs/processing-pipeline.md) and [Data Lake Structure](docs/data-lake-structure.md).

## 🚀 Quick Start

```bash
# Clone and install
git clone https://github.com/aws-samples/sample-voice-of-customer-datalake.git
cd sample-voice-of-customer-datalake
npm run install:all

# Build Lambda layers (requires Docker or Finch)
npm run build:layers

# Bootstrap CDK (first time only)
npm run cdk:bootstrap

# Deploy everything
npm run deploy:all
```

See [Deployment Guide](docs/deployment.md) for detailed instructions.

## 🧪 Running the Tests

```bash
npm run install:all   # once, installs root + CDK + frontend dependencies
npm run test          # frontend Vitest suite
```

Other suites live behind their own scripts: `npm run test:cdk` (CDK),
`npm run test:stream` (AI assistant stream Lambda), and `npm run test:backend`
(Python pytest — needs the Python venv, which `install:all` does not create;
see the [Deployment Guide](docs/deployment.md#quality-checks)).
`npm run check` runs the full quality gate before you open a pull request. See
[Quality Checks](docs/deployment.md#quality-checks) for what each script covers.

## 🔐 Initial Login

After deployment, an initial admin user is created automatically:

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | Check CloudFormation stack outputs for `InitialAdminPassword` |

The password is generated when the admin user is first created and stored as a CloudFormation output. Retrieve it with:

```bash
aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InitialAdminPassword`].OutputValue' \
  --output text
```

> 🔒 **Note**: You will be prompted to change this password on your first login.
> On redeployments the admin user is left untouched — no new user is created, the
> password is never reset, and the output shows a placeholder instead of a password.

## ⚙️ Configuration

Enable/disable plugins and menu items in `voc-datalake/cdk.context.json`:

```json
{
  "pluginStatus": {
    "webscraper": true
  },
  "menuStatus": {
    "dashboard": true,
    "scrapers": true
  }
}
```

After changes: `npm run generate:config && npm run deploy:frontend`

## 🔌 Built-in Data Sources

| Category | Sources |
|----------|---------|
| Scraping | Web Scraper (CSS selectors, JSON-LD extraction) |
| Review sites | Web Reviews: public review pages read with a managed browser (AgentCore Browser) |
| App Reviews | iOS App Reviews (Apple App Store), Android App Reviews (Google Play) |
| Issue trackers | GitHub Issues (scheduled sync plus a signed webhook) |
| File Import | S3 Import, manual CSV import |
| Direct Collection | Feedback Forms (embeddable forms) |
| Workshop Data | Synthetic Reviews generator |

The GitHub Issues plugin also ingests in real time through a signed webhook (`POST /webhooks/github_issues`); custom plugins can add their own.

## 🛠️ Create Your Own Plugin

```bash
cp -r voc-datalake/plugins/_template voc-datalake/plugins/my_source
# Edit manifest.json and handler.py
npm run validate:plugins
```

See [Getting Started with Plugins](docs/getting-started-plugins.md).

## 📊 Tech Stack

| Layer | Technologies |
|-------|-------------|
| Infrastructure | AWS CDK (5 stacks), Lambda (Python 3.14, Node.js for the assistant stream), DynamoDB, S3, SQS, API Gateway, Step Functions, EventBridge |
| AI/ML | Amazon Bedrock (Claude), Bedrock AgentCore (web search, browser), Comprehend, Translate |
| Frontend | React 19, Vite 7, Tailwind CSS 4, Zustand, TanStack Query |
| Security | Cognito, IAM, KMS, Secrets Manager, signed CloudFront URLs |

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/deployment.md) | How to deploy the platform |
| [EU Deployment](docs/eu-deployment.md) | `inferenceScope=eu`: EU inference profiles, model availability, web search and avatars, region choice |
| [Autonomous Agents](docs/autonomous-agents.md) | Agents, triggers, workflows, runs, decisions and plans |
| [Assistant Plan Mode](docs/assistant-plan-mode.md) | Multi-step requests the assistant proposes and runs after approval |
| [Persona Generation](docs/persona-generation.md) | Add personas next to the existing ones or replace them; how additive runs avoid repeating them |
| [Assistant Mentions](docs/assistant-mentions.md) | `@persona`, `@all` and `#document` in the project assistant: personas review tagged documents |
| [Memory](docs/memory.md) | Company and personal memory: extraction, review, retention |
| [Problem Analysis](docs/problem-analysis.md) | How /problems counts the whole window: `GET /feedback/problems`, grouping, partial and truncated answers |
| [Account or Administration](docs/account-vs-admin.md) | Where a setting lives: the six Administration tabs, the Account page, and what moves between them |
| [Morning brief](docs/briefing.md) | Per-user brief on Home: triggers, cost, email, privacy |
| [MCP](docs/mcp.md) | The global MCP server, tokens and tools for external agents |
| [Categories](docs/categories.md) | Categories, products, owners and per-user category access |
| [Company Context](docs/company-context.md) | Company vision, personal objectives and the design system |
| [Dimensions](docs/dimensions.md) | Dimensions, tags and channels: model, value sources, filters, API |
| [Source Policies](docs/source-policies.md) | Source profiles, PII redaction, restricted sources, retention and erasure |
| [Kiro Design System](docs/kiro-design-system.md) | Frontend themes, colours, typography, components, motion and UI rules (ported from KiroCrew) |
| [Project Workspace](docs/project-workspace.md) | Managed artifacts, prioritization, room voting, and MCP access |
| [Prioritization Scoring](docs/prioritization.md) | The workspace scoring setup: metrics, weights, directions, the composite formula, templates, routes |
| [Kiro ACP Browser Bridge](docs/kiro-acp-browser-bridge.md) | Send work from a browser to a local `kiro-cli` over ACP (`tools/kiro-acp-bridge`), options and threat model |
| [Plugin Architecture](docs/plugin-architecture.md) | Technical plugin system design |
| [Getting Started with Plugins](docs/getting-started-plugins.md) | Creating new data source plugins |
| [Feedback Forms](docs/feedback-forms.md) | Embeddable feedback forms |
| [Scrapers](docs/scrapers.md) | Web scraper configuration |
| [Mobile App Reviews](docs/mobile-app-reviews.md) | iOS & Android app store review plugins |
| [Web Reviews](docs/web-reviews.md) | Reviews from public review pages with a managed browser; blocked sites reported |
| [GitHub Issues](docs/github-issues.md) | Issues as feedback: sync, webhook, version and label metrics |
| [Ways of working with AI](docs/ways-of-working.md) | Per-user Human-driven / AI-assisted / AI-driven for PR/FAQs and PRDs: what each allows, writing by hand, server enforcement |
| [Document review](docs/document-review.md) | Margin comments on PR/FAQs and PRDs, "Ask personas to review", the share-for-review link and its email sign-in |
| [Decisions and Release Watch](docs/decisions-and-release-watch.md) | Decision records on projects (Pursue seeds a PR/FAQ) and before/after feedback per release |
| [Email Inbox](docs/email-intake.md) | Feedback by email (off by default): SES receiving, guards, threads and dedupe, attachments, custom domain setup |
| [Radar](docs/radar.md) | Other brands: love/hate, releases from web search, comparison |
| [Participants](docs/participants.md) | Lists of people to ask for feedback, asks by email (SES), unsubscribe, attribution, erasure |
| [Feedback boards](docs/feature-requests.md) | Boards per team or audience (sales requests, service issues, beta feedback): templates, fields, audiences, +1s, the boards' own sign-in, promote to a project |
| [Data Lake Structure](docs/data-lake-structure.md) | S3 and DynamoDB organization |
| [Processing Pipeline](docs/processing-pipeline.md) | How feedback is processed |
| [Lambda Sizing](docs/lambda-sizing.md) | Memory and timeout policy for every Lambda, and how it is measured |
| [Read Caching](docs/caching.md) | Version counters, the warm-container read memo, ETag/304: TTLs, invalidation, how to verify |
| [Code Audit](docs/code-audit.md) | `npm run audit:code`: dead-code, renamed-clone and re-implemented-helper detectors, how to read and allowlist them |
| [Changelog](CHANGELOG.md) | Release notes and upgrade guidance |

## 📄 License

MIT No Attribution - See [LICENSE](LICENSE) for details.
