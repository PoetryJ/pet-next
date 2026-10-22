/**
 * 三个 mock 余额服务商：分别产出 windows / money / points 三种气泡。
 * 只验证展示层与第三方注册入口，不发任何网络请求。
 * @module dsh-cordis-probe/mock-balance
 */

/** 相对当前时间的时间戳（ISO）：保证气泡里的「N 小时/天重置」每次都是未来时间。 */
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

/** 三窗口用量：滚动 31% / 周 8% / 月 72%，最紧迫的是月窗口。 */
export const mockWindows = {
  id: 'mock-windows',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'windows',
      data: {
        rolling: 31,
        weekly: 8,
        monthly: 72,
        rollingCapUsd: 12,
        weeklyCapUsd: 30,
        monthlyCapUsd: 60,
        rollingLabel: '5h',
        rollingResetsAt: inHours(3),
        weeklyResetsAt: inHours(50),
        monthlyResetsAt: inHours(300),
      },
    };
  },
};

/** 双币种余额 + 峰谷装饰：CNY 有余、USD 少量。 */
export const mockMoney = {
  id: 'mock-money',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'money',
      data: {
        wallets: [
          { currency: 'CNY', total: '8.79', granted: '1.00', toppedUp: '7.79', fullBalance: '20' },
          { currency: 'USD', total: '2.40', granted: '0.00', toppedUp: '2.40', fullBalance: '5' },
        ],
        tier: 'peak',
      },
    };
  },
};

/** 积分余额：800 / 1000（基准由数据带出，驱动档位）。 */
export const mockPoints = {
  id: 'mock-points',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'points',
      data: { unit: '积分', total: '800', full: '1000' },
    };
  },
};

/** 注册顺序即 id 顺序；三种形态各一个。 */
export const MOCK_BALANCE_PROVIDERS = [mockWindows, mockMoney, mockPoints];
