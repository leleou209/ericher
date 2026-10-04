// 写额度计量：今天到底写了多少行、写到哪儿去了。
//
// 为什么要这个东西：DO 免费层每天 10 万行写入，超了之后整个 DO 连「读」都会失败 ——
// 表现就是「我整个人都动不了」。可到底是谁在写、写了多少，一直只能靠猜。
// 猜没用。这笔账得能看见，否则每次瘫掉都只能等第二天早上八点。
//
// 口径说明（跟 Cloudflare 的账单不完全一样，但足够用来找元凶）：
//   - 写入：一条 INSERT / UPDATE / DELETE 记 1 行。真实口径按影响行数算，
//     批量语句会低估；我们这儿基本都是单行语句，误差很小。
//   - 建表建索引这类结构变更不算（幂等空操作，算进去反而虚报，见 DDL_RE）。
//   - 读取：记的是「返回了多少行」。真实口径是「扫描了多少行」，
//     所以这个数只会偏小 —— 偏小是安全的，宁可低估也不虚报。

const DAILY_WRITE_CAP = 100_000;
const DAILY_READ_CAP = 5_000_000;

/**
 * 攒够这么多行就先落一次账。太小会让记账本身变成开销，太大又容易丢。
 *
 * 原本是 1000：额度紧张的时候，「为了看得见账而写账」本身也要算进那 10 万行里，
 * 提到 5000 之后这笔开销降到 1/5，丢弃风险也不过是「驱逐时少记几千行」。
 */
const FLUSH_EVERY = 5000;

export interface WriteReport {
  day: string;
  writes: number;
  reads: number;
  writeCap: number;
  readCap: number;
  /**
   * 最费写入额度的几处，降序。
   * 只列写：这块面板要回答的是「谁在吃那 10 万行」，读混进来只会把答案挤下去
   * （读的上限是 500 万行，本来也不是瓶颈）。
   */
  top: Array<{ key: string; n: number }>;
  /** 还在内存里没落账的那部分（正常情况下很小） */
  pending: number;
}

/** 落账时的一行 */
export interface MeterCell {
  key: string;
  n: number;
}

const WRITE_OPS = new Set(["insert", "replace", "update", "delete"]);
/**
 * 建表 / 建索引 / 改表结构这类语句。
 *
 * 为什么不把它们算成写入：唤醒时那一堆 `CREATE TABLE IF NOT EXISTS` 是幂等空操作，
 * 表已经在了就一行都不会写。而 DO 一天会被唤醒很多次，每次都十几条 DDL ——
 * 把它们算进去，账面上会凭空多出几万行「写入」，反而把真凶盖住。
 * 宁可低估，也不虚报。
 */
const DDL_RE = /^(create|drop|alter|pragma|vacuum|reindex)/;

const NAME = String.raw`([\w.]+)`;
/**
 * 表名怎么找：每种语句的位置不一样。
 * 先看 index 那条 —— 它的第一个名字是索引名，表名在 ON 后面，
 * 弄反了就会冒出一个根本不存在的「表」，把排行榜带偏。
 */
const TABLE_RES: RegExp[] = [
  new RegExp(
    String.raw`^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+${NAME}`,
  ),
  new RegExp(String.raw`^(?:insert|replace)(?:\s+or\s+\w+)?\s+into\s+${NAME}`),
  new RegExp(String.raw`^update(?:\s+or\s+\w+)?\s+${NAME}`),
  new RegExp(String.raw`^delete\s+from\s+${NAME}`),
  new RegExp(String.raw`^create\s+table\s+(?:if\s+not\s+exists\s+)?${NAME}`),
  new RegExp(String.raw`^alter\s+table\s+${NAME}`),
  new RegExp(String.raw`^select[\s\S]*?\sfrom\s+${NAME}`),
];

/**
 * 把模板串拼成语句骨架：值用 ? 顶替。
 * 数账只关心「哪张表、什么动作」，值是什么无关紧要。
 */
export function sqlText(strings: unknown): string {
  if (Array.isArray(strings)) return (strings as string[]).join("?");
  return String(strings ?? "");
}

