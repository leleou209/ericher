// ─────────────────────────────────────────────────────────────
// hr-desk · 管理面板（后半）：账本 / 文件 / 自我认知 / 工作守则 / 会话 / 嗓音 / 来客 / 模型 / 读音
//
// 前半在 Panels.tsx，纯工具在 PanelsShared.ts。
// 本文件 import 工具只走 ./PanelsShared —— 不许回头 import Panels.tsx（防循环）。
// ─────────────────────────────────────────────────────────────

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
  VENDOR_PRESETS,
} from "../lib/presets";
import { Icon } from "./Icons";
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

/**
 * 行容器：左边正文、右边小动作、最右一个删除叉。
 * 与 Panels.tsx 里的 Row 是同一份 —— 拆文件后两边各持一份：
 * 它是组件进不了纯工具文件，而本文件又不许回头 import Panels（防循环）。
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
 * 客人登记时能挑的几层。
 * 不把整个书架摆给他：identity、reflections 那些是 ericher 自己的工作底账，
 * 摆在这儿他只会不知道该挑哪个 —— 少给几个，反而好选。
 */
const LEDGER_SHELVES: Shelf[] = ["people", "events", "knowledge", "projects"];

/**
 * 公开账本 + 公开墙 —— 来客和持卡者看的那一格。
 *
 * 账本：管理员公开的人物条目，掺着他自己登记的那几笔。
 * 两档要分开标：管理员点头公开的那些对所有客人可见；客人自己写的落库是 private ——
 * 只有他本人和管理员看得到，别的客人一个字都翻不着。账本上的「公开」
 * 是管理员在记忆面板里亲自点的头，谁（包括前端）都不能替他做这个决定。
 *
 * 墙：公开权益（permPublic 档位）的持卡者贴的纸条，进门的人谁都看得到。
 * 能贴就能撤自己的 —— 收回自己说过的话不算改账本；管理员的板子他随时收拾。
 *
 * 账本只能添、不能改也不能删；墙上的条目署名是贴上去那一刻的昵称快照。
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
              if (e.key === "Enter") void post();
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
              if (e.key === "Enter") void add();
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
 * 云盘里的名字对人不友好：上传的是「时间戳-原名」，他画的是「draw-时间戳.png」。
 * 文件名这一层换成能认出来的说法；路径的层次交给树去摆。
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
 * 把平铺的 key 列表拼成一棵树。文件夹就是 key 里的路径段 ——
 * .keep 占位对象只负责把空文件夹撑出来，不当文件列；
 * 自己房间前缀剥掉（那是屋里屋外的划界，不是目录名），
 * 公开空间给个人话名字。写操作用的还是完整 key，剥的只是显示层。
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
 * 提示词编辑器：三份可改提示词共用一套交互（草稿 / 保存 / 恢复默认）。
 *
 * 三份都是「空串 = 用内置默认」，所以初值要用出厂默认值兜底 ——
 * 否则管理员打开面板看到的是空白，会误以为提示词丢了。
 * 只在外部值变化时同步草稿，避免打字打到一半被覆盖。
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
 * 一格稿子：草稿 + 失焦落库。
 *
 * 工具守则的格子有几十个，每格再摆一对「保存/恢复默认」按钮会吵得没法看，
 * 所以改成改完移开焦点（或按 Ctrl/Cmd+Enter）即落库，右上角一个小标记说明
 * 这一格是自定义还是出厂默认。内容没变就不打扰后端。
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
 * 工具守则：「8、我能用的工具」那一块，拆成 语义组 → 逐工具 两级。
 *
 * 一件工具一格提示词，改 read_url 不影响 draw；每组末尾一格写「这一组里
 * 什么话用哪件」；跨组的话（调用纪律、call_tool 用法、主动开口）收在末尾
 * 的「工具组使用风格」里。名册从 /api/tool-groups 取 —— 前后端各写一份
 * 必定对不上号（未来接 MCP 时新工具会自动出现在这里）。
 *
 * 主人/来客两套分开存、分开改：来客屋有自己的状态，管理员改主人那份，
 * 覆盖值不该漏到别人屋里去。
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
 * 默认口径是工作纪要（发生了什么、做了什么、什么情况、要收敛什么、下一步），
 * 不是感想 —— 这里改的是「记什么」，改完只影响之后的回想，不追溯已入库的条目。
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
 * 会话管理面板。消息本体存在后端 DO 里，切换会话是把那一场灌回对话主循环，
 * 所以这里点「切过去」是真的换对话，不是只换标题。
 * 列表数据由 App 统一加载，这里只负责渲染与转发操作，免得侧栏和设置页各拉一份。
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
 * 嗓子出自哪一路。读音服务条目化之后 provider 是协议名（mimo-chat / doubao /
 * glm-speech），这里翻成人话；没对上号的直接显示原值，不挡后端加新协议。
 * 为什么要标出来：一家念不出来（key 不对、余额不足）通常是一整排一起念不出来，
 * 用户看到「MiMo 那三副全是灰的」，就知道该去修 MiMo 那条配置，而不用一副一副试。
 */
const PROVIDER_LABEL: Record<string, string> = {
  "mimo-chat": "MiMo 式",
  doubao: "豆包",
  "glm-speech": "智谱",
};

/**
 * 挑一副念给你听的嗓子。
 *
 * 为什么非要「试听」这一下：音色的名字（「温婉珊珊」「锤锤」）谁也看不出好不好听，
 * 得让耳朵说了算。所以每副嗓子旁边就是一个能当场念一句的按钮，听完再定。
 *
 * 记在 state 里而不是 localStorage：换台设备打开，念给你听的还是同一个人。
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
    setTrying(v.id);
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
                {v.available ? v.desc : `${v.desc} —— ${v.why}`}
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
 * 来客名册 + 单个来客的留痕明细。
 *
 * 留痕是介绍页里当面承诺过的：「你随时可以问他记了你什么，他原样摊开」。
 * 这张面板就是承诺的管理员侧 —— 明细留在各间来客屋里（点开才隔着 DO 去取），
 * 这里只摆名册。加载失败就地写一句，不弹全局报错：来客的账晚几秒看到没关系。
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

// ── 来客类型（口令与说明）──────────────────────────────
//
// 权益不在这里改 —— 逐工具的权限矩阵搬到了「来客权限管理」页（见 GuestPermsPanel）。
// 这一页只管「有哪些档、各用什么口令进门、怎么接待」；新建的档默认对外工具全开。

/** 行内编辑表单的草稿：从某一行复制出来，改完整体 PATCH */
interface GuestDraft {
  name: string;
  password: string;
  note: string;
  active: boolean;
}

