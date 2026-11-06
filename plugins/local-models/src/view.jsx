import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Loader, PasswordInput, Tabs } from '@mantine/core'
import { Button, Icon, InterfaceProvider } from './ui'
import { Fields } from './Configuration'
import { ModelDetail } from './ModelDetail'
import { Engines } from './Engines'
import { ImportDialog, ClearDialog, RemoveCredentialDialog } from './ResourceDialogs'
import './view.css'
import { Discovery } from './discovery'
import { ModelLibrary } from './ModelLibrary'
import { LocalImportDialog } from './LocalImportDialog'
import { DownloadHistory } from './DownloadHistory'
import { downloadActive, downloadPresentation, latestJob } from './downloadPresentation'
import { modelInLibrary } from './modelPresentation'

const PREFIX = 'lexora.local-models'
const tabs = [['discover', '发现'], ['models', '我的模型']]
const live = model => ['idle', 'loading', 'running', 'stopping'].includes(model.state)

function useManager(context) {
  const [state, setState] = useState(null)
  const [pendingKeys, setPendingKeys] = useState(new Set())
  const [notice, setNotice] = useState(null)
  const operations = useRef(new Map())
  const active = useRef(true)
  const refreshing = useRef(false)
  const command = (name, input) => context.commands.execute(`${PREFIX}.${name}`, input)
  const refresh = async () => {
    if (refreshing.current || !active.current) return
    refreshing.current = true
    try { const result = await command('status'); if (active.current) setState(previous => ({ ...result, job: latestJob(previous?.job, result.job) })) }
    catch (error) { if (active.current) setNotice({ error: true, text: error.message || '无法读取模型状态，请重试。' }) }
    finally { refreshing.current = false }
  }
  const run = async (name, input, success, scope = input?.resourceId && !input?.modelId ? 'engines' : undefined) => {
    const key = `${name}:${input?.modelId ?? input?.serviceId ?? ''}`
    operations.current.set(key, (operations.current.get(key) ?? 0) + 1)
    setPendingKeys(new Set(operations.current.keys())); setNotice(null)
    try {
      const result = await command(name, input)
      if (!result?.ok) throw new Error(result?.error || result?.message || '操作未完成，请重试。')
      if (active.current && (result.warning || success)) setNotice({ text: result.warning || success, error: !!result.warning, scope })
      return result
    } catch (error) { if (active.current) setNotice({ error: true, text: error.message, scope }); return false }
    finally {
      const remaining = operations.current.get(key) - 1
      if (remaining) operations.current.set(key, remaining)
      else operations.current.delete(key)
      if (active.current) { setPendingKeys(new Set(operations.current.keys())); await refresh() }
    }
  }
  useEffect(() => {
    if (!notice || notice.error) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    active.current = true
    void refresh()
    const controller = new AbortController()
    context.events.on('view:message:received', ({ data }) => {
      if (data.message?.type !== 'resource-preparation') return
      setState(previous => previous && { ...previous, job: latestJob(previous.job, data.message.job) })
      if (!['preparing', 'cancelling'].includes(data.message.job?.state)) void refresh()
    }, { signal: controller.signal })
    const timer = setInterval(() => { if (context.visible) void refresh() }, 3000)
    return () => { active.current = false; controller.abort(); clearInterval(timer) }
  }, [])
  const busy = downloadActive(state?.job)
  const pendingReason = busy ? `正在处理「${state.job.title ?? state.models.find(model => model.id === state.job.modelId)?.title ?? state.specifications?.find(resource => resource.id === state.job.resourceId)?.title ?? '资源文件'}」。安装、导入和保存更改需等待此任务完成或取消；浏览与筛选不受影响。` : pendingKeys.size ? '正在保存当前操作，请稍候。' : ''
  return { state, pending: pendingKeys.size > 0 || busy, pendingReason, isPending: (name, id = '') => pendingKeys.has(`${name}:${id}`), notice, setNotice, run, refresh }
}

function ServiceForm({ service, manager }) {
  const [draft, setDraft] = useState(service.configuration)
  const [token, setToken] = useState('')
  const [removing, setRemoving] = useState(false)
  const disabled = manager.pending || !manager.state.supported
  return <form className="configuration service-form" onSubmit={event => { event.preventDefault(); void manager.run('configure-service', { serviceId: service.id, configuration: draft, ...(token ? { token } : {}) }, '连接配置已保存').then(ok => { if (ok) setToken('') }) }}>
    <Fields fields={service.fields} draft={draft} setDraft={setDraft} disabled={disabled} />
    {draft.auth !== 'none' && <PasswordInput label="API Key" autoComplete="off" value={token} placeholder={service.hasCredential ? '已保存；留空保留' : '填写密钥'} disabled={disabled} onChange={event => setToken(event.currentTarget.value)} />}
    {service.activationMessage && <p role="alert" className="inline-error">{service.activationMessage}</p>}
    <div className="form-actions"><Button type="submit" appearance="primary" disabled={disabled}>保存连接</Button>{service.hasCredential && <Button appearance="quiet" disabled={disabled} onClick={() => setRemoving(true)}>移除密钥</Button>}{live(service) && <Button icon="stop" disabled={!manager.state.supported || service.state === 'stopping' || manager.isPending('stop', service.id)} onClick={() => manager.run('stop', { serviceId: service.id }, '调用已停止')}>停止</Button>}</div>
    {removing && <RemoveCredentialDialog service={service} manager={manager} onClose={() => setRemoving(false)} />}
  </form>
}

