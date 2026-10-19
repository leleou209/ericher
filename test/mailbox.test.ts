/**
 * 信箱两本账的门禁：发件流水（mail_out）与收件（mail_in）。
 *
 * 库用真 SQLite（node:sqlite）—— 剪枝那几句是带子查询的 DELETE，假库测不出行为；
 * R2 用一个 Map 假桶，接口只取 mailbox.ts 声明的那三点（put/get/delete）。
 *
 * 钉住的四件事：
 *   1. 发出去的每一封都落一行，**失败也落**（只记成功的账本等于没账本）；
 *   2. 剪枝剪掉旧行时，挂在 R2 上的原件必须一起交出去（否则字节永远攒在那儿没人看见）；
 *   3. 同一份报文重投/重喂只落一行（按内容 hash 去重）；
 *   4. 原件太大或没配桶时行照记、键留空 —— 界面由此能说清「这封只有摘要」。
 *
 * 运行: npx vitest run test/mailbox.test.ts
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlTag } from "../src/agent/state";
import {
  EML_MAX_BYTES,
  MAIL_IN_KEEP,
  MAIL_OUT_KEEP,
  ensureMailboxSchema,
  emlKeyFor,
  findMailIn,
  getEml,
  insertMailIn,
  listMailIn,
  listMailOut,
  mailInUnread,
  parseAttachments,
  putEml,
  recordMailOut,
  serializeAttachments,
  setMailInRead,
  toHex,
  MAX_ATTACH_ITEMS,
  type EmlStore,
} from "../src/mail/mailbox";
import type { MailInRow } from "../src/mail/mailboxTypes";

function database(): { db: DatabaseSync; sql: SqlTag } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    db
      .prepare(strings.join("?"))
      .all(...(values as (string | number | null)[])) as never) as unknown as SqlTag;
  return { db, sql };
}

const out = (over: Partial<Parameters<typeof recordMailOut>[1]> = {}) => ({
  at: "2026-10-19T08:00:00.000Z",
  to: ["a@x.test"],
  subject: "测试一封",
  ok: true,
  error: "",
  source: "panel" as const,
  ...over,
});

const row = (over: Partial<MailInRow> = {}): MailInRow => ({
  id: crypto.randomUUID(),
  at: "2026-10-19T08:00:00.000Z",
  from: "someone@else.test",
  fromName: "Someone",
  to: "ericher@bun.example.test",
  subject: "你好",
  bytes: 1234,
  read: false,
  hasAttachment: false,
  attachments: [],
  preview: "正文开头一段",
  emlKey: "",
  ...over,
});

describe("发件流水", () => {
  it("成功与失败都各落一行，读回来按新在前", () => {
    const { sql } = database();
    recordMailOut(sql, out({ at: "2026-10-19T08:00:00.000Z" }));
    recordMailOut(
      sql,
      out({
        at: "2026-10-19T09:00:00.000Z",
        ok: false,
        error: "认证被拒绝",
        source: "tool",
      }),
    );
    const rows = listMailOut(sql);
    expect(rows.length).toBe(2);
    // 最新那行在前：面板第一眼要看见刚刚发生了什么
    expect(rows[0].error).toBe("认证被拒绝");
    expect(rows[0].ok).toBe(false);
    expect(rows[0].source).toBe("tool");
    expect(rows[1].ok).toBe(true);
  });

  it("多收件人原样存回数组，逗号拼不出去重前的空条", () => {
    const { sql } = database();
    recordMailOut(sql, out({ to: ["a@x.test", "b@y.test", "c@z.test"] }));
    expect(listMailOut(sql)[0].to).toEqual(["a@x.test", "b@y.test", "c@z.test"]);
  });

  it("认不出的来源落回 tool，不变成一个空白格子", () => {
    const { sql } = database();
    recordMailOut(sql, out({ source: "who-knows" as never }));
    expect(listMailOut(sql)[0].source).toBe("tool");
  });

  it(`超出保留数 ${MAIL_OUT_KEEP} 行：剪掉最旧的，最新那行必须还在`, () => {
    const { db, sql } = database();
    ensureMailboxSchema(sql);
    for (let i = 0; i < MAIL_OUT_KEEP + 5; i++) {
      recordMailOut(
        sql,
        out({ at: `2026-01-0${1 + Math.floor(i / 100)}T00:00:${String(i % 60).padStart(2, "0")}.000Z`, subject: `第 ${i} 封` }),
      );
    }
    const n = db.prepare("SELECT COUNT(*) AS c FROM mail_out").get() as { c: number };
    expect(Number(n.c)).toBe(MAIL_OUT_KEEP);
    const rows = listMailOut(sql);
    expect(rows[0].subject).toBe(`第 ${MAIL_OUT_KEEP + 4} 封`);
    expect(rows.some((r) => r.subject === "第 0 封")).toBe(false);
  });

  it("剪枝按行数算，不按 id 区间：中间断号也不会一刀切多", () => {
    const { db, sql } = database();
    ensureMailboxSchema(sql);
    for (let i = 0; i < 3; i++) recordMailOut(sql, out({ subject: `s${i}` }));
    db.prepare("DELETE FROM mail_out WHERE subject = 's1'").run();
    for (let i = 0; i < MAIL_OUT_KEEP; i++) recordMailOut(sql, out({ subject: `t${i}` }));
    const rows = listMailOut(sql);
    expect(rows.length).toBe(MAIL_OUT_KEEP);
    // s0 与 s2 排在最早，被挤出去的是它们，而不是「id 落在某个区间里」的谁
    expect(rows.some((r) => r.subject === "s0" || r.subject === "s2")).toBe(false);
    expect(rows.some((r) => r.subject === "t0")).toBe(true);
  });
});

/**
 * 第 i 封的时刻：严格按 i 递增。
 *
 * 这里原先是拼字符串的「分:秒.毫秒」，i 过 60 就绕回头 —— 于是剪枝按 at 排出来的
 * 旧行根本不是最早写入的那几封，测试把一个夹具的错当成了被测行为的错。
 */
