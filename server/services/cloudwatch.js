'use strict';
const store = require('../store');
const registry = require('../registry');
const { AwsError, now, requireParam, arn, hex } = require('../util');

function S() { return store.get().cloudwatch; }
const METRIC_RETENTION_MS = 3 * 60 * 60 * 1000; // 3시간

// ---------------- Logs ----------------
function findGroup(name) {
  const g = S().logGroups.find((x) => x.logGroupName === name);
  if (!g) throw new AwsError('ResourceNotFoundException', `로그 그룹 '${name}' 을(를) 찾을 수 없습니다.`, 404);
  return g;
}
const logsActions = {
  CreateLogGroup(p, ctx) {
    const name = requireParam(p, 'logGroupName');
    if (S().logGroups.find((g) => g.logGroupName === name)) throw new AwsError('ResourceAlreadyExistsException', '로그 그룹이 이미 존재합니다.', 409);
    S().logGroups.push({ logGroupName: name, arn: arn('logs', ctx.region, `log-group:${name}:*`), creationTime: Date.now(), storedBytes: 0, retentionInDays: p.retentionInDays, Region: ctx.region, streams: [] });
    return {};
  },
  DescribeLogGroups(p, ctx) { return { logGroups: S().logGroups.filter((g) => g.Region === ctx.region && (!p.logGroupNamePrefix || g.logGroupName.startsWith(p.logGroupNamePrefix))).map(({ streams, ...g }) => ({ ...g, streamCount: streams.length })) }; },
  DeleteLogGroup(p) { findGroup(requireParam(p, 'logGroupName')); S().logGroups = S().logGroups.filter((g) => g.logGroupName !== p.logGroupName); return {}; },
  PutRetentionPolicy(p) { findGroup(requireParam(p, 'logGroupName')).retentionInDays = Number(requireParam(p, 'retentionInDays')); return {}; },
  CreateLogStream(p) {
    const g = findGroup(requireParam(p, 'logGroupName'));
    const name = requireParam(p, 'logStreamName');
    if (g.streams.find((s) => s.logStreamName === name)) throw new AwsError('ResourceAlreadyExistsException', '로그 스트림이 이미 존재합니다.', 409);
    g.streams.push({ logStreamName: name, creationTime: Date.now(), events: [] });
    return {};
  },
  DescribeLogStreams(p) { const g = findGroup(requireParam(p, 'logGroupName')); return { logStreams: g.streams.map(({ events, ...s }) => ({ ...s, lastEventTimestamp: events.length ? events[events.length - 1].timestamp : undefined, storedBytes: events.reduce((a, e) => a + e.message.length, 0) })).sort((a, b) => (b.lastEventTimestamp || 0) - (a.lastEventTimestamp || 0)) }; },
  PutLogEvents(p, ctx) {
    let g = S().logGroups.find((x) => x.logGroupName === p.logGroupName);
    if (!g) { if (!p.autoCreate) throw new AwsError('ResourceNotFoundException', '로그 그룹이 없습니다.', 404); logsActions.CreateLogGroup({ logGroupName: p.logGroupName }, ctx); g = findGroup(p.logGroupName); }
    let s = g.streams.find((x) => x.logStreamName === p.logStreamName);
    if (!s) { if (!p.autoCreate) throw new AwsError('ResourceNotFoundException', '로그 스트림이 없습니다.', 404); s = { logStreamName: p.logStreamName, creationTime: Date.now(), events: [] }; g.streams.push(s); }
    for (const e of requireParam(p, 'logEvents')) { s.events.push({ timestamp: Number(e.timestamp || Date.now()), message: String(e.message), ingestionTime: Date.now() }); g.storedBytes += String(e.message).length; }
    if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
    return { nextSequenceToken: hex(16) };
  },
  GetLogEvents(p) {
    const g = findGroup(requireParam(p, 'logGroupName'));
    const s = g.streams.find((x) => x.logStreamName === p.logStreamName);
    if (!s) throw new AwsError('ResourceNotFoundException', '로그 스트림이 없습니다.', 404);
    let ev = s.events;
    if (p.startTime) ev = ev.filter((e) => e.timestamp >= Number(p.startTime));
    if (p.endTime) ev = ev.filter((e) => e.timestamp <= Number(p.endTime));
    return { events: ev.slice(-Number(p.limit || 1000)) };
  },
  FilterLogEvents(p) {
    const g = findGroup(requireParam(p, 'logGroupName'));
    let ev = [];
    for (const s of g.streams) for (const e of s.events) ev.push({ ...e, logStreamName: s.logStreamName, eventId: hex(16) });
    ev.sort((a, b) => a.timestamp - b.timestamp);
    if (p.filterPattern) { const pat = String(p.filterPattern).replace(/^"|"$/g, ''); ev = ev.filter((e) => e.message.includes(pat)); }
    if (p.startTime) ev = ev.filter((e) => e.timestamp >= Number(p.startTime));
    return { events: ev.slice(-Number(p.limit || 1000)) };
  },
};

