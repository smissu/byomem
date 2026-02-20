#!/usr/bin/env python3
"""byomem CLI — manage memory hooks, search index, and branch data."""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

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


def cmd_projects():
    """List all projects with basic stats."""
    cfg = get_config()
    projects = sorted(
        d for d in cfg.byomem.iterdir()
        if d.is_dir() and not d.name.startswith(".") and d.name != "queue"
        and ((d / "branches").exists() or (d / "main.md").exists())
    )
    if not projects:
        print("No projects found.")
        return

    for p in projects:
        branches_dir = p / "branches"
        branch_count = sum(1 for b in branches_dir.iterdir() if b.is_dir()) if branches_dir.exists() else 0
        has_main = (p / "main.md").exists()
        main_lines = len((p / "main.md").read_text().splitlines()) if has_main else 0
        print(f"  {p.name:<20} {branch_count} branch(es), main.md: {main_lines} lines")


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


def cmd_gc(project="", days=90, dry_run=False, reindex=False):
    """Garbage-collect merged branches older than --days."""
    cfg = get_config()

    # Determine projects to scan
    if project:
        projects = [project]
    else:
        projects = sorted(
            d.name for d in cfg.byomem.iterdir()
            if d.is_dir() and not d.name.startswith(".")
            and ((d / "branches").exists() or (d / "main.md").exists())
        )

    from core.branch_manager import delete_branch, list_branches

    total_deleted = 0
    total_freed = 0

    for proj in projects:
        branches = list_branches(proj, status="merged", older_than_days=days)
        if not branches:
            continue

        print(f"\n{proj}:")
        for b in branches:
            age_str = f"{b['age_days']}d old" if b['age_days'] is not None else "unknown age"
            size_str = f"{b['size_bytes'] / 1024:.0f} KB"

            if dry_run:
                print(f"  [dry-run] would delete {b['name']} ({age_str}, {size_str})")
            else:
                # Delete from search index first
                try:
                    from core.search_index import delete_indexed_prefix
                    rel_prefix = f"{proj}/branches/{b['name']}/"
                    delete_indexed_prefix(rel_prefix)
                except ImportError:
                    pass

                delete_branch(proj, b['name'])
                print(f"  deleted {b['name']} ({age_str}, {size_str})")

            total_deleted += 1
            total_freed += b['size_bytes']

    if not dry_run and total_deleted > 0:
        # Clean up orphaned entries
        try:
            from core.search_index import cleanup_orphaned_entries
            orphaned = cleanup_orphaned_entries()
            if orphaned:
                print(f"\nCleaned {orphaned} orphaned search index entries.")
        except ImportError:
            pass

    if total_deleted == 0:
        print("Nothing to clean up.")
    else:
        action = "Would delete" if dry_run else "Deleted"
        print(f"\n{action} {total_deleted} branch(es), ~{total_freed / 1024:.0f} KB freed.")

    if reindex and not dry_run and total_deleted > 0:
        print("Rebuilding search index...")
        cmd_reindex()

    return 0


def cmd_stats(project="", fmt="text"):
    """Show project statistics."""
    from core.reporting import compute_global_stats, compute_project_stats

    if project:
        stats = compute_project_stats(project)
        if fmt == "json":
            import json as json_mod
            print(json_mod.dumps(stats, indent=2, default=str))
            return 0

        print(f"\n  {project}")
        print(f"  Branches: {stats['branches_total']} ({stats['branches_active']} active, {stats['branches_merged']} merged)")
        if stats["type_distribution"]:
            types = ", ".join(f"{k}: {v}" for k, v in stats["type_distribution"].items())
            print(f"  Types: {types}")
        if stats["newest_branch"]:
            print(f"  Newest: {stats['newest_branch']}")
            print(f"  Oldest: {stats['oldest_branch']}")
        print(f"  Disk: {stats['disk_usage_bytes'] / 1024:.0f} KB")
        print(f"  main.md: {'yes' if stats['has_main'] else 'no'}")
    else:
        gstats = compute_global_stats()
        if fmt == "json":
            import json as json_mod
            print(json_mod.dumps(gstats, indent=2, default=str))
            return 0

        print(f"\n  Projects: {gstats['total_projects']}")
        print(f"  Total branches: {gstats['total_branches']}")
        print(f"  Total disk: {gstats['total_disk_bytes'] / 1024:.0f} KB")
        idx = gstats["search_index"]
        print(f"  Search index: {idx['files_count']} files, {idx['chunks_count']} chunks, {idx['db_size_bytes'] / 1024:.0f} KB")

        if gstats["projects"]:
            idx_by_project = idx.get("per_project", {})
            print("\n  Per project:")
            for ps in gstats["projects"]:
                chunks = idx_by_project.get(ps["project"], 0)
                print(f"    {ps['project']}: {ps['branches_total']} branches, {ps['disk_usage_bytes'] / 1024:.0f} KB, {chunks} indexed chunks")

    return 0


