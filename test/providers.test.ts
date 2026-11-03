/**
 * resolveModel（目录链 → 旧链的回落逻辑）测试。
 *
 * 三种接口格式各建对一家 provider；维护模型能单独走另一把 key；
 * key 缺失、没配置、读取出错三种情况一律回落旧链 ——
 * 换厂商是锦上添花，目录那边出任何岔子都不能让机器说不了话。
 *
 * 两个 provider 包都是 mock：只断言工厂参数与调用形态，不发真请求。
 *
 * 运行: npx vitest run test/providers.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, resolveModel } from "../src/providers";
import type {
  ActiveCatalog,
  ModelEntry,
  ModelProvider,
} from "../src/agent/modelConfigs";

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const anthropicModel = (id: string) => ({ vendor: "anthropic", modelId: id });
const anthropicProvider = Object.assign(vi.fn(anthropicModel), {
  languageModel: vi.fn(anthropicModel),
  chat: vi.fn(anthropicModel),
});

const chatModel = (id: string) => ({
  vendor: "openai-chat",
  modelId: id,
  doStream: vi.fn(async () => ({
    stream: new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  })),
});
const responsesModel = (id: string) => ({
  vendor: "openai-responses",
  modelId: id,
  doStream: vi.fn(async () => ({
    stream: new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  })),
});
const openaiProvider = Object.assign(vi.fn(chatModel), {
  chat: vi.fn(chatModel),
  responses: vi.fn(responsesModel),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAnthropic).mockImplementation(
    () => anthropicProvider as unknown as ReturnType<typeof createAnthropic>,
  );
  vi.mocked(createOpenAI).mockImplementation(
    () => openaiProvider as unknown as ReturnType<typeof createOpenAI>,
  );
});

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: "prov0001",
  name: "测试厂商",
  format: "anthropic",
  baseUrl: "https://api.example.com",
  keySecret: "DEEPSEEK_KEY",
  maintKeySecret: "",
  maintModel: "",
  // 写法与档位都由 catalog() 的 over 兜：默认这一份是「什么都没配」的存量状态
  thinkingDialect: "auto",
  created: "2026-01-01T00:00:00.000Z",
  ...over,
});

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: "abcd1234",
  providerId: "prov0001",
  model: "deepseek-v4-pro",
  maxOutput: 131072,
  contextWindow: 0,
  thinking: "",
  thinkingBudget: 0,
  active: true,
  created: "2026-01-01T00:00:00.000Z",
  ...over,
});

const catalog = (
  p: Partial<ModelProvider> = {},
  e: Partial<ModelEntry> = {},
): ActiveCatalog => ({ provider: provider(p), entry: entry(e) });

const env = (over: Record<string, unknown> = {}): Env =>
  ({ ...over }) as unknown as Env;

describe("resolveModel：三种格式", () => {
  it("anthropic：createAnthropic({ baseURL, apiKey }) 再调用即模型", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog(),
    );
    expect(createAnthropic).toHaveBeenCalledTimes(1);
    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: "https://api.example.com",
      apiKey: "sk-1",
    });
    expect(anthropicProvider).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(r?.model).toEqual({
      vendor: "anthropic",
      modelId: "deepseek-v4-pro",
    });
    expect(r?.maxOutput).toBe(131072);
    // 没配维护 key：复用主模型本体
    expect(r?.maintModel).toBe(r?.model);
  });

  it("openai-chat：走 provider 的 .chat", async () => {
    const r = await resolveModel(env({ OPENAI_KEY: "sk-2" }), async () =>
      catalog(
        { format: "openai-chat", keySecret: "OPENAI_KEY" },
        { model: "gpt-5.2" },
      ),
    );
    // 桥是惰性的：真跑一轮调用才现场建 provider（网络 stub 掉）
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const stream = await (
      r?.model as unknown as {
        doStream: (o: unknown) => Promise<{ stream: ReadableStream }>;
      }
    ).doStream({ prompt: [] });
    const reader = stream.stream.getReader();
    await reader.read();
    reader.cancel();
    vi.unstubAllGlobals();
    // 参数里多了抓思维链的 fetch
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-2",
        baseURL: "https://api.example.com",
      }),
    );
    expect(openaiProvider.chat).toHaveBeenCalledWith("gpt-5.2");
    expect(openaiProvider.responses).not.toHaveBeenCalled();
    expect(r?.model).toMatchObject({
      provider: "hr-desk.openai-bridge",
      modelId: "gpt-5.2",
    });
  });

  it("openai-responses：走 provider 的 .responses", async () => {
    const r = await resolveModel(env({ OPENAI_KEY: "sk-3" }), async () =>
      catalog(
        { format: "openai-responses", keySecret: "OPENAI_KEY" },
        { model: "gpt-5.2" },
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            'data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"hi"}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const stream = await (
      r?.model as unknown as {
        doStream: (o: unknown) => Promise<{ stream: ReadableStream }>;
      }
    ).doStream({ prompt: [] });
    const reader = stream.stream.getReader();
    await reader.read();
    reader.cancel();
    vi.unstubAllGlobals();
    expect(openaiProvider.responses).toHaveBeenCalledWith("gpt-5.2");
    expect(openaiProvider.chat).not.toHaveBeenCalled();
    expect(r?.model).toMatchObject({
      provider: "hr-desk.openai-bridge",
      modelId: "gpt-5.2",
    });
  });

  it("同一供应商换模型条目：地址与 key 不变，只换模型名", async () => {
    await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { model: "deepseek-flash" }),
    );
    expect(createAnthropic).toHaveBeenCalledTimes(1);
    expect(anthropicProvider).toHaveBeenCalledWith("deepseek-flash");
  });

  it("maxOutput 走条目的，透传且只认正整数", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { maxOutput: 8192 }),
    );
    expect(r?.maxOutput).toBe(8192);
    const bad = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { maxOutput: 0 }),
    );
    expect(bad?.maxOutput).toBe(131072);
  });

  it("contextWindow 走条目的：没设（0）回落默认档", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { contextWindow: 128_000 }),
    );
    expect(r?.contextWindow).toBe(128_000);
    const unset = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { contextWindow: 0 }),
    );
    expect(unset?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

/**
 * 思考强度：档位（条目）与写法（供应商）在这里合成 providerOptions。
 * 这一层只验「算出来是什么」；真正落到请求体是 reasoningBridge 的事（见 bridge 测试）。
 */
