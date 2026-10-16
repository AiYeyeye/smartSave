import { LocaleProvider, useI18n } from '../ui/i18n';
import { StateMessage } from '../ui/StateMessage';
import { DeferredNotice } from '../ui/DeferredNotice';

function Status({ failed }: { failed: boolean }) {
  const { t } = useI18n();
  if (!failed)
    return (
      <DeferredNotice show>
        <StateMessage kind="loading" title={t('正在连接智栏…')} />
      </DeferredNotice>
    );
  return (
    <StateMessage kind="error" title={t('侧栏启动验证未通过')}>
      <p>{t('书签尚未连接。请关闭此侧栏，再点击扩展图标重新打开；若刚更新了扩展，请先刷新当前网页。')}</p>
      <button onClick={() => window.parent.postMessage({ type: 'zhilan-overlay-close' }, '*')}>{t('关闭侧栏')}</button>
    </StateMessage>
  );
}

/** Display-only boot UI. The real App still mounts only after the existing overlay claim succeeds. */
export function OverlayStatus({ failed = false }: { failed?: boolean }) {
  return (
    <LocaleProvider>
      <Status failed={failed} />
    </LocaleProvider>
  );
}
