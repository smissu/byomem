import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type * as TypeScript from 'typescript';
import type { GraphCommunityRecord, GraphEdgeRecord, GraphImportInput, GraphNodeRecord, GraphReportStats } from './graph-db.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.byomem', 'graphify-out']);

interface MutableGraph {
  baseDir: string;
  nodes: Map<string, GraphNodeRecord>;
  edges: Map<string, GraphEdgeRecord>;
  symbolsByName: Map<string, string[]>;
  calls: Array<{ source: string; name: string; sourceFile: string; sourceLocation: string }>;
  heritage: Array<{ source: string; bases: string[]; sourceFile: string; sourceLocation: string }>;
}

const requireFromRuntime = createRequire(import.meta.url);
let tsModule: typeof TypeScript | undefined;

function getTypeScript(): typeof TypeScript {
  tsModule ??= requireFromRuntime('typescript') as typeof TypeScript;
  return tsModule;
}

function normalizeGraphLabel(label: string): string {
  return label.trim().toLowerCase();
}

function stableId(parts: Array<string | undefined>): string {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part ?? '').update('\0');
  return hash.digest('hex').slice(0, 24);
}

function sourceLocation(line: number): string {
  return `L${line}`;
}

function lineOf(content: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position && index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function fileNodeId(rel: string): string {
  return `file:${rel}`;
}

function nodeId(rel: string, name: string, line: number): string {
  return `${rel}:${name}:${line}`;
}

function addNode(graph: MutableGraph, node: GraphNodeRecord): void {
  graph.nodes.set(node.id, { ...node, normLabel: node.normLabel ?? normalizeGraphLabel(node.label) });
}

function addEdge(graph: MutableGraph, edge: GraphEdgeRecord): void {
  const id = edge.id ?? stableId([edge.source, edge.target, edge.relation, edge.sourceFile, edge.sourceLocation]);
  graph.edges.set(id, {
    ...edge,
    id,
    confidence: edge.confidence ?? 'EXTRACTED',
    confidenceScore: edge.confidenceScore ?? 1,
    weight: edge.weight ?? 1,
  });
}

function addSymbol(graph: MutableGraph, node: GraphNodeRecord, aliases: string[]): void {
  addNode(graph, node);
  for (const alias of aliases) {
    const key = alias.trim();
    if (!key) continue;
    const ids = graph.symbolsByName.get(key) ?? [];
    ids.push(node.id);
    graph.symbolsByName.set(key, ids);
  }
}

function addFileNode(graph: MutableGraph, rel: string): string {
  const id = fileNodeId(rel);
  addNode(graph, {
    id,
    label: rel,
    fileType: 'code',
    sourceFile: rel,
    sourceLocation: 'L1',
    kind: 'file',
  });
  return id;
}

function walkSourceFiles(baseDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(fullPath);
    }
  };
  if (existsSync(baseDir) && statSync(baseDir).isDirectory()) walk(baseDir);
  return files.sort();
}

function resolveRelativeImport(baseDir: string, importerRel: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const importerDir = dirname(resolve(baseDir, importerRel));
  const base = resolve(importerDir, specifier);
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => join(base, `index${extension}`)),
    join(base, '__init__.py'),
  ];
  const resolvedBase = resolve(baseDir);
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const resolved = resolve(candidate);
    if (resolved.startsWith(`${resolvedBase}${sep}`)) return relative(resolvedBase, resolved);
  }
  return undefined;
}

function addImportEdge(graph: MutableGraph, rel: string, fileId: string, specifier: string, line: number, resolvedRel?: string): void {
  const target = resolvedRel ? addFileNode(graph, resolvedRel) : `import:${specifier}`;
  if (!resolvedRel) {
    addNode(graph, {
      id: target,
      label: specifier,
      fileType: 'code',
      sourceFile: rel,
      sourceLocation: sourceLocation(line),
      kind: 'import',
    });
  }
  addEdge(graph, {
    source: fileId,
    target,
    relation: 'imports_from',
    sourceFile: rel,
    sourceLocation: sourceLocation(line),
  });
}

function declarationName(ts: typeof TypeScript, node: TypeScript.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return node.name?.text;
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name) ? node.name.text : undefined;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function callName(ts: typeof TypeScript, expression: TypeScript.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function heritageNames(node: TypeScript.ClassDeclaration | TypeScript.InterfaceDeclaration): string[] {
  return (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => type.expression.getText().split('.').at(-1) ?? type.expression.getText()));
}

