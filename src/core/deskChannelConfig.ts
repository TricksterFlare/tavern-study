export interface DeskChannelConfig { ANTHROPIC_API_KEY?: string }

export function validateDeskChannelConfig(env: DeskChannelConfig): string | null {
  return env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY 没配';
}
