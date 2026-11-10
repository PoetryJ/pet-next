/**
 * 编码档位敏感性：同一份「alpha<=1 置零」预处理输入，换 crf 重编 F/C，量 F–C 与 O–C。
 *
 * 不是画质门的一部分，只回答「差多少、差在哪、和编码档位的关系」。
 * 起因：crf 4 时 F–C 合成最大差就已经 6/255、O–C 前景 MAE 1.48/255，
 * 而 crf 0（真无损）时分别是 2/255 和 0.002/255。档位的影响远大于 alpha 阈值本身。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runMediaTool } from './tool.ts';
import { FIXTURE_CROP, encodeCommand, petRoot } from './arms.ts';
import { decodeAllFrames, openRaw } from './media.ts';
import { alphaStats, applyAlphaFloor, compositeFrame, diffStats, edgeMask, foregroundMask, restoreCrop } from './pixels.ts';

export interface EncoderProbe {
  readonly crf: number;
  readonly bytes: { readonly F: number; readonly C: number; readonly source: number };
  readonly fToC: { readonly maxComposite: number; readonly alphaMax: number; readonly samplesOver2: number };
  readonly ocForeground: { readonly mae: number; readonly p99: number; readonly max: number };
  readonly ocEdge: { readonly mae: number; readonly p99: number; readonly max: number };
}

/** 对每个 crf 各编一份 F/C，解回来全部 48 帧比一遍。 */
export async function probeEncoderSettings(workDir: string, crfs: readonly number[]): Promise<{ probes: EncoderProbe[]; problems: string[] }> {
  const problems: string[] = [];
  const source = path.join(petRoot(), 'assets', 'idle.webm');
  const decoded = await decodeAllFrames(source, workDir, 'sensitivity-source');
  const prepared = path.join(workDir, 'sensitivity-prepared.rgba');
  const whole = readFileSync(decoded.rawPath);
  for (let frame = 0; frame < decoded.frameCount; frame += 1) {
    applyAlphaFloor(whole.subarray(frame * decoded.frameBytes, (frame + 1) * decoded.frameBytes), 1);
  }
  writeFileSync(prepared, whole);
  const sourceBytes = statSync(source).size;

  const width = decoded.width;
  const height = decoded.height;
  const crop = FIXTURE_CROP;
  const original = openRaw(decoded);
  const frameBuffer = Buffer.alloc(decoded.frameBytes);
  const restored = Buffer.alloc(width * height * 4);
  const left = Buffer.alloc(width * height * 3);
  const right = Buffer.alloc(width * height * 3);
  const probes: EncoderProbe[] = [];
  try {
    for (const crf of crfs) {
      const fFile = path.join(workDir, `sensitivity-crf${crf}-F.webm`);
      const cFile = path.join(workDir, `sensitivity-crf${crf}-C.webm`);
      await runMediaTool(encodeCommand(prepared, fFile, width, height, null, crf), 300_000);
      await runMediaTool(encodeCommand(prepared, cFile, width, height, crop, crf), 300_000);
      const fArm = await decodeAllFrames(fFile, workDir, `sens-crf${crf}-F`);
      const cArm = await decodeAllFrames(cFile, workDir, `sens-crf${crf}-C`);
      const fReader = openRaw(fArm);
      const cReader = openRaw(cArm);
      const fBuffer = Buffer.alloc(fArm.frameBytes);
      const cBuffer = Buffer.alloc(cArm.frameBytes);
      let maxComposite = 0;
      let alphaMax = 0;
      let samplesOver2 = 0;
      const worst = {
        fg: { mae: 0, p99: 0, max: 0, frame: -1 },
        edge: { mae: 0, p99: 0, max: 0, frame: -1 },
      };
      for (let frame = 0; frame < decoded.frameCount; frame += 1) {
        original.read(frame, frameBuffer);
        fReader.read(frame, fBuffer);
        cReader.read(frame, cBuffer);
        restoreCrop(cBuffer, crop, width, height, restored);
        const alpha = alphaStats(fBuffer, restored, null);
        if (alpha.max > alphaMax) alphaMax = alpha.max;
        const foreground = foregroundMask(frameBuffer, width, height, 1);
        const edge = edgeMask(frameBuffer, width, height, 1, 2, 64);
        for (const plate of ['black', 'white', 'checker'] as const) {
          compositeFrame(fBuffer, width, height, plate, left);
          compositeFrame(restored, width, height, plate, right);
          const fc = diffStats(left, right, null);
          if (fc.max > maxComposite) maxComposite = fc.max;
          samplesOver2 += fc.over2;
          compositeFrame(frameBuffer, width, height, plate, left);
          const fg = diffStats(left, right, foreground);
          const ed = diffStats(left, right, edge);
          if (fg.mae > worst.fg.mae) worst.fg = { mae: fg.mae, p99: fg.p99, max: fg.max, frame };
          if (ed.mae > worst.edge.mae) worst.edge = { mae: ed.mae, p99: ed.p99, max: ed.max, frame };
        }
      }
      fReader.close();
      cReader.close();
      probes.push({
        crf,
        bytes: { F: statSync(fFile).size, C: statSync(cFile).size, source: sourceBytes },
        fToC: { maxComposite, alphaMax, samplesOver2 },
        ocForeground: { mae: worst.fg.mae, p99: worst.fg.p99, max: worst.fg.max },
        ocEdge: { mae: worst.edge.mae, p99: worst.edge.p99, max: worst.edge.max },
      });
    }
  } finally {
    original.close();
  }
  return { probes, problems };
}
