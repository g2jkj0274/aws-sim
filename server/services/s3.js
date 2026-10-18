'use strict';
const crypto = require('crypto');
const store = require('../store');
const { AwsError, now, requireParam, hex, globMatch, ACCOUNT_ID } = require('../util');

function S() { return store.get().s3; }

let eventHook = null; // (bucket, eventName, key, objectInfo) => void  — Lambda 트리거 연결용
function setEventHook(fn) { eventHook = fn; }

function validateBucketName(name) {
  if (!name || name.length < 3 || name.length > 63) throw new AwsError('InvalidBucketName', '버킷 이름은 3~63자여야 합니다.');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) throw new AwsError('InvalidBucketName', '버킷 이름은 소문자, 숫자, 점(.), 하이픈(-)만 사용하며 영숫자로 시작/끝나야 합니다. (대문자, 밑줄 불가)');
  if (/\.\./.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name)) throw new AwsError('InvalidBucketName', '버킷 이름은 IP 주소 형식이거나 연속된 점을 포함할 수 없습니다.');
  if (/^(xn--|sthree-)/.test(name) || /-s3alias$/.test(name)) throw new AwsError('InvalidBucketName', '예약된 접두사/접미사는 사용할 수 없습니다.');
}
function findBucket(name) {
  const b = S().buckets.find((x) => x.Name === name);
  if (!b) throw new AwsError('NoSuchBucket', `버킷 '${name}' 이(가) 존재하지 않습니다.`, 404);
  return b;
}
function pubBucket(b) {
  const { Objects, ...rest } = b;
  return { ...rest, ObjectCount: Objects.filter((o) => o.IsLatest && !o.DeleteMarker).length, TotalSize: Objects.filter((o) => o.IsLatest && !o.DeleteMarker).reduce((a, o) => a + o.Size, 0) };
}
function decodeBody(p) {
  if (p.Body === undefined || p.Body === null) return Buffer.alloc(0);
  if (p.BodyEncoding === 'base64' || p.IsBase64) return Buffer.from(String(p.Body), 'base64');
  return Buffer.from(String(p.Body), 'utf8');
}
function guessType(key) {
  const ext = key.split('.').pop().toLowerCase();
  return { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', xml: 'application/xml', pdf: 'application/pdf' }[ext] || 'binary/octet-stream';
}
function latest(b, key) { return b.Objects.find((o) => o.Key === key && o.IsLatest); }
function pubObj(o) { const { Body, ...rest } = o; return rest; }

function isPublicRead(bucket, key) {
  if (bucket.PublicAccessBlock && (bucket.PublicAccessBlock.BlockPublicPolicy || bucket.PublicAccessBlock.RestrictPublicBuckets)) return { allowed: false, reason: '버킷의 퍼블릭 액세스 차단(BlockPublicPolicy/RestrictPublicBuckets)이 활성화되어 있습니다.' };
  const pol = bucket.Policy;
  if (!pol) return { allowed: false, reason: '버킷 정책이 없습니다. s3:GetObject 를 Principal "*" 에 허용하는 버킷 정책을 추가하세요.' };
  const resourceArn = `arn:aws:s3:::${bucket.Name}/${key}`;
  let allowed = false;
  for (const s of pol.Statement) {
    const principalAll = s.Principal === '*' || (s.Principal && s.Principal.AWS === '*');
    if (!principalAll) continue;
    const acts = [].concat(s.Action || []);
    const res = [].concat(s.Resource || []);
    if (acts.some((a) => globMatch(a, 's3:GetObject')) && res.some((r) => globMatch(r, resourceArn))) {
      if (s.Effect === 'Deny') return { allowed: false, reason: '버킷 정책의 Deny 문이 GetObject 를 거부합니다.' };
      allowed = true;
    }
  }
  return allowed ? { allowed: true } : { allowed: false, reason: `버킷 정책에 Principal "*" 에게 s3:GetObject 를 ${resourceArn} 에 허용하는 Allow 문이 없습니다.` };
}

const actions = {
  CreateBucket(p, ctx) {
    const name = requireParam(p, 'Bucket');
    validateBucketName(name);
    if (S().buckets.find((b) => b.Name === name)) throw new AwsError('BucketAlreadyExists', `버킷 이름 '${name}' 은(는) 이미 사용 중입니다. 버킷 이름은 전 세계적으로 고유해야 합니다.`, 409);
    const region = (p.CreateBucketConfiguration && p.CreateBucketConfiguration.LocationConstraint) || ctx.region;
    const b = { Name: name, CreationDate: now(), Region: region, Arn: `arn:aws:s3:::${name}`, Versioning: 'Disabled', PublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }, Policy: null, Website: null, Cors: null, Lifecycle: null, Encryption: { SSEAlgorithm: 'AES256' }, Tags: [], Notifications: [], Objects: [] };
    S().buckets.push(b);
    return { Location: `/${name}`, Bucket: pubBucket(b) };
  },
  ListBuckets() { return { Buckets: S().buckets.map(pubBucket), Owner: { ID: ACCOUNT_ID, DisplayName: 'sim-user' } }; },
  HeadBucket(p) { findBucket(requireParam(p, 'Bucket')); return { BucketRegion: findBucket(p.Bucket).Region }; },
  GetBucketLocation(p) { return { LocationConstraint: findBucket(requireParam(p, 'Bucket')).Region }; },
  DeleteBucket(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    if (b.Objects.length) throw new AwsError('BucketNotEmpty', '비어 있지 않은 버킷은 삭제할 수 없습니다. 먼저 객체(및 모든 버전)를 삭제하세요.', 409);
    S().buckets = S().buckets.filter((x) => x !== b);
    return {};
  },
  PutObject(p, ctx) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const key = requireParam(p, 'Key');
    if (key.length > 1024) throw new AwsError('KeyTooLongError', '객체 키는 1024바이트 이하여야 합니다.');
    const body = decodeBody(p);
    const versioned = b.Versioning === 'Enabled';
    for (const o of b.Objects) if (o.Key === key && o.IsLatest) { if (versioned) o.IsLatest = false; else b.Objects = b.Objects.filter((x) => x !== o); }
    const obj = { Key: key, VersionId: versioned ? hex(32) : 'null', IsLatest: true, Size: body.length, ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"`, LastModified: now(), ContentType: p.ContentType || guessType(key), StorageClass: p.StorageClass || 'STANDARD', Metadata: p.Metadata || {}, Body: body.toString('base64'), Owner: { ID: ACCOUNT_ID } };
    b.Objects.push(obj);
    if (eventHook) eventHook(b, 'ObjectCreated:Put', key, obj, ctx);
    return { ETag: obj.ETag, VersionId: versioned ? obj.VersionId : undefined };
  },
  GetObject(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const key = requireParam(p, 'Key');
    const o = p.VersionId ? b.Objects.find((x) => x.Key === key && x.VersionId === p.VersionId) : latest(b, key);
    if (!o || o.DeleteMarker) throw new AwsError('NoSuchKey', `지정한 키 '${key}' 이(가) 존재하지 않습니다.`, 404);
    const buf = Buffer.from(o.Body, 'base64');
    const isText = /^(text\/|application\/(json|javascript|xml))/.test(o.ContentType);
    return { ...pubObj(o), Body: isText ? buf.toString('utf8') : buf.toString('base64'), BodyEncoding: isText ? 'utf8' : 'base64', ContentLength: o.Size };
  },
  HeadObject(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const o = latest(b, requireParam(p, 'Key'));
    if (!o || o.DeleteMarker) throw new AwsError('NotFound', '객체가 존재하지 않습니다.', 404);
    return { ...pubObj(o), ContentLength: o.Size };
  },
  CopyObject(p) {
    const src = String(requireParam(p, 'CopySource')).replace(/^\//, '');
    const [sb, ...rest] = src.split('/');
    const o = latest(findBucket(sb), decodeURIComponent(rest.join('/')));
    if (!o || o.DeleteMarker) throw new AwsError('NoSuchKey', '원본 객체가 존재하지 않습니다.', 404);
    return actions.PutObject({ Bucket: p.Bucket, Key: p.Key, Body: o.Body, BodyEncoding: 'base64', ContentType: o.ContentType, Metadata: o.Metadata });
  },
  ListObjectsV2(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const prefix = p.Prefix || '';
    const delim = p.Delimiter;
    let objs = b.Objects.filter((o) => o.IsLatest && !o.DeleteMarker && o.Key.startsWith(prefix));
    const Contents = [];
    const prefixes = new Set();
    for (const o of objs) {
      if (delim) {
        const rest = o.Key.slice(prefix.length);
        const idx = rest.indexOf(delim);
        if (idx >= 0) { prefixes.add(prefix + rest.slice(0, idx + 1)); continue; }
      }
      Contents.push({ Key: o.Key, LastModified: o.LastModified, ETag: o.ETag, Size: o.Size, StorageClass: o.StorageClass, ContentType: o.ContentType });
    }
    Contents.sort((a, b2) => a.Key.localeCompare(b2.Key));
    const max = Number(p.MaxKeys || 1000);
    return { Name: b.Name, Prefix: prefix, Delimiter: delim, KeyCount: Math.min(Contents.length, max), MaxKeys: max, IsTruncated: Contents.length > max, Contents: Contents.slice(0, max), CommonPrefixes: [...prefixes].sort().map((Prefix) => ({ Prefix })) };
  },
  ListObjects(p) { return actions.ListObjectsV2(p); },
  ListObjectVersions(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const list = b.Objects.filter((o) => !p.Prefix || o.Key.startsWith(p.Prefix));
    return { Name: b.Name, Versions: list.filter((o) => !o.DeleteMarker).map(pubObj), DeleteMarkers: list.filter((o) => o.DeleteMarker).map(pubObj) };
  },
  DeleteObject(p, ctx) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const key = requireParam(p, 'Key');
    if (p.VersionId) { b.Objects = b.Objects.filter((o) => !(o.Key === key && o.VersionId === p.VersionId)); const rem = b.Objects.filter((o) => o.Key === key); if (rem.length && !rem.some((o) => o.IsLatest)) rem[rem.length - 1].IsLatest = true; return { VersionId: p.VersionId }; }
    if (b.Versioning === 'Enabled') {
      for (const o of b.Objects) if (o.Key === key) o.IsLatest = false;
      const dm = { Key: key, VersionId: hex(32), IsLatest: true, DeleteMarker: true, LastModified: now(), Size: 0 };
      b.Objects.push(dm);
      if (eventHook) eventHook(b, 'ObjectRemoved:DeleteMarkerCreated', key, dm, ctx);
      return { DeleteMarker: true, VersionId: dm.VersionId };
    }
    b.Objects = b.Objects.filter((o) => o.Key !== key);
    if (eventHook) eventHook(b, 'ObjectRemoved:Delete', key, { Key: key }, ctx);
    return {};
  },
  DeleteObjects(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const Deleted = [];
    for (const o of (p.Delete && p.Delete.Objects) || p.Objects || []) { actions.DeleteObject({ Bucket: b.Name, Key: o.Key, VersionId: o.VersionId }); Deleted.push({ Key: o.Key }); }
    return { Deleted, Errors: [] };
  },
  PutBucketVersioning(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const status = (p.VersioningConfiguration && p.VersioningConfiguration.Status) || p.Status;
    if (!['Enabled', 'Suspended'].includes(status)) throw new AwsError('MalformedXML', 'Status 는 Enabled 또는 Suspended 여야 합니다.');
    b.Versioning = status;
    return {};
  },
  GetBucketVersioning(p) { const b = findBucket(requireParam(p, 'Bucket')); return b.Versioning === 'Disabled' ? {} : { Status: b.Versioning }; },
  PutBucketPolicy(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    let pol = requireParam(p, 'Policy');
    if (typeof pol === 'string') { try { pol = JSON.parse(pol); } catch (e) { throw new AwsError('MalformedPolicy', 'JSON 구문 오류: ' + e.message); } }
    if (!pol.Statement) throw new AwsError('MalformedPolicy', 'Statement 가 필요합니다.');
    pol.Statement = [].concat(pol.Statement);
    for (const s of pol.Statement) {
      if (!s.Principal) throw new AwsError('MalformedPolicy', '버킷 정책(리소스 기반 정책)의 각 Statement 에는 Principal 이 필요합니다.');
      for (const r of [].concat(s.Resource || [])) if (!r.startsWith(`arn:aws:s3:::${b.Name}`)) throw new AwsError('MalformedPolicy', `Resource ${r} 은(는) 이 버킷(arn:aws:s3:::${b.Name})의 ARN 이어야 합니다.`);
      const isPublic = s.Principal === '*' || (s.Principal && s.Principal.AWS === '*');
      if (isPublic && s.Effect === 'Allow' && b.PublicAccessBlock.BlockPublicPolicy) throw new AwsError('AccessDenied', '퍼블릭 정책을 차단하는 설정(BlockPublicPolicy)이 켜져 있어 퍼블릭 버킷 정책을 저장할 수 없습니다. 먼저 "퍼블릭 액세스 차단" 설정을 해제하세요.', 403);
    }
    b.Policy = pol;
    return {};
  },
  GetBucketPolicy(p) { const b = findBucket(requireParam(p, 'Bucket')); if (!b.Policy) throw new AwsError('NoSuchBucketPolicy', '버킷 정책이 없습니다.', 404); return { Policy: JSON.stringify(b.Policy) }; },
  DeleteBucketPolicy(p) { findBucket(requireParam(p, 'Bucket')).Policy = null; return {}; },
  PutPublicAccessBlock(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const c = p.PublicAccessBlockConfiguration || p;
    b.PublicAccessBlock = { BlockPublicAcls: !!c.BlockPublicAcls, IgnorePublicAcls: !!c.IgnorePublicAcls, BlockPublicPolicy: !!c.BlockPublicPolicy, RestrictPublicBuckets: !!c.RestrictPublicBuckets };
    return {};
  },
  GetPublicAccessBlock(p) { return { PublicAccessBlockConfiguration: findBucket(requireParam(p, 'Bucket')).PublicAccessBlock }; },
  DeletePublicAccessBlock(p) { findBucket(requireParam(p, 'Bucket')).PublicAccessBlock = { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false }; return {}; },
  PutBucketWebsite(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const c = p.WebsiteConfiguration || p;
    const index = (c.IndexDocument && c.IndexDocument.Suffix) || c.IndexDocument;
    if (!index) throw new AwsError('InvalidArgument', 'IndexDocument.Suffix 가 필요합니다.');
    b.Website = { IndexDocument: { Suffix: index }, ErrorDocument: c.ErrorDocument ? { Key: c.ErrorDocument.Key || c.ErrorDocument } : undefined };
    return {};
  },
  GetBucketWebsite(p) { const b = findBucket(requireParam(p, 'Bucket')); if (!b.Website) throw new AwsError('NoSuchWebsiteConfiguration', '정적 웹 사이트 호스팅이 설정되지 않았습니다.', 404); return b.Website; },
  DeleteBucketWebsite(p) { findBucket(requireParam(p, 'Bucket')).Website = null; return {}; },
  PutBucketTagging(p) { const b = findBucket(requireParam(p, 'Bucket')); b.Tags = (p.Tagging && p.Tagging.TagSet) || p.TagSet || []; return {}; },
  GetBucketTagging(p) { return { TagSet: findBucket(requireParam(p, 'Bucket')).Tags }; },
  PutBucketEncryption(p) { const b = findBucket(requireParam(p, 'Bucket')); const rule = ((p.ServerSideEncryptionConfiguration || {}).Rules || [])[0]; b.Encryption = rule ? rule.ApplyServerSideEncryptionByDefault : { SSEAlgorithm: 'AES256' }; return {}; },
  GetBucketEncryption(p) { return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: findBucket(requireParam(p, 'Bucket')).Encryption }] } }; },
  PutBucketLifecycleConfiguration(p) { const b = findBucket(requireParam(p, 'Bucket')); b.Lifecycle = (p.LifecycleConfiguration && p.LifecycleConfiguration.Rules) || p.Rules || []; return {}; },
  GetBucketLifecycleConfiguration(p) { const b = findBucket(requireParam(p, 'Bucket')); if (!b.Lifecycle) throw new AwsError('NoSuchLifecycleConfiguration', '수명 주기 구성이 없습니다.', 404); return { Rules: b.Lifecycle }; },
  PutBucketCors(p) { const b = findBucket(requireParam(p, 'Bucket')); b.Cors = (p.CORSConfiguration && p.CORSConfiguration.CORSRules) || p.CORSRules || []; return {}; },
  GetBucketCors(p) { const b = findBucket(requireParam(p, 'Bucket')); if (!b.Cors) throw new AwsError('NoSuchCORSConfiguration', 'CORS 구성이 없습니다.', 404); return { CORSRules: b.Cors }; },
  PutBucketNotificationConfiguration(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const c = p.NotificationConfiguration || p;
    const list = [];
    for (const l of c.LambdaFunctionConfigurations || []) {
      const fnArn = l.LambdaFunctionArn;
      const fn = store.get().lambda.functions.find((f) => f.FunctionArn === fnArn || f.FunctionName === fnArn);
      if (!fn) throw new AwsError('InvalidArgument', `Lambda 함수 ${fnArn} 을(를) 찾을 수 없습니다.`);
      list.push({ Id: l.Id || hex(16), Type: 'lambda', Target: fn.FunctionArn, Events: [].concat(l.Events || ['s3:ObjectCreated:*']), Filter: l.Filter });
    }
    for (const q of c.QueueConfigurations || []) list.push({ Id: q.Id || hex(16), Type: 'sqs', Target: q.QueueArn, Events: [].concat(q.Events || ['s3:ObjectCreated:*']), Filter: q.Filter });
    for (const t of c.TopicConfigurations || []) list.push({ Id: t.Id || hex(16), Type: 'sns', Target: t.TopicArn, Events: [].concat(t.Events || ['s3:ObjectCreated:*']), Filter: t.Filter });
    b.Notifications = list;
    return {};
  },
  GetBucketNotificationConfiguration(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    return {
      LambdaFunctionConfigurations: b.Notifications.filter((n) => n.Type === 'lambda').map((n) => ({ Id: n.Id, LambdaFunctionArn: n.Target, Events: n.Events, Filter: n.Filter })),
      QueueConfigurations: b.Notifications.filter((n) => n.Type === 'sqs').map((n) => ({ Id: n.Id, QueueArn: n.Target, Events: n.Events })),
      TopicConfigurations: b.Notifications.filter((n) => n.Type === 'sns').map((n) => ({ Id: n.Id, TopicArn: n.Target, Events: n.Events })),
    };
  },
  CheckPublicAccess(p) {
    const b = findBucket(requireParam(p, 'Bucket'));
    const key = p.Key || (b.Website ? b.Website.IndexDocument.Suffix : 'index.html');
    const r = isPublicRead(b, key);
    return { Bucket: b.Name, Key: key, Public: r.allowed, Reason: r.reason, ObjectExists: !!latest(b, key), ObjectUrl: `/s3/${b.Name}/${key}`, WebsiteUrl: b.Website ? `/s3-website/${b.Name}/` : null };
  },
};

