import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { activateManager } from '../manager.js'
import { compatibleImageRecipe } from '../imageRecovery.js'
import { zImageTurbo, zImageTurboFiles } from '../native/image/recipes.mjs'

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await readFile(new URL('../resources.json', import.meta.url)))
const imageTemplate = catalog.models.find(model => model.id === 'qwen-image')
const zTemplate = catalog.models.find(model => model.id === 'z-image-turbo')

async function fixture({ stored = {}, resources = [], data, platform, onSave = async () => {}, onBind = async () => {}, onUnbind = async () => {}, runtimes = [{ runtime: 'image', configured: true, instances: [] }] } = {}) {
  const commands = new Map(), bindings = [], unbindings = [], saves = [], preparations = [], downloads = []
  const runtimeBindings = new Map()
  let persisted = structuredClone(stored)
  const context = {
    signal: new AbortController().signal,
    storage: { get: async () => structuredClone(persisted), set: async value => { await onSave(value); persisted = structuredClone(value); saves.push(structuredClone(value)) } },
    views: { broadcast: async () => {} }, subscriptions: { add() {} },
    commands: { register: (name, handler) => { commands.set(name, handler); return () => {} } },
    inference: {
      capabilities: platform ? { nativeRuntime: true } : { runtimeIsolation: true },
      environment: async () => ({ platform, executionMode: platform === 'linux-x64' ? 'isolated' : 'supervised' }),
      resources: {
        list: async () => resources,
        prepare: async request => {
          preparations.push(structuredClone(request))
          const resource = { id: request.id, kind: request.kind, revision: 'prepared-revision', authorized: true }
          resources.push(resource)
          return resource
        },
      },
      status: async () => runtimes,
      credentials: { has: async () => false },
      bind: async binding => {
        await onBind(binding)
        bindings.push(structuredClone(binding))
        runtimeBindings.set(binding.runtime, structuredClone(binding))
        const runtime = runtimes.find(item => item.runtime === binding.runtime)
        if (runtime) runtime.configured = true
      },
      unbind: async target => {
        unbindings.push(structuredClone(target))
        await onUnbind(target)
        runtimeBindings.delete(target.runtime)
        const runtime = runtimes.find(item => item.runtime === target.runtime)
        if (runtime) runtime.configured = false
      },
    },
    network: { download: async request => { downloads.push(request); const bytes = new TextEncoder().encode(JSON.stringify(data)); return { bytes, size: bytes.length } } },
    resources: { readBytes: async resource => ({ data: resource.bytes, eof: true }), release: async () => {} },
  }
  await activateManager(context, { manifest: { id: 'lexora.local-models' }, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  const execute = (name, input) => commands.get(`lexora.local-models.${name}`)({ arguments: input })
  return { execute, bindings, unbindings, saves, preparations, downloads, state: () => execute('status'), persisted: () => structuredClone(persisted), currentBinding: runtime => structuredClone(runtimeBindings.get(runtime)) }
}
const authorized = ids => ids.map(id => ({ id, revision: 'fixture-revision', authorized: true }))
const zSpecification = specifications.find(spec => spec.id === zTemplate.resources[1])
const compatibleId = 'compatible-z-image-turbo'
const legacyRecord = () => {
  const model = {
    ...imageTemplate, id: 'custom-af52b6dbee3564ea6973', custom: true, imageArchitecture: 'checkpoint',
    origin: { source: 'huggingface', repository: 'unsloth/Z-Image-Turbo-FP8', revision: 'a8c25b2dd9bf175840a3875c1f466281a61d20f2' },
    metadata: { tags: ['base_model:Tongyi-MAI/Z-Image-Turbo'] },
    files: { model: 'Z-Image-Turbo-FP8.safetensors' }, resources: ['image-cuda', 'original-fp8-resource'],
  }
  return { model, specification: { id: model.resources[1], kind: 'model', files: [{ path: model.files.model, sha256: 'a'.repeat(64), bytes: 6290000000 }] } }
}
const compatibleRecord = id => ({ model: { ...zTemplate, id, custom: true, resources: ['image-cuda', `${id}-model`] }, specification: { ...zSpecification, id: `${id}-model` } })

test('legacy unchecked checkpoint retains identity, active choice, files and parameters without claiming readiness or binding', async () => {
  const model = { ...imageTemplate, id: 'custom-original-fp8', imageArchitecture: 'checkpoint', files: { model: 'Z-Image-Turbo-FP8.safetensors' }, resources: ['image-cuda', 'original-fp8-resource'] }
  const specification = { id: 'original-fp8-resource', kind: 'model', files: [{ path: model.files.model, sha256: 'a'.repeat(64), bytes: 6290000000 }] }
  const stored = { custom: [{ model, specification }], active: { image: model.id }, models: { [model.id]: { ...model.defaults, steps: 17, preservedExtra: 'retain' } } }
  const f = await fixture({ stored, resources: authorized(model.resources) })
  const current = (await f.state()).models[0]
  assert.equal(current.id, model.id)
  assert.equal(current.active, true)
  assert.equal(current.filesReady, true)
  assert.equal(current.filesRegistered, true)
  assert.equal(current.prepared, false)
  assert.equal(current.bound, false)
  assert.equal(current.state, 'unverified')
  assert.match(current.bindingWarning, /尚无完整结构验证.*保留/)
  assert.equal(f.bindings.length, 0)
  assert.equal(f.saves.length, 0)
  assert.match((await f.execute('activate-model', { modelId: model.id })).error, /结构验证/)
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...current.configuration, steps: 18 } })).ok, true)
  assert.deepEqual(f.saves[0].custom, stored.custom)
  assert.deepEqual(f.saves[0].active, stored.active)
  assert.equal(f.saves[0].models[model.id].preservedExtra, 'retain')
  assert.equal(f.bindings.length, 0)
})

