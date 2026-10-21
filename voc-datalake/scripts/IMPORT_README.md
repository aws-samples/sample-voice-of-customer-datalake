# Load the Projects and Personas into your platform

This folder contains ready-made **Projects and Personas** (with their documents,
prototypes, and persona pictures) to load into the VoC platform you deployed in
Step 1. It's just data — there are no passwords in here, and you don't need
access to any other system.

## Before you start

You need three values that your deploy produced (the deploy guide shows where
they appear), plus AWS access to your own account:

- your deployment's **name** (the short identifier you chose when deploying)
- your AWS **account number**
- your AWS **region** (e.g. `us-east-1`)
- AWS credentials on your machine (the same ones you deployed with)
- Python 3 with `boto3` (`pip install boto3`)

## Load it

Open a terminal **in this folder**, then:

**1. Preview first (writes nothing):**

```bash
python import_projects.py \
  --bundle . \
  --target-prefix YOUR_DEPLOYMENT_NAME \
  --account YOUR_ACCOUNT_NUMBER \
  --region YOUR_REGION
```

It prints how many projects, items, and pictures it will load. If that looks
right:

**2. Load it for real:**

```bash
python import_projects.py \
  --bundle . \
  --target-prefix YOUR_DEPLOYMENT_NAME \
  --account YOUR_ACCOUNT_NUMBER \
  --region YOUR_REGION \
  --apply
```

Add `--profile YOUR_AWS_PROFILE` to either command if you use a named AWS
profile.

Running it again is harmless — it just overwrites with the same data, so it's
safe to re-run if it gets interrupted.

## Check it worked

Open your platform's website, log in, and go to the **Projects** page. You
should see the projects listed, each with personas (pictures shown), documents,
and prototypes. The expected counts are in `manifest.json` in this folder.

## If something's off

- **"No projects.ndjson in … — is this an export bundle?"** — you're running the
  command from the wrong folder. `cd` into this folder (the one holding
  `import_projects.py`) and try again.
- **An AWS permissions / credentials error** — your terminal isn't pointed at
  your AWS account. Use the same credentials/profile you deployed with, and add
  `--profile YOUR_AWS_PROFILE`.
- **Projects appear but pictures are blank** — the picture files didn't upload;
  re-run the `--apply` command (it's safe to repeat).
