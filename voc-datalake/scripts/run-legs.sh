#!/bin/sh
# Run every npm script named on the command line, then report ALL of them.
#
# Why this exists: the root aggregates (`lint`, `typecheck:all`, `check`) used to
# be `&&` chains, so the FIRST failure hid every later step. A `lint:python`
# failure meant you never learned whether the CDK or backend suites passed, and
# the fix was to re-run the legs by hand one at a time. This runs all of them and
# names the ones that failed.
#
# ⚠️ MUST be invoked with the REPO ROOT as the working directory, because the legs
# are root npm scripts (`npm run lint:frontend`, …). It is deliberately NOT run as
# `cd voc-datalake && ./scripts/run-legs.sh` — the `build:layers` shape — because
# that would resolve leg names against voc-datalake/package.json instead.
#
# POSIX sh on purpose: no bashisms, so it runs under dash. It does assume a POSIX
# shell, which the aggregates already did (`cd x && …`, `.venv/bin/python`).
set -u

if [ "$#" -eq 0 ]; then
    printf 'run-legs.sh: no legs given; pass one or more npm script names\n' >&2
    exit 2
fi

# The exit status is the FIRST failing leg's, not a hardcoded 1 and not the last
# one's: an `&&` chain propagated the status of the leg that stopped it, and
# callers that distinguish e.g. ruff's 2 from 1 keep reading the same number they
# read before. Legs after it still run — that is the whole point — but they do not
# overwrite the answer.
status=0
failed=''

for leg in "$@"; do
    printf '\n>>> npm run %s\n' "$leg"
    # VOC_LEGS_NESTED tells a nested invocation to skip its own summary: `check`
    # runs `lint` and `typecheck:all`, which are themselves leg runs, and three
    # "Failed legs:" lines compete to be the authoritative one. The per-leg
    # PASS/FAIL lines are kept — those are the diagnosis.
    if VOC_LEGS_NESTED=1 npm run "$leg"; then
        printf '<<< %s: PASS\n' "$leg"
    else
        leg_status=$?
        [ "$status" -eq 0 ] && status="$leg_status"
        failed="$failed $leg"
        printf '<<< %s: FAIL (exit %s)\n' "$leg" "$leg_status"
    fi
done

# A nested run stays quiet here; the outermost one owns the summary.
if [ "${VOC_LEGS_NESTED:-}" = "1" ]; then
    exit "$status"
fi

if [ "$status" -eq 0 ]; then
    printf '\nAll legs passed:%s\n' " $*"
else
    printf '\nFailed legs:%s\n' "$failed" >&2
fi

exit "$status"
