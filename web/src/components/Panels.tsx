// ─────────────────────────────────────────────────────────────
// hr-desk · 管理面板（前半）：记忆书架 / 任务 / 技能 / 提醒 / 额度 / 联系人
//
// 旧 Panels.tsx 近两千行，拆成三份：
//   · PanelsShared.ts —— 常量与纯工具（两个组件文件共用，谁也不依赖谁）；
//   · Panels.tsx（本文件）—— 前半的面板，并对外再导出全部工具；
//   · Panels2.tsx —— 后半的面板（账本 / 文件 / 自我认知 / 守则 / 会话 / 嗓音 / 来客）。
// 依赖方向只许向前：Panels → Panels2 / PanelsShared，不许回头，循环就无从谈起。
// 样式在 Panels.css：白纸黑字 —— 白底、灰阶、发丝线、黑色块。
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  SHELVES,
  SHELF_LABEL,
  SENSITIVITIES,
  SENSITIVITY_LABEL,
  TAG_GATE_LEVELS,
  type ChatState,
  type MemEntry,
  type Reminder,
  type Sensitivity,
  type Shelf,
  type TagGate,
  type TagStat,
  type UsageReport,
} from "../lib/types";
import { Icon, type IconName } from "./Icons";
import { zoomIn } from "./Lightbox";
import {
  EntityAddButton,
  EntityNote,
  EntityRow,
  FormDialog,
  FormRow,
  FormSection,
  useDraft,
} from "./FormDialog";
import {
  DEFAULT_MEMORY_SHELF,
  MAX_MEMORY_CONTENT,
  contentSnippet,
  gateLevelLabel,
  memoryContentTooLong,
  memoryMissingFields,
  memoryPayloadOf,
  tagStatSummary,
  type MemoryDraft,
} from "../lib/memoryForm";
import {
  MAX_PERSON_CHARS,
  contactMissingFields,
  contactPayloadOf,
  hasGuestPerson,
  isGuestPerson,
  personNameTooLong,
  personSummary,
  type ContactDraft,
} from "../lib/contactForm";
import { ageText, fmtWhen, needReview, type Patch } from "./PanelsShared";
import "./Panels.css";
import "./PanelsLists.css";

// 对外契约：旧 Panels.tsx 的全部非组件导出，一个不少地在这里再导出
// （Messages.tsx 从这里拿 toolMeta，Pages.tsx 从这里拿 deviceId）。
export {
  TOOL_META,
  TOOL_FALLBACK,
  toolMeta,
  ageText,
  needReview,
  deviceId,
} from "./PanelsShared";

// 后半部分的面板从这里挂出去。Panels2 只依赖 PanelsShared，
// 不会回头引用本文件 —— 这条单向依赖是拆文件的底线。
export * from "./Panels2";

// 量级的轻重序（SENSITIVITIES 的下标）：tag 门放行时「量级不超门槛」的比较用
const sensRank = (s: string) => SENSITIVITIES.indexOf(s as Sensitivity);

// 内置类型名：AI 写记忆时会自动把 type 塞进 tags —— 给这类 tag 开门，
// 等于把一个类型整个放出去，比普通 tag 的门宽得多。开门前该多看一眼。
const TYPE_TAGS = new Set(["insight", "fact", "update", "book", "image"]);

/** 新增记忆的起手草稿：架子落在「知识」，和旧的那根输入条同一个默认值 */
const blankMemoryDraft = (): MemoryDraft => ({
  content: "",
  shelf: DEFAULT_MEMORY_SHELF,
  tags: "",
  volatility: "stable",
});

/** 人脉的起手草稿：人还没名字，正文也空着 */
const blankContactDraft = (): ContactDraft => ({
  person: "",
  content: "",
  tags: "",
  volatility: "stable",
});

