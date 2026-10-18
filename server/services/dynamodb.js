'use strict';
const store = require('../store');
const { AwsError, now, requireParam, arn } = require('../util');

function S() { return store.get().dynamodb; }

// ---- DynamoDB JSON ↔ 일반 JSON ----
function isDdbJson(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && ['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS'].includes(keys[0]);
}
function unmarshall(v) {
  if (!isDdbJson(v)) return v;
  const t = Object.keys(v)[0], x = v[t];
  switch (t) {
    case 'S': return String(x);
    case 'N': return Number(x);
    case 'BOOL': return !!x;
    case 'NULL': return null;
    case 'L': return x.map(unmarshall);
    case 'M': return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, unmarshall(val)]));
    case 'SS': return x.map(String);
    case 'NS': return x.map(Number);
    default: return x;
  }
}
function unmarshallItem(item) {
  if (!item) return item;
  const out = {};
  for (const [k, v] of Object.entries(item)) out[k] = unmarshall(v);
  return out;
}
function marshall(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(marshall) };
  if (typeof v === 'object') return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, marshall(x)])) };
  return { S: String(v) };
}
function marshallItem(item) { return item ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, marshall(v)])) : item; }
function looksMarshalled(item) { return item && typeof item === 'object' && Object.values(item).length > 0 && Object.values(item).every(isDdbJson); }
function inItem(item) { return looksMarshalled(item) ? unmarshallItem(item) : item; }

function findTable(name) {
  const t = S().tables.find((x) => x.TableName === name);
  if (!t) throw new AwsError('ResourceNotFoundException', `테이블 '${name}' 을(를) 찾을 수 없습니다. (Requested resource not found)`, 404);
  return t;
}
function pubTable(t) {
  const { Items, ...rest } = t;
  return { ...rest, ItemCount: Items.length, TableSizeBytes: JSON.stringify(Items).length };
}
function keyOf(t, item) {
  const k = {};
  for (const ks of t.KeySchema) {
    if (item[ks.AttributeName] === undefined) throw new AwsError('ValidationException', `키 속성 '${ks.AttributeName}' 이(가) 없습니다. 테이블 키 스키마: ${t.KeySchema.map((x) => x.AttributeName + '(' + x.KeyType + ')').join(', ')}`);
    k[ks.AttributeName] = item[ks.AttributeName];
  }
  return k;
}
function sameKey(a, b) { return Object.keys(a).every((k) => String(a[k]) === String(b[k])); }
function checkTypes(t, item) {
  for (const ad of t.AttributeDefinitions) {
    if (item[ad.AttributeName] === undefined) continue;
    const want = { S: 'string', N: 'number', B: 'string' }[ad.AttributeType];
    if (typeof item[ad.AttributeName] !== want) throw new AwsError('ValidationException', `속성 '${ad.AttributeName}' 의 유형이 스키마(${ad.AttributeType})와 다릅니다: One or more parameter values were invalid: Type mismatch for key ${ad.AttributeName}`);
  }
}

