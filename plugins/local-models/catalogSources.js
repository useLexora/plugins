export const huggingFaceCatalog = {
  kinds: ['chat', 'vision', 'asr', 'tts', 'image'],
  sorts: ['downloads', 'lastModified'],
  pageSize: 24,
  pipelines: { chat: 'text-generation', vision: 'image-text-to-text', asr: 'automatic-speech-recognition', tts: 'text-to-speech', image: 'text-to-image' },
  placeholder: '搜索名称、作者，或粘贴 Hugging Face 仓库链接',
}

export const sortLabels = { downloads: '下载最多', lastModified: '最近更新' }
