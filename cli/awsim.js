#!/usr/bin/env node
'use strict';
// awsim — AWS CLI 문법을 흉내 내는 시뮬레이터용 CLI
//   awsim <service> <command> [--option value ...] [--region <r>] [--endpoint-url <url>] [--output json|table|text]
//   예) awsim ec2 run-instances --image-id ami-0c9c942bd7bf113a2 --instance-type t2.micro
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.awsim', 'config.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; } }
const cfg = loadConfig();
let ENDPOINT = process.env.AWSIM_ENDPOINT || cfg.endpoint || 'http://localhost:4566';
let REGION = process.env.AWSIM_REGION || process.env.AWS_DEFAULT_REGION || cfg.region || 'ap-northeast-2';
let OUTPUT = cfg.output || 'json';

const pascal = (s) => s.split('-').filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const LIST_PARAMS = new Set(['InstanceIds', 'ActionNames', 'ResourceArns', 'Resources', 'KeyNames', 'GroupIds', 'GroupNames', 'SecurityGroupIds', 'SecurityGroups', 'Filters', 'Tags', 'AlarmNames', 'AlarmActions', 'OKActions', 'AttributeDefinitions', 'KeySchema', 'Dimensions', 'Statistics', 'Entries', 'MetricData', 'TagSpecifications', 'IpPermissions', 'VpcIds', 'SubnetIds', 'RouteTableIds', 'InternetGatewayIds', 'QueueUrls', 'Events', 'MetricDataQueries', 'Objects', 'ImageIds', 'GlobalSecondaryIndexes', 'LogEvents', 'TableNames', 'AttributeNames', 'Users']);
const LIST_KEYS = new Set(['Values', 'Tags', 'IpRanges', 'Rules', 'Events', 'Statement']);

// ---- 짧은 구문(shorthand) 파서: Key=Value,Key2=Value2 / [ {..},{..} ] / Values=a,b ----
function parseShorthand(str) {
  let i = 0;
  const s = str.trim();
  const peek = () => s[i];
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function parseValue(stopChars) {
    skipWs();
    if (peek() === '{') { i++; const o = parseObject('}'); return o; }
    if (peek() === '[') { i++; const arr = []; skipWs(); while (i < s.length && peek() !== ']') { arr.push(parseValue(',]')); skipWs(); if (peek() === ',') i++; skipWs(); } i++; return arr; }
    let start = i;
    while (i < s.length && !stopChars.includes(s[i])) i++;
    return coerce(s.slice(start, i).trim());
  }
  function parseObject(end) {
    const o = {};
    skipWs();
    while (i < s.length && peek() !== end) {
      let start = i;
      while (i < s.length && s[i] !== '=') i++;
      const key = s.slice(start, i).trim(); i++;
      skipWs();
      if (peek() === '[' || peek() === '{') { o[key] = parseValue(',' + end); }
      else {
        // 값: 다음 "키=" 가 나올 때까지(쉼표 포함)
        start = i;
        while (i < s.length && s[i] !== end) {
          if (s[i] === ',') { const rest = s.slice(i + 1); if (/^\s*[\w.-]+\s*=/.test(rest) || !LIST_KEYS.has(key)) break; }
          i++;
        }
        const raw = s.slice(start, i).trim();
        o[key] = LIST_KEYS.has(key) && raw.includes(',') ? raw.split(',').map((x) => coerce(x.trim())) : coerce(raw);
      }
      skipWs();
      if (peek() === ',') i++;
      skipWs();
    }
    if (end !== '\0') i++;
    return o;
  }
  if (s[0] === '[' ) return parseValue('');
  if (s[0] === '{') return parseValue('');
  return parseObject('\0');
}
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  return v;
}
function parseValueToken(v) {
  if (typeof v !== 'string') return v;
  if (/^fileb?:\/\//.test(v)) { const p = v.replace(/^fileb?:\/\//, ''); try { return fs.readFileSync(p, 'utf8'); } catch (e) { die(`파일을 읽을 수 없습니다: ${p}`); } }
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) { try { return JSON.parse(t); } catch (e) { try { return parseShorthand(t); } catch (e2) { return v; } } }
  if (/^[\w.-]+=/.test(t) && !/^\w+:\/\//.test(t)) { try { return parseShorthand(t); } catch (e) { return v; } }
  return v;
}

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const MULTI_OPTS = new Set([...LIST_PARAMS].map(kebab));
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const values = [];
      if (eq > 0) values.push(a.slice(eq + 1));
      else if (MULTI_OPTS.has(name)) { while (i + 1 < argv.length && !(argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) values.push(argv[++i]); }
      else if (i + 1 < argv.length && !(argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) values.push(argv[++i]);
      if (!values.length) { flags[name] = true; continue; }
      opts[name] = values;
    } else positional.push(a);
  }
  return { positional, opts, flags };
}

