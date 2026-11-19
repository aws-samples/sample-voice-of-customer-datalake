# Security Audit Detailed Checklists

Referenced from SKILL.md for deep-dive checks.

## Authentication and Authorization

### Token Security
- Auth tokens never logged (grep for `token`, `bearer`, `jwt`, `password`, `secret`, `api_key` in log/print/console)
- Tokens never in URLs (`?token=`, `?api_key=`)
- Token validation checks signature AND expiry
- Refresh flow handles expired tokens without exposing refresh tokens to client JS

### JWT Specifics
- Algorithm validated: reject `none`, enforce `RS256` or `ES256`
- `aud` and `iss` claims validated
- Short-lived expiry (15 min access, hours for refresh)
- Refresh tokens server-side or httpOnly cookie, never localStorage
- No sensitive data in JWT payload (base64, not encrypted)

### Session and Cookie
- Cookies: `httpOnly`, `sameSite=strict`, `secure` in production
- Session ID regenerated on login and privilege change
- Logout invalidates server-side (not just client cookie)

### OAuth/OIDC
- `state` parameter validated (CSRF prevention)
- PKCE for public clients (SPAs, mobile)
- Redirect URI against allowlist
- Authorization code single-use with short expiry

### Authorization
- Checks on every protected route (not just auth presence)
- Role/permission from server data, not client claims
- No IDOR: verify resource ownership
- Admin endpoints use separate middleware

### CORS
- No wildcard `*` origin in production
- Specific domains, not broad patterns
- `Access-Control-Allow-Credentials` only with specific origins

## Input Validation (OWASP A05:2025 Injection)

### Request Validation
- Bodies validated at boundary (Zod, Pydantic, joi)
- Query params validated and typed
- Path params validated (no `../` traversal)
- Content-Type checked before parsing
- Request size limits enforced

### Injection Prevention
- SQL parameterized (no string concat with user input)
- Shell commands: `subprocess.run` with list args, not `os.system`
- Template rendering auto-escapes (Jinja2 `autoescape=True`, React JSX)
- XML: `defusedxml` or safe flags
- YAML: `yaml.safe_load()` only
- CSV: `defusedcsv` instead of `csv` module when user data flows into CSV output (formula injection: `=CMD()` in cells)
- No `eval()`, `exec()`, `Function()`, `pickle.loads()` on untrusted input
- No `subprocess.run(shell=True)` with user args

### Dangerous Function Patterns (grep targets)

Scan for these known-dangerous patterns. Each requires audit, not automatic rejection:

```bash
# Python: URL scheme injection (file://, ftp://)
grep -rn "urlopen\|urllib.request" $TARGET
# Fix: use requests library, or validate scheme is https:// before opening

# Python: CSV formula injection
grep -rn "import csv" $TARGET
# Audit: if user data flows into csv.writer, use defusedcsv instead

# Python: pickle deserialization (arbitrary code execution)
grep -rn "pickle.loads\|pickle.load(" $TARGET

# Python: unsafe YAML
grep -rn "yaml.load(" $TARGET | grep -v "safe_load\|SafeLoader"

# Any: hardcoded API keys in test files
grep -rn "api.key\|api_key\|apikey\|authorization.*Bearer" tests/

# CDK/IaC: Secrets Manager path names (common B105 false positive)
grep -rn "B105\|hardcoded.password" $TARGET
```

### File Handling
- Paths canonicalized and checked against allowlist
- Uploads validated: type, size, name (no path traversal)
- Extensions validated against allowlist
- Stored outside web root with randomized names

### URL/Redirect
- Redirects against allowlist (no open redirect)
- URLs: reject `javascript:`, `data:`, `vbscript:`, `file://` schemes
- No `urllib.request.urlopen()` with dynamic URLs (supports `file://` scheme, bandit B310). Use `requests` library or validate scheme before opening
- SSRF: block internal IPs (127.0.0.1, 169.254.169.254, 10.x, 172.16-31.x, 192.168.x)

## Information Disclosure (OWASP A01:2025 Broken Access Control, A02:2025 Security Misconfiguration)

### Error Handling
- No stack traces/file paths/SQL in error responses
- Generic production error messages
- 404 for both "not found" and "not authorized" (no resource enumeration)
- Rate limit responses don't reveal algorithm

### Logging
- Debug mode disabled in production
- No sensitive data in logs
- Appropriate log levels
- Error logs don't expose architecture to clients

