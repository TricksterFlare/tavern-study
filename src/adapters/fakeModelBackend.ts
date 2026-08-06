import type { ModelBackend, ModelStreamEvent, StreamChatArgs, StreamChatResult } from '../core/modelBackend.ts';

export class FakeModelBackend implements ModelBackend {
  readonly calls: StreamChatArgs[] = [];
  private readonly result: StreamChatResult; private readonly events: ModelStreamEvent[];
  constructor(result: StreamChatResult, events: ModelStreamEvent[] = []) { this.result = result; this.events = events; }
  async streamChat(args: StreamChatArgs): Promise<StreamChatResult> {
    this.calls.push({ ...args, system: structuredClone(args.system), onEvent: undefined });
    for (const event of this.events) await args.onEvent?.(structuredClone(event));
    return structuredClone(this.result);
  }
}
