/**
 * M3-5 B：Windows 试用正式入口 pnpm chat:trial（薄壳）。
 * 只做两件事：解析 --context=on|off（与 M3-6 的 --experience=companion）并打印明确
 * 状态行；按选择调整 env 后 **复用 chat-remote.mjs 全链**（配置/SSH 隧道/健康探测/
 * 退出链不重实现）。不自动发送消息、不暗中 fallback fake、不硬编码地址凭据。
 * 注意：必须在动态 import chat-remote 之前完成 env 调整——chat-remote 顶层即
 * 执行 runRemote 并 process.exit；Electron 子进程的 env 由该链 spread 透传。
 * @module pet-next/scripts/chat-trial
 */
import {
  buildTrialEnv,
  COMPANION_EXPERIENCE,
  OFF_LOG,
  ON_LOG,
  parseTrialArgs,
  TRIAL_EXPERIENCE_LOG,
} from './chat-trial-args.mjs';

const parsed = parseTrialArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`[chat-trial] 参数错误：${parsed.error}`);
  process.exit(parsed.exitCode);
}

console.log(parsed.context === 'on' ? ON_LOG : OFF_LOG);
if (parsed.experience === COMPANION_EXPERIENCE) console.log(TRIAL_EXPERIENCE_LOG);

const trialEnv = buildTrialEnv(process.env, parsed.context, parsed.experience);
for (const key of Object.keys(process.env)) {
  if (!(key in trialEnv)) delete process.env[key];
}
for (const [key, value] of Object.entries(trialEnv)) {
  process.env[key] = value;
}

await import('./chat-remote.mjs');
