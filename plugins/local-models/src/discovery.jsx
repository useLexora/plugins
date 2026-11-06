import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Accordion, ActionIcon, Badge, CloseButton, Fieldset, Radio, Skeleton, Table, TextInput, Title, UnstyledButton } from '@mantine/core'
import { Select } from './Select'
import { huggingFaceCatalog as directory, sortLabels } from '../catalogSources.js'
import { AuthorAvatar, HuggingFaceMark } from './AuthorIdentity'
import { createAuthorAvatars } from './authorAvatars'
import { Button, Icon } from './ui'
import { modelKinds, modelSymbols } from './modelPresentation'
import { catalogTags, choiceBytes, formatBytes, formatCount, formatDate, initialSelection, installationLabel, quantization, sourceUrl } from './catalogPresentation'
import { expandModelFiles } from '../modelFileGroups.js'
import './discovery.css'

export function ModelTags({ item }) {
  return <span className="model-tags lm-discovery-tags">{catalogTags(item).map((tag, index) => <Badge component="span" key={tag} className={`model-tag lm-discovery-tag${index === 0 ? ' model-tag--task' : ''}`} size="sm" radius="sm" color="gray" variant={index === 0 ? 'light' : 'outline'} title={tag}>{tag}</Badge>)}</span>
}

function InstallationTag({ availability }) {
  if (!availability) return null
  return <Badge component="span" className={`installation-tag installation-tag--${availability.state} lm-discovery-installation`} size="sm" radius="sm" color="gray" variant="light" data-installation-state={availability.state} title={availability.reason}>{installationLabel(availability)}</Badge>
}

function FileChoices({ role, value, onChange, disabled }) {
  const [query, setQuery] = useState('')
  const files = role.choices.filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()))
  return <Fieldset className="file-choices lm-discovery-file-choices" variant="unstyled" disabled={disabled} legend={<span className="lm-discovery-file-legend">{role.title}<span>{role.choices.length} 个文件</span></span>}>
    {role.choices.length > 5 && <TextInput className="search-control file-search lm-discovery-file-search" type="search" aria-label={`筛选${role.title}`} leftSection={<Icon name="search" size={16} />} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件名或量化，如 Q4_K_M" disabled={disabled} />}
    <Table.ScrollContainer className="file-table lm-discovery-file-scroll" minWidth={460} maxHeight={380} type="native" tabIndex={0} aria-label={`${role.title}文件列表`}>
      <Table className="lm-discovery-file-table" stickyHeader verticalSpacing="sm" horizontalSpacing="sm" highlightOnHover>
        <Table.Thead className="file-table-header"><Table.Tr><Table.Th scope="col">文件</Table.Th><Table.Th scope="col">量化 / 精度</Table.Th><Table.Th scope="col">大小</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {role.optional && <Table.Tr className="file-choice" data-selected={!value || undefined} data-disabled={disabled || undefined} onClick={() => { if (!disabled) onChange('') }}><Table.Td colSpan={3}><Radio name={`file-${role.id}`} checked={!value} onChange={() => onChange('')} label="不使用" disabled={disabled} /></Table.Td></Table.Tr>}
          {files.map(file => <Table.Tr className={`file-choice${value === file.path ? ' is-selected' : ''}`} data-selected={value === file.path || undefined} data-disabled={disabled || undefined} key={file.path} onClick={() => { if (!disabled) onChange(file.path) }}>
            <Table.Td><Radio classNames={{ label: 'lm-discovery-file-label', body: 'lm-discovery-file-radio' }} name={`file-${role.id}`} value={file.path} checked={value === file.path} onChange={() => onChange(file.path)} disabled={disabled} label={<span className="file-name lm-discovery-file-name">{file.path}{file.parts?.length > 1 && <small>完整分片 · {file.parts.length} 个文件</small>}</span>} /></Table.Td>
            <Table.Td className="file-precision lm-discovery-file-precision">{quantization(file.path) || '—'}</Table.Td>
            <Table.Td className="file-size lm-discovery-file-size">{formatBytes(choiceBytes(file))}</Table.Td>
          </Table.Tr>)}
          {!files.length && <Table.Tr><Table.Td colSpan={3}><div className="file-empty lm-discovery-file-empty">没有匹配的文件。<Button size="small" appearance="quiet" onClick={() => setQuery('')}>清除筛选</Button></div></Table.Td></Table.Tr>}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
    {query && value && !files.some(file => file.path === value) && <p className="lm-discovery-note">已选文件不在当前筛选结果中：{value}</p>}
  </Fieldset>
}

