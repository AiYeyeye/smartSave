import { translate, translateKnown, type Language } from '../ui/i18n';
import { modelFailureText } from './model-failure-text';

export type ModelSettingsNotice =
  string | { kind: 'listed'; count: number } | { kind: 'list-failed' | 'test-failed'; reason: string };

export function modelSettingsNoticeText(language: Language, notice: ModelSettingsNotice): string {
  if (typeof notice === 'string') return translateKnown(language, notice);
  if (notice.kind === 'listed')
    return translate(language, '已授权并获取 {count} 个模型；尚未证明任务能力。', { count: notice.count });
  return translate(
    language,
    notice.kind === 'list-failed'
      ? '未能获取模型列表：{reason}。可手填模型 ID；401检查密钥；403检查服务鉴权/Origin；429稍后重试；permission重新授权；list-unsupported 请手填。'
      : '模型请求未完成：{reason}。可展开 Debug 日志查看调用与返回。',
    { reason: modelFailureText(language, notice.reason) },
  );
}
