import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Key, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App, Alert, Button, Drawer, Dropdown, Form, Input, Modal, Select, Table, Tag, Tooltip, type TableColumnsType, type MenuProps } from 'antd'
import { OfficeTheme } from './office-theme'
import { ClockCircleOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FolderOpenOutlined, HistoryOutlined, InboxOutlined, EllipsisOutlined, SearchOutlined, StarFilled, StarOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons'
import type { EditableDocument } from './lexora'
import { fileName, kindOf, KIND_LABEL, type OfficeDocument, type OfficeKind } from './office-library'
import { dateLabel, sizeLabel } from './office-ui'
import { OfficeFileBadge } from './office-home-icons'

export interface LibraryActions {
  pick(): Promise<void>
  resume(doc: EditableDocument): Promise<void>
  forget(doc: EditableDocument): Promise<void>
  open(doc: OfficeDocument): Promise<void>
  create(kind: OfficeKind, name?: string): Promise<void>
  import(): Promise<void>
  mutate(action: string, doc: OfficeDocument, extra?: Record<string, string | number | boolean>): Promise<void>
  export(doc: OfficeDocument, versionId?: string): Promise<void>
  run(action: () => Promise<void>): void
}

const scopes = [
  { id: 'all', label: '文档库', icon: <FolderOpenOutlined aria-hidden="true" /> },
  { id: 'local', label: '本地文件', icon: <FolderOpenOutlined aria-hidden="true" /> },
  { id: 'recent', label: '最近使用', icon: <ClockCircleOutlined aria-hidden="true" /> },
  { id: 'favorite', label: '我的收藏', icon: <StarOutlined aria-hidden="true" /> },
  { id: 'trash', label: '回收站', icon: <DeleteOutlined aria-hidden="true" /> },
] as const
const kinds = Object.keys(KIND_LABEL) as OfficeKind[]
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
type NamePrompt = { kind: OfficeKind; doc?: OfficeDocument }
type Confirmation = { title: string; description: string; confirm: string; danger?: boolean; perform(): Promise<void> }

function LibraryDropdown({ items, children }: { items: MenuProps['items']; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLSpanElement>(null)
  const focusFrame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  return <span className="office-menu-trigger" ref={trigger} onKeyDownCapture={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false)
      cancelAnimationFrame(focusFrame.current)
      focusFrame.current = requestAnimationFrame(() => trigger.current?.querySelector('button')?.focus({ preventScroll: true }))
    }
  }}><Dropdown autoFocus trigger={['click']} open={open} onOpenChange={setOpen} menu={{ items, onClick: ({ domEvent }) => { domEvent.preventDefault(); setOpen(false) } }}>{children}</Dropdown></span>
}


