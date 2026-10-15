import {
  Archive,
  FolderTree,
  Palette,
  ScrollText,
  Shield,
  Sparkles,
  Upload,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { ModeSwitch } from './ThemeProvider';
import { useI18n } from './i18n';

export type OptionsRoute =
  'browse' | 'organize' | 'import' | 'export' | 'ai-services' | 'appearance' | 'privacy' | 'debug';

export const ROUTE_META: Record<OptionsRoute, { title: string; desc: string; icon: LucideIcon; wide?: boolean }> = {
  browse: { title: '书签目录', desc: '浏览、搜索与批量管理浏览器原生书签。', icon: FolderTree },
  organize: { title: 'AI 整理', desc: '在选定目录内整理与精确去重；先预览，确认后才写入。', icon: WandSparkles },
  import: { title: '导入书签', desc: '支持 HTML / JSON / CSV / TXT / Markdown，导入后按设置自动分类。', icon: Upload },
  export: { title: '导出与备份', desc: '手动导出、自动输出到本地文件，以及撤销与恢复记录。', icon: Archive },
  'ai-services': {
    title: 'AI 服务',
    desc: '连接模型服务，并为收藏、导入、搜索、整理分别指定模型。',
    icon: Sparkles,
    wide: true,
  },
  appearance: { title: '外观', desc: '颜色模式与主题色，弹窗和设置页同步。', icon: Palette },
  privacy: { title: '隐私与规则', desc: '控制发送给 AI 的内容、排除目录与网站规则。', icon: Shield },
  debug: { title: '收藏记录与调试', desc: '每次原生收藏的 AI 处理结果，以及可选的调用轨迹。', icon: ScrollText },
};

const GROUPS: { label: string; routes: OptionsRoute[] }[] = [
  { label: '书签', routes: ['browse', 'organize', 'import', 'export'] },
  { label: 'AI', routes: ['ai-services'] },
  { label: '偏好', routes: ['appearance', 'privacy', 'debug'] },
];

const ROUTES = new Set<string>(Object.keys(ROUTE_META));

/** `#organize`, `#ai-services/add` … → route. Unknown or empty hashes land on the bookmark directory. */
export function parseOptionsHash(hash: string): OptionsRoute {
  const raw = hash.replace(/^#/, '');
  if (raw.startsWith('ai-services')) return 'ai-services';
  if (raw === 'settings' || raw === 'overview') return 'ai-services';
  if (raw === 'export-backup') return 'export';
  if (raw === 'model') return 'debug';
  return ROUTES.has(raw) ? (raw as OptionsRoute) : 'browse';
}

export function OptionsNav({
  route,
  onRoute,
  attention,
}: {
  route: OptionsRoute;
  onRoute: (route: OptionsRoute) => void;
  /** Short badge per route, e.g. AI 服务 → 未配置. */
  attention?: Partial<Record<OptionsRoute, string>>;
}) {
  const { t, message } = useI18n();
  return (
    <nav className="side-nav" aria-label={t('设置导航')}>
      <div className="side-brand">
        <span className="zh-logo" aria-hidden="true" />
        <div>
          <strong>{t('智栏')}</strong>
          <small>{t('原生书签 · AI 助手')}</small>
        </div>
      </div>
      {GROUPS.map(group => (
        <div key={group.label} role="group" aria-label={message(group.label)}>
          <div className="side-group" aria-hidden="true">
            {message(group.label)}
          </div>
          {group.routes.map(id => {
            const meta = ROUTE_META[id];
            const Icon = meta.icon;
            return (
              <button
                key={id}
                type="button"
                className="side-item"
                aria-current={route === id ? 'page' : undefined}
                onClick={() => onRoute(id)}
              >
                <Icon aria-hidden="true" />
                {message(meta.title)}
                {attention?.[id] ? <span className="side-badge">{attention[id]}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
      <div className="side-foot">
        <ModeSwitch compact />
      </div>
    </nav>
  );
}