// HTTP 직접 접근(퍼블릭 객체/정적 웹 사이트)용
function serveObject(bucketName, key, website) {
  const b = S().buckets.find((x) => x.Name === bucketName);
  if (!b) return { status: 404, type: 'application/xml', body: `<Error><Code>NoSuchBucket</Code><Message>버킷이 존재하지 않습니다: ${bucketName}</Message></Error>` };
  if (website) {
    if (!b.Website) return { status: 404, type: 'text/html; charset=utf-8', body: `<h1>404 Not Found</h1><p>버킷 <b>${bucketName}</b> 에 정적 웹 사이트 호스팅이 설정되지 않았습니다. (PutBucketWebsite)</p>` };
    if (!key || key.endsWith('/')) key = (key || '') + b.Website.IndexDocument.Suffix;
  }
  const r = isPublicRead(b, key);
  if (!r.allowed) return { status: 403, type: website ? 'text/html; charset=utf-8' : 'application/xml', body: website ? `<h1>403 Forbidden</h1><p>${r.reason}</p>` : `<Error><Code>AccessDenied</Code><Message>${r.reason}</Message></Error>` };
  const o = latest(b, key);
  if (!o || o.DeleteMarker) {
    if (website && b.Website.ErrorDocument) { const e = latest(b, b.Website.ErrorDocument.Key); if (e) return { status: 404, type: e.ContentType, body: Buffer.from(e.Body, 'base64') }; }
    return { status: 404, type: website ? 'text/html; charset=utf-8' : 'application/xml', body: website ? `<h1>404 Not Found</h1><p>객체 ${key} 이(가) 없습니다.</p>` : `<Error><Code>NoSuchKey</Code><Message>${key}</Message></Error>` };
  }
  return { status: 200, type: o.ContentType, body: Buffer.from(o.Body, 'base64') };
}

module.exports = { actions, serveObject, setEventHook, findBucket, isPublicRead };
