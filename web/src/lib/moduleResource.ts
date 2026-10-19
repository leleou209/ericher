/** 并行预热和 React.lazy 共用导入，失败预热不制造未处理 rejection。 */
export function moduleResource<T>(loader: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  const load = (): Promise<T> => {
    if (!pending) pending = Promise.resolve().then(loader).catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  };
  return { load, preload: () => { void load().catch(() => {}); } };
}
