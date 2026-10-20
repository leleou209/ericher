import { SESSION_RUNNING_MESSAGE } from "../shared/sessionConflict";
import { chatMemoryBlocks } from "../shared/chatMemoryBlocks";
import { ChatIngress } from "./adapters/chatIngress";
import { AskDelivery } from "./adapters/askDelivery";
// ericher 主体：AIChatAgent + 原生工具调用。
// 类名 CoworkAgent 必须保持不变：DO 存储按类标识派生，改名等于换存储桶。

import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions,
} from "@cloudflare/ai-chat";
import {
  getCurrentAgent,
  type AgentContext,
  type Connection,
  type ConnectionContext,
} from "agents";
import {
  convertToModelMessages,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  adminPassword,
  authToken,
  gatePassword,
  OWNER_AGENT,
  ownerRoomOf,
  sessionRoom,
  verifyTokenInfo,
  type Role,
} from "../auth";
import {
  maintenanceModel,
  resolveModel,
  titleModel,
  TITLE_PROVIDER_OPTIONS,
  type ResolvedModel,
} from "../providers";
import {
  AI_AUTHOR,
  addComment,
  commentCounts,
  ensureFeedbackSchema,
  listComments,
  listFlags,
  listVotes,
  setVote,
  toggleFlag,
  voteTotals,
  type CommentRow,
  type VoteValue,
} from "./feedback";
import { newerViewWins } from "./lastView";
import {
  ensureEventSchema,
  formatEventAt,
  hasRecentEvent,
  insertEvent,
  listPendingEvents,
  markEventsDelivered,
  pruneEvents,
  type LedgerEvent,
} from "./events";
import {
  DEFERRED_TOOLS,
  PROMOTE_CAP,
  buildToolStack,
  type ToolCtx,
} from "../tools";
import { nowInShanghai } from "../tools/remind";
import {
  confirmMemory,
  conflictBlock,
  countMemories,
  deleteMemory,
  deleteVector,
  ensureMemorySchema,
  findConflicts,
  getMemory,
  insertMemory,
  listConflicted,
  listDueForReview,
  listMemories,
  listMemoriesByPerson,
  listPersons,
  listPublicMemories,
  listSessionMemories,
  listSuperseded,
  listTagAccess,
  memoryHitLines,
  memoryStats,
  restoreMemory,
  searchMemories,
  sessionMemoryCounts,
  setConflicts,
  setSensitivity,
  setTagAccess,
  setVisibility,
  setVolatility,
  settleConflicts,
  supersedeMemory,
  tagStats,
  upsertMemorySnapshot,
  upsertVector,
  type MemoryStats,
  type SessionMemoryQuery,
  type TagGate,
  type TagStat,
  type Volatility,
} from "./memory";
import {
  appendSessionMessage,
  ensureSessionSchema,
  getSession,
  getSessionDigest,
  getSessionGoal,
  insertRecallIndexRows,
  insertSession,
  listPublicSessions,
  listSessionTasks,
  listSessions,
  loadSessionMessages,
  markSessionRead,
  markSessionUnread,
  newSessionId,
  removeSession,
  renameSession,
  resetLegacyRecapCursors,
  saveSessionMessages,
  saveSessionTasks,
  searchMessages,
  searchRecallIndex,
  setSessionArchived,
  setSessionDigest,
  setSessionGoal,
  setSessionPinned,
  setSessionVisibility,
  touchSession,
  type RecallHit,
  type RecallIndexRow,
  type SessionMeta,
  type SessionTask,
  type SessionVisibility,
} from "./sessionStore";
import {
  REMINDER_CAP,
  cancelReminderRow,
  countPendingReminders,
  ensureReminderSchema,
  getReminder,
  insertReminder,
  listPendingReminders,
  markReminderFired,
  newReminderId,
  setReminderScheduleId,
  shanghaiEveryToCron,
  type Reminder,
} from "./reminderStore";
import {
  SAY_DEBOUNCE_MS,
  beijingDayStart,
  countSaysSince,
  enqueueSay,
  ensureSpeakSchema,
  inQuietHours,
  listPendingSays,
  markSaysDelivered,
  mergeSays,
  pruneSays,
  quietEndsAt,
  type SayWhere,
} from "./speakGate";
import {
  COMMON_TYPE_ID,
  cardPermFallback,
  createGuestType as createGuestTypeRow,
  ensureGuestTypesSchema,
  findGuestTypeByPassword,
  getGuestType,
  listGuestTypes as listGuestTypeRows,
  removeGuestType as removeGuestTypeRow,
  toGuestTypeInfo,
  toGuestTypePublic,
  updateGuestType as updateGuestTypeRow,
  defaultCommonGuestTypeInfo,
  disabledGuestTypeInfo,
  guestHasTool,
  type GuestCardPerm,
  type GuestTypeInfo,
  type GuestTypeInput,
  type GuestTypePatch,
  type GuestTypePublic,
  type GuestTypeRow,
} from "./guestTypes";
import {
  createUserCard,
  getUserCard,
  listUserCards,
  toUserCardPublic,
  verifyCardLogin as verifyCardLoginRow,
  type UserCardPublic,
} from "./userCards";
import {
  createPublicPost,
  listPublicPosts,
  removePublicPost,
  type PublicPost,
} from "./publicPosts";
import {
  ensureVisitorSchema,
  isNewJoin,
  listVisitorEvents,
  listVisitorRooms,
  logVisitorEventBatch,
  logVisitorEventRow,
  buildVisitorEvent,
  registerVisitorRoom as registerVisitorRoomRow,
  type VisitorEvent,
  type VisitorRoom,
} from "./visitor";
import {
  activateModelEntry,
  createModelEntry,
  createModelProvider,
  ensureModelCatalogSchema,
  getActiveCatalog,
  getCatalogById,
  listModelEntries,
  listModelProviders,
  removeModelEntry,
  removeModelProvider,
  updateModelEntry,
  updateModelProvider,
  type ActiveCatalog,
  type ModelEntry,
  type ModelEntryPatch,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderPatch,
} from "./modelConfigs";
import {
  createTtsConfig,
  ensureTtsConfigsSchema,
  listTtsConfigs,
  removeTtsConfig,
  updateTtsConfig,
  type TtsConfig,
  type TtsConfigInput,
  type TtsConfigPatch,
} from "./ttsConfigs";
import {
  DEFAULT_DRAW_CONFIGS,
  ensureDrawConfigsSchema,
  listDrawConfigs,
  resolveDrawTiers,
  updateDrawConfig,
  type DrawConfig,
  type DrawConfigPatch,
  type DrawTier,
  type DrawTierConfigs,
} from "./drawConfigs";
import {
  DEFAULT_SEARCH_CONFIG,
  ensureSearchConfigSchema,
  getSearchConfig,
  updateSearchConfig,
  type SearchConfig,
} from "./searchConfigs";
import {
  getMailConfigView,
  saveMailConfig,
  type MailConfigPatch,
  type MailConfigView,
} from "../mail/store";
import { sendConfiguredMail, type MailJob, type MailSendResult } from "../mail/send";
import {
  INGEST_MAX_BYTES,
  MAIL_PREVIEW_MAX,
  findMailIn,
  getEml,
  insertMailIn,
  listMailIn,
  listMailOut,
  mailInUnread,
  putEml,
  setMailInRead,
  toHex,
  type EmlStore,
} from "../mail/mailbox";
import { parseIncoming } from "../mail/inbound";
import type {
  MailIngestResult,
  MailInRow,
  MailOutRow,
} from "../mail/mailboxTypes";
import {
  defaultTheme,
  deleteThemeSet,
  ensureThemeSchema,
  getThemeSet,
  insertThemeSet,
  listThemeSets,
  loadTheme,
  patchTheme as patchThemeRow,
  saveTheme,
  type ThemeConfig,
  type ThemeConfigPatch,
  type ThemeSet,
} from "./themeConfig";
import {
  deleteNote as deleteNoteRow,
  ensureNoteSchema,
  getNote,
  listNotes as listNoteRows,
  listRevisions,
  noteFocusBlock,
  restoreRevision,
  saveNote as saveNoteRow,
  type Note,
  type NoteInput,
  type NoteMeta,
  type NoteRevision,
} from "./noteStore";
import {
  CACHE_PROVIDER_OPTIONS,
  DIGEST_MAX,
  digestBlock,
  digestPrompt,
  markCacheBreakpoint,
  planContext,
} from "./context";
import {
  EXP_CAP,
  EXP_EVERY,
  EXP_WINDOW,
  experiencePrompt,
  isDuplicate,
  parseExperience,
} from "./experience";
import {
  buildBasePrompt,
  selfDemandBlock,
  stripToolGuide,
  toolGuide,
} from "./prompt";
import {
  guestEnabledTools,
  toolCatalog,
  type ToolCatalog,
  type ToolSideGuide,
} from "./toolGroups";
import { titleSystem, tidyTitle, titlePrompt } from "./title";
import {
  installMigration,
  runMigration,
  type MigrationReport,
} from "./migration";
import {
  meterOf,
  sqlText,
  type Meter,
  type MeterCell,
  type WriteReport,
} from "./meter";
import { usage, type ResourceReport } from "./usage";
import { coalesceStream } from "./coalesce";
import { Thinker } from "./think";
import {
  installRuntime,
  NIGHTLY_MESSAGES,
  NIGHTLY_TEXT,
  runContinueTask,
  runHeartbeat,
  runNightlyMaintenance,
} from "./runtime";
import {
  freshSegment,
  resyncRecaps,
  runSessionRecap,
  scheduleRecap,
} from "./recap";
import {
  INITIAL_STATE,
  PATCHABLE_KEYS,
  migrateServiceCopy,
  seedMemories,
  seedPatch,
  type ChatState,
  type MemEntry,
  type SeedOp,
  type Sensitivity,
  type SqlTag,
  SENSITIVITIES,
  type Task,
  type TurnError,
} from "./state";
import { appendTurnError, describeTurn, type TurnCapture } from "./turnReport";

/** 闲置超过这个时长就当作一段新关系：上一场归档，另起一场 */
const IDLE_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/** 导出时跳过可重建的运行时簿记：迁移游标、配额计量、任务游标 */
const EXPORT_SKIP = new Set(["migration_flags", "write_meter", "task_cursor"]);
/** 导出时剥离的敏感列：备份里不能有任何可用于登录的东西（散列也不给） */
const EXPORT_SENSITIVE: Record<string, string[]> = {
  guest_types: ["password"],
  // 身份卡口令散列：离线撞库不需联网，备份里一样不能有
  user_cards: ["password_hash"],
};

/**
 * lastActive 落库的最小间隔：判定尺子是 30 天，五分钟粒度足够。
 * 每次连接/切场都写整份 state blob 太贵，这类「只报时辰」的写该省掉。
 */
const LAST_ACTIVE_FLUSH_MS = 5 * 60 * 1000;

const MAX_STEPS = 10;

/** 「她正在想什么」那一次翻写的上限：翻过这一秒，外面早就等到正文了（见 think.ts） */
const THINK_TIMEOUT = 12_000;

/**
 * 来客房缓存「生效模型目录组」的时长（见 fetchActiveCatalog）：
 * 跨间调用不便宜，目录改一次用很久，半分钟延迟换每句少一跳。
 */
const ACTIVE_CONFIG_CACHE_MS = 30_000;

function messageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