/** 压平空白、去掉标识符引号、转小写 —— 后面全部按小写匹配。 */
function normalize(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[`"[\]]/g, " ");
}

/** 这条语句算不算占额度。只认真正的行级写。 */
export function isWrite(text: string): boolean {
  const first = text.split(" ", 1)[0] || "";
  return WRITE_OPS.has(first);
}

/** 结构变更：不占行，也不进账。 */
export function isDdl(text: string): boolean {
  return DDL_RE.test(text);
}

/** 账本里存的 key 长这样：「动作:表名」。这条是不是结构变更。 */
function isDdlKey(key: string): boolean {
  const op = key.split(":", 1)[0] || "";
  return DDL_RE.test(op);
}

/** 「动作:表名」，找不到表名就只留动作。 */
export function classify(raw: string): string {
  const text = normalize(raw);
  const first = text.split(" ", 1)[0] || "";
  // 认不出动作就别硬塞进读里 —— 那会让「读取」这一栏凭空变大，把元凶带偏
  if (!first) return "other";
  const op = WRITE_OPS.has(first) || DDL_RE.test(text) ? first : "read";
  for (const re of TABLE_RES) {
    const hit = re.exec(text);
    if (hit) return `${op}:${hit[1]}`;
  }
  return op;
}

/** 和 Cloudflare 的额度重置对齐：UTC 零点，也就是北京早上八点。 */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function addAll(
  into: Map<string, number>,
  cells: Iterable<MeterCell>,
): Map<string, number> {
  for (const c of cells) into.set(c.key, (into.get(c.key) || 0) + c.n);
  return into;
}

/**
 * 计量器。
 *
 * 为什么不只用内存记：DO 一闲下来就会被驱逐，内存里的数跟着没。
 * 那「今天一共写了多少」永远读出来都是零，等于白做。
 * 所以攒一批就落一次账（一天一行、一个来源一行），开销约千分之几。
 *
 * 结构是「已落账的 base」+「还没落账的 pending」，两者相加才是全部。
 * 驱逐重启后 base 由 loader 从库里读回来，pending 从零开始 —— 数不会丢，也不会重复算。
 */
export class Meter {
  /** agent 挂回调时置位。agent 那边也是靠它保证只挂一次。 */
  attached = false;

  private day = utcDay();
  /** 上一轮结束时写到哪儿了，用来算「这一轮写了多少」 */
  private turnMark = 0;
  /** 已经落账的部分（惰性从库里读一次）。writes / reads 都由它现算，不另存一份 */
  private base = new Map<string, number>();
  private baseLoaded = false;
  /** 还没落账的部分 */
  private pendingWrites = 0;
  private pendingReads = 0;
  private pending = new Map<string, number>();
  /** 落账 / 读账用的回调，由 agent 挂上来（它才有数据库） */
  private sink?: (day: string, cells: MeterCell[]) => void;
  private loader?: (day: string) => MeterCell[];
  /** 正在落账 / 读账：这期间的 sql 不再计数，免得「记账的账」也记进去 */
  private busy = false;

  attach(
    sink: (day: string, cells: MeterCell[]) => void,
    loader: (day: string) => MeterCell[],
  ): void {
    this.sink = sink;
    this.loader = loader;
  }

  /**
   * 写和读分别多少。
   * 结构变更（建表建索引）一律不认 —— 它们是幂等空操作，
   * 认了就会在账面上凭空多出几万行，把真凶盖住。
   */
  private totals(): { writes: number; reads: number } {
    let writes = this.pendingWrites;
    let reads = this.pendingReads;
    for (const [key, n] of this.base) {
      if (isDdlKey(key)) continue;
      if (key.startsWith("read")) reads += n;
      else writes += n;
    }
    return { writes, reads };
  }

  private ensureBase(): void {
    if (this.baseLoaded || !this.loader) return;
    this.baseLoaded = true;
    // 先标记再读：loader 自己会发 SELECT，不标记就会绕回来
    this.busy = true;
    try {
      this.base = new Map(this.loader(this.day).map((c) => [c.key, c.n]));
      // 起点只算「账本里已有的」，不含内存里攒的这批 ——
      // 否则驱逐重启后第一轮会把今天早些时候写的全算成「这一轮写的」
      let done = 0;
      for (const [key, n] of this.base) {
        if (!isDdlKey(key) && !key.startsWith("read")) done += n;
      }
      this.turnMark = done;
    } catch {
      // 库还没建好或读不到：就当从零开始，不影响正常干活
    } finally {
      this.busy = false;
    }
  }

  /** 记一笔。rowCount 只有读语句才用得上。 */
  note(rawSql: string, rowCount = 0): void {
    if (this.busy) return;
    this.roll();
    const text = normalize(rawSql);
    // 结构变更直接放过：它不占行，记进来只会把真凶盖住
    if (isDdl(text)) return;
    const key = classify(text);
    if (isWrite(text)) {
      this.pendingWrites++;
      this.pending.set(key, (this.pending.get(key) || 0) + 1);
      if (this.pendingWrites >= FLUSH_EVERY) this.flush();
    } else {
      // 读不占写入额度，但「谁在读、读了多少行」一样值得看
      this.pendingReads += Math.max(0, rowCount);
      if (rowCount > 0)
        this.pending.set(key, (this.pending.get(key) || 0) + rowCount);
    }
  }

  /** 跨天（UTC）就清空重来 —— 额度按自然日给，昨天的账不该算在今天头上。 */
  roll(now = Date.now()): void {
    const d = utcDay(now);
    if (d === this.day) return;
    this.day = d;
    this.turnMark = 0;
    this.base = new Map();
    this.baseLoaded = false;
    this.pendingWrites = 0;
    this.pendingReads = 0;
    this.pending.clear();
  }

  /** 把内存里攒的落一次账。攒着不落，驱逐一次就丢了。 */
  flush(): void {
    this.ensureBase();
    if (!this.sink || this.pending.size === 0) return;
    const cells = [...this.pending.entries()].map(([key, n]) => ({ key, n }));
    this.busy = true;
    try {
      this.sink(this.day, cells);
    } catch {
      // 落账失败（比如额度已经满了）：留在内存里，下次再试
      return;
    } finally {
      this.busy = false;
    }
    addAll(this.base, cells);
    this.pendingWrites = 0;
    this.pendingReads = 0;
    this.pending.clear();
  }

  /**
   * 一轮结束时报一句：这一轮写了多少。给 wrangler tail 看，也给遥测用。
   * 把数字返回出去而不是在这儿直接发事件：计量器不该知道 env，
   * 谁调它谁才有那个上下文。
   */
  turn(label: string): { delta: number; total: number } {
    this.roll();
    this.ensureBase();
    const total = this.totals().writes;
    const delta = total - this.turnMark;
    this.turnMark = total;
    // 攒着的趁这会儿落账 —— 一轮最多一次，比每条语句都写便宜得多
    this.flush();
    if (delta > 0)
      console.log(
        `[meter] ${label}：这一轮写了 ${delta} 行，今天累计 ${total} 行`,
      );
    return { delta, total };
  }

  report(): WriteReport {
    this.roll();
    // 面板打开时把攒着的落掉，不然看到的数是「上次落账时」的
    this.flush();
    const { writes, reads } = this.totals();
    const top = [...this.base.entries()]
      .filter(([key]) => !isDdlKey(key) && !key.startsWith("read"))
      .map(([key, n]) => ({ key, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    return {
      day: this.day,
      writes,
      reads,
      writeCap: DAILY_WRITE_CAP,
      readCap: DAILY_READ_CAP,
      top,
      pending: this.pendingWrites,
    };
  }
}

/**
 * 每个 agent 实例一份。
 *
 * 不用类字段：基类构造时就会发 SQL，那时候子类字段还没初始化，
 * 用字段会读到 undefined。挂在实例上的 WeakMap 不受初始化顺序影响。
 */
const REGISTRY = new WeakMap<object, Meter>();

export function meterOf(host: object): Meter {
  let m = REGISTRY.get(host);
  if (!m) {
    m = new Meter();
    REGISTRY.set(host, m);
  }
  return m;
}
