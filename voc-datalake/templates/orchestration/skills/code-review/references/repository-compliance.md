# Repository Compliance Checks (open-source and sample repositories)

What an open-source or sample repository usually requires of every change, beyond the code's correctness. Each
check follows the repository's own rule: read its existing files, its contributing guide and its licence first,
and hold the change to what they show.

## Licence Headers

When the repository's source files carry a licence header (a copyright line and an SPDX identifier), every new
source file in the change carries the same header, in the same form as its neighbours:
```python
# Copyright <the holder the repository names>. All Rights Reserved.
# SPDX-License-Identifier: <the repository's licence, e.g. MIT-0>
```
Check: read two or three existing files of the same kind, then every new file in the patch. Flag a missing or
different header. A repository whose files carry no header needs none.

## Security Scan Results

- Every `# nosec`, `# noqa`, `// nosec`, `// noqa` suppression the change adds is documented where the repository
  documents them (for example `SECURITY_SCAN_RESULTS.md`)
- Each entry: file path, line, rule ID, justification, approver
- Check: search the patch's added lines for `nosec` and `noqa`

## AWS Service Name Standards

First mention per file uses full official name. Short forms OK after.
- "Amazon Bedrock AgentCore", not "AgentCore"
- "AWS Lambda", not "Lambda"
- "Amazon DynamoDB", not "DynamoDB"
- "Amazon API Gateway", not "API Gateway"
- "Amazon CloudWatch Logs", not "CloudWatch"
- "AWS Secrets Manager", not "Secrets Manager"
- "Amazon S3" (acceptable short form after first mention)
- "AWS Identity and Access Management (IAM)" on first mention

## Content Quality

- No absolute guarantees: replace "never/always/impossible/guaranteed" with "does not/should/unlikely/designed to"
- Replace "ensure" with "verify", "confirm", or "validate" in security contexts
- Account IDs: `123456789012` (12 digits)
- Region names: `us-east-1` or `us-west-2` (not `REGION` or `YOUR-REGION`)
- No promotional language in technical sections

## Input Validation at Boundaries

For all entry points (API handlers, CLI parsers, event handlers):
- Type checking on all payload fields (Pydantic, Zod, struct tags, JSR 380)
- Length limits on string inputs
- Enum validation (allowlist, not blocklist)
- Number ranges (min/max bounds)
- Array/list size limits
