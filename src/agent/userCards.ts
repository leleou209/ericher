// user_cards：长期使用者的身份卡。
//
// 门禁码只回答「能不能进」，身份卡回答「你是谁、回到哪间屋」。
// 一张卡把某个长期使用者绑在他自己的房间里：昵称全局唯一、目的必填、
// 密码摘要入库 —— 下次凭「昵称 + 密码」登卡，直接回到同一间屋子，
// 记忆、对话、留痕都在，换设备也一样。
//
// 卡不派生房间，卡「绑定」房间：room 字段记的是领卡那一刻所在的屋子。
// 这样临时聊着聊着想变长期，当前房间整体升级，历史一条不用搬。
//
// 表只建在主人那间（和 guest_types 一样是台子的配置）；卡上的权益
// 跟着所属类型档走 —— 档位勾了记事本 / 云盘 / 公开，卡的主人才能开。

import { timingSafeEqual } from "../auth";
import { hashPassword } from "./guestTypes";
import type { SqlTag } from "./state";

/** 内置通用档在卡表里的档位 id：走前台口令进来的卡都归这档（权益全开） */
export const COMMON_TYPE_ID = "common";

interface UserCardRow {
  id: string;
  /** 全局唯一昵称（登卡的钥匙之一） */
  name: string;
  /** 目的声明：长期使用者必填，进提示词，让 ericher 知道这人为什么来 */
  purpose: string;
  /** 联系邮箱：只登记不发送（项目没有邮件通道），管理员面板可见，用于人工联系 */
  email: string;
  /** SHA-256 摘要（hex）。明文不落表，和 guest_types 同一套规矩 */
  passwordHash: string;
  /** 归属权限档 */
  typeId: string;
  /** 绑定的房间（DO 实例名）：登卡就是回到这间 */
  room: string;
  created: string;
  lastSeen: string;
}

/** 对外快照：剥掉摘要。卡的主人自己也不需要看到摘要 */
export type UserCardPublic = Omit<UserCardRow, "passwordHash">;

interface CardRow {
  id: string;
  name: string;
  purpose: string;
  email: string;
  password_hash: string;
  type_id: string;
  room: string;
  created: string;
  last_seen: string;
}

function rowToCard(r: CardRow): UserCardRow {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    email: r.email,
    passwordHash: r.password_hash,
    typeId: r.type_id,
    room: r.room,
    created: r.created,
    lastSeen: r.last_seen,
  };
}

function ensureUserCardsSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS user_cards (
       id            TEXT PRIMARY KEY,
       name          TEXT NOT NULL UNIQUE,
       purpose       TEXT NOT NULL DEFAULT '',
       email         TEXT NOT NULL DEFAULT '',
       password_hash TEXT NOT NULL,
       type_id       TEXT NOT NULL,
       room          TEXT NOT NULL,
       created       TEXT NOT NULL,
       last_seen     TEXT NOT NULL
     )`;
}

function cardById(sql: SqlTag, id: string): UserCardRow | null {
  const rows = sql<CardRow>`
    SELECT id, name, purpose, email, password_hash, type_id, room,
           created, last_seen
    FROM user_cards WHERE id = ${id}`;
  return rows.length ? rowToCard(rows[0]) : null;
}

/** 按 id 查卡。查无此卡返回 null。 */
export function getUserCard(sql: SqlTag, id: string): UserCardRow | null {
  ensureUserCardsSchema(sql);
  return cardById(sql, id);
}

/** 剥成对外快照 */
export function toUserCardPublic(c: UserCardRow): UserCardPublic {
  const { passwordHash: _passwordHash, ...rest } = c;
  return rest;
}

/**
 * 领卡（或把当前临时会话升级成长期）。昵称全局唯一，密码不许和两个门禁码撞。
 * room 绑定领卡那一刻所在的屋子 —— 升级路径的历史一条不搬。
 */
export async function createUserCard(
  sql: SqlTag,
  input: {
    name: string;
    purpose: string;
    password: string;
    email?: string;
    typeId: string;
    room: string;
    adminPw: string;
    gatePw: string;
  },
): Promise<UserCardRow> {
  ensureUserCardsSchema(sql);
  const name = (input.name || "").trim().slice(0, 40);
  const purpose = (input.purpose || "").trim().slice(0, 300);
  const email = (input.email || "").trim().slice(0, 120);
  const password = input.password || "";
  if (!name) throw new Error("昵称不能为空");
  if (!purpose) throw new Error("长期身份需要说明来意，这一栏不能空着");
  if (password.length < 6) throw new Error("卡密码至少 6 位");
  if (input.adminPw && timingSafeEqual(password, input.adminPw))
    throw new Error("卡密码和管理员口令撞了，换一个");
  if (input.gatePw && timingSafeEqual(password, input.gatePw))
    throw new Error("卡密码和门禁口令撞了，换一个");
  const dup = sql<{ id: string }>`
    SELECT id FROM user_cards WHERE name = ${name}`;
  if (dup.length)
    throw new Error(`「${name}」已经有人用了，换一个昵称（或直接登卡）`);
  const row: CardRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    purpose,
    email,
    password_hash: await hashPassword(password),
    type_id: input.typeId || COMMON_TYPE_ID,
    room: input.room,
    created: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  sql`INSERT INTO user_cards (id, name, purpose, email, password_hash,
            type_id, room, created, last_seen)
      VALUES (${row.id}, ${row.name}, ${row.purpose}, ${row.email},
              ${row.password_hash}, ${row.type_id}, ${row.room},
              ${row.created}, ${row.last_seen})`;
  return rowToCard(row);
}

/**
 * 登卡：昵称 + 密码对上了返回那张卡。密码只认摘要比对；
 * 查无此人、密码不对都返回 null —— 不区分「没有这个人」和「密码错了」，
 * 免得给试探的人报点。
 */
export async function verifyCardLogin(
  sql: SqlTag,
  name: string,
  password: string,
): Promise<UserCardRow | null> {
  if (!name || !password) return null;
  ensureUserCardsSchema(sql);
  const rows = sql<CardRow>`
    SELECT id, name, purpose, email, password_hash, type_id, room,
           created, last_seen
    FROM user_cards WHERE name = ${(name || "").trim().slice(0, 40)}`;
  if (!rows.length) return null;
  const card = rowToCard(rows[0]);
  const hash = await hashPassword(password);
  if (!timingSafeEqual(card.passwordHash, hash)) return null;
  return card;
}

/** 登卡成功后顺手刷新 last_seen（访客面板能看到这个人上次什么时候来） */
export function touchCard(sql: SqlTag, id: string): void {
  sql`UPDATE user_cards SET last_seen = ${new Date().toISOString()}
      WHERE id = ${id}`;
}

/** 卡的房间被删（管理员清房）时 nothing to bind —— 暂不提供改绑；列卡片 / 删卡给管理员面板用 */
export function listUserCards(sql: SqlTag): UserCardRow[] {
  ensureUserCardsSchema(sql);
  return sql<CardRow>`
    SELECT id, name, purpose, email, password_hash, type_id, room,
           created, last_seen
    FROM user_cards ORDER BY created`.map(rowToCard);
}

export function removeUserCard(sql: SqlTag, id: string): boolean {
  ensureUserCardsSchema(sql);
  const rows = sql<{ id: string }>`SELECT id FROM user_cards WHERE id = ${id}`;
  if (!rows.length) return false;
  sql`DELETE FROM user_cards WHERE id = ${id}`;
  return true;
}