def cmd_health(repair=False):
    """Check index health and optionally repair."""
    from core.reporting import check_index_health

    health = check_index_health()

    print(f"\n  Status: {health['status']}")
    print(f"  Orphaned index entries: {health['orphaned_files']}")
    print(f"  Missing metadata: {len(health['missing_metadata'])}")

    if health["missing_metadata"]:
        for path in health["missing_metadata"]:
            print(f"    - {path}")

    if health["issues"]:
        for issue in health["issues"]:
            print(f"  Issue: {issue}")

    if repair and health["orphaned_files"] > 0:
        try:
            from core.search_index import cleanup_orphaned_entries
            removed = cleanup_orphaned_entries()
            print(f"\n  Repaired: removed {removed} orphaned entries.")
        except ImportError:
            print("  Could not import search index for repair.")

    return 0


def cmd_queue(purge=False, history=0):
    """Show queue status: pending, processing, and worker lock."""
    cfg = get_config()
    pending_dir = cfg.queue_path / "pending"
    processing_dir = cfg.queue_path / "processing"
    pid_file = cfg.queue_path / "worker.pid"

    failed_dir = cfg.queue_path / "failed"

    pending = sorted(pending_dir.glob("*.json")) if pending_dir.exists() else []
    processing = sorted(processing_dir.glob("*.json")) if processing_dir.exists() else []
    failed = sorted(failed_dir.glob("*.json")) if failed_dir.exists() else []

    # Worker lock status
    worker_status = "not running"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)
            worker_status = f"running (PID {pid})"
        except ProcessLookupError:
            worker_status = f"stale lock (PID {pid})"
        except (ValueError, OSError):
            worker_status = "invalid lock file"

    print(f"\n  Worker: {worker_status}")
    print(f"  Pending: {len(pending)}")
    print(f"  Processing: {len(processing)}")
    print(f"  Failed: {len(failed)}")
    print(f"  Overflow threshold: {cfg.overflow_threshold}")

    if purge and processing:
        for f in processing:
            f.unlink()
        print(f"\n  Purged {len(processing)} stale processing file(s).")
        # Clean stale PID lock too
        if pid_file.exists():
            try:
                pid = int(pid_file.read_text().strip())
                os.kill(pid, 0)
            except (ProcessLookupError, ValueError, OSError):
                pid_file.unlink(missing_ok=True)
                print("  Removed stale worker lock.")
    elif not purge and processing:
        print("\n  Stale processing files detected. Run with --purge to clean.")

    if failed:
        print(f"\n  Failed jobs ({len(failed)}):")
        for f in failed:
            try:
                data = json.loads(f.read_text())
                sid = data.get("session_id", "?")[:8]
                err = data.get("last_error", "unknown")
                cwd = Path(data.get("cwd", "")).name or "?"
                print(f"    {sid}  project={cwd}  error={err}")
            except (json.JSONDecodeError, KeyError):
                print(f"    {f.name}  (unreadable)")

    # Show recent processing history
    history_path = cfg.queue_path / "history.jsonl"
    if history_path.exists():
        lines = history_path.read_text().splitlines()
        n = history if history > 0 else 10
        recent = lines[-n:]
        if recent:
            print(f"\n  Recent history ({len(recent)}/{len(lines)}):")
            print(f"  {'Timestamp':<20} {'Session':<10} {'Model':<24} {'Duration':>8}  {'Status'}")
            print(f"  {'-'*19}  {'-'*9} {'-'*23} {'-'*8}  {'-'*6}")
            for line in recent:
                try:
                    entry = json.loads(line)
                    print(
                        f"  {entry['ts']:<20} {entry['session']:<10} {entry['model']:<24} "
                        f"{entry['duration_s']:>7.2f}s  {entry['status']}"
                    )
                except (json.JSONDecodeError, KeyError):
                    continue
    elif history > 0:
        print("\n  No processing history yet.")

    return 0


