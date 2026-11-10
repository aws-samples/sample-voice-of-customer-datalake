#!/usr/bin/env bash
# Turn the production e2e suite's two Cognito test users on or off, and write the suite's env file.
#
#   bash e2e/scripts/e2e-users.sh enable     # from voc-datalake/frontend; then: set -a; . <env file>; set +a
#   bash e2e/scripts/e2e-users.sh disable    # after the run
#
# enable:  for each user (it must already exist, README → Models: the `e2e` group), add it to the `e2e` group,
#          enable it and give it a new random permanent password; write E2E_SITE, E2E_API and both users'
#          credentials to the env file (mode 600, passwords single-quoted). Passwords are never printed.
# disable: disable both users, sign them out everywhere (their tokens stop working) and delete the env file.
#
# The deployment is read from the stack outputs (UserPoolId and WebsiteURL of the core stack, ApiEndpoint of the
# API stack), with the operator's ambient AWS credentials and region.
#
# Env: E2E_STACK_PREFIX  the deployment's prefix (-c deploymentPrefix), if any
#      E2E_ADMIN_USER    the admin test user (default e2e-admin; in the `admins` group)
#      E2E_USER_USER     the plain test user (default e2e-viewer; in the `users` group)
#      E2E_ENV_FILE      where the env file goes (default ~/.config/voc-e2e/suite.env; never inside a git work tree)
set -euo pipefail

ACTION="${1:-}"
if [[ "$ACTION" != enable && "$ACTION" != disable ]]; then
  echo "usage: e2e-users.sh enable|disable" >&2
  exit 2
fi

PREFIX="${E2E_STACK_PREFIX:+$E2E_STACK_PREFIX-}"
CORE_STACK="${PREFIX}VocCoreStack"
API_STACK="${PREFIX}VocApiStack"
ADMIN_USER="${E2E_ADMIN_USER:-e2e-admin}"
PLAIN_USER="${E2E_USER_USER:-e2e-viewer}"
ENV_FILE="${E2E_ENV_FILE:-$HOME/.config/voc-e2e/suite.env}"

# The env file holds passwords: refuse a path inside any git work tree (a commit could publish it).
ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$ENV_DIR"
if git -C "$ENV_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "E2E_ENV_FILE is inside a git work tree ($ENV_FILE): choose a path outside any repository" >&2
  exit 2
fi

output() { # stack, output key
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text)"
  if [[ -z "$value" || "$value" == None ]]; then
    echo "$1 has no $2 output" >&2
    exit 2
  fi
  printf '%s' "$value"
}

POOL="$(output "$CORE_STACK" UserPoolId)"

new_password() { # 32 characters with an upper, a lower, a digit and a symbol (the pool's policy)
  python3 -c 'import secrets, string; a = string.ascii_letters + string.digits; print("Aa1!" + "".join(secrets.choice(a) for _ in range(28)))'
}

if [[ "$ACTION" == disable ]]; then
  # Every step is tried for both users (one failure must not leave the other on), then the result is reported.
  FAILED=()
  for user in "$ADMIN_USER" "$PLAIN_USER"; do
    aws cognito-idp admin-disable-user --user-pool-id "$POOL" --username "$user" || FAILED+=("disable $user")
    aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$user" || FAILED+=("sign out $user")
  done
  rm -f "$ENV_FILE"
  if (( ${#FAILED[@]} > 0 )); then
    echo "removed $ENV_FILE, but these steps FAILED: ${FAILED[*]}" >&2
    exit 1
  fi
  echo "disabled $ADMIN_USER and $PLAIN_USER; removed $ENV_FILE"
  exit 0
fi

SITE="$(output "$CORE_STACK" WebsiteURL)"
API="$(output "$API_STACK" ApiEndpoint)"
for user in "$ADMIN_USER" "$PLAIN_USER"; do
  aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$user" > /dev/null
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$user" --group-name e2e
  aws cognito-idp admin-enable-user --user-pool-id "$POOL" --username "$user"
done
ADMIN_PASSWORD="$(new_password)"
PLAIN_PASSWORD="$(new_password)"
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --permanent
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$PLAIN_USER" --password "$PLAIN_PASSWORD" --permanent

umask 077
{
  echo "E2E_SITE=${SITE%/}"
  echo "E2E_API=${API%/}"
  echo "E2E_ADMIN_USER=$ADMIN_USER"
  echo "E2E_ADMIN_PASSWORD='$ADMIN_PASSWORD'"
  echo "E2E_USER_USER=$PLAIN_USER"
  echo "E2E_USER_PASSWORD='$PLAIN_PASSWORD'"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "enabled $ADMIN_USER and $PLAIN_USER; env file: $ENV_FILE"
