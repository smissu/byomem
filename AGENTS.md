# BYOMem Repo Guidance

## Memory usage
- Retrieve **project** memory first when working in the current repo or on repo-local decisions.
- Retrieve **user** memory only for stable personal preferences, repeated working style, or cross-repo user-level context.
- Prefer project memory over user memory when both are relevant to the same task.
- Do not store duplicate facts in both scopes.

## What to store
- Store concise outcomes, decisions, fixes, and durable preferences.
- High-confidence inferred durable preferences, repeated working-style preferences, stable decisions, and other important durable info that will help future coding/project work may be stored proactively.
- Project memory: repo-specific decisions, architecture choices, bug fixes, rollout notes.
- User memory: long-lived preferences, recurring habits, reusable personal defaults.

## What not to store
- Do not store raw transcripts or full chat logs.
- Do not store ephemeral brainstorming, unreviewed speculation, or low-confidence guesses.
- Do not store code-indexing data in memory; code retrieval is separate from memory retrieval.

## Capture workflow
- Prefer reviewed capture over automatic capture.
- Generate candidate memories from task outcomes, and store them when confidence is high and the information is durable.
- Default ambiguous content to **project** or reject; do not auto-promote uncertain content to user memory.

## Retrieval order
- For repo work: check project memory first, then user memory if needed.
- Before starting substantive work in this repo, search project memory for relevant context, decisions, conventions, and prior fixes so you are not starting from the codebase cold.
- Keep memory retrieval separate from code search/indexing.
- Use canonical native BYOMem records as the source of truth.

## BYOMem extension policy
- This repo should use the global Pi BYOMem extension from `~/.pi/agent/extensions/byomem/` when available.
- Do not keep a second active BYOMem runtime under `.pi/extensions/`, because Pi auto-discovers both project and global extensions and duplicate BYOMem tools/hooks can conflict.
- Keep repo-local BYOMem implementation code in canonical shared source files, not as a second auto-loaded project extension runtime.
