export interface UsageTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type UsageStatus = 'ok' | 'failed';

export interface UsageSink {
  logUsage(
    channel: string,
    model: string | undefined | null,
    usage: UsageTokens | undefined | null,
    status?: UsageStatus,
  ): Promise<void>;
}

interface UsageSinkEnv {
  OC_DB: D1Database;
}

const CHANNELS = new Set(['desk', 'desk-timeline', 'desk-board-refresh']);

export function makeD1UsageSink(env: UsageSinkEnv): UsageSink {
  return {
    async logUsage(channel, model, usage, status = 'ok'): Promise<void> {
      try {
        if (!CHANNELS.has(channel)) return;
        const input = Number(usage?.input) || 0;
        const output = Number(usage?.output) || 0;
        const cacheRead = Number(usage?.cache_read) || 0;
        const cacheWrite = Number(usage?.cache_write) || 0;
        if (status === 'ok' && !input && !output && !cacheRead && !cacheWrite) return;

        await env.OC_DB.prepare(
          `INSERT INTO usage_log
             (id, channel, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `ug_${crypto.randomUUID()}`,
          channel,
          model || null,
          input,
          output,
          cacheRead,
          cacheWrite,
          status,
        ).run();
      } catch (error) {
        console.error('[usage] Failed to record model usage:', channel, error);
      }
    },
  };
}
