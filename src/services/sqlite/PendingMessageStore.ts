import type { DbAdapter } from '../database/DbAdapter.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export interface PersistentPendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing';
  created_at_epoch: number;
  agent_type: string | null;
  agent_id: string | null;
}

export class PendingMessageStore {
  private adapter: DbAdapter;

  constructor(
    adapter: DbAdapter,
    private onMutate?: () => void
  ) {
    this.adapter = adapter;
  }

  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const now = Date.now();
    const result = await this.adapter.run(`
      INSERT OR IGNORE INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, created_at_epoch,
        agent_type, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `, [
      sessionDbId,
      contentSessionId,
      message.toolUseId ?? null,
      message.type,
      message.tool_name || null,
      message.tool_input ? JSON.stringify(message.tool_input) : null,
      message.tool_response ? JSON.stringify(message.tool_response) : null,
      message.cwd || null,
      message.last_assistant_message || null,
      message.prompt_number || null,
      now,
      message.agentType ?? null,
      message.agentId ?? null
    ]);

    this.onMutate?.();
    return result.lastInsertRowid as number;
  }

  async claimNextMessage(sessionDbId: number): Promise<PersistentPendingMessage | null> {
    const sql = `
      UPDATE pending_messages
         SET status = 'processing'
       WHERE id = (
         SELECT id FROM pending_messages
          WHERE session_db_id = ? AND status = 'pending'
          ORDER BY id ASC
          LIMIT 1
       )
       RETURNING *
    `;
    const claimed = await this.adapter.get<PersistentPendingMessage>(sql, [sessionDbId]);
    if (claimed) {
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${claimed.id} | type=${claimed.message_type}`, {
        sessionId: sessionDbId
      });
    }
    this.onMutate?.();
    return claimed ?? null;
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    const result = await this.adapter.run(`
      DELETE FROM pending_messages WHERE session_db_id = ?
    `, [sessionDbId]);
    const changes = result.changes ?? 0;
    if (changes > 0) {
      logger.info('QUEUE', `CLEARED | sessionDbId=${sessionDbId} | rowsDeleted=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const result = await this.adapter.run(`
      UPDATE pending_messages
         SET status = 'pending'
       WHERE session_db_id = ? AND status = 'processing'
    `, [sessionDbId]);
    const changes = result.changes ?? 0;
    if (changes > 0) {
      logger.info('QUEUE', `RESET_PROCESSING | sessionDbId=${sessionDbId} | rowsReset=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  async getPendingCount(sessionDbId: number): Promise<number> {
    const result = await this.adapter.get<{ count: number }>(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `, [sessionDbId]);
    return result?.count ?? 0;
  }

  async peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>> {
    return await this.adapter.all<{ message_type: string; tool_name: string | null }>(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `, [sessionDbId]);
  }

  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined,
      agentId: persistent.agent_id ?? undefined,
      agentType: persistent.agent_type ?? undefined
    };
  }
}