def cmd_wipe(confirm=False, project=""):
    """Wipe data for a fresh start. Wipes one project or all.

    Preserves config.yaml, hooks, MCP server, and installed state.
    """
    cfg = get_config()

    scope = f"project '{project}'" if project else "ALL byomem"

    if not confirm:
        print(f"This will delete {scope} data:")
        if not project:
            print("  - Search database (search.db)")
        else:
            print(f"  - Search index entries for {project}")
        print("  - Branch data (log.md, commit.md, metadata.md)")
        print("  - main.md project memory")
        if not project:
            print("  - Queue history and debug logs")
            print("  - Session offsets")
        print()
        print("Config, hooks, and MCP server are preserved.")
        print()
        # List available projects
        projects = sorted(
            d for d in cfg.byomem.iterdir()
            if d.is_dir() and not d.name.startswith(".") and d.name != "queue"
            and ((d / "branches").exists() or (d / "main.md").exists())
        )
        if projects:
            print("Projects:")
            for p in projects:
                branches_dir = p / "branches"
                branch_count = sum(1 for b in branches_dir.iterdir() if b.is_dir()) if branches_dir.exists() else 0
                print(f"  {p.name:<20} {branch_count} branch(es)")
            print()
        print("Run with --confirm to proceed.")
        return 1

    removed = []

    if project:
        # --- Per-project wipe ---
        project_dir = cfg.byomem / project
        if not project_dir.exists():
            print(f"Project '{project}' not found.")
            return 1

        # Remove project entries from search index
        try:
            from core.search_index import delete_indexed_prefix
            count = delete_indexed_prefix(f"{project}/")
            if count:
                removed.append(f"search index: {count} file(s) for {project}")
        except Exception:
            pass

        # Reset main.md
        main_md = project_dir / "main.md"
        if main_md.exists():
            main_md.write_text(f"# {project}\n\n## Key Decisions & Fixes\n")
            removed.append(str(main_md) + " (reset)")

        # Clear branch files
        _wipe_branches(project_dir / "branches", removed)

    else:
        # --- Full wipe ---
        # 1. Search DB + WAL/SHM
        for suffix in ("", "-shm", "-wal"):
            p = Path(str(cfg.db_path) + suffix)
            if p.exists():
                p.unlink()
                removed.append(str(p))

        # 2. All projects
        for project_dir in cfg.byomem.iterdir():
            if not project_dir.is_dir() or project_dir.name.startswith(".") or project_dir.name == "queue":
                continue

            main_md = project_dir / "main.md"
            if main_md.exists():
                main_md.write_text(f"# {project_dir.name}\n\n## Key Decisions & Fixes\n")
                removed.append(str(main_md) + " (reset)")

            _wipe_branches(project_dir / "branches", removed)

        # 3. Queue: history, debug log, session offsets
        queue_dir = cfg.queue_path
        if queue_dir.exists():
            for name in ("history.jsonl", "summarizer_debug.jsonl"):
                p = queue_dir / name
                if p.exists():
                    p.unlink()
                    removed.append(str(p))

            offsets_dir = queue_dir / "offsets"
            if offsets_dir.exists():
                for f in offsets_dir.iterdir():
                    f.unlink()
                    removed.append(str(f))

            failed_dir = queue_dir / "failed"
            if failed_dir.exists():
                for f in failed_dir.glob("*.json"):
                    f.unlink()
                    removed.append(str(f))

    print(f"Wiped {len(removed)} items ({scope}).")
    for r in removed:
        print(f"  {r}")

    return 0


def _wipe_branches(branches_dir, removed):
    """Clear branch files under a branches/ directory."""
    if not branches_dir.exists():
        return
    for branch in branches_dir.iterdir():
        if not branch.is_dir():
            continue
        for f in branch.iterdir():
            if f.name == ".lock":
                continue
            if f.name == "commit.md":
                f.write_text("")
            else:
                f.unlink()
            removed.append(str(f))