test('checkpoint structure evidence is tied to its hashed resource and permits generate only', async () => {
  for (const mismatched of [false, true]) {
    const model = { ...imageTemplate, id: 'local-validated', imageArchitecture: 'checkpoint', imageValidation: { version: 1, kind: 'ldm-header', architecture: 'sdxl', sha256: 'a'.repeat(64) }, files: { model: 'complete.safetensors' }, resources: ['image-cuda', 'local-validated-model'] }
    const specification = { id: model.resources[1], kind: 'model', files: [{ path: model.files.model, sha256: (mismatched ? 'b' : 'a').repeat(64) }] }
    const f = await fixture({ stored: { custom: [{ model, specification }], active: { image: model.id } }, resources: authorized(model.resources) })
    assert.equal(f.bindings.length, mismatched ? 0 : 1)
    if (!mismatched) {
      assert.deepEqual(f.bindings[0].configuration.imageValidation, model.imageValidation)
      assert.deepEqual(f.bindings[0].imageModels[0].support.operations, ['generate'])
      assert.equal(f.bindings[0].imageModels[0].support.maxReferenceImages, 0)
    }
  }
})

test('Z-Image catalog and resource index agree with all pinned components and safe Turbo defaults', async () => {
  const specification = specifications.find(spec => spec.id === zTemplate.resources[1])
  assert.equal(specification.bytes, zImageTurboFiles.reduce((sum, file) => sum + file.bytes, 0))
  assert.deepEqual(specification.files.map(file => [file.path, file.url, file.sha256, file.bytes]), zImageTurboFiles.map(file => [file.path, file.url, file.sha256, file.bytes]))
  const f = await fixture({ resources: authorized(zTemplate.resources), stored: { active: { image: zTemplate.id } } })
  assert.equal(f.bindings.length, 1)
  const binding = f.bindings[0]
  assert.equal(binding.configuration.imageArchitecture, 'z-image-turbo')
  assert.equal(binding.configuration.steps, 8)
  assert.deepEqual(binding.configuration.files, zTemplate.files)
  assert.deepEqual(binding.imageModels[0].support.operations, ['generate'])
  assert.equal(binding.imageModels[0].support.maxReferenceImages, 0)
})

