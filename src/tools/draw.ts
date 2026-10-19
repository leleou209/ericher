// 画图：draw（文生图/图生图，带 reference 保留主体特征）、diagram（她写 mermaid，渲染器摆线）、
// send_image（把云盘已有的图发回对话）三条并列。选错路线的代价是「出来的东西完全不对」，
// 所以拆成三条而不是一个 mode 参数。
// diagram 不手写 SVG：坐标吃 token、易被输出上限截断、对齐差；文生图画结构必走形
// （框歪、字糊、箭头乱指），而结构正是示意图的命根子。send_image 少了就只能重画一张，
// 而重画的从来不是同一张。
// draw 的 quality：fast = Workers AI FLUX.2 klein（免费额度内、无水印），
// high = 硅基流动 Z-Image-Turbo（兜底 Kolors，按张付费）—— 升档只关乎美不美与花费，故用一个参数。
// 画好随结果递回自检（draw.toModelOutput）：图在手上，少一跳少一次忘记看；历史只留文字，不重发图。

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { insertMemory, searchMemories } from "../agent/memory";
import { guestHasTool } from "../agent/guestTypes";
import type { DrawConfig, DrawFormat, DrawTier } from "../agent/drawConfigs";
import { usage } from "../agent/usage";
import { sessionKey } from "../fileAccess";
import type { ToolCtx } from "./types";
import { loadImage, mayViewKey } from "./vision";
import { publicFetch } from "./search";

/**
 * 高质量档与兜底档的端点/模型/降级链已搬进 draw_configs 表；这里只剩画幅。
 * 两家尺寸口径不同：硅基流动横图是 1280x720，别把通用那组直接搬过去。
 */
const SIZES = {
  square: { w: 1024, h: 1024 },
  wide: { w: 1344, h: 768 },
  tall: { w: 768, h: 1344 },
} as const;

/** 硅基流动是另一套尺寸表：横图给它 1280x720，别把 FLUX 那组直接搬过去 */
const SF_SIZES = {
  square: "1024x1024",
  wide: "1280x720",
  tall: "768x1024",
} as const;

/** MiniMax 不认像素尺寸，只认宽高比 */
const MM_RATIOS = {
  square: "1:1",
  wide: "16:9",
  tall: "9:16",
} as const;

/** mermaid 源码上限。源码本该是「几十行」的量级；到 100KB 已经是往里塞东西了 */
const MMD_CAP = 100_000;

