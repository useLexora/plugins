import React, { useEffect, useRef } from 'react'
import { Table } from '@mantine/core'
import { Button } from './ui'
import { DownloadProgress } from './DownloadProgress'
import { formatBytes } from './catalogPresentation'

export function Engines({ state, specifications, manager, selected, onImport, onBack }) {
  const authorized = id => state.resources.find(resource => resource.id === id && resource.authorized)
  const engines = specifications.filter(spec => spec.kind === 'engine' && (!spec.legacy || authorized(spec.id)))
  const highlighted = useRef(null)
  useEffect(() => { highlighted.current?.scrollIntoView({ block: 'nearest' }); highlighted.current?.focus({ preventScroll: true }) }, [selected])
  return <section className="engines-page page-content" aria-label="推理引擎">
    <header className="page-title-row"><Button icon="chevron-left" iconOnly aria-label="返回模型页面" onClick={onBack} /><h2>推理引擎</h2><span className="engine-count">{engines.filter(engine => authorized(engine.id)).length} / {engines.length} 已安装</span></header>
    <p className="page-description">引擎供同类模型共用，可单独安装或导入已有资源。</p>
    <Table className="engine-grid" stickyHeader layout="fixed" verticalSpacing="md" horizontalSpacing="sm" aria-label="推理引擎列表">
      <Table.Thead><Table.Tr><Table.Th className="engine-name-column">引擎</Table.Th><Table.Th className="engine-size-column">大小</Table.Th><Table.Th className="engine-status-column">状态</Table.Th><Table.Th className="engine-actions-column">操作</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{engines.map(engine => {
        const resource = authorized(engine.id)
        const dependents = state.models.filter(model => [...model.resources, ...(model.directoryResources ?? [])].includes(engine.id))
        const purposes = state.engines.find(item => item.id === engine.id)?.capabilities ?? []
        const busy = dependents.some(model => model.runtimeBusy) || manager.pending
        const job = state.job?.resourceId === engine.id ? state.job : null
        const preparing = job && ['preparing', 'cancelling'].includes(job.state)
        return <Table.Tr ref={engine.id === selected ? highlighted : null} tabIndex={-1} className={`engine-card${engine.id === selected ? ' is-highlighted' : ''}`} key={engine.id} data-engine-id={engine.id}>
          <Table.Td className="engine-identity"><strong>{engine.title.replace(/ 引擎$/, '')}</strong><span className="engine-purpose">{purposes.join(' / ')}</span>{preparing && <DownloadProgress job={job} />}{job?.state === 'failed' && <p className="inline-error" role="alert">{job.message}</p>}</Table.Td>
          <Table.Td className="engine-meta">{formatBytes(resource?.bytes ?? engine.bytes)}</Table.Td>
          <Table.Td><span className={`engine-status${resource ? ' is-ready' : ''}`}>{preparing ? job.state === 'cancelling' ? '取消中' : '安装中' : resource ? '已安装' : '未安装'}</span></Table.Td>
          <Table.Td className="engine-actions">{preparing ? <Button disabled={job.state === 'cancelling'} onClick={() => manager.run('cancel-preparation', {}, '已请求取消', 'engines')}>取消安装</Button> : <>
            {!resource && !engine.legacy && <Button appearance={engine.id === selected ? 'primary' : undefined} disabled={busy || !state.supported} onClick={() => manager.run('prepare', { resourceId: engine.id, mode: 'download' }, '引擎已安装')}>安装引擎</Button>}
            {!engine.legacy && <Button disabled={busy || !state.supported} onClick={() => onImport(null, engine)}>导入引擎</Button>}
          </>}</Table.Td>
        </Table.Tr>
      })}</Table.Tbody>
    </Table>
  </section>
}