test('adding audited Z-Image creates a separate custom identity with Turbo defaults without selecting it over the old checkpoint', async () => {
  const old = { ...imageTemplate, id: 'old-checkpoint', imageArchitecture: 'checkpoint', files: { model: 'fp8.safetensors' }, resources: ['image-cuda', 'fp8'] }
  const stored = { custom: [{ model: old, specification: { id: 'fp8', kind: 'model', files: [] } }], active: { image: old.id }, models: { [old.id]: { ...old.defaults, steps: 23 } } }
  const diffusion = zImageTurboFiles[0]
  const f = await fixture({ stored, data: { id: diffusion.repository, sha: diffusion.revision, pipeline_tag: 'text-to-image', siblings: [{ rfilename: diffusion.path, size: diffusion.bytes, lfs: { sha256: diffusion.sha256 } }] } })
  const detail = await f.execute('inspect-model', { repository: diffusion.repository })
  const result = await f.execute('add-model', { key: detail.key, selection: Object.fromEntries(zImageTurboFiles.map(file => [file.role, file.path])) })
  assert.equal(result.ok, true)
  const saved = f.saves.at(-1)
  const added = saved.custom.find(item => item.model.id === result.modelId)
  assert.equal(added.model.imageArchitecture, 'z-image-turbo')
  assert.equal(added.model.defaults.steps, 8)
  assert.equal(saved.models[result.modelId].steps, 8)
  assert.deepEqual(added.model.files, zTemplate.files)
  assert.deepEqual(saved.custom.find(item => item.model.id === old.id), stored.custom[0])
  assert.equal(saved.active.image, old.id)
  assert.equal(saved.models[old.id].steps, 23)
})

test('compatible image recovery uses explicit Hugging Face provenance, never model names or filenames', () => {
  const { model } = legacyRecord()
  const pinned = { source: 'huggingface', repository: 'example/quantized-model', revision: 'b'.repeat(40) }
  for (const record of [
    model,
    { ...model, metadata: undefined },
    { ...model, origin: pinned, metadata: { baseModels: ['Tongyi-MAI/Z-Image-Turbo'] } },
    { ...model, origin: pinned, metadata: { tags: ['base_model:quantized:Tongyi-MAI/Z-Image-Turbo'] } },
    ...['Tongyi-MAI/Z-Image-Turbo', 'leejet/Z-Image-Turbo-GGUF', 'Comfy-Org/Z-Image-Turbo'].map(repository => ({ ...model, origin: { ...pinned, repository }, metadata: undefined })),
  ]) assert.equal(compatibleImageRecipe(record), 'z-image-turbo')
  for (const record of [
    { ...model, runtime: 'chat' },
    { ...model, imageArchitecture: 'z-image-turbo' },
    { ...model, imageArchitecture: undefined },
    { ...model, origin: undefined },
    { ...model, origin: { ...model.origin, source: 'local' } },
    { ...model, title: 'Z-Image Turbo FP8', origin: pinned, metadata: {} },
    { ...model, origin: { ...pinned, revision: 'main' } },
    { ...model, origin: pinned, metadata: { tags: ['Z-Image-Turbo', 'base_model:Tongyi-MAI/Z-Image'] } },
    { ...model, origin: pinned, metadata: { baseModels: ['Tongyi-MAI/Z-Image-Turbo-extra'] } },
    { ...model, origin: { ...pinned, repository: 'example/Z-Image-Turbo-FP8' }, metadata: {} },
    undefined,
  ]) assert.equal(compatibleImageRecipe(record), undefined)
})

test('compatible model command rejects missing, unrelated, non-image and already verified sources without changing records', async () => {
  const old = legacyRecord()
  const validated = { ...old.model, imageValidation: { version: 1, kind: 'ldm-header', architecture: 'sdxl', sha256: old.specification.files[0].sha256 } }
  for (const model of [old.model, { ...old.model, origin: undefined }, { ...old.model, runtime: 'chat' }, validated, { ...zTemplate, origin: old.model.origin }]) {
    const specification = model.imageArchitecture === 'z-image-turbo' ? zSpecification : old.specification
    const f = await fixture({ stored: { custom: [{ model, specification }], active: {} } })
    const before = await f.state()
    const result = await f.execute('add-compatible-model', { modelId: model === old.model ? 'missing' : model.id })
    assert.equal(typeof result.error, 'string')
    assert.deepEqual((await f.state()).models, before.models)
    assert.deepEqual((await f.state()).specifications, before.specifications)
    assert.equal(f.saves.length, 0)
    assert.equal(f.preparations.length, 0)
    assert.equal(f.downloads.length, 0)
  }
})