// ---------------- Metrics ----------------
function dimsKey(dims) { return (dims || []).map((d) => `${d.Name}=${d.Value}`).sort().join(','); }
function putMetric(ns, name, dims, value, unit, region) {
  S().metrics.push({ Namespace: ns, MetricName: name, Dimensions: dims || [], Timestamp: Date.now(), Value: Number(value), Unit: unit || 'None', Region: region });
}
function prune() { const cutoff = Date.now() - METRIC_RETENTION_MS; S().metrics = S().metrics.filter((m) => m.Timestamp >= cutoff); }
function stat(values, s) {
  if (!values.length) return undefined;
  switch (s) {
    case 'Sum': return values.reduce((a, b) => a + b, 0);
    case 'Minimum': return Math.min(...values);
    case 'Maximum': return Math.max(...values);
    case 'SampleCount': return values.length;
    default: return values.reduce((a, b) => a + b, 0) / values.length;
  }
}
function seriesFor(ns, name, dims, start, end, period, statistic) {
  const key = dimsKey(dims);
  const pts = S().metrics.filter((m) => m.Namespace === ns && m.MetricName === name && dimsKey(m.Dimensions) === key && m.Timestamp >= start && m.Timestamp <= end);
  const buckets = new Map();
  for (const pt of pts) { const b = Math.floor(pt.Timestamp / (period * 1000)) * period * 1000; if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(pt.Value); }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, vals]) => ({ Timestamp: new Date(ts).toISOString(), [statistic]: stat(vals, statistic), Unit: pts[0] ? pts[0].Unit : 'None' }));
}
const cwActions = {
  PutMetricData(p, ctx) {
    const ns = requireParam(p, 'Namespace');
    if (ns.startsWith('AWS/') && ctx.caller === 'user') throw new AwsError('InvalidParameterValue', 'AWS/ 로 시작하는 네임스페이스는 예약되어 있습니다.');
    for (const d of requireParam(p, 'MetricData')) putMetric(ns, d.MetricName, d.Dimensions, d.Value, d.Unit, ctx.region);
    return {};
  },
  ListMetrics(p, ctx) {
    prune();
    const seen = new Map();
    for (const m of S().metrics) {
      if (m.Region !== ctx.region) continue;
      if (p.Namespace && m.Namespace !== p.Namespace) continue;
      if (p.MetricName && m.MetricName !== p.MetricName) continue;
      const k = `${m.Namespace}|${m.MetricName}|${dimsKey(m.Dimensions)}`;
      if (!seen.has(k)) seen.set(k, { Namespace: m.Namespace, MetricName: m.MetricName, Dimensions: m.Dimensions });
    }
    return { Metrics: [...seen.values()] };
  },
  GetMetricStatistics(p) {
    const ns = requireParam(p, 'Namespace'), name = requireParam(p, 'MetricName');
    const start = p.StartTime ? Date.parse(p.StartTime) : Date.now() - 3600 * 1000, end = p.EndTime ? Date.parse(p.EndTime) : Date.now();
    const period = Number(p.Period || 60);
    const stats = [].concat(p.Statistics || ['Average']);
    const Datapoints = [];
    const key = dimsKey(p.Dimensions);
    const pts = S().metrics.filter((m) => m.Namespace === ns && m.MetricName === name && dimsKey(m.Dimensions) === key && m.Timestamp >= start && m.Timestamp <= end);
    const buckets = new Map();
    for (const pt of pts) { const b = Math.floor(pt.Timestamp / (period * 1000)) * period * 1000; if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(pt.Value); }
    for (const [ts, vals] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) { const d = { Timestamp: new Date(ts).toISOString(), Unit: pts[0].Unit }; for (const s of stats) d[s] = stat(vals, s); Datapoints.push(d); }
    return { Label: name, Datapoints };
  },
  GetMetricData(p) {
    const start = p.StartTime ? Date.parse(p.StartTime) : Date.now() - 3600 * 1000, end = p.EndTime ? Date.parse(p.EndTime) : Date.now();
    const MetricDataResults = [];
    for (const q of p.MetricDataQueries || []) {
      const ms = q.MetricStat;
      const series = seriesFor(ms.Metric.Namespace, ms.Metric.MetricName, ms.Metric.Dimensions, start, end, Number(ms.Period || 60), ms.Stat || 'Average');
      MetricDataResults.push({ Id: q.Id, Label: q.Label || ms.Metric.MetricName, Timestamps: series.map((s) => s.Timestamp), Values: series.map((s) => s[ms.Stat || 'Average']), StatusCode: 'Complete' });
    }
    return { MetricDataResults };
  },
  // ---- Alarms ----
  PutMetricAlarm(p, ctx) {
    const name = requireParam(p, 'AlarmName');
    requireParam(p, 'MetricName'); requireParam(p, 'Namespace');
    const ops = ['GreaterThanThreshold', 'GreaterThanOrEqualToThreshold', 'LessThanThreshold', 'LessThanOrEqualToThreshold'];
    if (!ops.includes(p.ComparisonOperator)) throw new AwsError('ValidationError', `ComparisonOperator 는 ${ops.join(' | ')} 중 하나여야 합니다.`);
    if (p.Threshold === undefined) throw new AwsError('ValidationError', 'Threshold 가 필요합니다.');
    for (const a of [].concat(p.AlarmActions || [])) {
      if (a.startsWith('arn:aws:sns:')) { if (!store.get().sns.topics.find((t) => t.TopicArn === a)) throw new AwsError('ValidationError', `SNS 주제 ${a} 을(를) 찾을 수 없습니다.`); }
      else if (!/^arn:aws:automate:[\w-]+:ec2:(stop|terminate|reboot)$/.test(a) && !a.startsWith('arn:aws:lambda:')) throw new AwsError('ValidationError', `지원하지 않는 알람 작업: ${a} (SNS 주제 ARN 또는 arn:aws:automate:<region>:ec2:stop)`);
    }
    const existing = S().alarms.find((a) => a.AlarmName === name && a.Region === ctx.region);
    const alarm = { ...(existing || {}), AlarmName: name, AlarmArn: arn('cloudwatch', ctx.region, `alarm:${name}`), AlarmDescription: p.AlarmDescription || '', Namespace: p.Namespace, MetricName: p.MetricName, Dimensions: p.Dimensions || [], Statistic: p.Statistic || 'Average', Period: Number(p.Period || 60), EvaluationPeriods: Number(p.EvaluationPeriods || 1), DatapointsToAlarm: Number(p.DatapointsToAlarm || p.EvaluationPeriods || 1), Threshold: Number(p.Threshold), ComparisonOperator: p.ComparisonOperator, TreatMissingData: p.TreatMissingData || 'missing', AlarmActions: [].concat(p.AlarmActions || []), OKActions: [].concat(p.OKActions || []), ActionsEnabled: p.ActionsEnabled !== false, StateValue: existing ? existing.StateValue : 'INSUFFICIENT_DATA', StateReason: existing ? existing.StateReason : 'Unchecked: Initial alarm creation', StateUpdatedTimestamp: existing ? existing.StateUpdatedTimestamp : now(), AlarmConfigurationUpdatedTimestamp: now(), Region: ctx.region, History: existing ? existing.History : [] };
    if (existing) S().alarms[S().alarms.indexOf(existing)] = alarm; else S().alarms.push(alarm);
    return {};
  },
  DescribeAlarms(p, ctx) { return { MetricAlarms: S().alarms.filter((a) => a.Region === ctx.region && (!p.AlarmNames || !p.AlarmNames.length || p.AlarmNames.includes(a.AlarmName)) && (!p.StateValue || a.StateValue === p.StateValue)) }; },
  DeleteAlarms(p) { const names = [].concat(requireParam(p, 'AlarmNames')); S().alarms = S().alarms.filter((a) => !names.includes(a.AlarmName)); return {}; },
  SetAlarmState(p) {
    const a = S().alarms.find((x) => x.AlarmName === p.AlarmName);
    if (!a) throw new AwsError('ResourceNotFound', '알람을 찾을 수 없습니다.', 404);
    setState(a, requireParam(p, 'StateValue'), p.StateReason || 'Set manually', true);
    return {};
  },
  DescribeAlarmHistory(p) { const a = S().alarms.find((x) => x.AlarmName === p.AlarmName); return { AlarmHistoryItems: a ? a.History : [] }; },
};

