// hr-desk 管理面板（后半）：账本 / 文件 / 自我认知 / 工作守则 / 会话 / 嗓音 / 来客 / 模型 / 读音。
// 前半在 Panels.tsx，纯工具在 PanelsShared.ts；本文件只 import 后者（防循环）。

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api";
import { speak, stopSpeaking } from "../lib/speech";
import {
  MODEL_FORMAT_LABEL,
  TTS_DEFAULTS,
  TTS_PROTOCOL_LABEL,
  TTS_VOICE_PRESETS,
  VENDOR_PRESETS,
  voiceLabel,
} from "../lib/presets";
import { Icon } from "./Icons";
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
  entryFormOf,
  entryMissingFields,
  entrySummary,
  looksLikeRawKey,
  parseContextWindow,
  parseMaxOutput,
  providerMissingFields,
  providerSummary,
  type ProviderFormDraft,
} from "../lib/modelCatalogForm";
import {
  COMMON_TYPE_ID,
  GUEST_CARD_PERMS,
  blankGuestDraft,
  guestDraftOf,
  guestMissingFields,
  guestPasswordValue,
  guestTypeSummary,
  type GuestFormDraft,
} from "../lib/guestTypeForm";
import {
  freshTtsDraft,
  ttsDraftOf,
  ttsMissingFields,
  ttsPayloadOf,
  ttsSummary,
  ttsWithProtocol,
  type TtsFormDraft,
} from "../lib/ttsConfigForm";
import {
  DRAW_FORMAT_LABEL,
  DRAW_TIER_META,
  blankDrawDraft,
  drawDraftOf,
  drawIsBinding,
  drawMissingFields,
  drawPayloadOf,
  drawSummary,
  drawWithFormat,
  parseDrawModels,
  type DrawFormDraft,
} from "../lib/drawConfigForm";
import {
  SHELF_LABEL,
  type ChatState,
  type DrawConfig,
  type DrawFormat,
  type GuestType,
  type MemEntry,
  type ModelEntry,
  type ModelFormat,
  type ModelProvider,
  type PublicPost,
  type R2File,
  type SearchConfig,
  type SearchFormat,
  type SessionMeta,
  type Shelf,
  type Summary,
  type ToolCatalog,
  type ToolGroupDef,
  type TtsConfig,
  type TtsProtocol,
  type UserCard,
  type Voice,
  type VisitorEvent,
  type VisitorRoom,
} from "../lib/types";
import { fmtWhen, toolMeta, type Patch } from "./PanelsShared";
import "./Panels.css";
import "./Panels2Panels.css";

/**
 * 行容器：左边正文、右边小动作、最右删除叉。与 Panels.tsx 的 Row 是同一份 ——
 * 组件进不了纯工具文件，两边各持一份（防循环）。
 */
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

// ── 公开账本（来客看的）───────────────────────────────

/**
 * 客人登记时能挑的几层。不摆整个书架：identity、reflections 是 ericher 自己的工作底账，
 * 摆出来只会让人不知道该挑哪个。
 */
const LEDGER_SHELVES: Shelf[] = ["people", "events", "knowledge", "projects"];

/**
 * 公开账本 + 公开墙。账本：管理员公开条目 + 客人自己登记的（private，仅本人与管理员可见，
 * 公开只能管理员点头）；只能添不能改删。墙：permPublic 持卡者贴纸条，能贴能撤自己的。
 */
