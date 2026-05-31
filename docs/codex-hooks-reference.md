# Codex Hooks Reference

This note documents the Codex hook patterns used with BYOMem so future setup work keeps memory, file search, graph context, and session capture aligned.

## Paired Lifecycle Operations

Use `connect codex` and `remove codex` as paired lifecycle operations:

```bash
npm run byomem:cli -- connect codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist
npm run byomem:cli -- connect codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist --apply
npm run byomem:cli -- remove codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist
npm run byomem:cli -- remove codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist --apply
```

Both commands are dry-run first. Use the `--apply` forms only as an apply-after-review step after checking the JSON report.

## Safe Removal Contract

Safe uninstall means integration rollback does not delete durable data. `remove codex` reads global `~/.codex/config.toml` by default, so dry-run output must be reviewed as an all-project Codex config change.

`remove codex --apply` removes only recognized BYOMem Codex integration artifacts after backing up modified config/integration files, not durable BYOMem data. Recognized removable artifacts are canonical BYOMem MCP config sections, the marked AGENTS guidance block, canonical Codex hook commands, and stale BYOMem-owned runtime-state records.

Durable memory, file-search, graph, queue, runtime DB, embedding cache, and artifact data are preserved. `remove codex` does not kill or terminate live processes. Dangerous flags such as `--delete-data`, `--kill-processes`, and `--force` are rejected in this release.

## Extension Exposure Decision Record

Initial decision: `defer`.

BYOMem should defer menu/help exposure unless implementation records an explicit override. The command remains available through explicit CLI usage for advanced operators, while avoiding accidental uninstall discoverability in extension menus.

## Runtime Verification

Every BYOMem MCP surface exposes `byomem_runtime_info`. For release evidence, repo-local commands are necessary but not sufficient; installed/global verification should inspect the active Codex-facing MCP runtime-info tool and confirm `byomem_runtime_info.runtime.packageVersion === "0.1.10"` and `byomem_runtime_info.server.version === "0.1.10"`.

## BYOMem graph hook

Purpose:
- remind Codex that BYOMem graph tools are available for architecture and relationship questions
- keep BYOMem graph updates current after code edits

Typical repo-local hook file:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "grep -Eq 'byomem-(operations|graph)' ~/.codex/config.toml 2>/dev/null && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"byomem graph: use BYOMem graph MCP tools for architecture, communities, cross-file relationships, and shortest paths. Prefer byomem_graph_query, byomem_graph_explain, and byomem_graph_path for structural questions before raw grep. Run byomem_graph_update after code changes when graph context should be refreshed.\"}}' || true"
          }
        ]
      }
    ]
  }
}
```

Recommended use:
- prefer `byomem_graph_query`, `byomem_graph_explain`, and `byomem_graph_path` for architecture, communities, shortest paths, and cross-file relationships
- keep `byomem_graph_update` in the workflow after code changes

## BYOMem file-search hook

Purpose:
- remind Codex that `byomem_file_search` is available for exact file/chunk lookup, semantic evidence, and opt-in graph context
- keep BYOMem file search as the source-evidence layer alongside BYOMem graph structure

Typical repo-local hook file:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "grep -Eq 'byomem-(operations|file_search|file-search)' ~/.codex/config.toml 2>/dev/null && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"byomem: exact file/chunk lookup is available via byomem_file_search; use it for source passages, semantic matches, and indexed evidence before falling back to grep. For code, architecture, debugging, review, or cross-file investigation tasks, call byomem_file_search with includeGraph: true.\"}}' || true"
          }
        ]
      }
    ]
  }
}
```

Recommended use:
- prefer BYOMem for exact passages, line references, semantic file search, and source evidence
- use `includeGraph: true` for code, architecture, debugging, review, or cross-file investigation tasks
- use BYOMem graph when the question is about relationships, architecture, or the project graph
- if both apply, use BYOMem file search for evidence and BYOMem graph for structure

## Codex Stop hook

Purpose:
- connect Codex CLI `Stop` events to BYOMem session capture with the project-local command `node /Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/cli.js codex-session-capture`
- keep the hook manual and repo-local; do not enable it globally or in user-global Codex config without explicit approval
- write compact summaries into the normal durable `byomem-session` rollup path
- keep any optional sanitized raw archive separate from canonical memory records

Typical repo-local hook file:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p /Users/ericsmith/.byomem/runtime && node /Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/cli.js codex-session-capture >> /Users/ericsmith/.byomem/runtime/codex-stop-hook.log 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

Recommended use:
- treat summaries as the durable memory path and the only path that should feed normal search
- keep BYOMem hook command output out of stdout; Codex Stop hooks reject unsupported JSON response shapes
- treat a sanitized raw archive as optional, disabled by default, and outside canonical memory records
- keep the archive sanitized before storage; do not retain raw transcript JSON, tool traces, signatures, encrypted fields, or binary payloads
- keep `qwen3:8b` / `qwen3.5:4b` for summarization and reserve `minishlab/potion-code-16M` for embeddings only
- do not expect the archive path to replace the normal rollup path or the search/indexing path

## Codex Session Capture Activation

Codex session capture is manual. Do not enable it globally, in user-global Codex config, or in repo setup scripts without explicit user approval.

Activation steps after approval:

1. Add the project-local Stop hook snippet above to `.codex/hooks.json`.
2. Add `session_capture.enabled: true` to the BYOMem config used by the Codex runtime.
3. Set conservative thresholds, for example `threshold_turns: 3`, `min_turns: 2`, and `large_turn_chars: 4096`.
4. Restart the Codex runtime so the BYOMem extension reloads the config.
5. Run a dry turn and confirm `byomem_runtime_status` reports `sessionCaptureEnabled: true`.

Expected behavior:

- Below-threshold turns update only `queue/session-capture-state.json`.
- Threshold, final, idle, or configured switch flushes write one compact `byomem-session` rollup.
- Durable rollups keep only `kind`, `sessionId`, `flushReason`, and `sourceStableKey` structured fields.
- Raw transcript lines, tool traces, signatures, and encrypted payload fields are not durable memory content.
- The session-capture summarizer stays on `qwen3:8b` with `qwen3.5:4b` as fallback.
- `minishlab/potion-code-16M` stays reserved for embeddings and should not be repurposed as a summarizer.

Rollback:

1. Remove the project-local Stop hook entry from `.codex/hooks.json` if you no longer want Codex session capture in this repo.
2. Set `session_capture.enabled: false`, or remove the `session_capture` block.
3. Restart Codex.
4. Confirm `byomem_runtime_status` reports `sessionCaptureEnabled: false`.
5. Remove any test rollups with `byomem_prune` if they were created during validation.

## Combined setup

When BYOMem hooks are installed in Codex:
- keep graph, memory, and file-search `UserPromptSubmit` reminders in `.codex/hooks.json`
- keep the project-local `Stop` hook separate from those reminders
- keep the global `AGENTS.md` guidance short and explicit
- do not let session capture or indexing hooks replace the lightweight reminder hooks
- prefer split MCP server config for memory, graph, and file-search; keep all-in-one operations only as a compatibility fallback

## Notes

- These hooks are documentation and reminder surfaces only.
- They should stay lightweight and should not attempt to perform expensive indexing work on prompt submit.
- Session capture must stay opt-in until the operator explicitly approves activation.
- The Stop hook should stay project-local unless the operator explicitly approves a broader rollout.
