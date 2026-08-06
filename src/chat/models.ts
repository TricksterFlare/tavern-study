// src/chat/models.ts
// 模型档案表:不同代模型请求姿势不同(传错就 400),worker 按当前模型查表拼请求体。
// 详见架构草案 §2.5。前端切模型 = 点下拉,后端自动适配。

export interface ModelProfile {
  thinking: 'adaptive' | 'extended' | 'none';
  display?: 'summarized';   // adaptive 下要不要显式开思考文字(4.7/4.8 默认不吐,要加)
  effort: boolean;          // 支不支持 output_config.effort
  maxTokens: number;
}

export const DEFAULT_MODEL = 'claude-opus-4-8';

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-fable-5':    { thinking: 'adaptive', display: 'summarized', effort: true,  maxTokens: 64000 }, // Fable 5:thinking永远在线(显式传adaptive合法,disabled/budget_tokens会400);安全分类器可能回stop_reason:"refusal"
  'claude-opus-5':     { thinking: 'adaptive', display: 'summarized', effort: true,  maxTokens: 64000 }, // Opus 5:thinking默认就开(不传=adaptive);disabled只在effort≤high合法,配xhigh/max会400;budget_tokens/temperature同样400;同带refusal终态
  'claude-opus-4-8':   { thinking: 'adaptive', display: 'summarized', effort: true,  maxTokens: 64000 },
  'claude-opus-4-7':   { thinking: 'adaptive', display: 'summarized', effort: true,  maxTokens: 64000 },
  'claude-opus-4-6':   { thinking: 'adaptive', effort: true,  maxTokens: 64000 }, // 4.6 思考文字默认就吐 summarized
  'claude-sonnet-4-6': { thinking: 'adaptive', effort: true,  maxTokens: 64000 },
  'claude-opus-4-5':   { thinking: 'extended', effort: true,  maxTokens: 32000 },
  'claude-sonnet-4-5': { thinking: 'extended', effort: false, maxTokens: 32000 }, // Sonnet 4.5 不支持 effort
};

// 拼出请求体里跟"模型差异"相关的那部分(model / max_tokens / thinking / effort)
export function buildModelParams(model: string): Record<string, any> {
  // 不认识的模型名整个夹回默认值——否则 model 字符串原样发出去会 404
  const id = MODEL_PROFILES[model] ? model : DEFAULT_MODEL;
  const p = MODEL_PROFILES[id];
  const params: Record<string, any> = { model: id, max_tokens: p.maxTokens, stream: true };

  if (p.thinking === 'adaptive') {
    params.thinking = p.display
      ? { type: 'adaptive', display: p.display }
      : { type: 'adaptive' };
  } else if (p.thinking === 'extended') {
    // 老模型:extended 要手动给思考额度,且必须 < max_tokens
    params.thinking = { type: 'enabled', budget_tokens: Math.floor(p.maxTokens / 2) };
  }

  if (p.effort) params.output_config = { effort: 'high' };
  return params;
}
