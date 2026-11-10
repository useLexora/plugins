import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildTask } from './fixtures/long-context-tasks.mjs'

const ids = ['document', 'logs', 'review', 'writing']
const copy = value => JSON.parse(JSON.stringify(value))
const reject = (task, mutate) => {
  const value = copy(task.expected.answer)
  mutate(value)
  const result = task.evaluate(JSON.stringify(value))
  assert.equal(result.passed, false)
  assert.ok(result.checks.some(check => !check.passed))
}
const records = task => task.messages[1].text.split('BEGIN SYNTHETIC MATERIAL\n')[1].split('\nEND SYNTHETIC MATERIAL')[0].split(/\n\n(?=\[(?:DOC|LOG|SRC|NOTE)-)/)

test('builders expose deterministic CPU-runner inputs without model or filesystem dependencies', () => {
  for (const id of ids) {
    const task = buildTask(id)
    assert.equal(task.id, id)
    assert.deepEqual(task.messages.map(message => message.role), ['system', 'user'])
    assert.ok(task.messages.every(message => typeof message.text === 'string' && message.text.length > 20))
    assert.ok(task.maxTokens >= 768 && task.maxTokens <= 2048)
    assert.equal(task.expected.contextWindow, 65536)
    assert.equal(task.expected.targetInputTokens, 56000)
    assert.equal(task.expected.units, 100)
    assert.deepEqual(task.messages, buildTask(id).messages)
    assert.equal(records(task).length, 100)
  }
  for (const units of [0, 19, 1.2, NaN, Infinity, '100', 20001]) assert.throws(() => buildTask('document', units), RangeError)
  assert.throws(() => buildTask('tools'), /Unknown/)
  assert.throws(() => buildTask('toString'), /Unknown/)
})

test('every material scales linearly with distinct records and distributed evidence', () => {
  for (const id of ids) {
    const small = buildTask(id, 1000)
    const large = buildTask(id, 4000)
    const a = records(small)
    const b = records(large)
    assert.equal(a.length, 1000)
    assert.equal(b.length, 4000)
    assert.equal(new Set(b).size, 4000)
    const bodies = b.map(record => record.replace(/^\[[^\]]+\] /, ''))
    assert.equal(new Set(bodies).size, 4000, `${id}: unique source bodies, not only source IDs`)
    const ratio = large.messages[1].text.length / small.messages[1].text.length
    assert.ok(ratio > 3.5 && ratio < 4.5, `${id} scaling ${ratio}`)
    assert.ok(small.messages[1].text.length > 90000)
    const fractions = Object.values(large.expected.anchors).map(anchor => anchor.fraction)
    assert.ok(fractions.some(fraction => fraction < 0.1))
    assert.ok(fractions.some(fraction => fraction > 0.4 && fraction < 0.6))
    assert.ok(fractions.some(fraction => fraction > 0.9))
    for (const [name, anchor] of Object.entries(large.expected.anchors)) {
      assert.ok(anchor.index > small.expected.anchors[name].index)
      assert.ok(b[anchor.index].startsWith(`[${anchor.source}] `))
      const before = b.slice(0, anchor.index).join('\n\n').length / large.messages[1].text.length
      assert.ok(Math.abs(before - anchor.fraction) < 0.07, `${id}/${name}: evidence distributed by actual character position`)
    }
  }
})

test('document, logs and review accept complete factually correct answers at different scales', () => {
  for (const id of ids.slice(0, 3)) {
    for (const units of [20, 100, 1703, 4000]) {
      const task = buildTask(id, units)
      const result = task.evaluate(JSON.stringify(task.expected.answer))
      assert.equal(result.passed, true, `${id}/${units}: ${JSON.stringify(result.checks)}`)
      assert.ok(result.checks.length >= 8)
      assert.ok(result.checks.every(check => typeof check.name === 'string' && typeof check.passed === 'boolean'))
    }
  }
})

