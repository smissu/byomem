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

## Memory hygiene
- Prune stale, outdated, redundant, or superseded memories proactively when the stale status is clear.
- Do not ask for approval before pruning clearly stale memories; preserve durable architecture, outcome, decision, and preference records.
- Prefer pruning ephemeral `byomem-session` rollups when they duplicate newer architecture, sprint-outcome, bugfix, or explicit preference memories.
- When replacing a memory with a more accurate record, prune the older duplicate after verifying the new record covers the durable fact.
- Avoid fully automatic destructive prune hooks; use directives or future dry-run recommendations unless a hook can prove high-confidence stale records.

## Hermes-native retrieval order
- Keep memory retrieval separate from code search/indexing.
- For repo-local decisions or prior durable facts, check project memory first; only use user memory for stable cross-repo preferences.
- When investigating the codebase, prefer BYOMem file search / semantic search before `grep`, `find`, or other broad text searches.
- For exact source passages, indexed evidence, and semantic matches, prefer `byomem_file_search` over raw file scans.
- For architecture or cross-module questions, read `graphify-out/GRAPH_REPORT.md` first, then use graphify queries/paths for relationships that span files.
- Use canonical native BYOMem records as the source of truth.

## Hermes-native graph maintenance
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost).
- After modifying code files in this session, run a BYOMem file-search scan for this repo to keep indexed source passages current.
- If you capture a durable repo decision, store it as concise project memory only after verifying it is stable and worth keeping.

## BYOMem extension policy
- This repo should use the global Pi BYOMem extension from `~/.pi/agent/extensions/byomem/` when available.
- Do not keep a second active BYOMem runtime under `.pi/extensions/`, because Pi auto-discovers both project and global extensions and duplicate BYOMem tools/hooks can conflict.
- Keep repo-local BYOMem implementation code in canonical shared source files, not as a second auto-loaded project extension runtime.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use `graphify query` / `graphify explain` first for architecture, components, modules, and relationships
- Use `graphify path "<A>" "<B>"` for dependency/connection questions
- Use BYOMem file search for exact source passages after graphify identifies the relevant area
- Use `rg` mainly for narrow exact string checks, test names, or when graphify/BYOMem does not cover the need
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
- After modifying code files in this session, run a BYOMem file-search scan for this repo to keep indexed source passages current
