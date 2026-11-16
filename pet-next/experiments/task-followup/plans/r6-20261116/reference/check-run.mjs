// Independent evidence checker: does not import the driver, evaluator or product code.
// END-STATE is only a terminal-file barrier; none of its verdict/data is read.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const read = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const lines = p => readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const parse = value => value ? JSON.parse(value) : null;
const ms = value => Date.parse(value);
const uniq = values => [...new Set(values)];
const sum = values => values.reduce((a, b) => a + b, 0);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node check-run.mjs --run <completed run directory> [--out <new JSON file>] [--expectations <frozen expectations JSON>]\nExit 0: all independent checks pass; 1: completed-run check failures; 2: incomplete/malformed input. No GPU/network/product imports.');
  process.exit(0);
}
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
try {
  if (!option('--run')) throw new Error('--run is required');
  const run = resolve(option('--run'));
  const out = resolve(option('--out') ?? join(here, `${basename(run)}.json`));
  if (existsSync(out)) throw new Error(`Refusing to overwrite existing score: ${out}`);
  const outRelative = relative(run, out);
  if (!outRelative.startsWith('..') && !isAbsolute(outRelative)) throw new Error('Output must be outside the read-only run');
  const timelinePath = join(run, 'driver/timeline.jsonl');
  if (!existsSync(join(run, 'END-STATE.json')) || !existsSync(timelinePath)) throw new Error('Run not terminal; no database opened');
  const timeline = lines(timelinePath);
  if (!timeline.some(e => e.kind === 'driver.done') || read(join(run, 'workspace/state/host.json')).state !== 'stopped') throw new Error('Driver/host not stopped; no database opened');
  const start = timeline.find(e => e.kind === 'driver.start');
  const origin = timeline.find(e => e.kind === 'origin')?.origin;
  if (!start || !Number.isFinite(ms(origin))) throw new Error('Missing driver.start/origin');
  const trajectoryPath = start.trajectory;
  const trajectory = read(trajectoryPath);
  const expectationPath = resolve(option('--expectations') ?? trajectoryPath.replace(/\.trajectory\.json$/, '.expectations.json'));
  const expected = read(expectationPath);
  if (!['TDEV-01', 'TDEV-02'].includes(expected.trajectoryId)) throw new Error('Only frozen TDEV-01/TDEV-02 supported');
  const checks = [];
  const check = (id, ok, evidence = null) => { checks.push({ id, ok: Boolean(ok), evidence }); return Boolean(ok); };
  check('frozen_trajectory_bytes', sha(trajectoryPath) === start.trajectorySha, { recorded: start.trajectorySha, actual: sha(trajectoryPath) });
  check('trajectory_expectation_identity', trajectory.id === expected.trajectoryId, { trajectory: trajectory.id, expected: expected.trajectoryId });
  const workspace = join(run, 'workspace');
  const inside = p => { if (!p) return null; const target = resolve(workspace, p), r = relative(workspace, target); if (r.startsWith('..') || isAbsolute(r)) throw new Error(`Outside workspace: ${p}`); return target; };
  const fileSha = p => p && existsSync(p) ? sha(p) : null;
  const fileJson = p => p && existsSync(p) ? read(p) : null;
  const dbPath = join(workspace, 'state/followup.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let tables;
  try { tables = Object.fromEntries(['tasks','receipts','effects','attentions','notifications','followup_events','command_log','wake_jobs','assessments'].map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()])); }
  finally { db.close(); }
  const { tasks, receipts, effects, attentions, notifications, followup_events: events, command_log: commands, wake_jobs: wakeJobs, assessments } = tables;
  const taskMap = Object.fromEntries(timeline.filter(e => e.kind === 'task.created').map(e => [e.alias, e.ticketId]));
  const aliasFor = id => Object.keys(taskMap).find(a => taskMap[a] === id) ?? null;
  const httpDir = join(run, 'http');
  const http = readdirSync(httpDir).filter(n => n.endsWith('.json')).sort().map(n => ({ file: n, ...read(join(httpDir, n)) }));
  const hostLog = lines(join(workspace, 'state/host.log'));
  const producerDir = join(workspace, 'producer-evidence');
  const producerFiles = readdirSync(producerDir).filter(n => n.endsWith('.jsonl'));
  const producer = producerFiles.flatMap(n => lines(join(producerDir, n)));
  const published = producer.filter(e => e.event === 'result.published');
  const snapshots = readdirSync(join(run, 'driver')).filter(n => /^snapshot-.*\.json$/.test(n)).sort().map(n => ({ file: n, ...read(join(run, 'driver', n)) }));
  const observations = events.filter(e => e.kind === 'artifact.observed').map(e => ({ ...e, payload: parse(e.payload_json) }));
  const artifactChecks = [];

  function inspectReceipt(t, r, requirement) {
    const ref = parse(r.input_ref_json), effect = effects.find(e => e.effect_id === r.effect_id);
    const result = parse(t.result_json), analysis = parse(t.analysis_json), completion = parse(t.completion_json);
    const inputPath = inside(result?.resultPath), input = fileJson(inputPath), inputSha = fileSha(inputPath);
    const artifactPath = inside(input?.artifactPath), artifact = fileJson(artifactPath), artifactSha = fileSha(artifactPath);
    const outputPath = inside(r.output_path), outputSha = fileSha(outputPath);
    const output = outputSha ? readFileSync(outputPath, 'utf8') : '';
    const samples = artifact?.samples ?? [], failed = samples.filter(s => s.pass === false), passed = samples.filter(s => s.pass === true);
    const clusters = {}; for (const s of failed) { const k = (s.note ?? 'unknown').split(':')[0]; clusters[k] = (clusters[k] ?? 0) + 1; }
    const produced = published.find(p => p.runId === ref?.runId && p.revision === ref?.revision && p.resultFileSha === inputSha && p.artifactSha === artifactSha);
    const observed = observations.find(e => e.ticket_id === t.ticket_id && e.source_id === ref?.sourceId && e.source_revision === ref?.sourceRevision && e.payload.resultFileSha === inputSha);
    const currentIdentity = Boolean(ref && effect && r.ok === 1 && r.inputs_verified === 1 && r.needs_reconciliation === 0 && effect.state === 'succeeded'
      && r.ticket_id === t.ticket_id && r.task_revision === t.task_revision && r.assignment_id === t.assignment_id
      && effect.ticket_id === r.ticket_id && effect.task_revision === r.task_revision && effect.assignment_id === r.assignment_id && effect.attempt_id === r.attempt_id
      && ref.taskId === t.ticket_id && ref.taskRevision === t.task_revision && ref.assignmentId === t.assignment_id && same(ref, parse(effect.input_ref_json))
      && ref.runId === result?.runId && ref.revision === result?.revision && ref.runId === input?.runId && ref.revision === input?.revision
      && ref.resultFileSha === inputSha && inputSha === result?.resultFileSha && ref.artifactSha === artifactSha && artifactSha === input?.artifactSha
      && outputSha && outputSha === r.output_sha256 && outputSha === analysis?.artifactSha && analysis?.receiptId === r.receipt_id
      && outputSha === completion?.artifactSha && completion?.receiptId === r.receipt_id && same(completion?.inputRef, ref)
      && fileSha(inside(`state/inputs/${inputSha}.json`)) === inputSha && produced && observed);
    const countCorrect = samples.length > 0 && passed.length + failed.length === samples.length && same(samples, input?.samples)
      && input?.metrics?.total === samples.length && input?.metrics?.passed === passed.length && input?.metrics?.failed === failed.length
      && output.includes(`total=${samples.length} passed=${passed.length} failed=${failed.length}`)
      && failed.every(s => output.includes(s.id)) && Object.entries(clusters).every(([k, v]) => output.includes(`${k}: ${v}`));
    const expectedCorrect = ref?.runId === requirement.receipt.runId && ref?.revision === requirement.receipt.revision
      && resolve(outputPath ?? workspace) === inside(requirement.artifact.relativePath.replace('{ticketId}', t.ticket_id))
      && requirement.artifact.mustContain.every(s => output.includes(s)) && requirement.artifact.mustNotContain.every(s => !output.includes(s));
    const record = { taskAlias: aliasFor(t.ticket_id), receiptId: r.receipt_id, effectId: r.effect_id, currentIdentity, countCorrect, expectedCorrect,
      valid: currentIdentity && countCorrect && expectedCorrect, inputRef: ref, outputPath, outputSha, inputSha, artifactSha,
      total: samples.length, passed: passed.length, failed: failed.length, failedIds: failed.map(s => s.id), clusters,
      producerAt: produced?.at ?? null, observedAt: observed?.observed_at ?? null };
    artifactChecks.push(record);
    check(`${record.taskAlias}:receipt:${r.receipt_id}:identity_and_bytes`, currentIdentity, record);
    check(`${record.taskAlias}:receipt:${r.receipt_id}:sample_recomputation`, countCorrect, { total: samples.length, passed: passed.length, failed: failed.length, clusters });
    check(`${record.taskAlias}:receipt:${r.receipt_id}:frozen_expected_content`, expectedCorrect, { expectedRun: requirement.receipt.runId, expectedRevision: requirement.receipt.revision });
    return record;
  }
  const taskResults = expected.requiredFinal.map(requirement => {
    const t = tasks.find(t => t.ticket_id === taskMap[requirement.taskAlias]);
    check(`${requirement.taskAlias}:final_status`, t?.status === requirement.status, { actual: t?.status, required: requirement.status });
    if (!t) return { taskAlias: requirement.taskAlias, missing: true, validCompletion: false };
    const ownReceipts = receipts.filter(r => r.ticket_id === t.ticket_id), ownNotifications = notifications.filter(n => n.ticket_id === t.ticket_id);
    const cancel = events.find(e => e.ticket_id === t.ticket_id && e.kind === 'user.cancelled');
    const cancelRequest = requirement.notificationsAfterTurn ? timeline.find(e => e.kind === 'turn.released' && e.sourceTurnId === requirement.notificationsAfterTurn) : null;
    const later = at => ownNotifications.filter(n => [n.created_at,n.delivered_at,n.presented_at].some(v => v && ms(v) > ms(at)));
    if (requirement.notificationsAfterTurn) {
      check(`${requirement.taskAlias}:cancellation_recorded`, Boolean(cancelRequest && cancel), { requestAt: cancelRequest?.at, cancelledAt: cancel?.recorded_at });
      check(`${requirement.taskAlias}:no_notice_after_cancel_request`, Boolean(cancelRequest) && later(cancelRequest.at).length === requirement.notificationsAfterTurnCount, cancelRequest ? later(cancelRequest.at) : 'missing cancellation request');
      check(`${requirement.taskAlias}:no_notice_after_effective_cancel`, Boolean(cancel) && later(cancel.recorded_at).length === 0, cancel ? later(cancel.recorded_at) : 'missing cancellation event');
    }
    if (requirement.successfulToolReceipts !== undefined) check(`${requirement.taskAlias}:successful_receipts`, ownReceipts.filter(r => r.ok === 1).length === requirement.successfulToolReceipts, ownReceipts.map(r => ({ id: r.receipt_id, ok: r.ok })));
    let validCompletion = false;
    if (requirement.receipt) {
      const requiredReceipts = ownReceipts.filter(r => r.tool === requirement.receipt.tool);
      check(`${requirement.taskAlias}:exact_receipt_count`, requiredReceipts.length === requirement.receipt.count, { actual: requiredReceipts.length, expected: requirement.receipt.count });
      const inspected = requiredReceipts.map(r => inspectReceipt(t, r, requirement));
      validCompletion = t.status === 'completed' && inspected.length === requirement.receipt.count && inspected.every(x => x.valid);
      check(`${requirement.taskAlias}:effective_completion`, validCompletion);
    }
    return { taskAlias: requirement.taskAlias, ticketId: t.ticket_id, status: t.status, stage: t.stage, validCompletion,
      receipts: ownReceipts.length, successfulReceipts: ownReceipts.filter(r => r.ok === 1).length,
      notifications: { created: ownNotifications.length, delivered: ownNotifications.filter(n => n.delivered_at).length, presented: ownNotifications.filter(n => n.presented_at).length,
        afterCancel: cancel ? later(cancel.recorded_at).length : null, afterCancellationRequest: cancelRequest ? later(cancelRequest.at).length : null },
      cancellationRequestAt: cancelRequest?.at ?? null, cancelledAt: cancel?.recorded_at ?? null };
  });

  const answerEvents = events.filter(e => e.kind === 'user.answered').map(e => ({ ...e, payload: parse(e.payload_json) }));
  const sameBody = (body, captured) => ['ticketId','attentionId','decisionId','taskRevision','optionId'].every(k => body?.[k] === captured?.[k]);
  const acceptedHttp = h => h.status === 200 && h.json?.ok === true && h.json?.result?.ok === true;
  const decisions = expected.requiredDecisions.map((requirement, index) => {
    const responseSpec = trajectory.userModel.responses.find(r => r.reply.turnId === requirement.answerTurn);
    if (!responseSpec) throw new Error(`No response spec for ${requirement.answerTurn}`);
    const ticket = taskMap[requirement.taskAlias], wanted = responseSpec.requires.renderedCurrentResult;
    const productionId = requirement.validFrom.split(' ')[0];
    const production = published.find(p => p.productionId === productionId);
    const observed = observations.find(e => e.ticket_id === ticket && e.payload.runId === wanted.runId && e.payload.revision === wanted.revision);
    const revisionOf = a => Math.max(0, ...(parse(a.evidence_json) ?? []).filter(e => String(e.sourceId).endsWith(`/${wanted.runId}`)).map(e => Number(/^r(\d+):/.exec(e.sourceRevision ?? '')?.[1] ?? 0)));
    const matching = attentions.filter(a => a.ticket_id === ticket && revisionOf(a) === wanted.revision);
    const rendered = timeline.filter(e => e.kind === 'test_client.rendered' && e.responseId === responseSpec.id && e.task?.ticketId === ticket && e.task?.result?.runId === wanted.runId && e.task?.result?.revision === wanted.revision);
    const choice = timeline.find(e => e.kind === 'user.choice_request' && e.sourceTurnId === requirement.answerTurn && e.responseId === responseSpec.id);
    const capture = choice?.body;
    const notice = capture ? notifications.find(n => n.ticket_id === ticket && n.attention_id === capture.attentionId && n.decision_id === capture.decisionId) : null;
    const attention = capture ? attentions.find(a => a.attention_id === capture.attentionId && a.decision_id === capture.decisionId && a.ticket_id === ticket) : null;
    const render = capture ? rendered.find(e => e.task.decision?.attentionId === capture.attentionId && e.task.decision?.decisionId === capture.decisionId) : null;
    const presentHttp = capture ? http.find(h => h.request?.route === '/api/present' && h.request.body?.ticketId === ticket && h.request.body.attentionId === capture.attentionId && h.status === 200 && h.json?.presented?.includes(capture.attentionId)) : null;
    const answerHttp = capture ? http.find(h => h.request?.route === '/api/answer' && sameBody(h.request.body, capture) && ms(h.request.startedAt) >= ms(choice.at)) : null;
    const answerEvent = capture ? answerEvents.find(e => e.ticket_id === ticket && e.payload.attentionId === capture.attentionId) : null;
    const producedOk = matching.length >= requirement.minimum && matching.length <= requirement.maximum && Boolean(observed && production) && matching.every(a => ms(a.created_at) >= ms(observed.observed_at));
    const visibleOk = Boolean(render && notice?.presented_at && presentHttp && attention && attention.task_revision === capture.taskRevision && notice.delivered_at
      && ms(render.at) <= ms(notice.presented_at) && ms(notice.delivered_at) <= ms(notice.presented_at)
      && ms(notice.presented_at) - ms(origin) <= requirement.mustBePresentedByMs && ms(notice.presented_at) >= ms(observed?.observed_at));
    const visibleBeforeReply = Boolean(visibleOk && answerHttp && ms(notice.presented_at) <= ms(answerHttp.request.startedAt));
    const shouldReject = Boolean(requirement.answerMustBeRejectedAfterSupersession);
    const laterObserved = observed && observations.find(e => e.ticket_id === ticket && e.payload.runId === wanted.runId && e.payload.revision > wanted.revision && ms(e.observed_at) < ms(answerHttp?.request.startedAt));
    const rejectionCode = answerHttp?.json?.result?.code ?? answerHttp?.json?.code ?? answerHttp?.json?.error ?? null;
    const explicitRejection = answerHttp && !acceptedHttp(answerHttp) && (answerHttp.json?.result?.ok === false || (answerHttp.status === 409 && answerHttp.json?.ok === false));
    const answeredOk = shouldReject ? Boolean(visibleBeforeReply && laterObserved && explicitRejection && rejectionCode && !answerEvent && attention.state === 'superseded')
      : Boolean(visibleBeforeReply && acceptedHttp(answerHttp) && answerEvent && attention.state === 'answered' && attention.answer_option_id === responseSpec.reply.optionId);
    check(`decision:${index}:current_version_produced_once`, producedOk, { expected: wanted, attentionIds: matching.map(a => a.attention_id), observedAt: observed?.observed_at, producerAt: production?.at });
    check(`decision:${index}:actually_presented_in_window`, visibleOk, { responseId: responseSpec.id, presentedAt: notice?.presented_at, deadlineMs: requirement.mustBePresentedByMs, renderAt: render?.at, presentHttp: presentHttp?.file });
    check(`decision:${index}:${shouldReject ? 'old_answer_rejected_without_event' : 'visible_answer_accepted'}`, answeredOk, { responseId: responseSpec.id, attentionId: capture?.attentionId, answerHttp: answerHttp?.file, httpStatus: answerHttp?.status, code: rejectionCode, answerEvent: answerEvent?.event_id ?? null, laterObservedAt: laterObserved?.observed_at });
    return { taskAlias: requirement.taskAlias, responseId: responseSpec.id, answerTurn: requirement.answerTurn, wanted, produced: matching.length, producedOk, visibleOk, answeredOk,
      shouldReject, rejectionCode, attentionId: capture?.attentionId ?? null, decisionId: capture?.decisionId ?? null, presentedAt: notice?.presented_at ?? null, repliedAt: answerHttp?.request.startedAt ?? null };
  });
  // Every actual acceptance must have its own preceding persisted presentation.
  for (const h of http.filter(h => h.request?.route === '/api/answer' && acceptedHttp(h))) {
    const b = h.request.body, n = notifications.find(n => n.ticket_id === b.ticketId && n.attention_id === b.attentionId && n.decision_id === b.decisionId);
    check(`accepted_answer_visible:${h.file}`, Boolean(n?.presented_at && ms(n.presented_at) <= ms(h.request.startedAt)), { attentionId: b.attentionId, presentedAt: n?.presented_at, answeredAt: h.request.startedAt });
  }
  const duplicates = Object.entries(Object.groupBy(notifications, n => `${n.ticket_id}:${n.decision_id}`)).filter(([, ns]) => ns.length > 1).map(([key, ns]) => ({ key, ids: ns.map(n => n.notification_id) }));
  check('no_same_decision_duplicate_notifications', duplicates.length === 0, duplicates);
  const avoidables = (expected.avoidables ?? []).map((a, i) => {
    const own = notifications.filter(n => n.ticket_id === taskMap[a.taskAlias]);
    let found = [];
    if (a.afterTurn) { const turn = timeline.find(e => e.kind === 'turn.released' && e.sourceTurnId === a.afterTurn); found = turn ? own.filter(n => [n.created_at,n.delivered_at,n.presented_at].some(v => v && ms(v) > ms(turn.at))) : own; }
    if (a.intervalMs) found = own.filter(n => ms(n.created_at) - ms(origin) >= a.intervalMs[0] && ms(n.created_at) - ms(origin) < a.intervalMs[1]);
    if (Number.isFinite(a.fromMs) && Number.isFinite(a.toMs)) found = own.filter(n => ms(n.created_at) - ms(origin) >= a.fromMs && ms(n.created_at) - ms(origin) < a.toMs);
    if (a.kind === 'same_decision_duplicate') found = own.filter(n => duplicates.some(d => d.ids.includes(n.notification_id)));
    check(`avoidable:${i}:${a.taskAlias}`, found.length === 0, { definition: a, notificationIds: found.map(n => n.notification_id) });
    return { definition: a, count: found.length, notificationIds: found.map(n => n.notification_id) };
  });

  const starts = timeline.filter(e => e.kind === 'host.start'), liveStarts = starts.filter(e => !e.seed);
  const stops = timeline.filter(e => e.kind === 'host.stopped');
  const expectedLiveCount = trajectory.timeline.filter(e => e.kind === 'service.start').length;
  check('distinct_live_processes_for_all_starts', liveStarts.length === expectedLiveCount && uniq(liveStarts.map(s => s.pid)).length === expectedLiveCount, { expected: expectedLiveCount, actualPids: liveStarts.map(s => s.pid) });
  for (const s of starts) {
    const stop = stops.find(e => e.name === s.name && e.pid === s.pid), request = timeline.find(e => e.kind === 'host.stop_request' && e.pid === s.pid && e.requestId === stop?.requestId);
    const exit = timeline.find(e => e.kind === 'host.exit' && e.pid === s.pid);
    check(`host_closed:${s.name}`, Boolean(stop && request && exit && stop.forced === false && exit.code === 0 && exit.signal === null
      && stop.receipt?.type === 'pet-followup:service-stopped' && stop.receipt.pid === s.pid && stop.receipt.requestId === request.requestId
      && stop.receipt.dbClosed === true && stop.receipt.state === 'stopped' && ms(stop.receipt.stoppedAt) >= ms(request.at)),
    { pid: s.pid, stopRequestId: request?.requestId, receipt: stop?.receipt, exitCode: exit?.code, forced: stop?.forced });
  }
  const health = http.filter(h => h.request?.route === '/api/health');
  const manualCommands = commands.filter(c => /^(tick|advance|seed)$/i.test(c.name));
  const forbiddenHttp = http.filter(h => /\/(?:tick|advance|seed|drain)(?:[/?]|$)/i.test(h.request?.route ?? ''));
  const manualArgs = starts.filter(s => s.argv.some(a => /^(?:--clock|--now|--fake-clock|tick|advance|drain)$/.test(a)));
  check('real_clock_no_manual_tick', health.length >= starts.length && health.every(h => h.status === 200 && h.json?.clock === 'real') && starts.every(s => s.clock === 'RealClock') && !manualCommands.length && !forbiddenHttp.length && !manualArgs.length,
    { healthCount: health.length, hostCount: starts.length, manualCommands, forbiddenHttp: forbiddenHttp.map(h => h.file), manualArgs: manualArgs.map(s => s.name) });
  const finalSnapshot = snapshots.find(s => s.label === 'final');
  const recovery = expected.recovery.map((requirement, index) => {
    const before = snapshots.find(s => s.label === `before-stop-${index + 1}`), restarted = liveStarts[index + 1];
    const details = [];
    if (requirement.mustKeepCompletion || requirement.mustKeepArtifactSha || requirement.mustNotDuplicateReceipts) {
      for (const req of expected.requiredFinal.filter(r => r.status === 'completed')) {
        const t = taskResults.find(t => t.taskAlias === req.taskAlias), b = before?.data?.[req.taskAlias]?.task, f = finalSnapshot?.data?.[req.taskAlias]?.task;
        const artifact = artifactChecks.find(a => a.taskAlias === req.taskAlias && a.valid);
        const ok = Boolean(t?.validCompletion && b?.status === 'completed' && f?.status === 'completed' && artifact && b.report?.sha256 === artifact.outputSha && f.report?.sha256 === artifact.outputSha
          && b.report.receiptId === artifact.receiptId && f.report.receiptId === artifact.receiptId && restarted && ms(before.at) < ms(restarted.at) && ms(finalSnapshot.at) > ms(restarted.at)
          && receipts.filter(r => r.ticket_id === t.ticketId && r.tool === req.receipt.tool).length === req.receipt.count);
        check(`recovery:${index}:${req.taskAlias}:completion_bytes_and_receipt_survive`, ok, { beforeAt: before?.at, restartAt: restarted?.at, afterAt: finalSnapshot?.at, beforeReport: b?.report, afterReport: f?.report, recomputedSha: artifact?.outputSha });
        details.push({ taskAlias: req.taskAlias, ok });
      }
    }
    if (requirement.mustKeepOldAttentionInvalid || requirement.mustNotReuseOldAnswer) {
      const stale = decisions.filter(d => d.shouldReject);
      const ok = stale.length > 0 && stale.every(d => d.answeredOk) && receipts.filter(r => r.tool === 'write_analysis').every(r => {
        const current = decisions.find(d => !d.shouldReject && d.taskAlias === aliasFor(r.ticket_id) && d.answeredOk);
        return current && ms(r.started_at) >= ms(current.repliedAt);
      });
      check(`recovery:${index}:old_answer_not_reused`, ok, stale);
    }
    if (requirement.productionWhileStopped) {
      const p = published.find(p => p.productionId === requirement.productionWhileStopped), previous = stops.find(s => s.name === liveStarts[index]?.name);
      const observed = p && observations.find(e => e.payload.runId === p.runId && e.payload.revision === p.revision);
      const ok = Boolean(p && previous && restarted && observed && ms(p.at) > ms(previous.receipt.stoppedAt) && ms(p.at) < ms(restarted.at) && ms(observed.observed_at) >= ms(restarted.at));
      check(`recovery:${index}:offline_production_observed_after_restart`, ok, { production: p?.productionId, publishedAt: p?.at, stoppedAt: previous?.receipt?.stoppedAt, restartedAt: restarted?.at, observedAt: observed?.observed_at });
    }
    return { requirement, details };
  });

  const ioDir = join(run, 'model-io');
  const calls = readdirSync(ioDir).filter(n => n.endsWith('.request.json')).sort().map(n => {
    const request = read(join(ioDir, n)), rp = join(ioDir, n.replace('.request.json', '.response.json')), response = existsSync(rp) ? read(rp) : null;
    return { file: n, purpose: n.includes('-memory-extract-') ? 'extract' : 'assess', stage: ms(request.sentAt) < ms(origin) ? 'prelude' : 'live',
      sentAt: request.sentAt, receivedAt: response?.receivedAt ?? null, elapsedMs: response ? ms(response.receivedAt) - ms(request.sentAt) : null,
      model: request.body?.model, temperature: request.body?.temperature, maxTokens: request.body?.max_tokens,
      url: request.url, status: response?.status ?? null, error: response?.error ?? null, usage: response?.body?.usage ?? null,
      requestSha: sha(join(ioDir, n)), responseSha: fileSha(rp) };
  });
  const aggregate = xs => ({ attempts: xs.length, http200: xs.filter(c => c.status === 200).length, clientErrors: xs.filter(c => c.error).length,
    missingResponses: xs.filter(c => !c.responseSha).length, usageKnown: xs.filter(c => c.usage).length, usageUnknown: xs.filter(c => !c.usage).length,
    knownPromptTokens: sum(xs.map(c => c.usage?.prompt_tokens ?? 0)), knownCompletionTokens: sum(xs.map(c => c.usage?.completion_tokens ?? 0)), knownTotalTokens: sum(xs.map(c => c.usage?.total_tokens ?? 0)),
    clientElapsedMsSum: sum(xs.map(c => c.elapsedMs ?? 0)) });
  check('actual_model_io_recorded', calls.length > 0 && calls.some(c => c.purpose === 'extract' && c.status === 200), { count: calls.length, missingResponses: calls.filter(c => !c.responseSha).map(c => c.file) });
  check('model_calls_settled_before_host_closed', calls.every(c => c.responseSha && Number.isFinite(ms(c.receivedAt)) && ms(c.receivedAt) <= ms(stops.at(-1)?.receipt?.stoppedAt)), calls.filter(c => !c.responseSha || ms(c.receivedAt) > ms(stops.at(-1)?.receipt?.stoppedAt)).map(c => c.file));
  const failed = checks.filter(c => !c.ok);
  const evidencePaths = [timelinePath, dbPath, join(workspace, 'state/host.log'), trajectoryPath, expectationPath, ...producerFiles.map(n => join(producerDir, n))];
  const result = { schema: 'product-mainline-independent-run-check/v1', checkedAt: new Date().toISOString(), run, trajectoryId: expected.trajectoryId,
    scope: 'Public development trajectory; actual product host, real time and model HTTP; authored producer and scripted HTTP presenter. END-STATE verdict is not read.',
    fullStoryPass: failed.length === 0, independentChecks: { passed: checks.length - failed.length, total: checks.length, failed, checks },
    actual: { validCompletions: taskResults.filter(t => t.validCompletion).length, requiredCompletions: expected.requiredFinal.filter(t => t.status === 'completed').length,
      requiredDecisions: decisions.length, missingOrLateDecisions: decisions.filter(d => !d.visibleOk).length, failedAnswerBranches: decisions.filter(d => !d.answeredOk).length,
      notifications: notifications.length, deliveredNotifications: notifications.filter(n => n.delivered_at).length, presentedNotifications: notifications.filter(n => n.presented_at).length,
      duplicateNotificationGroups: duplicates.length, writeAnalysisReceipts: receipts.filter(r => r.tool === 'write_analysis').length },
    tasks: taskResults, artifacts: artifactChecks, decisions, avoidables, recovery, hostPids: liveStarts.map(s => s.pid),
    timing: { origin, startedAt: start.at, finishedAt: timeline.findLast(e => e.kind === 'driver.done')?.at },
    costs: Object.fromEntries([['all', calls], ['extract', calls.filter(c => c.purpose === 'extract')], ['assess', calls.filter(c => c.purpose === 'assess')], ['prelude', calls.filter(c => c.stage === 'prelude')], ['live', calls.filter(c => c.stage === 'live')]].map(([k, v]) => [k, aggregate(v)])),
    modelCalls: calls, notificationSequence: notifications.map(n => ({ ...n, taskAlias: aliasFor(n.ticket_id), elapsedMs: ms(n.created_at) - ms(origin) })),
    wakeJobs, assessmentStatuses: Object.fromEntries(Object.entries(Object.groupBy(assessments, a => a.status)).map(([k, v]) => [k, v.length])),
    observations: observations.map(e => ({ ticketId: e.ticket_id, sourceRevision: e.source_revision, runId: e.payload.runId, revision: e.payload.revision, at: e.observed_at })),
    evidence: evidencePaths.map(path => ({ path, sha256: sha(path) })),
    limitations: ['One public development trajectory per run, not a held-out or statistical test.', 'HTTP presentation records are not actual Electron UI or real-user outcomes.', 'Known usage totals exclude unknown consumption from aborted calls; request attempts are not successful calls.', 'Strong rule uses real-model memory extraction; it is not a model-free baseline.', 'No GPU-resident weights attestation. No conclusion of fewer interruptions if required decisions/completions fail.'] };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ out, fullStoryPass: result.fullStoryPass, actual: result.actual, checks: { passed: checks.length - failed.length, total: checks.length, failed: failed.map(c => c.id) }, costs: result.costs.all }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) { console.error(JSON.stringify({ error: String(error?.stack ?? error), verdictProduced: false })); process.exitCode = 2; }
