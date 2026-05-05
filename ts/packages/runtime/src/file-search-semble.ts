/// <reference path="./chonkie-shims.d.ts" />
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, join } from 'node:path';
import { CodeChunker } from '@chonkiejs/core';

export type FileSearchIndexStorageMode = 'disk' | 'memory';
export type FileSearchSearchMode = 'bm25' | 'semantic' | 'hybrid';

export interface FileSearchChunk {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language?: string;
  source?: FileSearchChunkerSource;
  fallbackReason?: FileSearchChunkerFallbackReason;
}

export interface FileSearchChunkRow extends FileSearchChunk {
  projectKey: string;
  chunkIndex: number;
  chunkHash: string;
  hasLineMetadata?: boolean;
  lexicalScore?: number;
  semanticScore?: number;
  score?: number;
}

export interface FileSearchSearchResult {
  chunk: FileSearchChunk;
  score: number;
  source: FileSearchSearchMode;
  id?: string;
  scope?: 'project';
  identity?: {
    namespace: string;
    leafName: string;
    parentContext?: string;
  };
  provenance?: {
    source: string;
    origin?: string;
  };
  content?: {
    text?: string;
  };
  metadata?: {
    createdAt: string;
    updatedAt: string;
  };
  file?: {
    projectKey: string;
    path: string;
    chunkIndex?: number;
    chunkText?: string;
    chunkHash?: string;
    startLine?: number;
    endLine?: number;
    lexicalScore?: number;
    semanticScore?: number;
  };
}

interface ChunkBoundary {
  startLine: number;
  endLine: number;
}

export type FileSearchChunkerSource = 'chonkie' | 'line-fallback';
export type FileSearchChunkerFallbackReason = 'not-ready' | 'unsupported-language' | 'missing-wasm' | 'chunker-error' | null;

export interface FileSearchChunkerDiagnostics {
  source: FileSearchChunkerSource;
  fallbackReason: FileSearchChunkerFallbackReason;
  ready: boolean;
  waitedForReadiness: boolean;
  language?: string;
}

export interface FileSearchChunkingResult {
  chunks: FileSearchChunk[];
  chunker: FileSearchChunkerDiagnostics;
}

const DEFAULT_CODE_CHUNK_LINES = 50;
const DEFAULT_CODE_CHUNK_OVERLAP = 5;
const DEFAULT_CHONKIE_CODE_CHUNK_SIZE = 2048;
const DEFAULT_CHONKIE_CODE_CHUNK_OVERLAP = 0;
const DEFAULT_LINE_CHUNK_LINES = 50;
const DEFAULT_LINE_CHUNK_OVERLAP = 5;
const BOUNDARY_LOOKBACK_LINES = 12;
const RRF_K = 60;
const FILE_SATURATION_THRESHOLD = 1;
const FILE_SATURATION_DECAY = 0.5;
const FILE_COHERENCE_BOOST_FRAC = 0.2;
const EMBEDDED_SYMBOL_BOOST_SCALE = 0.5;
const DEFINITION_BOOST_MULTIPLIER = 3.0;
const STEM_BOOST_MULTIPLIER = 1.0;
const STOPWORDS = new Set(
  'a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with'.split(' '),
);

