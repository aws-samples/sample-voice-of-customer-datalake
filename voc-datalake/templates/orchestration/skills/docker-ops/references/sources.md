# Sources

Checked 2026-10-28.

- Node.js release schedule: v24 ("Krypton") is current Active LTS; v20 ("Iron") left
  Maintenance LTS on 2026-03-24 and is now unsupported; v22 is Maintenance LTS until
  2027-04: https://nodejs.org/en/about/previous-releases
- Python release status: 3.13 is in Security mode (supported to 2029-10), 3.14/3.15 are
  newer Bugfix releases: https://devguide.python.org/versions/,
  https://www.python.org/downloads/
- Distroless image tags use a `-debian13` suffix; `python3-debian13` and
  `nodejs24-debian13` are the current variants:
  https://github.com/GoogleContainerTools/distroless
- PostgreSQL 18 is the latest stable major release (19 in RC as of this check); 16 is
  still supported but two majors behind: https://www.postgresql.org/support/versioning/
- ECR tag immutability CLI (`create-repository` / `put-image-tag-mutability` with
  `--image-tag-mutability IMMUTABLE`):
  https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html
- Multi-stage build guidance (named stages, BuildKit stage pruning):
  https://docs.docker.com/build/building/multi-stage/
- No local `docker build` for images shipped to AWS; use AWS CodeBuild instead (user's
  global AWS Build policy, not an external source).
