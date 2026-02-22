"""Write summarized session data to main.md and project MEMORY.md."""

from datetime import date
from pathlib import Path

from core.config import get_config


def maybe_update_main(project: str, summary: dict, turn_id: str | None = None):
    cfg = get_config()
    main = cfg.byomem / project / "main.md"
    if not main.exists():
        main.parent.mkdir(parents=True, exist_ok=True)
        main.write_text(f"# {project}\n\n## Key Decisions & Fixes\n")
    content = main.read_text()
    entry = (
        f"- [{date.today()}] [{summary['classification'].upper()}] "
        f"{summary['title']}: {summary['summary']}"
    )
    if turn_id:
        entry += f" <!-- turn: {turn_id} -->"
    entry += "\n"
    if "## Key Decisions & Fixes" not in content:
        content += "\n## Key Decisions & Fixes\n"
    main.write_text(content + entry)


def maybe_update_project_memory(cwd: str, summary: dict):
    path = _cc_memory_path(cwd)
    content = path.read_text() if path.exists() else ""
    entry = f"\n- [{date.today()}] {summary['title']}: {summary['summary']}"
    if "## Auto-captured" not in content:
        content += "\n\n## Auto-captured\n"
    path.write_text(content + entry)


def _cc_memory_path(cwd: str) -> Path:
    encoded = cwd.replace("/", "-")
    mem_dir = Path.home() / ".claude" / "projects" / encoded / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    return mem_dir / "MEMORY.md"