function Version({ item, context, manager, avatars, onAdded, onBack, onFindVersions, onImport }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState({})
  const [checksums, setChecksums] = useState({})
  const [recipeOverride, setRecipeOverride] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const back = useRef(null)
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    let current = true
    setDetail(null); setError('')
    context.commands.execute('lexora.local-models.inspect-model', { ...item, recipeOverride }).then(result => {
      if (!current) return
      if (result.error) throw Error(result.error)
      setDetail(result)
      setSelection(initialSelection(result.roles))
      setChecksums({})
    }).catch(error => { if (current) setError(error.message) })
    return () => { current = false }
  }, [item.key, attempt, recipeOverride])
  const files = detail?.roles.flatMap(role => role.choices.filter(file => file.path === selection[role.id])) ?? []
  const uniqueFiles = expandModelFiles([...files, ...(detail?.companionFiles ?? [])])
  const total = uniqueFiles.length && uniqueFiles.every(file => Number.isFinite(file.bytes)) ? uniqueFiles.reduce((sum, file) => sum + file.bytes, 0) : null
  const unhashed = uniqueFiles.filter(file => !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))
  const needsChecksums = unhashed.some(file => !Number.isFinite(file.bytes)) || unhashed.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1024 ** 2
  const adding = manager.isPending('add-model')
  const disabled = manager.pending || !manager.state.supported || !detail || !!detail.unavailableReason || !!detail.missing.length || detail.roles.some(role => !role.optional && !selection[role.id])
  const add = async (download) => {
    const result = await manager.run('add-model', { key: detail.key, title: item.title, selection, checksums, mode: download ? 'download' : 'import' }, '')
    if (!result) return
    onAdded(result.modelId)
    if (download) void manager.run('prepare', { modelId: result.modelId, scope: 'model', mode: 'download' }, '模型文件已下载')
  }
  const metadata = { ...item, ...detail }
  const license = metadata.license ?? metadata.tags?.find(tag => tag.startsWith('license:'))?.slice(8)
  return <section className="repository-page lm-discovery-repository" aria-label="模型详情">
    <div className="repository-content page-content lm-discovery-repository-content">
      <header className="repository-header lm-discovery-repository-header">
        <div className="lm-discovery-title-row"><ActionIcon ref={back} className="back-button lm-discovery-back" variant="subtle" color="gray" size="lg" aria-label="返回搜索结果" title="返回搜索结果" onClick={onBack}><Icon name="chevron-right" size={18} /></ActionIcon><Title order={2} size="h3">{item.title}</Title></div>
        <p className="repository-owner lm-discovery-owner"><AuthorAvatar owner={item.repository.split('/')[0]} avatars={avatars} />{item.repository.split('/')[0]}</p>
        <ModelTags item={metadata} />
        <div className="repository-stats lm-discovery-stats">
          {metadata.downloads != null && <span><Icon name="download" size={14} />{formatCount(metadata.downloads)} 次下载</span>}
          {metadata.likes != null && <span><Icon name="star" size={14} />{formatCount(metadata.likes)} 喜欢</span>}
          {formatDate(metadata.updated) && <span>更新于 {formatDate(metadata.updated)}</span>}
          <Button size="small" appearance="quiet" icon="external-link" onClick={() => context.openExternal(sourceUrl(item))}>查看来源与模型说明</Button>
        </div>
      </header>
      <div className="loading-recipe lm-discovery-recipe"><span>加载方式</span><Select aria-label="加载方式" value={recipeOverride ?? 'auto'} onChange={value => setRecipeOverride(value === 'auto' ? null : value)} disabled={adding} options={[{ value: 'auto', label: '自动识别' }, { value: 'chat', label: '对话 · llama.cpp' }, { value: 'vision', label: '对话＋图片 · llama.cpp' }, { value: 'asr', label: '语音转写 · Zipformer' }, { value: 'tts', label: '语音朗读 · Kokoro' }]} /></div>
      {error ? <div className="catalog-feedback lm-discovery-feedback" role="alert"><Icon name="alert" size={22} /><Title order={3} size="h5">无法读取模型文件</Title><p>{error}</p><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : !detail ? <div className="catalog-feedback lm-discovery-feedback" role="status">正在读取模型文件…</div> : <div className="repository-layout lm-discovery-repository-layout">
        <div className="repository-files lm-discovery-files">
          {detail.availability?.code !== 'ready' && <div className="version-unavailable lm-discovery-notice" role="status"><Icon name="info" size={18} /><div><strong>{installationLabel(detail.availability)}</strong>{detail.availability?.reason && <p>{detail.availability.reason}</p>}<div className="support-actions lm-discovery-actions">
            {['format', 'adapter'].includes(detail.availability?.code) && <Button size="small" onClick={() => onFindVersions(item)}>查找 GGUF 版本</Button>}
            <Button size="small" onClick={() => setAttempt(value => value + 1)}>重新读取信息</Button>
            <Button size="small" onClick={onImport}>导入本地模型</Button>
          </div></div></div>}
          {detail.requirement && <p className="lm-discovery-note">{detail.requirement}</p>}
          {detail.roles.filter(role => role.choices.length).map(role => <FileChoices key={role.id} role={role} value={selection[role.id] ?? ''} disabled={adding} onChange={value => setSelection(previous => ({ ...previous, [role.id]: value }))} />)}
          {detail.companionFiles?.length > 0 && <p className="lm-discovery-note">另包含 {detail.companionFiles.length} 个配套语音数据文件，已计入下载大小。</p>}
          {!!metadata.tags?.length && <Accordion className="source-tags lm-discovery-source-tags" variant="default"><Accordion.Item value="tags"><Accordion.Control>来源标签 <span className="lm-discovery-tag-count">{metadata.tags.length}</span></Accordion.Control><Accordion.Panel><span className="model-tags lm-discovery-tags">{[...new Set(metadata.tags)].map(tag => <Badge component="span" className="model-tag lm-discovery-tag" size="sm" radius="sm" color="gray" variant="outline" title={tag} key={tag}>{tag}</Badge>)}</span></Accordion.Panel></Accordion.Item></Accordion>}
        </div>
        <aside className="download-summary lm-discovery-summary" aria-label="下载摘要">
          <Title order={3} size="h5">本次下载</Title>
          <strong className="download-size lm-discovery-size">{formatBytes(total)}</strong>
          <span className="summary-caption lm-discovery-note">{uniqueFiles.length} 个已选文件</span>
          <ul>{uniqueFiles.map(file => <li key={file.path}>{file.path}</li>)}</ul>
          {unhashed.length > 0 && <p className="lm-discovery-note">{needsChecksums ? '来源缺少校验值。可填写文件的 SHA-256 后下载，或下载后导入本地模型；不需要更换模型。' : '下载时会先读取小文件生成校验值；已有文件也可直接通过本地导入添加。'}</p>}
          {needsChecksums && unhashed.map(file => <TextInput className="checksum-field lm-discovery-checksum" key={file.path} label={`${file.path} · SHA-256`} aria-label={`${file.path} SHA-256`} value={checksums[file.path] ?? ''} onChange={event => setChecksums(previous => ({ ...previous, [file.path]: event.target.value }))} placeholder="粘贴文件的 SHA-256" spellCheck={false} />)}
          <Button appearance="primary" icon="download" disabled={disabled} onClick={() => add(true)}>{adding ? '正在准备文件信息…' : detail?.availability?.code === 'inferred' || recipeOverride ? '尝试下载' : '下载到本地'}</Button>
          <Button icon="file-up" disabled={manager.pending || !manager.state.supported} onClick={unhashed.length || disabled ? onImport : () => add(false)}>{unhashed.length || disabled ? '导入本地模型' : '已有文件，添加后导入'}</Button>
          {!license && <p className="license-note lm-discovery-note">来源未声明许可</p>}
        </aside>
      </div>}
    </div>
  </section>
}

