import React, { useState } from 'react'
import { Table, Tabs } from '@mantine/core'
import { Button, Icon } from './ui'
import { ModelConfiguration } from './Configuration'
import { RuntimeObservation, runtimeRecovery } from './RuntimeObservation'
import { DownloadProgress } from './DownloadProgress'
import { downloadActive } from './downloadPresentation'
import { engineIdentity, modelOriginLabel, modelGuidance } from './modelPresentation'
import { catalogTags, formatBytes } from './catalogPresentation'

const authorized = (state, id) => state.resources.find(resource => resource.id === id && resource.authorized)

export function ModelDetail({ model, state, specifications, manager, onImport, onAction, onClear, onEngine, onRemove, backButton }) {
  const [tab, setTab] = useState('files')
  const job = state.job?.modelId === model.id ? state.job : null
  const preparing = downloadActive(job)
  const disabled = manager.pending || !state.supported
  const presentation = modelGuidance(model, state, specifications)
  const files = model.activeResources.map(id => specifications.find(spec => spec.id === id)).filter(spec => spec?.kind === 'model')
  const engines = model.activeResources.map(id => specifications.find(spec => spec.id === id)).filter(spec => spec?.kind === 'engine')
  const modelBusy = model.active && model.runtimeBusy
  const conversational = ['chat', 'vision'].includes(model.runtime)
  const recovery = runtimeRecovery(model.runtimeObservation?.error)
  const fileAction = ['import', 'download', 'inspect', 'cancel'].includes(presentation.action)
  const issue = ['recover', 'refresh', 'engine'].includes(presentation.action) || model.state === 'unsupported'
  const primaryDisabled = presentation.action === 'cancel' ? manager.isPending('cancel-preparation') || job?.state !== 'preparing' : disabled || (model.runtimeBusy && (presentation.action === 'activate' || (model.active && ['import', 'inspect', 'download'].includes(presentation.action))))
  const action = () => <Button appearance="primary" disabled={primaryDisabled} onClick={() => onAction(model, presentation)}>{manager.isPending('add-compatible-model', model.id) ? '正在打开…' : presentation.actionLabel}</Button>
  const canImport = model.state !== 'unverified' && !preparing
  const canDownload = canImport && !model.filesReady && model.origin?.source !== 'local'
  return <article className="model-detail" data-selected-model={model.id}>
    <header className="model-detail-heading">
      <div className="model-title-actions"><div className="page-title-row">{backButton}<h2>{model.title}</h2></div><div className="model-header-actions">
        {presentation.action === 'activate' && action()}
        {(['idle', 'loading', 'running', 'stopping'].includes(model.state) || model.active && model.runtimeBusy) && <Button icon="stop" disabled={!state.supported || model.state === 'stopping' || manager.isPending('stop', model.id)} onClick={() => manager.run('stop', { modelId: model.id }, '模型已停止')}>停止</Button>}
        {model.filesRegistered ? <Button appearance="danger" icon="trash" disabled={disabled || modelBusy} onClick={() => onClear(model)}>清理模型文件</Button> : model.custom && <Button appearance="danger" icon="trash" disabled={disabled} onClick={() => onRemove(model)}>移除未完成记录</Button>}
      </div></div>
      <p className="repository-owner">{modelOriginLabel(model)}</p>
      <div className="model-facts"><span className={`model-state model-state--${presentation.tone}`}>{presentation.label}</span><span className="model-metadata">{catalogTags(model).join(' · ')}</span></div>
      {!fileAction && !issue && presentation.action !== 'engine' && <p className="model-usage" role="note">{presentation.description}</p>}
    </header>
    {issue && <section className="model-issue" aria-label="需要处理"><p>{presentation.description}</p>{presentation.action && action()}</section>}
    {presentation.warning && <div className="model-warning" role="status"><p>{presentation.warning}</p>{model.compatibilityWarning && engines.length > 0 && presentation.action !== 'engine' && <Button onClick={() => onEngine(engines[0].id)}>检查引擎</Button>}</div>}
    {recovery && <section className="model-recovery" aria-label="失败恢复指引"><h3>恢复选项</h3><p>{recovery}</p><div className="section-actions"><Button onClick={() => setTab('configuration')}>修改运行参数</Button>{engines.length > 0 && <Button onClick={() => onEngine(engines[0].id)}>管理推理引擎</Button>}</div><p className="field-help">这些入口不会自动修改配置或重新运行模型。</p></section>}
    <Tabs value={tab} onChange={setTab} className="model-tabs" keepMounted>
      <Tabs.List aria-label="模型详情"><Tabs.Tab value="files">模型文件</Tabs.Tab><Tabs.Tab value="configuration">运行参数</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="configuration" pt="lg"><ModelConfiguration key={model.id} model={model} hardware={state.environment?.hardware} run={manager.run} disabled={disabled || modelBusy} />{conversational && <RuntimeObservation model={model} />}</Tabs.Panel>
      <Tabs.Panel value="files" pt="lg">
        <section className="model-section" aria-label="模型文件">
          <div className="section-heading"><h3>文件与引用</h3><div className="section-actions">
            {fileAction && action()}
            {canDownload && presentation.action !== 'download' && <Button icon="download" disabled={disabled || modelBusy} onClick={() => onAction(model, { action: 'download' })}>下载模型文件</Button>}
            {canImport && presentation.action !== 'import' && <Button icon="file-up" disabled={disabled || modelBusy} onClick={() => onImport(model)}>{model.filesReady ? '重新选择文件' : '导入已有文件'}</Button>}
          </div></div>
          {fileAction && <p className="section-description">{presentation.description}</p>}
          {presentation.error && <p className="inline-error" role="alert">{presentation.error}</p>}
          {preparing && <DownloadProgress job={job} />}
          {files.map(spec => {
            const resource = authorized(state, spec.id)
            const entries = spec.archives ?? spec.files
            return <div className="model-file-group" key={spec.id}>
              <div className="model-file-summary"><span>{resource ? '文件引用可用' : state.resources.some(item => item.id === spec.id && item.authorized === false) ? '需重新授权文件引用' : model.filesRegistered ? '文件状态待确认' : '尚未获取'}</span><span>{resource ? '' : '预计 '}{formatBytes(resource?.bytes ?? spec.bytes)} · {entries.length} 个{spec.archives ? '资源包' : '文件'}</span></div>
              <Table className="model-file-list" layout="fixed" verticalSpacing="sm" aria-label={`${spec.title ?? model.title}文件清单`}><Table.Tbody>{entries.map(file => <Table.Tr key={file.path ?? file.id}><Table.Td><span className="file-name"><Icon name="file" /><span>{file.path ?? file.name ?? file.id}</span></span></Table.Td></Table.Tr>)}</Table.Tbody></Table>
            </div>
          })}
        </section>
      </Tabs.Panel>
    </Tabs>
    {engines.length > 0 && <details className="runtime-environment">
      <summary>运行环境</summary>
      {engines.map(engine => {
        const identity = engineIdentity(engine)
        return <div className="runtime-row" key={engine.id}><div><strong>{identity.title}</strong><span>{[identity.version, identity.backend].filter(Boolean).join(' · ')}</span>{!authorized(state, engine.id) && <span>{state.resources.some(resource => resource.id === engine.id && resource.authorized === false) ? '需重新授权' : '待准备'}</span>}</div><Button aria-label={`管理 ${identity.title} ${identity.backend} 引擎`} onClick={() => onEngine(engine.id)}>管理</Button></div>
      })}
    </details>}
  </article>
}
