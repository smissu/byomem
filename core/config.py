"""
Single source of truth for all byomem configuration.
Replaces scattered module-level BYOMEM/DB_PATH constants.
"""
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Config:
    byomem: Path = field(default_factory=lambda: Path.home() / ".byomem")
    summarizer_model: str = "claude-haiku-4-5-20251001"
    summarizer_max_tokens: int = 300
    embedding_model: str = "text-embedding-3-small"
    embedding_dimension: int = 1536
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
    settings_path: Path = field(
        default_factory=lambda: Path.home() / ".claude" / "settings.json"
    )

    @property
    def db_path(self) -> Path:
        return self.byomem / "search.db"


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

    embeddings = data.get("embeddings", {})
    if "model" in embeddings:
        kwargs["embedding_model"] = embeddings["model"]
    if "dimension" in embeddings:
        kwargs["embedding_dimension"] = embeddings["dimension"]

    memory = data.get("memory", {})
    for key in ("chunk_tokens", "chunk_overlap", "max_results", "min_score",
                "vector_weight", "keyword_weight",
                "candidate_multiplier", "approx_chars_per_token"):
        if key in memory:
            kwargs[key] = memory[key]

    truncation = data.get("truncation", {})
    for key in ("user_message_max", "assistant_message_max", "log_user_prefix", "log_assistant_prefix"):
        if key in truncation:
            kwargs[key] = truncation[key]

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