describe("resolveModel：思考强度", () => {
  it("条目没设档位：null —— 跟厂商默认走，存量条目行为不变", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog(),
    );
    expect(r?.providerOptions).toBeNull();
  });

  it("anthropic 线：档位折成 thinking.budgetTokens，走 AI SDK 的 anthropic 键", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({ thinkingDialect: "auto" }, { thinking: "high" }),
    );
    expect(r?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
  });

  it("自定义预算优先：条目填了 thinkingBudget 就用它", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { thinking: "low", thinkingBudget: 2048 }),
    );
    expect(r?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
  });

  it("关闭思考：thinking.disabled —— 两种 anthropic 写法都认这一句", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { thinking: "off" }),
    );
    expect(r?.providerOptions).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
  });

  it("推理档写法：折成 effort，不塞 budget", async () => {
    const r = await resolveModel(env({ ANTHROPIC_KEY: "sk-a" }), async () =>
      catalog(
        {
          format: "anthropic",
          keySecret: "ANTHROPIC_KEY",
          thinkingDialect: "anthropic-effort",
        },
        { thinking: "medium" },
      ),
    );
    expect(r?.providerOptions).toEqual({ anthropic: { effort: "medium" } });
  });

  it("OpenAI 线：只给桥一句指令（哪个写法、什么强度）", async () => {
    const r = await resolveModel(env({ OPENAI_KEY: "sk-2" }), async () =>
      catalog(
        { format: "openai-chat", keySecret: "OPENAI_KEY" },
        { thinking: "low" },
      ),
    );
    expect(r?.providerOptions).toEqual({
      ericher: { dialect: "reasoning-effort", level: "low" },
    });
  });

  it("写法选「不下发」：null，哪怕档位配了", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({ thinkingDialect: "none" }, { thinking: "high" }),
    );
    expect(r?.providerOptions).toBeNull();
  });

  it("输出上限窄到开不了思考：null（开只会换一条 400）", async () => {
    const r = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({}, { thinking: "high", maxOutput: 1024 }),
    );
    expect(r?.providerOptions).toBeNull();
  });

  it("旧链：没有目录条目就没有思考档，null", async () => {
    const r = await resolveModel(env({ API_KEY: "k" }), async () => null);
    expect(r?.providerOptions).toBeNull();
  });
});

