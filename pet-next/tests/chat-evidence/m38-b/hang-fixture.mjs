#!/usr/bin/env node
/**
 * 负对照夹具（M3-8 B）：故意"挂住"——顶层 await 永不 resolve，并留下一个继承 stdout 的子进程。
 * 只用于验证 run-hang-probe.mjs 的看门狗确实能在总限到点时 SIGKILL 整棵树并拿到 exit/close，
 * 不是被 10s 限时"吓住"的通路。不参与产品代码、不参与任何测试收集。
 */
import { spawn } from 'node:child_process';

spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
process.stdout.write('{"event":"hang-fixture-started"}\n');
await new Promise(() => {});
