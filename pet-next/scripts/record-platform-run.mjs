/**
 * 跨平台一次运行的入口。记录逻辑在 tests/support/record-cli.ts。
 *
 * Windows 与 Linux 同一条命令（在 pet-next 目录下）：
 *   node scripts/record-platform-run.mjs -- node --experimental-strip-types --test --test-reporter spec tests/cleanup.test.ts tests/support/process-tree.test.ts tests/support/process-table.test.ts tests/support/run-record.test.ts tests/support/record-cli.test.ts
 *
 * 日志写到 logs/platform-runs/<platform>/。本脚本不会因为当前不是 Windows 而报通过。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, '..', 'tests', 'support', 'record-cli.ts');
const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
