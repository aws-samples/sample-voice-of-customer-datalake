# Voice of Customer (VoC) Data Lake

A fully serverless AWS platform for ingesting, processing, and analyzing customer feedback using AI-powered insights with Amazon Bedrock.

## 🎬 Demo

![VoC Demo](static/VoC%20Demo.gif)

## ✨ Features

- **Plugin-Based Architecture**: Extensible data source plugins, easily create your own
- **AI-Powered Analysis**: Amazon Bedrock (Claude) for sentiment, categorization, and insights
- **Real-Time Processing**: Event-driven with SQS and DynamoDB Streams
- **Multi-Language Support**: Auto-detection and translation
- **React Dashboard**: Metrics, charts, AI chat, and project management
- **Secure**: Cognito auth, WAF protection, KMS encryption

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA SOURCE PLUGINS                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                        │
│  │ Web Scraper │ │   Custom    │ │  Feedback   │                        │
│  │   Plugin    │ │   Plugins   │ │    Forms    │                        │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘                        │
│         └───────────────┴───────────────┘                               │
│                         │                                                │
│             ┌───────────┴───────────┐                                   │
│             │   Plugin Loader (CDK)  │                                   │
│             │  manifest.json → Lambda │                                   │
│             └───────────┬───────────┘                                   │
└─────────────────────────┼───────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│  S3 Raw Data  →  SQS Queue  →  Processor Lambda  →  DynamoDB Feedback  │
│                               (Bedrock + Comprehend)                    │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│  API Gateway (17 Lambdas)  →  CloudFront  →  React Dashboard           │
└────────────────────────────────────────────────────────────────────────┘
```

Each plugin is self-contained with a `manifest.json` that defines infrastructure, UI config, and credentials. See [Plugin Architecture](docs/plugin-architecture.md).

## 🚀 Quick Start

```bash
# Clone and install
git clone xxxxxx (repo url)
cd voice-of-customer-datalake
npm run install:all

# Build Lambda layers (requires Docker)
npm run build:layers

# Bootstrap CDK (first time only)
npm run cdk:bootstrap

# Deploy everything
npm run deploy:all
```

See [Deployment Guide](docs/deployment.md) for detailed instructions.

## 🔐 Initial Login

After deployment, an initial admin user is created automatically:

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | Check CloudFormation stack outputs for `InitialAdminPassword` |

The password is randomly generated during deployment and stored as a CloudFormation output. Retrieve it with:

```bash
aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InitialAdminPassword`].OutputValue' \
  --output text
```

> 🔒 **Note**: You will be prompted to change this password on your first login.

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

## 🔌 Built-in Plugins

| Category | Plugins |
|----------|---------|
| Scraping | Web Scraper (CSS selectors, JSON-LD extraction) |
| App Reviews | iOS App Reviews (Apple App Store), Android App Reviews (Google Play) |
| Direct Input | Feedback Forms (embeddable forms) |

## 🛠️ Create Your Own Plugin

```bash
cp -r plugins/_template plugins/my_source
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
| Security | Cognito, WAF, KMS, Secrets Manager |

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/deployment.md) | How to deploy the platform |
| [Plugin Architecture](docs/plugin-architecture.md) | Technical plugin system design |
| [Getting Started with Plugins](docs/getting-started-plugins.md) | Creating new data source plugins |
| [Feedback Forms](docs/feedback-forms.md) | Embeddable feedback forms |
| [Scrapers](docs/scrapers.md) | Web scraper configuration |
| [Mobile App Reviews](docs/mobile-app-reviews.md) | iOS & Android app store review plugins |
| [Data Lake Structure](docs/data-lake-structure.md) | S3 and DynamoDB organization |
| [Processing Pipeline](docs/processing-pipeline.md) | How feedback is processed |

## 📄 License

Apache-2.0 - See [LICENSE](LICENSE) for details.
