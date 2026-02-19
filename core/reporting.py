"""Reporting and health-check functions shared by CLI and MCP server."""
import re

from core.config import get_config


def compute_project_stats(project: str) -> dict:
    """Compute statistics for a single project.

    Returns dict with: branches_total, branches_active, branches_merged,
    type_distribution, newest_branch, oldest_branch, disk_usage_bytes.
    """
    cfg = get_config()
    proj_dir = cfg.byomem / project
    branches_dir = proj_dir / "branches"

    stats = {
        "project": project,
        "branches_total": 0,
        "branches_active": 0,
        "branches_merged": 0,
        "type_distribution": {},
        "newest_branch": None,
        "oldest_branch": None,
        "disk_usage_bytes": 0,
        "has_main": (proj_dir / "main.md").exists(),
    }

    if not branches_dir.exists():
        return stats

    branches = [d for d in branches_dir.iterdir() if d.is_dir()]
    stats["branches_total"] = len(branches)

    for d in sorted(branches):
        # Read metadata
        meta = d / "metadata.md"
        branch_status = ""
        branch_type = ""
        if meta.exists():
            for line in meta.read_text().splitlines():
                sm = re.match(r"^status:\s*(.*)", line)
                if sm:
                    branch_status = sm.group(1).strip()
                tm = re.match(r"^type:\s*(.*)", line)
                if tm:
                    branch_type = tm.group(1).strip()

        if branch_status == "active":
            stats["branches_active"] += 1
        elif branch_status == "merged":
            stats["branches_merged"] += 1

        if branch_type:
            stats["type_distribution"][branch_type] = stats["type_distribution"].get(branch_type, 0) + 1

        # Size
        stats["disk_usage_bytes"] += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())

    # Newest/oldest by name (sorted alphabetically = chronologically for YYYY-MM-DD)
    names = sorted(d.name for d in branches)
    if names:
        stats["oldest_branch"] = names[0]
        stats["newest_branch"] = names[-1]

    # Add main.md size
    main_path = proj_dir / "main.md"
    if main_path.exists():
        stats["disk_usage_bytes"] += main_path.stat().st_size

    return stats


def compute_global_stats() -> dict:
    """Compute stats across all projects.

    Returns dict with: total_projects, total_branches, projects (list of project stats),
    search_index (files_count, chunks_count, db_size_bytes).
    """
    cfg = get_config()

    # Find all projects
    projects = sorted(
        d.name for d in cfg.byomem.iterdir()
        if d.is_dir() and not d.name.startswith(".")
        and ((d / "branches").exists() or (d / "main.md").exists())
    ) if cfg.byomem.exists() else []

    project_stats = [compute_project_stats(p) for p in projects]

    total_branches = sum(ps["branches_total"] for ps in project_stats)
    total_disk = sum(ps["disk_usage_bytes"] for ps in project_stats)

    # Search index stats
    index_stats = {"files_count": 0, "chunks_count": 0, "db_size_bytes": 0}
    if cfg.db_path.exists():
        index_stats["db_size_bytes"] = cfg.db_path.stat().st_size
        try:
            from core.search_index import get_db
            db = get_db()
            index_stats["files_count"] = db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
            index_stats["chunks_count"] = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        except Exception:
            pass

    return {
        "total_projects": len(projects),
        "total_branches": total_branches,
        "total_disk_bytes": total_disk,
        "projects": project_stats,
        "search_index": index_stats,
    }


def check_index_health() -> dict:
    """Check search index integrity.

    Returns dict with: orphaned_files (count), stale_files (count),
    missing_metadata (list of branch paths), issues (list of strings).
    """
    cfg = get_config()

    health = {
        "orphaned_files": 0,
        "stale_files": 0,
        "missing_metadata": [],
        "issues": [],
        "status": "healthy",
    }

    # Check for orphaned search index entries
    if cfg.db_path.exists():
        try:
            from core.search_index import get_db
            db = get_db()
            rows = db.execute("SELECT path FROM files").fetchall()
            for (file_path,) in rows:
                full_path = cfg.byomem / file_path
                if not full_path.exists():
                    health["orphaned_files"] += 1
        except Exception:
            health["issues"].append("Could not read search database")

    # Check for branches with missing metadata
    if cfg.byomem.exists():
        for proj_dir in cfg.byomem.iterdir():
            if not proj_dir.is_dir() or proj_dir.name.startswith("."):
                continue
            branches_dir = proj_dir / "branches"
            if not branches_dir.exists():
                continue
            for branch in branches_dir.iterdir():
                if not branch.is_dir():
                    continue
                meta = branch / "metadata.md"
                if not meta.exists():
                    health["missing_metadata"].append(str(branch.relative_to(cfg.byomem)))

    if health["orphaned_files"] > 0 or health["missing_metadata"]:
        health["status"] = "issues_found"

    return health
