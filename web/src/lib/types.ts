// 后端 src/agent/state.ts 的镜像类型。
// 不 import 后端：会把 Workers 全局类型带进浏览器侧；字段若变，两边一起改。

export const SHELVES = [
  "identity",
  "people",
  "projects",
  "knowledge",
  "patterns",
  "events",
  "reflections",
  "archive",
  "sessions",
] as const;

export type Shelf = (typeof SHELVES)[number];

export const SHELF_LABEL: Record<Shelf, string> = {
  identity: "身份",
  people: "人物",
  projects: "项目",
  knowledge: "知识",
  patterns: "模式",
  events: "事件",
  reflections: "反思",
  archive: "归档",
  sessions: "会话",
};

/** 一段话的语气，与后端 state.ts 的 SENTIMENTS 一一对应；只留六个，再多分不清 */
export const SENTIMENTS = [
  "calm",
  "warm",
  "low",
  "tense",
  "bright",
  "tired",
] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  calm: "平静",
  warm: "温软",
  low: "有点低",
  tense: "绷着",
  bright: "亮堂",
  tired: "乏",
};

/** 会话记忆左栏的一行：哪一场、记了几条、最后一次是什么时候 */
export interface SessionMemoryGroup {
  sessionId: string;
  title: string;
  n: number;
  last: string;
}

export interface MemEntry {
  id: string;
  date: string;
  type: string;
  tags: string[];
  weight: number;
  shelf: string;
  /** 归属人物（人脉视图用）；空串表示不属于任何具体的人 */
  person: string;
  /** 能不能给来客看。private = 只在我和管理员之间用；public = 管理员特意点了头的那几条 */
  visibility: "private" | "public";
  /** 显式收回：管理员手动的「不公开」压过 tag 门，只听公开/收回按钮 */
  hold?: boolean;
  content: string;
  accessed: number;
  /** 学到这条记忆的时刻（ISO）；和 date 不是一回事 */
  learned: string;
  /** 非空表示已被作废（值为替代它的记忆 id 或 retired）；空串表示还算数 */
  supersededBy: string;
  /** 会变（关于现状，会过期）还是稳定（关于他是谁，一直成立） */
  volatility: "stable" | "volatile";
  /** 上次被确认「现在还是这样」的时刻（ISO）；空串 = 从没确认过 */
  verified: string;
  /** 这件事从什么时候开始成立（ISO）。默认等于 learned */
  validAt: string;
  /** 到什么时候不再成立（ISO）；空串 = 到现在还算数 */
  invalidAt: string;
  /** 还没对上的那几条（记忆 id）：像在说同一件事，还没弄明白哪个算数 */
  conflictsWith: string[];
  /** 书册的标题（type=book 时有值）；条目和图像是空串 */
  title: string;
  /** 图像记忆指向的云盘文件 key（type=image 时有值），面板拿它把原图显示出来 */
  fileKey: string;
  /** 这条挂在哪一场对话上（会话记忆才有值）；空串表示它不属于任何一场 */
  sessionId: string;
  /** 这一段的语气（会话记忆才有值，见 SENTIMENTS）；空串 = 没标 */
  sentiment: string;
  /** 量级：这条事知道的人该有多少。AI 写入时按评分公式标，管理员可在这里改 */
  sensitivity: Sensitivity;
  /** 量级的评分依据（0-9 = AI 算的分；10 = 管理员亲手设的绝密） */
  score: number;
}

/** 记忆的量级，从轻到重五档（后端 state.ts 同款） */
export const SENSITIVITIES = [
  "trivial",
  "normal",
  "important",
  "secret",
  "topsecret",
] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  trivial: "不重要",
  normal: "一般",
  important: "重要",
  secret: "机密",
  topsecret: "绝密",
};

/** tag 公开门槛的档位：到机密为止 —— 绝密没有出门这条路 */
export const TAG_GATE_LEVELS = [
  "trivial",
  "normal",
  "important",
  "secret",
] as const;

/** 一道开着的 tag 门：带这个 tag、量级不超过 maxLevel 的记忆，来客读得到 */
export interface TagGate {
  tag: string;
  maxLevel: string;
}

/** 一个 tag 的分布：几条、各量级多少 */
export interface TagStat {
  tag: string;
  n: number;
  trivial: number;
  normal: number;
  important: number;
  secret: number;
  topsecret: number;
}

export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  title: string;
  desc: string;
  status: TaskStatus;
  created: string;
}