function buildParams(service, command, opts, flags) {
  const params = {};
  for (const [k, vals] of Object.entries(opts)) {
    if (['region', 'endpoint-url', 'output', 'query', 'profile'].includes(k)) continue;
    const name = pascal(k);
    const parsed = vals.map(parseValueToken);
    let v = parsed.length > 1 ? parsed : parsed[0];
    if (LIST_PARAMS.has(name) && !Array.isArray(v)) v = [v];
    if (LIST_PARAMS.has(name) && Array.isArray(v) && v.length === 1 && Array.isArray(v[0])) v = v[0];
    params[name] = v;
  }
  for (const [k, on] of Object.entries(flags)) {
    const neg = k.startsWith('no-');
    const name = pascal(neg ? k.slice(3) : k);
    if (['region', 'endpoint-url', 'output', 'yes', 'help', 'debug', 'force', 'recursive'].includes(k)) continue;
    if (/^(MapPublicIpOnLaunch|EnableDnsHostnames|EnableDnsSupport|DisableApiTermination)$/.test(name)) params[name] = { Value: !neg && on };
    else params[name] = !neg && on;
  }
  // ---- AWS CLI 특유의 옵션 이름 → API 파라미터 보정 ----
  if (service === 'ec2') {
    if (params.Cidr) { params.CidrIp = params.Cidr; delete params.Cidr; }
    if (params.Protocol) { params.IpProtocol = params.Protocol; delete params.Protocol; }
    if (params.Port !== undefined) { const [a, b] = String(params.Port).split('-'); params.FromPort = Number(a); params.ToPort = Number(b || a); delete params.Port; }
    if (params.Count) { params.MinCount = params.MaxCount = Number(params.Count); delete params.Count; }
    if (params.Groups && typeof params.Groups === 'string') params.Groups = [params.Groups];
    if (params.Tags && command === 'create-tags') params.Tags = [].concat(params.Tags);
    if (params.Dimensions) params.Dimensions = [].concat(params.Dimensions);
  }
  if (service === 'lambda') {
    if (params.ZipFile !== undefined) { params.Code = { ZipFile: params.ZipFile }; delete params.ZipFile; }
    if (params.Environment && typeof params.Environment === 'object' && !params.Environment.Variables) params.Environment = { Variables: params.Environment };
    if (params.Payload !== undefined && typeof params.Payload !== 'string') params.Payload = JSON.stringify(params.Payload);
  }
  if (service === 'sns') {
    if (params.NotificationEndpoint) { params.Endpoint = params.NotificationEndpoint; delete params.NotificationEndpoint; }
  }
  if (service === 'sqs' || service === 'sns') {
    if (params.Attributes && typeof params.Attributes === 'object') for (const [k, v] of Object.entries(params.Attributes)) if (typeof v !== 'string') params.Attributes[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (service === 'iam' || service === 's3' || service === 's3api') {
    for (const k of ['PolicyDocument', 'AssumeRolePolicyDocument', 'Policy']) if (params[k] && typeof params[k] !== 'string') params[k] = JSON.stringify(params[k]);
  }
  if (service === 'cloudwatch') {
    if (params.Dimensions) params.Dimensions = [].concat(params.Dimensions);
    if (params.Statistics) params.Statistics = [].concat(params.Statistics);
  }
  if (service === 'dynamodb') {
    for (const k of ['AttributeDefinitions', 'KeySchema']) if (params[k]) params[k] = [].concat(params[k]);
    if (params.ProvisionedThroughput && typeof params.ProvisionedThroughput === 'string') params.ProvisionedThroughput = parseShorthand(params.ProvisionedThroughput);
  }
  return params;
}

async function api(service, action, params = {}) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}/api/${service}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-region': REGION }, body: JSON.stringify(params) });
  } catch (e) {
    die(`시뮬레이터 서버(${ENDPOINT})에 연결할 수 없습니다. 먼저 'npm start' 로 서버를 실행하세요.`);
  }
  const body = await res.json();
  if (!res.ok) { const err = new Error(body.message); err.code = body.__type || 'Error'; err.action = action; throw err; }
  return body;
}
function die(msg, code = 252) { console.error(msg); process.exit(code); }
function print(obj) {
  if (obj === undefined || obj === null) return;
  if (OUTPUT === 'json') { const s = JSON.stringify(obj, null, 4); if (s !== '{}') console.log(s); return; }
  if (OUTPUT === 'text') { console.log(toText(obj)); return; }
  console.log(toTable(obj));
}
function toText(obj, prefix = '') {
  if (Array.isArray(obj)) return obj.map((x) => toText(x, prefix)).join('\n');
  if (obj && typeof obj === 'object') { const scalars = Object.entries(obj).filter(([, v]) => v === null || typeof v !== 'object'); const nested = Object.entries(obj).filter(([, v]) => v && typeof v === 'object'); const line = prefix + scalars.map(([, v]) => String(v)).join('\t'); return [line, ...nested.map(([k, v]) => toText(v, k.toUpperCase() + '\t'))].filter(Boolean).join('\n'); }
  return prefix + String(obj);
}
function toTable(obj) {
  // 첫 번째 배열 속성을 표로 출력
  let rows = Array.isArray(obj) ? obj : null;
  if (!rows) for (const v of Object.values(obj)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') { rows = v; break; }
  if (!rows) return JSON.stringify(obj, null, 2);
  if (rows.length && rows[0].Instances) rows = rows.flatMap((r) => r.Instances);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] === null || typeof r[k] !== 'object' || (r[k] && r[k].Name))))].slice(0, 8);
  const cell = (r, c) => { const v = r[c]; return v && typeof v === 'object' ? String(v.Name) : String(v ?? ''); };
  const widths = cols.map((c) => Math.min(40, Math.max(c.length, ...rows.map((r) => cell(r, c).length))));
  const line = (vals) => '| ' + vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join(' | ') + ' |';
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  return [sep, line(cols), sep, ...rows.map((r) => line(cols.map((c) => cell(r, c)))), sep].join('\n');
}
function parseS3Uri(u) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u || '');
  if (!m) die(`S3 URI 형식이 아닙니다: ${u} (예: s3://bucket/key)`);
  return { bucket: m[1], key: m[2] };
}
function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KiB' : n + ' B'; }

