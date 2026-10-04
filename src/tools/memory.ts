// 记忆图书馆：长期记忆的增删查。底层是 memories 表 + Vectorize 语义检索。

import { tool } from "ai";
import { z } from "zod";
import {
  ageLabel,
  confirmMemory,
  deleteMemory,
  deleteVector,
  findConflicts,
  getMemory,
  insertMemory,
  listConflicted,
  listDueForReview,
  listMemories,
  listMemoriesByPerson,
  listPersons,
  listSuperseded,
  memoryStats,
  getMemoryByDedupeKey,
  needsReview,
  restoreMemory,
  reviewRef,
  searchMemories,
  setConflicts,
  setVolatility,
  settleConflicts,
  supersedeMemory,
} from "../agent/memory";
import { SHELVES, type MemEntry } from "../agent/state";
import { OWNER_AGENT } from "../auth";
import type { ToolCtx } from "./types";

/**
 * 工具输出里统一带上「学到多久了」——新旧是我判断要不要先确认一句的唯一依据。
 * 会变又久没确认的，再挂一个 ⚠️：那是「该问一句了」的意思，不是「这条错了」。
 * ❓ 是另一回事：这条和某条旧说法像在说同一件事，还没弄明白哪个算数。
 */
function line(e: MemEntry): string {
  const bits = [`[${e.id}]`, `[${e.shelf} · 学到${ageLabel(e.learned)}`];
  if (e.person) bits[1] += ` · ${e.person}`;
  // 事情从什么时候开始成立：和我什么时候听说它常常是同一天，不同才值得说
  if (e.validAt && e.validAt.slice(0, 10) !== e.learned.slice(0, 10))
    bits[1] += ` · 这件事自 ${e.validAt.slice(0, 10)} 起`;
  bits[1] += "]";
  if (e.supersededBy)
    bits[1] += ` ⚠️已作废${e.invalidAt ? `（失效于${ageLabel(e.invalidAt)}）` : ""}`;
  else if (needsReview(e))
    bits[1] += ` ⚠️会变·${ageLabel(reviewRef(e))}没确认过`;
  if (e.conflictsWith.length)
    bits[1] += ` ❓还没对上 ${e.conflictsWith.join("、")}`;
  // 书册用标题开头——检索结果里先看到「这是什么」，正文在后面
  const body =
    e.type === "book" && e.title
      ? `「${e.title}」 ${e.content}`
      : e.type === "image"
        ? `📷 ${e.content}（云盘 key：${e.fileKey}）`
        : e.content;
  return `${bits.join(" ")} ${body}`;
}