/** 本场步骤：字段同 Task，但只属于当前这场（后端存 session_tasks 表） */
export interface SessionTask {
  title: string;
  desc: string;
  status: TaskStatus;
  created: string;
}

export interface ToolStat {
  tool: string;
  count: number;
  ok: number;
  fail: number;
  totalMs: number;
  lastTs: number;
}

export interface Summary {
  ts: string;
  summary: string;
  msgCount: number;
}

/** 他正等你回答的问题（ask 工具写入）；答完卡片消失，答案作为普通消息留在对话流 */
export interface AskEntry {
  id: string;
  /** 他问的那句话 */
  text: string;
  /** 他给的候选（可空）。给了选项也允许自己写 */
  options: string[];
  /** 他为什么问 —— 答的人该知道这个答案会被拿去做哪一步 */
  why: string;
  askedAt: string;
  /** 归在哪一场：换了一场话题就不该还看见上一场的追问 */
  sessionId: string;
}

export interface ChatState {
  selfModel: string;
  selfModelVer: number;
  selfLog: string[];
  /** 他给自己定的要求（由他自己用 self 工具写）；空串 = 还没写过 */
  selfDemand: string;
  selfDemandVer: number;
  selfDemandLog: string[];
  /** 管理员自定义的人格提示词；为空表示用内置默认 */
  basePrompt: string;
  /** 工具守则逐工具稿：name → 文本（空 = 出厂默认）；改一件不影响别的 */
  toolPrompts: Record<string, string>;
  /** 组尾的追加稿：groupId → 文本（空 = 用出厂默认） */
  toolGroupNotes: Record<string, string>;
  /** 末栏「工具组使用风格」的覆盖稿（空 = 用出厂默认） */
  toolStyle: string;
  /** 来客那间另存一份：逐工具的覆盖稿 */
  guestToolPrompts: Record<string, string>;
  /** 来客那间的组尾覆盖稿 */
  guestToolGroupNotes: Record<string, string>;
  /** 来客那间的末栏风格覆盖稿 */
  guestToolStyle: string;
  /** 管理员自定义的回想守则（空 = 用内置默认） */
  recapPrompt: string;
  skills: Record<string, string[]>;
  tasks: Task[];
  /** 本场计划改过几次；内容按 room/session 去 /api/session-plan 拉，它变了就重拉 */
  planRev: number;
  /** 还摆在我眼前、没答的问题 */
  asks: AskEntry[];
  thinkMode: "normal" | "deep";
  /** 「深度思考」槽位指到哪条模型配置；空 = 跟普通模式同一套（回复风格页指派） */
  deepConfigId: string;
  toolStats: Record<string, ToolStat>;
  summaries: Summary[];
  /** 当前正在聊的会话 id，由后端维护；前端只读它来高亮列表 */
  activeSession: string;
  lastActive: number;
  userId: string;
  /** 来客自己报过的称呼（进门介绍页 / whoami 登记的；管理员房里是主人自己的，设置页可改）；空串 = 还没有 */
  guestName: string;
  /** 管理员的一句话签名（设置页「个人信息」里写的）；只进界面显示，不进提示词。空串 = 没写过 */
  adminBio: string;
  /** 来客类型档的快照（连接鉴权时从主人房取来，见后端 guestTypes.ts）；临时票没有这一格 */
  guestType?: GuestTypeInfo;
  /** 复盘游标：已经回看到第几条消息 */
  expUpto: number;
  /** 累计从经历里长出来的经验条数 */
  expCount: number;
  /** 朗读用哪副嗓子（音色 id，见 src/audio/tts.ts）；空串 = 还没挑，用默认 */
  voice: string;
  /** 我此刻翻着的笔记 id；后端每轮拼提示词都读它，说「这篇」时他知道指哪篇 */
  noteFocus: string;
  /** 上一轮的上下文账（后端轮尾回写）；头部用它画窗口占用与缓存命中 */
  lastUsage?: LastUsage;
  /** 异常中断的死因账（后端轮尾回写）；界面按 messageId 挂在对应回答下面 */
  turnErrors?: TurnError[];
  /** 最后看的哪间屋（人屋名/场屋名）；多端对齐用，空串 = 没记过 */
  lastRoom: string;
  /** 最后看的那一场（sessions 表主键）；与人屋的 activeSession 不是同一格 */
  lastSession: string;
  /** 上面这几笔的时刻；0 = 没记过。多端写回时人屋只留最晚那笔 */
  lastViewAt: number;
}

