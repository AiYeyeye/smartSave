import { useEffect, useState } from 'react';
import {
  emptyTokenLedger,
  tokenUsageView,
  watchTokenUsage,
  TOKEN_RECENT_LIMIT,
  type TokenUsageLedger,
} from '../persistence/token-usage';
import type { TokenPurpose, UsageSummary } from '../domain/token-usage';
import { useI18n, type MessageKey } from '../ui/i18n';
import './token-usage.css';

const PURPOSES: Record<TokenPurpose, MessageKey> = {
  'preference-summary': 'AI 总结偏好',
  rename: 'AI 书签改名',
  save: '智能收藏',
  search: '语义搜索',
  'search-expand': '搜索扩展',
  'history-query': '历史查询理解',
  'history-rank': '历史结果排序',
  organize: 'AI 整理',
  'import-map': '导入映射',
  'import-classify': '导入分类',
  'connection-test': '连接测试',
};
type Period = 'today' | '7' | '30' | 'all';
const PERIODS: [Period, MessageKey][] = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '累计'],
];

export function TokenUsage({ visible = true }: { visible?: boolean }) {
  const { t, language } = useI18n();
  const [ledger, setLedger] = useState<TokenUsageLedger>();
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  useEffect(() => {
    if (!visible) return;
    return watchTokenUsage(
      next => {
        setLedger(next);
        setError(false);
      },
      () => setError(true),
    );
  }, [visible]);
  const data = tokenUsageView(ledger ?? emptyTokenLedger(), period);
  const number = (value: number | undefined) => (value === undefined ? t('未提供') : value.toLocaleString(language));
  const metric = (summary: UsageSummary, key: 'input' | 'output' | 'total') =>
    number(summary.requests === 0 || summary[`${key}Known`] > 0 ? summary[key] : undefined);
  const date = (at: number) =>
    new Date(at).toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const summary = data.summary;
  return (
    <section className="token-usage" aria-label={t('Token 统计')}>
      <div className="token-toolbar">
        <div className="token-period" role="group" aria-label={t('统计范围')}>
          {PERIODS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id)}>
              {t(label)}
            </button>
          ))}
        </div>
        {ledger && ledger.since > 0 && (
          <small title={t('记录起始时间')}>{new Date(ledger.since).toLocaleDateString(language)}</small>
        )}
      </div>
      {error && <p role="alert">{t('无法读取 Token 统计')}</p>}
      {ledger && (
        <>
          <dl className="token-totals surface">
            {(
              [
                ['total', '总Token'],
                ['input', '输入Token'],
                ['output', '输出Token'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <dt>{t(label)}</dt>
                <dd>{metric(summary, key)}</dd>
              </div>
            ))}
            <div>
              <dt>{t('请求次数')}</dt>
              <dd>{number(summary.requests)}</dd>
            </div>
          </dl>
          <p className="hint token-note">
            {summary.missing > 0 && <span>{t('{count} 次未提供用量', { count: summary.missing })}</span>}
            {summary.partial > 0 && <span>{t('{count} 次用量不完整', { count: summary.partial })}</span>}
          </p>
          {summary.requests === 0 ? (
            <div className="surface token-empty">
              <h2>{t('暂无调用记录')}</h2>
            </div>
          ) : (
            <>
              <section className="surface token-section" aria-label={t('按模型')}>
                <h2>{t('按模型')}</h2>
                <div className="token-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('模型')}</th>
                        <th>{t('请求次数')}</th>
                        <th>{t('输入Token')}</th>
                        <th>{t('输出Token')}</th>
                        <th>{t('总Token')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.models.map(model => (
                        <tr key={JSON.stringify([model.adapter, model.model])}>
                          <th scope="row">
                            <span>{model.model}</span>
                            <small>{model.adapter}</small>
                          </th>
                          <td data-label={t('请求次数')}>{number(model.summary.requests)}</td>
                          <td data-label={t('输入Token')}>{metric(model.summary, 'input')}</td>
                          <td data-label={t('输出Token')}>{metric(model.summary, 'output')}</td>
                          <td data-label={t('总Token')}>{metric(model.summary, 'total')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="surface token-section" aria-label={t('按用途')}>
                <h2>{t('按用途')}</h2>
                <ul className="token-purpose-list">
                  {data.purposes.map(([purpose, counts]) => (
                    <li key={purpose}>
                      <span>
                        {t(PURPOSES[purpose])}
                        <small>
                          {t('请求次数')} · {number(counts.requests)}
                        </small>
                      </span>
                      <strong>{metric(counts, 'total')}</strong>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="surface token-section" aria-label={t('最近请求')}>
                <h2>
                  {t('最近请求')}
                  <small>{t('最近 {count} 次请求', { count: TOKEN_RECENT_LIMIT })}</small>
                </h2>
                <ul className="token-recent-list">
                  {data.recent.map(record => (
                    <li key={record.id}>
                      <div>
                        <strong>{record.model}</strong>
                        <small>
                          {t(PURPOSES[record.purpose])} · {date(record.at)}
                        </small>
                      </div>
                      <div>
                        <strong>{number(record.counts.total)}</strong>
                        <small>
                          {Object.keys(record.counts).length === 0
                            ? t('未提供')
                            : !record.complete || Object.keys(record.counts).length < 3
                              ? t('部分用量')
                              : `${number(record.counts.input)} / ${number(record.counts.output)}`}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}
