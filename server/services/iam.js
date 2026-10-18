'use strict';
const store = require('../store');
const { ACCOUNT_ID, AwsError, now, hex, globMatch, requireParam } = require('../util');

const MANAGED = [
  { name: 'AdministratorAccess', desc: '모든 AWS 서비스와 리소스에 대한 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } },
  { name: 'PowerUserAccess', desc: 'IAM/조직 관리를 제외한 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', NotAction: ['iam:*', 'organizations:*'], Resource: '*' }, { Effect: 'Allow', Action: ['iam:CreateServiceLinkedRole', 'iam:ListRoles'], Resource: '*' }] } },
  { name: 'ReadOnlyAccess', desc: '모든 리소스 읽기 전용', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['*:Describe*', '*:Get*', '*:List*'], Resource: '*' }] } },
  { name: 'AmazonS3FullAccess', desc: 'S3 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] } },
  { name: 'AmazonS3ReadOnlyAccess', desc: 'S3 읽기 전용', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:Get*', 's3:List*'], Resource: '*' }] } },
  { name: 'AmazonEC2FullAccess', desc: 'EC2 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ec2:*', 'cloudwatch:*'], Resource: '*' }] } },
  { name: 'AmazonEC2ReadOnlyAccess', desc: 'EC2 읽기 전용', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'ec2:Describe*', Resource: '*' }] } },
  { name: 'AmazonDynamoDBFullAccess', desc: 'DynamoDB 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'dynamodb:*', Resource: '*' }] } },
  { name: 'AWSLambdaBasicExecutionRole', desc: 'Lambda가 CloudWatch Logs에 로그를 쓰도록 허용', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' }] } },
  { name: 'AWSLambda_FullAccess', desc: 'Lambda 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['lambda:*', 'logs:*', 'iam:PassRole'], Resource: '*' }] } },
  { name: 'AmazonSQSFullAccess', desc: 'SQS 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sqs:*', Resource: '*' }] } },
  { name: 'AmazonSNSFullAccess', desc: 'SNS 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sns:*', Resource: '*' }] } },
  { name: 'CloudWatchFullAccess', desc: 'CloudWatch 전체 액세스', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['cloudwatch:*', 'logs:*'], Resource: '*' }] } },
];

function S() { return store.get().iam; }

function seed() {
  const iam = S();
  for (const m of MANAGED) {
    if (!iam.policies.find((p) => p.PolicyName === m.name && p.Scope === 'AWS')) {
      iam.policies.push({ PolicyName: m.name, PolicyId: 'ANPA' + hex(17).toUpperCase(), Arn: `arn:aws:iam::aws:policy/${m.name}`, Path: '/', Scope: 'AWS', Description: m.desc, Document: m.doc, AttachmentCount: 0, CreateDate: now(), DefaultVersionId: 'v1' });
    }
  }
}

function parseDoc(doc) {
  if (!doc) throw new AwsError('MalformedPolicyDocument', '정책 문서가 비어 있습니다.');
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (e) { throw new AwsError('MalformedPolicyDocument', 'JSON 구문 오류: ' + e.message); }
  }
  if (!doc.Statement) throw new AwsError('MalformedPolicyDocument', 'Statement 가 필요합니다.');
  if (!Array.isArray(doc.Statement)) doc.Statement = [doc.Statement];
  for (const s of doc.Statement) {
    if (!['Allow', 'Deny'].includes(s.Effect)) throw new AwsError('MalformedPolicyDocument', `Effect 는 Allow 또는 Deny 여야 합니다 (현재: ${s.Effect})`);
    if (!s.Action && !s.NotAction) throw new AwsError('MalformedPolicyDocument', 'Statement 에 Action 이 필요합니다.');
    if (!s.Resource && !s.NotResource && !s.Principal) throw new AwsError('MalformedPolicyDocument', 'Statement 에 Resource 가 필요합니다.');
  }
  return doc;
}

const userArn = (n) => `arn:aws:iam::${ACCOUNT_ID}:user/${n}`;
const roleArn = (n) => `arn:aws:iam::${ACCOUNT_ID}:role/${n}`;
const groupArn = (n) => `arn:aws:iam::${ACCOUNT_ID}:group/${n}`;