// ---- 고수준 s3 명령 ----
async function s3High(cmd, pos, opts, flags) {
  if (cmd === 'ls') {
    if (!pos[0]) { const r = await api('s3', 'ListBuckets'); for (const b of r.Buckets) console.log(`${b.CreationDate.replace('T', ' ').slice(0, 19)} ${b.Name}`); return; }
    const { bucket, key } = parseS3Uri(pos[0]);
    const r = await api('s3', 'ListObjectsV2', { Bucket: bucket, Prefix: key, Delimiter: flags.recursive ? undefined : '/' });
    for (const p of r.CommonPrefixes || []) console.log(`                           PRE ${p.Prefix}`);
    for (const o of r.Contents) console.log(`${o.LastModified.replace('T', ' ').slice(0, 19)} ${String(o.Size).padStart(10)} ${o.Key}`);
    return;
  }
  if (cmd === 'mb') { const { bucket } = parseS3Uri(pos[0]); await api('s3', 'CreateBucket', { Bucket: bucket }); console.log(`make_bucket: ${bucket}`); return; }
  if (cmd === 'rb') {
    const { bucket } = parseS3Uri(pos[0]);
    if (flags.force) { const r = await api('s3', 'ListObjectVersions', { Bucket: bucket }); for (const o of [...r.Versions, ...r.DeleteMarkers]) { await api('s3', 'DeleteObject', { Bucket: bucket, Key: o.Key, VersionId: o.VersionId }); console.log(`delete: s3://${bucket}/${o.Key}`); } }
    await api('s3', 'DeleteBucket', { Bucket: bucket }); console.log(`remove_bucket: ${bucket}`); return;
  }
  if (cmd === 'cp') {
    const [src, dst] = pos;
    if (!src || !dst) die('사용법: awsim s3 cp <로컬파일|s3://...> <s3://...|로컬파일>');
    if (dst.startsWith('s3://')) {
      const { bucket, key } = parseS3Uri(dst);
      let body, name;
      if (src.startsWith('s3://')) { const s = parseS3Uri(src); const o = await api('s3', 'GetObject', { Bucket: s.bucket, Key: s.key }); body = o.Body; name = path.basename(s.key); var enc = o.BodyEncoding; }
      else { if (!fs.existsSync(src)) die(`파일이 없습니다: ${src}`); const buf = fs.readFileSync(src); const isText = /\.(txt|html?|css|js|json|md|csv|xml|svg|py)$/i.test(src); body = isText ? buf.toString('utf8') : buf.toString('base64'); enc = isText ? 'utf8' : 'base64'; name = path.basename(src); }
      const finalKey = !key || key.endsWith('/') ? key + name : key;
      await api('s3', 'PutObject', { Bucket: bucket, Key: finalKey, Body: body, BodyEncoding: enc, ContentType: opts['content-type'] ? opts['content-type'][0] : undefined });
      console.log(`upload: ${src} to s3://${bucket}/${finalKey}`); return;
    }
    const s = parseS3Uri(src);
    const o = await api('s3', 'GetObject', { Bucket: s.bucket, Key: s.key });
    const out = fs.existsSync(dst) && fs.statSync(dst).isDirectory() ? path.join(dst, path.basename(s.key)) : dst;
    fs.writeFileSync(out, o.BodyEncoding === 'base64' ? Buffer.from(o.Body, 'base64') : o.Body);
    console.log(`download: ${src} to ${out}`); return;
  }
  if (cmd === 'rm') { const { bucket, key } = parseS3Uri(pos[0]); if (flags.recursive) { const r = await api('s3', 'ListObjectsV2', { Bucket: bucket, Prefix: key }); for (const o of r.Contents) { await api('s3', 'DeleteObject', { Bucket: bucket, Key: o.Key }); console.log(`delete: s3://${bucket}/${o.Key}`); } return; } await api('s3', 'DeleteObject', { Bucket: bucket, Key: key }); console.log(`delete: s3://${bucket}/${key}`); return; }
  if (cmd === 'website') { const { bucket } = parseS3Uri(pos[0]); await api('s3', 'PutBucketWebsite', { Bucket: bucket, WebsiteConfiguration: { IndexDocument: { Suffix: (opts['index-document'] || ['index.html'])[0] }, ErrorDocument: opts['error-document'] ? { Key: opts['error-document'][0] } : undefined } }); console.log(`website: ${ENDPOINT}/s3-website/${bucket}/`); return; }
  if (cmd === 'presign') { const { bucket, key } = parseS3Uri(pos[0]); console.log(`${ENDPOINT}/s3/${bucket}/${key}`); return; }
  die(`지원하지 않는 s3 명령: ${cmd} (ls, mb, rb, cp, rm, website, presign)`);
}

