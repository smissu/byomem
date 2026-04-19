"""Tests for core/indexing_utils.py.

Covers:
  - _get_embedding(): single-text cache hit, cache miss (API call), API failure
  - _get_embeddings_batch(): batch fetching with cache, multiple API batches,
    API failure graceful degradation, and correct result ordering

AC references:
  AC-1: 20 chunks with batch_size=10 makes exactly 2 API calls
  AC-2: 20 chunks where 15 are cached makes 1 API call (for the 5 uncached)
  AC-3: API failure returns None for failed chunks without crashing
  AC-4: Returned embeddings match cache-hit + freshly-fetched in correct order

Note: these tests exercise batch embedding behavior in core/indexing_utils.py.
"""

import hashlib
import sqlite3
import struct

import pytest

# ============================================================
# Helpers
# ============================================================


def _make_db_with_cache(tmp_path):
    """Create an in-memory-style SQLite DB with the embedding_cache table.

    Returns a connection with the embedding_cache table ready to use.
    We use a file-backed DB under tmp_path so sqlite_vec can load if available.
    """
    db_path = tmp_path / "test_embed.db"
    db = sqlite3.connect(str(db_path))
    db.execute("""
        CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
        )
    """)
    db.commit()
    return db


def _pack_embedding(floats):
    """Serialize a list of floats to the same binary format used by sqlite_vec."""
    return struct.pack(f"{len(floats)}f", *floats)


def _insert_cached(db, text_hash, embedding):
    """Insert a pre-computed embedding blob directly into embedding_cache."""
    blob = _pack_embedding(embedding)
    db.execute(
        "INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)",
        (text_hash, blob),
    )
    db.commit()


def _text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _make_batch_mock(mocker, n_per_call=None):
    """Build a mock for openai.OpenAI that handles batch embedding calls.

    When embeddings.create is called with input=list_of_N_texts, the response
    data has N elements, each with embedding=[float_index / 1000.0] * 1536
    where float_index is the position within the batch.

    n_per_call: if provided, a list of expected batch sizes (for strict checking).
    Returns the mock so tests can inspect call_count.
    """
    call_tracker = {"call_count": 0}

    def fake_create(model, input):
        count = len(input) if isinstance(input, list) else 1
        call_tracker["call_count"] += 1
        mock_data = []
        for i in range(count):
            # Each embedding is unique: uses (call_number * 1000 + position) as value
            val = (call_tracker["call_count"] * 1000 + i) / 100000.0
            item = mocker.Mock()
            item.embedding = [val] * 1536
            mock_data.append(item)
        result = mocker.Mock()
        result.data = mock_data
        return result

    mock_client = mocker.Mock()
    mock_client.embeddings.create.side_effect = fake_create

    mock_openai_cls = mocker.patch("core.indexing_utils.openai.OpenAI")
    mock_openai_cls.return_value = mock_client

    return mock_openai_cls, call_tracker


# ============================================================
# Tests for _get_embedding (existing single-text function)
# ============================================================


