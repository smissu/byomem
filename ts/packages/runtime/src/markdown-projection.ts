import type { MemoryRecord } from './contracts.js';

export function projectToMarkdown(record: MemoryRecord): string {
  return `# ${record.id}\n\n${record.content.text ?? ''}`.trim();
}