async function labsCmd(pos) {
  const r = await (await fetch(`${ENDPOINT}/api/labs?region=${REGION}`)).json();
  if (pos[0]) {
    const lab = r.labs.find((l) => l.id === pos[0]);
    if (!lab) die(`실습을 찾을 수 없습니다: ${pos[0]}`);
    console.log(`\n[${lab.service}] ${lab.title}  (레벨 ${lab.level}, 약 ${lab.minutes}분)\n${lab.description}\n`);
    lab.steps.forEach((s, i) => console.log(`  ${s.ok ? '✔' : '○'} ${i + 1}. ${s.label}`));
    console.log('\nCLI 예시:'); for (const c of lab.cli) console.log('  ' + c);
    console.log(lab.done ? `\n완료! (${lab.completedAt})` : '');
    return;
  }
  console.log(`\n실습 진행: ${r.completed}/${r.total} 완료  (리전 ${REGION})\n`);
  for (const l of r.labs) console.log(`  ${l.done ? '✔' : '○'} ${l.id.padEnd(22)} [${l.service.padEnd(10)}] Lv${l.level}  ${Math.round(l.progress * 100).toString().padStart(3)}%  ${l.title}`);
  console.log('\n자세히: awsim labs <id>');
}

function usage() {
  console.log(`awsim — AWS 시뮬레이터 CLI (AWS CLI 문법 호환)

사용법:
  awsim <service> <command> [--option value ...]
  awsim s3 ls|mb|rb|cp|rm|website [s3://...]
  awsim labs [id]                 실습 미션 진행 상황
  awsim help <service>            서비스의 지원 작업 목록
  awsim configure --region <r> [--endpoint-url <url>] [--output json|table|text]
  awsim reset --yes               모든 리소스 초기화

공통 옵션: --region <r>  --endpoint-url <url>  --output json|table|text  --debug
서비스: iam, sts, ec2 (vpc 포함), s3, s3api, lambda, dynamodb, sqs, sns, cloudwatch, logs, billing(ce)

예시:
  awsim ec2 describe-instances --output table
  awsim ec2 run-instances --image-id ami-0c9c942bd7bf113a2 --instance-type t2.micro --count 1
  awsim s3api put-object --bucket my-bucket --key hello.txt --body "hello"
  awsim lambda invoke --function-name hello-lambda --payload '{"name":"AWS"}' out.json
  awsim dynamodb put-item --table-name Orders --item '{"customerId":{"S":"c1"},"orderId":{"S":"o1"}}'
  awsim iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/dev-user --action-names s3:GetObject
값 표기: JSON('{...}'), 짧은 구문(Key=a,Value=b), 파일(file://x.json, fileb://index.js)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, opts, flags } = parseArgs(argv);
  if (opts.region) REGION = opts.region[0];
  if (opts.output) OUTPUT = opts.output[0];
  if (opts['endpoint-url']) ENDPOINT = opts['endpoint-url'][0];
  const [service, command, ...rest] = positional;
  if (!service || flags.help && !command) return usage();
  if (service === 'configure') { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); const c = { ...cfg, region: REGION, endpoint: opts['endpoint-url'] ? opts['endpoint-url'][0] : cfg.endpoint, output: OUTPUT }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); console.log(`저장됨: ${CONFIG_FILE}\n${JSON.stringify(c, null, 2)}`); return; }
  if (service === 'labs') return labsCmd([command, ...rest].filter(Boolean));
  if (service === 'reset') { if (!flags.yes) die('모든 리소스가 삭제됩니다. 확인하려면 --yes 를 붙이세요.'); const r = await (await fetch(`${ENDPOINT}/api/reset`, { method: 'POST' })).json(); console.log(r.message); return; }
  if (service === 'help') { const meta = await (await fetch(`${ENDPOINT}/api/meta`)).json(); const svc = command; if (!svc) { console.log('서비스: ' + Object.keys(meta.Services).join(', ')); return; } if (!meta.Services[svc]) die(`알 수 없는 서비스: ${svc}`); console.log(`${svc} 지원 작업 (${meta.Services[svc].length}개):`); for (const a of meta.Services[svc]) console.log('  ' + a.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()); return; }
  if (!command) die(`사용법: awsim ${service} <command> [옵션]   (목록: awsim help ${service})`);
  if (service === 's3' && ['ls', 'mb', 'rb', 'cp', 'rm', 'website', 'presign', 'sync'].includes(command)) return s3High(command, rest, opts, flags);
  if (service === 'logs' && command === 'tail') { const r = await api('logs', 'FilterLogEvents', { logGroupName: rest[0] || (opts['log-group-name'] || [])[0], limit: 200 }); for (const e of r.events) console.log(`${new Date(e.timestamp).toISOString()} ${e.message}`); return; }
  const action = pascal(command);
  const params = buildParams(service, command, opts, flags);
  if (flags.debug) console.error('→', service, action, JSON.stringify(params));
  try {
    const result = await api(service, action, params);
    if (service === 'lambda' && action === 'Invoke') {
      const outfile = rest[0];
      const payload = typeof result.Payload === 'string' ? result.Payload : JSON.stringify(result.Payload);
      if (outfile) { fs.writeFileSync(outfile, payload); print({ StatusCode: result.StatusCode, FunctionError: result.FunctionError, ExecutedVersion: result.ExecutedVersion }); console.error(`(응답 본문 → ${outfile})`); }
      else print({ StatusCode: result.StatusCode, FunctionError: result.FunctionError, Payload: result.Payload });
      if (flags['log-type'] || (opts['log-type'] && opts['log-type'][0] === 'Tail')) console.error(result.LogResult);
      return;
    }
    if (service === 'ec2' && action === 'CreateKeyPair' && result.KeyMaterial && OUTPUT === 'text') { console.log(result.KeyMaterial); return; }
    if (service === 'ec2' && action === 'GetConsoleOutput' && result.Output) { result.Output = Buffer.from(result.Output, 'base64').toString('utf8'); }
    print(result);
  } catch (e) {
    if (e.code) { console.error(`\nAn error occurred (${e.code}) when calling the ${e.action} operation: ${e.message}`); process.exit(254); }
    throw e;
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
