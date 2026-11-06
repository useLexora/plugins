const messages: Record<string, string> = {
  'Engine not installed': '缺少引擎', 'Engine download required': '需下载引擎', 'Engine unsupported': '引擎不支持', 'Engine needs attention': '检查引擎',
  'Models': '本地模型', 'Downloaded': '已准备', 'Local Catalog': '待下载', 'Pinned': '已固定',
  '{count} models': '{count}', '{count} model': '{count}', 'Model list actions': '模型操作',
  'Search models': '搜索模型', 'Search local catalogs…': '搜索名称或引擎', 'Clear search': '清空搜索',
  'Sort': '排序', 'Sort models by': '模型排序', 'Name (A–Z)': '名称', 'Size (largest first)': '大小',
  'Model list': '模型列表', 'No models match your search.': '没有匹配的模型', 'Running': '处理中',
  'Backend active; model is running.': '正在处理请求', 'Model is available to download.': '可下载',
  'Downloading{progress}': '下载中{progress}', 'Model downloaded and ready.': '资源已就绪',
}
export function useI18n() { return { t: (message: string, args?: Record<string, unknown>) => Object.entries(args ?? {}).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), messages[message] ?? message) } }