const SYMBOL_QUERY_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\\|->|\.)[A-Za-z_][A-Za-z0-9_]*)+|_[A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*|[A-Z][A-Za-z0-9]*)$/;
const EMBEDDED_SYMBOL_RE = /\b(?:[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+)\b/g;
const DEFINITION_KEYWORDS = [
  'class',
  'module',
  'defmodule',
  'def',
  'interface',
  'struct',
  'enum',
  'trait',
  'type',
  'func',
  'function',
  'object',
  'abstract class',
  'data class',
  'fn',
  'fun',
  'package',
  'namespace',
  'protocol',
  'record',
  'typedef',
];
const SQL_DEFINITION_KEYWORDS = [
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE PROCEDURE',
  'CREATE FUNCTION',
];
const REEXPORT_FILENAMES = new Set(['__init__.py', 'package-info.java']);

const TEST_FILE_RE = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go|[^/]*Tests?\.java|[^/]*Test\.php|[^/]*_spec\.rb|[^/]*_test\.rb|[^/]*\.test\.[jt]sx?|[^/]*\.spec\.[jt]sx?|[^/]*Tests?\.kt|[^/]*Spec\.kt|[^/]*Tests?\.swift|[^/]*Spec\.swift|[^/]*Tests?\.cs|test_[^/]*\.cpp|[^/]*_test\.cpp|test_[^/]*\.c|[^/]*_test\.c|[^/]*Spec\.scala|[^/]*Suite\.scala|[^/]*Test\.scala|[^/]*_test\.dart|test_[^/]*\.dart|[^/]*_spec\.lua|[^/]*_test\.lua|test_[^/]*\.lua|test_helpers?[^/]*\.\w+)$/;
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec|testing)(?:\/|$)/;
const COMPAT_DIR_RE = /(?:^|\/)(?:compat|_compat|legacy)(?:\/|$)/;
const EXAMPLES_DIR_RE = /(?:^|\/)(?:_?examples?|docs?_src)(?:\/|$)/;
const DOCS_DIR_RE = /(?:^|\/)(?:docs?|documentation)(?:\/|$)/;
const TYPE_DEFS_RE = /\.d\.ts$/;
const NON_CODE_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.log', '.ini']);
const requireFromRuntime = createRequire(import.meta.url);

const CODE_LANGUAGE_EXTENSIONS = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.swift', 'swift'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.cs', 'csharp'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
  ['.h', 'c'],
  ['.c', 'c'],
  ['.scala', 'scala'],
  ['.sql', 'sql'],
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.ps1', 'powershell'],
  ['.lua', 'lua'],
]);

