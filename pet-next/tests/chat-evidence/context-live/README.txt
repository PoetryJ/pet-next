context-live/ —— M3-4 起聊天 E2E 的原始请求 NDJSON 持久证据
=====================================================
来源：tests/chat-context.e2e.test.ts（含 Windows 独立驱动同款约定）。
每次用例结束、清理临时 userData 之前，fake 模型服务记录的完整请求体
（FAKE_MODEL_LOG NDJSON：{event, at, bytes, body}）复制到本目录：

  ctx-on/requests.ndjson   T1（PET_NEXT_CHAT_CONTEXT=1）真实窗口两轮 + 新对话后第三轮
  ctx-off/requests.ndjson  T2（缺省关闭）两轮
  meta.txt                 标签/开关/时间/原始临时路径

NDJSON 每行一个 POST /v1/chat/completions 的完整 body（含 messages 结构），
是历史注入/清空语义的最原始证据；不清空、不脱敏（fake 场景无真实数据）。
Windows 复跑：node scripts/win-context-recheck.mjs（生成/运行 Windows 独立驱动）。