### Source Exposure
- `.env`, `*.pem`, `*.key` in `.gitignore`
- No hardcoded credentials
- No secrets in client bundles (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`)
- Source maps disabled in production

## API Security

### Rate Limiting
- On auth endpoints and expensive operations
- Per-user or per-IP, not global only
- `Retry-After` header in responses

### Security Headers
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy` restricts sources
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` disables unused features

### API Design
- Pagination on all list endpoints
- Field filtering (not entire objects)
- Explicit allowlist for mass assignment
- Idempotency keys on state-changing endpoints

## Client-Side Security

### XSS Prevention
- No `dangerouslySetInnerHTML` / `v-html` with user content
- Sanitize with DOMPurify if HTML needed
- No `javascript:`/`data:` URLs from user input
- CSP: no `unsafe-inline` or `unsafe-eval`

### CSRF
- CSRF tokens on state-changing endpoints
- SameSite cookie attribute
- Custom headers on SPA API calls

### Client Storage
- No tokens in `localStorage` (use httpOnly cookies)
- `sessionStorage` for session-scoped data
- No sensitive data in URL hash

### Frontend Dependencies
- No untrusted `npm:` imports
- CDN scripts with SRI hashes
- `postMessage` handlers validate origin

## Infrastructure Security

### IAM
- No `*` actions/resources without justification
- Service roles scoped to specific ARNs
- Cross-account: assume-role with external ID
- No hardcoded credentials

### Secrets Management
- SSM Parameter Store or Secrets Manager
- Rotation enabled where supported
- Encrypted with customer-managed KMS in production
- No defaults in committed config

### Encryption
- At rest: S3, DynamoDB, RDS, EBS, SQS
- In transit: TLS 1.2+
- KMS key rotation for production
- No weak algorithms (MD5, SHA1, DES, RC4)
- Passwords: bcrypt, scrypt, or Argon2

### Network
- VPC security groups least privilege
- DB not publicly accessible
- Lambda in VPC only if needed
- API Gateway with WAF/throttling

### Compute
- Lambda: explicit timeout, memory, runtime
- Containers: non-root, read-only FS, no privileged
- EC2: SSM Session Manager, no SSH keys in source
- ECS/EKS: per-service task roles

### Storage
- S3: BlockPublicAccess, SSL, versioning
- DynamoDB: encryption, PITR for production
- RDS: encryption, backups, deletion protection

### Logging/Monitoring
- CloudTrail for management events
- CloudWatch alarms for auth failures, errors, cost
- Access logs on API Gateway, ALB, S3
- Log retention configured

## Application Code Hygiene

Patterns that scanners flag but skills previously missed. Ruff `S` rules catch most of these at lint time.

### File Operations
- `open()` without `encoding=` parameter (semgrep: `unspecified-open-encoding`). Fix: add `encoding="utf-8"` to every `open()` call
- `read_bytes()` followed by `len()` check (read-then-validate DoS). Fix: `stat().st_size` before reading
- Hardcoded `/tmp` paths (bandit B108, ruff S108). Fix: use `tempfile.mkdtemp()` or pytest `tmp_path`
- `tempfile.NamedTemporaryFile` without `.flush()` before using `.name` (semgrep: `tempfile-without-flush`)

### Subprocess Security
- `subprocess.run(shell=True)` with dynamic args (bandit B602, ruff S602). Fix: use list form
- `subprocess.run` with tainted env vars (semgrep: `dangerous-subprocess-use-tainted-env-args`). Fix: validate input with allowlist regex
- `os.system()` anywhere (always use subprocess with list args)

### Network and Binding
- Binding to `0.0.0.0` (bandit B104, ruff S104). Fix: use env var `BIND_HOST` defaulting to `127.0.0.1`, suppress with `# nosec B104` only in containers
- `urllib.request.urlopen()` with dynamic URLs (bandit B310, ruff S310). Fix: use `requests` library or validate URL scheme
- `exit()` instead of `sys.exit()` (semgrep: `use-sys-exit`)

### Blocking Calls
- `time.sleep()` in production code (semgrep: `arbitrary-sleep`). Acceptable for: rate limiting (add comment), benchmark warmup (add nosemgrep). Fix for polling: use `asyncio.Event` or `threading.Event`

### XML and Serialization
- `xml.etree.ElementTree` without `defusedxml` (semgrep: `use-defused-xml`, bandit B314). Fix: `import defusedxml.ElementTree as ET`
- `pickle.loads()` on untrusted data (bandit B301, ruff S301)
- `yaml.load()` without SafeLoader (bandit B506)

### Python List and String Bugs
- Implicit string concatenation in lists (semgrep: `string-concat-in-list`). Missing comma causes silent string merging. Grep: look for adjacent string literals in list definitions
- `is_running` without parentheses when it's a method, not a property (semgrep: `is-function-without-parentheses`). Fix: verify `@property` decorator exists, or add `()`

### Web Server Configuration (nginx, reverse proxy)
- `add_header` in `location` block silently replaces all `server`-level headers (semgrep: `header-redefinition`). Fix: repeat security headers in every location block
- `proxy_set_header Host $http_host` allows host header injection (semgrep: `request-host-used`). Fix: use `$server_name` or a validated map
- `proxy_set_header Upgrade $http_upgrade` without filtering enables H2C smuggling (semgrep: `possible-nginx-h2c-smuggling`). Fix: use a `map` that only allows `websocket` upgrades
- Security headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options) must appear in every location block, not just server level