function App({ context, specifications }) {
  const manager = useManager(context)
  const { state } = manager
  const [tab, setTab] = useState('discover')
  const [selected, setSelected] = useState('')
  const [engine, setEngine] = useState(null)
  const [engineReturn, setEngineReturn] = useState({ tab: 'models', selected: '' })
  const [serviceId, setServiceId] = useState('speech-api')
  const [libraryEpoch, setLibraryEpoch] = useState(0)
  const [modal, setModal] = useState(null)
  const activeJob = downloadActive(state?.job)
  const downloading = activeJob && state.job.mode === 'download' && !!state.job.modelId
  const headerProgress = downloading ? downloadPresentation(state.job).percent : undefined
  useEffect(() => {
    if (!context.onSettingsHeaderAction) return
    const subscription = context.onSettingsHeaderAction(id => {
      setSelected(''); manager.setNotice(null)
      if (id === 'engines') { setEngine(null); setEngineReturn({ tab: 'models', selected: '' }); setTab('engines') }
      if (id === 'downloads') setTab('transfers')
    })
    return () => subscription.dispose()
  }, [context])
  useEffect(() => {
    if (!context.setSettingsHeaderActions) return
    void context.setSettingsHeaderActions([{ id: 'engines', title: '推理引擎', icon: 'settings' }, { id: 'downloads', title: downloading ? '下载历史 1' : '下载历史', icon: 'download', ...(downloading ? { progress: headerProgress } : {}) }]).catch(error => manager.setNotice({ error: true, text: error.message.includes('EXTENSION_INVALID_ARGUMENT') ? '当前宿主不支持下载圆环进度，请更新 Lexora。' : error.message }))
  }, [context, downloading, headerProgress])
  if (!state) return <main className="manager loading-state"><div className="catalog-feedback" role={manager.notice?.error ? 'alert' : 'status'}>{manager.notice?.error ? <><h3>无法读取模型状态</h3><p>{manager.notice.text}</p><Button onClick={manager.refresh}>重试</Button></> : '正在读取模型…'}</div></main>
  specifications = state.specifications ?? specifications
  const legacyServices = state.services.filter(item => item.configured || item.credentialPending)
  const service = legacyServices.find(item => item.id === serviceId) ?? legacyServices[0]
  const showModel = id => {
    setSelected(id); setLibraryEpoch(value => value + 1)
    const model = state.models.find(model => model.id === id)
    setTab(model && modelInLibrary(model, state.resources, specifications) ? 'models' : 'transfers')
  }
  const discover = () => setTab('discover')
  const importModel = (model, specification) => setModal({ kind: 'import', model, specification })
  const recoverModel = async model => {
    const result = await manager.run('add-compatible-model', { modelId: model.id }, '已打开兼容版本，旧模型和文件均已保留')
    if (result) showModel(result.modelId)
  }
  const modelAction = (model, guidance) => {
    if (guidance.action === 'recover') return recoverModel(model)
    if (guidance.action === 'import') return importModel(model)
    if (guidance.action === 'inspect') return setModal({ kind: 'local-import' })
    if (guidance.action === 'download') return manager.run('prepare', { modelId: model.id, scope: 'model', mode: 'download' }, '模型文件已下载')
    if (guidance.action === 'activate') return manager.run('activate-model', { modelId: model.id }, '模型已启用')
    if (guidance.action === 'cancel') return manager.run('cancel-preparation', {}, '已请求取消')
    if (guidance.action === 'refresh') return manager.refresh()
    if (guidance.action === 'engine') { setEngineReturn({ tab, selected: model.id }); setEngine(guidance.engineId); setTab('engines') }
  }
  const Library = tab === 'transfers' ? DownloadHistory : ModelLibrary
  return <main className="manager" data-ready="true">
    <nav className="manager-tabs page-content" aria-label="管理分类"><Tabs value={tab} onChange={value => { setTab(value); setSelected(''); manager.setNotice(null) }}><Tabs.List>{tabs.map(([id, title]) => <Tabs.Tab key={id} value={id} id={`${id}-tab`} aria-controls={`${id}-page`} rightSection={id === 'models' ? <span className="nav-count">{state.models.filter(model => modelInLibrary(model, state.resources, specifications)).length}</span> : undefined}>{title}</Tabs.Tab>)}</Tabs.List></Tabs><div className="manager-utilities">{legacyServices.length > 0 && <Button onClick={() => setTab('services')}>已有 API 连接</Button>}</div></nav>
    {!context.setSettingsHeaderActions && <div role="alert" className="compatibility-banner">当前宿主缺少模块标题操作能力，请更新 Lexora 后管理引擎和下载历史。</div>}
    {!state.supported && <div role="alert" className="compatibility-banner">{state.compatibilityMessage}</div>}
    {manager.notice && (!manager.notice.scope || manager.notice.scope === tab) && <div className={`manager-notice ${manager.notice.error ? 'is-error' : ''}`} role={manager.notice.error ? 'alert' : 'status'}><Icon name={manager.notice.error ? 'alert' : 'check'} size={16} /><span>{manager.notice.text}</span><Button icon="x" iconOnly size="small" aria-label="关闭提示" onClick={() => manager.setNotice(null)} /></div>}
    {downloadActive(state.job) && <div className="preparation-status" role="status"><span>{manager.pendingReason}</span><Button onClick={() => { if (state.job.modelId) { setSelected(''); setTab('transfers') } else { setEngineReturn({ tab, selected }); setEngine(state.job.resourceId); setTab('engines') } }}>查看当前任务</Button></div>}
    {manager.isPending('add-model') && <div className="background-job" role="status"><Loader size={16} /><span>正在校验模型目录和文件信息…</span><Button size="small" disabled={manager.isPending('cancel-preparation')} onClick={() => manager.run('cancel-preparation', {}, '已请求取消添加')}>取消添加</Button></div>}
    <div className="manager-page" id="discover-page" role="tabpanel" aria-labelledby="discover-tab" hidden={tab !== 'discover'}><Discovery context={context} manager={manager} onAdded={showModel} onImport={() => setModal({ kind: 'local-import' })} /></div>
    <div className="manager-page" id="models-page" role="tabpanel" aria-labelledby="models-tab" hidden={!['models', 'transfers'].includes(tab)}><Library key={`library-${libraryEpoch}-${tab === 'transfers'}`} visible={['models', 'transfers'].includes(tab)} onAction={modelAction} manager={manager} state={state} specifications={specifications} selected={selected} onSelect={setSelected} onDiscover={discover} onImport={() => setModal({ kind: 'local-import' })} onBack={() => { setSelected(''); setTab('models') }} renderDetail={(model, backButton) => <ModelDetail key={model.id} backButton={backButton} model={model} state={state} specifications={specifications} manager={manager} onImport={importModel} onAction={modelAction} onClear={model => setModal({ kind: 'clear', model })} onRemove={async model => { if (await manager.run('remove-record', { modelId: model.id }, '未完成的记录已移除')) setSelected('') }} onEngine={id => { setEngineReturn({ tab, selected: model.id }); setEngine(id); setTab('engines') }} />} /></div>
    {tab === 'engines' && <Engines state={state} specifications={specifications} manager={manager} selected={engine} onImport={importModel} onBack={() => { setSelected(engineReturn.selected); setTab(engineReturn.tab) }} />}
    {tab === 'services' && service && <section className="services-page page-content" aria-label="已有 API 连接"><h2>已有 API 连接</h2><p className="page-description">新增连接请到「模型服务」。</p><Tabs value={service.id} onChange={setServiceId}><Tabs.List aria-label="服务列表">{legacyServices.map(item => <Tabs.Tab key={item.id} value={item.id}>{item.title}</Tabs.Tab>)}</Tabs.List></Tabs><ServiceForm key={service.id} service={service} manager={manager} /></section>}
    {modal?.kind === 'local-import' && <LocalImportDialog context={context} manager={manager} onClose={() => setModal(null)} onCompleted={id => { setModal(null); setSelected(id); setLibraryEpoch(value => value + 1); setTab('models') }} />}
    {modal?.kind === 'import' && <ImportDialog {...modal} specifications={specifications} context={context} manager={manager} onClose={() => setModal(null)} />}
    {modal?.kind === 'clear' && <ClearDialog model={modal.model} manager={manager} onClose={() => setModal(null)} />}
  </main>
}

export async function render(context, container) {
  const [css, specifications] = await Promise.all([fetch('/__package/view.css').then(response => response.text()), fetch('/__package/resources.json').then(response => response.json())])
  if (context.signal.aborted) return
  const style = document.createElement('style'); style.textContent = css; container.append(style)
  const mount = document.createElement('div'); mount.className = 'local-models-root'; container.append(mount)
  const root = createRoot(mount)
  root.render(<InterfaceProvider context={context}><App context={context} specifications={specifications} /></InterfaceProvider>)
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; root.unmount(); mount.remove(); style.remove() }
  context.signal.addEventListener('abort', dispose, { once: true })
  return dispose
}
