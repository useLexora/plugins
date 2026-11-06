import React, { useEffect, useRef, useState } from 'react'
import { ActionIcon, Badge, Table, TextInput, Title, UnstyledButton } from '@mantine/core'
import { Button, Icon } from './ui'
import { Select } from './Select'
import { DownloadProgress } from './DownloadProgress'
import { downloadActive, downloadEntries } from './downloadPresentation'
import { modelInLibrary, modelOriginLabel, modelPresentation } from './modelPresentation'
import { ModelTags } from './discovery'
import { quantization } from './catalogPresentation'
import './transfers.css'

export function DownloadHistory({ state, specifications, selected, onSelect, onDiscover, onBack, renderDetail, manager }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const back = useRef(null)
  const lastRow = useRef(null)
  const model = state.models.find(item => item.id === selected)
  const entries = downloadEntries(state, specifications, modelInLibrary)
  const visible = entries.filter(entry => {
    const text = `${entry.title ?? entry.model?.title ?? ''} ${entry.model?.origin?.repository ?? ''} ${Object.values(entry.model?.files ?? {}).join(' ')} ${entry.progress?.path ?? ''}`.toLowerCase()
    return text.includes(query.trim().toLowerCase()) && (filter === 'all' || (filter === 'active' ? downloadActive(entry) : filter === 'completed' ? entry.state === 'completed' : ['failed', 'cancelled', 'interrupted'].includes(entry.state)))
  })
  useEffect(() => {
    if (model) back.current?.focus()
    else lastRow.current?.focus({ preventScroll: true })
  }, [model?.id])
  const open = (event, id) => { lastRow.current = event.currentTarget; onSelect(id) }
  return <section className="library-page download-history lm-transfer-page" aria-label="下载历史">
    <div className="library-browser page-content lm-transfer-browser" hidden={!!model}>
      <header className="task-heading lm-transfer-heading"><ActionIcon className="back-button lm-transfer-back" variant="subtle" color="gray" size="lg" aria-label="返回我的模型" title="返回我的模型" onClick={onBack}><Icon name="chevron-right" size={18} /></ActionIcon><Title order={2} size="h3">下载历史</Title></header>
      <div className="library-toolbar lm-transfer-toolbar"><TextInput className="search-control lm-transfer-search" type="search" aria-label="搜索下载历史" leftSection={<Icon name="search" size={17} />} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、来源或文件" /><Select className="lm-transfer-filter" aria-label="下载状态" value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部状态' }, { value: 'active', label: '进行中' }, { value: 'completed', label: '已完成' }, { value: 'unfinished', label: '未完成' }]} /></div>
      {state.historyWarning && <p className="lm-transfer-error" role="alert">{state.historyWarning}</p>}
      {!entries.length ? <div className="library-empty lm-transfer-empty"><Icon name="download" size={30} /><Title order={3} size="h5">还没有下载记录</Title><Button icon="search" onClick={onDiscover}>去发现模型</Button></div> : <div className="library-results lm-transfer-results">
        {!visible.length ? <div className="catalog-feedback lm-transfer-empty"><Title order={3} size="h5">没有匹配的下载记录</Title><Button onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</Button></div> : <div className="download-history-list lm-transfer-list">
          <Table className="lm-transfer-table" stickyHeader horizontalSpacing="sm" verticalSpacing="md">
            <Table.Thead><Table.Tr><Table.Th scope="col">模型</Table.Th><Table.Th scope="col">下载状态</Table.Th><Table.Th scope="col">操作</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{visible.map(entry => {
              const title = entry.title ?? entry.model?.title ?? entry.modelId
              const origin = entry.model ? modelOriginLabel(entry.model) : '模型记录已移除'
              const precision = [...new Set(Object.values(entry.model?.files ?? {}).map(quantization).filter(Boolean))].join(' / ')
              return <Table.Tr className="download-history-row lm-transfer-row" key={entry.id} data-download-id={entry.id}>
                <Table.Td className="history-identity lm-transfer-identity">
                  <div className="history-heading lm-transfer-model-heading">{entry.model ? <UnstyledButton className="history-model lm-transfer-model" title={title} data-model-id={entry.modelId} onClick={event => open(event, entry.modelId)}><strong>{title}</strong></UnstyledButton> : <strong className="history-model lm-transfer-model" title={title}>{title}</strong>}{entry.model && <ModelTags item={entry.model} />}</div>
                  <span className="history-origin lm-transfer-origin" title={origin}>{origin}</span>
                  <div className="history-meta lm-transfer-meta">{precision && <span>{precision}</span>}{entry.startedAt && <time dateTime={new Date(entry.startedAt).toISOString()}>{new Date(entry.startedAt).toLocaleString()}</time>}</div>
                </Table.Td>
                <Table.Td className="lm-transfer-state">{entry.state === 'pending' ? <Badge component="span" className="model-state lm-transfer-badge" color="gray" variant="light" size="sm" radius="sm">{modelPresentation(entry.model, null).label}</Badge> : <DownloadProgress job={entry} compact />}</Table.Td>
                <Table.Td className="lm-transfer-action-cell"><div className="history-row-actions lm-transfer-actions">
                  {downloadActive(entry) ? <Button size="small" disabled={entry.state === 'cancelling' || entry.state === 'committing' || manager.isPending('cancel-preparation')} onClick={() => manager.run('cancel-preparation', {}, '已请求取消')}>取消</Button> : ['failed', 'cancelled', 'interrupted'].includes(entry.state) && entry.model && !entry.model.filesReady && <Button size="small" disabled={manager.pending} title={state.resumableDownloads ? '优先从已保留的文件继续下载' : '当前宿主不支持断点续传'} onClick={() => manager.run('prepare', { modelId: entry.modelId, retryId: entry.id, scope: 'model', mode: 'download' }, '模型文件已下载')}>{state.resumableDownloads ? '重试' : '重新下载'}</Button>}
                  {entry.model && <ActionIcon className="history-open" variant="subtle" color="gray" aria-label="查看模型详情" title="查看模型详情" onClick={event => open(event, entry.modelId)}><Icon name="chevron-right" size={17} /></ActionIcon>}
                </div></Table.Td>
              </Table.Tr>
            })}</Table.Tbody>
          </Table>
        </div>}
      </div>}
    </div>
    {model && <div className="library-detail page-content lm-transfer-detail">{renderDetail(model, <ActionIcon ref={back} className="back-button" variant="subtle" color="gray" size="lg" aria-label="返回下载历史" title="返回下载历史" onClick={() => onSelect('')}><Icon name="arrow-left" size={22} /></ActionIcon>)}</div>}
  </section>
}