function Row({
  children,
  onDelete,
  actions,
}: {
  children: React.ReactNode;
  onDelete?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <li className="row">
      <div className="row-main">{children}</div>
      {actions}
      {onDelete && (
        <button
          className="row-del"
          onClick={onDelete}
          title="删除"
          aria-label="删除"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </li>
  );
}

/**
 * 记忆行：记忆面板和人物面板看的是同一批数据，展示也该是同一套 ——
 * 否则「会变 / 待复核」只在一处出现，另一处看着就像在说谎。
 */
function MemRow({
  m,
  showWeight,
  gateLevelOf,
  onRetire,
  onConfirm,
  onVolatility,
  onVisibility,
  onSensitivity,
  onCoexist,
  onDelete,
}: {
  m: MemEntry;
  showWeight?: boolean;
  /** tag 门槛账本（记忆面板传入）：算「按tag公开中」标签用；不传就不显示这一路 */
  gateLevelOf?: (tag: string) => string;
  onRetire: () => void;
  onConfirm: () => void;
  onVolatility: (v: "stable" | "volatile") => void;
  onVisibility?: (v: "private" | "public") => void;
  onSensitivity?: (v: Sensitivity) => void;
  onCoexist?: () => void;
  onDelete: () => void;
}) {
  const volatile = m.volatility === "volatile";
  const isPublic = m.visibility === "public";
  // 有效公开的两条路：手动点过头的（没被收回、不是绝密），和 tag 门放行的。
  // 收回（hold）压过一切自动放行；绝密在查询层就没有出门的路。
  const outByMark = isPublic && !m.hold && m.sensitivity !== "topsecret";
  const gateHit =
    gateLevelOf && !m.hold && m.sensitivity !== "topsecret"
      ? m.tags.some((t) => {
          const lv = gateLevelOf(t);
          return !!lv && sensRank(m.sensitivity) <= sensRank(lv);
        })
      : false;
  return (
    <Row
      onDelete={onDelete}
      actions={
        <>
          {volatile && (
            <button
              className="row-act"
              onClick={onConfirm}
              title="我刚跟本人核对过：它现在还是这样"
            >
              确认
            </button>
          )}
          {!!m.conflictsWith?.length && onCoexist && (
            <button
              className="row-act"
              onClick={onCoexist}
              title="这两条不是一回事，都留着——把疑问销掉"
            >
              不冲突
            </button>
          )}
          <button
            className="row-act"
            onClick={onRetire}
            title={
              m.supersededBy
                ? "恢复：让它重新参与检索"
                : "作废：新说法取代了它，内容保留"
            }
          >
            {m.supersededBy ? "恢复" : "作废"}
          </button>
        </>
      }
    >
      <span className="tag">{SHELF_LABEL[m.shelf as Shelf] || m.shelf}</span>
      {showWeight && <span className="tag ghost">{m.weight.toFixed(2)}</span>}
      <button
        className={volatile ? "tag volatile" : "tag ghost"}
        onClick={() => onVolatility(volatile ? "stable" : "volatile")}
        title={
          volatile
            ? "会变：说的是他现在怎么样。点一下改成「稳定」，它就不用再复核了"
            : "稳定：说的是他是谁、什么一直成立。点一下改成「会变」，过一阵会提醒我复核"
        }
      >
        {volatile ? "会变" : "稳定"}
      </button>
      {needReview(m) && <span className="tag warn">待复核</span>}
      {/* 量级：这条事知道的人该有多少。AI 写入时按分标，改档是人做的事（下拉里五档全在，
          绝密只有这里设得动）；分数是 AI 留的依据，跟着档位一起显示 */}
      {onSensitivity && (
        <select
          className={`tag sens-${m.sensitivity}`}
          value={m.sensitivity}
          onChange={(e) => onSensitivity(e.target.value as Sensitivity)}
          title="量级：决定这条能按 tag 放给来客看。绝密只有这里设得动；「10分」是人拍的板，不是算出来的"
          aria-label="记忆量级"
        >
          {SENSITIVITIES.map((s) => (
            <option key={s} value={s}>
              {SENSITIVITY_LABEL[s]}
              {s === m.sensitivity && m.score ? ` · ${m.score}分` : ""}
            </option>
          ))}
        </select>
      )}
      {/* 公开是给人点的事，所以它不做成标签、做成开关：点一下就是「让来客知道这条」。
          标记只是标记 —— 来客读不读得到由三道闸一起决定（手动标记 / 收回 / 量级），
          「已收回」「按tag公开中」两个标签负责把真话说全 */}
      {m.hold && (
        <span
          className="tag warn"
          title="你收回了这条：tag 门再开它也不出门，点「公开」才能重新放行"
        >
          已收回
        </span>
      )}
      {onVisibility && (
        <button
          className={outByMark ? "tag public" : "tag ghost"}
          disabled={m.sensitivity === "topsecret" && !isPublic}
          onClick={() => onVisibility(isPublic ? "private" : "public")}
          title={
            m.sensitivity === "topsecret" && !isPublic
              ? "绝密没有出门的路：想公开，先把量级降下来"
              : isPublic
                ? "来客能问出这条。点一下收回 —— 收回之后 tag 门再开它也出不了门"
                : m.hold
                  ? "你收回了这条：点「公开」才能重新放行"
                  : gateHit
                    ? "来客读得到它（tag 门放行中）。点一下收回 —— 收回之后 tag 门再开也出不了门"
                    : "只在这间屋子里用。点一下公开，来客问到相关的事就能查到这条"
          }
        >
          {isPublic ? "公开" : "不公开"}
        </button>
      )}
      {!m.hold && !outByMark && gateHit && (
        <span
          className="tag public"
          title="不是手动公开的：tag 门开着、量级也在门槛之内，来客读得到"
        >
          按tag公开中
        </span>
      )}
      {m.supersededBy && <span className="tag warn">已作废</span>}
      {!!m.conflictsWith?.length && (
        <span
          className="tag warn"
          title={`和 ${m.conflictsWith.join("、")} 像在说同一件事，还没弄明白哪个算数`}
        >
          对不上
        </span>
      )}
      {/* 图像记忆：原图就在云盘里，直接摆出来 —— 搜得到就看得见。
          点一下能看大图、能下载：缩略图这么小，看它本来就是为了确认「是不是这张」 */}
      {m.type === "image" && m.fileKey && (
        <img
          className="mem-thumb"
          src={`/api/files/${encodeURIComponent(m.fileKey)}`}
          alt={m.content.slice(0, 40) || "记忆里的图"}
          title="点开看大图"
          loading="lazy"
          onClick={() =>
            zoomIn(
              `/api/files/${encodeURIComponent(m.fileKey || "")}`,
              m.content.slice(0, 40),
            )
          }
        />
      )}
      {/* 书册：标题立户头，正文收进可展开的全篇 —— 一篇上万字不该把整个书架撑开 */}
      {m.type === "book" && m.title && <p className="mem-title">{m.title}</p>}
      {m.type === "book" && m.content.length > 200 ? (
        <details className="mem-book-body">
          <summary>全文 {m.content.length} 字</summary>
          <pre>{m.content}</pre>
        </details>
      ) : (
        <p className={m.supersededBy ? "dim" : ""}>{m.content}</p>
      )}
      <span className="meta">
        学到{ageText(m.learned, m.date)}
        {m.validAt && m.validAt.slice(0, 10) !== m.learned.slice(0, 10)
          ? ` · 这件事自 ${m.validAt.slice(0, 10)} 起`
          : ""}
        {m.verified ? ` · 确认于${ageText(m.verified)}` : ""}
        {m.supersededBy ? ` · 失效于${ageText(m.invalidAt)}` : ""} · {m.date} ·{" "}
        {m.tags.join(" / ")}
      </span>
    </Row>
  );
}
// ── 记忆书架 ──────────────────────────────────────────

export function MemoryPanel() {
  const [shelf, setShelf] = useState<Shelf | "">("");
  const [items, setItems] = useState<MemEntry[]>([]);
  const [q, setQ] = useState("");
  // 语义检索的请求定序：只有最新一次请求的响应才准许落库（见 load）
  const reqSeq = useRef(0);
  const [err, setErr] = useState("");
  // 写一条记忆改到弹页里做：这里编辑的是「打开弹页那一刻拍下的草稿」，按下记下才提交。
  // hook 一律留在函数体最上面 —— 放到条件分支或早退之后，React 会报
  // "Rendered more hooks than during the previous render"，面板就停在读取中不动了。
  const memForm = useDraft<MemoryDraft>(blankMemoryDraft());
  const [memDialog, setMemDialog] = useState(false);
  const [memErr, setMemErr] = useState("");
  const [savingMem, setSavingMem] = useState(false);

  // 已作废的记忆默认藏起来：它们不再参与检索，摆在正列表里只会让人以为它们还算数
  const [showRetired, setShowRetired] = useState(false);
  // 只看该复核的：复核是一件事，不该在几百条里靠眼睛找
  const [dueOnly, setDueOnly] = useState(false);
  // 只看有疑问的：和上面同理 —— 「哪两条对不上」也是个清单，不该靠翻
  const [doubtOnly, setDoubtOnly] = useState(false);
  // 只看哪一类：条目 / 书册 / 图像。书册和图像是后来才有的记忆形态，混在一架书里靠眼睛翻是翻不到的
  const [kind, setKind] = useState<"all" | "entry" | "book" | "image">("all");
  // 第一次还没回来的那段空档。不区分出来的话，用户一进门就看到「这里是空的」，
  // 半秒后凭空冒出一屏记忆 —— 等于先跟他撒了个谎
  const [loading, setLoading] = useState(true);
  // 「按 tag 公开」节：默认收着 —— 它是给「想一类一类放行」的人看的，
  // 不是每次翻记忆都要路过的东西
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagData, setTagData] = useState<{
    gates: TagGate[];
    stats: TagStat[];
  } | null>(null);

  // 门槛账本挂载就拉：每行记忆的「按tag公开中」标签要用它算有效可见性，
  // 不能等摊开这块才拉 —— 标签等不起。之后开关门就地改门槛清单，
  // 不重拉分布 —— 分布不因开关而变
  useEffect(() => {
    if (tagData) return;
    api
      .tagGates()
      .then(setTagData)
      .catch((e: Error) => setErr(e.message));
  }, [tagData]);

  const gateLevelOf = (tag: string) =>
    // gates 也兜一层：账本没回来齐就先当没开门，别让整块设置跟着塌
    tagData?.gates?.find((g) => g.tag === tag)?.maxLevel || "";

  const setGate = async (tag: string, maxLevel: string) => {
    // 先就地改：门开了没反应，会让人以为没开上 —— 失败时下面的请求会把真账拉回来
    setTagData((prev) =>
      prev
        ? {
            gates: [
              ...prev.gates.filter((g) => g.tag !== tag),
              ...(maxLevel ? [{ tag, maxLevel }] : []),
            ],
            stats: prev.stats,
          }
        : prev,
    );
    try {
      const { gates } = await api.setTagGate(tag, maxLevel);
      setTagData((prev) => (prev ? { ...prev, gates } : prev));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const load = useCallback(async () => {
    // 每次加载领一个自增序号：请求乱序回来时，旧的那次直接在后面作废，
    // 免得「先发的慢请求」把「后发的快请求」刚写好的结果覆盖掉
    const seq = ++reqSeq.current;
    try {
      setErr("");
      // 换筛选条件时也要重新举起这个旗：上一条筛选的结果空着，
      // 不举旗的话会说「这里是空的」，可其实只是还在查
      setLoading(true);
      const next = dueOnly
        ? await api.memoryDue()
        : doubtOnly
          ? await api.memoryConflicts()
          : q
            ? await api.memorySearch(q, showRetired)
            : await api.memories(shelf || undefined, showRetired);
      if (seq !== reqSeq.current) return; // 过期响应：丢弃，别 set
      setItems(next);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setErr((e as Error).message);
    } finally {
      // 只有最新那次才负责收旗，旧请求回来时不能把 loading 熄掉
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [q, shelf, showRetired, dueOnly, doubtOnly]);

  useEffect(() => {
    // 打字停下来再查后端（260ms）：语义检索框原来每敲一个字都直打一次；
    // 序号已在 load 里兜底，过期响应不会覆盖新结果
    const t = window.setTimeout(() => void load(), 260);
    return () => window.clearTimeout(t);
  }, [load]);

  const patchMem = (p: Partial<MemoryDraft>) =>
    memForm.setDraft((prev) => ({ ...prev, ...p }));

  const openAddMem = () => {
    memForm.reset(blankMemoryDraft());
    setMemErr("");
    setMemDialog(true);
  };

  const closeAddMem = () => {
    setMemDialog(false);
    setMemErr("");
  };

  const saveMem = async () => {
    if (savingMem) return;
    const missing = memoryMissingFields(memForm.draft);
    if (missing.length) {
      setMemErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSavingMem(true);
    setMemErr("");
    try {
      await api.memoryAdd(memoryPayloadOf(memForm.draft));
      // 成功后先回填列表再关窗：列表摆的是落库后的真值，不做乐观更新
      await load();
      setMemDialog(false);
    } catch (e) {
      // 后端校验不过原样摆在弹页里，不关窗
      setMemErr((e as Error).message);
    } finally {
      setSavingMem(false);
    }
  };

  const del = async (m: MemEntry) => {
    // 删除不是作废 —— 条目直接没了。先问一句，别让手滑把一条还作数的记忆永久抹掉
    if (
      !window.confirm(
        `永久删除这条记忆？「${contentSnippet(m.content)}」删了就找不回来了。`,
      )
    )
      return;
    await api.memoryDelete(m.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  const retire = async (m: MemEntry) => {
    await api
      .memorySupersede(m.id, !!m.supersededBy)
      .catch((e: Error) => setErr(e.message));
    await load();
  };

  // 点完先就地改，再去请求：标签这种小东西等一两秒才变，会让人以为没点上。
  // 请求失败时后面的 load() 会把真状态拉回来，所以乐观一下是安全的。
  const confirm = async (m: MemEntry) => {
    const now = new Date().toISOString();
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, verified: now } : x)),
    );
    await api.memoryConfirm(m.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  const setVol = async (m: MemEntry, v: "stable" | "volatile") => {
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, volatility: v } : x)),
    );
    await api.memoryVolatility(m.id, v).catch((e: Error) => setErr(e.message));
    await load();
  };

  // 公开 / 收回。先就地改再请求，理由同上：点完没反应会让人以为没点上。
  // 收回不是把标记改回 private 就完事 —— hold 跟着一起落，和后端同一个规矩；
  // 改回公开时 hold 也一起清掉。请求失败时 load() 会把真状态拉回来。
  const setVis = async (m: MemEntry, v: "private" | "public") => {
    setItems((prev) =>
      prev.map((x) =>
        x.id === m.id ? { ...x, visibility: v, hold: v === "private" } : x,
      ),
    );
    await api.memoryVisibility(m.id, v).catch((e: Error) => setErr(e.message));
    await load();
  };

  // 改量级。同样先就地改：档位是下拉的事，落了再让真状态回来对账。
  // 降档会解开绝密对公开按钮的锁（真状态回来后 hold 门重新算）。
  const setSens = async (m: MemEntry, v: Sensitivity) => {
    setItems((prev) =>
      prev.map((x) =>
        x.id === m.id
          ? {
              ...x,
              sensitivity: v,
              // 绝密是管理员亲手拍的板：跟着把分钉在 10，和后端同一个规矩
              score: v === "topsecret" ? 10 : x.score,
            }
          : x,
      ),
    );
    await api.memorySensitivity(m.id, v).catch((e: Error) => setErr(e.message));
    await load();
  };

  // 答一句「这两条不是一回事」。和确认一样先就地改：点完没反应会让人以为没点上。
  const coexist = async (m: MemEntry) => {
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, conflictsWith: [] } : x)),
    );
    await api.memoryCoexist(m.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  return (
    <div className="panel-body">
      <div className="tabs">
        <button
          className={
            shelf === "" && !q && !dueOnly && !doubtOnly ? "chip on" : "chip"
          }
          onClick={() => {
            setShelf("");
            setQ("");
            setDueOnly(false);
            setDoubtOnly(false);
            setKind("all");
          }}
        >
          全部
        </button>
        {SHELVES.map((s) => (
          <button
            key={s}
            className={
              shelf === s && !q && !dueOnly && !doubtOnly ? "chip on" : "chip"
            }
            onClick={() => {
              setShelf(s);
              setQ("");
              setDueOnly(false);
              setDoubtOnly(false);
              setKind("all");
            }}
          >
            {SHELF_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="inline-form">
        <input
          className="field"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value) {
              setDueOnly(false);
              setDoubtOnly(false);
            }
          }}
          placeholder="语义检索…"
        />
      </div>

      <div className="tabs sub">
        <button
          className={kind === "all" ? "chip on" : "chip"}
          onClick={() => setKind("all")}
        >
          全部类型
        </button>
        <button
          className={kind === "entry" ? "chip on" : "chip"}
          onClick={() => setKind("entry")}
        >
          条目
        </button>
        <button
          className={kind === "book" ? "chip on" : "chip"}
          onClick={() => setKind("book")}
        >
          书册
        </button>
        <button
          className={kind === "image" ? "chip on" : "chip"}
          onClick={() => setKind("image")}
        >
          图像
        </button>
      </div>

      <label className="check-line">
        <input
          type="checkbox"
          checked={dueOnly}
          onChange={(e) => {
            setDueOnly(e.target.checked);
            if (e.target.checked) setDoubtOnly(false);
          }}
        />
        只看该复核的（说的是现状、又有一阵没核对过的那些）
      </label>

      <label className="check-line">
        <input
          type="checkbox"
          checked={doubtOnly}
          onChange={(e) => {
            setDoubtOnly(e.target.checked);
            if (e.target.checked) setDueOnly(false);
          }}
        />
        只看有疑问的（和别的说法像在说同一件事，还没对上）
      </label>

      <label className="check-line">
        <input
          type="checkbox"
          checked={showRetired}
          onChange={(e) => setShowRetired(e.target.checked)}
        />
        连已作废的也显示（它们不再参与检索，只是留个说法）
      </label>

      <div className="tabs sub">
        <button
          className={tagsOpen ? "chip on" : "chip"}
          onClick={() => setTagsOpen((v) => !v)}
        >
          按 tag 公开
        </button>
      </div>

      {tagsOpen && (
        <div className="tag-gates">
          <p className="meta">
            门槛开在哪个 tag，带这个 tag 的记忆就按量级放行给来客 ——
            一类一类地开，
            不用一条条点公开。一般只建议开到「不重要」：门槛往上提，放出去的是一整类，不是一条。
          </p>
          {!tagData && <EntityNote>读取中…</EntityNote>}
          {!!tagData?.stats.length && (
            <div className="entity-list">
              {tagData.stats.map((s) => (
                <EntityRow
                  key={s.tag}
                  title={s.tag}
                  summary={
                    <>
                      {tagStatSummary(s)}
                      {TYPE_TAGS.has(s.tag) && (
                        <span
                          className="tag warn"
                          title="这是记忆的内置类型名：AI 写每条记忆都会自动带上它。开这道门等于把整个类型按量级放出去，比普通 tag 的门宽得多 —— 想清楚再开"
                        >
                          内置类型
                        </span>
                      )}
                    </>
                  }
                  right={
                    <select
                      className="field gate-select"
                      value={gateLevelOf(s.tag)}
                      onChange={(e) => setGate(s.tag, e.target.value)}
                      title="这个 tag 允许出门的最高量级；「不公开」是关门"
                      aria-label={`tag ${s.tag} 的公开门槛`}
                    >
                      <option value="">不公开</option>
                      {TAG_GATE_LEVELS.map((lv) => (
                        <option key={lv} value={lv}>
                          {gateLevelLabel(lv)}
                        </option>
                      ))}
                    </select>
                  }
                />
              ))}
            </div>
          )}
          {!!tagData && !tagData.stats.length && (
            <EntityNote>
              还没有带 tag 的记忆 —— 写记忆时打上标签，这里就有门可开。
            </EntityNote>
          )}
        </div>
      )}

      <EntityAddButton label="写一条新记忆" onClick={openAddMem} />

      <ul className="rows">
        {(kind === "all"
          ? items
          : items.filter((m) =>
              kind === "entry"
                ? m.type !== "book" && m.type !== "image"
                : m.type === kind,
            )
        ).map((m) => (
          <MemRow
            key={m.id}
            m={m}
            showWeight
            gateLevelOf={gateLevelOf}
            onDelete={() => del(m)}
            onRetire={() => retire(m)}
            onConfirm={() => confirm(m)}
            onVolatility={(v) => setVol(m, v)}
            onVisibility={(v) => setVis(m, v)}
            onSensitivity={(v) => setSens(m, v)}
            onCoexist={() => coexist(m)}
          />
        ))}
        {!items.length && (
          <li className="empty-sm">
            {loading
              ? "读取中…"
              : dueOnly
                ? "没有该复核的——关于现状的那些，最近都核对过"
                : doubtOnly
                  ? "没有悬着的疑问——记下的每句话都清清爽爽"
                  : "这里是空的"}
          </li>
        )}
      </ul>

      {/* 新增弹页：写完按下「记下」才进库。量级 / 公开 / 会不会变这些仍在行上点，
          它们是天天要动的事，不该为它们开一次窗 */}
      {memDialog && (
        <FormDialog
          wide
          title="写一条新记忆"
          subtitle="一条一件事。存进来以后就在上面这个列表里，量级、公开、作废都在行上随手改。"
          saveLabel="记下"
          busy={savingMem}
          error={memErr}
          dirty={memForm.dirty(memForm.draft)}
          onClose={closeAddMem}
          onSave={() => void saveMem()}
        >
          <FormSection title="正文">
            <FormRow
              label="要记住的事"
              wide
              hint={
                memoryContentTooLong(memForm.draft.content)
                  ? `这一条写了 ${memForm.draft.content.trim().length} 字：服务端单条只留前 ${MAX_MEMORY_CONTENT} 字，后面会被截掉，建议拆成几条`
                  : "谁、发生了什么、从什么时候算起 —— 一句说得清的事就够一条"
              }
            >
              <textarea
                className="field"
                rows={4}
                placeholder="写一条新记忆…"
                value={memForm.draft.content}
                onChange={(e) => patchMem({ content: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="归置">
            <FormRow label="架子" hint="书架上摆在哪一格，翻的时候按这一格筛">
              <select
                className="field"
                value={memForm.draft.shelf}
                onChange={(e) => patchMem({ shelf: e.target.value as Shelf })}
                aria-label="记忆架子"
              >
                {SHELVES.map((s) => (
                  <option key={s} value={s}>
                    {SHELF_LABEL[s]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow
              label="会不会变"
              hint="说的是他现在怎么样就选「会变」，过一阵会提醒复核；说他一直如此选「稳定」"
            >
              <select
                className="field"
                value={memForm.draft.volatility}
                onChange={(e) =>
                  patchMem({
                    volatility: e.target.value as MemoryDraft["volatility"],
                  })
                }
                aria-label="会不会变"
              >
                <option value="stable">稳定</option>
                <option value="volatile">会变</option>
              </select>
            </FormRow>
            <FormRow
              label="标签"
              hint="逗号、顿号或空格分开。「按 tag 公开」那道门就是按这里的名字开的，写准一点"
            >
              <input
                className="field"
                placeholder="workflow、硬件"
                value={memForm.draft.tags}
                onChange={(e) => patchMem({ tags: e.target.value })}
              />
            </FormRow>
          </FormSection>
        </FormDialog>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}
// ── 任务 ──────────────────────────────────────────────

const STATUS_NEXT: Record<string, "todo" | "doing" | "done"> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};
const STATUS_META: Record<string, { label: string; icon: IconName }> = {
  todo: { label: "待办", icon: "clock" },
  doing: { label: "进行中", icon: "refresh" },
  done: { label: "已完成", icon: "check" },
};

export function TaskPanel({
  state,
  patch,
  readOnly,
}: {
  state: ChatState;
  patch: Patch;
  readOnly?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  const add = async () => {
    if (!title.trim()) return;
    const tasks = [
      ...state.tasks,
      {
        title: title.trim(),
        desc: desc.trim(),
        status: "todo" as const,
        created: new Date().toISOString().slice(0, 10),
      },
    ];
    await patch({ tasks });
    setTitle("");
    setDesc("");
  };

  return (
    <div className="panel-body">
      <ul className="rows">
        {state.tasks.map((t, i) => {
          const meta = STATUS_META[t.status] || STATUS_META.todo;
          const label = (
            <>
              <Icon name={meta.icon} size={12} /> {meta.label}
            </>
          );
          return (
            <Row
              key={`${t.title}-${i}`}
              onDelete={
                readOnly
                  ? undefined
                  : () =>
                      patch({ tasks: state.tasks.filter((_, j) => j !== i) })
              }
            >
              {readOnly ? (
                <span className={`status ${t.status}`}>{label}</span>
              ) : (
                <button
                  className={`status ${t.status}`}
                  onClick={() =>
                    patch({
                      tasks: state.tasks.map((x, j) =>
                        j === i ? { ...x, status: STATUS_NEXT[x.status] } : x,
                      ),
                    })
                  }
                  title="点击切换状态"
                >
                  {label}
                </button>
              )}
              <p>{t.title}</p>
              {t.desc && <span className="meta">{t.desc}</span>}
            </Row>
          );
        })}
        {!state.tasks.length && <li className="empty-sm">暂无任务</li>}
      </ul>

      {readOnly ? (
        <p className="meta pad">只读视图 · 任务由 ericher 在对话中更新</p>
      ) : (
        <div className="inline-form sticky col">
          <input
            className="field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="任务标题"
          />
          <div className="inline-form">
            <input
              className="field"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="补充说明（可选）"
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={add}
              disabled={!title.trim()}
            >
              新建
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 技能 ──────────────────────────────────────────────

export function SkillPanel({
  state,
  patch,
}: {
  state: ChatState;
  patch: Patch;
}) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const names = Object.keys(state.skills);

  const save = async () => {
    if (!name.trim() || !steps.trim()) return;
    const list = steps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    await patch({ skills: { ...state.skills, [name.trim()]: list } });
    setName("");
    setSteps("");
  };

  return (
    <div className="panel-body">
      <ul className="rows">
        {names.map((n) => (
          <Row
            key={n}
            onDelete={() => {
              const next = { ...state.skills };
              delete next[n];
              void patch({ skills: next });
            }}
          >
            <button
              className="link"
              onClick={() => setOpen(open === n ? null : n)}
            >
              {n} <span className="meta">{state.skills[n].length} 步</span>
            </button>
            {open === n && (
              <ol className="steps">
                {state.skills[n].map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
          </Row>
        ))}
        {!names.length && <li className="empty-sm">暂无技能</li>}
      </ul>

      <div className="inline-form sticky col">
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="技能名"
        />
        <textarea
          className="field"
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={"每行一步，例如：\nsearch 关键词\nread_url 最相关的一条"}
          rows={3}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={save}
          disabled={!name.trim() || !steps.trim()}
        >
          保存技能
        </button>
      </div>
    </div>
  );
}
// ── 提醒（主动能力）──────────────────────────────────

/** 把最常见的「每天固定点」cron 说成人话；认不出来的原样显示，不猜。 */
function humanCron(expr: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expr.trim());
  if (!m) return `每 ${expr}`;
  return `每天 ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
}

/** 「还有多久」。到点了也别说负数，那只会让人以为坏了。 */
function until(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  if (diff <= 0) return "等下一次";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "马上";
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

/**
 * 提醒面板。
 * 这里不是「设一个通知」，而是「我和他说好了一件事」——所以取消按钮叫「不提醒了」，
 * 而不是「删除」。措辞会决定他怎么理解这个功能。
 */
export function ReminderPanel() {
  const [rows, setRows] = useState<Reminder[]>([]);
  const [pro, setPro] = useState<{ today: number; quietNow: boolean } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await api.reminders());
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
    // 主动开口的账读不到不该让整个面板报错，所以单独兜
    try {
      setPro(await api.proactive());
    } catch {
      setPro(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (r: Reminder) => {
    try {
      await api.cancelReminder(r.id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel-body">
      <h3 className="sect">还没到点的约定（{rows.length}）</h3>

      <ul className="remind-list">
        {rows.map((r) => (
          <li className="remind-row" key={r.id}>
            <div className="remind-when">
              <Icon name="bell" size={15} />
              <span>{fmtWhen(r.at)}</span>
              {r.every ? (
                <span className="tag">{humanCron(r.every)}</span>
              ) : (
                <span className="tag ghost">一次</span>
              )}
              {r.urgent && <span className="tag">必须叫醒</span>}
              {/* 对话里冒出来的时间节点，ericher 主动记的那一类（内容以「跟进：」开头） */}
              {r.what.startsWith("跟进：") && (
                <span className="tag ghost">跟进</span>
              )}
              {/* 到点落在哪儿是看这一行时最该知道的：回原来那一场，还是他另开一场 */}
              {r.mode === "new" && (
                <span className="tag ghost">
                  另开一场{r.title ? `「${r.title}」` : ""}
                </span>
              )}
            </div>
            <p className="remind-what">{r.what}</p>
            <div className="remind-foot">
              <span className="meta">{until(r.at)}</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void cancel(r)}
              >
                不提醒了
              </button>
            </div>
          </li>
        ))}
      </ul>

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !rows.length && (
        <p className="empty-sm">
          还没有约定。在对话里说一句「明天九点提醒我交周报」，我就记下了。
        </p>
      )}

      <p className="meta pad">
        到点我会自己开口，那句话落在当初约定它的那场对话里 ——
        你切回那场就能看到，在线的话也会立刻收到。
      </p>

      <h3 className="sect">安静时段</h3>
      <p className="meta pad">
        晚上 23 点到早上 8 点，一次性提醒我会压到早上八点再说，不会丢掉。
        重复提醒照常 ——
        那个点是你自己定的，我照办。真要凌晨叫醒你，说一句「必须叫醒我」就行。
        {pro && (pro.quietNow ? " 现在正在安静时段里。" : "")}
      </p>
      {pro && (
        <p className="meta pad">
          今天我已经主动开口 {pro.today} 次。
          {pro.today >= 8
            ? "有点多了 —— 想清静的话，去「提醒」里取消几条约定。"
            : ""}
        </p>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
// ── 今日额度（他今天写了多少行，写到哪儿去了）──────────

/** 把 "insert:cf_agents_state" 翻成人话。翻不出来就原样显示，不硬编。 */
function quotaLabel(key: string): string {
  const [op, table = ""] = key.split(":");
  const verbs: Record<string, string> = {
    insert: "写入",
    replace: "写入",
    update: "改写",
    delete: "删除",
    create: "建表",
    drop: "删表",
    alter: "改表",
    pragma: "自检",
    read: "读取",
  };
  const where: Record<string, string> = {
    cf_agents_state: "整份状态",
    cf_ai_chat_agent_messages: "聊天记录",
    cf_agents_schedules: "定时任务表",
    memories: "记忆库",
    sessions: "会话索引",
    session_messages: "会话正文",
    reminders: "提醒",
    write_meter: "额度账本本身",
    msg_flags: "重点标记",
    msg_comments: "批注",
    msg_votes: "评价",
    task_cursor: "长任务游标",
    patterns: "经验库",
    files: "文件索引",
  };
  return `${verbs[op] || op}${where[table] ? ` · ${where[table]}` : table ? ` · ${table}` : ""}`;
}

/** 一行额度：数字 + 进度条。n 为 null 表示这项只有官方口径、还没接 token。 */
function QuotaRow(props: {
  n: number | null;
  cap: number;
  unit: string;
  official?: boolean;
  detail?: string;
  emptyHint?: string;
}) {
  const { n, cap, unit, official, detail, emptyHint } = props;
  if (n === null) {
    return (
      <>
        <div className="quota-head">
          <span className="quota-n">—</span>
          <span className="meta">
            / {cap.toLocaleString()} {unit}
          </span>
        </div>
        <p className="meta pad">
          {emptyHint || "接上 API Token 后，这里会是官方数。"}
        </p>
      </>
    );
  }
  const pct = Math.min(100, (n / cap) * 100);
  const level = pct >= 90 ? "danger" : pct >= 60 ? "warn" : "ok";
  return (
    <>
      <div className="quota-head">
        <span className={`quota-n ${level}`}>{n.toLocaleString()}</span>
        <span className="meta">
          / {cap.toLocaleString()} {unit}
        </span>
        {official && <span className="tag">官方</span>}
      </div>
      <div className={`quota-bar ${level}`}>
        <span style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
      {detail && <p className="meta pad">{detail}</p>}
    </>
  );
}

/**
 * 额度总览：这间屋子每天/每月的所有天花板。
 *
 * 两块拼起来：SQL 读写和 Workers 请求优先用 Cloudflare 官方 Analytics 的精确数
 * （接了 CF_API_TOKEN 才有，有几分钟延迟）；AI neurons 和 Vectorize 官方没有
 * 查询接口，是他自己埋账估的。两边在同一个面板上各标各的口径，不混着骗人。
 */
export function QuotaPanel() {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setRep(await api.usage());
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const wr = rep?.writes ?? null;
  const res = rep?.resources ?? null;
  const off = rep?.official ?? null;
  // 读写优先官方；没接 token 退回自计量 —— 自计量只会偏小不会虚报（见 meter.ts）
  const writeN = off?.sqlRowsWritten ?? wr?.writes ?? null;
  const readN = off?.sqlRowsRead ?? wr?.reads ?? null;
  const writePct = wr ? Math.min(100, ((writeN ?? 0) / wr.writeCap) * 100) : 0;
  const neuronPct = res
    ? Math.min(100, (res.neurons / res.neuronsCap) * 100)
    : 0;

  return (
    <div className="panel-body">
      <div className="quota-top">
        <h3 className="sect">今天的额度</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {loading && <p className="empty-sm">读取中…</p>}

      {rep && wr && res && (
        <>
          <p className="sect-sub">SQL 写入 —— 整间屋子瘫掉通常就是它</p>
          <QuotaRow
            n={writeN}
            cap={wr.writeCap}
            unit="行"
            official={off?.sqlRowsWritten != null}
            detail={
              (writePct >= 90
                ? "快满了。到顶之后他连翻记忆都做不到，得等早上八点重置。"
                : writePct >= 60
                  ? "已经过半了 —— 今天再聊下去，可能会提前用光。"
                  : "离上限还远。") + " 额度按 UTC 零点（北京时间早八点）重置。"
            }
          />

          <p className="sect-sub">SQL 读取</p>
          <QuotaRow
            n={readN}
            cap={wr.readCap}
            unit="行"
            official={off?.sqlRowsRead != null}
          />

          <p className="sect-sub">Workers 请求</p>
          <QuotaRow
            n={off?.requests ?? null}
            cap={100_000}
            unit="次/天"
            official
            detail={
              off
                ? `出错 ${off.errors ?? 0} · 子请求 ${off.subrequests ?? 0}。官方数约有几分钟延迟。`
                : undefined
            }
            emptyHint="这项只有官方口径（请求从门口进来，他自己数不全）。接法：在 Cloudflare 后台建一个 Analytics:Read 权限的 Token，跑 npx wrangler secret put CF_API_TOKEN。"
          />

          <p className="sect-sub">AI 算力（neurons，估算）</p>
          <QuotaRow
            n={res.neurons}
            cap={res.neuronsCap}
            unit="/天"
            detail={`≈${res.embeds} 次嵌入 · ${res.images} 张 FLUX 图。${
              neuronPct >= 90
                ? "快满了 —— 出图和写记忆会开始报错。"
                : "超了当天 Workers AI 直接报错，出图会自己降到智谱兜底。"
            }`}
          />

          <p className="sect-sub">Vectorize 查询（本月）</p>
          <QuotaRow
            n={res.vecQueriedDims}
            cap={res.vecQueryCap}
            unit="维"
            detail="每语义检索一次 ≈ topK × 1024 维。按月结算。"
          />

          <p className="sect-sub">Vectorize 存储</p>
          <QuotaRow
            n={res.vecStoredDims}
            cap={res.vecStoreCap}
            unit="维"
            detail={`≈${Math.round(res.vecStoredDims / 1024)} 条向量记忆（近似存量）。`}
          />

          {!!wr.top.length && (
            <>
              <h3 className="sect">写哪儿去了</h3>
              <ul className="remind-list">
                {wr.top.map((t) => (
                  <li className="remind-row" key={t.key}>
                    <div className="remind-when">
                      <span className="watch-target">{quotaLabel(t.key)}</span>
                      <span className="tag">{t.n.toLocaleString()} 行</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="meta pad">
            没标「官方」的数字是他自己数的：SQL 每条过一遍账、AI 按字符估 token
            乘单价。读数只算「返回了几行」，批量删除也只算一次 ——
            所以只会偏小，不会虚报。账跟着 Durable Object 一起驱逐重启，
            重启后从账本和 state 里把今天的数接回来。
          </p>
        </>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}
// ── 联系人（人脉视图：按人翻记忆）──────────────────────

export function ContactPanel() {
  const [people, setPeople] = useState<Array<{ person: string; n: number }>>(
    [],
  );
  const [who, setWho] = useState<string | null>(null);
  const [items, setItems] = useState<MemEntry[]>([]);
  const [err, setErr] = useState("");
  // 记一条关于某人的事改到弹页里做：编辑的是「打开弹页那一刻拍下的草稿」，按下记下才提交。
  // hook 必须留在函数体最上面 —— 这个面板有一句 `if (who) return …` 的早退，
  // 放到它后面就会报 "Rendered more hooks than during the previous render"，面板停在读取中。
  const contactForm = useDraft<ContactDraft>(blankContactDraft());
  const [contactDialog, setContactDialog] = useState(false);
  const [contactErr, setContactErr] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  // 来客一天来好几拨，人脉列表很快被「来客·X」淹没 —— 给个开关把他们拢到一起看
  const [onlyGuests, setOnlyGuests] = useState(false);
  // 这两份数据也是异步来的。不举旗，就会在「刚点开某个人」的那一瞬间说
  // 「还没有关于他的记忆」—— 然后记忆才一条条冒出来
  const [loadingPeople, setLoadingPeople] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

  const loadPeople = useCallback(async () => {
    try {
      setPeople(await api.persons());
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingPeople(false);
    }
  }, []);

  const loadItems = useCallback(async (person: string, all = false) => {
    try {
      setLoadingItems(true);
      setItems(await api.memoryOfPerson(person, all));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  useEffect(() => {
    if (who) void loadItems(who, showRetired);
  }, [who, showRetired, loadItems]);

  const retire = async (m: MemEntry) => {
    await api
      .memorySupersede(m.id, !!m.supersededBy)
      .catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
    await loadPeople();
  };

  // 和人脉面板同一套：先就地改再请求，避免点完没反应
  const confirm = async (m: MemEntry) => {
    const now = new Date().toISOString();
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, verified: now } : x)),
    );
    await api.memoryConfirm(m.id).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
  };

  const setVol = async (m: MemEntry, v: "stable" | "volatile") => {
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, volatility: v } : x)),
    );
    await api.memoryVolatility(m.id, v).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
  };

  const setVis = async (m: MemEntry, v: "private" | "public") => {
    setItems((prev) =>
      prev.map((x) =>
        x.id === m.id ? { ...x, visibility: v, hold: v === "private" } : x,
      ),
    );
    await api.memoryVisibility(m.id, v).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
  };

  // 改量级：和记忆面板同一个动作、同一套先改再对账的规矩。
  const setSens = async (m: MemEntry, v: Sensitivity) => {
    setItems((prev) =>
      prev.map((x) =>
        x.id === m.id
          ? {
              ...x,
              sensitivity: v,
              score: v === "topsecret" ? 10 : x.score,
            }
          : x,
      ),
    );
    await api.memorySensitivity(m.id, v).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
  };

  const coexist = async (m: MemEntry) => {
    setItems((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, conflictsWith: [] } : x)),
    );
    await api.memoryCoexist(m.id).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who, showRetired);
  };

  const patchContact = (p: Partial<ContactDraft>) =>
    contactForm.setDraft((prev) => ({ ...prev, ...p }));

  /** 新增与「关于某个人的第一条」共用同一份草稿：从谁那一行点进来，名字就带着走 */
  const openAddContact = () => {
    contactForm.reset({ ...blankContactDraft(), person: who || "" });
    setContactErr("");
    setContactDialog(true);
  };

  const closeAddContact = () => {
    setContactDialog(false);
    setContactErr("");
  };

  const saveContact = async () => {
    if (savingContact) return;
    const missing = contactMissingFields(contactForm.draft);
    if (missing.length) {
      setContactErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSavingContact(true);
    setContactErr("");
    try {
      await api.memoryAdd(contactPayloadOf(contactForm.draft));
      const target = contactForm.draft.person.trim();
      // 回填名单与这个人的条目之后再关窗：列表摆的是落库后的真值，不做乐观更新
      if (who) await loadItems(who);
      else setWho(target);
      await loadPeople();
      setContactDialog(false);
    } catch (e) {
      // 后端校验不过原样摆在弹页里，不关窗
      setContactErr((e as Error).message);
    } finally {
      setSavingContact(false);
    }
  };

  const del = async (m: MemEntry) => {
    // 和记忆面板同一条规矩：删除是永久的，先问一句再动手
    if (
      !window.confirm(
        `永久删除关于${who}的这条记忆？「${contentSnippet(m.content)}」删了就找不回来了。`,
      )
    )
      return;
    await api.memoryDelete(m.id).catch((e: Error) => setErr(e.message));
    if (who) await loadItems(who);
    await loadPeople();
  };

  // 弹页在两种进入方式里是同一个：名单下面「新记一个人」要填名字，
  // 从某人页里点进来名字已经带着，只留正文与归置那几格
  const contactDialogNode = contactDialog && (
    <FormDialog
      wide
      title={who ? `记一条关于${who}的事` : "新记一个人"}
      subtitle={
        who
          ? "存进来就在下面这个列表里；公开、量级、作废这些仍在行上点。"
          : "先给人立个户口，再写下第一条关于他的事 —— 同一个称呼反复用，人才翻得起来。"
      }
      saveLabel="记下"
      busy={savingContact}
      error={contactErr}
      dirty={contactForm.dirty(contactForm.draft)}
      onClose={closeAddContact}
      onSave={() => void saveContact()}
    >
      {!who && (
        <FormSection title="这个人">
          <FormRow
            label="姓名 / 称呼"
            hint={
              personNameTooLong(contactForm.draft.person)
                ? `称呼写了 ${contactForm.draft.person.trim().length} 字：服务端单条只留前 ${MAX_PERSON_CHARS} 字，后面会被截掉`
                : "和记忆里已有的写法保持一致，别同一个人记成两个名字"
            }
          >
            <input
              className="field"
              placeholder="人物姓名 / 称呼"
              value={contactForm.draft.person}
              onChange={(e) => patchContact({ person: e.target.value })}
            />
          </FormRow>
        </FormSection>
      )}

      <FormSection title="正文">
        <FormRow
          label="要记住的事"
          wide
          hint={
            memoryContentTooLong(contactForm.draft.content)
              ? `这一条写了 ${contactForm.draft.content.trim().length} 字：服务端单条只留前 ${MAX_MEMORY_CONTENT} 字，后面会被截掉，建议拆成几条`
              : "关于他的这一件事，一句说得清就够一条"
          }
        >
          <textarea
            className="field"
            rows={4}
            placeholder="关于他的一条记忆…"
            value={contactForm.draft.content}
            onChange={(e) => patchContact({ content: e.target.value })}
          />
        </FormRow>
      </FormSection>

      <FormSection title="归置">
        <FormRow
          label="会不会变"
          hint="说的是他现在怎么样就选「会变」，过一阵会提醒复核；说他一直如此选「稳定」"
        >
          <select
            className="field"
            value={contactForm.draft.volatility}
            onChange={(e) =>
              patchContact({
                volatility: e.target.value as ContactDraft["volatility"],
              })
            }
            aria-label="会不会变"
          >
            <option value="stable">稳定</option>
            <option value="volatile">会变</option>
          </select>
        </FormRow>
        <FormRow
          label="标签"
          hint="逗号、顿号或空格分开。「按 tag 公开」那道门就是按这里的名字开的，写准一点"
        >
          <input
            className="field"
            placeholder="近况、家里"
            value={contactForm.draft.tags}
            onChange={(e) => patchContact({ tags: e.target.value })}
          />
        </FormRow>
      </FormSection>
    </FormDialog>
  );

  if (who) {
    return (
      <div className="panel-body">
        <button className="link" onClick={() => setWho(null)}>
          ← 所有人
        </button>
        <h3 className="sect">
          {who}
          {loadingItems ? (
            <span className="meta"> · 读取中…</span>
          ) : (
            <>
              {" "}
              · {items.filter((m) => !m.supersededBy).length} 条记忆
              {items.filter(needReview).length > 0 &&
                ` · ${items.filter(needReview).length} 条待复核`}
            </>
          )}
        </h3>
        <label className="check-line">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
          />
          连已作废的也显示
        </label>
        <EntityAddButton
          label={`记一条关于${who}的事`}
          onClick={openAddContact}
        />
        <ul className="rows">
          {items.map((m) => (
            <MemRow
              key={m.id}
              m={m}
              onDelete={() => del(m)}
              onRetire={() => retire(m)}
              onConfirm={() => confirm(m)}
              onVolatility={(v) => setVol(m, v)}
              onVisibility={(v) => setVis(m, v)}
              onSensitivity={(v) => setSens(m, v)}
              onCoexist={() => coexist(m)}
            />
          ))}
          {!items.length && (
            <li className="empty-sm">
              {loadingItems ? "读取中…" : `还没有关于${who}的记忆`}
            </li>
          )}
        </ul>
        {contactDialogNode}
        {err && <p className="err">{err}</p>}
      </div>
    );
  }

  return (
    <div className="panel-body">
      {hasGuestPerson(people) && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={onlyGuests}
            onChange={(e) => setOnlyGuests(e.target.checked)}
          />
          只看来客
        </label>
      )}
      <EntityAddButton label="新记一个人" onClick={openAddContact} />
      {!!people.length && (
        <div className="entity-list">
          {(onlyGuests
            ? people.filter((p) => isGuestPerson(p.person))
            : people
          ).map((p) => (
            <EntityRow
              key={p.person}
              title={p.person}
              summary={personSummary(p.n)}
              onEdit={() => {
                // 先把上一个人的记忆清掉：留着的话，新的一进来会先顶着旧数据，
                // 标题上那个「N 条」就成了别人的数字
                setItems([]);
                setWho(p.person);
              }}
            />
          ))}
        </div>
      )}
      {!people.length && (
        <EntityNote>
          {loadingPeople ? "读取中…" : "还没有归属到具体人物的记忆"}
        </EntityNote>
      )}

      {contactDialogNode}
      <p className="meta pad">
        联系人就是记忆库的人脉入口：同一条记忆在「记忆」里按分类看，在这里按人看。
      </p>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
