/**
 * 编码参数必须带上 alpha，并且不能出现抠黑滤镜。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterDeletesNearBlack, preserveAlphaEncodeCommand } from './encode-alpha.ts';

test('VP9 编码保留 yuva，并在解码端指定 libvpx', () => {
  const command = preserveAlphaEncodeCommand('ffmpeg', 'in.webm', 'out.webm', { x: 2, y: 4, width: 16, height: 18 }, 'vp9');
  const filter = command[command.indexOf('-vf') + 1] ?? '';
  assert.equal(filter, 'crop=16:18:2:4,format=yuva420p');
  assert.equal(filterDeletesNearBlack(filter), false);
  assert.ok(command.includes('libvpx-vp9'));
  assert.equal(command[command.indexOf('-auto-alt-ref') + 1], '0');
  assert.equal(command[command.indexOf('-pix_fmt') + 1], 'yuva420p');
  assert.equal(command.at(-1), 'out.webm');
});

test('色键和 geq 算作删除近黑', () => {
  assert.equal(filterDeletesNearBlack('crop=2:2:0:0,format=yuva420p'), false);
  assert.equal(filterDeletesNearBlack('colorkey=0x000000:0.1:0.1'), true);
  assert.equal(filterDeletesNearBlack('format=yuva420p,chromakey=black'), true);
  assert.equal(filterDeletesNearBlack('geq=r=r:a=if(lt(r,16),0,255)'), true);
});