export function LedgerPanel({
  isAdmin,
  cardId,
  canPublic,
}: {
  isAdmin: boolean;
  /** 当前登录者的卡 id；没有卡（临时票）就是 null */
  cardId: string | null;
  /** 有没有公开权益：档位开了 permPublic 的持卡者才能往墙上贴 */
  canPublic: boolean;
}) {
  const [items, setItems] = useState<MemEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [shelf, setShelf] = useState<Shelf>("people");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  /** 这一场里刚登记的几条：写完得让他在列表上看见那一笔，不然会以为没存上 */
  const [mine, setMine] = useState<string[]>([]);
  // ── 公开墙：和账本分开的两样东西。账本是 ericher 的记忆摊给来客，
  // 墙上是人自己贴的纸条 —— 档位开了公开权益的持卡者都能贴
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [postDraft, setPostDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState("");

  const load = useCallback(async () => {
    try {
      // 墙拉不到不该拖住账本：各自兜底，谁挂了谁自己显示空
      const [ledger, wall] = await Promise.all([
        api.publicLedger(),
        api.posts().catch(() => [] as PublicPost[]),
      ]);
      setItems(ledger);
      setPosts(wall);
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

  const add = async () => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const entry = await api.memoryAdd({ content, shelf });
      // 如实带上落库的 visibility（private）：账本里「谁看得到」靠它区分，
      // 硬标成 public 是替管理员做了他没做的决定
      setItems((prev) => [entry, ...prev]);
      setMine((prev) => [...prev, entry.id]);
      setDraft("");
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 贴一条上墙。署名在后端用卡的昵称快照，这里只送内容 */
  const post = async () => {
    const content = postDraft.trim();
    if (!content || posting) return;
    setPosting(true);
    try {
      const p = await api.postAdd(content);
      setPosts((prev) => [p, ...prev]);
      setPostDraft("");
      setPostErr("");
    } catch (e) {
      setPostErr((e as Error).message);
    } finally {
      setPosting(false);
    }
  };

  /** 摘一条：管理员摘任意；持卡者只摘得动自己贴的（后端按卡 id 挡） */
  const unpost = async (id: string) => {
    try {
      await api.postDel(id);
      setPosts((prev) => prev.filter((p) => p.id !== id));
      setPostErr("");
    } catch (e) {
      setPostErr((e as Error).message);
    }
  };

  return (
    <div className="panel-body">
      <h3 className="sect">公开墙（{posts.length}）</h3>
      <ul className="rows">
        {posts.map((p) => (
          <Row
            key={p.id}
            onDelete={
              // 摘的权限在后端按卡 id 挡：这里把按钮只摆给该看见的人 ——
              // 管理员收拾整块板子，持卡者收得回自己贴的
              isAdmin || p.cardId === cardId
                ? () => void unpost(p.id)
                : undefined
            }
          >
            <span className="tag ghost">{p.author}</span>
            <p>{p.content}</p>
            <span className="meta">{fmtWhen(p.created)}</span>
          </Row>
        ))}
        {!posts.length && (
          <li className="empty-sm">{loading ? "读取中…" : "墙上还空着"}</li>
        )}
      </ul>
      {canPublic ? (
        <div className="inline-form">
          <input
            className="field"
            value={postDraft}
            onChange={(e) => setPostDraft(e.target.value)}
            placeholder="往墙上贴一句话，进门的人都看得到…"
            onKeyDown={(e) => {
              // isComposing 守卫：输入法确认候选词的那下回车不算提交
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void post();
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={post}
            disabled={!postDraft.trim() || posting}
          >
            {posting ? "贴着…" : "贴上墙"}
          </button>
        </div>
      ) : (
        <p className="meta pad">
          {isAdmin
            ? "持卡者贴的纸条都收在这里；带叉的能摘。"
            : "往墙上贴需要公开权益 —— 那一档跟着长期身份走，来客类型面板里能给。"}
        </p>
      )}
      {postErr && <p className="err">{postErr}</p>}

      <h3 className="sect">公开账本</h3>
      <ul className="rows">
        {items.map((m) => (
          <Row key={m.id}>
            <span className="tag">
              {SHELF_LABEL[m.shelf as Shelf] || m.shelf}
            </span>
            {!!m.person && <span className="tag ghost">{m.person}</span>}
            {mine.includes(m.id) && <span className="tag ok">我刚登记的</span>}
            {/* 账本里 private 的只有「他这场登记的」一种：主屋来的都是管理员点过头的 public。
                把这一档标出来，别让他以为一写上去就人人可见 */}
            {m.visibility !== "public" && (
              <span className="tag">仅你与管理员可见</span>
            )}
            <p>{m.content}</p>
            <span className="meta">
              {m.learned ? `记于${m.learned.slice(0, 10)}` : m.date}
              {m.tags.length ? ` · ${m.tags.join(" / ")}` : ""}
            </span>
          </Row>
        ))}
        {!items.length && (
          <li className="empty-sm">
            {loading ? "读取中…" : "账本上还没有公开的条目"}
          </li>
        )}
      </ul>

      <div className="inline-form sticky col">
        <select
          className="field"
          value={shelf}
          onChange={(e) => setShelf(e.target.value as Shelf)}
          aria-label="归到哪一层"
        >
          {LEDGER_SHELVES.map((s) => (
            <option key={s} value={s}>
              {SHELF_LABEL[s]}
            </option>
          ))}
        </select>
        <div className="inline-form">
          <input
            className="field"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="想留在账本上的一句话…"
            onKeyDown={(e) => {
              // isComposing 守卫：输入法确认候选词的那下回车不算提交
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void add();
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={add}
            disabled={!draft.trim() || saving}
          >
            {saving ? "记着…" : "登记"}
          </button>
        </div>
      </div>

      <p className="meta pad">
        这里是 ericher 公开给所有客人看的那些人：谁是谁、该怎么称呼，都在上面。
        你也可以往上添一笔 ——
        你写下的只有你和管理员看得到，别的客人翻不着（ericher
        会在台后留一份，这一点他不瞒人）；
        要让一条对所有客人公开，得管理员在记忆面板里亲自点头，谁也替不了这个决定。
        账本只能添：已经写下的条目不能改也不能删。
      </p>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
// ── 文件（R2）─────────────────────────────────────────

const fmtSize = (n: number) =>
  n > 1024 * 1024
    ? (n / 1024 / 1024).toFixed(1) + "MB"
    : Math.round(n / 1024) + "KB";

/** 空文件夹的占位对象：只负责把空夹撑出来，列表里不当文件显示 */
const FOLDER_KEEP = ".keep";

/**
 * 云盘名对人不友好：上传是「时间戳-原名」，画的是「draw-时间戳.png」。
 * 这里换成能认出的说法；层次交给树。
 */
function showFile(name: string): string {
  const drawn = /^draw-(\d+)\.png$/.exec(name);
  if (drawn) {
    const d = new Date(Number(drawn[1]));
    if (!Number.isFinite(d.getTime())) return "他画的图";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `他画的图 · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return name.replace(/^\d+-/, "");
}

interface FileNode {
  name: string;
  /** 从自己范围根算起的相对路径（公开空间用展示名，不在整理范围内） */
  path: string;
  /** 完整的桶内 key：文件节点才有 */
  key: string;
  dir: boolean;
  size: number;
  uploaded: string;
  /** 会话文件夹的别名：知道是哪一场就显示场名 */
  label?: string;
  children: FileNode[];
}

/** 拼路径：两段都可能是空串，别拼出开头或结尾的斜杠 */
function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * 把平铺 key 拼成树：文件夹就是路径段；.keep 只撑空夹、不当文件；
 * 自己房间前缀剥掉（那是屋里屋外的划界），公开空间给人话名。写操作仍用完整 key。
 */
function buildTree(files: R2File[], scope: string): FileNode[] {
  const root: FileNode = {
    name: "",
    path: "",
    key: "",
    dir: true,
    size: 0,
    uploaded: "",
    children: [],
  };
  const dirs = new Map<string, FileNode>([["", root]]);
  const ensureDir = (rel: string): FileNode => {
    const got = dirs.get(rel);
    if (got) return got;
    const at = rel.lastIndexOf("/");
    const parent = ensureDir(at < 0 ? "" : rel.slice(0, at));
    const node: FileNode = {
      name: rel.slice(at + 1),
      path: rel,
      key: "",
      dir: true,
      size: 0,
      uploaded: "",
      children: [],
    };
    parent.children.push(node);
    dirs.set(rel, node);
    return node;
  };
  for (const f of files) {
    const rel =
      scope && f.key.startsWith(scope)
        ? f.key.slice(scope.length)
        : f.key.replace(/^f\/public\//, "公开空间/");
    if (!rel) continue;
    if (rel === FOLDER_KEEP || rel.endsWith(`/${FOLDER_KEEP}`)) {
      ensureDir(rel.slice(0, -(FOLDER_KEEP.length + 1)));
      continue;
    }
    const at = rel.lastIndexOf("/");
    const parent = ensureDir(at < 0 ? "" : rel.slice(0, at));
    parent.children.push({
      name: rel.slice(at + 1),
      path: rel,
      key: f.key,
      dir: false,
      size: f.size,
      uploaded: f.uploaded,
      children: [],
    });
  }
  const sort = (n: FileNode): void => {
    n.children.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, "zh"),
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** 给「会话/<id>」形状的文件夹挂上场名：翻云盘时按场找，比认 id 快 */
function labelSessions(nodes: FileNode[], titles: Map<string, string>): void {
  for (const n of nodes) {
    if (n.dir && n.name === "会话") {
      for (const c of n.children)
        if (c.dir) c.label = titles.get(c.name) || `会话 ${c.name.slice(0, 8)}`;
    }
    labelSessions(n.children, titles);
  }
}

/** 树里所有可作整理去处的文件夹（公开空间是墙，不是抽屉，不进清单） */
function collectDirs(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (!n.dir || !n.path) continue;
    if (n.path === "公开空间" || n.path.startsWith("公开空间/")) continue;
    if (n.path === "f/public" || n.path.startsWith("f/public/")) continue;
    out.push(n.path);
    collectDirs(n.children, out);
  }
  return out;
}

export function FilePanel({ sessions }: { sessions: SessionMeta[] }) {
  const [files, setFiles] = useState<R2File[]>([]);
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 和记忆库同理：还没拿到就说「云盘是空的」，是在替用户下一个错的结论
  const [loading, setLoading] = useState(true);
  /** 展开着的文件夹（相对路径集合） */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /** 上传 / 新建落进哪个文件夹（相对路径，"" = 根） */
  const [target, setTarget] = useState("");
  /** 正在搬的文件：记 key 和现居文件夹，选好去处再确认 */
  const [moving, setMoving] = useState<{ key: string; dir: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const r = await api.files();
      setFiles(r.files);
      setScope(r.scope || "");
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

  const titles = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.title])),
    [sessions],
  );
  const tree = useMemo(() => {
    const t = buildTree(files, scope);
    labelSessions(t, titles);
    return t;
  }, [files, scope, titles]);
  const dirOptions = useMemo(() => collectDirs(tree), [tree]);

  /** 相对路径 → 完整 key：写操作都按完整 key 谈 */
  const fullKey = (rel: string) => scope + rel;

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) await api.upload(f, target);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mkdir = async () => {
    const name = window.prompt("新建文件夹（想一次建几层就用 / 隔开）");
    if (!name?.trim()) return;
    setBusy(true);
    try {
      await api.mkdir(joinPath(target, name.trim()));
      setOpen((o) => new Set(o).add(target));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (n: FileNode) => {
    const next = window.prompt(n.dir ? "重命名文件夹" : "重命名文件", n.name);
    if (!next?.trim() || next.trim() === n.name) return;
    const at = n.path.lastIndexOf("/");
    const parent = at < 0 ? "" : n.path.slice(0, at);
    setBusy(true);
    try {
      await api.move(
        n.dir ? fullKey(n.path) : n.key,
        fullKey(joinPath(parent, next.trim())),
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const moveTo = async (n: FileNode, toRel: string) => {
    setBusy(true);
    try {
      await api.move(
        n.dir ? fullKey(n.path) : n.key,
        fullKey(joinPath(toRel, n.name)),
      );
      setMoving(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rm = async (n: FileNode) => {
    if (
      !window.confirm(
        n.dir
          ? `删掉文件夹「${n.label || n.name}」？里面的东西会一起没掉。`
          : `删掉「${showFile(n.name)}」？找不回来了。`,
      )
    )
      return;
    setBusy(true);
    try {
      if (n.dir) await api.deleteFolder(fullKey(n.path));
      else await api.deleteFile(n.key);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (path: string) => {
    setOpen((o) => {
      const s = new Set(o);
      if (s.has(path)) s.delete(path);
      else s.add(path);
      return s;
    });
  };

  const renderNode = (n: FileNode, depth: number): React.ReactElement => {
    const indent = { paddingLeft: depth * 14 + 2 };
    // 公开空间是墙不是抽屉：看和下载都行，整理（改名/搬/删）不归这间屋
    const publicArea = n.path === "公开空间" || n.path.startsWith("公开空间/");
    const inScope = !publicArea;
    if (n.dir) {
      const isOpen = open.has(n.path);
      return (
        <Fragment key={n.path}>
          <li className={`row ${target === n.path ? "file-target" : ""}`}>
            <div className="row-main">
              <button
                className="file-folder"
                style={indent}
                onClick={() => {
                  toggle(n.path);
                  setTarget(n.path);
                }}
                title="点开收起；再点一下设为上传去处"
              >
                <Icon name={isOpen ? "book-open" : "bookmark"} size={14} />
                <span>{n.label || n.name}</span>
                <span className="meta">
                  {n.children.length ? `${n.children.length} 项` : "空文件夹"}
                </span>
              </button>
            </div>
            {inScope && (
              <>
                <button
                  className="row-del"
                  title="重命名"
                  onClick={() => rename(n)}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  className="row-del"
                  title="删除文件夹"
                  onClick={() => rm(n)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </>
            )}
          </li>
          {isOpen && n.children.map((c) => renderNode(c, depth + 1))}
        </Fragment>
      );
    }
    const at = n.path.lastIndexOf("/");
    const myDir = at < 0 ? "" : n.path.slice(0, at);
    return (
      <li className="row" key={n.key}>
        <div className="row-main">
          <a
            href={api.fileUrl(n.key)}
            target="_blank"
            rel="noreferrer"
            style={indent}
          >
            {showFile(n.name)}
          </a>
          <span className="meta">
            {fmtSize(n.size)} · {n.uploaded.slice(0, 10)}
          </span>
        </div>
        {moving?.key === n.key ? (
          <>
            <select
              className="file-move"
              value={moving.dir}
              onChange={(e) => setMoving({ key: n.key, dir: e.target.value })}
            >
              <option value="">（云盘根目录）</option>
              {dirOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button
              className="row-del"
              title="确认移动"
              onClick={() => moveTo(n, moving.dir)}
            >
              <Icon name="check" size={13} />
            </button>
            <button
              className="row-del"
              title="取消"
              onClick={() => setMoving(null)}
            >
              <Icon name="x" size={13} />
            </button>
          </>
        ) : (
          inScope && (
            <>
              <button
                className="row-del"
                title="移动到…"
                onClick={() => setMoving({ key: n.key, dir: myDir })}
              >
                <Icon name="maximize" size={13} />
              </button>
              <button
                className="row-del"
                title="重命名"
                onClick={() => rename(n)}
              >
                <Icon name="edit" size={13} />
              </button>
              <button className="row-del" title="删除" onClick={() => rm(n)}>
                <Icon name="trash" size={13} />
              </button>
            </>
          )
        )}
      </li>
    );
  };

  return (
    <div className="panel-body">
      <div className="file-toolbar">
        <label className="upload">
          <input
            type="file"
            multiple
            onChange={(e) => upload(e.target.files)}
            disabled={busy}
            hidden
          />
          {busy ? "上传中…" : target ? `上传到「${target}」` : "选择文件上传"}
        </label>
        <button className="btn-ghost" onClick={mkdir} disabled={busy}>
          新建文件夹
        </button>
      </div>
      <ul className="rows">
        {tree.map((n) => renderNode(n, 0))}
        {!tree.length && (
          <li className="empty-sm">{loading ? "读取中…" : "云盘是空的"}</li>
        )}
      </ul>
      <p className="meta pad">
        对话里递进来的文件、他画出来的图、演示图和卡片，都按会话归在「会话」的各场里；
        「公开空间」是贴给进门人看的墙，看和下载都行，整理不归这间屋。
        点文件夹名设为上传去处，再点一下展开收起；重命名、移动、删除都是真删，删前想一下。
      </p>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
// ── 自我认知 ──────────────────────────────────────────

export function SelfPanel({
  state,
  patch,
}: {
  state: ChatState;
  patch: Patch;
}) {
  const [draft, setDraft] = useState(state.selfModel);
  const [saved, setSaved] = useState(false);
  // 自我要求是另一格：内核是「我知道什么」，这里是「我要求自己怎么做」。
  // 他自己在对话里用 self 工具改它，这一屏读写的也是同一格 —— 两边看的是一份东西。
  const demand = state.selfDemand ?? "";
  const [demandDraft, setDemandDraft] = useState(demand);
  const [demandSaved, setDemandSaved] = useState(false);
  const demandLog = state.selfDemandLog ?? [];

  useEffect(() => setDraft(state.selfModel), [state.selfModel]);
  useEffect(() => setDemandDraft(demand), [demand]);

  const save = async () => {
    await patch({
      selfModel: draft.slice(0, 1000),
      selfModelVer: state.selfModelVer + 1,
      selfLog: [
        ...state.selfLog,
        `${new Date().toISOString().slice(0, 10)}: 手动更新`,
      ].slice(-20),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveDemand = async () => {
    await patch({
      selfDemand: demandDraft.slice(0, 1000),
      selfDemandVer: (state.selfDemandVer || 0) + 1,
      selfDemandLog: [
        ...demandLog,
        `${new Date().toISOString().slice(0, 10)}: 手动更新`,
      ].slice(-20),
    });
    setDemandSaved(true);
    setTimeout(() => setDemandSaved(false), 1500);
  };

  return (
    <div className="panel-body">
      <p className="meta">版本 v{state.selfModelVer}</p>
      <textarea
        className="field big"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={10}
      />
      <button
        className="btn btn-primary btn-sm"
        onClick={save}
        disabled={draft === state.selfModel}
      >
        {saved ? "已保存" : "保存内核"}
      </button>

      <h3 className="sect">他对自己的要求</h3>
      <p className="meta">
        版本 v{state.selfDemandVer || 0}
        {demand.trim() ? "" : " · 他还没写过"}
      </p>
      <textarea
        className="field big"
        value={demandDraft}
        onChange={(e) => setDemandDraft(e.target.value)}
        rows={6}
        placeholder="这一格本来该由 ericher 自己填 —— 你也可以替他起个头，但别替他写完"
      />
      <button
        className="btn btn-primary btn-sm"
        onClick={saveDemand}
        disabled={demandDraft === demand}
      >
        {demandSaved ? "已保存" : "保存要求"}
      </button>
      <p className="meta pad">
        内核是「我知道什么」，这一格是「我要求自己成为什么样、怎么做」。
        分开是因为前者越攒越厚，后者得他主动立 —— 混着写，成长就变成了流水账。
      </p>

      <p className="meta pad">
        他累计从经历里长出的经验：{state.expCount || 0} 条。
        这些不是你说过的话，是他自己复盘出来的做法，在「上下文记忆」的「模式」分类里，你随时能删。
      </p>

      {!!state.selfLog.length && (
        <>
          <h3 className="sect">成长日志</h3>
          <ul className="rows">
            {[...state.selfLog].reverse().map((l, i) => (
              <Row key={i}>
                <p>{l}</p>
              </Row>
            ))}
          </ul>
        </>
      )}

      {!!demandLog.length && (
        <>
          <h3 className="sect">要求的变更记录</h3>
          <ul className="rows">
            {[...demandLog].reverse().map((l, i) => (
              <Row key={i}>
                <p>{l}</p>
              </Row>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── 提示词（守则 / 工具守则 / 回想守则）──────────────────

/**
 * 提示词编辑器：三份共用。空串 = 内置默认，初值用出厂值兜底（否则会以为丢了）；
 * 只在外部值变化时同步草稿，避免打字被覆盖。
 */
function PromptEditor({
  rows,
  hint,
  current,
  fallback,
  onSave,
  onReset,
}: {
  rows: number;
  hint: string;
  current: string;
  fallback: string;
  onSave: (text: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(current || fallback);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(current || fallback);
  }, [current, fallback]);

  const custom = current.trim().length > 0;

  return (
    <div className="panel-body">
      <p className="meta">
        {custom ? "当前使用自定义版本" : "当前使用内置默认版本"} ·{" "}
        {draft.length} 字
      </p>
      <textarea
        className="field big"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={rows}
      />
      <div className="row-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={async () => {
            await onSave(draft);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
          disabled={draft === (current || fallback)}
        >
          {saved ? "已保存" : "保存"}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onReset}
          disabled={!custom}
        >
          恢复默认
        </button>
      </div>
      <p className="meta pad">{hint}</p>
    </div>
  );
}

/**
 * 两份默认稿都在 /api/prompt 里一次取回（守则 / 回想守则）。
 * 工具那份不在这里 —— 它拆成了逐工具的稿子，出厂稿随名册走，见 /api/tool-groups。
 */
function usePromptDefaults() {
  const [defaults, setDefaults] = useState({ base: "", recap: "" });
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .getDefaultPrompt()
      .then(setDefaults)
      .catch((e: Error) => setErr(e.message));
  }, []);
  return { defaults, err };
}

/** 工作守则：ericher 的第一人称行为底稿（「我的活是什么、边界在哪」） */
export function PromptPanel({
  state,
  patch,
}: {
  state: ChatState;
  patch: Patch;
}) {
  const { defaults, err } = usePromptDefaults();
  return (
    <>
      <PromptEditor
        rows={18}
        hint="改完即刻生效，下一轮对话就会带上新的工作守则。"
        current={state.basePrompt ?? ""}
        fallback={defaults.base}
        onSave={async (text) => void (await patch({ basePrompt: text }))}
        onReset={async () => void (await patch({ basePrompt: "" }))}
      />
      {err && <p className="err">{err}</p>}
    </>
  );
}

/**
 * 一格稿子：草稿 + 失焦落库。工具守则格子有几十个，每格再摆保存按钮会吵得没法看，
 * 所以失焦（或 Ctrl/Cmd+Enter）即落库，右上角标自定义/默认；内容没变不打扰后端。
 */
function GuideField({
  label,
  hint,
  value,
  fallback,
  rows = 2,
  onSave,
  onReset,
}: {
  label: string;
  hint?: string;
  value: string;
  fallback: string;
  rows?: number;
  onSave: (text: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(value || fallback);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const custom = value.trim().length > 0;

  useEffect(() => {
    setDraft(value || fallback);
  }, [value, fallback]);

  // 高度自适应：内容几行就几行，不摆一个固定高度的空框
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const commit = async () => {
    const text = draft.trim();
    if (text === (value || fallback).trim()) return;
    await onSave(text);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="guide-field">
      <div className="guide-field-head">
        <span className="guide-field-label">{label}</span>
        {saved && <span className="meta">已保存</span>}
        <span className="meta">{custom ? "自定义" : "默认"}</span>
        {custom && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await onReset();
              setSaved(true);
              setTimeout(() => setSaved(false), 1200);
            }}
          >
            恢复默认
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        className="field guide-textarea"
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void commit();
        }}
      />
      {hint && <p className="meta pad">{hint}</p>}
    </div>
  );
}

type ToolGuideSide = "owner" | "guest";

/**
 * 工具守则：语义组 → 逐工具。改一件不影响别的；名册来自 /api/tool-groups；
 * 主人/来客两套分开存，覆盖值不漏到别人屋里。
 */
export function ToolGuidePanel({
  state,
  patch,
}: {
  state: ChatState;
  patch: Patch;
}) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [err, setErr] = useState("");
  const [side, setSide] = useState<ToolGuideSide>("owner");
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .getToolGroups()
      .then(setCatalog)
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (err)
    return (
      <div className="panel-body">
        <p className="err">{err}</p>
      </div>
    );
  if (!catalog)
    return (
      <div className="panel-body">
        <p className="empty-sm">读取中…</p>
      </div>
    );

  const guest = side === "guest";
  const defs = catalog.defaults[side];
  // 当前自定义从 state 取（catalog.current 是请求那一刻的快照，改完不会回灌）
  const cur = guest
    ? {
        prompts: state.guestToolPrompts ?? {},
        groupNotes: state.guestToolGroupNotes ?? {},
        style: state.guestToolStyle ?? "",
      }
    : {
        prompts: state.toolPrompts ?? {},
        groupNotes: state.toolGroupNotes ?? {},
        style: state.toolStyle ?? "",
      };

  // 三格各自的落库目标：同一份逻辑走主人/来客两套字段
  const writePrompt = (name: string, text: string) =>
    void patch(
      (guest
        ? { guestToolPrompts: { ...cur.prompts, [name]: text } }
        : {
            toolPrompts: { ...cur.prompts, [name]: text },
          }) as Partial<ChatState>,
    );
  const writeNote = (gid: string, text: string) =>
    void patch(
      (guest
        ? { guestToolGroupNotes: { ...cur.groupNotes, [gid]: text } }
        : {
            toolGroupNotes: { ...cur.groupNotes, [gid]: text },
          }) as Partial<ChatState>,
    );
  const writeStyle = (text: string) =>
    void patch(
      (guest
        ? { guestToolStyle: text }
        : { toolStyle: text }) as Partial<ChatState>,
    );

  // 组内该露脸的工具：主人那间 = owner，来客那间 = guest
  const groups: Array<{ def: ToolGroupDef; tools: ToolCatalog["tools"] }> =
    catalog.groups
      .map((def) => ({
        def,
        tools: catalog.tools.filter(
          (t) => t.group === def.id && (guest ? t.guest : t.owner),
        ),
      }))
      .filter((g) => g.tools.length);

  return (
    <div className="panel-body">
      <p className="meta">
        一件工具一格：改一件不影响别的。改完移开焦点即保存（Ctrl/⌘+Enter
        也行）。 「默认」是按出厂稿说的，「自定义」才用你写的那句。
      </p>

      <div className="tabs">
        <button
          className={`chip ${!guest ? "on" : ""}`}
          onClick={() => setSide("owner")}
        >
          主人那间
        </button>
        <button
          className={`chip ${guest ? "on" : ""}`}
          onClick={() => setSide("guest")}
        >
          来客那间
        </button>
      </div>
      <p className="meta pad">
        {guest
          ? "来客那间另有一份，与主人这份互不影响。这里写的只对来客生效；档位关掉的工具不出现在提示词里，写了也用不上。"
          : "主人那间这份改的是你自己的助手；来客那间那份在另一个标签页里改。"}
      </p>

      {groups.map(({ def, tools }) => {
        const open = !closed[def.id];
        return (
          <div className="guide-group" key={def.id}>
            <button
              className="guide-group-head"
              onClick={() => setClosed((prev) => ({ ...prev, [def.id]: open }))}
              aria-expanded={open}
            >
              <Icon name={open ? "minus" : "plus"} />
              <span className="guide-group-label">{def.label}</span>
              <span className="meta">{def.hint}</span>
              <span className="meta">{tools.length} 件</span>
            </button>
            {open && (
              <div className="guide-group-body">
                {tools.map((t) => (
                  <GuideField
                    key={t.name}
                    label={`${toolMeta(t.name).zh}（${t.name}）${
                      t.resident ? " · 直接调" : " · 经 call_tool 调"
                    }`}
                    value={cur.prompts[t.name] ?? ""}
                    fallback={defs.prompts[t.name] ?? ""}
                    onSave={(text) => {
                      writePrompt(t.name, text);
                      return Promise.resolve();
                    }}
                    onReset={() => {
                      writePrompt(t.name, "");
                      return Promise.resolve();
                    }}
                  />
                ))}
                <GuideField
                  label={`【${def.label}】本组取舍`}
                  hint="这一组里什么话用哪件，写在组末。"
                  value={cur.groupNotes[def.id] ?? ""}
                  fallback={defs.groupNotes[def.id] ?? ""}
                  rows={3}
                  onSave={(text) => {
                    writeNote(def.id, text);
                    return Promise.resolve();
                  }}
                  onReset={() => {
                    writeNote(def.id, "");
                    return Promise.resolve();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}

      <div className="guide-group">
        <div className="guide-group-head static">
          <span className="guide-group-label">工具组使用风格</span>
          <span className="meta">跨组的话：调用纪律、call_tool、主动开口</span>
        </div>
        <div className="guide-group-body">
          <GuideField
            label="使用风格"
            value={cur.style}
            fallback={defs.style}
            rows={7}
            onSave={(text) => {
              writeStyle(text);
              return Promise.resolve();
            }}
            onReset={() => {
              writeStyle("");
              return Promise.resolve();
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 回想守则：没人说话半小时后，她回头整理这场对话时读的提示词。
 * 默认口径是工作纪要而非感想；改的是「记什么」，只影响之后的回想，不追溯已入库条目。
 */
export function RecapGuidePanel({
  state,
  patch,
}: {
  state: ChatState;
  patch: Patch;
}) {
  const { defaults, err } = usePromptDefaults();
  return (
    <>
      <PromptEditor
        rows={12}
        hint="没人说话半小时后，她回头整理这场对话时读的提示词。改完只影响之后的回想，不追溯已入库的条目。"
        current={state.recapPrompt ?? ""}
        fallback={defaults.recap}
        onSave={async (text) => void (await patch({ recapPrompt: text }))}
        onReset={async () => void (await patch({ recapPrompt: "" }))}
      />
      {err && <p className="err">{err}</p>}
    </>
  );
}
// ── 会话 ──────────────────────────────────────────────

/**
 * 会话管理：消息存在后端 DO，点「切过去」是真的换对话。列表由 App 统一加载，
 * 这里只渲染与转发，免得侧栏和设置页各拉一份。
 */
export function SessionSection({
  list,
  active,
  onSwitch,
  onRename,
  onDelete,
  onToggleVisibility,
  onToggleArchive,
  onTogglePin,
  summaries,
}: {
  list: SessionMeta[];
  active: string;
  onSwitch: (id: string, title: string) => void;
  onRename: (s: SessionMeta) => void;
  onDelete: (s: SessionMeta) => void;
  onToggleVisibility: (s: SessionMeta) => void;
  onToggleArchive: (s: SessionMeta) => void;
  onTogglePin: (s: SessionMeta) => void;
  summaries: Summary[];
}) {
  // 置顶的排前面（按置顶的先后），其余照旧按创建时间倒序（后端已排好）
  const live = list
    .filter((s) => !s.archived)
    .sort((a, b) =>
      a.pinned && b.pinned
        ? a.pinned < b.pinned
          ? -1
          : a.pinned > b.pinned
            ? 1
            : 0
        : a.pinned
          ? -1
          : b.pinned
            ? 1
            : 0,
    );
  const shelved = list.filter((s) => s.archived);
  return (
    <div className="panel-body">
      <ul className="rows">
        {live.map((s) => (
          <Row key={s.id}>
            <div className="session-line">
              <button
                className={`link ${s.id === active ? "on" : ""}`}
                onClick={() => onSwitch(s.id, s.title)}
              >
                {s.title}
              </button>
              <span
                className={`tag ${s.visibility === "public" ? "ok" : "ghost"}`}
              >
                {s.visibility === "public" ? "公开" : "私有"}
              </span>
              {s.pinned && <span className="tag">置顶</span>}
              {s.id === active && <span className="tag">当前</span>}
              {s.hasDigest && (
                <span
                  className="tag ghost"
                  title="这场更早的对话已被压成提要（原文还在，旧会话里照样搜得到）"
                >
                  早段已摘要
                </span>
              )}
            </div>
            <span className="meta">
              {s.msgCount} 条 · {s.lastActive.slice(0, 16).replace("T", " ")}
            </span>
            <div className="row-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onSwitch(s.id, s.title)}
              >
                切过去
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onTogglePin(s)}
                title={s.pinned ? "取消置顶" : "置顶，排到置顶区末尾"}
              >
                {s.pinned ? "取消置顶" : "置顶"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onToggleVisibility(s)}
              >
                {s.visibility === "public" ? "收回" : "公开"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onRename(s)}
              >
                重命名
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onToggleArchive(s)}
                title="不删，只是收起来"
              >
                收起
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => onDelete(s)}
              >
                删除
              </button>
            </div>
          </Row>
        ))}
        {!live.length && (
          <li className="empty-sm">
            {shelved.length
              ? "在聊的都收起来了，展开下面「已归档」能看到"
              : "还没有会话记录"}
          </li>
        )}
      </ul>

      {!!shelved.length && (
        <>
          <h3 className="sect">已归档 · {shelved.length}</h3>
          <ul className="rows">
            {shelved.map((s) => (
              <Row key={s.id}>
                <div className="session-line">
                  <button
                    className={`link ${s.id === active ? "on" : ""}`}
                    onClick={() => onSwitch(s.id, s.title)}
                  >
                    {s.title}
                  </button>
                  {s.visibility === "public" && (
                    <span className="tag ghost">公开（已收起）</span>
                  )}
                  {s.id === active && <span className="tag">当前</span>}
                </div>
                <span className="meta">
                  {s.msgCount} 条 · 最后聊于 {s.lastActive.slice(0, 10)}
                </span>
                <div className="row-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onToggleArchive(s)}
                  >
                    展开
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => onDelete(s)}
                  >
                    删除
                  </button>
                </div>
              </Row>
            ))}
          </ul>
        </>
      )}

      <p className="meta pad">
        每场会话有自己的消息，切过去就是真的回到那一场。聊得久了，很早以前的部分会压成一段提要
        （原文一条不删，只是不再整段重发），标着「早段已摘要」的就是这种。
        {shelved.length > 0 &&
          ` 归档的 ${shelved.length} 场只是从列表上挪开了：内容、提要、搜索都还在，想接着聊点「展开」就回来。`}
      </p>

      {!!summaries.length && (
        <>
          <h3 className="sect">会话摘要</h3>
          <ul className="rows">
            {[...summaries].reverse().map((s, i) => (
              <Row key={i}>
                <span className="meta">
                  {s.ts.slice(0, 16).replace("T", " ")} · {s.msgCount} 条
                </span>
                <p>{s.summary}</p>
              </Row>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
// ── 朗读嗓音 ──────────────────────────────────────────

/**
 * 嗓子出自哪一路：provider 是协议名，翻成人话；没对上号就显示原值（不挡新协议）。
 * 标出来是因为一家念不出来通常一整排都灰 —— 一看就知道去修哪条配置。
 */
const PROVIDER_LABEL: Record<string, string> = {
  "mimo-chat": "MiMo 式",
  doubao: "豆包",
  "glm-speech": "智谱",
  minimax: "MiniMax",
};

/**
 * 挑一副念给你听的嗓子。「试听」必须留着：音色名看不出好不好听，得让耳朵定。
 * 选择记在 state 而非 localStorage —— 换设备还是同一个人。
 */
export function VoicePanel({
  voices,
  current,
  fallback,
  cloud,
  patch,
}: {
  voices: Voice[];
  current: string;
  /** 没选时实际用哪一副。选了就以后端记的为准，这里只看「没选」那一种情况 */
  fallback: string;
  /** 这台机器接上云端嗓子了吗。没接上就等于每句话都是浏览器音色在念 —— 这事得说出来 */
  cloud: boolean;
  patch: Patch;
}) {
  // 正在试听哪一副；空串 = 没在听
  const [trying, setTrying] = useState("");
  // 这家念不出来 —— 不提示的话，点了没声音会让人以为是自己没点到
  const [bad, setBad] = useState("");

  // 人离开这一页，声音就该停。退出了还在背后念，是件挺吓人的事。
  useEffect(() => () => stopSpeaking(), []);

  const tryOne = async (v: Voice) => {
    if (trying === v.id) {
      stopSpeaking();
      setTrying("");
      return;
    }
    stopSpeaking();
    setBad("");
    // 「正在念」是先举手后出声：念成了由 onEnd/下面的分支收旗，
    // 念砸了（promise 直接 reject）也得有人收 —— 不然按钮永远停在「停」上
    setTrying(v.id);
    try {
      const r = await speak("你好，我是 ericher。以后就由我来念。", v.id, () =>
        setTrying(""),
      );
      if (r.by === "cloud") return;
      setTrying("");
      if (r.by === "browser") {
        // 云端没接上、退成了系统音色。不说清楚的话，人会把那个难听的嗓子
        // 当成「这一副就长这样」，于是以为换嗓子根本没用 —— 其实是要去修配置。
        setBad(
          `「${v.label}」没念成：${r.why}。刚才那句是浏览器自带的音色念的。`,
        );
      } else {
        setBad(`「${v.label}」没念出声音，换一个试试，或者稍后再来。`);
      }
    } catch {
      // 朗读这条路真出了错（不是「没念成」那种带着原因回来的）：
      // 把卡住的「正在念」复位，并照实说一句，别让人对着不动的按钮干等
      setTrying("");
      setBad(`「${v.label}」试听出了错，稍后再试一次。`);
    }
  };

  const pick = async (v: Voice) => {
    stopSpeaking();
    setTrying("");
    setBad("");
    await patch({ voice: v.id });
  };

  // 清单是空的：读音服务一条都没配上（或全停了）。别说成「没连上」——
  // 那会让人以为是自己网络的问题，其实该去读音配置里添条目。没有可选项，选择自然禁用。
  if (!voices.length) {
    return (
      <div className="panel-body">
        <p className="empty-sm">未配置读音服务。</p>
        <p className="meta pad">
          「读音配置」里还没有可用条目，现在朗读用的是浏览器自带的音色。
          到读音配置里添一条（协议、Key、音色配齐），这里的嗓子清单就回来了。
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body">
      {bad && <p className="empty-sm">{bad}</p>}
      {!cloud && (
        <p className="empty-sm">
          这台机器还没接上云端嗓子，现在每句话都是浏览器自带的音色在念 ——
          能出声，但确实不好听。
          下面标着「用不了」的那几副，配好对应的钥匙就能用。
        </p>
      )}
      <ul className="rows">
        {voices.map((v) => {
          // 默认那一副也要标出来 —— 否则「我自己选的」和「在用的」看起来一模一样，
          // 用户会以为是自己选错了
          const chosen = v.available && current === v.id;
          const on = v.available && (chosen || (!current && fallback === v.id));
          // 音色 id 翻成人话名：光看 female-shaonv 谁也不知道是什么嗓子
          const desc = v.voice ? `音色 ${voiceLabel(v.provider, v.voice)}` : v.desc;
          return (
            <Row
              key={v.id}
              actions={
                v.available ? (
                  <button
                    className="row-act"
                    onClick={() => tryOne(v)}
                    title={trying === v.id ? "别念了" : "先听一句，再决定"}
                  >
                    {trying === v.id ? "停" : "试听"}
                  </button>
                ) : undefined
              }
            >
              <div className="session-line">
                {/* 用不了的嗓子不给点：点了会退到别的嗓子发声，听到的和名字对不上，更让人糊涂 */}
                <button
                  className={`link ${on ? "on" : ""}`}
                  disabled={!v.available}
                  onClick={() => v.available && pick(v)}
                >
                  {v.label}
                </button>
                <span className="tag ghost">
                  {PROVIDER_LABEL[v.provider] || v.provider}
                </span>
                {v.available ? (
                  on && (
                    <span className="tag ok">
                      {chosen ? "正在用" : "正在用（默认）"}
                    </span>
                  )
                ) : (
                  <span className="tag warn">用不了</span>
                )}
              </div>
              <span className="meta">
                {v.available ? desc : `${desc} —— ${v.why}`}
              </span>
            </Row>
          );
        })}
      </ul>
      <p className="meta pad">
        点名字就换成那一副，点「试听」先听一句 ——
        选好之后，以后他开口都是这个声音，换个设备打开也一样。
        标着「用不了」的那几副，多半是那条读音配置的 Key 还没配对 ——
        到「读音配置」里把那一目的变量名改好，嗓子就回来了。
        {current ? (
          <>
            {" "}
            <button
              className="link"
              onClick={() => {
                stopSpeaking();
                setTrying("");
                setBad("");
                void patch({ voice: "" });
              }}
            >
              还是交给你决定
            </button>
            （改回默认，以后哪副好听就用哪副）
          </>
        ) : (
          " 你没选，上面标着「正在用（默认）」的就是此刻在念的那一副。"
        )}
      </p>
    </div>
  );
}
// ── 来客（谁进过门、都做了什么）────────────────────────

/** 留痕类型翻成人话。后端 kind：join / message / intro / panel */
const VISITOR_KIND: Record<string, string> = {
  join: "进门",
  message: "发言",
  intro: "自我介绍",
  panel: "面板",
};

/**
 * 来客名册 + 单个来客的留痕明细。介绍页当面承诺过「你随时可以问他记了你什么」，
 * 这里是承诺的管理员侧。明细留在各来客屋（点开才隔 DO 取），失败就地写一句。
 */
export function VisitorsPanel() {
  const [rooms, setRooms] = useState<VisitorRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  /** 正在展开哪一位的明细；空串 = 都收着 */
  const [openRoom, setOpenRoom] = useState("");
  const [events, setEvents] = useState<VisitorEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsErr, setEventsErr] = useState("");
  /** 卡与档位名映射：卡按 room 拼进名册行 —— 同一个人只出现一行，持卡以标签呈现 */
  const [cards, setCards] = useState<UserCard[]>([]);
  const [typeNames, setTypeNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      // 持卡人名单拉不到不该拖住来客名册：各自兜底，谁挂了谁自己显示空
      const [vs, cs, ts] = await Promise.all([
        api.visitors(),
        api.cards().catch(() => [] as UserCard[]),
        api.guestTypes().catch(() => [] as GuestType[]),
      ]);
      setRooms(vs);
      setCards(cs);
      setTypeNames(Object.fromEntries(ts.map((t) => [t.id, t.name])));
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

  const open = async (room: string) => {
    if (openRoom === room) {
      setOpenRoom("");
      return;
    }
    setOpenRoom(room);
    setEvents([]);
    setEventsErr("");
    setEventsLoading(true);
    try {
      setEvents(await api.visitorEventsOf(room));
    } catch (e) {
      setEventsErr((e as Error).message);
    } finally {
      setEventsLoading(false);
    }
  };

  // 拼合：卡都绑着房间（领卡那一刻所在的那间），按 room 对上名册行，
  // 同一个人只出现一次，持卡以档位标签呈现。万一房间先没了卡还在（理论边界），
  // 也单独摆出来 —— 管理员视角少一行人比多一行更糟。
  const roomIds = new Set(rooms.map((r) => r.room));
  const orphanCards = cards.filter((c) => !roomIds.has(c.room));

  return (
    <div className="panel-body">
      <h3 className="sect">
        来客名册（{rooms.length}
        {!!cards.length && ` · 持卡 ${cards.length}`}）
      </h3>

      <ul className="remind-list">
        {rooms.map((r) => {
          const card = cards.find((c) => c.room === r.room);
          return (
            <li className="remind-row" key={r.room}>
              <div className="remind-when">
                <button
                  className="link"
                  onClick={() => void open(r.room)}
                  title="点开看这位来客的留痕明细"
                >
                  <Icon
                    name={
                      openRoom === r.room ? "chevron-down" : "chevron-right"
                    }
                    size={13}
                  />{" "}
                  {r.nickname || "没留称呼"}
                </button>
                {card && (
                  <span
                    className="tag ghost"
                    title="领过身份卡：凭「昵称 + 密码」随时回到这间屋"
                  >
                    {card.typeId === "common"
                      ? "通用档"
                      : typeNames[card.typeId] || card.typeId}
                  </span>
                )}
              </div>
              <div className="remind-when">
                <Icon name="user" size={15} />
                <span className="meta">{r.room}</span>
              </div>
              {card?.purpose && <p className="remind-what">{card.purpose}</p>}
              <div className="remind-foot">
                <span className="meta">
                  首次 {fmtWhen(r.firstSeen)} · 最近 {fmtWhen(r.lastSeen)}
                  {card &&
                    ` · ${card.email ? `邮箱 ${card.email}` : "没留邮箱"}`}
                </span>
              </div>

              {openRoom === r.room && (
                <div className="panel-body">
                  {eventsLoading && <p className="empty-sm">读取中…</p>}
                  {eventsErr && <p className="err">{eventsErr}</p>}
                  {!eventsLoading && !eventsErr && !events.length && (
                    <p className="empty-sm">这位来客还没有留痕。</p>
                  )}
                  {!!events.length && (
                    <ul className="remind-list">
                      {events.map((ev) => (
                        <li className="remind-row" key={ev.id}>
                          <div className="remind-when">
                            <span className="tag">
                              {VISITOR_KIND[ev.kind] || ev.kind}
                            </span>
                            <span className="meta">{fmtWhen(ev.ts)}</span>
                            {ev.nickname && (
                              <span className="tag ghost">{ev.nickname}</span>
                            )}
                          </div>
                          {ev.detail && (
                            <p className="remind-what">{ev.detail}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {orphanCards.map((c) => (
          <li className="remind-row" key={c.id}>
            <div className="remind-when">
              <strong>{c.name}</strong>
              <span className="tag ghost">
                {c.typeId === "common"
                  ? "通用档"
                  : typeNames[c.typeId] || c.typeId}
              </span>
              <span className="meta">绑定的房间已不在名册</span>
            </div>
            <div className="remind-foot">
              <span className="meta">
                {c.email ? `邮箱 ${c.email}` : "没留邮箱"} · 最近活跃{" "}
                {fmtWhen(c.lastSeen)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !rooms.length && !err && (
        <p className="empty-sm">还没有来客进过门。</p>
      )}

      <p className="meta pad">
        留痕是介绍页里当面说明过的：来客说过什么、动过哪些面板，一笔一笔记在他自己那间屋里。
        客人问起「记了我什么」，把这一页摊给他看就行。行首带档位标签的是持卡来客：
        卡是长期身份，领卡那一刻所在的屋子跟着卡走，凭「昵称 + 密码」随时回来。
        邮箱只登记不发送 —— 这台机器没有邮件通道，这里是人工联系用的底账。
      </p>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

// ── 来客类型（口令与说明）──
// 权益不在这里改（逐工具矩阵在「来客权限管理」页）；这一页只管有哪些档、
// 各用什么口令、怎么接待。新建的档默认对外工具全开。

/** 弹页认的「新增」标记；其余非空值是档位 id（编辑），空串 = 弹页关着 */
const GUEST_NEW = "__new";

/**
 * 来客类型管理：一个自定义口令一类来客。口令后端只存 SHA-256、永不回显，忘了只能重设；
 * 停用 ≠ 删除（配置保留）；改动对之后新登录的来客生效。
 */
export function GuestTypesPanel() {
  const [types, setTypes] = useState<GuestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 列表行只读，改的都是「打开弹页那一刻拍下的草稿」，按下保存才提交。
  // hook 一律留在函数体最上面：放到条件分支或早退之后，React 会报
  // "Rendered more hooks than during the previous render"，面板就停在读取中不动了。
  const form = useDraft<GuestFormDraft>(blankGuestDraft());
  const [dialog, setDialog] = useState("");
  const [dialogErr, setDialogErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setTypes(await api.guestTypes());
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

  const patch = (p: Partial<GuestFormDraft>) =>
    form.setDraft((prev) => ({ ...prev, ...p }));

  // 新增与编辑共用同一个弹页：空草稿就是新增，快照就是编辑
  const openAdd = () => {
    form.reset(blankGuestDraft());
    setDialogErr("");
    setDialog(GUEST_NEW);
  };

  const openEdit = (t: GuestType) => {
    form.reset(guestDraftOf(t));
    setDialogErr("");
    setDialog(t.id);
  };

  const closeDialog = () => {
    setDialog("");
    setDialogErr("");
  };

  const isNew = dialog === GUEST_NEW;
  const editing = isNew ? null : types.find((t) => t.id === dialog) || null;
  // 内置通用档：口令取自 env，没有重设这一说（后端见它带口令直接抛）
  const builtin = editing?.id === COMMON_TYPE_ID;

  const save = async () => {
    if (!dialog || saving) return;
    const missing = guestMissingFields(form.draft, isNew);
    if (missing.length) {
      setDialogErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSaving(true);
    setDialogErr("");
    try {
      if (isNew)
        // 对外工具与长期权益都不带：走后端缺省（新档对外全开、长期全关），
        // 之后到「来客权限管理」页按件调
        await api.guestTypeAdd({
          name: form.draft.name.trim(),
          password: form.draft.password.trim(),
          note: form.draft.note.trim(),
        });
      else {
        // 口令留空 = 不改，干脆不带这个字段；填了才重设
        const password = guestPasswordValue(form.draft.password);
        await api.guestTypePatch({
          id: dialog,
          name: form.draft.name.trim(),
          note: form.draft.note.trim(),
          ...(password ? { password } : {}),
        });
      }
      // 成功后重新拉一遍名册再关窗：列表显示的是落库后的真值，不做乐观更新
      await load();
      setDialog("");
    } catch (e) {
      // 后端校验不过（如口令和现有的重复）原样摆在弹页里，不关窗
      setDialogErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (t: GuestType) => {
    await api
      .guestTypePatch({ id: t.id, active: !t.active })
      .catch((e: Error) => setErr(e.message));
    await load();
  };

  const del = async (t: GuestType) => {
    if (!window.confirm(`删掉「${t.name}」？这个口令之后就进不来了。`)) return;
    await api.guestTypeDelete(t.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  return (
    <div className="panel-body">
      <p className="meta">
        不同口令进来是不同类型：各自独立房间与记忆。这一页只管档位与口令；
        各档能用哪些工具，去「来客权限管理」页按件勾。口令只存摘要不回显，忘了就在编辑里重设。改动对之后新登录的来客生效。
        第一行的「通用来客」是内置的默认档 —— 拿前台门禁口令进来的人都归它，
        口令取自环境变量，改不得也删不得。
      </p>

      <h3 className="sect">类型（{types.length}）</h3>
      <EntityAddButton label="新增类型" onClick={openAdd} />

      {!!types.length && (
        <div className="entity-list">
          {types.map((t) => {
            // 内置通用档恒在名册第一行：拿前台门禁口令进来的人都归它。
            // 它跟自定义档一样能调工具与接待说明，但口令取自 env、也删不得停不得。
            const isBuiltin = t.id === COMMON_TYPE_ID;
            return (
              <EntityRow
                key={t.id}
                title={t.name}
                summary={guestTypeSummary(t)}
                disabled={!t.active}
                editing={dialog === t.id}
                onEdit={() => openEdit(t)}
                onDelete={isBuiltin ? undefined : () => void del(t)}
                deleteConfirm={`删掉「${t.name}」？这个口令之后就进不来了。`}
                right={
                  isBuiltin ? (
                    <span
                      className="tag"
                      title="前台门禁口令进来的来客都归这一档"
                    >
                      内置
                    </span>
                  ) : (
                    // 停用/启用是动作，留在行上常驻：弹页只管叫什么、怎么接待、口令换成什么
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void toggleActive(t)}
                    >
                      {t.active ? "停用" : "启用"}
                    </button>
                  )
                }
              />
            );
          })}
        </div>
      )}

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !types.length && !err && (
        <p className="empty-sm">
          还没有自定义类型。名册里只有内置的「通用来客」—— 拿前台门禁口令进来
          的人都归这一档，它的工具在「来客权限管理」页按件调。
        </p>
      )}

      {err && <p className="err">{err}</p>}

      {/* 档位弹页：新增与编辑共用同一份表单，空草稿即新增 */}
      {dialog && (
        <FormDialog
          title={isNew ? "新增类型" : `编辑「${editing?.name ?? ""}」`}
          busy={saving}
          error={dialogErr}
          dirty={form.dirty(form.draft)}
          onClose={closeDialog}
          onSave={() => void save()}
        >
          <FormSection title="档位">
            <FormRow label="名称" hint="必填">
              <input
                className="field"
                placeholder="名称（必填）"
                value={form.draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </FormRow>
            <FormRow label="接待说明" hint="可空" wide>
              <input
                className="field"
                placeholder="说明（可空）"
                value={form.draft.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="口令">
            {!builtin && (
              <FormRow
                label={isNew ? "进门口令" : "重设口令"}
                hint={
                  isNew
                    ? "必填；只存摘要，之后不回显"
                    : "留空 = 不改；填了才换成新口令"
                }
              >
                <input
                  className="field"
                  placeholder={isNew ? "口令（必填）" : "口令（留空 = 不改）"}
                  value={form.draft.password}
                  onChange={(e) => patch({ password: e.target.value })}
                />
              </FormRow>
            )}
            <EntityNote>
              {builtin
                ? "口令就是前台门禁口令，取自环境变量，改不得；这一档也停不得、删不得 —— 它是门口最后一把钥匙。"
                : "口令只存摘要、不回显：摘要不可逆，忘了就在这里重设一个。一档不能没有口令，所以这里没有「清除」这一说 —— 真不要这个口令就删掉整档。"}{" "}
              对外工具与长期权益到「来客权限管理」页按件调。
              {isNew
                ? " 新档默认对外工具全开、长期权益全关：先来的是临时来客，私人空间等他领了卡再说。"
                : ""}
            </EntityNote>
          </FormSection>

          {/* 权限这格只读：这一页没有改工具的那条路，但得让人看清现在开着什么 */}
          {editing && (
            <FormSection title="这一档现在开着">
              <div className="tabs">
                {editing.tools.length ? (
                  editing.tools.map((n) => (
                    <span
                      key={n}
                      className="chip on"
                      style={{ cursor: "default" }}
                    >
                      {toolMeta(n).zh}
                    </span>
                  ))
                ) : (
                  <span className="meta">对外工具全关</span>
                )}
              </div>
              <EntityNote>
                {GUEST_CARD_PERMS.map((p) => `${p.label} ${editing[p.key] ? "开" : "关"}`).join(" · ")}
                —— 这三项只对持身份卡的长期使用者生效。
              </EntityNote>
            </FormSection>
          )}
        </FormDialog>
      )}
    </div>
  );
}

// ── 来客权限管理（各档 × 各工具）──────────────────────

/**
 * 长期权益：临时来客没有持久身份，谈不上「自己的」东西 ——
 * 这组开关只对持身份卡的长期使用者生效（见 src/index.ts cardAllows）。
 */
const CARD_PERMS: Array<{
  key: "permNotes" | "permFiles" | "permPublic" | "permMatrix";
  label: string;
  hint: string;
}> = [
  { key: "permNotes", label: "记事本", hint: "给自己写私人草稿的笔记本" },
  { key: "permFiles", label: "云盘上传", hint: "上传并管理自己的文件" },
  {
    key: "permPublic",
    label: "公开内容",
    hint: "往公共墙上贴纸条、看公开文件",
  },
  {
    key: "permMatrix",
    label: "权限矩阵",
    hint: "网页矩阵的整面管理权（不拆子权限）—— 后果见这一节下面那句话",
  },
];

/**
 * 来客权限管理：每行一档、每列一件工具。可关的逐件勾，恒开的置灰（介绍页承诺过）；
 * 名册来自 /api/tool-groups，改一格立刻 PATCH 整份清单；对之后新登录的来客生效。
 */
export function GuestPermsPanel() {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [types, setTypes] = useState<GuestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  // 一次只发一张 PATCH：next 从渲染闭包的 t.tools 算出，并发时后写会盖掉先写
  // （两次都成功，刷新后只有一格生效）。hook 必须在早退之前，否则 hooks 数量会变。
  const submitting = useRef(false);

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([api.getToolGroups(), api.guestTypes()]);
      setCatalog(c);
      setTypes(t);
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

  if (!catalog)
    return (
      <div className="panel-body">
        {err ? (
          <p className="err">{err}</p>
        ) : (
          <p className="empty-sm">读取中…</p>
        )}
      </div>
    );

  const guestTools = catalog.tools.filter((t) => t.guest);
  const togglable = guestTools.filter((t) => t.guestTogglable);
  const alwaysOn = guestTools.filter((t) => !t.guestTogglable);

  const setTool = async (t: GuestType, name: string, on: boolean) => {
    const next = on
      ? [...new Set([...t.tools, name])]
      : t.tools.filter((x) => x !== name);
    if (submitting.current) return;
    submitting.current = true;
    setBusy(`${t.id}:${name}`);
    try {
      const saved = await api.guestTypePatch({ id: t.id, tools: next });
      setTypes((current) =>
        current.map((type) => (type.id === t.id ? saved : type)),
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy("");
    }
  };

  const setCardPerm = async (
    t: GuestType,
    key: "permNotes" | "permFiles" | "permPublic" | "permMatrix",
    on: boolean,
  ) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(`${t.id}:${key}`);
    try {
      const saved = await api.guestTypePatch({ id: t.id, [key]: on });
      setTypes((current) =>
        current.map((type) => (type.id === t.id ? saved : type)),
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy("");
    }
  };

  return (
    <div className="panel-body">
      <p className="meta">
        逐件勾这一档能用的工具：勾了才出现在来客那间；没勾的，来客问起来助手会照实说「做不到」，不拿好听的话应付。
        改一格即时生效，对之后新登录的来客生效。第一行是内置的「通用来客」 ——
        拿前台门禁口令进来的人都归它，一样按件调；它不能停用也不能删。
      </p>

      {loading && <p className="empty-sm">读取中…</p>}

      {!loading && !types.length && (
        <p className="empty-sm">
          还没有档位。先去「来客类型」页建一档、配好口令，再回来勾工具。
        </p>
      )}

      {!!types.length && (
        <>
          <h3 className="sect">对外工具</h3>
          <div className="perm-scroll">
            <table className="perm-matrix">
              <thead>
                <tr>
                  <th className="perm-corner">档位</th>
                  {togglable.map((t) => (
                    <th key={t.name} title={t.name}>
                      {toolMeta(t.name).zh}
                    </th>
                  ))}
                  {alwaysOn.map((t) => (
                    <th
                      key={t.name}
                      className="perm-always"
                      title={`${t.name} · 恒开，关不掉`}
                    >
                      {toolMeta(t.name).zh}
                      <span className="perm-always-tag">恒开</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr
                    key={t.id}
                    style={!t.active ? { opacity: 0.55 } : undefined}
                  >
                    <th className="perm-rowhead">
                      {t.name}
                      {!t.active && <span className="tag">已停用</span>}
                    </th>
                    {togglable.map((tool) => {
                      const on = t.tools.includes(tool.name);
                      const key = `${t.id}:${tool.name}`;
                      return (
                        <td key={tool.name}>
                          <button
                            className={`perm-cell ${on ? "on" : ""}`}
                            disabled={!!busy}
                            onClick={() => void setTool(t, tool.name, !on)}
                            aria-pressed={on}
                            aria-label={`${t.name} · ${toolMeta(tool.name).zh}`}
                            title={`${toolMeta(tool.name).zh}：${on ? "已开，点一下关掉" : "已关，点一下打开"}`}
                          >
                            {on ? "✓" : "·"}
                          </button>
                        </td>
                      );
                    })}
                    {alwaysOn.map((tool) => (
                      <td key={tool.name}>
                        <span
                          className="perm-cell on locked"
                          title={`${toolMeta(tool.name).zh} · 恒开`}
                        >
                          ✓
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="meta pad">
            「恒开」那几件（天气、识图、交互卡片、留痕）不出网、不留东西，介绍页当面说过，来客恒有。
          </p>

          <h3 className="sect">长期权益（凭身份卡）</h3>
          <p className="meta">
            普通口令进来的临时来客没有持久身份，谈不上「自己的」东西，所以这四项只对持身份卡的长期使用者生效。
          </p>
          <ul className="remind-list">
            {types.map((t) => (
              <li
                className="remind-row"
                key={t.id}
                style={!t.active ? { opacity: 0.55 } : undefined}
              >
                <div className="remind-when">
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                  {!t.active && <span className="tag">已停用</span>}
                </div>
                <div className="remind-when">
                  {CARD_PERMS.map((p) => {
                    const on = t[p.key];
                    const key = `${t.id}:${p.key}`;
                    return (
                      <button
                        key={p.key}
                        className={`chip ${on ? "on" : ""}`}
                        disabled={!!busy}
                        onClick={() => void setCardPerm(t, p.key, !on)}
                        title={p.hint}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
          <p className="meta pad">
            「权限矩阵」这一档给出去的是<strong>整面</strong>管理权，没有只给一面的选项：除了页面与连线，还包含
            <strong>外站认定表</strong>（决定「去外站」那道闸放行哪些域名，等于交出他能看见的全部出站面）和
            <strong>打包 / 装备</strong>（装备是整体替换语义 —— 一次误操作覆盖现网所有页面，包括别人正在改的那些）。
            一般不建议随意给。点掉这一格就收回：矩阵的读写每次请求现查名册，不是登录时定死的。
          </p>
        </>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}

// ── 模型配置 ──────────────────────────────────────────

/**
 * 供应商表单草稿（新增/编辑共用）。供应商级管接哪一家，模型名归各家底下的条目。
 */
interface ProviderDraft {
  name: string;
  format: ModelFormat;
  baseUrl: string;
  keySecret: string;
  maintKeySecret: string;
  maintModel: string;
}

/** 模型条目草稿：给某家供应商挂模型时用。两个数字输入框里都是字符串 */
interface EntryDraft {
  model: string;
  maxOutput: string;
  /** 最大上下文，以 K 计（界面口径）；存库时折回 token */
  contextWindow: string;
}

/** 厂商下拉里「空白」那一项的值；"" 留给还没选过的初始态 */
const BLANK_PRESET = "__blank";
/** 拉模型列表的 chips 挂在新增表单下时用的 scope 值（供应商行用各自 id） */
const ADD_SCOPE = "__add";

/**
 * 换线格式时把接口地址跟着换对：地址正是某厂商某格式的已知地址，就换成新格式的地址
 * （换格式不换门必然 404）。手改过的地址不匹配任何已知值，不动。
 */
const urlForFormat = (
  baseUrl: string,
  from: ModelFormat,
  to: ModelFormat,
): string | null => {
  for (const v of VENDOR_PRESETS) {
    if (v.urls[from] === baseUrl && v.urls[to]) return v.urls[to] as string;
  }
  return null;
};

const blankProviderDraft = (): ProviderDraft => ({
  name: "",
  format: "anthropic",
  baseUrl: "",
  keySecret: "",
  maintKeySecret: "",
  maintModel: "",
});

const providerDraftOf = (p: ModelProvider): ProviderDraft => ({
  name: p.name,
  format: p.format,
  baseUrl: p.baseUrl,
  keySecret: p.keySecret,
  maintKeySecret: p.maintKeySecret,
  maintModel: p.maintModel,
});

/** 提交前折成请求体：空串的字段不传，「留空 = 用本家 / 复用主线」的语义交给后端 */
const providerPayloadOf = (d: ProviderDraft) => ({
  name: d.name.trim(),
  format: d.format,
  baseUrl: d.baseUrl.trim(),
  keySecret: d.keySecret.trim(),
  maintKeySecret: d.maintKeySecret.trim() || undefined,
  maintModel: d.maintModel.trim() || undefined,
});

const blankEntryDraft = (): EntryDraft => ({
  model: "",
  maxOutput: "",
  contextWindow: "",
});

/**
 * 模型目录：供应商管「接哪家」，模型条目挂在各自底下。模型名靠「拉取模型列表」现挑；
 * 普通/深度用哪个去回复风格页指派。Key 存 secret 变量名，Key 本体永不进浏览器。
 */
export function ModelConfigsPanel() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 列表行只读，改的都是「打开弹页那一刻拍下的草稿」，按下保存才提交。
  // hook 一律留在函数体最上面：放到条件分支或早退之后，React 会报
  // "Rendered more hooks than during the previous render"，面板就停在读取中不动了。
  const providerForm = useDraft<ProviderFormDraft>({
    ...blankProviderDraft(),
    firstModel: "",
    firstMax: "",
  });
  // "" = 关着；ADD_SCOPE = 新增；其余是供应商 id = 编辑。新增与编辑共用同一个弹页
  const [providerDialog, setProviderDialog] = useState("");
  const [vendorKey, setVendorKey] = useState("");
  const [providerErr, setProviderErr] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);

  const entryForm = useDraft<EntryDraft>(blankEntryDraft());
  // entryId 空 = 给这家新挂一条；非空 = 编辑那一条
  const [entryDialog, setEntryDialog] = useState<{
    providerId: string;
    entryId: string;
  } | null>(null);
  const [entryErr, setEntryErr] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);

  // 拉模型清单：scope 认弹页（ADD_SCOPE 或供应商 id）。
  // pullSeq 是代次号：弹页换过目标后迟到的那一份必须丢掉，否则上一家的清单会盖进这一家
  const pullSeq = useRef(0);
  const [pullScope, setPullScope] = useState("");
  const [pulling, setPulling] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [pullErr, setPullErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.modelCatalog();
      setProviders(r.providers);
      setEntries(r.entries);
      setKeySecrets(r.keySecrets);
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

  /** 丢掉在飞的拉取：弹页一开一关都走它 */
  const clearPull = () => {
    pullSeq.current += 1;
    setPullScope("");
    setPulling(false);
    setModels([]);
    setPullErr("");
  };

  /**
   * 拉模型列表：scope 是弹页认的供应商 id 或 ADD_SCOPE。
   * 已知厂商用其标定的列表端点与鉴权头 —— anthropic 兼容门下没有 /models，瞎拼只会 404。
   */
  const pullModels = useCallback(
    async (
      scope: string,
      format: ModelFormat,
      baseUrl: string,
      keySecret: string,
    ) => {
      const seq = (pullSeq.current += 1);
      setPullScope(scope);
      setModels([]);
      setPullErr("");
      setPulling(true);
      try {
        const preset = VENDOR_PRESETS.find((x) =>
          Object.values(x.urls).includes(baseUrl),
        );
        const r = await api.modelListModels({
          format,
          baseUrl,
          keySecret,
          ...(preset
            ? { listUrl: preset.listUrl, listAuth: preset.listAuth }
            : {}),
        });
        if (seq !== pullSeq.current) return;
        setModels(r.models);
      } catch (e) {
        if (seq !== pullSeq.current) return;
        setPullErr((e as Error).message);
        setModels([]);
      } finally {
        if (seq === pullSeq.current) setPulling(false);
      }
    },
    [],
  );

  const patchProvider = (p: Partial<ProviderFormDraft>) =>
    providerForm.setDraft((prev) => ({ ...prev, ...p }));

  const applyVendor = (key: string) => {
    setVendorKey(key);
    const v = VENDOR_PRESETS.find((x) => x.key === key);
    if (!v) {
      providerForm.setDraft({
        ...blankProviderDraft(),
        firstModel: "",
        firstMax: "",
      });
      return;
    }
    // 厂商只带出「接哪一家」的部分；首个模型名不预填，拉取列表后点选
    providerForm.setDraft({
      name: v.label,
      format: v.format,
      baseUrl: v.baseUrl,
      keySecret: v.keySecret,
      maintKeySecret: "",
      maintModel: "",
      firstModel: "",
      firstMax: String(v.maxOutput),
    });
  };
  const vendor = VENDOR_PRESETS.find((x) => x.key === vendorKey) || null;

  const openAddProvider = () => {
    setEntryDialog(null);
    clearPull();
    setVendorKey("");
    providerForm.reset({
      ...blankProviderDraft(),
      firstModel: "",
      firstMax: "",
    });
    setProviderErr("");
    setProviderDialog(ADD_SCOPE);
  };

  const openEditProvider = (p: ModelProvider) => {
    setEntryDialog(null);
    clearPull();
    // 厂商预设是新增时的脚手架，编辑不带：编辑该看见这一家现在真正配着什么
    setVendorKey("");
    providerForm.reset({ ...providerDraftOf(p), firstModel: "", firstMax: "" });
    setProviderErr("");
    setProviderDialog(p.id);
  };

  const closeProviderDialog = () => {
    setProviderDialog("");
    setProviderErr("");
    clearPull();
  };

  const saveProvider = async () => {
    if (savingProvider) return;
    const missing = providerMissingFields(providerForm.draft);
    if (missing.length) {
      setProviderErr(missing.map((m) => m.message).join("；"));
      return;
    }
    const isNew = providerDialog === ADD_SCOPE;
    setSavingProvider(true);
    setProviderErr("");
    try {
      const payload = providerPayloadOf(providerForm.draft);
      if (isNew)
        await api.modelProviderAdd({
          ...payload,
          firstModel: providerForm.draft.firstModel.trim() || undefined,
          maxOutput: parseMaxOutput(providerForm.draft.firstMax),
        });
      else await api.modelProviderPatch({ id: providerDialog, ...payload });
      // 成功后重新拉一遍目录再关窗：列表显示的是落库后的真值，不做乐观更新
      await load();
      setProviderDialog("");
    } catch (e) {
      // 后端校验不过（缺 Key、地址不对之类）原样摆在弹页里，不关窗
      setProviderErr((e as Error).message);
    } finally {
      setSavingProvider(false);
    }
  };

  const delProvider = async (p: ModelProvider) => {
    await api.modelProviderDelete(p.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  const openAddEntry = (p: ModelProvider) => {
    setProviderDialog("");
    clearPull();
    entryForm.reset(blankEntryDraft());
    setEntryErr("");
    setEntryDialog({ providerId: p.id, entryId: "" });
    // 一开窗就去问这一家有哪些模型：点一个芯片填进「模型名」，拉不到不拦手填
    void pullModels(p.id, p.format, p.baseUrl, p.keySecret);
  };

  const openEditEntry = (e: ModelEntry) => {
    const p = providers.find((x) => x.id === e.providerId);
    setProviderDialog("");
    clearPull();
    entryForm.reset(entryFormOf(e));
    setEntryErr("");
    setEntryDialog({ providerId: e.providerId, entryId: e.id });
    if (p) void pullModels(p.id, p.format, p.baseUrl, p.keySecret);
  };

  const closeEntryDialog = () => {
    setEntryDialog(null);
    setEntryErr("");
    clearPull();
  };

  const saveEntry = async () => {
    if (!entryDialog || savingEntry) return;
    const missing = entryMissingFields(entryForm.draft);
    if (missing.length) {
      setEntryErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSavingEntry(true);
    setEntryErr("");
    try {
      const body = {
        model: entryForm.draft.model.trim(),
        maxOutput: parseMaxOutput(entryForm.draft.maxOutput),
        contextWindow: parseContextWindow(entryForm.draft.contextWindow),
      };
      if (entryDialog.entryId)
        await api.modelEntryPatch({ id: entryDialog.entryId, ...body });
      else
        await api.modelEntryAdd({
          providerId: entryDialog.providerId,
          ...body,
        });
      await load();
      setEntryDialog(null);
    } catch (e) {
      setEntryErr((e as Error).message);
    } finally {
      setSavingEntry(false);
    }
  };

  /** 点模型芯片：只填进当前弹页那格，提交仍要人按保存 */
  const pickModel = (id: string) => {
    if (providerDialog === ADD_SCOPE) {
      patchProvider({ firstModel: id });
      return;
    }
    entryForm.setDraft((prev) => ({ ...prev, model: id }));
  };

  /** 生效只能换、不能摘：后端语义是全库唯一，摘掉就没有生效模型（原面板也没这条路） */
  const setActive = async (e: ModelEntry) => {
    if (e.active) return;
    await api
      .modelEntryPatch({ id: e.id, active: true })
      .catch((er: Error) => setErr(er.message));
    await load();
  };

  const delEntry = async (e: ModelEntry) => {
    await api.modelEntryDelete(e.id).catch((er: Error) => setErr(er.message));
    await load();
  };

  /** 遗留的通用环境变量：模型目录还没建起来时，它仍会被当作回落 */
  const hasLegacyKey = keySecrets.some((k) => k === "API_KEY");

  const rawKeyHint =
    "这串像是 Key 本体（sk- 开头）。这一栏填的是 secret 变量名，比如 DEEPSEEK_KEY；Key 本体在终端跑 npx wrangler secret put DEEPSEEK_KEY 配进这台机器。";

  /** 拉回来的清单：只在它属于当前弹页时出现；失败就一句话，不拦人手动填 */
  const pulledBlock = (scope: string) =>
    pullScope !== scope ? null : (
      <div className="form-pull">
        {pulling && <p className="empty-sm">拉取中…</p>}
        {pullErr && <p className="err">{pullErr}</p>}
        {!pulling && !models.length && !pullErr && (
          <p className="empty-sm">这一家没回模型清单 —— Key 或地址可能不对。</p>
        )}
        {!!models.length && (
          <>
            <div className="tabs">
              {models.map((m) => (
                <button
                  key={m.id}
                  className="chip"
                  type="button"
                  title={m.name && m.name !== m.id ? m.name : undefined}
                  onClick={() => pickModel(m.id)}
                >
                  {m.id}
                </button>
              ))}
            </div>
            <p className="meta">点一个模型名，填进上面那一格；拉不到就手填。</p>
          </>
        )}
      </div>
    );

  const entryId = entryDialog?.entryId ?? "";
  const entryProviderId = entryDialog?.providerId ?? "";
  const editingEntry = entryId
    ? entries.find((e) => e.id === entryId) || null
    : null;
  const entryProvider = entryProviderId
    ? providers.find((p) => p.id === entryProviderId) || null
    : null;
  const editingProvider =
    providers.find((p) => p.id === providerDialog) || null;

  return (
    <div className="panel-body">
      <p className="meta">
        一家供应商就是一套接模型的钥匙串，底下想挂几个模型就挂几个。这里只管「有哪些模型可选」；普通和深度两种模式各用哪个，在设置
        → 回复风格里指派，指派完下一轮对话生效。
      </p>

      <h3 className="sect">供应商（{providers.length}）</h3>
      <EntityAddButton label="新增供应商" onClick={openAddProvider} />

      {!!providers.length && (
        <div className="entity-list">
          {providers.map((p) => {
            const mine = entries.filter((x) => x.providerId === p.id);
            return (
              <div className="entity-group" key={p.id}>
                <EntityRow
                  title={p.name}
                  summary={providerSummary(p, mine.length)}
                  editing={providerDialog === p.id}
                  onEdit={() => openEditProvider(p)}
                  onDelete={() => void delProvider(p)}
                  deleteConfirm={`删掉「${p.name}」？名下的模型条目会一并删除。`}
                />

                {/* 模型条目：这一家挂着的所有模型；普通模式用哪个，去「回复风格」页指派 */}
                <div className="entity-sublist">
                  {mine.map((e) => (
                    <EntityRow
                      key={e.id}
                      title={e.model}
                      summary={entrySummary(e)}
                      editing={entryId === e.id}
                      onEdit={() => openEditEntry(e)}
                      onDelete={() => void delEntry(e)}
                      deleteConfirm={`删掉模型「${e.model}」？`}
                      right={
                        <button
                          className={"chip" + (e.active ? " on" : "")}
                          type="button"
                          disabled={e.active}
                          onClick={() => void setActive(e)}
                          title={
                            e.active
                              ? "正在生效的模型；要换就点别的条目上的「设为生效」"
                              : "把普通模式指到这一条"
                          }
                        >
                          {e.active ? "生效中" : "设为生效"}
                        </button>
                      }
                    />
                  ))}
                  {!mine.length && (
                    <EntityNote>
                      这家还没挂模型 —— 点「添加模型」拉列表挑，或者手填一个。
                    </EntityNote>
                  )}
                  <EntityAddButton
                    label="添加模型"
                    onClick={() => openAddEntry(p)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !providers.length && !err && (
        <p className="empty-sm">
          还没有供应商。点「新增供应商」从厂商挑一家起头，拉模型列表点选后保存；空白新建也行。
        </p>
      )}

      {err && <p className="err">{err}</p>}

      {/* 供应商弹页：新增与编辑共用同一份表单，空草稿即新增 */}
      {providerDialog && (
        <FormDialog
          wide
          title={
            providerDialog === ADD_SCOPE
              ? "新增供应商"
              : `编辑「${editingProvider?.name ?? ""}」`
          }
          busy={savingProvider}
          error={providerErr}
          dirty={providerForm.dirty(providerForm.draft)}
          onClose={closeProviderDialog}
          onSave={() => void saveProvider()}
        >
          {providerDialog === ADD_SCOPE && (
            <FormSection title="起头">
              <FormRow
                label="从厂商开始"
                hint="挑一家带出接口格式、地址与 Key 变量名；接别家就选空白"
              >
                <select
                  className="field"
                  value={vendorKey}
                  onChange={(e) => applyVendor(e.target.value)}
                  aria-label="从厂商开始"
                >
                  <option value="">从厂商开始…</option>
                  {VENDOR_PRESETS.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label}
                    </option>
                  ))}
                  <option value={BLANK_PRESET}>空白</option>
                </select>
              </FormRow>
              {vendor && (
                <EntityNote>
                  {vendor.note}{" "}
                  <a href={vendor.modelsPage} target="_blank" rel="noreferrer">
                    官方模型列表站 ↗
                  </a>
                </EntityNote>
              )}
            </FormSection>
          )}

          <FormSection title="基本信息">
            <FormRow label="供应商名称">
              <input
                className="field"
                placeholder="供应商名称"
                value={providerForm.draft.name}
                onChange={(e) => patchProvider({ name: e.target.value })}
              />
            </FormRow>
            <FormRow label="接口格式" hint="换格式时接口地址跟着预设表换对">
              <select
                className="field"
                value={providerForm.draft.format}
                onChange={(e) => {
                  const f = e.target.value as ModelFormat;
                  // 格式换了，门也得换：地址跟着预设表走，别让 anthropic 的门收 openai 的信
                  const next = urlForFormat(
                    providerForm.draft.baseUrl,
                    providerForm.draft.format,
                    f,
                  );
                  patchProvider(
                    next ? { format: f, baseUrl: next } : { format: f },
                  );
                }}
                aria-label="接口格式"
              >
                {(Object.keys(MODEL_FORMAT_LABEL) as ModelFormat[]).map(
                  (f) => (
                    <option key={f} value={f}>
                      {MODEL_FORMAT_LABEL[f]}
                    </option>
                  ),
                )}
              </select>
            </FormRow>
            <FormRow label="接口地址">
              <input
                className="field"
                placeholder="Base URL"
                value={providerForm.draft.baseUrl}
                onChange={(e) => patchProvider({ baseUrl: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="凭据">
            <FormRow
              label="Key 变量名"
              hint={
                looksLikeRawKey(providerForm.draft.keySecret)
                  ? rawKeyHint
                  : "填 secret 的变量名，不是 Key 本体"
              }
            >
              <input
                className="field"
                list="mc-key-secrets"
                placeholder="Key 变量名"
                value={providerForm.draft.keySecret}
                onChange={(e) => patchProvider({ keySecret: e.target.value })}
              />
            </FormRow>
            <EntityNote>
              Key 填的是变量名：新厂商先在终端跑 npx wrangler secret put
              DEEPSEEK_KEY 把 Key 配进这台机器，再到这里填变量名
              {keySecrets.length ? "，配过的名字会出现在下拉里" : ""}。
              {hasLegacyKey
                ? " 检测到环境里还配着 API_KEY：未建模型目录时，它仍会被用作回落。"
                : ""}
            </EntityNote>
          </FormSection>

          <FormSection title="维护性调用">
            <FormRow
              label="维护用 Key"
              hint="后台整理记忆这类活单独用哪把；留空 = 用上面那把"
            >
              <input
                className="field"
                list="mc-key-secrets"
                placeholder="维护用 Key（留空 = 用上面那把）"
                value={providerForm.draft.maintKeySecret}
                onChange={(e) =>
                  patchProvider({ maintKeySecret: e.target.value })
                }
              />
            </FormRow>
            <FormRow
              label="维护用模型"
              hint="留空 = 复用当前生效的主线模型；可从这一家挂着的模型里挑"
            >
              <input
                className="field"
                list="mc-maint-models"
                placeholder="维护用模型（留空 = 复用主线）"
                value={providerForm.draft.maintModel}
                onChange={(e) => patchProvider({ maintModel: e.target.value })}
              />
            </FormRow>
          </FormSection>

          {providerDialog === ADD_SCOPE && (
            <FormSection title="首个模型">
              <FormRow label="首个模型名" hint="可空，之后再加">
                <input
                  className="field"
                  placeholder="首个模型名（可空，之后再加）"
                  value={providerForm.draft.firstModel}
                  onChange={(e) =>
                    patchProvider({ firstModel: e.target.value })
                  }
                />
              </FormRow>
              <FormRow label="输出上限" hint="token，留空 = 用服务端默认">
                <input
                  className="field"
                  placeholder="输出上限（token，可空）"
                  value={providerForm.draft.firstMax}
                  onChange={(e) => patchProvider({ firstMax: e.target.value })}
                />
              </FormRow>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={
                  !providerForm.draft.baseUrl.trim() ||
                  !providerForm.draft.keySecret.trim()
                }
                title="问这一家现在有哪些模型可挑"
                onClick={() =>
                  void pullModels(
                    ADD_SCOPE,
                    providerForm.draft.format,
                    providerForm.draft.baseUrl.trim(),
                    providerForm.draft.keySecret.trim(),
                  )
                }
              >
                {pullScope === ADD_SCOPE && pulling ? "拉取中…" : "拉取模型列表"}
              </button>
              {pulledBlock(ADD_SCOPE)}
            </FormSection>
          )}

          {/* 维护用模型的下拉选项：编辑哪家就给哪家的模型条目 */}
          <datalist id="mc-maint-models">
            {(editingProvider
              ? entries.filter((e) => e.providerId === editingProvider.id)
              : []
            ).map((e) => (
              <option key={e.id} value={e.model} />
            ))}
          </datalist>
        </FormDialog>
      )}

      {/* 模型条目弹页：新增与编辑共用；开窗自动拉这一家的清单，点芯片填模型名 */}
      {entryDialog && entryProvider && (
        <FormDialog
          wide
          title={
            editingEntry
              ? `编辑模型「${editingEntry.model}」`
              : `给「${entryProvider.name}」添加模型`
          }
          subtitle="点下面的清单挑一个模型名，或者直接手填；两个额度格都可以留空。"
          busy={savingEntry}
          error={entryErr}
          dirty={entryForm.dirty(entryForm.draft)}
          onClose={closeEntryDialog}
          onSave={() => void saveEntry()}
        >
          <FormSection title="模型">
            <FormRow label="模型名">
              <input
                className="field"
                placeholder="模型名"
                value={entryForm.draft.model}
                onChange={(e) =>
                  entryForm.setDraft((prev) => ({
                    ...prev,
                    model: e.target.value,
                  }))
                }
              />
            </FormRow>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              title="重新问这一家有哪些模型可挑"
              onClick={() =>
                void pullModels(
                  entryProvider.id,
                  entryProvider.format,
                  entryProvider.baseUrl,
                  entryProvider.keySecret,
                )
              }
            >
              {pullScope === entryProvider.id && pulling
                ? "拉取中…"
                : "重新拉取模型列表"}
            </button>
            {pulledBlock(entryProvider.id)}
          </FormSection>

          <FormSection title="额度">
            <FormRow label="输出上限" hint="token，留空 = 用服务端默认">
              <input
                className="field"
                placeholder="输出上限（token，可空）"
                value={entryForm.draft.maxOutput}
                onChange={(e) =>
                  entryForm.setDraft((prev) => ({
                    ...prev,
                    maxOutput: e.target.value,
                  }))
                }
              />
            </FormRow>
            <FormRow
              label="最大上下文"
              hint="以 K 计，填 200 就是 200K；留空 = 不设，界面回落默认档"
            >
              <input
                className="field"
                placeholder="最大上下文（K，可空）"
                value={entryForm.draft.contextWindow}
                onChange={(e) =>
                  entryForm.setDraft((prev) => ({
                    ...prev,
                    contextWindow: e.target.value,
                  }))
                }
              />
            </FormRow>
          </FormSection>
        </FormDialog>
      )}

      {/* datalist 只渲染一次：多个输入框共享同一份 secret 名清单 */}
      <datalist id="mc-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );
}

// ── 读音配置 ──────────────────────────────────────────
//
// 草稿、协议默认值联动、必填校验与行摘要都在 ../lib/ttsConfigForm.ts ——
// 新增与编辑共用一个弹页，这套取舍得能测。

/** 弹页认的「新增」标记；其余非空值是条目 id（编辑），空串 = 弹页关着 */
const TTS_NEW = "__new";

/**
 * 读音配置：一条一副嗓子。朗读用哪副完全由这里决定，
 * 排最前且 Key 可用的那条是默认；没有条目时退回浏览器音色（能出声，不好听）。
 */
export function TtsConfigsPanel() {
  const [tts, setTts] = useState<TtsConfig[]>([]);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 这副嗓子在这台机器上用不用得上，是后端按 env 判的（/api/voices 逐条回 why）。
  // 不照前端那份 Key 下拉清单自己推：清单是有名目的闭集，填了别名会被误说成「没配」。
  const [whyById, setWhyById] = useState<Record<string, string>>({});

  // 列表行只读，改的都是「打开弹页那一刻拍下的草稿」，按下保存才提交。
  // hook 一律留在函数体最上面：放到条件分支或早退之后，React 会报
  // "Rendered more hooks than during the previous render"，面板就停在读取中不动了。
  const form = useDraft<TtsFormDraft>(freshTtsDraft());
  const [dialog, setDialog] = useState("");
  const [dialogErr, setDialogErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, v] = await Promise.all([
        api.ttsConfigs(),
        // 顺带问一遍每条现在配不配得上；这一步挂了不影响配置面本身
        api.voices().catch(() => null),
      ]);
      setTts(r.tts);
      setKeySecrets(r.keySecrets);
      setWhyById(
        Object.fromEntries(
          (v?.voices ?? []).filter((x) => x.why).map((x) => [x.id, x.why]),
        ),
      );
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

  const patch = (p: Partial<TtsFormDraft>) =>
    form.setDraft((prev) => ({ ...prev, ...p }));

  // 新增与编辑共用同一个弹页：起头草稿就是新增，快照就是编辑
  const openAdd = () => {
    form.reset(freshTtsDraft());
    setDialogErr("");
    setDialog(TTS_NEW);
  };

  const openEdit = (t: TtsConfig) => {
    form.reset(ttsDraftOf(t));
    setDialogErr("");
    setDialog(t.id);
  };

  const closeDialog = () => {
    setDialog("");
    setDialogErr("");
  };

  const isNew = dialog === TTS_NEW;
  const editing = isNew ? null : tts.find((t) => t.id === dialog) || null;
  // 占位话与协议说明都跟着草稿的协议走：切了协议就该看到新那家的默认值
  const def = TTS_DEFAULTS[form.draft.protocol];

  const save = async () => {
    if (!dialog || saving) return;
    const missing = ttsMissingFields(form.draft);
    if (missing.length) {
      setDialogErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSaving(true);
    setDialogErr("");
    try {
      if (isNew) await api.ttsConfigAdd(ttsPayloadOf(form.draft));
      else await api.ttsConfigPatch({ id: dialog, ...ttsPayloadOf(form.draft) });
      // 成功后重新拉一遍清单再关窗：列表显示的是落库后的真值，不做乐观更新
      await load();
      setDialog("");
    } catch (e) {
      // 后端校验不过（缺 Key 变量名之类）原样摆在弹页里，不关窗
      setDialogErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (t: TtsConfig) => {
    if (!window.confirm(`删掉「${t.name}」？这副嗓子之后就没人念了。`)) return;
    await api.ttsConfigDelete(t.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  return (
    <div className="panel-body">
      <p className="meta">
        内置的三家嗓音已经移除，读音服务完全由这里的条目决定：一条就是一副可用的嗓子；
        没有条目时，朗读回退浏览器自带的音色。排在最前、Key
        可用的那条是默认嗓子。
      </p>

      <h3 className="sect">嗓子（{tts.length}，排前面的优先）</h3>
      <EntityAddButton label="新增嗓子" onClick={openAdd} />

      {/* 默认嗓子由列表顺序表达（排在最前且 Key 可用的那条），行上不再加「默认」标记 */}
      {!!tts.length && (
        <div className="entity-list">
          {tts.map((t) => (
            <EntityRow
              key={t.id}
              title={t.name}
              summary={ttsSummary(t, whyById[t.id] ?? "")}
              editing={dialog === t.id}
              onEdit={() => openEdit(t)}
              onDelete={() => void del(t)}
              deleteConfirm={`删掉「${t.name}」？这副嗓子之后就没人念了。`}
            />
          ))}
        </div>
      )}

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !tts.length && !err && (
        <p className="empty-sm">还没有读音条目，现在朗读用的是浏览器音色。</p>
      )}

      {err && <p className="err">{err}</p>}

      {/* 嗓子弹页：新增与编辑共用同一份表单，起头草稿即新增 */}
      {dialog && (
        <FormDialog
          wide
          title={isNew ? "新增嗓子" : `编辑「${editing?.name ?? ""}」`}
          subtitle="一条就是一副可用的嗓子；留空的格子走这一家的默认值。"
          busy={saving}
          error={dialogErr}
          dirty={form.dirty(form.draft)}
          onClose={closeDialog}
          onSave={() => void save()}
        >
          <FormSection title="基本信息">
            <FormRow label="名称">
              <input
                className="field"
                placeholder="名称"
                value={form.draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </FormRow>
            <FormRow label="协议" hint="换协议时，没动过的格子跟着换到这一家的默认值">
              <select
                className="field"
                value={form.draft.protocol}
                onChange={(e) =>
                  form.setDraft(
                    ttsWithProtocol(form.draft, e.target.value as TtsProtocol),
                  )
                }
                aria-label="协议"
              >
                {(Object.keys(TTS_PROTOCOL_LABEL) as TtsProtocol[]).map((p) => (
                  <option key={p} value={p}>
                    {TTS_PROTOCOL_LABEL[p]}
                  </option>
                ))}
              </select>
            </FormRow>
          </FormSection>

          <FormSection title="凭据">
            <FormRow label="Key 变量名" hint="填的是 secret 变量名，不是 Key 本体">
              <input
                className="field"
                list="tts-key-secrets"
                placeholder="Key 变量名"
                value={form.draft.keySecret}
                onChange={(e) => patch({ keySecret: e.target.value })}
              />
            </FormRow>
            <FormRow label="接口地址" wide>
              <input
                className="field"
                placeholder="Base URL（可空 = 用这一家的默认地址）"
                value={form.draft.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="嗓子">
            <FormRow label="模型" hint="留空也走这一家的默认模型">
              <input
                className="field"
                placeholder={`模型（${def.model}）`}
                value={form.draft.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
            </FormRow>
            <FormRow label="音色" hint="点输入框能从预置表里挑；清单外的 id 手填也照收">
              <input
                className="field"
                list={`tts-voices-${form.draft.protocol}`}
                placeholder={def.voicePh}
                value={form.draft.voice}
                onChange={(e) => patch({ voice: e.target.value })}
              />
            </FormRow>
            {form.draft.protocol === "mimo-chat" && (
              <FormRow label="语气 style" hint="这一家特有，可空">
                <input
                  className="field"
                  placeholder="语气 style（这一家特有，可空）"
                  value={form.draft.style}
                  onChange={(e) => patch({ style: e.target.value })}
                />
              </FormRow>
            )}
            <EntityNote>
              {def.note}
              {form.draft.protocol === "mimo-chat" ? "；语气 style 只有这一家用得上" : ""}
              {keySecrets.length ? "；Key 配过的名字在下拉里" : ""}。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      <datalist id="tts-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      {/* 音色预置表按协议各挂一个 datalist：选了哪家协议就出哪一家的音色清单。
          option 的 value 是进接口的 id，label 是给人看的名字；手填清单外的 id 也照收。 */}
      {(Object.keys(TTS_VOICE_PRESETS) as TtsProtocol[]).map((p) => (
        <datalist key={p} id={`tts-voices-${p}`}>
          {TTS_VOICE_PRESETS[p].map((v) => (
            <option key={v.id} value={v.id} label={v.label} />
          ))}
        </datalist>
      ))}
    </div>
  );
}

/**
 * 绘图配置：三档（fast / high / fallback）各一行，tier 是主键、恒在，只能编辑。
 * workers-ai 走平台 AI 绑定（neurons 计费），端点与 key 用不上；key 栏填 secret 变量名。
 */
export function DrawConfigsPanel() {
  const [configs, setConfigs] = useState<DrawConfig[]>([]);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  // 行只读，改的都是「打开弹页那一刻拍下的草稿」，按下保存才提交。
  // hook 一律留在函数体最上面 —— 下面那句 if (loading) 就是本组件的早退，
  // 把 hook 放到它之后会报 "Rendered more hooks than during the previous render"。
  const form = useDraft<DrawFormDraft>(blankDrawDraft());
  // "" = 关着；其余是档位 = 编辑那档
  const [dialog, setDialog] = useState<DrawConfig["tier"] | "">("");
  const [dialogErr, setDialogErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // key 变量名候选与模型目录共用一本册子（配过的 secret 名都在那）
      const [r, catalog] = await Promise.all([
        api.drawConfigs(),
        api.modelCatalog(),
      ]);
      setConfigs(r.configs);
      setKeySecrets(catalog.keySecrets);
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

  const patch = (p: Partial<DrawFormDraft>) =>
    form.setDraft((prev) => ({ ...prev, ...p }));

  const openEdit = (c: DrawConfig) => {
    form.reset(drawDraftOf(c));
    setDialogErr("");
    setDialog(c.tier);
  };

  const closeDialog = () => {
    setDialog("");
    setDialogErr("");
  };

  const binding = drawIsBinding(form.draft.format);
  // 只提示、不拦保存：有的厂牌 Key 确实长这样（与模型目录同一个口径）
  const badKey = !binding && looksLikeRawKey(form.draft.keySecret);
  // 这串文本现在切出来是几个模型：降级顺序就是它，先数给人看
  const modelCount = parseDrawModels(form.draft.models).length;

  const save = async () => {
    if (!dialog || saving) return;
    const missing = drawMissingFields(form.draft);
    if (missing.length) {
      setDialogErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSaving(true);
    setDialogErr("");
    setSaved("");
    try {
      await api.drawConfigPatch({ tier: dialog, ...drawPayloadOf(form.draft) });
      // 先给回执，再重新拉一遍回填，然后关窗：列表显示的是落库后的真值
      setSaved(`${DRAW_TIER_META[dialog].title} 已保存`);
      await load();
      setDialog("");
    } catch (e) {
      // 后端校验不过（清单空、协议不认识之类）原样摆在弹页里，不关窗
      setDialogErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="empty-sm">读取中…</p>;

  return (
    <div className="panel-body">
      <h3 className="sect">出图三档（{configs.length}）</h3>
      {err && <p className="err">{err}</p>}
      {saved && <p className="meta">{saved}</p>}

      {/* tier 是主键、三档恒在：没有「新增」入口，行上也不给删除 */}
      {!!configs.length && (
        <div className="entity-list">
          {configs.map((c) => (
            <div className="entity-group" key={c.tier}>
              <EntityRow
                title={DRAW_TIER_META[c.tier].title}
                summary={drawSummary(c)}
                editing={dialog === c.tier}
                onEdit={() => openEdit(c)}
              />
              <EntityNote>{DRAW_TIER_META[c.tier].desc}</EntityNote>
            </div>
          ))}
        </div>
      )}

      {!configs.length && (
        <p className="empty-sm">后端没回绘图配置，刷新看看。</p>
      )}

      {/* 档位弹页：三档共用同一份表单，拍的就是这一档现在的配置 */}
      {dialog && (
        <FormDialog
          wide
          title={`编辑「${DRAW_TIER_META[dialog].title}」`}
          subtitle={DRAW_TIER_META[dialog].desc}
          busy={saving}
          error={dialogErr}
          dirty={form.dirty(form.draft)}
          onClose={closeDialog}
          onSave={() => void save()}
        >
          <FormSection title="走哪家">
            <FormRow
              label="出图协议"
              hint="换协议时，没动过的格子跟着换到这一家的默认值"
            >
              <select
                className="field"
                value={form.draft.format}
                onChange={(ev) =>
                  form.setDraft(
                    drawWithFormat(form.draft, ev.target.value as DrawFormat),
                  )
                }
                aria-label="出图协议"
              >
                {(Object.keys(DRAW_FORMAT_LABEL) as DrawFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {DRAW_FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="标注名" hint="画完图边上那行字">
              <input
                className="field"
                placeholder="标注名（画完图边上那行字）"
                value={form.draft.label}
                onChange={(ev) => patch({ label: ev.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="模型降级清单">
            <FormRow label="模型清单" wide>
              <input
                className="field"
                placeholder="模型清单（逗号分隔，降级有序）"
                value={form.draft.models}
                onChange={(ev) => patch({ models: ev.target.value })}
              />
            </FormRow>
            <EntityNote>
              现在这串是 {modelCount} 个模型
              {modelCount > 1 ? "：前面的先试，没成才轮到后面" : ""}
              {modelCount ? "" : " —— 至少要留一个模型名"}。
            </EntityNote>
          </FormSection>

          <FormSection title="接口与钥匙">
            <FormRow label="出图端点" wide hint="workers-ai 用不上">
              <input
                className="field"
                placeholder="出图端点（workers-ai 用不上）"
                value={form.draft.endpoint}
                disabled={binding}
                onChange={(ev) => patch({ endpoint: ev.target.value })}
              />
            </FormRow>
            <FormRow label="key 变量名" hint="workers-ai 用不上">
              <input
                className="field"
                placeholder="key 的 secret 变量名（workers-ai 用不上）"
                value={form.draft.keySecret}
                disabled={binding}
                list="draw-key-secrets"
                onChange={(ev) => patch({ keySecret: ev.target.value })}
              />
            </FormRow>
            {binding && (
              <p className="meta">
                走平台 AI 绑定，按 neurons 计费，不用配端点和 key。
              </p>
            )}
            {badKey && (
              <p className="err">
                这里填的是 secret 变量名，不是 Key 本体 —— Key 用 npx wrangler
                secret put 配进这台机器。
              </p>
            )}
          </FormSection>
        </FormDialog>
      )}

      <datalist id="draw-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );
}

/** 搜索通道的界面用词 */
const SEARCH_FORMAT_LABEL: Record<SearchFormat, string> = {
  tavily: "Tavily（自带答案摘要与正文抓取）",
  brave: "Brave（独立索引、快，只有摘要）",
};

/**
 * 搜索配置：一条主通道，配走哪家 / 用哪把钥匙。没配 key 时自动退化为
 * DuckDuckGo 免费通道，搜索照常能用。key 栏填 secret 变量名，Key 本体永不进浏览器。
 */
export function SearchConfigsPanel() {
  const [config, setConfig] = useState<SearchConfig | null>(null);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try {
      // key 变量名候选与模型目录共用一本册子（配过的 secret 名都在那）
      const [r, catalog] = await Promise.all([
        api.searchConfig(),
        api.modelCatalog(),
      ]);
      setConfig(r.config);
      setKeySecrets(catalog.keySecrets);
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

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setErr("");
    setSaved("");
    try {
      const next = await api.searchConfigPatch({
        format: config.format,
        keySecret: config.keySecret.trim(),
      });
      setConfig(next);
      setSaved("搜索配置已保存，下一轮搜索生效");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="empty-sm">读取中…</p>;
  if (!config) return <p className="empty-sm">还没有搜索配置。</p>;

  const badKey = config.keySecret.trim().startsWith("sk-");

  return (
    <div>
      {err && <p className="err">{err}</p>}
      {saved && <p className="meta">{saved}</p>}
      <p className="meta">
        联网搜索的主通道：我「先搜一下再回答」时走的就是它。没配
        key（或通道挂了）会退化成 DuckDuckGo 免费通道 —— 能用，但摘要短、不稳。
      </p>
      <div className="panel-body">
        <div className="inline-form">
          <select
            className="field"
            value={config.format}
            onChange={(ev) =>
              setConfig({
                ...config,
                format: ev.target.value as SearchFormat,
              })
            }
          >
            {(Object.keys(SEARCH_FORMAT_LABEL) as SearchFormat[]).map((f) => (
              <option key={f} value={f}>
                {SEARCH_FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
          <input
            className="field"
            placeholder="key 的 secret 变量名（留空 = 免费通道）"
            value={config.keySecret}
            list="search-key-secrets"
            onChange={(ev) =>
              setConfig({ ...config, keySecret: ev.target.value })
            }
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        {badKey && (
          <p className="err">
            这里填的是 secret 变量名，不是 Key 本体 —— Key 用 npx wrangler
            secret put 配进这台机器。
          </p>
        )}
      </div>
      <datalist id="search-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );
}
