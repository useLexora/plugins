const splitPattern = /^(.*\/)?([^/]+)-(\d{5})-of-(\d{5})\.gguf$/i

export function groupGgufFiles(files) {
  const groups = new Map()
  const entries = files.map(file => {
    const match = splitPattern.exec(file.path)
    if (!match) return { file }
    const [, directory = '', stem, sequence, count] = match
    const key = directory + stem
    const index = Number(sequence)
    const total = Number(count)
    let group = groups.get(key)
    if (!group) {
      group = { total, parts: new Map(), invalid: false }
      groups.set(key, group)
    }
    if (total !== group.total || index < 1 || index > total || group.parts.has(index)) group.invalid = true
    group.parts.set(index, file)
    return { file, group, index }
  })
  return entries.flatMap(({ file, group, index }) => {
    if (!group) return [file]
    if (index !== 1 || group.invalid || group.parts.size !== group.total) return []
    const parts = [...group.parts].sort(([a], [b]) => a - b).map(([, part]) => part)
    return [{ ...file, parts }]
  })
}

export function expandModelFiles(files) {
  const expanded = new Map()
  for (const choice of files) {
    for (const file of choice.parts ?? [choice]) {
      if (!expanded.has(file.path)) expanded.set(file.path, file)
    }
  }
  return [...expanded.values()]
}