function findUser(name) {
  const u = S().users.find((x) => x.UserName === name);
  if (!u) throw new AwsError('NoSuchEntity', `사용자 ${name} 을(를) 찾을 수 없습니다.`, 404);
  return u;
}
function findRole(name) {
  const r = S().roles.find((x) => x.RoleName === name);
  if (!r) throw new AwsError('NoSuchEntity', `역할 ${name} 을(를) 찾을 수 없습니다.`, 404);
  return r;
}
function findGroup(name) {
  const g = S().groups.find((x) => x.GroupName === name);
  if (!g) throw new AwsError('NoSuchEntity', `그룹 ${name} 을(를) 찾을 수 없습니다.`, 404);
  return g;
}
function findPolicy(arn) {
  const p = S().policies.find((x) => x.Arn === arn || x.PolicyName === arn);
  if (!p) throw new AwsError('NoSuchEntity', `정책 ${arn} 을(를) 찾을 수 없습니다.`, 404);
  return p;
}
function pub(u) {
  const { InlinePolicies, ...rest } = u;
  return { ...rest, InlinePolicyNames: (InlinePolicies || []).map((x) => x.PolicyName) };
}

// ---- policy evaluation ----
function matchList(v, test) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.some((p) => globMatch(p, test));
}
function evaluate(docs, action, resource) {
  let allowed = false;
  const matched = [];
  for (const { doc, source } of docs) {
    for (const s of doc.Statement) {
      const actionMatch = s.Action ? matchList(s.Action, action) : !matchList(s.NotAction, action);
      const resMatch = s.Resource ? matchList(s.Resource, resource) : s.NotResource ? !matchList(s.NotResource, resource) : true;
      if (actionMatch && resMatch) {
        matched.push({ SourcePolicyId: source, Sid: s.Sid, Effect: s.Effect });
        if (s.Effect === 'Deny') return { decision: 'explicitDeny', matched };
        allowed = true;
      }
    }
  }
  return { decision: allowed ? 'allowed' : 'implicitDeny', matched };
}
function policiesFor(principalArn) {
  const iam = S();
  const docs = [];
  const addAttached = (list, who) => {
    for (const a of list || []) { const p = iam.policies.find((x) => x.Arn === a); if (p) docs.push({ doc: p.Document, source: `${who} ← ${p.PolicyName}` }); }
  };
  if (principalArn.includes(':user/')) {
    const u = findUser(principalArn.split('/').pop());
    addAttached(u.AttachedPolicies, '사용자');
    for (const ip of u.InlinePolicies || []) docs.push({ doc: ip.Document, source: `인라인 ${ip.PolicyName}` });
    for (const gn of u.Groups || []) { const g = iam.groups.find((x) => x.GroupName === gn); if (g) addAttached(g.AttachedPolicies, `그룹 ${gn}`); }
  } else if (principalArn.includes(':role/')) {
    const r = findRole(principalArn.split('/').pop());
    addAttached(r.AttachedPolicies, '역할');
    for (const ip of r.InlinePolicies || []) docs.push({ doc: ip.Document, source: `인라인 ${ip.PolicyName}` });
  } else throw new AwsError('InvalidInput', 'PolicySourceArn 은 user 또는 role ARN 이어야 합니다.');
  return docs;
}

