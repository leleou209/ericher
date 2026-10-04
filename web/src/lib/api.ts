// Worker `/api/*` 的薄封装。
//
// 为什么不用 agents 的客户端 RPC（`agent.call()`）：那要求服务端方法带 `@callable()`
// 装饰器，而 tsconfig 的 `experimentalDecorators` 与 stage-3 装饰器冲突。所以
// 写操作走 REST（Worker 再通过 DO binding RPC 打到 agent），读实时状态走 useAgent().state。

import type {
  Attachment,
  ChatState,
  DrawConfig,
  FeedbackSummary,
  MemEntry,
  ModelEntry,
  ModelFormat,
  ModelProvider,
  MsgComment,
  Note,
  NoteMeta,
  NoteRevision,
  R2File,
  RecallHit,
  Reminder,
  SearchConfig,
  Sensitivity,
  SessionMeta,
  SessionMemoryGroup,
  Shelf,
  TagGate,
  TagStat,
  ToolCatalog,
  TtsConfig,
  TtsProtocol,
  Voice,
  VisitorEvent,
  VisitorRoom,
  GuestType,
  UserCard,
  PublicPost,
  WriteReport,
  UsageReport,
} from "./types";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
}

/**
 * 身份过期时的回调。门禁挂上它 —— 收到 401 就把人请回门口重新验证。
 *
 * 不挂的话，token 过期后界面看着还是开着的，只是每个请求都在悄悄失败：
 * 会话列表空着、面板点不动，而人不会想到「我该重新登录」，只会以为坏了。
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const text = await r.text();
  // 不是每个响应都是 JSON：网关的 502、路由没配好时回的 HTML 都会走到这里。
  // 直接 JSON.parse 的话，抛出来的是「Unexpected token <」—— 这行字谁也读不懂，
  // 而它真正想说的是「服务端没按约定回话」。
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  // 登录接口的 401 是「密码错」，不是「身份过期」—— 那种情况下人本来就在门口站着
  if (r.status === 401 && path !== "/api/auth") {
    onUnauthorized?.();
    const msg = (body as ApiErr | null)?.error || "登录已过期，请重新验证";
    throw new Error(msg);
  }
  if (!r.ok) {
    const msg =
      (body as ApiErr | null)?.error ||
      `${r.status} ${r.statusText || "请求失败"}`;
    throw new Error(msg);
  }
  if (
    body &&
    typeof body === "object" &&
    "ok" in (body as object) &&
    "data" in (body as object)
  ) {
    return (body as ApiOk<T>).data;
  }
  return body as T;
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

/**
 * 业务失败的兜底：有的端点把失败装在 200 响应里回（{ ok:false, error }），
 * req 只看 HTTP 状态，看不出这种。这里再翻一遍，翻到了就抛成异常，
 * 调用方就统一走 try/catch，不用每处都记得检查 ok 字段。
 */
function bizOk<T>(body: unknown, fallback: string): T {
  if (
    body &&
    typeof body === "object" &&
    "ok" in (body as object) &&
    (body as { ok: unknown }).ok === false
  ) {
    const e = (body as { error?: unknown }).error;
    throw new Error(typeof e === "string" && e ? e : fallback);
  }
  return body as T;
}

/** 与后端 `src/auth.ts` 的 Role 对齐：user 只能聊天，admin 才有面板与写权限 */
export type Role = "admin" | "user";

/** 登录结果：角色 + 该连哪个 DO 实例（一个实例只有一份对话，见后端 auth.ts 注释） */
interface Identity {
  ok: true;
  role: Role;
  agent: string;
}

