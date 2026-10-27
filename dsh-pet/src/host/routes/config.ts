/**
 * 内容配置的读写与元信息：电机 /config、单宠显示位置 /pet-display、可编辑字段清单 /config/meta。
 *
 * 不校验配置形状（归 ./config），不重启桌面 Helper 之外的进程。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/config
 */
import {
  PET_DISPLAY_SET,
  findPetInstance,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  syncUserConfigFromDefault,
  userConfigUnparsable,
} from '../config.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { type RouteResult } from '../http.ts';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.ts';
import { profileNameFrom, storageEntries } from '../storage-paths.ts';
import { electronLandingDir } from '../helper-process.ts';
import { homedir } from 'node:os';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 内容配置领域：未命中返回 undefined，命中返回应答。 */
export async function handleConfigRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const {
    configPaths,
    ctx,
    lock,
    log,
    memesUserRoot,
    petConfigDir,
    state,
    requestRestart,
    thumbUserRoot,
    userConfigPath,
    userRoot,
  } = deps;
  const { body, method, rest, url } = input;

  // 成品配置：/dsh-pet-7340/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
  if (rest === 'config') {
    if (method === 'GET') {
      // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
      // 浏览器/桌面/设置页直接消费，无需任何校验/兜底
      try {
        // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
        // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
        return {
          kind: 'json',
          status: 200,
          obj: readAllConfig(configPaths),
          headers: { 'cache-control': 'no-cache, no-store' },
        };
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    if (method === 'PUT') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      try {
        // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段带回给 saveUserConfig，
        // 保存不再抹掉用户手改的精调配置。
        // 必须走 JSONC 容忍解析器（readUserConfig）：用户层可能是带 // 注释的 config.jsonc 原文，
        // 严格 JSON.parse 会抛错并吞掉 → existing 变 undefined → 白名单重建 → 高级字段全丢。
        const existing = readUserConfig(configPaths);
        const clean = saveUserConfig(parsed, existing);
        if (!clean) {
          return {
            kind: 'json',
            status: 400,
            obj: {
              error:
                'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（id 为非空字符串且去除首尾空白后唯一；display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled / trayEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
            },
          };
        }
        // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ 先不写盘。
        // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
        // 所以回 409 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
        if (url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
          return {
            kind: 'json',
            status: 409,
            obj: { error: 'user config is unparsable', needConfirm: true, userFile: userConfigPath },
          };
        }
        await mkdir(userRoot, { recursive: true });
        await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
        void requestRestart(); // display/size 等可能变化：重解析桌面宠物并重启 Helper（异步，不阻塞保存响应）
        // 响应体 = 保存后的成品聚合（与 GET /config 同一份，字段已填满）：设置页直接交给
        // flattenConfigPets 拍平渲染，客户端的条目级字段只有这一处填充。
        return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-pet] config save failed: ${e instanceof Error ? e.message : String(e)}`);
        return { kind: 'json', status: 500, obj: { error: 'failed to save config' } };
      }
    }
    if (method === 'POST') {
      // 同步：把内置默认配置（assets/config.jsonc 原文，含注释）整份写入用户配置——
      // 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
      // 不必再自己从包内复制一份（见 config.ts 的 syncUserConfigFromDefault）。
      try {
        syncUserConfigFromDefault(configPaths);
      } catch (e) {
        // 默认文件缺失 / 用户目录不可写：显式 500，绝不静默留下半个配置文件
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
      void requestRestart(); // 配置变了：重解析桌面宠物并重启 Helper（异步，不阻塞响应）
      return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
    }
    return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
  }

  // 单只宠物的显示位置（桌面端右键「关闭桌面显示」→ POST /pet-display）。只收 id + display：
  // 客户端做整段读-改-写容易误伤同层其它宠物，也拿不准该写哪一层；层归属由服务端反查
  // （合并后 id 全局唯一，findPetInstance 没有歧义）。
  // 写入语义与 PUT /config 一致：白名单重建 + existing 透传，用户手改的非白名单字段不许被抹掉。
  if (rest === 'pet-display') {
    if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    // 失败一律 HTTP 200 + `{ok:false, reason, message}`（与其他动作端点同口径）：缺 id / display
    // 非法 / 宠物不存在 / 写盘失败都是业务错误，用 400/404 会让调用方当成传输层故障。
    // 只有 405（方法错）与 400（JSON 坏了）仍是协议层错误码，全插件只有这两处不是 200。
    const fail = (reason: string, message: string): RouteResult => ({
      kind: 'json',
      status: 200,
      obj: { ok: false, reason, message },
    });
    let payload: { id?: unknown; display?: unknown };
    try {
      payload = JSON.parse(body ?? '') as { id?: unknown; display?: unknown };
    } catch {
      return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
    }
    const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
    const nextDisplay = String(payload.display ?? '');
    // id 必填（与 9 条 `?pet=` 路由同一对词汇：没给 → pet-required；不存在 → unknown-pet）
    if (!petId) return fail('pet-required', 'pet 必填：要指定操作哪只桌宠');
    if (!PET_DISPLAY_SET.has(nextDisplay)) {
      return fail('bad-request', `display 必须是 web / desktop / both / none：${nextDisplay}`);
    }
    let merged: Record<string, Record<string, unknown>>;
    try {
      merged = readAllConfig(configPaths);
    } catch (e) {
      return fail('generate-error', e instanceof Error ? e.message : String(e));
    }
    // 命中不到有两种可能：id 根本不存在，或该实例在合并时因 id 与其它条目重复被跳过（不在聚合里）。
    // 两种都只能按「没有这只桌宠」报——绝不能凭 id 去猜它「应该」属于哪个文件。
    const hit = findPetInstance(merged, petId);
    if (!hit) return fail('unknown-pet', `没有这只桌宠：${petId}`);
    // 目标层：main → 用户主配置；其余 → 文件宠物自己的配置（.json 或 .jsonc，定位统一走 ./config）
    let layerPath: string;
    let layerDir: string;
    let existing: Record<string, unknown> | undefined;
    if (hit.entry === 'main') {
      layerPath = userConfigPath;
      layerDir = userRoot;
      existing = readUserConfig(configPaths);
    } else {
      const file = readPetConfigEntry(configPaths, hit.entry);
      if (!file) {
        return fail('generate-error', `宠物条目配置文件找不到：${hit.entry}`);
      }
      layerPath = file.path;
      layerDir = petConfigDir;
      existing = file.raw;
    }
    // 整段替换语义：saveUserConfig 重建的是整个 pets 数组，必须带上该层全部宠物，只把目标
    // 那只的 display 换掉（漏掉别的 = 把它们从配置里删掉）。
    const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
    const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, display: nextDisplay } : p));
    const clean = saveUserConfig({ pets }, existing);
    if (!clean) return fail('bad-request', '宠物配置非法');
    try {
      await mkdir(layerDir, { recursive: true });
      await writeFile(layerPath, JSON.stringify(clean, null, 2), 'utf8');
    } catch (e) {
      return fail('generate-error', e instanceof Error ? e.message : String(e));
    }
    // 配置变更信号（只在写盘成功之后：失败时不该动版本号，否则浏览器白重拉一次 /config）。
    // 这是全插件唯一写 sections.config 的地方：保存 / 同步配置的调用方自己就拿到了成品聚合
    // （响应体），桌面端由下面的 requestRestart() 重启，都不需要这个信号；
    // 而桌面端右键改 display 时浏览器页面不是发起方，只能靠它发现「配置被别处改过」。
    state.writeSection('config', {});
    // 占用锁：改成 `none`（桌面端右键「关闭桌面显示」）＝ 用户主动隐藏/关闭，属于抢占——
    // 撤销本轮占用（cause: preempted）。不做的话宠物会被锁到 TTL 到点，而用户明明已经把它藏了
    // （issue #122：「用户主动停止、隐藏或关闭时，也应能取消联动，避免宠物被永久锁住」）。
    // 只认 `none`：web/desktop/both 是换显示位置，不是「用户接管」。
    if (nextDisplay === 'none') lock.release({ petId, force: true });
    // 不 await：发起者很可能就是即将被这次重载换掉的桌面 Helper（与 /reload 同一处境）。
    // 写盘已经落定，重启结果不需要回给调用方。
    void requestRestart();
    // 响应体 = 改动后的成品聚合（与 PUT / POST /config 同形）：调用方（浏览器端右键菜单）
    // 直接把它交给 petBridge.reload，不必再发一次 GET /config —— 与设置页保存走的是同一条路，
    // 也就不会拿到可能陈旧的配置（现场表现：不返回聚合时浏览器端要刷新才生效）。
    return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
  }

  // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
  if (rest === 'config/meta') {
    return {
      kind: 'json',
      status: 200,
      obj: {
        user: userConfigPath,
        default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
        animations: thumbUserRoot,
        memes: memesUserRoot,
        // 统一日志出口（就是上面那个 logger 的 file：三种模式都落在 $DSH_HOME/dsh-pet/logs.txt）：
        // 桌面版没有控制台，用户反馈「宠物不出现 / 闪退」时只能靠这个文件。
        logs: log.file,
        // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
        // 前两条直接传真实写入方的路径，不在这里重拼目录名
        storage: storageEntries({
          userDataRoot: userRoot,
          electronDir: electronLandingDir(),
          home: homedir(),
          packageRoot: PACKAGE_ROOT,
        }),
        // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
        profile: profileNameFrom(PACKAGE_ROOT) ?? '',
      },
    };
  }

  return undefined;
}
