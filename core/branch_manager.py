"""GCC branch lifecycle — create, append, commit, metadata."""
import re
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


def append_to_log(branch: Branch, turn: dict):
    entry = (
        f"\n<!-- last_id: {turn['id']} -->\n"
        f"---\n**[{turn['timestamp']}]** {turn['user'][:300]}\n\n"
        f"{turn['assistant'][:600]}\n"
    )
    with branch.log_md.open("a") as f:
        f.write(entry)


def commit_milestone(branch: Branch, summary: dict):
    existing = branch.commit_md.read_text() if branch.commit_md.exists() else ""
    new_content = existing + (
        f"\n## This Commit's Contribution\n"
        f"**[{summary['classification'].upper()}] {summary['title']}**\n"
        f"{summary['summary']}\n"
    )
    branch.commit_md.write_text(new_content)


def update_metadata(branch: Branch, last_turn: dict):
    meta = branch.meta_md.read_text()
    meta = re.sub(r"last_updated:.*\n", "", meta)
    meta += f"last_updated: {last_turn['timestamp']}\n"
    branch.meta_md.write_text(meta)


def _last_turn_id(log_path: Path) -> str | None:
    if not log_path.exists() or not log_path.stat().st_size:
        return None
    for line in reversed(log_path.read_text().splitlines()):
        if "<!-- last_id:" in line:
            return line.split("last_id:")[1].strip().rstrip(" -->")
    return None
