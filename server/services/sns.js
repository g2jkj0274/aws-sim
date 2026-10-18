'use strict';
const store = require('../store');
const registry = require('../registry');
const { AwsError, now, uuid, hex, requireParam, arn, ACCOUNT_ID } = require('../util');

function S() { return store.get().sns; }

function findTopic(a) {
  const t = S().topics.find((x) => x.TopicArn === a || x.Name === a);
  if (!t) throw new AwsError('NotFound', `주제를 찾을 수 없습니다: ${a}`, 404);
  return t;
}
function matchesFilter(policy, attrs) {
  if (!policy) return true;
  for (const [k, conds] of Object.entries(policy)) {
    const a = attrs && attrs[k];
    const v = a ? (a.DataType === 'Number' ? Number(a.StringValue) : a.StringValue) : undefined;
    const ok = [].concat(conds).some((c) => {
      if (c && typeof c === 'object') {
        if (c.exists !== undefined) return c.exists ? v !== undefined : v === undefined;
        if (c.prefix !== undefined) return typeof v === 'string' && v.startsWith(c.prefix);
        if (c.numeric) { let r = true; for (let i = 0; i < c.numeric.length; i += 2) { const op = c.numeric[i], n = c.numeric[i + 1]; r = r && ({ '=': v === n, '>': v > n, '>=': v >= n, '<': v < n, '<=': v <= n }[op]); } return r; }
        if (c['anything-but'] !== undefined) return ![].concat(c['anything-but']).includes(v);
        return false;
      }
      return v === c;
    });
    if (!ok) return false;
  }
  return true;
}

