# Security Policy

## Reporting a Vulnerability

Please report suspected security issues privately through GitHub's private vulnerability reporting when it is available for this repository.

If private vulnerability reporting is not available, open a minimal issue that describes the affected area without including exploit details, credentials, or private data. A maintainer will coordinate follow-up privately.

## Secret Handling

Do not commit local memory stores, raw agent transcripts, runtime queues, `.env` files, credentials, or generated dependency directories. The repository uses `.gitignore`, Gitleaks, and GitHub secret scanning to reduce accidental exposure, but those checks are not a substitute for reviewing changes before publishing.
