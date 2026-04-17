from core.memory_capture import classify_capture_candidate, generate_capture_candidate


def test_capture_candidate_generation_from_task_outcome(tmp_path):
    candidate = generate_capture_candidate("Fixed a blocker in the sync flow", str(tmp_path / "repo-a"))
    assert candidate is not None
    assert candidate.scope == "project"
    assert candidate.text == "Fixed a blocker in the sync flow"


def test_capture_classification_conservative():
    assert classify_capture_candidate("I prefer dark mode", "/tmp/repo").decision == "user"
    assert classify_capture_candidate("Fixed a blocker", "/tmp/repo").decision == "project"
    assert classify_capture_candidate("", "/tmp/repo").decision == "reject"


def test_capture_candidate_defaults_to_project_on_ambiguity(tmp_path):
    candidate = generate_capture_candidate("Outcome: done", str(tmp_path / "repo-a"))
    assert candidate is not None
    assert candidate.scope == "project"
