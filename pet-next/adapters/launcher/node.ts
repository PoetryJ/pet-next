/**
 * M3-7 B：launcher 的真实 IO 绑定（fs 原子写 + 既有隧道/探测/配置校验）。
 *
 * 复用不重造：
 * - 校验与隧道规格：adapters/connection/tunnel.ts 的 resolveTunnelConfig；
 * - 隧道：同文件的 startTunnel（ssh -N -L、有界就绪、幂等 stop）；
 * - 探测：electron/chat-config.ts 的 probeQwenService（GET /v1/models 协议，零 POST；
 *   与 chat-local-core 的 probeLocalService 同语义，选 TS 版因为 Electron 从 dist 加载，
 *   .mjs 不进 dist）；
 * - 配置路径：~/.pet-next/qwen-remote.json（PET_NEXT_REMOTE_CONFIG 可覆盖）。
 * 所有依赖可注入，便于单测不碰真盘/真网络。
 * @module pet-next/adapters/launcher/node
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { probeQwenService } from '../../electron/chat-config.ts';
import { resolveTunnelConfig, startTunnel as realStartTunnel } from '../connection/tunnel.ts';
import {
  createLauncherController,
  type LauncherControllerDeps,
  type LauncherProbeService,
  type LauncherStartTunnel,
} from '../../core/launcher/controller.ts';
import type { LauncherConfigIo } from '../../core/launcher/config.ts';
import {
  LAUNCHER_CONFIG_FILENAME,
  LAUNCHER_CONFIG_PATH_ENV,
  type LauncherConfig,
  type LauncherConfigValidator,
  type LauncherController,
  type LauncherError,
  type LauncherTunnelResolver,
} from '../../contracts/launcher.ts';
import type { TunnelConfig } from '../../contracts/connection.ts';

/** 配置文件绝对路径：PET_NEXT_REMOTE_CONFIG 优先，否则 ~/.pet-next/qwen-remote.json。 */
export function resolveConfigFilePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env[LAUNCHER_CONFIG_PATH_ENV];
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed !== '') return path.resolve(trimmed);
  return path.join(home, '.pet-next', LAUNCHER_CONFIG_FILENAME);
}

/** 真实文件 IO：同目录临时文件 + rename 的原子写；ensureParent 负责建目录。 */
export function createAtomicConfigIo(): LauncherConfigIo {
  return {
    readFile: (file) => readFile(file, 'utf8'),
    async writeFileAtomic(file, text) {
      const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
      try {
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, file);
      } catch (error) {
        // 临时文件不落盘残留：尽力清理后把原始错误交给上层归类 write-failed。
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async ensureParent(file) {
      await mkdir(path.dirname(file), { recursive: true });
    },
  };
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return undefined;
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 白名单 + 复用 resolveTunnelConfig 校验；失败给 config-invalid。
 * 缺省字段沿用隧道默认值（localPort 18873 / remoteHost 127.0.0.1 / remotePort 18872）。
 */
export function validateLauncherConfig(
  raw: unknown,
): { ok: true; config: LauncherConfig } | { ok: false; error: LauncherError } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: { code: 'config-invalid', message: '配置必须是 JSON 对象' } };
  }
  const record = raw as Record<string, unknown>;
  const identityFile = readText(record, 'identityFile');
  const resolved = resolveTunnelConfig(
    {},
    {
      host: readText(record, 'host') ?? '',
      port: readNumber(record, 'port') ?? Number.NaN,
      user: readText(record, 'user') ?? '',
      ...(identityFile !== undefined && identityFile.trim() !== ''
        ? { identityFile: identityFile.trim() }
        : {}),
      ...(readNumber(record, 'localPort') !== undefined
        ? { localPort: readNumber(record, 'localPort') }
        : {}),
      ...(readText(record, 'remoteHost') ? { remoteHost: readText(record, 'remoteHost') } : {}),
      ...(readNumber(record, 'remotePort') !== undefined
        ? { remotePort: readNumber(record, 'remotePort') }
        : {}),
    },
  );
  if (!resolved.ok) {
    return { ok: false, error: { code: 'config-invalid', message: resolved.error.message } };
  }
  const config = resolved.config;
  return {
    ok: true,
    config: {
      host: config.host,
      port: config.port,
      user: config.user,
      ...(config.identityFile ? { identityFile: config.identityFile } : {}),
      localPort: config.localPort,
      remoteHost: config.remoteHost,
      remotePort: config.remotePort,
    },
  };
}

