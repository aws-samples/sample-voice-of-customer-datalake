# Voice of Customer (VoC) Data Lake

A fully serverless AWS platform for ingesting, processing, and analyzing customer feedback using AI-powered insights with Amazon Bedrock.

## 🎬 Demo

![VoC Demo](static/VoC%20Demo.gif)

## ✨ Features

- **Plugin-Based Architecture**: Extensible data source plugins, easily create your own
- **AI-Powered Analysis**: Amazon Bedrock (Claude) for sentiment, categorization, and insights
- **Per-Surface Model Picker**: admins choose the Claude model per AI feature (chat, documents, prototypes, enrichment) over a curated allowlist
- **Web Search**: AgentCore Gateway connector for chat and research — deployed by default, searches stay opt-in per request (opt out with `enableWebSearch: false`)
- **Project Research Workspace**: generate personas, research, PRDs, PR/FAQs, product reports, and prototypes from customer evidence
- **Managed Artifact Versions**: persistent PRD, PR/FAQ, and prototype series with revision and derivation lineage
- **Team Prioritization**: compose document sets into scoring rows, collect individual or room ballots, and surface stale or cross-generation selections
- **External-Agent Access**: scoped, expiring MCP credentials expose eleven read-only feedback, metrics, project, persona, and job tools
- **Real-Time Processing**: Event-driven with SQS and DynamoDB Streams
- **Multi-Language Support**: Auto-detection and translation
- **React Dashboard**: Metrics, charts, AI chat, projects, and prioritization
- **Secure**: Cognito authentication, least-privilege IAM, KMS encryption, signed private assets, and Secrets Manager

## 🏗️ Architecture

```
Data sources → S3 raw archive → SQS → Processor Lambda → DynamoDB Feedback
                                       │                    │
                                       └─ Bedrock           └─ Stream → Aggregates

S3 website bucket → CloudFront → React Dashboard
React Dashboard  → API Gateway → Domain API Lambdas → DynamoDB / S3 / Bedrock
```

Each plugin is self-contained with a `manifest.json` that defines infrastructure, UI config, and credentials. See [Plugin Architecture](docs/plugin-architecture.md).

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
`npm run test:stream` (streaming chat Lambda), and `npm run test:backend`
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
| App Reviews | iOS App Reviews (Apple App Store), Android App Reviews (Google Play) |
| File Import | S3 Import, manual CSV import |
| Direct Collection | Feedback Forms (embeddable forms) |
| Workshop Data | Synthetic Reviews generator |

Custom plugins can add webhook ingestion; none of the bundled plugin manifests enables a webhook.

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
| Infrastructure | AWS CDK, Lambda (Python 3.14), DynamoDB, S3, SQS, API Gateway |
| AI/ML | Amazon Bedrock (Claude), Comprehend, Translate |
| Frontend | React 19, Vite 7, Tailwind CSS 4, Zustand, TanStack Query |
| Security | Cognito, IAM, KMS, Secrets Manager, signed CloudFront URLs |

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/deployment.md) | How to deploy the platform |
| [Project Workspace](docs/project-workspace.md) | Managed artifacts, prioritization, room voting, and MCP access |
| [Plugin Architecture](docs/plugin-architecture.md) | Technical plugin system design |
| [Getting Started with Plugins](docs/getting-started-plugins.md) | Creating new data source plugins |
| [Feedback Forms](docs/feedback-forms.md) | Embeddable feedback forms |
| [Scrapers](docs/scrapers.md) | Web scraper configuration |
| [Mobile App Reviews](docs/mobile-app-reviews.md) | iOS & Android app store review plugins |
| [Data Lake Structure](docs/data-lake-structure.md) | S3 and DynamoDB organization |
| [Processing Pipeline](docs/processing-pipeline.md) | How feedback is processed |
| [Changelog](CHANGELOG.md) | Release notes and upgrade guidance |

## 📄 License

MIT No Attribution - See [LICENSE](LICENSE) for details.
