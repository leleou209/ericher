// 资源自计量：AI neurons 和 Vectorize 维度到底花了多少。
//
// 为什么这两个要自己数：Cloudflare 的 GraphQL Analytics 接口查得到请求数和
// SQL 读写行（见 analytics.ts），但 Workers AI 的 neurons 和 Vectorize 的
// 维度用量没有公开查询入口 —— 面板上想看，只有一条路：在自己的消耗点上埋账。
// 埋账的地方就三处：embed() 一次、flux 出图一次、Vectorize 查/写一次。
//
// 口径说明（和账单不完全一样，但足够回答「离上限还远不远」）：
//   - neurons 是估算：Workers AI 的响应里没有可靠的 usage 字段，
//     按字符估 token（中日韩一个字 ≈ 1 token，其余 4 个字符 ≈ 1 token），
//     再乘官方单价。估算只会偏差不至于偏一个数量级，看趋势够用。
//   - Vectorize 存储维是近似存量：upsert 覆盖同一条不新增维度，
//     这里按 ±1024 记，改一条记忆会虚增一点。宁可看错一点，不漏看。

/** bge-m3 官方单价：1075 neurons / 百万输入 token ≈ 1.075 / token */
export const NEURONS_PER_TOKEN = 1.075;
/** flux-2-klein-4b 官方单价：输出 26.05 / 512² tile，输入 5.37 / 512² tile */
const FLUX_OUT_PER_TILE = 26.05;
const FLUX_IN_PER_TILE = 5.37;
/** bge-m3 的向量维度（Vectorize 按维度计量） */
export const EMBED_DIMS = 1024;

// 免费档上限（Workers AI 按天、Vectorize 按月，都按 UTC 重置口径对齐）
export const NEURONS_CAP = 10_000;
export const VEC_QUERY_CAP = 30_000_000;
export const VEC_STORE_CAP = 5_000_000;

/** 自计量的全部家当。存进 state.usage，面板读的就是它。 */
export interface UsageSnapshot {
  /** 日计数所属的 UTC 日（YYYY-MM-DD），跨天清零 */
  day: string;
  /** 今天烧掉的 neurons（估算） */
  neurons: number;
  /** 今天跑了多少次 embedding */
  embeds: number;
  /** 今天用 FLUX 画了几张 */
  images: number;
  /** 月计数所属的 UTC 月（YYYY-MM），跨月清零 */
  month: string;
  /** 这个月查询过多少维（topK × 1024 的累计） */
  vecQueriedDims: number;
  /** 当前存着多少维（近似存量） */
  vecStoredDims: number;
}

export interface ResourceReport extends UsageSnapshot {
  neuronsCap: number;
  vecQueryCap: number;
  vecStoreCap: number;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** 按字符估 token：CJK 一字一 token，其余四个字符一个。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) || 0;
    // 常用汉字、日文假名、韩文、全角标点
    if (
      (c >= 0x3000 && c <= 0x30ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef)
    )
      cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一张 FLUX 图的 neurons：输出 tile 数 × 26.05，外加提示词那侧约 1 个 tile。 */
export function fluxNeurons(w: number, h: number): number {
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return tiles * FLUX_OUT_PER_TILE + FLUX_IN_PER_TILE;
}

function zeroSnap(now = Date.now()): UsageSnapshot {
  return {
    day: utcDay(now),
    neurons: 0,
    embeds: 0,
    images: 0,
    month: utcMonth(now),
    vecQueriedDims: 0,
    vecStoredDims: 0,
  };
}

/**
 * 计数器本体。
 *
 * 为什么是模块级单例而不是每个 agent 一份：neurons 和 Vectorize 的额度是
 * 整个账号共用的，谁烧的都该进同一本账。主人那间负责把账本快照存回 state
 * （每轮至多一次，且只在数字动了的时候），面板读主人 state 里的那份。
 * 来客那几间若落在别的 isolate，它们的零星消耗暂时汇不进来 —— 量太小，
 * 不值得为它多写一张表。
 */
export class UsageCounter {
  private snap = zeroSnap();
  /** 主人那间第一次拿到 state 里的旧账时接一次，之后不再碰 loader */
  private hydrated = false;
  /** 上次写回 state 时的快照，用来判断「这一轮到底动没动」 */
  private lastFlushed = JSON.stringify(this.snap);

  /**
   * 从 state.usage 接回上个实例落账的数。只接一次；跨天/跨月的旧数直接作废。
   *
   * 是「加」不是「换」：state 里那份是上一个实例写回时的总数，
   * 内存里这份是这个实例开机之后新记的 —— 两段时间不重叠，相加才是今天的全账。
   * 换掉的话，唤醒后、接账前那几笔就被抹掉了。
   */
  hydrate(saved: UsageSnapshot | undefined | null): void {
    if (this.hydrated) return;
    this.hydrated = true;
    if (!saved) return;
    this.roll();
    const day = this.snap.day;
    const month = this.snap.month;
    if (saved.day === day) {
      this.snap.neurons += saved.neurons || 0;
      this.snap.embeds += saved.embeds || 0;
      this.snap.images += saved.images || 0;
    }
    if (saved.month === month) {
      this.snap.vecQueriedDims += saved.vecQueriedDims || 0;
      this.snap.vecStoredDims += saved.vecStoredDims || 0;
    }
    this.lastFlushed = JSON.stringify(this.snap);
  }

  /** 跨天/跨月就地清零 —— 额度按自然日/月给，昨天的账不该压在今天头上。 */
  private roll(): void {
    const now = Date.now();
    const day = utcDay(now);
    const month = utcMonth(now);
    if (this.snap.day !== day) {
      this.snap.day = day;
      this.snap.neurons = 0;
      this.snap.embeds = 0;
      this.snap.images = 0;
    }
    if (this.snap.month !== month) {
      this.snap.month = month;
      this.snap.vecQueriedDims = 0;
      this.snap.vecStoredDims = 0;
    }
  }

  noteEmbed(text: string): void {
    this.roll();
    this.snap.neurons += estimateTokens(text) * NEURONS_PER_TOKEN;
    this.snap.embeds++;
  }

  noteFluxImage(w: number, h: number): void {
    this.roll();
    this.snap.neurons += fluxNeurons(w, h);
    this.snap.images++;
  }

  noteVecQuery(topK: number): void {
    this.roll();
    this.snap.vecQueriedDims += topK * EMBED_DIMS;
  }

  noteVecUpsert(n = 1): void {
    this.roll();
    this.snap.vecStoredDims += n * EMBED_DIMS;
  }

  noteVecDelete(n = 1): void {
    this.roll();
    this.snap.vecStoredDims = Math.max(
      0,
      this.snap.vecStoredDims - n * EMBED_DIMS,
    );
  }

  snapshot(): UsageSnapshot {
    this.roll();
    return { ...this.snap };
  }

  /** 和上次写回的比一比：没动就一个字都不用写（state 落盘是要占写额度的）。 */
  dirty(): boolean {
    this.roll();
    return JSON.stringify(this.snap) !== this.lastFlushed;
  }

  markFlushed(): void {
    this.lastFlushed = JSON.stringify(this.snap);
  }

  report(): ResourceReport {
    this.roll();
    return {
      ...this.snap,
      neurons: Math.round(this.snap.neurons),
      neuronsCap: NEURONS_CAP,
      vecQueryCap: VEC_QUERY_CAP,
      vecStoreCap: VEC_STORE_CAP,
    };
  }
}

/** 全模块共用的一本账（见类注释）。 */
export const usage = new UsageCounter();