/** 一次异常中断的死因（后端 turnReport.ts 判定）；title/detail 是人话，
 *  raw 是原始报文，界面折叠、仅管理员可展开 */
export interface TurnError {
  /** 绑定的助手消息 id；断在还没吐出内容时为空串，界面按尾部落单条 */
  messageId: string;
  sessionId: string;
  reason: "stream-error" | "aborted" | "output-limit";
  title: string;
  detail: string;
  raw?: string;
  at: number;
}

/** 一轮对话烧掉多少上下文（后端 onChatMessage 轮尾回写，见 src/agent/state.ts） */
export interface LastUsage {
  /** 记的是哪一场的账 —— 只在与当前场对上号时才显示 */
  sessionId: string;
  /** 输入 token 总量（含缓存命中与新写） */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 这扇门有多宽（token）；0 = 没设，用默认档 */
  contextWindow: number;
}

/** 附件的类别。决定服务端用哪条链路去读它 */
export type AttachKind =
  "image" | "text" | "pdf" | "audio" | "video" | "unknown";

/** 服务端读完一份附件的结果（见后端 src/agent/attach.ts） */
export interface Attachment {
  kind: AttachKind;
  name: string;
  size: number;
  /** 读到的正文；空串表示这次没读到 */
  text: string;
  /** 一句话结论：读到了什么，或者为什么读不到 */
  note: string;
  /** 已经拼好、可以直接接进消息正文的那一段 */
  block: string;
}

/** 还没连上（agent.state 为 undefined）时的占位，避免面板到处判空。 */
export const INITIAL_UI_STATE: ChatState = {
  selfModel: "",
  selfModelVer: 0,
  selfLog: [],
  selfDemand: "",
  selfDemandVer: 0,
  selfDemandLog: [],
  basePrompt: "",
  toolPrompts: {},
  toolGroupNotes: {},
  toolStyle: "",
  guestToolPrompts: {},
  guestToolGroupNotes: {},
  guestToolStyle: "",
  recapPrompt: "",
  skills: {},
  tasks: [],
  planRev: 0,
  asks: [],
  thinkMode: "normal",
  deepConfigId: "",
  toolStats: {},
  summaries: [],
  activeSession: "",
  lastActive: 0,
  userId: "",
  guestName: "",
  adminBio: "",
  expUpto: 0,
  expCount: 0,
  voice: "",
  noteFocus: "",
  turnErrors: [],
  lastRoom: "",
  lastSession: "",
  lastViewAt: 0,
};

export interface R2File {
  key: string;
  size: number;
  uploaded: string;
}

/** 单条消息的赞踩汇总。mine: 1 = 我赞过，-1 = 我踩过，0 = 没投 */
interface MsgVote {
  up: number;
  down: number;
  mine: number;
}

/** 消息上要显示的反馈徽标：votes 按 message id 索引，comments 是评论条数，flags 是被标重的消息 id */
export interface FeedbackSummary {
  votes: Record<string, MsgVote>;
  comments: Record<string, number>;
  flags: string[];
}

export interface MsgComment {
  id: string;
  messageId: string;
  /** "ai" = ericher，其余是登录角色（admin / user） */
  author: string;
  content: string;
  ts: number;
}

/** 一场会话的元信息。消息本体存在后端，列表里只需要这些。 */
export interface SessionMeta {
  id: string;
  title: string;
  /** private = 只有管理员看得见；public = 来客也能在「公开会话」里读 */
  visibility: "private" | "public";
  created: string;
  lastActive: string;
  /** 置顶时刻；空串 = 未置顶。置顶区按它升序：先顶的在前 */
  pinned: string;
  msgCount: number;
  /** 这场更早的部分已经被压缩成摘要（原文还在，只是不再整段发给我） */
  hasDigest: boolean;
  /** 收起来了：不删，只是从会话主列表挪到「已归档」分组，翻旧账照样搜得到 */
  archived: boolean;
  /** ericher 另开的一场、我还没看过：侧栏里先闪一下，之后留个角标，点进去就清 */
  unread: boolean;
  /** 这一场宿在哪间屋：空 = 宿在人屋（屋内多场的老模式）；非空 = 独立场屋（人屋--场id），前端按它换连接 */
  home: string;
}

/** 跨会话回忆的一次命中：哪一场、谁说的、说了什么 */
export interface RecallHit {
  sessionId: string;
  sessionTitle: string;
  lastActive: string;
  role: string;
  message: string;
}

