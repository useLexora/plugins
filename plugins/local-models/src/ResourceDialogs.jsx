import React, { useEffect, useId, useRef, useState } from 'react'
import { Modal, Stack, Text } from '@mantine/core'
import { groupGgufFiles } from '../modelFileGroups.js'
import { zImageTurbo } from '../native/image/recipes.mjs'
import { Button } from './ui'
import { Select } from './Select'
import './dialogs.css'

export function useDialogLifecycle(onClose) {
  const [opened, setOpened] = useState(false)
  const [closing, setClosing] = useState(false)
  const afterClose = useRef(onClose)
  useEffect(() => { setOpened(true) }, [])
  const complete = callback => {
    afterClose.current = callback
    setClosing(true)
    setOpened(false)
  }
  return {
    opened,
    closing,
    close: () => complete(onClose),
    complete,
    onExitTransitionEnd: () => { if (closing) afterClose.current() },
  }
}

const modalClasses = {
  content: 'resource-dialog',
  header: 'resource-dialog-header',
  title: 'resource-dialog-title',
  body: 'resource-dialog-body',
}

export function ImportDialog({ model, specification, specifications, context, manager, onClose }) {
  const dialog = useDialogLifecycle(onClose)
  const labelId = useId()
  const [resourceId, setResourceId] = useState(specification?.id ?? model.resources.find(id => specifications.find(spec => spec.id === id)?.kind === 'model'))
  const [selected, setSelected] = useState({})
  const [choosing, setChoosing] = useState(false)
  const resource = specifications.find(spec => spec.id === resourceId)
  const entries = resource.archives ?? resource.files
  const splitModel = !resource.archives && groupGgufFiles(resource.files).some(file => file.parts?.length > 1)
  const directDirectory = !specification && !resource.archives && (model.imageArchitecture === zImageTurbo.architecture || entries.every(file => file.source === file.path))
  const disabled = choosing || manager.pending || dialog.closing
  const ready = entries.every(entry => selected[entry.id ?? entry.path])
  const close = () => { if (!disabled) dialog.close() }
  const pick = async (entry) => {
    if (disabled) return
    setChoosing(true)
    try {
      const files = await context.resources.pickFiles({ multiple: false })
      if (files?.[0]) setSelected(previous => ({ ...previous, [entry.id ?? entry.path]: files[0] }))
    } catch (error) { manager.setNotice({ error: true, text: error.message }) }
    finally { setChoosing(false) }
  }
  const directory = async () => {
    if (disabled) return
    setChoosing(true)
    try {
      const value = await context.resources.pickDirectory()
      if (!value) return
      dialog.close()
      await manager.run('prepare', { modelId: model.id, mode: 'directory', directoryId: value.id, ...(directDirectory ? { scope: 'model' } : {}) }, '目录中的资源已校验并引用')
    } catch (error) { manager.setNotice({ error: true, text: error.message }) }
    finally { setChoosing(false) }
  }
  const submit = () => {
    if (disabled || !ready) return
    dialog.close()
    void manager.run('prepare', { ...(model ? { modelId: model.id } : {}), resourceId, mode: 'file', [resource.archives ? 'archives' : 'files']: entries.map(entry => ({ id: entry.id ?? entry.path, resourceId: selected[entry.id ?? entry.path].id })) }, '文件已校验并导入')
  }
  return <Modal opened={dialog.opened} onClose={close} onExitTransitionEnd={dialog.onExitTransitionEnd} title={`导入 ${specification ? '引擎' : model.title}`} size={560} centered classNames={modalClasses} closeOnClickOutside={false} closeOnEscape={!disabled} closeButtonProps={{ 'aria-label': '关闭导入', disabled }} returnFocus trapFocus>
    <Stack gap="md">
      {manager.pending && <Text size="sm" role="status" className="resource-dialog-copy">{manager.pendingReason}</Text>}
      <div className="resource-dialog-field">
        <label id={labelId} htmlFor={`${labelId}-input`}>资源</label>
        <Select id={`${labelId}-input`} aria-labelledby={labelId} value={resourceId} disabled={!!specification || disabled} onChange={value => { setResourceId(value); setSelected({}) }} options={(specification ? [specification.id] : model.resources.filter(id => specifications.find(spec => spec.id === id)?.kind === 'model')).map(id => ({ value: id, label: specifications.find(spec => spec.id === id)?.title ?? id }))} />
      </div>
      {!specification && !model.bundle && <Stack gap="sm" align="flex-start">
        <Text size="sm" className="resource-dialog-copy">{directDirectory ? '优先选择包含下方文件的模型文件夹，直接引用已有文件，无需重新下载。也可以在下方逐个选择。' : '已有完整资源目录？可直接选择，或在下方逐个导入文件。'}</Text>
        <Button appearance={Object.keys(selected).length ? undefined : 'primary'} icon="hard-drive" disabled={disabled} onClick={directory}>{directDirectory ? '选择模型文件夹' : '选择完整资源目录'}</Button>
      </Stack>}
      <div className="resource-dialog-files">{entries.map(entry => <div className="resource-dialog-file" key={entry.id ?? entry.path}>
        <Text size="sm" className="resource-dialog-file-name">{entry.name ?? entry.path ?? entry.id}</Text>
        <Button className="resource-dialog-file-picker" disabled={disabled} onClick={() => pick(entry)} icon={selected[entry.id ?? entry.path] ? 'check' : 'file-up'} title={selected[entry.id ?? entry.path]?.name}><span className="resource-dialog-file-selection">{selected[entry.id ?? entry.path]?.name ?? '选择文件'}</span></Button>
      </div>)}</div>
      <Text size="sm" className="resource-dialog-copy">{splitModel ? '逐片导入会复制到模型目录并恢复分片命名，不改动原文件。若分片已按原名放在同一文件夹，可选择模型文件夹直接引用，避免复制。' : '版本与校验值须匹配。模型文件直接引用，压缩包解压到插件目录。'}</Text>
      <div className="resource-dialog-actions"><Button disabled={disabled} onClick={close}>取消</Button><Button appearance={ready ? 'primary' : undefined} disabled={disabled || !ready} onClick={submit}>导入</Button></div>
    </Stack>
  </Modal>
}