describe("resolveModel：维护模型（供应商级维护口）", () => {
  it("维护 key 独立配了：另建一个模型，模型名缺省复用主线条目", async () => {
    const r = await resolveModel(
      env({ DEEPSEEK_KEY: "sk-1", SK_MAINTENANCE: "sk-m" }),
      async () => catalog({ maintKeySecret: "SK_MAINTENANCE" }),
    );
    expect(createAnthropic).toHaveBeenCalledTimes(2);
    expect(createAnthropic).toHaveBeenNthCalledWith(2, {
      baseURL: "https://api.example.com",
      apiKey: "sk-m",
    });
    expect(anthropicProvider).toHaveBeenNthCalledWith(2, "deepseek-v4-pro");
    expect(r?.maintModel).not.toBe(r?.model);
  });

  it("维护模型写了名字：跟着走；key 没配：复用主模型", async () => {
    const named = await resolveModel(
      env({ DEEPSEEK_KEY: "sk-1", SK_MAINTENANCE: "sk-m" }),
      async () =>
        catalog({
          maintKeySecret: "SK_MAINTENANCE",
          maintModel: "deepseek-flash",
        }),
    );
    expect(anthropicProvider).toHaveBeenNthCalledWith(2, "deepseek-flash");

    const noKey = await resolveModel(env({ DEEPSEEK_KEY: "sk-1" }), async () =>
      catalog({ maintKeySecret: "NOT_SET", maintModel: "deepseek-flash" }),
    );
    expect(noKey?.maintModel).toBe(noKey?.model);
  });
});

describe("resolveModel：回落旧链", () => {
  const OLD_CHAIN = {
    vendor: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  };

  it("供应商点名的那把 key 没配：回落 mainModel，maxOutput 131072", async () => {
    const r = await resolveModel(env({ API_KEY: "k" }), async () =>
      catalog({ keySecret: "NOT_SET" }),
    );
    // 回落走的是旧链 provider（env.API_ENDPOINT 缺省到官方地址）
    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
      headers: undefined,
    });
    expect(r?.model).toEqual(OLD_CHAIN);
    expect(r?.maxOutput).toBe(131072);
  });

  it("没有生效条目：回落旧链，维护模型跟 maintenanceModel", async () => {
    const r = await resolveModel(
      env({ API_KEY: "k", SK_MAINTENANCE: "km", API_MODEL: "" }),
      async () => null,
    );
    expect(r?.model).toEqual(OLD_CHAIN);
    expect(anthropicProvider).toHaveBeenNthCalledWith(
      2,
      "claude-sonnet-4-20250514",
    );
  });

  it("fetchActive 抛错当 null 处理，照常回落", async () => {
    const r = await resolveModel(env({ API_KEY: "k" }), async () => {
      throw new Error("主人那间没醒");
    });
    expect(r?.model).toEqual(OLD_CHAIN);
  });

  it("旧链也没配 API_KEY：返回 null，由调用方给「API_KEY 未配置」", async () => {
    const r = await resolveModel(env({}), async () => null);
    expect(r).toBeNull();
  });
});