function setState(alarm, state, reason, manual = false) {
  if (alarm.StateValue === state) return;
  const prev = alarm.StateValue;
  alarm.StateValue = state; alarm.StateReason = reason; alarm.StateUpdatedTimestamp = now();
  alarm.History.unshift({ Timestamp: now(), HistoryItemType: 'StateUpdate', HistorySummary: `${prev} → ${state}${manual ? ' (수동)' : ''}: ${reason}` });
  if (alarm.History.length > 50) alarm.History.length = 50;
  store.record({ time: now(), service: 'cloudwatch', action: 'AlarmStateChange', detail: `${alarm.AlarmName}: ${prev} → ${state}` });
  if (!alarm.ActionsEnabled) return;
  const acts = state === 'ALARM' ? alarm.AlarmActions : state === 'OK' ? alarm.OKActions : [];
  for (const a of acts) {
    try {
      if (a.startsWith('arn:aws:sns:')) registry.dispatch('sns', 'Publish', { TopicArn: a, Subject: `ALARM: "${alarm.AlarmName}" in ${alarm.Region}`, Message: JSON.stringify({ AlarmName: alarm.AlarmName, NewStateValue: state, NewStateReason: reason, StateChangeTime: now(), Region: alarm.Region, Trigger: { MetricName: alarm.MetricName, Namespace: alarm.Namespace, Statistic: alarm.Statistic, Threshold: alarm.Threshold, ComparisonOperator: alarm.ComparisonOperator, Dimensions: alarm.Dimensions } }, null, 2) });
      else if (/ec2:(stop|terminate|reboot)$/.test(a)) {
        const iid = (alarm.Dimensions.find((d) => d.Name === 'InstanceId') || {}).Value;
        const op = a.split(':').pop();
        if (iid) registry.dispatch('ec2', { stop: 'StopInstances', terminate: 'TerminateInstances', reboot: 'RebootInstances' }[op], { InstanceIds: [iid] }, { region: alarm.Region });
        alarm.History.unshift({ Timestamp: now(), HistoryItemType: 'Action', HistorySummary: `EC2 ${op} 작업 실행: ${iid}` });
      } else if (a.startsWith('arn:aws:lambda:')) require('./lambda').invokeByArn(a, { source: 'aws.cloudwatch', alarmName: alarm.AlarmName, state }, 'cloudwatch');
    } catch (e) { alarm.History.unshift({ Timestamp: now(), HistoryItemType: 'Action', HistorySummary: `작업 실패: ${a}: ${e.message}` }); }
  }
}
function evaluateAlarms() {
  for (const a of S().alarms) {
    const endT = Date.now();
    const start = endT - a.Period * a.EvaluationPeriods * 1000;
    const series = seriesFor(a.Namespace, a.MetricName, a.Dimensions, start, endT, a.Period, a.Statistic);
    if (!series.length) { if (a.TreatMissingData === 'breaching') setState(a, 'ALARM', '데이터 없음(breaching 처리)'); else if (a.TreatMissingData === 'notBreaching') setState(a, 'OK', '데이터 없음(notBreaching 처리)'); else if (a.TreatMissingData === 'missing') setState(a, 'INSUFFICIENT_DATA', '최근 기간에 데이터포인트가 없습니다.'); continue; }
    const cmp = { GreaterThanThreshold: (v) => v > a.Threshold, GreaterThanOrEqualToThreshold: (v) => v >= a.Threshold, LessThanThreshold: (v) => v < a.Threshold, LessThanOrEqualToThreshold: (v) => v <= a.Threshold }[a.ComparisonOperator];
    const recent = series.slice(-a.EvaluationPeriods);
    const breaching = recent.filter((s) => cmp(s[a.Statistic])).length;
    const vals = recent.map((s) => Number(s[a.Statistic]).toFixed(2)).join(', ');
    if (breaching >= a.DatapointsToAlarm) setState(a, 'ALARM', `Threshold Crossed: ${breaching} datapoints [${vals}] ${a.ComparisonOperator.replace(/Threshold$/, '')} ${a.Threshold}`);
    else if (recent.length >= Math.min(a.EvaluationPeriods, 1)) setState(a, 'OK', `Threshold not crossed: datapoints [${vals}] vs ${a.Threshold}`);
  }
}