test('document rejects unsigned proposals, missing safeguards, invented citations and duplicate decisions', () => {
  const task = buildTask('document')
  reject(task, value => { value.decisions[1].value = '90_DAYS' })
  reject(task, value => { value.decisions[0].owner = 'release' })
  reject(task, value => { value.decisions[2].effectiveDate = '2031-05-01' })
  reject(task, value => { value.decisions[0].evidence[0].source = task.expected.anchors.draft.source })
  reject(task, value => { value.decisions[0].evidence[0].quote += ' Approved by an invented executive.' })
  reject(task, value => { value.decisions[0].evidence[0].quote = 'EU_ONLY' })
  reject(task, value => { value.decisions[1] = copy(value.decisions[0]) })
  reject(task, value => { value.superseded = [] })
  reject(task, value => { value.safeguards.rawBodyStored = true })
  reject(task, value => { value.safeguards.observedHoursAtLeast = 1 })
  const shuffled = copy(task.expected.answer)
  shuffled.decisions.reverse()
  shuffled.superseded.reverse()
  assert.equal(task.evaluate(JSON.stringify(shuffled)).passed, true)
})

test('citations accept sufficient source fragments without terminal punctuation or fixed counts', () => {
  for (const id of ids.slice(0, 3)) {
    const task = buildTask(id)
    const value = copy(task.expected.answer)
    const trimQuotes = item => {
      if (!item || typeof item !== 'object') return
      if (Array.isArray(item.evidence)) {
        item.evidence = item.evidence.map(cite => ({ ...cite, quote: cite.quote.replace(/[.;]$/, '') }))
        item.evidence.push(copy(item.evidence[0]))
      }
      Object.values(item).forEach(trimQuotes)
    }
    trimQuotes(value)
    assert.equal(task.evaluate(JSON.stringify(value)).passed, true, id)
  }
  const task = buildTask('document')
  const value = copy(task.expected.answer)
  const source = task.expected.anchors.residency.source
  value.decisions[0].evidence = ['residency=EU_ONLY', 'owner=privacy', 'effectiveDate=2031-05-01', 'Customer payload and backups must stay in EU'].map(quote => ({ source, quote }))
  assert.equal(task.evaluate(JSON.stringify(value)).passed, true)
  value.decisions[0].evidence.splice(1, 1)
  assert.equal(task.evaluate(JSON.stringify(value)).passed, false, 'missing owner fact cannot be replaced by unrelated true text')
})

test('every extra citation must be genuine and nonempty; fragments cannot borrow another source', () => {
  const task = buildTask('document')
  for (const quote of ['', ' ', 'Approved by a nonexistent signer.']) {
    reject(task, value => { value.decisions[0].evidence.push({ source: task.expected.anchors.residency.source, quote }) })
  }
  reject(task, value => { value.decisions[0].evidence.push({ source: 'DOC-NOT-FOUND', quote: 'residency=EU_ONLY' }) })
  reject(task, value => { value.decisions[0].evidence.push({ source: task.expected.anchors.retention.source, quote: 'residency=EU_ONLY' }) })
  reject(task, value => { value.decisions[0].evidence[0].quote = 'residency=EU_ONLY, owner=privacy, effectiveDate=2031-05-01' })
  reject(task, value => { value.decisions[1].evidence = [{ source: task.expected.anchors.draft.source, quote: 'M-42 remains binding' }] })
  const logs = buildTask('logs')
  reject(logs, value => { value.rootCause.evidence = [{ source: logs.expected.anchors.reject.source, quote: 'audience=orders-v2 issuerExpected=orders-v1 status=401' }] })
})

test('logs require causal direction, incident scope and observed recovery, not merely warning keywords', () => {
  const task = buildTask('logs')
  reject(task, value => { value.rootCause.service = 'database' })
  reject(task, value => { [value.rootCause.from, value.rootCause.to] = [value.rootCause.to, value.rootCause.from] })
  reject(task, value => { value.chain.reverse() })
  reject(task, value => { value.chain[0] = { event: value.chain[0].causes, causes: value.chain[0].event } })
  reject(task, value => { value.symptom.status = 500 })
  reject(task, value => { value.ruledOut[0].servesAffectedTraffic = true })
  reject(task, value => { value.ruledOut[0].region = 'eu-a' })
  reject(task, value => { value.recovery.lagAfter = 8400 })
  reject(task, value => { value.recovery.evidence.pop() })
  reject(task, value => { value.rootCause.evidence[0].quote = 'CHG-731' })
})