/** 只声明用到的部分，免得依赖生成的 Ai 类型细节（和 memory.ts 里那处同一套写法） */
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export function drawTools(ctx: ToolCtx): ToolSet {
  // 这一轮里画了几张。把「不对就重画一次」卡死在一次：不设闸的话，
  // 她对自己的图容易越看越不顺眼，一张配图能来回画到把整轮耗光。
  let attempts = 0;

  const draw = tool({
    description:
      "调用生图模型画一张有质感的艺术图：插画、封面、配图、场景、角色。" +
      "不带参考图就是文生图 —— 质感、光线、情绪都拿手，但内容不可控，画不了需要精确对位的结构。" +
      "带上 reference 是图生图：保留参考图里人物/主体的长相和画意，按你的描述出新图 —— " +
      "「还是这个人换个场景」「照这张图改一下」都走它。要改哪里（背景、动作、加东西）写进 prompt，" +
      "要保留的也一并写全；这是照着参考图重生一张，不是像素级 P 图，原图的小细节会变。" +
      "要讲清楚关系和结构（流程图、架构图、时序图、逻辑网络、对比表格），用 diagram 亲自画演示图。" +
      "英文提示词出图更稳，画风、构图、光线都写进去。默认那档便宜够用；画日系动漫、二次元人物、立绘，" +
      "或者他说要「好看点」的时候，把 quality 提到 high，那档贵一点但明显更像样。" +
      "画好后把图片地址给你，你要把那行 markdown 放进回复里，他才看得见。",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "画面描述。写清主体、风格、构图、光线、色调；英文效果通常更好，也可以中英混写",
        ),
      reference: z
        .string()
        .optional()
        .describe(
          "参考图的云盘文件名（形如 f/default/draw-1730000000000-9f2c1eab.png，画过的、" +
            "存进记忆的、发过的都在）。给了它就是图生图：照着一张图改、或要人物前后一致时用；" +
            "纯画新图不要给",
        ),
      shape: z
        .enum(["square", "wide", "tall"])
        .default("square")
        .describe("画幅：方形 / 横图 / 竖图"),
      quality: z
        .enum(["fast", "high"])
        .default("fast")
        .describe(
          "画质档。默认 fast：便宜档，日常配图、示意用图、随手画一张就用它。" +
            "画日系动漫、二次元人物、立绘、封面，或者他说「画好看点」「要能拿得出手的」，才用 high" +
            "（high 按张付费，别当默认）",
        ),
      keep: z
        .boolean()
        .optional()
        .describe(
          "true = 画完顺手把这张存进记忆（type=image）。他说「这个以后还要用」「存着」的时候才用，" +
            "别每张都存——配图不是藏品，图多了记忆库就成了图床",
        ),
    }),
    execute: async ({ prompt, shape, keep, quality, reference }) => {
      attempts += 1;
      const { w, h } = SIZES[shape];
      const size = `${w}x${h}`;
      const errors: string[] = [];

      // 参考图（图生图）先备好原件：key 是她嘴上说的，可能被诱导指向别间屋的图 ——
      // 过一遍房间划界再取（和 view_image 同一扇门），越界的当没看见
      let ref: string | null = null;
      const refKey = (reference || "").trim();
      if (refKey) {
        if (!mayViewKey(ctx, refKey))
          return `这张参考图我看不了：${refKey}（不在我能看的范围里）`;
        const img = await loadImage(ctx.env, refKey);
        if (!img.ok) return img.why;
        // MiniMax 的 image_file 认 data URI（官方口径：data:image/jpeg;base64,{data} 或公网 URL）。
        // 云盘那条 /api/files 要带登录态，人家的服务器拉不动，只能递原件
        ref = `data:${img.mediaType};base64,${img.data}`;
      }

      let bytes: ArrayBuffer | null = null;
      let meta = "";

      // 来客一律走便宜档：高质量那档花的是管理员的钱，不该由路过的人替他决定
      const tier: DrawTier = ctx.guest ? "fast" : quality;
      const tiers = await ctx.drawTiers();

      // 降级链由 draw_configs 驱动：high 先走贵的，没成掉 fast，最后兜底；
      // 每档失败原因留在 errors 里，全栽了才把清单交出去
      const order: DrawTier[] =
        tier === "high" ? ["high", "fast", "fallback"] : ["fast", "fallback"];
      for (const t of order) {
        const got = await drawWith(
          ctx.env,
          tiers[t],
          prompt,
          ref,
          shape,
          w,
          h,
          errors,
        );
        if (got) {
          bytes = got.bytes;
          meta = got.meta;
          break;
        }
      }
      if (!bytes) return "这次没画成：\n" + errors.join("\n");

      // 存进云盘再给他看：供应商给的地址有有效期，过几天翻回来就是空白。
      // key 带房间前缀 + 会话文件夹 + 随机段：读图靠它划界，产物按场归档，也不容易撞名
      const key = sessionKey(ctx.room, ctx.sessionId, "draw", "png");
      await ctx.env.MEMORY_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: "image/png" },
      });

      const kept = keep ? keepMemory(ctx, prompt, key) : "";
      return (
        handOff(
          `画好了：/api/files/${key}`,
          prompt.slice(0, 40),
          `/api/files/${key}`,
          meta,
          kept,
        ) +
        "\n\n" +
        selfCheck(attempts)
      );
    },
    // 图递回去让她自己看一眼 —— 自检就靠这一句。key 是从她自己的输出里抠的，
    // 但万一被诱导写出别家的 key，递图前也得过一遍房间划界（和 view_image 同一扇门）
    toModelOutput: async ({ output }) => {
      const key = imageKeyIn(output);
      const img =
        key && mayViewKey(ctx, key) ? await loadImage(ctx.env, key) : null;
      if (!img?.ok) return { type: "text", value: output };
      return {
        type: "content",
        value: [
          { type: "text", text: output },
          { type: "image-data", data: img.data, mediaType: img.mediaType },
        ],
      };
    },
  });

  const diagram = tool({
    description:
      "亲自画一张演示图（不是调用生图模型）：流程图、架构图、时序图、状态机、ER 图、" +
      "思维导图、时间线、关系网络。你写 mermaid 源码，渲染器负责把节点和连线摆整齐 —— " +
      "布局、配色、对齐全都不用你操心，你只管把节点和关系写对。\n" +
      "图的价值在关系完整：层级、分支、循环、例外路径都要如实画出来。" +
      "几十个节点、五六层嵌套、来回循环都是正常的 —— 宁可一张写全的大图，" +
      "也不要几张各说一半的小图；为省事压缩或省略节点，等于把图毁了。\n" +
      "复杂结构分层表达：同层归 subgraph，跨层连边，循环和双向关系照实写。\n" +
      "**凡是给他看结构，必须当场调用本工具出图，不许用文字示意或口头描述代替** —— " +
      "「大概是这样：A → B → C」这种不算画图。\n" +
      "要画有质感、有情绪的艺术图（插画、封面、场景、角色）用 draw —— 那是另一条路：模型生成，画不了精确结构。",
    inputSchema: z.object({
      mermaid: z
        .string()
        .describe(
          "完整的 mermaid 源码（别包 ``` 围栏，也别加解释）。第一行声明图型：" +
            "flowchart（流程/架构/关系网络）、sequenceDiagram（时序）、stateDiagram-v2（状态机）、" +
            "classDiagram（类/结构）、erDiagram（实体关系）、mindmap（思维导图）、timeline（时间线）、" +
            "pie / gantt / gitGraph。\n" +
            "写法要点：节点 id 用短英文，label 带特殊字符（括号、引号）就用引号包住；" +
            "箭头写 --> 与 -.->，双向和循环用 A <--> B 或两条单向；连线文字用 |标签|；" +
            "分层用 subgraph 名字 … end。\n" +
            "别手写坐标和颜色 —— 渲染器全包。\n" +
            "节点写全、关系写全：内容是图的命，行数不用省。只有真的堆到上百行才拆，" +
            "且拆之前先把全景那张画出来。",
        ),
      title: z
        .string()
        .describe("这张图叫什么。既是文件名，也是以后回头找它的线索"),
      keep: z
        .boolean()
        .optional()
        .describe(
          "true = 把这张示意图存进记忆（type=image）。他说「以后还要看」「存着」的时候才用",
        ),
    }),
    execute: async ({ mermaid, title, keep }) => {
      const clean = extractMermaid(mermaid);
      if (!clean)
        return (
          "这段源码存不下来：我需要一段 mermaid 图源码，第一行得是图型声明" +
          "（flowchart / sequenceDiagram / stateDiagram-v2 / erDiagram / mindmap 一类）。" +
          "外面别包 ``` 围栏，也别加解释。"
        );
      if (clean.length > MMD_CAP) {
        return `这张图太大了（${Math.round(clean.length / 1024)}KB），拆成几张小图分次画。`;
      }
      const key = sessionKey(ctx.room, ctx.sessionId, "diagram", "mmd");
      await ctx.env.MEMORY_BUCKET.put(key, clean, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      const kept = keep ? keepMemory(ctx, title, key) : "";
      const url = `/api/files/${key}`;
      const lines = clean.split("\n").length;
      return handOff(
        `图已经画好了：${url}`,
        title,
        url,
        `Mermaid 示意 · ${lines} 行`,
        kept,
      );
    },
  });

  const tools: ToolSet = { draw, diagram };

  // 发图不给来客：云盘是同一只桶，他凭一个文件名就能把管理员的图翻出来
  if (ctx.guest) return tools;

  tools.send_image = tool({
    description:
      "把他要的图发到对话里。他说「把那张图给我看看」「上次画的那张呢」的时候用。" +
      "知道文件名就给完整 key（画完时我告诉过你，形如 f/default/draw-1730000000000-9f2c1eab.png）；" +
      "说不清文件名就给 query，我去图像记忆里按画面内容找 —— 但只有当时存过（keep）的图才找得回来。" +
      "无论哪条路，拿到地址后必须把那行 markdown 放进你的回复里，他才看得见。",
    inputSchema: z.object({
      key: z
        .string()
        .optional()
        .describe(
          "云盘文件名，形如 draw-1730000000000.png、diagram-1730000000000.mmd（mermaid 示意图）" +
            "或 diagram-*.svg（早先画的旧图）",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "想找哪张图：按画面内容去图像记忆里搜，比如「弹道示意图」「那张蓝猫」",
        ),
      note: z
        .string()
        .optional()
        .describe("配一句话说明这是什么，会写进图片的替换文字里"),
    }),
    execute: async ({ key, query, note }) => {
      const found = await findImage(ctx, key, query);
      if (!found) {
        return key?.trim()
          ? `云盘里没有这个文件：${key}`
          : "图像记忆里没找到对得上的图。要么他说的不是这个说法，要么那张图当时没存下来 —— 没存的话得重新画一张。";
      }
      const url = `/api/files/${encodeURIComponent(found.key)}`;
      const alt = note?.trim() || found.content.slice(0, 30) || "图片";
      const seen = found.content ? `这是当时存下的：${found.content}\n\n` : "";
      const fallbackNote = found.fallback
        ? "\n\n（检索没通，这是最近存的一张，不一定是他要的那张 —— 跟他说清楚。）"
        : "";
      return `${seen}把下面这行原样放进你的回复里（别改动括号里的地址）：\n![${alt}](${url})${fallbackNote}`;
    },
  });

  return tools;
}

