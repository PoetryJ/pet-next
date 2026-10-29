/**
 * 把一次运行的环境、命令、退出码和原始输出分成独立文件。
 * 环境里的凭据字段只保留键名。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY = /(secret|password|passwd|token|credential|authorization|cookie|api[-_]?key)/i;

export interface RunRecordInput {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly directory: string;
}

/** 凭据键的值换成占位符，其余原样保留。键按字母序写出。 */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    redacted[key] = SECRET_KEY.test(key) ? '[redacted]' : value;
  }
  return redacted;
}

/**
 * 写入 environment.json、command.json、exit-code.txt、stdout.log、stderr.log。
 * @returns 记录目录。
 */
export async function writeRunRecord(input: RunRecordInput): Promise<string> {
  await mkdir(input.directory, { recursive: true });
  const command = {
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    platform: input.platform,
  };
  const exitText = input.exitCode === null ? 'null\n' : `${input.exitCode}\n`;
  await writeFile(path.join(input.directory, 'environment.json'), `${JSON.stringify(redactEnv(input.env), null, 2)}\n`);
  await writeFile(path.join(input.directory, 'command.json'), `${JSON.stringify(command, null, 2)}\n`);
  await writeFile(path.join(input.directory, 'exit-code.txt'), exitText);
  await writeFile(path.join(input.directory, 'stdout.log'), input.stdout);
  await writeFile(path.join(input.directory, 'stderr.log'), input.stderr);
  return input.directory;
}