test('compatible addition is independent, idempotent and restored with a direct model-directory preparation protocol', async () => {
  const old = legacyRecord()
  const originalConfiguration = { ...old.model.defaults, steps: 99, vramGiB: 19, preservedExtra: 'retain' }
  const stored = { custom: [old], active: { image: old.model.id, asr: 'retain-asr' }, models: { [old.model.id]: originalConfiguration } }
  const resources = authorized(old.model.resources)
  const originalResources = structuredClone(resources)
  const f = await fixture({ stored, resources })
  assert.equal((await f.state()).specifications.some(spec => spec.id === zSpecification.id), false)
  const result = await f.execute('add-compatible-model', { modelId: old.model.id })
  assert.deepEqual(result, { ok: true, modelId: compatibleId })
  assert.equal(f.saves.length, 1)
  const saved = f.saves[0]
  assert.equal(saved.custom.length, 2)
  assert.deepEqual(saved.custom[0], old)
  assert.deepEqual(saved.models[old.model.id], originalConfiguration)
  assert.deepEqual(saved.active, stored.active)
  const added = saved.custom[1]
  assert.equal(added.model.id, compatibleId)
  assert.equal(added.model.custom, true)
  assert.equal(added.model.acquisition, 'import')
  assert.equal(added.model.imageArchitecture, 'z-image-turbo')
  assert.deepEqual(added.model.origin, { source: 'huggingface', repository: zImageTurbo.repository, revision: zImageTurbo.revision })
  assert.deepEqual(added.model.files, zTemplate.files)
  assert.deepEqual(added.model.defaults, zTemplate.defaults)
  assert.deepEqual(saved.models[compatibleId], zTemplate.defaults)
  assert.deepEqual(added.model.resources, ['image-cuda', `${compatibleId}-model`])
  assert.equal(added.model.directoryResources, undefined)
  assert.deepEqual(added.specification, { ...zSpecification, id: `${compatibleId}-model`, files: zSpecification.files.map(file => ({ ...file, source: file.path })) })
  assert.deepEqual(resources, originalResources)
  assert.equal(f.bindings.length, 0)
  assert.equal(f.preparations.length, 0)
  assert.equal(f.downloads.length, 0)
  assert.deepEqual(await f.execute('add-compatible-model', { modelId: old.model.id }), result)
  assert.equal(f.saves.length, 1)
  assert.equal((await f.state()).models.length, 2)

  const restarted = await fixture({ stored: saved, resources })
  let state = await restarted.state()
  assert.equal(state.models.find(model => model.id === old.model.id).state, 'unverified')
  assert.equal(state.models.find(model => model.id === compatibleId).state, 'missing')
  assert.deepEqual(state.specifications.find(spec => spec.id === added.specification.id), added.specification)
  assert.deepEqual(await restarted.execute('add-compatible-model', { modelId: old.model.id }), result)
  assert.equal(restarted.saves.length, 0)
  assert.deepEqual(await restarted.execute('prepare', { modelId: compatibleId, mode: 'directory', scope: 'model', directoryId: 'selected-model-directory' }), { ok: true })
  assert.deepEqual(restarted.preparations, [{
    id: `${compatibleId}-model`, kind: 'model',
    files: zImageTurboFiles.map(file => ({ path: file.path, sha256: file.sha256, source: { directoryId: 'selected-model-directory', path: file.path, reference: true } })),
  }])
  state = await restarted.state()
  const current = state.models.find(model => model.id === compatibleId)
  assert.equal(current.filesReady, true)
  assert.equal(current.prepared, true)
  assert.equal(current.bindingWarning, '')
  assert.equal(current.active, false)
  assert.equal(state.models.find(model => model.id === old.model.id).active, true)
  assert.equal(state.job.state, 'completed')
  assert.equal(restarted.bindings.length, 0)
  assert.equal(restarted.downloads.length, 0)
  assert.deepEqual(restarted.saves, [{ ...saved, resourceRevisions: { ...saved.resourceRevisions, [`${compatibleId}-model`]: 'prepared-revision' } }])
})