/**
 * 交图给模型时统一说同一套话。图是这条工具唯一的产出，模型很容易只回一句「画好了」，
 * 人就什么都看不见 —— 所以反复叮嘱把那行 markdown 放进回复。工具卡另有兜底渲染（前端的 Drawn），
 * 但正文里那张图才是他要的位置。
 */
export function handOff(
  lead: string,
  alt: string,
  url: string,
  meta: string,
  kept: string,
): string {
  // 方括号会把那一行 markdown 本身拆散（前端是按 ![…](…) 认图的），所以替换文字里不留方括号
  const safe = alt.replace(/[[\]]/g, "");
  return (
    `${lead}\n\n` +
    `把下面这行原样放进你的回复里，他就能看到图（别改动括号里的地址）：\n` +
    `![${safe}](${url})\n\n` +
    `（${meta}）${kept}`
  );
}

/**
 * 画完让她自己看一眼：这里只说「看什么、不对怎么办」，图已随结果递回（见 toModelOutput）。
 * 不走看图工具：图在手上，多一跳就多一次她忘记看的可能；且只在下一步生效，
 * 历史里只留这行文字，图不会每轮重发（白烧 token）。
 */
export function selfCheck(n: number): string {
  if (n <= 1)
    return "这张图就在下面，你自己看一眼：脸崩了、手指多出来、主体不是我要的、糊成一团，就改一版提示词再画一次（最多一次）。";
  return "这版是重画过的了，就用它：别再画第三版，把图给他，顺口说一句这版改了什么。";
}

