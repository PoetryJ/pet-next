/**
 * 清理夹具：拉起一个不会自己退出的孙进程，再按模式失败、挂起或正常退出。
 * fail / hang 故意不回收孙进程，用来确认运行器会清掉它。
 */
import { spawn } from 'node:child_process';

const mode = process.argv[2];

function grandchild() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

function report(child) {
  console.log(`CHILD ${child.pid}`);
  console.error(`MODE ${mode}`);
}

if (mode === 'fail') {
  const child = grandchild();
  report(child);
  setTimeout(() => process.exit(2), 600);
} else if (mode === 'hang') {
  const child = grandchild();
  report(child);
  setInterval(() => {}, 1000);
} else if (mode === 'exit') {
  const child = grandchild();
  report(child);
  console.log('READY');
  setTimeout(() => process.exit(0), 400);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
