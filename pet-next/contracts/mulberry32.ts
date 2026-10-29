/**
 * 持续负载夹具的随机序列，只供 runner 造数。
 * @module pet-next/contracts/mulberry32
 */

/**
 * 由种子生成 `[0, 1)` 的序列。种子按无符号 32 位进入。
 *
 * @param seed - 夹具里的固定种子。
 * @returns 每次调用给出下一个数。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
