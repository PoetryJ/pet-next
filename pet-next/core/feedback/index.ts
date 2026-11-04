/**
 * 聊天反馈联动：纯策略入口。页面适配层只消费本模块的类型与归约函数。
 * @module pet-next/core/feedback
 */
export { FEEDBACK_HIDE_MS, initialFeedbackState, reduceFeedback } from './reduce.ts';
export type { FeedbackReduceOptions, FeedbackStep } from './reduce.ts';
export type { FeedbackEffect, FeedbackEvent, FeedbackPhase, FeedbackState } from './types.ts';
