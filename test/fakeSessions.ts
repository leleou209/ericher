// 测试用的服务端会话：与主屋 DO 的 auth_sessions 同形，存在内存 Map 里。
import type { Role } from "../src/auth";

export type FakeSession = {
  role: Role;
  type?: string;
  card?: string;
  exp: number;
};

export function attachFakeSessions<T extends object>(
  agent: T,
  store = new Map<string, FakeSession>(),
): T {
  const a = agent as Record<string, unknown>;
  a.sessionCreate = async (input: {
    hash: string;
    role: Role;
    type?: string;
    card?: string;
    exp: number;
  }) => {
    store.set(input.hash, {
      role: input.role,
      type: input.type,
      card: input.card,
      exp: input.exp,
    });
  };
  a.sessionVerify = async (hash: string) => {
    const s = store.get(hash);
    if (!s || s.exp <= Date.now()) return null;
    return { ...s };
  };
  a.sessionRenew = async (hash: string, ttlSec: number) => {
    const s = store.get(hash);
    if (!s || s.exp <= Date.now()) return null;
    s.exp = Date.now() + Math.max(0, ttlSec) * 1000;
    return s.exp;
  };
  a.sessionRevoke = async (hash: string) => store.delete(hash);
  a.sessionRevokeAccount = async () => 0;
  a.loginFailure = async () => ({ blocked: 0, count: 1 });
  a.loginSuccess = async () => {};
  return agent;
}
