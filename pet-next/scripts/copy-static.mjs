/**
 * 把页面、样式和本地素材复制到 dist，供 Electron loadFile 使用。
 * 不读取 dsh-pet，也不访问网络。
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(join(root, 'dist/app'), { recursive: true });
await mkdir(join(root, 'dist/assets'), { recursive: true });
await cp(join(root, 'app/page.html'), join(root, 'dist/app/page.html'));
await cp(join(root, 'app/page.css'), join(root, 'dist/app/page.css'));
await cp(join(root, 'assets'), join(root, 'dist/assets'), { recursive: true });
