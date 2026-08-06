import type { ModelBackend, ModelUsage, StreamChatArgs, StreamChatResult } from '../core/modelBackend.ts';
import { createLiteralThinkingSplitter } from '../shared/text.ts';
import { buildModelParams } from '../chat/models.ts';

const ZERO_USAGE = (): ModelUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

type Fetcher = typeof fetch;
// 共用端点闸(流式/非流式两条链同一道):只认 https、拒绝 URL 内嵌凭据。传入值语义=完整 Messages 端点 URL。
export function safeEndpoint(raw: string): string | null { try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null; } catch { return null; } }

export interface AnthropicBackendOptions { apiKey: string; baseUrl?: string; timeoutMs?: number; userId?: string; fetch?: Fetcher }

export class AnthropicStreamBackend implements ModelBackend {
  private readonly options: AnthropicBackendOptions;
  constructor(options: AnthropicBackendOptions) { this.options = options; }
  async streamChat(args: StreamChatArgs): Promise<StreamChatResult> {
    // baseUrl 只认 undefined=未配置;配了(含空串)就必须过 safeEndpoint,不许悄悄回落官方端点(codex增量审)。
    const endpoint = this.options.baseUrl === undefined ? 'https://api.anthropic.com/v1/messages' : safeEndpoint(this.options.baseUrl); if (!this.options.apiKey || !endpoint) return { ok: false, kind: 'config' };
    const controller = new AbortController(); let timedOut = false; const abort = () => controller.abort();
    args.signal?.addEventListener('abort', abort, { once: true }); if (args.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? 480_000);
    let text = ''; let thinking = ''; const usage = ZERO_USAGE(); let stopReason = ''; let streamError = false; let messageStopped = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null; let naturalEof = false; const blocks = new Map<number, 'text' | 'thinking' | 'redacted'>();
    const splitter = createLiteralThinkingSplitter(args.model,
      async (chunk) => { if (!chunk) return; text += chunk; await args.onEvent?.({ type: 'text', text: chunk }); },
      async (chunk) => { if (!chunk) return; thinking += chunk; await args.onEvent?.({ type: 'thinking', text: chunk }); }, true);
    try {
      const response = await (this.options.fetch || fetch)(endpoint, { method: 'POST', headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'extended-cache-ttl-2025-04-11', 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildModelParams(args.model), system: args.system.map((block) => block.cache ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral', ttl: '1h' } } : { type: 'text', text: block.text }), messages: [{ role: 'user', content: args.prompt }], ...(this.options.userId ? { metadata: { user_id: this.options.userId } } : {}) }), signal: controller.signal });
      if (!response.ok || !response.body) return { ok: false, kind: 'http', detail: String(response.status) };
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      const consume = async (line: string) => {
        const trimmed = line.trim(); if (!trimmed.startsWith('data:')) return; const raw = trimmed.slice(5).trim(); if (!raw) return;
        let event: any; try { event = JSON.parse(raw); } catch { return; }
        if (messageStopped) { streamError = true; return; }
        const index = Number(event.index); const validIndex = Number.isInteger(index) && index >= 0;
        if (event.type === 'content_block_start') { const type = event.content_block?.type; if (!validIndex || blocks.has(index)) streamError = true; else if (type === 'text' || type === 'thinking' || type === 'redacted_thinking') blocks.set(index, type === 'redacted_thinking' ? 'redacted' : type); else streamError = true; }
        else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') { if (!validIndex || blocks.get(index) !== 'text') streamError = true; else await splitter.feed(String(event.delta.text || '')); }
        else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') { if (!validIndex || blocks.get(index) !== 'thinking') streamError = true; else { const chunk = String(event.delta.thinking || ''); thinking += chunk; await args.onEvent?.({ type: 'thinking', text: chunk }); } }
        else if (event.type === 'content_block_stop') { if (!validIndex || !blocks.delete(index)) streamError = true; }
        else if (event.type === 'message_start') { const u = event.message?.usage || {}; usage.input += Number(u.input_tokens) || 0; usage.cacheRead += Number(u.cache_read_input_tokens) || 0; usage.cacheWrite += Number(u.cache_creation_input_tokens) || 0; await args.onEvent?.({ type: 'usage', usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } }); }
        else if (event.type === 'message_delta') { if (event.delta?.stop_reason) stopReason = String(event.delta.stop_reason); usage.output = Number(event.usage?.output_tokens) || usage.output; }
        else if (event.type === 'message_stop') { if (!stopReason || blocks.size) streamError = true; messageStopped = true; }
        else if (event.type === 'error') streamError = true;
      };
      while (true) { const { done, value } = await reader.read(); if (done) { naturalEof = true; break; } buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) await consume(line); }
      buffer += decoder.decode(); if (buffer) await consume(buffer); await splitter.flush(); await args.onEvent?.({ type: 'usage', usage });
      if (args.signal?.aborted) return { ok: false, kind: 'aborted', usage };
      if (streamError || !messageStopped || !['end_turn', 'max_tokens'].includes(stopReason)) return { ok: false, kind: 'protocol', detail: stopReason || 'missing accepted stop reason', usage };
      if (!text) return { ok: false, kind: 'empty', usage };
      return { ok: true, terminal: 'clean', text, thinking, usage, stopReason };
    } catch (error: any) {
      if (args.signal?.aborted) return { ok: false, kind: 'aborted', usage };
      if (timedOut || error?.name === 'AbortError') return { ok: false, kind: 'timeout', usage };
      return { ok: false, kind: 'fetch', detail: String(error?.message || error), usage };
    } finally { if (reader && !naturalEof) try { await reader.cancel(); } catch {} clearTimeout(timer); args.signal?.removeEventListener('abort', abort); }
  }
}
