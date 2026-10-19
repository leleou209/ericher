import { request as req, requestResponse, json, assertApiSuccess as bizOk, ApiError } from "./http";
// Worker `/api/*` 的薄封装。
// 不用 agents 的客户端 RPC：它要求服务端方法带 @callable()，而 tsconfig 的
// experimentalDecorators 与 stage-3 冲突。写操作走 REST，读实时状态走 useAgent().state。

import type {
  Attachment,
  ChatState,
  DrawConfig,
  FeedbackSummary,
  MailConfigPatch,
  MailConfigView,
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
  SessionTask,
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
  MatrixPage,
  MatrixPages,
  MatrixPageDetail,
  MatrixPackResult,
  MatrixLink,
  MatrixLinks,
  MatrixNav,
  MatrixStat,
  MatrixTheme,
  MatrixSites,
  ApprovedSite,
  LinkPlace,
} from "./types";
import { defaultTheme, type ThemeConfig, type ThemeConfigPatch, type ThemeSet } from "./theme";

export { setUnauthorizedHandler } from "./http";

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
  me: (signal?: AbortSignal) => req<Identity>("/api/me", { signal }),

  logout: () => fetch("/api/logout", { method: "POST" }),

  // ── 配置态（任务 / 禁令 / 技能 / 联系人 / 思考模式 / 自我认知 / 人格提示词）──
  getConfig: () => req<ChatState>("/api/config"),

  /**
   * 两份可编辑提示词的出厂默认（守则 / 回想守则），供「恢复默认」用。
   * 工具那份不在这里 —— 它逐工具拆分，出厂稿随名册走（见 getToolGroups）。
   */
  getDefaultPrompt: () => req<{ base: string; recap: string }>("/api/prompt"),

  /**
   * 工具名册：组 → 工具，两侧（主人/来客）的出厂稿与当前自定义。
   * 「工具守则」与「来客权限」页共用（仅管理员）。
   */
  getToolGroups: () => req<ToolCatalog>("/api/tool-groups"),

  patchConfig: (patch: Partial<ChatState>) =>
    req<ChatState>("/api/config", json("POST", { patch })),

  /**
   * 调思考强度（每场一份）。单开一条是因为来客也该能调，而 patchConfig 那道门后面
   * 还站着人格提示词与任务清单。room：不点名调的是人屋，连在场屋时必须点名。
   */
  setThinkMode: (mode: "normal" | "deep", room?: string) =>
    req<ChatState>("/api/think", json("POST", { mode, room })),

  /**
   * 回答提问卡：resolve 挂起的 ask 工具，模型带着答案在同一轮里接着跑。
   * room 送进挂起的场屋（他可能已切走）；answer 空串 = 先不答。
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
   * 公开账本：管理员公开的人物条目 + 他这场自己登记的（仅读）。
   * 写走 memoryAdd，后端按身份落到他自己那间。
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
  upload: (file: File, folder = "", signal?: AbortSignal) => {
    const form = new FormData();
    form.append("file", file);
    if (folder) form.append("folder", folder);
    return req<{ key: string; name: string; type: string; size: number }>(
      "/api/upload",
      {
        method: "POST",
        body: form,
        signal,
      },
    );
  },
  fileUrl: (key: string) =>
    `/api/files/${key.split("/").map(encodeURIComponent).join("/")}`,

  /**
   * 读刚上传的附件（看图 / 抽 PDF / 转写录音），回一段可直接进对话的正文；
   * 读不出来也带一句人话回来，不抛错。native：图由前端以原图放进消息，
   * 服务端不必再请视觉模型转述（只有太大 / 格式冷门的图才走转述）。
   */
  attach: (key: string, name: string, native?: boolean, signal?: AbortSignal) =>
    req<Attachment>("/api/attach", { ...json("POST", { key, name, native }), signal }),

  // ── 会话（元信息与消息都在后端 DO 里）──
  sessions: () => req<SessionMeta[]>("/api/sessions"),
  /**
   * 开新会话。不点名时后端只立「预备栏」不落库并回 null ——
   * 真正的会话行等第一句话发出后才建，免得侧栏攒一排空会话。
   */
  createSession: (title?: string, visibility?: "private" | "public") =>
    req<SessionMeta | null>(
      "/api/sessions",
      json("POST", { title, visibility }),
    ),
  /** 切换会话会把这一场的消息灌回对话，返回切换后的元信息 */
  switchSession: (id: string) =>
    req<SessionMeta | null>("/api/sessions/switch", json("POST", { id })),
  /**
   * 记「最后看的是哪间屋、哪一场」（多端对齐）。写口恒落人屋，连场屋时也能发。
   * at 默认此刻；后端只收更晚的那笔，所以要在人真操作的那一瞬打戳。
   */
  setActiveRoom: (room: string, session: string, at = Date.now()) =>
    req<ChatState>("/api/active-room", json("POST", { room, session, at })),
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
   * 三种检索都走这条：关键词 q、时间 from/to、语气 sentiment，可按场收窄。
   * 全空 = 全部，最近的在前面。
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
  // room：本子跟着场走 —— 连在哪间场屋，读写的就是哪间的本子；空着 = 人屋
  notes: (q?: string, tag?: string, room?: string) => {
    // 用 URLSearchParams 拼参：手拼时 q 空、tag+room 同时有值会漏掉 &
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (tag) p.set("tag", tag);
    if (room) p.set("room", room);
    const s = p.toString();
    return req<NoteMeta[]>(`/api/notes${s ? `?${s}` : ""}`);
  },
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
   * 告诉他「我翻开了哪一篇」（空串 = 合上）。不只是界面状态：
   * 他下一轮就知道你说的「这篇」是哪篇。
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

  // ── 本场计划：这一场的目标与步骤（仅管理员）──
  // 与提醒不同：提醒是会话外、到点响；这里只管把这一场要干什么钉在眼前，不排期。
  // room + session 都要：一间屋能装好几场，老场都住在人屋。
  sessionPlan: (room: string, session: string) =>
    req<{ goal: string; tasks: SessionTask[] }>(
      `/api/session-plan?room=${encodeURIComponent(room)}&session=${encodeURIComponent(session)}`,
    ),
  /** 写本场计划：只传要改的那一格（goal / tasks），没传的那格原样不动 */
  saveSessionPlan: (input: {
    room: string;
    session: string;
    goal?: string;
    tasks?: SessionTask[];
  }) =>
    req<{ goal: string; tasks: SessionTask[] }>(
      "/api/session-plan",
      json("POST", input),
    ),

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
   * 进门介绍页的落点：称呼 / 来历都可空、整个表单可跳过。
   * 报了称呼后端会记进他那间屋，往后的留痕跟着称呼走。
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
    permMatrix?: boolean;
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
    permMatrix?: boolean;
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

  // ── 网页矩阵 ──
  /**
   * 一次性总览：版本 / 构建 / 云盘 / 矩阵规模 / 外观开关。
   * 设置页状态卡与工作台头部用它；未登录时抛错，调用方自己降级。
   */
  matrixStat: async () =>
    bizOk<MatrixStat>(
      await req<unknown>("/api/matrix/stat"),
      "读取网页矩阵运行状态失败",
    ),
  /** 全部矩阵页（层级树按 path 拼）与配置版本 */
  matrixPages: async () =>
    bizOk<MatrixPages>(
      await req<unknown>("/api/matrix/pages"),
      "读取网页矩阵页面失败",
    ),
  /** 单页正文：编辑时取回原件 */
  matrixPage: async (id: string) =>
    bizOk<MatrixPageDetail>(
      await req<unknown>(`/api/matrix/page?id=${encodeURIComponent(id)}`),
      "读取页面失败",
    ),
  /**
   * 新建 / 保存一页。FormData：meta（JSON）必有；正文三选一 ——
   * file / text / key（云盘）。外链不出正文；编辑不带正文时沿用原正文。
   */
  matrixSave: async (form: FormData) =>
    bizOk<{ page: MatrixPage }>(
      await req<unknown>("/api/matrix/save", { method: "POST", body: form }),
      "保存页面失败",
    ),
  matrixDelete: async (id: string) =>
    bizOk<{ id: string }>(
      await req<unknown>("/api/matrix/delete", json("POST", { id })),
      "删除页面失败",
    ),
  /** 全局悬浮菜单开关：所有页面统一挂的那个左上角浮窗 */
  matrixNav: async (on: boolean) =>
    bizOk<{ nav: MatrixNav }>(
      await req<unknown>("/api/matrix/nav", json("POST", { on })),
      "保存悬浮菜单设置失败",
    ),
  /** 全局外观：注入物的主色与按钮形态（整份覆盖） */
  matrixTheme: async (theme: MatrixTheme) =>
    bizOk<{ theme: MatrixTheme }>(
      await req<unknown>("/api/matrix/theme", json("POST", theme)),
      "保存矩阵外观失败",
    ),
  /** 外站认定表：列在表里的域名才允许从内站过去（整份覆盖） */
  matrixSites: async () =>
    bizOk<MatrixSites>(
      await req<unknown>("/api/matrix/sites"),
      "读取外站认定表失败",
    ),
  matrixSaveSites: async (sites: ApprovedSite[]) =>
    bizOk<MatrixSites>(
      await req<unknown>("/api/matrix/sites", json("POST", { sites })),
      "保存外站认定表失败",
    ),
  /** 全部通路（页面之间的有向连线；页面 = 节点，按钮 = 边） */
  matrixLinks: async () =>
    bizOk<MatrixLinks>(
      await req<unknown>("/api/matrix/links"),
      "读取网页矩阵通路失败",
    ),
  /**
   * 新建 / 改一条通路。后端按 (from,to) upsert：同一对只留一条，
   * 改文字或落点就是拿同一对再发一次。
   */
  matrixLink: async (input: {
    from: string;
    to: string;
    label?: string;
    place?: LinkPlace;
    order?: number;
  }) =>
    bizOk<{ link: MatrixLink }>(
      await req<unknown>("/api/matrix/link", json("POST", input)),
      "连线失败",
    ),
  /** 断开一条通路；不存在也算成功（幂等） */
  matrixUnlink: async (from: string, to: string) =>
    bizOk<unknown>(
      await req<unknown>("/api/matrix/unlink", json("POST", { from, to })),
      "断开通路失败",
    ),
  /**
   * 导出整套矩阵为 zip。不走 req（那条路只认 JSON，这里是二进制流）。
   * 失败时后端回 JSON（{ok:false,error}）。missing 是「有页、正文却没进包」的路径，
   * 这种包装不回来，导出时得当场知道。
   */
  matrixPackExport: async (): Promise<{ blob: Blob; missing: string[] }> => {
    const r = await requestResponse("/api/matrix/pack");
    const raw = r.headers.get("X-Matrix-Pack-Missing-Paths") || "";
    let missing: string[] = [];
    if (raw) {
      try {
        missing = decodeURIComponent(raw).split(",").filter(Boolean);
      } catch {
        /* 头坏了就当没有 —— 不因为一条说明把导出整件事作废 */
      }
    }
    return { blob: await r.blob(), missing };
  },
  /**
   * 装备矩阵包：**整体替换**线上那套（旧正文与旧配置全换）。
   * 后端动手前会留一份底，装错了能回滚。
   */
  matrixPackEquip: async (file: File) =>
    bizOk<MatrixPackResult>(
      await req<unknown>("/api/matrix/pack", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      }),
      "装备矩阵包失败",
    ),
  /** 回滚：把上一次装备前的留底再装回去（同样整体替换） */
  matrixPackRollback: async () =>
    bizOk<MatrixPackResult>(
      await req<unknown>("/api/matrix/pack/rollback", { method: "POST" }),
      "回滚失败",
    ),

  // ── 模型目录（供应商 + 模型条目两级；仅管理员）──
  /**
   * keySecrets 是这台机器已配的 secret 名（wrangler secret put 过的），
   * 供表单下拉挑选 —— 配没配过一眼就知道。形状没对上就当空。
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

  // ── 邮件（SMTP 发信账号；仅管理员）──
  /** 读这一份配置：keyAvailable 与 lastSend 是后端算出来的只读事实 */
  mailConfig: () => req<MailConfigView>("/api/mail/config"),
  /**
   * 保存那九格可写字段。请求体里没有口令 —— 口令住在 keySecret 所指的
   * Worker secret 里，浏览器从来没见过它。
   */
  mailConfigSave: (patch: MailConfigPatch) =>
    req<MailConfigView>("/api/mail/config", json("POST", patch)),
  /**
   * 发一封测试邮件；to 不给就寄到配置里的默认地址。
   * 失败是 200 里的 {ok:false,error}，req() 会抛成 ApiError —— 落定即真发出去了，
   * 调用方接住原话显示，别当成功。
   */
  mailTest: (to?: string) =>
    req<{ ok: true }>("/api/mail/test", json("POST", { to })),
  // 人亲自动笔那一封：契约同 mailTest —— {ok:true} / {ok:false,error}，
  // 失败那句是后端原话（req 会把它抛成 ApiError，界面整段显示，不截不改写）
  mailSend: (job: { to?: string; subject: string; text: string }) =>
    req<{ ok: true }>("/api/mail/send", json("POST", job)),

  // ── 主题（门面装点；读是免鉴权的，写只有管理员）──
  themeGet: async (): Promise<ThemeConfig> => {
    const r = bizOk<{ theme?: ThemeConfig }>(
      await req<unknown>("/api/theme"),
      "读取主题失败",
    );
    return r?.theme ?? defaultTheme();
  },
  // 注意：PATCH 走 writeState，回执是 {ok, data: ThemeConfig}，
  // req() 解包后拿到的是裸 ThemeConfig（不是 {theme}），别再套一层。
  themePatch: (input: ThemeConfigPatch) =>
    bizOk<ThemeConfig>(
      req<unknown>("/api/theme", json("PATCH", input)),
      "保存主题失败",
    ),
  /** 传一张素材（背景/头像/弹页图/花纹/图标）；同名重传就是换图 */
  themeUploadAsset: (name: string, bytes: Blob) =>
    bizOk<{ ref: string; size: number }>(
      req<unknown>(
        `/api/theme/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", body: bytes },
      ),
      "上传素材失败",
    ),
  /**
   * 从云盘导一张图进主题公开区：服务端复制一份（原文件不动），
   * 回来还是 `asset:<文件名>` 引用，和直接上传一个口径。
   */
  themeImportDrive: (key: string) =>
    bizOk<{ ref: string; size: number }>(
      req<unknown>("/api/theme/import", json("POST", { key })),
      "从云盘导入失败",
    ),
  /**
   * 一键装备主题包（zip）：theme.json 清单 + assets/。
   * 服务端会把包留一份进云盘 betpag 文件夹，回来带归档 key。
   */
  themeEquipPack: (bytes: Blob, name?: string) =>
    bizOk<{ theme: ThemeConfig; assets: number; driveKey: string }>(
      req<unknown>(
        `/api/theme/pack${name ? `?name=${encodeURIComponent(name)}` : ""}`,
        { method: "POST", body: bytes },
      ),
      "装备主题包失败",
    ),
  /** 导出当前主题包（zip 下载） */
  themeExportPack: async (): Promise<Blob> => {
    const r = await requestResponse("/api/theme/pack");
    return r.blob();
  },

  // ── 自定义主题存档（把当前整份配置存成一份带名字的档）──
  /** 列全部存档，新的在前 */
  themeSets: async () =>
    bizOk<{ sets: ThemeSet[] }>(
      await req<unknown>("/api/theme/sets"),
      "读取自定义主题失败",
    ),
  /** 把当前主题存成一份档（含素材的整包） */
  themeSaveSet: async (name: string) =>
    bizOk<{ set: ThemeSet; sets: ThemeSet[] }>(
      await req<unknown>("/api/theme/sets", json("POST", { name })),
      "存档主题失败",
    ),
  /** 换回某份存档：整份替换当前主题 */
  themeApplySet: async (id: string) =>
    bizOk<{ theme: ThemeConfig; assets: number; set: ThemeSet }>(
      await req<unknown>("/api/theme/sets/apply", json("POST", { id })),
      "换装自定义主题失败",
    ),
  /** 删一份存档（云盘里的包体一并清走） */
  themeDeleteSet: async (id: string) =>
    bizOk<{ sets: ThemeSet[] }>(
      await req<unknown>("/api/theme/sets/delete", json("POST", { id })),
      "删除自定义主题失败",
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
   * 取一段话的音频。不走 req（它按 JSON 解析，这里回音频字节）。
   * 拿不到时把服务端的原因带回来（没配 key / 余额不足 / 限流），否则人不知道该修什么。
   */
  tts: async (
    text: string,
    voice: string,
  ): Promise<{ blob: Blob } | { why: string }> => {
    try {
      const r = await requestResponse("/api/tts", json("POST", { text, voice }));
      return { blob: await r.blob() };
    } catch (error) {
      return { why: error instanceof ApiError ? error.message : "没连上网络" };
    }
  },

  // ── 动作 ──
  organize: () => req<string>("/api/organize", { method: "POST" }),
  /**
   * 打断这一轮生成（服务端那一轮；客户端也会断）。
   * room：正在说话的那间屋 —— REST 没有连接语义，不点名会去人屋找。
   */
  stop: (room?: string) => req<boolean>("/api/stop", json("POST", { room })),
  /**
   * 清空「当前这场」的消息与摘要。room 点名哪间屋 —— 场屋不挂在人屋上，
   * 不点名清的会是人的那场。不带 = 人屋。
   */
  clear: (room?: string) =>
    req<{ ok: boolean }>("/api/clear", json("POST", { room })),

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
