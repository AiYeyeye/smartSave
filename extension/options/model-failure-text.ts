import { translate, type Language, type MessageKey } from '../ui/i18n';

const reasons: Record<string, MessageKey> = {
  'json-mode-input-required':
    '模型服务未识别输入消息中的 JSON 输出要求，已拒绝请求。请更新并重新加载扩展后测试连接；若仍失败，请向服务商反馈 JSON 模式兼容问题。',
  refused:
    '模型服务拒绝回答或触发内容审核。请先用合成数据测试连接，再检查本次发送的标题、网址和分类要求；切换接口模式不能解决内容拦截。',
  'http-400': '模型服务未接受请求。请核对接口模式、基础地址、模型 ID 和支持的输出额度；具体原因见 Debug 日志。',
  'http-422': '模型服务未接受请求。请核对接口模式、基础地址、模型 ID 和支持的输出额度；具体原因见 Debug 日志。',
};

/** Translate owned error codes only, without exposing remote error bodies in the UI. */
export function modelFailureText(language: Language, reason: string): string {
  const key = Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
  return key ? translate(language, key) : reason;
}
