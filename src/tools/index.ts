// 工具集合入口：全部是原生 AI SDK tool（有 inputSchema + execute），不再有 [TOOL:xxx] 正则。
// 渐进式披露（仅主人那间）：常驻（RESIDENT_TOOLS）的 schema 全量挂进请求；渐进式（DEFERRED_TOOLS）
// 不进请求，提示里只给一行式索引，经 call_tool 网关调用（gateway.ts），用熟自动转正常驻。
// 来客那间不拆层：门面求稳，10 个工具本来就不大。

import type { ToolSet } from "ai";
import { adminTools } from "./admin";
import { artifactTools } from "./artifact";
import { askTools } from "./ask";
import { drawTools } from "./draw";
import { feedbackTools } from "./feedback";
import { fileTools } from "./files";
import { matrixTools } from "./matrix";
import { memoryTools, guestMemoryTools } from "./memory";
import { noteTools } from "./note";
import { planTools } from "./plan";
import { recallTools } from "./recall";
import { mailTools } from "./mail";
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

// 常驻/渐进名单归 toolGroups.ts 持有，但别的模块一直从 "../tools" 拿 ——
// 在这里转出去，名册不分家，调用方也不用改。
export { DEFERRED_TOOLS, RESIDENT_TOOLS };

/**
 * 分层与来客工具名册都在 src/agent/toolGroups.ts；这里只留「怎么组装」——
 * 名册分家就会和提示词里写的对不上号。
 */

/** 转正常驻的上限：转满 8 个就不再转，索引照样兜底 */
export const PROMOTE_CAP = 8;

/**
 * 组装给模型的那一栈工具：常驻 + 已转正的 + call_tool 网关。渐进式的不在返回值里 ——
 * 模型看不见它们的 schema，只能走网关。来客那间不拆层，全量返回。
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
  // 多档来客类型：档位的启用清单决定来客那间注册哪些对外工具。没带 guestType / 清单
  //（普通来客票、老 state）一律视为全开 —— 开关是「明确关掉才生效」，缺省不能反着解释成全关。
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
  // 来客到此为止：管理员自己的记忆、任务、提醒、文件都不给他碰（既泄密，也等于替他做决定）。
  // 唯一例外是记忆，而且是受限读的那一半：他说自己的事要记下（管理员那边也留一份），
  // 翻得到的是管理员公开的 + 他名下的（SQL 里过滤），private 的主体一个字不出主屋。
  // visitor_log 只在来客这间有且不设开关：留痕是明说的，他随时能翻自己的账。
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
    // 本场计划只给主人这一间：来客那间没有「这一场要办成什么」，
    // 那是主人自己排的事；给了他既看不懂，也会把管理员的安排读出来
    ...planTools(ctx),
    // 笔记本只给他这一间：本子上是他自己的草稿，来客那间连「有这本子」都不该知道
    ...noteTools(ctx),
    ...remindTools(ctx),
    // 发信只在这间屋有：邮件是离开这个系统的出口，发出去收不回。
    // 来客那间碰它，等于拿管理员的邮箱身份对外说话
    ...mailTools(ctx),
    ...adminTools(ctx),
    ...feedbackTools(ctx),
    // 网页矩阵：建页/改页/连通路/换外观
    ...matrixTools(ctx),
  };
}
