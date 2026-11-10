/**
 * 原生 YUVA 平面级自对照：Y/U/V/A 逐字节比，不经 RGB。
 *
 * 目的：把「原生 YUVA 直通（解码出的 YUV+alpha 平面直接送编码器，不转 RGB）」
 * 与「RGBA 路径（YUV→RGB→lut→YUV）」分开量。旧自往返装置全部先解到 RGBA
 * 再以 `-pix_fmt rgba` 喂编码器，所以它测的从来不是平面直通。
 *
 * 这里不设门限：判据是「全等」（max = 0）。0 不是拍出来的阈值，而是「直通」的定义；
 * 不成立就把实测差原样写进报告。
 */
import { decodeAllPlanes, openRaw, planeLayout, type PlaneLayout, type RawVideo } from './media.ts';
import { percentile } from './pixels.ts';

export type PlaneId = 'Y' | 'U' | 'V' | 'A';

export const PLANE_IDS: readonly PlaneId[] = ['Y', 'U', 'V', 'A'];

export interface PlaneStat {
  readonly samples: number;
  readonly max: number;
  readonly mae: number;
  readonly p99: number;
  readonly differing: number;
  readonly over1: number;
  readonly over2: number;
}

export interface PlaneWorst {
  readonly frame: number;
  readonly max: number;
}

export interface PlaneIdentityReport {
  readonly note: string;
  readonly ref: { readonly file: string; readonly frameCount: number };
  readonly cand: { readonly file: string; readonly frameCount: number };
  readonly layout: Omit<PlaneLayout, 'y' | 'u' | 'v' | 'a'>;
  readonly perPlane: Record<PlaneId, PlaneStat>;
  readonly worst: Record<PlaneId, PlaneWorst>;
  readonly identical: boolean;
  readonly maxOverPlanes: number;
}

interface Acc {
  readonly histogram: Uint32Array;
  samples: number;
  sum: number;
  max: number;
  differing: number;
  over1: number;
  over2: number;
}

function emptyAcc(): Acc {
  return { histogram: new Uint32Array(256), samples: 0, sum: 0, max: 0, differing: 0, over1: 0, over2: 0 };
}

function accumulatePlane(left: Uint8Array, right: Uint8Array, acc: Acc): void {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = Math.abs((left[index] ?? 0) - (right[index] ?? 0));
    acc.sum += delta;
    acc.samples += 1;
    acc.histogram[delta] = (acc.histogram[delta] ?? 0) + 1;
    if (delta > acc.max) acc.max = delta;
    if (delta !== 0) acc.differing += 1;
    if (delta > 1) acc.over1 += 1;
    if (delta > 2) acc.over2 += 1;
  }
}

function merge(target: Acc, source: Acc): void {
  target.samples += source.samples;
  target.sum += source.sum;
  if (source.max > target.max) target.max = source.max;
  target.differing += source.differing;
  target.over1 += source.over1;
  target.over2 += source.over2;
  for (let value = 0; value < source.histogram.length; value += 1) {
    const count = source.histogram[value] ?? 0;
    if (count !== 0) target.histogram[value] = (target.histogram[value] ?? 0) + count;
  }
}

function summarize(acc: Acc): PlaneStat {
  return {
    samples: acc.samples,
    max: acc.max,
    mae: acc.samples === 0 ? 0 : acc.sum / acc.samples,
    p99: percentile(acc.histogram, acc.samples, 0.99),
    differing: acc.differing,
    over1: acc.over1,
    over2: acc.over2,
  };
}

const SPAN_KEY = { Y: 'y', U: 'u', V: 'v', A: 'a' } as const;

/** 两份 webm 的 Y/U/V/A 平面逐帧逐字节比较；必须同分辨率、同帧数。 */
export async function measurePlaneIdentity(refFile: string, candFile: string, workDir: string, label: string): Promise<PlaneIdentityReport> {
  const ref: RawVideo = await decodeAllPlanes(refFile, workDir, `${label}-ref`);
  const cand: RawVideo = await decodeAllPlanes(candFile, workDir, `${label}-cand`);
  if (ref.width !== cand.width || ref.height !== cand.height) {
    throw new Error(`平面比较要求同分辨率：${ref.width}x${ref.height} vs ${cand.width}x${cand.height}`);
  }
  if (ref.frameCount !== cand.frameCount) {
    throw new Error(`平面比较要求同帧数：${ref.frameCount} vs ${cand.frameCount}`);
  }
  const layout = planeLayout(ref.width, ref.height);
  const refReader = openRaw(ref);
  const candReader = openRaw(cand);
  const refFrame = Buffer.alloc(ref.frameBytes);
  const candFrame = Buffer.alloc(cand.frameBytes);
  const totals: Record<PlaneId, Acc> = { Y: emptyAcc(), U: emptyAcc(), V: emptyAcc(), A: emptyAcc() };
  const worst: Record<PlaneId, PlaneWorst> = {
    Y: { frame: -1, max: 0 },
    U: { frame: -1, max: 0 },
    V: { frame: -1, max: 0 },
    A: { frame: -1, max: 0 },
  };
  try {
    for (let frame = 0; frame < ref.frameCount; frame += 1) {
      refReader.read(frame, refFrame);
      candReader.read(frame, candFrame);
      for (const plane of PLANE_IDS) {
        const span = layout[SPAN_KEY[plane]];
        const frameAcc = emptyAcc();
        accumulatePlane(refFrame.subarray(span.offset, span.offset + span.length), candFrame.subarray(span.offset, span.offset + span.length), frameAcc);
        if (frameAcc.max > worst[plane].max) worst[plane] = { frame, max: frameAcc.max };
        merge(totals[plane], frameAcc);
      }
    }
  } finally {
    refReader.close();
    candReader.close();
  }
  const perPlane: Record<PlaneId, PlaneStat> = {
    Y: summarize(totals.Y),
    U: summarize(totals.U),
    V: summarize(totals.V),
    A: summarize(totals.A),
  };
  const maxOverPlanes = Math.max(perPlane.Y.max, perPlane.U.max, perPlane.V.max, perPlane.A.max);
  return {
    note: '全 48 帧、逐平面逐字节；解码显式 -c:v libvpx-vp9 -pix_fmt yuva420p，未经 RGB',
    ref: { file: refFile, frameCount: ref.frameCount },
    cand: { file: candFile, frameCount: cand.frameCount },
    layout: {
      width: layout.width,
      height: layout.height,
      chromaWidth: layout.chromaWidth,
      chromaHeight: layout.chromaHeight,
      frameBytes: layout.frameBytes,
    },
    perPlane,
    worst,
    identical: maxOverPlanes === 0,
    maxOverPlanes,
  };
}