function Library({ documents, recent, actions, host, loading }: { documents: OfficeDocument[]; recent: EditableDocument[]; actions: LibraryActions; host: HTMLElement; loading: boolean }) {
  const { message } = App.useApp()
  const [scope, setScope] = useState<string>('all')
  const [greeting] = useState(() => { const hour = new Date().getHours(); return hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。' })
  const [kind, setKind] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('updated')
  const [selection, setSelection] = useState<Key[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const busy = useRef(new Set<string>())
  const [namePrompt, setNamePrompt] = useState<NamePrompt>()
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [confirmError, setConfirmError] = useState('')
  const [versionId, setVersionId] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(800)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(entries => { if (entries[0].contentRect.width > 0) setWidth(Math.round(entries[0].contentRect.width)) })
    if (main.current) observer.observe(main.current)
    return () => observer.disconnect()
  }, [])
  const searchRef = useRef<import('antd').InputRef>(null)
  const filtered = useMemo(() => documents.filter(doc =>
    (scope === 'trash' ? doc.trashedAt !== null : doc.trashedAt === null)
    && (scope !== 'favorite' || doc.favorite) && (kind === 'all' || doc.kind === kind)
    && doc.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => scope === 'recent' || sort === 'opened' ? b.openedAt - a.openedAt : sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'size' ? b.versions[0].file.size - a.versions[0].file.size : b.updatedAt - a.updatedAt), [documents, scope, kind, query, sort])
  const local = scope === 'local'
  const localFiles = useMemo(() => recent.filter(doc => (kind === 'all' || kindOf(doc.name) === kind)
    && doc.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'size' ? b.size - a.size : b.openedAt - a.openedAt), [recent, kind, query, sort])
  const count = local ? localFiles.length : filtered.length
  const totalSize = local ? localFiles.reduce((sum, doc) => sum + doc.size, 0) : filtered.reduce((sum, doc) => sum + doc.versions[0].file.size, 0)
  const picked = filtered.filter(doc => selection.includes(doc.id))
  const versionDocument = documents.find(doc => doc.id === versionId)
  useEffect(() => { if (versionId && !versionDocument) setVersionId(undefined) }, [versionId, versionDocument])
  useEffect(() => {
    const ids = new Set(filtered.map(doc => doc.id))
    setSelection(previous => previous.every(id => ids.has(String(id))) ? previous : previous.filter(id => ids.has(String(id))))
  }, [filtered])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!host.hidden && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !namePrompt && !confirmation && !versionId) {
        event.preventDefault(); event.stopPropagation(); searchRef.current?.focus({ cursor: 'all' })
      }
    }
    host.addEventListener('keydown', handle)
    return () => host.removeEventListener('keydown', handle)
  }, [host, namePrompt, confirmation, versionId])
  const execute = async (key: string, action: () => Promise<void>, success?: string, onError?: (error: string) => void) => {
    if (busy.current.has(key)) return
    busy.current.add(key); setPending(new Set(busy.current))
    try { await action(); if (success) void message.success(success) }
    catch (error) { if (onError) onError(errorText(error)); else void message.error(errorText(error)) }
    finally { busy.current.delete(key); setPending(new Set(busy.current)) }
  }
  const changeScope = (next: string) => { setScope(next); setSelection([]); scroller.current?.scrollTo(0, 0) }
  const promptName = (prompt: NamePrompt) => { setNamePrompt(prompt); setName(prompt.doc ? prompt.doc.name.replace(/\.[^.]+$/, '') : `未命名${KIND_LABEL[prompt.kind]}`); setNameError('') }
  const submitName = () => {
    if (!namePrompt) return
    void execute('name', async () => {
      fileName(name, namePrompt.kind)
      if (namePrompt.doc) await actions.mutate('rename', namePrompt.doc, { name })
      else await actions.create(namePrompt.kind, name)
      setNamePrompt(undefined)
    }, namePrompt.doc ? '已重命名' : undefined, setNameError)
  }
  const confirm = (value: Confirmation) => { setConfirmError(''); setConfirmation(value) }
  const batch = async (docs: OfficeDocument[], action: string, extra?: Record<string, string | number | boolean>) => {
    const failed: OfficeDocument[] = []
    const errors: string[] = []
    for (const doc of docs) {
      try { await actions.mutate(action, doc, extra) }
      catch (error) { failed.push(doc); errors.push(`${doc.name}：${errorText(error)}`) }
    }
    setSelection(failed.map(doc => doc.id))
    return { failed, error: failed.length ? `已完成 ${docs.length - failed.length} 个，${failed.length} 个未完成。${errors.join('；')}` : '' }
  }
  const batchSelected = async (action: string, extra?: Record<string, string | number | boolean>) => {
    const result = await batch(picked, action, extra)
    if (result.error) throw new Error(result.error)
  }
  const remove = (docs: OfficeDocument[], permanent = false) => {
    let remaining = docs
    confirm({
      title: permanent ? '彻底删除文件？' : '移入回收站？', confirm: permanent ? '彻底删除' : '移入回收站', danger: true,
      description: permanent ? `将彻底删除 ${docs.length} 个文件及其历史版本，此操作无法撤销。` : `将 ${docs.length} 个文件移入回收站。需要时可以恢复文件及其历史版本。`,
      async perform() {
        const result = await batch(remaining, permanent ? 'delete' : 'trash')
        remaining = result.failed
        if (result.error) throw new Error(`${result.error} 重试只处理未完成的文件。`)
      },
    })
  }
  const rowMenu = (doc: OfficeDocument) => doc.trashedAt !== null ? [
    { key: 'delete', label: '彻底删除', icon: <DeleteOutlined aria-hidden="true" />, danger: true, onClick: () => remove([doc], true) },
  ] : [
    { key: 'rename', label: '重命名', icon: <EditOutlined aria-hidden="true" />, onClick: () => promptName({ kind: doc.kind, doc }) },
    { key: 'duplicate', label: '复制', icon: <CopyOutlined aria-hidden="true" />, onClick: () => void execute(doc.id, () => actions.mutate('duplicate', doc), '已创建副本') },
    { key: 'export', label: '导出', icon: <DownloadOutlined aria-hidden="true" />, onClick: () => void execute(doc.id, () => actions.export(doc)) },
    { type: 'divider' as const },
    { key: 'versions', label: '版本', icon: <HistoryOutlined aria-hidden="true" />, onClick: () => setVersionId(doc.id) },
    { type: 'divider' as const },
    { key: 'trash', label: '移入回收站', icon: <DeleteOutlined aria-hidden="true" />, danger: true, onClick: () => remove([doc]) },
  ]
  const resetFilters = () => { setQuery(''); setKind('all'); setSelection([]) }
  const hasFilter = Boolean(query.trim()) || kind !== 'all'
  const empty = <div className="office-empty">
    <span className="office-empty-mark" aria-hidden="true">{scope === 'trash' ? <DeleteOutlined aria-hidden="true" /> : hasFilter ? <SearchOutlined aria-hidden="true" /> : <InboxOutlined aria-hidden="true" />}</span>
    <h2>{hasFilter ? '没有找到文件' : local ? '还没有打开过本地文件' : scope === 'trash' ? '回收站是空的' : scope === 'favorite' ? '还没有收藏文件' : '从一份文件开始'}</h2>
    <p>{hasFilter ? '试试其他名称，或清除当前筛选。' : local ? '打开已有文件，直接在原位置编辑和保存。' : scope === 'trash' ? '删除的文件会保留在这里，直到你彻底删除。' : scope === 'favorite' ? '点击文件旁的星标，把常用文件留在这里。' : '创建文档、表格、演示文稿，或将已有文件导入文档库。'}</p>
    {hasFilter ? <Button onClick={resetFilters}>清除筛选</Button> : local ? <Button icon={<FolderOpenOutlined aria-hidden="true" />} loading={pending.has('pick')} onClick={() => void execute('pick', actions.pick)}>打开本地文件</Button> : scope === 'all' || scope === 'recent' ? <Button aria-label="导入文件" icon={<UploadOutlined aria-hidden="true" />} loading={pending.has('import')} onClick={() => void execute('import', actions.import)}>导入文档库</Button> : null}
  </div>
  return <div className="office-library">
    <main ref={main} className="office-library-main">
      <header className="office-home-hero"><h1>{greeting}<span>有什么想做的吗？</span></h1></header>
      <section className="office-quick-cards" aria-label="创建或打开文件">
        {kinds.map(item => <button type="button" className="office-quick-card" key={item} aria-label={`新建${KIND_LABEL[item]}`} onClick={() => promptName({ kind: item })}>
          <OfficeFileBadge kind={item} size={34} /><span className="office-quick-copy"><strong>{KIND_LABEL[item]}</strong><span>.{item}</span></span>
        </button>)}
        <button type="button" className="office-quick-card office-import-card" aria-label="打开本地文件" aria-busy={pending.has('pick')} disabled={pending.has('pick')} onClick={() => void execute('pick', actions.pick)}>
          <span className="office-import-mark"><FolderOpenOutlined aria-hidden="true" /></span><span className="office-quick-copy"><strong>{pending.has('pick') ? '正在打开…' : '打开本地文件'}</strong><span>在原位置编辑和保存</span></span>
        </button>
      </section>
      <div className="office-library-navigation">
        <nav aria-label="文档库导航">{scopes.map(item => <button type="button" className="office-nav-item" key={item.id} aria-current={scope === item.id ? 'page' : undefined} onClick={() => changeScope(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
        <Input ref={searchRef} className="office-search" prefix={<SearchOutlined aria-hidden="true" />} allowClear placeholder="搜索文件名称" aria-label="搜索文件" value={query} onChange={event => { setQuery(event.target.value); setSelection([]) }} />
      </div>
      <div className="office-library-tools">
        <div className="office-type-filters" role="group" aria-label="文件类型">{[['all', '全部'], ...Object.entries(KIND_LABEL)].map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => { setKind(id); setSelection([]) }}>{label}</button>)}</div>
        <div className="office-list-order">{!local && scope !== 'trash' && <Button size="small" type="text" aria-label="导入文件" icon={<UploadOutlined aria-hidden="true" />} loading={pending.has('import')} onClick={() => void execute('import', actions.import)}>导入文档库</Button>}<Select variant="borderless" className="office-sort" aria-label="排序方式" value={scope === 'recent' ? 'opened' : sort} onChange={value => { setSort(value); if (scope === 'recent') setScope('all') }} options={[{ value: 'updated', label: local ? '最近打开' : '最近修改' }, { value: 'opened', label: '最近打开' }, { value: 'name', label: '名称' }, { value: 'size', label: '文件大小' }]} /><span>{count} 个文件</span></div>
      </div>
      <div className={`office-selection-bar ${picked.length ? 'has-selection' : ''}`}>
        {picked.length ? <><strong>已选择 {picked.length} 个文件</strong><div className="office-actions">{scope === 'trash' ? <Button size="small" icon={<UndoOutlined aria-hidden="true" />} loading={pending.has('batch')} onClick={() => void execute('batch', () => batchSelected('restore'), '已恢复所选文件')}>恢复所选</Button> : <Button size="small" icon={<StarOutlined aria-hidden="true" />} loading={pending.has('batch')} onClick={() => void execute('batch', () => batchSelected('favorite', { value: true }), '已收藏所选文件')}>收藏所选</Button>}
          <Button size="small" danger icon={<DeleteOutlined aria-hidden="true" />} disabled={pending.has('batch')} onClick={() => remove(picked, scope === 'trash')}>{scope === 'trash' ? '彻底删除' : '移入回收站'}</Button><Button type="text" size="small" onClick={() => setSelection([])}>取消选择</Button></div></> : hasFilter ? <><span>{count} 个文件符合筛选</span><Button type="text" size="small" onClick={resetFilters}>清除筛选</Button></> : null}
      </div>
      <div className="office-table-area" ref={scroller}>
        {local ? <Table<EditableDocument> className="office-file-table" rowKey="id" tableLayout="fixed" pagination={false} dataSource={localFiles} loading={loading} locale={{ emptyText: empty }}
          onRow={doc => ({ 'data-document-id': doc.id, onDoubleClick: event => { if (!(event.target as HTMLElement).closest('button')) void execute(doc.id, () => actions.resume(doc)) } })}
          columns={([
            { title: '文件名称', key: 'name', render: (_, doc) => <div className="office-file-identity"><OfficeFileBadge kind={kindOf(doc.name)} size={26} /><div className="office-file-label"><button type="button" className="office-file-name" title={doc.name} disabled={pending.has(doc.id)} onClick={() => void execute(doc.id, () => actions.resume(doc))}>{doc.name}</button><span className="office-local-location" title={doc.location}>{doc.location}{doc.recovery ? ' · 有恢复草稿' : ''}</span></div></div> },
            { title: '最近打开', key: 'opened', width: 140, render: (_, doc) => <time>{dateLabel(doc.openedAt)}</time> },
            { title: '大小', key: 'size', width: 88, render: (_, doc) => sizeLabel(doc.size) },
            { title: '操作', key: 'actions', width: 100, className: 'office-row-actions', render: (_, doc) => <div className="office-row-buttons"><Button type="text" size="small" loading={pending.has(doc.id)} onClick={() => void execute(doc.id, () => actions.resume(doc))}>打开</Button><LibraryDropdown items={[{ key: 'forget', label: '移除记录', disabled: doc.recovery, onClick: () => void execute(doc.id, () => actions.forget(doc)) }]}><Button type="text" size="small" aria-label="更多操作" disabled={pending.has(doc.id)} icon={<EllipsisOutlined aria-hidden="true" />} /></LibraryDropdown></div> },
          ] satisfies TableColumnsType<EditableDocument>).filter(column => (column.key !== 'size' || width > 670) && (column.key !== 'opened' || width > 510))} /> :
        <Table<OfficeDocument> className="office-file-table" rowKey="id" tableLayout="fixed" pagination={false} dataSource={filtered} loading={loading} locale={{ emptyText: empty }}
          rowSelection={{ selectedRowKeys: selection, onChange: keys => setSelection(keys), columnWidth: 40, columnTitle: undefined, getTitleCheckboxProps: () => ({ 'aria-label': '选择所有文件' }), getCheckboxProps: doc => ({ 'aria-label': `选择 ${doc.name}`, disabled: pending.has(doc.id) }) }}
          onRow={doc => ({ 'data-document-id': doc.id, onDoubleClick: event => { if (doc.trashedAt === null && !(event.target as HTMLElement).closest('button,input')) void execute(doc.id, () => actions.open(doc)) } })}
          columns={([
            { title: '文件名称', key: 'name', render: (_, doc) => <div className="office-file-identity"><OfficeFileBadge kind={doc.kind} size={26} /><div className="office-file-label">{scope === 'trash' ? <strong title={doc.name}>{doc.name}</strong> : <button type="button" className="office-file-name" title={doc.name} disabled={pending.has(doc.id)} onClick={() => void execute(doc.id, () => actions.open(doc))}>{doc.name}</button>}<span className="office-mobile-size">{sizeLabel(doc.versions[0].file.size)}</span></div></div> },
            { title: scope === 'trash' ? '删除时间' : '修改时间', key: 'updated', width: 140, className: 'office-column-date', render: (_, doc) => <time title={new Date(scope === 'trash' ? doc.trashedAt! : doc.updatedAt).toLocaleString('zh-CN')}>{dateLabel(scope === 'trash' ? doc.trashedAt! : doc.updatedAt)}</time> },
            { title: '大小', key: 'size', width: 88, className: 'office-column-size', render: (_, doc) => sizeLabel(doc.versions[0].file.size) },
            { title: '操作', key: 'actions', width: 140, className: 'office-row-actions', render: (_, doc) => <div className="office-row-buttons">{scope === 'trash' ? <Button aria-label="恢复" type="text" size="small" loading={pending.has(doc.id)} onClick={() => void execute(doc.id, () => actions.mutate('restore', doc), '已恢复文件')}>恢复</Button> : <><Button aria-label="打开" aria-busy={pending.has(doc.id)} type="text" size="small" loading={pending.has(doc.id)} onClick={() => void execute(doc.id, () => actions.open(doc))}>打开</Button><Tooltip title={doc.favorite ? '取消收藏' : '收藏'}><Button type="text" size="small" className={doc.favorite ? 'office-star-active' : ''} aria-label={doc.favorite ? '取消收藏' : '收藏'} disabled={pending.has(doc.id)} icon={doc.favorite ? <StarFilled aria-hidden="true" /> : <StarOutlined aria-hidden="true" />} onClick={() => void execute(doc.id, () => actions.mutate('favorite', doc, { value: !doc.favorite }))} /></Tooltip></>}
              <LibraryDropdown items={rowMenu(doc)}><Button type="text" size="small" aria-label="更多操作" disabled={pending.has(doc.id)} icon={<EllipsisOutlined aria-hidden="true" />} /></LibraryDropdown></div> },
          ] satisfies TableColumnsType<OfficeDocument>).filter(column => (column.key !== 'size' || width > 670) && (column.key !== 'updated' || width > 510))} />}
      </div>
      <footer className="office-library-footer"><span>{sizeLabel(totalSize)} · {count} 个文件</span><span>{local ? '保存时更新原文件' : '自动保存到文档库 · 保留最近 12 个版本'}</span></footer>
    </main>
    <Modal title={namePrompt?.doc ? '重命名' : `新建${KIND_LABEL[namePrompt?.kind ?? 'docx']}`} open={Boolean(namePrompt)} getContainer={() => host} destroyOnHidden onCancel={() => { if (!pending.has('name')) setNamePrompt(undefined) }} onOk={submitName} confirmLoading={pending.has('name')} okText={namePrompt?.doc ? '保存名称' : '创建'} cancelText="取消" cancelButtonProps={{ disabled: pending.has('name') }} maskClosable={!pending.has('name')} keyboard={!pending.has('name')} afterOpenChange={open => { if (open) host.querySelector<HTMLInputElement>('#office-file-name')?.select() }}>
      <p className="office-form-description">{namePrompt?.doc ? '修改文档库中的名称，文件内容和版本保持不变。' : '文件会自动保存到文档库。'}</p>
      <Form layout="vertical" onFinish={submitName}><Form.Item label="文件名称" htmlFor="office-file-name" validateStatus={nameError ? 'error' : undefined} help={nameError || '最多 100 个字符，不包含路径或特殊字符。'}><Input id="office-file-name" value={name} disabled={pending.has('name')} maxLength={105} suffix={`.${namePrompt?.kind ?? ''}`} onChange={event => { setName(event.target.value); setNameError('') }} onPressEnter={event => { event.preventDefault(); submitName() }} /></Form.Item></Form>
    </Modal>
    <Modal title={confirmation?.title} open={Boolean(confirmation)} getContainer={() => host} destroyOnHidden onCancel={() => { if (!pending.has('confirm')) setConfirmation(undefined) }} okText={confirmation?.confirm} cancelText="取消" okButtonProps={{ danger: confirmation?.danger }} confirmLoading={pending.has('confirm')} cancelButtonProps={{ disabled: pending.has('confirm') }} keyboard={!pending.has('confirm')} maskClosable={!pending.has('confirm')} onOk={() => void execute('confirm', async () => { await confirmation?.perform(); setConfirmation(undefined) }, undefined, setConfirmError)}>
      <p className="office-form-description">{confirmation?.description}</p>{confirmError && <Alert type="error" title={confirmError} showIcon />}
    </Modal>
    <Drawer title="版本历史" open={Boolean(versionId && versionDocument)} onClose={() => setVersionId(undefined)} getContainer={() => host} rootStyle={{ position: 'absolute' }} size={440} destroyOnHidden>
      {versionDocument && <><div className="office-drawer-document"><OfficeFileBadge kind={versionDocument.kind} size={34} /><div><strong>{versionDocument.name}</strong><span>{KIND_LABEL[versionDocument.kind]} · {sizeLabel(versionDocument.versions[0].file.size)}</span></div></div>
        <dl className="office-file-details"><div><dt>创建于</dt><dd>{new Date(versionDocument.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>最近打开</dt><dd>{versionDocument.openedAt ? new Date(versionDocument.openedAt).toLocaleString('zh-CN') : '尚未打开'}</dd></div></dl>
        <p className="office-version-help">恢复历史版本后，当前版本仍会保留在历史记录中。</p><div className="office-version-list">{versionDocument.versions.map((version, index) => <div className="office-version-row" key={version.id}>
          <span className={`office-version-dot ${index === 0 ? 'current' : ''}`} /><div className="office-version-content"><div className="office-version-title"><strong>{index === 0 ? '当前版本' : version.label}</strong>{index === 0 && <Tag color="success">最新</Tag>}</div><span className="office-muted">{dateLabel(version.createdAt)} · {sizeLabel(version.file.size)}</span><div className="office-actions"><Button aria-label="导出" size="small" type="text" icon={<DownloadOutlined aria-hidden="true" />} loading={pending.has(version.id)} onClick={() => void execute(version.id, () => actions.export(versionDocument, version.id))}>导出</Button>{index > 0 && <Button size="small" type="text" icon={<UndoOutlined aria-hidden="true" />} onClick={() => confirm({ title: '恢复此版本？', description: '当前版本将保留在历史记录中。其他页面需要重新打开此文件。', confirm: '恢复版本', perform: () => actions.mutate('restoreVersion', versionDocument, { versionId: version.id }) })}>恢复</Button>}</div></div>
        </div>)}</div></>}
    </Drawer>
  </div>
}

export function mountLibrary(host: HTMLElement, actions: LibraryActions) {
  const root = createRoot(host)
  let documents: OfficeDocument[] = []
  let recent: EditableDocument[] = []
  let loading = true
  const render = () => root.render(<OfficeTheme host={host}><Library host={host} actions={actions} documents={documents} recent={recent} loading={loading} /></OfficeTheme>)
  render()
  return { update(next: OfficeDocument[], local: EditableDocument[]) { documents = next; recent = local; loading = false; render() }, dispose() { root.unmount() } }
}
