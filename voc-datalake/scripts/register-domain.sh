#!/usr/bin/env bash
# Print the Route 53 Domains command that registers a domain for the email inbox
# (docs/email-intake.md, "Deploy and configure a custom domain").
#
# DRY RUN ONLY: this script never registers anything. Registering a domain costs money,
# needs the owner's contact details and sends a verification email, so a person runs the
# printed command once, deliberately. It checks availability and the price first (both
# read-only calls; Route 53 Domains lives in us-east-1).
#
# Usage: scripts/register-domain.sh <domain> [contact.json]
#   contact.json: a Route 53 Domains ContactDetail object (FirstName, LastName, ContactType,
#   Email, PhoneNumber, AddressLine1, City, CountryCode, ZipCode, ...). A template is printed
#   when it is omitted.
set -euo pipefail

DOMAIN="${1:-}"
CONTACT="${2:-contact.json}"
REGION="us-east-1"

if [[ -z "$DOMAIN" || ! "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
  echo "Usage: $0 <domain> [contact.json]   (a lower-case domain such as example-feedback.com)" >&2
  exit 2
fi

TLD="${DOMAIN##*.}"

echo "Checking availability of ${DOMAIN} (read-only)..."
aws route53domains check-domain-availability --region "$REGION" --domain-name "$DOMAIN" \
  --query 'Availability' --output text || echo "  (could not check: are you signed in?)"

echo "Registration price for .${TLD} (read-only)..."
aws route53domains list-prices --region "$REGION" --tld "$TLD" \
  --query 'Prices[0].RegistrationPrice' --output json || echo "  (could not read the price)"

if [[ ! -f "$CONTACT" ]]; then
  cat <<'TEMPLATE'

No contact file given. Save this as contact.json and fill it in (use a role mailbox):
{
  "FirstName": "Ana", "LastName": "Example", "ContactType": "COMPANY", "OrganizationName": "Example Ltd",
  "Email": "domains@example.com", "PhoneNumber": "+1.5555550100",
  "AddressLine1": "1 Example Street", "City": "Seattle", "State": "WA", "CountryCode": "US", "ZipCode": "98101"
}
TEMPLATE
fi

cat <<COMMAND

To register (this COSTS MONEY and emails the registrant a verification link), run:

  aws route53domains register-domain --region ${REGION} \\
    --domain-name ${DOMAIN} --duration-in-years 1 --auto-renew \\
    --admin-contact file://${CONTACT} --registrant-contact file://${CONTACT} --tech-contact file://${CONTACT} \\
    --privacy-protect-admin-contact --privacy-protect-registrant-contact --privacy-protect-tech-contact

Route 53 creates a public hosted zone for it. Then deploy the inbox into a subdomain:

  npm run deploy:infra -- -c inboundEmailDomain=voc.${DOMAIN} -c inboundEmailHostedZoneId=<the new zone id>

Find the zone id with: aws route53 list-hosted-zones-by-name --dns-name ${DOMAIN}
COMMAND
