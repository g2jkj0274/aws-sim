'use strict';
// 통합 스모크 테스트: 서버를 임시 포트/임시 상태 파일로 띄우고 주요 시나리오를 실행합니다.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4699;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awsim-test-'));
const stateFile = path.join(tmp, 'state.json');
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), `--port=${PORT}`, '--reset'], { env: { ...process.env, AWSIM_STATE: stateFile, AWSIM_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
server.stdout.on('data', () => {});
server.on('exit', (c, sig) => console.log('[server exit]', c, sig));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, passes = 0;
async function call(svc, action, params = {}, region = 'ap-northeast-2') {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${svc}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-region': region }, body: JSON.stringify(params) }).catch((e) => { throw new Error(`${svc}/${action} fetch failed: ${e.cause && e.cause.message}`); });
  const body = await r.json();
  if (!r.ok) { const e = new Error(`${body.__type}: ${body.message}`); e.code = body.__type; throw e; }
  return body;
}
async function expectError(code, fn) {
  try { await fn(); fail(`오류 ${code} 가 발생해야 하는데 성공함`); } catch (e) { if (e.code === code) ok(`오류 ${code} 정상 발생`); else fail(`오류 ${code} 기대, 실제: ${e.message}`); }
}
function ok(msg) { passes++; console.log('  ✔', msg); }
function fail(msg) { failures++; console.log('  ✘', msg); }
function assert(cond, msg) { cond ? ok(msg) : fail(msg); }

async function main() {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/meta`); break; } catch (e) { await sleep(200); } }
  console.log('\n[IAM]');
  const u = await call('iam', 'CreateUser', { UserName: 'dev-user' });
  assert(u.User.Arn.endsWith(':user/dev-user'), '사용자 생성');
  await call('iam', 'CreateGroup', { GroupName: 'developers' });
  await call('iam', 'AddUserToGroup', { GroupName: 'developers', UserName: 'dev-user' });
  await call('iam', 'AttachGroupPolicy', { GroupName: 'developers', PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' });
  await call('iam', 'CreateAccessKey', { UserName: 'dev-user' });
  const sim = await call('iam', 'SimulatePrincipalPolicy', { PolicySourceArn: u.User.Arn, ActionNames: ['s3:GetObject', 's3:PutObject'] });
  assert(sim.EvaluationResults[0].EvalDecision === 'allowed' && sim.EvaluationResults[1].EvalDecision === 'implicitDeny', '정책 시뮬레이션 allowed/implicitDeny');
  await expectError('EntityAlreadyExists', () => call('iam', 'CreateUser', { UserName: 'dev-user' }));
  await expectError('MalformedPolicyDocument', () => call('iam', 'CreatePolicy', { PolicyName: 'bad', PolicyDocument: '{"Statement":[{"Effect":"Maybe"}]}' }));
  const role = await call('iam', 'CreateRole', { RoleName: 'lambda-exec', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] } });
  await call('iam', 'AttachRolePolicy', { RoleName: 'lambda-exec', PolicyArn: 'arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole' });

  console.log('\n[VPC]');
  const v = await call('ec2', 'CreateVpc', { CidrBlock: '10.0.0.0/16', TagSpecifications: [{ ResourceType: 'vpc', Tags: [{ Key: 'Name', Value: 'lab-vpc' }] }] });
  const pub = await call('ec2', 'CreateSubnet', { VpcId: v.Vpc.VpcId, CidrBlock: '10.0.1.0/24' });
  const priv = await call('ec2', 'CreateSubnet', { VpcId: v.Vpc.VpcId, CidrBlock: '10.0.2.0/24', AvailabilityZone: 'ap-northeast-2b' });
  await expectError('InvalidSubnet.Conflict', () => call('ec2', 'CreateSubnet', { VpcId: v.Vpc.VpcId, CidrBlock: '10.0.1.0/25' }));
  await expectError('InvalidSubnet.Range', () => call('ec2', 'CreateSubnet', { VpcId: v.Vpc.VpcId, CidrBlock: '192.168.1.0/24' }));
  const igw = await call('ec2', 'CreateInternetGateway', {});
  await call('ec2', 'AttachInternetGateway', { InternetGatewayId: igw.InternetGateway.InternetGatewayId, VpcId: v.Vpc.VpcId });
  const rtb = await call('ec2', 'CreateRouteTable', { VpcId: v.Vpc.VpcId });
  await call('ec2', 'CreateRoute', { RouteTableId: rtb.RouteTable.RouteTableId, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw.InternetGateway.InternetGatewayId });
  await call('ec2', 'AssociateRouteTable', { RouteTableId: rtb.RouteTable.RouteTableId, SubnetId: pub.Subnet.SubnetId });
  await call('ec2', 'ModifySubnetAttribute', { SubnetId: pub.Subnet.SubnetId, MapPublicIpOnLaunch: { Value: true } });
  const subs = await call('ec2', 'DescribeSubnets', { SubnetIds: [pub.Subnet.SubnetId, priv.Subnet.SubnetId] });
  assert(subs.Subnets.find((s) => s.SubnetId === pub.Subnet.SubnetId).IsPublic && !subs.Subnets.find((s) => s.SubnetId === priv.Subnet.SubnetId).IsPublic, '퍼블릭/프라이빗 서브넷 판정');

  console.log('\n[EC2]');
  await call('ec2', 'CreateKeyPair', { KeyName: 'lab-key' });
  const sg = await call('ec2', 'CreateSecurityGroup', { GroupName: 'web-sg', Description: 'web', VpcId: v.Vpc.VpcId });
  await call('ec2', 'AuthorizeSecurityGroupIngress', { GroupId: sg.GroupId, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' });
  await call('ec2', 'AuthorizeSecurityGroupIngress', { GroupId: sg.GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] });
  await expectError('InvalidPermission.Duplicate', () => call('ec2', 'AuthorizeSecurityGroupIngress', { GroupId: sg.GroupId, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }));
  await expectError('InvalidAMIID.NotFound', () => call('ec2', 'RunInstances', { ImageId: 'ami-nope' }));
  const run = await call('ec2', 'RunInstances', { ImageId: 'ami-0c9c942bd7bf113a2', InstanceType: 't2.micro', KeyName: 'lab-key', SubnetId: pub.Subnet.SubnetId, SecurityGroupIds: [sg.GroupId], UserData: '#!/bin/bash\nyum install -y httpd\nsystemctl start httpd', TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'web-1' }] }] });
  const iid = run.Instances[0].InstanceId;
  assert(run.Instances[0].State.Name === 'pending' && run.Instances[0].PrivateIpAddress.startsWith('10.0.1.'), '인스턴스 pending + 서브넷 IP 할당');
  await expectError('IncorrectInstanceState', () => call('ec2', 'StopInstances', { InstanceIds: [iid] }));
  await sleep(3600);
  const di = await call('ec2', 'DescribeInstances', { InstanceIds: [iid] });
  const inst = di.Reservations[0].Instances[0];
  assert(inst.State.Name === 'running' && !!inst.PublicIpAddress, '인스턴스 running + 퍼블릭 IP');
  const reach = await call('ec2', 'CheckReachability', { InstanceId: iid, Port: 80 });
  assert(reach.Reachable, '80 포트 도달 가능');
  const reach2 = await call('ec2', 'CheckReachability', { InstanceId: iid, Port: 443 });
  assert(!reach2.Reachable, '443 포트 도달 불가 (SG)');
  const sh = await call('ec2', 'RunShellCommand', { InstanceId: iid, Command: 'curl http://169.254.169.254/latest/meta-data/instance-id' });
  assert(sh.Output === iid, '메타데이터 셸 시뮬레이션');
  const eip = await call('ec2', 'AllocateAddress', {});
  await call('ec2', 'AssociateAddress', { InstanceId: iid, AllocationId: eip.AllocationId });
  const vol = await call('ec2', 'CreateVolume', { AvailabilityZone: 'ap-northeast-2b', Size: 10 });
  await expectError('InvalidVolume.ZoneMismatch', () => call('ec2', 'AttachVolume', { VolumeId: vol.VolumeId, InstanceId: iid, Device: '/dev/sdf' }));
  await call('ec2', 'StopInstances', { InstanceIds: [iid] });
  await sleep(2800);
  const di2 = await call('ec2', 'DescribeInstances', { InstanceIds: [iid] });
  assert(di2.Reservations[0].Instances[0].State.Name === 'stopped', '인스턴스 stopped');
  await call('ec2', 'StartInstances', { InstanceIds: [iid] });

  console.log('\n[S3]');
  await expectError('InvalidBucketName', () => call('s3', 'CreateBucket', { Bucket: 'My_Bucket' }));
  await call('s3', 'CreateBucket', { Bucket: 'my-site-2026' });
  await expectError('BucketAlreadyExists', () => call('s3', 'CreateBucket', { Bucket: 'my-site-2026' }));
  await call('s3', 'PutObject', { Bucket: 'my-site-2026', Key: 'index.html', Body: '<h1>Hello S3</h1>', ContentType: 'text/html' });
  await call('s3', 'PutObject', { Bucket: 'my-site-2026', Key: 'docs/a.txt', Body: 'a' });
  const ls = await call('s3', 'ListObjectsV2', { Bucket: 'my-site-2026', Delimiter: '/' });
  assert(ls.KeyCount === 1 && ls.CommonPrefixes[0].Prefix === 'docs/', 'ListObjectsV2 + Delimiter');
  await expectError('AccessDenied', () => call('s3', 'PutBucketPolicy', { Bucket: 'my-site-2026', Policy: { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::my-site-2026/*' }] } }));
  let r = await fetch(`http://127.0.0.1:${PORT}/s3/my-site-2026/index.html`);
  assert(r.status === 403, '퍼블릭 접근 차단 (403)');
  await call('s3', 'PutPublicAccessBlock', { Bucket: 'my-site-2026', PublicAccessBlockConfiguration: { BlockPublicPolicy: false, RestrictPublicBuckets: false } });
  await call('s3', 'PutBucketPolicy', { Bucket: 'my-site-2026', Policy: { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::my-site-2026/*' }] } });
  await call('s3', 'PutBucketWebsite', { Bucket: 'my-site-2026', WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } });
  r = await fetch(`http://127.0.0.1:${PORT}/s3-website/my-site-2026/`);
  assert(r.status === 200 && (await r.text()).includes('Hello S3'), '정적 웹 사이트 서빙');
  await call('s3', 'PutBucketVersioning', { Bucket: 'my-site-2026', VersioningConfiguration: { Status: 'Enabled' } });
  await call('s3', 'PutObject', { Bucket: 'my-site-2026', Key: 'docs/a.txt', Body: 'b' });
  const vers = await call('s3', 'ListObjectVersions', { Bucket: 'my-site-2026', Prefix: 'docs/' });
  assert(vers.Versions.length === 2, '버전 2개');
  const got = await call('s3', 'GetObject', { Bucket: 'my-site-2026', Key: 'docs/a.txt' });
  assert(got.Body === 'b', '최신 버전 조회');

  console.log('\n[Lambda]');
  await expectError('InvalidParameterValueException', () => call('lambda', 'CreateFunction', { FunctionName: 'f', Role: 'nope' }));
  const fn = await call('lambda', 'CreateFunction', { FunctionName: 'hello-lambda', Runtime: 'nodejs20.x', Role: role.Role.Arn, Handler: 'index.handler', Code: { ZipFile: "exports.handler = async (event) => { console.log('hi', event); const s3 = new AWS.S3(); await s3.putObject({ Bucket: 'my-site-2026', Key: 'from-lambda.txt', Body: 'x' }).promise(); return { ok: true, name: event.name }; };" } });
  assert(fn.FunctionArn.includes(':function:hello-lambda'), '함수 생성');
  const inv = await call('lambda', 'Invoke', { FunctionName: 'hello-lambda', Payload: { name: 'AWS' } });
  assert(inv.Payload && inv.Payload.name === 'AWS' && !inv.FunctionError, 'Node 함수 호출 성공');
  const fromLambda = await call('s3', 'HeadObject', { Bucket: 'my-site-2026', Key: 'from-lambda.txt' });
  assert(fromLambda.Size === 1, 'Lambda 안에서 AWS SDK 로 S3 쓰기');
  const bad = await call('lambda', 'Invoke', { FunctionName: 'hello-lambda', Payload: 'not json' }).catch((e) => e);
  assert(bad.code === 'InvalidRequestContentException', '잘못된 Payload 오류');
  const logs = await call('logs', 'FilterLogEvents', { logGroupName: '/aws/lambda/hello-lambda' });
  assert(logs.events.some((e) => e.message.includes('hi')), 'CloudWatch 로그 기록');
  const py = await call('lambda', 'CreateFunction', { FunctionName: 'py-fn', Runtime: 'python3.12', Role: 'lambda-exec' });
  const pinv = await call('lambda', 'Invoke', { FunctionName: 'py-fn', Payload: { name: '파이썬' } });
  if (pinv.FunctionError && /Python 이 설치/.test(pinv.Payload.errorMessage)) ok('Python 미설치 - 건너뜀'); else assert(pinv.Payload && pinv.Payload.statusCode === 200 && JSON.parse(pinv.Payload.body).message.includes('파이썬'), 'Python 함수 호출 성공');
  await call('s3', 'PutBucketNotificationConfiguration', { Bucket: 'my-site-2026', NotificationConfiguration: { LambdaFunctionConfigurations: [{ LambdaFunctionArn: 'hello-lambda', Events: ['s3:ObjectCreated:*'] }] } });
  await call('s3', 'PutObject', { Bucket: 'my-site-2026', Key: 'uploads/x.txt', Body: 'x' });
  await sleep(1500);
  const fcfg = await call('lambda', 'GetFunctionConfiguration', { FunctionName: 'hello-lambda' });
  assert(fcfg.InvokeSources && fcfg.InvokeSources.s3 >= 1, 'S3 → Lambda 트리거');
  // hello-lambda 는 같은 버킷에 다시 쓰므로 재귀 호출이 발생 → 깊이 제한으로 멈춰야 함
  assert(fcfg.InvokeSources.s3 <= 6, `재귀 호출 가드 (s3 호출 ${fcfg.InvokeSources.s3}회)`);
  const hist = await (await fetch(`http://127.0.0.1:${PORT}/api/history`)).json();
  assert(hist.Events.some((e) => e.action === 'RecursionGuard'), '재귀 호출 경고 기록');
  await call('lambda', 'CreateFunctionUrlConfig', { FunctionName: 'hello-lambda' });
  r = await fetch(`http://127.0.0.1:${PORT}/lambda-url/hello-lambda/?name=url`);
  assert(r.status === 200 && (await r.json()).ok === true, '함수 URL 호출');

  console.log('\n[DynamoDB]');
  await expectError('ValidationException', () => call('dynamodb', 'CreateTable', { TableName: 'Orders', KeySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'customerId', AttributeType: 'S' }] }));
  await call('dynamodb', 'CreateTable', { TableName: 'Orders', KeySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }, { AttributeName: 'orderId', KeyType: 'RANGE' }], AttributeDefinitions: [{ AttributeName: 'customerId', AttributeType: 'S' }, { AttributeName: 'orderId', AttributeType: 'S' }], BillingMode: 'PAY_PER_REQUEST' });
  await sleep(2700);
  await call('dynamodb', 'PutItem', { TableName: 'Orders', Item: { customerId: { S: 'c1' }, orderId: { S: 'o1' }, amount: { N: '120' } } });
  await call('dynamodb', 'PutItem', { TableName: 'Orders', Item: { customerId: 'c1', orderId: 'o2', amount: 50, tags: ['a'] }, _plain: true });
  await call('dynamodb', 'PutItem', { TableName: 'Orders', Item: { customerId: { S: 'c2' }, orderId: { S: 'o3' }, amount: { N: '7' } } });
  await expectError('ValidationException', () => call('dynamodb', 'PutItem', { TableName: 'Orders', Item: { customerId: { S: 'c9' } } }));
  const q = await call('dynamodb', 'Query', { TableName: 'Orders', KeyConditionExpression: 'customerId = :c AND begins_with(orderId, :o)', ExpressionAttributeValues: { ':c': { S: 'c1' }, ':o': { S: 'o' } } });
  assert(q.Count === 2 && q.Items[0].amount.N === '120', 'Query 복합 키 + DynamoDB JSON 반환');
  await expectError('ValidationException', () => call('dynamodb', 'Query', { TableName: 'Orders', KeyConditionExpression: 'amount > :a', ExpressionAttributeValues: { ':a': { N: '1' } } }));
  const sc = await call('dynamodb', 'Scan', { TableName: 'Orders', FilterExpression: 'amount >= :a', ExpressionAttributeValues: { ':a': { N: '50' } } });
  assert(sc.Count === 2 && sc.ScannedCount === 3, 'Scan + FilterExpression');
  const up = await call('dynamodb', 'UpdateItem', { TableName: 'Orders', Key: { customerId: { S: 'c1' }, orderId: { S: 'o1' } }, UpdateExpression: 'SET #s = :s, amount = amount + :inc', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': { S: 'SHIPPED' }, ':inc': { N: '5' } }, ReturnValues: 'ALL_NEW' });
  assert(up.Attributes.status.S === 'SHIPPED' && up.Attributes.amount.N === '125', 'UpdateItem SET + 산술');
  await expectError('ConditionalCheckFailedException', () => call('dynamodb', 'PutItem', { TableName: 'Orders', Item: { customerId: { S: 'c1' }, orderId: { S: 'o1' } }, ConditionExpression: 'attribute_not_exists(customerId)' }));

  console.log('\n[SQS/SNS]');
  const dlq = await call('sqs', 'CreateQueue', { QueueName: 'orders-dlq' });
  const dlqArn = (await call('sqs', 'GetQueueAttributes', { QueueUrl: dlq.QueueUrl })).Attributes.QueueArn;
  const mq = await call('sqs', 'CreateQueue', { QueueName: 'orders-main', Attributes: { VisibilityTimeout: '0', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '2' }) } });
  await call('sqs', 'SendMessage', { QueueUrl: mq.QueueUrl, MessageBody: 'poison' });
  for (let i = 0; i < 3; i++) await call('sqs', 'ReceiveMessage', { QueueUrl: mq.QueueUrl });
  const dlqMsgs = await call('sqs', 'ReceiveMessage', { QueueUrl: dlq.QueueUrl });
  assert(dlqMsgs.Messages && dlqMsgs.Messages.length === 1 && dlqMsgs.Messages[0].Body === 'poison', 'DLQ 로 이동');
  const topic = await call('sns', 'CreateTopic', { Name: 'orders' });
  const q1 = await call('sqs', 'CreateQueue', { QueueName: 'billing-queue' });
  const q1Arn = (await call('sqs', 'GetQueueAttributes', { QueueUrl: q1.QueueUrl })).Attributes.QueueArn;
  await call('sns', 'Subscribe', { TopicArn: topic.TopicArn, Protocol: 'sqs', Endpoint: q1Arn });
  await call('sns', 'Subscribe', { TopicArn: topic.TopicArn, Protocol: 'lambda', Endpoint: 'hello-lambda' });
  const es = await call('sns', 'Subscribe', { TopicArn: topic.TopicArn, Protocol: 'email', Endpoint: 'me@example.com' });
  assert(es.SubscriptionArn === 'pending confirmation', '이메일 구독 대기');
  const inbox = await call('sns', 'ListInbox', {});
  await call('sns', 'ConfirmSubscription', { TopicArn: topic.TopicArn, Token: inbox.Messages[0].Confirmation.Token });
  const pubr = await call('sns', 'Publish', { TopicArn: topic.TopicArn, Message: 'order #1', Subject: 'New order' });
  assert(pubr.Deliveries.filter((d) => d.Status === 'DELIVERED').length === 3, 'SNS 팬아웃 3곳 전달');
  const rcv = await call('sqs', 'ReceiveMessage', { QueueUrl: q1.QueueUrl });
  assert(rcv.Messages.length === 1 && JSON.parse(rcv.Messages[0].Body).Message === 'order #1', 'SQS 가 SNS 봉투 수신');
  await call('sqs', 'DeleteMessage', { QueueUrl: q1.QueueUrl, ReceiptHandle: rcv.Messages[0].ReceiptHandle });
  await call('lambda', 'CreateEventSourceMapping', { FunctionName: 'hello-lambda', EventSourceArn: q1Arn });
  await call('sqs', 'SendMessage', { QueueUrl: q1.QueueUrl, MessageBody: '{"x":1}' });
  await sleep(2600);
  const attrs = await call('sqs', 'GetQueueAttributes', { QueueUrl: q1.QueueUrl });
  assert(attrs.Attributes.ApproximateNumberOfMessages === '0', 'SQS → Lambda ESM 처리 후 삭제');

  console.log('\n[CloudWatch]');
  await call('ec2', 'CreateTags', { Resources: [iid], Tags: [{ Key: 'SimLoad', Value: 'high' }] });
  await call('cloudwatch', 'PutMetricAlarm', { AlarmName: 'high-cpu', Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: iid }], Statistic: 'Average', Period: 60, EvaluationPeriods: 1, Threshold: 70, ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [topic.TopicArn] });
  const cw = require('../server/services/cloudwatch');
  await sleep(100);
  const metrics = await call('cloudwatch', 'ListMetrics', { Namespace: 'AWS/EC2' });
  assert(metrics.Metrics.some((m) => m.MetricName === 'CPUUtilization'), 'EC2 지표 수집');
  const est = await call('billing', 'GetCostEstimate', {});
  assert(est.Lines.some((l) => l.Service === 'EC2') && est.EstimatedMonthlyUsd > 0, '요금 추정');
  const labs = await (await fetch(`http://127.0.0.1:${PORT}/api/labs?region=ap-northeast-2`)).json();
  const done = labs.labs.filter((l) => l.done).map((l) => l.id);
  assert(done.includes('s3-website') && done.includes('vpc-build') && done.includes('ec2-webserver') && done.includes('dynamodb-crud'), `실습 자동 채점 (완료: ${done.join(', ')})`);
  void cw;
}

main().catch((e) => { fail('예외: ' + e.stack); }).finally(() => {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n통과 ${passes}, 실패 ${failures}`);
  process.exit(failures ? 1 : 0);
});