/** 从工具结果那段文字里把云盘文件名抠回来（handOff 写进去的那个地址） */
export function imageKeyIn(text: string): string | null {
  const m = /!\[[^\]]*\]\(\/api\/files\/([^)\s]+)\)/.exec(text);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 「存着」的那张才进记忆：说明写画面本身（检索靠它命中），原件的指针是 key。
 * keep 是 opt-in —— 不设闸的话，画得越多记忆库越像图床，检索会被废图淹掉。
 */
function keepMemory(ctx: ToolCtx, content: string, fileKey: string): string {
  // 来客那档关了记忆：图仍留在云盘（点开能看），但不能从这条侧路绕过档位把行写进记忆库 ——
  // 档位承诺的是「不落库」，不是「少落一条」
  if (ctx.guest && ctx.guestType && !guestHasTool(ctx.guestType, "memory"))
    return "\n（他这一档没开记忆，图只放在云盘，没有进记忆库。）";
  try {
    const mem = insertMemory(ctx.sql, {
      type: "image",
      content: content.slice(0, 300),
      title: "",
      fileKey,
      shelf: "knowledge",
    });
    ctx.enqueueVector({
      id: mem.id,
      content: content.slice(0, 300),
      type: "image",
      shelf: "knowledge",
      tags: mem.tags,
    });
    return `\n已存进记忆 [${mem.id}]，以后搜这段描述能找回来。`;
  } catch {
    return "\n（想顺手存进记忆，但记忆库没写成——图本身是好的，要存的话回头用 memory add 补一条。）";
  }
}

