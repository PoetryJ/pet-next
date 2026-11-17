/**
 * 把故事里的 96 轮历史写进宿主记忆（数据准备，不是测量）。
 *
 * 为什么预置：96 轮若都走在线抽取，单 run 就会产生 30+ 次模型调用，72 run 超出 2000 POST 预算，
 * 且与“长期运行后的一次介入”不符。预置内容与真实历史同构（原话、时间、任务范围、来源轮次），
 * 并标记为已抽取；当轮的 1–3 轮仍走真实 /api/say。
 *
 * 同时预置 1–2 条结构化承诺（含改口版本），使 V 臂看到与 T 臂同等的“历史”。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export function seedHistory(workspace, story, taskIds, now = new Date().toISOString()) {
  const db = new DatabaseSync(join(workspace, 'state', 'followup.sqlite'))
  // 与 capability/memory/store.ts 同构；baseline 模式没有 cap_* 表时也能预置（dry-run 用）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cap_log (cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, scopes TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cap_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, task_ids TEXT NOT NULL, project_id TEXT, cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cap_items (item_id TEXT PRIMARY KEY, json TEXT NOT NULL, cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cap_extractions (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT NOT NULL, turn_ids TEXT NOT NULL, cursor INTEGER NOT NULL);
  `)
  const insertLog = db.prepare('INSERT INTO cap_log (kind, ref, scopes, at) VALUES (?,?,?,?)')
  const insertTurn = db.prepare('INSERT OR REPLACE INTO cap_turns (turn_id, session_id, seq, at, role, text, task_ids, project_id, cursor) VALUES (?,?,?,?,?,?,?,?,?)')
  const insertItem = db.prepare('INSERT OR REPLACE INTO cap_items (item_id, json, cursor) VALUES (?,?,?)')
  const turnIdOf = (n) => `hist-${story.id}-${String(n).padStart(3, '0')}`
  let seq = 0
  let cursor = 0
  let correction = null
  db.exec('BEGIN')
  try {
    for (const turn of story.turns) {
      seq += 1
      cursor = Number(insertLog.run('turn', turnIdOf(seq), JSON.stringify([taskIds[turn.target]]), turn.at).lastInsertRowid)
      insertTurn.run(turnIdOf(seq), `hist-${story.id}`, seq, turn.at, 'user', turn.text, JSON.stringify([taskIds[turn.target]]), null, cursor)
    }
    const allIds = story.turns.map((_, i) => turnIdOf(i + 1))
    cursor = Number(insertLog.run('extraction', `seed-${story.id}`, JSON.stringify(Object.values(taskIds)), now).lastInsertRowid)
    db.prepare('INSERT OR REPLACE INTO cap_extractions (request_id, status, detail, turn_ids, cursor) VALUES (?,?,?,?,?)')
      .run(`seed-${story.id}`, 'applied', 'seeded_history', JSON.stringify(allIds), cursor)

    const first = story.turns[0]
    const base = {
      itemId: `seed-${story.id}-c1`,
      kind: 'commitment',
      key: 'completionCondition',
      value: 'reports_ready_then_ask',
      statement: first.text,
      scope: { level: 'task', id: taskIds.A },
      validFrom: first.at,
      validUntil: null,
      status: 'active',
      authority: 'user',
      confidence: 1,
      evidenceTurnIds: [turnIdOf(1)],
      supersedes: [],
      supersededBy: [],
    }
    cursor = Number(insertLog.run('item', base.itemId, JSON.stringify([taskIds.A]), now).lastInsertRowid)
    insertItem.run(base.itemId, JSON.stringify(base), cursor)

    correction = story.live?.livesays?.find((s) => /更正/.test(s.text))?.text ?? null
    if (correction) {
      const lastTurn = story.turns.at(-1)
      const next = {
        ...base,
        itemId: `seed-${story.id}-c2`,
        value: 'reports_ready_then_ask_v2',
        statement: correction,
        validFrom: lastTurn.at,
        evidenceTurnIds: [turnIdOf(story.turns.length)],
        supersedes: [base.itemId],
      }
      cursor = Number(insertLog.run('item', next.itemId, JSON.stringify([taskIds.A]), now).lastInsertRowid)
      insertItem.run(next.itemId, JSON.stringify(next), cursor)
      const old = { ...base, status: 'superseded', supersededBy: [next.itemId] }
      db.prepare('UPDATE cap_items SET json = ? WHERE item_id = ?').run(JSON.stringify(old), base.itemId)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  db.close()
  return { turns: seq, items: correction ? 2 : 1 }
}
