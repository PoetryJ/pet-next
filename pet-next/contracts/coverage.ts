/**
 * 本轮契约测试和平台实测要点名的用例。这里没有测试实现。
 * @module pet-next/contracts/coverage
 */

/** `tests/contracts/` 要覆盖的名字。用假时钟和受控 Promise，不用固定 sleep。 */
export const REQUIRED_CONTRACT_CASES = [
  'late-loaded',
  'late-ended',
  'duplicate-request',
  'consecutive-clicks',
  'load-failure',
  'callback-after-dispose',
  'preheat-races-click',
  'drag-blocks-auto',
  'expired-action',
  'bounded-history',
] as const;

export type RequiredContractCase = (typeof REQUIRED_CONTRACT_CASES)[number];

/** `tests/platform/` 要覆盖的桌宠流程。系统缩放和 Chromium 强制缩放仍用 `REQUIRED_SCALE_CASES` 分开记。 */
export const REQUIRED_PLATFORM_FLOWS = ['click', 'drag', 'transparent', 'quit', 'process-cleanup'] as const;

export type RequiredPlatformFlow = (typeof REQUIRED_PLATFORM_FLOWS)[number];