test('reused unauthorized builtin imports bare component paths only for model-scoped directories without rewriting its recipe', async () => {
  for (const scope of ['model', undefined]) {
    const old = legacyRecord()
    const stored = { custom: [old], active: { image: old.model.id } }
    const resources = [...authorized([zTemplate.resources[0]]), { id: zSpecification.id, revision: 'expired-revision', authorized: false }]
    const f = await fixture({ stored, resources })
    assert.deepEqual(await f.execute('add-compatible-model', { modelId: old.model.id }), { ok: true, modelId: zTemplate.id })
    const before = (await f.state()).specifications.find(spec => spec.id === zSpecification.id)
    assert.deepEqual(before, zSpecification)
    assert.deepEqual(await f.execute('prepare', { modelId: zTemplate.id, mode: 'directory', directoryId: 'selected-model-directory', ...(scope ? { scope } : {}) }), { ok: true })
    assert.deepEqual(f.preparations, [{
      id: zSpecification.id, kind: 'model',
      files: zSpecification.files.map(file => ({ path: file.path, sha256: file.sha256, source: { directoryId: 'selected-model-directory', path: scope === 'model' ? file.path : file.source, reference: true } })),
    }])
    const state = await f.state()
    assert.deepEqual(state.models.map(model => model.id), [zTemplate.id, old.model.id])
    assert.deepEqual(state.specifications.find(spec => spec.id === zSpecification.id), before)
    assert.equal(state.models.find(model => model.id === zTemplate.id).prepared, true)
    assert.equal(state.models.find(model => model.id === old.model.id).active, true)
    assert.deepEqual(f.persisted(), { ...stored, resourceRevisions: { [zSpecification.id]: 'prepared-revision' } })
    assert.equal(f.bindings.length, 0)
    assert.equal(f.downloads.length, 0)
    assert.equal(f.saves.length, 1)
  }
})

test('compatible target reuse prefers active then authorized model files then the first verified target', async () => {
  const old = legacyRecord()
  const first = compatibleRecord('existing-first')
  const ready = compatibleRecord('existing-ready')
  const invalid = compatibleRecord('existing-invalid')
  invalid.specification = { ...invalid.specification, files: [] }
  for (const { active, resources, expected } of [
    { active: first.model.id, resources: authorized([ready.specification.id]), expected: first.model.id },
    { active: invalid.model.id, resources: authorized([invalid.specification.id, ready.specification.id]), expected: ready.model.id },
    { active: old.model.id, resources: [], expected: first.model.id },
  ]) {
    const f = await fixture({ stored: { custom: [old, invalid, first, ready], active: { image: active } }, resources })
    assert.deepEqual(await f.execute('add-compatible-model', { modelId: old.model.id }), { ok: true, modelId: expected })
    assert.equal((await f.state()).models.length, 4)
    assert.equal((await f.state()).models.find(model => model.id === active).active, true)
    assert.equal(f.saves.length, 0)
    assert.equal(f.bindings.length, 0)
    assert.equal(f.preparations.length, 0)
  }
})

