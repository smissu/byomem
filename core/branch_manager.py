"""GCC branch lifecycle — create, append, commit, metadata."""

import re
import shutil
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from core.config import get_config


@dataclass
class Branch:
    path: Path
    last_turn_id: str | None

    @property
    def commit_md(self):
        return self.path / "commit.md"

    @property
    def log_md(self):
        return self.path / "log.md"

    @property
    def meta_md(self):
        return self.path / "metadata.md"


def get_or_create_branch(project: str, session_id: str) -> Branch:
    cfg = get_config()
    slug = session_id[:8]
    name = f"{date.today()}-{slug}"
    path = cfg.byomem / project / "branches" / name
    path.mkdir(parents=True, exist_ok=True)

    for f in (path / "commit.md", path / "log.md"):
        if not f.exists():
            f.write_text("")

    if not (path / "metadata.md").exists():
        (path / "metadata.md").write_text(
            f"# {name}\ndate: {date.today()}\nstatus: active\ntype:\ntags:\nsummary:\n"
        )

    return Branch(path=path, last_turn_id=_last_turn_id(path / "log.md"))


def append_to_log(branch: Branch, turn):
    cfg = get_config()
    if isinstance(turn, dict):
        tid, ts, user, asst = turn["id"], turn["timestamp"], turn["user"], turn["assistant"]
    else:
        tid, ts, user, asst = turn.id, turn.timestamp, turn.user, turn.assistant
    entry = (
        f"\n<!-- last_id: {tid} -->\n"
        f"---\n**[{ts}]** {user[: cfg.log_user_prefix]}\n\n"
        f"{asst[: cfg.log_assistant_prefix]}\n"
    )
    with branch.log_md.open("a") as f:
        f.write(entry)


def commit_milestone(branch: Branch, summary: dict, turn_id: str | None = None):
    existing = branch.commit_md.read_text() if branch.commit_md.exists() else ""
    header = f"**[{summary['classification'].upper()}] {summary['title']}**"
    if turn_id:
        header += f" <!-- turn: {turn_id} -->"
    new_content = existing + (f"\n## This Commit's Contribution\n{header}\n{summary['summary']}\n")
    branch.commit_md.write_text(new_content)


def extract_log_section(log_path: Path, turn_id: str, max_chars: int = 800) -> str | None:
    """Find the log section for a turn_id anchor, return bounded text."""
    if not log_path.exists():
        return None
    content = log_path.read_text()
    anchor = f"<!-- last_id: {turn_id} -->"
    start = content.find(anchor)
    if start == -1:
        return None
    # Find next anchor after this one
    next_anchor = content.find("<!-- last_id:", start + len(anchor))
    if next_anchor == -1:
        section = content[start:]
    else:
        section = content[start:next_anchor]
    return section[:max_chars]


def update_metadata(branch: Branch, last_turn, summary: dict | None = None):
    if isinstance(last_turn, dict):
        ts = last_turn["timestamp"]
    else:
        ts = last_turn.timestamp
    meta = branch.meta_md.read_text()
    meta = re.sub(r"last_updated:.*\n", "", meta)
    meta += f"last_updated: {ts}\n"
    if summary and summary.get("title"):
        meta = re.sub(r"summary:.*\n", f"summary: {summary['title']}\n", meta)
    branch.meta_md.write_text(meta)


def list_branches(
    project: str, status: str | None = None, older_than_days: int | None = None
) -> list[dict]:
    """List branches for a project with optional filtering.

    Returns list of dicts: {name, status, age_days, size_bytes, path}
    Age derived from branch name YYYY-MM-DD prefix.
    """
    cfg = get_config()
    branches_dir = cfg.byomem / project / "branches"
    if not branches_dir.exists():
        return []

    today = date.today()
    results = []
    for d in sorted(branches_dir.iterdir(), reverse=True):
        if not d.is_dir():
            continue

        # Parse age from branch name (YYYY-MM-DD prefix)
        age_days = None
        m = re.match(r"(\d{4}-\d{2}-\d{2})", d.name)
        if m:
            try:
                branch_date = date.fromisoformat(m.group(1))
                age_days = (today - branch_date).days
            except ValueError:
                pass

        # Read status from metadata.md
        branch_status = ""
        meta = d / "metadata.md"
        if meta.exists():
            for line in meta.read_text().splitlines():
                sm = re.match(r"^status:\s*(.*)", line)
                if sm:
                    branch_status = sm.group(1).strip()
                    break

        # Calculate size
        size_bytes = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())

        # Apply filters
        if status and branch_status != status:
            continue
        if older_than_days is not None and (age_days is None or age_days < older_than_days):
            continue

        results.append(
            {
                "name": d.name,
                "status": branch_status,
                "age_days": age_days,
                "size_bytes": size_bytes,
                "path": d,
            }
        )

    return results


def delete_branch(project: str, branch_name: str) -> bool:
    """Delete a branch directory. Returns True if deleted, False if not found."""
    cfg = get_config()
    branch_dir = cfg.byomem / project / "branches" / branch_name
    if not branch_dir.exists():
        return False
    shutil.rmtree(branch_dir)
    return True


def _last_turn_id(log_path: Path) -> str | None:
    if not log_path.exists() or not log_path.stat().st_size:
        return None
    for line in reversed(log_path.read_text().splitlines()):
        if "<!-- last_id:" in line:
            return line.split("last_id:")[1].strip().rstrip(" -->")
    return None
