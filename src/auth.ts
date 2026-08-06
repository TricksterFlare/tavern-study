export type Scope =
  | 'study:read' | 'study:write'
  | 'chapters:read' | 'chapters:write'
  | 'desk:read' | 'desk:write'
  | 'published:read' | 'comments:read' | 'comments:write';

export interface AuthContext {
  actorId: 'owner' | 'companion';
  actorType: 'owner' | 'ai';
  displayName: string;
  scopes: ReadonlySet<Scope>;
}

export interface AuthEnv {
  OWNER_TOKEN: string;
  OWNER_TOKEN_PREVIOUS?: string;
  COMPANION_TOKEN?: string;
  COMPANION_TOKEN_PREVIOUS?: string;
  COMPANION_NAME?: string;
  COMPANION_COMMENT_WRITE?: string;
}

const OWNER_SCOPES: Scope[] = [
  'study:read', 'study:write', 'chapters:read', 'chapters:write',
  'desk:read', 'desk:write', 'published:read', 'comments:read', 'comments:write',
];

// 先各自哈希成定长 32 字节摘要,再逐字节比较(codex 终审 #F4):循环次数只跟摘要长度(恒为32)
// 挂钩,不再跟着输入长度走——原先"循环次数=max(输入长度,secret长度)"会把输入长度泄给远程计时。
async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [bytes, expected] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= bytes[i] ^ expected[i];
  return diff === 0;
}

export async function authenticate(request: Request, env: AuthEnv): Promise<AuthContext | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1];
  if (!token) return null;

  for (const candidate of [env.OWNER_TOKEN, env.OWNER_TOKEN_PREVIOUS]) {
    if (candidate && await equalSecret(token, candidate)) {
      return { actorId: 'owner', actorType: 'owner', displayName: 'Owner', scopes: new Set(OWNER_SCOPES) };
    }
  }
  for (const candidate of [env.COMPANION_TOKEN, env.COMPANION_TOKEN_PREVIOUS]) {
    if (candidate && await equalSecret(token, candidate)) {
      const scopes: Scope[] = ['published:read', 'comments:read'];
      if (env.COMPANION_COMMENT_WRITE === 'true') scopes.push('comments:write');
      return { actorId: 'companion', actorType: 'ai', displayName: env.COMPANION_NAME?.slice(0, 80) || 'Companion', scopes: new Set(scopes) };
    }
  }
  return null;
}

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.has(scope);
}
