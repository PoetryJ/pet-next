#!/usr/bin/env node
/**
 * M3-11 A：把一轮的“输入 → 写入”按序号对齐，自证“一次输入是否只写一次”。
 *
 *   node bench/drag-write-budget/align-forensic.mjs --run=cdp-125 [--limit=20]
 *
 * 读 `runs/<run>/dispatch.ndjson`、`pointer.ndjson`、`bounds.ndjson`，用与 run.mjs 完全相同的筛选
 * （drag-start = 距按下点 ≥5px 的第一条 move；之后只看 screen 坐标有变化的 move），然后按序号 1:1 配对：
 *   第 k 条 drag-move ↔ 第 k 条 bounds 行
 * 打印数量链（dispatch → pointermove → dragMoves → bounds）、`bounds/dragMoves`、`<0.6ms` 写对的
 * 输入间隔是否同样 <0.6ms，以及一段连续事件表（输入时刻 / 屏幕坐标 / 写入时刻 / requested）。
 *
 * 判读：若 bounds/dragMoves > 1，说明一次输入写了两次（产品双写）；= 1 则是输入自己成对到达。
 * @module pet-next/bench/drag-write-budget/align-forensic
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const run = value('run', 'cdp-125');
const limit = Number(value('limit', '20'));
const THRESHOLD_PX = 5;
const TIGHT_MS = 0.6;

const readNdjson = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const dir = path.join(benchDir, 'runs', run);
const dispatch = readNdjson(path.join(dir, 'dispatch.ndjson'));
const pointer = readNdjson(path.join(dir, 'pointer.ndjson'));
const bounds = readNdjson(path.join(dir, 'bounds.ndjson'));

const press = pointer.find((event) => event.type === 'pointerdown') ?? null;
const moves = pointer.filter((event) => event.type === 'pointermove');
let started = false;
let prev = null;
const drag = [];
for (const move of moves) {
  if (!started) {
    if (press !== null && Math.hypot(move.screenX - press.screenX, move.screenY - press.screenY) >= THRESHOLD_PX) {
      started = true;
      drag.push(move);
    }
    prev = move;
    continue;
  }
  if (prev !== null && (move.screenX !== prev.screenX || move.screenY !== prev.screenY)) drag.push(move);
  prev = move;
}

const n = Math.min(drag.length, bounds.length);
const rows = Array.from({ length: n }, (_, i) => ({
  k: i,
  pt: drag[i].t,
  psx: drag[i].screenX,
  psy: drag[i].screenY,
  wt: bounds[i].at,
  wx: bounds[i].requested.x,
  wy: bounds[i].requested.y,
}));
const pGap = (i) => (i === 0 ? null : rows[i].pt - rows[i - 1].pt);
const wGap = (i) => (i === 0 ? null : rows[i].wt - rows[i - 1].wt);

console.log(`run=${run}`);
console.log(
  `dispatch=${dispatch.length} pointermove=${moves.length} dragMoves=${drag.length} bounds=${bounds.length} ` +
    `bounds/dragMoves=${(bounds.length / Math.max(1, drag.length)).toFixed(3)}`,
);
const tightWrites = [];
let maxSkew = 0;
let sumSkew = 0;
for (let i = 1; i < rows.length; i += 1) {
  const skew = Math.abs(wGap(i) - pGap(i));
  maxSkew = Math.max(maxSkew, skew);
  sumSkew += skew;
  if (wGap(i) < TIGHT_MS) tightWrites.push(i);
}
console.log(
  `tight write pairs(<${TIGHT_MS}ms)=${tightWrites.length}/${rows.length - 1}; ` +
    `all with pointer gap<${TIGHT_MS}ms? ${tightWrites.every((i) => pGap(i) < TIGHT_MS)}; ` +
    `|wGap-pGap| mean=${(sumSkew / Math.max(1, rows.length - 1)).toFixed(3)}ms max=${maxSkew.toFixed(3)}ms`,
);
console.log(`identical pointer timestamps in drag sequence=${drag.filter((m, i) => i > 0 && m.t === drag[i - 1].t).length}`);
console.log('');
const start = Math.max(0, (tightWrites[0] ?? 1) - 6);
console.log('k | pointer.t | pGap | screen(x,y) | writeAt | wGap | requested');
for (let i = start; i < Math.min(rows.length, start + limit); i += 1) {
  const r = rows[i];
  const gap = (v) => (v === null ? '-' : v.toFixed(3));
  console.log(
    `${r.k} | ${r.pt.toFixed(3)} | ${gap(pGap(r.k))} | ${r.psx},${r.psy} | ${r.wt.toFixed(3)} | ${gap(wGap(r.k))} | ${r.wx},${r.wy}`,
  );
}
