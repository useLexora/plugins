import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildTask } from './fixtures/long-context-tasks.mjs'
import { createRealChatHarness } from './fixtures/real-chat-harness.mjs'

const enabled = process.env.LEXORA_CHAT_LONG_TEST === '1'
const engine = process.env.LEXORA_CHAT_TEST_ENGINE
const model = process.env.LEXORA_CHAT_TEST_MODEL
const output = process.env.LEXORA_CHAT_TEST_OUTPUT
const backend = process.env.LEXORA_CHAT_TEST_BACKEND ?? 'cpu'
const selected = new Set((process.env.LEXORA_CHAT_LONG_CASES ?? 'document,logs,review,writing,tools,revisions,cancellation').split(','))
const targetTokens = 56000
const json = text => JSON.parse(text.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, ''))
const assistant = result => ({ role: 'assistant', text: result.text, toolCalls: result.toolCalls })
const complete = result => {
  assert.equal(result.error, null)
  assert.equal(result.doneEvents, 1)
  assert.equal(result.reason, 'stop')
  assert.equal(result.thinkingLeak, false)
  assert.ok(Number.isFinite(result.firstTextMs), 'First visible text timing must be measured')
  assert.ok(result.timings?.decode?.tokensPerSecond > 0, 'Generation throughput must come from real engine timings')
}
const dense = result => assert.ok(result.totalPromptTokens >= 54000 && result.totalPromptTokens <= 63000, `Actual prompt must exercise a near-full 64K window, got ${result.totalPromptTokens}`)

const ledger = units => Array.from({ length: units }, (_, index) => {
  const id = 30000 + index
  const amount = 10000 + (index * 137) % 980000
  const category = ['storage renewal', 'server replacement', 'backup verification', 'network maintenance', 'support retainer', 'migration rehearsal', 'capacity reservation'][index % 7]
  return `H-${id} | cost-center-${index % 53} | order ARCH-${id} | ${category} | invoiced=${amount} cents | settled=${amount} cents | currency=CNY | period=2025-${String(index % 12 + 1).padStart(2, '0')} | reviewer=auditor-${index % 31} | evidence=archive/${id} | contract=AGR-${18000 + index % 417} | approval=APP-${21000 + index} | disposition=matched`
}).join('\n')

