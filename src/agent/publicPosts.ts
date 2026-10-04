// public_posts：公开墙。
//
// 「公开内容」的落点：permPublic 档位的持卡者可以把一句话贴上墙，
// 进门的人谁都看得到。和公开账本（管理员点头公开的记忆）是两回事 ——
// 账本是 ericher 的记忆摊给来客，墙上是人自己贴的纸条。
//
// 表只建在主人那间（和 guest_types / user_cards 一样是台子的配置）：
// 墙是这个家的公告板，不属于任何一间来客屋。发帖人只用昵称快照 ——
// 卡注销了帖子还在，署名是他贴上去那一刻报的名字。

import type { SqlTag } from "./state";

export interface PublicPost {
  id: string;
  /** 发帖人卡 id：撤回时校验「这贴是不是你发的」 */
  cardId: string;
  /** 昵称快照：贴上墙那一刻的名字 */
  author: string;
  content: string;
  created: string;
}

interface PostRow {
  id: string;
  card_id: string;
  author: string;
  content: string;
  created: string;
}

function rowToPost(r: PostRow): PublicPost {
  return {
    id: r.id,
    cardId: r.card_id,
    author: r.author,
    content: r.content,
    created: r.created,
  };
}

function ensurePublicPostsSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS public_posts (
       id      TEXT PRIMARY KEY,
       card_id TEXT NOT NULL,
       author  TEXT NOT NULL,
       content TEXT NOT NULL,
       created TEXT NOT NULL
     )`;
}

/** 贴一条上墙。内容按 500 字封顶 —— 墙是贴纸条的地方，不是发文的地方 */
export function createPublicPost(
  sql: SqlTag,
  input: { cardId: string; author: string; content: string },
): PublicPost {
  ensurePublicPostsSchema(sql);
  const row: PostRow = {
    id: crypto.randomUUID().slice(0, 8),
    card_id: input.cardId,
    author: (input.author || "").trim().slice(0, 40) || "无名氏",
    content: (input.content || "").trim().slice(0, 500),
    created: new Date().toISOString(),
  };
  if (!row.content) throw new Error("墙上不贴白纸：内容不能空");
  sql`INSERT INTO public_posts (id, card_id, author, content, created)
      VALUES (${row.id}, ${row.card_id}, ${row.author}, ${row.content},
              ${row.created})`;
  return rowToPost(row);
}

/** 墙上现在贴着什么，新的在前 */
export function listPublicPosts(sql: SqlTag, limit = 200): PublicPost[] {
  ensurePublicPostsSchema(sql);
  return sql<PostRow>`
    SELECT id, card_id, author, content, created
    FROM public_posts ORDER BY created DESC LIMIT ${limit}`.map(rowToPost);
}

/**
 * 摘掉一条。byCardId 给了就只许摘本人那张卡发的 —— 撤回自己的话；
 * 没给就是管理员（主人收拾这块板子）。摘了不存在的返回 false。
 */
export function removePublicPost(
  sql: SqlTag,
  id: string,
  byCardId?: string,
): boolean {
  ensurePublicPostsSchema(sql);
  const rows = byCardId
    ? sql<PostRow>`SELECT id FROM public_posts
        WHERE id = ${id} AND card_id = ${byCardId}`
    : sql<PostRow>`SELECT id FROM public_posts WHERE id = ${id}`;
  if (!rows.length) return false;
  sql`DELETE FROM public_posts WHERE id = ${id}`;
  return true;
}