/** 她要发的那张图：给文件名就直接认，给关键词就去图像记忆里找（只认存成 image 的那些） */
async function findImage(
  ctx: ToolCtx,
  key?: string,
  query?: string,
): Promise<{ key: string; content: string; fallback?: boolean } | null> {
  const k = (key || "").trim();
  if (k) {
    const obj = await ctx.env.MEMORY_BUCKET.head(k);
    return obj ? { key: k, content: "" } : null;
  }
  const q = (query || "").trim();
  if (!q) return null;
  try {
    // 统一入口：场屋连主屋的图像记忆一起搜（别场存过的图这边也找得回）
    const hits = ctx.searchMemories
      ? await ctx.searchMemories(q, 8)
      : await searchMemories(ctx.sql, ctx.env, q, 8, {
          cache: ctx.recallCache,
        });
    const hit = hits.find((e) => e.type === "image" && e.fileKey);
    if (hit) return { key: hit.fileKey, content: hit.content };
    // 查询没命中就照实说没找到：把最近一张顶上去，八成不是他要的那张 ——
    // 「不是上次那张图」比「没找到」更伤信任
    return null;
  } catch {
    // 向量检索没通才退到最近存的一张兜底；外层会说明这是备选
  }
  const rows = ctx.sql<{ file_key: string; content: string }>`
    SELECT file_key, content FROM memories
    WHERE type = 'image' AND file_key != '' AND superseded_by = ''
    ORDER BY learned DESC LIMIT 1`;
  const r = rows[0];
  return r ? { key: r.file_key, content: r.content, fallback: true } : null;
}

/**
 * 模型常把源码包在 ``` 围栏里或前后带解释：有围栏取围栏内，没围栏从第一行图型声明取到结尾。
 * 没有图型声明的不算 mermaid 图，前端也渲不出东西，宁可让她重发。
 */
const MMD_HEADS =
  /^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|mindmap|journey|gantt|pie|gitGraph|timeline|zenuml|sankey-beta|architecture-beta|quadrantChart|xychart-beta|block-beta|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;

