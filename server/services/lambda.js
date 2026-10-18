'use strict';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../store');
const registry = require('../registry');
const { AwsError, now, uuid, hex, requireParam, arn, ACCOUNT_ID } = require('../util');

function S() { return store.get().lambda; }
const RUNTIMES = ['nodejs20.x', 'nodejs18.x', 'python3.12', 'python3.11', 'python3.10'];

const SAMPLES = {
  node: `// Node.js 핸들러 예제
// 전역 'AWS' 객체로 시뮬레이터의 다른 서비스를 호출할 수 있습니다 (aws-sdk v2 스타일).
// 예: const s3 = new AWS.S3(); await s3.putObject({ Bucket: 'my-bucket', Key: 'hello.txt', Body: 'hi' }).promise();
exports.handler = async (event, context) => {
  console.log('받은 이벤트:', JSON.stringify(event));
  const name = (event && event.name) || 'World';
  return {
    statusCode: 200,
    body: JSON.stringify({ message: \`Hello, \${name}!\`, requestId: context.awsRequestId }),
  };
};
`,
  python: `# Python 핸들러 예제
# boto3 shim 이 제공됩니다: boto3.client('s3').put_object(Bucket='my-bucket', Key='a.txt', Body='hi')
import json

def lambda_handler(event, context):
    print('받은 이벤트:', json.dumps(event, ensure_ascii=False))
    name = event.get('name', 'World') if isinstance(event, dict) else 'World'
    return {
        'statusCode': 200,
        'body': json.dumps({'message': f'Hello, {name}!', 'requestId': context.aws_request_id})
    }
`,
};

function findFn(name) {
  const f = S().functions.find((x) => x.FunctionName === name || x.FunctionArn === name);
  if (!f) throw new AwsError('ResourceNotFoundException', `함수 '${name}' 을(를) 찾을 수 없습니다.`, 404);
  return f;
}
function pubFn(f) {
  const { Code, _invocations, ...rest } = f;
  return rest;
}
function fnArn(region, name) { return arn('lambda', region, `function:${name}`); }

function logToCw(f, lines) {
  try {
    registry.dispatch('logs', 'PutLogEvents', { logGroupName: `/aws/lambda/${f.FunctionName}`, logStreamName: f._stream || (f._stream = `${new Date().toISOString().slice(0, 10).replace(/-/g, '/')}/[$LATEST]${hex(32)}`), logEvents: lines.map((m) => ({ timestamp: Date.now(), message: m })), autoCreate: true }, { region: f.Region });
  } catch (e) { /* ignore */ }
}
function metric(f, name, value, unit) {
  try { registry.dispatch('cloudwatch', 'PutMetricData', { Namespace: 'AWS/Lambda', MetricData: [{ MetricName: name, Dimensions: [{ Name: 'FunctionName', Value: f.FunctionName }], Value: value, Unit: unit }] }, { region: f.Region }); } catch (e) { /* ignore */ }
}

// ---- Node.js 실행 ----
const MAX_CHAIN_DEPTH = 4; // 이벤트 → Lambda → 이벤트 … 재귀 호출 깊이 제한
function makeAwsSdk(region, depth = 0) {
  // new AWS.S3().putObject({...}).promise()  → registry.dispatch('s3','PutObject',...)
  const svcMap = { S3: 's3', DynamoDB: 'dynamodb', SQS: 'sqs', SNS: 'sns', Lambda: 'lambda', IAM: 'iam', EC2: 'ec2', CloudWatch: 'cloudwatch', CloudWatchLogs: 'logs' };
  const AWS = {};
  for (const [cls, svc] of Object.entries(svcMap)) {
    AWS[cls] = function Client() {
      return new Proxy({}, { get(_, method) {
        if (typeof method !== 'string') return undefined;
        const action = method[0].toUpperCase() + method.slice(1);
        return (params = {}) => {
          const run = () => registry.dispatch(svc, action, params, { region, caller: 'lambda', depth });
          return { promise: () => Promise.resolve().then(run), send: () => Promise.resolve().then(run) };
        };
      } });
    };
  }
  AWS.DynamoDB.DocumentClient = function DocumentClient() {
    return new Proxy({}, { get(_, method) {
      if (typeof method !== 'string') return undefined;
      const action = { put: 'PutItem', get: 'GetItem', delete: 'DeleteItem', update: 'UpdateItem', query: 'Query', scan: 'Scan', batchWrite: 'BatchWriteItem' }[method] || method[0].toUpperCase() + method.slice(1);
      return (params = {}) => ({ promise: () => Promise.resolve().then(() => registry.dispatch('dynamodb', action, { ...params, _plain: true }, { region, caller: 'lambda', depth })) });
    } });
  };
  AWS.config = { region, update() {} };
  return AWS;
}