export function ClearDialog({ model, manager, onClose }) {
  const dialog = useDialogLifecycle(onClose)
  return <Modal opened={dialog.opened} onClose={dialog.close} onExitTransitionEnd={dialog.onExitTransitionEnd} title={`清理 ${model.title}？`} size={480} centered classNames={modalClasses} closeOnClickOutside={false} withCloseButton={false} returnFocus trapFocus>
    <Stack gap="md">
      <Text size="sm" className="resource-dialog-copy">停止模型并清理插件管理的模型文件。已安装的引擎和手动引用的原文件都会保留。</Text>
      <div className="resource-dialog-actions"><Button data-autofocus disabled={dialog.closing} onClick={dialog.close}>取消</Button><Button appearance="danger" disabled={dialog.closing} onClick={() => { dialog.close(); void manager.run('clear', { modelId: model.id }, '模型资源已清理，共享资源和原文件已保留') }}>清理资源</Button></div>
    </Stack>
  </Modal>
}

export function RemoveCredentialDialog({ service, manager, onClose }) {
  const dialog = useDialogLifecycle(onClose)
  return <Modal opened={dialog.opened} onClose={dialog.close} onExitTransitionEnd={dialog.onExitTransitionEnd} title="移除 API Key？" size={480} centered classNames={modalClasses} closeOnClickOutside={false} withCloseButton={false} returnFocus trapFocus>
    <Stack gap="md">
      <Text size="sm" className="resource-dialog-copy">移除后，{service.title}将停止调用。下次使用时需要重新填写密钥。</Text>
      <div className="resource-dialog-actions"><Button data-autofocus disabled={dialog.closing} onClick={dialog.close}>取消</Button><Button appearance="danger" disabled={dialog.closing} onClick={() => { dialog.close(); void manager.run('remove-credential', { serviceId: service.id }, '密钥已移除') }}>移除密钥</Button></div>
    </Stack>
  </Modal>
}
