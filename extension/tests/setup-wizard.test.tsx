import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { recommendAssignments, recommendModels, SetupWizard } from '../options/ai-services/SetupWizard';
import { DEFAULT_FEATURES } from '../persistence/ai-services';
import type { ConnectedService } from '../options/ai-services';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider } from '../ui/i18n';

const ids = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'text-embedding-3-small', 'tts-1'];
const service: ConnectedService = {
  id: 'c1',
  name: 'OpenAI',
  serviceType: 'OpenAI',
  kind: 'api',
  detail: '',
  baseUrl: 'https://api.openai.com/v1',
  mode: 'openai',
  status: 'ok',
  letter: 'O',
  avatarClass: 'c-openai',
  catalog: ids.map(id => ({ id, ctx: '' })),
  enabled: [],
};

it('English onboarding retains model input and existing assignments across language changes and a failed save', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const saved = vi.fn(async () => {});
  const assigned = vi.fn().mockRejectedValueOnce(Error('quota')).mockResolvedValue(undefined);
  const features = DEFAULT_FEATURES.map(feature =>
    feature.id === 'search' ? { ...feature, connId: 'existing', modelId: 'existing-model' } : feature,
  );
  render(
    <LocaleProvider>
      <LanguagePicker />
      <SetupWizard
        service={{ ...service, name: '已连接' }}
        services={[service]}
        features={features}
        onboarding
        onSaveModels={saved}
        onAssign={assigned}
        onClose={vi.fn()}
      />
    </LocaleProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Set up 已连接' })).toBeVisible();
  const model = screen.getByLabelText('Model to use');
  fireEvent.change(model, { target: { value: 'my-custom-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('your saved service is retained');
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('使用哪个模型')).toBe(model);
  expect(model).toHaveValue('my-custom-model');
  expect(screen.getByRole('alert')).toHaveTextContent('已保存的服务会保留');
  fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
  await screen.findByRole('heading', { name: '在网页侧栏试一次' });
  expect(assigned.mock.calls[1]![0]).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ featureId: 'search' })]),
  );
  expect(assigned.mock.calls[1]![0]).toHaveLength(4);
  expect(saved.mock.calls).toHaveLength(2);
  const guide = screen.getByRole('list', { name: '试分类操作图解' });
  expect(within(guide).getAllByRole('img')).toHaveLength(4);
  expect(within(guide).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('list', { name: 'Illustrated page-trial steps' })).toBe(guide);
  expect(within(guide).getByText('Open sidebar settings')).toBeVisible();
  expect(saved.mock.calls).toHaveLength(2);
  expect(assigned.mock.calls).toHaveLength(2);
});

it('recommends a fast model for per-bookmark work and a stronger one for whole-tree work, never embeddings', () => {
  expect(recommendModels(ids)).toMatchObject({ fast: 'gpt-4.1-mini', strong: 'gpt-4.1' });
  expect(recommendModels(ids).picked).not.toContain('text-embedding-3-small');
  const features = DEFAULT_FEATURES.map(f => (f.id === 'search' ? { ...f, connId: 'other', modelId: 'x' } : f));
  expect(recommendAssignments(features, 'c1', ['gpt-4.1', 'gpt-4.1-mini'])).toEqual({
    import: 'gpt-4.1',
    save: 'gpt-4.1-mini',
    search: '__keep__',
    organize: 'gpt-4.1',
    classify: 'gpt-4.1-mini',
  });
});

it('walks connect → models → features, saving both and keeping assignments on other connections', async () => {
  const onSaveModels = vi.fn(async () => {});
  const onAssign = vi.fn<(changes: { featureId: string; connId: string; modelId: string }[]) => Promise<void>>(
    async () => {},
  );
  const onClose = vi.fn();
  const features = DEFAULT_FEATURES.map(f => (f.id === 'search' ? { ...f, connId: 'other', modelId: 'x' } : f));
  const user = userEvent.setup();
  render(
    <SetupWizard
      service={service}
      services={[service]}
      features={features}
      onSaveModels={onSaveModels}
      onAssign={onAssign}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('checkbox', { name: /gpt-4\.1-mini/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /gpt-4\.1-mini/ }));
  await user.click(screen.getByRole('checkbox', { name: /^gpt-4\.1(?!-)/ }));
  await user.click(screen.getByRole('button', { name: '下一步' }));
  expect(onSaveModels).toHaveBeenCalledWith(expect.arrayContaining(['gpt-4.1', 'gpt-4.1-mini']), service.catalog);
  await waitFor(() => expect(screen.getByLabelText('智能收藏使用的模型')).toHaveValue('gpt-4.1-mini'));
  await user.selectOptions(screen.getByLabelText('页面分类使用的模型'), '__none__');
  await user.click(screen.getByRole('button', { name: '完成' }));
  const changes = onAssign.mock.calls[0]![0];
  expect(changes.find(c => c.featureId === 'save')).toEqual({
    featureId: 'save',
    connId: 'c1',
    modelId: 'gpt-4.1-mini',
  });
  expect(changes.find(c => c.featureId === 'search')).toBeUndefined();
  expect(changes.find(c => c.featureId === 'classify')).toEqual({ featureId: 'classify', connId: '', modelId: '' });
  expect(onClose).toHaveBeenCalledWith(expect.stringContaining('gpt-4.1-mini'));
});

