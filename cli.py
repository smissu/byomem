#!/usr/bin/env python3
"""byomem CLI — manage memory hooks, search index, and branch data."""
import argparse
import json
import os
import re
import sys
import tempfile

from core.config import get_config


def cmd_install():
    """Register byomem Stop hook and MCP server in settings.json."""
    cfg = get_config()
    venv_python = cfg.byomem / ".venv" / "bin" / "python"
    stop_hook = cfg.byomem / "hooks" / "stop_hook.py"
    mcp_server = cfg.byomem / "mcp_server.py"

    if not venv_python.exists():
        print(f"Error: venv python not found at {venv_python}", file=sys.stderr)
        return 1

    # Read existing settings
    settings = {}
    if cfg.settings_path.exists():
        try:
            settings = json.loads(cfg.settings_path.read_text())
        except (json.JSONDecodeError, ValueError):
            backup = cfg.settings_path.with_suffix(".json.bak")
            cfg.settings_path.rename(backup)
            print(f"Malformed settings.json backed up to {backup}")

    # Ensure structure
    hooks = settings.setdefault("hooks", {})
    stop_list = hooks.setdefault("Stop", [])

    # Remove any existing byomem entries (idempotent)
    stop_list[:] = [
        entry for entry in stop_list
        if not _is_byomem_hook_entry(entry)
    ]

    # Add Stop hook (nested format per Claude Code spec)
    hook_command = f"{venv_python} {stop_hook}"
    stop_list.append({
        "matcher": "",
        "hooks": [{"type": "command", "command": hook_command}],
    })

    # Add MCP server
    servers = settings.setdefault("mcpServers", {})
    servers["byomem"] = {
        "command": str(venv_python),
        "args": [str(mcp_server)],
    }

    # Atomic write
    _atomic_write_json(cfg.settings_path, settings)
    print("byomem installed: Stop hook and MCP server registered.")
    return 0


def cmd_uninstall():
    """Remove byomem entries from settings.json."""
    cfg = get_config()
    if not cfg.settings_path.exists():
        print("Nothing to uninstall (settings.json not found).")
        return 0

    try:
        settings = json.loads(cfg.settings_path.read_text())
    except (json.JSONDecodeError, ValueError):
        print("settings.json is malformed, skipping.", file=sys.stderr)
        return 1

    changed = False

    # Remove hook entries
    stop_list = settings.get("hooks", {}).get("Stop", [])
    filtered = [e for e in stop_list if not _is_byomem_hook_entry(e)]
    if len(filtered) != len(stop_list):
        settings["hooks"]["Stop"] = filtered
        changed = True

    # Remove MCP server
    if "byomem" in settings.get("mcpServers", {}):
        del settings["mcpServers"]["byomem"]
        changed = True

    if changed:
        _atomic_write_json(cfg.settings_path, settings)
        print("byomem uninstalled.")
    else:
        print("byomem was not installed.")
    return 0


def cmd_status():
    """Print installation status of hook and MCP server."""
    cfg = get_config()
    if not cfg.settings_path.exists():
        print("Hook: not installed")
        print("MCP Server: not installed")
        return

    try:
        settings = json.loads(cfg.settings_path.read_text())
    except (json.JSONDecodeError, ValueError):
        print("Error: settings.json is malformed", file=sys.stderr)
        return

    # Check hook
    stop_list = settings.get("hooks", {}).get("Stop", [])
    hook_found = any(_is_byomem_hook_entry(e) for e in stop_list)
    print(f"Hook: {'installed' if hook_found else 'not installed'}")

    # Check MCP server
    mcp_found = "byomem" in settings.get("mcpServers", {})
    print(f"MCP Server: {'installed' if mcp_found else 'not installed'}")


def cmd_show(project):
    """List branches for a project with summaries from metadata.md."""
    cfg = get_config()
    branches_dir = cfg.byomem / project / "branches"
    if not branches_dir.exists():
        print(f"No branches found for project '{project}'.")
        return

    branches = sorted(branches_dir.iterdir(), reverse=True)
    if not branches:
        print(f"No branches found for project '{project}'.")
        return

    for branch in branches:
        if not branch.is_dir():
            continue
        summary = _read_metadata_field(branch / "metadata.md", "summary")
        status = _read_metadata_field(branch / "metadata.md", "status")
        line = f"  {branch.name}"
        if status:
            line += f"  [{status}]"
        if summary:
            line += f"  {summary}"
        print(line)


def cmd_log(project, branch):
    """Print the commit.md content for a branch."""
    cfg = get_config()
    commit_path = cfg.byomem / project / "branches" / branch / "commit.md"
    if not commit_path.exists():
        print(f"Branch '{branch}' not found in project '{project}'.")
        return
    content = commit_path.read_text()
    if content.strip():
        print(content)
    else:
        print("(empty commit log)")


