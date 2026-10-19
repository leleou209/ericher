/** 抽屉第一次打开后保持挂载：自动保存与未提交的编辑不该因为收起就丢。 */
export interface DrawerVisits {
  note: boolean;
  memo: boolean;
  plan: boolean;
}

export const drawerMounted = (open: boolean, visited: boolean): boolean => open || visited;

export function rememberDrawer(
  previous: DrawerVisits,
  open: { note: boolean; memo: boolean; plan: boolean },
): DrawerVisits {
  const next = {
    note: previous.note || open.note,
    memo: previous.memo || open.memo,
    plan: previous.plan || open.plan,
  };
  return next.note === previous.note && next.memo === previous.memo && next.plan === previous.plan
    ? previous
    : next;
}