export function extractMermaid(raw: string): string | null {
  const fenced = /```(?:mermaid)?[^\n]*\n([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const lines = body.split("\n");
  const headAt = lines.findIndex(
    (l) =>
      l.trim() !== "" && !l.trim().startsWith("%%") && MMD_HEADS.test(l.trim()),
  );
  if (headAt < 0) return null;
  // 图头前面紧挨着的 %% 注释行是源码的一部分，带上；再往前的解释文字才是要剔的
  let start = headAt;
  while (start > 0) {
    const prev = lines[start - 1].trim();
    if (prev === "" || prev.startsWith("%%")) start--;
    else break;
  }
  return lines.slice(start).join("\n").trim() || null;
}

// ── 出图（配置驱动，见 drawConfigs.ts）──────────────────

/** 从 env 里按变量名取 key；不是字符串一律当没配（和 tts.ts 那处同一套写法） */
function envKey(env: Env, name: string): string {
  const v = (env as unknown as Record<string, unknown>)[name || ""];
  return typeof v === "string" ? v : "";
}

/**
 * 按一档配置出一张图。没配好（缺 key、缺端点、接口栽了）不算异常 ——
 * push 一条人话原因就返回 null，让降级链接着走；全链都栽了才报错。
 */
async function drawWith(
  env: Env,
  cfg: DrawConfig,
  prompt: string,
  ref: string | null,
  shape: keyof typeof SIZES,
  w: number,
  h: number,
  errors: string[],
): Promise<{ bytes: ArrayBuffer; meta: string } | null> {
  // 带了参考图就必须图生图：这家吃不下就直说、跳过这档，别把参考图默默扔了
  // 当纯文生图画 —— 没有参考的那张根本不是他要的
  if (ref && !supportsReference(cfg.format)) {
    errors.push(`${cfg.label}：这家不支持参考图（图生图），跳过`);
    return null;
  }
  if (cfg.format === "workers-ai")
    return workersAiDraw(env, cfg, prompt, w, h, errors);
  return externalDraw(env, cfg, prompt, ref, shape, errors);
}

/**
 * 哪些格式吃得下参考图：只有 MiniMax（subject_reference 人物主体参考）。
 * 其余几家（workers-ai / siliconflow / zhipu）的出图端点只认文字；智谱 GLM-Image 有图生图能力，
 * 开放 API 还没开这个入参。
 */
export function supportsReference(format: DrawFormat): boolean {
  return format === "minimax";
}

/**
 * workers-ai 档：走 Workers AI 绑定。模型入参是 multipart 表单（不是 JSON），
 * 所以把 FormData 包成 Response 再取 body 交给 run。回的是 base64，省一次下载；
 * models 取第一个 —— 绑定内没有「换一家再试」，换模型就是改配置。
 */
async function workersAiDraw(
  env: Env,
  cfg: DrawConfig,
  prompt: string,
  w: number,
  h: number,
  errors: string[],
): Promise<{ bytes: ArrayBuffer; meta: string } | null> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai) {
    errors.push(`${cfg.label}：没绑 Workers AI`);
    return null;
  }

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(w));
  form.append("height", String(h));
  const wrapped = new Response(form);

  const out = (await ai.run(cfg.models[0], {
    multipart: {
      body: wrapped.body,
      contentType: wrapped.headers.get("content-type") || "multipart/form-data",
    },
  })) as { image?: string };
  if (!out?.image) {
    errors.push(`${cfg.label}：回里没有图`);
    return null;
  }
  // 成了才记账：烧的是 CF 的 neurons 额度（见 usage.ts），失败的那几次不算
  usage.noteFluxImage(w, h);
  return { bytes: fromBase64(out.image), meta: `${cfg.label} · ${w}x${h}` };
}

/**
 * 端点留空时的默认出图地址（与 web 面板的格式预设一致，见
 * web/src/lib/presets.ts 的 DRAW_FORMAT_DEFAULTS）；配了就用配的。
 */
const DRAW_DEFAULT_ENDPOINTS: Record<DrawFormat, string> = {
  "workers-ai": "",
  siliconflow: "https://api.siliconflow.cn/v1/images/generations",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/images/generations",
  minimax: "https://api.minimax.cn/v1/image_generation",
};

/**
 * 外部三家（siliconflow / zhipu / minimax）共用：端点、模型、key 变量名全来自配置；
 * 差异只剩入参/回包形状（按 format 分岔）：
 *   siliconflow —— image_size，回 images[].url（临时桶一小时过期，须当场下进云盘）；
 *   zhipu       —— size，回 data[].url 或 b64_json；
 *   minimax     —— aspect_ratio，回 data.image_base64（或 image_urls，24 小时过期），唯一支持图生图。
 */

/**
 * 三家的请求体（纯函数，好测）。参考图只在 minimax 有落点：subject_reference 带一张图
 * （data URI 或公网 URL），保留人物/主体特征再按 prompt 出新图 —— 官方限单图，类型目前只有 character。
 */
export function requestBody(
  format: DrawFormat,
  model: string,
  prompt: string,
  size: string,
  ref: string | null,
): Record<string, unknown> {
  if (format === "siliconflow")
    return { model, prompt, image_size: size, batch_size: 1 };
  if (format === "minimax")
    return {
      model,
      prompt,
      aspect_ratio: size,
      response_format: "base64",
      n: 1,
      ...(ref
        ? { subject_reference: [{ type: "character", image_file: ref }] }
        : {}),
    };
  return { model, prompt, size };
}

async function externalDraw(
  env: Env,
  cfg: DrawConfig,
  prompt: string,
  ref: string | null,
  shape: keyof typeof SIZES,
  errors: string[],
): Promise<{ bytes: ArrayBuffer; meta: string } | null> {
  const apiKey = envKey(env, cfg.keySecret);
  if (!apiKey) {
    errors.push(`${cfg.label}：${cfg.keySecret || "key 变量名"} 没配`);
    return null;
  }
  // 端点留空 = 用这一家的默认地址（和读音那条线的兜底一个规矩）
  const endpoint = cfg.endpoint.trim() || DRAW_DEFAULT_ENDPOINTS[cfg.format];
  if (!endpoint) {
    errors.push(`${cfg.label}：出图端点没配`);
    return null;
  }
  const size =
    cfg.format === "siliconflow"
      ? SF_SIZES[shape]
      : cfg.format === "minimax"
        ? MM_RATIOS[shape]
        : `${SIZES[shape].w}x${SIZES[shape].h}`;
  for (const model of cfg.models) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(requestBody(cfg.format, model, prompt, size, ref)),
      });
      if (!r.ok) {
        errors.push(
          `${cfg.label}/${model}：HTTP ${r.status} ${(await r.text()).slice(0, 120)}`,
        );
        continue;
      }
      const j = (await r.json()) as {
        images?: Array<{ url?: unknown }>;
        data?: unknown;
      };
      const first = pickImage(cfg.format, j);
      const bytes = await fetchImage(first.url, first.b64);
      if (!bytes) {
        errors.push(`${cfg.label}/${model}：没拿到图`);
        continue;
      }
      // 硅基流动的模型名带命名空间（Tongyi-MAI/Z-Image-Turbo），标注取短名
      const short =
        cfg.format === "siliconflow"
          ? (model.split("/").pop() ?? model)
          : model;
      return {
        bytes,
        meta: `${short} · ${cfg.label} · ${size}${ref ? " · 图生图" : ""}`,
      };
    } catch (e) {
      errors.push(
        `${cfg.label}/${model}：${(e as Error).message.slice(0, 120)}`,
      );
    }
  }
  return null;
}

/**
 * 三家的回包形状不同，这里统一挑出第一张（临时地址或 base64 二选一）：
 * siliconflow 回 images[].url；zhipu 回 data[].url / b64_json；
 * minimax 回 data.image_base64（base64 优先，url 形式 24 小时过期）。
 */
function pickImage(
  format: DrawFormat,
  j: { images?: Array<{ url?: unknown }>; data?: unknown },
): { url: unknown; b64: unknown } {
  if (format === "siliconflow")
    return { url: j.images?.[0]?.url, b64: undefined };
  if (format === "minimax") {
    const d = j.data as
      | { image_base64?: unknown[]; image_urls?: unknown[] }
      | undefined;
    return { url: d?.image_urls?.[0], b64: d?.image_base64?.[0] };
  }
  const d = (
    j.data as Array<{ url?: unknown; b64_json?: unknown }> | undefined
  )?.[0];
  return { url: d?.url, b64: d?.b64_json };
}

/** base64 → 字节。Worker 里没有 Buffer，只能一个字符一个码地还回去 */
function fromBase64(b64: string): ArrayBuffer {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/** 供应商可能回一个临时地址，也可能直接回 base64；两种都接住 */
async function fetchImage(
  url: unknown,
  b64: unknown,
): Promise<ArrayBuffer | null> {
  if (typeof url === "string" && url) {
    // 这个地址来自第三方供应商的回包，不能当可信输入：过一遍白名单（逐跳校验），
    // 免得被诱导去读内网 / 云元数据端点（与 search 那侧同一条护栏）
    const r = await publicFetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return buf.byteLength ? buf : null;
  }
  if (typeof b64 === "string" && b64) return fromBase64(b64);
  return null;
}
