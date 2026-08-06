// src/chat/modelBackend.ts
// ModelBackend 合同·非流式一次性调用：completeText，专供 deskTimeline(时光带折叠) 与
// deskBoardRefresh(状态板重算) 两条链共用，直连 Anthropic，不复制门房调用细节。
//
// 分工纪律:
//   · 这一层只回【结构化终态】(ok/kind/detail),不组用户可见文案——错误话术的主权留在各调用方。
//   · 记账(usageSink)也留在调用方:"失败也恰好记一笔"的账本纪律不搬家。
//   · 姿势照 summary.ts(BP3 直连)的先例:非流式、独立 max_tokens 小额度
//     (不抄 buildModelParams 的 64k——非流式大额度会被 API 要求转 streaming)、只取 content 里的
//     text 块。thinking 沿用模型档案缺省(Fable/Opus 关不掉,别硬传 disabled 吃 400)。

import { buildModelParams } from './models.ts';
import { safeEndpoint } from '../adapters/streamModelBackends.ts';

export interface ModelBackendEnv {
  ANTHROPIC_API_KEY?: string;
  // 可选:指向 Anthropic 兼容网关的完整 Messages 端点 URL(如 https://gateway.example/v1/messages)。
  // 协议不变仍是 Anthropic Messages;仅 https、不认 URL 内嵌凭据;配了但非法=bad_base_url,不悄悄回落官方端点。
  ANTHROPIC_BASE_URL?: string;
  [k: string]: any;
}

export interface CompleteTextArgs {
  system: string;
  prompt: string;
  model: string;
  timeoutMs?: number;   // 缺省 100_000
  maxTokens?: number;   // 缺省 8000(给 thinking+正文留足)
}

export interface CompleteTextUsage { input: number; output: number; cache_read: number; cache_write: number }

// truncated/refusal 单列终态(codex #1):照 summary.ts 先例,截断/拒答=失败,不许当正常文本交出去。
// 失败变体也带 usage(codex #2):解析成功后的失败(截断/拒答/空文本)钱已经真花了,
// 调用方记账要能拿到真实用量。
export type CompleteTextResult =
  | { ok: true; text: string; usage?: CompleteTextUsage; stopReason?: string }
  | { ok: false; kind: 'no_key' | 'bad_base_url' | 'http' | 'empty' | 'timeout' | 'fetch' | 'truncated' | 'refusal' | 'bad_stop_reason'; detail?: string; usage?: CompleteTextUsage };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 100_000;
const DEFAULT_API_MAX_TOKENS = 8000;

export async function completeText(env: ModelBackendEnv, { system, prompt, model, timeoutMs, maxTokens }: CompleteTextArgs): Promise<CompleteTextResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, kind: 'no_key' };
  // 只认 undefined=未配置;配了(含空串)就必须过 safeEndpoint——空值不是端点,不许悄悄回落官方(codex增量审)。
  const endpoint = env.ANTHROPIC_BASE_URL === undefined ? ANTHROPIC_URL : safeEndpoint(env.ANTHROPIC_BASE_URL);
  if (!endpoint) return { ok: false, kind: 'bad_base_url', detail: String(env.ANTHROPIC_BASE_URL).slice(0, 120) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // buildModelParams 给的是流式聊天档(stream:true + 64k):这里只借它的模型号规范化与 thinking 档位,
    // stream 拿掉、max_tokens 换小额度——非流式大额度会被 API 拒(要求 streaming),摘要也用不着 64k。
    const base: Record<string, any> = buildModelParams(model);
    delete base.stream;
    base.max_tokens = maxTokens ?? DEFAULT_API_MAX_TOKENS;
    // buildModelParams 的 budget_tokens 是按流式大额度(64k/32k)配的;这里把 max_tokens 压小之后
    // 必须同步压思考额度——API 规矩 budget_tokens < max_tokens,不压会稳定 400。
    // 压完还得 ≥1024(API 对 budget_tokens 的下限);装不下就干脆不开思考(extended 档不传=off,合法)。
    if (base.thinking && typeof base.thinking.budget_tokens === 'number' && base.thinking.budget_tokens >= base.max_tokens) {
      const budget = Math.floor(base.max_tokens / 2);
      if (budget >= 1024) base.thinking = { ...base.thinking, budget_tokens: budget };
      else delete base.thinking;
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': String(env.ANTHROPIC_API_KEY),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...base, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: prompt }] }),
      signal: ctl.signal,
    });
    if (!resp.ok) {
      const d = await resp.text().catch(() => '');
      return { ok: false, kind: 'http', detail: `${resp.status}: ${d.slice(0, 200)}` };
    }
    const data: any = await resp.json().catch(() => null);
    if (!data) return { ok: false, kind: 'empty', detail: 'bad json' };
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => String(b.text || ''))
      .join('');
    const u = data.usage || {};
    const usage = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cache_read: Number(u.cache_read_input_tokens) || 0,
      cache_write: Number(u.cache_creation_input_tokens) || 0,
    };
    // 截断/拒答=失败(codex #1,照 summary.ts 先例):半截摘要落库会冻结顶替真历史,refusal 文本更不是摘要。
    // 失败也带 usage——钱已经真花了,账本不能凭空蒸发(codex #2)。
    // 成功终态改成显式白名单(codex 终审 #F1):只有 stop_reason === 'end_turn' 才算成功——正文非空
    // 不再够格。缺失/未知 stop_reason(包括 null/undefined)一律落进 bad_stop_reason,把实际值带上
    // 方便排查,不许悄悄当正常文本交出去。
    if (data.stop_reason === 'max_tokens') return { ok: false, kind: 'truncated', detail: 'max_tokens', usage };
    if (data.stop_reason === 'refusal') return { ok: false, kind: 'refusal', detail: 'refusal', usage };
    if (data.stop_reason !== 'end_turn') {
      return { ok: false, kind: 'bad_stop_reason', detail: data.stop_reason ? String(data.stop_reason) : 'missing', usage };
    }
    if (!text) return { ok: false, kind: 'empty', detail: 'end_turn', usage };
    return { ok: true, text, usage, stopReason: String(data.stop_reason) };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'fetch', detail: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