// EC2 지표 시뮬레이션: 실행 중 인스턴스마다 CPUUtilization / NetworkIn 생성
const cpuState = {};
function sampleEc2() {
  const ec2 = store.get().ec2;
  for (const i of ec2.instances) {
    if (i.State.Name !== 'running') continue;
    const st = cpuState[i.InstanceId] || (cpuState[i.InstanceId] = { cpu: 2 + Math.random() * 5 });
    const stress = /stress|cpu-burn|yes\s*>\s*\/dev\/null|# load:high/.test(i.UserData || '') || (i.Tags || []).some((t) => t.Key === 'SimLoad' && t.Value === 'high');
    const target = stress ? 85 + Math.random() * 12 : 3 + Math.random() * 10;
    st.cpu = st.cpu + (target - st.cpu) * 0.4 + (Math.random() - 0.5) * 3;
    st.cpu = Math.max(0.1, Math.min(100, st.cpu));
    const dims = [{ Name: 'InstanceId', Value: i.InstanceId }];
    putMetric('AWS/EC2', 'CPUUtilization', dims, Number(st.cpu.toFixed(2)), 'Percent', i.Region);
    putMetric('AWS/EC2', 'NetworkIn', dims, Math.round(1000 + Math.random() * 50000), 'Bytes', i.Region);
    putMetric('AWS/EC2', 'NetworkOut', dims, Math.round(500 + Math.random() * 20000), 'Bytes', i.Region);
    putMetric('AWS/EC2', 'StatusCheckFailed', dims, 0, 'Count', i.Region);
  }
  for (const q of store.get().sqs.queues) {
    const t = Date.now();
    putMetric('AWS/SQS', 'ApproximateNumberOfMessagesVisible', [{ Name: 'QueueName', Value: q.QueueName }], q.Messages.filter((m) => m.VisibleAt <= t).length, 'Count', q.Region);
  }
  for (const tb of store.get().dynamodb.tables) putMetric('AWS/DynamoDB', 'ItemCount', [{ Name: 'TableName', Value: tb.TableName }], tb.Items.length, 'Count', tb.Region);
  prune();
  store.save();
}
function startTimers() {
  setInterval(sampleEc2, 10000);
  setInterval(evaluateAlarms, 15000);
  setTimeout(sampleEc2, 1500);
}

module.exports = { actions: cwActions, logsActions, startTimers, putMetric, evaluateAlarms, sampleEc2 };
