import { Globe, MousePointer2, Puzzle, Settings, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';

/** Illustrations only: displaying the guide must never capture a tab or send a request. */
function ClickTarget({ children }: { children: ReactNode }) {
  return (
    <span className="ai-trial-click-target">
      {children}
      <MousePointer2 className="ai-trial-pointer" />
    </span>
  );
}

export function TrialGuide() {
  const { t } = useI18n();
  const steps = [
    {
      title: t('打开网页侧栏'),
      hint: t('回到要分类的网页，点击智栏图标。'),
      picture: (
        <>
          <div className="ai-trial-browser-bar">
            <span className="ai-trial-url">example.com</span>
            <Puzzle />
            <ClickTarget>
              <span className="zh-logo" />
            </ClickTarget>
          </div>
          <div className="ai-trial-page-lines">
            <Globe />
            <span />
            <span />
          </div>
        </>
      ),
    },
    {
      title: t('点击侧栏设置'),
      hint: t('找到侧栏右上角的齿轮图标。'),
      picture: (
        <>
          <div className="ai-trial-sidebar-bar">
            <span className="zh-logo" />
            <strong>{t('智栏')}</strong>
            <ClickTarget>
              <Settings />
            </ClickTarget>
          </div>
          <div className="ai-trial-sidebar-lines">
            <span />
            <span />
            <span />
          </div>
        </>
      ),
    },
    {
      title: t('选择试分类'),
      hint: t('在快速设置中点击这一项。'),
      picture: (
        <>
          <div className="ai-trial-mini-heading">
            <Settings />
            <strong>{t('快速设置')}</strong>
          </div>
          <ClickTarget>{t('试分类当前网页')}</ClickTarget>
        </>
      ),
    },
    {
      title: t('核对后发送'),
      hint: t('检查标题和网址，再点击发送。'),
      picture: (
        <>
          <div className="ai-trial-mini-heading">
            <Sparkles />
            <strong>{t('当前网页试分类')}</strong>
          </div>
          <div className="ai-trial-page-info">example.com</div>
          <ClickTarget>{t('发送并试分类')}</ClickTarget>
        </>
      ),
    },
  ];
  return (
    <>
      <div className="ai-trial-guide-heading">
        <h3>{t('在网页侧栏试一次')}</h3>
        <span>{t('操作示意 · 点击紫色标记处')}</span>
      </div>
      <ol className="ai-trial-guide" aria-label={t('试分类操作图解')}>
        {steps.map((step, index) => (
          <li key={index}>
            <div className={`ai-trial-illustration is-step-${index + 1}`} role="img" aria-label={step.hint}>
              <div aria-hidden="true">{step.picture}</div>
            </div>
            <div className="ai-trial-step-caption">
              <span className="ai-trial-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.hint}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="ai-trial-privacy">
        <ShieldCheck aria-hidden="true" />
        {t('遵循隐私设置；不读取正文，不会创建或移动书签。')}
      </p>
      <details className="ai-trial-help">
        <summary>{t('使用哪个模型？密钥需要记住吗？')}</summary>
        <p>{t('使用「智能收藏」分配的模型，遵循现有隐私设置，不读取正文。试分类只显示建议，不会创建或移动书签。')}</p>
        <p>{t('若密钥只保留在当前设置页，请先在服务设置中启用「记住密钥」，才能在侧栏或后台使用。')}</p>
      </details>
    </>
  );
}
