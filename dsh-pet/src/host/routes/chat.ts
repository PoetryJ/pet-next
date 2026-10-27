/**
 * 对话：/chat 读写对话记忆并调用模型生成回复。
 *
 * 不拼装提示词（归 ./chat）。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/chat
 */
import { readAllConfig, sliceMemoryRounds } from '../config.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 对话领域：未命中返回 undefined，命中返回应答。 */
export async function handleChatRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { chatWithPet, configPaths, log, memoryPath, memoryRounds, readMemory, requirePet } = deps;
  const { body, method, rest, url } = input;

  // 对话：GET /chat 读最近记忆窗口（截尾 chatMemoryRounds 轮，一次读、不是轮询），
  // POST /chat 携带历史生成回复并写入记忆，回复同时写 S 的 pets.<id>.say。
  // 记忆唯一读写方是 host（memory.json），浏览器与桌面天然共享同一份。
  if (rest === 'chat') {
    if (method !== 'GET' && method !== 'POST') {
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }
    try {
      // `?rounds=`：GET 专属的查看参数——只决定这次读多少轮（不写记忆，也不改变后续对话
      // 往上下文里带多少，所以 POST 不认它）。与 surface 同一处境：参数级校验放在读盘之前。
      const roundsRaw = method === 'GET' ? url.searchParams.get('rounds') : null;
      let roundsOverride: number | null = null;
      if (roundsRaw !== null && roundsRaw.trim() !== '') {
        const n = Number(roundsRaw);
        if (!Number.isInteger(n) || n < 0 || n > 200) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: false, reason: 'bad-request', message: 'rounds 必须是 0–200 的整数（不传则用配置）' },
          };
        }
        roundsOverride = n;
      }
      // pet 必填且必须真实存在：空串会让人设/配图按 main 条目取，记忆以那个（不存在的）id
      // 新建一个分桶，回复写进没人消费的 `pets[""].say`，还回 ok:true。
      // 惰性 + 记忆化：pet 空串时完全不读配置；GET 分支复用同一次读取。
      let cfgCache: Record<string, Record<string, unknown>> | undefined;
      const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(configPaths));
      // surface 只对 POST 校验：GET 是读记忆，跟宠物显示在哪一端无关
      const who = requirePet(url.searchParams, cfg, { surface: method === 'POST' });
      if (!who.ok) return who.res;
      const petId = who.petId;
      if (method === 'GET') {
        const mem = await readMemory();
        const rawMessages = mem[who.entry]?.[petId]?.messages;
        // 记忆文件是合法 JSON 但 messages 不是数组时，slice() 会抛 slice is not a function：
        // 按空历史处理并记一行日志，不因为一条坏数据让整个历史接口报错。
        const list = Array.isArray(rawMessages) ? rawMessages.filter((m) => m && typeof m.content === 'string') : [];
        if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
          log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按空历史处理：${memoryPath}`);
        }
        // 传了 ?rounds= 就用传的（含 0 = 空历史），没传才回落到配置
        const rounds = roundsOverride ?? memoryRounds(who.conf);
        // 与 chatWithPet 同一语义：rounds = 0 → 空历史（slice(-0) 会返回整个数组，见上）
        const messages = sliceMemoryRounds(list, rounds);
        return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
      }
      if (method === 'POST') {
        const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        if (!text) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
        }
        if (text.length > 2000) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
          };
        }
        const result = await chatWithPet(petId, text);
        return { kind: 'json', status: 200, obj: result };
      }
    } catch (e) {
      // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
      return {
        kind: 'json',
        status: 200,
        obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  return undefined;
}
