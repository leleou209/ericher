// 版本号比较：检查更新用它判新旧。
//
// 为什么单独成一个文件：判定「该不该更新」只认 package.json 的 version，
// 不认提交 —— 私有部署攒批推送是常态，两边的提交几乎永远对不上，
// hash 不同不代表这边旧。semver 的比较规则很小，但它是「提示用户升级」
// 的开关，值得有一份自己的测试。

/** 逐位比较两个 x.y.z 版本号：a 大返回正数，b 大返回负数，相等返回 0。缺位按 0 补。 */
export function compareSemver(a: string, b: string): number {
  const pa = (a || "")
    .trim()
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = (b || "")
    .trim()
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  // 比到两边最长的位数，缺位补 0。不能只比前 3 段：像 0.1.6.5 这种补丁位会
  // 被当成 0.1.6，停在旧版的用户永远等不到升级提示。
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