async function runNode(f, event, context, logs, depth) {
  const sandbox = {
    console: { log: (...a) => logs.push(fmt(a)), info: (...a) => logs.push(fmt(a)), warn: (...a) => logs.push('WARN ' + fmt(a)), error: (...a) => logs.push('ERROR ' + fmt(a)) },
    module: { exports: {} }, exports: {}, process: { env: { ...(f.Environment && f.Environment.Variables) || {}, AWS_REGION: f.Region, AWS_LAMBDA_FUNCTION_NAME: f.FunctionName, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(f.MemorySize) }, hrtime: process.hrtime },
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Math, Date, Promise, Error, Object, Array, String, Number, Boolean, Map, Set, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    AWS: makeAwsSdk(f.Region, depth),
    require: (m) => {
      if (m === 'aws-sdk') return sandbox.AWS;
      if (['crypto', 'util', 'url', 'querystring', 'path'].includes(m)) return require(m);
      throw new Error(`Cannot find module '${m}' (시뮬레이터는 aws-sdk, crypto, util, url, querystring, path 만 지원합니다)`);
    },
  };
  sandbox.module.exports = sandbox.exports;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const script = new vm.Script(f.Code.Source, { filename: 'index.js' });
  script.runInContext(sandbox, { timeout: 5000 });
  const handlerName = (f.Handler || 'index.handler').split('.').pop();
  const mod = sandbox.module.exports && Object.keys(sandbox.module.exports).length ? sandbox.module.exports : sandbox.exports;
  const handler = mod[handlerName];
  if (typeof handler !== 'function') throw new Error(`Handler '${f.Handler}' 을(를) 찾을 수 없습니다. 'exports.${handlerName} = async (event, context) => {...}' 형태로 내보내야 합니다.`);
  const timeoutMs = (f.Timeout || 3) * 1000;
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Task timed out after ${(f.Timeout || 3).toFixed(2)} seconds`)), timeoutMs); });
  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        try {
          const r = handler(event, context, (err, res) => (err ? reject(err) : resolve(res)));
          if (r && typeof r.then === 'function') r.then(resolve, reject);
          else if (handler.length < 3) resolve(r);
        } catch (e) { reject(e); }
      }),
      timeout,
    ]);
    return result;
  } finally { clearTimeout(timer); }
}
function fmt(args) { return args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '); }
function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

// ---- Python 실행 ----
const PY_WRAPPER = `
import sys, json, io, traceback, importlib.util, os
d = sys.argv[1]
sys.path.insert(0, d)
req = json.loads(sys.stdin.read())
spec = importlib.util.spec_from_file_location('lambda_function', os.path.join(d, 'lambda_function.py'))
mod = importlib.util.module_from_spec(spec)
out = io.StringIO()
real_stdout = sys.stdout
sys.stdout = out
class Ctx:
    def __init__(self, c):
        self.aws_request_id = c['awsRequestId']; self.function_name = c['functionName']; self.memory_limit_in_mb = c['memoryLimitInMB']; self.invoked_function_arn = c['invokedFunctionArn']; self.log_group_name = c['logGroupName']
    def get_remaining_time_in_millis(self): return 3000
result = {'ok': True}
try:
    spec.loader.exec_module(mod)
    handler = getattr(mod, req['handler'])
    r = handler(req['event'], Ctx(req['context']))
    result['result'] = r
except Exception as e:
    result = {'ok': False, 'errorType': type(e).__name__, 'errorMessage': str(e), 'stackTrace': traceback.format_exc().splitlines()}
sys.stdout = real_stdout
result['logs'] = out.getvalue()
print('\\n__LAMBDA_RESULT__' + json.dumps(result, ensure_ascii=False, default=str))
`;
const PY_BOTO3 = `
# boto3 shim: 시뮬레이터 HTTP API 를 호출합니다.
import json, os, re, urllib.request
_BASE = os.environ.get('AWS_SIM_ENDPOINT', 'http://127.0.0.1:4566')
_SVC = {'s3': 's3', 'dynamodb': 'dynamodb', 'sqs': 'sqs', 'sns': 'sns', 'lambda': 'lambda', 'iam': 'iam', 'ec2': 'ec2', 'cloudwatch': 'cloudwatch', 'logs': 'logs'}
def _pascal(name):
    return ''.join(p.capitalize() for p in name.split('_'))
class _Client:
    def __init__(self, svc, region):
        self._svc = svc; self._region = region
    def __getattr__(self, name):
        def call(**kw):
            if self._svc == 'dynamodb': kw['_plain'] = False
            data = json.dumps(kw, default=str).encode('utf-8')
            req = urllib.request.Request(f"{_BASE}/api/{self._svc}/{_pascal(name)}", data=data, headers={'Content-Type': 'application/json', 'x-region': self._region or ''})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    return json.loads(r.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8')
                try: err = json.loads(body)
                except Exception: err = {'message': body}
                raise Exception(f"{err.get('__type', 'Error')}: {err.get('message', body)}")
        return call
def client(svc, region_name=None, **kw):
    return _Client(_SVC.get(svc, svc), region_name or os.environ.get('AWS_REGION'))
class _Table:
    def __init__(self, c, name): self._c = c; self.name = name
    def put_item(self, Item, **kw): return self._c.put_item(TableName=self.name, Item=Item, _plain=True)
    def get_item(self, Key, **kw): return self._c.get_item(TableName=self.name, Key=Key, _plain=True)
    def delete_item(self, Key, **kw): return self._c.delete_item(TableName=self.name, Key=Key, _plain=True)
    def scan(self, **kw): return self._c.scan(TableName=self.name, _plain=True, **kw)
    def query(self, **kw): return self._c.query(TableName=self.name, _plain=True, **kw)
class _Resource:
    def __init__(self, svc, region): self._svc = svc; self._c = _Client(svc, region)
    def Table(self, name): return _Table(self._c, name)
def resource(svc, region_name=None, **kw):
    return _Resource(_SVC.get(svc, svc), region_name or os.environ.get('AWS_REGION'))
`;
function findPython() {
  for (const c of ['python', 'python3', 'py']) {
    try { const r = require('child_process').spawnSync(c, ['--version']); if (r.status === 0) return c; } catch (e) { /* next */ }
  }
  return null;
}
let pythonCmd;
function runPython(f, event, context, logs) {
  return new Promise((resolve, reject) => {
    if (pythonCmd === undefined) pythonCmd = findPython();
    if (!pythonCmd) return reject(new Error('이 PC에 Python 이 설치되어 있지 않아 Python 런타임을 실행할 수 없습니다. nodejs 런타임을 사용하세요.'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsim-lambda-'));
    fs.writeFileSync(path.join(dir, 'lambda_function.py'), f.Code.Source);
    fs.writeFileSync(path.join(dir, 'boto3.py'), PY_BOTO3);
    fs.writeFileSync(path.join(dir, '_wrapper.py'), PY_WRAPPER);
    const env = { ...process.env, ...((f.Environment && f.Environment.Variables) || {}), AWS_REGION: f.Region, AWS_LAMBDA_FUNCTION_NAME: f.FunctionName, AWS_SIM_ENDPOINT: `http://127.0.0.1:${process.env.AWSIM_PORT || 4566}`, PYTHONIOENCODING: 'utf-8' };
    // -I: 격리 모드(환경변수/사용자 site 무시), -X utf8: 콘솔 코드페이지와 무관하게 UTF-8 입출력
    const child = spawn(pythonCmd, ['-I', '-X', 'utf8', path.join(dir, '_wrapper.py'), dir], { env });
    const outChunks = [], errChunks = [];
    let out = '', err = '';
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.stdin.on('error', () => { /* 파이썬이 일찍 종료한 경우 EPIPE 무시 */ });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Task timed out after ${(f.Timeout || 3).toFixed(2)} seconds`)); }, (f.Timeout || 3) * 1000 + 1500);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      out = Buffer.concat(outChunks).toString('utf8'); err = Buffer.concat(errChunks).toString('utf8');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      const idx = out.lastIndexOf('__LAMBDA_RESULT__');
      if (idx < 0) return reject(new Error('Python 실행 실패:\n' + (err || out).trim()));
      let res;
      try { res = JSON.parse(out.slice(idx + '__LAMBDA_RESULT__'.length)); } catch (e) { return reject(new Error('결과 파싱 실패: ' + e.message)); }
      if (res.logs) logs.push(...res.logs.replace(/\n$/, '').split('\n'));
      if (err.trim()) logs.push(...err.trim().split('\n'));
      if (!res.ok) { const e = new Error(res.errorMessage); e.name = res.errorType; e.stackTrace = res.stackTrace; return reject(e); }
      resolve(res.result);
    });
    child.stdin.end(JSON.stringify({ event, context, handler: (f.Handler || 'lambda_function.lambda_handler').split('.').pop() }));
  });
}

async function invoke(f, event, invocationType = 'RequestResponse', source = 'manual', depth = 0) {
  const requestId = uuid();
  const start = Date.now();
  const logs = [];
  const context = { awsRequestId: requestId, functionName: f.FunctionName, functionVersion: '$LATEST', memoryLimitInMB: f.MemorySize, invokedFunctionArn: f.FunctionArn, logGroupName: `/aws/lambda/${f.FunctionName}`, logStreamName: f._stream || '', getRemainingTimeInMillis: () => Math.max(0, (f.Timeout || 3) * 1000 - (Date.now() - start)) };
  const lines = [`START RequestId: ${requestId} Version: $LATEST`];
  let result, error;
  try {
    if (f.Runtime.startsWith('python')) result = await runPython(f, event, context, logs);
    else result = await runNode(f, event, context, logs, depth);
  } catch (e) { error = e; }
  const duration = Date.now() - start;
  lines.push(...logs.map((l) => `${new Date().toISOString()}\t${requestId}\tINFO\t${l}`));
  if (error) lines.push(`${new Date().toISOString()}\t${requestId}\tERROR\tInvoke Error\t${safeJson({ errorType: error.name || 'Error', errorMessage: error.message, stack: (error.stack || '').split('\n').slice(0, 4) })}`);
  lines.push(`END RequestId: ${requestId}`, `REPORT RequestId: ${requestId}\tDuration: ${duration.toFixed(2)} ms\tBilled Duration: ${Math.max(1, Math.ceil(duration))} ms\tMemory Size: ${f.MemorySize} MB\tMax Memory Used: ${Math.min(f.MemorySize, 40 + Math.round(Math.random() * 30))} MB`);
  logToCw(f, lines);
  metric(f, 'Invocations', 1, 'Count');
  metric(f, 'Duration', duration, 'Milliseconds');
  if (error) metric(f, 'Errors', 1, 'Count');
  f._invocations = (f._invocations || 0) + 1;
  f.LastInvoked = now();
  f.LastInvokeStatus = error ? 'Error' : 'Success';
  f.InvokeSources = f.InvokeSources || {};
  f.InvokeSources[source] = (f.InvokeSources[source] || 0) + 1;
  if (!error) f.SuccessCount = (f.SuccessCount || 0) + 1;
  store.record({ time: now(), service: 'lambda', action: 'Invoke', detail: `${f.FunctionName} (${source}) ${error ? 'ERROR' : 'OK'} ${duration}ms` });
  store.save();
  return { requestId, result, error, duration, logs: lines };
}

const actions = {
  CreateFunction(p, ctx) {
    const name = requireParam(p, 'FunctionName');
    if (!/^[a-zA-Z0-9-_]{1,64}$/.test(name)) throw new AwsError('ValidationException', '함수 이름은 영숫자, 하이픈, 밑줄만 사용할 수 있습니다 (최대 64자).');
    if (S().functions.find((f) => f.FunctionName === name && f.Region === ctx.region)) throw new AwsError('ResourceConflictException', `함수 '${name}' 이(가) 이미 존재합니다.`, 409);
    const runtime = p.Runtime || 'nodejs20.x';
    if (!RUNTIMES.includes(runtime)) throw new AwsError('InvalidParameterValueException', `지원하지 않는 런타임: ${runtime}. 지원: ${RUNTIMES.join(', ')}`);
    const role = requireParam(p, 'Role');
    const iamRole = store.get().iam.roles.find((r) => r.Arn === role || r.RoleName === role);
    if (!iamRole) throw new AwsError('InvalidParameterValueException', `실행 역할 ${role} 을(를) 찾을 수 없습니다. IAM 에서 lambda.amazonaws.com 을 신뢰하는 역할을 먼저 만드세요.`);
    const trust = iamRole.AssumeRolePolicyDocument;
    const trusted = trust.Statement.some((s) => s.Effect === 'Allow' && s.Principal && [].concat((s.Principal.Service) || []).includes('lambda.amazonaws.com'));
    if (!trusted) throw new AwsError('InvalidParameterValueException', `역할 ${iamRole.RoleName} 의 신뢰 정책이 lambda.amazonaws.com 을 허용하지 않습니다. 'The role defined for the function cannot be assumed by Lambda.'`);
    let source = (p.Code && (p.Code.ZipFile || p.Code.Source)) || p.Source;
    if (!source) source = runtime.startsWith('python') ? SAMPLES.python : SAMPLES.node;
    if (typeof source === 'string' && p.Code && p.Code.ZipFile && /^[A-Za-z0-9+/=]+$/.test(source) && !/\s/.test(source) && source.length % 4 === 0) { try { source = Buffer.from(source, 'base64').toString('utf8'); } catch (e) { /* keep */ } }
    const f = {
      FunctionName: name, FunctionArn: fnArn(ctx.region, name), Runtime: runtime, Role: iamRole.Arn, Handler: p.Handler || (runtime.startsWith('python') ? 'lambda_function.lambda_handler' : 'index.handler'),
      CodeSize: Buffer.byteLength(source), Description: p.Description || '', Timeout: Number(p.Timeout || 3), MemorySize: Number(p.MemorySize || 128), LastModified: now(), CodeSha256: require('crypto').createHash('sha256').update(source).digest('base64'), Version: '$LATEST',
      Environment: p.Environment || { Variables: {} }, Architectures: ['x86_64'], PackageType: 'Zip', State: 'Active', Region: ctx.region, Tags: p.Tags || {}, Code: { Source: source }, _invocations: 0,
    };
    if (f.Timeout < 1 || f.Timeout > 900) throw new AwsError('ValidationException', 'Timeout 은 1~900초여야 합니다.');
    if (f.MemorySize < 128 || f.MemorySize > 10240) throw new AwsError('ValidationException', 'MemorySize 는 128~10240MB 여야 합니다.');
    S().functions.push(f);
    try { registry.dispatch('logs', 'CreateLogGroup', { logGroupName: `/aws/lambda/${name}` }, ctx); } catch (e) { /* exists */ }
    return pubFn(f);
  },
  ListFunctions(p, ctx) { return { Functions: S().functions.filter((f) => f.Region === ctx.region).map(pubFn) }; },
  GetFunction(p) { const f = findFn(requireParam(p, 'FunctionName')); return { Configuration: pubFn(f), Code: { RepositoryType: 'Sim', Source: f.Code.Source }, Tags: f.Tags }; },
  GetFunctionConfiguration(p) { return pubFn(findFn(requireParam(p, 'FunctionName'))); },
  UpdateFunctionCode(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    const src = p.ZipFile || p.Source;
    if (!src) throw new AwsError('ValidationException', 'ZipFile(소스 코드)이 필요합니다.');
    f.Code.Source = src; f.CodeSize = Buffer.byteLength(src); f.LastModified = now(); f.CodeSha256 = require('crypto').createHash('sha256').update(src).digest('base64');
    return pubFn(f);
  },
  UpdateFunctionConfiguration(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    for (const k of ['Handler', 'Description', 'Runtime']) if (p[k] !== undefined) f[k] = p[k];
    if (p.Timeout !== undefined) f.Timeout = Number(p.Timeout);
    if (p.MemorySize !== undefined) f.MemorySize = Number(p.MemorySize);
    if (p.Environment) f.Environment = p.Environment;
    if (p.Role) { const r = store.get().iam.roles.find((x) => x.Arn === p.Role || x.RoleName === p.Role); if (!r) throw new AwsError('InvalidParameterValueException', '역할을 찾을 수 없습니다.'); f.Role = r.Arn; }
    f.LastModified = now();
    return pubFn(f);
  },
  DeleteFunction(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    S().functions = S().functions.filter((x) => x !== f);
    S().eventSourceMappings = S().eventSourceMappings.filter((m) => m.FunctionArn !== f.FunctionArn);
    return {};
  },
  async Invoke(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    let payload = p.Payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { throw new AwsError('InvalidRequestContentException', 'Payload 는 유효한 JSON 이어야 합니다: ' + e.message); } }
    if (payload === undefined) payload = {};
    const type = p.InvocationType || 'RequestResponse';
    if (type === 'Event') { invoke(f, payload, type, 'async'); return { StatusCode: 202 }; }
    const r = await invoke(f, payload, type, 'manual');
    const out = { StatusCode: 200, ExecutedVersion: '$LATEST', Payload: r.error ? { errorType: r.error.name || 'Error', errorMessage: r.error.message, stackTrace: r.error.stackTrace || (r.error.stack || '').split('\n').slice(0, 5) } : (r.result === undefined ? null : r.result), RequestId: r.requestId, DurationMs: r.duration };
    if (r.error) out.FunctionError = 'Unhandled';
    if (p.LogType === 'Tail' || p.IncludeLogs !== false) out.LogResult = r.logs.join('\n');
    return out;
  },
  AddPermission(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    f.Permissions = f.Permissions || [];
    f.Permissions.push({ Sid: p.StatementId || hex(8), Action: p.Action || 'lambda:InvokeFunction', Principal: p.Principal, SourceArn: p.SourceArn });
    return { Statement: JSON.stringify(f.Permissions[f.Permissions.length - 1]) };
  },
  GetPolicy(p) { const f = findFn(requireParam(p, 'FunctionName')); return { Policy: JSON.stringify({ Version: '2012-10-17', Statement: f.Permissions || [] }) }; },
  CreateFunctionUrlConfig(p) {
    const f = findFn(requireParam(p, 'FunctionName'));
    f.FunctionUrl = `http://localhost:${process.env.AWSIM_PORT || 4566}/lambda-url/${f.FunctionName}/`;
    f.FunctionUrlAuthType = p.AuthType || 'NONE';
    return { FunctionUrl: f.FunctionUrl, FunctionArn: f.FunctionArn, AuthType: f.FunctionUrlAuthType, CreationTime: now() };
  },
  GetFunctionUrlConfig(p) { const f = findFn(requireParam(p, 'FunctionName')); if (!f.FunctionUrl) throw new AwsError('ResourceNotFoundException', '함수 URL 이 없습니다.', 404); return { FunctionUrl: f.FunctionUrl, FunctionArn: f.FunctionArn, AuthType: f.FunctionUrlAuthType }; },
  DeleteFunctionUrlConfig(p) { const f = findFn(requireParam(p, 'FunctionName')); delete f.FunctionUrl; delete f.FunctionUrlAuthType; return {}; },
  CreateEventSourceMapping(p, ctx) {
    const f = findFn(requireParam(p, 'FunctionName'));
    const src = requireParam(p, 'EventSourceArn');
    if (!/^arn:aws:(sqs|dynamodb):/.test(src)) throw new AwsError('InvalidParameterValueException', '이 시뮬레이터는 SQS / DynamoDB Streams 이벤트 소스 매핑만 지원합니다.');
    if (src.startsWith('arn:aws:sqs:')) { const q = store.get().sqs.queues.find((x) => x.QueueArn === src); if (!q) throw new AwsError('InvalidParameterValueException', `SQS 대기열 ${src} 을(를) 찾을 수 없습니다.`); }
    const m = { UUID: uuid(), EventSourceArn: src, FunctionArn: f.FunctionArn, BatchSize: Number(p.BatchSize || 10), State: p.Enabled === false ? 'Disabled' : 'Enabled', LastModified: now(), Region: ctx.region, LastProcessingResult: 'No records processed' };
    S().eventSourceMappings.push(m);
    return m;
  },
  ListEventSourceMappings(p, ctx) { return { EventSourceMappings: S().eventSourceMappings.filter((m) => m.Region === ctx.region && (!p.FunctionName || m.FunctionArn === findFn(p.FunctionName).FunctionArn)) }; },
  DeleteEventSourceMapping(p) { S().eventSourceMappings = S().eventSourceMappings.filter((m) => m.UUID !== p.UUID); return {}; },
  ListRuntimes() { return { Runtimes: RUNTIMES, Samples: SAMPLES }; },
  ListTags(p) { return { Tags: findFn(requireParam(p, 'Resource')).Tags }; },
};

