import { onboardingEnglish } from './onboarding';
import { aiServicesEnglish } from './ai-services';
import { saveEnglish } from './save';
import { saveReceiptsEnglish } from './save-receipts';
import { bookmarksEnglish } from './bookmarks';
import { organizeEnglish } from './organize';
import { renameEnglish } from './rename';
import { organizeWorkbenchEnglish } from './organize-workbench';
import { organizeStatusEnglish } from './organize-status';
import { recoveryEnglish } from './recovery';
import { exportEnglish } from './export';
import { importEnglish } from './import';
import { preferencesEnglish } from './preferences';
import { tokenUsageEnglish } from './token-usage';
import { historyEnglish } from './history';
import { bookmarkRecencyEnglish } from './bookmark-recency';
import { personalizationEnglish } from './personalization';
/** UI-owned messages only. Native bookmark content and provider output never enter this catalog. */
export const english = {
  '关闭不会删除已收藏的书签。': 'Closing keeps your bookmark.',
  '展开目录：{folder}': 'Expand folder: {folder}',
  '收起目录：{folder}': 'Collapse folder: {folder}',
  暂无可选目录: 'No folders available',

  ...onboardingEnglish,
  收藏确认: 'Review bookmark',
  '名称已修改，目录修改尚未确认。请查看恢复记录。':
    'The name was changed; the folder change is unconfirmed. Check recovery records.',
  '待确认 {count} 项': '{count} bookmarks to review',
  '收藏确认未能打开，请重试。': 'Could not open the bookmark review. Try again.',
  '已收藏 · AI 正在归类…': 'Saved · AI is sorting…',
  '已收藏 · 已按本地规则归类': 'Saved · Sorted by a local rule',
  '已收藏 · AI 已归类': 'Saved · Sorted by AI',
  '已收藏 · 保持原位置': 'Saved · Kept in place',
  '已收藏 · 未自动归类': 'Saved · Not sorted',
  '文件夹：{path}': 'Folder: {path}',
  文件夹: 'Folder',
  'AI 建议': 'Suggested by AI',
  详情: 'Details',
  用原名: 'Use original',
  原位置: 'Original folder',
  归类到: 'Sorted into',
  归类方式: 'Sorted by',
  未归类原因: 'Not sorted because',
  撤销归类: 'Undo sorting',
  移出列表: 'Remove from list',
  确认本条收藏: 'Review this bookmark',
  '正在读取收藏…': 'Loading bookmark…',
  确认收藏: 'Confirm bookmark',
  确认修改: 'Confirm changes',
  稍后处理: 'Review later',
  '正在保存并核对结果…': 'Saving and checking the result…',
  查看恢复记录: 'Open recovery records',
  收藏详情: 'Bookmark details',
  '原名称：{title}': 'Original name: {title}',
  '建议名称：{title}': 'Suggested name: {title}',
  '正在自动归类，完成后可确认名称和目录。': 'Classifying automatically. Review the name and folder when finished.',
  '其余收藏已留待稍后处理。': 'The remaining bookmarks are saved for later review.',
  '没有待确认的收藏。': 'No bookmarks need review.',
  继续确认: 'Continue reviewing',
  '关闭窗口会保留已收藏的书签和自动归类结果。': 'Closing keeps your bookmarks and their automatic classification.',
  ...personalizationEnglish,
  ...bookmarkRecencyEnglish,
  ...historyEnglish,
  'AI 服务配置不可用': 'AI service settings are unavailable',
  '当前页面资料不可用；仅支持 http(s) 网页，请切换到网页标签后重试。':
    'Page details are unavailable. Only HTTP(S) pages are supported. Switch to a webpage tab and try again.',
  '无法确定当前标签页；请在浏览器窗口中重新打开智栏。':
    'Could not identify the current tab. Reopen Zhilan in a browser window.',
  '无法读取书签或安装身份，请重试。': 'Could not read bookmarks or the installation identity. Try again.',
  本地网站规则: 'Local website rule',
  本地同站点归类: 'Local same-site classification',
  'Ollama（本地）': 'Ollama (local)',
  'LM Studio（本地）': 'LM Studio (local)',
  '外观立即保存在本机；浏览器启用同步时，也会同步明暗模式和主题色。':
    'Appearance is saved locally immediately. Light/dark mode and accent color also sync when browser sync is enabled.',
  '语言立即保存在本机，并尝试通过浏览器同步。右键菜单和工具栏提示也会同步切换。':
    'Language is saved locally immediately and synced through your browser when available. Context menus and toolbar hints update with the same language.',
  '仅同步语言、明暗模式和主题色；服务密钥、网址、目录规则和书签关键词保留在本机。同步不可用时仍可正常使用。':
    'Only language, light/dark mode and accent color sync. Provider keys, URLs, folder rules and bookmark keywords stay local. You can keep using Zhilan when sync is unavailable.',
  '正在连接智栏…': 'Connecting to Zhilan…',
  关闭侧栏: 'Close sidebar',
  侧栏启动验证未通过: 'Could not start the sidebar',
  '书签尚未连接。请关闭此侧栏，再点击扩展图标重新打开；若刚更新了扩展，请先刷新当前网页。':
    'Bookmarks are not connected yet. Close this sidebar and reopen it from the extension icon. If the extension was just updated, refresh the webpage first.',
  ...aiServicesEnglish,
  ...saveEnglish,
  ...saveReceiptsEnglish,
  ...bookmarksEnglish,
  ...organizeEnglish,
  ...renameEnglish,
  ...organizeWorkbenchEnglish,
  ...organizeStatusEnglish,
  ...recoveryEnglish,
  ...exportEnglish,
  ...importEnglish,
  ...preferencesEnglish,
  ...tokenUsageEnglish,
  智栏: 'Zhilan',
  '智栏 · 书签助手': 'Zhilan · Bookmark assistant',
  语言: 'Language',
  语言设置: 'Language settings',
  '默认简体中文；切换后立即应用到全部智栏页面。':
    'Simplified Chinese is the default. Changes apply immediately to every Zhilan page.',
  '使用页面顶部的语言选项切换简体中文或 English，立即生效。':
    'Use the language selector at the top of the page to switch between Simplified Chinese and English instantly.',
  '语言保存在本机，已打开的智栏页面会同步切换。右键菜单和工具栏提示也会同步切换。':
    'The language is saved on this device and updates across open Zhilan pages. Context menus and toolbar hints update with the same language.',
  '语言已切换，但无法保存。重新打开后可能恢复默认语言。':
    'Language changed, but could not be saved. Reopening may restore the default.',
  跳到主要内容: 'Skip to main content',
  书签目录: 'Bookmarks',
  '浏览、搜索与批量管理浏览器原生书签。': 'Browse, search and manage your browser bookmarks.',
  'AI 整理': 'AI organization',
  '在选定目录内整理与精确去重；先预览，确认后才写入。':
    'Organize and review duplicates in a folder. Preview and confirm before applying changes.',
  导入书签: 'Import bookmarks',
  '支持 HTML / JSON / CSV / TXT / Markdown，导入后按设置自动分类。':
    'Import HTML, JSON, CSV, TXT or Markdown and classify bookmarks using your settings.',
  导出与备份: 'Export & backup',
  '手动导出、自动输出到本地文件，以及撤销与恢复记录。':
    'Export bookmarks, save to local files and review undo and recovery records.',
  'AI 服务': 'AI services',
  '连接模型服务，并为收藏、导入、搜索、整理分别指定模型。':
    'Connect your AI services and assign models to saving, importing, searching and organizing.',
  外观: 'Appearance',
  '颜色模式与主题色，弹窗和设置页同步。': 'Choose colors and appearance for the sidebar and settings.',
  隐私与规则: 'Privacy & rules',
  '控制发送给 AI 的内容、排除目录与网站规则。': 'Control what is sent to AI, excluded folders and website rules.',
  收藏记录与调试: 'Save history & diagnostics',
  '每次原生收藏的 AI 处理结果，以及可选的调用轨迹。':
    'Review bookmark classification results and optional request diagnostics.',
  书签: 'Bookmarks',
  AI: 'AI',
  偏好: 'Preferences',
  设置导航: 'Settings navigation',
  '原生书签 · AI 助手': 'Browser bookmarks · AI assistant',
  未配置: 'Not configured',
  批量管理: 'Bulk actions',
  快速搜索入口: 'Search shortcuts',
  '按 Alt+Shift+K 打开搜索。也可在地址栏输入 zl，按 Tab 或空格后输入关键词。智栏内按 Ctrl+K（Mac：⌘K）聚焦搜索。':
    'Press Alt+Shift+K to open search. Or type zl in the address bar, press Tab or Space, then enter keywords. Within Zhilan, press Ctrl+K (Mac: ⌘K) to focus search.',
  '若快捷键被其他扩展占用，可在浏览器中重新设置。':
    'If another extension uses this shortcut, change it in your browser settings.',
  设置浏览器搜索快捷键: 'Configure browser shortcuts',
  备份与恢复记录: 'Backup & recovery records',
  外观设置: 'Appearance settings',
  '旧版单连接模型配置（兼容）': 'Legacy single-service configuration',
  '新版请在「AI 服务」里连接并按功能分配模型；这里保留旧的单连接配置，供尚未迁移的搜索 / 整理 / 导入路径使用。':
    'Use AI services to connect and assign models. Legacy single-service settings remain available for installations that have not migrated.',
  搜索书签: 'Search bookmarks',
  '搜索书签，或描述你要找的网站': 'Search bookmarks or describe a website',
  清空搜索: 'Clear search',
  返回书签: 'Back to bookmarks',
  快速设置: 'Quick settings',
  设置: 'Settings',
  收起侧栏: 'Close sidebar',
  '收起（Esc）': 'Close (Esc)',
  书签工具: 'Bookmark tools',
  '在设置页中用 AI 整理选定目录': 'Organize a folder with AI in settings',
  整理: 'Organize',
  在设置页中导入书签文件: 'Import a bookmark file in settings',
  导入: 'Import',
  在设置页中导出与备份: 'Export and back up in settings',
  导出: 'Export',
  批量选择书签: 'Select multiple bookmarks',
  批量: 'Select',
  跟随系统: 'System',
  浅色: 'Light',
  深色: 'Dark',
  靛紫: 'Indigo',
  海蓝: 'Blue',
  青绿: 'Teal',
  琥珀: 'Amber',
  玫红: 'Rose',
  石墨: 'Graphite',
  颜色模式: 'Color mode',
  主题色: 'Accent color',
  '快速切换为{mode}': 'Switch to {mode}',
  '外观保存在本机浏览器，工具栏弹窗与设置页同步生效。':
    'Appearance is saved in this browser and shared by the sidebar and settings.',
  浮层侧栏: 'Overlay sidebar',
  '从左侧弹出盖在网页上，点空白处或按 Esc 收起':
    'Opens over the left side of the page. Click outside or press Esc to close.',
  浏览器侧边栏: 'Browser side panel',
  '固定在页面旁边，网页会让出位置': 'Stays beside the page, which resizes to make room.',
  侧栏打开方式: 'Sidebar behavior',
  '浏览器内置页面（如新标签页、设置页）无法放浮层，会自动改用浏览器侧边栏。':
    'Browser pages such as settings and new tabs use the browser side panel automatically.',
  'AI 服务管理': 'Manage AI services',
  收藏记录与调试日志: 'Save history & logs',
  更多外观选项: 'More appearance options',
  完整设置: 'All settings',
  搜索结果: 'Search results',
  本地优先: 'Local first',
  前往整理工作台: 'Open organization workspace',
  '正在建立本地搜索索引…': 'Building the local search index…',
  重试读取: 'Retry loading',
  'AI 帮我找': 'Find with AI',
  继续搜索剩余书签: 'Search remaining bookmarks',
  深度搜索: 'Deep search',
  '已取消 AI 搜索，保留已找到的结果；搜索尚未完成。':
    'AI search cancelled. Results found so far are retained; the search is incomplete.',
  'AI 搜索未完成，保留已找到的结果。{reason}': 'AI search is incomplete. Results found so far are retained. {reason}',
  '单条书签或查询超过模型请求限额，搜索尚未完成。':
    'A bookmark or the query exceeds the model request limit. The search is incomplete.',
  '模型未完整判断本批书签，搜索尚未完成。':
    'The model did not account for every bookmark in this batch. The search is incomplete.',
  '书签已变化，当前结果尚未覆盖最新书签，请重新搜索。':
    'Bookmarks changed. These results do not cover the latest collection; search again.',
  '已检查 {checked} / {total} 条 · 匹配 {matched} 条 · 无法确定 {uncertain} 条':
    'Checked {checked} / {total} · Matches {matched} · Uncertain {uncertain}',
  '当前没有已确认的匹配结果。': 'No confirmed matches so far.',
  '无法确定是否相关（{count}）': 'Uncertain relevance ({count})',
  '仅本地匹配，未发送 AI（{count}）': 'Local matches only, not sent to AI ({count})',
  '正在搜索…': 'Searching…',
  '取消 AI 搜索': 'Cancel AI search',
  '没有匹配的关键词结果。': 'No keyword matches.',
  '{count} 条结果 · {action}': 'Results: {count} · {action}',
  '点击或聚焦后按 Enter 打开': 'Click a result or focus it and press Enter to open',
  连接恢复后可打开: 'Results can be opened after reconnection',
  未命名书签: 'Untitled bookmark',
  '已等待 {seconds} 秒': 'Waiting {seconds}s',
  '搜索入口已过期，请重新输入关键词。': 'This search link has expired. Enter your keywords again.',
  '搜索入口不可用，请重新输入关键词。': 'This search link is unavailable. Enter your keywords again.',
  '书签服务不可用。': 'Cannot connect to your bookmarks. Try loading them again.',
  '搜索索引不可用，请等待书签刷新。': 'Search is unavailable while bookmarks refresh.',
  '设置或权限已变化，已恢复本地结果。': 'Settings or permissions changed. Local results have been restored.',
  '正在更新书签；仍可搜索上次读取的数据，连接恢复后可打开结果。':
    'Updating bookmarks. You can search the previous list and open results after reconnection.',
  '正在读取书签…': 'Loading bookmarks…',
  '已取消 AI 搜索，保留本地结果。': 'AI search cancelled. Local results are still available.',
  'AI 搜索暂不可用，请等待书签连接恢复并检查模型配置。':
    'AI search is unavailable. Wait for bookmarks to reconnect and check your model settings.',
  '正在分段检查允许搜索的书签…': 'Checking allowed bookmarks in batches…',
  '正在理解描述并查找候选书签…': 'Finding bookmarks that match your description…',
  '服务繁忙，{seconds} 秒后重试（{attempt}/3），可随时取消。':
    'Service busy. Retrying in {seconds}s ({attempt}/3). You can cancel at any time.',
  '正在比较 {count} 条候选书签…找不到时可尝试深度搜索。':
    'Comparing {count} candidate bookmarks… Try Deep search if needed.',
  '深度搜索：已检查 {count} / {total} 条，正在比较相关结果…':
    'Deep search: checked {count} / {total} bookmarks. Comparing relevant results…',
  'AI 找到 {count} 条相关书签': 'AI found {count} relevant bookmarks',
  'AI 没有找到相关书签，换个描述试试': 'AI found no relevant bookmarks. Try another description.',
  'AI 搜索未完成，保留本地结果。{reason}': 'AI search did not finish. Local results are still available. {reason}',
  '读取书签或模型设置超时，请重试。': 'Loading bookmarks or model settings timed out. Try again.',
  '书签正在更新，请连接恢复后重试。': 'Bookmarks are updating. Try again after reconnection.',
  '模型搜索超时，请重试或调整模型超时设置。': 'AI search timed out. Try again or adjust the model timeout.',
  '请先在 AI 服务中为“智能搜索”指定模型。': 'Assign a model to Smart search in AI services first.',
  '没有允许用于 AI 搜索的书签，请检查隐私排除设置。':
    'No bookmarks are allowed for AI search. Check your privacy exclusions.',
  '书签资料超过单次模型请求限额，请通过隐私排除设置缩小 AI 搜索范围。':
    'Bookmark data exceeds the request limit. Reduce the AI search scope using privacy exclusions.',
  '模型服务尚未授权，请检查 AI 服务权限。':
    'Access to the model service has not been granted. Check AI service permissions.',
  '搜索期间书签或设置已变化，请重新搜索。': 'Bookmarks or settings changed during the search. Search again.',
  '模型返回的搜索结果无效，请重试。': 'The model returned invalid search results. Try again.',
  '快速搜索没有找到足够候选，可以尝试“深度搜索”，分段检查全部允许搜索的书签。':
    'Fast search found too few candidates. Try Deep search to check all allowed bookmarks in batches.',
  '请检查模型连接后重试。': 'Check your model connection and try again.',
  '{reason} 仍可搜索上次读取的数据。': '{reason} You can still search the previously loaded data.',
} as const;
export type MessageKey = keyof typeof english;