export function Discovery({ context, manager, onAdded, onImport }) {
  const searchInput = useRef(null)
  const avatars = useMemo(() => createAuthorAvatars(context), [context])
  useEffect(() => () => avatars.dispose(), [avatars])
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('downloads')
  const [availability, setAvailability] = useState('installable')
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState({ items: [], errors: [], nextCursor: null, pageComplete: true })
  const [pages, setPages] = useState([])
  const [page, setPage] = useState(0)
  const [continuation, setContinuation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const results = useRef(null)
  const lastCard = useRef(null)
  useEffect(() => {
    let current = true
    setError('')
    if (pages[page] && !continuation) {
      setData(pages[page]); setLoading(false)
      if (results.current) results.current.scrollTop = 0
      return
    }
    setLoading(true)
    context.commands.execute('lexora.local-models.discover', { kind, query: search, sort, availability, ...(continuation ? { cursor: continuation } : page ? { cursor: pages[page - 1].nextCursor } : {}) }).then(result => {
      if (!current) return
      if (result.error) throw Error(result.error)
      setData(result)
      setPages(previous => [...previous.slice(0, page), result])
      if (results.current && !continuation) results.current.scrollTop = 0
    }).catch(error => { if (current) { setError(error.message); if (!continuation) setData({ items: [], errors: [], nextCursor: null, pageComplete: true }) } }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [kind, search, sort, availability, page, attempt, continuation])
  useEffect(() => { if (!selected) lastCard.current?.focus({ preventScroll: true }) }, [selected])
  const restart = () => { setLoading(true); setPages([]); setPage(0); setContinuation(null); setAttempt(value => value + 1) }
  const navigate = target => { setLoading(true); setContinuation(null); setPage(target) }
  const continueSearch = () => { setLoading(true); setContinuation(data.nextCursor); setAttempt(value => value + 1) }
  const findVersions = item => {
    const name = item.title.replace(/[-_.]gguf$/i, '')
    setSelected(null); setQuery(name); setSearch(name); setKind(item.recipe === 'vision' ? 'vision' : 'chat'); setAvailability('installable'); restart()
  }
  const reset = () => { setQuery(''); setSearch(''); setKind('all'); setAvailability('all'); restart() }
  const changeQuery = value => {
    setQuery(value)
    if (!value && search) { setSearch(''); restart() }
  }
  return <section className="discovery-page lm-discovery-page" aria-label="发现模型">
    <div className="catalog-browser page-content lm-discovery-browser" hidden={!!selected}>
      <form className="catalog-search lm-discovery-search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); restart() }}>
        <Select aria-label="模型来源" className="catalog-source lm-discovery-source" value="huggingface" onChange={() => {}} options={[{ value: 'huggingface', label: 'Hugging Face', icon: <HuggingFaceMark /> }]} />
        <TextInput ref={searchInput} className="search-control lm-discovery-search-input" type="search" aria-label="搜索模型目录" leftSection={<Icon name="search" size={18} />} rightSection={query ? <CloseButton size="sm" aria-label="清空搜索" onClick={() => { changeQuery(''); searchInput.current?.focus() }} /> : null} value={query} onChange={event => changeQuery(event.target.value)} placeholder={directory.placeholder} />
        <Select aria-label="安装筛选" className="catalog-availability lm-discovery-availability" value={availability} onChange={value => { setAvailability(value); restart() }} options={[{ value: 'all', label: '全部' }, { value: 'installable', label: '可安装' }]} />
        <Button type="submit" disabled={loading}>搜索</Button>
      </form>
      <div className="catalog-toolbar lm-discovery-toolbar">
        <div className="category-filters lm-discovery-filters" role="group" aria-label="模型用途">{modelKinds.filter(item => item.value === 'all' || directory.kinds.includes(item.value)).map(item => <Button size="small" key={item.value} variant={kind === item.value ? 'light' : 'subtle'} aria-pressed={kind === item.value} onClick={() => { setKind(item.value); restart() }} icon={item.value !== 'all' ? modelSymbols[item.value] : undefined}>{item.value === 'all' ? '全部' : item.label}</Button>)}</div>
        <Select aria-label="目录排序" className="lm-discovery-sort" compact value={sort} onChange={value => { setSort(value); restart() }} options={directory.sorts.map(value => ({ value, label: sortLabels[value] }))} />
      </div>
      <div id="model-catalog-results" className="catalog-results lm-discovery-results" ref={results} aria-busy={loading}>
        {loading && <div className="results-caption lm-discovery-caption" role="status">{continuation ? '正在继续查找，本页已有结果会保留…' : '正在查询来源…'}</div>}
        {!loading && data.pageComplete === false && <div className="results-caption lm-discovery-caption" role="status">已找到 {data.items.length} 个候选模型，目录尚未查完。继续查找会补充当前页，不会跳过结果。</div>}
        {error && continuation && <div className="partial-error lm-discovery-partial-error" role="alert"><span>{error} 已保留当前结果。</span><Button size="small" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>}
        {!loading && data.errors.length > 0 && <div className="partial-error lm-discovery-partial-error" role="status"><span>部分信息暂不可用：{data.errors.join('；')}</span><Button size="small" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>}
        {loading && !continuation ? <div className="catalog-skeleton lm-discovery-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <div className="lm-discovery-skeleton" key={i}><Skeleton height={18} width="45%" /><Skeleton height={23} /><Skeleton height={14} width="65%" /></div>)}</div> : error && !continuation ? <div className="catalog-feedback lm-discovery-feedback" role="alert"><Icon name="cloud-off" size={28} /><Title order={3} size="h5">无法获取模型目录</Title><p>{error}</p><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : !data.items.length ? <div className="catalog-feedback lm-discovery-feedback"><Icon name="search" size={28} /><Title order={3} size="h5">{availability === 'installable' ? data.nextCursor ? '正在查找可安装模型' : '没有找到可直接安装的模型' : '没有找到匹配的模型'}</Title><p>{data.nextCursor ? '目录尚未查完，可继续查找或选择具体用途。' : '试试其他关键词，或切换为全部模型。'}</p><Button onClick={reset}>清除筛选</Button></div> : <div className="catalog-grid lm-discovery-grid">{data.items.map(item => <UnstyledButton className="catalog-card lm-discovery-card" key={item.key} data-discovery-key={item.key} onClick={event => { lastCard.current = event.currentTarget; setSelected(item) }}>
          <span className="card-heading lm-discovery-card-heading"><span className="card-publisher lm-discovery-publisher"><AuthorAvatar owner={item.repository.split('/')[0]} avatars={avatars} /><span>{item.repository.split('/')[0]}</span></span><InstallationTag availability={item.availability} /></span>
          <strong className="card-title lm-discovery-card-title">{item.title}</strong>
          <ModelTags item={item} />
          <span className="card-footer lm-discovery-card-footer">{item.downloads != null && <span><Icon name="download" size={13} />{formatCount(item.downloads)}</span>}{item.likes != null && <span><Icon name="star" size={13} />{formatCount(item.likes)}</span>}{formatDate(item.updated) && <span className="card-updated">{formatDate(item.updated)}</span>}{item.gated && item.availability?.code !== 'access' && <span>需申请访问</span>}</span>
        </UnstyledButton>)}</div>}
      </div>
      <nav className="catalog-pagination lm-discovery-pagination" aria-label="模型目录分页">
        <Button size="small" disabled={loading || page === 0} aria-controls="model-catalog-results" onClick={() => navigate(page - 1)}>上一页</Button>
        <span aria-live="polite">{data.pageComplete === false ? '正在补齐第' : '第'} {page + 1} 页</span>
        <Button size="small" disabled={loading || !data.nextCursor} aria-controls="model-catalog-results" onClick={() => data.pageComplete === false ? continueSearch() : navigate(page + 1)}>{data.pageComplete === false ? '继续查找' : '下一页'}</Button>
      </nav>
    </div>
    {selected && <Version key={selected.key} item={selected} context={context} manager={manager} avatars={avatars} onAdded={onAdded} onBack={() => setSelected(null)} onFindVersions={findVersions} onImport={onImport} />}
  </section>
}
