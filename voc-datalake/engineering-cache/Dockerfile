# voc-engineering-cache: the checkout cache's writer (docs/autonomous-engineering.md → The checkout cache).
# A container-image Lambda because it needs git, which Lambda's Python runtime does not have: the distro's git on
# Lambda's own Python base image, pinned by digest, and the filler's code (lambda/engineering/connectors/cache.py)
# with the modules it imports. The CDK builds it from voc-datalake/ (lib/stacks/engineering-cache.ts, a Docker image
# asset for linux/arm64, only with -c engineeringAgents=true) and pushes it to the bootstrap's asset repository.
# It runs no repository code: git only fetches, with hooks, the system config and credential helpers off.
FROM --platform=linux/arm64 public.ecr.aws/lambda/python:3.14@sha256:6c41adfe09281f878ba6eef693deb33b9d7bef91adba28433f03e41a2cfcb28f

# git from the distro, one exact build (git-core: the git binary and its helpers, no Perl, no documentation).
# Once this build leaves the distro's repository, dnf finds no match and the image build fails loudly (never a silent
# other git); to bump it, `dnf list --showduplicates git-core --releasever=latest` in this base image, pin the newest.
RUN dnf install -y --releasever=latest git-core-2.50.1-1.amzn2023.0.2 && dnf clean all && rm -rf /var/cache/dnf

# Every package pinned by version and sha256, wheels only: the same Powertools as the processing layer
# (lambda/layers/processing-deps), the signing primitive the App's JWT needs (lambda/layers/signing-deps), boto3.
COPY engineering-cache/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY lambda/engineering ${LAMBDA_TASK_ROOT}/engineering
COPY lambda/shared ${LAMBDA_TASK_ROOT}/shared

CMD ["engineering.connectors.cache.lambda_handler"]
