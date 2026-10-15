export const ORGANIZE_STYLES = [
  { id: 'topic', label: '按主题（推荐）', hint: '例如：设计、编程、学习、生活。' },
  { id: 'type', label: '按内容类型', hint: '例如：工具网站、文章、教程、视频、资料。' },
  { id: 'purpose', label: '按功能用途', hint: '例如：写作、画图、编程、效率办公。' },
  { id: 'existing', label: '沿用现有目录', hint: '优先归入已有分类，尽量少建目录。' },
  { id: 'custom', label: '自定义分类', hint: '描述你想要的分类和目录名称。' },
] as const;
export type OrganizeStyle = (typeof ORGANIZE_STYLES)[number]['id'];
export interface OrganizePreference {
  style: OrganizeStyle;
  instructions: string;
}
export const ORGANIZE_INSTRUCTIONS_LIMIT = 1000;
export function organizePreference(value: OrganizePreference): OrganizePreference {
  if (
    !ORGANIZE_STYLES.some(s => s.id === value.style) ||
    typeof value.instructions !== 'string' ||
    value.instructions.length > ORGANIZE_INSTRUCTIONS_LIMIT
  )
    throw Error('invalid-organize-preference');
  const instructions = value.instructions.trim();
  if (value.style === 'custom' && !instructions) throw Error('missing-organize-instructions');
  return { style: value.style, instructions };
}