// ---- 이벤트 소스 연결 ----
function s3Event(bucket, eventName, key, obj) {
  return { Records: [{ eventVersion: '2.1', eventSource: 'aws:s3', awsRegion: bucket.Region, eventTime: now(), eventName, s3: { s3SchemaVersion: '1.0', bucket: { name: bucket.Name, arn: bucket.Arn }, object: { key: encodeURIComponent(key).replace(/%2F/g, '/'), size: obj.Size || 0, eTag: (obj.ETag || '').replace(/"/g, ''), versionId: obj.VersionId } } }] };
}
function onS3Event(bucket, eventName, key, obj, ctx) {
  const depth = (ctx && ctx.depth) || 0;
  if (!(bucket.Notifications || []).length) return;
  if (depth >= MAX_CHAIN_DEPTH) {
    store.record({ time: now(), service: 'lambda', action: 'RecursionGuard', detail: `재귀 호출 감지: 버킷 ${bucket.Name} 의 이벤트가 Lambda 를 반복 호출하고 있어 깊이 ${depth} 에서 중단했습니다. (Lambda 가 트리거 버킷에 다시 쓰고 있지 않은지 확인하세요)` });
    return;
  }
  for (const n of bucket.Notifications || []) {
    if (!n.Events.some((e) => e === `s3:${eventName}` || (e.endsWith('*') && `s3:${eventName}`.startsWith(e.slice(0, -1))))) continue;
    if (n.Filter && n.Filter.Key && n.Filter.Key.FilterRules) {
      const ok = n.Filter.Key.FilterRules.every((r) => (r.Name.toLowerCase() === 'prefix' ? key.startsWith(r.Value) : key.endsWith(r.Value)));
      if (!ok) continue;
    }
    const ev = s3Event(bucket, eventName, key, obj);
    if (n.Type === 'lambda') { const f = S().functions.find((x) => x.FunctionArn === n.Target); if (f) invoke(f, ev, 'Event', 's3', depth + 1); }
    else if (n.Type === 'sqs') { try { registry.dispatch('sqs', 'SendMessage', { QueueUrl: n.Target, MessageBody: JSON.stringify(ev) }, { depth: depth + 1 }); } catch (e) { /* ignore */ } }
    else if (n.Type === 'sns') { try { registry.dispatch('sns', 'Publish', { TopicArn: n.Target, Message: JSON.stringify(ev), Subject: 'Amazon S3 Notification' }, { depth: depth + 1 }); } catch (e) { /* ignore */ } }
  }
}
function invokeByArn(fnArnOrName, event, source, depth = 0) {
  const f = S().functions.find((x) => x.FunctionArn === fnArnOrName || x.FunctionName === fnArnOrName);
  if (!f) return null;
  if (depth >= MAX_CHAIN_DEPTH) { store.record({ time: now(), service: 'lambda', action: 'RecursionGuard', detail: `재귀 호출 감지: ${f.FunctionName} (source=${source}) 깊이 ${depth} 에서 중단` }); return null; }
  return invoke(f, event, 'Event', source, depth + 1);
}
// SQS 폴러
let polling = false;
async function pollSqs() {
  if (polling) return; polling = true;
  try {
    for (const m of S().eventSourceMappings.filter((x) => x.State === 'Enabled' && x.EventSourceArn.startsWith('arn:aws:sqs:'))) {
      const q = store.get().sqs.queues.find((x) => x.QueueArn === m.EventSourceArn);
      const f = S().functions.find((x) => x.FunctionArn === m.FunctionArn);
      if (!q || !f) continue;
      const r = registry.dispatch('sqs', 'ReceiveMessage', { QueueUrl: q.QueueUrl, MaxNumberOfMessages: Math.min(10, m.BatchSize) });
      if (!r.Messages || !r.Messages.length) continue;
      const ev = { Records: r.Messages.map((msg) => ({ messageId: msg.MessageId, receiptHandle: msg.ReceiptHandle, body: msg.Body, attributes: msg.Attributes, messageAttributes: msg.MessageAttributes || {}, md5OfBody: msg.MD5OfBody, eventSource: 'aws:sqs', eventSourceARN: q.QueueArn, awsRegion: q.Region })) };
      const res = await invoke(f, ev, 'Event', 'sqs', 1);
      if (!res.error) { for (const msg of r.Messages) registry.dispatch('sqs', 'DeleteMessage', { QueueUrl: q.QueueUrl, ReceiptHandle: msg.ReceiptHandle }); m.LastProcessingResult = 'OK'; }
      else m.LastProcessingResult = 'PROBLEM: ' + res.error.message;
      m.LastModified = now();
    }
  } catch (e) { /* ignore */ } finally { polling = false; }
}
function startPollers() { setInterval(pollSqs, 2000); }

module.exports = { actions, invoke, onS3Event, invokeByArn, startPollers, SAMPLES, RUNTIMES };
