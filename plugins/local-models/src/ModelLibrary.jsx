import React, { useEffect, useRef, useState } from 'react'
import { Table, TextInput } from '@mantine/core'
import { Button, Icon } from './ui'
import { Select } from './Select'
import { modelInLibrary, modelKinds, modelMatches, modelOriginLabel, modelGuidance } from './modelPresentation'
import { formatBytes } from './catalogPresentation'

export function ModelLibrary({ state, specifications, selected, onSelect, onDiscover, onImport, onAction, manager, renderDetail, visible = true }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [sort, setSort] = useState('name')
  const lastRow = useRef(null)
  const back = useRef(null)
  const title = '我的模型'
  const library = state.models.filter(model => modelInLibrary(model, state.resources, specifications))
  const modelSize = model => {
    const resources = model.activeResources.filter(id => specifications.find(spec => spec.id === id)?.kind === 'model')
    const sizes = resources.map(id => state.resources.find(resource => resource.id === id && resource.authorized)?.bytes ?? specifications.find(spec => spec.id === id)?.bytes)
    return sizes.length && sizes.every(Number.isFinite) ? sizes.reduce((sum, size) => sum + size, 0) : null
  }
  const models = library.filter(model => modelMatches(model, query, kind)).sort((a, b) => sort === 'size' ? (modelSize(b) ?? -1) - (modelSize(a) ?? -1) : a.title.localeCompare(b.title))
  const model = state.models.find(model => model.id === selected)
  useEffect(() => {
    if (!visible) return
    if (model) back.current?.focus()
    else lastRow.current?.focus({ preventScroll: true })
  }, [model?.id, visible])
  const open = (event, id) => { lastRow.current = event.currentTarget; onSelect(id) }
  return <section className="library-page" aria-label={title}>
    <div className="library-browser page-content" hidden={!!model}>
      <div className="library-toolbar">
        <TextInput className="library-search" type="search" aria-label="搜索本地模型" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="搜索模型、来源或文件" leftSection={<Icon name="search" />} />
        <Select aria-label="模型类型" value={kind} options={modelKinds} onChange={setKind} />
        <Select aria-label="模型排序" value={sort} options={[{ value: 'name', label: '按名称' }, { value: 'size', label: '按大小' }]} onChange={setSort} />
        <Button appearance="primary" icon="file-up" onClick={onImport}>导入本地模型</Button>
      </div>
      {!library.length ? <div className="library-empty"><Icon name="hard-drive" size={28} /><h3>还没有本地模型</h3><p>导入已有文件，或从模型目录中选择。</p><Button onClick={onDiscover}>去发现模型</Button></div> : <div className="library-results">
        {!models.length ? <div className="library-empty"><Icon name="search" size={28} /><h3>没有匹配的模型</h3><Button onClick={() => { setQuery(''); setKind('all') }}>清除筛选</Button></div> : <Table className="local-model-list" stickyHeader layout="fixed" verticalSpacing="md" horizontalSpacing="sm" highlightOnHover aria-label="本地模型列表">
          <Table.Thead><Table.Tr><Table.Th className="model-column-name">模型</Table.Th><Table.Th className="model-column-kind">用途</Table.Th><Table.Th className="model-column-size">文件大小</Table.Th><Table.Th className="model-column-status">状态</Table.Th><Table.Th className="model-column-actions">操作</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{models.map(model => {
            const status = modelGuidance(model, state, specifications)
            const disabled = status.action === 'cancel' ? manager.isPending('cancel-preparation') || state.job?.state === 'cancelling' : manager.pending || !state.supported || (model.runtimeBusy && (status.action === 'activate' || (model.active && ['import', 'inspect', 'download'].includes(status.action))))
            return <Table.Tr key={model.id} className="local-model-row" data-model-id={model.id}>
              <Table.Td className="local-model-identity"><button className="local-model-name" onClick={event => open(event, model.id)}>{model.title}</button><span className="local-model-origin">{modelOriginLabel(model)}</span></Table.Td>
              <Table.Td className="local-model-kind">{modelKinds.find(kind => kind.value === model.runtime)?.label ?? model.runtime}</Table.Td>
              <Table.Td className="local-model-size"><span>{formatBytes(modelSize(model))}</span>{!model.filesReady && <small>预计大小</small>}</Table.Td>
              <Table.Td className="local-model-status"><span className={`model-state model-state--${status.tone}`}>{status.label}</span></Table.Td>
              <Table.Td className="local-model-actions"><div className="local-model-action-group">{status.action && <Button disabled={disabled} onClick={event => { lastRow.current = event.currentTarget; onAction(model, status) }}>{status.actionLabel}</Button>}<Button className="local-model-details" rightSection={<Icon name="chevron-right" size={14} />} onClick={event => open(event, model.id)}>详情</Button></div></Table.Td>
            </Table.Tr>
          })}</Table.Tbody>
        </Table>}
      </div>}
    </div>
    {model && <div className="library-detail page-content">{renderDetail(model, <button ref={back} type="button" className="back-button" aria-label={`返回${title}`} onClick={() => onSelect('')}><Icon name="arrow-left" size={22} /></button>)}</div>}
  </section>
}