def cmd_merge_project(source, target, confirm=False):
    """Merge all data from source project into target project.

    Moves branches, appends main.md entries, and reindexes.
    """
    import shutil

    cfg = get_config()
    src_dir = cfg.byomem / source
    tgt_dir = cfg.byomem / target

    if not src_dir.exists():
        print(f"Source project '{source}' not found.")
        return 1
    if not tgt_dir.exists():
        print(f"Target project '{target}' not found.")
        return 1

    # Preview
    src_branches = []
    src_branches_dir = src_dir / "branches"
    if src_branches_dir.exists():
        src_branches = [b for b in src_branches_dir.iterdir() if b.is_dir()]

    src_main = src_dir / "main.md"
    main_entries = 0
    if src_main.exists():
        main_entries = sum(1 for line in src_main.read_text().splitlines() if line.startswith("- ["))

    print(f"Merge '{source}' -> '{target}':")
    print(f"  {len(src_branches)} branch(es) to move")
    print(f"  {main_entries} main.md entries to append")

    if not confirm:
        print("\nRun with --confirm to proceed.")
        return 1

    # 1. Move branches
    tgt_branches_dir = tgt_dir / "branches"
    tgt_branches_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    for branch in src_branches:
        dest = tgt_branches_dir / branch.name
        if dest.exists():
            # Append suffix to avoid collision
            dest = tgt_branches_dir / f"{branch.name}-from-{source}"
        shutil.move(str(branch), str(dest))
        moved += 1
    print(f"  Moved {moved} branch(es)")

    # 2. Append main.md entries
    if src_main.exists():
        src_content = src_main.read_text()
        entries = [line for line in src_content.splitlines() if line.startswith("- [")]
        if entries:
            tgt_main = tgt_dir / "main.md"
            if not tgt_main.exists():
                tgt_main.parent.mkdir(parents=True, exist_ok=True)
                tgt_main.write_text(f"# {target}\n\n## Key Decisions & Fixes\n")
            tgt_content = tgt_main.read_text()
            tgt_content += "\n".join(entries) + "\n"
            tgt_main.write_text(tgt_content)
            print(f"  Appended {len(entries)} entries to {target}/main.md")

    # 3. Remove source search index entries and reindex under target
    try:
        from core.search_index import delete_indexed_prefix, index_file

        delete_indexed_prefix(f"{source}/")

        # Reindex moved branches
        for branch in tgt_branches_dir.iterdir():
            if not branch.is_dir():
                continue
            commit = branch / "commit.md"
            if commit.exists() and commit.read_text().strip():
                index_file(commit, target)

        # Reindex target main.md
        tgt_main = tgt_dir / "main.md"
        if tgt_main.exists():
            index_file(tgt_main, target)

        print("  Reindexed search entries")
    except ImportError:
        print("  Warning: could not reindex (search_index unavailable)")

    # 4. Clean up empty source
    if src_branches_dir.exists() and not list(src_branches_dir.iterdir()):
        shutil.rmtree(str(src_dir))
        print(f"  Removed empty '{source}' directory")
    else:
        print(f"  Note: '{source}' directory still has files, remove manually if empty")

    print(f"\nDone. Merged '{source}' into '{target}'.")
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
    sub.add_parser("projects", help="List all projects")

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

    p_queue = sub.add_parser("queue", help="Show queue status")
    p_queue.add_argument("--purge", action="store_true", help="Remove stale processing files")
    p_queue.add_argument("--history", type=int, default=0, metavar="N", help="Show last N history entries (default: 10)")

    p_wipe = sub.add_parser("wipe", help="Wipe all data for a fresh start")
    p_wipe.add_argument("action", nargs="?", default="", help="'list' to show projects, or omit to wipe")
    p_wipe.add_argument("--confirm", action="store_true", help="Actually wipe (safety check)")
    p_wipe.add_argument("--project", default="", help="Wipe only this project")

    sub.add_parser("reindex", help="Rebuild the search index")

    p_stats = sub.add_parser("stats", help="Show project statistics")
    p_stats.add_argument("--project", default="", help="Show stats for one project")
    p_stats.add_argument("--format", default="text", choices=["text", "json"], help="Output format")

    p_health = sub.add_parser("health", help="Check index health")
    p_health.add_argument("--repair", action="store_true", help="Fix orphaned entries")

    p_merge_proj = sub.add_parser("merge-project", help="Merge one project's data into another")
    p_merge_proj.add_argument("source", help="Source project to merge from")
    p_merge_proj.add_argument("target", help="Target project to merge into")
    p_merge_proj.add_argument("--confirm", action="store_true", help="Actually merge (safety check)")

    p_gc = sub.add_parser("gc", help="Garbage-collect old merged branches")
    p_gc.add_argument("--project", default="", help="Limit to one project")
    p_gc.add_argument("--days", type=int, default=90, help="Delete merged branches older than N days (default: 90)")
    p_gc.add_argument("--dry-run", action="store_true", help="Show what would be deleted")
    p_gc.add_argument("--reindex", action="store_true", help="Rebuild search index after cleanup")

    args = parser.parse_args()

    if args.command == "install":
        sys.exit(cmd_install())
    elif args.command == "uninstall":
        sys.exit(cmd_uninstall())
    elif args.command == "status":
        cmd_status()
    elif args.command == "projects":
        cmd_projects()
    elif args.command == "show":
        cmd_show(args.project)
    elif args.command == "log":
        cmd_log(args.project, args.branch)
    elif args.command == "search":
        cmd_search(args.query, project=args.project)
    elif args.command == "merge":
        sys.exit(cmd_merge(args.project, args.branch))
    elif args.command == "queue":
        sys.exit(cmd_queue(purge=args.purge, history=args.history))
    elif args.command == "wipe":
        if args.action == "list":
            cmd_projects()
        else:
            sys.exit(cmd_wipe(confirm=args.confirm, project=args.project))
    elif args.command == "reindex":
        cmd_reindex()
    elif args.command == "stats":
        sys.exit(cmd_stats(project=args.project, fmt=args.format))
    elif args.command == "health":
        sys.exit(cmd_health(repair=args.repair))
    elif args.command == "merge-project":
        sys.exit(cmd_merge_project(args.source, args.target, confirm=args.confirm))
    elif args.command == "gc":
        sys.exit(cmd_gc(project=args.project, days=args.days, dry_run=args.dry_run, reindex=args.reindex))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