it('can be skipped at the first step without assigning anything', async () => {
  const onAssign = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <SetupWizard
      service={service}
      services={[service]}
      features={DEFAULT_FEATURES}
      onSaveModels={vi.fn(async () => {})}
      onAssign={onAssign}
      onClose={onClose}
    />,
  );
  await user.click(screen.getByRole('button', { name: '跳过，稍后配置' }));
  expect(onClose).toHaveBeenCalledWith();
  expect(onAssign).not.toHaveBeenCalled();
});

it('does not recommend non-chat models when they are the entire catalog', () => {
  expect(recommendModels(['text-embedding-3-small', 'tts-1']).picked).toEqual([]);
  expect(Object.values(recommendAssignments(DEFAULT_FEATURES, 'c1', ['tts-1']))).toEqual(
    DEFAULT_FEATURES.map(() => '__none__'),
  );
});

it('onboards with one model, preserves existing assignments and provides an explicit webpage trial handoff', async () => {
  const onAssign = vi.fn(async () => {});
  const onSaveModels = vi.fn(async () => {});
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <SetupWizard
      onboarding
      service={service}
      services={[service]}
      features={DEFAULT_FEATURES.map(f => (f.id === 'search' ? { ...f, connId: 'c1', modelId: 'existing' } : f))}
      onSaveModels={onSaveModels}
      onAssign={onAssign}
      onClose={onClose}
    />,
  );
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getAllByRole('radio')).toHaveLength(ids.length);
  expect(screen.getByRole('button', { name: '保存并继续' })).toBeDisabled();
  expect(screen.getAllByRole('radio').every(radio => !(radio as HTMLInputElement).checked)).toBe(true);
  expect(screen.getByRole('radio', { name: /text-embedding/ })).toBeDisabled();
  await user.clear(screen.getByLabelText('使用哪个模型'));
  await user.type(screen.getByLabelText('使用哪个模型'), 'my-existing-model');
  await user.click(screen.getByRole('button', { name: '保存并继续' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '在网页侧栏试一次' })).toBeVisible());
  expect(onSaveModels).toHaveBeenCalledWith(
    ['my-existing-model'],
    expect.arrayContaining([{ id: 'my-existing-model', ctx: '自定义' }]),
  );
  expect(onAssign).toHaveBeenCalledWith(
    DEFAULT_FEATURES.filter(f => f.id !== 'search').map(f => ({
      featureId: f.id,
      connId: 'c1',
      modelId: 'my-existing-model',
    })),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('list', { name: '试分类操作图解' })).toBeVisible();
  expect(screen.getByText('遵循隐私设置；不读取正文，不会创建或移动书签。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '完成，稍后试分类' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps onboarding at the editable step after persistence failure and allows retry', async () => {
  const onAssign = vi.fn(async () => {});
  const onSaveModels = vi.fn().mockRejectedValueOnce(Error('storage')).mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(
    <SetupWizard
      onboarding
      service={service}
      services={[service]}
      features={DEFAULT_FEATURES}
      onSaveModels={onSaveModels}
      onAssign={onAssign}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('radio', { name: 'gpt-4o' }));
  await user.click(screen.getByRole('button', { name: '保存并继续' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('配置尚未完成'));
  expect(onAssign).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保存并继续' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '在网页侧栏试一次' })).toBeVisible());
  expect(onAssign).toHaveBeenCalledOnce();
  expect(onSaveModels).toHaveBeenLastCalledWith(['gpt-4o'], service.catalog);
});
