// 渐进式工具网关（Meta-Tool 模式）。全量 schema 太贵（24 个工具约 8K tokens），
// 首层只给一行式索引，要用时再递完整定义（同 Anthropic Tool Search / MCP 三层发现 / OpenAI manifest 前缀）。
// AI SDK 没有原生 defer（tools 参数整场固定），所以网关承担两件事：
//   dispatch —— 按速记调真工具，zod 校验失败把「哪里没对上 + 完整定义」一起回喂，模型同一场自纠；
//   probe    —— 只传 tool 不传 args 时，把说明和完整参数定义递回去。
// 边界：靠 toModelOutput 回传媒体的工具（draw、view_image）不能走这里 —— 网关只回字符串，图会丢，必须常驻。

import { tool } from "ai";
import { z } from "zod";

/** 网关手里的一个渐进式工具：只用到 description / inputSchema / execute 三样 */
type DeferredTool = {
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema?: any;
  execute?: (input: unknown) => Promise<unknown>;
};

export type GatewayCallbacks = {
  /** 每次真分发（probe 不算）都报一声：统计与「热度转正」都靠这一个信号 */
  onDeferredUse?: (name: string, ok: boolean, ms: number) => void;
};

/** 把一个工具的说明 + 完整参数定义写成给人（模型）看的一段话 */
function definitionOf(name: string, t: DeferredTool): string {
  let schema = "{}";
  try {
    if (t.inputSchema && typeof t.inputSchema.safeParse === "function") {
      schema = JSON.stringify(
        z.toJSONSchema(t.inputSchema, { io: "input", reused: "inline" }),
      );
    }
  } catch {
    schema = "{}（定义转写失败，按索引里的参数速记给）";
  }
  return `【${name}】${t.description || "（无说明）"}\n参数定义：${schema}`;
}

export function gatewayTools(
  deferred: Record<string, DeferredTool>,
  callbacks: GatewayCallbacks = {},
  promoted: string[] = [],
) {
  return {
    call_tool: tool({
      description:
        "渐进式工具网关。系统提示「工具索引」里列了名字但没挂完整定义的工具，都从这里调：" +
        "tool 填索引里的名字，args 按索引的参数速记给。拿不准参数就只传 tool 不传 args（probe），" +
        "我会把完整定义递回来再调。用顺手了我会把它转正常驻，之后直接调，不用再经过这里。",
      inputSchema: z.object({
        tool: z.string().describe("索引里的工具名，照抄"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("参数对象，按索引速记给；不传 = 只看定义不执行"),
      }),
      execute: async ({ tool: name, args }) => {
        const t = deferred[name];
        if (!t) {
          // 转正过的工具已直接挂在工具栈里，网关这一跳对它关闭。得把「该走哪条路」说死，
          // 不然模型会拿「索引里没有」当成工具消失了
          if (promoted.includes(name))
            return (
              `「${name}」已经转成常驻工具了，直接调用它即可（不用再经过 call_tool，` +
              `也不要再传 {tool, args} 包装）。它的完整参数定义在你的工具列表里。`
            );
          return `索引里没有「${name}」这个工具。名字要照索引抄，别自己造。`;
        }
        // probe：只报定义不执行 —— 参数没把握时先看一眼，省得拿猜测去撞校验
        if (!args) return definitionOf(name, t);

        let input: unknown = args;
        if (t.inputSchema && typeof t.inputSchema.safeParse === "function") {
          const r = t.inputSchema.safeParse(args);
          if (!r.success) {
            // 校验失败也是一次失败的使用：统计和转正门槛都得看见它，
            // 不然「照着错误提示重试」的空转会一路计成用得顺手
            callbacks.onDeferredUse?.(name, false, 0);
            const issues = r.error.issues
              .map(
                (i: { path: PropertyKey[]; message: string }) =>
                  `${i.path.join(".") || "(root)"}: ${i.message}`,
              )
              .join("；");
            // 定义跟着错误一起回：模型不用再 probe 一步
            return (
              `「${name}」的参数没对上（${issues}）。完整定义如下，改完再调：\n` +
              definitionOf(name, t)
            );
          }
          input = r.data;
        }
        if (typeof t.execute !== "function")
          return `「${name}」是个占位名，没有可执行的动作。`;

        const t0 = Date.now();
        try {
          const out = await t.execute(input);
          callbacks.onDeferredUse?.(name, true, Date.now() - t0);
          return typeof out === "string" ? out : JSON.stringify(out);
        } catch (e) {
          callbacks.onDeferredUse?.(name, false, Date.now() - t0);
          return (
            `「${name}」执行出错：${(e as Error).message}。可以修正参数重试，` +
            `或者换别的办法。`
          );
        }
      },
    }),
  };
}
