/**
 * M3-5 B：chat:trial 纯参数模块（无 IO、无 process 依赖，可测）。
 * 接口冻结见 docs/M3-5-INTERFACE.txt：缺省 off；on/off 之外一律 exit 2；
 * 重复 --context 报错（防 "on off" 误粘被静默取值，试用反馈失真）。
 * @module pet-next/scripts/chat-trial-args
 */

export const TRIAL_CONTEXT_ENV = 'PET_NEXT_CHAT_CONTEXT';

export const TRIAL_USAGE = '用法：pnpm chat:trial [--context=on|off] [--experience=companion]（缺省 off；连续对话用 on；companion 打开等待提示+回应预览）';

export const ON_LOG = '[chat-trial] 上下文=on（连续对话，4 轮/2000 字符上界）';
export const OFF_LOG = '[chat-trial] 上下文=off（单轮，与 M3-1 行为一致）';

/** M3-6：体验预览令牌（唯一值 companion）。 */
export const COMPANION_EXPERIENCE = 'companion';
export const TRIAL_EXPERIENCE_ENV = 'PET_NEXT_EXPERIENCE';
export const TRIAL_EXPERIENCE_LOG = '[chat-trial] 体验=companion（等待提示+回应预览，short+behavior 同启）';
/** companion 需要 short 与 behavior 同时打开；只在父 env 未显式给 preview 时注入。 */
export const TRIAL_PREVIEW_ENV = 'PET_NEXT_PREVIEW';
export const COMPANION_PREVIEW = 'short+behavior';

/**
 * @param argv {string[]} 进程参数（不含 node 与脚本路径）
 * @returns 成功：{ ok:true, context:'on'|'off' }；失败：{ ok:false, error, exitCode:2 }
 */
export function parseTrialArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, error: '参数必须是数组', exitCode: 2 };
  }
  let context;
  let experience = 'none';
  let seenContext = false;
  let seenExperience = false;
  for (const raw of argv) {
    if (typeof raw !== 'string') {
      return { ok: false, error: `非法参数：${String(raw)}`, exitCode: 2 };
    }
    if (!raw.startsWith('--')) {
      return { ok: false, error: `未知参数：${raw}（仅支持 --context=on|off 与 --experience=companion）\n${TRIAL_USAGE}`, exitCode: 2 };
    }
    if (raw.startsWith('--context=')) {
      const value = raw.slice('--context='.length);
      if (value !== 'on' && value !== 'off') {
        return {
          ok: false,
          error: `--context 的值必须是 on 或 off，收到：${value === '' ? '(空)' : value}\n${TRIAL_USAGE}`,
          exitCode: 2,
        };
      }
      if (seenContext) {
        return { ok: false, error: `重复 --context（此前已给 ${context}，又给 ${value}）——只允许一次\n${TRIAL_USAGE}`, exitCode: 2 };
      }
      context = value;
      seenContext = true;
      continue;
    }
    if (raw.startsWith('--experience=')) {
      const value = raw.slice('--experience='.length);
      if (value !== COMPANION_EXPERIENCE) {
        return {
          ok: false,
          error: `--experience 的值必须是 companion，收到：${value === '' ? '(空)' : value}\n${TRIAL_USAGE}`,
          exitCode: 2,
        };
      }
      if (seenExperience) {
        return { ok: false, error: `重复 --experience——只允许一次\n${TRIAL_USAGE}`, exitCode: 2 };
      }
      experience = COMPANION_EXPERIENCE;
      seenExperience = true;
      continue;
    }
    return { ok: false, error: `未知选项：${raw}\n${TRIAL_USAGE}`, exitCode: 2 };
  }
  return { ok: true, context: seenContext ? context : 'off', experience: seenExperience ? experience : 'none' };
}

/**
 * 构造子进程 env：on → 设 PET_NEXT_CHAT_CONTEXT='1'；off → 删除该键（父 shell
 * 继承值必须被清除，见 electron/main.ts 的非空即启用语义）。不修改传入对象。
 * @param env {Record<string,string|undefined>}
 * @param context {'on'|'off'}
 */
export function buildTrialEnv(env, context, experience = 'none') {
  if (context !== 'on' && context !== 'off') {
    throw new TypeError(`buildTrialEnv: context 必须是 'on'|'off'，收到 ${String(context)}`);
  }
  if (experience !== 'none' && experience !== COMPANION_EXPERIENCE) {
    throw new TypeError(`buildTrialEnv: experience 必须是 'none'|'companion'，收到 ${String(experience)}`);
  }
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // 两项都由本次参数重建：父 shell 的残留值必须被清除（与 M3-5 context 语义一致）。
    if (key === TRIAL_CONTEXT_ENV) continue;
    if (key === TRIAL_EXPERIENCE_ENV) continue;
    child[key] = value;
  }
  if (context === 'on') child[TRIAL_CONTEXT_ENV] = '1';
  if (experience === COMPANION_EXPERIENCE) {
    child[TRIAL_EXPERIENCE_ENV] = COMPANION_EXPERIENCE;
    // 组合 short + behavior；父 env 已显式给 preview 时尊重它（不覆盖用户选择）。
    if (child[TRIAL_PREVIEW_ENV] === undefined || child[TRIAL_PREVIEW_ENV] === '') {
      child[TRIAL_PREVIEW_ENV] = COMPANION_PREVIEW;
    }
  }
  return child;
}
