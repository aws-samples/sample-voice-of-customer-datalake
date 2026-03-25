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

Each plugin is self-contained with a `manifest.json` that defines infrastructure, UI config, and credentials. See [System Documentation](.kiro/SYSTEM_DOCUMENTATION.md#plugin-architecture).

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

See [Deployment Guide](.kiro/steering/deployment.md) for detailed instructions.

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
| Direct Input | Feedback Forms (embeddable forms) |

## 🛠️ Create Your Own Plugin

```bash
cp -r plugins/_template plugins/my_source
# Edit manifest.json and handler.py
npm run validate:plugins
```

See [System Documentation](.kiro/SYSTEM_DOCUMENTATION.md#creating-plugins).

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
| [System Documentation](.kiro/SYSTEM_DOCUMENTATION.md) | Complete technical documentation |
| [Deployment Guide](.kiro/steering/deployment.md) | How to deploy the platform |
| [Tech Stack](.kiro/steering/tech.md) | Technology stack and best practices |
| [Project Structure](.kiro/steering/structure.md) | Repository organization |
| [Product Overview](.kiro/steering/product.md) | Product features and capabilities |

## 📄 License

Apache-2.0 - See [LICENSE](LICENSE) for details.