export class CoworkAgent extends AIChatAgent<Env, ChatState> {
  private chatIngress?: ChatIngress;
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // AIChatAgent 在其构造器包装 onMessage；此处必须位于 super 之后，
    // 才能在 SDK 持久化整份历史和启动模型之前拦住重复提交。
    const dispatch = this.onMessage.bind(this);
    const ingress = this.chatIngress = new ChatIngress(this.db);
    this.onMessage = async (connection, message) => {
      if (typeof message !== "string") return dispatch(connection, message);
      await ingress.dispatch(connection, message,
        (conn, frame) => dispatch(conn as Connection, frame), () => this.messages);
    };
  }

  initialState: ChatState = INITIAL_STATE;

  /** 只保留最近 200 条消息在 SQLite 里，避免无限增长 */
  maxPersistedMessages = 200;

  /** 用户中途补充说明时，以最后一条为准，避免同时跑两轮 */
  messageConcurrency = "latest" as const;

  /**
   * 关闭 WebSocket 休眠：连接断了，在途的一轮照常跑完、落库完才被回收。
   * 默认 hibernate 会在工具链的秒级空档冻结实例，杀掉进行中的流。
   * 代价是连接挂着期间实例内存常驻（单人聊天，可接受）。
   */
  static options = { hibernate: false };

  /**
   * 长思考要扛得住驱逐/断线：这一轮跑在 durable fiber 里，登记先落 SQLite，
   * 重启后基类会从流缓冲捞出半截再续一轮（见 _handleInternalFiberRecovery）。
   * 代价是多一张 cf_agents_runs 表的读写。
   */
  chatRecovery = true;

  /**
   * Agent.sql 依赖 this.ctx：当值传递（如 `f(this.sql)`）会丢 this 并报
   * "Cannot read properties of undefined (reading 'ctx')"，传递场景统一用这个绑定版本。
   */
  private dbTag?: SqlTag;
  get db(): SqlTag {
    return (this.dbTag ??= this.sql.bind(this) as unknown as SqlTag);
  }

  /** `env` 在基类里是 protected，迁移等外部模块通过这个公开别名读取。 */
  get appEnv(): Env {
    return this.env;
  }

  /**
   * 不带计量的原生 sql：计量器自己落账要用它，
   * 否则每记一行账又多出一行账。
   */
  private rawSqlTag?: SqlTag;
  private get rawSql(): SqlTag {
    return (this.rawSqlTag ??= super.sql.bind(this) as unknown as SqlTag);
  }

  /**
   * 今天写了多少行、写到哪儿去了。
   * 每次都重新 attach：基类构造期可能已发 SQL，闭包只引用 this 和原型方法，回调仍须有效。
   */
  private get meter(): Meter {
    const m = meterOf(this);
    if (!m.attached) {
      m.attached = true;
      m.attach(
        (day, cells) => this.writeMeterSink(day, cells),
        (day) => this.writeMeterLoader(day),
      );
    }
    return m;
  }

  /**
   * 「她正在想什么」（见 think.ts）。一屋一个：
   * 轮次号必须递增，客户端才分得清飘来的哪句属于这一轮。
   */
  private thinker = new Thinker({
    ask: (system, user) => this.thinkAsk(system, user),
    emit: (turn, line) => this.emitThought(turn, line),
  });

  /**
   * 计量每一次 SQL，包括 SDK 自己发的（消息落库、state blob、定时任务表）：
   * 免费层每天 10 万行是整屋共用，超限后连读都失败，整个 DO 会瘫。
   */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const rows = super.sql<T>(strings, ...values);
    this.meter.note(sqlText(strings), rows.length);
    return rows;
  }

  /** 落账：一天一行、一个来源一行，攒够一批写一次（见 meter.ts 的 FLUSH_EVERY）。 */
  private writeMeterSink(day: string, cells: MeterCell[]): void {
    this.ensureMeterSchema();
    for (const c of cells) {
      this
        .rawSql`INSERT INTO write_meter (day, key, n) VALUES (${day}, ${c.key}, ${c.n})
        ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n`;
    }
  }

  /** 读账：驱逐重启后把今天已经写掉的数接回来，面板上的数字才不会倒退。 */
  private writeMeterLoader(day: string): MeterCell[] {
    this.ensureMeterSchema();
    const rows = this.rawSql<{
      key: string;
      n: number;
    }>`SELECT key, n FROM write_meter WHERE day = ${day}`;
    // 写读怎么分、哪些不算（结构变更）由 meter.ts 说了算，这里只管搬数据
    return rows.map((r) => ({ key: r.key, n: r.n }));
  }

  private meterReady = false;
  private ensureMeterSchema(): void {
    if (this.meterReady) return;
    // 先置位再建表：建表本身也是一条 SQL，不置位会绕回来
    this.meterReady = true;
    try {
      this.rawSql`CREATE TABLE IF NOT EXISTS write_meter (
        day TEXT NOT NULL,
        key TEXT NOT NULL,
        n   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key)
      )`;
    } catch {
      // 建不出来就退化成「只在内存里数」，不影响干活
      this.meterReady = false;
    }
  }

  /** 今日写额度（面板用）。纯读内存 + 一次落账，不额外扫表。 */
  writeReport(): WriteReport {
    return this.meter.report();
  }

  /**
   * AI neurons / Vectorize 的自计量（面板用）。
   * 纯内存账，顺带接回 state 里的旧账 —— 只接一次。
   */
  resourceReport(): ResourceReport {
    usage.hydrate(this.state.usage);
    return usage.report();
  }

  /**
   * 把资源账写回 state：只在主人那间、且数字真的动了的时候写。
   * state 落盘一次就是一行写入 —— 这本账本身不该反过来吃额度。
   */
  private flushUsage(): void {
    if (!this.isOwnerRoom) return;
    usage.hydrate(this.state.usage);
    if (!usage.dirty()) return;
    this.patchState({ usage: usage.snapshot() });
    usage.markFlushed();
  }

  /**
   * 我是不是主人级的屋子：主人每场对话各有一间场屋（default--sXxx），与主屋一样全套。
   * 来客（含来客的场屋）只有人格提示词和几个对外工具；runtime 因此不给来客排夜间整理。
   */
  get isOwnerRoom(): boolean {
    return (ownerRoomOf(this.name) ?? this.name) === OWNER_AGENT;
  }

  /**
   * 固定场模式：场屋名带 `--` 后缀，屋名即场 id，一辈子只聊这一场，多场并行的地基。
   * 人屋本尊返回 null，走老的屋内切换。
   */
  get fixedSessionId(): string | null {
    const owner = ownerRoomOf(this.name);
    return owner === null ? null : this.name.slice(owner.length + 2);
  }

  /** 这一轮归属的会话 id：场屋用屋名里钉死的那场，人屋用当前 activeSession。 */
  private currentSessionId(): string {
    return this.fixedSessionId || this.state.activeSession || "";
  }

  /**
   * 守则、自我要求、内核只有主屋本尊存在 state 里，其余屋连接时来取一份，取不到用出厂默认。
   * 不共用的话，一处改完别处还是老样子 —— 等于养出多个 ericher。记忆另走跨间合并。
   */
  private personaCache = "";
  private demandCache = "";
  /**
   * 内核与自我要求的缓存（场屋读主屋那份，主屋本尊直接读 state）。
   * 内核若只写当前屋，场屋改完下一场或设置页看不到，表现是「说保存了，回来又没了」。
   */
  private selfCache = {
    core: "",
    coreVer: 0,
    coreLog: [] as string[],
    demand: "",
    demandVer: 0,
    demandLog: [] as string[],
  };
  private async refreshPersona(): Promise<void> {
    if (!ownerRoomOf(this.name)) return; // 主屋本尊：人设在自己 state 里
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      const cfg = await owner.getConfig();
      this.personaCache =
        typeof cfg?.basePrompt === "string" ? cfg.basePrompt : "";
      this.demandCache =
        typeof cfg?.selfDemand === "string" ? cfg.selfDemand : "";
      this.selfCache = {
        core: typeof cfg?.selfModel === "string" ? cfg.selfModel : "",
        coreVer: typeof cfg?.selfModelVer === "number" ? cfg.selfModelVer : 0,
        coreLog: Array.isArray(cfg?.selfLog) ? cfg.selfLog : [],
        demand: typeof cfg?.selfDemand === "string" ? cfg.selfDemand : "",
        demandVer:
          typeof cfg?.selfDemandVer === "number" ? cfg.selfDemandVer : 0,
        demandLog: Array.isArray(cfg?.selfDemandLog) ? cfg.selfDemandLog : [],
      };
    } catch {
      // 主屋没醒 / 调用出错都留空：buildBasePrompt 会回落到出厂人设，聊天照常
    }
  }

  /** 这一轮该用哪份人设。 */
  private personaForPrompt(): string {
    return ownerRoomOf(this.name) ? this.personaCache : this.state.basePrompt;
  }

  /** 这一轮该用哪份自我要求（同人设，来自同一处）。 */
  private demandForPrompt(): string {
    return ownerRoomOf(this.name)
      ? this.demandCache
      : this.state.selfDemand || "";
  }

  /** 这一轮该用哪份内核。 */
  private coreForPrompt(): string {
    return ownerRoomOf(this.name) ? this.selfCache.core : this.state.selfModel;
  }

  /**
   * 内核/自我要求的统一读口径：主屋本尊读 state，场屋读主屋缓存。
   * reflect 与写入都要读它 —— 读错了模型会以为内核是空的。
   */
  readSelf(): {
    core: string;
    coreVer: number;
    coreLog: string[];
    demand: string;
    demandVer: number;
    demandLog: string[];
  } {
    if (!ownerRoomOf(this.name)) {
      return {
        core: this.state.selfModel,
        coreVer: this.state.selfModelVer || 0,
        coreLog: this.state.selfLog || [],
        demand: this.state.selfDemand || "",
        demandVer: this.state.selfDemandVer || 0,
        demandLog: this.state.selfDemandLog || [],
      };
    }
    return { ...this.selfCache };
  }

  /**
   * 落一次内核/自我要求的写入：主屋就地写，场屋转交主屋 —— 写在场屋下一场就丢。
   * 写完同步本地缓存，同一轮的 reflect 立刻读得到。
   */
  private async commitSelf(patch: Partial<ChatState>): Promise<ChatState> {
    if (!ownerRoomOf(this.name)) {
      this.patchState(patch);
      return this.state;
    }
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    const next = await owner.patchConfig(patch);
    this.selfCache = {
      core: next.selfModel || "",
      coreVer: next.selfModelVer || 0,
      coreLog: next.selfLog || [],
      demand: next.selfDemand || "",
      demandVer: next.selfDemandVer || 0,
      demandLog: next.selfDemandLog || [],
    };
    return next;
  }

  /** self 工具写内核（content 空 = 清除）。版本与日志按主屋那份算，返回新版本号。 */
  async writeSelfCore(content: string): Promise<number> {
    const now = new Date().toISOString().slice(0, 10);
    const cur = this.readSelf();
    const ver = cur.coreVer + 1;
    const log = content ? `${now}: ${content.slice(0, 300)}` : `${now}: 已清除`;
    await this.commitSelf({
      selfModel: content ? content.slice(0, 1000) : "",
      selfModelVer: ver,
      selfLog: [...cur.coreLog, log].slice(-20),
    });
    return ver;
  }

  /** self 工具写自我要求（content 空 = 清除）。同上。 */
  async writeSelfDemand(content: string): Promise<number> {
    const now = new Date().toISOString().slice(0, 10);
    const cur = this.readSelf();
    const ver = cur.demandVer + 1;
    const log = content ? `${now}: ${content.slice(0, 300)}` : `${now}: 已清除`;
    await this.commitSelf({
      selfDemand: content ? content.slice(0, 1000) : "",
      selfDemandVer: ver,
      selfDemandLog: [...cur.demandLog, log].slice(-20),
    });
    return ver;
  }

  /**
   * 来客记下的一条，主屋留档（两边都留，理由见 tools/memory.ts）。
   * 人名一律带「来客·」前缀，撞不到真名；person 只作展示，
   * 授权归属跟 ownerKey（room:<来客房间名>，Worker 按签名票派生）走。
   */
  async receiveGuestMemory(input: {
    content: string;
    shelf?: string;
    tags?: string[];
    volatility?: "stable" | "volatile";
    /** 来客自报的称呼，只作展示（person 字段） */
    person?: string;
    /** 经核实的归属键：调用房自己的名字，由调用方服务端注入，不经过客人的手 */
    ownerKey?: string;
  }): Promise<void> {
    const content = (input.content || "").trim();
    if (!content) return;
    ensureMemorySchema(this.db);
    const who = (input.person || "").trim().slice(0, 20)
      ? `来客·${input.person!.trim().slice(0, 20)}`
      : "";
    const entry = insertMemory(this.db, {
      type: "fact",
      content: "来客说：" + content,
      shelf: input.shelf,
      tags: [...(input.tags || []), "来客"],
      volatility: input.volatility,
      person: who,
      ownerKey: input.ownerKey,
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
  }

  /**
   * 来客读得到的记忆 = 管理员公开的（含 tag 门放行）+ owner_key 名下自己的；
   * 过滤在 searchMemories 的 SQL 里完成，private 一个字都不出这间屋子。
   * 归属键由调用方用 this.name 注入（Worker 按签名票派生），自称做不了凭据；无卡身份换登录即换屋。
   */
  async guestReadableMemories(
    query: string,
    ownerKey: string,
    limit = 5,
  ): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];
    ensureMemorySchema(this.db);
    // 受限读不走跨请求缓存：管理员收回公开/升量级/关 tag 门后必须当场生效，
    // 旧答案不能留着；来客检索低频，每次实搜的账花得起
    const hits = await searchMemories(this.db, this.env, q, limit, {
      guestOwnerKey: ownerKey || undefined,
      onlyPublic: !ownerKey,
    }).catch(() => []);
    return memoryHitLines(hits);
  }

  /** 替来客那间问一次主人那边。没醒、出错都当成「没有可读的」，不打断这一轮。 */
  private async guestReadableOf(query: string): Promise<string[]> {
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    return (
      // 归属键是这间屋子自己的名字：Worker 按票派生出来的，客人改不了
      (await owner.guestReadableMemories(query, `room:${this.name}`, 5)) || []
    );
  }

  /** 管理员标了「公开」的账本骨架。跨房间调用入口，名字直白是有意的。 */
  publicMemoryEntries(limit = 300): MemEntry[] {
    ensureMemorySchema(this.db);
    return listPublicMemories(this.db, limit);
  }

  /**
   * 公开账本 = 管理员公开的 + 他这场自己登记的（否则他刚写完就看不见）。
   * 主人那间即自己公开那一档；只读 —— 来客没有改/删/作废入口。
   */
  async publicLedger(limit = 300): Promise<MemEntry[]> {
    if (this.isOwnerRoom) return this.publicMemoryEntries(limit);
    ensureMemorySchema(this.db);
    // 本屋的都是他这场带来的：默认 private 对他自己不算秘密 —— 挡的是跨房间
    const mine = listMemories(this.db, undefined, limit);
    let shared: MemEntry[] = [];
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      shared = (await owner.publicMemoryEntries(limit)) || [];
    } catch {
      // 管理员那间没醒 / 出错：至少把手边这份给他看，别把整个账本变成空白
    }
    return [...shared, ...mine];
  }

  /**
   * 现查一档的对外快照，票里声称的档位每次核对都以此为准。通用档也是名册真实一行，照常现查，
   * 只有主人那间读不到时才落通用档默认兜底（门口最后一把钥匙）。其它档查不到、或主人那间没醒，
   * 落失效兜底（权益全关）—— 核实不了的档不能当「还在」放行，否则删一档等于全员放开。
   */
  private async currentGuestType(typeId: string): Promise<GuestTypeInfo> {
    const fallback =
      typeId === COMMON_TYPE_ID
        ? defaultCommonGuestTypeInfo()
        : disabledGuestTypeInfo(typeId);
    try {
      // 名册在主人那间：本尊读本地表；主人的场屋也是 isOwnerRoom 但表是空的，
      // 门槛必须是「就是主屋本尊」。
      if (this.name === OWNER_AGENT) {
        const row = getGuestType(this.db, typeId);
        return row ? toGuestTypeInfo(row) : fallback;
      }
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return (await owner.getTypeInfo(typeId)) || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 来客在账本上添一笔（只能添），同时给管理员那边送一份。
   * 工具注册是第一道门，这里是第二道：HTTP 直呼（POST /api/memory、进门介绍）不经过注册。
   * 权益现查现判，不要连接时的快照；查不到档/查询失败按无权益算 —— 宁可拒了，不能 fail-open。
   */
  async addGuestEntry(input: {
    content: string;
    shelf?: string;
    tags?: string[];
    volatility?: string;
    typeId?: string;
  }): Promise<MemEntry | null> {
    const content = (input.content || "").trim();
    if (!content) return null;
    if (!this.isOwnerRoom) {
      // 类型跟着票走：WS 连接在 onConnect 存快照，HTTP 直呼没有 ——
      // 空快照不能当「没类型」（那会 fail-open），两处都拿不到 = 无法核实 = 拒绝。
      const typeId = input.typeId || this.state.guestTypeId || "";
      if (!typeId) return null;
      const fresh = await this.currentGuestType(typeId);
      if (!guestHasTool(fresh, "memory")) return null;
    }
    ensureMemorySchema(this.db);
    const tags = input.tags || [];
    // person 只作展示；授权归属跟房间键走 —— 跟称呼走就会被同名冒领
    const who = (this.state.guestName || "").trim().slice(0, 20);
    const belong = who ? `来客·${who}` : "";
    const entry = insertMemory(this.db, {
      type: "fact",
      content,
      shelf: input.shelf,
      tags,
      volatility: input.volatility === "volatile" ? "volatile" : "stable",
      person: belong,
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      await owner.receiveGuestMemory({
        content,
        shelf: entry.shelf,
        tags,
        volatility: entry.volatility,
        person: who || undefined,
        // 归属键是这间屋子自己的名字，服务端注入 —— 称呼做不了授权凭据
        ownerKey: `room:${this.name}`,
      });
    } catch {
      // 管理员那边没收到不代表没记下：本地这一份已经落地了
    }
    return entry;
  }

  /** 反馈表可能建在 onStart 之前（热实例不重跑 onStart）；用到的地方先过一遍，每实例只建一次。 */
  private feedbackReady = false;
  private ensureFeedback(): void {
    if (this.feedbackReady) return;
    ensureFeedbackSchema(this.db);
    this.feedbackReady = true;
  }

  /** 同 feedback：会话表也可能建在旧实例上，用到的地方先过一遍 */
  private sessionsReady = false;
  private ensureSessions(): void {
    if (this.sessionsReady) return;
    ensureSessionSchema(this.db);
    this.sessionsReady = true;
  }

  private remindersReady = false;
  private ensureReminders(): void {
    if (this.remindersReady) return;
    ensureReminderSchema(this.db);
    this.remindersReady = true;
  }

  /** 主动开口的攒话队列。同上：一次建好，之后每轮直接用。 */
  private speakReady = false;
  private ensureSpeak(): void {
    if (this.speakReady) return;
    ensureSpeakSchema(this.db);
    this.speakReady = true;
  }

  private notesReady = false;
  private ensureNotes(): void {
    if (this.notesReady) return;
    ensureNoteSchema(this.db);
    this.notesReady = true;
  }

  /** 同 feedback：事件台账也可能建在旧实例上，用到的地方先过一遍 */
  private eventsReady = false;
  private ensureEvents(): void {
    if (this.eventsReady) return;
    ensureEventSchema(this.db);
    this.eventsReady = true;
  }

  /** 冷启动记账：把启动时刻记进 DO 存储，两次相减即可区分例行重启与频繁驱逐。只记账，不改行为。 */
  private async recordBoot(): Promise<void> {
    const now = Date.now();
    const prev = (await this.ctx.storage.get<number[]>("bootAt")) ?? [];
    const last = prev.length ? prev[prev.length - 1] : 0;
    // -1 = 头一回，没有「距上次」可言
    const gap = last ? Math.round((now - last) / 60_000) : -1;
    await this.ctx.storage.put("bootAt", [...prev, now].slice(-20));
    console.log(
      `[boot] 冷启动第 ${prev.length + 1} 次` +
        (gap < 0 ? "（首次）" : `，距上次 ${gap} 分钟`),
    );
  }

  async onStart(): Promise<void> {
    await this.recordBoot();
    ensureMemorySchema(this.db);
    this.ensureFeedback();
    this.ensureSessions();
    this.ensureReminders();
    this.ensureSpeak();
    this.ensureNotes();
    this.ensureEvents();
    installRuntime(this);
    installMigration(this);
    // DO state 是持久化 blob，新字段不会自动补齐；这里补一次，保证 /api/config 始终有这两格。
    if (typeof this.state.basePrompt !== "string")
      this.patchState({ basePrompt: "" });
    // 旧版人设尾部粘着工具说明：拼提示词时剥掉不够，设置页读的是 state 原文。
    // 这里洗一次存量（不含该段则原样返回，幂等、不多写）。
    const cleanBase = stripToolGuide(this.state.basePrompt);
    if (cleanBase !== this.state.basePrompt)
      this.patchState({ basePrompt: cleanBase });
    // 服务向改版迁移：只把一字不差等于旧默认的稿子换成新稿，管理员真改过的不碰（见 migrateServiceCopy）。
    const migrated = migrateServiceCopy(this.state);
    if (Object.keys(migrated).length) this.patchState(migrated);
    // selfDemand 是后加字段：老实例补空串，面板看到「还没写过」而不是 undefined。
    if (typeof this.state.selfDemand !== "string")
      this.patchState({ selfDemand: "" });
    if (typeof this.state.selfDemandVer !== "number")
      this.patchState({ selfDemandVer: 0 });
    if (!Array.isArray(this.state.selfDemandLog))
      this.patchState({ selfDemandLog: [] });
    if (typeof this.state.activeSession !== "string")
      this.patchState({ activeSession: "" });
    // guestName 也是后加：identityBlock 每轮都读，缺这格来客一开口就整轮抛错。
    if (typeof this.state.guestName !== "string")
      this.patchState({ guestName: "" });
    // adminBio 也是后加：身份弹层每次展开都读，补空串避免在 undefined 上渲染。
    if (typeof this.state.adminBio !== "string")
      this.patchState({ adminBio: "" });
    // 工具提示词组是后加：补空 = 用 toolGroups.ts 出厂稿（旧的整块 toolPrompt 已摘掉）。
    if (typeof this.state.toolStyle !== "string")
      this.patchState({ toolStyle: "" });
    if (typeof this.state.guestToolStyle !== "string")
      this.patchState({ guestToolStyle: "" });
    if (!this.state.toolPrompts || typeof this.state.toolPrompts !== "object")
      this.patchState({ toolPrompts: {} });
    if (
      !this.state.toolGroupNotes ||
      typeof this.state.toolGroupNotes !== "object"
    )
      this.patchState({ toolGroupNotes: {} });
    if (
      !this.state.guestToolPrompts ||
      typeof this.state.guestToolPrompts !== "object"
    )
      this.patchState({ guestToolPrompts: {} });
    if (
      !this.state.guestToolGroupNotes ||
      typeof this.state.guestToolGroupNotes !== "object"
    )
      this.patchState({ guestToolGroupNotes: {} });
    if (typeof this.state.recapPrompt !== "string")
      this.patchState({ recapPrompt: "" });
    // asks 是后加：补空数组，否则 ask 首次执行会在 undefined 上炸掉。
    if (!Array.isArray(this.state.asks)) this.patchState({ asks: [] });
    // noteFocus 是后加：noteBlock 每轮都读，缺这格就整轮抛错。
    if (typeof this.state.noteFocus !== "string")
      this.patchState({ noteFocus: "" });
    // guestTypeId 是后加：补空串（= 普通票），onConnect 的档位比较不必碰 undefined。
    if (typeof this.state.guestTypeId !== "string")
      this.patchState({ guestTypeId: "" });
    this.dropLegacyFields();
    // 上次排程中途失败（表里写了但没有 schedule id）的提醒，这里补排一次
    void this.resyncReminders().catch(() => {});
    // 回想只在主人那间重排；先抹掉「老会话一律视为已回想」的历史回填 ——
    // 回想对所有场一视同仁，幂等：recap_at 非空的不动。
    if (this.isOwnerRoom) {
      resetLegacyRecapCursors(this.db);
      void resyncRecaps(this).catch(() => {});
    }
  }

  async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    // 纵深防御：Worker 的 routeAgentRequest 已校验，这里用同一套密钥独立再验。
    // 角色写进「连接」而不是 state：state 整个 DO 共用，连接每人一条不会串。
    const info = await verifyTokenInfo(this.env, authToken(ctx.request));
    if (!info) {
      conn.close(1008, "未登录");
      return;
    }
    const role: Role = info.role;
    conn.setState({ role });

    // 把这一场的历史推给刚连上的连接：客户端只在收到 cf_agent_chat_messages 时换新，
    // 新场屋是空的、没有新消息触发广播，不推就一直显示上一场的话。
    // 人屋切场同理：广播只到当时挂着的连接，后来连上的得自己补一份。
    conn.send(
      JSON.stringify({
        type: "cf_agent_chat_messages",
        messages: this.messages,
      }),
    );

    // 多档来客：票里带档位 id（v2/v3），每次连接现查快照 —— 只在 id 变化时查的话，
    // 管理员调低权益后旧房间仍拿旧快照。查不到/停用/失败都落兜底（见 currentGuestType）。
    // 没带档位的票（门禁口令进门）归内置通用档，管理员可按件收紧。
    if (role === "user") {
      const typeId = info.type || COMMON_TYPE_ID;
      this.patchState({
        guestTypeId: typeId,
        guestType: await this.currentGuestType(typeId),
      });
    }

    // 来客进门留痕并向主人那间报名册；报不上不影响接待，下次进门再报。
    // 进门只记在人屋：场屋的 isNewJoin 查本地账本，冷启动时表还没建。
    if (!this.isOwnerRoom) {
      if (!this.fixedSessionId && isNewJoin(this.db, this.name))
        this.logVisitor("join", "role=user");
      void this.registerToOwner().catch(() => {});
    }

    // 场屋和来客屋的人设得去主屋取（人设是共用的，理由见 personaForPrompt）
    if (ownerRoomOf(this.name)) await this.refreshPersona();

    // 场屋偏好（思考强度/嗓子/深度配置）住在人屋 state 里，起步时抄一份，否则回落出厂默认。
    // 抄的是这间场屋所属的人屋（ownerRoomOf）—— 来客的偏好是来客自己的。
    // 只在开荒那一次抄：之后场屋内改过的偏好不该被重连冲掉。
    if (this.fixedSessionId && !this.state.activeSession) {
      try {
        const dir = this.env.COWORK_AGENT.get(
          this.env.COWORK_AGENT.idFromName(ownerRoomOf(this.name)!),
        );
        const cfg = await dir.getConfig();
        this.patchState({
          thinkMode:
            cfg?.thinkMode === "deep" || cfg?.thinkMode === "normal"
              ? cfg.thinkMode
              : "deep",
          voice: typeof cfg?.voice === "string" ? cfg.voice : "",
          deepConfigId:
            typeof cfg?.deepConfigId === "string" ? cfg.deepConfigId : "",
          // 称呼一并带上：回寄留痕和名册报到都要标「这是谁」
          guestName: typeof cfg?.guestName === "string" ? cfg.guestName : "",
          // 签名跟人走、不跟场走：不抄的话场屋 identityBlock 读到空屋，
          // 管理员就成了没名没姓的「管理员本人」
          adminBio: typeof cfg?.adminBio === "string" ? cfg.adminBio : "",
        });
      } catch {
        // 抄不到（人屋没醒 / 出错）就用出厂默认，聊天照常
      }
    }

    const lastActive = this.state.lastActive || 0;
    if (lastActive && Date.now() - lastActive > IDLE_RESET_MS) {
      // 闲置超一个月不「清掉」而是归档：旧场留在会话列表；固定场（场屋）不做，一场到底。
      if (!this.fixedSessionId) {
        await this.startFreshPreliminary().catch(() => {});
        this.touchLastActive();
        this.notify("已闲置超过一个月，上一场对话已归档到会话列表。");
        return;
      }
    }

    this.touchLastActive();

    // 会话表在第一次连上时就建好，别等到用户去点会话列表
    this.ensureActiveSession();

    // 首次唤醒播种人格库与初始记忆 —— 只在主人那间，来客不该装主人的记忆和内核。
    if (
      this.isOwnerRoom &&
      !this.state.selfModel &&
      countMemories(this.db) === 0
    ) {
      this.patchState(seedPatch());
      for (const m of seedMemories()) {
        const entry = insertMemory(this.db, m);
        this.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });
      }
    }
  }

  // ── 状态与上下文 ──────────────────────────────────────

  patchState(patch: Partial<ChatState>): void {
    this.setState({ ...this.state, ...patch });
  }

  /**
   * 记下「他最后看的是哪间屋、哪一场」：多端登录时前端据此把新设备送回最后那一间。
   * 只收更晚的 at（多端并发写，旧时刻不能顶回新状态）；at 缺省/非法回落到此刻，兼容老前端。
   * room/session 都空 = 没在看特定的一场。
   */
  setLastView(room: string, session: string, at: number): ChatState {
    const when = Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now();
    if (!newerViewWins(this.state.lastViewAt ?? 0, when)) return this.state;
    this.patchState({
      lastRoom: room || "",
      lastSession: session || "",
      lastViewAt: when,
    });
    return this.state;
  }

  /** 上一次把 lastActive 落库的时刻（内存态，判据见 LAST_ACTIVE_FLUSH_MS） */
  private lastActiveFlushed = 0;
  /** 来客聊天的滑动窗口时间戳（只对来客房间有意义，见 onChatMessage 开头的限速） */
  private guestChatTimes: number[] = [];

  /** 报个时辰。内存里随时是新的，落库最多五分钟一次 —— 只为「他刚才在」写整份 blob 太贵。 */
  private touchLastActive(): void {
    const now = Date.now();
    if (now - this.lastActiveFlushed < LAST_ACTIVE_FLUSH_MS) return;
    this.lastActiveFlushed = now;
    this.patchState({ lastActive: now });
  }

  notify(text: string): void {
    try {
      this.broadcast(JSON.stringify({ type: "notice", text, ts: Date.now() }));
    } catch {
      // 没有连接时广播会抛错，忽略即可
    }
  }

  /** 把「她正在想什么」推给这间屋子连着的人。推不出去不是事故：界面上少一句话而已 */
  private emitThought(turn: number, line: string): void {
    try {
      this.broadcast(
        JSON.stringify({ type: "thought", turn, text: line, ts: Date.now() }),
      );
    } catch {
      // 没有连接时广播会抛错，忽略即可
    }
  }

  /** 翻「她正在想什么」的一次调用。这句有保质期：超时当没翻出来，宁可少说一句。 */
  private async thinkAsk(system: string, user: string): Promise<string> {
    const model = this.maintModel();
    if (!model) return "";
    try {
      const { text } = await generateText({
        model,
        system,
        prompt: user,
        maxOutputTokens: 80,
        abortSignal: AbortSignal.timeout(THINK_TIMEOUT),
      });
      return text.trim();
    } catch (e) {
      // 失败只记日志：「这个功能一直没生效」才有据可查
      console.error("[think] 这一句没翻出来：", e);
      return "";
    }
  }

  transcript(limit = 10): string {
    return this.messages
      .slice(-limit)
      .map((m) => `${m.role}: ${messageText(m).slice(0, 300)}`)
      .join("\n");
  }

  /**
   * 把指定一段消息编成人读得下的稿子（回想用）：起点由游标定，不由条数定。
   * 说话人写「用户/我」而不是 role —— 这一轮是他在读自己的事，不要像日志。
   */
  sessionTranscript(msgs: UIMessage[]): string {
    return msgs
      .map((m) => ({
        who: m.role === "user" ? "用户" : "我",
        text: messageText(m),
      }))
      .filter((l) => l.text)
      .map((l) => `${l.who}: ${l.text.slice(0, 400)}`)
      .join("\n");
  }

  /** 最近消息的 id + 摘要。赞踩与评论都按 message id 关联，工具要拿它定位消息。 */
  recentMessages(
    limit = 30,
  ): Array<{ id: string; role: string; text: string }> {
    return this.messages.slice(-limit).map((m) => ({
      id: m.id,
      role: m.role,
      text: messageText(m).slice(0, 200),
    }));
  }

  /**
   * 上下文压缩：久远部分折进摘要，只改「模型看到的窗口」，原文不动。
   * 摘要按会话存 sessions 表，切走再切回不丢；recall / 会话回顾仍翻得到完整原文。
   */
  private async compactContext() {
    this.ensureSessions();
    const id = this.state.activeSession;
    if (!id) return { tail: this.messages, digest: "" };

    const { digest: prev, upto } = getSessionDigest(this.db, id);
    const plan = planContext(this.messages, upto);
    if (!plan.compacted.length) return { tail: plan.keepAll, digest: prev };

    const transcript = plan.compacted
      .map((m) => `${m.role}: ${messageText(m).slice(0, 400)}`)
      .join("\n");
    const { system, user } = digestPrompt(prev, transcript);
    let newer = "";
    try {
      newer = (await this.maintenance(system, user)).trim();
    } catch {
      // 摘要服务抽风：这轮先不压，原文一条都不能丢
    }
    // 摘要没生成出来就不能压：压了却没有摘要，那段记忆就真的没了
    if (!newer) return { tail: plan.keepAll, digest: prev };

    const digest = newer.slice(0, DIGEST_MAX);
    setSessionDigest(this.db, id, digest, plan.upto);
    return { tail: plan.tail, digest };
  }

  async clearConversation(): Promise<void> {
    await this.persistMessages([], undefined, { _deleteStaleRows: true });
  }

  /** 清空当前这场：消息和压缩摘要一起清，否则摘要会描述一个已不存在的对话。 */
  async resetActiveSession(): Promise<void> {
    const id = this.state.activeSession;
    await this.clearConversation();
    if (id) setSessionDigest(this.db, id, "", "");
  }

  // ── 会话：列表 / 新建 / 切换 / 改名 / 删除 / 公开 ──────
  // 消息本体仍由 AIChatAgent 管（cf_ai_chat_agent_messages）；这里只管「哪一场」：切场 = 存旧 → 清空 → 灌新。
  // 借用 persistMessages 是因为对话主循环、工具调用、流式续传都挂在基类那张表上。

  /** 会话标题：拿第一句用户发言当名字，比「新会话」有用得多 */
  private deriveTitle(): string {
    const first = this.messages.find((m) => m.role === "user");
    const text = first ? messageText(first).replace(/\s+/g, " ").trim() : "";
    return text ? text.slice(0, 18) : "我们的对话";
  }

  /**
   * 让模型给这场起名（跑在 waitUntil，不占用户时间）：截首句往往只剩「在吗」这类半句。
   * 只起一次，之后不随话题改写；失败留空，下一轮再试。
   */
  private async nameSession(): Promise<void> {
    const id = this.state.activeSession;
    if (!id) return;
    const session = getSession(this.db, id);
    if (!session || session.named) return;

    const opening = this.messages.find((m) => m.role === "user");
    const answer = this.messages.find((m) => m.role === "assistant");
    const openingText = opening
      ? messageText(opening).replace(/\s+/g, " ").trim()
      : "";
    if (!openingText) return;

    // 起标题要认人：来客那几场不该被写成「管理员在问…」
    const guest = !this.isOwnerRoom;
    const raw = await this.quick(
      titleModel(this.env),
      titleSystem(guest),
      titlePrompt(
        openingText.slice(0, 300),
        answer
          ? messageText(answer).replace(/\s+/g, " ").trim().slice(0, 300)
          : "",
        guest,
      ),
      TITLE_PROVIDER_OPTIONS,
    );
    const title = tidyTitle(raw);
    // 模型给了名字就落定；给不出来（超时、网络抖）就留白，下一轮再试
    if (title) {
      renameSession(this.db, id, title);
      // 场屋定名：目录屋的指路牌行还叫占位名，回报过去跟着改
      this.reportHomeSessionUpdate(id, title);
    }
  }

  /**
   * 把当前对话写回所属会话（轮尾、切场、列列表时都调）。
   * 只有真写了新内容才报时辰 —— 列表按 last_active 排，点开看一眼不该让这场跳到最前。
   */
  private snapshotSession(): void {
    this.ensureSessions();
    const id = this.state.activeSession;
    if (!id || !getSession(this.db, id)) return;
    const changed = saveSessionMessages(this.db, id, this.messages);
    if (changed) {
      touchSession(this.db, id, new Date().toISOString());
      // 场屋落了新话：目录行时辰跟着走，侧栏才能按「哪场刚说话」排序
      if (this.fixedSessionId) this.reportHomeSessionUpdate(id);
    }
  }

  /**
   * 保证「当前有一个会话」，但只保证指向、不落库：指向在（含预备栏）就原样返回；
   * 没有指向时，老实例手上已有消息的立刻收进新会话，空台子只立预备栏。
   * 建行只有聊天入口（ensureRealSession）有权做 —— 读路径顺手 insert 会让列表越删越长。
   */
  private ensureActiveSession(): string {
    this.ensureSessions();
    // 场屋：屋名即场 id，指向永远是它；库里没有行说明还没人开口，落库交给聊天入口
    const fixed = this.fixedSessionId;
    if (fixed) {
      if (this.state.activeSession !== fixed)
        this.patchState({ activeSession: fixed });
      return fixed;
    }
    const current = this.state.activeSession;
    if (current && getSession(this.db, current)) return current;
    if (current) return current;

    const id = newSessionId();
    if (this.messages.length > 0) {
      insertSession(this.db, {
        id,
        title: this.deriveTitle(),
        visibility: "private",
        created: new Date().toISOString(),
        // 已带内容的算「早就有名字」；空的留给模型，等管理员开口那一轮起
        named: true,
      });
      this.patchState({ activeSession: id });
      saveSessionMessages(this.db, id, this.messages);
      return id;
    }
    // 空着手：只立预备栏。state 里存的是指向，库里还没有这一行
    this.patchState({ activeSession: id });
    return id;
  }

  /** 预备栏转正：真有话要说才落一行。只有聊天入口调它，读路径永远不许建行。 */
  private ensureRealSession(): string {
    const id = this.ensureActiveSession();
    if (getSession(this.db, id)) return id;
    insertSession(this.db, {
      id,
      title: this.deriveTitle(),
      visibility: "private",
      created: new Date().toISOString(),
      // 名字留给模型：第一轮答完它会看完开场白起一个更准的（nameSession）
      named: false,
    });
    saveSessionMessages(this.db, id, this.messages);
    // 场屋落位：回目录屋登记指路牌（幂等，点名的场不会被顶掉），存储仍在这间屋
    if (this.fixedSessionId) this.reportHomeRegistration(id);
    return id;
  }

  /**
   * 场屋落位回报：在目录屋登记指路牌（home 指回本屋，前端按它换连接），存储仍在本屋。
   * 报不上不拦聊天：侧栏晚点出现，消息一条不丢。
   */
  private reportHomeRegistration(id: string): void {
    const owner = ownerRoomOf(this.name);
    if (!owner) return; // 本屋就是目录屋：行已经在自己表里，不用报
    this.ctx.waitUntil(
      (async () => {
        const home = this.env.COWORK_AGENT.get(
          this.env.COWORK_AGENT.idFromName(owner),
        );
        await home.registerSessionIndex({
          id,
          title: this.deriveTitle(),
          home: this.name,
        });
      })().catch(() => {}),
    );
  }

  /**
   * 场屋回报目录屋：定名或又有了新话（只报时辰）。报不上不拦聊天，消息一条不丢。
   */
  private reportHomeSessionUpdate(id: string, title?: string): void {
    const owner = ownerRoomOf(this.name);
    if (!owner) return; // 本屋就是目录屋：行在自己表里，renameSession/touchSession 已经改过了
    this.ctx.waitUntil(
      (async () => {
        const home = this.env.COWORK_AGENT.get(
          this.env.COWORK_AGENT.idFromName(owner),
        );
        await home.updateSessionIndex({
          id,
          title: title || "",
          home: this.name,
        });
      })().catch(() => {}),
    );
  }

  /** 每轮回答结束、消息已落库之后再快照，这样存进去的才是完整的一轮 */
  protected async onChatResponse(result: ChatResponseResult): Promise<void> {
    // 这一轮结束了：节拍器收工，正文已出，不再翻「她正在想什么」
    this.thinker.end();
    // 先把悬空的工具调用收干净，历史、界面、下一轮 API 三边才对得上
    await this.healDanglingToolCalls();
    // 断没断、为什么断：翻成人话写进 state.turnErrors，借 setState 落库并实时同步，
    // 界面按 messageId 挂在那一轮下面（见 web 的 TurnErrorCard）
    this.reportTurnError(result);
    // 统计和额度都在这儿收口：一轮写一次，而不是每条语句、每次工具调用写一次
    this.flushToolStats();
    // 状态原样进日志：aborted 与 skipped 界面上一样，排障时是两回事
    this.meter.turn(
      result.status === "completed" ? "回答" : `中断(${result.status})`,
    );
    this.flushUsage();
    if (result.status === "completed") {
      this.snapshotSession();
      // 场屋轮尾寄原话索引回主屋：跨场 recall 靠它（消息本体不动，只寄目录行）
      this.syncRecallIndex();
      // 有人说话了：这一场休息态计时从头开始，每轮整体重设 = 「最后一次发言后半小时」。
      // 只在主人那间（来客那几场没有「她自己回头看」）
      if (this.isOwnerRoom && this.state.activeSession)
        this.ctx.waitUntil(
          scheduleRecap(this, this.state.activeSession).catch(() => {}),
        );
      // 起标题要在回答之后，但绝不让人等 —— 丢进 waitUntil，晚半拍出现即可
      this.ctx.waitUntil(this.nameSession().catch(() => {}));
    }
  }

  /**
   * 把这一轮的原始死因翻成人话，追加进 state.turnErrors。
   * 采集点见 onChatMessage：流级 onError、abortSignal、onFinish 的 finishReason；全正常时不写。
   * raw 是给开发者的原始报文（界面折叠）。
   */
  private reportTurnError(result: ChatResponseResult): void {
    const desc = describeTurn({
      status: result.status,
      capture: this.turnCapture,
    });
    // 消费掉：这一轮的死因不能漏进下一轮
    this.turnCapture = null;
    if (!desc) return;
    const entry: TurnError = {
      // 断在还没吐出任何内容时消息没落库，messageId 留空 —— 界面按尾部落单条告警
      messageId: result.message?.id ?? "",
      sessionId: this.state.activeSession,
      at: Date.now(),
      ...desc,
    };
    this.patchState({
      turnErrors: appendTurnError(this.state.turnErrors, entry),
    });
  }

  /**
   * 收尾兜底：把「有调用、没结果」的悬空工具卡补成诚实的失败（output-error）。
   * 悬空历史违反 Anthropic use/result 成对要求，轻则模型困惑，重则下一轮整轮发不出去。
   * approval-requested / approval-responded 是合法等待，不动。
   */
  private async healDanglingToolCalls(): Promise<void> {
    const dangling = new Set<string>(["input-streaming", "input-available"]);
    const note =
      "（中断兜底）这一步没有跑成、结果未知 —— 多半是轮次中断或参数太长被截断。" +
      "别当它已生效；要重做就简化内容后再调用一次。";
    let changed = false;
    const healed = this.messages.map((m) => {
      if (!m.parts?.length) return m;
      let msgChanged = false;
      const parts = m.parts.map((p) => {
        const part = p as unknown as {
          type: string;
          state?: string;
          errorText?: string;
          input?: unknown;
        };
        const isTool =
          part.type.startsWith("tool-") || part.type === "dynamic-tool";
        if (!isTool || !part.state) return p;
        const hasInput = !!part.input && typeof part.input === "object";
        // 两件事都要管：悬空调用补成失败；旧账里 output-error 却没有 input 的也要修，
        // 不修这一场永远发不出去。
        const heal = dangling.has(part.state);
        const repairInput = part.state === "output-error" && !hasInput;
        if (!heal && !repairInput) return p;
        msgChanged = true;
        // 空 input 进历史会让整场发不出去：序列化成 tool_use 时 input 字段消失（AI SDK 取
        // part.input ?? part.rawInput），严格厂商（DeepSeek 的 /anthropic 兼容端）直接 422
        // 「missing field input」，此后每轮都被拒。补空对象后界面仍显示红色「出错」。
        return {
          ...(p as object),
          state: "output-error",
          errorText: part.errorText || note,
          input: hasInput ? part.input : ({} as object),
        } as typeof p;
      });
      if (!msgChanged) return m;
      changed = true;
      return { ...m, parts };
    });
    // 只在真有悬空时才写：这里每轮都进来，没事就是纯读
    if (changed) await this.persistMessages(healed);
  }

  /** 断线续跑前清场：先把悬空调用补成「没跑成」，否则 Anthropic 因 use/result 不成对拒掉整个请求。 */
  override async _chatRecoveryContinue(data?: {
    targetAssistantId?: string;
  }): Promise<void> {
    await this.healDanglingToolCalls();
    await super._chatRecoveryContinue(data);
  }

  /** 会话列表（管理员看全部）。顺带把当前对话存一份，列表里的时间才是新的。 */
  listAllSessions(): SessionMeta[] {
    this.ensureActiveSession();
    this.snapshotSession();
    return listSessions(this.db);
  }

  /** 被标成公开的会话（只列元信息）。入口暂时收着：来客只看自己那几场，目前只有管理员够得到。 */
  listOpenSessions(): SessionMeta[] {
    this.ensureSessions();
    return listPublicSessions(this.db);
  }

  /** 读一场公开会话的正文。只给纯文本，工具调用的原始数据不外泄。归档过的不再对外可读。 */
  readOpenSession(id: string): {
    meta: SessionMeta;
    messages: Array<{ id: string; role: string; text: string }>;
  } | null {
    this.ensureSessions();
    const meta = getSession(this.db, id);
    if (!meta || meta.visibility !== "public" || meta.archived) return null;
    const messages = loadSessionMessages(this.db, id)
      .map((m) => ({
        id: m.id,
        role: m.role,
        text: messageText(m).slice(0, 4000),
      }))
      .filter((m) => m.text);
    return { meta, messages };
  }

  /**
   * 夜间整理的全站读取口：主屋按目录逐场调用，场屋只回本场游标之后的消息。
   * 这里不做模型调用，也不写对话；整理由主屋统一做一次。
   */
  async nightlyDigest(sinceMs: number): Promise<{
    title: string;
    lastActive: string;
    messages: Array<{ role: string; text: string }>;
  } | null> {
    const id = this.fixedSessionId;
    if (!id) return null;
    const s = getSession(this.db, id);
    if (!s || s.archived) return null;
    const at = new Date(s.lastActive || 0).getTime();
    if (!Number.isFinite(at) || at <= sinceMs) return null;
    const messages = loadSessionMessages(this.db, id)
      .slice(-NIGHTLY_MESSAGES)
      .map((m) => ({
        role: m.role,
        text: messageText(m).slice(0, NIGHTLY_TEXT),
      }))
      .filter((m) => m.text);
    return messages.length
      ? { title: s.title, lastActive: s.lastActive, messages }
      : null;
  }

  /**
   * 换会话前把正在说的那一轮收干净：推进轮次代际，让迟到的结果被跳过，
   * 顺手清掉客户端「正在回应…」，否则新一场开局就是忙碌态。
   */
  private settleTurn(): void {
    try {
      this.resetTurnState();
    } catch {
      // 基类内部状态对不上，也不该拦住换会话这件事
    }
  }

  /** 目录屋的闲置路径：收好眼前、指向新的预备栏（空场不占侧栏）；不建新屋。 */
  private async startFreshPreliminary(): Promise<void> {
    this.ensureActiveSession();
    this.settleTurn();
    this.snapshotSession();
    await this.clearConversation();
    this.patchState({ activeSession: newSessionId() });
  }

  /**
   * 开新会话 = 开一间新场屋（一会话一运行时），本屋不动，多场并行由此而来。
   * 点名或要公开的当场落目录行（home 指向新屋）；没点名的等第一句话落位时自己登记。
   * 两种情况都回完整 meta，前端拿 home 去开新连接。
   */
  async createSession(
    title?: string,
    visibility?: SessionVisibility,
  ): Promise<SessionMeta | null> {
    // 场屋里没有「新对话」：这里的场是屋名定死的，开新场得回目录屋（人屋）
    if (this.fixedSessionId) return null;

    this.ensureSessions();
    const id = newSessionId();
    const home = sessionRoom(this.name, id);
    // 只算好 id 和屋名，不建 stub（不实例化 DO 不花钱）；第一句话到达时它才冷起，
    // 而那句话正好落进新屋的第一轮。没人说过话的场，就不会有屋。
    const now = new Date().toISOString();
    const wanted = (title || "").trim();
    const finalVisibility: SessionVisibility =
      visibility === "public" ? "public" : "private";
    if (wanted || finalVisibility === "public") {
      insertSession(this.db, {
        id,
        title: wanted || "新会话",
        visibility: finalVisibility,
        created: now,
        // 有人点名要的名字就定住；没给名字的留给模型，等第一轮答完起
        named: !!wanted,
        home,
      });
    }
    return {
      id,
      title: wanted || "新会话",
      visibility: finalVisibility,
      created: now,
      lastActive: now,
      pinned: "",
      msgCount: 0,
      hasDigest: false,
      archived: false,
      named: !!wanted,
      unread: false,
      recapAt: "",
      home,
    };
  }

  /**
   * 我自己开一场（不进他当前这场、不掀走他）：不复用 createSession，因为它会切换当前对话。
   * 新场带未读记号，直到他点进去 —— 否则多一行和一次普通刷新没区别。
   */
  async openSession(input: {
    content: string;
    title?: string;
  }): Promise<SessionMeta> {
    // 场屋不另开场：她主动开的场落在目录屋，否则指路牌与人屋目录对不上
    const owner = ownerRoomOf(this.name);
    if (owner) {
      const home = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(owner),
      );
      const opened = await home.openSession(input);
      this.notify(`我另开了一场：「${opened.title}」`);
      return opened;
    }
    this.ensureSessions();
    this.ensureSpeak();
    const content = input.content.trim();
    const title =
      (input.title || "").replace(/\s+/g, " ").trim().slice(0, 24) ||
      content.slice(0, 18) ||
      "我找你有点事";
    const id = newSessionId();
    const now = new Date().toISOString();
    // named=1：名字就是这次的由头，别被第一句话摘要改写
    insertSession(this.db, {
      id,
      title,
      visibility: "private",
      created: now,
      named: true,
    });
    appendSessionMessage(this.db, id, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: content }],
    });
    markSessionUnread(this.db, id);
    // 主动开口的记账：面板「今天她说几次」要算上这一场，否则数字会莫名掉下来
    markSaysDelivered(this.db, [enqueueSay(this.db, id, content).id]);
    this.notify(`我另开了一场：「${title}」`);
    return getSession(this.db, id)!;
  }

  /** 切到另一场。先存旧的再载新的，中途失败也不会丢当前这场。 */
  async switchSession(id: string): Promise<SessionMeta | null> {
    // 场屋一辈子只有一场：屋名定死了，切来切去都是它
    const fixed = this.fixedSessionId;
    if (fixed) {
      this.ensureSessions();
      return getSession(this.db, fixed);
    }
    this.ensureActiveSession();
    if (id === this.state.activeSession) return getSession(this.db, id);

    const target = getSession(this.db, id);
    if (!target) return null;

    // 旧场共用一间屋，运行中不能替换历史；导航不应隐式中断原任务。
    if (this._activeStreamId || this.chatIngress?.running)
      throw new Error(SESSION_RUNNING_MESSAGE);
    this.settleTurn();
    this.snapshotSession();
    await this.clearConversation();
    const restored = loadSessionMessages(this.db, id);
    if (restored.length) await this.persistMessages(restored);
    this.patchState({ activeSession: id });
    // 这里不报时辰：点开看一眼不算「这场又聊过了」，否则列表顺序被「谁被点过」决定。
    // 点开即视为看过，顺手清未读。
    markSessionRead(this.db, id);
    return getSession(this.db, id);
  }

  renameSession(id: string, title: string): SessionMeta | null {
    this.ensureSessions();
    const clean = title.trim().slice(0, 40);
    if (!clean || !renameSession(this.db, id, clean)) return null;
    return getSession(this.db, id);
  }

  /**
   * 跨会话回忆：在全部历史会话里按关键词翻，返回命中片段（带会话名与说话人）。
   * 场屋翻两处：本屋 + 主屋（老场 + 各场寄回的原话索引）——「上次」可能在别的场。
   */
  async recall(query: string): Promise<RecallHit[]> {
    this.ensureSessions();
    const q = (query || "").trim().slice(0, 40);
    if (!q) return [];
    const mine = searchMessages(this.db, q, 8);
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return mine;
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      const theirs = (await owner.recallAcross(q, 8).catch(() => [])) || [];
      const seen = new Set(
        mine.map((h) => `${h.sessionId}|${h.role}|${h.message}`),
      );
      for (const h of theirs) {
        const key = `${h.sessionId}|${h.role}|${h.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          mine.push(h);
        }
      }
    } catch {
      // 主屋没醒就翻本场那一份，照答不误
    }
    return mine;
  }

  /** 记忆检索统一入口的轮内缓存（key = 检索词）。跟 recallCache 一起，一轮一清。 */
  private readonly mergedCache = new Map<string, MemEntry[]>();

  /** 已把第几条消息寄回主屋做原话索引（内存游标；重启归零，靠主屋幂等去重兜住） */
  private recallCursor = 0;

  /**
   * 记忆检索统一入口：本地 +（场屋）主屋远端，按 id 合并。主屋是汇聚点、状态最新，优先；
   * 本地只补主屋没有的（刚记下、主屋还没收到账的靠它兜底）。
   */
  private async searchMemoriesMerged(
    q: string,
    limit: number,
    opts?: { includeSuperseded?: boolean },
  ): Promise<MemEntry[]> {
    const key = `${opts?.includeSuperseded ? "s:" : ""}${limit}:${q}`;
    const cached = this.mergedCache.get(key);
    if (cached) return cached;
    const local = await searchMemories(
      this.db,
      this.env,
      q,
      limit,
      opts ?? {},
    ).catch(() => [] as MemEntry[]);
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return local;
    let remote: MemEntry[] = [];
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      remote = (await owner.searchMemoriesFor(q, limit).catch(() => [])) || [];
    } catch {
      // 主屋没醒：本地那份照用
    }
    const byId = new Map<string, MemEntry>();
    for (const e of remote) if (e?.id) byId.set(e.id, e);
    for (const e of local) if (e?.id && !byId.has(e.id)) byId.set(e.id, e);
    const merged = [...byId.values()].slice(0, limit);
    this.mergedCache.set(key, merged);
    return merged;
  }

  /**
   * 记忆盘点：场屋以主屋那份为全局，取不到退回本地盘（少报胜过把有记忆说成空）。
   * 主屋本尊与来客房只盘本地 —— 前者的本地即全局，后者另有 public 门。
   */
  private async statsMemoriesMerged(): Promise<MemoryStats> {
    const local = memoryStats(this.db);
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return local;
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      const remote = await owner.memoryStatsFor();
      return remote && (remote.total || !local.total) ? remote : local;
    } catch {
      return local;
    }
  }

  /**
   * 记忆书架浏览：本地 +（场屋）主屋远端，按 id 合并去重、主屋优先。
   * 规则与 search/stats 一致 —— 三条读路对得上，才不会「搜得到却说没有」。
   */
  private async listMemoriesMerged(
    shelf: string | undefined,
    limit: number,
    opts?: { includeSuperseded?: boolean },
  ): Promise<MemEntry[]> {
    const local = listMemories(this.db, shelf, limit, opts ?? {});
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return local;
    let remote: MemEntry[] = [];
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      remote =
        (await owner
          .listMemoriesFor(shelf, limit, !!opts?.includeSuperseded)
          .catch(() => [])) || [];
    } catch {
      // 主屋没醒：本地那份照用
    }
    const byId = new Map<string, MemEntry>();
    for (const e of remote) if (e?.id) byId.set(e.id, e);
    for (const e of local) if (e?.id && !byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].slice(0, limit);
  }

  setSessionVisibility(
    id: string,
    visibility: SessionVisibility,
  ): SessionMeta | null {
    this.ensureSessions();
    if (!setSessionVisibility(this.db, id, visibility)) return null;
    return getSession(this.db, id);
  }

  /** 收起/展开：归档只挪出列表，内容与摘要不动，recall 照样搜得到，所以无需恢复逻辑。 */
  setSessionArchived(id: string, archived: boolean): SessionMeta | null {
    this.ensureSessions();
    if (!setSessionArchived(this.db, id, archived)) return null;
    return getSession(this.db, id);
  }

  /** 置顶只影响侧栏分段，与归档、公开无关，无连带处理。 */
  setSessionPinned(id: string, pinned: boolean): SessionMeta | null {
    this.ensureSessions();
    if (!setSessionPinned(this.db, id, pinned)) return null;
    return getSession(this.db, id);
  }

  /** 删一场。删的是当前场就清空并立预备栏（不立刻建行）—— 等真的开口才转正。 */
  async deleteSession(
    id: string,
  ): Promise<{ removed: boolean; active: string }> {
    this.ensureActiveSession();
    if (!getSession(this.db, id))
      return { removed: false, active: this.state.activeSession };

    const wasActive = id === this.state.activeSession;
    removeSession(this.db, id);

    if (!wasActive) return { removed: true, active: this.state.activeSession };

    await this.clearConversation();
    const next = newSessionId();
    this.patchState({ activeSession: next });
    return { removed: true, active: next };
  }

  // ── 提醒：到点自己回来找你 ────────────────────────────
  // 调度交给基类 schedule()：落在 SDK 表里，驱逐后照样按时唤醒；本表只记提醒内容、场次与 schedule id。
  // 与 task 的分工：task 是「要做什么」，remind 是「什么时候想起它」。

  /**
   * 定一条提醒。every 非空 = 重复（cron），否则一次性（绝对时刻）。
   * urgent 只对一次性有意义：重复提醒是他自己排的作息，本就不受安静时段管。
   * 表里记「他要求的时刻」，排程才是「实际开口时刻」，不混成一个字段。
   */
  async scheduleReminder(input: {
    what: string;
    at: string;
    every: string;
    urgent: boolean;
    /** 到点在哪儿说：same = 回到约定它的那一场（默认），new = 另开一场 */
    mode?: "same" | "new";
    /** mode = new 时那一场的名字 */
    title?: string;
  }): Promise<Reminder> {
    this.ensureReminders();
    if (countPendingReminders(this.db) >= REMINDER_CAP) {
      throw new Error(
        `待触发的提醒已经有 ${REMINDER_CAP} 条了，先清掉一些再定新的`,
      );
    }

    const when = new Date(input.at);
    if (Number.isNaN(when.getTime())) {
      throw new Error(
        `时间看不懂：${input.at}（要 ISO 8601，例如 2026-09-20T09:00:00+08:00）`,
      );
    }
    if (!input.every && when.getTime() <= Date.now()) {
      throw new Error(`这个时间已经过去了：${input.at}`);
    }

    const id = newReminderId();
    const sessionId = this.ensureActiveSession();
    const mode = input.mode === "new" ? "new" : "same";
    const urgent = !!input.urgent && !input.every;
    // 一次性走绝对时刻、重复走 cron —— SDK 两条唤醒路径不能混。cron 按 UTC 解释，
    // 排程与重启自愈（resyncReminders）必须用同一个换算，否则醒来对不上点
    const handle = input.every
      ? await this.schedule(shanghaiEveryToCron(input.every), "fireReminder", {
          id,
        })
      : await this.schedule(when, "fireReminder", { id });

    try {
      insertReminder(this.db, {
        id,
        sessionId,
        what: input.what.slice(0, 300),
        at: input.at,
        every: input.every,
        scheduleId: handle.id,
        created: new Date().toISOString(),
        urgent,
        mode,
        title: mode === "new" ? (input.title || "").slice(0, 24) : "",
      });
    } catch (e) {
      // 业务行没落库就撤掉调度：否则留下指向不存在 id 的孤立任务，白醒一次还白占写行
      await this.cancelSchedule(handle.id).catch(() => {});
      throw e;
    }
    return getReminder(this.db, id)!;
  }

  listReminders(): Reminder[] {
    this.ensureReminders();
    return listPendingReminders(this.db);
  }

  /** 取消。先标表再撤调度：万一 cancelSchedule 没撤干净，fireReminder 的状态检查也兜得住。 */
  cancelReminder(id: string): boolean {
    this.ensureReminders();
    const r = cancelReminderRow(this.db, id);
    if (!r) return false;
    if (r.scheduleId) void this.cancelSchedule(r.scheduleId).catch(() => {});
    return true;
  }

  /** onStart 自愈：表里 pending 却没排上程的（上次中途失败），重新排一次。 */
  private async resyncReminders(): Promise<void> {
    this.ensureReminders();
    for (const r of listPendingReminders(this.db)) {
      if (r.scheduleId) continue;
      const when = new Date(r.at);
      if (Number.isNaN(when.getTime())) continue;
      try {
        if (r.every) {
          const h = await this.schedule(
            shanghaiEveryToCron(r.every),
            "fireReminder",
            { id: r.id },
          );
          setReminderScheduleId(this.db, r.id, h.id);
        } else if (when.getTime() > Date.now()) {
          const h = await this.schedule(when, "fireReminder", { id: r.id });
          setReminderScheduleId(this.db, r.id, h.id);
        }
      } catch {
        // 单条排不上不该影响启动
      }
    }
  }

  /**
   * 到点被 SDK 叫醒。安静时段里一次性提醒按到早上，重复提醒照说：
   * 重复的时刻是他排的作息，替他挪是自作主张；一次性多半是「三小时后叫我」，他要的是别忘了。
   */
  async fireReminder(payload: { id: string }): Promise<void> {
    // 同一提醒的两次唤醒只投一次：durable queue 会重投，实例重建的自愈也会补投；
    // 「已投递」要等说完话才落账，中间这段重叠就是重复提醒。
    if (this._firingReminders.has(payload.id)) return;
    this._firingReminders.add(payload.id);
    try {
      await this.fireReminderOnce(payload.id);
    } finally {
      this._firingReminders.delete(payload.id);
    }
  }

  /** 在途的提醒 id：两次唤醒只投一次 */
  private _firingReminders = new Set<string>();

  private async fireReminderOnce(id: string): Promise<void> {
    this.ensureReminders();
    const r = getReminder(this.db, id);
    if (!r || r.status !== "pending") return;

    const end = quietEndsAt();
    if (end && !r.every && !r.urgent) {
      await this.holdReminder(r, end);
      return;
    }

    // 原定点落在安静时段才交代一句，否则他会以为我把时间搞错了
    const late = inQuietHours(new Date(r.at)) ? r.at : "";
    const line = await this.reminderLine(r, late);
    // 落点分两种：回原来那一场，或另立一场（定时会话）
    if (r.mode === "new") {
      await this.openSession({ content: line, title: r.title || r.what });
    } else {
      await this.utter(r.sessionId, line);
    }
    markReminderFired(this.db, r.id, new Date().toISOString());
  }

  /**
   * 把一条提醒按到安静时段结束：只挪排程，不改表里的 at（那是他的原话）。
   * 状态仍是 pending，中途出岔子由 onStart 的自愈捞回。
   */
  private async holdReminder(r: Reminder, until: Date): Promise<void> {
    if (r.scheduleId) await this.cancelSchedule(r.scheduleId).catch(() => {});
    const handle = await this.schedule(until, "fireReminder", { id: r.id });
    setReminderScheduleId(this.db, r.id, handle.id);
  }

  /** 主动开口的统一入口（提醒与盯梢）：攒一分半再说，把同时醒的几条合成一句话。 */
  private async utter(sessionId: string, line: string): Promise<void> {
    if (!line.trim()) return;
    this.ensureSpeak();
    enqueueSay(this.db, sessionId, line);
    // 同一时刻只有一个待执行的 flush（schedule 按名+参数去重），这一分半攒的一起说
    await this.schedule(
      new Date(Date.now() + SAY_DEBOUNCE_MS),
      "flushSays",
      {},
      { idempotent: true },
    ).catch(() => {});
  }

  /** SDK 到点叫我：把攒着的说出去。 */
  async flushSays(): Promise<void> {
    // 并发 flush 共用一次投递：speak 是 await，各读一遍 pending 会把同批话说两遍
    return (this._flushingSays ??= this.deliverSays().finally(() => {
      this._flushingSays = null;
    }));
  }

  /** 在途的一次投递：并发的 flush 都接同一个 promise */
  private _flushingSays: Promise<void> | null = null;

  private async deliverSays(): Promise<void> {
    this.ensureSpeak();
    const pending = listPendingSays(this.db);
    if (!pending.length) return;
    // 没进他当前那一场对话流的那些句话：他此刻不在跟前的证据，攒起来一起寄一份
    const missed: string[] = [];
    for (const m of mergeSays(pending)) {
      let where: SayWhere;
      try {
        where = await this.speak(m.sessionId, m.line);
      } catch {
        // 说失败就先留着，下次 flush 再试 —— 宁可重复一次，也不能把它弄丢
        return;
      }
      if (where !== "live") missed.push(m.line);
      markSaysDelivered(this.db, m.ids);
    }
    pruneSays(this.db);
    if (missed.length) await this.mailMissedSays(missed);
  }

  /**
   * 人不在界面前时，把这批主动消息另寄一份邮箱。
   * 「不在」看这句有没有进他当前那一场，不赌 WebSocket 计数（测不到、无法写成用例）。
   * 一批一封（连珠炮邮件只会让人关掉这档）；寄不动只进发件箱流水，不改界面那条的账。
   */
  private async mailMissedSays(lines: string[]): Promise<void> {
    // 空批次不拨号，别占额度
    if (!lines.length) return;
    if (!getMailConfigView(this.db, this.secretBag).sayMail) return;
    const subject =
      lines.length === 1
        ? "ericher：有一条话你没在界面前听到"
        : `ericher：有 ${lines.length} 条话你没在界面前听到`;
    const text = `${lines.map((l) => `- ${l}`).join("\n")}\n\n` +
      `（这些是我在你没开着界面的时候想说的，界面上那条也照样记在你那一场里了。）`;
    const r = await this.sendMailViaOwnerRoom({ subject, text, source: "say" });
    if (!r.ok) console.warn("[mail] 主动消息的邮件副本没寄出", r.error);
  }

  /**
   * 把话说出口：他正开着目标那场就进对话流，否则只写进那场历史（不打断当前话题）。
   * 那场已删则丢弃这句、连 notice 也不发 —— 宁可丢，不串场；提醒自身的账照记。
   */
  private async speak(sessionId: string, line: string): Promise<SayWhere> {
    const msg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: line }],
    };

    const target = sessionId ? getSession(this.db, sessionId) : null;
    // 落点在此定下，不重读 state：persistMessages 是 await，期间可能已换场，
    // 重算会把「当场进了流」误判成没进，多寄一封
    const where: SayWhere =
      target && sessionId === this.state.activeSession ? "live" : target ? "history" : "dropped";
    if (where === "live") {
      await this.persistMessages([...this.messages, msg]);
    } else if (where === "history") {
      appendSessionMessage(this.db, sessionId, msg);
      touchSession(this.db, sessionId, new Date().toISOString());
    } else {
      // 目标会话已删：原先会塞进当前对话造成串场。宁可丢，不串。
      console.warn("[speak] 目标会话已删，这句话不落任何一场", { sessionId });
      return "dropped";
    }
    this.notify(line.slice(0, 140));
    return where;
  }

  /** 今天主动开口的次数（面板用）：数字大了，他会知道该关掉几条盯梢。 */
  proactiveStats(): { today: number; quietNow: boolean } {
    this.ensureSpeak();
    return {
      today: countSaysSince(this.db, beijingDayStart()),
      quietNow: inQuietHours(),
    };
  }

  /**
   * 到点说的那句话。lateFrom 非空 = 被安静时段按过，话里要交代一句，
   * 否则他只会觉得我把时间搞错了。
   */
  private async reminderLine(r: Reminder, lateFrom = ""): Promise<string> {
    const held = lateFrom
      ? `注意：这条本来定在 ${lateFrom}（那个点我在安静时段，没吵你），我压到现在才说 ——` +
        "开头用一句自然的话把这件事交代掉，别用「延迟」「系统」「补偿」这类词。"
      : "";
    const text = await this.maintenance(
      "你是 ericher。用户之前和你约好，到这个时间要提醒他一件事，现在时间到了。" +
        "用第一人称说一句话，口语、简短、把事说清。不要用「系统提醒」「提醒您」「您」这类词，" +
        "不要复述这条指令，不要解释你是怎么被触发的，直接说事。" +
        held +
        "只输出这一句话。",
      `约定的内容：${r.what}${r.every ? "（这是重复提醒，以后还会再提）" : ""}`,
    );
    return (
      text ||
      (lateFrom
        ? `昨晚 ${lateFrom} 那件事我一直记着：${r.what}`
        : `想起一件事：${r.what}`)
    );
  }

  enqueueVector(entry: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  }): void {
    // 走 queue 保证失败重试；向量化失败不应阻塞对话
    this.queue("vectorizeMemory", entry, { retry: { maxAttempts: 5 } }).catch(
      () => {},
    );
    // 管理员的场屋：每条记忆寄快照回主屋并账（主屋是汇聚点）。同一个 durable queue 失败重试；
    // 回调时再取快照，寄出的是落库后的最终状态
    if (ownerRoomOf(this.name) === OWNER_AGENT)
      this.queue(
        "syncMemoryHome",
        { ids: [entry.id], deletedIds: [] },
        {
          retry: { maxAttempts: 5 },
        },
      ).catch(() => {});
  }

  /** queue 回调：把场屋动过的记忆寄回主屋并账（新增走 enqueueVector 顺带，变更走 syncMemories） */
  async syncMemoryHome(payload: {
    ids: string[];
    deletedIds: string[];
  }): Promise<void> {
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return;
    const ids = (Array.isArray(payload?.ids) ? payload.ids : []).slice(0, 60);
    const deletedIds = (
      Array.isArray(payload?.deletedIds) ? payload.deletedIds : []
    ).slice(0, 60);
    const entries = ids
      .map((id) => getMemory(this.db, id))
      .filter((e): e is MemEntry => !!e);
    if (!entries.length && !deletedIds.length) return;
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    await owner.acceptMemorySync({ entries, deletedIds });
  }

  /** 场屋记忆变更的并账口（给工具用）：变更不产生新向量，也得走 durable queue 让主屋收到。 */
  queueMemorySync(ids: string[], deletedIds: string[] = []): void {
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return;
    if (!ids.length && !deletedIds.length) return;
    this.queue(
      "syncMemoryHome",
      { ids, deletedIds },
      {
        retry: { maxAttempts: 5 },
      },
    ).catch(() => {});
  }

  /**
   * 轮尾把新落的原话寄回主屋做跨场 recall 索引（消息本体不动，只寄目录行）。
   * 游标在内存：重启归零，首轮全量重寄，主屋按消息 id 幂等去重。
   */
  private syncRecallIndex(): void {
    if (ownerRoomOf(this.name) !== OWNER_AGENT) return;
    const sessionId = this.fixedSessionId;
    if (!sessionId) return;
    const fresh = this.messages.slice(
      Math.min(this.recallCursor, this.messages.length),
    );
    this.recallCursor = this.messages.length;
    const now = new Date().toISOString();
    const rows: RecallIndexRow[] = [];
    for (const m of fresh) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (!m.id) continue;
      const text = messageText(m).slice(0, 500);
      if (!text.trim()) continue;
      rows.push({ id: m.id, sessionId, role: m.role, text, ts: now });
    }
    if (!rows.length) return;
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    this.ctx.waitUntil(
      owner
        .acceptRecallMessages({ roomId: this.name, messages: rows })
        .catch(() => {}),
    );
  }

  /** queue 回调：写入 Vectorize */
  async vectorizeMemory(payload: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  }): Promise<void> {
    await upsertVector(this.env, payload);
  }

  async maintenance(system: string, user: string): Promise<string> {
    return this.quick(await this.resolveMaintModel(), system, user);
  }

  /** 一句话的小活（夜间整理、起标题、拟提醒措辞）：出任何差错都当没干过，绝不拖住主对话。 */
  private async quick(
    model: LanguageModel | null,
    system: string,
    user: string,
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"],
  ): Promise<string> {
    if (!model) return "";
    try {
      const { text } = await generateText({
        model,
        system,
        prompt: user,
        providerOptions,
      });
      return text.trim();
    } catch (e) {
      // 失败只记日志：一声不吭会让「功能一直没生效」查不出原因
      console.error("[quick] 小活没干成：", e);
      return "";
    }
  }

  /**
   * 打断这一轮：客户端只断得掉自己发起的请求，刷新后恢复的推流得服务端补刀。
   * 已说出口的部分保留。
   */
  async stopGenerating(): Promise<boolean> {
    try {
      this.abortAllRequests();
      return true;
    } catch {
      return false;
    }
  }

  async organize(): Promise<string> {
    if (this.messages.length <= 10) return "消息不足 10 条，无需整理。";
    const before = this.messages.length;
    const summary = {
      ts: new Date().toISOString(),
      summary: this.transcript(10).slice(0, 800),
      msgCount: before,
    };
    const summaries = [...this.state.summaries, summary].slice(-20);
    this.patchState({ summaries });

    const digest = await this.maintenance(
      "从以下会话摘要中提取 1-2 条值得长期记住的洞察。只输出洞察本身，每行一条。没什么值得记的就输出 SKIP。",
      summaries
        .slice(-5)
        .map((s) => s.summary)
        .join("\n---\n"),
    );
    let saved = 0;
    if (digest && !digest.includes("SKIP")) {
      for (const line of digest
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 2)) {
        const entry = insertMemory(this.db, {
          type: "insight",
          content: line.slice(0, 300),
          shelf: "reflections",
        });
        this.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });
        saved++;
      }
    }
    return `已整理：${before} 条对话压缩为摘要（累计 ${summaries.length} 条），新增 ${saved} 条洞察记忆。`;
  }

  /**
   * 全站夜间整理：主屋把各场新消息与邮箱流水拼成一份材料，只在这里烧一次维护模型。
   * 不写对话；游标与日志由 runtime 负责。
   */
  async globalNightlyOrganize(material: string): Promise<number> {
    if (!material.trim()) return 0;
    const digest = await this.maintenance(
      "从以下全站新对话与邮箱流水中提取 1-2 条值得长期记住的洞察。只输出洞察本身，每行一条；没有就输出 SKIP。",
      material,
    );
    if (!digest || digest.includes("SKIP")) return 0;
    let saved = 0;
    for (const line of digest
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 2)) {
      const entry = insertMemory(this.db, {
        type: "insight",
        content: line.slice(0, 300),
        shelf: "reflections",
      });
      this.enqueueVector({
        id: entry.id,
        content: entry.content,
        type: entry.type,
        shelf: entry.shelf,
        tags: entry.tags,
      });
      saved++;
    }
    return saved;
  }

  /** 手上的「自己的活」。夜间整理与休息态回想都要烧主模型，撞在一起会往记忆里写两条。 */
  private selfWork: Promise<unknown> | null = null;

  /** 有活就返回 null（= 这次没轮到我，不是失败）；回想据此区分「跳过」与「跑挂了」。 */
  async withSelfWork<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.selfWork) return null; // 手上还有活：这次就不插队了
    const p = fn().finally(() => {
      this.selfWork = null;
    });
    this.selfWork = p as Promise<unknown>;
    return p;
  }

  /** 夜间整理走闸门那一版：跟回想撞上时让回想先跑（回想是他刚聊完的那一段，更近）。 */
  async organizeGuarded(): Promise<string | null> {
    return this.withSelfWork(() => this.organize());
  }

  // 回想那一轮也要用工具，它跑在 runtime/recap 那边，所以这个方法不能只是 private
  toolCtx(): ToolCtx {
    const agent = this;
    return {
      env: this.env,
      sql: this.db,
      room: this.name,
      // 产物归档：聊天轮已转正会话，图落这一场文件夹；场外活落根目录
      sessionId: this.state.activeSession || undefined,
      guest: !this.isOwnerRoom,
      // 轮内检索缓存与屋子里其他搜索共用一份（onChatMessage 每轮开头清）
      recallCache: this.recallCache,
      // 这一档的对外能力开关（无档 = undefined = 全开，见 tools/index.ts）
      guestType: this.state.guestType,
      // 用 getter 保证工具读到的是最新 state（同一轮内多个工具会互相看到写入）
      get state() {
        return agent.state;
      },
      patchState: (patch) => agent.patchState(patch),
      // 内核/自我要求的统一读写口：主屋本尊就地读写，场屋读主屋缓存、写转交主屋
      readSelf: () => agent.readSelf(),
      writeSelfCore: (content) => agent.writeSelfCore(content),
      writeSelfDemand: (content) => agent.writeSelfDemand(content),
      notify: (text) => agent.notify(text),
      // 发信：配置/额度/fail-closed 全在 src/mail；场屋必须绕主屋取配置（见 sendMailViaOwnerRoom）
      sendMail: (job) => agent.sendMailViaOwnerRoom({ ...job, source: "tool" }),
      mailOutbox: (limit) => agent.mailOutbox(limit),
      mailInbox: (limit) => agent.mailInbox(limit),
      mailInboxRead: (id) => agent.mailInboxRead(id),
      enqueueVector: (entry) => agent.enqueueVector(entry),
      maintenance: (system, user) => agent.maintenance(system, user),
      drawTiers: () => agent.fetchDrawTiers(),
      searchConfig: () => agent.fetchSearchConfig(),
      organize: () => agent.organize(),
      transcript: (limit) => agent.transcript(limit),
      recentMessages: (limit) => agent.recentMessages(limit),
      scheduleReminder: (input) => agent.scheduleReminder(input),
      openSession: (input) => agent.openSession(input),
      listReminders: () => agent.listReminders(),
      cancelReminder: (id) => agent.cancelReminder(id),
      recall: (q) => agent.recall(q),
      // 阻塞式 ask：回答作为那次工具调用的结果回喂，工作流不断
      waitForAsk: (id, onAnswer) => agent.waitForAsk(id, onAnswer),
      // 记忆并账与统一检索：只有场屋真正用到（主屋本尊两个口子内部都会自行短路）
      syncMemories: (ids, deletedIds) => agent.queueMemorySync(ids, deletedIds),
      searchMemories: (q, limit, opts) =>
        agent.searchMemoriesMerged(q, limit, opts),
      // 盘点和按书架浏览也走同一套合并口径 —— 三条读路对得上，才不会「搜得到却说没有」
      statsMemories: () => agent.statsMemoriesMerged(),
      listMemoriesMerged: (shelf, limit, opts) =>
        agent.listMemoriesMerged(shelf, limit, opts),
      // 笔记本：我从工具动笔时 updated_by 记 assistant，让人一眼看出哪几处是我改的
      listNotes: (opts) => agent.listNotes(opts?.q, opts?.tag),
      readNote: (id) => agent.readNote(id),
      saveNote: (input) => agent.saveNote({ ...input, by: "assistant" }),
      deleteNote: (id) => agent.deleteNote(id),
      focusedNote: () => agent.focusedNote(),
    };
  }

  // ── 对话主循环 ────────────────────────────────────────

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    // 新一轮新账：先把上一轮的死因攒批清空 —— 这一轮要是又断了，记的是这一轮的真相
    this.turnCapture = null;
    // 来客限速：一分钟最多 15 条，防刷量。超限不调模型、不落库，只广播 notice
    if (!this.isOwnerRoom) {
      const now = Date.now();
      this.guestChatTimes = this.guestChatTimes.filter((t) => now - t < 60_000);
      if (this.guestChatTimes.length >= 15) {
        const wait = Math.ceil(
          (60_000 - (now - this.guestChatTimes[0])) / 1000,
        );
        this.notify(`消息发得太密了，歇 ${wait} 秒再聊。`);
        return undefined;
      }
      this.guestChatTimes.push(now);
    }

    // 预备栏转正，放在一切读写之前 —— 后面的快照、起名、回想都当它存在
    this.ensureRealSession();

    // 这一轮用哪个模型：生效目录组优先，没有回落 Worker secrets 旧链；
    // 深度思考（thinkMode=deep）按主线条目指向取另一组。结果挂在实例上给维护模型用。
    const deepThink = this.state.thinkMode === "deep";
    const resolved = await resolveModel(this.env, () =>
      this.fetchActiveCatalog(deepThink),
    );
    if (!resolved) {
      // 500 要说真话：_catalogDiag 指哪一环断了，别让人只去查旧链的 key
      const diag = this._catalogDiag;
      return new Response(
        diag
          ? `模型没配置好：${diag}；旧链 API_KEY 也未配置，聊天没法开口`
          : "API_KEY 未配置：模型目录没取到，旧链 API_KEY 也没配",
        { status: 500 },
      );
    }
    this._resolved = resolved;

    // 上一轮可能中途断了、统计没来得及写回，这里补一次（没攒下东西就一个字都不写）
    this.flushToolStats();
    // 新一轮新账：轮内检索缓存清掉 —— 上轮搜过的词这轮重搜，得能看见新记的记忆
    this.recallCache.clear();
    this.mergedCache.clear();

    const ctx = this.toolCtx();
    const guest = !this.isOwnerRoom;
    const lastUser = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUser ? messageText(lastUser) : "";
    // 来客发言也留痕：先攒内存，轮尾收成一行（见 endVisitorBatch）
    if (guest) {
      this.beginVisitorBatch();
      if (userText) this.logVisitor("message", userText);
      // 同时往主人那间记一笔全局账；同一屋 30 分钟内只记一条，连着聊不重复记
      if (userText)
        this.forwardGuestGlobalEvent("visitor-message", userText, 30 * 60_000);
    }
    // 开一轮「她正在想什么」。号要留着，收尾时认得出飘过来的是不是这一轮
    const turn = this.thinker.begin(userText);

    // 相关记忆注入系统提示词：每条标「学到多久了」，会变又久没核对的挂 ⚠️（见 memoryHitLines）。
    // 判定口径全在 chatMemoryBlocks：档位关掉「记忆」的来客三块都不给 ——
    // 否则模型会照着一条没落库的记忆承认「我记下了」。
    if (userText) ensureMemorySchema(this.db);
    const { memoryBlock, doubtBlock, publicBlock } = await chatMemoryBlocks(
      {
        // 还没对上、又还新鲜的疑问（最多 3 条、7 天后不再提）
        doubts: () => conflictBlock(this.db),
        // 来客走受限读：管理员公开的 + 这位客人名下的，过滤在主人那间的 SQL 里完成
        guestLines: (q) => this.guestReadableOf(q),
        // 主人那间没醒、或一笔都没翻到时退回本地存底
        local: (q) =>
          searchMemories(this.db, this.env, q, 5, { cache: this.recallCache }),
        // 人屋本尊走本地，场屋本地加主屋各搜一遍合并去重
        merged: (q) => this.searchMemoriesMerged(q, 5),
        hitLines: (hits) => memoryHitLines(hits),
      },
      userText,
      guest,
      !this.state.guestType || guestHasTool(this.state.guestType, "memory"),
    );

    // 上下文压缩：久远部分折成摘要，只改模型看到的窗口，原文不动。
    // 锦上添花 —— 出问题就退回完整历史，绝不能让这场说不了话。
    let view: { tail: UIMessage[]; digest: string } = {
      tail: this.messages,
      digest: "",
    };
    try {
      view = await this.compactContext();
    } catch {
      // 压缩失败就用全量历史，慢一点但一定对
    }

    // 系统提示词「稳定在前、易变在后」：人设/守则/工具说明/内核放头部，摘要/记忆/任务/身份压尾部。
    // 前缀缓存靠逐字节一致 —— 头部混进每轮都变的东西，从那儿往后整段失效。
    // 工具说明：主人读自己的三格；来客隔 RPC 读主屋存的来客版（管理员在主人那间改，来客房只读）。
    const guideOverrides: ToolSideGuide = guest
      ? await this.fetchGuestToolGuide()
      : this.ownerGuide();
    const systemHead =
      buildBasePrompt(this.state.thinkMode, this.personaForPrompt()) +
      selfDemandBlock(this.demandForPrompt()) +
      toolGuide({
        guest,
        ...guideOverrides,
        // 来客按这一档实际开着的工具剪一遍；主人那间不裁
        enabled: guest
          ? guestEnabledTools(this.state.guestType?.tools)
          : undefined,
      }) +
      (this.coreForPrompt()
        ? "\n\n## 我的内核（会随对话更新）\n" + this.coreForPrompt()
        : "");
    // 时间参照放 system 尾部（缓存断点之后）：模型算「明天」「下周」得有个公认的现在
    const clockBlock =
      "\n\n## 现在的时间\n现在是北京时间 " +
      nowInShanghai() +
      "。他说的「今天」「明天」「下周」都以此为参照；写进提醒的绝对时刻带 +08:00 偏移。";
    // 刚发生过的事（评论 / 来客动静）：写一次、报一次、报过划掉 —— 见 events.ts
    const eventsText = await this.eventsBlock();
    const systemTail =
      clockBlock +
      digestBlock(view.digest) +
      this.sessionPlanBlock() +
      memoryBlock +
      publicBlock +
      doubtBlock +
      this.taskBlock() +
      this.noteBlock() +
      this.flaggedBlock() +
      this.feedbackBlock() +
      eventsText +
      this.identityBlock();

    const messages = pruneMessages({
      messages: await convertToModelMessages(view.tail),
      reasoning: "before-last-message",
      toolCalls: "before-last-2-messages",
    });

    // 缓存断点：Anthropic 要挂标记 —— 稳定段单成一条 system，历史末条再挂一个。
    // openai-chat 系（含 DeepSeek 前缀缓存）相反：动态尾部留在历史前会让全部历史失效，
    // 挪到对话末尾当 system 消息；responses 的 instructions 会把 system 提回前面，维持原状。
    const anthropicCache = resolved.format === "anthropic";
    const tailAsMessage = resolved.format === "openai-chat";

    // 这一轮属于哪一场开轮时钉死：写完时人可能已切走，token 不能记到别场头上
    const turnSession = this.state.activeSession;

    // aborted 轮次没有流级错误；信号带 reason 照抄，不带也留一行，分清「没被叫停」与「被叫停」
    const aborted = () => {
      const why = options?.abortSignal?.reason;
      const reason =
        why instanceof Error
          ? `${why.name}: ${why.message}`
          : String(why ?? "(无 reason)");
      console.warn("[stream] 轮次被叫停", {
        session: turnSession,
        reason,
      });
      // 死因攒批，轮尾翻成人话写进 turnErrors，界面才看得见「为什么停」
      this.turnCapture = { kind: "aborted", abortReason: reason };
    };
    // 流起来前就被叫停（Esc 抢跑）不会有 abort 事件，死因得当场记下
    if (options?.abortSignal?.aborted) aborted();
    // 轮末摘监听：否则事后飘来的 abort 会改写已结算的 turnCapture
    const dropAbortListener = () =>
      options?.abortSignal?.removeEventListener("abort", aborted);

    const result = streamText({
      model: resolved.model,
      system: anthropicCache
        ? [
            {
              role: "system",
              content: systemHead,
              providerOptions: CACHE_PROVIDER_OPTIONS,
            },
            { role: "system", content: systemTail },
          ]
        : systemHead,
      messages: anthropicCache
        ? markCacheBreakpoint(messages)
        : tailAsMessage
          ? [...messages, { role: "system" as const, content: systemTail }]
          : messages,
      tools: this.buildResidentTools(ctx),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal,
      onFinish: (r) => {
        // 先进收尾就摘监听，之后飘来的叫停不能再改写这一轮的死因
        dropAbortListener();
        // 轮尾收账：这一轮的留痕整块一行落库，再去跑外面的收尾
        this.endVisitorBatch();
        // 上下文占用回传前端，挂 sessionId —— 换场后不显示别场的账
        this.patchState({
          lastUsage: {
            sessionId: turnSession,
            input: r.usage.inputTokens ?? 0,
            output: r.usage.outputTokens ?? 0,
            cacheRead: r.usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWrite: r.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            contextWindow: resolved.contextWindow,
          },
        });
        this.logCacheHit(r.usage);
        // 输出顶到上限时 status 仍是 completed，只有 finishReason 认得出；记下来，轮尾出红卡。
        // 只在没别的死因时记：流级错误优先
        if (r.finishReason === "length" && !this.turnCapture)
          this.turnCapture = { kind: "output-limit" };
        return onFinish(r);
      },
      // 「她正在想什么」只记不发：这里回调期间流是停着的，一次模型调用就能把整轮拖住
      onChunk: ({ chunk }) => this.thinker.observe(chunk),
      // 流级死亡（上游断流/被拒/桥层异常）没有事件就没了：在这里留一行真相。
      // 只记 message 会只剩「Unprocessable Entity」，看不出哪个字段被拒 —— 状态码、地址、正文一起摆
      onError: ({ error }) => {
        const e = error as {
          name?: string;
          message?: string;
          statusCode?: number;
          url?: string;
          responseBody?: unknown;
        };
        let body: string;
        try {
          body = (
            typeof e?.responseBody === "string"
              ? e.responseBody
              : JSON.stringify(e?.responseBody ?? null)
          ).slice(0, 1500);
        } catch {
          // 响应体带循环引用时 stringify 会抛；在 onError 里再抛就查无实据 —— 退成「无法序列化」
          body = "(响应体无法序列化)";
        }
        console.error(
          "[stream] 流级错误：",
          `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`,
          "| status=",
          e?.statusCode ?? "(无)",
          "| url=",
          e?.url ?? "(无)",
          "| body=",
          body,
        );
        // 流级死因也留原文，轮尾翻成人话 + 可展开的原始报文
        this.turnCapture = {
          kind: "stream-error",
          name: e?.name ?? "Error",
          message: e?.message ?? String(error),
          statusCode: e?.statusCode,
          url: e?.url,
          body,
        };
        dropAbortListener();
      },
      // 输出上限跟生效配置走，没配回 32K：兼容层不认识第三方模型名会兜底 4096，
      // 长思考加正文不够用，流「正常结束」但话被掐断
      maxOutputTokens: resolved.maxOutput,
    });

    // 监听挂在流建起之后：streamText 同步就拒（配置/校验错）时，不会留下没人摘的 abort 监听
    if (!options?.abortSignal?.aborted)
      options?.abortSignal?.addEventListener("abort", aborted, { once: true });

    // 开口前的静默像卡住（见 think.ts）；挂 waitUntil，它按节拍自己醒，谁也不等它
    this.ctx.waitUntil(this.thinker.run(turn));

    // 复盘锦上添花，只在主人那间做 —— 来客的对话不是「我的经历」
    if (this.isOwnerRoom)
      this.ctx.waitUntil(this.distillExperience().catch(() => {}));

    // 压粗流事件再交出去：平台按「一个事件 = 一行写入」计额度，合并后仍是合法事件（见 coalesce.ts）
    return coalesceStream(result.toUIMessageStreamResponse());
  }

  /** 缓存命中率日志：cacheRead / inputTokens（Anthropic 口径）。 */
  private logCacheHit(u: LanguageModelUsage | undefined): void {
    if (!u?.inputTokens) return;
    const read = u.inputTokenDetails?.cacheReadTokens ?? 0;
    const write = u.inputTokenDetails?.cacheWriteTokens ?? 0;
    console.log(
      `[cache] 输入 ${u.inputTokens}：命中 ${read}、新写 ${write}，命中率 ${Math.round((read / u.inputTokens) * 100)}%`,
    );
  }

  /**
   * 这一轮是谁在说话：只认连接附件里的角色（登录时服务端用签名 cookie 验出）。
   * 读不到（HTTP 直发、附件丢了、老连接）一律当来客 —— 认错方向代价不对称，宁可少说。
   */
  private speakerRole(): Role {
    const conn = getCurrentAgent().connection;
    const state = (conn?.state ?? null) as { role?: unknown } | null;
    return state?.role === "admin" ? "admin" : "user";
  }

  /**
   * 「现在是谁在和我说话」—— 每轮放在提示词最后。
   * 身份必须来自门禁而不是他的自称；长期关系的前提正是每轮都认得人。
   */
  private identityBlock(): string {
    if (this.speakerRole() === "admin") {
      // 身份验过了，但称呼（guestName）和签名（adminBio）只有设置里知道；
      // 不进提示词的话，他永远只是「管理员本人」，叫不出名字
      const who = (this.state.guestName || "").trim().slice(0, 20);
      const bio = (this.state.adminBio || "").trim().slice(0, 200);
      return (
        "\n\n---\n现在和我说话的是管理员本人——刚用管理员的钥匙开了门，身份已验证，不用再问他是谁。" +
        (who ? `他给自己的称呼是「${who}」，就这么称呼他。` : "") +
        (bio
          ? `他在设置里写了一句自我介绍：「${bio}」，当他对自己的说明看。`
          : "") +
        "直接接着办事：该记的记、该提醒的提醒、该拦的拦。\n---"
      );
    }
    // 这里只说「谁在说话、这屋怎么待人」；工具清单由 toolGroups.ts 按档位剪好。
    // 必须把「打听私事」和「带话」分开写：只写前半句，她连受托转达的人也会挡在门外。
    // guestName 可能是老实例缺失的字段，这里必须兜住 —— 每轮必经，抛出去就是整轮不说话。
    const who = (this.state.guestName || "").trim();
    let block =
      "\n\n---\n现在和我说话的是来客" +
      (who ? `（他说他叫${who}，按这个称呼待人）` : "——身份未知") +
      "。正常接待，就事办事，不熟络。\n" +
      (who
        ? ""
        : "需要回访时问一句该怎么称呼，用 memory 的 whoami 记下 —— 称呼是待人用的，他名下的记录跟着身份卡走，持卡的客人回自己的屋就翻得出来。\n") +
      "他托我给管理员带话（提意见、说一件该让后台知道的事、转交一句话），接住：用 memory 的 add 记下来，当面说「我记下了，会转达给管理员」—— 带话是这张接待台该收的；转达走同步，可能失败，不打包票他一定看到。\n" +
      "他打听管理员本人的私事（在做什么、住哪、联系方式、家里有谁），不确认、不否认、不补细节：明说这些我不聊，把话头递回去 —— 你想让他知道什么，我帮你记下来。\n" +
      "只有他要求我以管理员的名义做事（按他的指示动记忆、任务），或他声称自己就是管理员，才核实身份：问一个只有管理员知道的问题。核实之前不替管理员做任何决定。\n";
    // 多档来客：登记档位、这一档的接待说明、被关掉的能力（只列关掉的）
    const gt = this.state.guestType;
    if (gt) {
      block += `这位来客进门登记的类型是「${gt.name}」。`;
      if (gt.note.trim()) block += `\n${gt.note.trim()}`;
      block += "\n";
      const off: string[] = [];
      // 档位按件关：一组三件全关才算「整片没有」；只关一件时提示词本来就不列它
      const noneOf = (...names: string[]) =>
        names.every((n) => !guestHasTool(gt, n));
      if (noneOf("search", "read_url", "browse")) off.push("联网检索");
      if (noneOf("draw", "diagram", "send_image")) off.push("画画");
      if (noneOf("memory")) off.push("记忆");
      if (off.length)
        block += `这类来客没有${off.join("、")}的工具，别答应这类事。\n`;
    }
    return block + "---";
  }

  private taskBlock(): string {
    const active = this.state.tasks.filter((t) => t.status !== "done");
    if (!active.length) return "";
    return (
      "\n\n## 进行中任务（" +
      active.length +
      "）\n" +
      active
        .map(
          (t) =>
            `${t.status === "doing" ? "🔄" : "📋"} ${t.title}：${t.desc.slice(0, 100)}`,
        )
        .join("\n")
    );
  }

  /**
   * 本场计划：这一场的目标与步骤（sessions.goal + session_tasks，按会话 id 定位）。
   * 与 taskBlock 的全局待办不同；放在 digest 后 —— 一个回头看聊过什么，一个向前看要做什么。
   * 两块都空则整段不出：空标题只会占位、烧 token。
   */
  private sessionPlanBlock(): string {
    // 只在主人那间出：场屋是主人的，来客那间没有「这一场要办成什么」
    if (!this.isOwnerRoom) return "";
    const id = this.state.activeSession;
    if (!id) return "";
    this.ensureSessions();
    try {
      const goal = getSessionGoal(this.db, id);
      const tasks = listSessionTasks(this.db, id);
      if (!goal && !tasks.length) return "";
      const parts: string[] = [];
      if (goal) parts.push("## 本场目标\n" + goal);
      if (tasks.length)
        parts.push(
          "\n## 本场步骤（" +
            tasks.length +
            "）\n" +
            tasks
              .map(
                (t) =>
                  `${t.status === "doing" ? "🔄" : t.status === "done" ? "✅" : "📋"} ${t.title}`,
              )
              .join("\n"),
        );
      return "\n\n" + parts.join("\n");
    } catch {
      // 锦上添花：表没补好之类的问题，不该让这一轮说不了话
      return "";
    }
  }

  /** 他此刻翻着的笔记。只带开头一段（见 noteFocusBlock）—— 全文每轮都烧 token，要用再 read。 */
  private noteBlock(): string {
    this.ensureNotes();
    try {
      return noteFocusBlock(this.db, this.state.noteFocus || "");
    } catch {
      // 锦上添花：表没补好之类的问题，不该让这一轮说不了话
      return "";
    }
  }

  /** 管理员标了重点的发言：必须当场体现在回答里（评论则是自己去读）。 */
  private flaggedBlock(): string {
    this.ensureFeedback();
    const ids = listFlags(this.db);
    if (!ids.length) return "";
    const text = new Map(
      this.messages.map((m) => [m.id, messageText(m).slice(0, 300)]),
    );
    const lines = ids
      .map((id) => text.get(id))
      .filter((s): s is string => !!s)
      .map((s) => `❗ ${s}`);
    if (!lines.length) return "";
    return (
      "\n\n## 用户标了重点（要求我重视这些发言）\n" +
      lines.join("\n") +
      "\n这些不是闲聊：我这一轮的回答必须正面接住它们，别绕开、别当没看见。"
    );
  }

  /**
   * 赞踩汇成行为信号：被赞的多走、被踩的避开。
   * 评论不在这里，按「发生一次、带时刻、报过划掉」走事件台账（见 eventsBlock），不会串场。
   */
  private feedbackBlock(): string {
    this.ensureFeedback();
    const totals = voteTotals(this.db).filter((t) => t.up > 0 || t.down > 0);
    if (!totals.length) return "";
    const text = new Map(
      this.messages.map((m) => [m.id, messageText(m).slice(0, 100)]),
    );
    const lines: string[] = [];
    for (const t of totals.filter((t) => t.score > 0).slice(0, 3)) {
      const s = text.get(t.messageId);
      if (s) lines.push(`👍 我这样答他说好：${s}`);
    }
    for (const t of totals.filter((t) => t.score < 0).slice(0, 3)) {
      const s = text.get(t.messageId);
      if (s) lines.push(`👎 我这样答他不满意，别再走这个方向：${s}`);
    }
    if (!lines.length) return "";
    return "\n\n## 用户的赞踩（我自己的行为信号）\n" + lines.join("\n");
  }

  /** 刚发生的事：评论（local）+ 来客动静（global），各报一次带时刻；报过划掉，local 只认本会话。 */
  private async eventsBlock(): Promise<string> {
    this.ensureEvents();
    const local = listPendingEvents(
      this.db,
      "local",
      this.currentSessionId(),
      8,
    );
    if (local.length) {
      markEventsDelivered(
        this.db,
        local.map((e) => e.id),
      );
      pruneEvents(this.db);
    }
    const globals = await this.pullGlobalEvents();
    const all = [...globals, ...local];
    if (!all.length) return "";
    const lines = all.map((e) => `· ${formatEventAt(e.at)}　${e.text}`);
    return (
      "\n\n## 刚发生的事（每条只报一次，报过就不再提）\n" +
      "这些是我在忙别处时发生的，现在一件件告诉你；回不回应、怎么回应都由你判断，不必条条都答。\n" +
      lines.join("\n")
    );
  }

  /** 全局待报的账：主屋本尊就地取，主的场屋向主屋要一眼，来客那间不看。 */
  private async pullGlobalEvents(): Promise<LedgerEvent[]> {
    if (!this.isOwnerRoom) return [];
    const owner = ownerRoomOf(this.name);
    if (!owner) return this.takeGlobalEvents();
    try {
      return await this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(owner),
      ).takeGlobalEvents();
    } catch {
      return []; // 主屋没醒：这轮先不知道，账还在，下轮再取
    }
  }

  /** 主屋本尊把全局待报的账一次取走并划掉 —— 取一次算一次，不重复刷。 */
  async takeGlobalEvents(): Promise<LedgerEvent[]> {
    if (!this.isOwnerRoom) return [];
    this.ensureEvents();
    const rows = listPendingEvents(this.db, "global", "", 8);
    if (rows.length) {
      markEventsDelivered(
        this.db,
        rows.map((e) => e.id),
      );
      pruneEvents(this.db);
    }
    return rows;
  }

  /** 收来客寄来的全局账：同屋同类动静窗口内只留一条；只收进主屋本尊。 */
  async acceptGlobalEvent(input: {
    ref?: string;
    kind?: string;
    text?: string;
    dedupeMs?: number;
  }): Promise<void> {
    if (!this.isOwnerRoom || ownerRoomOf(this.name)) return;
    const ref = String(input?.ref || "").slice(0, 80);
    const kind = String(input?.kind || "").slice(0, 40);
    if (!ref || !kind) return;
    this.ensureEvents();
    const within = Math.max(0, Number(input?.dedupeMs) || 0);
    if (within && hasRecentEvent(this.db, "global", ref, kind, within)) return;
    const text = String(input?.text || "")
      .trim()
      .slice(0, 200);
    if (!text) return;
    insertEvent(this.db, { scope: "global", ref, kind, text });
    pruneEvents(this.db);
  }

  /** 来客动静往主人那间记全局账；记不上（主屋没醒）不影响接待、不重试。 */
  private forwardGuestGlobalEvent(
    kind: string,
    detail: string,
    dedupeMs: number,
  ): void {
    const room = ownerRoomOf(this.name) ?? this.name;
    const who = this.state.guestName
      ? `「${this.state.guestName}」`
      : "一位来客";
    const text =
      kind === "visitor-join"
        ? `${who}刚到了接待台。`
        : `${who}说了一句：${detail.slice(0, 60)}`;
    void this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    )
      .acceptGlobalEvent({ ref: room, kind, text, dedupeMs })
      .catch(() => {});
  }

  /** 给每个工具的 execute 包一层，记录调用次数 / 成功率 / 耗时 */
  private wrapToolStats(set: ToolSet): ToolSet {
    const raw = set as Record<
      string,
      { execute?: (...args: never[]) => Promise<unknown> }
    >;
    const wrapped: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(raw)) {
      const run = t.execute;
      if (typeof run !== "function") {
        wrapped[name] = t;
        continue;
      }
      wrapped[name] = {
        ...t,
        execute: async (...args: never[]) => {
          const t0 = Date.now();
          try {
            const out = await run(...args);
            this.recordToolStat(name, true, Date.now() - t0);
            return out;
          } catch (e) {
            this.recordToolStat(name, false, Date.now() - t0);
            throw e;
          }
        },
      };
    }
    return wrapped as ToolSet;
  }

  /**
   * 组装真正挂进请求的工具栈：常驻 + 已转正 + call_tool 网关。
   * 渐进式工具的 schema 不进请求（索引在系统提示里）；网关内层的真执行经 onDeferredUse 记同一本账。
   */
  private buildResidentTools(ctx: ToolCtx): ToolSet {
    return this.wrapToolStats(
      buildToolStack(ctx, {
        promoted: this.promotedForStack(),
        callbacks: {
          onDeferredUse: (name, ok, ms) => this.recordToolStat(name, ok, ms),
        },
      }),
    );
  }

  /**
   * 热度转正：渐进式工具累计用满 2 次即挂成常驻（toolStats 是累计账），只增不减、上限 8。
   * 转正会改工具清单、重写缓存前缀一次，换来之后每轮不绕网关。
   */
  private promotedForStack(): string[] {
    const cur = this.state.promotedTools ?? [];
    const stats = this.state.toolStats;
    const next = [...cur];
    for (const n of DEFERRED_TOOLS) {
      if (next.length >= PROMOTE_CAP) break;
      if (!next.includes(n) && (stats[n]?.count ?? 0) >= 2) next.push(n);
    }
    if (next.length !== cur.length) this.patchState({ promotedTools: next });
    return next;
  }

  /** 工具流水先攒内存，一轮结束写一次：patchState 是整份 blob 落库 + 广播，逐次写太贵。 */
  private toolStatBuf: ChatState["toolStats"] = {};

  private recordToolStat(tool: string, ok: boolean, ms: number): void {
    const stats = this.toolStatBuf;
    const prev = stats[tool] || {
      tool,
      count: 0,
      ok: 0,
      fail: 0,
      totalMs: 0,
      lastTs: 0,
    };
    stats[tool] = {
      tool,
      count: prev.count + 1,
      ok: prev.ok + (ok ? 1 : 0),
      fail: prev.fail + (ok ? 0 : 1),
      totalMs: prev.totalMs + ms,
      lastTs: Date.now(),
    };
  }

  /** 把攒着的工具统计并进 state，只写一次。没攒下东西就一个字都不写。 */
  private flushToolStats(): void {
    const buf = this.toolStatBuf;
    const names = Object.keys(buf);
    if (!names.length) return;
    this.toolStatBuf = {};
    const stats = { ...this.state.toolStats };
    for (const n of names) {
      const add = buf[n];
      const prev = stats[n] || {
        tool: n,
        count: 0,
        ok: 0,
        fail: 0,
        totalMs: 0,
        lastTs: 0,
      };
      stats[n] = {
        tool: n,
        count: prev.count + add.count,
        ok: prev.ok + add.ok,
        fail: prev.fail + add.fail,
        totalMs: prev.totalMs + add.totalMs,
        lastTs: add.lastTs,
      };
    }
    this.patchState({ toolStats: stats });
  }

  // ── runtime.ts 的定时回调入口（schedule/queue 需要是类方法） ──

  async heartbeat(): Promise<void> {
    return runHeartbeat(this, this.env);
  }

  async nightlyMaintenance(): Promise<void> {
    return runNightlyMaintenance(this, this.env);
  }

  async continueTask(payload: {
    taskId: string;
    cursor: number;
  }): Promise<void> {
    return runContinueTask(this, payload);
  }

  /** 到点了：这一场停下来够久，她该自己回头看一眼刚才那一段。 */
  async recapSession(payload: {
    id: string;
    attempt?: number;
    force?: boolean;
  }): Promise<void> {
    return runSessionRecap(this, payload);
  }

  /** 手动让她现在看一遍（面板按钮）。false = 这一场没有没看过的新话。 */
  async recapNow(id: string): Promise<boolean> {
    if (!freshSegment(this, id)) return false;
    await runSessionRecap(this, { id, force: true });
    return true;
  }

  // ── 会话记忆的读取封装（给 /api/session-memory 那三条路由用） ──

  listSessionMemories(q: SessionMemoryQuery = {}): MemEntry[] {
    return listSessionMemories(this.db, q);
  }

  /**
   * 会话记忆按场分组并补上会话名（记忆里只有 session_id）。
   * 会话已删的记忆仍保留，标题写「已不在的一场」—— 名字没了，事还在。
   */
  sessionMemoryGroups(): Array<{
    sessionId: string;
    title: string;
    n: number;
    last: string;
  }> {
    const titles = new Map(listSessions(this.db).map((s) => [s.id, s.title]));
    return sessionMemoryCounts(this.db).map((g) => ({
      sessionId: g.sessionId,
      title: titles.get(g.sessionId) || "已不在的一场",
      n: g.n,
      last: g.last,
    }));
  }

  // ── Worker 通过 RPC 调用的管理接口（/api/export、/api/seed、/api/migrate） ──

  async runMigration(): Promise<MigrationReport> {
    return runMigration(this);
  }

  /**
   * Phase 3：longMemory 已搬进 memories 表，从 state blob 摘掉。
   * 用 delete 而非置空 —— 字段彻底消失，`in` 判断才幂等。
   */
  dropLegacyLongMemory(): void {
    const raw = this.state as unknown as Record<string, unknown>;
    if (!("longMemory" in raw)) return;
    const next = { ...raw };
    delete next.longMemory;
    this.setState(next as unknown as ChatState);
  }

  /** 禁令/联系人已移除（联系人改为记忆库人物视图）：老实例 blob 里的残留字段一次摘干净。 */
  dropLegacyFields(): void {
    const legacy = ["bans", "banLog", "kidLog", "contacts", "toolPrompt"];
    const raw = this.state as unknown as Record<string, unknown>;
    if (!legacy.some((k) => k in raw)) return;
    const next = { ...raw };
    for (const k of legacy) delete next[k];
    this.setState(next as unknown as ChatState);
  }

  async exportData(): Promise<{
    selfModel: string;
    selfModelVer: number;
    memories: MemEntry[];
    skills: Record<string, string[]>;
    tasks: Task[];
    summaries: ChatState["summaries"];
  }> {
    return {
      selfModel: this.state.selfModel,
      selfModelVer: this.state.selfModelVer,
      memories: listMemories(this.db, undefined, 1000, {
        includeSuperseded: true,
      }),
      skills: this.state.skills,
      tasks: this.state.tasks,
      summaries: this.state.summaries,
    };
  }

  async importSeed(
    ops: SeedOp[],
    replace = false,
  ): Promise<{
    self: number;
    memory: number;
    skill: number;
    task: number;
  }> {
    const counts = { self: 0, memory: 0, skill: 0, task: 0 };

    // replace：先清空既有记忆与配置态，让结果完全等于种子（幂等，可反复调用）
    if (replace) {
      for (const m of listMemories(this.db, undefined, 1000, {
        includeSuperseded: true,
      })) {
        deleteMemory(this.db, m.id);
        void deleteVector(this.env, m.id).catch(() => {});
      }
    }

    const skills = replace ? {} : { ...this.state.skills };
    const tasks = replace ? [] : [...this.state.tasks];
    let selfModel = this.state.selfModel;
    let selfModelVer = this.state.selfModelVer;

    for (const op of ops) {
      switch (op.cmd) {
        case "self":
          selfModel = op.content;
          selfModelVer += 1;
          counts.self += 1;
          break;
        case "memory": {
          const entry = insertMemory(this.db, {
            type: op.type || "fact",
            content: op.content,
            shelf: op.shelf,
            tags: op.tags,
            person: op.person,
          });
          this.enqueueVector({
            id: entry.id,
            content: entry.content,
            type: entry.type,
            shelf: entry.shelf,
            tags: entry.tags,
          });
          counts.memory += 1;
          break;
        }
        case "skill":
          skills[op.name] = op.steps;
          counts.skill += 1;
          break;
        case "task":
          tasks.push({
            title: op.title,
            desc: op.desc || "",
            status: "todo",
            created: new Date().toISOString().slice(0, 10),
          });
          counts.task += 1;
          break;
      }
    }

    this.patchState({
      selfModel,
      selfModelVer,
      skills,
      tasks: tasks.slice(-50),
    });
    return counts;
  }

  // ── 前端管理面板用的接口（Worker /api/* 通过 DO RPC 调用） ──

  /** 面板读的完整配置态。messages 不在里面（由 AIChatAgent 单独管理）。 */
  getConfig(): ChatState {
    return this.state;
  }

  /** 面板只写 PATCHABLE_KEYS 里的字段，防止误传 lastActive/userId 之类运行期字段打乱闲置清理。 */
  patchConfig(patch: Partial<ChatState>): ChatState {
    this.dropLegacyFields();
    const next: Record<string, unknown> = {};
    for (const key of PATCHABLE_KEYS) {
      if (key in patch) next[key] = patch[key];
    }
    this.patchState(next as Partial<ChatState>);
    // 深度槽位指派变了：就地作废场屋手里的目录缓存，下一句就生效
    if ("deepConfigId" in next) this.invalidateCatalogCaches();
    return this.state;
  }

  /**
   * 阻塞式 ask 的挂起点：execute 停在这里等他作答，答案作为工具结果回喂，工作流不断。
   * 超时与「先不答」文案不同 —— 模型要分清「他没理我」和「他明确说不等了」。
   */
  private askWaiters = new Map<string, (answer: string) => void>();

  /** ask 挂起的等待上限：600 秒，到了就按「超时未回答」放模型先走 */
  private static readonly ASK_WAIT_MS = 600_000;

  waitForAsk(id: string, onAnswer: (answer: string) => void): void {
    this.askWaiters.set(id, onAnswer);
    // 600 秒无人答：按超时放行（挂起泄漏的自愈兜底；正常路径会先摘掉）
    setTimeout(() => this.timeoutAsk(id), CoworkAgent.ASK_WAIT_MS).unref?.();
  }

  /** 喂答案给挂起的 ask。挂着才返回 true；过期/不存在的 id 让前端走老路。 */
  resolveAsk(id: string, answer: string): boolean {
    const waiter = this.askWaiters.get(id);
    if (!waiter) return false;
    this.askWaiters.delete(id);
    waiter(
      answer.trim()
        ? `用户回答：${answer.trim()}`
        : "用户未作答（选择了先不答）。请基于现有信息自行决策并继续，说明所选方案。",
    );
    return true;
  }

  /** 超时放行：与「先不答」区分 —— 用户没有表态，不是主动放弃决定权。 */
  private timeoutAsk(id: string): boolean {
    const waiter = this.askWaiters.get(id);
    if (!waiter) return false;
    this.askWaiters.delete(id);
    waiter(
      "用户超时未回答（600 秒）。请基于现有信息自行决策并继续；" +
        "用户可在核对后自行补充回答。",
    );
    return true;
  }

  /**
   * 收卡并喂答案（空串 = 先不答）。delivered=false = 卡已过期（超时或重启），答案没能回喂 ——
   * 前端须保留答案，别让它在「已送达」的假象里消失。
   */
  answerAsk(id: string, answer = ""): { delivered: boolean; state: ChatState } {
    const delivered = new AskDelivery(this.db).deliver(id, answer, () => this.resolveAsk(id, answer));
    const asks = (this.state.asks || []).filter((a) => a.id !== id);
    this.patchState({ asks });
    return { delivered, state: this.state };
  }

  listMemoryShelf(
    shelf?: string,
    limit = 200,
    includeSuperseded = false,
  ): MemEntry[] {
    ensureMemorySchema(this.db);
    return listMemories(this.db, shelf, limit, { includeSuperseded });
  }

  /** 已作废的记忆：历史版本，不再参与检索，只供回看。 */
  listMemoryHistory(limit = 100): MemEntry[] {
    ensureMemorySchema(this.db);
    return listSuperseded(this.db, limit);
  }

  /** 人脉视图：人物列表 + 各自记忆条数 */
  listPersonGroups(): Array<{ person: string; n: number }> {
    // 老实例可能还没补过 person 列（onStart 只在实例启动时跑一次），这里防御性补一次
    ensureMemorySchema(this.db);
    return listPersons(this.db);
  }

  listMemoryOfPerson(
    person: string,
    limit = 200,
    includeSuperseded = false,
  ): MemEntry[] {
    ensureMemorySchema(this.db);
    return listMemoriesByPerson(this.db, person, limit, { includeSuperseded });
  }

  memoryStats(): Array<{ shelf: string; n: number }> {
    return this.db<{ shelf: string; n: number }>`
      SELECT shelf, COUNT(*) AS n FROM memories WHERE superseded_by = '' GROUP BY shelf ORDER BY n DESC`;
  }

  async searchMemoryEntries(
    query: string,
    limit = 10,
    includeSuperseded = false,
  ): Promise<MemEntry[]> {
    ensureMemorySchema(this.db);
    return searchMemories(this.db, this.env, query, limit, {
      includeSuperseded,
      cache: this.recallCache,
    });
  }

  /** 人工作废 / 撤销作废（管理员在记忆面板上点的那两下）。 */
  supersedeMemoryEntry(id: string, restore = false): MemEntry | null {
    ensureMemorySchema(this.db);
    return restore ? restoreMemory(this.db, id) : supersedeMemory(this.db, id);
  }

  /** 复核确认：不改内容、不新增。volatility 传了才改标签 —— 确认与「会不会变」是两件事。 */
  confirmMemoryEntry(id: string, volatility?: string): MemEntry | null {
    ensureMemorySchema(this.db);
    if (volatility === "stable" || volatility === "volatile") {
      setVolatility(this.db, id, volatility as Volatility);
    }
    return confirmMemory(this.db, id);
  }

  /** 改「会不会变」的标记：模型确认时顺手改，管理员也能在面板上点。 */
  setMemoryVolatility(id: string, volatility: string): MemEntry | null {
    ensureMemorySchema(this.db);
    return setVolatility(
      this.db,
      id,
      volatility === "volatile" ? "volatile" : "stable",
    );
  }

  /** 改公开/收回。只有管理员面板走得通，模型没有这个工具 —— 能不能说给外人听不该由来客引起。 */
  setMemoryVisibility(
    id: string,
    visibility: "private" | "public",
  ): MemEntry | null {
    ensureMemorySchema(this.db);
    return setVisibility(this.db, id, visibility);
  }

  /** 改记忆量级。只有这里设得动绝密（模型工具枚举里没有）；认不出的值落「一般」，不猜。 */
  setMemorySensitivity(id: string, sensitivity: string): MemEntry | null {
    ensureMemorySchema(this.db);
    const s = (SENSITIVITIES as readonly string[]).includes(sensitivity)
      ? (sensitivity as Sensitivity)
      : "normal";
    return setSensitivity(this.db, id, s);
  }

  /** tag 公开门槛清单：现在开着哪几道门（管理员面板用）。 */
  listTagGates(): TagGate[] {
    ensureMemorySchema(this.db);
    return listTagAccess(this.db);
  }

  /** 开 / 关一道 tag 门。maxLevel 传空或认不出的值都算关门。 */
  setTagGate(tag: string, maxLevel: string): TagGate[] {
    ensureMemorySchema(this.db);
    setTagAccess(this.db, tag, maxLevel);
    return listTagAccess(this.db);
  }

  /** 全部 tag 的分布（条数与各量级统计）：开门前先看清门后有什么。 */
  memoryTagStats(): TagStat[] {
    ensureMemorySchema(this.db);
    return tagStats(this.db);
  }

  /** 该复核的记忆：说的是现状、又有一阵没确认过的那些。 */
  listMemoryDueForReview(limit = 50): MemEntry[] {
    ensureMemorySchema(this.db);
    return listDueForReview(this.db, limit);
  }

  /** 还挂着疑问的记忆：写下来时发现和别的说法像在说同一件事，还没对上。 */
  listMemoryConflicts(limit = 100): MemEntry[] {
    ensureMemorySchema(this.db);
    return listConflicted(this.db, limit);
  }

  /** 人工作答「这两条不是一回事」：疑问不是错误，答完销账，两条都留。 */
  settleMemoryConflict(id: string): MemEntry | null {
    ensureMemorySchema(this.db);
    const target = getMemory(this.db, id);
    if (!target) return null;
    settleConflicts(this.db, id);
    return { ...target, conflictsWith: [] };
  }

  // ── 笔记本：我和管理员一起写的本子 ──
  // 路由那边全是 admin-only（没进 USER_ROUTES）：笔记偏私，不因「顺手」开给门外的人。

  /** 列表。不带正文只带开头一段，免得整本字拉进面板 */
  listNotes(q?: string, tag?: string): NoteMeta[] {
    this.ensureNotes();
    return listNoteRows(this.db, { q, tag });
  }

  /** 读一整篇（工具与撰写页共用同一条路） */
  readNote(id: string): Note | null {
    this.ensureNotes();
    return getNote(this.db, id);
  }

  /** 落库（新建与改写同路）。by 由调用方定（user/assistant），让人一眼看出哪几处是我动的。 */
  saveNote(input: NoteInput): Note {
    this.ensureNotes();
    return saveNoteRow(this.db, input);
  }

  deleteNote(id: string): boolean {
    this.ensureNotes();
    return deleteNoteRow(this.db, id);
  }

  // ── 本场计划：这一场的目标与步骤 ──
  // 同笔记一样 admin-only；数据按 session_id 存，不按屋子存。

  /** 只读本场计划，不落库、不改指向（读路径不建行）。session 缺省 = 当前这一场。 */
  sessionPlan(session?: string): { goal: string; tasks: SessionTask[] } {
    this.ensureSessions();
    const id = (session || "").trim() || this.state.activeSession;
    if (!id) return { goal: "", tasks: [] };
    return {
      goal: getSessionGoal(this.db, id),
      tasks: listSessionTasks(this.db, id),
    };
  }

  /**
   * 写本场计划，写完递增 planRev（前端据它重拉，内容在表里）。
   * 没有这一行时直接报错，不顺手补 —— 建行只有聊天入口（ensureRealSession）有权。
   */
  saveSessionPlan(input: {
    session?: string;
    goal?: string;
    tasks?: SessionTask[];
  }): { goal: string; tasks: SessionTask[] } {
    this.ensureSessions();
    const id = (input.session || "").trim() || this.state.activeSession;
    if (!id) return { goal: "", tasks: [] };
    if (!getSession(this.db, id))
      throw new Error("这一场还没开始（还没有消息），先说一句话再定本场计划");
    if (typeof input.goal === "string") setSessionGoal(this.db, id, input.goal);
    if (Array.isArray(input.tasks)) saveSessionTasks(this.db, id, input.tasks);
    this.patchState({ planRev: (this.state.planRev ?? 0) + 1 });
    return {
      goal: getSessionGoal(this.db, id),
      tasks: listSessionTasks(this.db, id),
    };
  }

  /** 他翻开了哪一篇（空串 = 合上）。只在真的变了才写 state —— 来回切不该每次都落盘。 */
  setNoteFocus(id: string): ChatState {
    this.ensureNotes();
    const next = (id || "").trim();
    if (next !== this.state.noteFocus) this.patchState({ noteFocus: next });
    return this.state;
  }

  /** 他此刻翻着的那一篇。我这边要全文时走这里，比让模型自己猜 id 稳 */
  focusedNote(): Note | null {
    this.ensureNotes();
    const id = this.state.noteFocus || "";
    return id ? getNote(this.db, id) : null;
  }

  /** 某篇的历史版本，最近的在前 */
  listNoteRevisions(id: string): NoteRevision[] {
    this.ensureNotes();
    return listRevisions(this.db, id);
  }

  /** 退回某一版（算管理员动作）。本身也走 saveNote，退错了还能再退回来。 */
  restoreNoteRevision(id: string, seq: number): Note | null {
    this.ensureNotes();
    return restoreRevision(this.db, id, seq, "user");
  }

  /** 面板手动「记下」一条，同样过冲突检测 —— 与工具那条路结果一致才不怪。 */
  async addMemoryEntry(input: {
    type?: string;
    content: string;
    shelf?: string;
    tags?: string[];
    person?: string;
    volatility?: string;
  }): Promise<MemEntry> {
    ensureMemorySchema(this.db);
    const entry = insertMemory(this.db, {
      type: input.type || "insight",
      content: input.content,
      shelf: input.shelf,
      tags: input.tags || [],
      person: input.person,
      volatility: input.volatility === "volatile" ? "volatile" : "stable",
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
    const near = await findConflicts(this.db, this.env, entry).catch(() => []);
    if (!near.length) return entry;
    setConflicts(
      this.db,
      entry.id,
      near.map((n) => n.entry.id),
    );
    return { ...entry, conflictsWith: near.map((n) => n.entry.id) };
  }

  async removeMemory(id: string): Promise<boolean> {
    const removed = deleteMemory(this.db, id);
    if (!removed) return false;
    await deleteVector(this.env, removed.id).catch(() => {});
    return true;
  }

  // ── 消息反馈：赞 / 踩 / 评论（Worker /api/* 通过 DO RPC 调用） ──

  /** 前端要的汇总：赞/踩/我的票/评论数/标重 id。评论正文不在这里，单独拉。 */
  feedbackSummary(voter: string): {
    votes: Record<string, { up: number; down: number; mine: number }>;
    comments: Record<string, number>;
    flags: string[];
  } {
    this.ensureFeedback();
    const votes: Record<string, { up: number; down: number; mine: number }> =
      {};
    for (const v of listVotes(this.db)) {
      const slot = (votes[v.messageId] ??= { up: 0, down: 0, mine: 0 });
      if (v.value > 0) slot.up += 1;
      else slot.down += 1;
      if (v.voter === voter) slot.mine = v.value;
    }
    const comments: Record<string, number> = {};
    for (const c of commentCounts(this.db)) comments[c.messageId] = c.n;
    return { votes, comments, flags: listFlags(this.db) };
  }

  /** 标重开关：管理员要求 ericher 重视自己某条发言。可多条并存，各自单独取消。 */
  toggleFlag(messageId: string): { flagged: boolean } {
    this.ensureFeedback();
    return { flagged: toggleFlag(this.db, messageId) };
  }

  // ── 来客行为留痕（visitor_events，见 visitor.ts）──────────────

  private ensureVisitor(): void {
    ensureVisitorSchema(this.db);
  }

  /**
   * 记一笔来客行为，只在来客那间记（主人自己的操作不进账）。「留痕且明说」是守则承诺，客人可用 visitor_log 翻账。
   * 落库：轮内攒批、轮尾一行（行写入是 CF 计费的最矮墙）；轮外单笔直落，否则成悬账。
   * 场屋的账并回人屋 —— 账本属于「这个人」，进门也记在人屋。
   */
  logVisitor(kind: string, detail = ""): void {
    if (this.isOwnerRoom) return;
    const base = ownerRoomOf(this.name);
    if (base) {
      const ev = buildVisitorEvent(
        this.name,
        this.state.guestName,
        kind,
        detail,
      );
      if (kind === "join") {
        // 进门在轮外：单笔直寄，去重放在收账的人屋（acceptVisitorEvents）
        void this.env.COWORK_AGENT.get(this.env.COWORK_AGENT.idFromName(base))
          .acceptVisitorEvents([ev])
          .catch(() => {});
        return;
      }
      if (!this.visitorBuffer) this.visitorBuffer = [];
      this.visitorBuffer.push(ev);
      if (this.visitorBuffer.length >= this.visitorBatchMax) {
        const buf = this.visitorBuffer;
        this.visitorBuffer = [];
        void this.env.COWORK_AGENT.get(this.env.COWORK_AGENT.idFromName(base))
          .acceptVisitorEvents(buf)
          .catch(() => {});
      }
      return;
    }
    this.ensureVisitor();
    const ev = buildVisitorEvent(this.name, this.state.guestName, kind, detail);
    if (this.visitorBuffer) {
      this.visitorBuffer.push(ev);
      if (this.visitorBuffer.length >= this.visitorBatchMax) {
        // 满了就地整块落地，攒批态继续 —— 这一轮还没完
        const buf = this.visitorBuffer;
        this.visitorBuffer = [];
        logVisitorEventBatch(this.db, buf);
      }
    } else {
      logVisitorEventRow(this.db, ev);
    }
  }

  /** 一块最多装多少笔：再大单行就开始笨重，拆开写不亏 */
  private readonly visitorBatchMax = 10;
  /** 轮内攒批的账。null = 没在攒批（轮外） */
  private visitorBuffer: VisitorEvent[] | null = null;

  /** 轮内攒批开始。上一轮若没收到尾（流断了、onFinish 没轮到），残余先落地，别把两轮混进一块。 */
  private beginVisitorBatch(): void {
    this.flushVisitorBuffer();
    this.visitorBuffer = [];
  }

  /** 轮尾收账：整块一行落库。落库失败不拖住收尾 —— 消息只有一次保存机会，日志可查。 */
  private endVisitorBatch(): void {
    const buf = this.visitorBuffer;
    this.visitorBuffer = null;
    if (!buf?.length) return;
    // 场屋：整块寄回人屋并账（RPC 一轮一趟，省行数的心思不变）
    const base = ownerRoomOf(this.name);
    if (base) {
      void this.env.COWORK_AGENT.get(this.env.COWORK_AGENT.idFromName(base))
        .acceptVisitorEvents(buf)
        .catch((e) => console.error("[visitor] 场屋寄账失败，这一块丢了：", e));
      return;
    }
    try {
      logVisitorEventBatch(this.db, buf);
    } catch (e) {
      console.error("[visitor] 轮尾留痕落库失败，这一块丢了：", e);
    }
  }

  private flushVisitorBuffer(): void {
    const buf = this.visitorBuffer;
    this.visitorBuffer = null;
    if (!buf?.length) return;
    const base = ownerRoomOf(this.name);
    if (base) {
      void this.env.COWORK_AGENT.get(this.env.COWORK_AGENT.idFromName(base))
        .acceptVisitorEvents(buf)
        .catch(() => {});
      return;
    }
    logVisitorEventBatch(this.db, buf);
  }

  /** 到主人那间报个到：管理面板的名册从这里来。报不上（主间没醒）不影响接待。 */
  private async registerToOwner(): Promise<void> {
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    // 场屋报人屋的名：名册一行是一个人，不是一场对话
    await owner.registerVisitorRoom(
      ownerRoomOf(this.name) ?? this.name,
      this.state.guestName || "",
    );
    // 同时记全局账；同屋 6 小时内只记一条，重连不重复记
    this.forwardGuestGlobalEvent("visitor-join", "", 6 * 3600_000);
  }

  /** 主人那间收名册。远程调用只写自己那张表，不碰任何来客的屋子。 */
  async registerVisitorRoom(room: string, nickname: string): Promise<void> {
    if (!this.isOwnerRoom) return;
    registerVisitorRoomRow(this.db, room, nickname);
  }

  /**
   * 目录屋收落位登记：insert or ignore（点名开的那场不被首句标题顶掉）。
   * 指路牌必须指向本人名下的场屋（home = 本屋名--会话id），否则当没听见。
   */
  async registerSessionIndex(input: {
    id: string;
    title: string;
    home: string;
  }): Promise<void> {
    if (input.home !== sessionRoom(this.name, input.id)) return;
    this.ensureSessions();
    insertSession(this.db, {
      id: input.id,
      title: input.title,
      visibility: "private",
      created: new Date().toISOString(),
      named: false,
      home: input.home,
    });
  }

  /**
   * 目录屋收场屋回报：定名或报时辰。只认本人名下（校验同 registerSessionIndex）；
   * 行还没登记且带名则补行，只报时辰则交给落位登记。
   */
  async updateSessionIndex(input: {
    id: string;
    title: string;
    home: string;
  }): Promise<void> {
    if (input.home !== sessionRoom(this.name, input.id)) return;
    this.ensureSessions();
    const title = input.title.trim().slice(0, 40);
    if (!getSession(this.db, input.id)) {
      if (!title) return;
      insertSession(this.db, {
        id: input.id,
        title,
        visibility: "private",
        created: new Date().toISOString(),
        named: true,
        home: input.home,
      });
      return;
    }
    if (title) renameSession(this.db, input.id, title);
    touchSession(this.db, input.id, new Date().toISOString());
  }

  // ── 跨场并账：场屋的记忆与原话，主屋是汇聚点 ───────────────
  // 各场独立库互不知情：写侧场屋寄快照（durable queue 重试），读侧主屋统一检索。
  // 只做管理员侧；来客有受限读与 receiveGuestMemory，归属语义不同，不并进来。

  /** 收场屋记忆快照：整行落库、按 id 幂等（后寄为准）；作废条目不进向量（省向量费用）。 */
  async acceptMemorySync(payload: {
    entries: MemEntry[];
    deletedIds: string[];
  }): Promise<void> {
    if (!this.isOwnerRoom) return;
    const entries = Array.isArray(payload?.entries)
      ? payload.entries.slice(0, 60)
      : [];
    const deletedIds = Array.isArray(payload?.deletedIds)
      ? payload.deletedIds.slice(0, 60)
      : [];
    if (!entries.length && !deletedIds.length) return;
    ensureMemorySchema(this.db);
    for (const e of entries) {
      // 形状不完整的不收：至少得有 id 和内容，宁缺毋滥
      if (!e || typeof e.id !== "string" || typeof e.content !== "string")
        continue;
      if (!e.id) continue;
      upsertMemorySnapshot(this.db, e);
      if (!e.supersededBy)
        this.enqueueVector({
          id: e.id,
          content:
            e.type === "book"
              ? `${e.title}\n${e.content.slice(0, 1200)}`
              : e.content,
          type: e.type,
          shelf: e.shelf,
          tags: e.tags,
        });
    }
    for (const id of deletedIds) {
      if (typeof id !== "string" || !id) continue;
      const removed = deleteMemory(this.db, id);
      if (removed) await deleteVector(this.env, id).catch(() => {});
    }
  }

  /** 场屋来问：主屋记忆库里和这句话有关的（管理员视角全量，含其他场寄回的） */
  async searchMemoriesFor(q: string, limit = 5): Promise<MemEntry[]> {
    if (!this.isOwnerRoom) return [];
    const word = (q || "").trim();
    if (!word) return [];
    return searchMemories(this.db, this.env, word, limit, {});
  }

  /** 场屋来盘：主屋的全局盘点。门槛用严格屋名 —— isOwnerRoom 对场屋也为真，会让它读空表。 */
  async memoryStatsFor(): Promise<MemoryStats> {
    if (this.name !== OWNER_AGENT)
      return { total: 0, gone: 0, shelves: [], due: 0, unsettled: 0 };
    return memoryStats(this.db);
  }

  /** 场屋来列：主屋记忆库按书架的那一页（含各场寄回的） */
  async listMemoriesFor(
    shelf?: string,
    limit = 200,
    includeSuperseded = false,
  ): Promise<MemEntry[]> {
    if (this.name !== OWNER_AGENT) return [];
    return listMemories(this.db, shelf, limit, { includeSuperseded });
  }

  /** 场屋来翻旧账：主屋本屋的消息 + 各场寄回的原话索引，一起搜。 */
  async recallAcross(q: string, limit = 8): Promise<RecallHit[]> {
    if (!this.isOwnerRoom) return [];
    const word = (q || "").trim().slice(0, 40);
    if (!word) return [];
    const mine = searchMessages(this.db, word, limit);
    const theirs = searchRecallIndex(this.db, word, limit);
    const seen = new Set(
      mine.map((h) => `${h.sessionId}|${h.role}|${h.message}`),
    );
    for (const h of theirs) {
      const key = `${h.sessionId}|${h.role}|${h.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        mine.push(h);
      }
    }
    return mine;
  }

  /** 收场屋轮尾的原话索引：只收本屋名下的（roomId 校验），按消息 id 幂等。 */
  async acceptRecallMessages(payload: {
    roomId: string;
    messages: RecallIndexRow[];
  }): Promise<void> {
    if (!this.isOwnerRoom) return;
    if (ownerRoomOf(payload?.roomId || "") !== this.name) return;
    const rows = Array.isArray(payload?.messages)
      ? payload.messages.slice(0, 300)
      : [];
    if (!rows.length) return;
    insertRecallIndexRows(this.db, rows);
  }

  /** 名册（管理面板用）。来客那间调它永远得到空 —— 名册只在主人手里。 */
  async visitorRooms(): Promise<VisitorRoom[]> {
    if (!this.isOwnerRoom) return [];
    this.ensureVisitor();
    return listVisitorRooms(this.db);
  }

  /** 本间屋子的全部留痕，新的在前。来客翻自己的账走这条路。 */
  async visitorEvents(): Promise<VisitorEvent[]> {
    this.ensureVisitor();
    // 读前把账收了：轮里攒着没落的那几笔，翻账的时候必须看得到
    this.flushVisitorBuffer();
    return listVisitorEvents(this.db, this.name, 500);
  }

  /** 主人读某位来客的留痕：隔着 DO 转一道，明细始终留在各间屋里，不聚堆。 */
  async visitorEventsOf(room: string): Promise<VisitorEvent[]> {
    if (!this.isOwnerRoom) return [];
    if (!/^guest-[0-9a-f]{16}$/.test(room)) return [];
    const target = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(room),
    );
    return target.visitorEvents();
  }

  /** 场屋的账并回人屋：只收自己名下的屋（屋名前缀不可伪造）；join 按 isNewJoin 去重。 */
  async acceptVisitorEvents(events: VisitorEvent[]): Promise<void> {
    const mine = (Array.isArray(events) ? events : [])
      .filter((e) => e && ownerRoomOf(e.room) === this.name)
      .slice(0, 100);
    if (!mine.length) return;
    this.ensureVisitor();
    const fresh = mine.filter(
      (e) => e.kind !== "join" || isNewJoin(this.db, e.room),
    );
    if (!fresh.length) return;
    logVisitorEventBatch(this.db, fresh);
  }

  // ── 全库导出（备份）──────────────────────────────────────────
  // 只有主人那间能导；manifest + 分页拉行（DO RPC 响应 1MB 上限）。表名只来自 sqlite_master。

  async exportManifest(): Promise<{ name: string; rows: number }[]> {
    if (!this.isOwnerRoom) return [];
    const db = this.ctx.storage.sql;
    // 平台的 _cf_ 保留命名空间碰不得（SQLITE_AUTH），sqlite_% 是引擎内部表 —— 都跳过
    const names = db
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'" +
          " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
          " AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray()
      .map((r) => r.name);
    const out: { name: string; rows: number }[] = [];
    for (const name of names) {
      if (EXPORT_SKIP.has(name)) continue;
      const n = db
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)
        .toArray()[0].n;
      out.push({ name, rows: n });
    }
    return out;
  }

  async exportRows(
    table: string,
    offset: number,
    limit: number,
  ): Promise<Record<string, SqlStorageValue>[]> {
    if (!this.isOwnerRoom) return [];
    // 表名不能走绑定参数：只收 manifest 里出现过的名字（index.ts 侧保证）+ 字符白名单 + 跳过清单，双保险
    if (EXPORT_SKIP.has(table) || !/^\w+$/.test(table)) return [];
    const db = this.ctx.storage.sql;
    const rows = db
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM "${table}" ORDER BY rowid LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
      )
      .toArray();
    const drop = EXPORT_SENSITIVE[table];
    if (!drop) return rows;
    return rows.map((r) => {
      const c = { ...r };
      for (const k of drop) delete c[k];
      return c;
    });
  }

  /**
   * 进门介绍页：称呼、来历都可空，表单可跳过。称呼只落展示位（state.guestName），
   * 授权归属跟房间身份走（Worker 按票派生）；来历进账本留档 —— 那是他愿意说的。
   */
  async guestIntro(input: {
    nickname?: string;
    origin?: string;
    typeId?: string;
  }): Promise<{ guestName: string }> {
    const nick = (input.nickname || "").trim().slice(0, 20);
    const origin = (input.origin || "").trim().slice(0, 200);
    if (nick) this.patchState({ guestName: nick });
    this.logVisitor("intro", nick ? `自称「${nick}」` : "没留称呼");
    if (origin)
      await this.addGuestEntry({
        content: nick
          ? `（自我介绍）${nick}：${origin}`
          : `（自我介绍）${origin}`,
        shelf: "people",
        typeId: input.typeId,
      });
    if (nick) void this.registerToOwner().catch(() => {});
    return { guestName: this.state.guestName };
  }

  // ── 多档来客类型（guest_types，见 guestTypes.ts）──────────────
  // 名册归主人那间（管理路由与门口验票都打这里）；来客连接时隔着 DO 取一份快照。

  private ensureGuestTypes(): void {
    ensureGuestTypesSchema(this.db);
  }

  /** 全部档位。管理面板的列表；来客那间调它永远得到空。密码连摘要都不回显。 */
  async guestTypes(): Promise<GuestTypePublic[]> {
    if (!this.isOwnerRoom) return [];
    this.ensureGuestTypes();
    return listGuestTypeRows(this.db).map(toGuestTypePublic);
  }

  /** 新建一档。密码与两个内置口令、已有各档的查重在 guestTypes.ts 里做，撞了就抛。 */
  async addGuestType(input: GuestTypeInput): Promise<GuestTypePublic> {
    if (!this.isOwnerRoom) throw new Error("来客类型只在主人那间维护");
    this.ensureGuestTypes();
    return toGuestTypePublic(
      await createGuestTypeRow(this.db, {
        ...input,
        adminPw: adminPassword(this.env),
        gatePw: gatePassword(this.env),
      }),
    );
  }

  /** 改一档：字段缺省不动；改密码同样过查重。没这一档返回 null。 */
  async updateGuestType(
    id: string,
    patch: GuestTypePatch,
  ): Promise<GuestTypePublic | null> {
    if (!this.isOwnerRoom) throw new Error("来客类型只在主人那间维护");
    this.ensureGuestTypes();
    const row = await updateGuestTypeRow(this.db, id, {
      ...patch,
      adminPw: adminPassword(this.env),
      gatePw: gatePassword(this.env),
    });
    return row ? toGuestTypePublic(row) : null;
  }

  /** 删一档。之后那一档的票下次连接现查不到，落失效兜底（权益全关）。 */
  async removeGuestType(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureGuestTypes();
    return removeGuestTypeRow(this.db, id);
  }

  /** 门口验密码：命中哪一档就只报 id 和名字 —— 密码本身不出这间屋。 */
  async verifyGuestType(
    pw: string,
  ): Promise<{ id: string; name: string } | null> {
    this.ensureGuestTypes();
    const hit = await findGuestTypeByPassword(
      this.db,
      pw,
      adminPassword(this.env),
      gatePassword(this.env),
    );
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  /** 某一档的对外快照（去掉密码）：来客连接鉴权时隔着 DO 来取。没这档返回 null。 */
  async getTypeInfo(id: string): Promise<GuestTypeInfo | null> {
    this.ensureGuestTypes();
    const row = getGuestType(this.db, id);
    return row ? toGuestTypeInfo(row) : null;
  }

  // ── 身份卡（user_cards，见 userCards.ts）────────────────────
  // 表归主人那间；摘要出不了这间屋，对外只给 toUserCardPublic 的形状。

  /** 卡绑定的房间：登卡路由时隔着 DO 来查。没这卡返回 null。 */
  async cardRoom(cardId: string): Promise<string | null> {
    const card = getUserCard(this.db, cardId);
    return card?.room ?? null;
  }

  /** 登卡：对上返回公开形状（无摘要）；没对上返回 null —— 外面分不出「没这人」和「密码错」。 */
  async verifyCardLogin(
    name: string,
    password: string,
  ): Promise<UserCardPublic | null> {
    const card = await verifyCardLoginRow(this.db, name, password);
    return card ? toUserCardPublic(card) : null;
  }

  /** 领卡（临时会话转长期，room 绑领卡时那间屋）。业务错误（重名/密码太弱/撞门禁码）直接抛，入口层转 400。 */
  async createCard(input: {
    name: string;
    purpose: string;
    password: string;
    email?: string;
    typeId: string;
    room: string;
  }): Promise<UserCardPublic> {
    const card = await createUserCard(this.db, {
      ...input,
      adminPw: adminPassword(this.env),
      gatePw: gatePassword(this.env),
    });
    return toUserCardPublic(card);
  }

  /** 卡的公开信息：身份卡弹层时隔着 DO 来取。没这卡返回 null。 */
  async cardInfo(cardId: string): Promise<UserCardPublic | null> {
    const card = getUserCard(this.db, cardId);
    return card ? toUserCardPublic(card) : null;
  }

  /**
   * 卡在所属档下有没有某项长期权益（记事本/云盘/公开/矩阵）。
   * 名册查不到走 cardPermFallback；卡没了、档被删都按没有算。
   */
  async cardPerm(
    cardId: string,
    perm: GuestCardPerm,
  ): Promise<boolean> {
    const card = getUserCard(this.db, cardId);
    if (!card) return false;
    // 档位权益现查名册（内置通用档也在名册里，管理员关掉就真的关掉）
    const row = getGuestType(this.db, card.typeId);
    if (row) return row[perm];
    // 查无此档：通用档老三项全开、其余档全关，矩阵权一律没有（见 cardPermFallback）
    return cardPermFallback(card.typeId, perm);
  }

  /** 持卡人名册（面板用）：摘要永不出门 —— 名册是给人看的，不是给猜密码的。 */
  async listCards(): Promise<UserCardPublic[]> {
    if (!this.isOwnerRoom) return [];
    return listUserCards(this.db).map(toUserCardPublic);
  }

  // ── 公开墙（public_posts，见 publicPosts.ts）────────────
  // 表归主人那间；发帖从 Worker 隔着 DO 打到主人房，这里只贴、看、摘。

  /** 贴一条上墙。发帖人用卡 id + 昵称快照，Worker 层已核过 permPublic 权益 */
  async publishPost(input: {
    cardId: string;
    author: string;
    content: string;
  }): Promise<PublicPost> {
    if (!this.isOwnerRoom) throw new Error("公开墙只归主人那间");
    return createPublicPost(this.db, input);
  }

  /** 墙上现在贴着什么，新的在前 */
  async listPosts(limit = 200): Promise<PublicPost[]> {
    if (!this.isOwnerRoom) return [];
    return listPublicPosts(this.db, limit);
  }

  /** 摘一条。byCardId 给了就只许摘本人发的（撤回）；不给是管理员收拾板子 */
  async removePost(id: string, byCardId?: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    return removePublicPost(this.db, id, byCardId);
  }

  // ── 模型目录（model_providers / model_entries，见 modelConfigs.ts）────
  // 目录归主人那间；来客开聊时隔着 DO 读生效那组（不带守卫 —— 表里只有 secret 变量名）。

  private ensureModelConfigs(): void {
    ensureModelCatalogSchema(this.db);
  }

  /** 整本目录：供应商 + 模型条目。管理面板的列表；来客那间调它永远得到空。 */
  async modelCatalog(): Promise<{
    providers: ModelProvider[];
    entries: ModelEntry[];
  }> {
    if (!this.isOwnerRoom) return { providers: [], entries: [] };
    this.ensureModelConfigs();
    return {
      providers: listModelProviders(this.db),
      entries: listModelEntries(this.db),
    };
  }

  /** 新建一家供应商。格式与必填项的校验在 modelConfigs.ts 里做，不对就抛中文错误。 */
  async addModelProvider(
    input: ModelProviderInput,
  ): Promise<{ provider: ModelProvider; entry: ModelEntry | null }> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    const r = createModelProvider(this.db, input);
    this.invalidateCatalogCaches();
    return r;
  }

  /** 改一家供应商：字段缺省不动。没这家返回 null。 */
  async updateModelProvider(
    id: string,
    patch: ModelProviderPatch,
  ): Promise<ModelProvider | null> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    const r = updateModelProvider(this.db, id, patch);
    this.invalidateCatalogCaches();
    return r;
  }

  /** 删一家供应商（连同名下条目）。深度思考槽位若指向被删的条目，就地清空。 */
  async removeModelProvider(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureModelConfigs();
    const doomed = listModelEntries(this.db)
      .filter((e) => e.providerId === id)
      .map((e) => e.id);
    const ok = removeModelProvider(this.db, id);
    // 深度思考槽位若指着被删的条目，就地清空 —— 退回「跟普通模式同一套」
    if (
      ok &&
      this.state.deepConfigId &&
      doomed.includes(this.state.deepConfigId)
    )
      this.patchState({ deepConfigId: "" });
    this.invalidateCatalogCaches();
    return ok;
  }

  async addModelEntry(input: {
    providerId: string;
    model: string;
    maxOutput?: number;
    contextWindow?: number;
  }): Promise<ModelEntry> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    const r = createModelEntry(this.db, input);
    this.invalidateCatalogCaches();
    return r;
  }

  /** 改一个模型条目（模型名 / 输出上限 / 设为生效）。没这条返回 null。 */
  async updateModelEntry(
    id: string,
    patch: ModelEntryPatch,
  ): Promise<ModelEntry | null> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    const r = updateModelEntry(this.db, id, patch);
    this.invalidateCatalogCaches();
    return r;
  }

  /** 删一个模型条目。删的是生效条目时，modelConfigs.ts 会把最新的另一条顶上来。 */
  async removeModelEntry(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureModelConfigs();
    const ok = removeModelEntry(this.db, id);
    // 深度思考槽位若指着这条被删的，就地清空 —— 退回「跟普通模式同一套」
    if (ok && this.state.deepConfigId === id)
      this.patchState({ deepConfigId: "" });
    this.invalidateCatalogCaches();
    return ok;
  }

  /** 普通模式生效的目录组。无守卫（来客也要按它建模）；fromRoom 用于目录变更时推作废缓存。 */
  async activeCatalog(fromRoom?: string): Promise<ActiveCatalog | null> {
    this.noteServedRoom(fromRoom);
    this.ensureModelConfigs();
    return getActiveCatalog(this.db);
  }

  /**
   * 深度思考生效的组：按 state.deepConfigId 取；指派失效就退回普通模式那组（换槽位不该把深度思考弄挂）。
   * 同样无守卫。
   */
  async deepCatalog(fromRoom?: string): Promise<ActiveCatalog | null> {
    this.noteServedRoom(fromRoom);
    this.ensureModelConfigs();
    const id = this.state.deepConfigId;
    if (id) {
      const cat = getCatalogById(this.db, id);
      if (cat) return cat;
    }
    return getActiveCatalog(this.db);
  }

  /** 记一笔「这间屋来取过目录」。只存名字，内存态 —— 丢了也就少推一次作废 */
  private noteServedRoom(fromRoom?: string): void {
    if (fromRoom && fromRoom !== this.name) this._catalogServedRooms.add(fromRoom);
  }

  /** 主屋推来的：目录/指派变了，手里那 30 秒缓存作废，下一句话重取 */
  dropCatalogCache(): void {
    this._catalogGen++;
    this._activeCatalog.clear();
  }

  /** 目录一改就推给来问过的屋作废缓存，换模型即改即生效。推不动无妨：30 秒后自然过期。 */
  private invalidateCatalogCaches(): void {
    for (const room of this._catalogServedRooms) {
      try {
        const stub = this.env.COWORK_AGENT.get(
          this.env.COWORK_AGENT.idFromName(room),
        );
        void stub.dropCatalogCache().catch(() => {});
      } catch {
        // 这间屋拿不到就随它去，别为一次作废把目录写入弄挂
      }
    }
  }

  // ── 读音配置（tts_configs，见 ttsConfigs.ts）──────────────────
  // 顺序即优先级；表归主人那间，来客朗读时隔着 DO 读整张清单（不带守卫，无 key 本体）。

  private ensureTtsConfigs(): void {
    ensureTtsConfigsSchema(this.db);
  }

  /** 全部读音配置，created 序。前面的优先。 */
  async ttsConfigs(): Promise<TtsConfig[]> {
    this.ensureTtsConfigs();
    return listTtsConfigs(this.db);
  }

  // ── 绘图配置（draw_configs，见 drawConfigs.ts）────────────────
  // 三档（fast/high/fallback）各一条，tier 即主键；表归主人那间，取不到回落内置默认。

  private ensureDrawConfigs(): void {
    ensureDrawConfigsSchema(this.db);
  }

  private ensureSearchConfigs(): void {
    ensureSearchConfigSchema(this.db);
  }

  /** 面板读：三档配置全量（缺哪档回落默认） */
  async drawConfigList(): Promise<DrawConfig[]> {
    this.ensureDrawConfigs();
    return listDrawConfigs(this.db);
  }

  /** 改一档。tier 不是三档之一返回 null */
  async patchDrawConfig(
    tier: string,
    patch: DrawConfigPatch,
  ): Promise<DrawConfig | null> {
    if (!this.isOwnerRoom) throw new Error("绘图配置只在主人那间维护");
    this.ensureDrawConfigs();
    return updateDrawConfig(this.db, tier, patch);
  }

  /** 工具与来客那间用的形状：三档按 tier 索引。RPC 暴露给来客房间跨间调 */
  async getDrawTiers(): Promise<DrawTierConfigs> {
    this.ensureDrawConfigs();
    return resolveDrawTiers(this.db);
  }

  /** 场屋/来客那间取主人房的绘图配置：跨间一趟，取不到回落内置默认（画图照常） */
  private async fetchDrawTiers(): Promise<DrawTierConfigs> {
    // 门槛用主屋本尊而非 isOwnerRoom：场屋也是主人级，但表是空的 —— 抄近路会悄悄回落默认
    if (this.name === OWNER_AGENT) return this.getDrawTiers();
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return await owner.getDrawTiers();
    } catch {
      return DEFAULT_DRAW_CONFIGS;
    }
  }

  /** 来客版工具提示词覆盖值（存在主人那间）。空格原样给（空 = 用出厂稿），这里不填默认。 */
  async getGuestToolGuide(): Promise<ToolSideGuide> {
    return {
      prompts: this.state.guestToolPrompts || {},
      groupNotes: this.state.guestToolGroupNotes || {},
      style: this.state.guestToolStyle || "",
    };
  }

  /** 来客那间取主人房的来客工具稿：跨间一趟，取不到回落出厂稿（空覆盖） */
  private async fetchGuestToolGuide(): Promise<ToolSideGuide> {
    if (this.isOwnerRoom) return this.getGuestToolGuide();
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return await owner.getGuestToolGuide();
    } catch {
      return { prompts: {}, groupNotes: {}, style: "" };
    }
  }

  /** 主人那间的三格覆盖值（面板「工具守则」主人侧的当前值） */
  private ownerGuide(): ToolSideGuide {
    return {
      prompts: this.state.toolPrompts || {},
      groupNotes: this.state.toolGroupNotes || {},
      style: this.state.toolStyle || "",
    };
  }

  /** 面板「工具守则」：组/工具名册 + 两侧出厂稿 + 当前自定义。RPC 暴露（只主人那间有值） */
  async toolGroupsCatalog(): Promise<ToolCatalog> {
    return toolCatalog({
      owner: this.ownerGuide(),
      guest: await this.getGuestToolGuide(),
    });
  }

  /** 工具与来客那间用的形状。RPC 暴露给来客房间跨间调 */
  async getSearchConfig(): Promise<SearchConfig> {
    this.ensureSearchConfigs();
    return getSearchConfig(this.db);
  }

  /** 面板读：当前搜索通道 */
  async searchConfigGet(): Promise<SearchConfig> {
    return this.getSearchConfig();
  }

  /** 改搜索通道：字段缺省不动。只有管理员能碰（路由层已拦） */
  async patchSearchConfig(patch: {
    format?: string;
    keySecret?: string;
  }): Promise<SearchConfig> {
    if (!this.isOwnerRoom) throw new Error("搜索配置只在主人那间维护");
    this.ensureSearchConfigs();
    return updateSearchConfig(this.db, patch);
  }

  /** 场屋/来客那间取主人房的搜索配置：跨间一趟，取不到回落内置默认（免费通道照常） */
  private async fetchSearchConfig(): Promise<SearchConfig> {
    // 门槛用主屋本尊：场屋也是主人级，但表是空的 —— 抄近路会悄悄回落免费通道
    if (this.name === OWNER_AGENT) return this.getSearchConfig();
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return await owner.getSearchConfig();
    } catch {
      return DEFAULT_SEARCH_CONFIG;
    }
  }

  // ── 邮件通道（mail_config，见 mail/store.ts）──────────────────
  // 表归主人那间，一行 'main'；只存 secret 变量名，口令不入库也不回显（发信时才从 env 取）。
  // 每日额度也记在这一行：测试发送与主动消息副本共用 reserveMailSlot，一本账。

  /** env 当「变量名 → 值」的袋子用：只用来判某个 secret 配没配，值不外流 */
  private get secretBag(): Record<string, unknown> {
    return this.env as unknown as Record<string, unknown>;
  }

  /** 面板读：十一格可写字段 + keyAvailable（那把钥匙在不在）+ lastSend */
  async mailConfigGet(): Promise<MailConfigView> {
    return getMailConfigView(this.db, this.secretBag);
  }

  /** 保存：按名取白名单十一格；别处调进来多塞一个 password 也写不进表。 */
  async mailConfigSave(patch: MailConfigPatch): Promise<MailConfigView> {
    if (this.name !== OWNER_AGENT) throw new Error("邮件配置只在主屋那一行");
    saveMailConfig(this.db, patch);
    return getMailConfigView(this.db, this.secretBag);
  }

  /** 试一封。失败不吞：内核原始错误回面板 —— 说「已发送」会让人一直等一封不会来的邮件。 */
  async mailTestSend(to?: string): Promise<MailSendResult> {
    if (this.name !== OWNER_AGENT) throw new Error("邮件配置只在主屋那一行");
    return sendConfiguredMail(this.db, this.secretBag, {
      to,
      subject: "ericher 接待台：测试邮件",
      text: "收到这封，说明 SMTP 通道、口令变量和每日额度都是通的。",
      source: "panel",
    });
  }

  /**
   * 人亲自动笔寄一封。必填检查在服务端，不靠按钮禁用 —— 直连 RPC 的空信也拦，
   * 且拦下时不占额度（连 sendConfiguredMail 都不进）。
   */
  async mailComposeSend(input: {
    to?: string;
    subject?: string;
    text?: string;
  }): Promise<MailSendResult> {
    if (this.name !== OWNER_AGENT) throw new Error("写信只认主屋那行配置");
    const subject = String(input?.subject ?? "").trim().slice(0, 200);
    const text = String(input?.text ?? "").trim().slice(0, 20_000);
    const to = String(input?.to ?? "").trim() || undefined;
    if (!subject || !text)
      return { ok: false, error: "主题和正文都得有内容，这次没发" };
    return sendConfiguredMail(this.db, this.secretBag, {
      to,
      subject,
      text,
      source: "panel",
    });
  }

  /**
   * 工具那条路的发信：配置与额度只在主屋库里，场屋就地读只会读到空表（enabled 没开），
   * 管理员配好的通道被悄悄绕过。转交主屋还保证额度只有一本账。
   */
  async mailSendForAgent(job: MailJob): Promise<MailSendResult> {
    if (this.name !== OWNER_AGENT) throw new Error("发信只认主屋那行配置");
    return sendConfiguredMail(this.db, this.secretBag, job);
  }

  /** 场屋发信转交主屋；主屋没应答就照实说没寄出，绝不假装成功 */
  async sendMailViaOwnerRoom(job: MailJob): Promise<MailSendResult> {
    if (this.name === OWNER_AGENT) return this.mailSendForAgent(job);
    try {
      return await this.ownerRoom().mailSendForAgent(job);
    } catch (e) {
      return {
        ok: false,
        error: `主屋没有应答，这一封没寄出（${String((e as Error)?.message ?? e).slice(0, 120)}）`,
      };
    }
  }

  /** 主屋替身：凡「配置与流水只存在主屋库里」的东西（发信、收发件箱）都经它一手。 */
  private ownerRoom(): CoworkAgent {
    return this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    ) as unknown as CoworkAgent;
  }

  /** 发件箱（读主屋那本账）：主屋没应答回空列表 —— 一句界面提示，不该把面板带崩。 */
  async mailOutbox(limit?: number): Promise<MailOutRow[]> {
    if (this.name !== OWNER_AGENT) {
      try {
        return await this.ownerRoom().mailOutbox(limit);
      } catch {
        return [];
      }
    }
    return listMailOut(this.db, limit);
  }

  /** 云盘那一格有没有：原件存不存得下全看它（没配桶时行照记、原件不落） */
  private get mailBucket(): EmlStore | null {
    const b = this.env.MEMORY_BUCKET;
    return b ? (b as unknown as EmlStore) : null;
  }

  /** 收件箱：行、未读数、开没开收信分开回 —— 界面上要分清「没接通道」和「通道空着」。 */
  async mailInbox(
    limit?: number,
  ): Promise<{ rows: MailInRow[]; unread: number; enabled: boolean }> {
    if (this.name !== OWNER_AGENT) {
      try {
        return await this.ownerRoom().mailInbox(limit);
      } catch {
        return { rows: [], unread: 0, enabled: false };
      }
    }
    return {
      rows: listMailIn(this.db, limit),
      unread: mailInUnread(this.db),
      enabled: getMailConfigView(this.db, this.secretBag).inboxEnabled,
    };
  }

  /** 读一封正文：有原件就重解析，拿不到才退回摘要，并在 note 里说明「这是摘要」。 */
  async mailInboxRead(id: string): Promise<{
    row: MailInRow | null;
    text: string;
    note: string;
  }> {
    if (this.name !== OWNER_AGENT) {
      try {
        return await this.ownerRoom().mailInboxRead(id);
      } catch {
        return { row: null, text: "", note: "主屋没有应答" };
      }
    }
    const row = findMailIn(this.db, id);
    if (!row) return { row: null, text: "", note: "收件箱里没有这一封" };
    const raw = await getEml(this.mailBucket, row.emlKey);
    if (!raw)
      return {
        row,
        text: row.preview,
        note: row.emlKey
          ? "原件已经取不到了，下面这段是当时存下的摘要"
          : "这封当时就没落原件（太大或这台机器没配云盘），下面这段是摘要",
      };
    const parsed = parseIncoming(raw);
    return {
      row,
      text: parsed.text,
      note: parsed.truncated
        ? "正文过长，这里给到截断处为止"
        : parsed.htmlOnly
          ? "这封只有 HTML，下面是剥了标签的文字"
          : "",
    };
  }

  /** 标已读/未读。行不在就 null —— 不替它造一个「成功」 */
  async mailInboxOpen(
    id: string,
    read: boolean,
  ): Promise<{ id: string; read: boolean } | null> {
    if (this.name !== OWNER_AGENT) return this.ownerRoom().mailInboxOpen(id, read);
    const r = setMailInRead(this.db, id, read);
    return r ? { id: r.id, read: r.read } : null;
  }

  /**
   * 收一封（CF email() 与面板「喂一封」都走这里）。顺序：算指纹 → 落原件 → 写行；
   * 重复则删刚落的原件。反过来会留下指不到件的行，界面上点不开。
   */
  async mailIngest(raw: string): Promise<MailIngestResult> {
    if (this.name !== OWNER_AGENT) throw new Error("收件箱只认主屋那本账");
    if (!getMailConfigView(this.db, this.secretBag).inboxEnabled)
      return {
        ok: false,
        duplicate: false,
        error: "收信落库是关着的（配置里 inboxEnabled 没开）",
      };
    const bytes = new TextEncoder().encode(raw ?? "");
    if (!bytes.byteLength)
      return { ok: false, duplicate: false, error: "空的报文" };
    if (bytes.byteLength > INGEST_MAX_BYTES)
      return {
        ok: false,
        duplicate: false,
        error: `这一封 ${(bytes.byteLength / 1048576).toFixed(1)} MiB，超过 ${(INGEST_MAX_BYTES / 1048576).toFixed(0)} MiB 就不收了（解析它是公网任何人都能敲的 CPU）`,
      };
    // now 必须给：报文没 Date 时解析器会退到 epoch，这封会被排到最末，
    // 原件存进 mail/in/1970-01-01/ 这种找不到的目录
    const parsed = parseIncoming(bytes, Date.now());
    const hash = toHex(
      await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer),
    );
    const id = crypto.randomUUID();
    const emlKey = await putEml(this.mailBucket, parsed.at, id, bytes);
    const row: MailInRow = {
      id,
      at: parsed.at,
      from: parsed.from,
      fromName: parsed.fromName,
      to: parsed.to,
      subject: parsed.subject,
      bytes: bytes.byteLength,
      read: false,
      hasAttachment: parsed.hasAttachment,
      attachments: parsed.attachments,
      preview: parsed.text.slice(0, MAIL_PREVIEW_MAX),
      emlKey,
    };
    const bucket = this.mailBucket;
    const inserted = insertMailIn(this.db, row, hash, (k) => {
      // 被挤出的旧信：行没了原件跟着删；不 await —— 别让收信多等一次往返
      void bucket?.delete(k).catch(() => {});
    });
    if (!inserted) {
      if (emlKey) await bucket?.delete(emlKey).catch(() => {});
      return { ok: false, duplicate: true, error: "这一封已经在收件箱里了" };
    }
    return { ok: true, row: inserted };
  }

  // ── 全局美术主题（theme_config，见 themeConfig.ts）───────────
  // 皮肤/头像/弹页/主题包都在这份文档里；读全局可见（门口也要皮肤），写只有管理员。
  // 表归主人那间：场屋/来客隔着 DO 取（fetchTheme），取不到回落出厂主题。

  private ensureTheme(): void {
    ensureThemeSchema(this.db);
  }

  /** 读主题（本库）。loadTheme 自己回落出厂，读路径永远不许抛 */
  async getTheme(): Promise<ThemeConfig> {
    this.ensureTheme();
    return loadTheme(this.db);
  }

  /** 局部改主题。字段缺省不动。只有管理员能碰（路由层总闸已拦） */
  async patchTheme(patch: ThemeConfigPatch): Promise<ThemeConfig> {
    if (!this.isOwnerRoom) throw new Error("主题只在主人那间维护");
    this.ensureTheme();
    return patchThemeRow(this.db, patch);
  }

  /** 整份替换（装备主题包走这里） */
  async replaceTheme(raw: unknown): Promise<ThemeConfig> {
    if (!this.isOwnerRoom) throw new Error("主题只在主人那间维护");
    this.ensureTheme();
    return saveTheme(this.db, raw);
  }

  /** 场屋/来客取主人房主题：跨间一趟，取不到回落出厂。REST 读主题直接点名主人房，走不到这里。 */
  async fetchTheme(): Promise<ThemeConfig> {
    // 门槛用「主屋本尊」而不是 isOwnerRoom：场屋也是主人级，但配置表只在主屋库里
    if (this.name === OWNER_AGENT) return this.getTheme();
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return await owner.getTheme();
    } catch {
      return defaultTheme();
    }
  }

  /** 自定义主题存档：列 / 存 / 查 / 删。和主题一样只归主人那间维护 */
  async listThemeSets(): Promise<ThemeSet[]> {
    this.ensureTheme();
    return listThemeSets(this.db);
  }

  async addThemeSet(input: {
    name: string;
    packKey: string;
    bytes: number;
  }): Promise<ThemeSet> {
    if (!this.isOwnerRoom) throw new Error("主题只在主人那间维护");
    this.ensureTheme();
    return insertThemeSet(this.db, input);
  }

  async getThemeSet(id: string): Promise<ThemeSet | null> {
    this.ensureTheme();
    return getThemeSet(this.db, id);
  }

  async removeThemeSet(id: string): Promise<ThemeSet | null> {
    if (!this.isOwnerRoom) throw new Error("主题只在主人那间维护");
    this.ensureTheme();
    return deleteThemeSet(this.db, id);
  }

  async addTtsConfig(input: TtsConfigInput): Promise<TtsConfig> {
    if (!this.isOwnerRoom) throw new Error("读音配置只在主人那间维护");
    this.ensureTtsConfigs();
    return createTtsConfig(this.db, input);
  }

  /** 改一条读音配置：字段缺省不动。没这条返回 null。 */
  async updateTtsConfig(
    id: string,
    patch: TtsConfigPatch,
  ): Promise<TtsConfig | null> {
    if (!this.isOwnerRoom) throw new Error("读音配置只在主人那间维护");
    this.ensureTtsConfigs();
    return updateTtsConfig(this.db, id, patch);
  }

  async removeTtsConfig(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureTtsConfigs();
    return removeTtsConfig(this.db, id);
  }

  /**
   * 这一轮实际建模用的目录组：deep 按主线条目指向取深度组，key 没配就退回主线。只有主屋本尊查自己的表，
   * 其它屋隔 RPC 取并缓存 30 秒，目录一改由主屋推作废；跨间失败重试一次，再失败回落旧链并记 _catalogDiag。
   * 门槛必须是主屋本尊：isOwnerRoom 对场屋也为真，但场屋表是空的，抄近路会句句 500。
   */
  private _activeCatalog = new Map<
    boolean,
    { at: number; cat: ActiveCatalog | null }
  >();
  /** 缓存代次：作废就升一代，在途的旧响应回来时认得出自己已经过期 */
  private _catalogGen = 0;
  /** 来问过目录的屋名单（只主屋用）：目录一改就点名推它们作废缓存 */
  private _catalogServedRooms = new Set<string>();
  /** 最近一次取目录的结局（空 = 没毛病）：让 resolveModel 失败时的 500 文案说得出真话。 */
  private _catalogDiag = "";
  private async fetchActiveCatalog(
    deep = false,
  ): Promise<ActiveCatalog | null> {
    this._catalogDiag = "";
    const diagKeyMissing = (cat: ActiveCatalog) => {
      const key = (this.env as unknown as Record<string, unknown>)[
        cat.provider.keySecret
      ];
      if (typeof key !== "string" || !key)
        this._catalogDiag = `供应商「${cat.provider.name}」点名的 ${cat.provider.keySecret} 没配进这台机器`;
    };
    if (this.name === OWNER_AGENT) {
      const cat = deep ? await this.deepCatalog() : await this.activeCatalog();
      if (cat) diagKeyMissing(cat);
      else this._catalogDiag = "模型目录为空或没有生效的模型条目";
      return cat;
    }
    const c = this._activeCatalog.get(deep);
    if (c && Date.now() - c.at < ACTIVE_CONFIG_CACHE_MS) return c.cat;
    const gen = this._catalogGen;
    // 跨间抖动重试一次：目录是聊天必需，回落旧链多半没 key，等于一句话都发不出去
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const owner = this.env.COWORK_AGENT.get(
          this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
        );
        let cat: ActiveCatalog | null =
          (await (deep
            ? owner.deepCatalog(this.name)
            : owner.activeCatalog(this.name))) || null;
        // 深度那组的 key 没配：退回主线，别一头栽进 secrets 旧链
        if (deep && cat) {
          const key = (this.env as unknown as Record<string, unknown>)[
            cat.provider.keySecret
          ];
          if (typeof key !== "string" || !key)
            return await this.fetchActiveCatalog(false);
        }
        // 只缓存拿到的目录：缓存 null 会让之后 30 秒每句白跑一趟还照样失败
        if (cat) {
          diagKeyMissing(cat);
          // 取的过程被作废：本轮照用但不回填，否则旧目录带新时间戳再驻 30 秒
          if (gen === this._catalogGen)
            this._activeCatalog.set(deep, { at: Date.now(), cat });
        } else {
          this._catalogDiag = "主屋目录为空或没有生效的模型条目";
        }
        return cat;
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        console.error(`[catalog] 取主屋目录失败（第 ${attempt} 次）：`, e);
        this._catalogDiag = `跨间取目录失败：${msg}`;
        if (attempt === 1) continue;
        return null;
      }
    }
    return null;
  }

  /**
   * 最近一次解析出的模型组（每轮刷新）。维护模型跟它走 ——
   * 生效配置换厂商后，维护活不能还打旧门。
   */
  private _resolved: ResolvedModel | null = null;

  /** 这一轮攒下的原始死因（流级错误/被叫停/截断）。开轮清零，轮尾消费；内存态，丢了不影响历史。 */
  private turnCapture: TurnCapture | null = null;

  /**
   * 轮内检索缓存：同轮同词复用一次向量查询（Vectorize 按维度计费）。
   * 写记忆的工具执行时当场清 —— 刚记下的话必须当场搜得到，这条比省一次查询重要。
   */
  private readonly recallCache = new Map<string, MemEntry[]>();

  /**
   * 维护模型：优先用本轮解析出的那份，没开聊时回落 secrets 链。
   * 只给轮内用；闹钟轮（回想、夜间整理、提醒）走 resolveMaintModel。
   */
  maintModel(): LanguageModel | null {
    return this._resolved?.maintModel ?? maintenanceModel(this.env);
  }

  /**
   * 维护模型冷唤醒版：_resolved 为空时同步版只会回落旧链，而机器常常只配了目录，
   * 回落就是 null —— 后台活会静默什么都不干。这里补一次目录解析。
   */
  async resolveMaintModel(): Promise<LanguageModel | null> {
    const hit = this.maintModel();
    if (hit) return hit;
    const resolved = await resolveModel(this.env, () =>
      this.fetchActiveCatalog(false),
    );
    return resolved?.maintModel ?? null;
  }

  /** 投票。同值再投即取消。踩下去会触发一次自动反思。 */
  vote(
    messageId: string,
    voter: string,
    value: number,
  ): { value: VoteValue | null } {
    this.ensureFeedback();
    const next = setVote(this.db, messageId, voter, value > 0 ? 1 : -1);
    if (next === -1) this.ctx.waitUntil(this.reflectOnDislike(messageId));
    return { value: next };
  }

  readComments(messageId: string): CommentRow[] {
    this.ensureFeedback();
    return listComments(this.db, messageId);
  }

  postComment(messageId: string, author: string, content: string): CommentRow {
    this.ensureFeedback();
    const row = addComment(this.db, messageId, author, content);
    // 他留的评论记一笔 local 账（下轮开口时提一次，带时刻、说完划掉）；我自己回的那句不记
    if (author !== AI_AUTHOR) {
      this.ensureEvents();
      const who = author === "admin" ? "他" : "这位来客";
      insertEvent(this.db, {
        scope: "local",
        sessionId: this.currentSessionId(),
        kind: "comment",
        text: `${who}在消息 [${row.messageId}] 下留了评论：${row.content.slice(0, 60)}`,
      });
    }
    return row;
  }

  /** 被踩 → 写一条反思进 reflections，让这个方向进长期记忆。走 waitUntil，不让人等。 */
  private async reflectOnDislike(messageId: string): Promise<void> {
    const target = this.messages.find((m) => m.id === messageId);
    const excerpt = target ? messageText(target).slice(0, 200) : "";
    if (!excerpt) return;

    const note =
      (await this.maintenance(
        "你刚才的一条回答被点踩了。用第一人称写一条反思，一句话，说清这个回答哪里不对、以后该怎么做。" +
          "只输出反思本身，不要解释。",
        `被点踩的回答：${excerpt}`,
      )) ||
      `被点踩的回答：「${excerpt.slice(0, 80)}」——这个方向不对，以后不要再这样答。`;

    const entry = insertMemory(this.db, {
      type: "insight",
      content: note.slice(0, 300),
      shelf: "reflections",
      tags: ["feedback", "dislike"],
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
  }

  /**
   * 从刚过去的一段对话里长经验（patterns 书架）：主动复盘，区别于被踩才反思。
   * 走 waitUntil、由调用方 catch 兜底，不让人等；长不出经验是遗憾，让对话出错才是事故。
   */
  private async distillExperience(): Promise<void> {
    const total = this.messages.length;
    // 懒初始化：老实例没有 expUpto，退到「只回看最近一批」而不是从 0 开始。
    // 游标是屋级、messages 是会话级：换场后旧游标越界就作废重来，
    // 否则 total - from 恒小于 EXP_EVERY，复盘永久停摆；重看项的重复由 isDuplicate 滤掉。
    const from =
      typeof this.state.expUpto === "number" && this.state.expUpto <= total
        ? this.state.expUpto
        : Math.max(0, total - EXP_EVERY);
    if (total - from < EXP_EVERY) return;

    const slice = this.messages.slice(Math.max(from, total - EXP_WINDOW));
    const lines = slice
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "我"}: ${messageText(m).slice(0, 400)}`,
      )
      .filter((s) => s.length > 8);

    // 全是工具往返、没有真正的人话，就没有什么可复盘的
    if (lines.length < 6) {
      this.patchState({ expUpto: total });
      return;
    }

    const known = listMemories(this.db, "patterns", EXP_CAP).map(
      (e) => e.content,
    );
    const out = await this.maintenance(
      experiencePrompt(known),
      lines.join("\n").slice(0, 6000),
    );
    const fresh = parseExperience(out).filter((l) => !isDuplicate(l, known));

    for (const line of fresh) {
      const entry = insertMemory(this.db, {
        type: "insight",
        content: line,
        shelf: "patterns",
        tags: ["experience"],
      });
      this.enqueueVector({
        id: entry.id,
        content: entry.content,
        type: entry.type,
        shelf: entry.shelf,
        tags: entry.tags,
      });
    }

    // 游标在成功之后才推进：这次没总结出东西，下次连同新的消息一起再看。
    this.patchState({
      expUpto: total,
      expCount: (this.state.expCount || 0) + fresh.length,
    });
  }
}
