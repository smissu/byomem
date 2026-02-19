import json

from core.parser import parse_new_turns


def _make_msg(uuid, msg_type, content, parent_uuid=None, timestamp="2026-02-19T10:00:00"):
    msg = {
        "type": msg_type,
        "uuid": uuid,
        "timestamp": timestamp,
        "message": {"content": content},
    }
    if parent_uuid:
        msg["parentUUID"] = parent_uuid
    return msg


def _write_jsonl(path, messages):
    path.write_text("\n".join(json.dumps(m) for m in messages))
    return path


def test_empty_transcript(tmp_path):
    f = tmp_path / "empty.jsonl"
    f.write_text("")
    assert parse_new_turns(f) == []


def test_whitespace_only(tmp_path):
    f = tmp_path / "ws.jsonl"
    f.write_text("   \n  \n ")
    assert parse_new_turns(f) == []


def test_single_turn(tmp_path):
    msgs = [
        _make_msg("u1", "user", "hello"),
        _make_msg("a1", "assistant", "hi there", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert len(turns) == 1
    assert turns[0]["id"] == "u1"
    assert turns[0]["user"] == "hello"
    assert turns[0]["assistant"] == "hi there"
    assert turns[0]["timestamp"] == "2026-02-19T10:00:00"


def test_multiple_turns(tmp_path):
    msgs = [
        _make_msg("u1", "user", "first question"),
        _make_msg("a1", "assistant", "first answer", parent_uuid="u1"),
        _make_msg("u2", "user", "second question", timestamp="2026-02-19T11:00:00"),
        _make_msg("a2", "assistant", "second answer", parent_uuid="u2"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert len(turns) == 2
    assert turns[0]["id"] == "u1"
    assert turns[1]["id"] == "u2"
    assert turns[1]["user"] == "second question"


def test_resume_from_since_id(tmp_path):
    msgs = [
        _make_msg("u1", "user", "old"),
        _make_msg("a1", "assistant", "old reply", parent_uuid="u1"),
        _make_msg("u2", "user", "new"),
        _make_msg("a2", "assistant", "new reply", parent_uuid="u2"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f, since_id="u1")
    assert len(turns) == 1
    assert turns[0]["id"] == "u2"


def test_since_id_not_found(tmp_path):
    msgs = [
        _make_msg("u1", "user", "hello"),
        _make_msg("a1", "assistant", "hi", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f, since_id="nonexistent")
    assert turns == []


def test_skip_non_user_messages(tmp_path):
    msgs = [
        _make_msg("s1", "system", "system prompt"),
        _make_msg("u1", "user", "hello"),
        _make_msg("a1", "assistant", "hi", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert len(turns) == 1
    assert turns[0]["id"] == "u1"


def test_string_content(tmp_path):
    msgs = [
        _make_msg("u1", "user", "plain string"),
        _make_msg("a1", "assistant", "plain reply", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert turns[0]["user"] == "plain string"
    assert turns[0]["assistant"] == "plain reply"


def test_list_content(tmp_path):
    user_content = [
        {"type": "text", "text": "part one"},
        {"type": "text", "text": "part two"},
    ]
    asst_content = [
        {"type": "text", "text": "reply one"},
        {"type": "image", "url": "http://x"},
        {"type": "text", "text": "reply two"},
    ]
    msgs = [
        _make_msg("u1", "user", user_content),
        _make_msg("a1", "assistant", asst_content, parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert turns[0]["user"] == "part one part two"
    assert turns[0]["assistant"] == "reply one reply two"


def test_empty_content(tmp_path):
    msgs = [
        _make_msg("u1", "user", ""),
        _make_msg("a1", "assistant", "", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert turns[0]["user"] == ""
    assert turns[0]["assistant"] == ""


def test_user_truncated_to_2000(tmp_path):
    long_text = "x" * 5000
    msgs = [
        _make_msg("u1", "user", long_text),
        _make_msg("a1", "assistant", "short", parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert len(turns[0]["user"]) == 2000


def test_assistant_truncated_to_3000(tmp_path):
    long_text = "y" * 5000
    msgs = [
        _make_msg("u1", "user", "short"),
        _make_msg("a1", "assistant", long_text, parent_uuid="u1"),
    ]
    f = _write_jsonl(tmp_path / "t.jsonl", msgs)
    turns = parse_new_turns(f)
    assert len(turns[0]["assistant"]) == 3000
