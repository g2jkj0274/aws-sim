'use strict';
const crypto = require('crypto');
const store = require('../store');
const { AwsError, now, uuid, hex, requireParam, arn, ACCOUNT_ID } = require('../util');

function S() { return store.get().sqs; }
const PORT = () => process.env.AWSIM_PORT || 4566;

function findQueue(urlOrName) {
  const q = S().queues.find((x) => x.QueueUrl === urlOrName || x.QueueName === urlOrName || x.QueueArn === urlOrName);
  if (!q) throw new AwsError('AWS.SimpleQueueService.NonExistentQueue', `지정한 대기열이 존재하지 않습니다: ${urlOrName}`, 404);
  return q;
}
function pubQueue(q) { const { Messages, ...rest } = q; return { ...rest, ...counts(q) }; }
function counts(q) {
  const t = Date.now();
  return { ApproximateNumberOfMessages: q.Messages.filter((m) => m.VisibleAt <= t && m.DelayUntil <= t).length, ApproximateNumberOfMessagesNotVisible: q.Messages.filter((m) => m.VisibleAt > t).length, ApproximateNumberOfMessagesDelayed: q.Messages.filter((m) => m.DelayUntil > t).length };
}
function expire(q) {
  const ret = Number(q.Attributes.MessageRetentionPeriod) * 1000;
  q.Messages = q.Messages.filter((m) => Date.now() - Number(m.Attributes.SentTimestamp) < ret);
}
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

