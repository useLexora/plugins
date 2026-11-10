import React, { useEffect, useId, useRef, useState } from 'react'
import { Menu, Radio } from '@mantine/core'
import { Button, Icon } from './ui'
import { DownloadProgress } from './DownloadProgress'
import { formatBytes } from './catalogPresentation'
import { downloadActive, downloadPresentation } from './downloadPresentation'
import { engineFamilies, engineMutationBlocked } from './modelPresentation'

const versionLabel = engine => engine.version || (engine.custom ? engine.id.replace(/^llama-custom-/, '').slice(0, 8) : engine.title || engine.id)
const needsAuthorization = (engine, state) => !engine.installed && state.resources.some(resource => resource.id === engine.id && resource.authorized === false)
const canImport = (engine, state) => !engine.legacy || needsAuthorization(engine, state)

export function enginePreview(group, state) {
  return group.versions.find(engine => engine.selected && (engine.installed || needsAuthorization(engine, state)))
    ?? group.versions.find(engine => engine.installed)
    ?? group.versions.find(engine => !engine.legacy && !engine.custom)
    ?? group.versions[0]
}

function EngineHeading({ family }) {
  return <header className="engine-family-heading"><h3>{family.title}</h3>{family.capabilities.length > 0 && <span className="engine-purpose">{family.capabilities.join(' / ')}</span>}</header>
}

