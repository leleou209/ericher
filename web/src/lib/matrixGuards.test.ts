import { describe, expect, it, vi } from "vitest";
import {
  ConfigurationSave,
  MatrixOperationLock,
  MatrixReloadGuard,
  PackOperation,
  downloadPack,
  type PackDownloadIo,
} from "./matrixGuards";

describe("矩阵刷新票据", () => {
  it("较新一次的刷新使旧响应作废", () => {
    const guard = new MatrixReloadGuard();
    const old = guard.next();
    const latest = guard.next();
    expect(guard.current(old)).toBe(false);
    expect(guard.current(latest)).toBe(true);
  });
  it("保存前与保存期间的刷新都盖不掉保存结果", () => {
    const guard = new MatrixReloadGuard();
    const before = guard.next();
    guard.beginSave();
    const during = guard.next();
    expect(guard.current(during)).toBe(false);
    guard.endSave();
    expect(guard.current(before)).toBe(false);
    expect(guard.current(during)).toBe(false);
    expect(guard.current(guard.next())).toBe(true);
  });
  it("嵌套保存没配对完时仍按保存中处理", () => {
    const guard = new MatrixReloadGuard();
    guard.beginSave();
    guard.beginSave();
    guard.endSave();
    expect(guard.current(guard.next())).toBe(false);
    guard.endSave();
    expect(guard.current(guard.next())).toBe(true);
  });
  it("卸载后在途刷新不再写回", () => {
    const guard = new MatrixReloadGuard();
    const ticket = guard.next();
    guard.invalidate();
    expect(guard.current(ticket)).toBe(false);
  });
});

describe("矩阵配置保存", () => {
  const effects = () => ({ busy: vi.fn(), message: vi.fn(), apply: vi.fn() });

  it("成功后应用服务端值并报出成功", async () => {
    const e = effects();
    await new ConfigurationSave().run(async () => "normalized", e, "外观已保存");
    expect(e.apply).toHaveBeenCalledWith("normalized");
    expect(e.message).toHaveBeenLastCalledWith("外观已保存");
    expect(e.busy).toHaveBeenLastCalledWith(false);
  });
  it("失败保留原值，只把错误说出来", async () => {
    const e = effects();
    await new ConfigurationSave().run(
      async () => {
        throw new Error("存不上");
      },
      e,
      "外观已保存",
    );
    expect(e.apply).not.toHaveBeenCalled();
    expect(e.message).toHaveBeenLastCalledWith("存不上");
    expect(e.busy).toHaveBeenLastCalledWith(false);
  });
  it("失败后仍能再次保存", async () => {
    const saver = new ConfigurationSave();
    const e = effects();
    await saver.run(
      async () => {
        throw new Error("存不上");
      },
      e,
      "已保存",
    );
    await saver.run(async () => "value", e, "已保存");
    expect(e.apply).toHaveBeenCalledWith("value");
  });
  it("在途期间的重复提交不发第二个请求", async () => {
    const saver = new ConfigurationSave();
    const e = effects();
    let release!: (value: string) => void;
    const request = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = saver.run(request, e, "已保存");
    await saver.run(request, e, "已保存");
    release("done");
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    expect(e.apply).toHaveBeenCalledWith("done");
  });
  it("失效后的晚返回不写回界面也不释放忙状态", async () => {
    const saver = new ConfigurationSave();
    const e = effects();
    let release!: (value: string) => void;
    const first = saver.run(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      e,
      "已保存",
    );
    saver.invalidate();
    release("late");
    await first;
    expect(e.apply).not.toHaveBeenCalled();
    expect(e.busy.mock.calls).toEqual([[true]]);
    expect(e.message.mock.calls).toEqual([[""]]);
  });
});

