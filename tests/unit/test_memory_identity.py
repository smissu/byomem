from pathlib import Path


def test_resolve_project_name_uses_git_root_when_present(tmp_path):
    from core.memory_identity import resolve_project_name

    repo = tmp_path / "myproject"
    repo.mkdir()
    (repo / ".git").mkdir()
    nested = repo / "src" / "pkg"
    nested.mkdir(parents=True)

    assert resolve_project_name(str(nested)) == "myproject"


def test_project_id_is_stable_for_same_workspace(tmp_path):
    from core.memory_identity import resolve_project_id

    repo_a = tmp_path / "repo-a"
    repo_a.mkdir()

    assert resolve_project_id(str(repo_a)) == resolve_project_id(str(repo_a.resolve()))


def test_project_id_does_not_collide_for_same_leaf_name(tmp_path):
    from core.memory_identity import resolve_project_id

    repo_a = tmp_path / "team-a" / "shared"
    repo_b = tmp_path / "team-b" / "shared"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)

    assert resolve_project_id(str(repo_a)) != resolve_project_id(str(repo_b))


def test_user_id_is_stable_for_default_local_identity(monkeypatch):
    from core.memory_identity import resolve_user_id

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    assert resolve_user_id() == resolve_user_id()


def test_user_id_prefers_explicit_override(monkeypatch):
    from core.memory_identity import resolve_user_id

    monkeypatch.setenv("BYOMEM_USER_ID", "explicit-user")
    assert resolve_user_id().startswith("user_")
