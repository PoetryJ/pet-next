/**
 * 用参数数组调用 ffprobe / ffmpeg，不经过 shell。
 */
import { execFile } from 'node:child_process';

/** 640×360×48 帧 RGBA 约 44MB，上限留一倍。 */
export const MAX_STDOUT_BYTES = 80 * 1024 * 1024;

export type ToolFailure = 'missing' | 'timeout' | 'failed';

/** 工具没跑成。`missing` 和超时、非零退出分开，方便写 limitation。 */
export class MediaToolError extends Error {
  readonly tool: string;
  readonly reason: ToolFailure;

  constructor(tool: string, reason: ToolFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaToolError';
    this.tool = tool;
    this.reason = reason;
  }
}

export interface ToolResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * 执行一条已经拆开的命令。
 *
 * @param command - 第一个元素是可执行文件。
 * @param timeoutMs - 超时后杀掉子进程。
 */
export function runMediaTool(command: readonly string[], timeoutMs: number): Promise<ToolResult> {
  const bin = command[0];
  if (!bin) return Promise.reject(new MediaToolError('tool', 'missing', '命令为空'));
  return new Promise((resolve, reject) => {
    execFile(bin, command.slice(1), { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, encoding: 'buffer' }, (error, stdout, stderr) => {
      const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
      const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
      if (!error) {
        resolve({ stdout: outBuf, stderr: errText });
        return;
      }
      reject(toolError(bin, error, errText));
    });
  });
}

function toolError(bin: string, error: Error, errText: string): MediaToolError {
  const errno = error as NodeJS.ErrnoException & { killed?: boolean };
  if (errno.code === 'ENOENT') return new MediaToolError(bin, 'missing', `缺少 ${bin}`, { cause: error });
  if (errno.killed || errno.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const reason = errno.killed ? 'timeout' : 'failed';
    const message = errno.killed ? `${bin} 超时` : `${bin} 输出超过上限`;
    return new MediaToolError(bin, reason, message, { cause: error });
  }
  const detail = errText.trim().slice(0, 400);
  return new MediaToolError(bin, 'failed', detail || `${bin} 退出失败`, { cause: error });
}