const actions = {
  CreateTopic(p, ctx) {
    const name = requireParam(p, 'Name');
    if (!/^[\w-]{1,256}(\.fifo)?$/.test(name)) throw new AwsError('InvalidParameter', '주제 이름은 영숫자, 하이픈, 밑줄만 사용할 수 있습니다 (최대 256자).');
    const existing = S().topics.find((t) => t.Name === name && t.Region === ctx.region);
    if (existing) return { TopicArn: existing.TopicArn };
    const t = { TopicArn: arn('sns', ctx.region, name), Name: name, Region: ctx.region, DisplayName: (p.Attributes && p.Attributes.DisplayName) || '', Owner: ACCOUNT_ID, FifoTopic: name.endsWith('.fifo'), CreatedAt: now(), Tags: p.Tags || [], MessagesPublished: 0 };
    S().topics.push(t);
    return { TopicArn: t.TopicArn };
  },
  ListTopics(p, ctx) { return { Topics: S().topics.filter((t) => t.Region === ctx.region).map((t) => ({ ...t, SubscriptionsConfirmed: S().subscriptions.filter((s) => s.TopicArn === t.TopicArn && s.Status === 'Confirmed').length, SubscriptionsPending: S().subscriptions.filter((s) => s.TopicArn === t.TopicArn && s.Status === 'PendingConfirmation').length })) }; },
  GetTopicAttributes(p) { const t = findTopic(requireParam(p, 'TopicArn')); return { Attributes: { TopicArn: t.TopicArn, DisplayName: t.DisplayName, Owner: t.Owner, SubscriptionsConfirmed: String(S().subscriptions.filter((s) => s.TopicArn === t.TopicArn && s.Status === 'Confirmed').length), SubscriptionsPending: String(S().subscriptions.filter((s) => s.TopicArn === t.TopicArn && s.Status !== 'Confirmed').length), FifoTopic: String(t.FifoTopic) } }; },
  SetTopicAttributes(p) { const t = findTopic(requireParam(p, 'TopicArn')); if (p.AttributeName === 'DisplayName') t.DisplayName = p.AttributeValue; return {}; },
  DeleteTopic(p) { const t = findTopic(requireParam(p, 'TopicArn')); S().topics = S().topics.filter((x) => x !== t); S().subscriptions = S().subscriptions.filter((s) => s.TopicArn !== t.TopicArn); return {}; },
  Subscribe(p) {
    const t = findTopic(requireParam(p, 'TopicArn'));
    const proto = requireParam(p, 'Protocol');
    const endpoint = requireParam(p, 'Endpoint');
    if (!['sqs', 'lambda', 'email', 'email-json', 'http', 'https', 'sms'].includes(proto)) throw new AwsError('InvalidParameter', `지원하지 않는 프로토콜: ${proto}`);
    if (proto === 'sqs' && !store.get().sqs.queues.find((q) => q.QueueArn === endpoint)) throw new AwsError('InvalidParameter', `SQS 대기열 ARN ${endpoint} 을(를) 찾을 수 없습니다. (arn:aws:sqs:<region>:<account>:<name> 형식)`);
    if (proto === 'lambda' && !store.get().lambda.functions.find((f) => f.FunctionArn === endpoint || f.FunctionName === endpoint)) throw new AwsError('InvalidParameter', `Lambda 함수 ${endpoint} 을(를) 찾을 수 없습니다.`);
    if (proto.startsWith('email') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(endpoint)) throw new AwsError('InvalidParameter', '올바른 이메일 주소가 아닙니다.');
    const dup = S().subscriptions.find((s) => s.TopicArn === t.TopicArn && s.Protocol === proto && s.Endpoint === endpoint);
    if (dup) return { SubscriptionArn: dup.SubscriptionArn };
    const attrs = p.Attributes || {};
    const sub = { SubscriptionArn: `${t.TopicArn}:${uuid()}`, TopicArn: t.TopicArn, Protocol: proto, Endpoint: endpoint, Owner: ACCOUNT_ID, Status: proto.startsWith('email') || proto.startsWith('http') ? 'PendingConfirmation' : 'Confirmed', FilterPolicy: attrs.FilterPolicy ? (typeof attrs.FilterPolicy === 'string' ? JSON.parse(attrs.FilterPolicy) : attrs.FilterPolicy) : null, RawMessageDelivery: String(attrs.RawMessageDelivery) === 'true', CreatedAt: now(), Token: hex(16) };
    S().subscriptions.push(sub);
    if (sub.Status === 'PendingConfirmation') S().inbox.push({ Id: uuid(), To: endpoint, Subject: 'AWS Notification - Subscription Confirmation', Message: `You have chosen to subscribe to the topic:\n${t.TopicArn}\n\nTo confirm this subscription, click or visit the link below (시뮬레이터: 콘솔의 "구독 확인" 버튼을 누르거나 ConfirmSubscription 을 호출하세요):\nToken=${sub.Token}`, Time: now(), TopicArn: t.TopicArn, Confirmation: { SubscriptionArn: sub.SubscriptionArn, Token: sub.Token } });
    return { SubscriptionArn: sub.Status === 'Confirmed' ? sub.SubscriptionArn : 'pending confirmation' };
  },
  ConfirmSubscription(p) {
    const t = findTopic(requireParam(p, 'TopicArn'));
    const sub = S().subscriptions.find((s) => s.TopicArn === t.TopicArn && (s.Token === p.Token || s.SubscriptionArn === p.SubscriptionArn));
    if (!sub) throw new AwsError('InvalidParameter', '토큰이 유효하지 않습니다.');
    sub.Status = 'Confirmed';
    return { SubscriptionArn: sub.SubscriptionArn };
  },
  Unsubscribe(p) { const a = requireParam(p, 'SubscriptionArn'); S().subscriptions = S().subscriptions.filter((s) => s.SubscriptionArn !== a); return {}; },
  ListSubscriptions(p, ctx) { return { Subscriptions: S().subscriptions.filter((s) => s.TopicArn.includes(`:${ctx.region}:`)) }; },
  ListSubscriptionsByTopic(p) { const t = findTopic(requireParam(p, 'TopicArn')); return { Subscriptions: S().subscriptions.filter((s) => s.TopicArn === t.TopicArn) }; },
  SetSubscriptionAttributes(p) {
    const s = S().subscriptions.find((x) => x.SubscriptionArn === p.SubscriptionArn);
    if (!s) throw new AwsError('NotFound', '구독을 찾을 수 없습니다.', 404);
    if (p.AttributeName === 'FilterPolicy') s.FilterPolicy = typeof p.AttributeValue === 'string' ? JSON.parse(p.AttributeValue) : p.AttributeValue;
    if (p.AttributeName === 'RawMessageDelivery') s.RawMessageDelivery = String(p.AttributeValue) === 'true';
    return {};
  },
  Publish(p, ctx) {
    const depth = (ctx && ctx.depth) || 0;
    const t = findTopic(requireParam(p, p.TopicArn ? 'TopicArn' : 'TargetArn'));
    let message = requireParam(p, 'Message');
    if (typeof message !== 'string') message = JSON.stringify(message);
    const messageId = uuid();
    t.MessagesPublished = (t.MessagesPublished || 0) + 1;
    const deliveries = [];
    for (const sub of S().subscriptions.filter((s) => s.TopicArn === t.TopicArn && s.Status === 'Confirmed')) {
      if (!matchesFilter(sub.FilterPolicy, p.MessageAttributes)) { deliveries.push({ Protocol: sub.Protocol, Endpoint: sub.Endpoint, Status: 'FILTERED' }); continue; }
      const envelope = { Type: 'Notification', MessageId: messageId, TopicArn: t.TopicArn, Subject: p.Subject, Message: message, Timestamp: now(), MessageAttributes: p.MessageAttributes || {} };
      try {
        if (sub.Protocol === 'sqs') { registry.dispatch('sqs', 'SendMessage', { QueueUrl: sub.Endpoint, MessageBody: sub.RawMessageDelivery ? message : JSON.stringify(envelope) }, { depth: depth + 1 }); }
        else if (sub.Protocol === 'lambda') { require('./lambda').invokeByArn(sub.Endpoint, { Records: [{ EventSource: 'aws:sns', EventVersion: '1.0', EventSubscriptionArn: sub.SubscriptionArn, Sns: envelope }] }, 'sns', depth); }
        else if (sub.Protocol.startsWith('email')) { S().inbox.push({ Id: uuid(), To: sub.Endpoint, Subject: p.Subject || (t.DisplayName ? `${t.DisplayName}` : 'AWS Notification Message'), Message: sub.Protocol === 'email-json' ? JSON.stringify(envelope, null, 2) : message, Time: now(), TopicArn: t.TopicArn }); }
        else { S().inbox.push({ Id: uuid(), To: `${sub.Protocol}: ${sub.Endpoint}`, Subject: p.Subject || 'HTTP POST', Message: JSON.stringify(envelope, null, 2), Time: now(), TopicArn: t.TopicArn }); }
        deliveries.push({ Protocol: sub.Protocol, Endpoint: sub.Endpoint, Status: 'DELIVERED' });
      } catch (e) { deliveries.push({ Protocol: sub.Protocol, Endpoint: sub.Endpoint, Status: 'FAILED', Error: e.message }); }
    }
    if (S().inbox.length > 200) S().inbox.splice(0, S().inbox.length - 200);
    store.record({ time: now(), service: 'sns', action: 'Publish', detail: `${t.Name}: ${deliveries.length}건 전달` });
    return { MessageId: messageId, Deliveries: deliveries };
  },
  ListInbox(p) { return { Messages: S().inbox.slice().reverse().filter((m) => !p.To || m.To === p.To) }; },
  ClearInbox() { S().inbox = []; return {}; },
  TagResource(p) { const t = findTopic(requireParam(p, 'ResourceArn')); t.Tags = p.Tags || []; return {}; },
};

module.exports = { actions, findTopic };
