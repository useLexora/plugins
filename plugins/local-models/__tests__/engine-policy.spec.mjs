import assert from 'node:assert/strict'
import test from 'node:test'
import { engineCompatibility, engineSpecification, initialEngineSelections, modelEngineRequirement, selectModelEngine } from '../enginePolicy.js'

const old = engineSpecification({ id: 'llama-b11747', kind: 'engine', legacy: true })
const next = { id: 'llama-vulkan-linux-x64-b12211', kind: 'engine', engineId: 'llama.cpp', backend: 'vulkan', version: 'b12211', platforms: ['linux-x64'] }
const cuda = { ...next, id: 'llama-cuda-linux-x64-b12211', backend: 'cuda' }
const specs = [old, next, cuda]
const model = { id: 'model', runtime: 'chat', resources: [old.id, 'weights'], metadata: { architecture: 'lfm3' } }

test('engine identity stays independent from immutable release resources and installed older builds remain selected', () => {
  assert.equal(old.title, 'llama.cpp')
  assert.equal(old.engineId, 'llama.cpp')
  assert.equal(old.version, 'b11747')
  const selections = initialEngineSelections(specs, [{ id: old.id, authorized: true }])
  assert.equal(selections['llama.cpp:vulkan'], old.id)
  assert.equal(initialEngineSelections(specs, [])['llama.cpp:vulkan'], next.id)
  const selected = selectModelEngine(model, { acceleration: 'cuda' }, specs, selections, 'linux-x64')
  assert.deepEqual(selected.resources, [cuda.id, 'weights'])
  assert.deepEqual(model.resources, [old.id, 'weights'])
})

test('missing or foreign explicit engine selections never fall back silently', () => {
  const choices = initialEngineSelections(specs, [], { 'llama.cpp:vulkan': 'removed' })
  assert.equal(choices['llama.cpp:vulkan'], 'removed')
  assert.equal(selectModelEngine(model, {}, specs, choices, 'linux-x64').engineSelectionMissing, true)
  assert.equal(selectModelEngine(model, {}, specs, { 'llama.cpp:vulkan': next.id }, 'windows-x64').engineSelectionMissing, true)
})

test('known architecture requirements report exact minimum and current builds without claiming unknown models are supported', () => {
  assert.deepEqual(modelEngineRequirement(model), { architecture: 'lfm3', minimumEngineVersion: 'b11960' })
  assert.match(engineCompatibility(model, old), /b11960.*b11747/)
  assert.equal(engineCompatibility(model, next), '')
  assert.equal(modelEngineRequirement({ ...model, metadata: { architecture: 'future' } }), null)
  assert.equal(modelEngineRequirement({ ...model, metadata: {}, title: 'LFM3' }), null)
  assert.equal(modelEngineRequirement({ ...model, files: { model: 'LFM3-1.7B-NVFP4.gguf' } }).minimumEngineVersion, 'b12088')
  assert.equal(modelEngineRequirement({ ...model, metadata: {}, origin: { repository: 'LiquidAI/LFM3-1.7B-GGUF' } }).minimumEngineVersion, 'b11960')
})

test('an explicitly imported CPU build is distinct from a GPU build running CPU-only', () => {
  const cpu = { ...next, id: 'custom-cpu', backend: 'cpu', custom: true }
  const selections = { 'llama.cpp:cpu': cpu.id, 'llama.cpp:vulkan': next.id }
  assert.equal(selectModelEngine(model, { acceleration: 'cpu' }, [...specs, cpu], selections, 'linux-x64').resources[0], cpu.id)
  assert.equal(selectModelEngine(model, { acceleration: 'gpu' }, [...specs, cpu], selections, 'linux-x64').resources[0], next.id)
})
