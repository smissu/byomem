#!/usr/bin/env python3
"""
byomem MCP server — exposes memory tools to Claude Code over stdio.

Tools: mem_context, mem_search, mem_get, mem_show, mem_latest, mem_list_projects.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP

from core.config import get_config
from core.search_index import hybrid_search

mcp = FastMCP("byomem")


@mcp.tool()
def mem_context(
    project: str,
    branch: str = "",
    commit: str = "",
    log_lines: int = 0,
) -> str:
    """Progressive retrieval of project memory.

    Bare call (no branch): returns main.md + branch listing.
    With branch: returns metadata + recent commits.
    With branch + commit: returns full commit.md.
    With branch + log_lines: returns last N lines of log.md.
    """
    cfg = get_config()
    proj_dir = cfg.byomem / project

    if not proj_dir.exists():
        return f"Project '{project}' not found in {cfg.byomem}"

    if not branch:
        # Bare snapshot: main.md + branch listing
        out = f"## {project} — Memory Snapshot\n\n"

        main_path = proj_dir / "main.md"
        if main_path.exists():
            out += main_path.read_text() + "\n"

        branches_dir = proj_dir / "branches"
        if branches_dir.exists():
            out += "\n## Branches\n"
            for b in sorted(branches_dir.iterdir(), reverse=True):
                if b.is_dir():
                    summary = _branch_summary(b)
                    out += f"  - {b.name}: {summary}\n"

        return out

    # Branch-level view
    branch_dir = proj_dir / "branches" / branch
    if not branch_dir.exists():
        return f"Branch '{branch}' not found in {project}"

    if commit:
        # Full commit.md
        commit_path = branch_dir / "commit.md"
        if commit_path.exists():
            return commit_path.read_text()
        return "commit.md is empty."

    if log_lines > 0:
        # Last N lines of log.md
        log_path = branch_dir / "log.md"
        if log_path.exists():
            lines = log_path.read_text().splitlines()
            return "\n".join(lines[-log_lines:])
        return "log.md is empty."

    # Default: metadata + recent commits
    out = ""
    meta_path = branch_dir / "metadata.md"
    if meta_path.exists():
        out += meta_path.read_text() + "\n"

    commit_path = branch_dir / "commit.md"
    if commit_path.exists():
        text = commit_path.read_text()
        if text.strip():
            lines = text.splitlines()
            out += "\n## Recent Commits\n"
            out += "\n".join(lines[-10:]) + "\n"

    return out


@mcp.tool()
def mem_search(
    query: str,
    project: str = "",
    max_results: int = 6,
    min_score: float = 0.35,
) -> str:
    """Hybrid FTS5 + vector search over indexed memory files.

    Returns scored snippets with line numbers. Follow up with mem_get
    to read full content of relevant hits.
    """
    results = hybrid_search(
        query, project=project, max_results=max_results, min_score=min_score
    )

    if not results:
        out = f'## Search: "{query}"\n0 results'
        if project:
            out += f" in {project}"
        return out

    out = f'## Search: "{query}"\n{len(results)} results (min score {min_score})\n\n'
    out += "─" * 40 + "\n"

    for i, r in enumerate(results, 1):
        out += (
            f"[{i}] score: {r['score']:.2f} | "
            f"{r['path']} (lines {r['start_line']}–{r['end_line']})\n"
            f"{r['preview']}\n\n"
        )

    out += "─" * 40 + "\n"
    out += "Use mem_get(path, start_line, count) to read full content.\n"
    return out


@mcp.tool()
def mem_get(path: str, start_line: int, line_count: int = 20) -> str:
    """Fetch exact lines from a memory file.

    Path is relative to ~/.byomem/. Use after mem_search to read
    specific chunks without fetching entire files.
    """
    cfg = get_config()
    full_path = cfg.byomem / path

    if not full_path.exists():
        return f"File not found: {path}"

    lines = full_path.read_text().splitlines()
    end = min(start_line + line_count - 1, len(lines))
    selected = lines[start_line - 1 : end]

    return f"## {path} (lines {start_line}–{end})\n\n" + "\n".join(selected)


@mcp.tool()
def mem_show(project: str) -> str:
    """List all branches for a project with one-line metadata summaries."""
    cfg = get_config()
    branches_dir = cfg.byomem / project / "branches"

    if not branches_dir.exists():
        return f"No branches found for project '{project}'."

    branches = sorted(
        [b for b in branches_dir.iterdir() if b.is_dir()],
        reverse=True,
    )

    if not branches:
        return f"No branches found for project '{project}'."

    out = f"## {project} branches\n\n"
    for b in branches:
        summary = _branch_summary(b)
        out += f"- **{b.name}**: {summary}\n"

    return out


@mcp.tool()
def mem_latest(project: str) -> str:
    """Return the most recent branch's commit.md in full."""
    cfg = get_config()
    branches_dir = cfg.byomem / project / "branches"

    if not branches_dir.exists():
        return f"No branches found for project '{project}'."

    branches = sorted(
        [b for b in branches_dir.iterdir() if b.is_dir()],
        reverse=True,
    )

    if not branches:
        return f"No branches found for project '{project}'."

    latest = branches[0]
    out = f"## Latest branch: {latest.name}\n\n"

    commit_path = latest / "commit.md"
    if commit_path.exists():
        text = commit_path.read_text()
        if text.strip():
            out += text
        else:
            out += "(No commits yet.)"
    else:
        out += "(No commit.md found.)"

    return out


@mcp.tool()
def mem_list_projects() -> str:
    """List all projects tracked by byomem."""
    cfg = get_config()

    if not cfg.byomem.exists():
        return "No projects found."

    projects = sorted(
        d.name
        for d in cfg.byomem.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )

    # Filter out non-project dirs (search.db parent, etc.)
    projects = [
        p
        for p in projects
        if (cfg.byomem / p / "main.md").exists()
        or (cfg.byomem / p / "branches").exists()
    ]

    if not projects:
        return "No projects found."

    out = "## byomem projects\n\n"
    for p in projects:
        branch_count = 0
        branches_dir = cfg.byomem / p / "branches"
        if branches_dir.exists():
            branch_count = sum(1 for b in branches_dir.iterdir() if b.is_dir())
        has_main = (cfg.byomem / p / "main.md").exists()
        out += f"- **{p}** ({branch_count} branches"
        if has_main:
            out += ", has main.md"
        out += ")\n"

    return out


def _branch_summary(branch_dir: Path) -> str:
    """Extract summary line from a branch's metadata.md."""
    meta = branch_dir / "metadata.md"
    if meta.exists():
        for line in meta.read_text().splitlines():
            m = re.match(r"summary:\s*(.*)", line)
            if m and m.group(1).strip():
                return m.group(1).strip()
    return "(no summary)"


if __name__ == "__main__":
    mcp.run()
