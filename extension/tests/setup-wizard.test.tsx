import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { recommendAssignments, recommendModels, SetupWizard } from '../options/ai-services/SetupWizard';
import { DEFAULT_FEATURES } from '../persistence/ai-services';
import type { ConnectedService } from '../options/ai-services';

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
  expect(screen.getByRole('checkbox', { name: /gpt-4\.1-mini/ })).toBeChecked();
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