// ---- 표현식 파서 (KeyCondition / Filter / Condition) ----
function tokenize(expr) {
  const re = /\s*(\(|\)|,|<>|<=|>=|=|<|>|:[\w.]+|#[\w]+|\b(?:AND|OR|NOT|BETWEEN|IN)\b|[\w.]+)/giy;
  const out = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < expr.length && (m = re.exec(expr))) out.push(m[1]);
  return out;
}
function makeEval(expr, names = {}, values = {}, plain = true) {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const val = (tok) => {
    if (tok.startsWith(':')) { if (!(tok in values)) throw new AwsError('ValidationException', `ExpressionAttributeValues 에 ${tok} 이(가) 없습니다.`); const v = values[tok]; return plain ? v : unmarshall(v); }
    throw new AwsError('ValidationException', `값은 ':이름' 형태의 플레이스홀더여야 합니다: ${tok}`);
  };
  const pathOf = (tok) => tok.split('.').map((seg) => (seg.startsWith('#') ? (names[seg] !== undefined ? names[seg] : (() => { throw new AwsError('ValidationException', `ExpressionAttributeNames 에 ${seg} 이(가) 없습니다.`); })()) : seg));
  const getAttr = (item, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), item);
  function primary() {
    const t = next();
    if (t === '(') { const e = orExpr(); if (next() !== ')') throw new AwsError('ValidationException', '괄호가 닫히지 않았습니다.'); return e; }
    if (/^NOT$/i.test(t)) { const e = primary(); return (item) => !e(item); }
    const fn = /^(begins_with|contains|attribute_exists|attribute_not_exists|attribute_type|size)$/i.exec(t);
    if (fn && peek() === '(') {
      next();
      const a = pathOf(next());
      let b;
      if (peek() === ',') { next(); b = val(next()); }
      if (next() !== ')') throw new AwsError('ValidationException', '함수 호출 괄호 오류');
      const name = fn[1].toLowerCase();
      if (name === 'size') { const sizeFn = (item) => { const v = getAttr(item, a); return v == null ? 0 : (typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(v).length); }; return compareTail(sizeFn); }
      return (item) => {
        const v = getAttr(item, a);
        if (name === 'begins_with') return typeof v === 'string' && v.startsWith(String(b));
        if (name === 'contains') return (typeof v === 'string' && v.includes(String(b))) || (Array.isArray(v) && v.some((x) => x === b));
        if (name === 'attribute_exists') return v !== undefined;
        if (name === 'attribute_not_exists') return v === undefined;
        if (name === 'attribute_type') return ({ S: 'string', N: 'number', BOOL: 'boolean' }[b] === typeof v) || (b === 'L' && Array.isArray(v)) || (b === 'M' && v && typeof v === 'object' && !Array.isArray(v));
        return false;
      };
    }
    const p = pathOf(t);
    return compareTail((item) => getAttr(item, p));
  }
  function compareTail(left) {
    const op = next();
    if (/^BETWEEN$/i.test(op)) { const lo = val(next()); if (!/^AND$/i.test(next())) throw new AwsError('ValidationException', 'BETWEEN a AND b 형식이어야 합니다.'); const hi = val(next()); return (item) => { const v = left(item); return v !== undefined && v >= lo && v <= hi; }; }
    if (/^IN$/i.test(op)) { if (next() !== '(') throw new AwsError('ValidationException', 'IN ( ... ) 형식이어야 합니다.'); const list = []; while (peek() !== ')') { list.push(val(next())); if (peek() === ',') next(); } next(); return (item) => list.some((x) => x === left(item)); }
    const right = val(next());
    const cmp = { '=': (a, b) => a === b, '<>': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b }[op];
    if (!cmp) throw new AwsError('ValidationException', `지원하지 않는 연산자: ${op}`);
    return (item) => { const v = left(item); return v !== undefined && cmp(v, right); };
  }
  function andExpr() { let l = primary(); while (peek() && /^AND$/i.test(peek())) { next(); const r = primary(); const ll = l; l = (item) => ll(item) && r(item); } return l; }
  function orExpr() { let l = andExpr(); while (peek() && /^OR$/i.test(peek())) { next(); const r = andExpr(); const ll = l; l = (item) => ll(item) || r(item); } return l; }
  const fn = orExpr();
  if (i < toks.length) throw new AwsError('ValidationException', `표현식 구문 오류 근처: ${toks.slice(i).join(' ')}`);
  return fn;
}
function applyUpdate(item, expr, names = {}, values = {}, plain = true) {
  const v = (tok) => { if (!(tok in values)) throw new AwsError('ValidationException', `ExpressionAttributeValues 에 ${tok} 이(가) 없습니다.`); return plain ? values[tok] : unmarshall(values[tok]); };
  const n = (tok) => (tok.startsWith('#') ? names[tok] : tok);
  const sections = expr.split(/\b(SET|REMOVE|ADD|DELETE)\b/i).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < sections.length; i += 2) {
    const kw = sections[i].toUpperCase(), body = sections[i + 1] || '';
    const parts = body.split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (kw === 'SET') {
        const m = /^([#\w.]+)\s*=\s*(.+)$/.exec(part);
        if (!m) throw new AwsError('ValidationException', `SET 구문 오류: ${part}`);
        const target = n(m[1]);
        const rhs = m[2].trim();
        let mm;
        if ((mm = /^([#\w.:]+)\s*([+-])\s*([#\w.:]+)$/.exec(rhs))) { const a = mm[1].startsWith(':') ? v(mm[1]) : item[n(mm[1])]; const b = mm[3].startsWith(':') ? v(mm[3]) : item[n(mm[3])]; item[target] = mm[2] === '+' ? Number(a || 0) + Number(b || 0) : Number(a || 0) - Number(b || 0); }
        else if ((mm = /^if_not_exists\(\s*([#\w.]+)\s*,\s*(:[\w]+)\s*\)$/.exec(rhs))) { if (item[n(mm[1])] === undefined) item[target] = v(mm[2]); }
        else if ((mm = /^list_append\(\s*([#\w.:]+)\s*,\s*([#\w.:]+)\s*\)$/.exec(rhs))) { const a = mm[1].startsWith(':') ? v(mm[1]) : item[n(mm[1])] || []; const b = mm[2].startsWith(':') ? v(mm[2]) : item[n(mm[2])] || []; item[target] = [].concat(a, b); }
        else if (rhs.startsWith(':')) item[target] = v(rhs);
        else item[target] = item[n(rhs)];
      } else if (kw === 'REMOVE') delete item[n(part)];
      else if (kw === 'ADD') { const m = /^([#\w.]+)\s+(:[\w]+)$/.exec(part); if (!m) throw new AwsError('ValidationException', `ADD 구문 오류: ${part}`); const t = n(m[1]); const val = v(m[2]); if (Array.isArray(val)) item[t] = [...new Set([...(item[t] || []), ...val])]; else item[t] = Number(item[t] || 0) + Number(val); }
      else if (kw === 'DELETE') { const m = /^([#\w.]+)\s+(:[\w]+)$/.exec(part); if (!m) throw new AwsError('ValidationException', `DELETE 구문 오류: ${part}`); const t = n(m[1]); const val = [].concat(v(m[2])); item[t] = (item[t] || []).filter((x) => !val.includes(x)); }
    }
  }
  return item;
}
function project(item, projection, names = {}) {
  if (!projection) return item;
  const out = {};
  for (const p of projection.split(',').map((s) => s.trim())) { const k = p.startsWith('#') ? names[p] : p; if (item[k] !== undefined) out[k] = item[k]; }
  return out;
}
function out(p, item) { return p._plain ? item : marshallItem(item); }
function valuesOf(p) { const v = p.ExpressionAttributeValues || {}; return v; }
function plainValues(p) { return p._plain || !Object.values(p.ExpressionAttributeValues || {}).every(isDdbJson); }

const actions = {
  CreateTable(p, ctx) {
    const name = requireParam(p, 'TableName');
    if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(name)) throw new AwsError('ValidationException', '테이블 이름은 3~255자의 영숫자, _ . - 만 사용할 수 있습니다.');
    if (S().tables.find((t) => t.TableName === name && t.Region === ctx.region)) throw new AwsError('ResourceInUseException', `테이블 '${name}' 이(가) 이미 존재합니다.`, 409);
    const ks = requireParam(p, 'KeySchema');
    const ad = requireParam(p, 'AttributeDefinitions');
    if (!ks.find((k) => k.KeyType === 'HASH')) throw new AwsError('ValidationException', 'KeySchema 에 HASH(파티션) 키가 필요합니다.');
    if (ks.length > 2) throw new AwsError('ValidationException', 'KeySchema 는 최대 2개(HASH, RANGE)입니다.');
    for (const k of ks) if (!ad.find((a) => a.AttributeName === k.AttributeName)) throw new AwsError('ValidationException', `키 속성 '${k.AttributeName}' 이(가) AttributeDefinitions 에 정의되지 않았습니다.`);
    for (const a of ad) { if (!['S', 'N', 'B'].includes(a.AttributeType)) throw new AwsError('ValidationException', `AttributeType 은 S, N, B 중 하나여야 합니다: ${a.AttributeName}`); const used = ks.some((k) => k.AttributeName === a.AttributeName) || (p.GlobalSecondaryIndexes || []).some((g) => g.KeySchema.some((k) => k.AttributeName === a.AttributeName)); if (!used) throw new AwsError('ValidationException', `AttributeDefinitions 의 '${a.AttributeName}' 이(가) 어떤 키 스키마에도 사용되지 않습니다. (One or more parameter values were invalid: Some AttributeDefinitions are not used)`); }
    const billing = p.BillingMode || 'PROVISIONED';
    if (billing === 'PROVISIONED' && !p.ProvisionedThroughput) throw new AwsError('ValidationException', 'BillingMode 가 PROVISIONED 이면 ProvisionedThroughput(ReadCapacityUnits/WriteCapacityUnits)이 필요합니다. 온디맨드를 원하면 BillingMode=PAY_PER_REQUEST 로 설정하세요.');
    const t = { TableName: name, TableArn: arn('dynamodb', ctx.region, `table/${name}`), TableId: require('crypto').randomUUID(), KeySchema: ks, AttributeDefinitions: ad, BillingModeSummary: { BillingMode: billing }, ProvisionedThroughput: billing === 'PROVISIONED' ? { ReadCapacityUnits: Number(p.ProvisionedThroughput.ReadCapacityUnits), WriteCapacityUnits: Number(p.ProvisionedThroughput.WriteCapacityUnits) } : { ReadCapacityUnits: 0, WriteCapacityUnits: 0 }, TableStatus: 'CREATING', CreationDateTime: now(), GlobalSecondaryIndexes: (p.GlobalSecondaryIndexes || []).map((g) => ({ ...g, IndexStatus: 'ACTIVE', IndexArn: arn('dynamodb', ctx.region, `table/${name}/index/${g.IndexName}`) })), StreamSpecification: p.StreamSpecification, Region: ctx.region, Tags: p.Tags || [], Items: [] };
    S().tables.push(t);
    setTimeout(() => { t.TableStatus = 'ACTIVE'; store.save(); }, 2500);
    return { TableDescription: pubTable(t) };
  },
  ListTables(p, ctx) { return { TableNames: S().tables.filter((t) => t.Region === ctx.region).map((t) => t.TableName) }; },
  DescribeTable(p) { return { Table: pubTable(findTable(requireParam(p, 'TableName'))) }; },
  UpdateTable(p) {
    const t = findTable(requireParam(p, 'TableName'));
    if (p.BillingMode) t.BillingModeSummary = { BillingMode: p.BillingMode };
    if (p.ProvisionedThroughput) t.ProvisionedThroughput = { ReadCapacityUnits: Number(p.ProvisionedThroughput.ReadCapacityUnits), WriteCapacityUnits: Number(p.ProvisionedThroughput.WriteCapacityUnits) };
    return { TableDescription: pubTable(t) };
  },
  DeleteTable(p) {
    const t = findTable(requireParam(p, 'TableName'));
    S().tables = S().tables.filter((x) => x !== t);
    return { TableDescription: { ...pubTable(t), TableStatus: 'DELETING' } };
  },
  PutItem(p) {
    const t = findTable(requireParam(p, 'TableName'));
    if (t.TableStatus !== 'ACTIVE') throw new AwsError('ResourceNotFoundException', `테이블이 아직 ${t.TableStatus} 상태입니다. 잠시 후 다시 시도하세요.`);
    const item = inItem(requireParam(p, 'Item'));
    const key = keyOf(t, item);
    checkTypes(t, item);
    const existing = t.Items.find((x) => sameKey(key, keyOf(t, x)));
    if (p.ConditionExpression) { const ok = makeEval(p.ConditionExpression, p.ExpressionAttributeNames, valuesOf(p), plainValues(p))(existing || {}); if (!ok) throw new AwsError('ConditionalCheckFailedException', 'The conditional request failed'); }
    if (existing) t.Items[t.Items.indexOf(existing)] = item; else t.Items.push(item);
    const r = {};
    if (p.ReturnValues === 'ALL_OLD' && existing) r.Attributes = out(p, existing);
    return r;
  },
  GetItem(p) {
    const t = findTable(requireParam(p, 'TableName'));
    const key = inItem(requireParam(p, 'Key'));
    keyOf(t, key);
    const item = t.Items.find((x) => sameKey(key, keyOf(t, x)));
    return item ? { Item: out(p, project(item, p.ProjectionExpression, p.ExpressionAttributeNames)) } : {};
  },
  DeleteItem(p) {
    const t = findTable(requireParam(p, 'TableName'));
    const key = inItem(requireParam(p, 'Key'));
    keyOf(t, key);
    const item = t.Items.find((x) => sameKey(key, keyOf(t, x)));
    if (p.ConditionExpression) { const ok = makeEval(p.ConditionExpression, p.ExpressionAttributeNames, valuesOf(p), plainValues(p))(item || {}); if (!ok) throw new AwsError('ConditionalCheckFailedException', 'The conditional request failed'); }
    if (item) t.Items = t.Items.filter((x) => x !== item);
    return p.ReturnValues === 'ALL_OLD' && item ? { Attributes: out(p, item) } : {};
  },
  UpdateItem(p) {
    const t = findTable(requireParam(p, 'TableName'));
    const key = inItem(requireParam(p, 'Key'));
    keyOf(t, key);
    let item = t.Items.find((x) => sameKey(key, keyOf(t, x)));
    const plain = plainValues(p);
    if (p.ConditionExpression) { const ok = makeEval(p.ConditionExpression, p.ExpressionAttributeNames, valuesOf(p), plain)(item || {}); if (!ok) throw new AwsError('ConditionalCheckFailedException', 'The conditional request failed'); }
    const old = item ? { ...item } : null;
    if (!item) { item = { ...key }; t.Items.push(item); }
    if (p.UpdateExpression) applyUpdate(item, p.UpdateExpression, p.ExpressionAttributeNames, valuesOf(p), plain);
    for (const k of Object.keys(key)) if (String(item[k]) !== String(key[k])) throw new AwsError('ValidationException', '키 속성은 변경할 수 없습니다.');
    const rv = p.ReturnValues || 'NONE';
    if (rv === 'ALL_NEW' || rv === 'UPDATED_NEW') return { Attributes: out(p, item) };
    if (rv === 'ALL_OLD' && old) return { Attributes: out(p, old) };
    return {};
  },
  Query(p) {
    const t = findTable(requireParam(p, 'TableName'));
    const kce = requireParam(p, 'KeyConditionExpression');
    const plain = plainValues(p);
    let ks = t.KeySchema;
    if (p.IndexName) { const g = (t.GlobalSecondaryIndexes || []).find((x) => x.IndexName === p.IndexName); if (!g) throw new AwsError('ValidationException', `인덱스 ${p.IndexName} 이(가) 없습니다.`); ks = g.KeySchema; }
    const hash = ks.find((k) => k.KeyType === 'HASH').AttributeName;
    const names = p.ExpressionAttributeNames || {};
    const resolved = kce.replace(/#\w+/g, (m) => names[m] || m);
    if (!new RegExp(`(^|[\\s(])${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*:`).test(resolved)) throw new AwsError('ValidationException', `Query 의 KeyConditionExpression 에는 파티션 키(${hash})에 대한 등호(=) 조건이 반드시 있어야 합니다. 현재: ${kce}`);
    if (/\bOR\b/i.test(kce)) throw new AwsError('ValidationException', 'KeyConditionExpression 에는 OR 를 사용할 수 없습니다.');
    const keyFn = makeEval(kce, names, valuesOf(p), plain);
    let items = t.Items.filter(keyFn);
    const range = ks.find((k) => k.KeyType === 'RANGE');
    if (range) items.sort((a, b) => (a[range.AttributeName] > b[range.AttributeName] ? 1 : a[range.AttributeName] < b[range.AttributeName] ? -1 : 0));
    if (p.ScanIndexForward === false) items.reverse();
    const scanned = items.length;
    if (p.FilterExpression) items = items.filter(makeEval(p.FilterExpression, names, valuesOf(p), plain));
    const limit = Number(p.Limit || 0);
    if (limit) items = items.slice(0, limit);
    return { Items: items.map((i) => out(p, project(i, p.ProjectionExpression, names))), Count: items.length, ScannedCount: scanned };
  },
  Scan(p) {
    const t = findTable(requireParam(p, 'TableName'));
    const plain = plainValues(p);
    let items = t.Items.slice();
    const scanned = items.length;
    if (p.FilterExpression) items = items.filter(makeEval(p.FilterExpression, p.ExpressionAttributeNames, valuesOf(p), plain));
    const limit = Number(p.Limit || 0);
    if (limit) items = items.slice(0, limit);
    return { Items: items.map((i) => out(p, project(i, p.ProjectionExpression, p.ExpressionAttributeNames))), Count: items.length, ScannedCount: scanned };
  },
  BatchWriteItem(p) {
    const req = requireParam(p, 'RequestItems');
    for (const [table, ops] of Object.entries(req)) {
      if (ops.length > 25) throw new AwsError('ValidationException', 'BatchWriteItem 은 테이블당 최대 25개 요청까지 가능합니다.');
      for (const op of ops) {
        if (op.PutRequest) actions.PutItem({ TableName: table, Item: op.PutRequest.Item, _plain: p._plain });
        if (op.DeleteRequest) actions.DeleteItem({ TableName: table, Key: op.DeleteRequest.Key, _plain: p._plain });
      }
    }
    return { UnprocessedItems: {} };
  },
  BatchGetItem(p) {
    const req = requireParam(p, 'RequestItems');
    const Responses = {};
    for (const [table, spec] of Object.entries(req)) Responses[table] = (spec.Keys || []).map((k) => actions.GetItem({ TableName: table, Key: k, _plain: p._plain }).Item).filter(Boolean);
    return { Responses, UnprocessedKeys: {} };
  },
  TagResource(p) { const t = S().tables.find((x) => x.TableArn === p.ResourceArn); if (t) t.Tags = p.Tags; return {}; },
};

module.exports = { actions, marshall, unmarshall, marshallItem, unmarshallItem };