const when = (i: number): string =>
  new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + i * 60_000).toISOString();

describe("收件行", () => {
  it("存进去再读回来是同一封；未读计数跟着走", () => {
    const { sql } = database();
    const r = row();
    expect(insertMailIn(sql, r, "h1")).not.toBeNull();
    const back = listMailIn(sql);
    expect(back.length).toBe(1);
    expect(back[0]).toEqual(r);
    expect(mailInUnread(sql)).toBe(1);
    const flipped = setMailInRead(sql, r.id, true);
    expect(flipped?.read).toBe(true);
    expect(mailInUnread(sql)).toBe(0);
    expect(findMailIn(sql, r.id)?.read).toBe(true);
  });

  it("同一份报文重投只落一行（按内容 hash 去重）", () => {
    const { sql } = database();
    const a = row();
    expect(insertMailIn(sql, a, "same-hash")).toEqual(a);
    expect(insertMailIn(sql, row(), "same-hash")).toBeNull();
    expect(listMailIn(sql).length).toBe(1);
  });

  it("空 hash 不去重：没算出指纹的两封是两封", () => {
    const { sql } = database();
    expect(insertMailIn(sql, row(), "")).not.toBeNull();
    expect(insertMailIn(sql, row(), "")).not.toBeNull();
    expect(listMailIn(sql).length).toBe(2);
  });

  it(`超出保留数 ${MAIL_IN_KEEP} 行：被挤掉的旧行把 R2 键交出来（不是只删行）`, () => {
    const { db, sql } = database();
    const evicted: string[] = [];
    for (let i = 0; i < MAIL_IN_KEEP + 3; i++) {
      const r = row({
        at: when(i),
        emlKey: `mail/in/2026-02-01/${i}.eml`,
      });
      insertMailIn(sql, r, `h${i}`, (k) => evicted.push(k));
    }
    // 账上的总数（不是界面那一页）才是剪枝的对象
    const onBook = db.prepare("SELECT COUNT(*) AS c FROM mail_in").get() as { c: number };
    expect(Number(onBook.c)).toBe(MAIL_IN_KEEP);
    // 而 listMailIn 的默认 limit 是一页，不是整本：这两个数混了就等于面板在谎报
    expect(listMailIn(sql).length).toBeLessThan(MAIL_IN_KEEP);
    expect(listMailIn(sql, MAIL_IN_KEEP).length).toBe(MAIL_IN_KEEP);
    // 交出来的必须正是被删掉的那三封的原件，一个不多一个不少
    expect(evicted.sort()).toEqual(
      ["0", "1", "2"].map((i) => `mail/in/2026-02-01/${i}.eml`).sort(),
    );
  });

  it("没落原件的行被挤掉时不往 onEvict 里塞空键", () => {
    const { sql } = database();
    const evicted: string[] = [];
    for (let i = 0; i < MAIL_IN_KEEP + 1; i++) {
      insertMailIn(
        sql,
        row({
          at: when(i),
          emlKey: "",
        }),
        `x${i}`,
        (k) => evicted.push(k),
      );
    }
    expect(evicted).toEqual([]);
  });

  it("读不到的 id 回 null，不回一个空壳", () => {
    const { sql } = database();
    insertMailIn(sql, row(), "h9");
    expect(findMailIn(sql, "没有这个 id")).toBeNull();
    expect(setMailInRead(sql, "没有这个 id", true)).toBeNull();
  });

  it("过长的字段被截住而不是报错（外站能写多长就多长）", () => {
    const { sql } = database();
    const r = row({
      subject: "S".repeat(900),
      from: "F".repeat(400),
      preview: "P".repeat(900),
      emlKey: "K".repeat(400),
    });
    const saved = insertMailIn(sql, r, "long")!;
    const back = findMailIn(sql, saved.id)!;
    expect(back.subject.length).toBe(500);
    expect(back.from.length).toBe(254);
    expect(back.preview.length).toBe(300);
    expect(back.emlKey.length).toBe(200);
  });
});