### Docker Security
- `ARG` for secrets in Dockerfile (semgrep: `secret-in-build-arg`). Build args are visible in image history. Fix: use `--mount=type=secret` (BuildKit) or runtime env vars
- Running as root (no `USER` directive)
- `COPY . .` without `.dockerignore` (copies .env, .git, node_modules)

### Grep Targets for New Patterns

```bash
# open() without encoding
grep -rn "open(" $TARGET --include="*.py" | grep -v "encoding=" | grep -v "\.read_bytes\|\.write_bytes\|mode=.*b"

# time.sleep in production code (exclude tests)
grep -rn "time\.sleep" $TARGET --include="*.py" | grep -v "test_\|_test\.\|conftest\|fixtures"

# Hardcoded /tmp
grep -rn '"/tmp' $TARGET --include="*.py"

# exit() instead of sys.exit()
grep -rn "^[^#]*\bexit(" $TARGET --include="*.py" | grep -v "sys\.exit\|pytest\.exit"

# Implicit string concat in lists
# (hard to grep; semgrep catches this better)

# nginx header issues
grep -rn "add_header" $TARGET --include="*.conf" | grep "location"
grep -rn "proxy_set_header Host" $TARGET --include="*.conf"
```

## Dependencies and Supply Chain

### Vulnerability Scanning
- `npm audit` / `pip audit` / `cargo audit` / `trivy fs .`
- Lock files committed
- No wildcard versions on security-critical packages

### Supply Chain
- Dependencies from official registries
- No squattable private package names
- Docker from official/verified publishers
- GitHub Actions pinned to commit SHA

### License
- Approved licenses (MIT, Apache-2.0, BSD, ISC, MPL-2.0)
- No GPL/AGPL in proprietary code without legal review

## Security Documentation

- `SECURITY.md`: threat model, data classification, shared responsibility
- `THREAT_MODEL.md`: STRIDE analysis, trust boundaries, mitigations
- `SECURITY_SCAN_RESULTS.md`: all scanner suppressions with justifications
- Architecture diagram: auth boundaries, encryption, data flow
- Module docstrings: security posture for auth/secrets/external API modules
- Key management: rotation policy, CMK upgrade path

## False Positive Triage

Tool findings that look like issues but are not. Suppress with inline comment + document in `SECURITY_SCAN_RESULTS.md`.

### Bandit

| Rule | Trigger | When It's False | Suppression |
|---|---|---|---|
| B105 | String containing "password", "secret", "credentials" | Secrets Manager path name, config key name, not the actual secret | `# nosec B105 — Secrets Manager path reference, not a credential` |
| B104 | Binding to `0.0.0.0` | Container behind ALB/reverse proxy, not exposed to internet | `# nosec B104 — container bound to 0.0.0.0, accessed only via ALB` |
| B310 | `urllib.request.urlopen()` | URL is a constant or from trusted config, not user input | `# nosec B310 — URL from config, not user-controlled` |
| B608 | SQL string formatting | String is a table/column name from code, not user input | `# nosec B608 — table name from internal constant` |

### Gitleaks

| Pattern | Trigger | When It's False | Fix |
|---|---|---|---|
| generic-api-key | String matching `[A-Za-z0-9]{32,}` in test files | Test fixtures using fake/dummy keys | Use obviously-fake values: `test-key-not-real-000000`, add to `.gitleaksignore` |
| generic-api-key | Environment variable assignment in CI config | Variable name references a key, value is a placeholder | Add pattern to `.gitleaks.toml` allowlist |

### Semgrep

| Rule | Trigger | When It's False | Fix |
|---|---|---|---|
| use-defusedcsv | `import csv` | CSV output contains only internal data, no user input flows into cells | Add `# nosemgrep: use-defusedcsv` with comment explaining data source |
| dynamic-urllib-use-detected | `urlopen(url_var)` | URL constructed from trusted config, not request parameters | Use `requests.get()` instead (cleaner API, no `file://` support) |

### Triage Process

1. Read the finding. Identify the exact code line
2. Trace the data flow: does untrusted input reach this code?
3. If NO untrusted input: suppress with comment + document in SECURITY_SCAN_RESULTS.md
4. If YES untrusted input: classify as FAIL, fix the code
5. If UNCERTAIN: classify as WARN, flag for team review
