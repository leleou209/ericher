/**
 * 关掉弱网 fixture：只杀本工装自己写下的 pid（Windows 走 taskkill /t /f 杀进程树），
 * 只删自己创建的 .wrangler/weak-network-test-* 目录。
 * 幂等：.wrangler 不存在（新克隆就被 .gitignore 掉了）、目录里没有 fixture.json、
 * 进程已经先退出 —— 这几种情况都只报告，不当失败。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MARKER, TEST_DIR_PREFIX, projectRoot, stopAllFixtures } from './start-weak-network-fixture.mjs';

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const handled = await stopAllFixtures({ remove: true });
    if (!handled.length) {
      console.log(`没有由本脚本启动的 fixture（${path.join(projectRoot, '.wrangler')} 下无 ${TEST_DIR_PREFIX}* + ${MARKER}）`);
    } else {
      for (const item of handled)
        console.log(
          `已处理 ${item.entry}${item.orphan ? '（上次删除被文件句柄卡住的残留空壳，没有 pid 可依，只清目录不动进程）' : ''}：pid=${item.pid || '无'} 端口=${item.port || '无'} 进程=${item.skipped ?? (item.killed ? '树已杀' : '没动')} 目录=${item.removed ? '已删' : '待清理（下次 start 会接手）'}`,
        );
      console.log(`共处理 ${handled.length} 个弱网 fixture。`);
    }
  } catch (error) {
    console.error(`弱网 fixture 关闭失败：${error.message}`);
    process.exitCode = 1;
  }
}