/** 一条提醒。调度在后端，前端只负责展示与取消。 */
export interface Reminder {
  id: string;
  /** 约定这条提醒时所在的会话；到点那句话也回到那一场 */
  sessionId: string;
  what: string;
  /** 首次触发时刻（ISO 8601 带时区） */
  at: string;
  /** 非空表示重复提醒，值为 cron 表达式 */
  every: string;
  status: "pending" | "done" | "cancelled";
  created: string;
  firedAt: string;
  /** 必须叫醒：安静时段里的一次性提醒照说不误。默认 false */
  urgent: boolean;
  /** 到点这句话落在哪儿：same = 回到上面那一场，new = 他另开一场说（定时会话） */
  mode: "same" | "new";
  /** mode = new 时那一场的名字 */
  title: string;
}

/** 今日写额度账：全屋共用 10 万行，超了连读都失败；用来看谁在写、写了多少 */
export interface WriteReport {
  /** UTC 日期，也就是额度所属的那一天（北京时间早八点换日） */
  day: string;
  writes: number;
  reads: number;
  writeCap: number;
  readCap: number;
  /** 最费额度的几处，降序。key 形如「insert:cf_agents_state」 */
  top: Array<{ key: string; n: number }>;
  /** 还在内存里、没落账的那部分 */
  pending: number;
}

/** AI neurons / Vectorize 的自计量（见 src/agent/usage.ts）。neurons 是估算口径。 */
export interface ResourceReport {
  day: string;
  /** 今天烧掉的 neurons（估算） */
  neurons: number;
  embeds: number;
  images: number;
  /** UTC 月（YYYY-MM），Vectorize 按月结算 */
  month: string;
  /** 本月查询过多少维 */
  vecQueriedDims: number;
  /** 当前存着多少维（近似存量） */
  vecStoredDims: number;
  neuronsCap: number;
  vecQueryCap: number;
  vecStoreCap: number;
}

/** Cloudflare 官方 Analytics 的精确数（见 src/analytics.ts）。没配 token 时是 null。 */
export interface OfficialUsage {
  day: string;
  requests: number | null;
  errors: number | null;
  subrequests: number | null;
  sqlRowsRead: number | null;
  sqlRowsWritten: number | null;
  /** 这份数是什么时候拿到的（毫秒时间戳）。官方口径有几分钟延迟。 */
  fetchedAt: number;
}

/** 额度总览：自计量 + 官方校准，一起回。 */
export interface UsageReport {
  writes: WriteReport;
  resources: ResourceReport;
  official: OfficialUsage | null;
}

/** 四个顶层页面：对话 / 笔记本 / 回想 / 设置 */
export type ViewKey =
  | "chat"
  | "note"
  | "memory-session"
  | "mailbox"
  | "settings";

/** 谁写的。user = 管理员，assistant = ericher 的笔迹；共用一个本子，但笔迹分得开 */
type NoteAuthor = "user" | "assistant";

export interface Note {
  id: string;
  title: string;
  /** Markdown 原文。存的是原样，渲染在前端 */
  body: string;
  tags: string[];
  author: NoteAuthor;
  updatedBy: NoteAuthor;
  pinned: boolean;
  created: string;
  updated: string;
}

/** 列表用的轻量视图：不带正文，只带一小段开头 */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  author: NoteAuthor;
  updatedBy: NoteAuthor;
  pinned: boolean;
  created: string;
  updated: string;
  preview: string;
}

export interface NoteRevision {
  noteId: string;
  seq: number;
  title: string;
  body: string;
  savedAt: string;
  by: NoteAuthor;
}

/** 一副嗓子的选项。服务端全量回传并逐副标出可用性（不静默滤掉，否则看不到原因）；
 *  id 是读音配置条目 id，provider 是协议名，后端加协议不必改前端 */
export interface VoiceOption {
  id: string;
  label: string;
  provider: string;
  /** 这条配置点名的音色 id；空串 = 用协议默认音色。前端拿它翻人话名 */
  voice: string;
  /** 一句话说明这个嗓子的性格，选的时候有依据 */
  desc: string;
  /** 这台机器现在用得上吗 */
  available: boolean;
  /** 用不上的原因；空串表示能用 */
  why: string;
}

/** 兼容别名：App 与朗读嗓音面板一直按 Voice 取数，形状与 VoiceOption 相同 */
export type Voice = VoiceOption;