function EngineBackend({ group, family, state, specifications, manager, selected, onImport, onImportCustom }) {
  const [panel, setPanel] = useState(() => group.versions.some(engine => engine.id === selected) ? { id: selected, mode: 'manage' } : null)
  const panelId = useId()
  const row = useRef(null)
  const trigger = useRef(null)
  const preview = enginePreview(group, state)
  const chosen = panel && group.versions.find(engine => engine.id === panel.id)
  const busy = engineMutationBlocked(group, state, specifications, manager.pending)
  const jobEngine = group.versions.find(engine => engine.id === state.job?.resourceId)
  const job = jobEngine ? state.job : null
  const preparing = downloadActive(job)
  const reauthorize = needsAuthorization(preview, state)
  const importable = group.versions.find(engine => canImport(engine, state))
  useEffect(() => {
    if (!group.versions.some(engine => engine.id === selected)) return
    setPanel({ id: selected, mode: 'manage' })
    row.current?.scrollIntoView({ block: 'nearest' })
    row.current?.focus({ preventScroll: true })
  }, [selected, group.key])
  const open = (mode = 'manage') => setPanel({ id: mode === 'import' && !canImport(preview, state) ? importable.id : preview.id, mode })
  const close = () => {
    setPanel(null)
    if (trigger.current && !trigger.current.disabled) trigger.current.focus()
    else row.current?.focus()
  }
  const importFiles = engine => engine.custom ? onImportCustom(engine.backend) : onImport(null, engine)
  const importMode = panel?.mode === 'import' || chosen && (chosen.custom && !chosen.installed || needsAuthorization(chosen, state) || chosen.legacy && !chosen.installed)
  const actionLabel = !chosen ? '请选择版本' : importMode ? needsAuthorization(chosen, state) ? '重新授权文件' : '选择本机文件' : chosen.installed ? chosen.selected ? '当前选择' : '使用此版本' : job?.resourceId === chosen.id && job.state === 'failed' ? '重试安装' : '安装此版本'
  const actionDisabled = busy || !chosen || (importMode ? !canImport(chosen, state) : chosen.installed && chosen.selected)
  const apply = () => {
    if (actionDisabled) return
    if (importMode) importFiles(chosen)
    else if (chosen.installed) manager.run('use-engine', { resourceId: chosen.id }, '引擎版本已切换')
    else manager.run('prepare', { resourceId: chosen.id, mode: 'download' }, '引擎已安装')
  }
  const summary = <div className="engine-summary">
    {preview.installed ? <><span>{preview.selected && (preview.version || preview.custom) ? '当前版本' : '已安装'}</span>{(preview.version || preview.custom) && <strong>{versionLabel(preview)}{preview.prerelease ? '（预发布）' : ''}</strong>}</> : <>{(preview.version || preview.custom) && <strong>{versionLabel(preview)}</strong>}{Number.isFinite(preview.bytes) && <span>{formatBytes(preview.bytes)}</span>}</>}
    {reauthorize && <span className="engine-attention">需重新授权</span>}
  </div>
  return <section className="engine-backend" aria-label={group.backend || group.title}>
    <div ref={row} tabIndex={-1} className={`engine-backend-row${group.backend ? '' : ' without-backend'}`} data-engine-id={preview.id}>
      {family ? <div className="engine-single-info"><EngineHeading family={family} />{summary}</div> : <>{group.backend && <h4>{group.backend}</h4>}{summary}</>}
      <div className="engine-actions">
        {preparing ? <Button ref={trigger} disabled={job.state !== 'preparing' || manager.isPending('cancel-preparation')} onClick={() => manager.run('cancel-preparation', {}, '已请求取消', 'engines')}>取消安装</Button> : <Button ref={trigger} appearance={preview.installed ? undefined : 'primary'} variant={preview.installed ? 'light' : undefined} aria-expanded={!!panel} aria-controls={panelId} onClick={() => panel ? close() : open()}>{preview.installed ? '管理版本' : reauthorize ? '重新授权' : preview.custom || preview.legacy ? '选择文件' : '安装'}</Button>}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><Button icon="more-horizontal" iconOnly aria-label={`${group.backend || group.title}更多操作`} /></Menu.Target>
          <Menu.Dropdown><Menu.Item leftSection={<Icon name="settings" />} onClick={() => open()}>管理版本</Menu.Item>{importable && <Menu.Item leftSection={<Icon name="file-up" />} onClick={() => open('import')}>导入已有文件</Menu.Item>}</Menu.Dropdown>
        </Menu>
      </div>
    </div>
    {preparing && <div className="engine-job"><p>{versionLabel(jobEngine)} · {downloadPresentation(job).label}</p><DownloadProgress job={job} /></div>}
    {job?.state === 'failed' && <p className="inline-error" role="alert">{versionLabel(jobEngine)}：{job.message}</p>}
    {['cancelled', 'interrupted'].includes(job?.state) && <p className="engine-purpose">{versionLabel(jobEngine)} · {downloadPresentation(job).label}</p>}
    {panel && <section id={panelId} className="engine-version-panel" aria-label={`${group.backend || group.title}版本管理`}>
      <div className="engine-panel-heading"><h5>{panel.mode === 'import' ? '选择要导入的版本' : '选择版本'}</h5><Button icon="x" iconOnly aria-label="关闭版本管理" onClick={close} /></div>
      <Radio.Group value={panel.id} onChange={id => setPanel({ ...panel, id })} aria-label="引擎版本">
        <div className="engine-version-options">{group.versions.map(engine => <Radio key={engine.id} value={engine.id} className="engine-version-option" data-engine-version-id={engine.id} label={<span className="engine-version-choice"><strong title={engine.custom ? `文件指纹 ${engine.id.replace(/^llama-custom-/, '')}` : undefined}>{versionLabel(engine)}</strong>{engine.prerelease && <span>预发布</span>}{engine.installed && <span>{engine.selected ? '当前选择' : '已安装'}</span>}{needsAuthorization(engine, state) && <span className="engine-attention">需重新授权</span>}</span>} />)}</div>
      </Radio.Group>
      {chosen ? <div className="engine-version-details">
        {!chosen.installed && <p className="engine-purpose">{formatBytes(chosen.bytes)}</p>}
        {chosen.prerelease && <p className="engine-prerelease-note">此版本是上游预发布构建，请保留当前可用版本。</p>}
        {chosen.requirements?.length > 0 && <div className="engine-requirements"><h6>运行要求</h6><ul>{chosen.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></div>}
        {!chosen.installed && chosen.engineId && !importMode && <p className="field-help">安装不会切换已有的版本选择。</p>}
        {importMode && !canImport(chosen, state) && <p className="field-help">此历史版本仅保留现有安装，请选择其他版本导入。</p>}
      </div> : <p className="inline-error">该版本已不在列表中，请重新选择。</p>}
      <div className="engine-panel-actions"><Button appearance="primary" disabled={actionDisabled} onClick={apply}>{actionLabel}</Button></div>
    </section>}
  </section>
}

export function Engines({ state, specifications, manager, selected, onImport, onImportCustom, onBack }) {
  const families = engineFamilies(state, specifications)
  return <section className="engines-page page-content" aria-label="推理引擎">
    <header className="page-title-row"><Button icon="chevron-left" iconOnly aria-label="返回模型页面" onClick={onBack} /><h2>推理引擎</h2><div className="engine-import-button section-actions"><Button disabled={manager.pending || !state.supported} onClick={() => manager.run('check-engine-updates', {}, '引擎目录已更新', 'engines')}>{manager.isPending('check-engine-updates') ? '正在检查' : '检查更新'}</Button><Button icon="file-up" disabled={manager.pending || !state.supported} onClick={() => onImportCustom()}>从本机导入</Button></div></header>
    {families.map(family => {
      const single = family.backends.length === 1 && !family.backends[0].backend
      return <section className={`engine-family${single ? ' engine-family--single' : ''}`} key={family.engineId} aria-label={family.title}>
        {!single && <EngineHeading family={family} />}
        <div className="engine-backends">{family.backends.map(group => <EngineBackend key={group.key} group={group} family={single ? family : undefined} state={state} specifications={specifications} manager={manager} selected={selected} onImport={onImport} onImportCustom={onImportCustom} />)}</div>
      </section>
    })}
    {families.length === 0 && <p className="page-description">当前平台没有可管理的引擎。</p>}
  </section>
}
