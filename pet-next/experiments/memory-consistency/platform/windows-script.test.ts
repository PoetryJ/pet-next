/**
 * Windows 验收入口脚本的静态契约测试。
 *
 * 本机没有 Windows/PowerShell，无法执行；这里只守住 R1 复核指出的三个具体缺陷：
 * 1. 无 BOM 的 UTF-8 在 Windows PowerShell 5 会 ParserError；
 * 2. 入口路径写死/借外层 git HEAD；
 * 3. 子命令失败但包装脚本仍 exit 0。
 * 真正的执行结果必须由 Windows 环境或 Codex 补验，测试不冒充运行时证据。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, 'windows-r1.ps1'));
const text = raw.toString('utf8');

describe('Windows 脚本契约（静态）', () => {
  test('UTF-8 BOM + CRLF：Windows PowerShell 5 才能正确解析中文', () => {
    assert.equal(raw[0], 0xef);
    assert.equal(raw[1], 0xbb);
    assert.equal(raw[2], 0xbf);
    assert.ok(raw.includes(Buffer.from('\r\n')), '必须是 CRLF');
  });

  test('用 $PSScriptRoot 定位仓库根，不依赖调用目录', () => {
    assert.match(text, /\$PSScriptRoot/);
    assert.match(text, /Resolve-Path \(Join-Path \$PSScriptRoot/);
  });

  test('SourceCommit 必填，不借外层 git HEAD', () => {
    assert.match(text, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$SourceCommit/);
    assert.equal(/git rev-parse/.test(text), false, '脚本不得自己读 git HEAD');
    assert.match(text, /--source-commit=/);
  });

  test('空格路径步骤调用真实的 memory-consistency/run.mjs，而不是上一级 run.mjs', () => {
    assert.match(text, /\$spacedExp = Join-Path \$spacedRoot "experiments\\memory-consistency"/);
    assert.match(text, /Join-Path \$spacedExp "run\.mjs"/);
    assert.equal(/Join-Path \$spacedRoot "run\.mjs"/.test(text), false);
  });

  test('每个子命令都记录退出码，任一步失败则非零退出', () => {
    assert.match(text, /\$code = \$LASTEXITCODE/);
    assert.match(text, /\$failed = @\(\$script:steps \| Where-Object \{ \$_.exit -ne 0 \}\)/);
    assert.match(text, /if \(\$failed\.Count -gt 0 -or -not \$gateOk\)/);
    assert.match(text, /exit 1/);
  });

  test('检查结果文件与信封，不只列文件名', () => {
    assert.match(text, /function Assert-GateArtifact/);
    assert.match(text, /memory-gate\/v1/);
    assert.match(text, /passed_gate/);
    assert.match(text, /sourceCommit/);
  });

  test('提供 fake-node 全 exit 7 的自检，验证失败会传播', () => {
    assert.match(text, /\[switch\]\$SelfTest/);
    assert.match(text, /fake-node\.cmd/);
    assert.match(text, /exit \/b 7/);
    assert.match(text, /SELFTEST PASSED/);
  });

  test('平台报告引用该脚本，不在 Windows 上写「本机无 Windows」', () => {
    const checks = readFileSync(join(HERE, 'checks.ts'), 'utf8');
    assert.match(checks, /onWindows \? \x27measured\x27 : \x27not_run\x27/);
    assert.match(checks, /本进程运行在 Windows/);
  });
});