const actions = {
  // ---- Users ----
  CreateUser(p) {
    const name = requireParam(p, 'UserName');
    if (!/^[\w+=,.@-]{1,64}$/.test(name)) throw new AwsError('ValidationError', '사용자 이름은 영숫자와 +=,.@-_ 만 사용할 수 있습니다.');
    if (S().users.find((u) => u.UserName === name)) throw new AwsError('EntityAlreadyExists', `사용자 ${name} 이(가) 이미 존재합니다.`, 409);
    const u = { Path: p.Path || '/', UserName: name, UserId: 'AIDA' + hex(17).toUpperCase(), Arn: userArn(name), CreateDate: now(), Tags: p.Tags || [], AttachedPolicies: [], InlinePolicies: [], Groups: [] };
    S().users.push(u);
    return { User: pub(u) };
  },
  GetUser(p) { return { User: pub(findUser(requireParam(p, 'UserName'))) }; },
  ListUsers() { return { Users: S().users.map(pub) }; },
  DeleteUser(p) {
    const u = findUser(requireParam(p, 'UserName'));
    if (u.AttachedPolicies.length || u.Groups.length || S().accessKeys.some((k) => k.UserName === u.UserName)) throw new AwsError('DeleteConflict', '정책/그룹/액세스 키가 연결된 사용자는 삭제할 수 없습니다. 먼저 분리하세요.', 409);
    S().users = S().users.filter((x) => x !== u);
    return {};
  },
  CreateAccessKey(p) {
    const u = findUser(requireParam(p, 'UserName'));
    if (S().accessKeys.filter((k) => k.UserName === u.UserName).length >= 2) throw new AwsError('LimitExceeded', '사용자당 액세스 키는 최대 2개입니다.');
    const k = { UserName: u.UserName, AccessKeyId: 'AKIA' + hex(16).toUpperCase(), Status: 'Active', SecretAccessKey: hex(40), CreateDate: now() };
    S().accessKeys.push(k);
    return { AccessKey: k };
  },
  ListAccessKeys(p) { return { AccessKeyMetadata: S().accessKeys.filter((k) => !p.UserName || k.UserName === p.UserName).map(({ SecretAccessKey, ...r }) => r) }; },
  DeleteAccessKey(p) {
    const id = requireParam(p, 'AccessKeyId');
    const before = S().accessKeys.length;
    S().accessKeys = S().accessKeys.filter((k) => k.AccessKeyId !== id);
    if (before === S().accessKeys.length) throw new AwsError('NoSuchEntity', '액세스 키를 찾을 수 없습니다.', 404);
    return {};
  },
  CreateLoginProfile(p) {
    const u = findUser(requireParam(p, 'UserName'));
    requireParam(p, 'Password');
    u.LoginProfile = { CreateDate: now(), PasswordResetRequired: !!p.PasswordResetRequired };
    return { LoginProfile: { UserName: u.UserName, ...u.LoginProfile } };
  },
  // ---- Groups ----
  CreateGroup(p) {
    const name = requireParam(p, 'GroupName');
    if (S().groups.find((g) => g.GroupName === name)) throw new AwsError('EntityAlreadyExists', `그룹 ${name} 이(가) 이미 존재합니다.`, 409);
    const g = { Path: '/', GroupName: name, GroupId: 'AGPA' + hex(17).toUpperCase(), Arn: groupArn(name), CreateDate: now(), AttachedPolicies: [] };
    S().groups.push(g);
    return { Group: g };
  },
  ListGroups() { return { Groups: S().groups.map((g) => ({ ...g, Users: S().users.filter((u) => u.Groups.includes(g.GroupName)).map((u) => u.UserName) })) }; },
  DeleteGroup(p) {
    const g = findGroup(requireParam(p, 'GroupName'));
    if (S().users.some((u) => u.Groups.includes(g.GroupName))) throw new AwsError('DeleteConflict', '사용자가 속한 그룹은 삭제할 수 없습니다.', 409);
    S().groups = S().groups.filter((x) => x !== g);
    return {};
  },
  AddUserToGroup(p) {
    const g = findGroup(requireParam(p, 'GroupName')); const u = findUser(requireParam(p, 'UserName'));
    if (!u.Groups.includes(g.GroupName)) u.Groups.push(g.GroupName);
    return {};
  },
  RemoveUserFromGroup(p) {
    const g = findGroup(requireParam(p, 'GroupName')); const u = findUser(requireParam(p, 'UserName'));
    u.Groups = u.Groups.filter((x) => x !== g.GroupName);
    return {};
  },
  ListGroupsForUser(p) { const u = findUser(requireParam(p, 'UserName')); return { Groups: S().groups.filter((g) => u.Groups.includes(g.GroupName)) }; },
  // ---- Roles ----
  CreateRole(p) {
    const name = requireParam(p, 'RoleName');
    if (S().roles.find((r) => r.RoleName === name)) throw new AwsError('EntityAlreadyExists', `역할 ${name} 이(가) 이미 존재합니다.`, 409);
    const trust = parseDoc(requireParam(p, 'AssumeRolePolicyDocument'));
    const r = { Path: '/', RoleName: name, RoleId: 'AROA' + hex(17).toUpperCase(), Arn: roleArn(name), CreateDate: now(), AssumeRolePolicyDocument: trust, Description: p.Description || '', MaxSessionDuration: p.MaxSessionDuration || 3600, AttachedPolicies: [], InlinePolicies: [], Tags: p.Tags || [] };
    S().roles.push(r);
    return { Role: r };
  },
  GetRole(p) { return { Role: findRole(requireParam(p, 'RoleName')) }; },
  ListRoles() { return { Roles: S().roles }; },
  DeleteRole(p) {
    const r = findRole(requireParam(p, 'RoleName'));
    if (r.AttachedPolicies.length) throw new AwsError('DeleteConflict', '정책이 연결된 역할은 삭제할 수 없습니다.', 409);
    const lambda = store.get().lambda.functions.find((f) => f.Role === r.Arn);
    if (lambda) throw new AwsError('DeleteConflict', `Lambda 함수 ${lambda.FunctionName} 이(가) 이 역할을 사용 중입니다.`, 409);
    S().roles = S().roles.filter((x) => x !== r);
    return {};
  },
  // ---- Policies ----
  CreatePolicy(p) {
    const name = requireParam(p, 'PolicyName');
    if (S().policies.find((x) => x.PolicyName === name && x.Scope === 'Local')) throw new AwsError('EntityAlreadyExists', `정책 ${name} 이(가) 이미 존재합니다.`, 409);
    const doc = parseDoc(requireParam(p, 'PolicyDocument'));
    const pol = { PolicyName: name, PolicyId: 'ANPA' + hex(17).toUpperCase(), Arn: `arn:aws:iam::${ACCOUNT_ID}:policy/${name}`, Path: '/', Scope: 'Local', Description: p.Description || '', Document: doc, AttachmentCount: 0, CreateDate: now(), DefaultVersionId: 'v1' };
    S().policies.push(pol);
    return { Policy: pol };
  },
  GetPolicy(p) { return { Policy: findPolicy(requireParam(p, 'PolicyArn')) }; },
  GetPolicyVersion(p) { const pol = findPolicy(requireParam(p, 'PolicyArn')); return { PolicyVersion: { Document: pol.Document, VersionId: 'v1', IsDefaultVersion: true } }; },
  ListPolicies(p) { return { Policies: S().policies.filter((x) => !p.Scope || p.Scope === 'All' || x.Scope === p.Scope) }; },
  DeletePolicy(p) {
    const pol = findPolicy(requireParam(p, 'PolicyArn'));
    if (pol.Scope === 'AWS') throw new AwsError('InvalidInput', 'AWS 관리형 정책은 삭제할 수 없습니다.');
    if (pol.AttachmentCount > 0) throw new AwsError('DeleteConflict', '연결된 정책은 삭제할 수 없습니다. 먼저 분리하세요.', 409);
    S().policies = S().policies.filter((x) => x !== pol);
    return {};
  },
  AttachUserPolicy(p) { const u = findUser(requireParam(p, 'UserName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (!u.AttachedPolicies.includes(pol.Arn)) { u.AttachedPolicies.push(pol.Arn); pol.AttachmentCount++; } return {}; },
  DetachUserPolicy(p) { const u = findUser(requireParam(p, 'UserName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (u.AttachedPolicies.includes(pol.Arn)) { u.AttachedPolicies = u.AttachedPolicies.filter((a) => a !== pol.Arn); pol.AttachmentCount--; } return {}; },
  AttachRolePolicy(p) { const r = findRole(requireParam(p, 'RoleName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (!r.AttachedPolicies.includes(pol.Arn)) { r.AttachedPolicies.push(pol.Arn); pol.AttachmentCount++; } return {}; },
  DetachRolePolicy(p) { const r = findRole(requireParam(p, 'RoleName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (r.AttachedPolicies.includes(pol.Arn)) { r.AttachedPolicies = r.AttachedPolicies.filter((a) => a !== pol.Arn); pol.AttachmentCount--; } return {}; },
  AttachGroupPolicy(p) { const g = findGroup(requireParam(p, 'GroupName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (!g.AttachedPolicies.includes(pol.Arn)) { g.AttachedPolicies.push(pol.Arn); pol.AttachmentCount++; } return {}; },
  DetachGroupPolicy(p) { const g = findGroup(requireParam(p, 'GroupName')); const pol = findPolicy(requireParam(p, 'PolicyArn')); if (g.AttachedPolicies.includes(pol.Arn)) { g.AttachedPolicies = g.AttachedPolicies.filter((a) => a !== pol.Arn); pol.AttachmentCount--; } return {}; },
  PutUserPolicy(p) { const u = findUser(requireParam(p, 'UserName')); const doc = parseDoc(requireParam(p, 'PolicyDocument')); const name = requireParam(p, 'PolicyName'); u.InlinePolicies = u.InlinePolicies.filter((x) => x.PolicyName !== name); u.InlinePolicies.push({ PolicyName: name, Document: doc }); return {}; },
  PutRolePolicy(p) { const r = findRole(requireParam(p, 'RoleName')); const doc = parseDoc(requireParam(p, 'PolicyDocument')); const name = requireParam(p, 'PolicyName'); r.InlinePolicies = r.InlinePolicies.filter((x) => x.PolicyName !== name); r.InlinePolicies.push({ PolicyName: name, Document: doc }); return {}; },
  GetUserPolicy(p) { const u = findUser(requireParam(p, 'UserName')); const ip = u.InlinePolicies.find((x) => x.PolicyName === p.PolicyName); if (!ip) throw new AwsError('NoSuchEntity', '인라인 정책을 찾을 수 없습니다.', 404); return { UserName: u.UserName, PolicyName: ip.PolicyName, PolicyDocument: ip.Document }; },
  DeleteUserPolicy(p) { const u = findUser(requireParam(p, 'UserName')); u.InlinePolicies = u.InlinePolicies.filter((x) => x.PolicyName !== p.PolicyName); return {}; },
  ListAttachedUserPolicies(p) { const u = findUser(requireParam(p, 'UserName')); return { AttachedPolicies: u.AttachedPolicies.map((a) => ({ PolicyArn: a, PolicyName: a.split('/').pop() })) }; },
  ListAttachedRolePolicies(p) { const r = findRole(requireParam(p, 'RoleName')); return { AttachedPolicies: r.AttachedPolicies.map((a) => ({ PolicyArn: a, PolicyName: a.split('/').pop() })) }; },
  ListAttachedGroupPolicies(p) { const g = findGroup(requireParam(p, 'GroupName')); return { AttachedPolicies: g.AttachedPolicies.map((a) => ({ PolicyArn: a, PolicyName: a.split('/').pop() })) }; },
  ListUserPolicies(p) { const u = findUser(requireParam(p, 'UserName')); return { PolicyNames: u.InlinePolicies.map((x) => x.PolicyName) }; },
  // ---- Simulation ----
  SimulatePrincipalPolicy(p) {
    const src = requireParam(p, 'PolicySourceArn');
    const acts = [].concat(requireParam(p, 'ActionNames'));
    const resources = p.ResourceArns && p.ResourceArns.length ? [].concat(p.ResourceArns) : ['*'];
    const docs = policiesFor(src);
    const EvaluationResults = [];
    for (const a of acts) for (const r of resources) {
      const ev = evaluate(docs, a, r);
      EvaluationResults.push({ EvalActionName: a, EvalResourceName: r, EvalDecision: ev.decision, MatchedStatements: ev.matched });
    }
    return { EvaluationResults };
  },
  GetAccountSummary() {
    const s = S();
    return { SummaryMap: { Users: s.users.length, Groups: s.groups.length, Roles: s.roles.length, Policies: s.policies.filter((x) => x.Scope === 'Local').length, AccessKeysPerUserQuota: 2, UsersQuota: 5000 } };
  },
  GetCallerIdentity() { return { UserId: ACCOUNT_ID, Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:root` }; },
};

// 특정 보안 주체(user/role ARN)가 action 을 resource 에 수행할 수 있는지
function isAllowed(principalArn, action, resource = '*') {
  try { return evaluate(policiesFor(principalArn), action, resource).decision === 'allowed'; } catch (e) { return false; }
}

module.exports = { actions, seed, isAllowed, parseDoc, evaluate, userArn, roleArn };
