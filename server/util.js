'use strict';
const crypto = require('crypto');

const ACCOUNT_ID = '123456789012';
const REGIONS = [
  { id: 'us-east-1', name: '미국 동부(버지니아 북부)' },
  { id: 'us-west-2', name: '미국 서부(오레곤)' },
  { id: 'ap-northeast-2', name: '아시아 태평양(서울)' },
  { id: 'ap-northeast-1', name: '아시아 태평양(도쿄)' },
  { id: 'eu-west-1', name: '유럽(아일랜드)' },
];
const DEFAULT_REGION = 'ap-northeast-2';

class AwsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function hex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}
function id(prefix, len = 17) {
  return `${prefix}-0${hex(len - 1)}`;
}
function uuid() {
  return crypto.randomUUID();
}
function now() {
  return new Date().toISOString();
}
function arn(service, region, resource, account = ACCOUNT_ID) {
  return `arn:aws:${service}:${region}:${account}:${resource}`;
}
function azs(region) {
  return ['a', 'b', 'c'].map((s) => region + s);
}
function requireParam(params, name) {
  if (params[name] === undefined || params[name] === null || params[name] === '') {
    throw new AwsError('ValidationError', `필수 파라미터가 없습니다: ${name}`);
  }
  return params[name];
}
function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
function globMatch(pattern, value) {
  const re = new RegExp('^' + String(pattern).split('*').map((s) => escapeRe(s).replace(/\?/g, '.')).join('.*') + '$', 'i');
  return re.test(value);
}
// CIDR helpers
function ipToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function parseCidr(cidr) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(cidr || '').trim());
  if (!m) throw new AwsError('InvalidParameterValue', `잘못된 CIDR 블록입니다: ${cidr} (예: 10.0.0.0/16)`);
  if (m[1].split('.').some((o) => Number(o) > 255)) throw new AwsError('InvalidParameterValue', `잘못된 IP 주소입니다: ${m[1]}`);
  const bits = Number(m[2]);
  if (bits < 0 || bits > 32) throw new AwsError('InvalidParameterValue', `잘못된 프리픽스 길이입니다: /${bits}`);
  const base = ipToInt(m[1]);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits, mask, size: 2 ** (32 - bits) };
}
function cidrContains(outer, inner) {
  const o = parseCidr(outer), i = parseCidr(inner);
  return i.bits >= o.bits && ((i.base & o.mask) >>> 0) === o.base;
}
function cidrOverlap(a, b) {
  const x = parseCidr(a), y = parseCidr(b);
  const bits = Math.min(x.bits, y.bits);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((x.base & mask) >>> 0) === ((y.base & mask) >>> 0);
}
function tagsFromSpec(params, resourceType) {
  const specs = params.TagSpecifications || [];
  const tags = [];
  for (const s of specs) if (!s.ResourceType || s.ResourceType === resourceType) tags.push(...(s.Tags || []));
  if (params.Tags) tags.push(...params.Tags);
  return tags.map((t) => ({ Key: t.Key, Value: String(t.Value ?? '') }));
}
function nameOf(res) {
  const t = (res.Tags || []).find((x) => x.Key === 'Name');
  return t ? t.Value : '';
}
function applyFilters(list, filters) {
  if (!filters || !filters.length) return list;
  return list.filter((item) =>
    filters.every((f) => {
      const vals = [].concat(f.Values || []);
      if (f.Name.startsWith('tag:')) {
        const k = f.Name.slice(4);
        const tag = (item.Tags || []).find((t) => t.Key === k);
        return tag && vals.some((v) => globMatch(v, tag.Value));
      }
      const key = f.Name.split('.').map((s) => s.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())).join('.');
      const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), item);
      const actual = v && typeof v === 'object' && v.Name ? v.Name : v;
      return vals.some((x) => globMatch(x, String(actual)));
    })
  );
}
module.exports = { ACCOUNT_ID, REGIONS, DEFAULT_REGION, AwsError, hex, id, uuid, now, arn, azs, requireParam, globMatch, parseCidr, cidrContains, cidrOverlap, intToIp, ipToInt, tagsFromSpec, nameOf, applyFilters };
