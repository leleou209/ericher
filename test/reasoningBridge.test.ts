/**
 * 思考流桥测试（reasoningBridge）—— 端到端形态。
 *
 * 桥现场建 openai provider 并拦截 fetch：stub 全局 fetch 返回构造的 SSE，
 * 让真 provider 完整跑一遍解析，验证 reasoning_content /
 * response.reasoning_text.delta 被合成为 reasoning 事件、正文原样、
 * 半包 JSON 可拼、无思维链时零影响。
 *
 * 运行: npx vitest run
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { openAIModelWithReasoning } from "../src/agent/reasoningBridge";

function sseResponse(sse: string, chunkSize = Infinity): Response {
  const bytes = new TextEncoder().encode(sse);
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        ctrl.enqueue(bytes.slice(i, i + chunkSize));
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  format: "openai-chat" | "openai-responses",
  sse: string,
  chunkSize = Infinity,
): Promise<LanguageModelV3StreamPart[]> {
  const model = openAIModelWithReasoning({
    apiKey: "k",
    baseURL: "https://fake.test/v1",
    format,
    modelId: "m",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(sse, chunkSize)),
  );
  const res = await (
    model as unknown as {
      doStream: (
        o: LanguageModelV3CallOptions,
      ) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
    }
  ).doStream({
    prompt: [],
  } as unknown as LanguageModelV3CallOptions);
  const reader = res.stream.getReader();
  const out: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHAT_SSE =
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想想"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n' +
  "data: [DONE]\n\n";

describe("思考流桥（openAIModelWithReasoning）", () => {
  it("chat：reasoning_content 分片合成 reasoning 事件，先于正文", async () => {
    const out = await collect("openai-chat", CHAT_SSE);
    const kinds = out.map((e) => e.type);
    expect(kinds).toContain("reasoning-start");
    expect(kinds).toContain("reasoning-end");
    expect(kinds.indexOf("reasoning-start")).toBeLessThan(
      kinds.indexOf("text-delta"),
    );
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas.join("")).toBe("先想想");
    expect(out.some((e) => e.type === "text-delta" && e.delta === "答案")).toBe(
      true,
    );
  });

  it("半包 JSON：reasoning 分片跨 SSE 块也能拼回来", async () => {
    const out = await collect("openai-chat", CHAT_SSE, 7);
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas.join("")).toBe("先想想");
    expect(out.some((e) => e.type === "text-delta" && e.delta === "答案")).toBe(
      true,
    );
  });

  it("responses：reasoning_text.delta 事件也认", async () => {
    const sse =
      'data: {"type":"response.reasoning_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"琢磨中"}\n\n' +
      'data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"正文"}\n\n';
    const out = await collect("openai-responses", sse);
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["琢磨中"]);
    expect(out.some((e) => e.type === "text-delta")).toBe(true);
  });

  it("doGenerate：thinker 的非流式调用从流式实现聚合出全文", async () => {
    const model = openAIModelWithReasoning({
      apiKey: "k",
      baseURL: "https://fake.test/v1",
      format: "openai-chat",
      modelId: "m",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(CHAT_SSE)),
    );
    const res = await (
      model as unknown as {
        doGenerate: (o: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }
    ).doGenerate({ prompt: [] });
    expect(res.content.map((c) => c.text ?? "").join("")).toBe("答案");
    vi.unstubAllGlobals();
  });
  it("没有思维链的端点零影响：事件原样穿过", async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"直接答"}}]}\n\n';
    const out = await collect("openai-chat", sse);
    console.log(
      "[dbg] events:",
      JSON.stringify(out.map((e) => e.type)),
      (
        out.find((e) => e.type === "error") as unknown as {
          error?: { message?: string };
        }
      )?.error?.message ?? "",
    );
    expect(out.some((e) => e.type === "text-delta")).toBe(true);
    expect(out.some((e) => e.type === "reasoning-start")).toBe(false);
  });
});

/**
 * 思考参数落地：providerOptions 里那句指令要真写进出站请求体。
 *
 * 为什么必须在这一层验：AI SDK 的 openai provider 只认自家 schema，
 * thinking / enable_thinking 这类私有字段会被 strip 掉 —— 只有拦住真发出去的
 * 那一次 fetch，才证明它们没在半路被吞。
 */
describe("思考参数写进请求体", () => {
  /** 拦住桥发出去的那一次请求，把请求体解析回来；响应随便给一条能收尾的流 */
  async function requestBodyOf(
    format: "openai-chat" | "openai-responses",
    providerOptions?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const model = openAIModelWithReasoning({
      apiKey: "k",
      baseURL: "https://fake.test/v1",
      format,
      modelId: "m",
    });
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return sseResponse(
          'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        );
      }),
    );
    const res = await (
      model as unknown as {
        doStream: (
          o: LanguageModelV3CallOptions,
        ) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
      }
    ).doStream({
      prompt: [],
      ...(providerOptions ? { providerOptions } : {}),
    } as unknown as LanguageModelV3CallOptions);
    // 只关心请求体：流读不读得完无所谓，取消掉别让定时器挂着
    await res.stream.getReader().cancel();
    return seen[0] ?? {};
  }

  it("reasoning-effort：chat 线是顶层 reasoning_effort", async () => {
    const body = await requestBodyOf("openai-chat", {
      ericher: { dialect: "reasoning-effort", level: "high" },
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("reasoning-effort：responses 线是嵌套的 reasoning.effort", async () => {
    const body = await requestBodyOf("openai-responses", {
      ericher: { dialect: "reasoning-effort", level: "max" },
    });
    expect(body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("thinking-object：DeepSeek/GLM 那种 thinking.type 开关", async () => {
    const body = await requestBodyOf("openai-chat", {
      ericher: { dialect: "thinking-object", level: "off" },
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("enable-thinking：Qwen 那种布尔开关", async () => {
    const body = await requestBodyOf("openai-chat", {
      ericher: { dialect: "enable-thinking", level: "medium" },
    });
    expect(body.enable_thinking).toBe(true);
  });

  it("没传 providerOptions：一个思考字段都不多发（存量行为不变）", async () => {
    const body = await requestBodyOf("openai-chat");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("reasoning");
  });
});