describe("原件落在 R2 的那几条", () => {
  function fakeBucket() {
    const map = new Map<string, Uint8Array>();
    const store: EmlStore = {
      async put(k, d) {
        map.set(k, d);
      },
      async get(k) {
        const v = map.get(k);
        if (!v) return null;
        return {
          async arrayBuffer() {
            return v.slice().buffer as ArrayBuffer;
          },
        };
      },
      async delete(k) {
        map.delete(k);
      },
    };
    return { store, map };
  }

  it("按键写进桶，再按同一个键读回原字节", async () => {
    const { store, map } = fakeBucket();
    const raw = new TextEncoder().encode("一封真信");
    const key = await putEml(store, "2026-10-19T08:00:00.000Z", "abc", raw);
    expect(key).toBe("mail/in/2026-10-19/abc.eml");
    expect(map.size).toBe(1);
    const back = await getEml(store, key);
    expect(new TextDecoder().decode(back!)).toBe("一封真信");
  });

  it("太大不落地：返回空键，行照记（界面由此能说「只有摘要」）", async () => {
    const { store, map } = fakeBucket();
    const big = new Uint8Array(EML_MAX_BYTES + 1);
    expect(await putEml(store, "2026-10-19T08:00:00.000Z", "big", big)).toBe("");
    expect(map.size).toBe(0);
  });

  it("这台机器没配桶：putEml 不抛，getEml 回 null", async () => {
    expect(await putEml(null, "2026-10-19T08:00:00.000Z", "x", new Uint8Array(4))).toBe("");
    expect(await getEml(null, "mail/in/2026-10-19/x.eml")).toBeNull();
    // 键给了但对象没了（被删/换桶）同样是 null，不是抛
    const { store } = fakeBucket();
    expect(await getEml(store, "mail/in/2026-10-19/never.eml")).toBeNull();
    expect(await getEml(store, "")).toBeNull();
  });

  it("时刻认不出时键落到 unknown 目录，不落到一个畸形键上", () => {
    expect(emlKeyFor("不是个时刻", "id1")).toBe("mail/in/unknown/id1.eml");
    expect(emlKeyFor("2026-10-19T08:00:00.000Z", "id2")).toBe("mail/in/2026-10-19/id2.eml");
  });

  it("同一份字节算出的指纹稳定，且不同字节不同", async () => {
    const a = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("同一封")));
    const b = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("同一封")));
    const c = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("另一封")));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * 附件清单：只记名字与大小，内容一概不在这儿（原件在 R2）。
 *
 * 这一格必须对脏数据宽容 —— 它是外站寄来的东西，一个坏条目不该把整封信的清单作废，
 * 更不该让收件箱那一页读不出来。
 */