function addTsCalls(ts: typeof TypeScript, graph: MutableGraph, rel: string, ownerId: string, ownerNode: TypeScript.Node, sourceFile: TypeScript.SourceFile, content: string): void {
  const visit = (node: TypeScript.Node): void => {
    if (node !== ownerNode && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isCallExpression(node)) {
      const name = callName(ts, node.expression);
      if (name) graph.calls.push({ source: ownerId, name, sourceFile: rel, sourceLocation: sourceLocation(lineOf(content, node.getStart(sourceFile))) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ownerNode, visit);
}

function resolveCalls(graph: MutableGraph): void {
  for (const call of graph.calls) {
    for (const target of (graph.symbolsByName.get(call.name) ?? []).slice(0, 3)) {
      if (target === call.source) continue;
      addEdge(graph, {
        source: call.source,
        target,
        relation: 'calls',
        confidence: 'INFERRED',
        confidenceScore: 0.8,
        sourceFile: call.sourceFile,
        sourceLocation: call.sourceLocation,
      });
    }
  }
}

function resolveHeritage(graph: MutableGraph): void {
  for (const heritage of graph.heritage) {
    for (const base of heritage.bases) {
      const target = graph.symbolsByName.get(base)?.[0];
      if (!target || target === heritage.source) continue;
      addEdge(graph, {
        source: heritage.source,
        target,
        relation: 'extends',
        confidence: 'INFERRED',
        confidenceScore: 0.8,
        sourceFile: heritage.sourceFile,
        sourceLocation: heritage.sourceLocation,
      });
    }
  }
}

function featureKey(sourceFile: string | undefined): string {
  if (!sourceFile) return 'external';
  const file = sourceFile.replaceAll('\\', '/');
  const name = file.split('/').at(-1) ?? file;
  const lower = name.toLowerCase();
  const testPrefix = file.includes('/tests/') || file.startsWith('tests/') ? 'tests:' : '';
  const sourcePrefix = file.includes('/src/') ? 'src:' : '';
  if (lower.includes('file-search')) return `${testPrefix || sourcePrefix}file-search`;
  if (lower.includes('graph')) return `${testPrefix || sourcePrefix}graph`;
  if (lower.includes('mcp')) return `${testPrefix || sourcePrefix}mcp`;
  if (lower.includes('session') || lower.includes('capture') || lower.includes('transcript')) return `${testPrefix || sourcePrefix}session-capture`;
  if (lower.includes('memory') || lower.includes('store') || lower.includes('retrieval') || lower.includes('search-index')) return `${testPrefix || sourcePrefix}memory`;
  if (lower.includes('queue') || lower.includes('worker')) return `${testPrefix || sourcePrefix}queue`;
  if (lower.includes('embedding') || lower.includes('semantic')) return `${testPrefix || sourcePrefix}semantic`;
  if (lower.includes('identity') || lower.includes('normalizer') || lower.includes('contract')) return `${testPrefix || sourcePrefix}contracts`;
  if (testPrefix) return `${testPrefix}other`;
  if (sourcePrefix) return `${sourcePrefix}${name.replace(/\.[^.]+$/, '').split('-')[0] || 'other'}`;
  return file.split('/').slice(0, 2).join('/') || 'root';
}

function assignCommunities(nodes: GraphNodeRecord[], edges: GraphEdgeRecord[]): { nodes: GraphNodeRecord[]; communities: GraphCommunityRecord[]; stats: GraphReportStats } {
  const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
  const groups = new Map<string, string[]>();
  for (const node of byId.values()) {
    const key = featureKey(node.sourceFile);
    const group = groups.get(key) ?? [];
    group.push(node.id);
    groups.set(key, group);
  }
  const components = [...groups.entries()]
    .map(([key, ids]) => ({ key, ids: ids.sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key));
  const communities = components.map((component, index) => {
    for (const id of component.ids) {
      const node = byId.get(id);
      if (node) node.community = index;
    }
    const labels = component.ids.map((id) => byId.get(id)?.label).filter((label): label is string => Boolean(label));
    const idSet = new Set(component.ids);
    const internalEdges = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target)).length;
    const possibleEdges = Math.max(1, component.ids.length * Math.max(1, component.ids.length - 1));
    return {
      id: index,
      name: `Native ${component.key}`,
      cohesion: Number((internalEdges / possibleEdges).toFixed(3)),
      nodeCount: component.ids.length,
      preview: labels.slice(0, 8),
    };
  });
  const inferredEdges = edges.filter((edge) => edge.confidence === 'INFERRED').length;
  return {
    nodes: [...byId.values()],
    communities,
    stats: {
      summaryNodes: nodes.length,
      summaryEdges: edges.length,
      summaryCommunities: communities.length,
      extractedPercent: edges.length ? Number((((edges.length - inferredEdges) / edges.length) * 100).toFixed(1)) : 0,
      inferredPercent: edges.length ? Number(((inferredEdges / edges.length) * 100).toFixed(1)) : 0,
      ambiguousPercent: 0,
      inferredEdges,
      averageInferredConfidence: inferredEdges ? 0.8 : 0,
      godNodeCount: 0,
      isolatedNodeCount: communities.filter((community) => community.nodeCount === 1).length,
      thinCommunityCount: communities.filter((community) => (community.nodeCount ?? 0) <= 2).length,
      suggestedQuestionCount: 0,
    },
  };
}

function extractTsFile(graph: MutableGraph, filePath: string): void {
  const ts = getTypeScript();
  const rel = relative(graph.baseDir, filePath);
  const content = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const fileId = addFileNode(graph, rel);

  const addDeclaration = (node: TypeScript.Node, name: string, kind: string, label = name, parentId = fileId): string => {
    const line = lineOf(content, node.getStart(sourceFile));
    const id = nodeId(rel, label.replace(/\(\)$/, ''), line);
    addSymbol(graph, {
      id,
      label,
      fileType: 'code',
      sourceFile: rel,
      sourceLocation: sourceLocation(line),
      kind,
    }, [name, label, label.replace(/\(\)$/, '')]);
    addEdge(graph, {
      source: parentId,
      target: id,
      relation: parentId === fileId ? 'contains' : 'method',
      sourceFile: rel,
      sourceLocation: sourceLocation(line),
    });
    return id;
  };

  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const line = lineOf(content, node.getStart(sourceFile));
      const specifier = node.moduleSpecifier.text;
      addImportEdge(graph, rel, fileId, specifier, line, resolveRelativeImport(graph.baseDir, rel, specifier));
      continue;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const line = lineOf(content, node.getStart(sourceFile));
      const specifier = node.moduleSpecifier.text;
      addImportEdge(graph, rel, fileId, specifier, line, resolveRelativeImport(graph.baseDir, rel, specifier));
      continue;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const classLine = lineOf(content, node.getStart(sourceFile));
      const classId = addDeclaration(node, node.name.text, 'class', node.name.text);
      graph.heritage.push({ source: classId, bases: heritageNames(node), sourceFile: rel, sourceLocation: sourceLocation(classLine) });
      for (const member of node.members) {
        const name = declarationName(ts, member);
        if (!name) continue;
        const label = `${node.name.text}.${name}${ts.isMethodDeclaration(member) ? '()' : ''}`;
        const memberId = addDeclaration(member, name, ts.isMethodDeclaration(member) ? 'method' : 'property', label, classId);
        const memberRecord = graph.nodes.get(memberId);
        if (memberRecord) addSymbol(graph, memberRecord, [name]);
        if (ts.isMethodDeclaration(member)) addTsCalls(ts, graph, rel, memberId, member, sourceFile, content);
        if (ts.isPropertyDeclaration(member) && member.initializer) addTsCalls(ts, graph, rel, memberId, member.initializer, sourceFile, content);
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const interfaceLine = lineOf(content, node.getStart(sourceFile));
      const interfaceId = addDeclaration(node, node.name.text, 'interface', node.name.text);
      graph.heritage.push({ source: interfaceId, bases: heritageNames(node), sourceFile: rel, sourceLocation: sourceLocation(interfaceLine) });
      continue;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      addDeclaration(node, node.name.text, 'type', node.name.text);
      continue;
    }
    if (ts.isEnumDeclaration(node) && node.name) {
      addDeclaration(node, node.name.text, 'enum', node.name.text);
      continue;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      const id = addDeclaration(node, node.name.text, 'function', `${node.name.text}()`);
      addTsCalls(ts, graph, rel, id, node, sourceFile, content);
      continue;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        const functionLike = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
        const id = addDeclaration(declaration, declaration.name.text, functionLike ? 'function' : 'symbol', functionLike ? `${declaration.name.text}()` : declaration.name.text);
        if (initializer) addTsCalls(ts, graph, rel, id, initializer, sourceFile, content);
      }
    }
  }
}

