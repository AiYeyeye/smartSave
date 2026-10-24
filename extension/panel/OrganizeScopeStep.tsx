import type { TreeSnapshot } from '../domain/node-reference';
import type { OrganizeState } from '../domain/organize-state';
import {
  ORGANIZE_STYLES,
  ORGANIZE_SUB_STYLES,
  ORGANIZE_INSTRUCTIONS_LIMIT,
  type OrganizeStyle,
  type OrganizeSubStyle,
} from '../domain/organize-preferences';
import type { OrganizeLevels } from '../domain/classification-policy';
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
  levels: OrganizeLevels;
  setLevels: (value: OrganizeLevels) => void;
  subStyle: OrganizeSubStyle | '';
  setSubStyle: (value: OrganizeSubStyle | '') => void;
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
  levels,
  setLevels,
  subStyle,
  setSubStyle,
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
            <label>
              {t('最少层级')}
              <Select
                aria-label={t('最少层级')}
                value={String(levels)}
                disabled={state.busy}
                onChange={e => {
                  cancel();
                  setLevels(Number(e.target.value) as OrganizeLevels);
                }}
              >
                <option value="1">{t('不限，由 AI 决定')}</option>
                <option value="2">{t('至少两级：大类 / 小类（推荐）')}</option>
                <option value="3">{t('至少三级')}</option>
              </Select>
            </label>
            {levels > 1 && !['custom', 'existing', 'numbered'].includes(style) && (
              <label>
                {t('小类按')}
                <Select
                  aria-label={t('小类按')}
                  value={subStyle}
                  disabled={state.busy}
                  onChange={e => {
                    cancel();
                    setSubStyle(e.target.value as OrganizeSubStyle | '');
                  }}
                >
                  <option value="">{t('与大类相同')}</option>
                  {ORGANIZE_STYLES.filter(option => (ORGANIZE_SUB_STYLES as readonly string[]).includes(option.id)).map(
                    option => (
                      <option key={option.id} value={option.id}>
                        {t(option.label)}
                      </option>
                    ),
                  )}
                </Select>
              </label>
            )}
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
              {t('{count}/{limit}', {
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
            <p>{t('已记住 {count} 条“不再建议”', { count: memory.rejected.length })}</p>
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
