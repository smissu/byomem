# OpenCode Hook System — Research Findings

**Date:** 2026-02-21  
**Status:** Complete — plugin working end-to-end

---

## Executive Summary

The byomem bridge script (`hooks/opencode_bridge.py`) is **fully built and ready**. The missing piece is triggering it from opencode. Two approaches were investigated:

| Approach | Verdict |
|----------|---------|
| `experimental.hook.session_completed` (config) | **NOT IMPLEMENTED** — type exists in schema but zero runtime code |
| JS/TS Plugin (`event` hook + `session.idle`) | **Viable — recommended path** |

---

## Approach A: `experimental.hook.session_completed` (Config Hook)

### Finding: Dead Config — Schema Only, No Implementation

The config schema declares `experimental.hook.session_completed`:

```typescript
// packages/sdk/js/src/gen/types.gen.ts (auto-generated)
experimental?: {
  hook?: {
    file_edited?: { [key: string]: Array<{ command: string[]; environment?: Record<string,string> }> }
    session_completed?: Array<{ command: string[]; environment?: Record<string,string> }>
  }
}
```

**However**, exhaustive repo-wide searches confirm:
- Zero references to `session_completed` in any runtime source file (`packages/opencode/src/`)
- Zero references to `experimental?.hook` being read or acted upon anywhere
- No dispatch/spawn code wired to this config key
- The `file_edited` hook in the same section is also unimplemented
- No functions named `runHook`, `executeHook`, or similar exist

**Evidence (searched patterns with zero hits in runtime code):**
- `session_completed` (outside auto-generated SDK types) → 0 results
- `hook?.session`, `experimental?.hook`, `config.experimental?.hook` → 0 results
- `runHook`, `executeHook` → 0 results
- `hook.session_completed` → 0 results
- `session_completed` appears ONLY in:
  - `packages/sdk/js/src/gen/types.gen.ts` (auto-generated types)
  - `packages/sdk/js/src/v2/gen/types.gen.ts` (v2 auto-generated types)

**Conclusion:** This config key is a placeholder/future feature that was never wired up. **Do not use.**

---

## Approach B: JS/TS Plugin (Recommended)

### How OpenCode Plugins Work

Plugins are JS/TS modules that export a function returning a `Hooks` object:

```typescript
export type Plugin = (input: PluginInput) => Promise<Hooks>
```

#### PluginInput (what the plugin receives)

Source: [`packages/plugin/src/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts#L25-L33)

```typescript
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // SDK client — can fetch sessions/messages
  project: Project                                  // Project metadata
  directory: string                                 // Current working directory
  worktree: string                                  // Git worktree root
  serverUrl: URL                                    // Local API server URL
  $: BunShell                                       // Bun shell helper for running commands
}
```

Key facts:
- `client` is the opencode SDK client — can call API endpoints to list/read sessions and messages
- `$` is Bun's shell helper — can spawn subprocesses, pipe data

#### How Plugins Are Loaded

Source: [`packages/opencode/src/plugin/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)

```typescript
const input: PluginInput = {
  client,
  project: Instance.project,
  worktree: Instance.worktree,
  directory: Instance.directory,
  serverUrl: Server.url(),
  $: Bun.$,
}
```

#### How Events Are Dispatched to Plugins

Same file — `Plugin.init()`:

```typescript
export async function init() {
  // ...
  Bus.subscribeAll(async (input) => {
    const hooks = await state().then((x) => x.hooks)
    for (const hook of hooks) {
      hook["event"]?.({
        event: input,
      })
    }
  })
}
```

ALL Bus events are forwarded to every plugin's `event` hook. This includes `session.idle`.

#### The `session.idle` Event