function pythonIndent(line: string): number {
  return line.match(/^\s*/)?.[0].replaceAll('\t', '    ').length ?? 0;
}

function extractPythonCalls(line: string): string[] {
  const names: string[] = [];
  const callPattern = /(?:\b|\.)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(line)) !== null) {
    const name = match[1];
    if (!['if', 'for', 'while', 'return', 'class', 'def', 'with', 'except', 'super'].includes(name)) names.push(name);
  }
  return names;
}

function extractPythonFile(graph: MutableGraph, filePath: string): void {
  const rel = relative(graph.baseDir, filePath);
  const content = readFileSync(filePath, 'utf8');
  const fileId = addFileNode(graph, rel);
  const stack: Array<{ indent: number; id: string; name: string; kind: string }> = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const indent = pythonIndent(line);
    while (stack.length && indent <= stack[stack.length - 1]!.indent) stack.pop();

    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const specifier of importMatch[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        addImportEdge(graph, rel, fileId, specifier, lineNo);
      }
      return;
    }
    const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_.$]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const moduleName = fromMatch[1];
      const modulePath = moduleName.replace(/^\.+/, '').replaceAll('.', '/');
      const resolved = resolveRelativeImport(graph.baseDir, rel, moduleName.startsWith('.') ? moduleName : `./${modulePath}`);
      addImportEdge(graph, rel, fileId, moduleName, lineNo, resolved);
      return;
    }
    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?:/);
    if (classMatch) {
      const name = classMatch[1];
      const id = nodeId(rel, name, lineNo);
      addSymbol(graph, { id, label: name, fileType: 'code', sourceFile: rel, sourceLocation: sourceLocation(lineNo), kind: 'class' }, [name]);
      addEdge(graph, { source: fileId, target: id, relation: 'contains', sourceFile: rel, sourceLocation: sourceLocation(lineNo) });
      graph.heritage.push({ source: id, bases: (classMatch[2] ?? '').split(',').map((part) => part.trim().split('.')[0]).filter(Boolean), sourceFile: rel, sourceLocation: sourceLocation(lineNo) });
      stack.push({ indent, id, name, kind: 'class' });
      return;
    }
    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (defMatch) {
      const name = defMatch[1];
      const parentClass = [...stack].reverse().find((item) => item.kind === 'class');
      const label = parentClass ? `${parentClass.name}.${name}()` : `${name}()`;
      const id = nodeId(rel, label.replace(/\(\)$/, ''), lineNo);
      addSymbol(graph, { id, label, fileType: 'code', sourceFile: rel, sourceLocation: sourceLocation(lineNo), kind: parentClass ? 'method' : 'function' }, [name, label, label.replace(/\(\)$/, '')]);
      addEdge(graph, { source: parentClass?.id ?? fileId, target: id, relation: parentClass ? 'method' : 'contains', sourceFile: rel, sourceLocation: sourceLocation(lineNo) });
      stack.push({ indent, id, name, kind: parentClass ? 'method' : 'function' });
      return;
    }
    const owner = [...stack].reverse().find((item) => item.kind === 'function' || item.kind === 'method');
    if (owner) {
      for (const name of extractPythonCalls(trimmed)) graph.calls.push({ source: owner.id, name, sourceFile: rel, sourceLocation: sourceLocation(lineNo) });
    }
  });
}

export function buildNativeSourceGraph(baseDir: string): GraphImportInput {
  const graph: MutableGraph = {
    baseDir: resolve(baseDir),
    nodes: new Map(),
    edges: new Map(),
    symbolsByName: new Map(),
    calls: [],
    heritage: [],
  };
  for (const filePath of walkSourceFiles(graph.baseDir)) {
    if (JS_TS_EXTENSIONS.has(extname(filePath))) extractTsFile(graph, filePath);
    else if (extname(filePath) === '.py') extractPythonFile(graph, filePath);
  }
  resolveHeritage(graph);
  resolveCalls(graph);
  const edges = [...graph.edges.values()];
  const assigned = assignCommunities([...graph.nodes.values()], edges);
  return {
    source: 'native-source',
    baseDir: graph.baseDir,
    nodes: assigned.nodes,
    edges,
    reportCommunities: assigned.communities,
    reportStats: assigned.stats,
  };
}