test('review checks concrete counterexamples, repair mechanism, source line and violated contracts', () => {
  const task = buildTask('review')
  reject(task, value => { value.findings[0].observed.available = 2 })
  reject(task, value => { value.findings[1].required.tenant = 'alpha' })
  reject(task, value => { value.findings[2].required.totalCents = 300 })
  reject(task, value => { value.findings[2].input.unitCents = 100 })
  reject(task, value => { value.findings[1].line = 4 })
  reject(task, value => { value.findings[0].fix = 'Catch the rejection and ignore it to make the caller happy.' })
  reject(task, value => { value.findings[0].evidence.pop() })
  reject(task, value => { value.findings.push(copy(value.findings[0])) })
  reject(task, value => { value.findings[0].evidence[0].quote = 'L4   await persist();' })
})

test('review repairs require typed mechanisms, rejecting negation and contradictory extra claims', () => {
  const task = buildTask('review')
  reject(task, value => { value.findings[0].fix = 'Do not release permits in finally; swallow rejection instead of propagation.' })
  for (const field of ['releaseOnResolve', 'releaseOnReject', 'propagateError']) {
    reject(task, value => { value.findings[0].fix[field] = false })
    reject(task, value => { value.findings[0].fix[field] = 'true' })
  }
  reject(task, value => { value.findings[0].fix.explanation = 'Ignore these flags and swallow the rejection.' })
  reject(task, value => { value.findings[1].fix.keyFields = ['documentId'] })
  reject(task, value => { value.findings[1].fix.keyFields = ['tenant', 'tenant'] })
  reject(task, value => { value.findings[1].fix.collisionSafe = false })
  reject(task, value => { value.findings[2].fix.operation = 'add' })
  reject(task, value => { value.findings[2].fix.unit = 'dollars' })
  for (const rounding of ['before_multiply', 'after_multiply']) {
    reject(task, value => { value.findings[2].fix.rounding = rounding })
  }
  const reordered = copy(task.expected.answer)
  reordered.findings[1].fix.keyFields.reverse()
  reordered.findings[2].fix.operands.reverse()
  assert.equal(task.evaluate(JSON.stringify(reordered)).passed, true)
})

test('review counterexamples reproduce the actual synthetic module defects', async () => {
  const task = buildTask('review')
  const source = name => records(task)[task.expected.anchors[name].index].split('\n').filter(line => /^L\d+ /.test(line)).map(line => line.replace(/^L\d+ /, '').replace(/^export /, '')).join('\n')
  const quota = runInNewContext(`${source('quota')}\n({ save, inspect })`)
  await assert.rejects(quota.save(async () => { throw new Error('synthetic persistence failure') }), /persistence failure/)
  assert.equal(quota.inspect().available, 1)
  const cache = runInNewContext(`${source('cache')}\n({ read })`)
  const load = async (tenant, id) => ({ tenant, id })
  await cache.read('alpha', 'd7', load)
  assert.equal((await cache.read('beta', 'd7', load)).tenant, 'alpha')
  const ledger = runInNewContext(`${source('ledger')}\n({ total })`)
  assert.equal(ledger.total(149, 2), 200)
  assert.equal(149 * 2, task.expected.answer.findings[2].required.totalCents)
})

test('task instructions describe schemas without leaking the extracted answers', () => {
  const forbidden = { document: ['EU_ONLY', '30_DAYS', 'CANARY_5_PERCENT', '2031-05-01'], logs: ['CHG-731', 'CHG-732', 'orders-v2', '8400'], review: ['totalCents: 298', 'finally', 'collision-free'] }
  for (const [id, facts] of Object.entries(forbidden)) {
    const instruction = buildTask(id).messages[1].text.split('BEGIN SYNTHETIC MATERIAL')[0]
    for (const fact of facts) assert.equal(instruction.includes(fact), false, `${id}: leaked ${fact}`)
  }
})

