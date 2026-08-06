// src/storage/vectorize.ts
// Vectorize + Workers AI embedding 的封装层

// Workers AI 的类型 D1Database 类似,但需要单独定义
interface Ai {
  run(model: string, options: { text: string | string[] }): Promise<{
    shape: number[];
    data: number[][];
  }>;
}

interface VectorizeIndex {
  upsert(vectors: Array<{
    id: string;
    values: number[];
    metadata?: Record<string, any>;
  }>): Promise<{ mutationId: string }>;

  query(values: number[], options?: {
    topK?: number;
    returnMetadata?: boolean;
    returnValues?: boolean;
    filter?: Record<string, any>;
  }): Promise<{
    matches: Array<{
      id: string;
      score: number;
      metadata?: Record<string, any>;
    }>;
  }>;

  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
}

// 把一段文本变成 1024 维向量
export async function embedText(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-m3', { text });
  return result.data[0];
}

// 把一条记忆的向量塞进 Vectorize(id 跟 D1 里的 entry id 保持一致,方便反查)
export async function upsertVector(
  vectorize: VectorizeIndex,
  ai: Ai,
  id: string,
  text: string,
  metadata?: Record<string, any>
): Promise<void> {
  const values = await embedText(ai, text);
  await vectorize.upsert([{ id, values, metadata }]);
}

// 语义查询 - 把查询文本 embed 然后找最近的 topK 条
export async function queryVectors(
  vectorize: VectorizeIndex,
  ai: Ai,
  query: string,
  topK: number = 10,
  filter?: Record<string, any>
): Promise<Array<{ id: string; score: number; metadata?: Record<string, any> }>> {
  const queryVector = await embedText(ai, query);
  const result = await vectorize.query(queryVector, {
    topK,
    returnMetadata: true,
    filter
  });
  return result.matches;
}

// 删除某条向量(catch 删除时同步删)
export async function deleteVector(
  vectorize: VectorizeIndex,
  id: string
): Promise<void> {
  await vectorize.deleteByIds([id]);
}

// 类型导出给 index.ts 用
export type { Ai, VectorizeIndex };
