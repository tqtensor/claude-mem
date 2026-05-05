
import type { DbAdapter } from '../../database/DbAdapter.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../../shared/platform-source.js';

function resolveCreateSessionArgs(
  customTitle?: string,
  platformSource?: string
): { customTitle?: string; platformSource?: string } {
  return {
    customTitle,
    platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined
  };
}

export async function createSDKSession(
  adapter: DbAdapter,
  contentSessionId: string,
  project: string,
  userPrompt: string,
  customTitle?: string,
  platformSource?: string
): Promise<number> {
  const now = new Date();
  const nowEpoch = now.getTime();
  const resolved = resolveCreateSessionArgs(customTitle, platformSource);
  const normalizedPlatformSource = resolved.platformSource ?? DEFAULT_PLATFORM_SOURCE;

  const existing = await adapter.get<{ id: number; platform_source: string | null }>(`
    SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
  `, [contentSessionId]);

  if (existing) {
    if (project) {
      await adapter.run(`
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ? AND (project IS NULL OR project = '')
      `, [project, contentSessionId]);
    }
    if (resolved.customTitle) {
      await adapter.run(`
        UPDATE sdk_sessions SET custom_title = ?
        WHERE content_session_id = ? AND custom_title IS NULL
      `, [resolved.customTitle, contentSessionId]);
    }

    if (resolved.platformSource) {
      const storedPlatformSource = existing.platform_source?.trim()
        ? normalizePlatformSource(existing.platform_source)
        : undefined;

      if (!storedPlatformSource) {
        await adapter.run(`
          UPDATE sdk_sessions SET platform_source = ?
          WHERE content_session_id = ?
            AND COALESCE(platform_source, '') = ''
        `, [resolved.platformSource, contentSessionId]);
      } else if (storedPlatformSource !== resolved.platformSource) {
        throw new Error(
          `Platform source conflict for session ${contentSessionId}: existing=${storedPlatformSource}, received=${resolved.platformSource}`
        );
      }
    }
    return existing.id;
  }

  await adapter.run(`
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
  `, [contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch]);

  const row = await adapter.get<{ id: number }>('SELECT id FROM sdk_sessions WHERE content_session_id = ?', [contentSessionId]);
  return row!.id;
}

export async function updateMemorySessionId(
  adapter: DbAdapter,
  sessionDbId: number,
  memorySessionId: string | null
): Promise<void> {
  await adapter.run(`
    UPDATE sdk_sessions
    SET memory_session_id = ?
    WHERE id = ?
  `, [memorySessionId, sessionDbId]);
}
