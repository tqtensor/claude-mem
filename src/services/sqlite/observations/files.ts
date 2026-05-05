
import type { DbAdapter } from '../../database/DbAdapter.js';
import { logger } from '../../../utils/logger.js';
import type { SessionFilesResult } from './types.js';

export function parseFileList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [value];
  }
}

export async function getFilesForSession(
  adapter: DbAdapter,
  memorySessionId: string
): Promise<SessionFilesResult> {
  const rows = await adapter.all<{
    files_read: string | null;
    files_modified: string | null;
  }>(`
    SELECT files_read, files_modified
    FROM observations
    WHERE memory_session_id = ?
  `, [memorySessionId]);

  const filesReadSet = new Set<string>();
  const filesModifiedSet = new Set<string>();

  for (const row of rows) {
    parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

    parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
  }

  return {
    filesRead: Array.from(filesReadSet),
    filesModified: Array.from(filesModifiedSet)
  };
}
