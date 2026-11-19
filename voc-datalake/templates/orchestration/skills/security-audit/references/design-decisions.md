# Security Audit: Design Decisions

Why each rule exists, told through the incidents that motivated them.

## INFO Severity Must Be Reviewed

**Rule**: Review ALL tool findings including INFO severity. Do not auto-dismiss.

**Battle story**: A bandit INFO-level finding flagged `csv.writer` usage where user-submitted data flowed into cells. Team dismissed it as noise. Three months later, a security researcher reported CSV formula injection: cells starting with `=CMD(...)` executed in Excel when analysts downloaded reports. The fix required `defusedcsv` and an emergency patch.

**How to apply**: When triaging scanner output, read every INFO finding. Check if user data flows into the flagged code path. Suppress only with inline comment and documented justification.

## Gitleaks Scans Test Files Too

**Rule**: Run gitleaks on test files, not just source.

**Battle story**: A developer committed a test fixture with a real AWS access key (copied from their local env for "quick testing"). The key was in `tests/fixtures/config.json`. Standard secret scanners skipping test directories missed it. The key was scraped from a public GitHub repo within 4 hours and used to spin up crypto mining instances.

**How to apply**: Never exclude `tests/` from secret scanning. Use mock credentials in test fixtures (`AKIAIOSFODNN7EXAMPLE` is the AWS placeholder).

## CORS Wildcard Blocks Production

**Rule**: No CORS `*` in production.

**Battle story**: An internal API used `Access-Control-Allow-Origin: *` because "only our frontend calls it." An attacker created a phishing page that made authenticated requests to the API from the victim's browser, exfiltrating customer data. The API trusted the browser's cookies, and CORS `*` allowed any origin to read responses.

**How to apply**: Always list specific allowed origins. For development, use `localhost:*` patterns. For production, enumerate the exact frontend domains.

## No Tokens in localStorage

**Rule**: Store tokens in httpOnly cookies, not localStorage.

**Battle story**: An XSS vulnerability in a third-party analytics widget allowed attackers to read `localStorage` and exfiltrate JWT tokens. httpOnly cookies are inaccessible to JavaScript, so the same XSS would not have leaked the session.

**How to apply**: Check for `localStorage.setItem` with token/session values. Migrate to httpOnly cookies with sameSite=Strict and secure flags.

## URL Validation: No urllib with Dynamic URLs

**Rule**: No `urllib.request.urlopen()` with dynamic URLs. Use `requests`.

**Battle story**: A Python service accepted a URL parameter for fetching webhooks. It used `urllib.request.urlopen(url)` which supports `file://` scheme. An attacker passed `file:///etc/passwd` and received the server's password file. The `requests` library only supports HTTP/HTTPS by default.

**How to apply**: Grep for `urlopen` calls. Check if the URL is user-controlled. Replace with `requests.get()` and add scheme validation (`assert url.startswith('https://')`).

## JWT Algorithm Must Be Validated

**Rule**: JWT validation must check algorithm, not just signature.

**Battle story**: A service decoded JWTs without pinning the algorithm. An attacker crafted a token with `alg: none` and an empty signature. The JWT library accepted it because "none" is a valid algorithm per RFC 7519. The attacker gained admin access without knowing the secret key.

**How to apply**: Always specify `algorithms=["RS256"]` (or your expected algorithm) in JWT decode calls. Never allow the token itself to dictate the algorithm.

## Dependency Audit Includes Docker Images

**Rule**: Run `trivy image` on Docker images, not just `pip audit`/`npm audit`.

**Battle story**: A Python application had clean `pip audit` results. However, the base Docker image (`python:3.11`) included an outdated OpenSSL with a known RCE vulnerability. The vulnerability was in the OS layer, not the Python packages. Trivy caught it; pip audit could not.

**How to apply**: After building Docker images, always run `trivy image --severity HIGH,CRITICAL <image>`. Pin base images to patch versions. Update base images monthly.

## Suppressions Need Documentation

**Rule**: Every scanner suppression must be documented with justification.

**Battle story**: A team accumulated 47 suppressions in their checkov config over 18 months. When a new security engineer audited them, 12 suppressions were for rules that no longer applied (the risky code had been refactored), and 3 hid genuine vulnerabilities that had been introduced after the suppression was added. Without documented justification, nobody could tell which were safe to keep.

**How to apply**: Record suppressions in `SECURITY_SCAN_RESULTS.md` with: rule ID, file, reason, date, reviewer. Audit suppressions quarterly.

## OWASP Top 10:2025 Replaces the 2021 Category Numbers

**Rule**: Report findings against OWASP Top 10:2025, not the 2021 edition.

**Why**: OWASP published the 2025 revision (see references/sources.md). It added Software
Supply Chain Failures as a dedicated A03 (dependency and build-pipeline compromise was
scattered across 2021's A06/A08), folded Server-Side Request Forgery into Injection (A05),
and added Mishandling of Exceptional Conditions (fail-open error paths, unhandled
exceptions that change security state) as A10. A report still labeled "A10 SSRF" is citing
a retired category.

**How to apply**: Use the mapping in SKILL.md's OWASP table when translating an older
finding or a tool that still emits 2021 IDs (many SAST rulesets, including Semgrep's
`p/owasp-top-ten` pack, still ship under the old labels; the underlying bug classes are
unchanged).
