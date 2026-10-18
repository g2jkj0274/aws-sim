#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const registry = require('./registry');
const util = require('./util');
const { AwsError, REGIONS, DEFAULT_REGION, ACCOUNT_ID } = util;

const args = process.argv.slice(2);
const PORT = Number((args.find((a) => a.startsWith('--port=')) || '').split('=')[1] || process.env.AWSIM_PORT || 4566);
process.env.AWSIM_PORT = String(PORT);
const RESET = args.includes('--reset');

store.load(RESET);

const iam = require('./services/iam');
const vpc = require('./services/vpc');
const ec2 = require('./services/ec2');
const s3 = require('./services/s3');
const lambda = require('./services/lambda');
const dynamodb = require('./services/dynamodb');
const sqs = require('./services/sqs');
const sns = require('./services/sns');
const cloudwatch = require('./services/cloudwatch');
const billing = require('./services/billing');
const labs = require('./labs');

iam.seed();
ec2.seed();
for (const r of REGIONS) vpc.seedRegion(r.id);
store.saveNow();

const ec2Merged = { actions: { ...vpc.actions, ...ec2.actions } };
registry.register('iam', iam);
registry.register('sts', { actions: { GetCallerIdentity: iam.actions.GetCallerIdentity } });
registry.register('ec2', ec2Merged);
registry.register('vpc', ec2Merged);
registry.register('s3', s3);
registry.register('s3api', s3);
registry.register('lambda', lambda);
registry.register('dynamodb', dynamodb);
registry.register('sqs', sqs);
registry.register('sns', sns);
registry.register('cloudwatch', cloudwatch);
registry.register('logs', { actions: cloudwatch.logsActions });
registry.register('billing', billing);
registry.register('ce', billing);
s3.setEventHook(lambda.onS3Event);

const CONSOLE_DIR = path.join(__dirname, '..', 'console');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', ...extra });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function errorBody(e) {
  if (e instanceof AwsError) return { status: e.status, body: { __type: e.code, Code: e.code, message: e.message, Message: e.message } };
  console.error(e);
  return { status: 500, body: { __type: 'InternalError', Code: 'InternalError', message: e.message, stack: (e.stack || '').split('\n').slice(0, 5) } };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, svc, action
  const raw = await readBody(req);
  let params = {};
  if (raw.length) { try { params = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { __type: 'SerializationException', message: 'JSON 본문을 해석할 수 없습니다: ' + e.message }); } }
  const region = req.headers['x-region'] || params.Region || url.searchParams.get('region') || DEFAULT_REGION;
  if (!REGIONS.find((r) => r.id === region)) return send(res, 400, { __type: 'InvalidRegion', message: `알 수 없는 리전: ${region}. 사용 가능: ${REGIONS.map((r) => r.id).join(', ')}` });
  const ctx = { region, caller: 'user' };

  // ---- 메타/보조 엔드포인트 ----
  if (parts[1] === 'meta') {
    return send(res, 200, { AccountId: ACCOUNT_ID, DefaultRegion: DEFAULT_REGION, Regions: REGIONS, Services: Object.fromEntries(registry.list().map((s) => [s, Object.keys(registry.services[s].actions)])), Port: PORT, InstanceTypes: ec2.INSTANCE_TYPES, LambdaRuntimes: lambda.RUNTIMES, LambdaSamples: lambda.SAMPLES });
  }
  if (parts[1] === 'labs') {
    if (parts[2] === 'reset' && req.method === 'POST') { labs.reset(); return send(res, 200, { ok: true }); }
    return send(res, 200, labs.progress(region));
  }
  if (parts[1] === 'history') return send(res, 200, { Events: store.get().history.slice(-Number(url.searchParams.get('limit') || 100)).reverse() });
  if (parts[1] === 'reset' && req.method === 'POST') {
    store.load(true); iam.seed(); ec2.seed(); for (const r of REGIONS) vpc.seedRegion(r.id); store.saveNow();
    return send(res, 200, { ok: true, message: '모든 리소스를 초기화했습니다.' });
  }
  if (parts[1] === 'overview') {
    const s = store.get();
    const inR = (list) => list.filter((x) => x.Region === region);
    return send(res, 200, {
      Region: region,
      Counts: { ec2Running: inR(s.ec2.instances).filter((i) => i.State.Name === 'running').length, ec2Total: inR(s.ec2.instances).filter((i) => i.State.Name !== 'terminated').length, vpcs: inR(s.vpc.vpcs).length, s3Buckets: s.s3.buckets.length, iamUsers: s.iam.users.length, iamRoles: s.iam.roles.length, lambda: inR(s.lambda.functions).length, dynamodb: inR(s.dynamodb.tables).length, sqs: inR(s.sqs.queues).length, sns: inR(s.sns.topics).length, alarms: inR(s.cloudwatch.alarms).length, alarmsInAlarm: inR(s.cloudwatch.alarms).filter((a) => a.StateValue === 'ALARM').length },
      Cost: billing.estimate(), Labs: labs.progress(region), Recent: s.history.slice(-8).reverse(),
    });
  }

  const svc = parts[1], action = parts[2];
  if (!svc || !action) return send(res, 404, { __type: 'NotFound', message: 'POST /api/<service>/<Action> 형식으로 호출하세요. GET /api/meta 에서 서비스/작업 목록을 확인할 수 있습니다.' });
  try {
    let result = registry.dispatch(svc, action, params, ctx);
    if (result && typeof result.then === 'function') result = await result;
    return send(res, 200, result === undefined ? {} : result, 'application/json; charset=utf-8', { 'x-amzn-RequestId': util.uuid() });
  } catch (e) {
    const { status, body } = errorBody(e);
    return send(res, status, body);
  }
}

