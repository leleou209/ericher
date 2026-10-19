import { describe, expect, it } from "vitest";
import { SESSION_RUNNING_MESSAGE, sessionConflictResponse } from "../src/shared/sessionConflict";

describe("旧会话切换冲突的安全响应", () => {
  it("已知运行冲突返回409与可操作的指导", async () => {
    const response = sessionConflictResponse(new Error(`remote: ${SESSION_RUNNING_MESSAGE}`));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toEqual({ ok: false, error: SESSION_RUNNING_MESSAGE });
  });
  it("未知平台错误不泄露内部信息", () => {
    expect(sessionConflictResponse(new Error("R2 secret internal key"))).toBeNull();
    expect(sessionConflictResponse(null)).toBeNull();
  });
});