test('evaluators fail closed on malformed, partial, keyword-only or unexpected-shaped outputs', () => {
  for (const id of ids.slice(0, 3)) {
    const task = buildTask(id)
    for (const output of ['', 'null', '[]', 'true', '{}', '{"decisions":{}}', '{"findings":[null]}', '{"chain":"CHG-731 AUTH_REJECT"}', 'EU_ONLY 30_DAYS CANARY_5_PERCENT CORE-QUOTA CORE-CACHE CORE-LEDGER', `\`\`\`json\n${JSON.stringify(task.expected.answer)}\n\`\`\``, JSON.stringify(task.expected.answer).slice(0, -1)]) {
      assert.equal(task.evaluate(output).passed, false, `${id}: ${output.slice(0, 50)}`)
    }
  }
})

const writingAnswer = `## scope: Scope and ownership
Action: Assign the acceptance owner and an independent reviewer before selecting synthetic fixtures. Record the model checksum, machine identifier, maintenance window, and approval boundary in the run manifest. Never delete original files or modify staged changes during acceptance preparation.
Verify: Require exactly 2 named roles to sign the manifest, with a documented contact channel and a clear decision deadline. Confirm that every selected dataset is synthetic and that no production account, payment record, or customer conversation entered the preparation folder.
Rollback: If ownership or authorization remains unclear, stop before launching any process and return the manifest for correction. Preserve the current workstation state, notify the reviewer about the missing decision, and reschedule the window rather than guessing permission.

## budget: Context budgeting
Action: Configure contextWindow as 65536 for every execution, including short probes, and measure the complete serialized conversation with the selected model tokenizer. Adjust distinct source records toward 56000 input tokens while reserving output capacity and template overhead explicitly.
Verify: Require the measured input count to remain within 600 tokens of the target and confirm that input plus output allowance and template overhead stays below the allocated context window. Compare server properties with requested settings before accepting the configuration.
Rollback: If token accounting or server allocation differs, stop generation and restore the previous configuration snapshot. Reduce fixture record count using measured proportions, serialize again, and repeat the tokenizer check without truncating evidence or changing the required context allocation.

## data: Data preparation
Action: Generate distinct records with stable source identifiers and vary their service, timestamp, and configuration fields. Redact any accidentally introduced credential before storing artifacts, and keep the original generated corpus separately from derived prompts so later investigations can reproduce evidence placement.
Verify: Expect exactly 0 credentials in the reviewed fixture sample and require every cited record identifier to resolve to one source paragraph. Measure evidence positions near the beginning, middle, and end, checking that resizing moves those positions without duplicating paragraphs.
Rollback: Quarantine a contaminated derivative rather than editing the preserved original corpus in place. Rebuild the affected fixture from its deterministic seed, record the replacement checksum, and ask the reviewer to confirm that the repaired material remains synthetic and independently traceable.

## baseline: Baseline execution
Action: Select CPU execution explicitly and reserve a maintenance window without competing inference workloads. Capture engine version, thread count, memory availability, and sampling settings alongside the prompt checksum; launch one bounded request and record first token latency separately from total completion time.
Verify: Require exactly 1 completion event and inspect actual allocation before interpreting performance. Check that the process stayed on CPU, emitted nonempty output, respected the requested token ceiling, and reported input usage consistent with the previously recorded tokenizer measurement.
Rollback: Cancel a stalled request through the supported cancellation path and wait for process termination before another attempt. Restore thread settings and release the inference instance, retaining timing diagnostics so an operator can distinguish resource pressure from a task quality failure.

## quality: Quality gates
Action: Parse each structured response and compare concrete decision values, causal edges, and numerical counterexamples against the fixture expectations. Validate every citation against its source record and reject answers that merely repeat vocabulary while reversing causality or inventing supporting quotations.
Verify: Require exactly 0 failed factual checks and confirm that deliberately corrupted answers are rejected by the same evaluator. Review missing evidence independently from formatting failures, and preserve the complete response so a truncated answer cannot accidentally be counted as correct.
Rollback: Mark the run as failed rather than relaxing the evaluator when results are inconvenient. Retain the response and failed check names, investigate whether generation ended early, and rerun only after documenting a justified configuration change that does not weaken acceptance criteria.

## revision: Multi-turn revision
Action: Reuse the original document background, then introduce one explicitly approved revision in a subsequent user turn. Ask for the updated decisions with supporting citations, preserve the earlier exchange, and require the model to distinguish the new approval from superseded unsigned suggestions.
Verify: Require exactly 1 changed decision while every unchanged owner, effective date, and safety gate remains equal to the original accepted result. Confirm that the revised citation points to the new approval and that earlier evidence is retained for unaffected requirements.
Rollback: Restore the saved conversation branch if a revised answer changes unrelated decisions or loses their evidence. Keep the failing branch for diagnosis, identify the unsupported change, and start a fresh revision trial from the accepted baseline rather than silently repairing model output.

## recovery: Failure and recovery
Action: Capture a preflight snapshot of configuration and record the precise shutdown procedure before starting inference. Define separate responses for invalid JSON, resource exhaustion, and cancellation; preserve diagnostic logs without secrets and make rollback responsibility explicit to the operator on duty.
Verify: Require exactly 0 active inference processes after cancellation and compare restored configuration values against the snapshot. Confirm that original files remain intact, temporary resources were released, and retained logs contain enough timestamps to reconstruct the failure without exposing credentials.
Rollback: Apply the saved configuration through the supported interface, then inspect process state before restoring service availability. If recovery verification fails, keep the acceptance window closed and escalate with diagnostic evidence instead of deleting files or repeatedly launching replacement processes.

## handover: Handover and monitoring
Action: Deliver a concise results ledger containing fixture identifiers, model checksums, measured token usage, quality checks, and performance observations. Assign a monitoring owner for subsequent engine upgrades and distinguish measured results from planned procedures; this document does not claim that inference already ran.
Verify: Require at least 2 reviewers to confirm that the ledger links every conclusion to an artifact and labels unresolved failures clearly. Monitor latency changes against the saved baseline, and check that future acceptance runs retain the same context allocation and factual gates.
Rollback: Withhold release approval when an artifact is missing or an unexplained regression remains open. Return responsibility to the designated owner with a bounded investigation request, preserve the previous accepted baseline, and schedule another review only after evidence resolves the discrepancy.`