const draftOf = (t: GuestType): GuestDraft => ({
  name: t.name,
  // 口令不回显（后端只存摘要）：留空表示不改，要换才填
  password: "",
  note: t.note,
  active: t.active,
});

/**
 * 来客类型管理：一个自定义口令就是一类来客。
 *
 * 列表 + 顶部新增表单 + 行内展开编辑。口令在后端只存 SHA-256 摘要，
 * 列表上永远只给掩码 —— 摘要不可逆，忘了口令就重设一个，没有「点开看」这条路。
 * 停用不是删除：配置留着，随时能再打开；只有真不要了这个口令才删。
 * 改动对之后新登录的来客生效。
 */
export function GuestTypesPanel() {
  const [types, setTypes] = useState<GuestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 新增表单：名称 + 口令必填；对外工具与长期权益都走后端缺省
  // （新档对外工具全开、长期权益全关：先来的是临时来客，私人空间等他领了卡再说）
  const [nName, setNName] = useState("");
  const [nPw, setNPw] = useState("");
  const [nNote, setNNote] = useState("");
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);

  // 行内编辑：editingId 非空时那一行展开成表单
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState<GuestDraft | null>(null);
  const [editErr, setEditErr] = useState("");
  const [busy, setBusy] = useState(false);

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

  const startEdit = (t: GuestType) => {
    if (editingId === t.id) {
      setEditingId("");
      setDraft(null);
      return;
    }
    setEditingId(t.id);
    setEditErr("");
    setDraft(draftOf(t));
  };

  const add = async () => {
    if (!nName.trim() || !nPw.trim() || adding) return;
    setAdding(true);
    setAddErr("");
    try {
      // 工具权益与长期权益都不带：走后端缺省（对外全开、长期全关），
      // 之后到「来客权限管理」页按件调
      await api.guestTypeAdd({
        name: nName.trim(),
        password: nPw.trim(),
        note: nNote.trim(),
      });
      setNName("");
      setNPw("");
      setNNote("");
      await load();
    } catch (e) {
      // 后端校验不过（如口令和现有的重复）原样摆在这里，不翻译
      setAddErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!draft || !editingId || busy) return;
    setBusy(true);
    setEditErr("");
    try {
      const { password, ...rest } = draft;
      // 口令留空 = 不改；填了才带上这个字段
      await api.guestTypePatch({
        id: editingId,
        ...rest,
        password: password.trim() || undefined,
      });
      setEditingId("");
      setDraft(null);
      await load();
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setBusy(false);
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
      </p>

      <h3 className="sect">新增类型</h3>
      <div className="inline-form col">
        {addErr && <p className="err">{addErr}</p>}
        <div className="inline-form">
          <input
            className="field"
            placeholder="名称（必填）"
            value={nName}
            onChange={(e) => setNName(e.target.value)}
          />
          <input
            className="field"
            placeholder="口令（必填）"
            value={nPw}
            onChange={(e) => setNPw(e.target.value)}
          />
          <input
            className="field"
            placeholder="说明（可空）"
            value={nNote}
            onChange={(e) => setNNote(e.target.value)}
          />
        </div>
        <p className="meta">
          新档默认对外工具全开、长期权益全关 —— 到「来客权限管理」页再按件调。
        </p>
        <div className="inline-form">
          <button
            className="btn btn-primary btn-sm"
            onClick={add}
            disabled={adding || !nName.trim() || !nPw.trim()}
          >
            保存
          </button>
        </div>
      </div>

      <h3 className="sect">自定义类型（{types.length}）</h3>
      <ul className="remind-list">
        {types.map((t) => {
          return (
            <li
              className="remind-row"
              key={t.id}
              style={!t.active ? { opacity: 0.55 } : undefined}
            >
              <div className="remind-when">
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <span className="meta" title="口令只存摘要不回显，忘了就重设">
                  ••••••
                </span>
                {!t.active && <span className="tag">已停用</span>}
              </div>

              <div className="remind-when">
                {t.tools.length ? (
                  t.tools.map((n) => (
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
                {t.permNotes && (
                  <span
                    className="chip on"
                    style={{ cursor: "default" }}
                    title="只对持身份卡的长期使用者生效"
                  >
                    记事本
                  </span>
                )}
                {t.permFiles && (
                  <span
                    className="chip on"
                    style={{ cursor: "default" }}
                    title="只对持身份卡的长期使用者生效"
                  >
                    云盘上传
                  </span>
                )}
                {t.permPublic && (
                  <span
                    className="chip on"
                    style={{ cursor: "default" }}
                    title="只对持身份卡的长期使用者生效"
                  >
                    公开内容
                  </span>
                )}
              </div>

              {t.note && (
                <p
                  className="meta"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.note}
                </p>
              )}

              <div className="row-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => startEdit(t)}
                >
                  {editingId === t.id ? "收起" : "编辑"}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void toggleActive(t)}
                >
                  {t.active ? "停用" : "启用"}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => void del(t)}
                >
                  删除
                </button>
              </div>

              {editingId === t.id && draft && (
                <div className="panel-body">
                  {editErr && <p className="err">{editErr}</p>}
                  <div className="inline-form">
                    <input
                      className="field"
                      placeholder="名称"
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                    <input
                      className="field"
                      placeholder="口令（留空 = 不改）"
                      value={draft.password}
                      onChange={(e) =>
                        setDraft({ ...draft, password: e.target.value })
                      }
                    />
                  </div>
                  <input
                    className="field"
                    placeholder="说明（可空）"
                    value={draft.note}
                    onChange={(e) =>
                      setDraft({ ...draft, note: e.target.value })
                    }
                  />
                  <p className="meta pad">
                    对外工具与长期权益到「来客权限管理」页按件调。
                  </p>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) =>
                        setDraft({ ...draft, active: e.target.checked })
                      }
                    />
                    启用：这个口令现在能进门
                  </label>
                  <div className="inline-form">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={saveEdit}
                      disabled={busy || !draft.name.trim()}
                    >
                      保存
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId("");
                        setDraft(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !types.length && !err && (
        <p className="empty-sm">
          还没有自定义类型。通用门禁口令进来的来客不在此列，权限全开。
        </p>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}

// ── 来客权限管理（各档 × 各工具）──────────────────────

/**
 * 长期权益：普通口令进来的临时来客没有持久身份，谈不上「自己的」东西，
 * 所以这组开关只对持身份卡的长期使用者生效（凭卡解锁，见 src/index.ts cardAllows）。
 */
const CARD_PERMS: Array<{
  key: "permNotes" | "permFiles" | "permPublic";
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
];

/**
 * 来客权限管理：一张矩阵 —— 每行一档来客，每列一件对外工具。
 *
 * 对外工具里能被关掉的（guestTogglable）逐件勾选；恒开的（天气/识图/卡片/留痕）
 * 置灰标「恒开」—— 那是介绍页当面说过的，没有关掉的路。长期权益另起一小节。
 *
 * 名册从 /api/tool-groups 取（与工具守则面板同一份），档位从 /api/guest-types 取。
 * 改一格立刻 PATCH 这一档的整份工具清单：逐格提交，不必整页保存。
 * 改动对之后新登录的来客生效。
 */
export function GuestPermsPanel() {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [types, setTypes] = useState<GuestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

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
    setBusy(`${t.id}:${name}`);
    try {
      await api.guestTypePatch({ id: t.id, tools: next });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const setCardPerm = async (
    t: GuestType,
    key: "permNotes" | "permFiles" | "permPublic",
    on: boolean,
  ) => {
    setBusy(`${t.id}:${key}`);
    try {
      await api.guestTypePatch({ id: t.id, [key]: on });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="panel-body">
      <p className="meta">
        逐件勾这一档能用的工具：勾了才出现在来客那间；没勾的，来客问起来助手会照实说「做不到」，不拿好听的话应付。
        改一格即时生效，对之后新登录的来客生效。通用门禁口令进来的来客不在此列
        —— 那种来客权限全开。
      </p>

      {loading && <p className="empty-sm">读取中…</p>}

      {!loading && !types.length && (
        <p className="empty-sm">
          还没有自定义档位。先去「来客类型」页建一档、配好口令，再回来勾工具。
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
                            disabled={busy === key}
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
            普通口令进来的临时来客没有持久身份，谈不上「自己的」东西，所以这三项只对持身份卡的长期使用者生效。
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
                        disabled={busy === key}
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
        </>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}

// ── 模型配置 ──────────────────────────────────────────

/**
 * 供应商表单草稿（新增与编辑共用）。
 * 名称就是供应商名称 —— 旧表单「名称 vs 模型名」的二义性已经拆开：
 * 供应商级管接哪一家，模型名归各家底下的模型条目。
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
 * 换线格式时把接口地址跟着换对：地址若正是某厂商某格式的已知地址，
 * 就换成同厂商在新格式下的地址（DeepSeek 的 anthropic 与 openai 格式
 * 是两个门，格式换了门没换必然 404）。手改过的地址不匹配任何已知值，
 * 说明人知道自己在干什么，不动。
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

/** 上下文输入框里的 K 值折回 token；空着或不像样返回 undefined（= 不动 / 默认档） */
const kToTokens = (s: string): number | undefined => {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) && n > 0
    ? Math.round(n * 1000)
    : undefined;
};

/** token 数画成 K：200000 → 200K */
const tokensToK = (n: number): string => `${Math.round(n / 1000)}K`;

/**
 * 模型目录：供应商管「接哪家」（地址、格式、Key 变量名），模型条目挂在各家
 * 底下、随便挂几个 —— 一家供应商不再只绑死一个模型。
 * 厂商表帮人起头（选一家带出地址与坑，都写在 note 里），模型名靠「拉取模型列表」
 * 从厂商现拉现挑。这里只管「有哪些可选」；普通和深度各用哪个，去回复风格页指派。
 * Key 存的是 secret 变量名：Key 本身永远不进浏览器。
 */
export function ModelConfigsPanel() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 新增供应商表单：先挑厂商（或空白）预填「接哪一家」，首个模型可空、之后再加
  const [vendorKey, setVendorKey] = useState("");
  const [draft, setDraft] = useState<ProviderDraft>(blankProviderDraft);
  const [firstModel, setFirstModel] = useState("");
  const [firstMax, setFirstMax] = useState("");
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);

  // 供应商行内编辑：editingId 非空时那一家展开成表单
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState<ProviderDraft | null>(null);
  const [editErr, setEditErr] = useState("");
  const [busy, setBusy] = useState(false);

  // 给某家供应商添加模型：openAddFor 是展开着「添加模型」行的那家 id
  const [openAddFor, setOpenAddFor] = useState("");
  const [entryDraft, setEntryDraft] = useState<EntryDraft>(blankEntryDraft);
  const [entryErr, setEntryErr] = useState("");

  // 条目行内编辑：entryEditId 非空时那一条展开成小表单
  const [entryEditId, setEntryEditId] = useState("");
  const [entryEdit, setEntryEdit] = useState<EntryDraft | null>(null);

  // 拉模型列表：chips 展开在对应位置，点了填进对应草稿
  const [listingId, setListingId] = useState("");
  const [listing, setListing] = useState(false);
  const [models, setModels] = useState<Array<{
    id: string;
    name?: string;
  }> | null>(null);
  const [listErr, setListErr] = useState("");

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

  const applyVendor = (key: string) => {
    setVendorKey(key);
    const v = VENDOR_PRESETS.find((x) => x.key === key);
    if (!v) {
      setDraft(blankProviderDraft());
      setFirstModel("");
      setFirstMax("");
      return;
    }
    // 厂商只带出「接哪一家」的部分；首个模型名不预填，拉取列表后点选
    setDraft({
      name: v.label,
      format: v.format,
      baseUrl: v.baseUrl,
      keySecret: v.keySecret,
      maintKeySecret: "",
      maintModel: "",
    });
    setFirstModel("");
    setFirstMax(String(v.maxOutput));
  };
  const vendor = VENDOR_PRESETS.find((x) => x.key === vendorKey) || null;

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setAddErr("");
    try {
      await api.modelProviderAdd({
        ...providerPayloadOf(draft),
        firstModel: firstModel.trim() || undefined,
        maxOutput: firstMax.trim() ? Number(firstMax) : undefined,
      });
      setVendorKey("");
      setDraft(blankProviderDraft());
      setFirstModel("");
      setFirstMax("");
      await load();
    } catch (e) {
      // 后端校验不过（缺 Key、地址不对之类）原样摆在这里，不翻译
      setAddErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (p: ModelProvider) => {
    if (editingId === p.id) {
      setEditingId("");
      setEditDraft(null);
      return;
    }
    setEditingId(p.id);
    setEditErr("");
    setEditDraft(providerDraftOf(p));
  };

  const saveEdit = async () => {
    if (!editDraft || !editingId || busy) return;
    setBusy(true);
    setEditErr("");
    try {
      await api.modelProviderPatch({
        id: editingId,
        ...providerPayloadOf(editDraft),
      });
      setEditingId("");
      setEditDraft(null);
      await load();
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const delProvider = async (p: ModelProvider) => {
    if (!window.confirm(`删掉「${p.name}」？名下的模型条目会一并删除。`))
      return;
    await api.modelProviderDelete(p.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  /**
   * 拉模型列表：scope 是供应商 id（已保存的那家）或 ADD_SCOPE（新增表单）。
   * 地址若是某厂商的已知门，就用该厂商标定过的列表端点与鉴权头 ——
   * anthropic 家的兼容门下没有 /models，瞎拼只会白吃一个 404。
   */
  const pullModels = async (
    scope: string,
    format: ModelFormat,
    baseUrl: string,
    keySecret: string,
  ) => {
    if (listingId === scope) {
      setListingId("");
      setModels(null);
      setListErr("");
      return;
    }
    setListingId(scope);
    setModels(null);
    setListErr("");
    setListing(true);
    try {
      const vendor = VENDOR_PRESETS.find((x) =>
        Object.values(x.urls).includes(baseUrl),
      );
      const r = await api.modelListModels({
        format,
        baseUrl,
        keySecret,
        ...(vendor
          ? { listUrl: vendor.listUrl, listAuth: vendor.listAuth }
          : {}),
      });
      setModels(r.models);
    } catch (e) {
      setListErr((e as Error).message);
      setModels([]);
    } finally {
      setListing(false);
    }
  };

  /** 点模型 chip：新增表单里填「首个模型名」；供应商行里直接挂成条目 */
  const pickModel = async (scope: string, id: string) => {
    if (scope === ADD_SCOPE) {
      setFirstModel(id);
      return;
    }
    try {
      await api.modelEntryAdd({ providerId: scope, model: id });
      setEntryDraft(blankEntryDraft());
      await load();
    } catch (e) {
      setEntryErr((e as Error).message);
    }
  };

  /** 给某家挂一个手填的模型条目 */
  const addEntry = async (providerId: string) => {
    if (!entryDraft.model.trim()) return;
    setEntryErr("");
    try {
      await api.modelEntryAdd({
        providerId,
        model: entryDraft.model.trim(),
        maxOutput: entryDraft.maxOutput.trim()
          ? Number(entryDraft.maxOutput)
          : undefined,
        contextWindow: kToTokens(entryDraft.contextWindow),
      });
      setEntryDraft(blankEntryDraft());
      await load();
    } catch (e) {
      setEntryErr((e as Error).message);
    }
  };

  const startEntryEdit = (e: ModelEntry) => {
    if (entryEditId === e.id) {
      setEntryEditId("");
      setEntryEdit(null);
      return;
    }
    setEntryEditId(e.id);
    setEntryEdit({
      model: e.model,
      maxOutput: e.maxOutput ? String(e.maxOutput) : "",
      contextWindow: e.contextWindow
        ? String(Math.round(e.contextWindow / 1000))
        : "",
    });
  };

  const saveEntryEdit = async () => {
    if (!entryEdit || !entryEditId) return;
    try {
      await api.modelEntryPatch({
        id: entryEditId,
        model: entryEdit.model.trim(),
        maxOutput: entryEdit.maxOutput.trim()
          ? Number(entryEdit.maxOutput)
          : undefined,
        contextWindow: kToTokens(entryEdit.contextWindow),
      });
      setEntryEditId("");
      setEntryEdit(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const delEntry = async (e: ModelEntry) => {
    if (!window.confirm(`删掉模型「${e.model}」？`)) return;
    await api.modelEntryDelete(e.id).catch((er: Error) => setErr(er.message));
    await load();
  };

  /** 新增与编辑共用的供应商字段集，保证两处要填的东西永远一致 */
  const renderProviderFields = (
    d: ProviderDraft,
    patch: (p: Partial<ProviderDraft>) => void,
    modelListId?: string,
  ) => (
    <>
      <div className="inline-form">
        <input
          className="field"
          placeholder="供应商名称"
          value={d.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <select
          className="field"
          value={d.format}
          onChange={(e) => {
            const f = e.target.value as ModelFormat;
            // 格式换了，门也得换：地址跟着预设表走，别让 anthropic 的门收 openai 的信
            const next = urlForFormat(d.baseUrl, d.format, f);
            patch(next ? { format: f, baseUrl: next } : { format: f });
          }}
          aria-label="接口格式"
        >
          {(Object.keys(MODEL_FORMAT_LABEL) as ModelFormat[]).map((f) => (
            <option key={f} value={f}>
              {MODEL_FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </div>
      <input
        className="field"
        placeholder="Base URL"
        value={d.baseUrl}
        onChange={(e) => patch({ baseUrl: e.target.value })}
      />
      <div className="inline-form">
        <input
          className="field"
          list="mc-key-secrets"
          placeholder="Key 变量名"
          value={d.keySecret}
          onChange={(e) => patch({ keySecret: e.target.value })}
        />
        {/* 常见手误：把 Key 本体当变量名贴进来。取不到值不说，Key 还落了库 */}
        {/^sk-\S+/.test(d.keySecret.trim()) && (
          <p className="err">
            这串像是 Key 本体（sk- 开头）。这一栏填的是 secret 变量名，比如
            DEEPSEEK_KEY；Key 本体在终端跑 npx wrangler secret put DEEPSEEK_KEY
            配进这台机器。
          </p>
        )}
      </div>
      <div className="inline-form">
        <input
          className="field"
          list="mc-key-secrets"
          placeholder="维护用 Key（留空 = 用上面那把）"
          value={d.maintKeySecret}
          onChange={(e) => patch({ maintKeySecret: e.target.value })}
        />
        <input
          className="field"
          list={modelListId}
          placeholder="维护用模型（留空 = 复用主线）"
          value={d.maintModel}
          onChange={(e) => patch({ maintModel: e.target.value })}
        />
      </div>
    </>
  );

  /** 遗留的通用环境变量：模型目录还没建起来时，它仍会被当作回落 */
  const hasLegacyKey = keySecrets.some((k) => k === "API_KEY");

  return (
    <div className="panel-body">
      <p className="meta">
        一家供应商就是一套接模型的钥匙串，底下想挂几个模型就挂几个。这里只管「有哪些模型可选」；普通和深度两种模式各用哪个，在设置
        → 回复风格里指派，指派完下一轮对话生效。
      </p>

      <h3 className="sect">新增供应商</h3>
      <div className="inline-form col">
        {addErr && <p className="err">{addErr}</p>}
        <div className="inline-form">
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
          <button
            className="btn btn-ghost btn-sm"
            disabled={!draft.baseUrl.trim() || !draft.keySecret.trim()}
            title="问这一家现在有哪些模型可挑"
            onClick={() =>
              void pullModels(
                ADD_SCOPE,
                draft.format,
                draft.baseUrl.trim(),
                draft.keySecret.trim(),
              )
            }
          >
            {listingId === ADD_SCOPE && listing ? "拉取中…" : "拉取模型列表"}
          </button>
        </div>
        {vendor && (
          <p className="meta">
            {vendor.note}{" "}
            <a href={vendor.modelsPage} target="_blank" rel="noreferrer">
              官方模型列表站 ↗
            </a>
          </p>
        )}
        {listingId === ADD_SCOPE && (
          <div className="panel-body">
            {listErr && <p className="err">{listErr}</p>}
            {listing && <p className="empty-sm">拉取中…</p>}
            {models && !listing && !models.length && !listErr && (
              <p className="empty-sm">
                这一家没回模型清单 —— Key 或地址可能不对。
              </p>
            )}
            {!!models?.length && (
              <>
                <div className="tabs">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      className="chip"
                      title={m.name && m.name !== m.id ? m.name : undefined}
                      onClick={() => pickModel(ADD_SCOPE, m.id)}
                    >
                      {m.id}
                    </button>
                  ))}
                </div>
                <p className="meta">点一个模型名，填进「首个模型名」。</p>
              </>
            )}
          </div>
        )}
        {renderProviderFields(draft, (p) =>
          setDraft((prev) => ({ ...prev, ...p })),
        )}
        <div className="inline-form">
          <input
            className="field"
            placeholder="首个模型名（可空，之后再加）"
            value={firstModel}
            onChange={(e) => setFirstModel(e.target.value)}
          />
          <input
            className="field"
            placeholder="输出上限（token，可空）"
            value={firstMax}
            onChange={(e) => setFirstMax(e.target.value)}
          />
        </div>
        <p className="meta">
          Key 填的是变量名：新厂商先在终端跑 npx wrangler secret put
          DEEPSEEK_KEY 把 Key 配进这台机器，再到这里填变量名
          {keySecrets.length ? "，配过的名字会出现在下拉里" : ""}。
          {hasLegacyKey
            ? " 检测到环境里还配着 API_KEY：未建模型目录时，它仍会被用作回落。"
            : ""}
        </p>
        <div className="inline-form">
          <button
            className="btn btn-primary btn-sm"
            onClick={add}
            disabled={
              adding ||
              !draft.name.trim() ||
              !draft.baseUrl.trim() ||
              !draft.keySecret.trim()
            }
          >
            {adding ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <h3 className="sect">供应商（{providers.length}）</h3>
      <ul className="remind-list">
        {providers.map((p) => {
          const mine = entries.filter((x) => x.providerId === p.id);
          return (
            <li className="remind-row" key={p.id}>
              <div className="remind-when">
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span className="tag">
                  {MODEL_FORMAT_LABEL[p.format] || p.format}
                </span>
                <span className="tag ghost">{p.keySecret}</span>
                {p.maintModel && (
                  <span className="meta">维护 {p.maintModel}</span>
                )}
              </div>
              <div className="remind-when">
                <span className="meta">{p.baseUrl}</span>
              </div>

              <div className="row-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => startEdit(p)}
                >
                  {editingId === p.id ? "收起" : "编辑"}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setOpenAddFor(openAddFor === p.id ? "" : p.id);
                    setEntryDraft(blankEntryDraft());
                    setEntryErr("");
                    if (openAddFor !== p.id)
                      void pullModels(p.id, p.format, p.baseUrl, p.keySecret);
                  }}
                  title="问这一家现在有哪些模型可挑"
                >
                  {listingId === p.id && listing ? "拉取中…" : "添加模型"}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => void delProvider(p)}
                >
                  删除
                </button>
              </div>

              {/* 模型条目：这一家挂着的所有模型；普通模式用哪个，去「回复风格」页指派 */}
              {mine.length > 0 && (
                <ul className="remind-list">
                  {mine.map((e) => (
                    <li className="remind-row" key={e.id}>
                      <div className="remind-when">
                        <span style={{ fontWeight: 600 }}>{e.model}</span>
                        <span className="meta">
                          输出上限 {e.maxOutput || "默认"} · 上下文{" "}
                          {e.contextWindow
                            ? tokensToK(e.contextWindow)
                            : "默认"}
                        </span>
                      </div>
                      <div className="row-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => startEntryEdit(e)}
                        >
                          {entryEditId === e.id ? "收起" : "编辑"}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void delEntry(e)}
                        >
                          删除
                        </button>
                      </div>
                      {entryEditId === e.id && entryEdit && (
                        <div className="panel-body">
                          <div className="inline-form">
                            <input
                              className="field"
                              placeholder="模型名"
                              value={entryEdit.model}
                              onChange={(ev) =>
                                setEntryEdit({
                                  ...entryEdit,
                                  model: ev.target.value,
                                })
                              }
                            />
                            <input
                              className="field"
                              placeholder="输出上限（token，可空）"
                              value={entryEdit.maxOutput}
                              onChange={(ev) =>
                                setEntryEdit({
                                  ...entryEdit,
                                  maxOutput: ev.target.value,
                                })
                              }
                            />
                            <input
                              className="field"
                              placeholder="最大上下文（K，可空）"
                              value={entryEdit.contextWindow}
                              onChange={(ev) =>
                                setEntryEdit({
                                  ...entryEdit,
                                  contextWindow: ev.target.value,
                                })
                              }
                            />
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => void saveEntryEdit()}
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {mine.length === 0 && (
                <p className="empty-sm">
                  这家还没挂模型 —— 点「添加模型」拉列表挑，或者手填一个。
                </p>
              )}

              {/* 添加模型行：手填模型名，或点上面拉回来的 chips */}
              {openAddFor === p.id && (
                <div className="panel-body">
                  {entryErr && <p className="err">{entryErr}</p>}
                  {listing && <p className="empty-sm">拉取中…</p>}
                  {listErr && listingId === p.id && (
                    <p className="err">{listErr}</p>
                  )}
                  {models && !listing && !models.length && !listErr && (
                    <p className="empty-sm">
                      这一家没回模型清单 —— Key 或地址可能不对。
                    </p>
                  )}
                  {!!models?.length && (
                    <>
                      <div className="tabs">
                        {models.map((m) => (
                          <button
                            key={m.id}
                            className="chip"
                            title={
                              m.name && m.name !== m.id ? m.name : undefined
                            }
                            onClick={() => void pickModel(p.id, m.id)}
                          >
                            {m.id}
                          </button>
                        ))}
                      </div>
                      <p className="meta">
                        点一个模型名，直接挂进这一家；也可以在下面手填。
                      </p>
                    </>
                  )}
                  <div className="inline-form">
                    <input
                      className="field"
                      placeholder="模型名"
                      value={entryDraft.model}
                      onChange={(ev) =>
                        setEntryDraft({
                          ...entryDraft,
                          model: ev.target.value,
                        })
                      }
                    />
                    <input
                      className="field"
                      placeholder="输出上限（token，可空）"
                      value={entryDraft.maxOutput}
                      onChange={(ev) =>
                        setEntryDraft({
                          ...entryDraft,
                          maxOutput: ev.target.value,
                        })
                      }
                    />
                    <input
                      className="field"
                      placeholder="最大上下文（K，可空）"
                      value={entryDraft.contextWindow}
                      onChange={(ev) =>
                        setEntryDraft({
                          ...entryDraft,
                          contextWindow: ev.target.value,
                        })
                      }
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={!entryDraft.model.trim()}
                      onClick={() => void addEntry(p.id)}
                    >
                      添加
                    </button>
                  </div>
                </div>
              )}

              {editingId === p.id && editDraft && (
                <div className="panel-body">
                  {editErr && <p className="err">{editErr}</p>}
                  {renderProviderFields(
                    editDraft,
                    (patch) =>
                      setEditDraft((prev) =>
                        prev ? { ...prev, ...patch } : prev,
                      ),
                    `mm-${p.id}`,
                  )}
                  <p className="meta">
                    维护用模型从这一家挂着的模型里挑（往下看有清单），留空就跟着主线走。
                  </p>
                  <div className="inline-form">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={saveEdit}
                      disabled={
                        busy ||
                        !editDraft.name.trim() ||
                        !editDraft.baseUrl.trim() ||
                        !editDraft.keySecret.trim()
                      }
                    >
                      保存
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId("");
                        setEditDraft(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 维护用模型的下拉选项：这一家自己的模型条目 */}
              <datalist id={`mm-${p.id}`}>
                {mine.map((e) => (
                  <option key={e.id} value={e.model} />
                ))}
              </datalist>
            </li>
          );
        })}
      </ul>

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !providers.length && !err && (
        <p className="empty-sm">
          还没有供应商。从上面的厂商挑一家起头，拉模型列表点选后保存；空白新建也行。
        </p>
      )}

      {err && <p className="err">{err}</p>}

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

/** 读音条目的草稿：新增与行内编辑共用 */
interface TtsDraft {
  name: string;
  protocol: TtsProtocol;
  baseUrl: string;
  keySecret: string;
  model: string;
  voice: string;
  style: string;
}

const blankTtsDraft = (): TtsDraft => ({
  name: "",
  protocol: "mimo-chat",
  baseUrl: "",
  keySecret: "",
  model: "",
  voice: "",
  style: "",
});

const ttsDraftOf = (t: TtsConfig): TtsDraft => ({
  name: t.name,
  protocol: t.protocol,
  baseUrl: t.baseUrl,
  keySecret: t.keySecret,
  model: t.model,
  voice: t.voice,
  style: t.style,
});

/** 非MiMo 式的条目 style 没有意义，提交时清掉，免得留脏数据 */
const ttsPayloadOf = (d: TtsDraft) => ({
  name: d.name.trim(),
  protocol: d.protocol,
  baseUrl: d.baseUrl.trim(),
  keySecret: d.keySecret.trim(),
  model: d.model.trim(),
  voice: d.voice.trim(),
  style: d.protocol === "mimo-chat" ? d.style.trim() : "",
});

/**
 * 读音配置：一条就是一副可用的嗓子。内置的三家已经移除，
 * 朗读用哪副完全由这里的条目决定，排在最前且 Key 可用的那条是默认。
 * 没有条目时朗读回退浏览器音色 —— 能出声，就是不好听。
 */
export function TtsConfigsPanel() {
  const [tts, setTts] = useState<TtsConfig[]>([]);
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 新增表单
  const [draft, setDraft] = useState<TtsDraft>(blankTtsDraft);
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);

  // 行内编辑
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState<TtsDraft | null>(null);
  const [editErr, setEditErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.ttsConfigs();
      setTts(r.tts);
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

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setAddErr("");
    try {
      await api.ttsConfigAdd(ttsPayloadOf(draft));
      setDraft(blankTtsDraft());
      await load();
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (t: TtsConfig) => {
    if (editingId === t.id) {
      setEditingId("");
      setEditDraft(null);
      return;
    }
    setEditingId(t.id);
    setEditErr("");
    setEditDraft(ttsDraftOf(t));
  };

  const saveEdit = async () => {
    if (!editDraft || !editingId || busy) return;
    setBusy(true);
    setEditErr("");
    try {
      await api.ttsConfigPatch({ id: editingId, ...ttsPayloadOf(editDraft) });
      setEditingId("");
      setEditDraft(null);
      await load();
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async (t: TtsConfig) => {
    if (!window.confirm(`删掉「${t.name}」？这副嗓子之后就没人念了。`)) return;
    await api.ttsConfigDelete(t.id).catch((e: Error) => setErr(e.message));
    await load();
  };

  /** 新增与编辑共用的字段集：model / voice 的占位话跟着协议走 */
  const renderTtsFields = (
    d: TtsDraft,
    patch: (p: Partial<TtsDraft>) => void,
  ) => {
    const def = TTS_DEFAULTS[d.protocol];
    return (
      <>
        <div className="inline-form">
          <input
            className="field"
            placeholder="名称"
            value={d.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
          <select
            className="field"
            value={d.protocol}
            onChange={(e) => patch({ protocol: e.target.value as TtsProtocol })}
            aria-label="协议"
          >
            {(Object.keys(TTS_PROTOCOL_LABEL) as TtsProtocol[]).map((p) => (
              <option key={p} value={p}>
                {TTS_PROTOCOL_LABEL[p]}
              </option>
            ))}
          </select>
          <input
            className="field"
            list="tts-key-secrets"
            placeholder="Key 变量名"
            value={d.keySecret}
            onChange={(e) => patch({ keySecret: e.target.value })}
          />
        </div>
        <input
          className="field"
          placeholder="Base URL（可空 = 用这一家的默认地址）"
          value={d.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
        <div className="inline-form">
          <input
            className="field"
            placeholder={`模型（${def.model}）`}
            value={d.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
          <input
            className="field"
            placeholder={def.voicePh}
            value={d.voice}
            onChange={(e) => patch({ voice: e.target.value })}
          />
        </div>
        {d.protocol === "mimo-chat" && (
          <input
            className="field"
            placeholder="语气 style（这一家特有，可空）"
            value={d.style}
            onChange={(e) => patch({ style: e.target.value })}
          />
        )}
        <p className="meta">
          {def.note}
          {d.protocol === "mimo-chat" ? "；语气 style 只有这一家用得上" : ""}
          {keySecrets.length ? "；Key 配过的名字在下拉里" : ""}
        </p>
      </>
    );
  };

  return (
    <div className="panel-body">
      <p className="meta">
        内置的三家嗓音已经移除，读音服务完全由这里的条目决定：一条就是一副可用的嗓子；
        没有条目时，朗读回退浏览器自带的音色。排在最前、Key
        可用的那条是默认嗓子。
      </p>

      <h3 className="sect">新增嗓子</h3>
      <div className="inline-form col">
        {addErr && <p className="err">{addErr}</p>}
        {renderTtsFields(draft, (p) => setDraft((prev) => ({ ...prev, ...p })))}
        <div className="inline-form">
          <button
            className="btn btn-primary btn-sm"
            onClick={add}
            disabled={
              adding ||
              !draft.name.trim() ||
              !draft.keySecret.trim() ||
              !draft.model.trim()
            }
          >
            {adding ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <h3 className="sect">嗓子（{tts.length}，排前面的优先）</h3>
      <ul className="remind-list">
        {tts.map((t) => (
          <li className="remind-row" key={t.id}>
            <div className="remind-when">
              <span style={{ fontWeight: 600 }}>{t.name}</span>
              <span className="tag">
                {TTS_PROTOCOL_LABEL[t.protocol] || t.protocol}
              </span>
              <span className="meta">{t.model || "默认模型"}</span>
              <span className="meta">音色 {t.voice || "默认"}</span>
            </div>

            <div className="row-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => startEdit(t)}
              >
                {editingId === t.id ? "收起" : "编辑"}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void del(t)}
              >
                删除
              </button>
            </div>

            {editingId === t.id && editDraft && (
              <div className="panel-body">
                {editErr && <p className="err">{editErr}</p>}
                {renderTtsFields(editDraft, (p) =>
                  setEditDraft((prev) => (prev ? { ...prev, ...p } : prev)),
                )}
                <div className="inline-form">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={saveEdit}
                    disabled={
                      busy ||
                      !editDraft.name.trim() ||
                      !editDraft.keySecret.trim() ||
                      !editDraft.model.trim()
                    }
                  >
                    保存
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setEditingId("");
                      setEditDraft(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {loading && <p className="empty-sm">读取中…</p>}
      {!loading && !tts.length && !err && (
        <p className="empty-sm">还没有读音条目，现在朗读用的是浏览器音色。</p>
      )}

      {err && <p className="err">{err}</p>}

      <datalist id="tts-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );
}

/** 三档的名目与定位。tier 就是配置主键，顺序永远是：high → fast → fallback */
const DRAW_TIER_META: Record<
  DrawConfig["tier"],
  { title: string; desc: string }
> = {
  fast: { title: "主力 fast", desc: "日常配图走这档：便宜、不带平台水印" },
  high: {
    title: "高质量 high",
    desc: "按张付费：画立绘、二次元、封面，或者他说「要好看点」时她才升档",
  },
  fallback: {
    title: "兜底 fallback",
    desc: "前面全栽了才轮到它：能出一张是正事",
  },
};

const DRAW_FORMAT_LABEL: Record<DrawFormat, string> = {
  "workers-ai": "Workers AI 绑定",
  siliconflow: "硅基流动",
  zhipu: "智谱",
};

/** 表单草稿：模型清单在输入框里是逗号分隔的字符串，存库时折回数组 */
interface DrawDraft {
  format: DrawFormat;
  label: string;
  endpoint: string;
  models: string;
  keySecret: string;
}

const drawDraftOf = (c: DrawConfig): DrawDraft => ({
  format: c.format,
  label: c.label,
  endpoint: c.endpoint,
  models: c.models.join(", "),
  keySecret: c.keySecret,
});

/**
 * 绘图配置面板：出图三档各一张卡，每档配「出图协议 / 标注名 / 端点 /
 * 模型降级清单 / key 变量名」，存 draw_configs（见后端 agent/drawConfigs.ts）。
 * workers-ai 档走平台 AI 绑定（neurons 计费），端点与 key 栏用不上。
 * 红线同模型/读音两套目录：key 栏填的是 secret 变量名，Key 本体永不进浏览器。
 */
export function DrawConfigsPanel() {
  const [configs, setConfigs] = useState<DrawConfig[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DrawDraft>>({});
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTier, setSavingTier] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try {
      // key 变量名候选与模型目录共用一本册子（配过的 secret 名都在那）
      const [r, catalog] = await Promise.all([
        api.drawConfigs(),
        api.modelCatalog(),
      ]);
      setConfigs(r.configs);
      setDrafts(
        Object.fromEntries(r.configs.map((c) => [c.tier, drawDraftOf(c)])),
      );
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

  const save = async (tier: DrawConfig["tier"]) => {
    const d = drafts[tier];
    if (!d) return;
    setSavingTier(tier);
    setErr("");
    setSaved("");
    try {
      await api.drawConfigPatch({
        tier,
        format: d.format,
        label: d.label.trim(),
        endpoint: d.endpoint.trim(),
        keySecret: d.keySecret.trim(),
        models: d.models
          .split(/[，,]/)
          .map((m) => m.trim())
          .filter(Boolean),
      });
      setSaved(`${DRAW_TIER_META[tier].title} 已保存`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingTier("");
    }
  };

  if (loading) return <p className="empty-sm">读取中…</p>;

  return (
    <div>
      {err && <p className="err">{err}</p>}
      {saved && <p className="meta">{saved}</p>}
      {configs.map((c) => {
        const d = drafts[c.tier];
        if (!d) return null;
        const isBinding = d.format === "workers-ai";
        const badKey = !isBinding && d.keySecret.trim().startsWith("sk-");
        return (
          <div className="panel-body" key={c.tier}>
            <div className="remind-when">
              <span style={{ fontWeight: 600 }}>
                {DRAW_TIER_META[c.tier].title}
              </span>
            </div>
            <p className="meta">{DRAW_TIER_META[c.tier].desc}</p>
            <div className="inline-form">
              <select
                className="field"
                value={d.format}
                onChange={(ev) =>
                  setDrafts({
                    ...drafts,
                    [c.tier]: { ...d, format: ev.target.value as DrawFormat },
                  })
                }
              >
                {(Object.keys(DRAW_FORMAT_LABEL) as DrawFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {DRAW_FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="标注名（画完图边上那行字）"
                value={d.label}
                onChange={(ev) =>
                  setDrafts({
                    ...drafts,
                    [c.tier]: { ...d, label: ev.target.value },
                  })
                }
              />
            </div>
            <div className="inline-form">
              <input
                className="field"
                placeholder="出图端点（workers-ai 用不上）"
                value={d.endpoint}
                disabled={isBinding}
                onChange={(ev) =>
                  setDrafts({
                    ...drafts,
                    [c.tier]: { ...d, endpoint: ev.target.value },
                  })
                }
              />
              <input
                className="field"
                placeholder="模型清单（逗号分隔，降级有序）"
                value={d.models}
                onChange={(ev) =>
                  setDrafts({
                    ...drafts,
                    [c.tier]: { ...d, models: ev.target.value },
                  })
                }
              />
            </div>
            <div className="inline-form">
              <input
                className="field"
                placeholder="key 的 secret 变量名（workers-ai 用不上）"
                value={d.keySecret}
                disabled={isBinding}
                list="draw-key-secrets"
                onChange={(ev) =>
                  setDrafts({
                    ...drafts,
                    [c.tier]: { ...d, keySecret: ev.target.value },
                  })
                }
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={savingTier === c.tier}
                onClick={() => void save(c.tier)}
              >
                {savingTier === c.tier ? "保存中…" : "保存"}
              </button>
            </div>
            {isBinding && (
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
          </div>
        );
      })}
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
 * 搜索配置面板：联网搜索只有一条主通道，配「走哪家 / 用哪把钥匙」，
 * 存 search_config（见后端 agent/searchConfigs.ts）。没配 key 时自动退化
 * 为 DuckDuckGo 免费通道，搜索工具照常能用。
 * 红线同模型/绘图/读音三套目录：key 栏填的是 secret 变量名，Key 本体永不进浏览器。
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
