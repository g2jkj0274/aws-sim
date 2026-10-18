/* IAM / VPC / EC2 페이지 */
(function () {
  'use strict';
  const { h, api, table, badge, stateBadge, tabs, card, kv, breadcrumb, fmtDate, nameTag, modal, confirm, toast, cli } = App;
  const ACCOUNT = () => App.meta.AccountId;
  const TRUST = (svc) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: svc }, Action: 'sts:AssumeRole' }] });
  const POLICY_TEMPLATES = {
    '': null,
    'S3 특정 버킷 읽기/쓰기': { Version: '2012-10-17', Statement: [{ Sid: 'ListBucket', Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::team-data' }, { Sid: 'ReadWrite', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::team-data/*' }] },
    'S3 읽기 + 삭제 명시적 거부': { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::team-data', 'arn:aws:s3:::team-data/*'] }, { Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' }] },
    'EC2 조회 전용': { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ec2:Describe*'], Resource: '*' }] },
    'EC2 시작/중지 (특정 태그)': { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ec2:StartInstances', 'ec2:StopInstances'], Resource: `arn:aws:ec2:*:${'123456789012'}:instance/*` }, { Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' }] },
    'DynamoDB 한 테이블 전체': { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'dynamodb:*', Resource: 'arn:aws:dynamodb:*:123456789012:table/Orders' }] },
    'Lambda 기본 실행 (로그)': { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' }] },
  };

  // =====================================================================
  // IAM
  // =====================================================================
  App.register('iam', async ([tab = 'users', id, sub]) => {
    const base = '#/iam';
    const T = tabs([{ id: 'users', label: '사용자' }, { id: 'groups', label: '사용자 그룹' }, { id: 'roles', label: '역할' }, { id: 'policies', label: '정책' }, { id: 'simulator', label: '정책 시뮬레이터' }], tab, base);
    const head = h('div', null, h('h1', null, 'IAM (Identity and Access Management) ', h('span', { class: 'muted small' }, '글로벌 서비스')), T);
    if (tab === 'users' && id) return userDetail(id, sub);
    if (tab === 'groups' && id) return groupDetail(id);
    if (tab === 'roles' && id) return roleDetail(id);
    if (tab === 'policies' && id) return policyDetail(id);
    if (tab === 'users') {
      const { Users } = await api('iam', 'ListUsers');
      const keys = (await api('iam', 'ListAccessKeys', {})).AccessKeyMetadata;
      return h('div', null, head, card(h('h2', null, '사용자 ', h('span', { class: 'count' }, `(${Users.length})`)), table({
        columns: [{ label: '사용자 이름', render: (u) => h('a', { href: `${base}/users/${u.UserName}` }, u.UserName) }, { label: '그룹', render: (u) => u.Groups.join(', ') || '-' }, { label: '연결된 정책', render: (u) => u.AttachedPolicies.length + (u.InlinePolicyNames.length ? ` (+인라인 ${u.InlinePolicyNames.length})` : '') }, { label: '액세스 키', render: (u) => keys.filter((k) => k.UserName === u.UserName).length }, { label: '콘솔 액세스', render: (u) => (u.LoginProfile ? badge('활성', 'green') : badge('없음', 'grey')) }, { label: '생성일', render: (u) => fmtDate(u.CreateDate) }],
        rows: Users, onRow: (u) => App.navigate(`${base}/users/${u.UserName}`),
      }), [h('button', { class: 'primary', onclick: createUser }, '사용자 생성')]), cli('awsim iam create-user --user-name dev-user'));
    }
    if (tab === 'groups') {
      const { Groups } = await api('iam', 'ListGroups');
      return h('div', null, head, card(h('h2', null, '사용자 그룹 ', h('span', { class: 'count' }, `(${Groups.length})`)), table({ columns: [{ label: '그룹 이름', render: (g) => h('a', { href: `${base}/groups/${g.GroupName}` }, g.GroupName) }, { label: '사용자', render: (g) => g.Users.join(', ') || '-' }, { label: '연결된 정책', render: (g) => g.AttachedPolicies.map((a) => a.split('/').pop()).join(', ') || '-' }, { label: '생성일', render: (g) => fmtDate(g.CreateDate) }], rows: Groups, onRow: (g) => App.navigate(`${base}/groups/${g.GroupName}`) }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '사용자 그룹 생성', fields: [{ name: 'GroupName', label: '그룹 이름', required: true, placeholder: 'developers' }], onSubmit: async (v) => { await api('iam', 'CreateGroup', v); toast('그룹을 만들었습니다.', 'success'); App.refresh(); } }) }, '그룹 생성')]), cli('awsim iam create-group --group-name developers'));
    }
    if (tab === 'roles') {
      const { Roles } = await api('iam', 'ListRoles');
      const trusted = (r) => r.AssumeRolePolicyDocument.Statement.map((s) => (s.Principal && (s.Principal.Service || s.Principal.AWS)) || '?').flat().join(', ');
      return h('div', null, head, card(h('h2', null, '역할 ', h('span', { class: 'count' }, `(${Roles.length})`)), table({ columns: [{ label: '역할 이름', render: (r) => h('a', { href: `${base}/roles/${r.RoleName}` }, r.RoleName) }, { label: '신뢰할 수 있는 엔터티', render: trusted }, { label: '연결된 정책', render: (r) => r.AttachedPolicies.map((a) => a.split('/').pop()).join(', ') || '-' }, { label: '생성일', render: (r) => fmtDate(r.CreateDate) }], rows: Roles, onRow: (r) => App.navigate(`${base}/roles/${r.RoleName}`) }), [h('button', { class: 'primary', onclick: createRole }, '역할 생성')]), cli('awsim iam create-role --role-name lambda-exec --assume-role-policy-document file://trust.json'));
    }
    if (tab === 'policies') {
      const { Policies } = await api('iam', 'ListPolicies');
      const filter = h('select', { onchange: () => draw() }, h('option', { value: 'All' }, '모든 정책'), h('option', { value: 'Local' }, '고객 관리형'), h('option', { value: 'AWS' }, 'AWS 관리형'));
      const box = h('div');
      const draw = () => { box.innerHTML = ''; box.appendChild(table({ columns: [{ label: '정책 이름', render: (p) => h('a', { href: `${base}/policies/${encodeURIComponent(p.Arn)}` }, p.PolicyName) }, { label: '유형', render: (p) => (p.Scope === 'AWS' ? badge('AWS 관리형', 'blue') : badge('고객 관리형', 'green')) }, { label: '연결 수', key: 'AttachmentCount' }, { label: '설명', key: 'Description' }], rows: Policies.filter((p) => filter.value === 'All' || p.Scope === filter.value), onRow: (p) => App.navigate(`${base}/policies/${encodeURIComponent(p.Arn)}`) })); };
      draw();
      return h('div', null, head, card(h('h2', null, '정책 ', h('span', { class: 'count' }, `(${Policies.length})`)), [h('div', { class: 'filterbar' }, filter), box], [h('button', { class: 'primary', onclick: createPolicy }, '정책 생성')]), cli("awsim iam create-policy --policy-name team-data-writer --policy-document '{...}'"));
    }
    if (tab === 'simulator') return h('div', null, head, await simulator(id));
    return head;
  });

  async function createUser() {
    const { Policies } = await api('iam', 'ListPolicies');
    const { Groups } = await api('iam', 'ListGroups');
    return modal({ title: '사용자 생성', fields: [
      { name: 'UserName', label: '사용자 이름', required: true, placeholder: 'dev-user', hint: '영숫자, +=,.@-_ 최대 64자' },
      { name: 'console', label: 'AWS Management Console 액세스 제공 (콘솔 암호 생성)', type: 'checkbox' },
      { name: 'group', label: '사용자 그룹에 추가', type: 'select', options: [['', '(없음)'], ...Groups.map((g) => g.GroupName)] },
      { name: 'policies', label: '직접 정책 연결', type: 'multiselect', options: Policies.map((p) => [p.Arn, `${p.PolicyName} ${p.Scope === 'AWS' ? '(AWS 관리형)' : ''}`]) },
    ], onSubmit: async (v) => {
      await api('iam', 'CreateUser', { UserName: v.UserName });
      if (v.console) await api('iam', 'CreateLoginProfile', { UserName: v.UserName, Password: 'Temp#' + Math.random().toString(36).slice(2, 8), PasswordResetRequired: true });
      if (v.group) await api('iam', 'AddUserToGroup', { GroupName: v.group, UserName: v.UserName });
      for (const p of v.policies) await api('iam', 'AttachUserPolicy', { UserName: v.UserName, PolicyArn: p });
      toast('사용자를 만들었습니다.', 'success'); App.navigate(`#/iam/users/${v.UserName}`);
    } });
  }
  async function userDetail(name, sub = 'permissions') {
    const { User } = await api('iam', 'GetUser', { UserName: name });
    const { Policies } = await api('iam', 'ListPolicies');
    const { Groups } = await api('iam', 'ListGroups');
    const keys = (await api('iam', 'ListAccessKeys', { UserName: name })).AccessKeyMetadata;
    const base = `#/iam/users/${name}`;
    const attachBtn = h('button', { onclick: () => modal({ title: '정책 연결', fields: [{ name: 'policies', label: '정책 선택', type: 'multiselect', options: Policies.filter((p) => !User.AttachedPolicies.includes(p.Arn)).map((p) => [p.Arn, `${p.PolicyName} ${p.Scope === 'AWS' ? '(AWS 관리형)' : ''}`]) }], submitLabel: '연결', onSubmit: async (v) => { for (const p of v.policies) await api('iam', 'AttachUserPolicy', { UserName: name, PolicyArn: p }); App.refresh(); } }) }, '정책 연결');
    const inlineBtn = h('button', { onclick: () => modal({ title: '인라인 정책 추가', wide: true, fields: [{ name: 'PolicyName', label: '정책 이름', required: true }, { name: 'tpl', label: '템플릿', type: 'select', options: Object.keys(POLICY_TEMPLATES).map((k) => [k, k || '(직접 작성)']), onChange: (v) => { const ta = document.querySelector('[data-field=PolicyDocument] textarea'); if (POLICY_TEMPLATES[v]) ta.value = JSON.stringify(POLICY_TEMPLATES[v], null, 2); } }, { name: 'PolicyDocument', label: '정책 문서 (JSON)', type: 'json', rows: 14, value: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:ListBucket'], Resource: '*' }] } }], onSubmit: async (v) => { await api('iam', 'PutUserPolicy', { UserName: name, PolicyName: v.PolicyName, PolicyDocument: v.PolicyDocument }); App.refresh(); } }) }, '인라인 정책 추가');
    const sections = {
      permissions: card('권한 정책', [
        table({ columns: [{ label: '정책 이름', render: (a) => h('a', { href: `#/iam/policies/${encodeURIComponent(a)}` }, a.split('/').pop()) }, { label: '유형', render: (a) => (a.includes('::aws:') ? 'AWS 관리형' : '고객 관리형') }, { label: '', render: (a) => h('button', { class: 'sm', onclick: async () => { await api('iam', 'DetachUserPolicy', { UserName: name, PolicyArn: a }); App.refresh(); } }, '분리') }], rows: User.AttachedPolicies, empty: '연결된 정책이 없습니다. (아무 권한도 없음 = 암시적 거부)' }),
        User.InlinePolicyNames.length ? [h('h3', null, '인라인 정책'), table({ columns: [{ label: '이름', render: (n) => n }, { label: '', render: (n) => h('span', null, h('button', { class: 'sm', onclick: async () => { const r = await api('iam', 'GetUserPolicy', { UserName: name, PolicyName: n }); App.showJson(n, r.PolicyDocument); } }, '보기'), ' ', h('button', { class: 'sm danger', onclick: async () => { await api('iam', 'DeleteUserPolicy', { UserName: name, PolicyName: n }); App.refresh(); } }, '삭제')) }], rows: User.InlinePolicyNames })] : null,
        h('h3', null, '그룹을 통해 상속된 정책'), table({ columns: [{ label: '그룹', render: (g) => h('a', { href: `#/iam/groups/${g.GroupName}` }, g.GroupName) }, { label: '정책', render: (g) => g.AttachedPolicies.map((a) => a.split('/').pop()).join(', ') || '-' }], rows: Groups.filter((g) => User.Groups.includes(g.GroupName)), empty: '속한 그룹이 없습니다.' }),
      ], [attachBtn, inlineBtn, h('a', { class: 'btn', href: `#/iam/simulator/${encodeURIComponent(User.Arn)}` }, '권한 시뮬레이션')]),
      groups: card('그룹', table({ columns: [{ label: '그룹', render: (g) => h('a', { href: `#/iam/groups/${g}` }, g) }, { label: '', render: (g) => h('button', { class: 'sm', onclick: async () => { await api('iam', 'RemoveUserFromGroup', { GroupName: g, UserName: name }); App.refresh(); } }, '제거') }], rows: User.Groups, empty: '속한 그룹이 없습니다.' }), [h('button', { onclick: () => modal({ title: '그룹에 추가', fields: [{ name: 'g', label: '그룹', type: 'select', options: Groups.filter((g) => !User.Groups.includes(g.GroupName)).map((g) => g.GroupName) }], submitLabel: '추가', onSubmit: async (v) => { await api('iam', 'AddUserToGroup', { GroupName: v.g, UserName: name }); App.refresh(); } }) }, '그룹에 추가')]),
      credentials: card('보안 자격 증명', [
        h('h3', null, '액세스 키 (프로그래밍 방식 액세스)'),
        table({ columns: [{ key: 'AccessKeyId', label: '액세스 키 ID' }, { key: 'Status', label: '상태' }, { label: '생성일', render: (k) => fmtDate(k.CreateDate) }, { label: '', render: (k) => h('button', { class: 'sm danger', onclick: async () => { await api('iam', 'DeleteAccessKey', { UserName: name, AccessKeyId: k.AccessKeyId }); App.refresh(); } }, '삭제') }], rows: keys, empty: '액세스 키가 없습니다.' }),
        h('div', { class: 'btn-row', style: { marginTop: '8px' } }, h('button', { class: 'primary', onclick: async () => { const r = await api('iam', 'CreateAccessKey', { UserName: name }); await modal({ title: '액세스 키 생성됨 — 비밀 키는 지금만 볼 수 있습니다', body: h('div', null, h('div', { class: 'alert warn' }, '실제 AWS 에서는 이 화면을 닫으면 비밀 액세스 키를 다시 볼 수 없습니다. 안전한 곳에 보관하세요.'), kv([['액세스 키 ID', r.AccessKey.AccessKeyId], ['비밀 액세스 키', h('code', null, r.AccessKey.SecretAccessKey)]])) }); App.refresh(); } }, '액세스 키 만들기')),
        h('h3', null, '콘솔 로그인'), User.LoginProfile ? h('p', null, badge('활성', 'green'), ' 콘솔 암호가 설정되어 있습니다.') : h('p', null, badge('없음', 'grey'), ' ', h('button', { class: 'link', onclick: async () => { await api('iam', 'CreateLoginProfile', { UserName: name, Password: 'Temp#1234' }); App.refresh(); } }, '콘솔 암호 설정')),
      ]),
    };
    return h('div', null, breadcrumb(['IAM', '#/iam'], ['사용자', '#/iam/users'], name),
      h('h1', null, name, ' ', h('button', { class: 'danger', style: { float: 'right' }, onclick: async () => { if (await confirm(`사용자 ${name} 을(를) 삭제할까요? (정책/그룹/키를 먼저 분리해야 합니다)`)) { await api('iam', 'DeleteUser', { UserName: name }); App.navigate('#/iam/users'); } } }, '사용자 삭제')),
      card('요약', kv([['ARN', h('span', null, User.Arn, ' ', App.copyBtn(User.Arn))], ['사용자 ID', User.UserId], ['생성일', fmtDate(User.CreateDate)], ['경로', User.Path]])),
      tabs([{ id: 'permissions', label: '권한' }, { id: 'groups', label: '그룹' }, { id: 'credentials', label: '보안 자격 증명' }], sub, base), sections[sub] || sections.permissions);
  }
  async function groupDetail(name) {
    const { Groups } = await api('iam', 'ListGroups');
    const g = Groups.find((x) => x.GroupName === name);
    if (!g) return h('div', null, '그룹이 없습니다.');
    const { Policies } = await api('iam', 'ListPolicies');
    const { Users } = await api('iam', 'ListUsers');
    return h('div', null, breadcrumb(['IAM', '#/iam'], ['사용자 그룹', '#/iam/groups'], name), h('h1', null, name, ' ', h('button', { class: 'danger', style: { float: 'right' }, onclick: async () => { if (await confirm('그룹을 삭제할까요?')) { await api('iam', 'DeleteGroup', { GroupName: name }); App.navigate('#/iam/groups'); } } }, '그룹 삭제')),
      card('요약', kv([['ARN', g.Arn], ['생성일', fmtDate(g.CreateDate)]])),
      card('사용자', table({ columns: [{ label: '사용자', render: (u) => h('a', { href: `#/iam/users/${u}` }, u) }, { label: '', render: (u) => h('button', { class: 'sm', onclick: async () => { await api('iam', 'RemoveUserFromGroup', { GroupName: name, UserName: u }); App.refresh(); } }, '제거') }], rows: g.Users, empty: '사용자가 없습니다.' }), [h('button', { onclick: () => modal({ title: '사용자 추가', fields: [{ name: 'u', label: '사용자', type: 'select', options: Users.filter((u) => !g.Users.includes(u.UserName)).map((u) => u.UserName) }], submitLabel: '추가', onSubmit: async (v) => { await api('iam', 'AddUserToGroup', { GroupName: name, UserName: v.u }); App.refresh(); } }) }, '사용자 추가')]),
      card('권한 정책', table({ columns: [{ label: '정책', render: (a) => h('a', { href: `#/iam/policies/${encodeURIComponent(a)}` }, a.split('/').pop()) }, { label: '', render: (a) => h('button', { class: 'sm', onclick: async () => { await api('iam', 'DetachGroupPolicy', { GroupName: name, PolicyArn: a }); App.refresh(); } }, '분리') }], rows: g.AttachedPolicies, empty: '연결된 정책이 없습니다.' }), [h('button', { onclick: () => modal({ title: '정책 연결', fields: [{ name: 'p', label: '정책', type: 'multiselect', options: Policies.filter((p) => !g.AttachedPolicies.includes(p.Arn)).map((p) => [p.Arn, p.PolicyName]) }], submitLabel: '연결', onSubmit: async (v) => { for (const p of v.p) await api('iam', 'AttachGroupPolicy', { GroupName: name, PolicyArn: p }); App.refresh(); } }) }, '정책 연결')]));
  }
  async function createRole() {
    const { Policies } = await api('iam', 'ListPolicies');
    return modal({ title: '역할 생성', wide: true, fields: [
      { name: 'RoleName', label: '역할 이름', required: true, placeholder: 'lambda-exec' },
      { name: 'trust', label: '신뢰할 수 있는 엔터티 유형', type: 'select', options: [['lambda.amazonaws.com', 'AWS 서비스: Lambda'], ['ec2.amazonaws.com', 'AWS 서비스: EC2'], ['states.amazonaws.com', 'AWS 서비스: Step Functions'], ['custom', '사용자 지정 신뢰 정책 (아래 JSON)']], onChange: (v) => { const ta = document.querySelector('[data-field=doc] textarea'); if (v !== 'custom') ta.value = JSON.stringify(TRUST(v), null, 2); } },
      { name: 'doc', label: '신뢰 정책 (AssumeRolePolicyDocument)', type: 'json', rows: 10, value: TRUST('lambda.amazonaws.com'), hint: '누가 이 역할을 "맡을(assume)" 수 있는지 정의합니다. Lambda 함수에 쓰려면 Principal.Service 가 lambda.amazonaws.com 이어야 합니다.' },
      { name: 'policies', label: '권한 정책 연결', type: 'multiselect', options: Policies.map((p) => [p.Arn, `${p.PolicyName} ${p.Scope === 'AWS' ? '(AWS 관리형)' : ''}`]) },
      { name: 'Description', label: '설명' },
    ], onSubmit: async (v) => { await api('iam', 'CreateRole', { RoleName: v.RoleName, AssumeRolePolicyDocument: v.doc, Description: v.Description }); for (const p of v.policies) await api('iam', 'AttachRolePolicy', { RoleName: v.RoleName, PolicyArn: p }); toast('역할을 만들었습니다.', 'success'); App.navigate(`#/iam/roles/${v.RoleName}`); } });
  }
  async function roleDetail(name) {
    const { Role } = await api('iam', 'GetRole', { RoleName: name });
    const { Policies } = await api('iam', 'ListPolicies');
    return h('div', null, breadcrumb(['IAM', '#/iam'], ['역할', '#/iam/roles'], name), h('h1', null, name, ' ', h('button', { class: 'danger', style: { float: 'right' }, onclick: async () => { if (await confirm('역할을 삭제할까요?')) { await api('iam', 'DeleteRole', { RoleName: name }); App.navigate('#/iam/roles'); } } }, '역할 삭제')),
      card('요약', kv([['ARN', h('span', null, Role.Arn, ' ', App.copyBtn(Role.Arn))], ['역할 ID', Role.RoleId], ['생성일', fmtDate(Role.CreateDate)], ['최대 세션 시간', Role.MaxSessionDuration + '초'], ['설명', Role.Description]])),
      h('div', { class: 'two-col' },
        card('권한 정책', [table({ columns: [{ label: '정책', render: (a) => h('a', { href: `#/iam/policies/${encodeURIComponent(a)}` }, a.split('/').pop()) }, { label: '', render: (a) => h('button', { class: 'sm', onclick: async () => { await api('iam', 'DetachRolePolicy', { RoleName: name, PolicyArn: a }); App.refresh(); } }, '분리') }], rows: Role.AttachedPolicies, empty: '연결된 정책이 없습니다.' }), (Role.InlinePolicies || []).length ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, '인라인 정책: ' + Role.InlinePolicies.map((p) => p.PolicyName).join(', ')) : null], [h('button', { onclick: () => modal({ title: '정책 연결', fields: [{ name: 'p', label: '정책', type: 'multiselect', options: Policies.filter((p) => !Role.AttachedPolicies.includes(p.Arn)).map((p) => [p.Arn, p.PolicyName]) }], submitLabel: '연결', onSubmit: async (v) => { for (const p of v.p) await api('iam', 'AttachRolePolicy', { RoleName: name, PolicyArn: p }); App.refresh(); } }) }, '정책 연결'), h('button', { onclick: () => modal({ title: '인라인 정책 추가', wide: true, fields: [{ name: 'PolicyName', label: '정책 이름', required: true }, { name: 'PolicyDocument', label: 'JSON', type: 'json', rows: 12, value: POLICY_TEMPLATES['Lambda 기본 실행 (로그)'] }], onSubmit: async (v) => { await api('iam', 'PutRolePolicy', { RoleName: name, ...v }); App.refresh(); } }) }, '인라인 정책')]),
        card('신뢰 관계 (누가 이 역할을 맡을 수 있나)', h('pre', null, JSON.stringify(Role.AssumeRolePolicyDocument, null, 2)))));
  }
  function createPolicy() {
    return modal({ title: '정책 생성', wide: true, fields: [
      { name: 'PolicyName', label: '정책 이름', required: true, placeholder: 'team-data-writer' },
      { name: 'tpl', label: '템플릿에서 시작', type: 'select', options: Object.keys(POLICY_TEMPLATES).map((k) => [k, k || '(직접 작성)']), onChange: (v) => { const ta = document.querySelector('[data-field=PolicyDocument] textarea'); if (POLICY_TEMPLATES[v]) ta.value = JSON.stringify(POLICY_TEMPLATES[v], null, 2); } },
      { name: 'PolicyDocument', label: '정책 문서 (JSON)', type: 'json', rows: 16, value: { Version: '2012-10-17', Statement: [{ Sid: 'Example', Effect: 'Allow', Action: ['s3:GetObject'], Resource: 'arn:aws:s3:::my-bucket/*' }] }, hint: 'Effect(Allow/Deny) · Action(서비스:작업, 와일드카드 *) · Resource(ARN). 명시적 Deny 가 항상 우선합니다.' },
      { name: 'Description', label: '설명' },
    ], onSubmit: async (v) => { await api('iam', 'CreatePolicy', { PolicyName: v.PolicyName, PolicyDocument: v.PolicyDocument, Description: v.Description }); toast('정책을 만들었습니다.', 'success'); App.navigate('#/iam/policies'); } });
  }
  async function policyDetail(arn) {
    const { Policy } = await api('iam', 'GetPolicy', { PolicyArn: arn });
    const { Users } = await api('iam', 'ListUsers'); const { Roles } = await api('iam', 'ListRoles'); const { Groups } = await api('iam', 'ListGroups');
    const used = [...Users.filter((u) => u.AttachedPolicies.includes(arn)).map((u) => ['사용자', u.UserName, `#/iam/users/${u.UserName}`]), ...Groups.filter((g) => g.AttachedPolicies.includes(arn)).map((g) => ['그룹', g.GroupName, `#/iam/groups/${g.GroupName}`]), ...Roles.filter((r) => r.AttachedPolicies.includes(arn)).map((r) => ['역할', r.RoleName, `#/iam/roles/${r.RoleName}`])];
    return h('div', null, breadcrumb(['IAM', '#/iam'], ['정책', '#/iam/policies'], Policy.PolicyName), h('h1', null, Policy.PolicyName, ' ', Policy.Scope === 'AWS' ? badge('AWS 관리형', 'blue') : h('button', { class: 'danger', style: { float: 'right' }, onclick: async () => { if (await confirm('정책을 삭제할까요?')) { await api('iam', 'DeletePolicy', { PolicyArn: arn }); App.navigate('#/iam/policies'); } } }, '정책 삭제')),
      card('요약', kv([['ARN', h('span', null, Policy.Arn, ' ', App.copyBtn(Policy.Arn))], ['설명', Policy.Description], ['연결 수', Policy.AttachmentCount], ['생성일', fmtDate(Policy.CreateDate)]])),
      h('div', { class: 'two-col' }, card('정책 문서 (JSON)', h('pre', null, JSON.stringify(Policy.Document, null, 2))), card('연결된 엔터티', table({ columns: [{ label: '유형', render: (r) => r[0] }, { label: '이름', render: (r) => h('a', { href: r[2] }, r[1]) }], rows: used, empty: '어디에도 연결되지 않았습니다.' }))));
  }
  async function simulator(preselect) {
    const { Users } = await api('iam', 'ListUsers'); const { Roles } = await api('iam', 'ListRoles');
    const principals = [...Users.map((u) => [u.Arn, `사용자: ${u.UserName}`]), ...Roles.map((r) => [r.Arn, `역할: ${r.RoleName}`])];
    const sel = h('select', null, principals.map((p) => h('option', { value: p[0], selected: p[0] === preselect }, p[1])));
    const acts = h('textarea', { rows: 4, placeholder: 's3:GetObject\ns3:PutObject\nec2:StartInstances' }, 's3:GetObject\ns3:PutObject\nec2:DescribeInstances\niam:CreateUser');
    const res = h('input', { type: 'text', placeholder: '* (쉼표로 여러 개)', value: '*' });
    const out = h('div');
    const run = async () => {
      const r = await api('iam', 'SimulatePrincipalPolicy', { PolicySourceArn: sel.value, ActionNames: acts.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), ResourceArns: res.value.split(',').map((s) => s.trim()).filter(Boolean) });
      out.innerHTML = '';
      out.appendChild(table({ columns: [{ key: 'EvalActionName', label: '작업' }, { key: 'EvalResourceName', label: '리소스' }, { label: '결과', render: (x) => badge({ allowed: '허용 (allowed)', explicitDeny: '명시적 거부 (explicitDeny)', implicitDeny: '암시적 거부 (implicitDeny)' }[x.EvalDecision], x.EvalDecision === 'allowed' ? 'green' : x.EvalDecision === 'explicitDeny' ? 'red' : 'grey') }, { label: '일치한 문', render: (x) => x.MatchedStatements.map((m) => `${m.SourcePolicyId} [${m.Effect}${m.Sid ? ' ' + m.Sid : ''}]`).join('; ') || '(없음)' }], rows: r.EvaluationResults }));
    };
    return card('정책 시뮬레이터', [
      h('p', { class: 'muted' }, 'IAM 평가 논리: ① 명시적 Deny 가 있으면 거부 ② Allow 가 있으면 허용 ③ 아무것도 없으면 암시적 거부. 사용자 정책 + 그룹 정책 + 인라인 정책이 모두 합쳐져 평가됩니다.'),
      h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', null, '보안 주체 (사용자/역할)'), sel), h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', null, '작업 (줄 또는 쉼표로 구분)'), acts), h('div', { class: 'field' }, h('label', null, '리소스 ARN'), res)), h('div', null, h('button', { class: 'primary', onclick: run }, '시뮬레이션 실행'))),
      h('div', { style: { marginTop: '14px' } }, out), principals.length ? null : h('div', { class: 'alert warn' }, '먼저 사용자나 역할을 만드세요.'),
      cli('awsim iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/dev-user --action-names s3:GetObject s3:PutObject'),
    ]);
  }

  // =====================================================================
  // VPC
  // =====================================================================
  App.register('vpc', async ([tab = 'vpcs', id]) => {
    const base = '#/vpc';
    const T = tabs([{ id: 'vpcs', label: 'VPC' }, { id: 'subnets', label: '서브넷' }, { id: 'rtbs', label: '라우팅 테이블' }, { id: 'igws', label: '인터넷 게이트웨이' }, { id: 'nat', label: 'NAT 게이트웨이' }], tab, base);
    const head = h('div', null, h('h1', null, 'VPC (Virtual Private Cloud) ', h('span', { class: 'muted small' }, App.region)), T);
    const [{ Vpcs }, { Subnets }, { RouteTables }, { InternetGateways }] = await Promise.all([api('ec2', 'DescribeVpcs'), api('ec2', 'DescribeSubnets'), api('ec2', 'DescribeRouteTables'), api('ec2', 'DescribeInternetGateways')]);
    const vpcLabel = (vid) => { const v = Vpcs.find((x) => x.VpcId === vid); return v ? `${nameTag(v) || (v.IsDefault ? '(기본)' : '')} ${v.VpcId} ${v.CidrBlock}` : vid; };
    const vpcOpts = Vpcs.map((v) => [v.VpcId, vpcLabel(v.VpcId)]);
    if (tab === 'vpcs' && id) return vpcMap(id, Vpcs, Subnets, RouteTables, InternetGateways);
    if (tab === 'vpcs') {
      return h('div', null, head, card(h('h2', null, 'VPC ', h('span', { class: 'count' }, `(${Vpcs.length})`)), table({ columns: [{ label: '이름', render: (v) => nameTag(v) || '-' }, { label: 'VPC ID', render: (v) => h('a', { href: `${base}/vpcs/${v.VpcId}` }, v.VpcId) }, { label: '상태', render: (v) => stateBadge(v.State) }, { key: 'CidrBlock', label: 'IPv4 CIDR' }, { label: '기본 VPC', render: (v) => (v.IsDefault ? '예' : '아니요') }, { label: '서브넷', render: (v) => Subnets.filter((s) => s.VpcId === v.VpcId).length }, { label: 'IGW', render: (v) => (InternetGateways.find((g) => g.Attachments.some((a) => a.VpcId === v.VpcId)) || {}).InternetGatewayId || '-' }, { label: '', render: (v) => (v.IsDefault ? null : h('button', { class: 'sm danger', onclick: async () => { if (await confirm(`${v.VpcId} 를 삭제할까요?`)) { await api('ec2', 'DeleteVpc', { VpcId: v.VpcId }); App.refresh(); } } }, '삭제')) }], rows: Vpcs, onRow: (v) => App.navigate(`${base}/vpcs/${v.VpcId}`) }),
        [h('button', { class: 'primary', onclick: () => modal({ title: 'VPC 생성', fields: [{ name: 'name', label: '이름 태그', placeholder: 'lab-vpc' }, { name: 'CidrBlock', label: 'IPv4 CIDR 블록', required: true, value: '10.0.0.0/16', hint: '/16 ~ /28. 예: 10.0.0.0/16 (65,536개 주소)' }, { name: 'wizard', label: '"VPC 등" 마법사: 퍼블릭/프라이빗 서브넷 + IGW + 라우팅 테이블까지 자동 생성', type: 'checkbox' }], onSubmit: async (v) => { const r = await api('ec2', 'CreateVpc', { CidrBlock: v.CidrBlock, TagSpecifications: v.name ? [{ ResourceType: 'vpc', Tags: [{ Key: 'Name', Value: v.name }] }] : [] }); if (v.wizard) await vpcWizard(r.Vpc, v.name || 'vpc'); toast('VPC 를 만들었습니다.', 'success'); App.navigate(`${base}/vpcs/${r.Vpc.VpcId}`); } }) }, 'VPC 생성')]), cli("awsim ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=lab-vpc}]'"));
    }
    if (tab === 'subnets') {
      return h('div', null, head, card(h('h2', null, '서브넷 ', h('span', { class: 'count' }, `(${Subnets.length})`)), table({ columns: [{ label: '이름', render: (s) => nameTag(s) || '-' }, { key: 'SubnetId', label: '서브넷 ID' }, { label: 'VPC', render: (s) => h('a', { href: `${base}/vpcs/${s.VpcId}` }, vpcLabel(s.VpcId)) }, { key: 'CidrBlock', label: 'IPv4 CIDR' }, { key: 'AvailabilityZone', label: '가용 영역' }, { label: '유형', render: (s) => (s.IsPublic ? badge('퍼블릭', 'green') : badge('프라이빗', 'grey')) }, { label: '퍼블릭 IP 자동 할당', render: (s) => h('button', { class: 'sm', onclick: async () => { await api('ec2', 'ModifySubnetAttribute', { SubnetId: s.SubnetId, MapPublicIpOnLaunch: { Value: !s.MapPublicIpOnLaunch } }); App.refresh(); } }, s.MapPublicIpOnLaunch ? '예 (끄기)' : '아니요 (켜기)') }, { key: 'AvailableIpAddressCount', label: '사용 가능 IP' }, { label: '', render: (s) => (s.DefaultForAz ? null : h('button', { class: 'sm danger', onclick: async () => { if (await confirm('서브넷을 삭제할까요?')) { await api('ec2', 'DeleteSubnet', { SubnetId: s.SubnetId }); App.refresh(); } } }, '삭제')) }], rows: Subnets }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '서브넷 생성', fields: [{ name: 'VpcId', label: 'VPC', type: 'select', options: vpcOpts, required: true }, { name: 'name', label: '이름 태그', placeholder: 'public-subnet-a' }, { name: 'AvailabilityZone', label: '가용 영역', type: 'select', options: ['a', 'b', 'c'].map((z) => App.region + z) }, { name: 'CidrBlock', label: 'IPv4 CIDR 블록', required: true, value: '10.0.1.0/24', hint: 'VPC CIDR 범위 안이어야 하고 다른 서브넷과 겹치면 안 됩니다.' }], onSubmit: async (v) => { await api('ec2', 'CreateSubnet', { VpcId: v.VpcId, CidrBlock: v.CidrBlock, AvailabilityZone: v.AvailabilityZone, TagSpecifications: v.name ? [{ ResourceType: 'subnet', Tags: [{ Key: 'Name', Value: v.name }] }] : [] }); App.refresh(); } }) }, '서브넷 생성')]), h('p', { class: 'muted small' }, '"퍼블릭 서브넷" = 연결된 라우팅 테이블에 0.0.0.0/0 → 인터넷 게이트웨이 경로가 있는 서브넷. 체크박스가 아니라 라우팅으로 결정됩니다.'), cli('awsim ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.1.0/24 --availability-zone ap-northeast-2a'));
    }
    if (tab === 'rtbs') {
      return h('div', null, head, card(h('h2', null, '라우팅 테이블 ', h('span', { class: 'count' }, `(${RouteTables.length})`)), table({ columns: [{ label: '이름', render: (r) => nameTag(r) || '-' }, { key: 'RouteTableId', label: 'ID' }, { label: 'VPC', render: (r) => vpcLabel(r.VpcId) }, { label: '메인', render: (r) => (r.Associations.some((a) => a.Main) ? '예' : '아니요') }, { label: '경로', render: (r) => h('div', null, r.Routes.map((x) => h('div', { class: 'small mono' }, `${x.DestinationCidrBlock} → ${x.GatewayId || x.NatGatewayId || x.InstanceId}`))) }, { label: '명시적 서브넷 연결', render: (r) => r.Associations.filter((a) => a.SubnetId).map((a) => a.SubnetId).join(', ') || '-' }, { label: '', render: (r) => h('span', null, h('button', { class: 'sm', onclick: () => addRoute(r, InternetGateways) }, '경로 추가'), ' ', h('button', { class: 'sm', onclick: () => associate(r, Subnets) }, '서브넷 연결'), ' ', r.Associations.some((a) => a.Main) ? null : h('button', { class: 'sm danger', onclick: async () => { if (await confirm('라우팅 테이블을 삭제할까요?')) { await api('ec2', 'DeleteRouteTable', { RouteTableId: r.RouteTableId }); App.refresh(); } } }, '삭제')) }], rows: RouteTables }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '라우팅 테이블 생성', fields: [{ name: 'VpcId', label: 'VPC', type: 'select', options: vpcOpts }, { name: 'name', label: '이름 태그', placeholder: 'public-rt' }], onSubmit: async (v) => { await api('ec2', 'CreateRouteTable', { VpcId: v.VpcId, TagSpecifications: v.name ? [{ ResourceType: 'route-table', Tags: [{ Key: 'Name', Value: v.name }] }] : [] }); App.refresh(); } }) }, '라우팅 테이블 생성')]), cli('awsim ec2 create-route --route-table-id rtb-xxx --destination-cidr-block 0.0.0.0/0 --gateway-id igw-xxx'));
    }
    if (tab === 'igws') {
      return h('div', null, head, card(h('h2', null, '인터넷 게이트웨이 ', h('span', { class: 'count' }, `(${InternetGateways.length})`)), table({ columns: [{ label: '이름', render: (g) => nameTag(g) || '-' }, { key: 'InternetGatewayId', label: 'ID' }, { label: '상태', render: (g) => (g.Attachments.length ? badge('Attached', 'green') : badge('Detached', 'grey')) }, { label: 'VPC', render: (g) => (g.Attachments[0] ? vpcLabel(g.Attachments[0].VpcId) : '-') }, { label: '', render: (g) => h('span', null, g.Attachments.length ? h('button', { class: 'sm', onclick: async () => { await api('ec2', 'DetachInternetGateway', { InternetGatewayId: g.InternetGatewayId, VpcId: g.Attachments[0].VpcId }); App.refresh(); } }, 'VPC 에서 분리') : h('button', { class: 'sm', onclick: () => modal({ title: 'VPC 에 연결', fields: [{ name: 'VpcId', label: 'VPC', type: 'select', options: vpcOpts }], submitLabel: '연결', onSubmit: async (v) => { await api('ec2', 'AttachInternetGateway', { InternetGatewayId: g.InternetGatewayId, VpcId: v.VpcId }); App.refresh(); } }) }, 'VPC 에 연결'), ' ', h('button', { class: 'sm danger', onclick: async () => { if (await confirm('삭제할까요?')) { await api('ec2', 'DeleteInternetGateway', { InternetGatewayId: g.InternetGatewayId }); App.refresh(); } } }, '삭제')) }], rows: InternetGateways }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '인터넷 게이트웨이 생성', fields: [{ name: 'name', label: '이름 태그', placeholder: 'lab-igw' }], onSubmit: async (v) => { await api('ec2', 'CreateInternetGateway', { TagSpecifications: v.name ? [{ ResourceType: 'internet-gateway', Tags: [{ Key: 'Name', Value: v.name }] }] : [] }); App.refresh(); } }) }, '인터넷 게이트웨이 생성')]), cli('awsim ec2 attach-internet-gateway --internet-gateway-id igw-xxx --vpc-id vpc-xxx'));
    }
    if (tab === 'nat') {
      const { NatGateways } = await api('ec2', 'DescribeNatGateways'); const { Addresses } = await api('ec2', 'DescribeAddresses');
      return h('div', null, head, h('div', { class: 'alert warn' }, 'NAT 게이트웨이는 프라이빗 서브넷의 인스턴스가 인터넷으로 나가게 해 줍니다. 시간당 과금되므로 실습 후 삭제하세요. 퍼블릭 서브넷 + 탄력적 IP 가 필요합니다.'), card(h('h2', null, 'NAT 게이트웨이 ', h('span', { class: 'count' }, `(${NatGateways.length})`)), table({ columns: [{ key: 'NatGatewayId', label: 'ID' }, { label: '상태', render: (n) => stateBadge(n.State) }, { key: 'SubnetId', label: '서브넷' }, { label: '탄력적 IP', render: (n) => n.NatGatewayAddresses[0].PublicIp }, { label: '', render: (n) => h('button', { class: 'sm danger', onclick: async () => { await api('ec2', 'DeleteNatGateway', { NatGatewayId: n.NatGatewayId }); App.refresh(); } }, '삭제') }], rows: NatGateways }),
        [h('button', { class: 'primary', onclick: () => modal({ title: 'NAT 게이트웨이 생성', fields: [{ name: 'SubnetId', label: '서브넷 (퍼블릭이어야 함)', type: 'select', options: Subnets.map((s) => [s.SubnetId, `${s.SubnetId} ${s.CidrBlock} ${s.IsPublic ? '(퍼블릭)' : '(프라이빗)'}`]) }, { name: 'AllocationId', label: '탄력적 IP 할당', type: 'select', options: Addresses.filter((a) => !a.AssociationId).map((a) => [a.AllocationId, `${a.PublicIp} (${a.AllocationId})`]), hint: '없으면 EC2 › 탄력적 IP 에서 먼저 할당하세요.' }], onSubmit: async (v) => { await api('ec2', 'CreateNatGateway', v); App.refresh(); } }) }, 'NAT 게이트웨이 생성')]));
    }
    return head;
  });
  async function vpcWizard(vpc, name) {
    const base = vpc.CidrBlock.split('.').slice(0, 2).join('.');
    const pub = await api('ec2', 'CreateSubnet', { VpcId: vpc.VpcId, CidrBlock: `${base}.1.0/24`, AvailabilityZone: App.region + 'a', TagSpecifications: [{ ResourceType: 'subnet', Tags: [{ Key: 'Name', Value: name + '-public-a' }] }] });
    await api('ec2', 'CreateSubnet', { VpcId: vpc.VpcId, CidrBlock: `${base}.2.0/24`, AvailabilityZone: App.region + 'a', TagSpecifications: [{ ResourceType: 'subnet', Tags: [{ Key: 'Name', Value: name + '-private-a' }] }] });
    const igw = await api('ec2', 'CreateInternetGateway', { TagSpecifications: [{ ResourceType: 'internet-gateway', Tags: [{ Key: 'Name', Value: name + '-igw' }] }] });
    await api('ec2', 'AttachInternetGateway', { InternetGatewayId: igw.InternetGateway.InternetGatewayId, VpcId: vpc.VpcId });
    const rtb = await api('ec2', 'CreateRouteTable', { VpcId: vpc.VpcId, TagSpecifications: [{ ResourceType: 'route-table', Tags: [{ Key: 'Name', Value: name + '-public-rt' }] }] });
    await api('ec2', 'CreateRoute', { RouteTableId: rtb.RouteTable.RouteTableId, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw.InternetGateway.InternetGatewayId });
    await api('ec2', 'AssociateRouteTable', { RouteTableId: rtb.RouteTable.RouteTableId, SubnetId: pub.Subnet.SubnetId });
    await api('ec2', 'ModifySubnetAttribute', { SubnetId: pub.Subnet.SubnetId, MapPublicIpOnLaunch: { Value: true } });
  }
  function addRoute(rtb, igws) {
    return modal({ title: `경로 추가 — ${rtb.RouteTableId}`, fields: [{ name: 'DestinationCidrBlock', label: '대상 (CIDR)', value: '0.0.0.0/0', required: true }, { name: 'target', label: '대상 게이트웨이', type: 'select', options: igws.filter((g) => g.Attachments.some((a) => a.VpcId === rtb.VpcId)).map((g) => ['igw:' + g.InternetGatewayId, `인터넷 게이트웨이 ${g.InternetGatewayId}`]).concat([['nat', 'NAT 게이트웨이 (ID 직접 입력)']]) }, { name: 'natId', label: 'NAT 게이트웨이 ID (선택 시)', placeholder: 'nat-xxx' }], submitLabel: '추가', onSubmit: async (v) => { const p = { RouteTableId: rtb.RouteTableId, DestinationCidrBlock: v.DestinationCidrBlock }; if (v.target.startsWith('igw:')) p.GatewayId = v.target.slice(4); else p.NatGatewayId = v.natId; await api('ec2', 'CreateRoute', p); App.refresh(); } });
  }
  function associate(rtb, subnets) {
    return modal({ title: `서브넷 연결 — ${rtb.RouteTableId}`, fields: [{ name: 'SubnetId', label: '서브넷', type: 'select', options: subnets.filter((s) => s.VpcId === rtb.VpcId).map((s) => [s.SubnetId, `${nameTag(s) || ''} ${s.SubnetId} ${s.CidrBlock}`]) }], submitLabel: '연결', onSubmit: async (v) => { await api('ec2', 'AssociateRouteTable', { RouteTableId: rtb.RouteTableId, SubnetId: v.SubnetId }); App.refresh(); } });
  }
  async function vpcMap(id, Vpcs, Subnets, RouteTables, Igws) {
    const v = Vpcs.find((x) => x.VpcId === id);
    if (!v) return h('div', null, 'VPC 가 없습니다.');
    const { Reservations } = await api('ec2', 'DescribeInstances');
    const instances = Reservations.flatMap((r) => r.Instances).filter((i) => i.VpcId === id && i.State.Name !== 'terminated');
    const igw = Igws.find((g) => g.Attachments.some((a) => a.VpcId === id));
    const subs = Subnets.filter((s) => s.VpcId === id);
    const rtbFor = (s) => RouteTables.find((r) => r.Associations.some((a) => a.SubnetId === s.SubnetId)) || RouteTables.find((r) => r.VpcId === id && r.Associations.some((a) => a.Main));
    return h('div', null, breadcrumb(['VPC', '#/vpc'], ['VPC 목록', '#/vpc/vpcs'], id),
      h('h1', null, nameTag(v) || id, ' ', h('span', { class: 'muted', style: { fontSize: '14px' } }, v.CidrBlock)),
      card('세부 정보', kv([['VPC ID', id], ['CIDR', v.CidrBlock], ['기본 VPC', v.IsDefault ? '예' : '아니요'], ['DNS 호스트 이름', v.EnableDnsHostnames ? '활성' : '비활성'], ['인터넷 게이트웨이', igw ? igw.InternetGatewayId : h('span', { class: 'err' }, '없음 — 인터넷과 통신 불가')]])),
      card('리소스 맵', h('div', null,
        h('div', { class: 'alert info' }, `🌐 인터넷 ${igw ? '⟷ ' + igw.InternetGatewayId + ' (IGW) ⟷ ' : '✖ (IGW 없음) '} VPC ${v.CidrBlock}`),
        h('div', { class: 'cards-grid' }, subs.map((s) => { const rtb = rtbFor(s); const inst = instances.filter((i) => i.SubnetId === s.SubnetId); return h('div', { class: 'svc-card', style: { borderTop: '4px solid ' + (s.IsPublic ? '#1d8102' : '#879596') } }, h('div', { class: 'name' }, s.IsPublic ? '🟢 퍼블릭 서브넷' : '⚪ 프라이빗 서브넷'), h('div', { class: 'small' }, nameTag(s) || s.SubnetId), h('div', { class: 'small muted' }, `${s.CidrBlock} · ${s.AvailabilityZone}`), h('div', { class: 'small', style: { marginTop: '6px' } }, '라우팅: ', rtb ? rtb.Routes.map((r) => h('div', { class: 'mono small' }, `${r.DestinationCidrBlock} → ${r.GatewayId || r.NatGatewayId}`)) : '-'), h('div', { class: 'small', style: { marginTop: '6px' } }, inst.length ? inst.map((i) => h('div', null, '🖥 ', h('a', { href: `#/ec2/instances/${i.InstanceId}` }, nameTag(i) || i.InstanceId), ' ', stateBadge(i.State), ' ', h('span', { class: 'muted' }, i.PrivateIpAddress))) : h('span', { class: 'muted' }, '인스턴스 없음'))); }), subs.length ? null : h('div', { class: 'muted' }, '서브넷이 없습니다. 서브넷 탭에서 만드세요.')))));
  }

  // =====================================================================
  // EC2
  // =====================================================================
  const USERDATA = {
    '': '',
    'Apache 웹 서버 (Amazon Linux)': '#!/bin/bash\nyum update -y\nyum install -y httpd\nsystemctl start httpd\nsystemctl enable httpd\necho "<h1>Hello from $(hostname -f)</h1>" > /var/www/html/index.html',
    'nginx (Ubuntu)': '#!/bin/bash\napt-get update\napt-get install -y nginx\nsystemctl start nginx\necho "<h1>Hello from nginx</h1>" > /var/www/html/index.html',
    'CPU 부하 발생 (CloudWatch 실습용)': '#!/bin/bash\nyum install -y stress\nstress --cpu 2 --timeout 3600 &',
  };
  App.register('ec2', async ([tab = 'instances', id, sub]) => {
    const base = '#/ec2';
    const T = tabs([{ id: 'instances', label: '인스턴스' }, { id: 'sgs', label: '보안 그룹' }, { id: 'keypairs', label: '키 페어' }, { id: 'eips', label: '탄력적 IP' }, { id: 'volumes', label: 'EBS 볼륨' }, { id: 'amis', label: 'AMI' }], tab, base);
    const head = h('div', null, h('h1', null, 'EC2 (Elastic Compute Cloud) ', h('span', { class: 'muted small' }, App.region)), T);
    if (tab === 'instances' && id) return instanceDetail(id, sub);
    if (tab === 'sgs' && id) return sgDetail(id);
    if (tab === 'instances') {
      const { Reservations } = await api('ec2', 'DescribeInstances');
      const rows = Reservations.flatMap((r) => r.Instances);
      const box = h('div');
      const draw = (list) => { box.innerHTML = ''; box.appendChild(table({ columns: [{ label: '이름', render: (i) => nameTag(i) || '-' }, { label: '인스턴스 ID', render: (i) => h('a', { href: `${base}/instances/${i.InstanceId}` }, i.InstanceId) }, { label: '상태', render: (i) => stateBadge(i.State) }, { key: 'InstanceType', label: '유형' }, { label: '가용 영역', render: (i) => i.Placement.AvailabilityZone }, { key: 'PublicIpAddress', label: '퍼블릭 IPv4' }, { key: 'PrivateIpAddress', label: '프라이빗 IPv4' }, { label: '보안 그룹', render: (i) => i.SecurityGroups.map((g) => g.GroupName).join(', ') }, { label: '시작 시간', render: (i) => fmtDate(i.LaunchTime) }], rows: list, onRow: (i) => App.navigate(`${base}/instances/${i.InstanceId}`), empty: '인스턴스가 없습니다. "인스턴스 시작" 으로 첫 서버를 만들어 보세요.' })); };
      draw(rows);
      App.poll(async () => { const r = await api('ec2', 'DescribeInstances', {}, { silent: true }); const l = r.Reservations.flatMap((x) => x.Instances); if (JSON.stringify(l.map((i) => i.State.Name + i.PublicIpAddress)) !== JSON.stringify(rows.map((i) => i.State.Name + i.PublicIpAddress))) { rows.splice(0, rows.length, ...l); draw(l); } }, 3000);
      return h('div', null, head, card(h('h2', null, '인스턴스 ', h('span', { class: 'count' }, `(${rows.length})`)), box, [h('button', { class: 'primary', onclick: launchInstance }, '인스턴스 시작')]), cli('awsim ec2 run-instances --image-id ami-0c9c942bd7bf113a2 --instance-type t2.micro --key-name lab-key --security-groups web-sg'));
    }
    if (tab === 'sgs') {
      const { SecurityGroups } = await api('ec2', 'DescribeSecurityGroups'); const { Vpcs } = await api('ec2', 'DescribeVpcs');
      return h('div', null, head, card(h('h2', null, '보안 그룹 ', h('span', { class: 'count' }, `(${SecurityGroups.length})`)), table({ columns: [{ label: '이름', render: (g) => h('a', { href: `${base}/sgs/${g.GroupId}` }, g.GroupName) }, { key: 'GroupId', label: 'ID' }, { key: 'VpcId', label: 'VPC' }, { key: 'Description', label: '설명' }, { label: '인바운드 규칙', render: (g) => g.IpPermissions.map((p) => `${p.IpProtocol === '-1' ? '모든 트래픽' : p.IpProtocol.toUpperCase() + ' ' + (p.FromPort === p.ToPort ? p.FromPort : p.FromPort + '-' + p.ToPort)} ← ${[...p.IpRanges.map((r) => r.CidrIp), ...p.UserIdGroupPairs.map((u) => u.GroupId)].join(',')}`).join('; ') || '(없음)' }], rows: SecurityGroups, onRow: (g) => App.navigate(`${base}/sgs/${g.GroupId}`) }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '보안 그룹 생성', fields: [{ name: 'GroupName', label: '보안 그룹 이름', required: true, placeholder: 'web-sg' }, { name: 'Description', label: '설명', required: true, value: 'web server security group' }, { name: 'VpcId', label: 'VPC', type: 'select', options: Vpcs.map((v) => [v.VpcId, `${nameTag(v) || (v.IsDefault ? '(기본)' : '')} ${v.VpcId} ${v.CidrBlock}`]) }, { name: 'preset', label: '인바운드 규칙 프리셋', type: 'select', options: [['', '없음 (나중에 추가)'], ['web', 'SSH(22) + HTTP(80) + HTTPS(443) — 어디서나'], ['ssh', 'SSH(22) — 어디서나']] }], onSubmit: async (v) => { const r = await api('ec2', 'CreateSecurityGroup', { GroupName: v.GroupName, Description: v.Description, VpcId: v.VpcId }); const ports = v.preset === 'web' ? [22, 80, 443] : v.preset === 'ssh' ? [22] : []; for (const p of ports) await api('ec2', 'AuthorizeSecurityGroupIngress', { GroupId: r.GroupId, IpProtocol: 'tcp', FromPort: p, ToPort: p, CidrIp: '0.0.0.0/0' }); App.navigate(`${base}/sgs/${r.GroupId}`); } }) }, '보안 그룹 생성')]), cli('awsim ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 80 --cidr 0.0.0.0/0'));
    }
    if (tab === 'keypairs') {
      const { KeyPairs } = await api('ec2', 'DescribeKeyPairs');
      return h('div', null, head, card(h('h2', null, '키 페어 ', h('span', { class: 'count' }, `(${KeyPairs.length})`)), table({ columns: [{ key: 'KeyName', label: '이름' }, { key: 'KeyType', label: '유형' }, { key: 'KeyPairId', label: 'ID' }, { key: 'KeyFingerprint', label: '지문' }, { label: '생성일', render: (k) => fmtDate(k.CreateTime) }, { label: '', render: (k) => h('button', { class: 'sm danger', onclick: async () => { if (await confirm('키 페어를 삭제할까요?')) { await api('ec2', 'DeleteKeyPair', { KeyName: k.KeyName }); App.refresh(); } } }, '삭제') }], rows: KeyPairs }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '키 페어 생성', fields: [{ name: 'KeyName', label: '이름', required: true, placeholder: 'lab-key' }], onSubmit: async (v) => { const r = await api('ec2', 'CreateKeyPair', v); const blob = new Blob([r.KeyMaterial], { type: 'application/x-pem-file' }); await modal({ title: '프라이빗 키 다운로드 — 지금만 가능합니다', body: h('div', null, h('div', { class: 'alert warn' }, '실제 AWS 에서는 프라이빗 키(.pem)를 이 시점에만 받을 수 있습니다. 분실하면 다시 만들어야 합니다.'), h('a', { class: 'btn', href: URL.createObjectURL(blob), download: v.KeyName + '.pem' }, `${v.KeyName}.pem 다운로드`), h('pre', { style: { maxHeight: '160px' } }, r.KeyMaterial.slice(0, 300) + '…')) }); App.refresh(); } }) }, '키 페어 생성')]), cli('awsim ec2 create-key-pair --key-name lab-key --output text > lab-key.pem'));
    }
    if (tab === 'eips') {
      const { Addresses } = await api('ec2', 'DescribeAddresses'); const { Reservations } = await api('ec2', 'DescribeInstances');
      const inst = Reservations.flatMap((r) => r.Instances).filter((i) => i.State.Name === 'running');
      return h('div', null, head, h('div', { class: 'alert info' }, '탄력적 IP(EIP)는 고정 퍼블릭 IPv4 주소입니다. 인스턴스를 중지/시작해도 유지됩니다. 인스턴스에 연결하지 않은 채 두면 시간당 과금됩니다.'), card(h('h2', null, '탄력적 IP ', h('span', { class: 'count' }, `(${Addresses.length})`)), table({ columns: [{ key: 'PublicIp', label: '퍼블릭 IP' }, { key: 'AllocationId', label: '할당 ID' }, { label: '연결된 인스턴스', render: (a) => (a.InstanceId ? h('a', { href: `${base}/instances/${a.InstanceId}` }, a.InstanceId) : a.NatGatewayId ? `NAT ${a.NatGatewayId}` : badge('유휴 (과금 중)', 'red')) }, { label: '', render: (a) => h('span', null, a.AssociationId ? (a.InstanceId ? h('button', { class: 'sm', onclick: async () => { await api('ec2', 'DisassociateAddress', { AssociationId: a.AssociationId }); App.refresh(); } }, '연결 해제') : null) : h('button', { class: 'sm', onclick: () => modal({ title: '탄력적 IP 연결', fields: [{ name: 'InstanceId', label: '인스턴스 (running)', type: 'select', options: inst.map((i) => [i.InstanceId, `${nameTag(i) || ''} ${i.InstanceId}`]) }], submitLabel: '연결', onSubmit: async (v) => { await api('ec2', 'AssociateAddress', { AllocationId: a.AllocationId, InstanceId: v.InstanceId }); App.refresh(); } }) }, '인스턴스에 연결'), ' ', a.AssociationId ? null : h('button', { class: 'sm danger', onclick: async () => { await api('ec2', 'ReleaseAddress', { AllocationId: a.AllocationId }); App.refresh(); } }, '릴리스')) }], rows: Addresses }), [h('button', { class: 'primary', onclick: async () => { await api('ec2', 'AllocateAddress', {}); App.refresh(); } }, '탄력적 IP 주소 할당')]), cli('awsim ec2 associate-address --instance-id i-xxx --allocation-id eipalloc-xxx'));
    }
    if (tab === 'volumes') {
      const { Volumes } = await api('ec2', 'DescribeVolumes'); const { Reservations } = await api('ec2', 'DescribeInstances'); const { Snapshots } = await api('ec2', 'DescribeSnapshots');
      const inst = Reservations.flatMap((r) => r.Instances).filter((i) => i.State.Name !== 'terminated');
      return h('div', null, head, card(h('h2', null, 'EBS 볼륨 ', h('span', { class: 'count' }, `(${Volumes.length})`)), table({ columns: [{ key: 'VolumeId', label: '볼륨 ID' }, { label: '크기', render: (v) => v.Size + ' GiB' }, { key: 'VolumeType', label: '유형' }, { label: '상태', render: (v) => stateBadge(v.State) }, { key: 'AvailabilityZone', label: '가용 영역' }, { label: '연결', render: (v) => v.Attachments.map((a) => `${a.InstanceId} (${a.Device})`).join(', ') || '-' }, { label: '', render: (v) => h('span', null, v.State === 'available' ? h('button', { class: 'sm', onclick: () => modal({ title: '볼륨 연결', body: h('p', { class: 'muted small' }, '같은 가용 영역의 인스턴스에만 연결할 수 있습니다.'), fields: [{ name: 'InstanceId', label: '인스턴스', type: 'select', options: inst.map((i) => [i.InstanceId, `${nameTag(i) || ''} ${i.InstanceId} (${i.Placement.AvailabilityZone})`]) }, { name: 'Device', label: '디바이스', value: '/dev/sdf' }], submitLabel: '연결', onSubmit: async (x) => { await api('ec2', 'AttachVolume', { VolumeId: v.VolumeId, ...x }); App.refresh(); } }) }, '연결') : h('button', { class: 'sm', onclick: async () => { await api('ec2', 'DetachVolume', { VolumeId: v.VolumeId }); App.refresh(); } }, '분리'), ' ', h('button', { class: 'sm', onclick: async () => { await api('ec2', 'CreateSnapshot', { VolumeId: v.VolumeId, Description: 'manual' }); App.refresh(); } }, '스냅샷'), ' ', v.State === 'available' ? h('button', { class: 'sm danger', onclick: async () => { await api('ec2', 'DeleteVolume', { VolumeId: v.VolumeId }); App.refresh(); } }, '삭제') : null) }], rows: Volumes }),
        [h('button', { class: 'primary', onclick: () => modal({ title: '볼륨 생성', fields: [{ name: 'AvailabilityZone', label: '가용 영역', type: 'select', options: ['a', 'b', 'c'].map((z) => App.region + z) }, { name: 'Size', label: '크기 (GiB)', type: 'number', value: 10, min: 1 }, { name: 'VolumeType', label: '유형', type: 'select', options: ['gp3', 'gp2', 'io1', 'st1'] }, { name: 'Encrypted', label: '암호화', type: 'checkbox' }], onSubmit: async (v) => { await api('ec2', 'CreateVolume', v); App.refresh(); } }) }, '볼륨 생성')]),
        Snapshots.length ? card('스냅샷', table({ columns: [{ key: 'SnapshotId', label: 'ID' }, { key: 'VolumeId', label: '볼륨' }, { label: '크기', render: (s) => s.VolumeSize + ' GiB' }, { key: 'State', label: '상태' }, { label: '시작', render: (s) => fmtDate(s.StartTime) }], rows: Snapshots })) : null, cli('awsim ec2 create-volume --availability-zone ap-northeast-2a --size 10'));
    }
    if (tab === 'amis') {
      const { Images } = await api('ec2', 'DescribeImages');
      return h('div', null, head, card('AMI (Amazon Machine Image)', table({ columns: [{ key: 'ImageId', label: 'AMI ID', render: (i) => h('span', null, i.ImageId, ' ', App.copyBtn(i.ImageId)) }, { key: 'Name', label: '이름' }, { key: 'Description', label: '설명' }, { key: 'Platform', label: '플랫폼' }, { key: 'User', label: '기본 사용자' }, { label: '프리 티어', render: (i) => (i.FreeTier ? badge('사용 가능', 'green') : '-') }], rows: Images })));
    }
    return head;
  });

  async function launchInstance() {
    const [{ Images }, { KeyPairs }, { Vpcs }, { Subnets }, { SecurityGroups }] = await Promise.all([api('ec2', 'DescribeImages'), api('ec2', 'DescribeKeyPairs'), api('ec2', 'DescribeVpcs'), api('ec2', 'DescribeSubnets'), api('ec2', 'DescribeSecurityGroups')]);
    const types = App.meta.InstanceTypes;
    const subnetOpts = (vpcId) => Subnets.filter((s) => s.VpcId === vpcId).map((s) => [s.SubnetId, `${nameTag(s) || ''} ${s.SubnetId} ${s.CidrBlock} ${s.AvailabilityZone} ${s.IsPublic ? '퍼블릭' : '프라이빗'}`]);
    const defaultVpc = (Vpcs.find((v) => v.IsDefault) || Vpcs[0] || {}).VpcId;
    return modal({ title: '인스턴스 시작', wide: true, submitLabel: '인스턴스 시작', fields: [
      { name: 'name', label: '이름', placeholder: 'web-server-1' },
      { name: 'ImageId', label: 'AMI (애플리케이션 및 OS 이미지)', type: 'select', options: Images.map((i) => [i.ImageId, `${i.Description} — ${i.ImageId}${i.FreeTier ? ' (프리 티어)' : ''}`]) },
      { name: 'InstanceType', label: '인스턴스 유형', type: 'select', options: types.map((t) => [t.InstanceType, `${t.InstanceType} — ${t.VCpu} vCPU, ${t.MemoryMiB / 1024} GiB, $${t.PriceUsd}/h ${t.FreeTier ? '(프리 티어)' : ''}`]) },
      { name: 'KeyName', label: '키 페어 (로그인)', type: 'select', options: [['', '키 페어 없이 진행'], ...KeyPairs.map((k) => k.KeyName)], hint: KeyPairs.length ? '' : '키 페어가 없습니다. 실제 SSH 접속에는 키가 필요하지만 시뮬레이터에서는 없이도 진행됩니다.' },
      { name: 'VpcId', label: 'VPC', type: 'select', options: Vpcs.map((v) => [v.VpcId, `${nameTag(v) || (v.IsDefault ? '(기본)' : '')} ${v.VpcId} ${v.CidrBlock}`]), value: defaultVpc, onChange: (v) => { const sel = document.querySelector('[data-field=SubnetId] select'); sel.innerHTML = ''; for (const [val, label] of subnetOpts(v)) sel.appendChild(h('option', { value: val }, label)); const sg = document.querySelector('[data-field=SecurityGroupIds]'); sg.querySelectorAll('label').forEach((l) => { l.style.display = SecurityGroups.find((g) => g.GroupId === l.querySelector('input').value).VpcId === v ? '' : 'none'; }); } },
      { name: 'SubnetId', label: '서브넷', type: 'select', options: subnetOpts(defaultVpc) },
      { name: 'AssociatePublicIpAddress', label: '퍼블릭 IP 자동 할당', type: 'select', options: [['', '서브넷 설정 따름'], ['true', '활성화'], ['false', '비활성화']] },
      { name: 'SecurityGroupIds', label: '보안 그룹 (방화벽)', type: 'multiselect', options: SecurityGroups.map((g) => [g.GroupId, `${g.GroupName} (${g.GroupId}) — ${g.IpPermissions.length}개 인바운드 규칙`]), hint: '선택하지 않으면 VPC 의 default 보안 그룹이 사용됩니다.' },
      { name: 'VolumeSize', label: '루트 볼륨 크기 (GiB)', type: 'number', value: 8, min: 8 },
      { name: 'preset', label: '사용자 데이터 템플릿', type: 'select', options: Object.keys(USERDATA).map((k) => [k, k || '(없음)']), onChange: (v) => { document.querySelector('[data-field=UserData] textarea').value = USERDATA[v]; } },
      { name: 'UserData', label: '사용자 데이터 (첫 부팅 시 실행되는 스크립트)', type: 'code', rows: 6 },
      { name: 'Count', label: '인스턴스 개수', type: 'number', value: 1, min: 1, max: 10 },
    ], onSubmit: async (v) => {
      const sgSel = [...document.querySelectorAll('[data-field=SecurityGroupIds] input:checked')].map((c) => c.value);
      const p = { ImageId: v.ImageId, InstanceType: v.InstanceType, MinCount: v.Count, MaxCount: v.Count, SubnetId: v.SubnetId, UserData: v.UserData, BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: v.VolumeSize } }], TagSpecifications: v.name ? [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: v.name }] }] : [] };
      if (v.KeyName) p.KeyName = v.KeyName;
      if (sgSel.length) p.SecurityGroupIds = sgSel;
      if (v.AssociatePublicIpAddress) p.AssociatePublicIpAddress = v.AssociatePublicIpAddress === 'true';
      const r = await api('ec2', 'RunInstances', p);
      toast(`${r.Instances.length}개 인스턴스를 시작했습니다 (pending → running 약 3초).`, 'success');
      App.navigate(`#/ec2/instances/${r.Instances[0].InstanceId}`);
    } });
  }

  async function instanceDetail(id, sub = 'details') {
    const { Reservations } = await api('ec2', 'DescribeInstances', { InstanceIds: [id] });
    const i = Reservations[0] && Reservations[0].Instances[0];
    if (!i) return h('div', null, '인스턴스가 없습니다.');
    const base = `#/ec2/instances/${id}`;
    const st = i.State.Name;
    const act = (action, label, enabled, cls = '') => h('button', { class: cls, disabled: !enabled, onclick: async () => { if (action === 'TerminateInstances' && !(await confirm(`${id} 를 종료(삭제)할까요? 되돌릴 수 없습니다.`, '종료'))) return; await api('ec2', action, { InstanceIds: [id] }); toast(`${label} 요청됨`, 'success'); setTimeout(App.refresh, 300); } }, label);
    const actions = h('div', { class: 'btn-row' }, act('StartInstances', '시작', st === 'stopped'), act('StopInstances', '중지', st === 'running'), act('RebootInstances', '재부팅', st === 'running'), act('TerminateInstances', '종료', !['terminated', 'shutting-down'].includes(st), 'danger'), h('a', { class: 'btn', href: base + '/connect' }, '연결'), h('button', { onclick: () => reachTest(i) }, '연결 테스트 (80/22)'));
    if (['pending', 'stopping', 'shutting-down'].includes(st)) App.poll(async () => { const r = await api('ec2', 'DescribeInstances', { InstanceIds: [id] }, { silent: true }); if (r.Reservations[0].Instances[0].State.Name !== st) App.refresh(); }, 1500);
    const { Volumes } = await api('ec2', 'DescribeVolumes');
    const sections = {
      details: h('div', null, card('인스턴스 요약', kv([['인스턴스 ID', h('span', null, id, ' ', App.copyBtn(id))], ['상태', stateBadge(i.State)], ['인스턴스 유형', i.InstanceType], ['AMI', i.ImageId], ['퍼블릭 IPv4 주소', i.PublicIpAddress ? h('span', null, i.PublicIpAddress, i.ElasticIp ? badge('탄력적 IP', 'blue') : null) : h('span', { class: 'muted' }, '없음')], ['퍼블릭 DNS', i.PublicDnsName], ['프라이빗 IPv4', i.PrivateIpAddress], ['프라이빗 DNS', i.PrivateDnsName], ['VPC', h('a', { href: `#/vpc/vpcs/${i.VpcId}` }, i.VpcId)], ['서브넷', i.SubnetId], ['가용 영역', i.Placement.AvailabilityZone], ['키 페어', i.KeyName || '-'], ['보안 그룹', h('span', null, i.SecurityGroups.map((g) => [h('a', { href: `#/ec2/sgs/${g.GroupId}` }, g.GroupName), ' ']))], ['IAM 역할', i.IamInstanceProfile ? i.IamInstanceProfile.Arn.split('/').pop() : '-'], ['시작 시간', fmtDate(i.LaunchTime)], ['플랫폼', i.PlatformDetails]])),
        i.UserData ? card('사용자 데이터', h('pre', null, i.UserData)) : null,
        card('태그', [table({ columns: [{ key: 'Key', label: '키' }, { key: 'Value', label: '값' }], rows: i.Tags || [], empty: '태그가 없습니다.' })], [h('button', { onclick: () => modal({ title: '태그 추가/수정', fields: [{ name: 'Key', label: '키', required: true, value: 'Name', datalist: ['Name', 'Environment', 'SimLoad'] }, { name: 'Value', label: '값', required: true, hint: 'SimLoad=high 로 두면 CPU 지표가 85% 이상으로 올라갑니다 (CloudWatch 경보 실습용).' }], submitLabel: '저장', onSubmit: async (v) => { await api('ec2', 'CreateTags', { Resources: [id], Tags: [v] }); App.refresh(); } }) }, '태그 관리')])),
      connect: connectPanel(i),
      monitoring: monitoringPanel(i),
      storage: card('스토리지 (EBS)', table({ columns: [{ label: '디바이스', render: (v) => v.Attachments[0].Device }, { key: 'VolumeId', label: '볼륨 ID' }, { label: '크기', render: (v) => v.Size + ' GiB' }, { key: 'VolumeType', label: '유형' }, { label: '종료 시 삭제', render: (v) => (v.Attachments[0].DeleteOnTermination ? '예' : '아니요') }], rows: Volumes.filter((v) => v.Attachments.some((a) => a.InstanceId === id)) })),
    };
    return h('div', null, breadcrumb(['EC2', '#/ec2'], ['인스턴스', '#/ec2/instances'], id), h('h1', null, nameTag(i) || id, ' ', stateBadge(i.State)), actions, h('br'),
      tabs([{ id: 'details', label: '세부 정보' }, { id: 'connect', label: '연결 (셸)' }, { id: 'monitoring', label: '모니터링' }, { id: 'storage', label: '스토리지' }], sub, base), sections[sub] || sections.details);
  }
  async function reachTest(i) {
    const r80 = await api('ec2', 'CheckReachability', { InstanceId: i.InstanceId, Port: 80 });
    const r22 = await api('ec2', 'CheckReachability', { InstanceId: i.InstanceId, Port: 22 });
    const show = (r) => h('div', null, h('h3', null, `TCP ${r.Port}: `, r.Reachable ? badge('도달 가능', 'green') : badge('도달 불가', 'red')), h('ul', { class: 'steps' }, r.Steps.map((s) => h('li', { class: s.ok ? 'ok' : 'todo' }, s.ok ? '✔ ' : '✖ ', s.label, s.hint ? h('div', { class: 'small err' }, s.hint) : null))));
    return modal({ title: '인터넷에서 인스턴스 도달성 검사', wide: true, body: h('div', null, h('p', { class: 'muted small' }, '실제 AWS 의 "Reachability Analyzer" 를 단순화한 것입니다. 퍼블릭 IP · IGW · 라우팅 · 보안 그룹 4가지를 차례로 확인합니다.'), show(r80), show(r22)) });
  }
  function connectPanel(i) {
    const term = h('div', { class: 'terminal' });
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: false });
    const user = { 'ami-0e9bfdb247cc8de84': 'ubuntu', 'ami-0f4fa8ee2b1a1dc4b': 'Administrator' }[i.ImageId] || 'ec2-user';
    const host = `ip-${(i.PrivateIpAddress || '').replace(/\./g, '-')}`;
    const prompt = () => h('div', null, h('span', { class: 'prompt' }, `[${user}@${host} ~]$ `), input);
    const hist = [];
    let hi = 0;
    const write = (text) => { const d = h('div', null, text); term.insertBefore(d, term.lastChild); };
    const run = async () => {
      const cmd = input.value; input.value = ''; hist.push(cmd); hi = hist.length;
      write(h('div', null, h('span', { class: 'prompt' }, `[${user}@${host} ~]$ `), cmd));
      if (cmd.trim() === 'clear') { term.querySelectorAll(':scope > div:not(:last-child)').forEach((d) => d.remove()); return; }
      const r = await api('ec2', 'RunShellCommand', { InstanceId: i.InstanceId, Command: cmd }, { silent: true }).catch((e) => ({ Output: e.message }));
      if (r.Output) write(r.Output);
      term.scrollTop = term.scrollHeight;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); input.value = hist[hi] || ''; } if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; } });
    term.appendChild(h('div', null, i.State.Name === 'running' ? `ssh -i ${i.KeyName || 'key'}.pem ${user}@${i.PublicIpAddress || i.PrivateIpAddress}\n   ,     #_\n   ~\\_  ####_        Amazon Linux (simulated)\n  ~~  \\_#####\\\n  ~~     \\###|\n  ~~       \\#/ ___\n   ~~       V~' '->\n    ~~~         /\n      ~~._.   _/\n         _/ _/\n       _/m/'\n'cat README.txt' 로 지원 명령을 확인하세요.` : `ssh: connect to host ${i.PublicIpAddress || i.PrivateIpAddress} port 22: 인스턴스가 ${i.State.Name} 상태입니다.`));
    term.appendChild(prompt());
    term.addEventListener('click', () => input.focus());
    setTimeout(() => input.focus(), 100);
    return card('EC2 Instance Connect (시뮬레이션 셸)', [h('p', { class: 'muted small' }, '실제 SSH 가 아닌, 학습용 가짜 셸입니다. 인스턴스 메타데이터(curl http://169.254.169.254/latest/meta-data/), 사용자 데이터 로그, 다른 인스턴스로의 curl(보안 그룹 검사) 등을 체험할 수 있습니다.'), term, h('div', { class: 'btn-row', style: { marginTop: '8px' } }, h('button', { onclick: async () => { const r = await api('ec2', 'GetConsoleOutput', { InstanceId: i.InstanceId }); App.showJson('시스템 로그 (콘솔 출력)', atob(r.Output)); } }, '시스템 로그 보기'))]);
  }
  function monitoringPanel(i) {
    const box = h('div');
    const draw = async () => {
      const end = new Date(), start = new Date(Date.now() - 30 * 60000);
      const [cpu, net] = await Promise.all([api('cloudwatch', 'GetMetricStatistics', { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: i.InstanceId }], StartTime: start.toISOString(), EndTime: end.toISOString(), Period: 60, Statistics: ['Average', 'Maximum'] }, { silent: true }), api('cloudwatch', 'GetMetricStatistics', { Namespace: 'AWS/EC2', MetricName: 'NetworkIn', Dimensions: [{ Name: 'InstanceId', Value: i.InstanceId }], StartTime: start.toISOString(), EndTime: end.toISOString(), Period: 60, Statistics: ['Sum'] }, { silent: true })]);
      box.innerHTML = '';
      box.appendChild(h('div', { class: 'two-col' }, h('div', { class: 'metric-box' }, h('b', null, 'CPUUtilization (%)'), App.chart([{ label: 'Average', points: cpu.Datapoints.map((d) => ({ x: Date.parse(d.Timestamp), y: d.Average })) }, { label: 'Maximum', points: cpu.Datapoints.map((d) => ({ x: Date.parse(d.Timestamp), y: d.Maximum })) }], { unit: '%' })), h('div', { class: 'metric-box' }, h('b', null, 'NetworkIn (Bytes/min)'), App.chart([{ label: 'Sum', points: net.Datapoints.map((d) => ({ x: Date.parse(d.Timestamp), y: d.Sum })) }]))));
    };
    draw(); App.poll(draw, 10000);
    return card('모니터링 (CloudWatch 지표 · 10초마다 갱신)', [h('p', { class: 'muted small' }, '실행 중인 인스턴스는 10초마다 지표가 생성됩니다. 태그 SimLoad=high 또는 사용자 데이터에 "stress" 가 있으면 CPU 가 85%+ 로 올라갑니다.'), box, h('a', { href: '#/cloudwatch/alarms' }, 'CloudWatch 에서 경보 만들기 →')]);
  }
  async function sgDetail(gid) {
    const { SecurityGroups } = await api('ec2', 'DescribeSecurityGroups', { GroupIds: [gid] });
    const g = SecurityGroups[0];
    const fmtPerm = (p) => (p.IpProtocol === '-1' ? '모든 트래픽' : `${p.IpProtocol.toUpperCase()} ${p.FromPort === p.ToPort ? p.FromPort : p.FromPort + '-' + p.ToPort}`);
    const rules = g.IpPermissions.flatMap((p) => [...p.IpRanges.map((r) => ({ p, src: r.CidrIp, desc: r.Description })), ...p.UserIdGroupPairs.map((u) => ({ p, src: u.GroupId, sg: true }))]);
    const PRESETS = { ssh: ['tcp', 22], http: ['tcp', 80], https: ['tcp', 443], rdp: ['tcp', 3389], mysql: ['tcp', 3306], postgres: ['tcp', 5432], all: ['-1', 0], icmp: ['icmp', -1] };
    return h('div', null, breadcrumb(['EC2', '#/ec2'], ['보안 그룹', '#/ec2/sgs'], g.GroupName), h('h1', null, g.GroupName, ' ', h('span', { class: 'muted', style: { fontSize: '14px' } }, g.GroupId), g.GroupName !== 'default' ? h('button', { class: 'danger', style: { float: 'right' }, onclick: async () => { if (await confirm('보안 그룹을 삭제할까요?')) { await api('ec2', 'DeleteSecurityGroup', { GroupId: gid }); App.navigate('#/ec2/sgs'); } } }, '삭제') : null),
      card('세부 정보', kv([['설명', g.Description], ['VPC', h('a', { href: `#/vpc/vpcs/${g.VpcId}` }, g.VpcId)], ['소유자', g.OwnerId]])),
      card('인바운드 규칙', [h('p', { class: 'muted small' }, '보안 그룹은 상태 저장(stateful) 방화벽입니다. 인바운드를 허용하면 응답 트래픽은 자동 허용됩니다. 기본은 모두 거부(허용 규칙만 존재).'), table({ columns: [{ label: '유형', render: (r) => fmtPerm(r.p) }, { label: '프로토콜', render: (r) => (r.p.IpProtocol === '-1' ? '전체' : r.p.IpProtocol) }, { label: '포트 범위', render: (r) => (r.p.IpProtocol === '-1' ? '전체' : `${r.p.FromPort}-${r.p.ToPort}`) }, { label: '소스', render: (r) => (r.sg ? h('a', { href: `#/ec2/sgs/${r.src}` }, r.src) : r.src) }, { key: 'desc', label: '설명' }, { label: '', render: (r) => h('button', { class: 'sm danger', onclick: async () => { await api('ec2', 'RevokeSecurityGroupIngress', { GroupId: gid, IpProtocol: r.p.IpProtocol, FromPort: r.p.FromPort, ToPort: r.p.ToPort, CidrIp: r.sg ? undefined : r.src, SourceSecurityGroupId: r.sg ? r.src : undefined }); App.refresh(); } }, '삭제') }], rows: rules, empty: '인바운드 규칙이 없습니다 — 외부에서 어떤 트래픽도 들어올 수 없습니다.' })],
        [h('button', { class: 'primary', onclick: () => modal({ title: '인바운드 규칙 추가', fields: [{ name: 'type', label: '유형', type: 'select', options: [['ssh', 'SSH (TCP 22)'], ['http', 'HTTP (TCP 80)'], ['https', 'HTTPS (TCP 443)'], ['rdp', 'RDP (TCP 3389)'], ['mysql', 'MySQL/Aurora (TCP 3306)'], ['postgres', 'PostgreSQL (TCP 5432)'], ['custom', '사용자 지정 TCP'], ['all', '모든 트래픽'], ['icmp', '모든 ICMP']] }, { name: 'port', label: '포트 (사용자 지정 TCP 일 때, 예: 8080 또는 8000-8100)', value: '8080' }, { name: 'srcType', label: '소스 유형', type: 'select', options: [['cidr', 'CIDR'], ['sg', '보안 그룹']] }, { name: 'src', label: '소스', value: '0.0.0.0/0', hint: '0.0.0.0/0 = 어디서나 (IPv4). 내 IP 만 허용하려면 x.x.x.x/32. 보안 그룹 ID(sg-…)를 소스로 쓰면 그 그룹의 인스턴스만 허용.' }, { name: 'Description', label: '설명' }], submitLabel: '규칙 추가', onSubmit: async (v) => { const p = { GroupId: gid, Description: v.Description }; if (v.type === 'custom') { const [a, b] = v.port.split('-'); p.IpProtocol = 'tcp'; p.FromPort = Number(a); p.ToPort = Number(b || a); } else { const [proto, port] = PRESETS[v.type]; p.IpProtocol = proto; p.FromPort = port; p.ToPort = port; } if (v.srcType === 'sg') p.SourceSecurityGroupId = v.src; else p.CidrIp = v.src; await api('ec2', 'AuthorizeSecurityGroupIngress', p); App.refresh(); } }) }, '인바운드 규칙 추가')]),
      card('아웃바운드 규칙', table({ columns: [{ label: '유형', render: (p) => fmtPerm(p) }, { label: '대상', render: (p) => p.IpRanges.map((r) => r.CidrIp).join(', ') }], rows: g.IpPermissionsEgress })), cli(`awsim ec2 authorize-security-group-ingress --group-id ${gid} --protocol tcp --port 80 --cidr 0.0.0.0/0`));
  }
})();
