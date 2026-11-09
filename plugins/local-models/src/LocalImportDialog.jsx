import React, { useId, useState } from 'react'
import { Modal, Progress, Stack, Text, TextInput } from '@mantine/core'
import { Button } from './ui'
import { Select } from './Select'
import { useDialogLifecycle } from './ResourceDialogs'
import { formatBytes, kindLabel } from './catalogPresentation'
import './dialogs.css'

export function LocalImportDialog({ context, manager, onClose, onCompleted }) {
  const dialog = useDialogLifecycle(onClose)
  const id = useId()
  const [choosing, setChoosing] = useState(false)
  const [inspection, setInspection] = useState(null)
  const [recipe, setRecipe] = useState('')
  const [selection, setSelection] = useState({})
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const candidate = inspection?.candidates.find(item => item.recipe === recipe)
  const job = manager.state.job?.kind === 'local-import' ? manager.state.job : null
  const importing = manager.isPending('import-local') || ['preparing', 'cancelling', 'committing'].includes(job?.state)
  const committing = importing && job?.state === 'committing'
  const cancelling = job?.state === 'cancelling' || manager.isPending('cancel-preparation')
  const disabled = choosing || manager.pending || importing || dialog.closing
  const progress = job?.progress
  const determinate = progress?.phase !== 'hashing' && progress?.totalBytes > 0
  const percent = determinate ? Math.max(0, Math.min(100, (progress.bytes ?? 0) / progress.totalBytes * 100)) : 0
  const canSubmit = !!candidate && !!title.trim() && !candidate.missing?.length && candidate.roles.every(role => role.optional || selection[role.id])
  const close = () => { if (!disabled) dialog.close() }
  const selectCandidate = (value, result = inspection) => {
    const item = result.candidates.find(item => item.recipe === value)
    setRecipe(value); setTitle(item.title)
    setSelection(Object.fromEntries(item.roles.map(role => [role.id, role.optional || role.choices.length !== 1 ? '' : role.choices[0].id])))
  }
  const choose = async (directory) => {
    if (disabled) return
    setChoosing(true); setError(''); manager.setNotice(null)
    try {
      let files
      if (directory) {
        const chosen = await context.resources.pickDirectory()
        if (!chosen) return
        files = await context.resources.scanDirectory(chosen)
      } else files = await context.resources.pickFiles({ multiple: true })
      if (!files?.length) return
      setInspection(null)
      const result = await manager.run('inspect-local', { resourceIds: files.map(file => file.id) }, '')
      if (result) { setInspection(result); selectCandidate(result.defaultRecipe, result) }
    } catch (error) { setError(error.message) }
    finally { setChoosing(false) }
  }
  const submit = async event => {
    event.preventDefault()
    if (disabled || !canSubmit) return
    const result = await manager.run('import-local', { token: inspection.token, recipe, selection, title: title.trim() }, '本地模型已导入')
    if (result) dialog.complete(() => onCompleted(result.modelId))
  }
  return <Modal opened={dialog.opened} onClose={close} onExitTransitionEnd={dialog.onExitTransitionEnd} title="导入本地模型" size={640} centered classNames={{ content: 'resource-dialog', header: 'resource-dialog-header', title: 'resource-dialog-title', body: 'resource-dialog-body' }} closeOnClickOutside={false} closeOnEscape={!disabled} closeButtonProps={{ 'aria-label': '关闭本地导入', disabled }} returnFocus trapFocus>
    <Stack gap="md">
      <Text size="sm" className="resource-dialog-copy">直接引用原文件；移动后需重新授权。</Text>
      <div className="resource-dialog-pickers"><Button data-autofocus appearance={candidate ? undefined : 'primary'} icon="hard-drive" disabled={disabled} onClick={() => choose(true)}>选择文件夹</Button><Button icon="file-up" disabled={disabled} onClick={() => choose(false)}>选择文件</Button></div>
      {manager.pending && !importing && !choosing && !manager.isPending('inspect-local') && <Text size="sm" role="status" className="resource-dialog-copy">{manager.pendingReason}</Text>}
      {(choosing || manager.isPending('inspect-local')) && <Text size="sm" role="status" className="resource-dialog-copy">正在读取文件信息…</Text>}
      {(error || manager.notice?.error) && <Text size="sm" role="alert" className="resource-dialog-error">{error || manager.notice.text}</Text>}
      {candidate && <form onSubmit={submit}>
        <Stack gap="md">
          <div className="resource-dialog-field">
            <label id={`${id}-recipe-label`} htmlFor={`${id}-recipe`}>模型用途</label>
            <Select id={`${id}-recipe`} aria-label="本地模型用途" value={recipe} disabled={disabled} onChange={selectCandidate} options={inspection.candidates.map(item => ({ value: item.recipe, label: kindLabel(item.recipe) }))} />
          </div>
          <TextInput label="模型名称" aria-label="本地模型名称" value={title} maxLength={80} disabled={disabled} onChange={event => setTitle(event.target.value)} classNames={{ label: 'resource-dialog-input-label', input: 'resource-dialog-input' }} />
          <Stack gap="md">{candidate.roles.map(role => <div key={role.id} className="resource-dialog-field">
            <label id={`${id}-${role.id}-label`} htmlFor={`${id}-${role.id}`}>{role.title}{role.optional ? '（可选）' : ''}</label>
            <Select id={`${id}-${role.id}`} aria-labelledby={`${id}-${role.id}-label`} value={selection[role.id] ?? ''} disabled={disabled} onChange={value => setSelection(previous => ({ ...previous, [role.id]: value }))} options={[{ value: '', label: role.optional ? '不使用' : '选择对应文件' }, ...role.choices.map(file => ({ value: file.id, label: `${file.path ?? file.name} · ${formatBytes(file.bytes)}` }))]} />
          </div>)}</Stack>
          {candidate.companionFiles?.length > 0 && <Text size="sm" className="resource-dialog-copy">包含 {candidate.companionFiles.length} 个必要配套文件，将一并引用。</Text>}
          {candidate.missing?.length > 0 && <Text size="sm" role="alert" className="resource-dialog-error">缺少：{candidate.missing.join('、')}。请补齐后重新选择文件夹。</Text>}
          {candidate.warnings?.map(message => <Text size="sm" key={message} className="resource-dialog-copy">{message}</Text>)}
          <Text size="sm" className="resource-dialog-copy">原始来源未知，校验仅验证文件完整性。</Text>
          {importing && <Stack gap="xs" className="resource-dialog-progress" role="status">
            {determinate
              ? <Progress value={percent} color="var(--accent)" size="sm" aria-label="本地模型导入进度" classNames={{ root: 'resource-dialog-progress-track' }} />
              : <Progress.Root size="sm" role="progressbar" aria-label="本地模型导入进度" classNames={{ root: 'resource-dialog-progress-track' }}><Progress.Section value={100} animated withAria={false} color="var(--accent)" /></Progress.Root>}
            <Text size="sm" className="resource-dialog-copy">{committing ? '正在保存模型…' : cancelling ? '正在取消导入…' : `正在校验并引用文件${progress?.path ? ` · ${progress.path}` : ''}`}</Text>
          </Stack>}
          <div className="resource-dialog-actions">{importing ? <Button disabled={committing || cancelling || dialog.closing} onClick={() => manager.run('cancel-preparation', {}, '已请求取消导入')}>取消导入</Button> : <><Button disabled={disabled} onClick={close}>取消</Button><Button type="submit" appearance="primary" disabled={disabled || !canSubmit}>确认导入</Button></>}</div>
        </Stack>
      </form>}
      {!candidate && <div className="resource-dialog-actions"><Button disabled={disabled} onClick={close}>取消</Button></div>}
    </Stack>
  </Modal>
}
