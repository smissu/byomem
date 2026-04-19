# OpenCode Byomem Integration Setup

This document outlines how the `byomem` memory layer integrates with OpenCode via a TS plugin, a Python bridge, and MCP search tooling.

## Overview
Byomem (`Bring Your Own Memory`) provides a persistent, project-scoped vector and full-text search index for Claude Code and OpenCode. 

The integration relies on three small pieces:
1. **MCP server**: provides real-time context and search tools to agents.
2. **Plugin**: the TypeScript hook file that captures OpenCode events.
3. **Bridge**: `hooks/opencode_bridge.py`, which receives the plugin payload and queues native indexing.

## 1. MCP Server Configuration
The `byomem` MCP server exposes project memory to the AI. It is configured globally in `~/.config/opencode/opencode.json`.

```json
"mcp": {
  "byomem": {
    "type": "local",
    "command": [
      "/Users/ericsmith/Documents/byomem/.venv/bin/python",
      "/Users/ericsmith/Documents/byomem/mcp_server.py"
    ],
    "enabled": true
  }
}
```
*This allows agents to search memory proactively (e.g., `mem_search(query)`).*

## 2. Session Synchronization Plugin
To ensure conversations are persistently saved, a custom plugin (`~/.config/opencode/plugin/byomem.ts`) intercepts session events and slash commands, sending the full message history to the Python bridge for indexing.

### Plugin Location
`~/.config/opencode/plugin/byomem.ts`

### Bridge
`hooks/opencode_bridge.py`

### Triggers
The plugin syncs session data to the SQLite index under three conditions:
1. **Session Idle**: When the agent finishes a thought/tool execution (`session.idle`).
2. **Session Status**: When the session explicitly reports an idle status (`session.status`).
3. **Manual Commands**: When the user explicitly runs `/clear`, `/new`, `/quit`, or `/exit`. This is intercepted via the `command.execute.before` hook to ensure the session is synced before the terminal wipes the context.

### Sync Implementation
The plugin uses a `Map<string, number>` to track the last synced message count per session ID. This prevents dual-event race conditions between `session.idle` and `session.status` without permanently blocking ongoing sessions from syncing future messages. When triggered, it:
1. Fetches the full session history from the local SQLite database via the OpenCode `client.session.messages` API.
2. Checks if the current message count equals the last synced count. If so, it skips processing.
3. Formats the messages into a JSON payload containing the `session_id`, `cwd` (current working directory to scope the project), and the formatted `messages`.
4. Executes (`Bun.spawn`) the Python bridge script to run the indexing in the background.

```typescript
const BRIDGE_SCRIPT = "/Users/ericsmith/Documents/byomem/hooks/opencode_bridge.py"
const PYTHON = "/Users/ericsmith/Documents/byomem/.venv/bin/python"

// Spawns the Python bridge synchronously.
const proc = Bun.spawnSync([PYTHON, BRIDGE_SCRIPT], {
  stdin: Buffer.from(payload),
  stdout: "ignore",
  stderr: "pipe",
})
```

## 3. Python Bridge Script
`hooks/opencode_bridge.py`

This script accepts the JSON payload from the TypeScript plugin via standard input (`stdin`). It writes the transcript JSONL and queues native indexing so the messages are available for future memory search.

## Troubleshooting
- **Missing Recent Conversations**: If a recent conversation is missing, check whether the session had fewer than 2 messages; those are skipped.
- **Console Logs**: The TypeScript plugin logs to `stderr` with the prefix `[byomem]`. You can view these logs by starting OpenCode and observing the terminal output for errors during `/clear` or session idle events.
- **Python Path**: Ensure the Python path defined in `byomem.ts` and `opencode.json` correctly points to the `byomem` virtual environment (`.venv/bin/python`), as it requires specific dependencies (like the `mcp` SDK) installed there.
