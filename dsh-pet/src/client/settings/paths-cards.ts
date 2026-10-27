/**
 * 两张「落盘位置」展示卡：高级配置（配置文件、表情包、日志路径）与卸载与存储（清单 + 卸载命令）。
 * 数据同源于 `GET /config/meta`，读不到时两张卡都整块不出现——缺路径提示比给错路径更安全。
 * 只读展示，没有可编辑控件，因此不需要 busy。
 * @module dsh-pet/src/client/settings/paths-cards
 */
import type { FunctionComponent } from 'react';
import type { ConfigMeta } from './config/index.ts';
import type { SettingsRuntime } from './runtime.ts';
import { MONO_STACK, makeUiKit } from './ui.ts';

/** 两张卡的共同输入。 */
export interface PathsCardProps {
  /** 宿主给出的路径与存储清单。 */
  paths: ConfigMeta;
}

/** 一对落盘位置卡。 */
export interface PathsCards {
  /** 高级配置：默认配置、用户配置、动画目录、表情包目录与日志文件路径。 */
  ConfigMetaCard: FunctionComponent<PathsCardProps>;
  /** 卸载与存储：插件落盘的全部位置 + 卸载步骤与命令。 */
  StorageCard: FunctionComponent<PathsCardProps>;
}

/**
 * 造两张落盘位置卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 两个卡片组件。
 */
export function makePathsCards(rt: SettingsRuntime): PathsCards {
  const { h, t } = rt;
  const { cardHead } = makeUiKit({ h, t });

  function ConfigMetaCard(props: PathsCardProps) {
    const { paths } = props;
    const line = (key: string, value: string | undefined, suffix = '') =>
      value === undefined
        ? null
        : h('div', { key, className: 'dsh-pet-cfg__path', children: t(key) + '：' + value + suffix });
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('configMeta'), t('configMetaHint')),
        line('defaultConfig', paths.default),
        line('userConfig', paths.user),
        line('animationDir', paths.animations),
        line('memesDir', paths.memes),
        // 日志文件路径 + 一句说明；其余位置的用途都在问号里，唯独这条写在明面上——反馈问题时要先找它。
        line('logFile', paths.logs),
        paths.logs ? h('div', { className: 'dsh-pet-cfg__note', children: t('logFileNote') }) : null,
      ],
    });
  }

  function StorageCard(props: PathsCardProps) {
    const { paths } = props;
    const storage = paths.storage ?? [];
    if (storage.length === 0) return null;
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('storageTitle'), t('storageHint')),
        // 存储位置清单：每条都是「路径（等宽、可选中复制）到作用」。
        ...storage.map((entry) =>
          h('div', {
            key: entry.key,
            className: 'dsh-pet-cfg__path',
            children: [
              h('b', { key: 'p', style: { fontFamily: MONO_STACK }, children: entry.path }),
              // 尚未产生的目录标一下，避免用户去找不存在的文件夹。
              h('span', {
                key: 'd',
                children: ' — ' + t('storage.' + entry.key) + (entry.exists === false ? t('storageMissing') : ''),
              }),
            ],
          }),
        ),
        h('div', {
          key: 'ut',
          className: 'dsh-pet-cfg__cardTitle',
          style: { marginTop: '4px' },
          children: t('uninstallTitle'),
        }),
        h('div', { key: 'u1', className: 'dsh-pet-cfg__note', children: t('uninstallStep1') }),
        h('div', { key: 'u2', className: 'dsh-pet-cfg__note', children: t('uninstallStep2') }),
        h('div', {
          key: 'cmd',
          className: 'dsh-pet-cfg__cmd',
          children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
        }),
        h('div', { key: 'u3', className: 'dsh-pet-cfg__note', children: t('uninstallStep3') }),
      ],
    });
  }

  return { ConfigMetaCard, StorageCard };
}