export const api = {
  login: (pw: string) => req<Identity>("/api/auth", json("POST", { pw })),

  /** 已登录时返回当前身份；未登录抛错（401），门禁用这个判断是否已放行 */
  me: () => req<Identity>("/api/me"),

  logout: () => fetch("/api/logout", { method: "POST" }),

  // ── 配置态（任务 / 禁令 / 技能 / 联系人 / 思考模式 / 自我认知 / 人格提示词）──
  getConfig: () => req<ChatState>("/api/config"),

  /**
   * 两份可编辑提示词的出厂默认值（守则 / 回想守则），供「恢复默认」用。
   * 工具那份不在这里 —— 它拆成了逐工具的稿子，出厂稿随名册走，见 getToolGroups。
   */
  getDefaultPrompt: () => req<{ base: string; recap: string }>("/api/prompt"),

  /**
   * 工具名册：组 → 工具，两侧（主人/来客）的出厂稿与当前自定义。
   * 「工具守则」面板与「来客权限」页共用这一份（仅管理员）。
   */
  getToolGroups: () => req<ToolCatalog>("/api/tool-groups"),

  patchConfig: (patch: Partial<ChatState>) =>
    req<ChatState>("/api/config", json("POST", { patch })),

  /**
   * 调思考强度。单开一条而不是复用 patchConfig：来客也该能调强度，
   * 但 patchConfig 那道门后面还站着人格提示词和任务清单。
   * room：调哪间屋的开关。多场并行后每场各有各的强度 —— 空着 = 本人那间人屋，
   * 连在场屋上时必须点名，不然调的是人屋、眼前这场纹丝不动。
   */
  setThinkMode: (mode: "normal" | "deep", room?: string) =>
    req<ChatState>("/api/think", json("POST", { mode, room })),

  /**
   * 回答一张提问卡：他的回答会 resolve 那次挂起的 ask 工具调用，
   * 模型带着答案在同一轮工作流里接着跑。room 定参送进挂起的场屋
   * （他可能切到别的场才想起来答）；answer 空串 = 先不答。
   */
  answerAsk: (id: string, answer: string, room?: string) =>
    req<ChatState>("/api/ask/answer", json("POST", { id, answer, room })),

  // ── 记忆书架 ──
  memories: (shelf?: Shelf, includeSuperseded = false) =>
    req<MemEntry[]>(
      `/api/memory?${shelf ? `shelf=${encodeURIComponent(shelf)}&` : ""}${includeSuperseded ? "includeSuperseded=1" : ""}`,
    ),
  memoryOfPerson: (person: string, includeSuperseded = false) =>
    req<MemEntry[]>(
      `/api/memory?person=${encodeURIComponent(person)}${includeSuperseded ? "&includeSuperseded=1" : ""}`,
    ),
  /** 已作废的历史版本：不再参与检索，只供回看 */
  memoryHistory: () => req<MemEntry[]>("/api/memory/history"),
  /** 该复核的记忆：说的是现状、又有一阵没核对过的那些 */
  memoryDue: () => req<MemEntry[]>("/api/memory/due"),
  /** 还挂着疑问的记忆：写下来时发现和别的说法像在说同一件事，还没对上 */
  memoryConflicts: () => req<MemEntry[]>("/api/memory/conflicts"),
  /** 作答「这两条不是一回事」：疑问销掉，两条都留着 */
  memoryCoexist: (id: string) =>
    req<MemEntry | null>("/api/memory/coexist", json("POST", { id })),
  persons: () => req<Array<{ person: string; n: number }>>("/api/persons"),
  memoryStats: () =>
    req<Array<{ shelf: string; n: number }>>("/api/memory/stats"),
  memorySearch: (q: string, includeSuperseded = false) =>
    req<MemEntry[]>(
      `/api/memory/search?q=${encodeURIComponent(q)}${includeSuperseded ? "&includeSuperseded=1" : ""}`,
    ),
  memoryAdd: (input: {
    content: string;
    type?: string;
    shelf?: string;
    tags?: string[];
    person?: string;
    volatility?: "stable" | "volatile";
  }) => req<MemEntry>("/api/memory", json("POST", input)),
  memoryDelete: (id: string) =>
    req<boolean>("/api/memory/delete", json("POST", { id })),
  memorySupersede: (id: string, restore = false) =>
    req<MemEntry | null>(
      "/api/memory/supersede",
      json("POST", { id, restore }),
    ),
  /** 复核确认：我刚核对过，它现在还是这样（可同时改「会不会变」的标记） */
  memoryConfirm: (id: string, volatility?: "stable" | "volatile") =>
    req<MemEntry | null>(
      "/api/memory/confirm",
      json("POST", { id, volatility }),
    ),
  /** 改「会不会变」：会变的那些才会进复核清单 */
  memoryVolatility: (id: string, volatility: "stable" | "volatile") =>
    req<MemEntry | null>(
      "/api/memory/volatility",
      json("POST", { id, volatility }),
    ),

  /** 公开 / 收回一条记忆：来客那间能读到公开的那些，别的读不到 */
  memoryVisibility: (id: string, visibility: "private" | "public") =>
    req<MemEntry | null>(
      "/api/memory/visibility",
      json("POST", { id, visibility }),
    ),

  /** 改一条记忆的量级：五档都在管理员手里（绝密只有这里设得动） */
  memorySensitivity: (id: string, sensitivity: Sensitivity) =>
    req<MemEntry | null>(
      "/api/memory/sensitivity",
      json("POST", { id, sensitivity }),
    ),

  /** tag 公开门槛：开着哪几道门 + 每个 tag 各量级多少条，一次拿全 */
  tagGates: () =>
    req<{ gates: TagGate[]; stats: TagStat[] }>("/api/memory/tags"),

  /** 开 / 关一道 tag 门（maxLevel 传空串是关门），返回最新的门槛清单 */
  setTagGate: (tag: string, maxLevel: string) =>
    req<{ gates: TagGate[] }>(
      "/api/memory/tags",
      json("POST", { tag, maxLevel }),
    ),

  /**
   * 公开账本：来客能看的那一档 —— 管理员公开的人物条目 + 他这场自己登记的。
   * 只有读，没有改：写走 memoryAdd（后端按身份把它落到他自己那间）。
   */
  publicLedger: () => req<MemEntry[]>("/api/memory/public"),

  // ── 文件（R2）──
  // scope：这次清单的划界前缀（来客 = 自己房间前缀，管理员 = 桶根）。
  // 前端拼树、算「完整 key」都靠它 —— 服务器只回原料，目录是 key 里的路径
  files: () =>
    req<{ files: R2File[]; count: number; scope: string }>("/api/files"),
  mkdir: (path: string) =>
    req<{ ok: boolean; key: string }>(
      "/api/files/mkdir",
      json("POST", { path }),
    ),
  move: (from: string, to: string) =>
    req<{ ok: boolean; moved?: number }>(
      "/api/files/move",
      json("POST", { from, to }),
    ),
  deleteFile: (key: string) =>
    req<{ ok: boolean }>("/api/delete", json("POST", { key })),
  deleteFolder: (folder: string) =>
    req<{ ok: boolean; deleted?: number }>(
      "/api/delete",
      json("POST", { folder }),
    ),
  upload: (file: File, folder = "") => {
    const form = new FormData();
    form.append("file", file);
    if (folder) form.append("folder", folder);
    return req<{ key: string; name: string; type: string; size: number }>(
      "/api/upload",
      {
        method: "POST",
        body: form,
      },
    );
  },
  fileUrl: (key: string) =>
    `/api/files/${key.split("/").map(encodeURIComponent).join("/")}`,

  /**
   * 读一份刚上传的附件：服务端按类型读它（看图 / 抽 PDF 文字 / 转写录音），
   * 回一段能直接进对话的正文。读不出来也会带着一句人话回来，不抛错。
   * native：这张图前端会以原图（file part）直接放进消息 —— 服务端就不必再请
   * 视觉模型转述一遍了；只有前端没敢内联的图（太大 / 格式冷门）才走转述。
   */
  attach: (key: string, name: string, native?: boolean) =>
    req<Attachment>("/api/attach", json("POST", { key, name, native })),

  // ── 会话（元信息与消息都在后端 DO 里）──
  sessions: () => req<SessionMeta[]>("/api/sessions"),
  /**
   * 开新会话。不点名时后端只立「预备栏」不落库，返回 null ——
   * 真正的会话行要等第一句话发出后才建，免得侧栏攒下一排空会话
   */
  createSession: (title?: string, visibility?: "private" | "public") =>
    req<SessionMeta | null>(
      "/api/sessions",
      json("POST", { title, visibility }),
    ),
  /** 切换会话会把这一场的消息灌回对话，返回切换后的元信息 */
  switchSession: (id: string) =>
    req<SessionMeta | null>("/api/sessions/switch", json("POST", { id })),
  renameSession: (id: string, title: string) =>
    req<SessionMeta | null>(
      "/api/sessions/rename",
      json("POST", { id, title }),
    ),
  setSessionVisibility: (id: string, visibility: "private" | "public") =>
    req<SessionMeta | null>(
      "/api/sessions/visibility",
      json("POST", { id, visibility }),
    ),
  /** 收起 / 展开：归档只是挪个分组，内容与公开状态都不动 */
  setSessionArchived: (id: string, archived: boolean) =>
    req<SessionMeta | null>(
      "/api/sessions/archive",
      json("POST", { id, archived }),
    ),
  /** 置顶 / 取消置顶：只影响侧栏摆在哪一段，不动内容与公开状态 */
  setSessionPinned: (id: string, pinned: boolean) =>
    req<SessionMeta | null>("/api/sessions/pin", json("POST", { id, pinned })),
  deleteSession: (id: string) =>
    req<{ removed: boolean; active: string }>(
      "/api/sessions/delete",
      json("POST", { id }),
    ),
  /** 跨会话回忆：在自己全部历史会话里搜原话（仅管理员） */
  recall: (q: string) =>
    req<RecallHit[]>(`/api/recall?q=${encodeURIComponent(q)}`),

  // ── 会话记忆：他休息时回头整理出来的那些（仅管理员）──
  /**
   * 三种检索都走这一条：关键词（q）、时间（from/to）、语气（sentiment），
   * 再按场（sessionId）收窄。全都留空就是「全部，最近的在前面」。
   */
  sessionMemories: (
    q: {
      q?: string;
      sessionId?: string;
      sentiment?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return req<MemEntry[]>(`/api/session-memory${s ? `?${s}` : ""}`);
  },
  /** 左栏那一列：哪些场我回头看过、各记了几条、最后一次是几时 */
  sessionMemoryGroups: () =>
    req<SessionMemoryGroup[]>("/api/session-memory/sessions"),
  /** 叫他这会儿就看一眼。没新内容时 recap=false，那不是失败 */
  recapNow: (id: string) =>
    req<{ recap: boolean; note?: string }>(
      "/api/session-memory/recap",
      json("POST", { id }),
    ),

  // ── 笔记本：管理员和 ericher 共用的本子（仅管理员）──
  // room：本子跟着场走（每场自带资产）——连在哪间场屋上，读写的就是哪一间的本子；
  // 空着 = 本人那间人屋的本子
  notes: (q?: string, tag?: string, room?: string) =>
    req<NoteMeta[]>(
      `/api/notes?${q ? `q=${encodeURIComponent(q)}&` : ""}${tag ? `tag=${encodeURIComponent(tag)}` : ""}${room ? `room=${encodeURIComponent(room)}` : ""}`,
    ),
  readNote: (id: string, room?: string) =>
    req<Note | null>(
      `/api/notes/read?id=${encodeURIComponent(id)}${room ? `&room=${encodeURIComponent(room)}` : ""}`,
    ),
  /** 落库。不给 id 就是新建一篇。署名固定成「管理员」——写这条路只有主人走得通 */
  saveNote: (
    input: {
      id?: string;
      title?: string;
      body?: string;
      tags?: string[];
      pinned?: boolean;
    },
    room?: string,
  ) => req<Note>("/api/notes/save", json("POST", { ...input, room })),
  deleteNote: (id: string, room?: string) =>
    req<boolean>("/api/notes/delete", json("POST", { id, room })),
  /**
   * 告诉他「我翻开了哪一篇」（空串 = 合上了）。
   * 这一下不只是界面状态：他下一轮就知道你指着屏幕说的「这篇」是哪篇。
   */
  focusNote: (id: string, room?: string) =>
    req<ChatState>("/api/notes/focus", json("POST", { id, room })),
  /** 某篇的历史版本，最近的在前 —— ericher 改写过之后想退回去的时候用它 */
  noteRevisions: (id: string, room?: string) =>
    req<NoteRevision[]>(
      `/api/notes/revisions?id=${encodeURIComponent(id)}${room ? `&room=${encodeURIComponent(room)}` : ""}`,
    ),
  restoreNote: (id: string, seq: number, room?: string) =>
    req<Note | null>("/api/notes/restore", json("POST", { id, seq, room })),

  // ── 提醒（主动能力：到点 ericher 自己回来找你）──
  reminders: () => req<Reminder[]>("/api/reminders"),
  cancelReminder: (id: string) =>
    req<boolean>("/api/reminders/cancel", json("POST", { id })),

  /** 他主动开口的账：今天说了几次、现在是不是安静时段 */
  proactive: () => req<{ today: number; quietNow: boolean }>("/api/proactive"),

  // ── 来客留痕 ──
  /** 名册：谁来过、最近一次什么时候（仅管理员） */
  visitors: () => req<VisitorRoom[]>("/api/visitors"),
  /** 某位来客的留痕明细，新的在前（仅管理员） */
  visitorEventsOf: (room: string) =>
    req<VisitorEvent[]>(
      `/api/visitors/events?room=${encodeURIComponent(room)}`,
    ),
  /**
   * 进门介绍页的落点：报称呼 / 来历，两个字段都可空、整个表单可跳过。
   * 报了称呼后端会记进他自己那间屋子的 state，往后的留痕跟着称呼走。
   */
  guestIntro: (input: { nickname?: string; origin?: string }) =>
    req<{ guestName: string }>("/api/guest-intro", json("POST", input)),

  // ── 身份卡（长期使用者；见后端 userCards.ts）──
  /** 登卡：凭「昵称 + 密码」回到卡绑定的那间屋。不需要门禁码 —— 卡本身就是钥匙 */
  cardLogin: (input: { name: string; password: string }) =>
    req<Identity & { card: UserCard }>("/api/card/login", json("POST", input)),
  /** 领卡 / 把当前临时会话升级成长期。业务错误（重名等）原样抛人话 */
  cardCreate: (input: {
    name: string;
    purpose: string;
    password: string;
    email?: string;
  }) => req<Identity & { card: UserCard }>("/api/card", json("POST", input)),
  /** 当前登录的人有没有卡：无卡（临时票 / 管理员）返回 null */
  cardInfo: () => req<{ ok: true; card: UserCard | null }>("/api/card"),
  /** 解卡：回到同类型的临时身份，房间回到派生房 */
  cardDetach: () => req<Identity>("/api/card/detach", json("POST", {})),
  /** 持卡人名册：昵称、来意、邮箱、最近活跃（仅管理员） */
  cards: () => req<UserCard[]>("/api/cards"),

  // ── 公开墙（permPublic 持卡者贴纸条的地方；见后端 publicPosts.ts）──
  /** 读墙：进门的人谁都看得到（新的在前） */
  posts: () => req<PublicPost[]>("/api/posts"),
  /** 贴一条上墙：后端署名用卡的昵称快照，业务错误原样抛人话 */
  postAdd: (content: string) =>
    req<PublicPost>("/api/posts", json("POST", { content })),
  /** 摘一条：管理员摘任意；持卡者只摘得动自己贴的 */
  postDel: (id: string) =>
    req<{ ok: true }>("/api/posts", json("DELETE", { id })),

  // ── 来客类型（一个口令一类来客，权限按类型裁剪；仅管理员）──
  guestTypes: () => req<GuestType[]>("/api/guest-types"),
  guestTypeAdd: (input: {
    name: string;
    password: string;
    note?: string;
    /** 对外工具的逐件权益；不给时后端按旧开关/缺省推平 */
    tools?: string[];
    permNotes?: boolean;
    permFiles?: boolean;
    permPublic?: boolean;
  }) => req<GuestType>("/api/guest-types", json("POST", input)),
  guestTypePatch: (input: {
    id: string;
    name?: string;
    password?: string;
    note?: string;
    tools?: string[];
    permNotes?: boolean;
    permFiles?: boolean;
    permPublic?: boolean;
    active?: boolean;
  }) => req<GuestType>("/api/guest-types", json("PATCH", input)),
  guestTypeDelete: (id: string) =>
    req<{ ok: boolean }>(`/api/guest-types?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // ── 版本与更新检查 ──
  /** 拿本地版本号去对开源仓库的版本号（提交对不上号是攒批推送的常态，不作数）；
   *  latest 是对方 main 的版本号与最新一笔提交 */
  updateCheck: async () =>
    bizOk<{
      upToDate: boolean;
      latest: {
        version: string;
        hash: string;
        message: string;
        date: string;
      } | null;
    }>(await req<unknown>("/api/update-check"), "检查更新失败"),

  // ── 模型目录（供应商 + 模型条目两级；仅管理员）──
  /**
   * keySecrets 是这台机器已配置的 secret 名（wrangler secret put 过的那些），
   * 供表单下拉挑选 —— 配没配过一眼就知道。数组做兜底：形状没对上就当空。
   */
  modelCatalog: async (): Promise<{
    providers: ModelProvider[];
    entries: ModelEntry[];
    keySecrets: string[];
  }> => {
    const r = bizOk<{
      providers?: ModelProvider[];
      entries?: ModelEntry[];
      keySecrets?: string[];
    }>(await req<unknown>("/api/model-configs"), "读取模型目录失败");
    return {
      providers: Array.isArray(r?.providers) ? r.providers : [],
      entries: Array.isArray(r?.entries) ? r.entries : [],
      keySecrets: Array.isArray(r?.keySecrets) ? r.keySecrets : [],
    };
  },
  /** 新建一家供应商。firstModel 给了就顺手挂上首个模型条目 */
  modelProviderAdd: async (input: {
    name: string;
    format: ModelFormat;
    baseUrl: string;
    keySecret: string;
    maintKeySecret?: string;
    maintModel?: string;
    firstModel?: string;
    maxOutput?: number;
  }) =>
    bizOk<{ provider: ModelProvider; entry: ModelEntry | null }>(
      await req<unknown>("/api/model-configs/providers", json("POST", input)),
      "保存供应商失败",
    ),
  modelProviderPatch: async (
    input: Partial<Omit<ModelProvider, "id" | "created">> & { id: string },
  ) =>
    bizOk<ModelProvider>(
      await req<unknown>("/api/model-configs/providers", json("PATCH", input)),
      "保存供应商失败",
    ),
  modelProviderDelete: (id: string) =>
    req<{ ok: boolean }>(
      `/api/model-configs/providers?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  modelEntryAdd: async (input: {
    providerId: string;
    model: string;
    maxOutput?: number;
    contextWindow?: number;
  }) =>
    bizOk<ModelEntry>(
      await req<unknown>("/api/model-configs/entries", json("POST", input)),
      "添加模型失败",
    ),
  /** 含 { id, active: true } = 指派为普通模式的模型（回复风格页的指派就走这里） */
  modelEntryPatch: async (
    input: Partial<
      Pick<ModelEntry, "model" | "maxOutput" | "contextWindow" | "active">
    > & {
      id: string;
    },
  ) =>
    bizOk<ModelEntry>(
      await req<unknown>("/api/model-configs/entries", json("PATCH", input)),
      "保存模型失败",
    ),
  modelEntryDelete: (id: string) =>
    req<{ ok: boolean }>(
      `/api/model-configs/entries?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** 让服务端去问那家「你有哪些模型」。失败把后端的 error 原样带回（面板就地显示） */
  modelListModels: async (input: {
    format: ModelFormat;
    baseUrl: string;
    keySecret: string;
    /** 厂商预设里核实过的列表端点：给了就用它，不再从 format+baseUrl 拼 */
    listUrl?: string;
    listAuth?: "bearer" | "x-api-key";
  }): Promise<{ models: Array<{ id: string; name?: string }> }> => {
    const r = bizOk<{ models?: Array<{ id: string; name?: string }> }>(
      await req<unknown>("/api/model-configs/list-models", json("POST", input)),
      "拉取模型列表失败",
    );
    return { models: Array.isArray(r?.models) ? r.models : [] };
  },

  // ── 读音配置（一条就是一副可用嗓子；仅管理员）──
  /**
   * 响应根键名对两种可能都宽容：以后端实际回 tts 还是 configs 为准，统一归成 tts 数组。
   */
  ttsConfigs: async (): Promise<{ tts: TtsConfig[]; keySecrets: string[] }> => {
    const r = bizOk<{
      tts?: TtsConfig[];
      configs?: TtsConfig[];
      keySecrets?: string[];
    }>(await req<unknown>("/api/tts-configs"), "读取读音配置失败");
    return {
      tts: Array.isArray(r?.tts)
        ? r.tts
        : Array.isArray(r?.configs)
          ? r.configs
          : [],
      keySecrets: Array.isArray(r?.keySecrets) ? r.keySecrets : [],
    };
  },
  ttsConfigAdd: async (input: {
    name: string;
    protocol: TtsProtocol;
    baseUrl: string;
    keySecret: string;
    model: string;
    voice?: string;
    style?: string;
  }) =>
    bizOk<TtsConfig>(
      await req<unknown>("/api/tts-configs", json("POST", input)),
      "保存读音配置失败",
    ),
  ttsConfigPatch: async (
    input: Partial<Omit<TtsConfig, "id">> & { id: string },
  ) =>
    bizOk<TtsConfig>(
      await req<unknown>("/api/tts-configs", json("PATCH", input)),
      "保存读音配置失败",
    ),
  ttsConfigDelete: (id: string) =>
    req<{ ok: boolean }>(`/api/tts-configs?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // ── 绘图配置（出图三档各用哪家；仅管理员）──
  drawConfigs: async (): Promise<{
    configs: DrawConfig[];
    keySecrets: string[];
  }> => {
    const r = bizOk<{
      configs?: DrawConfig[];
      keySecrets?: string[];
    }>(await req<unknown>("/api/draw-configs"), "读取绘图配置失败");
    return {
      configs: Array.isArray(r?.configs) ? r.configs : [],
      keySecrets: Array.isArray(r?.keySecrets) ? r.keySecrets : [],
    };
  },
  drawConfigPatch: async (
    input: Partial<Omit<DrawConfig, "tier">> & { tier: DrawConfig["tier"] },
  ) =>
    bizOk<DrawConfig>(
      await req<unknown>("/api/draw-configs", json("PATCH", input)),
      "保存绘图配置失败",
    ),

  // ── 搜索配置（联网搜索走哪家、用哪把钥匙；仅管理员）──
  searchConfig: async (): Promise<{
    config: SearchConfig;
    keySecrets: string[];
  }> => {
    const r = bizOk<{
      config?: SearchConfig;
      keySecrets?: string[];
    }>(await req<unknown>("/api/search-configs"), "读取搜索配置失败");
    return {
      config: r?.config ?? { format: "tavily", keySecret: "" },
      keySecrets: Array.isArray(r?.keySecrets) ? r.keySecrets : [],
    };
  },
  searchConfigPatch: (input: Partial<SearchConfig>) =>
    bizOk<SearchConfig>(
      req<unknown>("/api/search-configs", json("PATCH", input)),
      "保存搜索配置失败",
    ),

  /** 今日写额度：谁在吃那 10 万行 */
  writes: () => req<WriteReport>("/api/writes"),
  /** 额度总览：SQL 读写 + AI neurons + Vectorize + 官方校准 */
  usage: () => req<UsageReport>("/api/usage"),

  // ── 朗读 ──
  /**
   * 这台机器上有哪些嗓子、每一副现在能不能用。
   * 注意：用不上的也会列出来（标灰 + 写明缺哪把钥匙），不再由服务端悄悄滤掉。
   */
  voices: () =>
    req<{ voices: Voice[]; cloud: boolean; defaultVoice: string }>(
      "/api/voices",
    ),
  /**
   * 取一段话的音频。
   *
   * 不走 req：req 按 JSON 解析，而这里回的是音频字节。
   * 拿不到音频时把服务端说的原因一起带回来（没配 key / 余额不足 / 限流）——
   * 只说「念不了」的话，人只会一直听着那个难听的嗓子，却不知道该去修什么。
   */
  tts: async (
    text: string,
    voice: string,
  ): Promise<{ blob: Blob } | { why: string }> => {
    try {
      const r = await fetch("/api/tts", json("POST", { text, voice }));
      if (r.ok) return { blob: await r.blob() };
      const j = (await r.json().catch(() => null)) as { why?: unknown } | null;
      return {
        why: typeof j?.why === "string" && j.why ? j.why : "云端这会儿不通",
      };
    } catch {
      return { why: "没连上网络" };
    }
  },

  // ── 动作 ──
  organize: () => req<string>("/api/organize", { method: "POST" }),
  /**
   * 打断：把这一轮正在生成的回答停下来（服务端那一轮，客户端自己也会断）。
   * room：正在说话的那间屋 —— REST 没有连接语义，多场并行后连接可能挂在场屋上，
   * 不点名就会去人屋里找一场没人说话的对话干着急。
   */
  stop: (room?: string) => req<boolean>("/api/stop", json("POST", { room })),
  clear: () => req<{ ok: boolean }>("/api/clear", { method: "POST" }),

  // ── 消息反馈（赞 / 踩 / 评论）──
  // room：反馈跟着场走。消息实际住在一场一间的场屋里，连接挂在场屋上；不带 room
  // 的话后端会落到人屋，徽标永远 0、点了也没反应。空着 = 本人那间人屋。
  feedback: (room?: string) =>
    req<FeedbackSummary>(
      `/api/feedback${room ? `?room=${encodeURIComponent(room)}` : ""}`,
    ),
  /** 同值再投 = 取消；返回生效后的票值，null 表示已取消 */
  vote: (messageId: string, value: 1 | -1, room?: string) =>
    req<{ value: number | null }>(
      "/api/vote",
      json("POST", { messageId, value, room }),
    ),
  comments: (messageId: string, room?: string) =>
    req<MsgComment[]>(
      `/api/comment?messageId=${encodeURIComponent(messageId)}${room ? `&room=${encodeURIComponent(room)}` : ""}`,
    ),
  comment: (messageId: string, content: string, room?: string) =>
    req<MsgComment>("/api/comment", json("POST", { messageId, content, room })),
  /** 标重开关：给管理员自己的发言打「要重视」的标记，再点一次取消 */
  flag: (messageId: string, room?: string) =>
    req<{ flagged: boolean }>("/api/flag", json("POST", { messageId, room })),
};