def cmd_search(query, project=""):
    """Search the memory index."""
    try:
        from core.search_index import hybrid_search
    except ImportError as e:
        print(f"Search unavailable: {e}", file=sys.stderr)
        return

    results = hybrid_search(query, project=project, min_score=0.0)
    if not results:
        print("No results.")
        return

    for r in results:
        print(f"[{r['score']:.4f}] {r['path']}  (lines {r['start_line']}-{r['end_line']})")
        preview = r["preview"][:200].replace("\n", " ")
        print(f"  {preview}")
        print()


def cmd_merge(project, branch):
    """Merge a branch's commit summary into main.md (no LLM)."""
    cfg = get_config()
    branch_dir = cfg.byomem / project / "branches" / branch
    if not branch_dir.exists():
        print(f"Branch '{branch}' not found in project '{project}'.")
        return 1

    meta_path = branch_dir / "metadata.md"
    commit_path = branch_dir / "commit.md"

    # Check if already merged
    status = _read_metadata_field(meta_path, "status")
    if status == "merged":
        print(f"Branch '{branch}' is already merged.")
        return 0

    # Get summary text
    summary_text = _read_metadata_field(meta_path, "summary")
    if not summary_text and commit_path.exists():
        # Fallback: first non-empty line of commit.md
        for line in commit_path.read_text().splitlines():
            stripped = line.strip().lstrip("#").strip()
            if stripped:
                summary_text = stripped
                break
    if not summary_text:
        summary_text = branch

    # Append to main.md
    main_path = cfg.byomem / project / "main.md"
    if not main_path.exists():
        main_path.parent.mkdir(parents=True, exist_ok=True)
        main_path.write_text(f"# {project}\n\n## Key Decisions & Fixes\n")
    content = main_path.read_text()
    if "## Key Decisions & Fixes" not in content:
        content += "\n## Key Decisions & Fixes\n"
    content += f"- [{branch}] {summary_text}\n"
    main_path.write_text(content)

    # Update metadata status
    if meta_path.exists():
        meta = meta_path.read_text()
        meta = re.sub(r"^status:.*$", "status: merged", meta, flags=re.MULTILINE)
        meta_path.write_text(meta)

    print(f"Merged '{branch}' into {project}/main.md")
    return 0


def cmd_reindex():
    """Rebuild the search index from all commit.md and main.md files."""
    cfg = get_config()

    # Delete existing DB
    if cfg.db_path.exists():
        cfg.db_path.unlink()
        print(f"Deleted {cfg.db_path}")

    try:
        from core.search_index import index_file
    except ImportError as e:
        print(f"Search unavailable: {e}", file=sys.stderr)
        return

    # Glob all commit.md and main.md files
    files = list(cfg.byomem.glob("**/commit.md")) + list(cfg.byomem.glob("**/main.md"))
    for f in files:
        # Derive project from path relative to byomem root
        rel = f.relative_to(cfg.byomem)
        project = rel.parts[0] if rel.parts else ""
        index_file(f, project)

    print(f"Indexed {len(files)} file(s).")


# --- helpers ---

def _is_byomem_hook_entry(entry):
    """Return True if a Stop hook entry belongs to byomem."""
    # Check nested format: {"matcher": "", "hooks": [{"type": "command", "command": "..."}]}
    for h in entry.get("hooks", []):
        if "byomem" in h.get("command", ""):
            return True
    # Check flat format: {"type": "command", "command": "..."}
    if "byomem" in entry.get("command", ""):
        return True
    return False


def _read_metadata_field(path, field):
    """Read a single field value from a metadata.md file."""
    if not path.exists():
        return ""
    for line in path.read_text().splitlines():
        m = re.match(rf"^{re.escape(field)}:\s*(.*)", line)
        if m:
            return m.group(1).strip()
    return ""


def _atomic_write_json(path, data):
    """Write JSON atomically via temp file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.rename(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main():
    parser = argparse.ArgumentParser(
        prog="byomem",
        description="Manage byomem memory hooks and search index.",
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("install", help="Register Stop hook and MCP server")
    sub.add_parser("uninstall", help="Remove byomem from settings.json")
    sub.add_parser("status", help="Show installation status")

    p_show = sub.add_parser("show", help="List branches for a project")
    p_show.add_argument("project", help="Project name")

    p_log = sub.add_parser("log", help="Print commit log for a branch")
    p_log.add_argument("project", help="Project name")
    p_log.add_argument("branch", help="Branch name")

    p_search = sub.add_parser("search", help="Search the memory index")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--project", default="", help="Filter by project")

    p_merge = sub.add_parser("merge", help="Merge a branch into main.md")
    p_merge.add_argument("project", help="Project name")
    p_merge.add_argument("branch", help="Branch name")

    sub.add_parser("reindex", help="Rebuild the search index")

    args = parser.parse_args()

    if args.command == "install":
        sys.exit(cmd_install())
    elif args.command == "uninstall":
        sys.exit(cmd_uninstall())
    elif args.command == "status":
        cmd_status()
    elif args.command == "show":
        cmd_show(args.project)
    elif args.command == "log":
        cmd_log(args.project, args.branch)
    elif args.command == "search":
        cmd_search(args.query, project=args.project)
    elif args.command == "merge":
        sys.exit(cmd_merge(args.project, args.branch))
    elif args.command == "reindex":
        cmd_reindex()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