Source: [`packages/opencode/src/session/status.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)

```typescript
export function set(sessionID: string, status: Info) {
  Bus.publish(Event.Status, { sessionID, status })
  if (status.type === "idle") {
    Bus.publish(Event.Idle, { sessionID })  // deprecated but still emitted
    delete state()[sessionID]
    return
  }
  state()[sessionID] = status
}
```

Fired when:
- `prompt.cancel()` is called (session interrupted)
- The prompt loop exits naturally (via `defer(() => cancel(sessionID))` in `prompt.loop`)

Event payload:
```typescript
type EventSessionIdle = {
  type: "session.idle"
  properties: { sessionID: string }
}
```

**Note:** `session.idle` is marked **deprecated** in the source. The replacement is `session.status` with `status.type === "idle"`. A robust plugin should handle both.

---

### Plugin Locations

| Scope | Path |
|-------|------|
| Global | `~/.config/opencode/plugin/*.{ts,js}` |
| Project | `.opencode/plugin/*.{ts,js}` |
| NPM | `opencode.json` → `"plugin": ["pkg-name"]` |

> Plugin = the TypeScript hook file. Bridge = `hooks/opencode_bridge.py`.

Files in these directories are auto-loaded at startup.

### Plugin Structure

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      // handle lifecycle events
    },
  }
}
```

### Available Hooks (relevant subset)

| Hook | Type | Use Case |
|------|------|----------|
| `event` | Generic | Receives ALL Bus events — use for session.idle |
| `chat.message` | Typed | Intercept/modify user messages before sending |
| `tool.execute.before` | Typed | Before tool execution |
| `tool.execute.after` | Typed | After tool execution |
| `shell.env` | Typed | Inject env vars into shell commands |
| `experimental.session.compacting` | Typed | Inject context during compaction |

### Available Events (via `event` hook)

| Event | Payload |
|-------|---------|
| `session.idle` | `{ sessionID }` |
| `session.status` | `{ sessionID, status: { type: "idle" | "busy" | "retry" } }` |
| `session.created` | `{ sessionID }` |
| `session.updated` | Session info |
| `session.compacted` | `{ sessionID }` |
| `session.deleted` | `{ sessionID }` |
| `message.updated` | `{ info: Message }` |
| `file.edited` | `{ file: string }` |

### SDK Client API

Access via `ctx.client`. Key methods for byomem:

```typescript
// Get session metadata (includes directory/cwd)
const session = await client.session.get(sessionID)
// session.directory — working directory
// session.title    — display name

// Get all messages for a session
const msgs = await client.session.messages(sessionID)
```

#### Message object shape (inferred — needs verification)

```typescript
{
  id: string,
  role: "user" | "assistant",
  parts: Array<{ type: "text", text?: string, ... }>,  // content is in parts[].text
  time: { created: number, ... },
}
```

### Data Persistence (alternative to hooks)

OpenCode persists sessions in **SQLite** (drizzle-orm tables: session, message, part) + **JSON files** under `Global.Path.data/storage`. So even without hooks, a cron/watcher approach could read sessions directly. The plugin approach is preferred since it's event-driven.

---

## Existing byomem Bridge (ready to receive)

### Bridge: `hooks/opencode_bridge.py` — Input Contract

```json
{
  "session_id": "ses_abc123...",
  "cwd": "/path/to/project",
  "messages": [
    { "id": "msg_1", "role": "user", "text": "...", "timestamp": "2025-01-01T00:00:00Z" },
    { "id": "msg_2", "role": "assistant", "text": "...", "timestamp": "2025-01-01T00:00:01Z" }
  ]
}
```

The bridge then:
1. Writes Claude-compatible JSONL to `~/.byomem/opencode/{session_prefix}.jsonl`
2. Enqueues a `QueueJob` with `transcript_offset=0`
3. Spawns the background worker (`queue_worker.py`)
4. Deduplicates via `has_pending_job()` and `branch.last_turn_id`

### Other Hook Scripts (patterns to match)

- `hooks/stop_hook.py` — Claude Code stop hook. Reads session JSON from stdin, computes byte offset, enqueues job, spawns worker. Same architecture.
- `hooks/queue_worker.py` — Worker entrypoint. Calls `core.worker.run_worker()`.
- Both use: structured stderr logging, `has_pending_job()` dedup, `QueueJob` model, detached `subprocess.Popen`, sync mode via `BYOMEM_SYNC` env var.

---

## Working Plugin Implementation

**File:** `~/.config/opencode/plugin/byomem.ts`

Plugin = the TypeScript hook file. Bridge = `hooks/opencode_bridge.py`.

### Bugs Fixed During Implementation

1. **Missing `export default`** — opencode's plugin loader uses `dynamic import()` and expects `module.default` to be the plugin function. Named exports (`export const ByomemPlugin`) are silently ignored. Fixed by adding `export default ByomemPlugin`.

2. **`Bun.spawn` race condition** — opencode doesn't `await` event handlers during shutdown. The sequence was: idle event → plugin starts → opencode disposes → bridge never reads stdin. Fixed by using `Bun.spawnSync` which blocks until the bridge completes.

3. **Duplicate idle events** — Both `session.idle` (deprecated) and `session.status` with `type: "idle"` fire for the same session. Fixed with a `Set<string>` to skip already-processed sessions.

4. **SDK API calling convention** — The SDK uses hey-api client style. Path parameters go in `{ path: { id: sessionID } }`, not as positional args. The old code called `client.session.messages(sessionID)` which silently failed.

5. **Message structure** — Messages have an `.info` wrapper in some cases (flat in others). Parts array can be on `msg.parts` or `msg.info.parts`. Plugin handles both.

### Confirmed API Details

```typescript
// SDK message fetch — hey-api style path params
const result = await client.session.messages({ path: { id: sessionID } } as any)
const msgs = result.data  // Array of message objects

// Message structure
msg.info?.role ?? msg.role        // "user" | "assistant"
msg.parts ?? msg.info?.parts      // Array<{ type: "text", text: string }>
msg.info?.time?.created           // epoch millis
msg.info?.id ?? msg.id            // message ID
```

### Plugin Discovery (confirmed from binary strings)

- Glob: `{plugin,plugins}/*.{ts,js}` scanned under config dirs
- Files converted to `file://` URLs and imported via `dynamic import()`
- Export: **must be `export default`** — loader checks `module.default`
- No config entry required — auto-discovered from `~/.config/opencode/plugin/`

### Verified End-to-End Flow

```
opencode run "say pong"
  → plugin loaded (byomem.ts via file:// import)
  → session.idle event fires
  → SDK fetches messages via client.session.messages()
  → Bun.spawnSync pipes JSON to opencode_bridge.py
  → bridge writes JSONL to ~/.byomem/opencode/{session_prefix}.jsonl
  → bridge enqueues QueueJob + spawns worker
  → worker creates memory branch in ~/.byomem/{project}/branches/
```

### Logs Location

- `~/.local/share/opencode/log/` — opencode runtime logs
- `[byomem]` prefix on stderr — plugin-specific log lines
- `--print-logs` flag on `opencode run` — surfaces stderr in terminal

---

## References

- [OpenCode Plugins Docs](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx)
- [Plugin Type Definitions](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)
- [Plugin Runtime (loader + trigger)](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)
- [Session Status (idle event)](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)
- [SDK Types (Event definitions)](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)
- [Session Prompt Loop](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts)
- [Helicone Plugin Example](https://github.com/H2Shami/opencode-helicone-session)
- [Notification Plugin Example](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx#L222-L231)