export function memoryTools(ctx: ToolCtx) {
  return {
    memory: tool({
      description:
        "长期记忆管理。search 语义+关键词混合检索（回答问题前先查，避免重复问已经知道的事）；" +
        "add 写入一条新记忆，可指定 person 归属某个人（人脉记忆见 people）；" +
        "一句话说不清的成体系知识（文章、教程、整理过的主题笔记）用 type=book 存、title 必填；" +
        "值得记住的图用 type=image 存、fileKey 必填；" +
        "如果这条新说法推翻了某条旧的（同一件事、旧的不再成立），把旧记忆的 id 填进 replaces，" +
        "系统会把旧的作废——不要让两条并存，并存的话我下次检索到哪条全看运气；" +
        "supersede 只作废不新增（比如当事人说「那个不算了」）；restore 撤销作废；" +
        "history 看已作废的历史版本；list 按书架浏览；people 列出所有人的记忆条数；" +
        "person_lookup 查某人的全部记忆；delete 按 id 删除；stats 看总量。" +
        "另外两个是关于「记忆会不会过期」的：due_for_review 列出该复核的（说的是现状、又有一阵没核对的那些）；" +
        "confirm 表示我刚跟本人核对过、它现在还是这样——把 id 给它，它就不再挂在待复核里" +
        "（顺带可以用 volatility 把标错的改过来）。" +
        "还有两个是关于「两句话对不上」的：add 完我会当场告诉你这条和哪几条像在说同一件事（❓），" +
        "conflicts 看还有哪些悬着的；确实不是一回事就用 coexist 把疑问销掉——" +
        "疑问不是错误，但一直悬着，我下次检索到哪条就全看运气了。" +
        "返回里每条都带「学到多久了」，标着 ⚠️ 的是该先确认再当实情讲的那些。" +
        `书架只能从这些里选：${SHELVES.join(" / ")}。` +
        "add 时要标量级（sensitivity）——它决定这条能不能按 tag 放给来客看。" +
        "先在心里算个分（score）：事理重要度（1-3）+ 调动频率（1-3）+ 是否强调（1-3），三项相加：" +
        "0-3 分标 normal（一般），4-7 分标 important（重要），8-9 分标 secret（机密），" +
        "日常琐碎、过些天谁都不会再提的标 trivial（不重要）；score 填你算出的分，" +
        "面板上要拿它当依据看。topsecret（绝密）不由你标 —— 那是管理员的锁，你手里没有这把钥匙。",
      inputSchema: z.object({
        action: z.enum([
          "search",
          "add",
          "list",
          "people",
          "person_lookup",
          "supersede",
          "restore",
          "history",
          "confirm",
          "due_for_review",
          "conflicts",
          "coexist",
          "delete",
          "stats",
        ]),
        query: z.string().optional().describe("search 时的检索词"),
        content: z
          .string()
          .optional()
          .describe("add 时的记忆内容，尽量一句话说清"),
        type: z
          .enum(["insight", "fact", "update", "book", "image"])
          .default("insight")
          .describe(
            "insight/fact/update 是一句话的条目；book 是书册（成体系的文章/教程/整理过的长知识，配 title）；" +
              "image 是图像记忆（一张值得记住的图，配 fileKey）",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "type=book 时的标题。检索是靠它先认出「这是什么」，没标题的书册等于没写",
          ),
        fileKey: z
          .string()
          .optional()
          .describe(
            "type=image 时图在云盘里的 key（画完的图我会拿到 key，他发来的图在附件说明里也有）",
          ),
        shelf: z.enum(SHELVES).default("knowledge"),
        person: z
          .string()
          .optional()
          .describe("add 时该记忆归属的人物名，人脉记忆填这个人"),
        tags: z.array(z.string()).optional(),
        sensitivity: z
          .enum(["trivial", "normal", "important", "secret"])
          .optional()
          .describe(
            "add 时的量级，按 description 里的评分公式算分定档；不填按「一般」处理。" +
              "枚举里没有 topsecret —— 绝密不由你标",
          ),
        score: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe(
            "add 时评分公式算出的分（0-9）：事理重要度 + 调动频率 + 是否强调，三项各 1-3。" +
              "它是量级的依据，和 sensitivity 一起填",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "delete / supersede / restore / confirm / coexist 时的记忆 id",
          ),
        replaces: z
          .string()
          .optional()
          .describe(
            "add 时，如果这条推翻了某条旧记忆（同一件事的新说法），填被推翻那条的 id",
          ),
        validFrom: z
          .string()
          .optional()
          .describe(
            "add 时，这件事从什么时候开始成立（ISO 日期）。只在当事人明说了的时候填" +
              "（「我从去年就开始做这个」）；没说就别填——默认就是今天，也就是我听说它的日子",
          ),
        volatility: z
          .enum(["stable", "volatile"])
          .optional()
          .describe(
            "这条会不会变：说的是他是谁、什么一直成立填 stable；说的是他现在怎么样填 volatile" +
              "（年龄、在读、在做什么、和谁还热络、什么还成立，都是会变的那些）。" +
              "会变的到点会回到复核清单里；confirm 时填它可以把标错的改过来",
          ),
        includeSuperseded: z
          .boolean()
          .default(false)
          .describe("list/search 是否连已作废的也返回"),
        limit: z.number().int().min(1).max(50).default(5),
      }),
      execute: async (a) => {
        const { sql, env } = ctx;

        // 写记忆的动作先清轮内检索缓存：刚记下/刚作废的话必须当场搜得到，
        // 这条永远比省一次向量查询重要
        if (
          a.action === "add" ||
          a.action === "supersede" ||
          a.action === "restore" ||
          a.action === "confirm" ||
          a.action === "delete"
        )
          ctx.recallCache?.clear();

        if (a.action === "stats") {
          // 统一入口：场屋本地盘加主屋盘（ctx 没配就本地直盘）
          const s = ctx.statsMemories
            ? await ctx.statsMemories()
            : memoryStats(sql);
          if (!s.total) return "记忆库为空。";
          return (
            `📚 还算数的 ${s.total - s.gone} 条${s.gone ? `（另有 ${s.gone} 条已被新说法作废，可 history 回看）` : ""}：\n` +
            s.shelves.map((r) => `[${r.shelf}] ${r.n} 条`).join("\n") +
            (s.due
              ? `\n🕰 其中 ${s.due} 条是关于现状、又有一阵没核对的，due_for_review 可以看是哪些。`
              : "") +
            (s.unsettled
              ? `\n❓ 还有 ${s.unsettled} 条和别的说法对不上，conflicts 可以看是哪些。`
              : "")
          );
        }

        if (a.action === "conflicts") {
          const items = listConflicted(sql, Math.max(a.limit, 20));
          if (!items.length) return "没有悬着的疑问——记下的每句话都清清爽爽。";
          const body = items.map((e) => {
            const others = e.conflictsWith
              .map((id) => getMemory(sql, id))
              .filter((x): x is MemEntry => !!x)
              .map((o) => `    ↔ ${line(o)}`)
              .join("\n");
            return `• ${line(e)}\n${others}`;
          });
          return (
            "❓ 还没对上的（记下来的时候觉得像在说同一件事）：\n" +
            body.join("\n") +
            "\n是同一件事的新说法：把旧的 id 填进 add 的 replaces，或直接 supersede 旧的；" +
            "确实不是一回事：coexist 把 id 给它，疑问就销了。"
          );
        }

        if (a.action === "coexist") {
          if (!a.id) return "coexist 需要提供 id。";
          const target = getMemory(sql, a.id);
          if (!target) return "找不到这条记忆：" + a.id;
          if (!target.conflictsWith.length)
            return `[${a.id}] 本来就没挂着疑问。`;
          const others = target.conflictsWith
            .map((id) => getMemory(sql, id))
            .filter((x): x is MemEntry => !!x)
            .map((o) => `[${o.id}]「${o.content}」`)
            .join("、");
          settleConflicts(sql, a.id);
          // 疑问销掉的不止一条的记号：两边的「还没对上」都清了，都寄回去
          ctx.syncMemories?.([a.id, ...target.conflictsWith]);
          return `已销掉 [${a.id}] 的疑问：它和 ${others} 确实不是一回事，都留着。`;
        }

        if (a.action === "due_for_review") {
          const items = listDueForReview(sql, Math.max(a.limit, 20));
          if (!items.length)
            return "没有该复核的记忆——关于现状的那些，最近都确认过。";
          return (
            "🕰 该复核的（说的是现状，又有一阵没确认了）：\n" +
            items.map((e) => `• ${line(e)}`).join("\n") +
            "\n跟本人确认过之后，用 confirm 把 id 记一下，它就不会再挂在这儿了。"
          );
        }

        if (a.action === "confirm") {
          if (!a.id) return "confirm 需要提供 id。";
          const target = getMemory(sql, a.id);
          if (!target) return "找不到这条记忆：" + a.id;
          // volatility 只在明确传了的时候才改：没传时 zod 给的是 undefined，
          // 不能拿默认值去覆盖 —— 那会让每次确认都把「会变」悄悄改成「稳定」。
          if (a.volatility) setVolatility(sql, a.id, a.volatility);
          const updated = confirmMemory(sql, a.id);
          ctx.syncMemories?.([a.id]);
          const now = updated?.volatility === "volatile" ? "会变" : "稳定";
          return (
            `已确认 [${a.id}]「${target.content}」——记下它现在还是这样（标着${now}）。` +
            (a.volatility && a.volatility !== target.volatility
              ? "同时改了「会不会变」的标记。"
              : "")
          );
        }

        if (a.action === "people") {
          const groups = listPersons(sql);
          if (!groups.length) return "还没有任何人物记忆。";
          return (
            "👥 所有人脉记忆：\n" +
            groups.map((g) => `• ${g.person}：${g.n} 条`).join("\n")
          );
        }

        if (a.action === "person_lookup") {
          const name = (a.person || a.query || "").trim();
          if (!name) return "person_lookup 需要提供 person 姓名。";
          const items = listMemoriesByPerson(sql, name, a.limit, {
            includeSuperseded: a.includeSuperseded,
          });
          if (!items.length) return `还没有「${name}」的记忆。`;
          return (
            `👤 ${name}（${items.length} 条）：\n` +
            items.map((e) => `• ${line(e)}`).join("\n")
          );
        }

        if (a.action === "list") {
          // 统一入口：场屋本地列加主屋列合并（ctx 没配就本地直列）
          const shelf = a.shelf;
          const items = ctx.listMemoriesMerged
            ? await ctx.listMemoriesMerged(shelf, 50, {
                includeSuperseded: a.includeSuperseded,
              })
            : listMemories(sql, shelf, 50, {
                includeSuperseded: a.includeSuperseded,
              });
          if (!items.length) return `书架「${shelf}」是空的。`;
          return (
            `📚 [${shelf}] ${items.length} 条：\n` +
            items.map((e) => `• ${line(e)}`).join("\n")
          );
        }

        if (a.action === "history") {
          const items = listSuperseded(sql, Math.max(a.limit, 20));
          if (!items.length) return "还没有被作废的记忆。";
          return (
            "🕰 已作废的历史版本（不再参与检索，只是留个说法）：\n" +
            items
              .map(
                (e) =>
                  `• ${line(e)}${e.supersededBy !== "retired" ? ` → 现在作数的是 [${e.supersededBy}]` : ""}`,
              )
              .join("\n")
          );
        }

        if (a.action === "search") {
          if (!a.query) return "search 需要提供 query。";
          // 统一入口：场屋本地加主屋各搜一遍合并去重（ctx 没配就本地直搜）
          const found = ctx.searchMemories
            ? await ctx.searchMemories(a.query, a.limit, {
                includeSuperseded: a.includeSuperseded,
              })
            : await searchMemories(sql, env, a.query, a.limit, {
                includeSuperseded: a.includeSuperseded,
                cache: ctx.recallCache,
              });
          if (!found.length) return "没有相关记忆。";
          return (
            "🔍 相关记忆：\n" + found.map((e) => `• ${line(e)}`).join("\n")
          );
        }

        if (a.action === "supersede" || a.action === "restore") {
          if (!a.id) return `${a.action} 需要提供 id。`;
          const target = getMemory(sql, a.id);
          if (!target) return "找不到这条记忆：" + a.id;
          if (a.action === "restore") {
            restoreMemory(sql, a.id);
            ctx.syncMemories?.([a.id]);
            return `已恢复 [${target.id}] ${target.content}——它重新参与检索了。`;
          }
          if (target.supersededBy) return `[${target.id}] 已经是作废状态了。`;
          supersedeMemory(sql, a.id);
          ctx.syncMemories?.([a.id]);
          return `已作废 [${target.id}] ${target.content}（内容保留，可 history 回看、可 restore 撤销）。`;
        }

        if (a.action === "delete") {
          if (!a.id) return "delete 需要提供 id。";
          const removed = deleteMemory(sql, a.id);
          if (!removed) return "找不到这条记忆：" + a.id;
          await deleteVector(env, removed.id).catch(() => {});
          ctx.syncMemories?.([], [removed.id]);
          return `已删除 [${removed.id}] ${removed.content}`;
        }

        // add
        const content = (a.content || "").trim();
        if (!content) return "add 需要提供 content。";
        if (a.type === "book" && !a.title?.trim())
          return "存书册（type=book）需要提供 title——没有标题，回头连它是什么都认不出。";
        if (a.type === "image" && !a.fileKey?.trim())
          return "存图像记忆（type=image）需要提供 fileKey——说明只是索引，原图的指针不能少。";
        // 回想重跑的幂等保护：insertMemory 遇到同键会原样返回第一次那条，
        // 但拦不住调用方往下走 —— 拿这次的正文去喂向量，向量层说新版、
        // SQLite 里存旧版，检索排序从此和正文对不上。判出重复就整段跳过。
        const dedupeKey = ctx.recapDedupe
          ? `${ctx.recapDedupe}:memory`
          : undefined;
        if (dedupeKey && getMemoryByDedupeKey(sql, dedupeKey))
          return "这一段已经记过了（重跑的幂等保护），不重复入库。";
        const entry = insertMemory(sql, {
          type: a.type,
          content,
          title: a.title,
          fileKey: a.fileKey,
          shelf: a.shelf,
          tags: a.tags || [],
          person: a.person,
          volatility: a.volatility,
          validAt: a.validFrom,
          // 量级跟着分走：模型只填得出四档（绝密不在它的工具里），分是留下的依据
          sensitivity: a.sensitivity,
          score: a.score,
          dedupeKey,
        });
        // 书册的向量取标题加开头：全文几万字，向量化整篇既贵又过不了模型的窗口，
        // 而检索要命中的本来就是「这篇讲什么」
        const forVector =
          a.type === "book"
            ? `${a.title || ""}\n${content.slice(0, 1200)}`
            : content;
        ctx.enqueueVector({
          id: entry.id,
          content: forVector,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });

        // 作废是「旧的那条不再算数」，不是删除：说过的旧话留着，将来解释得清我为什么改口。
        // 这里只认 id，不猜——猜错了会把一条无关的记忆作废掉，比留着旧的更糟。
        let replaced = "";
        let didReplace = false;
        if (a.replaces) {
          if (a.replaces === entry.id) {
            replaced = "（replaces 指向自己，忽略）";
          } else {
            const old = supersedeMemory(sql, a.replaces, entry.id);
            replaced = old
              ? `，同时作废了 [${old.id}]「${old.content}」`
              : `，但没找到要作废的 [${a.replaces}]，本次只新增`;
            didReplace = !!old;
          }
        }

        // 写完立刻回头看有没有旧说法和它像 —— 人也是这样：听到一句新话，当场会想起
        // 「你上次不是说…」。事后专门回头比对，是不会发生的。
        // 挑候选的是代码（两把尺子），判定「算不算同一件事」的是我，
        // 而账本由代码记着：我不能指望自己下次还记得这里有个疑问。
        // 已经指明替代了谁（didReplace）就不必再挑：对错当场就分完了。
        const near = didReplace
          ? []
          : await findConflicts(sql, env, entry).catch(() => []);
        let doubt = "";
        if (near.length) {
          setConflicts(
            sql,
            entry.id,
            near.map((n) => n.entry.id),
          );
          doubt =
            "\n❓ 这条和下面这些像在说同一件事，我把疑问先记下了：\n" +
            near
              .map(
                (n) =>
                  `• [${n.entry.id} · 学到${ageLabel(n.entry.learned)}] ${n.entry.content}（${n.why}）`,
              )
              .join("\n") +
            "\n是同一件事的新说法：把旧的那个 id 填进 replaces 再写一次，或者直接 supersede 旧的；" +
            "确实不是一回事：coexist 把这条的 id 给它，疑问就销了。别放着不管。";
        }

        // 新增 + 被连带改动的（作废的旧条目、挂上疑问的相关条目）一并寄回并账
        ctx.syncMemories?.([
          entry.id,
          ...(didReplace && a.replaces ? [a.replaces] : []),
          ...near.map((n) => n.entry.id),
        ]);

        return (
          `已记忆 [${entry.id}] ${entry.type} · ${entry.shelf}${entry.person ? ` · ${entry.person}` : ""} · 学到${ageLabel(entry.learned)}` +
          ` · ${entry.volatility === "volatile" ? "会变（到点我会回来复核）" : "稳定"}` +
          (entry.validAt.slice(0, 10) !== entry.learned.slice(0, 10)
            ? ` · 这件事自 ${entry.validAt.slice(0, 10)} 起`
            : "") +
          replaced +
          doubt
        );
      },
    }),
  };
}

