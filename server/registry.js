'use strict';
// 서비스 간 호출(예: SNS → Lambda, S3 → Lambda)과 API 라우팅이 공유하는 디스패처.
const { AwsError, DEFAULT_REGION } = require('./util');
const store = require('./store');

const services = {};

function register(name, mod) { services[name] = mod; }
function list() { return Object.keys(services); }

function dispatch(service, action, params = {}, ctx = {}) {
  const mod = services[service];
  if (!mod) throw new AwsError('UnknownService', `알 수 없는 서비스: ${service}`, 404);
  const fn = mod.actions[action];
  if (!fn) throw new AwsError('InvalidAction', `${service} 서비스에 '${action}' 작업이 없습니다. 지원 작업: ${Object.keys(mod.actions).join(', ')}`, 400);
  const region = params.Region || ctx.region || DEFAULT_REGION;
  const c = { caller: 'user', ...ctx, region };
  const result = fn(params, c);
  const labs = store.get().labs;
  labs.counts = labs.counts || {};
  const key = `${service}:${action}`;
  labs.counts[key] = (labs.counts[key] || 0) + 1;
  const mutating = !/^(Describe|List|Get|Head|Simulate|Check|Filter|Receive|Peek)/.test(action);
  if (mutating) {
    store.record({ time: new Date().toISOString(), service, action, detail: summarize(params), caller: c.caller });
  } else store.save();
  return result;
}
function summarize(p) {
  const keys = ['Bucket', 'Key', 'UserName', 'RoleName', 'GroupName', 'PolicyName', 'FunctionName', 'TableName', 'QueueName', 'QueueUrl', 'TopicArn', 'Name', 'InstanceIds', 'InstanceId', 'VpcId', 'SubnetId', 'GroupId', 'CidrBlock', 'AlarmName', 'logGroupName'];
  return keys.filter((k) => p[k] !== undefined).map((k) => `${k}=${Array.isArray(p[k]) ? p[k].join(',') : String(p[k]).slice(0, 60)}`).join(' ');
}

module.exports = { register, dispatch, list, services };