/** 来客留痕的一笔（后端 src/agent/visitor.ts 的镜像）。
 *  留痕是明说的：介绍页承诺过，来客随时能翻自己那间的账。 */
export interface VisitorEvent {
  id: string;
  room: string;
  /** 记这笔时客人报过的称呼；空串 = 还没报过 */
  nickname: string;
  /** join / message / intro / panel */
  kind: string;
  detail: string;
  ts: string;
}

/** 来客名册的一行（管理面板用）。firstSeen/lastSeen 后端返回的就是 camelCase */
export interface VisitorRoom {
  room: string;
  nickname: string;
  firstSeen: string;
  lastSeen: string;
}

/** 来客类型的对外快照（连接鉴权/工具层流转的形状，无密码无停用位） */
export type GuestTypeInfo = Omit<GuestType, "active" | "created">;

/** 来客类型：一个口令一类来客。首行恒为内置通用档（id=common，前台门禁口令进来的都归它，
 *  口令取自 env，不可改/停用/删除）；自定义口令后端只存 SHA-256 摘要 */
export interface GuestType {
  id: string;
  name: string;
  note: string;
  /** 对外工具名（权益权威）。空数组 = 显式全关；恒开的不必写，后端会补 */
  tools: string[];
  /** 长期权益：记事本（凭身份卡解锁） */
  permNotes: boolean;
  /** 长期权益：云盘上传（凭身份卡解锁） */
  permFiles: boolean;
  /** 长期权益：公开内容与公开文件（凭身份卡解锁） */
  permPublic: boolean;
  /** 网页矩阵全量管理权（页面/连线/外观/外站/打包，不拆子权限）。可选：老后端不回即视为无权 */
  permMatrix?: boolean;
  /** 停用后这个口令进不来，配置保留 */
  active: boolean;
  created: string;
}

/** 长期使用者的身份卡（后端 user_cards 的公开形状，无摘要） */
export interface UserCard {
  id: string;
  /** 全局唯一昵称：登卡的钥匙之一 */
  name: string;
  /** 目的声明：领卡时必填 */
  purpose: string;
  /** 联系邮箱：只登记不发送（项目没有邮件通道） */
  email: string;
  /** 归属权限档的 id；"common" = 走通用门禁口令领的卡 */
  typeId: string;
  /** 绑定的房间（对前端只是个名字，不用它做事） */
  room: string;
  created: string;
  lastSeen: string;
}

/** 公开墙上的一条：permPublic 持卡者贴的纸条，进门的人谁都看得到 */
export interface PublicPost {
  id: string;
  /** 发帖人卡 id：撤回时前端用它判断「这条是不是我贴的」 */
  cardId: string;
  /** 昵称快照：贴上墙那一刻的名字 */
  author: string;
  content: string;
  created: string;
}

// ── 工具名册（后端 src/agent/toolGroups.ts 的镜像，走 GET /api/tool-groups）──
// 工具守则与来客权限页共用；名册只有后端一份，前端写死两份必定对不上。

/** 工具语义组 */
type ToolGroupId =
  | "read"
  | "visual"
  | "memory"
  | "todo"
  | "session"
  | "system"
  | "matrix";

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
  /** 组标题下面的一句说明（只进界面，不进提示词） */
  hint: string;
}

/** 面板里的一件工具 */
export interface ToolCatalogTool {
  name: string;
  group: ToolGroupId;
  /** 常驻（schema 直接挂着）还是渐进（经 call_tool 调） */
  resident: boolean;
  owner: boolean;
  guest: boolean;
  /** 来客侧能不能单独开关；false 的是恒开，不参与权限矩阵 */
  guestTogglable: boolean;
}

/** 某一侧（主人/来客）的三格覆盖值 */
export interface ToolSideGuide {
  /** 逐工具的覆盖稿：name → 文本 */
  prompts: Record<string, string>;
  /** 组尾的追加稿：groupId → 文本 */
  groupNotes: Record<string, string>;
  /** 末栏「工具组使用风格」的覆盖稿 */
  style: string;
}

export interface ToolCatalog {
  groups: ToolGroupDef[];
  tools: ToolCatalogTool[];
  /** 出厂默认稿（「恢复默认」的对照） */
  defaults: { owner: ToolSideGuide; guest: ToolSideGuide };
  /** 当前自定义（空 = 用出厂稿） */
  current: { owner: ToolSideGuide; guest: ToolSideGuide };
}

