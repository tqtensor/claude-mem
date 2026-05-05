
import type { DbAdapter } from '../../database/DbAdapter.js';
import { logger } from '../../../utils/logger.js';

export async function saveUserPrompt(
  adapter: DbAdapter,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): Promise<number> {
  const now = new Date();
  const nowEpoch = now.getTime();

  const result = await adapter.run(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `, [contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch]);

  return result.lastInsertRowid as number;
}
