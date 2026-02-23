"""
Single source of truth for all byomem configuration.
Replaces scattered module-level BYOMEM/DB_PATH constants.
"""

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ProjectConfig:
    source_root: Path | None = None


@dataclass
class Config:
    byomem: Path = field(default_factory=lambda: Path.home() / ".byomem")
    summarizer_model: str = "claude-haiku-4-5-20251001"
    summarizer_max_tokens: int = 300
    summarizer_base_url: str | None = None
    summarizer_fallback_model: str | None = None
    summarizer_gemini_cli: str | None = None
    summarizer_gemini_model: str | None = None
    summarizer_gemini_fallback_model: str | None = None
    summarizer_opencode_cli: str | None = None
    summarizer_opencode_model: str | None = None
    summarizer_lmstudio_url: str | None = None
    summarizer_lmstudio_model: str | None = None
    summarizer_concurrency: int = 1
    embedding_model: str = "text-embedding-3-small"
    embedding_dimension: int = 1536
    embedding_base_url: str | None = None
    chunk_tokens: int = 400
    chunk_overlap: int = 80
    max_results: int = 6
    min_score: float = 0.35
    vector_weight: float = 0.7
    keyword_weight: float = 0.3
    candidate_multiplier: int = 4
    approx_chars_per_token: int = 4
    user_message_max: int = 2000
    assistant_message_max: int = 3000
    log_user_prefix: int = 300
    log_assistant_prefix: int = 600
    batch_size: int = 6
    overflow_threshold: int = 4
    max_workers: int = 4
    log_search_mode: str = "none"  # none | enrich | index
    log_score_demotion: float = 0.5
    code_vector_weight: float = 0.3
    code_keyword_weight: float = 0.7
    code_test_demotion: float = 0.25
    code_definition_boost: float = 3.0
    code_min_score: float = 0.20
    code_candidate_multiplier: int = 8
    code_embedding_model: str | None = None
    code_embedding_dimension: int | None = None
    code_chunk_tokens: int | None = None
    descripterizer_batch_size: int = 8
    descripterizer_max_tokens: int = 1024
    descripterizer_concurrency: int = 4
    descripterizer_backends: list[str] | None = None  # e.g. ["gemini", "opencode"]
    descripterizer_max_failures: int = 5  # disable backend after N consecutive failures
    descripterizer_cloud_threshold: int = 100  # only use cloud backends above this many chunks
    descripterizer_zai_url: str = "https://api.z.ai/api/coding/paas/v4/"
    descripterizer_zai_model: str = "glm-4.6"
    descripterizer_debug: bool = False
    summarizer_debug: bool = False
    code_db_path: Path = field(default_factory=lambda: Path.home() / ".byomem" / "code.db")
    projects: dict[str, ProjectConfig] = field(default_factory=dict)
    settings_path: Path = field(default_factory=lambda: Path.home() / ".claude" / "settings.json")

    @property
    def db_path(self) -> Path:
        return self.byomem / "search.db"

    @property
    def queue_path(self) -> Path:
        return self.byomem / "queue"


