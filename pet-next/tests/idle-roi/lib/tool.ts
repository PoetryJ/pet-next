/**
 * 画质门的自包含素材工具：只做"用参数数组调 ffmpeg/ffprobe"与"把 RGBA 写成 PNG"。
 *
 * 为什么复制而不是 import `assets-pipeline/`：`tests/boundaries.test.ts` 明确禁止产品目录
 * （含 `tests/`）引用素材流水线，画质门必须能独立复跑，不把流水线目录变成测试依赖。
 * 逻辑与 `assets-pipeline/media-tool.ts`、`assets-pipeline/png-rgba.ts` 等价，
 * 只保留本门实际用到的部分。
 *
 * @module pet-next/tests/idle-roi/lib/tool
 */
import { execFile } from 'node:child_process';
import { deflateSync } from 'node:zlib';

/** 640×360×48 帧 RGBA 约 44MB，上限留一倍。 */
const MAX_STDOUT_BYTES = 80 * 1024 * 1024;

export type ToolFailure = 'missing' | 'timeout' | 'failed';

/** 工具没跑成。`missing`、超时与其它失败分开。 */
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
 * 执行一条已经拆开的命令（不经过 shell）。
 *
 * @param command - 第一个元素是可执行文件。
 * @param timeoutMs - 超时后杀掉子进程。
 */
export function runMediaTool(command: readonly string[], timeoutMs: number): Promise<ToolResult> {
  const bin = command[0];
  if (!bin) return Promise.reject(new MediaToolError('tool', 'missing', '命令为空'));
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      command.slice(1),
      { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        if (!error) {
          resolve({ stdout: outBuf, stderr: errText });
          return;
        }
        reject(toolError(bin, error, errText));
      },
    );
  });
}

function toolError(bin: string, error: Error, errText: string): MediaToolError {
  const errno = error as NodeJS.ErrnoException & { killed?: boolean };
  if (errno.code === 'ENOENT') return new MediaToolError(bin, 'missing', `缺少 ${bin}`, { cause: error });
  if (errno.killed || errno.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const reason: ToolFailure = errno.killed ? 'timeout' : 'failed';
    const message = errno.killed ? `${bin} 超时` : `${bin} 输出超过上限`;
    return new MediaToolError(bin, reason, message, { cause: error });
  }
  const detail = errText.trim().slice(0, 400);
  return new MediaToolError(bin, 'failed', detail || `${bin} 退出失败`, { cause: error });
}

/** 8-bit RGBA PNG；长度不对时抛出。 */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`RGBA 长度应为 ${width * height * 4}，收到 ${rgba.length}`);
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr(width, height)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
