import React, { useId, useState } from 'react'
import { Modal, Stack, Text } from '@mantine/core'
import { isEngineFile } from '../engineImport.js'
import { Button } from './ui'
import { Select } from './Select'
import { useDialogLifecycle } from './ResourceDialogs'
import { DownloadProgress } from './DownloadProgress'
import { downloadActive } from './downloadPresentation'
import './dialogs.css'

const backends = { 'linux-x64': ['cpu', 'vulkan', 'cuda'], 'windows-x64': ['cpu', 'vulkan', 'cuda'], 'macos-arm64': ['cpu', 'metal'] }
const backendLabels = { cpu: 'CPU', vulkan: 'Vulkan', cuda: 'CUDA', metal: 'Metal' }

export function EngineImportDialog({ context, manager, initialBackend = '', onClose, onCompleted }) {
  const dialog = useDialogLifecycle(onClose)
  const id = useId()
  const platform = manager.state.environment?.platform
  const choices = backends[platform] ?? []
  const [backend, setBackend] = useState(choices.includes(initialBackend) ? initialBackend : '')
  const [files, setFiles] = useState([])
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const job = manager.state.job?.kind === 'engine-import' ? manager.state.job : null
  const importing = manager.isPending('import-engine') || downloadActive(job)
  const disabled = choosing || manager.pending || importing || dialog.closing || !manager.state.supported
  const close = () => { if (!choosing && !manager.pending && !importing && !dialog.closing) dialog.close() }
  const choose = async directory => {
    if (disabled) return
    setChoosing(true); setError(''); manager.setNotice(null)
    try {
      let selected
      if (directory) {
        const folder = await context.resources.pickDirectory()
        if (!folder || context.signal.aborted) return
        selected = await context.resources.scanDirectory(folder, { recursive: false })
      } else selected = await context.resources.pickFiles({ multiple: true })
      if (context.signal.aborted || (!directory && !selected?.length)) return
      const candidates = (selected ?? []).filter(file => isEngineFile(file.name, platform))
      setFiles(candidates)
      if (!candidates.length) setError('所选位置没有当前平台的 llama-server 或动态库，请重新选择。')
    } catch (error) { if (!context.signal.aborted) setError(error.message) }
    finally { if (!context.signal.aborted) setChoosing(false) }
  }
  const submit = async event => {
    event.preventDefault()
    if (disabled || !files.length || !choices.includes(backend)) return
    setError('')
    const result = await manager.run('import-engine', { resourceIds: files.map(file => file.id), backend }, '引擎已导入', 'engines')
    if (result && !context.signal.aborted) dialog.complete(() => onCompleted(result.resourceId))
  }
  return <Modal opened={dialog.opened} onClose={close} onExitTransitionEnd={dialog.onExitTransitionEnd} title="使用已有引擎" size={560} centered classNames={{ content: 'resource-dialog', header: 'resource-dialog-header', title: 'resource-dialog-title', body: 'resource-dialog-body' }} closeOnClickOutside={false} closeOnEscape={!disabled} closeButtonProps={{ 'aria-label': '关闭引擎导入', disabled }} returnFocus trapFocus>
    <form onSubmit={submit}><Stack gap="md">
      <Text size="sm" className="resource-dialog-copy">选择 llama-server 与配套动态库；只运行可信引擎，原文件保留。导入后可在引擎页选用，不会切换当前版本。</Text>
      <div className="resource-dialog-field">
        <label id={`${id}-backend-label`} htmlFor={`${id}-backend`}>引擎后端</label>
        <Select id={`${id}-backend`} aria-labelledby={`${id}-backend-label`} aria-describedby={`${id}-backend-help`} value={backend} disabled={disabled} placeholder="选择实际构建的后端" onChange={setBackend} options={choices.map(value => ({ value, label: backendLabels[value] }))} />
        <Text id={`${id}-backend-help`} size="sm" className="resource-dialog-copy">须与引擎的实际构建一致，不会自动识别 GPU 后端。</Text>
      </div>
      <div className="resource-dialog-pickers"><Button icon="hard-drive" disabled={disabled || !choices.length} onClick={() => choose(true)}>选择文件夹</Button><Button icon="file-up" disabled={disabled || !choices.length} onClick={() => choose(false)}>选择文件</Button></div>
      {files.length > 0 && <div className="resource-dialog-files" aria-label="已选择的引擎文件">{files.map(file => <Text size="sm" className="resource-dialog-file-name" key={file.id}>{file.name}</Text>)}</div>}
      {choosing && <Text size="sm" role="status" className="resource-dialog-copy">正在读取文件信息…</Text>}
      {manager.pending && !importing && !choosing && <Text size="sm" role="status" className="resource-dialog-copy">{manager.pendingReason}</Text>}
      {(error || manager.notice?.error) && <Text size="sm" role="alert" className="resource-dialog-error">{error || manager.notice.text}</Text>}
      {importing && (job ? <DownloadProgress job={job} /> : <Text size="sm" role="status">正在准备导入…</Text>)}
      <div className="resource-dialog-actions">{importing ? <Button disabled={job?.state !== 'preparing' || manager.isPending('cancel-preparation') || dialog.closing} onClick={() => manager.run('cancel-preparation', {}, '已请求取消导入', 'engines')}>取消导入</Button> : <><Button disabled={choosing || manager.pending || dialog.closing} onClick={close}>取消</Button><Button type="submit" appearance="primary" disabled={disabled || !files.length || !choices.includes(backend)}>导入</Button></>}</div>
    </Stack></form>
  </Modal>
}
