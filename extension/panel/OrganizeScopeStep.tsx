import type { TreeSnapshot } from '../domain/node-reference';
import type { OrganizeState } from '../domain/organize-state';
import { ORGANIZE_STYLES, ORGANIZE_INSTRUCTIONS_LIMIT, type OrganizeStyle } from '../domain/organize-preferences';
import type { OrganizeMemory } from '../persistence/organize-memory';
import type { OrganizeMemoryEditor } from './organize-workbench-view';
import { Select } from '../ui/Select';
import { useI18n } from '../ui/i18n';
import { organizeStatusText, organizePreviewText } from './organize-status-text';

type Props = {
  hidden: boolean;
  state: OrganizeState;
  modelAvailable: boolean;
  method: 'ai' | 'duplicates';
  setMethod: (value: 'ai' | 'duplicates') => void;
  style: OrganizeStyle;
  setStyle: (value: OrganizeStyle) => void;
  instructions: string;
  setInstructions: (value: string) => void;
  unfiledOnly: boolean;
  setUnfiledOnly: (value: boolean) => void;
  cleanupEmpty: boolean;
  setCleanupEmpty: (value: boolean) => void;
  allowRename: boolean;
  setAllowRename: (value: boolean) => void;
  batchSizeInput: string;
  setBatchSizeInput: (value: string) => void;
  batchSizeValid: boolean;
  preferenceReady: boolean;
  scopeProtected: boolean;
  memory: OrganizeMemory;
  memoryBusy: boolean;
  memoryError: string;
  changeMemory: OrganizeMemoryEditor;
  folders: TreeSnapshot['nodes'];
  scopedFolders: TreeSnapshot['nodes'];
  currentPaths: Map<string, string>;
  cancel: () => void;
  onScopeChange: (id: string) => void;
  onStart: () => void;
};
/** Controlled first step. Drafts and command ownership stay in the workbench. */
export function OrganizeScopeStep({
  hidden,
  state,
  modelAvailable,
  method,
  setMethod,
  style,
  setStyle,
  instructions,
  setInstructions,
  unfiledOnly,
  setUnfiledOnly,
  cleanupEmpty,
  setCleanupEmpty,
  allowRename,
  setAllowRename,
  batchSizeInput,
  setBatchSizeInput,
  batchSizeValid,
  preferenceReady,
  scopeProtected,
  memory,
  memoryBusy,
  memoryError,
  changeMemory,
  folders,
  scopedFolders,
  currentPaths,
  cancel,
  onScopeChange,
  onStart,
}: Props) {
  const { t, message, language } = useI18n();
  const statusText = (text: string) => organizeStatusText(language, text);
  return (
    <div hidden={hidden} className="workflow-stage">
      <h3>{t('想整理哪个目录？')}</h3>
      <label>
        {t('整理范围')}
        <Select
          aria-label={t('整理范围')}
          disabled={state.busy}
          value={state.scopeId}
          onChange={e => {
            onScopeChange(e.target.value);
          }}
        >
          <option value="">{t('请选择目录')}</option>
          {folders.map(n => (
            <option key={n.ref.nativeId} value={n.ref.nativeId}>
              {currentPaths.get(n.ref.nativeId) ?? n.title}
            </option>
          ))}
        </Select>
      </label>
      {state.tree.status === 'error' && <p role="alert">{statusText(state.tree.message)}</p>}
      {state.tree.status === 'loading' && <p role="status">{t('正在读取书签…')}</p>}
      <h3>{t('选择整理方式')}</h3>
      <div className="workflow-choices">
        <label className="workflow-choice">
          <input
            type="radio"
            name="organize-method"
            checked={method === 'ai'}
            disabled={state.busy || !modelAvailable}
            onChange={() => setMethod('ai')}
          />
          <span>
            <strong>{t('AI 整理目录')}</strong>
            <small>{t('根据内容建议分类、移动和合并；由你决定采用哪些。')}</small>
          </span>
        </label>
        <label className="workflow-choice">
          <input
            type="radio"
            name="organize-method"
            checked={method === 'duplicates'}
            disabled={state.busy}
            onChange={() => setMethod('duplicates')}
          />
          <span>
            <strong>{t('清理重复书签')}</strong>
            <small>{t('本地查找精确重复和疑似重复，逐条选择保留或删除。')}</small>
          </span>
        </label>
      </div>
      {method === 'ai' && (
        <label className="organize-option">
          <input
            type="checkbox"
            checked={unfiledOnly}
            disabled={state.busy || memoryBusy}
            onChange={e => {
              cancel();
              setUnfiledOnly(e.target.checked);
            }}
          />
          {t('只整理未分类的书签')}
        </label>
      )}
      {method === 'ai' && unfiledOnly && (
        <p className="hint">
          {t('只处理当前目录直接收藏的书签，沿用现有分类；子目录内容、目录名称和空目录保持不动。')}
        </p>
      )}
      {method === 'ai' && (
        <details className="workflow-help organize-advanced">
          <summary>{t('高级选项')}</summary>
          <div className="organize-preferences">
            <label>
              {t('分类方式')}
              <Select
                aria-label={t('分类方式')}
                value={style}
                disabled={state.busy}
                onChange={e => {
                  cancel();
                  setStyle(e.target.value as OrganizeStyle);
                }}
              >
                {ORGANIZE_STYLES.map(option => (
                  <option key={option.id} value={option.id}>
                    {t(option.label)}
                  </option>
                ))}
              </Select>
            </label>
            <p className="hint">{message(ORGANIZE_STYLES.find(option => option.id === style)?.hint ?? '')}</p>
            <label>
              {style === 'custom' ? t('你的分类要求（必填）') : t('补充要求（选填）')}
              <textarea
                aria-label={t('分类要求')}
                rows={3}
                maxLength={ORGANIZE_INSTRUCTIONS_LIMIT}
                value={instructions}
                disabled={state.busy}
                placeholder={t('例如：分成写作、画图、编程，目录用中文；拿不准的保持原位。')}
                onChange={e => {
                  cancel();
                  setInstructions(e.target.value);
                }}
              />
            </label>
            <p className="hint">
              {t('仅用于本次整理；要求会与所选范围的书签信息一起发送给 AI。{count}/{limit}', {
                count: instructions.length,
                limit: ORGANIZE_INSTRUCTIONS_LIMIT,
              })}
            </p>
          </div>
          <label>
            {t('每批最多书签')}
            <input
              aria-label={t('每批最多书签')}
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={batchSizeInput}
              aria-invalid={!batchSizeValid}
              aria-describedby={!batchSizeValid ? 'organize-batch-size-error' : undefined}
              disabled={state.busy || memoryBusy}
              onChange={e => {
                cancel();
                setBatchSizeInput(e.target.value);
              }}
            />
          </label>
          {!batchSizeValid && (
            <p id="organize-batch-size-error" role="alert">
              {t('请输入大于或等于 1 的有效整数。')}
            </p>
          )}
          <p className="hint">{t('默认每批最多 100 条，可自定义数量。同时按内容长度自动拆分，每批完成就能查看。')}</p>
          <label className="organize-option">
            <input
              type="checkbox"
              checked={cleanupEmpty && !unfiledOnly}
              disabled={state.busy || memoryBusy || unfiledOnly}
              onChange={e => {
                cancel();
                setCleanupEmpty(e.target.checked);
              }}
            />
            {t('建议清理原有空分类和迁移后变空的分类')}
          </label>
          <label className="organize-option">
            <input
              type="checkbox"
              checked={allowRename && !unfiledOnly}
              disabled={state.busy || memoryBusy || unfiledOnly}
              onChange={e => {
                cancel();
                setAllowRename(e.target.checked);
              }}
            />
            {t('允许建议重命名分类')}
          </label>
          <details className="workflow-help">
            <summary>{t('保护分类与已拒绝建议')}</summary>
            <p>{t('勾选的分类及其内容保持不动；保存在本机，后续整理继续遵守。')}</p>
            {scopedFolders.map(folder => (
              <label className="organize-option" key={folder.ref.nativeId}>
                <input
                  type="checkbox"
                  aria-label={t('保护 {title}', { title: folder.title })}
                  checked={memory.protectedFolderIds.includes(folder.ref.nativeId)}
                  disabled={state.busy || memoryBusy}
                  onChange={e => {
                    const checked = e.target.checked;
                    void changeMemory(
                      value => ({
                        ...value,
                        protectedFolderIds: checked
                          ? [...new Set([...value.protectedFolderIds, folder.ref.nativeId])]
                          : value.protectedFolderIds.filter(id => id !== folder.ref.nativeId),
                      }),
                      true,
                    );
                  }}
                />
                {currentPaths.get(folder.ref.nativeId)}
              </label>
            ))}
            <p>{t('已记住 {count} 条拒绝建议；普通取消勾选只影响本次。', { count: memory.rejected.length })}</p>
            {memory.rejected.map(record => (
              <div key={record.signature}>
                <span>{organizePreviewText(language, record.label)}</span>
                <button
                  disabled={state.busy || memoryBusy}
                  onClick={() =>
                    void changeMemory(value => ({
                      ...value,
                      rejected: value.rejected.filter(r => r.signature !== record.signature),
                    }))
                  }
                >
                  {t('恢复建议')}
                </button>
              </div>
            ))}
            {!!memory.rejected.length && (
              <button
                disabled={state.busy || memoryBusy}
                onClick={() => void changeMemory(value => ({ ...value, rejected: [] }))}
              >
                {t('清空拒绝记录')}
              </button>
            )}
          </details>
        </details>
      )}
      {memoryError && (
        <p role="alert">
          {message(memoryError)}
          <button disabled={memoryBusy} onClick={() => void changeMemory(value => value)}>
            {t('重试读取偏好')}
          </button>
        </p>
      )}
      {memoryBusy && !state.busy && <p role="status">{t('正在读取或保存整理偏好…')}</p>}
      {method === 'ai' && scopeProtected && (
        <p role="status">{t('该范围位于受保护分类中，请取消保护或选择其他范围。')}</p>
      )}
      {method === 'ai' && (
        <p className="hint">
          {state.task
            ? t('默认按主题整理。进度保存在本机，可关闭页面后重新打开查看；浏览器或后台中断后，需手动继续未完成批次。')
            : t('默认按主题整理。请保持本页面打开；切换页内栏目不影响生成，关闭或刷新页面会丢失本次进度。')}
        </p>
      )}
      <p className="hint">{t('这一步只生成建议，不会修改书签。')}</p>
      <div className="workflow-footer">
        <button
          className="primary"
          disabled={
            !state.scopeId ||
            state.busy ||
            (method === 'ai' && (memoryBusy || !!memoryError || scopeProtected)) ||
            state.tree.status !== 'ready' ||
            (method === 'ai' && (!modelAvailable || !preferenceReady || !batchSizeValid))
          }
          onClick={() => {
            onStart();
          }}
        >
          {method === 'ai' ? t('下一步：生成整理方案') : t('下一步：查找重复书签')}
        </button>
      </div>
    </div>
  );
}