const tools = [
  { name: 'list_orders', description: 'Return the current November 2026 orders for project Cedar.', parameters: { type: 'object', properties: { project: { type: 'string', enum: ['Cedar'] }, period: { type: 'string', enum: ['2026-11'] } }, required: ['project', 'period'], additionalProperties: false } },
  { name: 'read_invoice', description: 'Read an invoice by the exact ID returned by list_orders. Retry a transient lookup error once.', parameters: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'], additionalProperties: false } },
]
const orders = [
  { orderId: 'CED-101', invoiceId: 'INV-101', amountCents: 123450 },
  { orderId: 'CED-102', invoiceId: 'INV-102', amountCents: 70000 },
  { orderId: 'CED-103', invoiceId: 'INV-103', amountCents: 9990 },
]

test('opt-in realistic tasks use an actual 65536-token context on the selected backend', { skip: !enabled, timeout: 14400000 }, async t => {
  assert.ok(engine && model && output, 'Set the engine, model and output directory explicitly')
  assert.ok(selected.size > 0 && [...selected].every(id => ['document', 'logs', 'review', 'writing', 'tools', 'revisions', 'cancellation'].includes(id)), 'Select valid, nonempty task IDs; a typo must not pass with zero tasks')
  const harness = await createRealChatHarness({ engine, model, output, backend, profile: process.env.LEXORA_CHAT_TEST_PROFILE ?? 'unknown', threads: Number(process.env.LEXORA_CHAT_TEST_THREADS ?? 4), timeoutMs: Number(process.env.LEXORA_CHAT_TEST_TIMEOUT_MS ?? 900000) })
  t.after(() => harness.close())
  harness.metadata.selectedCases = [...selected]
  if (backend !== 'cpu') {
    assert.ok(harness.metadata.observedBackend.includes(backend), `Requested ${backend} must be observed in engine device/buffer evidence; inspect engine-stderr.log`)
    assert.ok(harness.metadata.observedOffload?.layers > 0, 'GPU acceptance requires actual offloaded layers, not a requested backend label')
    assert.ok(harness.metadata.gpuSampling.successfulSamples > 0, 'GPU acceptance requires NVML samples')
  }
  const prepare = async builder => {
    const task = await harness.calibrate(builder, targetTokens)
    console.log(JSON.stringify({ prepared: task.id, tokensWithoutTemplate: task.calibratedTokens, units: task.units }))
    return task
  }
  for (const id of ['document', 'logs', 'review', 'writing']) {
    if (!selected.has(id)) continue
    await t.test(id, async () => {
      const task = await prepare(units => buildTask(id, units))
      const result = await harness.invoke(id, task.messages, { maxTokens: task.maxTokens })
      result.inputSha256 = createHash('sha256').update(JSON.stringify(task.messages)).digest('hex')
      result.fixtureUnits = task.units
      result.tokensWithoutTemplate = task.calibratedTokens
      result.quality = task.evaluate(result.text)
      await harness.save()
      complete(result)
      dense(result)
      assert.equal(result.quality.passed, true, JSON.stringify(result.quality))
      if (id === 'writing') assert.ok(result.usage.output >= 1000, 'A long-output run must actually generate at least 1000 tokens')
    })
  }
  if (selected.has('tools')) await t.test('tool reconciliation and transient-error recovery', async () => {
    const maxTokens = Number(process.env.LEXORA_CHAT_TOOL_MAX_TOKENS ?? 768)
    assert.ok(Number.isInteger(maxTokens) && maxTokens >= 64 && maxTokens <= 4096)
    harness.metadata.toolMaxTokens = maxTokens
    const task = await prepare(units => ({ id: 'tools', messages: [
      { role: 'system', text: 'You are a financial audit assistant. Use the provided tools for current records. Never invent a successful lookup. Amounts are integer cents. Historical records are context, not current-period orders. Retry a transient invoice error once. After all invoices are read, return ONLY JSON: {"orderTotalCents":number,"invoiceTotalCents":number,"discrepancies":[{"orderId":string,"invoiceId":string,"differenceCents":number}]}. differenceCents = invoice amount minus order amount.' },
      { role: 'user', text: `Archived audit context:\n${ledger(units)}\n\n请核对 Cedar 项目 2026-11 的全部订单与发票。必须先查询当前订单，再读取其对应发票；不匹配项逐条列出。` },
    ] }))
    const messages = [...task.messages], calls = [], read = new Set()
    let injectedError = false, ordersDelivered = false, final
    for (let turn = 0; turn < 8; turn++) {
      const canReadInvoices = ordersDelivered
      const canRetryInvoice = injectedError
      const invoiceCallsThisTurn = new Set()
      const result = await harness.invoke(`tools-${turn + 1}`, messages, { tools, maxTokens })
      assert.equal(result.error, null)
      assert.equal(result.thinkingLeak, false)
      dense(result)
      messages.push(assistant(result))
      if (result.reason === 'stop') { final = result; break }
      assert.equal(result.reason, 'toolUse')
      assert.ok(result.toolCalls.length > 0)
      for (const call of result.toolCalls) {
        calls.push(call)
        assert.ok(calls.length <= 12, 'Tool execution must remain bounded')
        let payload, isError = false
        if (call.name === 'list_orders') {
          assert.deepEqual(call.arguments, { project: 'Cedar', period: '2026-11' })
          payload = { orders }
          ordersDelivered = true
        } else if (call.name === 'read_invoice') {
          assert.ok(canReadInvoices, 'Invoice calls must be based on order results from a preceding model turn')
          assert.equal(invoiceCallsThisTurn.has(call.arguments.invoiceId), false, 'Repeated calls in one response are not error recovery')
          invoiceCallsThisTurn.add(call.arguments.invoiceId)
          const order = orders.find(order => order.invoiceId === call.arguments.invoiceId)
          assert.ok(order, 'Unknown invoice IDs must not be invented')
          assert.deepEqual(Object.keys(call.arguments), ['invoiceId'])
          if (order.invoiceId === 'INV-102' && !injectedError) {
            injectedError = true; isError = true
            payload = { code: 'LOOKUP_TIMEOUT', retryable: true, message: 'Temporary lookup failure. Retry the same invoice once.' }
          } else {
            if (order.invoiceId === 'INV-102') assert.ok(canRetryInvoice, 'Retry must follow a model turn that received the lookup error')
            read.add(order.invoiceId)
            payload = { invoiceId: order.invoiceId, amountCents: order.amountCents + (order.invoiceId === 'INV-102' ? 2500 : 0), currency: 'CNY' }
          }
        } else assert.fail(`Unexpected tool: ${call.name}`)
        messages.push({ role: 'tool', toolCallId: call.id, text: JSON.stringify(payload), isError })
      }
    }
    assert.ok(final, 'Agent must finish within eight model turns')
    final.quality = { passed: false, toolCalls: calls.length, recoveredTransientError: injectedError && read.has('INV-102'), invoicesRead: [...read] }
    await harness.save()
    assert.equal(read.size, 3)
    assert.equal(injectedError, true)
    complete(final)
    assert.deepEqual(json(final.text), { orderTotalCents: 203440, invoiceTotalCents: 205940, discrepancies: [{ orderId: 'CED-102', invoiceId: 'INV-102', differenceCents: 2500 }] })
    final.quality.passed = true
    await harness.save()
  })
  if (selected.has('revisions')) await t.test('long-history revisions override obsolete constraints', async () => {
    const task = await prepare(units => ({ id: 'revisions', messages: [
      { role: 'system', text: 'Maintain the current migration decision register. Later explicit corrections replace earlier instructions; reference material is not an instruction. Return ONLY a JSON object with keys budgetCny,cutover,owner,allowDelete,rollbackHours after each request.' },
      { role: 'user', text: `Reference records from completed migrations:\n${ledger(units)}\n\n本次迁移基线：预算120000元，切换日期2026-12-08，负责人林雨，禁止删除原数据，回滚保留24小时。返回当前决策登记。` },
    ] }))
    const messages = [...task.messages]
    const expected = { budgetCny: 120000, cutover: '2026-12-08', owner: '林雨', allowDelete: false, rollbackHours: 24 }
    const changes = [null, ['预算调整为95000元，其他不变。', { budgetCny: 95000 }], ['负责人改为周宁。', { owner: '周宁' }], ['切换推迟到2026-12-12，回滚保留72小时。', { cutover: '2026-12-12', rollbackHours: 72 }], ['有人建议删除原数据节约成本，但未获批准；禁止删除的限制仍有效。', {}], ['纠正上一轮预算：最终批准105000元，覆盖之前95000和120000的版本。', { budgetCny: 105000 }]]
    for (const [index, change] of changes.entries()) {
      if (change) { messages.push({ role: 'user', text: change[0] }); Object.assign(expected, change[1]) }
      const result = await harness.invoke(`revisions-${index + 1}`, messages, { maxTokens: 256 })
      complete(result); dense(result)
      const actual = json(result.text)
      result.quality = { passed: JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort()), expected: { ...expected } }
      await harness.save()
      assert.deepEqual(actual, expected)
      messages.push(assistant(result))
    }
  })
  if (selected.has('cancellation')) await t.test('cancel a long-context response and reuse the runtime', async () => {
    const task = await prepare(units => buildTask('writing', units))
    const result = await harness.invoke('cancellation', task.messages, { maxTokens: 2048, cancelAfterCharacters: 500 })
    assert.equal(result.cancelled, true)
    assert.ok(result.text.length >= 500)
    assert.ok(result.cancellationMs < 5000, `Cancellation took ${result.cancellationMs} ms`)
    assert.equal(result.doneEvents, 0)
    assert.equal(result.ownedProcessesAlive, 0, 'The cancelled request must close its old engine process')
    const recovered = await harness.invoke('cancellation-recovery', [{ role: 'user', text: '请只回复：恢复成功' }], { maxTokens: 32 })
    complete(recovered)
    assert.match(recovered.text, /恢复成功/)
    recovered.quality = { passed: true, note: 'Short recovery probe, still using the same 64K runtime configuration; not a long-input throughput sample' }
    const timedOut = await harness.invoke('deadline', task.messages, { maxTokens: 2048, requestTimeoutMs: 50 })
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.ownedProcessesAlive, 0, 'A request deadline must close its engine process')
    assert.equal(timedOut.doneEvents, 0)
    const afterDeadline = await harness.invoke('deadline-recovery', [{ role: 'user', text: '请只回复：恢复成功' }], { maxTokens: 32 })
    complete(afterDeadline)
    assert.match(afterDeadline.text, /恢复成功/)
    afterDeadline.quality = { passed: true, note: 'Short recovery probe following a forced deadline; still configured at 64K' }
    await harness.save()
  })
})