/** 连接配置 → 隧道规格（复用 resolveTunnelConfig，结构兼容 TunnelConfig）。 */
export function resolveLauncherTunnelStrict(
  config: LauncherConfig,
): { ok: true; spec: TunnelConfig } | { ok: false; error: LauncherError } {
  const resolved = resolveTunnelConfig({}, config as Partial<TunnelConfig>);
  if (!resolved.ok) return { ok: false, error: { code: resolved.error.code, message: resolved.error.message } };
  return { ok: true, spec: resolved.config };
}

/**
 * 用哪个 node 执行 .mjs/.js 替身：
 * Electron 主进程的 process.execPath 是 electron 二进制（直接跑 .mjs 会变成再开一个 Electron），
 * 因此 Electron 内改用 PATH 的 node（可用 PET_NEXT_NODE_BIN 显式指定）；纯 node 进程用自身。
 */
function nodeForScripts(env: Record<string, string | undefined>): string {
  const explicit = env.PET_NEXT_NODE_BIN;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const inElectron = typeof process.versions.electron === 'string' && process.versions.electron !== '';
  return inElectron ? 'node' : process.execPath;
}

/**
 * PET_NEXT_SSH_BIN 允许指向 .mjs/.js 替身（验收用）：Windows 不能直接执行脚本文件，
 * 因此统一交给 node 执行；真实 OpenSSH 仍是可执行文件，行为不变（与 scripts/chat-remote.mjs 同规则）。
 */
function resolveSshLauncher(env: Record<string, string | undefined>): {
  sshBin?: string;
  argsPrefix?: string[];
} {
  const raw = env.PET_NEXT_SSH_BIN;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  const value = raw.trim();
  if (/\.(mjs|cjs|js)$/i.test(value)) {
    return { sshBin: nodeForScripts(env), argsPrefix: [value] };
  }
  return { sshBin: value };
}

export interface NodeLauncherOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  fetchImpl?: typeof fetch;
  startTunnel?: LauncherStartTunnel;
  probeService?: LauncherProbeService;
  defaultModel?: string;
  configIo?: LauncherConfigIo;
  configFile?: string;
}

/** 组装真实控制器：路径解析、原子写、真实隧道与零 POST 探测。 */
export function createNodeLauncherController(options: NodeLauncherOptions = {}): LauncherController {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const startTunnel: LauncherStartTunnel =
    options.startTunnel ??
    ((spec, tunnelDeps) => {
      const ssh = resolveSshLauncher(env);
      return realStartTunnel(
        { ...spec },
        {
          signal: tunnelDeps.signal,
          fetchImpl: tunnelDeps.fetchImpl,
          ...(ssh.sshBin ? { sshBin: ssh.sshBin } : {}),
          ...(ssh.argsPrefix ? { argsPrefix: ssh.argsPrefix } : {}),
        },
      );
    });

  const probeService: LauncherProbeService =
    options.probeService ??
    (async (config, fetchImpl) => {
      const result = await probeQwenService(config, fetchImpl);
      return result.ok
        ? { ok: true, models: result.models }
        : { ok: false, error: result.error, ...(result.models ? { models: result.models } : {}) };
    });

  const validate: LauncherConfigValidator = (raw) => validateLauncherConfig(raw);
  const resolveTunnel: LauncherTunnelResolver = (config) => resolveLauncherTunnelStrict(config);

  const deps: LauncherControllerDeps = {
    configFile: options.configFile ?? resolveConfigFilePath(env, home),
    configIo: options.configIo ?? createAtomicConfigIo(),
    validate,
    resolveTunnel,
    startTunnel,
    probeService,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
  };
  return createLauncherController(deps);
}