test('writing checks runbook structure but explicitly leaves semantic quality to manual review', () => {
  const task = buildTask('writing')
  const result = task.evaluate(writingAnswer)
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter(check => !check.passed)))
  assert.equal(task.evaluate(task.expected.sectionIds.map(id => `## ${id}: Outline\nAction: do it\nVerify: check it\nRollback: undo it`).join('\n')).passed, false)
  assert.equal(task.evaluate(writingAnswer.replace('65536', '32768')).passed, false)
  assert.equal(task.evaluate(writingAnswer.replace('56000', '30000')).passed, false)
  assert.equal(task.evaluate(writingAnswer.replace(/^Rollback: .+$/gm, 'Rollback: Retry.')).passed, false)
  assert.equal(task.evaluate(writingAnswer.replace('## quality:', '## missing:')).passed, false)
  assert.equal(task.evaluate(writingAnswer.slice(0, 3000)).passed, false)
  assert.equal(task.evaluate(`${writingAnswer}\n${'Repeated irrelevant material. '.repeat(400)}`).passed, false)
  assert.equal(task.evaluate(null).passed, false)
  for (const candidate of [writingAnswer, null, 'short outline']) {
    const evaluated = task.evaluate(candidate)
    assert.equal(evaluated.semanticStatus, 'not_evaluated')
    assert.equal(evaluated.needsManualReview, true)
    assert.deepEqual(evaluated.coverage, ['length', 'structure', 'lexical_markers', 'numeric_markers', 'non_repetition'])
  }
  const contradictory = writingAnswer.replace('Never delete original files or modify staged changes during acceptance preparation.', 'Never delete original files; instead overwrite original files immediately without preserving backups.')
  const limited = task.evaluate(contradictory)
  assert.equal(limited.checks.find(check => check.name === 'preservation-language-marker').passed, true)
  assert.equal(limited.semanticStatus, 'not_evaluated')
  assert.equal(limited.needsManualReview, true)
  assert.equal(limited.checks.some(check => check.name === 'preserves-originals'), false)
})