describe("附件清单那一格", () => {
  it("存进去再读回来是同一份清单（名字与字节都在）", () => {
    const { sql } = database();
    const r = row({
      hasAttachment: true,
      attachments: [
        { name: "月度 报告; v2.bin", bytes: 1234 },
        { name: "note.pdf", bytes: 99 },
      ],
    });
    const saved = insertMailIn(sql, r, "att1")!;
    expect(findMailIn(sql, saved.id)?.attachments).toEqual([
      { name: "月度 报告; v2.bin", bytes: 1234 },
      { name: "note.pdf", bytes: 99 },
    ]);
  });

  it(`超过 ${MAX_ATTACH_ITEMS} 个只留前若干，负数字节归零`, () => {
    const many = Array.from({ length: MAX_ATTACH_ITEMS + 6 }, (_, i) => ({
      name: `f${i}.bin`,
      bytes: i === 0 ? -5 : 10,
    }));
    const text = serializeAttachments(many);
    const back = parseAttachments(text);
    expect(back.length).toBe(MAX_ATTACH_ITEMS);
    expect(back[0]).toEqual({ name: "f0.bin", bytes: 0 });
    expect(back[back.length - 1].name).toBe(`f${MAX_ATTACH_ITEMS - 1}.bin`);
  });

  it("名字过长被截住，空名字的条目丢掉而不是占一格", () => {
    const back = parseAttachments(
      serializeAttachments([
        { name: "N".repeat(500), bytes: 1 },
        { name: "   ", bytes: 2 },
      ]),
    );
    expect(back.length).toBe(1);
    expect(back[0].name.length).toBe(200);
  });

  it("那一格被写坏时读成「没有清单」，不抛也不把整行带走", () => {
    const { db, sql } = database();
    const saved = insertMailIn(
      sql,
      row({ hasAttachment: true, attachments: [{ name: "a.pdf", bytes: 3 }] }),
      "att2",
    )!;
    for (const bad of ["不是 JSON", "{", "[]", '{"n":"x"}', "[null]", '[{"b":1}]']) {
      db.prepare("UPDATE mail_in SET attach = ?").run(bad);
      const r = findMailIn(sql, saved.id)!;
      expect(r.attachments).toEqual([]);
      // 清单坏了不影响这一封其它字段仍然读得到
      expect(r.subject).toBe(saved.subject);
    }
  });

  it("老库没有这一列时补上，且老行读出来是空清单而不是崩", () => {
    const { db, sql } = database();
    // 手工造一张今天早些时候那版的 mail_in（没有 attach 列）
    db.prepare(
      `CREATE TABLE mail_in (id TEXT PRIMARY KEY, hash TEXT, at TEXT, from_addr TEXT,
        from_name TEXT, to_addr TEXT, subject TEXT, bytes INTEGER, read_flag INTEGER,
        has_attach INTEGER, preview TEXT, eml_key TEXT)`,
    ).run();
    db.prepare(
      `INSERT INTO mail_in (id, hash, at, from_addr, from_name, to_addr, subject,
        bytes, read_flag, has_attach, preview, eml_key)
       VALUES ('old1','','2026-01-01T00:00:00.000Z','a@x.test','','t','旧的一封',1,0,0,'','')`,
    ).run();
    ensureMailboxSchema(sql);
    const r = findMailIn(sql, "old1");
    expect(r?.subject).toBe("旧的一封");
    expect(r?.attachments).toEqual([]);
    // 补完之后新行能正常带清单进去
    const saved = insertMailIn(
      sql,
      row({ hasAttachment: true, attachments: [{ name: "b.zip", bytes: 7 }] }),
      "att3",
    )!;
    expect(findMailIn(sql, saved.id)?.attachments).toEqual([
      { name: "b.zip", bytes: 7 },
    ]);
  });
});
