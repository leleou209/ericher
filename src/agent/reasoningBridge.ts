// 思考流桥 v2：让 openai 兼容端点的思维链实时显示。
//
// 为什么要有这一层：SDK 的 openai provider 只认 content / tool_calls / annotations
// —— DeepSeek、GLM、Kimi 这类端点把思维链放在 delta.reasoning_content（与 content
// 同级）或 Responses API 的 response.reasoning_text.delta 事件里。
//
// 第一版走「旁路收集 + 事件合成」，实测攒团 —— 根因在 provider 的 doStream：
// 它先 await throwIfOpenAIStreamErrorBeforeOutput 预读，把「非输出 chunk」全部
// 吞掉直到第一个正文块（isOpenAIChatOutputChunk 认 content 非空），且预读
// stream.tee() 的另一支数据积压 —— 整个思考阶段的字节在 doStream 返回前就被
// 预检消费完，消费者一次性收到。
//
// v2 改打「改写」：fetch 层把 reasoning 分片改写成 delta.content =
// "\u0000" + 分片 + "\u0000"（NUL 哨兵）—— 预检看到非空 content 立即放行，
// 思考阶段的字节逐块流到事件层；事件层把带哨兵的 text-delta 转回
// reasoning 事件，正文不受影响（模型输出 NUL 的概率为零，成对拦截）。
// reasoning 阶段会留一个空 text part（text-start/end 包着零个 delta），
// 前端对空 part 不渲染，无碍。

import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { ModelFormat } from "./modelConfigs";

/** 哨兵：包住改写进 content 的思维链分片。NUL 在正常模型输出里不会出现 */
const SENTINEL = "\u0000";

/** reasoning part 的 id：一次调用里所有思维链分片合到同一个 part */
const REASONING_ID = "reasoning_content";

/** 每次调用现场建 provider：fetch 是 provider 级配置（AI SDK 6 的调用选项里没有它） */

interface OpenAIModelConfig {
  apiKey: string;
  baseURL: string;
  format: Extract<ModelFormat, "openai-chat" | "openai-responses">;
  modelId: string;
}

/**
 * 字节级改写器：SSE 行缓冲 + 逐行判定 ——
 * chat 的 reasoning_content → delta.content 哨兵包裹；
 * responses 的 reasoning_text.delta → output_text.delta 哨兵包裹；
 * 其余行原样。
 */
class ReasoningRewriter {
  private buf = "";
  private dec = new TextDecoder();
  private enc = new TextEncoder();

  constructor(private readonly isResponses: boolean) {}

  /** 喂一块字节，返回改写后应输出的字节 */
  feed(bytes: Uint8Array): Uint8Array {
    this.buf += this.dec.decode(bytes, { stream: true });
    let out = "";
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      out += this.rewriteLine(line);
    }
    return this.enc.encode(out);
  }

  /** 流尾残余（没有换行结尾的半行） */
  flush(): Uint8Array | null {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return null;
    return this.enc.encode(this.rewriteLine(rest) + "\n");
  }

  private rewriteLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") return line;
    const payload = trimmed.slice(5).trim();
    if (!payload) return line;
    let j: unknown;
    try {
      j = JSON.parse(payload);
    } catch {
      return line;
    }
    if (this.isResponses) {
      const v = j as {
        type?: string;
        item_id?: string;
        delta?: unknown;
      };
      if (
        v.type === "response.reasoning_text.delta" &&
        typeof v.delta === "string" &&
        v.delta
      ) {
        return (
          'data: {"type":"response.output_text.delta","item_id":' +
          JSON.stringify(v.item_id ?? "reasoning") +
          ',"output_index":0,"content_index":0,"delta":' +
          JSON.stringify(SENTINEL + v.delta + SENTINEL) +
          "}\n\n"
        );
      }
      return line;
    }
    const v = j as {
      choices?: Array<{ delta?: { reasoning_content?: unknown } }>;
    };
    const rc = v.choices?.[0]?.delta?.reasoning_content;
    if (typeof rc === "string" && rc) {
      return (
        'data: {"choices":[{"index":0,"delta":{"content":' +
        JSON.stringify(SENTINEL + rc + SENTINEL) +
        "}}]}\n\n"
      );
    }
    return line;
  }
}