/**
 * 来客那间的记忆：读得到两档，写进的是他名下的。
 *
 * 「来客也是记忆的输入方」——这句话落到代码上就是这一条。但读是受限读：
 * 翻得到的是管理员公开过的 + 他自己名下的（按归属键 owner_key = room:<本间屋名>），
 * private 的主体一个字都不出管理员那间屋。过滤在 searchMemories 的 SQL 里完成，
 * 不靠提示词自觉。
 *
 * 归属跟验证过的身份走，不跟称呼走：房间名是 Worker 按签名票（或身份卡绑定）派生的，
 * 客人自己报什么称呼都改不了它。持卡的长使用者回的是卡绑定的那间屋，换设备也翻得回来；
 * 无卡的身份没有可核实的持久归属，重新登录就是新的屋子 —— 称呼从此只是待人接物的叫法，
 * 不再是钥匙。从前的「报上名字就翻得出别人名下的记录」正是要堵的那个洞。
 *
 * 两边都留：本地留一份（这一场里我还认得他），管理员那边也留一份。
 * 为什么不能只留管理员那边：来客那间是被清理过的房间，只放那边的话，
 * 这一场聊到一半我就把自己刚记的东西忘了。
 * 为什么不能只留本地：那他说的就白说了 —— 管理员永远不知道有人来过、说了什么。
 *
 * 合并成一句话：他说给的是管理员，我记下的也是管理员的东西，只是我暂时替他拿着。
 */
