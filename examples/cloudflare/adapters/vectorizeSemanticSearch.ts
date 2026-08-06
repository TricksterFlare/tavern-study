import type { SemanticSearchAdapter } from '../../../src/core/storage.ts';
import { deleteVector, queryVectors, upsertVector } from '../../../src/storage/vectorize';
import type { Ai, VectorizeIndex } from '../../../src/storage/vectorize';

export class VectorizeSemanticSearch implements SemanticSearchAdapter {
  constructor(private readonly index: VectorizeIndex, private readonly ai: Ai) {}

  async upsert(document: { id: string; text: string; metadata: Record<string, string> }): Promise<void> {
    await upsertVector(this.index, this.ai, document.id, document.text, document.metadata);
  }

  async delete(id: string): Promise<void> {
    await deleteVector(this.index, id);
  }

  async search(query: string, options: { limit: number; filter?: Record<string, string> }): Promise<Array<{ id: string; score: number }>> {
    const hits = await queryVectors(this.index, this.ai, query, options.limit, options.filter);
    return hits.map(({ id, score }) => ({ id, score }));
  }
}
