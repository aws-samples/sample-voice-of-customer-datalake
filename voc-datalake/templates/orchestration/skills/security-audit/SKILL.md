---
name: security-audit
description: "Application security audit against OWASP Top 10:2025: authentication and authorisation, input validation, information disclosure, infrastructure IAM, dependency CVEs, client-side XSS and CSRF, API security, supply chain. For auditing code or reviewing auth; AWS IaC alone is aws-security's."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/security-audit"
license: MIT
adapted: "The spec-loader step reads SECURITY.md and INFRA.md with read_file. Scanners run as run's argv with the repository's installed tools, offline: registry rulesets (semgrep p/...) and advisory databases (npm audit, pip-audit) need the network, so a missing or offline tool is a reported gap. Results go in findings or the finish; suppressions are the builder's or fixer's within its change. A reference to an unvendored skill is dropped."
---

Run a security audit on the code your task names (a reviewer: the files the patch changes, read in full).

Default: the checkout (the repository at the run's commit).

## Step 0: Load Project Specs

If the repository has a SECURITY.md (banned patterns, auth rules, secrets policy), read it with `read_file`, and
INFRA.md for the AWS context; else the built-in OWASP baseline below.

Cite SECURITY.md rules in findings. Add OWASP findings on top of SECURITY.md rules; they complement, not replace.

## Step 1: Detect Stack and Threat Surface

Read `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` and the repository's own notes for contributors.
Read every file before flagging vulnerabilities. Do not speculate about code you have not read.

| Surface | Stacks | Focus |
|---|---|---|
| Web app | React, Next.js, Vue | Client-side + API checks |
| API service | FastAPI, Express, Go | Input validation + auth + infra |
| CLI tool | Any | Input validation + dependencies |
| Infrastructure | CDK, Terraform, CloudFormation | IAM + encryption + network |
| Library/SDK | Any | Dependencies only |

## Step 2: Run Security Tools

The roles that run code run these with `run`, one argv each, with the tools the repository (or the image) has; a
reviewer that runs no code reads the code against Step 3 instead. The sandbox has no network: semgrep's registry
rulesets (`p/python`, `p/owasp-top-ten`) and the advisory databases behind `npm audit` and `pip-audit` cannot be
fetched there, so use the repository's local semgrep rules when it has them, and report what could not run as a gap.
The commands as a developer would type them:

```bash
# Python (use pyproject.toml config if present, otherwise -l for LOW+ severity)
if command -v bandit >/dev/null; then
  bandit -r "$TARGET" -q -c pyproject.toml 2>/dev/null || bandit -r "$TARGET" -q -l
else
  echo "SKIP: bandit not installed (pip install bandit)"
fi

# SAST: semgrep (Python + JS/TS, covers subprocess injection, XML, tempfile, encoding)
# p/owasp-top-ten ruleset predates the 2025 category renumbering below; it still
# flags the same underlying bug classes under its original rule IDs.
command -v semgrep && semgrep scan --config "p/python" --config "p/owasp-top-ten" --json --quiet $TARGET || echo "SKIP: semgrep not installed (pip install semgrep)"

# TypeScript/JS
command -v semgrep && semgrep scan --config "p/javascript" --config "p/owasp-top-ten" --json --quiet $TARGET || echo "SKIP: semgrep not installed"

# Secrets
command -v gitleaks && gitleaks dir "$TARGET" --report-format json || echo "SKIP: gitleaks not installed (brew install gitleaks)"

# Infrastructure
command -v checkov && checkov -d $TARGET --quiet || echo "SKIP: checkov not installed"

# Fast lint security (ruff S rules catch B104, B108, B310, B602 at lint speed)
command -v ruff && ruff check --select S --output-format concise $TARGET || echo "SKIP: ruff not installed"
```

**Missing tool = audit gap.** If any tool is unavailable, report it as a WARN in the audit output. Do not silently skip.

### Parse scanner output

Use `--json` output for structured triage. For each finding:
1. Read the rule ID, severity, file, and line number
2. Trace data flow: does untrusted input reach the flagged code?
3. Classify: FAIL (exploitable), WARN (fix before prod), or suppress (false positive)
4. Group findings by rule ID to fix patterns, not individual lines

### Triage tool findings

After running tools, read ALL findings including INFO severity:
1. **ERROR/WARNING**: investigate immediately, classify as FAIL or WARN
2. **INFO**: review each one. INFO findings include real issues (CSV injection, Secrets Manager path names). Do not auto-dismiss
3. **False positives**: a fixer or builder suppresses one in its own change with an inline comment + justification,
   documented in `SECURITY_SCAN_RESULTS.md`; a reviewer says it is a false positive in its finding instead

Common false positives: `references/checklists.md` (False Positive Triage section).

## Step 3: Core Security Checks

Detailed checklists for each category: `references/checklists.md`.

### Authentication and Authorization
- [ ] Tokens not logged, not in URLs
- [ ] Token validation: signature AND expiry
- [ ] JWT: algorithm validated, short-lived, no sensitive data in payload
- [ ] Session cookies: httpOnly + sameSite + secure
- [ ] Authorization on every protected route (not just auth presence)
- [ ] No IDOR (verify resource ownership)
- [ ] CORS: no wildcard `*` in production

### Input Validation (OWASP A05:2025 Injection)
- [ ] Request bodies validated at boundary (Zod, Pydantic, joi)
- [ ] SQL parameterized (no string concat with user input)
- [ ] Shell: `subprocess.run` with list args, not `shell=True` with user input
- [ ] No `eval()`, `exec()`, `pickle.loads()` on untrusted input
- [ ] YAML: `safe_load()` only
- [ ] CSV: `defusedcsv` instead of `csv` if user data flows into CSV output (prevents formula injection)
- [ ] URLs: no `urllib.request.urlopen()` with dynamic URLs (supports `file://` scheme, use `requests` library)
- [ ] File paths canonicalized, uploads validated
- [ ] Redirects against allowlist

### Information Disclosure (OWASP A01:2025 Broken Access Control, A02:2025 Security Misconfiguration)
- [ ] No stack traces in production error responses
- [ ] No sensitive data in logs (tokens, keys, PII)
- [ ] `.env`, `*.pem`, `*.key` in `.gitignore`
- [ ] No hardcoded credentials in source (including test files, gitleaks scans tests too)
- [ ] No secrets in client bundles (`NEXT_PUBLIC_`, `VITE_`)
- [ ] Source maps disabled in production

### Code Hygiene (ruff S rules + semgrep)
- [ ] `open()` calls include `encoding="utf-8"` (semgrep: unspecified-open-encoding)
- [ ] No hardcoded `/tmp` paths (ruff S108). Use `tempfile.mkdtemp()`
- [ ] No `subprocess.run(shell=True)` with dynamic args (ruff S602)
- [ ] No binding to `0.0.0.0` outside containers (ruff S104)
- [ ] No `time.sleep()` without justifying comment in production code
- [ ] XML parsed with `defusedxml`, not `xml.etree` (ruff S314)
- [ ] Docker: no secrets in `ARG`, no root user, `.dockerignore` exists

### API Security
- [ ] Rate limiting on auth endpoints and expensive operations
- [ ] Security headers: HSTS, CSP, X-Content-Type-Options, X-Frame-Options (repeat in every nginx location block)
- [ ] Pagination on list endpoints
- [ ] No mass assignment (explicit field allowlist)

### Client-Side (web apps)
- [ ] No `dangerouslySetInnerHTML` / `v-html` with user content
- [ ] CSP: no `unsafe-inline` or `unsafe-eval`
- [ ] CSRF tokens on state-changing endpoints
- [ ] No tokens in `localStorage`
- [ ] `postMessage` handlers validate origin

### Infrastructure
- [ ] IAM: no `*` actions/resources without documented justification
- [ ] Secrets in SSM/Secrets Manager, not env vars or code
- [ ] Encryption at rest and in transit (TLS 1.2+)
- [ ] VPC security groups: no 0.0.0.0/0 ingress
- [ ] Lambda: explicit timeout, memory, runtime
- [ ] S3: BlockPublicAccess, SSL enforcement
- [ ] No weak crypto (MD5, SHA1, DES, RC4)

### Dependencies and Supply Chain
- [ ] Run `npm audit` / `pip-audit` / `cargo audit` where they can (they need the advisory database: offline, a gap)
- [ ] Report HIGH and CRITICAL CVEs with remediation
- [ ] Lock files in the repository
- [ ] Dependencies from official registries
- [ ] Docker images from verified publishers
- [ ] GitHub Actions pinned to commit SHA
- [ ] Approved licenses (no GPL in proprietary code without review)

### Security Documentation
- [ ] `SECURITY.md` exists with threat model and shared responsibility
- [ ] Scanner suppressions documented in `SECURITY_SCAN_RESULTS.md`
- [ ] No superlatives in security claims ("never/always/guaranteed")

## Step 4: Report

A reviewer or hunter writes each FAIL and WARN as a finding (`write_findings`: file, line, severity, rule,
evidence); every role puts the summary in its finish.

```
## Security Audit Report

### Threat Surface: [web app / API / CLI / infrastructure / library]
### Summary: X FAIL / Y WARN / Z PASS / W N/A

| # | Category | Check | Status | File:Line | Details |
|---|----------|-------|--------|-----------|---------|
| 1 | Auth | JWT expiry validated | FAIL | src/auth.py:42 | Token decoded without checking `exp` claim |
| 2 | Input | SQL parameterized | PASS | src/db.py:18 | Uses parameterized queries via SQLAlchemy |
| 3 | Infra | IAM least privilege | WARN | infra/iam.py:31 | `s3:*` on resource `*`; scope to specific bucket |

### OWASP Top 10:2025 Coverage
| OWASP | Category | Status |
|---|---|---|
| A01 | Broken Access Control | |
| A02 | Security Misconfiguration | |
| A03 | Software Supply Chain Failures | |
| A04 | Cryptographic Failures | |
| A05 | Injection (includes SSRF) | |
| A06 | Insecure Design | |
| A07 | Authentication Failures | |
| A08 | Software or Data Integrity Failures | |
| A09 | Security Logging and Alerting Failures | |
| A10 | Mishandling of Exceptional Conditions | |
```

OWASP Top 10:2025 reordered and renamed several 2021 categories: Supply Chain
Failures is now A03 (was folded into A06/A08 in 2021), SSRF (2021 A10) merged into
Injection (A05), and Mishandling of Exceptional Conditions (error handling, fail-open
logic) is a new A10. Map older findings: 2021 A01 Broken Access Control -> 2025 A01;
2021 A02 Cryptographic Failures -> 2025 A04; 2021 A05 Security Misconfiguration ->
2025 A02; 2021 A10 SSRF -> 2025 A05.

Status: **FAIL** (= MUST: exploitable, fix now) / **WARN** (= SHOULD: fix before prod) / **PASS** / **N/A**

## Step 5: Fix or Hand Over

A hunter posts each FAIL as a fix task (or a finding); a reviewer writes findings; a fixer or builder fixes within
its task's change:

1. Fix all FAIL items your task covers
2. Report WARN with specific remediation
3. Verify fixes compile and tests pass
4. Run the dependency audit commands that can run offline
5. For infrastructure: verify cdk-nag or checkov passes (tfsec is deprecated; use `trivy config .` or checkov instead)

For design rationale behind each security rule, see `references/design-decisions.md`.
For AWS infrastructure security, see the `aws-security` skill.
For code quality review, see the `code-review` skill.
