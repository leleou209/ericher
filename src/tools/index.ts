// 工具集合入口。所有工具都是原生 AI SDK tool（有 inputSchema + execute），
// 不再有 [TOOL:xxx] 正则解析。
//
// 渐进式披露：主人那间的工具分两层——
//   常驻（RESIDENT_TOOLS）：schema 全量挂进请求，模型直接调；
//   渐进式（DEFERRED_TOOLS）：schema 不进请求，系统提示里一行式索引给名字和参数速记，
//     模型经 call_tool 网关调用（见 gateway.ts），用熟了自动转正常驻（热度粘性）。
// 不拆来客那间：门面求稳，10 个工具本来就不大。

import type { ToolSet } from "ai";
import { adminTools } from "./admin";
import { artifactTools } from "./artifact";
import { askTools } from "./ask";
import { drawTools } from "./draw";
import { feedbackTools } from "./feedback";
import { fileTools } from "./files";
import { memoryTools, guestMemoryTools } from "./memory";
import { noteTools } from "./note";
import { recallTools } from "./recall";
import { remindTools } from "./remind";
import { searchTools } from "./search";
import { sessionTools } from "./session";
import { sessionMemoTools } from "./sessionMemo";
import { taskTools } from "./task";
import type { ToolCtx } from "./types";
import { visionTools } from "./vision";
import { visitorLogTools } from "./visitor";
import { weatherTools } from "./weather";
import { gatewayTools, type GatewayCallbacks } from "./gateway";
import {
  DEFERRED_TOOLS,
  RESIDENT_TOOLS,
  guestEnabledTools,
} from "../agent/toolGroups";

// 常驻/渐进的名单归 toolGroups.ts 统一持有，但别的模块一直从 "../tools" 拿 ——
// 在这里转出去，名册不分家，调用方也不用改。
export { DEFERRED_TOOLS, RESIDENT_TOOLS };

/**
 * 常驻 / 渐进的分层、以及来客能用哪些工具，名册都在 src/agent/toolGroups.ts。
 * 这里只留「怎么组装」—— 名册分家就会和提示词里写的对不上号。
 */

/** 转正常驻的上限：转满 8 个就不再转，索引照样兜底 */
export const PROMOTE_CAP = 8;

/**
 * 组装给模型的那一栈工具：常驻 + 已转正的 + call_tool 网关。
 * 渐进式的不在返回值里——模型看不见它们的 schema，只能走网关。
 * 来客那间不拆层，全量返回（门面求稳）。
 */
export function buildToolStack(
  ctx: ToolCtx,
  opts: { promoted?: string[]; callbacks?: GatewayCallbacks } = {},
): ToolSet {
  const all = buildTools(ctx) as Record<string, never>;
  if (ctx.guest) return all as ToolSet;
  // 转正名单过滤一遍：工具可能已下架，名单里留着旧名字也不能塞进请求；
  // 上限在这里兜底——绕过 cowork 的 promotedForStack 直接喂一长串也塞不进来
  const promoted = (opts.promoted ?? [])
    .filter(
      (n) =>
        all[n] &&
        (DEFERRED_TOOLS as readonly string[]).includes(n) &&
        !(RESIDENT_TOOLS as readonly string[]).includes(n),
    )
    .slice(0, PROMOTE_CAP);
  const tools: Record<string, never> = {};
  for (const n of RESIDENT_TOOLS) if (all[n]) tools[n] = all[n];
  for (const n of promoted) tools[n] = all[n];
  const deferred: Record<string, never> = {};
  for (const n of DEFERRED_TOOLS)
    if (all[n] && !promoted.includes(n)) deferred[n] = all[n];
  Object.assign(
    tools,
    gatewayTools(deferred, opts.callbacks, promoted as string[]),
  );
  return tools as ToolSet;
}

export type { ToolCtx } from "./types";

export function buildTools(ctx: ToolCtx): ToolSet {
  // 多档来客类型：档位给的启用清单决定来客那间注册哪些对外工具。
  // 只对来客生效，主人那间不受影响；没带 guestType / 没带清单（普通来客票、
  // 老 state）一律视为全开 —— 开关是「明确关掉才生效」的语义，缺省不能
  // 反着解释成全关（见 toolGroups.ts 的 guestEnabledTools）。
  const enabled = ctx.guest
    ? new Set(guestEnabledTools(ctx.guestType?.tools))
    : null;
  const allow = (n: string) => !enabled || enabled.has(n);
  // 卡片对两间都开：给来客出清单/对比表正是接待的活，管理员自己也用得上。
  // 安全靠渲染端的 sandbox iframe + 响应头 CSP，不靠「不给工具」
  const outward: ToolSet = Object.fromEntries(
    Object.entries({
      ...searchTools(ctx),
      ...weatherTools(),
      ...visionTools(ctx),
      ...drawTools(ctx),
      ...artifactTools(ctx),
    }).filter(([n]) => allow(n)),
  ) as ToolSet;
  // 来客到此为止：管理员自己的记忆、任务、提醒、文件都不给他碰 ——
  // 给了他既等于泄露，也等于让他替管理员做决定。
  // 唯一的例外是记忆，而且是「受限读」的那一半：
  // 他说的关于他自己的事值得被记下（管理员那边也留一份）；
  // 翻得到的是管理员公开过的 + 他自己名下的（按称呼过滤，在 SQL 里完成），
  // private 的主体一个字都不出管理员那间屋。
  // visitor_log 也只在这间有，且不设开关：留痕是明说的，客人随时能翻自己的账。
  if (ctx.guest)
    return {
      ...outward,
      ...(allow("memory") ? guestMemoryTools(ctx) : {}),
      ...visitorLogTools(ctx),
    };

  return {
    ...outward,
    ...fileTools(ctx),
    // 回头问他一句。只给主人这一间：来客那间没有「正在替他做的事」，
    // 也就没有需要中途确认的岔口 —— 给了它，只会变成多问一句废话
    ...askTools(ctx),
    // 另开一场把一件事说清楚。跟 ask 同理：来客那间没有「我在替他做的事」，
    // 也就没有值得单独立一场的东西
    ...sessionTools(ctx),
    ...memoryTools(ctx),
    // 会话记录只给他这一间：来客那几场没有「她自己回头看」这回事，
    // 而且这条路写进去的东西会挂在会话上
    ...sessionMemoTools(ctx),
    ...recallTools(ctx),
    ...taskTools(ctx),
    // 笔记本只给他这一间：本子上是他自己的草稿，来客那间连「有这本子」都不该知道
    ...noteTools(ctx),
    ...remindTools(ctx),
    ...adminTools(ctx),
    ...feedbackTools(ctx),
  };
}