def _load_config() -> Config:
    """Load config from ~/.byomem/config.yaml if it exists, else defaults."""
    config_path = Path.home() / ".byomem" / "config.yaml"
    if not config_path.exists():
        return Config()

    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

    kwargs = {}
    if "byomem" in data:
        kwargs["byomem"] = Path(data["byomem"])

    # Flatten nested YAML sections into flat Config fields
    summarizer = data.get("summarizer", {})
    if "model" in summarizer:
        kwargs["summarizer_model"] = summarizer["model"]
    if "max_tokens" in summarizer:
        kwargs["summarizer_max_tokens"] = summarizer["max_tokens"]
    if "base_url" in summarizer:
        kwargs["summarizer_base_url"] = summarizer["base_url"]
    if "fallback_model" in summarizer:
        kwargs["summarizer_fallback_model"] = summarizer["fallback_model"]
    if "gemini_cli" in summarizer:
        kwargs["summarizer_gemini_cli"] = summarizer["gemini_cli"]
    if "gemini_model" in summarizer:
        kwargs["summarizer_gemini_model"] = summarizer["gemini_model"]
    if "gemini_fallback_model" in summarizer:
        kwargs["summarizer_gemini_fallback_model"] = summarizer["gemini_fallback_model"]
    if "opencode_cli" in summarizer:
        kwargs["summarizer_opencode_cli"] = summarizer["opencode_cli"]
    if "opencode_model" in summarizer:
        kwargs["summarizer_opencode_model"] = summarizer["opencode_model"]
    if "lmstudio_url" in summarizer:
        kwargs["summarizer_lmstudio_url"] = summarizer["lmstudio_url"]
    if "lmstudio_model" in summarizer:
        kwargs["summarizer_lmstudio_model"] = summarizer["lmstudio_model"]
    if "concurrency" in summarizer:
        kwargs["summarizer_concurrency"] = summarizer["concurrency"]

    embeddings = data.get("embeddings", {})
    if "model" in embeddings:
        kwargs["embedding_model"] = embeddings["model"]
    if "dimension" in embeddings:
        kwargs["embedding_dimension"] = embeddings["dimension"]
    if "base_url" in embeddings:
        kwargs["embedding_base_url"] = embeddings["base_url"]

    memory = data.get("memory", {})
    for key in (
        "chunk_tokens",
        "chunk_overlap",
        "max_results",
        "min_score",
        "vector_weight",
        "keyword_weight",
        "candidate_multiplier",
        "approx_chars_per_token",
        "log_search_mode",
        "log_score_demotion",
        "code_vector_weight",
        "code_keyword_weight",
        "code_test_demotion",
        "code_definition_boost",
        "code_min_score",
        "code_candidate_multiplier",
        "code_embedding_model",
    ):
        if key in memory:
            kwargs[key] = memory[key]
    if "code_embedding_dimension" in memory:
        kwargs["code_embedding_dimension"] = int(memory["code_embedding_dimension"])
    if "code_chunk_tokens" in memory:
        kwargs["code_chunk_tokens"] = int(memory["code_chunk_tokens"])
    if "descripterizer_batch_size" in memory:
        kwargs["descripterizer_batch_size"] = int(memory["descripterizer_batch_size"])
    if "descripterizer_max_tokens" in memory:
        kwargs["descripterizer_max_tokens"] = int(memory["descripterizer_max_tokens"])
    if "descripterizer_concurrency" in memory:
        kwargs["descripterizer_concurrency"] = int(memory["descripterizer_concurrency"])
    if "descripterizer_backends" in memory:
        val = memory["descripterizer_backends"]
        if isinstance(val, list):
            kwargs["descripterizer_backends"] = val
        elif isinstance(val, str):
            kwargs["descripterizer_backends"] = [b.strip() for b in val.split(",")]
    if "descripterizer_max_failures" in memory:
        kwargs["descripterizer_max_failures"] = int(memory["descripterizer_max_failures"])
    if "descripterizer_cloud_threshold" in memory:
        kwargs["descripterizer_cloud_threshold"] = int(memory["descripterizer_cloud_threshold"])
    if "descripterizer_zai_url" in memory:
        kwargs["descripterizer_zai_url"] = memory["descripterizer_zai_url"]
    if "descripterizer_zai_model" in memory:
        kwargs["descripterizer_zai_model"] = memory["descripterizer_zai_model"]
    if "descripterizer_debug" in memory:
        kwargs["descripterizer_debug"] = bool(memory["descripterizer_debug"])

    queue = data.get("queue", {})
    if "batch_size" in queue:
        kwargs["batch_size"] = queue["batch_size"]
    if "overflow_threshold" in queue:
        kwargs["overflow_threshold"] = queue["overflow_threshold"]
    if "max_workers" in queue:
        kwargs["max_workers"] = queue["max_workers"]

    summarizer_cfg = data.get("summarizer", summarizer)
    if "debug" in summarizer_cfg:
        kwargs["summarizer_debug"] = summarizer_cfg["debug"]

    truncation = data.get("truncation", {})
    for key in (
        "user_message_max",
        "assistant_message_max",
        "log_user_prefix",
        "log_assistant_prefix",
    ):
        if key in truncation:
            kwargs[key] = truncation[key]

    if "code_db_path" in data:
        kwargs["code_db_path"] = Path(data["code_db_path"])

    projects_data = data.get("projects", {}) or {}
    if projects_data:
        projects = {}
        for name, proj_data in projects_data.items():
            proj_data = proj_data or {}
            source_root = None
            if "source_root" in proj_data and proj_data["source_root"]:
                source_root = Path(proj_data["source_root"]).expanduser()
            projects[name] = ProjectConfig(source_root=source_root)
        kwargs["projects"] = projects

    if "settings_path" in data:
        kwargs["settings_path"] = Path(data["settings_path"])

    return Config(**kwargs)


# Module-level singleton — patched in tests via monkeypatch("core.config._config", ...)
_config: Config | None = None


def get_config() -> Config:
    """Return cached config singleton. Lazy-loads on first call."""
    global _config
    if _config is None:
        _config = _load_config()
    return _config