async function handleLambdaUrl(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // lambda-url, fn, ...
  const name = parts[1];
  const f = store.get().lambda.functions.find((x) => x.FunctionName === name);
  if (!f || !f.FunctionUrl) return send(res, 404, { Message: '함수 URL 이 없습니다. CreateFunctionUrlConfig 로 먼저 만드세요.' });
  const raw = await readBody(req);
  const event = { version: '2.0', routeKey: '$default', rawPath: '/' + parts.slice(2).join('/'), rawQueryString: url.search.slice(1), headers: req.headers, queryStringParameters: Object.fromEntries(url.searchParams), requestContext: { http: { method: req.method, path: '/' + parts.slice(2).join('/'), sourceIp: '127.0.0.1', userAgent: req.headers['user-agent'] }, requestId: util.uuid(), timeEpoch: Date.now() }, body: raw.length ? raw.toString('utf8') : undefined, isBase64Encoded: false };
  const r = await lambda.invoke(f, event, 'RequestResponse', 'url');
  if (r.error) return send(res, 502, { Message: 'Internal Server Error', Error: r.error.message });
  const out = r.result;
  if (out && typeof out === 'object' && out.statusCode) {
    const headers = out.headers || {};
    return send(res, out.statusCode, typeof out.body === 'string' ? out.body : JSON.stringify(out.body), headers['content-type'] || headers['Content-Type'] || (typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'), headers);
  }
  return send(res, 200, typeof out === 'string' ? out : JSON.stringify(out), typeof out === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(CONSOLE_DIR, p));
  if (!file.startsWith(CONSOLE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    return send(res, 200, fs.readFileSync(path.join(CONSOLE_DIR, 'index.html')), MIME['.html']);
  }
  return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/s3/')) { const [, , bucket, ...rest] = url.pathname.split('/'); const r = s3.serveObject(bucket, decodeURIComponent(rest.join('/')), false); return send(res, r.status, r.body, r.type); }
    if (url.pathname.startsWith('/s3-website/')) { const [, , bucket, ...rest] = url.pathname.split('/'); const r = s3.serveObject(bucket, decodeURIComponent(rest.join('/')), true); return send(res, r.status, r.body, r.type); }
    if (url.pathname.startsWith('/lambda-url/')) return await handleLambdaUrl(req, res, url);
    if (url.pathname.startsWith('/sqs/')) return send(res, 200, { message: 'SQS 대기열 URL 입니다. API 는 POST /api/sqs/<Action> 을 사용하세요.' });
    return serveStatic(req, res, url);
  } catch (e) {
    const { status, body } = errorBody(e);
    return send(res, status, body);
  }
});

server.listen(PORT, () => {
  cloudwatch.startTimers();
  lambda.startPollers();
  console.log(`\n  AWS 시뮬레이터가 시작되었습니다.`);
  console.log(`  콘솔:   http://localhost:${PORT}/`);
  console.log(`  API:    POST http://localhost:${PORT}/api/<service>/<Action>`);
  console.log(`  CLI:    node cli/awsim.js <service> <command> [--옵션 값 ...]`);
  console.log(`  상태:   ${store.FILE}${RESET ? ' (초기화됨)' : ''}\n`);
});
process.on('SIGINT', () => { store.saveNow(); process.exit(0); });
