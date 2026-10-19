import type { MemEntry } from "../agent/state";

/** 取数由调用方注入：本模块只决定「哪些记忆允许出现在这一轮的提示词里」 */
export interface ChatMemorySource {
  /** 还没对上、又还新鲜的疑问（最多 3 条） */
  doubts(): string;
  /** 来客受限读：管理员公开的 + 这位客人名下的 */
  guestLines(query: string): Promise<string[]>;
  /** 本间存底（主人没醒、或一笔没翻到时的兜底） */
  local(query: string): Promise<MemEntry[]>;
  /** 统一检索：本间 + 主屋合并去重 */
  merged(query: string): Promise<MemEntry[]>;
  /** 命中条目 → 提示词行（带「学到多久了」时间标） */
  hitLines(hits: MemEntry[]): string[];
}

export interface ChatMemoryBlocks {
  memoryBlock: string;
  doubtBlock: string;
  publicBlock: string;
}

/**
 * 轮首的记忆注入。
 *
 * 档位把「记忆」关掉的来客必须一条都不注入：工具已经移除、说明已经剪掉，
 * 注入块要是还在，模型就会看着注入块承认「我记下了」——那是一条根本没落库的记忆。
 * 所以这里用早退而不是分支兜底：一旦判定不允许，取数回调一个都不该被调用。
 */
export async function chatMemoryBlocks(
  source: ChatMemorySource,
  query: string,
  guest: boolean,
  memoryAllowed: boolean,
): Promise<ChatMemoryBlocks> {
  const blocks: ChatMemoryBlocks = { memoryBlock: "", doubtBlock: "", publicBlock: "" };
  if (!query || (guest && !memoryAllowed)) return blocks;

  try {
    blocks.doubtBlock = source.doubts();
  } catch {
    // 疑问块是锦上添花：表还没补好列之类的问题，不该让这轮说不了话
  }

  if (guest) {
    let lines: string[] = [];
    try {
      lines = await source.guestLines(query);
    } catch {
      // 主人那间没醒，用本地兜底
    }
    if (!lines.length) {
      lines = source.hitLines(await source.local(query).catch(() => []));
    }
    if (lines.length) {
      blocks.publicBlock =
        "\n\n## 记忆库里翻到的（管理员公开的 + 这位客人名下的）\n" + lines.join("\n");
    }
  } else {
    const hits = await source.merged(query).catch(() => []);
    if (hits.length) {
      blocks.memoryBlock =
        "\n\n## 相关记忆（检索自长期记忆库）\n" + source.hitLines(hits).join("\n");
    }
  }
  return blocks;
}