export function openAIModelWithReasoning(
  config: OpenAIModelConfig,
): import("ai").LanguageModel {
  const isResponses = config.format === "openai-responses";
  // 每次调用现场建 provider（fetch 是 provider 级配置，AI SDK 6 的调用选项里没有它；
  // createOpenAI 只是对象构造，每请求一次的账花得起）
  return {
    specificationVersion: "v3",
    provider: "hr-desk.openai-bridge",
    modelId: config.modelId,
    supportedUrls: Promise.resolve({}),
    doStream: async (options: LanguageModelV3CallOptions) => {
      const openai = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if (!res.body) return res;
          const rewriter = new ReasoningRewriter(isResponses);
          const body = res.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, ctrl) {
                try {
                  ctrl.enqueue(rewriter.feed(chunk));
                } catch {
                  // 改写器出错不该碰坏真流：大不了丢思考流
                  ctrl.enqueue(chunk);
                }
              },
              flush(ctrl) {
                const rest = rewriter.flush();
                if (rest) ctrl.enqueue(rest);
              },
            }),
          );
          return new Response(body, res);
        },
      });
      const inner = await (
        isResponses
          ? openai.responses(config.modelId)
          : openai.chat(config.modelId)
      ).doStream(options);

      // 事件层：哨兵 text-delta 转回 reasoning。start 只在第一片发一次、
      // end 只在思考结束（正文开始 / 工具开跑 / 流收尾）发一次 ——
      // 否则每个分片三件套会被 UI 拆成一个个独立折叠块，一个字一块。
      let reasoningOpen = false;
      const closeReasoning = (
        ctrl: TransformStreamDefaultController<LanguageModelV3StreamPart>,
      ) => {
        if (reasoningOpen) {
          ctrl.enqueue({ type: "reasoning-end", id: REASONING_ID });
          reasoningOpen = false;
        }
      };
      const stream = inner.stream.pipeThrough(
        new TransformStream<
          LanguageModelV3StreamPart,
          LanguageModelV3StreamPart
        >({
          transform(part, ctrl) {
            if (part.type === "text-delta") {
              const d = part.delta;
              if (
                d.length >= 2 &&
                d.startsWith(SENTINEL) &&
                d.endsWith(SENTINEL)
              ) {
                const piece = d.slice(SENTINEL.length, -SENTINEL.length);
                if (piece) {
                  if (!reasoningOpen) {
                    ctrl.enqueue({ type: "reasoning-start", id: REASONING_ID });
                    reasoningOpen = true;
                  }
                  ctrl.enqueue({
                    type: "reasoning-delta",
                    id: REASONING_ID,
                    delta: piece,
                  });
                }
                return;
              }
            }
            // 正文/工具/收尾出现 = 思考阶段结束，先封口再透传。
            // 正文那支必须是 text-delta：provider 只在整段内容开头发一次
            // text-start（那时先到的是哨兵，思考还没开），指望它封口等于永不封口
            if (
              reasoningOpen &&
              (part.type === "text-delta" ||
                part.type === "text-start" ||
                part.type === "tool-input-start" ||
                part.type === "finish")
            ) {
              closeReasoning(ctrl);
            }
            ctrl.enqueue(part);
          },
          flush(ctrl) {
            closeReasoning(ctrl);
          },
        }),
      );

      return { ...inner, stream };
    },
    // 非流式的活（thinker 飘字走 generateText）从流式实现聚合 —— 桥的
    // 语义全部在事件流里，这里只是把流喝干收成一次结果
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      const model = openAIModelWithReasoning(config) as unknown as {
        doStream: (
          o: LanguageModelV3CallOptions,
        ) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
      };
      const { stream } = await model.doStream(options);
      const reader = stream.getReader();
      let text = "";
      // usage 的形状由 finish 事件自带（同 spec 类型），聚合层只透传
      let usage: LanguageModelV3Usage | undefined;
      // V3 的 finishReason 是 { unified, raw } 对象，不是字符串
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: undefined,
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const v = value as {
          type: string;
          delta?: string;
          finishReason?: unknown;
          usage?: unknown;
        };
        if (v.type === "text-delta" && v.delta) text += v.delta;
        if (v.type === "finish") {
          if (v.usage) usage = v.usage as LanguageModelV3Usage;
          if (v.finishReason) {
            const fr = v.finishReason as LanguageModelV3FinishReason;
            // 同 spec 的 finish 事件带的就是对象；字符串兜底（跨 spec 时）
            finishReason =
              typeof fr === "string"
                ? {
                    unified: fr as LanguageModelV3FinishReason["unified"],
                    raw: fr,
                  }
                : fr;
          }
        }
      }
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason,
        usage,
        warnings: [],
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as LanguageModelV3GenerateResult;
    },
  };
}