/** 模型服务的接口格式。同一家的 baseUrl 换个路径就能换格式（各家的备注见 presets.ts） */
export type ModelFormat = "anthropic" | "openai-chat" | "openai-responses";

/** 读音服务的接法。决定这一条怎么发请求、参数叫什么名字 */
export type TtsProtocol = "mimo-chat" | "doubao" | "glm-speech" | "minimax";

/** 一家模型供应商：接哪一家的钥匙串（名称、地址、格式、Key 变量名），模型条目挂它底下 */
export interface ModelProvider {
  id: string;
  /** 供应商名称 */
  name: string;
  format: ModelFormat;
  baseUrl: string;
  /** Key 存的是 secret 变量名（wrangler secret put 过的），不是 Key 本身 */
  keySecret: string;
  /** 维护性调用（后台整理记忆之类的活）专用的 Key；空 = 用本家那把 */
  maintKeySecret: string;
  /** 维护性调用专用的小模型；空 = 复用当前生效的主线模型 */
  maintModel: string;
  created: string;
}

/** 一个模型条目：某家供应商底下的一个可用模型。active 的是正在载入的那个 */
export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
  /** 单次回复的输出上限（token）；0 = 用服务端默认 */
  maxOutput: number;
  /** 最大上下文（token）；0 = 用默认档。聊天头部用它对比 lastUsage 算窗口占用 */
  contextWindow: number;
  active: boolean;
  created: string;
}

/** 一条读音配置：一条就是一副可用的嗓子，排在最前且 Key 可用的那条是默认 */
export interface TtsConfig {
  id: string;
  name: string;
  protocol: TtsProtocol;
  baseUrl: string;
  /** Key 存的是 secret 变量名，不是 Key 本身 */
  keySecret: string;
  model: string;
  /** 音色 id；空 = 用服务端默认音色 */
  voice: string;
  /** 语气参数（目前只有 MiMo 式对话接口用得上） */
  style: string;
}

/** 绘图的出图协议。决定这一档怎么发请求、尺寸参数叫什么名字 */
export type DrawFormat = "workers-ai" | "siliconflow" | "zhipu" | "minimax";

/** 绘图配置：出图三档（fast 主力 / high 高质量 / fallback 兜底）各一条 */
export interface DrawConfig {
  tier: "fast" | "high" | "fallback";
  format: DrawFormat;
  /** 出图端点；workers-ai 走平台 AI 绑定，用不上 */
  endpoint: string;
  /** 模型名，降级有序：前面的先试，没成才轮到后面 */
  models: string[];
  /** Key 存的是 secret 变量名，不是 Key 本身；workers-ai 档为空 */
  keySecret: string;
  /** 结果标注里的供应商名 */
  label: string;
}

/** 联网搜索走的通道。Brave 独立索引没有摘要生成；Tavily 自带答案摘要与正文抓取 */
export type SearchFormat = "tavily" | "brave";

/** 联网搜索配置：单条（搜一下走哪家、用哪把钥匙） */
export interface SearchConfig {
  format: SearchFormat;
  /** Key 存的是 secret 变量名，不是 Key 本体 */
  keySecret: string;
}

/** 最后一次发信的回执（形状照后端，字段一个不加不减） */
export type MailLastSend = NonNullable<MailConfigView["lastSend"]>;

/** 邮件（SMTP）配置视图。口令永不进浏览器：keySecret 只是 secret 变量名；
 *  keyAvailable / lastSend 是后端只读事实，不由界面回传 */
export interface MailConfigView {
  enabled: boolean;
  hostname: string;
  port: number;
  /** true = 465/997 隐式 TLS；false = 587 起步但必须 STARTTLS 成功 */
  secure: boolean;
  username: string;
  /** Worker secret 的变量名，不是口令本身 */
  keySecret: string;
  /** 发件地址 */
  from: string;
  /** 默认收件地址（管理员自己的邮箱） */
  to: string;
  dailyCap: number;
  /** 后端算出来的只读事实：那个变量在这台机器上配没配 */
  keyAvailable: boolean;
  lastSend: { at: string; ok: boolean; error: string; to: string } | null;
}

/** 保存时提交的九格（其余为只读事实）。Pick 自 MailConfigView，防止抄出第二套拼法 */
export type MailConfigPatch = Pick<
  MailConfigView,
  "enabled" | "hostname" | "port" | "secure" | "username" | "keySecret" | "from" | "to" | "dailyCap"
