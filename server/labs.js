'use strict';
// 실습 미션 정의 + 자동 채점
const store = require('./store');
const vpc = require('./services/vpc');
const ec2 = require('./services/ec2');
const s3 = require('./services/s3');
const iam = require('./services/iam');

const has = (k) => ((store.get().labs.counts || {})[k] || 0) > 0;
const tagName = (r, n) => (r.Tags || []).some((t) => t.Key === 'Name' && t.Value === n);

const LABS = [
  {
    id: 's3-basics', level: 1, service: 'S3', title: 'S3 첫걸음: 버킷 만들고 파일 올리기', minutes: 5,
    description: 'S3는 객체 스토리지입니다. 버킷(최상위 컨테이너)을 만들고 그 안에 객체(파일)를 업로드합니다. 버킷 이름 규칙(소문자/숫자/하이픈, 전 세계 고유)을 몸으로 익혀 보세요.',
    steps: [
      { label: '버킷을 하나 이상 생성한다', check: (s) => s.s3.buckets.length > 0 },
      { label: '아무 버킷에 hello.txt 객체를 업로드한다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.Key === 'hello.txt' && o.IsLatest && !o.DeleteMarker)) },
      { label: 'docs/ 접두사(폴더) 아래에 객체를 하나 올린다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.Key.startsWith('docs/') && o.IsLatest)) },
      { label: 'ListObjectsV2 로 객체 목록을 조회한다', check: () => has('s3:ListObjectsV2') },
    ],
    cli: ['awsim s3 mb s3://my-first-bucket-2026', 'awsim s3api put-object --bucket my-first-bucket-2026 --key hello.txt --body "안녕하세요 S3"', 'awsim s3api put-object --bucket my-first-bucket-2026 --key docs/readme.md --body "# docs"', 'awsim s3 ls s3://my-first-bucket-2026'],
  },
  {
    id: 's3-website', level: 2, service: 'S3', title: 'S3 정적 웹 사이트 호스팅', minutes: 10,
    description: 'HTML 파일을 S3에 올리고 정적 웹 사이트로 공개합니다. "퍼블릭 액세스 차단" 해제 → 퍼블릭 읽기 버킷 정책 → 웹 사이트 호스팅 활성화 순서를 익힙니다. 완료 후 /s3-website/<버킷>/ 에 접속해 보세요.',
    steps: [
      { label: '버킷에 index.html 객체를 업로드한다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.Key === 'index.html' && o.IsLatest)) },
      { label: '그 버킷의 퍼블릭 액세스 차단(BlockPublicPolicy)을 해제한다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.Key === 'index.html') && !b.PublicAccessBlock.BlockPublicPolicy) },
      { label: 'Principal "*" 에 s3:GetObject 를 허용하는 버킷 정책을 추가한다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.Key === 'index.html') && s3.isPublicRead(b, 'index.html').allowed) },
      { label: '정적 웹 사이트 호스팅을 활성화한다 (IndexDocument=index.html)', check: (s) => s.s3.buckets.some((b) => b.Website && b.Website.IndexDocument.Suffix === 'index.html' && s3.isPublicRead(b, 'index.html').allowed) },
    ],
    cli: ['awsim s3 mb s3://my-site-2026', 'awsim s3api put-object --bucket my-site-2026 --key index.html --body "<h1>Hello</h1>" --content-type text/html', 'awsim s3api put-public-access-block --bucket my-site-2026 --public-access-block-configuration "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"', 'awsim s3api put-bucket-policy --bucket my-site-2026 --policy \'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::my-site-2026/*"}]}\'', 'awsim s3api put-bucket-website --bucket my-site-2026 --website-configuration \'{"IndexDocument":{"Suffix":"index.html"}}\''],
  },
  {
    id: 's3-versioning', level: 2, service: 'S3', title: 'S3 버전 관리로 실수 복구하기', minutes: 5,
    description: '버전 관리를 켜면 같은 키에 덮어써도 이전 버전이 남습니다. 객체를 두 번 올려 두 개의 버전을 만들고, 삭제 마커의 동작을 확인해 보세요.',
    steps: [
      { label: '버킷의 버전 관리를 Enabled 로 설정한다', check: (s) => s.s3.buckets.some((b) => b.Versioning === 'Enabled') },
      { label: '버전 관리 버킷에서 같은 키로 2번 이상 업로드해 버전이 2개 이상인 객체를 만든다', check: (s) => s.s3.buckets.some((b) => b.Versioning === 'Enabled' && Object.values(b.Objects.filter((o) => !o.DeleteMarker).reduce((m, o) => ((m[o.Key] = (m[o.Key] || 0) + 1), m), {})).some((n) => n >= 2)) },
      { label: '객체를 삭제해 삭제 마커(DeleteMarker)를 만든다', check: (s) => s.s3.buckets.some((b) => b.Objects.some((o) => o.DeleteMarker)) },
      { label: 'ListObjectVersions 로 버전 목록을 조회한다', check: () => has('s3:ListObjectVersions') },
    ],
    cli: ['awsim s3api put-bucket-versioning --bucket my-first-bucket-2026 --versioning-configuration Status=Enabled', 'awsim s3api put-object --bucket my-first-bucket-2026 --key notes.txt --body "v1"', 'awsim s3api put-object --bucket my-first-bucket-2026 --key notes.txt --body "v2"', 'awsim s3api delete-object --bucket my-first-bucket-2026 --key notes.txt', 'awsim s3api list-object-versions --bucket my-first-bucket-2026'],
  },
  {
    id: 'iam-least-privilege', level: 1, service: 'IAM', title: 'IAM 최소 권한: 읽기 전용 개발자 계정', minutes: 10,
    description: 'IAM 사용자 → 그룹 → 정책 구조를 만듭니다. 그룹에 AmazonS3ReadOnlyAccess 를 붙이고, 정책 시뮬레이터로 GetObject 는 허용, PutObject 는 거부되는지 확인합니다.',
    steps: [
      { label: 'IAM 사용자 dev-user 를 만든다', check: (s) => s.iam.users.some((u) => u.UserName === 'dev-user') },
      { label: 'IAM 그룹 developers 를 만들고 dev-user 를 넣는다', check: (s) => s.iam.users.some((u) => u.UserName === 'dev-user' && u.Groups.includes('developers')) },
      { label: 'developers 그룹에 AmazonS3ReadOnlyAccess 관리형 정책을 연결한다', check: (s) => s.iam.groups.some((g) => g.GroupName === 'developers' && g.AttachedPolicies.includes('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')) },
      { label: 'dev-user 의 액세스 키를 발급한다', check: (s) => s.iam.accessKeys.some((k) => k.UserName === 'dev-user') },
      { label: '정책 시뮬레이터로 dev-user 의 s3:GetObject 허용 / s3:PutObject 거부를 확인한다', check: (s) => has('iam:SimulatePrincipalPolicy') && s.iam.users.some((u) => u.UserName === 'dev-user') && iam.isAllowed(iam.userArn('dev-user'), 's3:GetObject') && !iam.isAllowed(iam.userArn('dev-user'), 's3:PutObject') },
    ],
    cli: ['awsim iam create-user --user-name dev-user', 'awsim iam create-group --group-name developers', 'awsim iam add-user-to-group --group-name developers --user-name dev-user', 'awsim iam attach-group-policy --group-name developers --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess', 'awsim iam create-access-key --user-name dev-user', 'awsim iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/dev-user --action-names s3:GetObject s3:PutObject'],
  },
  {
    id: 'iam-policy-author', level: 2, service: 'IAM', title: 'IAM 고객 관리형 정책 직접 작성하기', minutes: 10,
    description: '특정 버킷(arn:aws:s3:::team-data/*)에만 쓰기를 허용하는 JSON 정책을 직접 작성하고, 명시적 Deny 가 Allow 보다 우선하는 것을 확인합니다.',
    steps: [
      { label: 'team-data-writer 라는 고객 관리형 정책을 만든다 (s3:PutObject 를 arn:aws:s3:::team-data/* 에 Allow)', check: (s) => s.iam.policies.some((p) => p.PolicyName === 'team-data-writer' && p.Scope === 'Local' && iam.evaluate([{ doc: p.Document, source: 'x' }], 's3:PutObject', 'arn:aws:s3:::team-data/report.csv').decision === 'allowed') },
      { label: '그 정책에 s3:DeleteObject 를 Deny 하는 Statement 를 포함한다', check: (s) => s.iam.policies.some((p) => p.PolicyName === 'team-data-writer' && iam.evaluate([{ doc: p.Document, source: 'x' }], 's3:DeleteObject', 'arn:aws:s3:::team-data/report.csv').decision === 'explicitDeny') },
      { label: '정책을 사용자(아무나)에게 연결한다', check: (s) => { const p = s.iam.policies.find((x) => x.PolicyName === 'team-data-writer'); return !!p && s.iam.users.some((u) => u.AttachedPolicies.includes(p.Arn)); } },
      { label: '정책 시뮬레이터로 다른 버킷(arn:aws:s3:::other/*)에 대한 PutObject 가 implicitDeny 인지 확인한다', check: (s) => { const p = s.iam.policies.find((x) => x.PolicyName === 'team-data-writer'); const u = p && s.iam.users.find((x) => x.AttachedPolicies.includes(p.Arn)); return !!u && has('iam:SimulatePrincipalPolicy') && !iam.isAllowed(u.Arn, 's3:PutObject', 'arn:aws:s3:::other/file'); } },
    ],
    cli: ['awsim iam create-policy --policy-name team-data-writer --policy-document \'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],"Resource":"arn:aws:s3:::team-data/*"},{"Effect":"Deny","Action":"s3:DeleteObject","Resource":"*"}]}\'', 'awsim iam attach-user-policy --user-name dev-user --policy-arn arn:aws:iam::123456789012:policy/team-data-writer', 'awsim iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/dev-user --action-names s3:PutObject --resource-arns arn:aws:s3:::other/file'],
  },
  {
    id: 'vpc-build', level: 2, service: 'VPC', title: '나만의 VPC 네트워크 구축 (퍼블릭/프라이빗 서브넷)', minutes: 15,
    description: '10.0.0.0/16 VPC 에 퍼블릭 서브넷(10.0.1.0/24)과 프라이빗 서브넷(10.0.2.0/24)을 만듭니다. 인터넷 게이트웨이를 연결하고 퍼블릭 서브넷에만 0.0.0.0/0 → IGW 라우팅을 연결하는 것이 핵심입니다.',
    steps: [
      { label: 'CIDR 10.0.0.0/16 VPC 를 만들고 Name 태그를 lab-vpc 로 지정한다', check: (s) => s.vpc.vpcs.some((v) => v.CidrBlock === '10.0.0.0/16' && tagName(v, 'lab-vpc')) },
      { label: 'lab-vpc 에 서브넷 10.0.1.0/24 와 10.0.2.0/24 를 만든다', check: (s) => { const v = s.vpc.vpcs.find((x) => tagName(x, 'lab-vpc')); return !!v && ['10.0.1.0/24', '10.0.2.0/24'].every((c) => s.vpc.subnets.some((sn) => sn.VpcId === v.VpcId && sn.CidrBlock === c)); } },
      { label: '인터넷 게이트웨이를 만들어 lab-vpc 에 연결한다', check: (s) => { const v = s.vpc.vpcs.find((x) => tagName(x, 'lab-vpc')); return !!v && s.vpc.igws.some((g) => g.Attachments.some((a) => a.VpcId === v.VpcId)); } },
      { label: '새 라우팅 테이블에 0.0.0.0/0 → IGW 경로를 추가하고 10.0.1.0/24 서브넷에 연결한다 (10.0.1.0/24 가 퍼블릭이 됨)', check: (s) => { const v = s.vpc.vpcs.find((x) => tagName(x, 'lab-vpc')); const sn = v && s.vpc.subnets.find((x) => x.VpcId === v.VpcId && x.CidrBlock === '10.0.1.0/24'); const rtb = sn && vpc.routeTableForSubnet(sn); return !!sn && vpc.subnetIsPublic(sn) && rtb && !rtb.Associations.some((a) => a.Main); } },
      { label: '10.0.2.0/24 서브넷은 프라이빗(IGW 경로 없음)으로 유지한다', check: (s) => { const v = s.vpc.vpcs.find((x) => tagName(x, 'lab-vpc')); const sn = v && s.vpc.subnets.find((x) => x.VpcId === v.VpcId && x.CidrBlock === '10.0.2.0/24'); return !!sn && !vpc.subnetIsPublic(sn); } },
      { label: '퍼블릭 서브넷의 "퍼블릭 IPv4 주소 자동 할당" 을 켠다', check: (s) => { const v = s.vpc.vpcs.find((x) => tagName(x, 'lab-vpc')); const sn = v && s.vpc.subnets.find((x) => x.VpcId === v.VpcId && x.CidrBlock === '10.0.1.0/24'); return !!sn && sn.MapPublicIpOnLaunch; } },
    ],
    cli: ['awsim ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications \'ResourceType=vpc,Tags=[{Key=Name,Value=lab-vpc}]\'', 'awsim ec2 create-subnet --vpc-id <vpc-id> --cidr-block 10.0.1.0/24', 'awsim ec2 create-subnet --vpc-id <vpc-id> --cidr-block 10.0.2.0/24', 'awsim ec2 create-internet-gateway', 'awsim ec2 attach-internet-gateway --internet-gateway-id <igw-id> --vpc-id <vpc-id>', 'awsim ec2 create-route-table --vpc-id <vpc-id>', 'awsim ec2 create-route --route-table-id <rtb-id> --destination-cidr-block 0.0.0.0/0 --gateway-id <igw-id>', 'awsim ec2 associate-route-table --route-table-id <rtb-id> --subnet-id <public-subnet-id>', 'awsim ec2 modify-subnet-attribute --subnet-id <public-subnet-id> --map-public-ip-on-launch'],
  },
  {
    id: 'ec2-webserver', level: 2, service: 'EC2', title: 'EC2 웹 서버 띄우기 (보안 그룹 + 사용자 데이터)', minutes: 15,
    description: '키 페어와 보안 그룹(SSH 22, HTTP 80 허용)을 만들고, 사용자 데이터로 웹 서버(httpd/nginx)를 설치하는 인스턴스를 퍼블릭 서브넷에서 실행합니다. 연결 테스트로 80 포트 도달성을 확인하세요.',
    steps: [
      { label: '키 페어를 하나 만든다', check: (s, r) => s.ec2.keyPairs.some((k) => k.Region === r) },
      { label: 'web-sg 보안 그룹을 만들고 0.0.0.0/0 에서 TCP 22, 80 인바운드를 허용한다', check: (s, r) => s.ec2.securityGroups.some((g) => g.Region === r && g.GroupName === 'web-sg' && [22, 80].every((port) => g.IpPermissions.some((p) => (p.IpProtocol === '-1' || (p.IpProtocol === 'tcp' && p.FromPort <= port && p.ToPort >= port)) && p.IpRanges.some((x) => x.CidrIp === '0.0.0.0/0')))) },
      { label: 'web-sg 를 사용하고 사용자 데이터에 httpd 또는 nginx 설치 스크립트가 있는 인스턴스를 실행한다', check: (s, r) => s.ec2.instances.some((i) => i.Region === r && i.State.Name !== 'terminated' && i.SecurityGroups.some((g) => g.GroupName === 'web-sg') && /httpd|nginx|apache/.test(i.UserData || '')) },
      { label: '그 인스턴스가 running 상태이고 퍼블릭 IP를 가진다', check: (s, r) => s.ec2.instances.some((i) => i.Region === r && i.State.Name === 'running' && i.PublicIpAddress && i.SecurityGroups.some((g) => g.GroupName === 'web-sg')) },
      { label: '연결 테스트(CheckReachability)로 80 포트 도달 가능을 확인한다', check: (s, r) => has('ec2:CheckReachability') && s.ec2.instances.some((i) => i.Region === r && i.State.Name === 'running' && i.SecurityGroups.some((g) => g.GroupName === 'web-sg') && ec2.reachability(i, 80, '0.0.0.0').Reachable) },
    ],
    cli: ['awsim ec2 create-key-pair --key-name lab-key', 'awsim ec2 create-security-group --group-name web-sg --description "web server"', 'awsim ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 22 --cidr 0.0.0.0/0', 'awsim ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 80 --cidr 0.0.0.0/0', 'awsim ec2 run-instances --image-id ami-0c9c942bd7bf113a2 --instance-type t2.micro --key-name lab-key --security-groups web-sg --user-data "#!/bin/bash\\nyum install -y httpd\\nsystemctl start httpd"', 'awsim ec2 check-reachability --instance-id <instance-id> --port 80'],
  },
  {
    id: 'ec2-lifecycle', level: 3, service: 'EC2', title: 'EC2 수명 주기: 중지/시작, EBS 추가, 탄력적 IP', minutes: 15,
    description: '인스턴스를 중지하면 퍼블릭 IP가 바뀝니다. 탄력적 IP(EIP)를 연결해 고정 IP를 유지하고, 같은 AZ에 EBS 볼륨을 만들어 추가로 연결해 보세요.',
    steps: [
      { label: '실행 중인 인스턴스를 중지(stopped)했다가 다시 시작한다', check: (s) => s.history.some((h) => h.action === 'StopInstances') && s.history.some((h) => h.action === 'StartInstances') },
      { label: '탄력적 IP를 할당하고 실행 중인 인스턴스에 연결한다', check: (s, r) => s.ec2.addresses.some((a) => a.Region === r && a.InstanceId) },
      { label: '8GiB 이상의 EBS 볼륨을 새로 만든다', check: (s, r) => s.ec2.volumes.some((v) => v.Region === r && !v.Attachments.some((a) => a.Device === '/dev/xvda')) },
      { label: '그 볼륨을 같은 AZ의 인스턴스에 추가 디바이스(/dev/sdf 등)로 연결한다', check: (s, r) => s.ec2.volumes.some((v) => v.Region === r && v.Attachments.some((a) => a.Device !== '/dev/xvda' && a.State === 'attached')) },
      { label: '인스턴스에 Name 태그를 붙인다', check: (s, r) => s.ec2.instances.some((i) => i.Region === r && i.State.Name !== 'terminated' && (i.Tags || []).some((t) => t.Key === 'Name' && t.Value)) },
    ],
    cli: ['awsim ec2 stop-instances --instance-ids <id>', 'awsim ec2 start-instances --instance-ids <id>', 'awsim ec2 allocate-address', 'awsim ec2 associate-address --instance-id <id> --allocation-id <eipalloc-id>', 'awsim ec2 create-volume --availability-zone ap-northeast-2a --size 10', 'awsim ec2 attach-volume --volume-id <vol-id> --instance-id <id> --device /dev/sdf', 'awsim ec2 create-tags --resources <id> --tags Key=Name,Value=web-1'],
  },
  {
    id: 'lambda-hello', level: 1, service: 'Lambda', title: 'Lambda 함수 만들고 호출하기', minutes: 10,
    description: 'Lambda 는 서버 없이 코드를 실행합니다. 먼저 lambda.amazonaws.com 을 신뢰하는 IAM 역할을 만들고, 함수를 생성한 뒤 테스트 이벤트로 호출해 CloudWatch 로그를 확인합니다.',
    steps: [
      { label: 'lambda.amazonaws.com 을 신뢰하는 IAM 역할을 만든다', check: (s) => s.iam.roles.some((r) => r.AssumeRolePolicyDocument.Statement.some((st) => st.Effect === 'Allow' && st.Principal && [].concat(st.Principal.Service || []).includes('lambda.amazonaws.com'))) },
      { label: '그 역할에 AWSLambdaBasicExecutionRole 정책을 연결한다', check: (s) => s.iam.roles.some((r) => r.AttachedPolicies.includes('arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole')) },
      { label: 'hello-lambda 함수를 만든다', check: (s, r) => s.lambda.functions.some((f) => f.FunctionName === 'hello-lambda' && f.Region === r) },
      { label: '{"name":"AWS"} 이벤트로 호출해 성공한다', check: (s, r) => s.lambda.functions.some((f) => f.FunctionName === 'hello-lambda' && f.Region === r && (f.SuccessCount || 0) > 0) },
      { label: '함수의 CloudWatch 로그 그룹(/aws/lambda/hello-lambda)을 조회한다', check: (s) => has('logs:GetLogEvents') || has('logs:FilterLogEvents') },
    ],
    cli: ['awsim iam create-role --role-name lambda-exec --assume-role-policy-document \'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}\'', 'awsim iam attach-role-policy --role-name lambda-exec --policy-arn arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole', 'awsim lambda create-function --function-name hello-lambda --runtime nodejs20.x --role lambda-exec --handler index.handler --zip-file fileb://index.js', 'awsim lambda invoke --function-name hello-lambda --payload \'{"name":"AWS"}\' out.json', 'awsim logs filter-log-events --log-group-name /aws/lambda/hello-lambda'],
  },
  {
    id: 's3-lambda-trigger', level: 3, service: 'Lambda', title: 'S3 업로드 이벤트로 Lambda 자동 실행', minutes: 15,
    description: '이벤트 기반 아키텍처의 기본입니다. 버킷에 객체가 올라오면 Lambda 가 호출되도록 알림(Notification)을 설정하고, 업로드해서 로그에 이벤트가 찍히는지 확인합니다.',
    steps: [
      { label: '처리용 Lambda 함수(이름 자유)를 만든다', check: (s, r) => s.lambda.functions.some((f) => f.Region === r) },
      { label: '어떤 버킷에 ObjectCreated 이벤트 → Lambda 알림 구성을 추가한다', check: (s) => s.s3.buckets.some((b) => b.Notifications.some((n) => n.Type === 'lambda' && n.Events.some((e) => e.startsWith('s3:ObjectCreated')))) },
      { label: '그 버킷에 객체를 업로드해 Lambda 가 s3 이벤트로 호출된다', check: (s) => s.lambda.functions.some((f) => f.InvokeSources && f.InvokeSources.s3 > 0) },
      { label: 'Lambda 호출이 성공(오류 없음)한다', check: (s) => s.lambda.functions.some((f) => f.InvokeSources && f.InvokeSources.s3 > 0 && f.LastInvokeStatus === 'Success') },
    ],
    cli: ['awsim s3api put-bucket-notification-configuration --bucket my-first-bucket-2026 --notification-configuration \'{"LambdaFunctionConfigurations":[{"LambdaFunctionArn":"hello-lambda","Events":["s3:ObjectCreated:*"]}]}\'', 'awsim s3api put-object --bucket my-first-bucket-2026 --key uploads/photo.jpg --body "..."', 'awsim logs filter-log-events --log-group-name /aws/lambda/hello-lambda --filter-pattern "ObjectCreated"'],
  },
  {
    id: 'dynamodb-crud', level: 2, service: 'DynamoDB', title: 'DynamoDB 테이블 설계와 CRUD', minutes: 15,
    description: '파티션 키 + 정렬 키 복합 키를 가진 Orders 테이블을 만들고 항목을 넣은 뒤, Query(파티션 키 필수)와 Scan 의 차이를 체험합니다.',
    steps: [
      { label: 'Orders 테이블을 만든다 (파티션 키 customerId:S, 정렬 키 orderId:S, 온디맨드)', check: (s, r) => s.dynamodb.tables.some((t) => t.TableName === 'Orders' && t.Region === r && t.KeySchema.some((k) => k.KeyType === 'HASH' && k.AttributeName === 'customerId') && t.KeySchema.some((k) => k.KeyType === 'RANGE' && k.AttributeName === 'orderId')) },
      { label: '항목을 3개 이상 넣는다 (같은 customerId 2개 이상 포함)', check: (s) => s.dynamodb.tables.some((t) => t.TableName === 'Orders' && t.Items.length >= 3 && Object.values(t.Items.reduce((m, i) => ((m[i.customerId] = (m[i.customerId] || 0) + 1), m), {})).some((n) => n >= 2)) },
      { label: 'amount(숫자) 속성을 가진 항목이 있다', check: (s) => s.dynamodb.tables.some((t) => t.TableName === 'Orders' && t.Items.some((i) => typeof i.amount === 'number')) },
      { label: 'KeyConditionExpression 으로 특정 customerId 를 Query 한다', check: () => has('dynamodb:Query') },
      { label: 'UpdateItem 으로 항목의 status 속성을 바꾼다', check: (s) => has('dynamodb:UpdateItem') && s.dynamodb.tables.some((t) => t.TableName === 'Orders' && t.Items.some((i) => i.status)) },
    ],
    cli: ['awsim dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customerId,AttributeType=S AttributeName=orderId,AttributeType=S --key-schema AttributeName=customerId,KeyType=HASH AttributeName=orderId,KeyType=RANGE --billing-mode PAY_PER_REQUEST', 'awsim dynamodb put-item --table-name Orders --item \'{"customerId":{"S":"c1"},"orderId":{"S":"o1"},"amount":{"N":"120"}}\'', 'awsim dynamodb query --table-name Orders --key-condition-expression "customerId = :c" --expression-attribute-values \'{":c":{"S":"c1"}}\'', 'awsim dynamodb update-item --table-name Orders --key \'{"customerId":{"S":"c1"},"orderId":{"S":"o1"}}\' --update-expression "SET #s = :s" --expression-attribute-names \'{"#s":"status"}\' --expression-attribute-values \'{":s":{"S":"SHIPPED"}}\''],
  },
  {
    id: 'sns-sqs-fanout', level: 3, service: 'SNS', title: 'SNS → SQS 팬아웃 메시징', minutes: 15,
    description: '하나의 SNS 주제에 여러 SQS 대기열을 구독시키면 메시지 한 번 발행으로 여러 소비자에게 전달됩니다. 이메일 구독의 확인(Confirm) 절차도 체험합니다.',
    steps: [
      { label: 'orders 라는 SNS 주제를 만든다', check: (s, r) => s.sns.topics.some((t) => t.Name === 'orders' && t.Region === r) },
      { label: 'SQS 대기열을 2개 만든다 (예: billing-queue, shipping-queue)', check: (s, r) => s.sqs.queues.filter((q) => q.Region === r).length >= 2 },
      { label: '두 대기열 모두 orders 주제를 구독한다', check: (s) => { const t = s.sns.topics.find((x) => x.Name === 'orders'); return !!t && s.sns.subscriptions.filter((x) => x.TopicArn === t.TopicArn && x.Protocol === 'sqs').length >= 2; } },
      { label: '이메일 구독을 추가하고 확인(Confirm)한다', check: (s) => { const t = s.sns.topics.find((x) => x.Name === 'orders'); return !!t && s.sns.subscriptions.some((x) => x.TopicArn === t.TopicArn && x.Protocol.startsWith('email') && x.Status === 'Confirmed'); } },
      { label: 'orders 주제에 메시지를 발행한다', check: (s) => s.sns.topics.some((t) => t.Name === 'orders' && t.MessagesPublished > 0) },
      { label: '대기열에서 ReceiveMessage 로 메시지를 받아 본다', check: () => has('sqs:ReceiveMessage') },
    ],
    cli: ['awsim sns create-topic --name orders', 'awsim sqs create-queue --queue-name billing-queue', 'awsim sqs create-queue --queue-name shipping-queue', 'awsim sns subscribe --topic-arn arn:aws:sns:ap-northeast-2:123456789012:orders --protocol sqs --notification-endpoint arn:aws:sqs:ap-northeast-2:123456789012:billing-queue', 'awsim sns subscribe --topic-arn arn:aws:sns:ap-northeast-2:123456789012:orders --protocol email --notification-endpoint me@example.com', 'awsim sns publish --topic-arn arn:aws:sns:ap-northeast-2:123456789012:orders --message "order #1 created"', 'awsim sqs receive-message --queue-url <queue-url>'],
  },
  {
    id: 'sqs-dlq', level: 3, service: 'SQS', title: 'SQS 데드 레터 큐(DLQ)로 실패 메시지 격리', minutes: 10,
    description: '메시지를 받기만 하고 삭제하지 않으면 재수신 횟수가 올라갑니다. maxReceiveCount 를 넘으면 DLQ 로 이동하는 것을 직접 확인합니다. (가시성 제한 시간을 짧게 설정하면 빠르게 실험할 수 있습니다)',
    steps: [
      { label: 'DLQ 용 대기열(이름에 dlq 포함)을 만든다', check: (s, r) => s.sqs.queues.some((q) => q.Region === r && /dlq/i.test(q.QueueName)) },
      { label: '주 대기열에 RedrivePolicy(deadLetterTargetArn=DLQ, maxReceiveCount≤3)를 설정한다', check: (s, r) => s.sqs.queues.some((q) => q.Region === r && q.Attributes.RedrivePolicy && (() => { try { const rp = JSON.parse(q.Attributes.RedrivePolicy); return Number(rp.maxReceiveCount) <= 3 && s.sqs.queues.some((d) => d.QueueArn === rp.deadLetterTargetArn); } catch (e) { return false; } })()) },
      { label: '주 대기열에 메시지를 보낸다', check: (s) => s.sqs.queues.some((q) => q.Attributes.RedrivePolicy && (q.Messages.length > 0 || s.history.some((h) => h.action === 'SendMessage' && h.detail.includes(q.QueueName)))) },
      { label: '삭제하지 않고 반복 수신하여 메시지가 DLQ 로 이동하게 한다', check: (s) => s.sqs.queues.some((q) => /dlq/i.test(q.QueueName) && q.Messages.some((m) => m.Attributes.DeadLetterQueueSourceArn)) },
    ],
    cli: ['awsim sqs create-queue --queue-name orders-dlq', 'awsim sqs create-queue --queue-name orders-main --attributes \'{"VisibilityTimeout":"1","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:ap-northeast-2:123456789012:orders-dlq\\",\\"maxReceiveCount\\":\\"2\\"}"}\'', 'awsim sqs send-message --queue-url <main-url> --message-body "poison"', 'awsim sqs receive-message --queue-url <main-url>   # 2초 간격으로 3번 반복'],
  },
  {
    id: 'lambda-sqs-esm', level: 3, service: 'Lambda', title: 'SQS → Lambda 이벤트 소스 매핑', minutes: 10,
    description: 'Lambda 가 SQS 를 폴링해 메시지를 배치로 처리하게 합니다. 이벤트 소스 매핑을 만든 뒤 메시지를 보내면 2초 안에 함수가 호출되고 성공 시 메시지가 자동 삭제됩니다.',
    steps: [
      { label: 'Lambda 함수와 SQS 대기열을 준비한다', check: (s, r) => s.lambda.functions.some((f) => f.Region === r) && s.sqs.queues.some((q) => q.Region === r) },
      { label: '이벤트 소스 매핑(SQS ARN → 함수)을 만든다', check: (s) => s.lambda.eventSourceMappings.some((m) => m.EventSourceArn.startsWith('arn:aws:sqs:') && m.State === 'Enabled') },
      { label: '대기열에 메시지를 보내 Lambda 가 sqs 소스로 호출된다', check: (s) => s.lambda.functions.some((f) => f.InvokeSources && f.InvokeSources.sqs > 0) },
      { label: '처리 결과가 OK 이고 대기열이 비워진다', check: (s) => s.lambda.eventSourceMappings.some((m) => m.LastProcessingResult === 'OK' && (s.sqs.queues.find((q) => q.QueueArn === m.EventSourceArn) || { Messages: [1] }).Messages.length === 0) },
    ],
    cli: ['awsim lambda create-event-source-mapping --function-name hello-lambda --event-source-arn arn:aws:sqs:ap-northeast-2:123456789012:billing-queue --batch-size 5', 'awsim sqs send-message --queue-url <url> --message-body \'{"orderId":"o1"}\'', 'awsim lambda list-event-source-mappings'],
  },
  {
    id: 'cloudwatch-alarm', level: 3, service: 'CloudWatch', title: 'CloudWatch 경보로 CPU 과부하 감지 → SNS 알림', minutes: 15,
    description: 'EC2 CPUUtilization 지표에 경보를 걸고 SNS 로 알림을 보냅니다. 시뮬레이터에서는 인스턴스에 SimLoad=high 태그를 붙이거나 사용자 데이터에 "stress" 를 넣으면 CPU 가 85% 이상으로 올라갑니다. (지표는 10초마다 수집, 경보는 15초마다 평가)',
    steps: [
      { label: '알림용 SNS 주제를 만들고 이메일 구독을 확인한다', check: (s) => s.sns.subscriptions.some((x) => x.Protocol.startsWith('email') && x.Status === 'Confirmed') },
      { label: '실행 중인 인스턴스의 CPUUtilization 에 70% 초과 경보(AlarmActions=SNS 주제)를 만든다', check: (s, r) => s.cloudwatch.alarms.some((a) => a.Region === r && a.Namespace === 'AWS/EC2' && a.MetricName === 'CPUUtilization' && a.ComparisonOperator.startsWith('GreaterThan') && a.Threshold >= 50 && a.AlarmActions.some((x) => x.startsWith('arn:aws:sns:'))) },
      { label: '인스턴스에 부하를 준다 (SimLoad=high 태그) → 경보가 ALARM 상태가 된다', check: (s, r) => s.cloudwatch.alarms.some((a) => a.Region === r && a.MetricName === 'CPUUtilization' && (a.StateValue === 'ALARM' || a.History.some((h) => /→ ALARM/.test(h.HistorySummary)))) },
      { label: 'SNS 이메일 받은 편지함에 ALARM 메시지가 도착한다', check: (s) => s.sns.inbox.some((m) => /ALARM/.test(m.Subject || '')) },
    ],
    cli: ['awsim sns create-topic --name alerts', 'awsim sns subscribe --topic-arn arn:aws:sns:ap-northeast-2:123456789012:alerts --protocol email --notification-endpoint ops@example.com', 'awsim cloudwatch put-metric-alarm --alarm-name high-cpu --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --statistic Average --period 60 --evaluation-periods 1 --threshold 70 --comparison-operator GreaterThanThreshold --alarm-actions arn:aws:sns:ap-northeast-2:123456789012:alerts', 'awsim ec2 create-tags --resources <id> --tags Key=SimLoad,Value=high', 'awsim cloudwatch describe-alarms'],
  },
  {
    id: 'cost-cleanup', level: 2, service: 'Billing', title: '비용 정리: 숨은 과금 요소 제거', minutes: 10,
    description: '연결되지 않은 탄력적 IP, 사용하지 않는 NAT 게이트웨이, 프리 티어가 아닌 인스턴스는 꾸준히 과금됩니다. 요금 추정 페이지를 보고 정리하세요. (다른 실습을 먼저 진행한 뒤 마지막에 도전하면 좋습니다)',
    steps: [
      { label: '요금 추정(GetCostEstimate)을 조회한다', check: () => has('billing:GetCostEstimate') },
      { label: '연결되지 않은(유휴) 탄력적 IP 가 없다', check: (s) => !s.ec2.addresses.some((a) => !a.AssociationId) },
      { label: 'NAT 게이트웨이가 없다', check: (s) => s.vpc.natGateways.length === 0 },
      { label: '프리 티어가 아닌 유형(t2.micro/t3.micro 외)의 실행 중 인스턴스가 없다', check: (s) => !s.ec2.instances.some((i) => i.State.Name === 'running' && !ec2.INSTANCE_TYPES.find((t) => t.InstanceType === i.InstanceType && t.FreeTier)) },
      { label: '연결되지 않은(available) EBS 볼륨이 없다', check: (s) => !s.ec2.volumes.some((v) => v.State === 'available') },
      { label: '이 리전에 리소스(인스턴스/볼륨/EIP)를 최소 하나는 만든 적이 있다', check: (s) => s.history.some((h) => ['RunInstances', 'AllocateAddress', 'CreateVolume'].includes(h.action)) },
    ],
    cli: ['awsim billing get-cost-estimate', 'awsim ec2 describe-addresses', 'awsim ec2 release-address --allocation-id <eipalloc-id>', 'awsim ec2 delete-volume --volume-id <vol-id>', 'awsim ec2 terminate-instances --instance-ids <id>'],
  },
];

function progress(region) {
  const s = store.get();
  const out = [];
  let changed = false;
  for (const lab of LABS) {
    const steps = lab.steps.map((st) => { let ok = false; try { ok = !!st.check(s, region); } catch (e) { ok = false; } return { label: st.label, ok }; });
    const done = steps.every((x) => x.ok);
    if (done && !s.labs.completed[lab.id]) { s.labs.completed[lab.id] = new Date().toISOString(); changed = true; }
    out.push({ id: lab.id, level: lab.level, service: lab.service, title: lab.title, minutes: lab.minutes, description: lab.description, cli: lab.cli, steps, done, completedAt: s.labs.completed[lab.id] || null, progress: steps.filter((x) => x.ok).length / steps.length });
  }
  if (changed) store.save();
  return { labs: out, completed: out.filter((l) => l.done).length, total: out.length };
}
function reset() { store.get().labs = { completed: {}, counts: {} }; store.save(); }

module.exports = { LABS, progress, reset };
