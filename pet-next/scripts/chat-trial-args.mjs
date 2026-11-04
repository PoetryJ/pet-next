/**
 * M3-5 B：chat:trial 纯参数模块（无 IO、无 process 依赖，可测）。
 * 接口冻结见 docs/M3-5-INTERFACE.txt：缺省 off；on/off 之外一律 exit 2；
 * 重复 --context 报错（防 "on off" 误粘被静默取值，试用反馈失真）。
 * @module pet-next/scripts/chat-trial-args
 */

export const TRIAL_CONTEXT_ENV = 'PET_NEXT_CHAT_CONTEXT';

export const TRIAL_USAGE = '用法：pnpm chat:trial [--context=on|off]（缺省 off；连续对话用 on，单轮用 off）';

export const ON_LOG = '[chat-trial] 上下文=on（连续对话，4 轮/2000 字符上界）';
export const OFF_LOG = '[chat-trial] 上下文=off（单轮，与 M3-1 行为一致）';

/**
 * @param argv {string[]} 进程参数（不含 node 与脚本路径）
 * @returns 成功：{ ok:true, context:'on'|'off' }；失败：{ ok:false, error, exitCode:2 }
 */
export function parseTrialArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, error: '参数必须是数组', exitCode: 2 };
  }
  let context;
  let seen = false;
  for (const raw of argv) {
    if (typeof raw !== 'string') {
      return { ok: false, error: `非法参数：${String(raw)}`, exitCode: 2 };
    }
    if (!raw.startsWith('--')) {
      return { ok: false, error: `未知参数：${raw}（仅支持 --context=on|off）\n${TRIAL_USAGE}`, exitCode: 2 };
    }
    if (!raw.startsWith('--context=')) {
      return { ok: false, error: `未知选项：${raw}\n${TRIAL_USAGE}`, exitCode: 2 };
    }
    const value = raw.slice('--context='.length);
    if (value !== 'on' && value !== 'off') {
      return {
        ok: false,
        error: `--context 的值必须是 on 或 off，收到：${value === '' ? '(空)' : value}\n${TRIAL_USAGE}`,
        exitCode: 2,
      };
    }
    if (seen) {
      return { ok: false, error: `重复 --context（此前已给 ${context}，又给 ${value}）——只允许一次\n${TRIAL_USAGE}`, exitCode: 2 };
    }
    context = value;
    seen = true;
  }
  return { ok: true, context: seen ? context : 'off' };
}

/**
 * 构造子进程 env：on → 设 PET_NEXT_CHAT_CONTEXT='1'；off → 删除该键（父 shell
 * 继承值必须被清除，见 electron/main.ts 的非空即启用语义）。不修改传入对象。
 * @param env {Record<string,string|undefined>}
 * @param context {'on'|'off'}
 */
export function buildTrialEnv(env, context) {
  if (context !== 'on' && context !== 'off') {
    throw new TypeError(`buildTrialEnv: context 必须是 'on'|'off'，收到 ${String(context)}`);
  }
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === TRIAL_CONTEXT_ENV) continue; // 无论父值如何，按本次选择重建
    child[key] = value;
  }
  if (context === 'on') child[TRIAL_CONTEXT_ENV] = '1';
  return child;
}