>;

/** 外观主题：白纸黑字 / 晨曦微蓝 / 夜墨 / 跟随系统（见 theme.css 的 token 组） */
export type ThemeKey = "paper" | "dawn" | "dark" | "system";

/** 设置页左导航条目。工具不在这里 —— 它们在对话里直接调用，只有技能配方归此页 */
export type SettingsKey =
  | "profile"
  | "about"
  | "style"
  | "memory"
  | "ledger"
  | "contact"
  | "session"
  | "file"
  | "visitors"
  | "guestTypes"
  | "guestPerms"
  // 网页矩阵：矩阵页挂在主域名下，管理面在独立整页工作台
  | "matrix"
  | "modelConfigs"
  | "ttsConfigs"
  | "drawConfigs"
  | "searchConfigs"
  // 邮件：SMTP 发信账号（提醒这类主动能力要往外寄东西时走它）
  | "mail"
  | "task"
  | "remind"
  | "skills"
  | "prompt"
  | "toolPrompt"
  | "recapPrompt"
  | "self"
  | "voice"
  // 外观摊成四个独立子页（共用一份草稿，见 ThemePanel.tsx 的 AppearancePanel）
  | "appearance-theme"
  | "appearance-color"
  | "appearance-face"
  | "appearance-motion";

// ── 网页矩阵 ─────────────────────────────────────
// 矩阵已并回主包：这些数据由 /api/matrix/* 提供（见 src/matrix/core.ts）。

/** 一页的身份档：公开 / 持票来客 / 管理员 / 指定来客档位白名单 */
export type MatrixAccess = "public" | "visitor" | "admin" | "types";

/** 节点类型：网页 / 门卫 / 助手本体；老配置缺省按 page（见 matrix/core.ts） */
export type MatrixNodeKind = "page" | "gate" | "assistant" | "app";

/** 矩阵里的一页：一条层级路径 + 一档身份 + 一段正文（或一条外站链接） */
export interface MatrixPage {
  id: string;
  path: string;
  title: string;
  access: MatrixAccess;
  /** 节点类型，缺省 = page */
  kind?: MatrixNodeKind;
  types?: string[];
  sandbox?: boolean;
  entry?: boolean;
  external?: string;
  /** 本页自由 CSS：只在这一页生效，排在矩阵默认样式之后 */
  css?: string;
  /** 正文引用云盘文件的 key。有它就不出本页正文，那只文件不能删/搬 */
  driveKey?: string;
  updatedAt: number;
}

/** 全局悬浮菜单：所有页面统一挂的那个左上角浮窗 */
export interface MatrixNav {
  on: boolean;
}

/** 矩阵注入层（通路按钮、悬浮菜单）的主色与按钮形态，与页面自身 CSS 无关 */
export interface MatrixTheme {
  /** 主色：链接与按钮的强调色，六个十六进制位 */
  accent: string;
  button: "text" | "outline" | "solid";
}

export interface MatrixPages {
  rev: number;
  pages: MatrixPage[];
  nav: MatrixNav;
  theme: MatrixTheme;
}

/** 外站认定表：表内域名才允许从内站过去；表外（含伪造目标）一律拦，默认空表 */
export interface ApprovedSite {
  /** 域名（小写，不含协议与路径）；它同时放行自己的子域 */
  host: string;
  /** 为什么放行：给自己下次看得懂的备注 */
  note?: string;
  /** 免提示：认定过、信得过，从内站过去不再停门卫页，直接跳 */
  skip?: boolean;
}

export interface MatrixSites {
  sites: ApprovedSite[];
}

export interface MatrixPageDetail {
  page: MatrixPage;
  body: string;
}

/** 按钮落点（按钮由矩阵渲染时拼入，不属于页面内容）：
 *  auto = 页末「通路」栏；anchor = 正文里 name 的命名锚点；point = 拖拽坐标（0-100） */
export type LinkPlace =
  | { kind: "auto" }
  | { kind: "anchor"; name: string }
  | { kind: "point"; x: number; y: number };

/** 矩阵里的一条通路：A 页里的一个按钮，指向 B 页 */
export interface MatrixLink {
  /** 起点页面 id（不是 path —— 页面改路径时连线不能断） */
  from: string;
  /** 终点页面 id */
  to: string;
  label: string;
  place: LinkPlace;
  order: number;
}

export interface MatrixLinks {
  links: MatrixLink[];
}

