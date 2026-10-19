import { RequestEpoch } from "./requestEpoch";

/** 配置保存与包操作抢同一把锁：两者都写 busy/msg，并发会互相盖掉对方的状态。 */
export class MatrixOperationLock {
  private held = false;
  acquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    // 释放函数只认第一次调用：第二次再放会把别人刚拿到的锁一起放掉
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.held = false;
      }
    };
  }
}

/** 只允许最新一次刷新写回；保存期间的所有票据一律作废，免得慢 GET 盖掉刚存好的配置。 */
export class MatrixReloadGuard {
  private saving = 0;
  private epoch = new RequestEpoch();
  next(): number {
    return this.epoch.next();
  }
  current(ticket: number): boolean {
    return !this.saving && this.epoch.current(ticket);
  }
  beginSave(): void {
    this.saving++;
    this.epoch.invalidate();
  }
  endSave(): void {
    this.saving = Math.max(0, this.saving - 1);
    this.epoch.invalidate();
  }
  invalidate(): void {
    this.epoch.invalidate();
  }
}

export interface SaveEffects<T> {
  busy(value: boolean): void;
  message(value: string): void;
  apply(value: T): void;
}

/** 串行保存：重复提交当场忽略；失败只报信不动数据，界面只收服务端确认过的值。 */
export class ConfigurationSave {
  private epoch = new RequestEpoch();
  private pending = false;
  invalidate(): void {
    this.epoch.invalidate();
    this.pending = false;
  }
  async run<T>(
    request: () => Promise<T>,
    effects: SaveEffects<T>,
    success: string,
  ): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    const ticket = this.epoch.next();
    effects.busy(true);
    effects.message("");
    try {
      const result = await request();
      if (!this.epoch.current(ticket)) return;
      effects.apply(result);
      effects.message(success);
    } catch (error) {
      if (this.epoch.current(ticket)) {
        effects.message(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.epoch.current(ticket)) {
        this.pending = false;
        effects.busy(false);
      }
    }
  }
}

export interface PackStatus {
  setBusy(value: boolean): void;
  setMsg(value: string): void;
}

/** 一次只跑一个打包操作；current 交给操作自查 —— 请求到手时界面可能已经不该再被写了。 */
export class PackOperation {
  private epoch = new RequestEpoch();
  private pending = false;
  invalidate(): void {
    this.epoch.invalidate();
    this.pending = false;
  }
  async run(
    status: PackStatus,
    operation: (current: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    const ticket = this.epoch.next();
    const current = () => this.epoch.current(ticket);
    status.setBusy(true);
    status.setMsg("");
    try {
      await operation(current);
    } catch (error) {
      if (current()) {
        status.setMsg(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (current()) {
        this.pending = false;
        status.setBusy(false);
      }
    }
  }
}

export interface PackDownloadIo {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  open(url: string, filename: string): void;
}

/** 临时 URL 必须在 finally 回收：点不下去的时候也不能让整包 zip 一直占着内存。 */
export function downloadPack(
  blob: Blob,
  filename: string,
  io: PackDownloadIo,
): void {
  const url = io.createObjectURL(blob);
  try {
    io.open(url, filename);
  } finally {
    io.revokeObjectURL(url);
  }
}