test('compatible addition changes no in-memory model or specification until save succeeds and can retry after failure', async () => {
  const old = legacyRecord()
  const stored = { custom: [old], active: { image: old.model.id }, models: { [old.model.id]: { ...old.model.defaults, steps: 17, preservedExtra: 'retain' } } }
  let enter, release, attempts = 0
  const entered = new Promise(resolve => { enter = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const f = await fixture({ stored, resources: authorized(old.model.resources), onSave: async () => {
    if (++attempts === 1) { enter(); await blocked; throw Error('storage unavailable') }
  } })
  const before = await f.state()
  const pending = f.execute('add-compatible-model', { modelId: old.model.id })
  await entered
  assert.deepEqual((await f.state()).models, before.models)
  assert.deepEqual((await f.state()).specifications, before.specifications)
  assert.match((await f.execute('add-compatible-model', { modelId: old.model.id })).error, /当前操作/)
  release()
  assert.deepEqual(await pending, { error: 'storage unavailable' })
  assert.deepEqual((await f.state()).models, before.models)
  assert.deepEqual((await f.state()).specifications, before.specifications)
  assert.equal(f.saves.length, 0)
  assert.equal(f.bindings.length, 0)
  assert.equal(f.preparations.length, 0)
  assert.deepEqual(await f.execute('add-compatible-model', { modelId: old.model.id }), { ok: true, modelId: compatibleId })
  assert.equal(f.saves.length, 1)
  assert.deepEqual(f.saves[0].custom[0], old)
  assert.deepEqual(f.saves[0].active, stored.active)
  assert.deepEqual(f.saves[0].models[old.model.id], stored.models[old.model.id])
})

test('compatible addition refuses reserved identity collisions without overwriting the existing record', async () => {
  const old = legacyRecord()
  for (const collision of [
    { model: { ...old.model, id: compatibleId }, specification: { ...old.specification, id: 'unrelated-model-resource' } },
    { model: { ...old.model, id: 'other-existing-model', resources: ['image-cuda', `${compatibleId}-model`] }, specification: { ...old.specification, id: `${compatibleId}-model` } },
  ]) {
    const f = await fixture({ stored: { custom: [old, collision], active: { image: old.model.id } } })
    const before = await f.state()
    assert.match((await f.execute('add-compatible-model', { modelId: old.model.id })).error, /标识已存在/)
    assert.deepEqual((await f.state()).models, before.models)
    assert.deepEqual((await f.state()).specifications, before.specifications)
    assert.equal(f.saves.length, 0)
  }
})

test('compatible addition keeps Turbo defaults and the current platform engine and acceleration projection', async () => {
  for (const [platform, engine] of [['windows-x64', 'image-vulkan-windows-x64'], ['macos-arm64', 'image-metal-macos-arm64']]) {
    const old = legacyRecord()
    const f = await fixture({ platform, stored: { custom: [old], active: { image: old.model.id } } })
    assert.deepEqual(await f.execute('add-compatible-model', { modelId: old.model.id }), { ok: true, modelId: compatibleId })
    const model = (await f.state()).models.find(model => model.id === compatibleId)
    assert.deepEqual(model.resources, [engine, `${compatibleId}-model`])
    assert.equal(model.defaults.steps, 8)
    assert.equal(model.configuration.steps, 8)
    assert.equal(model.defaults.acceleration, platform === 'macos-arm64' ? 'gpu' : undefined)
    assert.equal(model.fields.some(field => field.key === 'acceleration'), platform === 'macos-arm64')
    assert.deepEqual(f.saves[0].custom[0], old)
    assert.deepEqual(f.saves[0].custom[1].model.resources, model.resources)
    assert.equal(model.state, 'missing')
    assert.equal(f.bindings.length, 0)
    assert.equal(f.preparations.length, 0)
  }
})

test('activation save failure unbinds a new compatible model when the active legacy checkpoint had no valid binding', async () => {
  const old = legacyRecord()
  const target = compatibleRecord(compatibleId)
  const stored = { custom: [old, target], active: { image: old.model.id }, models: { [old.model.id]: { ...old.model.defaults, steps: 17, preservedExtra: 'retain' } } }
  const resources = authorized([...new Set([...old.model.resources, ...target.model.resources])])
  const runtimes = [{ runtime: 'image', configured: false, instances: [] }]
  const saveError = Error('storage unavailable')
  let attempts = 0
  const f = await fixture({ stored, resources, runtimes, onSave: async () => { if (!attempts++) throw saveError } })
  const before = structuredClone(await f.state())
  assert.equal(f.currentBinding('image'), undefined)
  await assert.rejects(f.execute('activate-model', { modelId: target.model.id }), error => error === saveError)
  assert.equal(f.currentBinding('image'), undefined)
  assert.deepEqual(f.unbindings, [{ runtime: 'image' }])
  assert.deepEqual(runtimes, before.runtimes)
  assert.deepEqual((await f.state()).models, before.models)
  assert.deepEqual(f.persisted(), stored)
  assert.equal(f.saves.length, 0)
  assert.equal(f.bindings.length, 1)
  assert.equal(f.downloads.length, 0)
  assert.equal(f.preparations.length, 0)

  assert.deepEqual(await f.execute('activate-model', { modelId: target.model.id }), { ok: true })
  assert.equal(f.bindings.length, 2)
  assert.equal(f.currentBinding('image').imageModels[0].id, target.model.id)
  assert.equal(f.persisted().active.image, target.model.id)
  assert.deepEqual(f.persisted().custom, stored.custom)
  assert.deepEqual(f.persisted().models[old.model.id], stored.models[old.model.id])
})

test('activation save failure restores the exact known binding instead of resolving the previous model again', async () => {
  const old = legacyRecord()
  const previous = compatibleRecord('previous-verified')
  const target = compatibleRecord(compatibleId)
  const stored = { custom: [old, previous, target], active: { image: previous.model.id }, models: { [old.model.id]: { ...old.model.defaults, steps: 17 }, [previous.model.id]: { ...previous.model.defaults, steps: 5, seed: 42 } } }
  const resources = authorized([...new Set([...old.model.resources, ...previous.model.resources, ...target.model.resources])])
  const saveError = Error('storage unavailable')
  const f = await fixture({ stored, resources, onSave: async () => { throw saveError } })
  const originalBinding = f.currentBinding('image')
  assert.equal(originalBinding.imageModels[0].id, previous.model.id)
  assert.equal(originalBinding.configuration.steps, 5)
  resources.find(resource => resource.id === previous.specification.id).revision = 'changed-after-original-binding'
  const before = structuredClone(await f.state())
  await assert.rejects(f.execute('activate-model', { modelId: target.model.id }), error => error === saveError)
  assert.deepEqual(f.currentBinding('image'), originalBinding)
  assert.deepEqual(f.bindings[2], originalBinding)
  assert.equal(f.bindings[1].imageModels[0].id, target.model.id)
  assert.equal(f.bindings.length, 3)
  assert.deepEqual(f.unbindings, [])
  assert.deepEqual((await f.state()).models, before.models)
  assert.deepEqual((await f.state()).runtimes, before.runtimes)
  assert.deepEqual(f.persisted(), stored)
  assert.equal(f.saves.length, 0)
})

test('failed binding recovery reports uncertainty and clears the binding cache so another activation cannot skip the real bind', async () => {
  for (const hadPreviousBinding of [false, true]) {
    const old = legacyRecord()
    const previous = compatibleRecord('previous-verified')
    const target = compatibleRecord(compatibleId)
    const stored = { custom: [old, previous, target], active: { image: hadPreviousBinding ? previous.model.id : old.model.id }, models: { [old.model.id]: { ...old.model.defaults, steps: 17, preservedExtra: 'retain' } } }
    const resources = authorized([...new Set([...old.model.resources, ...previous.model.resources, ...target.model.resources])])
    const saveError = Error('storage unavailable')
    let initialized = false, failRecovery = true
    const f = await fixture({
      stored, resources, onSave: async () => { throw saveError },
      onBind: async binding => {
        if (initialized && hadPreviousBinding && binding.imageModels[0].id === previous.model.id && failRecovery) {
          failRecovery = false
          throw Error('restore rejected')
        }
      },
      onUnbind: async () => {
        if (!hadPreviousBinding && failRecovery) { failRecovery = false; throw Error('unbind rejected') }
      },
    })
    initialized = true
    const initialBindings = f.bindings.length
    await assert.rejects(f.execute('activate-model', { modelId: target.model.id }), error => {
      assert.match(error.message, /storage unavailable.*恢复失败.*状态未确认/)
      assert.equal(error.cause, saveError)
      return true
    })
    assert.equal(f.currentBinding('image').imageModels[0].id, target.model.id)
    assert.deepEqual(f.persisted(), stored)
    assert.equal((await f.state()).models.find(model => model.id === stored.active.image).active, true)
    assert.equal(f.saves.length, 0)
    assert.equal(f.bindings.length, initialBindings + 1)

    await assert.rejects(f.execute('activate-model', { modelId: target.model.id }), error => error === saveError)
    assert.equal(f.bindings.length, initialBindings + 2)
    assert.equal(f.currentBinding('image'), undefined)
    assert.deepEqual(f.persisted(), stored)
  }
})

test('activation leaves busy runtime instances, queued requests, stored choices and records untouched', async () => {
  for (const instance of [
    { state: 'ready', active: 0, pending: 1 },
    { state: 'ready', active: 1, pending: 0 },
    { state: 'loading', active: 0, pending: 0 },
    { state: 'stopping', active: 0, pending: 0 },
  ]) {
    const old = legacyRecord()
    const target = compatibleRecord(compatibleId)
    const stored = { custom: [old, target], active: { image: old.model.id }, models: { [old.model.id]: { ...old.model.defaults, steps: 17, preservedExtra: 'retain' } } }
    const resources = authorized([...new Set([...old.model.resources, ...target.model.resources])])
    const runtimes = [{ runtime: 'image', configured: false, instances: [instance] }]
    const f = await fixture({ stored, resources, runtimes, onSave: async () => { throw Error('busy activation must not save') } })
    const before = structuredClone(await f.state())
    assert.match((await f.execute('activate-model', { modelId: target.model.id })).error, /当前模型正在使用/)
    assert.deepEqual((await f.state()).models, before.models)
    assert.deepEqual(runtimes, before.runtimes)
    assert.deepEqual(f.persisted(), stored)
    assert.equal(f.currentBinding('image'), undefined)
    assert.equal(f.bindings.length, 0)
    assert.equal(f.unbindings.length, 0)
    assert.equal(f.saves.length, 0)
    assert.equal(f.downloads.length, 0)
    assert.equal(f.preparations.length, 0)
  }
})
