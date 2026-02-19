"""Tests for core/config.py — Config dataclass and get_config() singleton."""
from pathlib import Path

import yaml

from core.config import Config, _load_config, get_config


def test_defaults_without_yaml():
    """Config() uses sensible defaults when no YAML exists."""
    cfg = Config()
    assert cfg.byomem == Path.home() / ".byomem"
    assert cfg.summarizer_model == "claude-haiku-4-5-20251001"
    assert cfg.summarizer_max_tokens == 300
    assert cfg.embedding_model == "text-embedding-3-small"
    assert cfg.embedding_dimension == 1536
    assert cfg.chunk_tokens == 400
    assert cfg.chunk_overlap == 80
    assert cfg.max_results == 6
    assert cfg.min_score == 0.35
    assert cfg.vector_weight == 0.7
    assert cfg.keyword_weight == 0.3
    assert cfg.settings_path == Path.home() / ".claude" / "settings.json"


def test_loads_from_yaml(tmp_path, monkeypatch):
    """Config loads all fields from a YAML file."""
    config_yaml = tmp_path / ".byomem" / "config.yaml"
    config_yaml.parent.mkdir(parents=True)
    config_yaml.write_text(yaml.dump({
        "summarizer": {"model": "custom-model", "max_tokens": 500},
        "embeddings": {"model": "voyage-3", "dimension": 1024},
        "memory": {
            "chunk_tokens": 200,
            "chunk_overlap": 40,
            "max_results": 10,
            "min_score": 0.5,
            "vector_weight": 0.6,
            "keyword_weight": 0.4,
        },
    }))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.summarizer_model == "custom-model"
    assert cfg.summarizer_max_tokens == 500
    assert cfg.embedding_model == "voyage-3"
    assert cfg.embedding_dimension == 1024
    assert cfg.chunk_tokens == 200
    assert cfg.chunk_overlap == 40
    assert cfg.max_results == 10
    assert cfg.min_score == 0.5
    assert cfg.vector_weight == 0.6
    assert cfg.keyword_weight == 0.4


def test_missing_yaml_uses_defaults(tmp_path, monkeypatch):
    """When config.yaml doesn't exist, _load_config returns defaults."""
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.summarizer_model == "claude-haiku-4-5-20251001"
    assert cfg.byomem == tmp_path / ".byomem"


def test_partial_yaml_merges_with_defaults(tmp_path, monkeypatch):
    """Partial YAML only overrides specified fields."""
    config_yaml = tmp_path / ".byomem" / "config.yaml"
    config_yaml.parent.mkdir(parents=True)
    config_yaml.write_text(yaml.dump({
        "summarizer": {"model": "my-model"},
    }))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.summarizer_model == "my-model"
    # Other fields stay default
    assert cfg.summarizer_max_tokens == 300
    assert cfg.embedding_model == "text-embedding-3-small"
    assert cfg.chunk_tokens == 400


def test_byomem_property_paths():
    """Config.db_path is derived from byomem root."""
    cfg = Config(byomem=Path("/tmp/test-byomem"))
    assert cfg.db_path == Path("/tmp/test-byomem/search.db")


def test_get_config_caches_singleton(monkeypatch):
    """get_config() returns the same object on repeated calls."""
    import core.config as config_mod
    monkeypatch.setattr(config_mod, "_config", None)
    cfg1 = get_config()
    cfg2 = get_config()
    assert cfg1 is cfg2


def test_new_config_fields_defaults():
    """New Sprint 04 config fields have correct defaults."""
    cfg = Config()
    assert cfg.candidate_multiplier == 4
    assert cfg.approx_chars_per_token == 4
    assert cfg.user_message_max == 2000
    assert cfg.assistant_message_max == 3000
    assert cfg.log_user_prefix == 300
    assert cfg.log_assistant_prefix == 600


def test_memory_section_new_fields(tmp_path, monkeypatch):
    """memory section in YAML sets candidate_multiplier and approx_chars_per_token."""
    config_yaml = tmp_path / ".byomem" / "config.yaml"
    config_yaml.parent.mkdir(parents=True)
    config_yaml.write_text(yaml.dump({
        "memory": {"candidate_multiplier": 8, "approx_chars_per_token": 3},
    }))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.candidate_multiplier == 8
    assert cfg.approx_chars_per_token == 3


def test_truncation_section(tmp_path, monkeypatch):
    """truncation section in YAML sets message/log limits."""
    config_yaml = tmp_path / ".byomem" / "config.yaml"
    config_yaml.parent.mkdir(parents=True)
    config_yaml.write_text(yaml.dump({
        "truncation": {
            "user_message_max": 1000,
            "assistant_message_max": 1500,
            "log_user_prefix": 200,
            "log_assistant_prefix": 400,
        },
    }))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.user_message_max == 1000
    assert cfg.assistant_message_max == 1500
    assert cfg.log_user_prefix == 200
    assert cfg.log_assistant_prefix == 400


def test_partial_truncation_merges(tmp_path, monkeypatch):
    """Setting only some truncation fields keeps defaults for others."""
    config_yaml = tmp_path / ".byomem" / "config.yaml"
    config_yaml.parent.mkdir(parents=True)
    config_yaml.write_text(yaml.dump({
        "truncation": {"user_message_max": 500},
    }))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    cfg = _load_config()
    assert cfg.user_message_max == 500
    assert cfg.assistant_message_max == 3000  # default