export function guestMemoryTools(ctx: ToolCtx) {
  return {
    memory: tool({
      description:
        "这间屋子的记忆。add 记下他刚说的——关于他自己的事，或他托我转交给管理员的话（管理员那边也留一份，我不瞒他）；" +
        "search 翻记忆库——翻得到的是管理员公开过的 + 他自己名下记过的，别处翻不到；翻不到就照实说，别编：" +
        "编出来的记忆会让他误以为真有这条记录；" +
        "whoami 把他自报的称呼记下来——这只是待人接物的叫法；他名下的记忆跟着他的身份卡走" +
        "（持卡的客人回自己的屋就翻得到），不跟着称呼走；" +
        "值得下次用上的（他在做什么、在意什么、忌讳什么）我记；他特意托我转交的，一句也算数；随口寒暄不必记。",
      inputSchema: z.object({
        action: z
          .enum(["add", "search", "whoami"])
          .describe(
            "add 记下他说的事；search 翻公开与他名下的；whoami 记下他的称呼",
          ),
        content: z
          .string()
          .optional()
          .describe("add 时要记住的那句话，尽量一句话说清"),
        query: z
          .string()
          .optional()
          .describe("search 时的检索词——他说「还记得吗」时就拿他的原话来搜"),
        person: z.string().optional().describe("whoami 时填他自报的称呼"),
        shelf: z
          .enum(SHELVES)
          .default("people")
          .describe("关于他本人的事一般放在 people"),
        tags: z.array(z.string()).optional(),
        volatility: z
          .enum(["stable", "volatile"])
          .optional()
          .describe(
            "说的是他一直如此填 stable，说的是他现在的状况填 volatile；分不清就留空",
          ),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      execute: async (a) => {
        // 写记忆先清轮内检索缓存：刚记下的话必须当场搜得到
        if (a.action === "add") ctx.recallCache?.clear();

        if (a.action === "whoami") {
          const name = (a.person || "").trim().slice(0, 20);
          if (!name) return "whoami 需要提供 person：他自报的称呼。";
          ctx.patchState({ guestName: name });
          return (
            `记下了，他就叫「${name}」，我就按这个称呼待人。` +
            "名下的记忆跟着他的身份走：持卡的客人回自己的屋子就翻得回来，称呼本身不是钥匙。"
          );
        }

        if (a.action === "search") {
          const q = (a.query || "").trim();
          if (!q) return "search 需要提供 query。";
          // 先走主人那间的受限读（公开 + 本间屋名下的）；主人那间没醒就退回本地这一场的存底。
          // 归属键是这间屋子自己的名字（Worker 按票派生的），不从自报称呼取
          let lines: string[] = [];
          try {
            const owner = ctx.env.COWORK_AGENT.get(
              ctx.env.COWORK_AGENT.idFromName(OWNER_AGENT),
            );
            lines =
              (await owner.guestReadableMemories(
                q,
                `room:${ctx.room}`,
                a.limit,
              )) || [];
          } catch {
            // 主人那间没醒，用本地兜底
          }
          if (!lines.length) {
            const local = await searchMemories(ctx.sql, ctx.env, q, a.limit, {
              cache: ctx.recallCache,
            }).catch(() => []);
            lines = local.map(line);
          }
          if (!lines.length) {
            return (
              "没有相关记忆——管理员公开过的和他名下记过的都没翻到。" +
              (ctx.state.guestName
                ? ""
                : "我还不知道该怎么称呼他，聊到名字时用 whoami 记一下。")
            );
          }
          return (
            "🔍 翻到的（管理员公开过的 + 他名下记过的）：\n" +
            lines.map((l) => `• ${l}`).join("\n")
          );
        }

        // add
        const content = (a.content || "").trim();
        if (!content) return "add 需要提供 content。";
        // 老实例的 state 里可能没有 guestName 这一格，读的时候自己兜住 ——
        // 这里抛出去，add 就永远回不了一句话，他看到的是「她不吭声」。
        const name = (ctx.state.guestName || "").trim().slice(0, 20);

        const entry = insertMemory(ctx.sql, {
          type: "fact",
          content,
          shelf: a.shelf,
          tags: a.tags || [],
          volatility: a.volatility,
          // person 只管展示；授权归属跟本间屋的房间键走（上报主人房时带上）
          person: name ? `来客·${name}` : "",
        });
        ctx.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });

        // 上报给管理员那边。他那边没醒、或者调用出错，都不该让「我记住了」这件事失败 ——
        // 本地那一份已经落地了，这里只是多留一份。
        // ownerKey 是本间屋子自己的名字：Worker 按票派生的，自报称呼改不动它
        try {
          const owner = ctx.env.COWORK_AGENT.get(
            ctx.env.COWORK_AGENT.idFromName(OWNER_AGENT),
          );
          await owner.receiveGuestMemory({
            content,
            shelf: entry.shelf,
            tags: entry.tags,
            volatility: entry.volatility,
            person: name || undefined,
            ownerKey: `room:${ctx.room}`,
          });
        } catch {
          // 管理员那边暂时没收到，但这不影响我已经记下了
        }

        return (
          `已记住：${entry.content}` +
          (name
            ? `（记在他名下：来客·${name}）`
            : "（还不知道怎么称呼他——聊到名字时用 whoami 记一下，下次就认得、翻得出来）")
        );
      },
    }),
  };
}