class TestGetEmbedding:
    """Tests for the existing _get_embedding() single-text function."""

    def test_cache_hit_returns_without_api_call(self, tmp_path, tmp_byomem, mocker):
        """Cache hit: returns cached embedding, makes no API call."""
        from core.indexing_utils import _get_embedding

        db = _make_db_with_cache(tmp_path)
        text = "hello world"
        h = _text_hash(text)
        expected = [0.1] * 1536
        _insert_cached(db, h, expected)

        mock_openai = mocker.patch("core.indexing_utils.openai.OpenAI")

        result = _get_embedding(db, text, h)

        assert result is not None
        assert len(result) == 1536
        assert abs(result[0] - 0.1) < 1e-5
        mock_openai.assert_not_called()

    def test_cache_miss_calls_api_and_returns_embedding(self, tmp_path, tmp_byomem, mock_openai_embed):
        """Cache miss: calls API, returns the fetched embedding."""
        from core.indexing_utils import _get_embedding

        db = _make_db_with_cache(tmp_path)
        text = "new uncached text"
        h = _text_hash(text)

        # Verify no cache entry exists
        row = db.execute(
            "SELECT embedding FROM embedding_cache WHERE text_hash=?", (h,)
        ).fetchone()
        assert row is None

        result = _get_embedding(db, text, h)

        # mock_openai_embed returns [0.0] * 1536
        assert result is not None
        assert len(result) == 1536

    def test_api_failure_returns_none(self, tmp_path, tmp_byomem, mocker):
        """API failure (any exception): returns None without raising."""
        from core.indexing_utils import _get_embedding

        db = _make_db_with_cache(tmp_path)
        text = "some text"
        h = _text_hash(text)

        mocker.patch(
            "core.indexing_utils.openai.OpenAI",
            side_effect=RuntimeError("API unavailable"),
        )

        result = _get_embedding(db, text, h)
        assert result is None

    def test_embedding_timeout_passed_to_openai_client(self, tmp_path, tmp_byomem, mocker):
        from core.config import get_config
        from core.indexing_utils import _get_embedding

        db = _make_db_with_cache(tmp_path)
        get_config().embedding_request_timeout = 7
        text = "timeout test"
        h = _text_hash(text)

        mock_client = mocker.Mock()
        mock_client.embeddings.create.return_value = mocker.Mock(
            data=[mocker.Mock(embedding=[0.0] * 1536)]
        )
        openai_cls = mocker.patch("core.indexing_utils.openai.OpenAI", return_value=mock_client)

        result = _get_embedding(db, text, h)

        assert result is not None
        openai_cls.assert_called_once_with(timeout=7)

    def test_embedding_explicit_timeout_overrides_config(self, tmp_path, tmp_byomem, mocker):
        from core.config import get_config
        from core.indexing_utils import _get_embedding

        db = _make_db_with_cache(tmp_path)
        db.close()
        db = sqlite3.connect(str(tmp_path / "test_embed.db"), check_same_thread=False)
        db.execute("""
            CREATE TABLE IF NOT EXISTS embedding_cache (
                text_hash TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        db.commit()
        get_config().embedding_request_timeout = 7
        text = "explicit timeout test"
        h = _text_hash(text)

        mock_client = mocker.Mock()
        mock_client.embeddings.create.return_value = mocker.Mock(
            data=[mocker.Mock(embedding=[0.0] * 1536)]
        )
        openai_cls = mocker.patch("core.indexing_utils.openai.OpenAI", return_value=mock_client)

        result = _get_embedding(db, text, h, timeout=3)

        assert result is not None
        openai_cls.assert_called_once_with(timeout=3)


# ============================================================
# Tests for _get_embeddings_batch (new batch function — RED state)
# ============================================================


class TestGetEmbeddingsBatch:
    """Tests for the new _get_embeddings_batch() function.

    These tests cover the batch helper used by core/indexing_utils.py.
    """

    def _import_batch(self):
        """Import _get_embeddings_batch, surfacing a clear error if absent."""
        from core.indexing_utils import _get_embeddings_batch  # noqa: F401

        return _get_embeddings_batch

    # ------------------------------------------------------------------
    # AC-1: 20 chunks with batch_size=10 makes exactly 2 API calls
    # ------------------------------------------------------------------

    def test_ac1_twenty_uncached_two_api_calls(self, tmp_path, tmp_byomem, mocker):
        """AC-1: 20 completely uncached texts with batch_size=10 → exactly 2 API calls."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        texts = [f"unique text number {i}" for i in range(20)]
        hashes = [_text_hash(t) for t in texts]

        _, call_tracker = _make_batch_mock(mocker)

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert call_tracker["call_count"] == 2, (
            f"Expected exactly 2 API calls for 20 uncached texts with batch_size=10, "
            f"got {call_tracker['call_count']}"
        )
        assert len(results) == 20

    def test_ac1_exact_batch_boundary(self, tmp_path, tmp_byomem, mocker):
        """AC-1 variant: batch_size=5 with 10 texts → exactly 2 API calls."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)
        texts = [f"text {i}" for i in range(10)]
        hashes = [_text_hash(t) for t in texts]

        _, call_tracker = _make_batch_mock(mocker)

        _get_embeddings_batch(db, texts, hashes, batch_size=5)

        assert call_tracker["call_count"] == 2

    def test_ac1_non_divisible_batch(self, tmp_path, tmp_byomem, mocker):
        """AC-1 variant: 15 uncached texts with batch_size=10 → exactly 2 API calls (10+5)."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)
        texts = [f"text item {i}" for i in range(15)]
        hashes = [_text_hash(t) for t in texts]

        _, call_tracker = _make_batch_mock(mocker)

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert call_tracker["call_count"] == 2
        assert len(results) == 15

    # ------------------------------------------------------------------
    # AC-2: 20 chunks where 15 are cached → 1 API call (for 5 uncached)
    # ------------------------------------------------------------------

    def test_ac2_mostly_cached_one_api_call(self, tmp_path, tmp_byomem, mocker):
        """AC-2: 20 texts with 15 cached → 1 API call for the 5 uncached."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        texts = [f"text chunk {i}" for i in range(20)]
        hashes = [_text_hash(t) for t in texts]

        # Pre-populate cache for the first 15 texts
        cached_embedding = [0.5] * 1536
        for i in range(15):
            _insert_cached(db, hashes[i], cached_embedding)

        _, call_tracker = _make_batch_mock(mocker)

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        # Only 5 uncached → 1 API call (fits in one batch of 10)
        assert call_tracker["call_count"] == 1, (
            f"Expected exactly 1 API call for 5 uncached texts, "
            f"got {call_tracker['call_count']}"
        )
        assert len(results) == 20

    def test_ac2_all_cached_zero_api_calls(self, tmp_path, tmp_byomem, mocker):
        """AC-2 variant: all texts cached → 0 API calls."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        texts = [f"cached text {i}" for i in range(10)]
        hashes = [_text_hash(t) for t in texts]

        for h in hashes:
            _insert_cached(db, h, [0.3] * 1536)

        mock_openai_cls, call_tracker = _make_batch_mock(mocker)

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert call_tracker["call_count"] == 0
        assert len(results) == 10

    def test_ac2_no_cached_uses_batches(self, tmp_path, tmp_byomem, mocker):
        """AC-2 variant: 20 uncached with batch_size=20 → exactly 1 API call."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)
        texts = [f"item {i}" for i in range(20)]
        hashes = [_text_hash(t) for t in texts]

        _, call_tracker = _make_batch_mock(mocker)

        _get_embeddings_batch(db, texts, hashes, batch_size=20)

        assert call_tracker["call_count"] == 1

    # ------------------------------------------------------------------
    # AC-3: API failure returns None for failed chunks without crashing
    # ------------------------------------------------------------------

    def test_ac3_api_failure_returns_none_no_crash(self, tmp_path, tmp_byomem, mocker):
        """AC-3: API raises an exception → failed chunks get None, no exception raised."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)
        texts = ["text alpha", "text beta", "text gamma"]
        hashes = [_text_hash(t) for t in texts]

        mocker.patch(
            "core.indexing_utils.openai.OpenAI",
            side_effect=RuntimeError("API unavailable"),
        )

        # Should not raise
        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert len(results) == 3
        embeddings = [emb for emb, _ in results]
        # All should be None on total failure
        assert all(e is None for e in embeddings)

    def test_ac3_partial_failure_mixed_none_and_values(self, tmp_path, tmp_byomem, mocker):
        """AC-3 variant: first batch succeeds, second batch fails → None for second batch only."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        # 6 texts, batch_size=3 → 2 batches
        texts = [f"text {i}" for i in range(6)]
        hashes = [_text_hash(t) for t in texts]

        call_count = {"n": 0}

        def side_effect_partial(model, input):
            call_count["n"] += 1
            if call_count["n"] == 1:
                # First batch succeeds
                items = []
                for i in range(len(input)):
                    m = mocker.Mock()
                    m.embedding = [0.7] * 1536
                    items.append(m)
                resp = mocker.Mock()
                resp.data = items
                return resp
            else:
                raise RuntimeError("Second batch API failure")

        mock_client = mocker.Mock()
        mock_client.embeddings.create.side_effect = side_effect_partial
        mocker.patch("core.indexing_utils.openai.OpenAI").return_value = mock_client

        results = _get_embeddings_batch(db, texts, hashes, batch_size=3)

        assert len(results) == 6
        # First 3 (batch 1) should have embeddings
        for emb, _ in results[:3]:
            assert emb is not None
            assert len(emb) == 1536
        # Last 3 (batch 2) should be None
        for emb, _ in results[3:]:
            assert emb is None

    def test_ac3_empty_input_does_not_crash(self, tmp_path, tmp_byomem, mocker):
        """AC-3 variant: empty text list returns empty list without error."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        mocker.patch("core.indexing_utils.openai.OpenAI")

        results = _get_embeddings_batch(db, [], [], batch_size=10)
        assert results == []

    def test_batch_timeout_passed_to_openai_client(self, tmp_path, tmp_byomem, mocker):
        from core.config import get_config
        from core.indexing_utils import _get_embeddings_batch

        db = _make_db_with_cache(tmp_path)
        cfg = get_config()
        cfg.embedding_base_url = "http://localhost:11434/v1"
        cfg.embedding_request_timeout = 7
        texts = ["a", "b"]
        hashes = [_text_hash(t) for t in texts]

        mock_client = mocker.Mock()
        mock_client.embeddings.create.return_value = mocker.Mock(
            data=[mocker.Mock(embedding=[0.0] * 1536) for _ in texts]
        )
        openai_cls = mocker.patch("core.indexing_utils.openai.OpenAI", return_value=mock_client)

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert len(results) == 2
        openai_cls.assert_called_once_with(base_url="http://localhost:11434/v1", api_key="ollama", timeout=7)

    # ------------------------------------------------------------------
    # AC-4: Returned embeddings match cache-hit + freshly-fetched in correct order
    # ------------------------------------------------------------------

    def test_ac4_ordering_preserved_mixed_cache(self, tmp_path, tmp_byomem, mocker):
        """AC-4: Result list preserves original input order with mixed cached/uncached."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        # 6 texts; positions 1, 3, 5 (0-indexed) are cached
        texts = [f"text pos {i}" for i in range(6)]
        hashes = [_text_hash(t) for t in texts]

        cached_value = 0.999
        for i in [1, 3, 5]:
            _insert_cached(db, hashes[i], [cached_value] * 1536)

        # API returns a distinct value for fresh embeddings
        fresh_value = 0.111

        def fake_create(model, input):
            items = []
            for _ in input:
                m = mocker.Mock()
                m.embedding = [fresh_value] * 1536
                items.append(m)
            resp = mocker.Mock()
            resp.data = items
            return resp

        mock_client = mocker.Mock()
        mock_client.embeddings.create.side_effect = fake_create
        mocker.patch("core.indexing_utils.openai.OpenAI").return_value = mock_client

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        assert len(results) == 6

        for i, (emb, is_new) in enumerate(results):
            assert emb is not None, f"Position {i} should have a non-None embedding"
            assert len(emb) == 1536, f"Position {i} embedding wrong length"
            if i in (1, 3, 5):
                # From cache
                assert abs(emb[0] - cached_value) < 1e-4, (
                    f"Position {i} (cached): expected ~{cached_value}, got {emb[0]}"
                )
                assert is_new is False, f"Position {i} (cached) should have is_new=False"
            else:
                # Freshly fetched
                assert abs(emb[0] - fresh_value) < 1e-4, (
                    f"Position {i} (fresh): expected ~{fresh_value}, got {emb[0]}"
                )
                assert is_new is True, f"Position {i} (fresh) should have is_new=True"

    def test_ac4_is_new_flag_false_for_cache_hits(self, tmp_path, tmp_byomem, mocker):
        """AC-4 variant: is_new=False for all cache hits, True for API calls."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        texts = ["cached one", "fresh one", "cached two"]
        hashes = [_text_hash(t) for t in texts]

        # Cache texts at index 0 and 2
        _insert_cached(db, hashes[0], [0.1] * 1536)
        _insert_cached(db, hashes[2], [0.2] * 1536)

        def fake_create(model, input):
            items = [mocker.Mock(embedding=[0.9] * 1536) for _ in input]
            resp = mocker.Mock()
            resp.data = items
            return resp

        mock_client = mocker.Mock()
        mock_client.embeddings.create.side_effect = fake_create
        mocker.patch("core.indexing_utils.openai.OpenAI").return_value = mock_client

        results = _get_embeddings_batch(db, texts, hashes, batch_size=10)

        _, is_new_0 = results[0]
        _, is_new_1 = results[1]
        _, is_new_2 = results[2]

        assert is_new_0 is False, "Index 0 was cached; is_new should be False"
        assert is_new_1 is True, "Index 1 was uncached; is_new should be True"
        assert is_new_2 is False, "Index 2 was cached; is_new should be False"

    def test_ac4_single_text_cached_returns_tuple(self, tmp_path, tmp_byomem, mocker):
        """AC-4 variant: single cached text returns [(embedding, False)] list."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)
        text = "single cached"
        h = _text_hash(text)
        _insert_cached(db, h, [0.42] * 1536)

        mocker.patch("core.indexing_utils.openai.OpenAI")

        results = _get_embeddings_batch(db, [text], [h], batch_size=10)

        assert len(results) == 1
        emb, is_new = results[0]
        assert emb is not None
        assert abs(emb[0] - 0.42) < 1e-4
        assert is_new is False

    def test_ac4_result_length_matches_input(self, tmp_path, tmp_byomem, mocker):
        """AC-4 variant: result list length always equals input list length."""
        _get_embeddings_batch = self._import_batch()

        db = _make_db_with_cache(tmp_path)

        for count in [1, 5, 13, 20]:
            texts = [f"text_{count}_{i}" for i in range(count)]
            hashes = [_text_hash(t) for t in texts]

            _, call_tracker = _make_batch_mock(mocker)

            results = _get_embeddings_batch(db, texts, hashes, batch_size=7)
            assert len(results) == count, (
                f"For {count} inputs, expected {count} results, got {len(results)}"
            )