const actions = {
  CreateQueue(p, ctx) {
    const name = requireParam(p, 'QueueName');
    if (!/^[\w-]{1,80}(\.fifo)?$/.test(name)) throw new AwsError('InvalidParameterValue', '대기열 이름은 영숫자, 하이픈, 밑줄 최대 80자 (FIFO 는 .fifo 접미사)여야 합니다.');
    const attrs = p.Attributes || {};
    const fifo = String(attrs.FifoQueue) === 'true';
    if (fifo && !name.endsWith('.fifo')) throw new AwsError('InvalidParameterValue', 'FIFO 대기열 이름은 .fifo 로 끝나야 합니다.');
    if (!fifo && name.endsWith('.fifo')) throw new AwsError('InvalidParameterValue', '.fifo 로 끝나는 이름은 FifoQueue=true 속성이 필요합니다.');
    const existing = S().queues.find((q) => q.QueueName === name && q.Region === ctx.region);
    if (existing) return { QueueUrl: existing.QueueUrl };
    if (attrs.RedrivePolicy) {
      const rp = typeof attrs.RedrivePolicy === 'string' ? JSON.parse(attrs.RedrivePolicy) : attrs.RedrivePolicy;
      if (!S().queues.find((q) => q.QueueArn === rp.deadLetterTargetArn)) throw new AwsError('InvalidParameterValue', `DLQ ${rp.deadLetterTargetArn} 이(가) 존재하지 않습니다.`);
      attrs.RedrivePolicy = JSON.stringify(rp);
    }
    const q = {
      QueueName: name, QueueUrl: `http://localhost:${PORT()}/sqs/${ACCOUNT_ID}/${name}`, QueueArn: arn('sqs', ctx.region, name), Region: ctx.region, CreatedTimestamp: now(),
      Attributes: { VisibilityTimeout: String(attrs.VisibilityTimeout ?? 30), MessageRetentionPeriod: String(attrs.MessageRetentionPeriod ?? 345600), DelaySeconds: String(attrs.DelaySeconds ?? 0), ReceiveMessageWaitTimeSeconds: String(attrs.ReceiveMessageWaitTimeSeconds ?? 0), MaximumMessageSize: '262144', FifoQueue: String(fifo), ContentBasedDeduplication: String(attrs.ContentBasedDeduplication === 'true' || attrs.ContentBasedDeduplication === true), ...(attrs.RedrivePolicy ? { RedrivePolicy: attrs.RedrivePolicy } : {}) },
      Tags: p.tags || p.Tags || {}, Messages: [],
    };
    S().queues.push(q);
    return { QueueUrl: q.QueueUrl };
  },
  ListQueues(p, ctx) { return { QueueUrls: S().queues.filter((q) => q.Region === ctx.region && (!p.QueueNamePrefix || q.QueueName.startsWith(p.QueueNamePrefix))).map((q) => q.QueueUrl), Queues: S().queues.filter((q) => q.Region === ctx.region).map(pubQueue) }; },
  GetQueueUrl(p) { return { QueueUrl: findQueue(requireParam(p, 'QueueName')).QueueUrl }; },
  GetQueueAttributes(p) { const q = findQueue(requireParam(p, 'QueueUrl')); expire(q); return { Attributes: { ...q.Attributes, QueueArn: q.QueueArn, CreatedTimestamp: q.CreatedTimestamp, ...Object.fromEntries(Object.entries(counts(q)).map(([k, v]) => [k, String(v)])) } }; },
  SetQueueAttributes(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const attrs = p.Attributes || {};
    if (attrs.RedrivePolicy) { const rp = typeof attrs.RedrivePolicy === 'string' ? JSON.parse(attrs.RedrivePolicy) : attrs.RedrivePolicy; if (!S().queues.find((x) => x.QueueArn === rp.deadLetterTargetArn)) throw new AwsError('InvalidParameterValue', `DLQ ${rp.deadLetterTargetArn} 이(가) 존재하지 않습니다.`); attrs.RedrivePolicy = JSON.stringify(rp); }
    for (const [k, v] of Object.entries(attrs)) q.Attributes[k] = typeof v === 'string' ? v : JSON.stringify(v);
    return {};
  },
  DeleteQueue(p) { const q = findQueue(requireParam(p, 'QueueUrl')); S().queues = S().queues.filter((x) => x !== q); return {}; },
  PurgeQueue(p) { findQueue(requireParam(p, 'QueueUrl')).Messages = []; return {}; },
  SendMessage(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const body = String(requireParam(p, 'MessageBody'));
    if (body.length > 262144) throw new AwsError('InvalidParameterValue', '메시지는 256KB 를 초과할 수 없습니다.');
    const fifo = q.Attributes.FifoQueue === 'true';
    if (fifo && !p.MessageGroupId) throw new AwsError('MissingParameter', 'FIFO 대기열에는 MessageGroupId 가 필요합니다.');
    if (fifo && !p.MessageDeduplicationId && q.Attributes.ContentBasedDeduplication !== 'true') throw new AwsError('InvalidParameterValue', 'FIFO 대기열에는 MessageDeduplicationId 가 필요합니다 (또는 ContentBasedDeduplication 활성화).');
    const dedupId = fifo ? (p.MessageDeduplicationId || md5(body)) : null;
    if (fifo) { const dup = q.Messages.find((m) => m.Attributes.MessageDeduplicationId === dedupId && Date.now() - Number(m.Attributes.SentTimestamp) < 300000); if (dup) return { MessageId: dup.MessageId, MD5OfMessageBody: dup.MD5OfBody, SequenceNumber: dup.Attributes.SequenceNumber }; }
    const delay = Number(p.DelaySeconds ?? q.Attributes.DelaySeconds ?? 0);
    const m = { MessageId: uuid(), Body: body, MD5OfBody: md5(body), Attributes: { SentTimestamp: String(Date.now()), ApproximateReceiveCount: '0', ApproximateFirstReceiveTimestamp: '', SenderId: ACCOUNT_ID, ...(fifo ? { MessageGroupId: p.MessageGroupId, MessageDeduplicationId: dedupId, SequenceNumber: String(Date.now()) + '000' } : {}) }, MessageAttributes: p.MessageAttributes || {}, VisibleAt: 0, DelayUntil: Date.now() + delay * 1000 };
    q.Messages.push(m);
    return { MessageId: m.MessageId, MD5OfMessageBody: m.MD5OfBody, ...(fifo ? { SequenceNumber: m.Attributes.SequenceNumber } : {}) };
  },
  SendMessageBatch(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const Successful = [], Failed = [];
    for (const e of p.Entries || []) { try { const r = actions.SendMessage({ QueueUrl: q.QueueUrl, MessageBody: e.MessageBody, DelaySeconds: e.DelaySeconds, MessageAttributes: e.MessageAttributes, MessageGroupId: e.MessageGroupId, MessageDeduplicationId: e.MessageDeduplicationId }); Successful.push({ Id: e.Id, ...r }); } catch (err) { Failed.push({ Id: e.Id, Code: err.code, Message: err.message, SenderFault: true }); } }
    return { Successful, Failed };
  },
  ReceiveMessage(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    expire(q);
    const max = Math.min(10, Math.max(1, Number(p.MaxNumberOfMessages || 1)));
    const vt = Number(p.VisibilityTimeout ?? q.Attributes.VisibilityTimeout);
    const t = Date.now();
    let avail = q.Messages.filter((m) => m.VisibleAt <= t && m.DelayUntil <= t);
    if (q.Attributes.FifoQueue === 'true') avail.sort((a, b) => Number(a.Attributes.SequenceNumber) - Number(b.Attributes.SequenceNumber));
    const picked = avail.slice(0, max);
    const rp = q.Attributes.RedrivePolicy ? JSON.parse(q.Attributes.RedrivePolicy) : null;
    const Messages = [];
    for (const m of picked) {
      m.Attributes.ApproximateReceiveCount = String(Number(m.Attributes.ApproximateReceiveCount) + 1);
      if (!m.Attributes.ApproximateFirstReceiveTimestamp) m.Attributes.ApproximateFirstReceiveTimestamp = String(t);
      if (rp && Number(m.Attributes.ApproximateReceiveCount) > Number(rp.maxReceiveCount)) {
        const dlq = S().queues.find((x) => x.QueueArn === rp.deadLetterTargetArn);
        q.Messages = q.Messages.filter((x) => x !== m);
        if (dlq) { dlq.Messages.push({ ...m, VisibleAt: 0, DelayUntil: 0, Attributes: { ...m.Attributes, DeadLetterQueueSourceArn: q.QueueArn } }); store.record({ time: now(), service: 'sqs', action: 'Redrive', detail: `${m.MessageId} → DLQ ${dlq.QueueName}` }); }
        continue;
      }
      m.VisibleAt = t + vt * 1000;
      m.ReceiptHandle = hex(48);
      Messages.push({ MessageId: m.MessageId, ReceiptHandle: m.ReceiptHandle, MD5OfBody: m.MD5OfBody, Body: m.Body, Attributes: m.Attributes, MessageAttributes: m.MessageAttributes });
    }
    store.save();
    return { Messages };
  },
  DeleteMessage(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const rh = requireParam(p, 'ReceiptHandle');
    const m = q.Messages.find((x) => x.ReceiptHandle === rh);
    if (!m) throw new AwsError('ReceiptHandleIsInvalid', '잘못되었거나 만료된 ReceiptHandle 입니다. 메시지는 ReceiveMessage 로 받은 뒤 그 ReceiptHandle 로 삭제해야 합니다.');
    q.Messages = q.Messages.filter((x) => x !== m);
    return {};
  },
  DeleteMessageBatch(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const Successful = [], Failed = [];
    for (const e of p.Entries || []) { try { actions.DeleteMessage({ QueueUrl: q.QueueUrl, ReceiptHandle: e.ReceiptHandle }); Successful.push({ Id: e.Id }); } catch (err) { Failed.push({ Id: e.Id, Code: err.code, Message: err.message }); } }
    return { Successful, Failed };
  },
  ChangeMessageVisibility(p) {
    const q = findQueue(requireParam(p, 'QueueUrl'));
    const m = q.Messages.find((x) => x.ReceiptHandle === p.ReceiptHandle);
    if (!m) throw new AwsError('ReceiptHandleIsInvalid', '잘못된 ReceiptHandle 입니다.');
    m.VisibleAt = Date.now() + Number(p.VisibilityTimeout || 0) * 1000;
    return {};
  },
  PeekMessages(p) { const q = findQueue(requireParam(p, 'QueueUrl')); expire(q); const t = Date.now(); return { Messages: q.Messages.map((m) => ({ MessageId: m.MessageId, Body: m.Body, Attributes: m.Attributes, InFlight: m.VisibleAt > t, Delayed: m.DelayUntil > t })) }; },
  TagQueue(p) { const q = findQueue(requireParam(p, 'QueueUrl')); q.Tags = { ...q.Tags, ...(p.Tags || {}) }; return {}; },
  ListQueueTags(p) { return { Tags: findQueue(requireParam(p, 'QueueUrl')).Tags }; },
};

module.exports = { actions, findQueue };
