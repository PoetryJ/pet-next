/**
 * 系统缩放与模拟缩放的判别。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readForcedDeviceScaleFactor, scaleSourceOf } from './scale-source.ts';

describe('readForcedDeviceScaleFactor', () => {
  test('没有开关时留给操作系统', () => {
    assert.equal(readForcedDeviceScaleFactor('', ['electron', 'main.js']), null);
    assert.equal(scaleSourceOf(null), 'os');
  });

  test('100%、125%、150% 记为模拟条件', () => {
    assert.equal(readForcedDeviceScaleFactor('', ['--force-device-scale-factor=1']), 1);
    assert.equal(readForcedDeviceScaleFactor('', ['--force-device-scale-factor=1.25']), 1.25);
    assert.equal(readForcedDeviceScaleFactor('1.5', []), 1.5);
    assert.equal(scaleSourceOf(1.25), 'simulated-chromium-flag');
  });

  test('0 和非数字不当作模拟缩放', () => {
    assert.equal(readForcedDeviceScaleFactor('0', []), null);
    assert.equal(readForcedDeviceScaleFactor('abc', []), null);
    assert.equal(readForcedDeviceScaleFactor('', ['--force-device-scale-factor=0']), null);
  });
});