const CHONKIE_WASM_LANGUAGE_IDS = new Map<string, string>([
  ['typescript', 'typescript'],
  ['tsx', 'tsx'],
  ['javascript', 'javascript'],
  ['python', 'python'],
  ['go', 'go'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['ruby', 'ruby'],
  ['php', 'php'],
  ['csharp', 'c_sharp'],
  ['cpp', 'cpp'],
  ['c', 'c'],
  ['scala', 'scala'],
  ['sql', 'ql'],
  ['bash', 'bash'],
  ['lua', 'lua'],
  ['dart', 'dart'],
]);

type ChonkieChunk = {
  text: string;
  startIndex: number;
  endIndex: number;
};

type CodeChunkerInstance = Awaited<ReturnType<typeof CodeChunker.create>>;
type ChunkerReadinessState = 'pending' | 'ready';
type FileSearchChunkingKind = 'supported-code' | 'plain-text' | 'unsupported-language';

const chonkieCodeChunkers = new Map<string, CodeChunkerInstance>();
const chonkieChunkerAvailability = new Map<string, { wasmAvailable: boolean; initError?: string }>();
let chonkieChunkersState: ChunkerReadinessState = 'pending';

function resolveChonkieWasmPath(wasmId: string): string | undefined {
  const modulePath = `tree-sitter-wasms/out/tree-sitter-${wasmId}.wasm`;
  try {
    return requireFromRuntime.resolve(modulePath);
  } catch {
    const cwdPath = join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${wasmId}.wasm`);
    return existsSync(cwdPath) ? cwdPath : undefined;
  }
}

export const chonkieCodeChunkersReady = (async () => {
  for (const [language, wasmId] of CHONKIE_WASM_LANGUAGE_IDS.entries()) {
    const wasmPath = resolveChonkieWasmPath(wasmId);
    if (!wasmPath) {
      chonkieChunkerAvailability.set(language, { wasmAvailable: false });
      continue;
    }
    try {
      const chunker = await CodeChunker.create({
        language: wasmPath,
        tokenizer: 'character',
        chunkSize: DEFAULT_CHONKIE_CODE_CHUNK_SIZE,
      });
      chonkieCodeChunkers.set(language, chunker);
      chonkieChunkerAvailability.set(language, { wasmAvailable: true });
    } catch (error) {
      chonkieChunkerAvailability.set(language, {
        wasmAvailable: true,
        initError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  chonkieChunkersState = 'ready';
})();

function classifyFileSearchChunkingTarget(filePath: string): { kind: FileSearchChunkingKind; language?: string } {
  const language = inferFileSearchLanguage(filePath);
  if (language) {
    if (!isCodeAwareLanguage(language)) return { kind: 'plain-text', language };
    if (!CHONKIE_WASM_LANGUAGE_IDS.has(language)) return { kind: 'unsupported-language', language };
    return { kind: 'supported-code', language };
  }
  const extension = extname(filePath).toLowerCase();
  if (!extension || NON_CODE_TEXT_EXTENSIONS.has(extension)) return { kind: 'plain-text' };
  return { kind: 'unsupported-language' };
}

function withChunkerMetadata(chunks: FileSearchChunk[], diagnostics: FileSearchChunkerDiagnostics): FileSearchChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    source: diagnostics.source,
    fallbackReason: diagnostics.fallbackReason,
  }));
}

function buildChunkingResult(chunks: FileSearchChunk[], chunker: FileSearchChunkerDiagnostics): FileSearchChunkingResult {
  return {
    chunks: withChunkerMetadata(chunks, chunker),
    chunker,
  };
}

function fallbackDiagnostics(language: string | undefined, fallbackReason: Exclude<FileSearchChunkerFallbackReason, null>, waitedForReadiness: boolean): FileSearchChunkerDiagnostics {
  return {
    source: 'line-fallback',
    fallbackReason,
    ready: false,
    waitedForReadiness,
    ...(language ? { language } : {}),
  };
}

function plainTextDiagnostics(language?: string): FileSearchChunkerDiagnostics {
  return {
    source: 'line-fallback',
    fallbackReason: null,
    ready: false,
    waitedForReadiness: false,
    ...(language ? { language } : {}),
  };
}

function resolveUnavailableChunkerDiagnostics(language: string, waitedForReadiness: boolean): FileSearchChunkerDiagnostics {
  const availability = chonkieChunkerAvailability.get(language);
  if (availability?.wasmAvailable === false) return fallbackDiagnostics(language, 'missing-wasm', waitedForReadiness);
  if (availability?.initError) return fallbackDiagnostics(language, 'chunker-error', waitedForReadiness);
  if (chonkieChunkersState !== 'ready') return fallbackDiagnostics(language, 'not-ready', waitedForReadiness);
  return fallbackDiagnostics(language, 'chunker-error', waitedForReadiness);
}

export function shouldWaitForFileSearchChunker(filePath: string): boolean {
  return classifyFileSearchChunkingTarget(filePath).kind === 'supported-code';
}

export async function ensureFileSearchCodeChunkersReady(): Promise<{ ready: true; languages: string[] }> {
  await chonkieCodeChunkersReady;
  return { ready: true, languages: [...chonkieCodeChunkers.keys()] };
}


function normalizePathForComparison(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function splitIdentifier(token: string): string[] {
  const lower = token.toLowerCase();
  if (token.includes('_')) {
    const parts = lower.split('_').filter(Boolean);
    return parts.length >= 2 ? [lower, ...parts] : [lower];
  }
  const parts = token.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g)?.map((part) => part.toLowerCase()) ?? [];
  return parts.length >= 2 ? [lower, ...parts] : [lower];
}

function isCodeAwareLanguage(language: string | undefined): boolean {
  return Boolean(language && !['text', 'markdown', 'json', 'yaml', 'toml'].includes(language));
}

export function inferFileSearchLanguage(filePath: string): string | undefined {
  const extension = extname(filePath).toLowerCase();
  return CODE_LANGUAGE_EXTENSIONS.get(extension);
}

export function tokenizeSearchQuery(query: string): string[] {
  const rawTokens = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const tokens: string[] = [];
  for (const token of rawTokens) tokens.push(...splitIdentifier(token));
  return tokens.filter(Boolean);
}

export function isSymbolQuery(query: string): boolean {
  return SYMBOL_QUERY_RE.test(query.trim());
}

function extractSymbolName(query: string): string {
  let result = query.trim();
  for (const separator of ['::', '\\', '->', '.']) {
    if (result.includes(separator)) result = result.slice(result.lastIndexOf(separator) + separator.length);
  }
  return result.trim();
}

function stemMatches(stem: string, name: string): boolean {
  const stemNorm = stem.replace(/_/g, '');
  return stem === name || stemNorm === name || stem.replace(/s$/g, '') === name || stemNorm.replace(/s$/g, '') === name;
}

function naturalLanguageTokens(query: string): string[] {
  const embeddedSymbols = new Set(query.match(EMBEDDED_SYMBOL_RE) ?? []);
  return (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    .filter((token) => token.length > 1 && !STOPWORDS.has(token.toLowerCase()) && !embeddedSymbols.has(token))
    .flatMap((token) => splitIdentifier(token))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function filePathStemVariants(filePath: string): string[] {
  const normalized = normalizePathForComparison(filePath);
  const parts = normalized.split('/').filter(Boolean);
  const stem = basename(normalized).replace(/\.[^.]+$/, '').toLowerCase();
  const parent = parts.length > 1 ? parts[parts.length - 2]!.toLowerCase() : '';
  const variants = new Set<string>([
    stem,
    ...splitIdentifier(stem),
    parent,
    ...splitIdentifier(parent),
  ].filter(Boolean));
  return [...variants];
}

function countKeywordMatches(keywords: Set<string>, parts: Set<string>): number {
  const exact = [...keywords].filter((keyword) => parts.has(keyword)).length;
  if (exact === keywords.size) return exact;
  let matches = exact;
  for (const keyword of keywords) {
    if (parts.has(keyword)) continue;
    for (const part of parts) {
      const [shorter, longer] = keyword.length <= part.length ? [keyword, part] : [part, keyword];
      if (shorter.length >= 3 && longer.startsWith(shorter)) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

function hasBoundarySignal(line: string, language: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const lowered = trimmed.toLowerCase();
  if (language === 'python') return /^(class|def|async def|from |import )\b/.test(lowered);
  if (language === 'go') return /^(func|type|const|var|package)\b/.test(lowered);
  if (language === 'rust') return /^(pub\s+)?(fn|struct|enum|trait|mod|impl)\b/.test(lowered);
  if (language === 'java' || language === 'kotlin' || language === 'scala' || language === 'csharp') {
    return /^(?:public|private|protected|internal|abstract|final|sealed|static|async|export)?\s*(?:class|interface|enum|record|fun|def|object|package|namespace)\b/.test(lowered);
  }
  if (language === 'php') return /^(?:class|interface|trait|function|namespace|use)\b/.test(lowered);
  if (language === 'ruby') return /^(class|module|def)\b/.test(lowered);
  if (language === 'sql') return /^(create\s+(table|view|procedure|function)|alter\s+(table|view)|insert\s+into)\b/.test(lowered);
  return /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|module|namespace|object|fun|fn|import|from)\b/.test(lowered);
}

function trimChunkLines(lines: string[], startLine: number, endLine: number): ChunkBoundary | undefined {
  let start = startLine;
  let end = endLine;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return end > start ? { startLine: start + 1, endLine: end } : undefined;
}

function chunkLines(filePath: string, content: string, language?: string, maxLines = DEFAULT_LINE_CHUNK_LINES, overlapLines = DEFAULT_LINE_CHUNK_OVERLAP): FileSearchChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: FileSearchChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    if (language && end < lines.length) {
      for (let i = end - 1; i > Math.max(start + 1, end - BOUNDARY_LOOKBACK_LINES); i -= 1) {
        if (hasBoundarySignal(lines[i] ?? '', language)) {
          end = i + 1;
          break;
        }
      }
    }
    const range = trimChunkLines(lines, start, end);
    if (range) {
      chunks.push({
        filePath,
        content: lines.slice(start, end).join('\n').trim(),
        startLine: range.startLine,
        endLine: range.endLine,
        ...(language ? { language } : {}),
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function chunkPlainText(filePath: string, content: string, language?: string): FileSearchChunk[] {
  if (/\r?\n\s*\r?\n/.test(content)) return chunkLines(filePath, content, language);
  return chunkLines(filePath, content, language, 1, 0);
}

export function chunkFileContentLineFallback(
  filePath: string,
  content: string,
  language?: string,
  fallbackReason: FileSearchChunkerFallbackReason = null,
): FileSearchChunk[] {
  return withChunkerMetadata(chunkLines(filePath, content, language), {
    source: 'line-fallback',
    fallbackReason,
    ready: false,
    waitedForReadiness: false,
    ...(language ? { language } : {}),
  });
}

function chunkCodeAware(filePath: string, content: string, language: string, waitedForReadiness: boolean): FileSearchChunkingResult {
  const chunker = chonkieCodeChunkers.get(language);
  if (!chunker) return buildChunkingResult(chunkLines(filePath, content, language), resolveUnavailableChunkerDiagnostics(language, waitedForReadiness));
  try {
    const chunks = chunker.chunk(content) as ChonkieChunk[];
    if (!chunks.length) {
      return buildChunkingResult(chunkLines(filePath, content, language), {
        source: 'line-fallback',
        fallbackReason: null,
        ready: true,
        waitedForReadiness,
        language,
      });
    }
    return buildChunkingResult(chunks.map((chunk) => ({
      filePath,
      content: chunk.text,
      startLine: lineNumberAt(content, chunk.startIndex),
      endLine: lineNumberAt(content, chunk.endIndex),
      language,
    })), {
      source: 'chonkie',
      fallbackReason: null,
      ready: true,
      waitedForReadiness,
      language,
    });
  } catch {
    return buildChunkingResult(chunkLines(filePath, content, language), fallbackDiagnostics(language, 'chunker-error', waitedForReadiness));
  }
}

export function chunkFileContent(filePath: string, content: string): FileSearchChunk[] {
  const target = classifyFileSearchChunkingTarget(filePath);
  if (target.kind === 'plain-text') return withChunkerMetadata(chunkPlainText(filePath, content, target.language), plainTextDiagnostics(target.language));
  if (target.kind === 'unsupported-language') return withChunkerMetadata(chunkLines(filePath, content, target.language), fallbackDiagnostics(target.language, 'unsupported-language', false));
  try {
    return chunkCodeAware(filePath, content, target.language!, false).chunks;
  } catch {
    return chunkFileContentLineFallback(filePath, content, target.language, 'chunker-error');
  }
}

export async function chunkFileContentReady(filePath: string, content: string): Promise<FileSearchChunkingResult> {
  const target = classifyFileSearchChunkingTarget(filePath);
  if (target.kind === 'plain-text') return buildChunkingResult(chunkPlainText(filePath, content, target.language), plainTextDiagnostics(target.language));
  if (target.kind === 'unsupported-language') {
    return buildChunkingResult(chunkLines(filePath, content, target.language), fallbackDiagnostics(target.language, 'unsupported-language', false));
  }
  await ensureFileSearchCodeChunkersReady();
  return chunkCodeAware(filePath, content, target.language!, true);
}

export function chunkKey(chunk: Pick<FileSearchChunkRow, 'projectKey' | 'filePath' | 'chunkIndex'>): string {
  return `${chunk.projectKey}:${chunk.filePath}:${chunk.chunkIndex}`;
}

function rrfScores(scores: Map<string, number>): Map<string, number> {
  if (!scores.size) return scores;
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(ranked.map(([key], index) => [key, 1 / (RRF_K + index + 1)]));
}

export function resolveAlpha(query: string, alpha: number | undefined): number {
  if (alpha !== undefined) return alpha;
  if (isSymbolQuery(query)) return 0.3;
  return 0.5;
}

export function candidateScoreMap(rows: FileSearchChunkRow[]): Map<string, FileSearchChunkRow> {
  const candidates = new Map<string, FileSearchChunkRow>();
  for (const row of rows) {
    const key = chunkKey(row);
    const current = candidates.get(key);
    if (!current) {
      candidates.set(key, row);
      continue;
    }
    candidates.set(key, {
      ...current,
      ...row,
      lexicalScore: current.lexicalScore ?? row.lexicalScore,
      semanticScore: current.semanticScore ?? row.semanticScore,
      score: row.score ?? current.score,
    });
  }
  return candidates;
}

export function boostMultiChunkFiles(scores: Map<string, number>, chunks: Map<string, FileSearchChunkRow>): void {
  if (!scores.size) return;
  const maxScore = Math.max(...scores.values());
  if (!Number.isFinite(maxScore) || maxScore === 0) return;

  const fileSum = new Map<string, number>();
  const bestChunk = new Map<string, string>();

  for (const [key, score] of scores.entries()) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    fileSum.set(chunk.filePath, (fileSum.get(chunk.filePath) ?? 0) + score);
    const currentBestKey = bestChunk.get(chunk.filePath);
    if (!currentBestKey || (scores.get(currentBestKey) ?? 0) < score) bestChunk.set(chunk.filePath, key);
  }

  const maxFileSum = Math.max(...fileSum.values());
  if (!Number.isFinite(maxFileSum) || maxFileSum === 0) return;
  const boostUnit = maxScore * FILE_COHERENCE_BOOST_FRAC;

  for (const [filePath, key] of bestChunk.entries()) {
    const fileScore = fileSum.get(filePath) ?? 0;
    const current = scores.get(key);
    if (current === undefined) continue;
    scores.set(key, current + boostUnit * (fileScore / maxFileSum));
  }
}

function fileStemMatchesChunk(chunk: FileSearchChunkRow, names: Set<string>): boolean {
  const variants = filePathStemVariants(chunk.filePath);
  return [...names].some((name) => variants.some((variant) => stemMatches(variant, name.toLowerCase())));
}

function chunkDefinesSymbol(chunk: FileSearchChunkRow, symbolName: string): boolean {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nsPrefix = '(?:[A-Za-z_][A-Za-z0-9_]*(?:\\.|::))*';
  const keywordPattern = DEFINITION_KEYWORDS.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const sqlKeywordPattern = SQL_DEFINITION_KEYWORDS.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const general = new RegExp(`(?:^|(?<=\\s))(?:${keywordPattern})\\s+${nsPrefix}${escaped}(?:\\s|[<({:\\[]|$)`, 'm');
  const sql = new RegExp(`(?:^|(?<=\\s))(?:${sqlKeywordPattern})\\s+${nsPrefix}${escaped}(?:\\s|[<({:\\[]|$)`, 'mi');
  return general.test(chunk.content) || sql.test(chunk.content);
}

function definitionTier(chunk: FileSearchChunkRow, names: Set<string>, boostUnit: number): number {
  if (![...names].some((name) => chunkDefinesSymbol(chunk, name))) return 0;
  return boostUnit * (fileStemMatchesChunk(chunk, names) ? 1.5 : 1);
}

function boostSymbolDefinitions(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  chunks: Map<string, FileSearchChunkRow>,
  allChunks: Map<string, FileSearchChunkRow>,
): void {
  const symbolName = extractSymbolName(query);
  const names = new Set([symbolName]);
  if (symbolName !== query.trim()) names.add(query.trim());
  const boostUnit = maxScore * DEFINITION_BOOST_MULTIPLIER;

  for (const [key, score] of boosted.entries()) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier > 0) boosted.set(key, score + tier);
  }

  for (const [key, chunk] of allChunks.entries()) {
    if (boosted.has(key)) continue;
    if (!fileStemMatchesChunk(chunk, new Set([symbolName.toLowerCase()]))) continue;
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier > 0) {
      chunks.set(key, chunk);
      boosted.set(key, tier);
    }
  }
}

function boostStemMatches(boosted: Map<string, number>, query: string, maxScore: number, chunks: Map<string, FileSearchChunkRow>): void {
  const keywords = new Set(naturalLanguageTokens(query));
  if (!keywords.size) return;
  const boostUnit = maxScore * STEM_BOOST_MULTIPLIER;
  const pathCache = new Map<string, Set<string>>();
  for (const [key, score] of [...boosted.entries()]) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    if (!pathCache.has(chunk.filePath)) pathCache.set(chunk.filePath, new Set(filePathStemVariants(chunk.filePath)));
    const matches = countKeywordMatches(keywords, pathCache.get(chunk.filePath)!);
    if (matches <= 0) continue;
    const matchRatio = matches / keywords.size;
    if (matchRatio >= 0.10) boosted.set(key, score + (boostUnit * matchRatio));
  }
}

function embeddedSymbolStemMatches(filePath: string, names: Set<string>, minLength: number): boolean {
  const variants = filePathStemVariants(filePath);
  return [...names].some((name) => name.length >= minLength && variants.some((variant) => {
    const variantNorm = variant.toLowerCase();
    return variantNorm === name || variantNorm.startsWith(name) || name.startsWith(variantNorm);
  }));
}

function boostEmbeddedSymbols(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  chunks: Map<string, FileSearchChunkRow>,
  allChunks: Map<string, FileSearchChunkRow>,
): void {
  const names = new Set((query.match(EMBEDDED_SYMBOL_RE) ?? []).filter(Boolean));
  if (!names.size) return;
  const loweredNames = new Set([...names].map((name) => name.toLowerCase()));
  const boostUnit = maxScore * DEFINITION_BOOST_MULTIPLIER * EMBEDDED_SYMBOL_BOOST_SCALE;
  const minLength = 4;
  for (const [key, score] of boosted.entries()) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier > 0) boosted.set(key, score + tier);
  }
  for (const [key, chunk] of allChunks.entries()) {
    if (boosted.has(key)) continue;
    if (!embeddedSymbolStemMatches(chunk.filePath, loweredNames, minLength)) continue;
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier > 0) {
      chunks.set(key, chunk);
      boosted.set(key, tier);
    }
  }
}

export function applyQueryBoost(
  scores: Map<string, number>,
  query: string,
  chunks: Map<string, FileSearchChunkRow>,
  allChunks: Map<string, FileSearchChunkRow> = chunks,
): Map<string, number> {
  if (!scores.size) return scores;
  const maxScore = Math.max(...scores.values());
  if (!Number.isFinite(maxScore) || maxScore === 0) return scores;
  const boosted = new Map(scores);
  if (isSymbolQuery(query)) boostSymbolDefinitions(boosted, query, maxScore, chunks, allChunks);
  else {
    boostStemMatches(boosted, query, maxScore, chunks);
    boostEmbeddedSymbols(boosted, query, maxScore, chunks, allChunks);
  }
  return boosted;
}

function filePathPenalty(filePath: string): number {
  const normalised = normalizePathForComparison(filePath);
  let penalty = 1;
  if (TEST_FILE_RE.test(normalised) || TEST_DIR_RE.test(normalised)) penalty *= 0.3;
  if (REEXPORT_FILENAMES.has(basename(filePath))) penalty *= 0.5;
  if (COMPAT_DIR_RE.test(normalised)) penalty *= 0.3;
  if (EXAMPLES_DIR_RE.test(normalised)) penalty *= 0.3;
  if (TYPE_DEFS_RE.test(normalised)) penalty *= 0.7;
  return penalty;
}

export function rerankTopK(scores: Map<string, number>, chunks: Map<string, FileSearchChunkRow>, topK: number, penalisePaths = true, query = ''): Array<{ chunk: FileSearchChunkRow; score: number }> {
  if (!scores.size) return [];

  const penalised = new Map<string, number>();
  const penaltyCache = new Map<string, number>();
  const symbolQuery = isSymbolQuery(query);
  for (const [key, score] of scores.entries()) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    if (!penalisePaths) {
      penalised.set(key, score);
      continue;
    }
    if (!penaltyCache.has(chunk.filePath)) penaltyCache.set(chunk.filePath, filePathPenalty(chunk.filePath));
    penalised.set(key, score * (penaltyCache.get(chunk.filePath) ?? 1));
  }

  const compareEntries = (a: readonly [string, number], b: readonly [string, number]): number => {
    const scoreDelta = b[1] - a[1];
    if (scoreDelta !== 0) return scoreDelta;
    const aChunk = chunks.get(a[0]);
    const bChunk = chunks.get(b[0]);
    if (aChunk && bChunk) {
      const pathDelta = aChunk.filePath.localeCompare(bChunk.filePath);
      if (pathDelta !== 0) return pathDelta;
      const chunkIndexDelta = aChunk.chunkIndex - bChunk.chunkIndex;
      if (chunkIndexDelta !== 0) return chunkIndexDelta;
    }
    return a[0].localeCompare(b[0]);
  };

  const ranked = [...penalised.entries()].sort(compareEntries);
  const fileSelected = new Map<string, number>();
  const selected: Array<{ key: string; score: number }> = [];
  let minSelected = Number.POSITIVE_INFINITY;

  for (const [key, score] of ranked) {
    if (selected.length >= topK && score <= minSelected) break;
    const chunk = chunks.get(key);
    if (!chunk) continue;
    const alreadySelected = fileSelected.get(chunk.filePath) ?? 0;
    let effectiveScore = score;
    if (alreadySelected >= FILE_SATURATION_THRESHOLD) {
      const excess = alreadySelected - FILE_SATURATION_THRESHOLD + 1;
      effectiveScore *= FILE_SATURATION_DECAY ** excess;
    }
    selected.push({ key, score: effectiveScore });
    fileSelected.set(chunk.filePath, alreadySelected + 1);
    if (selected.length >= topK) minSelected = Math.min(...selected.map((entry) => entry.score));
  }

  selected.sort((a, b) => compareEntries([a.key, a.score], [b.key, b.score]));
  return selected.slice(0, topK).map(({ key, score }) => ({ chunk: chunks.get(key)!, score }));
}

export function normalizeRrf(scores: Map<string, number>): Map<string, number> {
  return rrfScores(scores);
}

export function buildSearchResult(row: FileSearchChunkRow, source: FileSearchSearchMode, redactText: (text: string) => string): FileSearchSearchResult {
  const chunk: FileSearchChunk = {
    filePath: row.filePath,
    content: redactText(row.content),
    startLine: row.startLine,
    endLine: row.endLine,
    ...(row.language ? { language: row.language } : {}),
  };
  const result: FileSearchSearchResult = { chunk, score: row.score ?? 0, source };
  const legacyId = `${row.projectKey}:${row.filePath}:${row.chunkIndex}`;
  const legacyIdentity = {
    namespace: row.projectKey,
    leafName: row.filePath,
    parentContext: `chunk-${row.chunkIndex}`,
  };
  const redactedText = redactText(row.content);
  Object.defineProperties(result, {
    id: { enumerable: false, configurable: true, value: legacyId },
    scope: { enumerable: false, configurable: true, value: 'project' },
    identity: { enumerable: false, configurable: true, value: legacyIdentity },
    provenance: {
      enumerable: false,
      configurable: true,
      value: {
        source: 'file-search',
        origin: row.semanticScore !== undefined && row.lexicalScore === undefined ? 'semantic-indexed-chunk' : 'indexed-chunk',
      },
    },
    content: { enumerable: false, configurable: true, value: { text: redactedText } },
    metadata: {
      enumerable: false,
      configurable: true,
      value: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    file: {
      enumerable: false,
      configurable: true,
      value: {
        projectKey: row.projectKey,
        path: row.filePath,
        chunkIndex: row.chunkIndex,
        chunkText: redactedText,
        chunkHash: row.chunkHash,
        ...(row.hasLineMetadata === false ? {} : { startLine: row.startLine, endLine: row.endLine }),
        lexicalScore: row.lexicalScore,
        semanticScore: row.semanticScore,
      },
    },
  });
  return result;
}
