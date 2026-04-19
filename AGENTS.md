# BYOMem Repo Guidance

## Memory usage
- Retrieve **project** memory first when working in the current repo or on repo-local decisions.
- Retrieve **user** memory only for stable personal preferences, repeated working style, or cross-repo user-level context.
- Prefer project memory over user memory when both are relevant to the same task.
- Do not store duplicate facts in both scopes.

## What to store
- Store concise outcomes, decisions, fixes, and durable preferences.
- Project memory: repo-specific decisions, architecture choices, bug fixes, rollout notes.
- User memory: long-lived preferences, recurring habits, reusable personal defaults.

## What not to store
- Do not store raw transcripts or full chat logs.
- Do not store ephemeral brainstorming, unreviewed speculation, or low-confidence guesses.
- Do not store code-indexing data in memory; code retrieval is separate from memory retrieval.

## Capture workflow
- Prefer reviewed capture over automatic capture.
- Generate candidate memories from task outcomes, then require explicit approval before writing.
- Default ambiguous content to **project** or reject; do not auto-promote uncertain content to user memory.

## Retrieval order
- For repo work: check project memory first, then user memory if needed.
- Keep memory retrieval separate from code search/indexing.
- Use canonical native BYOMem records as the source of truth.
