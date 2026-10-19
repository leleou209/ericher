import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createGuestType, listGuestTypes, updateGuestType, getGuestType } from '../src/agent/guestTypes';
import type { SqlTag } from '../src/agent/state';
const secrets = { adminPw: 'test-admin', gatePw: 'test-guest' };
function database() {
 const db = new DatabaseSync(':memory:');
 const sql = ((strings: TemplateStringsArray, ...values: any[]) => {
   const statement = db.prepare(strings.join('?'));
   return statement.all(...values);
 }) as SqlTag;
 return { db, sql };
}
it('真实SQLite逐项修改长期权限仍保持启用及其他权限', async () => {
 const { db, sql } = database();
 try {
   const type = await createGuestType(sql, { name: 'test', password: 'test-card', ...secrets });
   await updateGuestType(sql, type.id, { permNotes: true, ...secrets });
   await updateGuestType(sql, type.id, { permFiles: true, ...secrets });
   await updateGuestType(sql, type.id, { permPublic: true, ...secrets });
   expect(getGuestType(sql, type.id)).toMatchObject({ active: true, permNotes: true, permFiles: true, permPublic: true });
   await updateGuestType(sql, type.id, { active: false, ...secrets });
   await updateGuestType(sql, type.id, { permFiles: false, ...secrets });
   expect(listGuestTypes(sql).find(t => t.id === type.id)).toMatchObject({ active: false, permNotes: true, permFiles: false });
   await updateGuestType(sql, type.id, { active: true, ...secrets });
   expect(getGuestType(sql, type.id)?.active).toBe(true);
 } finally { db.close(); }
});
it('默认档异常停用后合法更新可恢复且不放开关闭权限', async () => {
 const { db, sql } = database();
 try {
   listGuestTypes(sql);
   db.exec("UPDATE guest_types SET active=0, perm_notes=0 WHERE id='common'");
   await updateGuestType(sql, 'common', { permFiles: false, ...secrets });
   expect(getGuestType(sql, 'common')).toMatchObject({ active: true, permNotes: false, permFiles: false });
   await expect(updateGuestType(sql, 'common', { active: false, ...secrets })).rejects.toThrow('不能停用');
 } finally { db.close(); }
});

/**
 * 矩阵权（permMatrix）在真 SQLite 上的两处底线：
 * - 新建的表缺省 0，内置通用档种入也是 0 —— 升级不会白送谁整面网页；
 * - 老库没有这一列时补列，存量行读回来是关；值真是 NULL 也算关。
 */
it('真SQLite新建表与内置档：perm_matrix 缺省就是关', async () => {
 const { db, sql } = database();
 try {
   const type = await createGuestType(sql, { name: 'new', password: 'new-card', ...secrets });
   expect(type.permMatrix).toBe(false);
   expect(getGuestType(sql, type.id)?.permMatrix).toBe(false);
   expect(listGuestTypes(sql).find(t => t.id === 'common')?.permMatrix).toBe(false);
   // 开→关→读回都落在真库里，不是只活在返回值里
   await updateGuestType(sql, type.id, { permMatrix: true, ...secrets });
   expect(getGuestType(sql, type.id)?.permMatrix).toBe(true);
   await updateGuestType(sql, type.id, { permNotes: true, ...secrets });
   expect(getGuestType(sql, type.id)?.permMatrix).toBe(true);
   await updateGuestType(sql, type.id, { permMatrix: false, ...secrets });
   expect(getGuestType(sql, type.id)?.permMatrix).toBe(false);
 } finally { db.close(); }
});

it('老库没有 perm_matrix 列：建表补齐后存量档按没有矩阵权算', async () => {
 const db = new DatabaseSync(':memory:');
 try {
   // 三项专属权益都有、第四项还没有的那一代表结构
   db.exec(`CREATE TABLE guest_types (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, password TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '',
     perm_search INTEGER NOT NULL DEFAULT 1, perm_draw INTEGER NOT NULL DEFAULT 1,
     perm_memory INTEGER NOT NULL DEFAULT 1, perm_notes INTEGER NOT NULL DEFAULT 0,
     perm_files INTEGER NOT NULL DEFAULT 0, perm_public INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)`);
   db.exec(`INSERT INTO guest_types (id, name, password, created)
     VALUES ('old', '老档', 'pw', '2026-01-01T00:00:00.000Z')`);
   const sql = ((strings: TemplateStringsArray, ...values: any[]) =>
     db.prepare(strings.join('?')).all(...values)) as SqlTag;
   const rows = listGuestTypes(sql);
   expect(rows.find(t => t.id === 'old')?.permMatrix).toBe(false);
   expect(db.prepare("SELECT perm_matrix AS v FROM guest_types WHERE id='old'").get()).toEqual({ v: 0 });
   // 补上之后管理员才有权逐档打开
   await updateGuestType(sql, 'old', { permMatrix: true, ...secrets });
   expect(getGuestType(sql, 'old')?.permMatrix).toBe(true);
 } finally { db.close(); }
});

it('perm_matrix 值为 NULL（没给默认值的旧列）：读回来算关', async () => {
 const db = new DatabaseSync(':memory:');
 try {
   db.exec(`CREATE TABLE guest_types (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, password TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]',
     perm_search INTEGER NOT NULL DEFAULT 1, perm_draw INTEGER NOT NULL DEFAULT 1,
     perm_memory INTEGER NOT NULL DEFAULT 1, perm_notes INTEGER NOT NULL DEFAULT 0,
     perm_files INTEGER NOT NULL DEFAULT 0, perm_public INTEGER NOT NULL DEFAULT 0,
     perm_matrix INTEGER, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)`);
   db.exec(`INSERT INTO guest_types (id, name, password, created)
     VALUES ('n', '缺值档', 'pw', '2026-01-01T00:00:00.000Z')`);
   const sql = ((strings: TemplateStringsArray, ...values: any[]) =>
     db.prepare(strings.join('?')).all(...values)) as SqlTag;
   expect(getGuestType(sql, 'n')?.permMatrix).toBe(false);
   // 缺值不算「开」，也不算「谁都没提过」：改别的字段时它留在关
   await updateGuestType(sql, 'n', { name: '改了名', ...secrets });
   expect(getGuestType(sql, 'n')?.permMatrix).toBe(false);
 } finally { db.close(); }
});
