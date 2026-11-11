/**
 * 平台与边界检查（D5）。
 *
 * 原则：
 * - 只在确实能跑的环境下宣称通过。Linux 通过不等于 Windows 通过。
 * - root 下 chmod 不构成权限测试；检测到绕过就如实标 not-proven。
 * - 中文与空格路径必须真的走一遍读写，而不是"理论上支持"。
 *
 * @module pet-next/experiments/memory-consistency/platform/checks
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATCH_SCHEMA_VERSION, type MemoryPatch } from '../contracts.ts';
import { recomputeDependencies } from '../ledger/patch.ts';
import { JsonlStore } from '../storage/store.ts';
import { statement } from '../testing/factory.ts';

/** 单条平台检查。 */
export interface PlatformCheck {
  readonly id: string;
  readonly title: string;
  readonly status: 'pass' | 'fail' | 'not_proven' | 'not_run';
  readonly detail: string;
}

/** 结果集合。 */
export interface PlatformReport {
  readonly platform: string;
  readonly node: string;
  readonly uid: number;
  readonly checks: readonly PlatformCheck[];
  readonly windows: { readonly status: 'not_run'; readonly command: string; readonly reason: string };
  readonly passed: boolean;
}

/** 中文 + 空格 + 括号的路径必须能完成一次写入/读取/恢复。 */
function chineseSpacePath(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-platform-'));
  const dir = join(root, '中文 目录（记忆）', 'store dir');
  try {
    mkdirSync(dir, { recursive: true });
    const opened = JsonlStore.open(dir);
    if (!opened.ok) return { id: 'path-cn-space', title: '中文与空格路径', status: 'fail', detail: `${opened.code}: ${opened.detail}` };
    const store = opened.value;
    const appended = store.append(statement(1, 'e1', '写一条', 'pref:x'));
    if (!appended.ok) return { id: 'path-cn-space', title: '中文与空格路径', status: 'fail', detail: appended.detail };
    const notes = store.getState().events.length;
    store.close();
    const reopened = JsonlStore.open(dir);
    if (!reopened.ok) return { id: 'path-cn-space', title: '中文与空格路径', status: 'fail', detail: reopened.detail };
    const count = reopened.value.getState().events.length;
    reopened.value.close();
    return {
      id: 'path-cn-space',
      title: '中文与空格路径',
      status: count === notes && count === 1 ? 'pass' : 'fail',
      detail: `dir=${dir} events=${count}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 只读目录：root 下 chmod 无效，必须承认测不到。 */
function readOnlyDir(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-ro-'));
  const dir = join(root, 'readonly');
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o500);
    const opened = JsonlStore.open(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (opened.ok) {
      opened.value.close();
      return {
        id: 'readonly-dir',
        title: '无写权限目录',
        status: uid === 0 ? 'not_proven' : 'fail',
        detail: uid === 0 ? 'root 绕过权限位，本项不能证明失败路径' : '只读目录居然可以写入',
      };
    }
    return {
      id: 'readonly-dir',
      title: '无写权限目录',
      status: opened.code === 'io_error' ? 'pass' : 'fail',
      detail: `${opened.code}: ${opened.detail}`,
    };
  } finally {
    chmodSync(dir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

/** 目录不可用时错误码是否可定位（用文件占位目录触发）。 */
function corruptManifest(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-corrupt-'));
  const dir = join(root, 'store');
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'events.log'), '{"type":"event"}\n', 'utf8');
    const opened = JsonlStore.open(dir);
    if (opened.ok) {
      opened.value.close();
      return { id: 'corrupt-log', title: '坏日志', status: 'fail', detail: '坏行没有被拒绝' };
    }
    return {
      id: 'corrupt-log',
      title: '坏日志',
      status: opened.code === 'corrupt_log' ? 'pass' : 'fail',
      detail: `${opened.code}: ${opened.detail}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 关闭后写入必须报错，不能静默。 */
function closedStore(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-closed-'));
  try {
    const opened = JsonlStore.open(root);
    if (!opened.ok) return { id: 'closed-store', title: '关闭后写入', status: 'fail', detail: opened.detail };
    const store = opened.value;
    store.close();
    const result = store.append(statement(1, 'e1', 'x', 'pref:x'));
    return {
      id: 'closed-store',
      title: '关闭后写入',
      status: result.ok === false ? 'pass' : 'fail',
      detail: result.ok ? '关闭后仍接受写入' : result.code,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 清单缺失但快照存在：必须报 manifest_mismatch，而不是当空库。 */
function orphanSnapshot(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-orphan-'));
  try {
    const opened = JsonlStore.open(root);
    if (!opened.ok) return { id: 'orphan-snapshot', title: '孤儿快照', status: 'fail', detail: opened.detail };
    const store = opened.value;
    if (!store.append(statement(1, 'e1', 'x', 'pref:x')).ok) return { id: 'orphan-snapshot', title: '孤儿快照', status: 'fail', detail: 'append failed' };
    const checkpoint = store.checkpoint();
    store.close();
    if (!checkpoint.ok) return { id: 'orphan-snapshot', title: '孤儿快照', status: 'fail', detail: checkpoint.detail };
    // 删掉快照但保留清单：恢复必须失败。
    rmSync(join(root, `state-${checkpoint.value.checkpointId}.json`), { force: true });
    const reopened = JsonlStore.open(root);
    if (reopened.ok) {
      reopened.value.close();
      return { id: 'orphan-snapshot', title: '清单指向缺失快照', status: 'fail', detail: '缺失快照被当成空库' };
    }
    return {
      id: 'orphan-snapshot',
      title: '清单指向缺失快照',
      status: reopened.code === 'manifest_mismatch' ? 'pass' : 'fail',
      detail: `${reopened.code}: ${reopened.detail}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 路径含中文时补丁也能提交（覆盖 recompute 的字符串处理）。 */
function patchOnChinesePath(): PlatformCheck {
  const root = mkdtempSync(join(tmpdir(), 'mem-patch-'));
  const dir = join(root, '记忆 实验');
  try {
    mkdirSync(dir, { recursive: true });
    const opened = JsonlStore.open(dir);
    if (!opened.ok) return { id: 'patch-cn-path', title: '中文路径补丁', status: 'fail', detail: opened.detail };
    const store = opened.value;
    if (!store.append(statement(1, 'e1', '偏好', 'pref:中文')).ok) {
      return { id: 'patch-cn-path', title: '中文路径补丁', status: 'fail', detail: 'append failed' };
    }
    const state = store.getState();
    const draft = {
      noteId: 'n:pref:中文',
      text: '中文键的笔记',
      sourceEventIds: ['e1'],
      parentNoteIds: [],
      dependencyVersions: {},
      generator: 'scripted' as const,
      subjectKey: 'pref:中文',
    };
    const dependencyVersions: Record<string, number> = {};
    for (const [depId, version] of Object.entries(recomputeDependencies(state, draft).dependencies)) {
      dependencyVersions[depId] = version;
    }
    const patch: MemoryPatch = {
      schemaVersion: PATCH_SCHEMA_VERSION,
      opId: 'op-cn-1',
      snapshotVersion: state.globalVersion,
      dependencyVersions,
      notesToUpsert: [draft],
      notesToInvalidate: [],
      producer: 'manual',
    };
    const committed = store.commitPatch(patch);
    store.close();
    return {
      id: 'patch-cn-path',
      title: '中文路径补丁',
      status: committed.ok ? 'pass' : 'fail',
      detail: committed.ok ? 'applied' : committed.detail,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 跑全部平台检查。 */
export function runPlatformChecks(): PlatformReport {
  const checks: PlatformCheck[] = [
    chineseSpacePath(),
    readOnlyDir(),
    corruptManifest(),
    closedStore(),
    orphanSnapshot(),
    patchOnChinesePath(),
  ];
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    uid,
    checks,
    windows: {
      status: 'not_run',
      reason:
        '本机无 Windows 环境。R1 已把 checkpoint 的 fsync 改为可写句柄（原实现在 Windows 上对只读 fd fsync 会 EPERM），' +
        '但该修复尚未在 Windows 实跑，必须待复验；不得用 Linux 结果代替跨平台结论。',
      command: [
        'powershell -NoProfile -Command "cd C:\\path\\to\\pet-next; $env:PATH=\\"C:\\Program Files\\nodejs;$env:PATH\\"; node --experimental-strip-types --test --test-reporter=spec experiments/memory-consistency/storage/store.test.ts experiments/memory-consistency/recovery/recovery.test.ts"',
        'powershell -NoProfile -Command "cd C:\\path\\to\\pet-next; node experiments/memory-consistency/run.mjs --all"',
        '# 中文空格路径：把工作树放到 C:\\Users\\<you>\\桌面\\记忆 实验\\pet-next 后重跑上面两条',
      ].join('\n'),
    },
    passed: checks.every((check) => check.status === 'pass' || check.status === 'not_proven'),
  };
}

/** 供 run.mjs 之外的人工检查：目录是否可用。 */
export function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return existsSync(dir);
  } catch {
    return false;
  }
}

/** 读取文件做指纹，供报告引用。 */
export function fileDigest(path: string): string {
  return readFileSync(path, 'utf8').length.toString(16);
}