/** 矩阵只读总览（/api/matrix/stat）：版本、规模、外观开关；细节去 pages/links 取 */
export interface MatrixStat {
  /** 版本号（与主包同取自 package.json） */
  version: string;
  /** 构建号（那次提交的短 hash） */
  build: string;
  /** 云盘桶通不通 */
  r2: boolean;
  /** 配置版本号，每次写配置自增 */
  rev: number;
  pages: number;
  links: number;
  /** 入口页条数（应当 0 或 1） */
  entries: number;
  /** 外链页条数 */
  external: number;
  /** 沙箱页条数 */
  sandbox: number;
  /** 外站认定表条数 */
  sites: number;
  nav: MatrixNav;
  theme: MatrixTheme;
  /** 最近一次改动页面配置的时刻（毫秒），0 = 还没动过 */
  updatedAt: number;
}

/** 装备矩阵包的回执。装备是整体替换：数字报的是包里的量，不是新增量 */
export interface MatrixPackResult {
  pages: number;
  links: number;
  sites: number;
  /** 指向包外页面的连线，装的时候丢了这么多条 */
  droppedLinks: number;
  /** 超过外站认定表上限、被丢掉的那几条 */
  droppedSites: number;
  /** 落进云盘的正文总字节 */
  bodyBytes: number;
  /** 装之前有没有留下「装前那一版」的留底 */
  snapshot: boolean;
}

// ── 信箱（发件流水 / 收件箱）──
// 字段与后端 src/mail/mailboxTypes.ts 一一对应；web 不 import src（避免 Workers 类型），
// 改一边必须同轮改另一边。MailConfigView.to 存地址表文本，规则见 mailForm/mailBoxView。

/** 这一封是谁要寄的：面板「试一封」/ ericher 的工具 / 提醒・盯梢的离线副本 */
export type MailSource = "panel" | "tool" | "say";

/** 发件箱里的一行：已落账的一封，成功失败都在 */
export interface MailOutRow {
  /** ISO 时刻 */
  at: string;
  /** 这一封实际寄给谁，可有多个 */
  to: string[];
  subject: string;
  ok: boolean;
  /** 失败原因原文；成功是空串 */
  error: string;
  source: MailSource;
}

/** 收件箱一行：头部在 DO 表，正文与原件在 R2。emlKey 空 = 原件没落盘，
 *  只有摘要与字节数，界面不能假装点得开全文 */
export interface MailInRow {
  id: string;
  at: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  /** 整封原始报文的字节数，不是正文字节数 */
  bytes: number;
  read: boolean;
  hasAttachment: boolean;
  /** 附件清单（仅名字与大小）。可选是有意为之：老数据可能没有，按「无清单」处理 */
  attachments?: { name: string; bytes: number }[];
  /** 纯文本正文的开头一段；随列表一起回 */
  preview: string;
  emlKey: string;
}

/** GET /api/mail/outbox 的 data */
export interface MailOutboxView {
  rows: MailOutRow[];
}

/** GET /api/mail/inbox 的 data：清单 + 未读总数 + 收信开关（关着 ≠ 空的） */
export interface MailInboxView {
  rows: MailInRow[];
  unread: number;
  enabled: boolean;
}

/** GET /api/mail/inbox/read 的 data：这一封的行 + 正文 + 后端那一句说明 */
export interface MailInReadView {
  row: MailInRow;
  text: string;
  note: string;
}

/** POST /api/mail/inbox/open 的 data（标已读 / 标未读的回执） */
export interface MailInOpenReceipt {
  id: string;
  read: boolean;
}

/** 邮件配置新增三格。全可选是刻意的：老后端不回时按开关关、地址表从 to 拆兜底 */
export interface MailConfigExtras {
  /** 提醒 / 盯梢另寄一份邮件副本的总开关；默认关 */
  sayMail?: boolean;
  /** 收信落库开关；默认关（没接 MX 之前就该关着） */
  inboxEnabled?: boolean;
  /** 默认收件地址表；`to` 那格存的就是它的文本形态 */
  toList?: string[];
}

/** GET /api/mail/config 的现值（原九格 + 新增三格） */
export type MailConfigViewFull = MailConfigView & MailConfigExtras;

/** POST /api/mail/config 现在送的那十一格：原九格 + 两个开关 */
export type MailConfigPatchFull = MailConfigPatch & {
  sayMail: boolean;
  inboxEnabled: boolean;
};