describe("矩阵包操作", () => {
  const status = () => ({ setBusy: vi.fn(), setMsg: vi.fn() });

  it("完成后按顺序占用并释放忙状态", async () => {
    const e = status();
    await new PackOperation().run(e, async (current) => {
      expect(current()).toBe(true);
    });
    expect(e.setBusy.mock.calls).toEqual([[true], [false]]);
  });
  it("失败报出错误，后续操作仍能运行", async () => {
    const runner = new PackOperation();
    const e = status();
    await runner.run(e, async () => {
      throw new Error("装不上");
    });
    expect(e.setMsg).toHaveBeenLastCalledWith("装不上");
    const next = vi.fn(async () => {});
    await runner.run(e, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("重复触发不会发第二个请求", async () => {
    const runner = new PackOperation();
    const e = status();
    let release!: () => void;
    const first = runner.run(
      e,
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const duplicate = vi.fn(async () => {});
    await runner.run(e, duplicate);
    release();
    await first;
    expect(duplicate).not.toHaveBeenCalled();
  });
  it("晚到的包不再下载", async () => {
    const runner = new PackOperation();
    const e = status();
    const download = vi.fn();
    let release!: () => void;
    const first = runner.run(e, async (current) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (current()) download();
    });
    runner.invalidate();
    release();
    await first;
    expect(download).not.toHaveBeenCalled();
    expect(e.setBusy.mock.calls).toEqual([[true]]);
  });
  it("失效后的晚返回错误不写回状态", async () => {
    const runner = new PackOperation();
    const e = status();
    let release!: () => void;
    const first = runner.run(
      e,
      async () =>
        await new Promise<void>((_resolve, reject) => {
          release = () => reject(new Error("晚到的失败"));
        }),
    );
    runner.invalidate();
    release();
    await first;
    expect(e.setMsg.mock.calls).toEqual([[""]]);
    expect(e.setBusy.mock.calls).toEqual([[true]]);
  });
});

describe("导出下载的临时 URL", () => {
  it("打开即用同一个 URL，随后回收", () => {
    const calls: string[] = [];
    const io: PackDownloadIo = {
      createObjectURL: () => {
        calls.push("create");
        return "blob:x";
      },
      open: (url, filename) => {
        calls.push(`open:${url}:${filename}`);
      },
      revokeObjectURL: (url) => {
        calls.push(`revoke:${url}`);
      },
    };
    downloadPack(new Blob(["zip"]), "matrix-1.zip", io);
    expect(calls).toEqual(["create", "open:blob:x:matrix-1.zip", "revoke:blob:x"]);
  });
  it("点不下去也要回收 URL，并把错误报给调用方", () => {
    const revoked: string[] = [];
    expect(() =>
      downloadPack(new Blob(["zip"]), "matrix-1.zip", {
        createObjectURL: () => "blob:x",
        open: () => {
          throw new Error("浏览器拦了下载");
        },
        revokeObjectURL: (url) => {
          revoked.push(url);
        },
      }),
    ).toThrow("浏览器拦了下载");
    expect(revoked).toEqual(["blob:x"]);
  });
});

describe("矩阵写操作共用的锁", () => {
  it("保存配置期间打包抢不到锁", () => {
    const lock = new MatrixOperationLock();
    const release = lock.acquire();
    expect(release).not.toBeNull();
    expect(lock.acquire()).toBeNull();
    release?.();
    expect(lock.acquire()).not.toBeNull();
  });
  it("重复调用旧的释放函数不会放掉别人拿到的锁", () => {
    const lock = new MatrixOperationLock();
    const first = lock.acquire();
    first?.();
    const second = lock.acquire();
    first?.();
    expect(lock.acquire()).toBeNull();
    second?.();
    expect(lock.acquire()).not.toBeNull();
  });
  it("两条路共用一把锁时，装备期间的保存不会发出请求", async () => {
    const lock = new MatrixOperationLock();
    const pack = new PackOperation();
    const saver = new ConfigurationSave();
    const saveRequest = vi.fn(async () => ({ sites: [] }));
    let release!: () => void;
    const running = async () => {
      const releaseLock = lock.acquire();
      if (!releaseLock) return;
      try {
        await pack.run(
          { setBusy: () => {}, setMsg: () => {} },
          async () =>
            await new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
      } finally {
        releaseLock();
      }
    };
    const inFlight = running();
    const save = async () => {
      const releaseLock = lock.acquire();
      if (!releaseLock) return;
      try {
        await saver.run(
          saveRequest,
          { busy: () => {}, message: () => {}, apply: () => {} },
          "外站认定已保存",
        );
      } finally {
        releaseLock();
      }
    };
    await save();
    expect(saveRequest).not.toHaveBeenCalled();
    release();
    await inFlight;
  });
});
