import { useI18n } from '../ui/i18n';
import './onboarding.css';

/** Instructions link to real actions; viewing the guide never captures or sends a webpage. */
export function OnboardingSteps({
  onConfigure,
  onSearch,
  onOrganize,
  onDismiss,
}: {
  onConfigure: () => void;
  onSearch: () => void;
  onOrganize: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="surface onboarding-steps" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title">{t('开始使用智栏')}</h2>
      <p className="hint">{t('已有书签就在下方。不配置 AI，也能浏览和搜索。')}</p>
      <ol aria-label={t('新手操作步骤')}>
        <li>
          <h3>{t('连接你已有的 AI 服务')}</h3>
          <p>{t('添加服务并选择模型，之后就能使用自动归类和 AI 搜索。也可以稍后设置。')}</p>
          <button type="button" onClick={onConfigure}>
            {t('配置 AI')}
          </button>
        </li>
        <li>
          <h3>{t('照常收藏网页')}</h3>
          <p>{t('点击浏览器地址栏的星标收藏。配置 AI 后会自动归类，名称和目录可在独立窗口中确认。')}</p>
        </li>
        <li>
          <h3>{t('找到需要的书签')}</h3>
          <p>{t('在顶部搜索框输入名称或用途，先看本地结果；需要时点击“AI 帮我找”。')}</p>
          <button type="button" onClick={onSearch}>
            {t('去搜索')}
          </button>
        </li>
        <li>
          <h3>{t('整理已有书签')}</h3>
          <p>{t('从底部打开“整理”，选择范围并查看方案，确认后才会修改书签。')}</p>
          <button type="button" onClick={onOrganize}>
            {t('打开整理')}
          </button>
        </li>
      </ol>
      <button type="button" className="primary" onClick={onDismiss}>
        {t('知道了，开始使用')}
      </button>
      <p className="hint">{t('以后可在侧栏设置中重新查看这些步骤。')}</p>
    </section>
  );
}
