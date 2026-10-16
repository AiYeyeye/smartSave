/** Built-in classification schemes (information architecture, PARA, LATCH, Johnny.Decimal). Topic is the default. */
export const ORGANIZE_STYLES = [
  { id: 'topic', label: '按主题（推荐）', hint: '例如：设计、编程、学习、生活。' },
  { id: 'type', label: '按内容类型', hint: '例如：工具网站、文章、教程、视频、资料。' },
  { id: 'purpose', label: '按功能用途', hint: '例如：写作、画图、编程、效率办公。' },
  { id: 'project', label: '按项目与状态（PARA）', hint: '分为进行中的项目、长期关注的领域、参考资料和归档。' },
  { id: 'source', label: '按来源网站', hint: '按网站或平台归类，例如 GitHub、B 站、知乎。' },
  { id: 'audience', label: '按使用对象', hint: '按给谁用归类，例如自己、家人、工作团队、客户。' },
  { id: 'numbered', label: '编号目录（Johnny.Decimal）', hint: '大类和小类带编号，例如 10 学习、11 编程。' },
  { id: 'existing', label: '沿用现有目录', hint: '优先归入已有分类，尽量少建目录。' },
  { id: 'custom', label: '自定义分类', hint: '描述你想要的分类和目录名称。' },
] as const;
export type OrganizeStyle = (typeof ORGANIZE_STYLES)[number]['id'];
export const ORGANIZE_STYLE_IDS = ORGANIZE_STYLES.map(style => style.id) as [OrganizeStyle, ...OrganizeStyle[]];
/** Schemes a second level can use on its own (a facet under the broad categories). */
export const ORGANIZE_SUB_STYLES = ['topic', 'type', 'purpose', 'source', 'audience'] as const;
export type OrganizeSubStyle = (typeof ORGANIZE_SUB_STYLES)[number];
export interface OrganizePreference {
  style: OrganizeStyle;
  instructions: string;
  /** Subfolders under each broad category follow this scheme instead of `style`. */
  subStyle?: OrganizeSubStyle;
}
export const ORGANIZE_INSTRUCTIONS_LIMIT = 1000;
export function organizePreference(value: OrganizePreference): OrganizePreference {
  if (
    !ORGANIZE_STYLES.some(s => s.id === value.style) ||
    typeof value.instructions !== 'string' ||
    value.instructions.length > ORGANIZE_INSTRUCTIONS_LIMIT ||
    (value.subStyle !== undefined && !ORGANIZE_SUB_STYLES.includes(value.subStyle))
  )
    throw Error('invalid-organize-preference');
  const instructions = value.instructions.trim();
  if (value.style === 'custom' && !instructions) throw Error('missing-organize-instructions');
  const subStyle = value.subStyle && value.subStyle !== value.style ? value.subStyle : undefined;
  return { style: value.style, instructions, ...(subStyle ? { subStyle } : {}) };
}
