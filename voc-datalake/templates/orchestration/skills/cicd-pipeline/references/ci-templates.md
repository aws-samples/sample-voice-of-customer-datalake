# CI/CD Templates

Templates below use tags (`@v4`) for readability. A workflow that merges pins each action to its full SHA (the skill's Step 2).

## Python CI

```yaml
name: Python CI

on:
  push:
    branches: [main]
    paths: ['**.py', 'pyproject.toml', 'uv.lock']
  pull_request:
    paths: ['**.py', 'pyproject.toml', 'uv.lock']

permissions:
  contents: read
  checks: write

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e # v10.3.2
        with:
          python-version: '3.12'  # Update to latest LTS: python.org/downloads/

      - run: uv sync --frozen

      - name: Lint
        run: uv run ruff check src/ tests/

      - name: Format
        run: uv run ruff format --check src/ tests/

      - name: Type check
        run: uv run pyright src/

  test:
    runs-on: ubuntu-latest
    needs: quality
    strategy:
      matrix:
        python-version: ['3.11', '3.12']
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e # v10.3.2
        with:
          python-version: ${{ matrix.python-version }}

      - run: uv sync --frozen

      - name: Run tests
        run: uv run pytest -v --cov=src --cov-report=xml --cov-fail-under=80

      - name: Upload coverage
        if: matrix.python-version == '3.12'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: coverage
          path: coverage.xml
```

## TypeScript CI

```yaml
name: TypeScript CI

on:
  push:
    branches: [main]
    paths: ['**.ts', '**.tsx', 'package.json', 'pnpm-lock.yaml']
  pull_request:
    paths: ['**.ts', '**.tsx', 'package.json', 'pnpm-lock.yaml']

permissions:
  contents: read
  checks: write

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6
        with:
          version: 10

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24  # Update to latest LTS: nodejs.org
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Lint and format
        run: pnpm biome check src/

      - name: Type check
        run: pnpm tsc --noEmit

      - name: Dead code
        run: pnpm knip --no-exit-code

  test:
    runs-on: ubuntu-latest
    needs: quality
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6
        with:
          version: 10

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24  # Update to latest LTS: nodejs.org
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm vitest run --coverage

      - name: Upload coverage
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: coverage
          path: coverage/
```

## Docker Build

```yaml
name: Docker Build

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3

      - uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6
        with:
          context: .
          push: false
          load: true
          tags: myapp:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Scan image
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: myapp:${{ github.sha }}
          severity: HIGH,CRITICAL
          exit-code: 1
```

The official `trivy-action` wraps the Trivy container for you: no DinD socket mount, no
hand-rolled `docker run`, and it reports results in the Actions UI via SARIF upload when
`format: sarif` is set.

## CDK Deployment

```yaml
name: CDK Deploy

on:
  push:
    branches: [main]
    paths: ['infra/**', 'src/**']

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false  # Never cancel deployments

jobs:
  diff:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE }}
          aws-region: us-east-1

      - uses: astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e # v10.3.2
        with:
          python-version: '3.12'

      - run: uv sync --frozen
      - run: uv run cdk diff 2>&1 | tee /tmp/cdk-diff.txt

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: cdk-diff
          path: /tmp/cdk-diff.txt

  deploy:
    runs-on: ubuntu-latest
    needs: diff
    environment: production  # Requires approval
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE }}
          aws-region: us-east-1

      - uses: astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e # v10.3.2
        with:
          python-version: '3.12'

      - run: uv sync --frozen
      - run: uv run cdk deploy --all --require-approval never
```

## PR Validation

```yaml
name: PR Checks

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - name: Check commit messages
        run: |
          git log --oneline origin/main..HEAD | while read line; do
            if ! echo "$line" | grep -qE '^[a-f0-9]+ (feat|fix|docs|refactor|test|chore|perf|ci|build|revert):'; then
              echo "Bad commit: $line"
              exit 1
            fi
          done

      - name: Check for large files
        run: |
          find . -type f -size +1M -not -path './.git/*' | head -5 | while read f; do
            echo "Large file: $f ($(du -h "$f" | cut -f1))"
            exit 1
          done
```

## Caching Strategy

| Stack | Cache Target | Key |
|---|---|---|
| Python (uv) | `~/.cache/uv` | `runner.os + hashFiles('uv.lock')` |
| TypeScript (pnpm) | pnpm store | Built into `actions/setup-node` with `cache: pnpm` |
| Docker | BuildKit layers | `type=gha` in build-push-action |

Cache limits: 10GB per repository. GitHub evicts entries after 7 days without access.

## Keeping SHA Pins Current

A SHA pin resolved once goes stale the moment the upstream action ships a security fix.
Dependabot opens the version-bump PR for you; `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ["*"]
```

Dependabot resolves the new SHA and keeps the trailing `# v4` comment in sync automatically.
Review and merge the PR like any other dependency bump; do not auto-merge actions that touch
`permissions` or deployment credentials.
