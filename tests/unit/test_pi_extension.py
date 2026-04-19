from pathlib import Path


EXTENSION_PATH = Path('.pi/extensions/byomem/index.ts').resolve()


def test_pi_extension_registers_manual_byomem_store_tool():
    text = EXTENSION_PATH.read_text()
    assert 'name: "byomem_store"' in text
    assert 'Store a memory entry in the current project' in text
    assert 'result: "blocked"' in text
    assert 'byomem_store is disabled in off mode' in text
    assert 'proposal requires explicit approval before persistence' in text
    assert 'type BridgeRequest =' in text
    assert 'action: "store"' in text


def test_pi_extension_registers_manual_byomem_search_tool():
    text = EXTENSION_PATH.read_text()
    assert 'name: "byomem_search"' in text
    assert 'promptSnippet: "Search byomem memory for relevant project context"' in text
    assert 'promptGuidelines: ["Use this tool when the user asks for memory or project context from byomem."]' in text


def test_pi_extension_registers_before_agent_start_hook_for_auto_injection():
    text = EXTENSION_PATH.read_text()
    assert 'before_agent_start' in text
    assert 'autoInjectByomemContext' in text


def test_pi_extension_registers_agent_end_session_capture_hook():
    text = EXTENSION_PATH.read_text()
    assert 'turn_end' in text
    assert 'captureSessionOnTurnEnd' in text
    assert 'action: "session_capture"' in text
    assert 'sessionCaptureDebounce' in text
    assert 'thresholdTurns' in text
    assert 'idleFlushSeconds' in text
    assert 'largeTurnBytes' in text
    assert 'summaryOnly' in text


def test_pi_extension_normalizes_nested_config_and_legacy_auto_injection():
    text = EXTENSION_PATH.read_text()
    assert 'readByomemConfig' in text
    assert 'search?: { enabled?: boolean; availableTo?: string }' in text
    assert 'injection?: {' in text
    assert 'sessionCapture?: {' in text
    assert 'mode?: string' in text
    assert 'autoInjection?: boolean' in text
    assert 'byomem.autoInjection ? "initial-only" : DEFAULT_INJECTION_MODE' in text
    assert 'function normalizeByomemMode(mode?: string)' in text
    assert 'if (normalized === "off" || normalized === "reviewed" || normalized === "auto-safe") return normalized;' in text
    assert 'return DEFAULT_BYOMEM_MODE;' in text
    assert 'const DEFAULT_BYOMEM_MODE = "auto-safe";' in text
    assert 'normalizeByomemMode(byomem.mode ?? settings?.mode)' in text


def test_pi_extension_auto_injection_reads_project_local_setting_and_prompt_text():
    text = EXTENSION_PATH.read_text()
    assert 'getPromptText' in text
    assert 'ctx.prompt' in text
    assert 'ctx.messages' in text
    assert 'current project context' in text
    assert 'DEFAULT_INJECTION_ALLOWED_AGENTS = ["lead"]' in text
    assert 'const agentName = (ctx as unknown as { agent?: { name?: string }; name?: string }).agent?.name' in text
    assert 'if (config.injectionAllowedAgents.length > 0 && !config.injectionAllowedAgents.includes(agentName)) return null;' in text


def test_pi_extension_auto_injection_is_bounded_and_advisory():
    text = EXTENSION_PATH.read_text()
    assert 'DEFAULT_INJECTION_MAX_RESULTS = 3' in text
    assert 'DEFAULT_INJECTION_MAX_CHARS = 700' in text
    assert 'query: getPromptText(ctx)' in text
    assert 'Byomem context:' in text
    assert 'bridge({' in text


def test_pi_extension_auto_safe_store_path_is_distinct_from_off_and_reviewed():
    text = EXTENSION_PATH.read_text()
    assert 'if (config.mode === "off")' in text or 'config.mode === "off"' in text
    assert 'result: "disabled"' in text
    assert 'if (config.mode === "reviewed")' in text
    assert 'result: "review-needed"' in text
    assert 'result: "stored"' in text
    assert 'detail: byomemModeText(config.mode)' in text


def test_pi_extension_search_can_be_disabled_but_defaults_allowed():
    text = EXTENSION_PATH.read_text()
    assert 'DEFAULT_SEARCH_ENABLED = true' in text
    assert 'DEFAULT_SEARCH_AVAILABLE_TO = "all-agents"' in text
    assert 'allowSearch' in text
    assert 'byomem search is disabled' in text


def test_pi_extension_auto_injection_fails_open_on_empty_results_and_adapter_failure():
    text = EXTENSION_PATH.read_text()
    assert 'if (!text) return null' in text
    assert 'catch {' in text
    assert 'return null' in text
    assert 'No matching memory items found' in text



def test_pi_extension_contains_sprint9_runtime_gating_logic():
    text = EXTENSION_PATH.read_text()
    assert 'resolveRuntimeTeamContext' in text
    assert 'team_active' in text
    assert 'agent_role' in text
    assert 'team_id' in text
    assert 'allowSearch' in text
    assert 'allowStore' in text
    assert 'tool: "byomem_search"' in text
    assert 'tool: "byomem_store"' in text


def test_pi_extension_bridge_logs_and_times_out_diagnostics():
    text = EXTENSION_PATH.read_text()
    assert 'BRIDGE_TIMEOUT_MS = 30000' in text
    assert 'byomem_bridge_debug.jsonl' in text
    assert 'stderr_preview' in text
    assert 'correlation_id' in text
    assert 'correlation_id: meta.correlationId' in text
    assert 'spawn(python, ["-m", adapterModule]' in text
    assert 'child.stdin.end(JSON.stringify({ ...request, correlation_id: meta.correlationId }))' in text
    assert 'child.on("close"' in text


def test_pi_extension_session_capture_uses_agent_end_messages_and_session_manager():
    text = EXTENSION_PATH.read_text()
    assert 'event.messages' in text
    assert 'ctx.sessionManager' in text
    assert 'getSessionId()' in text
    assert 'getSessionFile()' in text
    assert 'getEntries()' in text
    assert 'session_capture_resolution' in text
    assert 'session_capture_callback_entered' in text
    assert 'session_capture_hook_fired' in text
    assert 'runtime_root' in text
    assert 'queue_path' in text
    assert 'type TurnEndEvent =' in text
    assert 'event as TurnEndEvent' in text
    assert 'bridge invocation' in text
    assert 'debounce decision' in text
    assert 'session_capture_bridge_success' in text
    assert 'native_written_count' in text
    assert 'native_record_ids' in text


def test_pi_extension_sprint9_team_worker_search_and_store_are_blocked_in_metadata():
    text = EXTENSION_PATH.read_text()
    assert 'team worker direct search is disabled' in text
    assert 'team worker direct store is disabled' in text
    assert 'context: runtime' in text
    assert 'capabilities' in text
