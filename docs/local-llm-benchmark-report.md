# Local LLM Benchmark Report for byomem

## Purpose and scope

This report documents a local-only benchmark of Ollama models for byomem’s two remaining local-model paths:

- **Summarization** (`core/summarizer.py`)
- **Descripterizer / code-description** (`core/descripterizer.py`)

The goal was to compare the current recommended baseline, `qwen3:8b`, against newly pulled local candidates and decide whether any should replace it for primary use.

## Models tested

- `qwen3:8b` — current baseline
- `qwen3.5:4b`
- `qwen3.5:9b`

Notes:
- Both `qwen3.5` models were pulled successfully with exact names.
- Models were run sequentially and explicitly stopped between runs to avoid memory pressure.

## Benchmark method

- **Local-only**: direct calls to Ollama on `http://localhost:11434`
- **Summarization**: used the real byomem turn-summarization prompt/schema shape from `core/summarizer.py`
- **Descripterizer**: used the real byomem code-chunk description prompt/schema shape from `core/descripterizer.py`
- **Inputs**: small but realistic transcript-style and code-chunk-style examples mirroring byomem usage
- **Execution**: one model at a time; each model was stopped before the next was tested
- **Metric reported**: average latency across the benchmark runs for each model/path, plus structured-output usability and concise quality notes

## Summarization results

| Model | Avg latency | Structured output usable? | Notes |
|---|---:|---|---|
| `qwen3:8b` | 2.51s | Yes | Best overall balance: fast, concise, and accurate. |
| `qwen3.5:4b` | 3.63s | Yes | Acceptable, but more generic and less precise than `qwen3:8b`. |
| `qwen3.5:9b` | 4.51s | Yes | Usable, but slightly verbose and slower than the baseline. |

## Descripterizer results

| Model | Avg latency | Structured output usable? | Notes |
|---|---:|---|---|
| `qwen3:8b` | 2.49s | Yes | Best overall: concise, code-aware, and aligned with byomem’s code-description task. |
| `qwen3.5:4b` | 2.39s | Yes | Fastest of the tested set, but more generic and less code-specific. |
| `qwen3.5:9b` | 4.49s | Yes | Strong descriptions, but wordier than ideal and significantly slower. |

## Recommendation summary

### Keep `qwen3:8b` as primary

`qwen3:8b` remains the best primary local model for both summarization and descripterizer tasks. It delivered the best balance of speed, structured output reliability, and task-specific quality.

### `qwen3.5:4b` is acceptable as a lightweight option

`qwen3.5:4b` is a practical lightweight fallback if lower resource use matters more than quality. It is usable, but its outputs are more generic and less precise/code-specific than `qwen3:8b`.

### `qwen3.5:9b` does not justify replacing `qwen3:8b`

`qwen3.5:9b` produced usable output, but it was slower and more verbose than the baseline without a clear quality gain.

## Sequential execution and stopping

The benchmark was run sequentially, with each model explicitly stopped before moving to the next. This was done to minimize memory usage and keep the local Ollama host stable during testing.

## Bottom line

For byomem’s current local-model paths:

- **Primary**: `qwen3:8b`
- **Lightweight fallback**: `qwen3.5:4b` if needed
- **Not recommended as replacement**: `qwen3.5:9b`
