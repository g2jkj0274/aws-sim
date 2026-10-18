'use strict';
const crypto = require('crypto');
const store = require('../store');
const vpc = require('./vpc');
const { AwsError, id, now, hex, azs, requireParam, tagsFromSpec, applyFilters, parseCidr, ACCOUNT_ID } = require('../util');

function S() { return store.get().ec2; }
function V() { return store.get().vpc; }

const IMAGES = [
  { ImageId: 'ami-0c9c942bd7bf113a2', Name: 'al2023-ami-2023.5-kernel-6.1-x86_64', Description: 'Amazon Linux 2023 AMI', Platform: 'Linux', OwnerId: 'amazon', Architecture: 'x86_64', RootDeviceType: 'ebs', VirtualizationType: 'hvm', State: 'available', Public: true, User: 'ec2-user', FreeTier: true },
  { ImageId: 'ami-0e9bfdb247cc8de84', Name: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server', Description: 'Ubuntu Server 22.04 LTS', Platform: 'Linux', OwnerId: '099720109477', Architecture: 'x86_64', RootDeviceType: 'ebs', VirtualizationType: 'hvm', State: 'available', Public: true, User: 'ubuntu', FreeTier: true },
  { ImageId: 'ami-0a7d80731ae1b2435', Name: 'amzn2-ami-kernel-5.10-hvm-x86_64-gp2', Description: 'Amazon Linux 2 AMI', Platform: 'Linux', OwnerId: 'amazon', Architecture: 'x86_64', RootDeviceType: 'ebs', VirtualizationType: 'hvm', State: 'available', Public: true, User: 'ec2-user', FreeTier: true },
  { ImageId: 'ami-0f4fa8ee2b1a1dc4b', Name: 'Windows_Server-2022-English-Full-Base', Description: 'Microsoft Windows Server 2022', Platform: 'Windows', OwnerId: 'amazon', Architecture: 'x86_64', RootDeviceType: 'ebs', VirtualizationType: 'hvm', State: 'available', Public: true, User: 'Administrator', FreeTier: true },
  { ImageId: 'ami-0b2f6494ff0b07a0e', Name: 'RHEL-9.3.0_HVM-x86_64', Description: 'Red Hat Enterprise Linux 9', Platform: 'Linux', OwnerId: '309956199498', Architecture: 'x86_64', RootDeviceType: 'ebs', VirtualizationType: 'hvm', State: 'available', Public: true, User: 'ec2-user', FreeTier: false },
];

const INSTANCE_TYPES = [
  { InstanceType: 't2.micro', VCpu: 1, MemoryMiB: 1024, Family: '범용', FreeTier: true, PriceUsd: 0.0116 },
  { InstanceType: 't2.small', VCpu: 1, MemoryMiB: 2048, Family: '범용', FreeTier: false, PriceUsd: 0.023 },
  { InstanceType: 't3.micro', VCpu: 2, MemoryMiB: 1024, Family: '범용', FreeTier: true, PriceUsd: 0.0104 },
  { InstanceType: 't3.small', VCpu: 2, MemoryMiB: 2048, Family: '범용', FreeTier: false, PriceUsd: 0.0208 },
  { InstanceType: 't3.medium', VCpu: 2, MemoryMiB: 4096, Family: '범용', FreeTier: false, PriceUsd: 0.0416 },
  { InstanceType: 'm5.large', VCpu: 2, MemoryMiB: 8192, Family: '범용', FreeTier: false, PriceUsd: 0.096 },
  { InstanceType: 'm5.xlarge', VCpu: 4, MemoryMiB: 16384, Family: '범용', FreeTier: false, PriceUsd: 0.192 },
  { InstanceType: 'c5.large', VCpu: 2, MemoryMiB: 4096, Family: '컴퓨팅 최적화', FreeTier: false, PriceUsd: 0.085 },
  { InstanceType: 'c5.xlarge', VCpu: 4, MemoryMiB: 8192, Family: '컴퓨팅 최적화', FreeTier: false, PriceUsd: 0.17 },
  { InstanceType: 'r5.large', VCpu: 2, MemoryMiB: 16384, Family: '메모리 최적화', FreeTier: false, PriceUsd: 0.126 },
  { InstanceType: 'g4dn.xlarge', VCpu: 4, MemoryMiB: 16384, Family: '가속 컴퓨팅(GPU)', FreeTier: false, PriceUsd: 0.526 },
];

function seed() {
  if (!S().images.length) S().images = IMAGES.map((i) => ({ ...i, CreationDate: now() }));
}

function findInstance(iid) {
  const i = S().instances.find((x) => x.InstanceId === iid);
  if (!i) throw new AwsError('InvalidInstanceID.NotFound', `인스턴스 '${iid}' 이(가) 존재하지 않습니다.`, 404);
  return i;
}
function findSg(gid) {
  const g = S().securityGroups.find((x) => x.GroupId === gid || x.GroupName === gid);
  if (!g) throw new AwsError('InvalidGroup.NotFound', `보안 그룹 '${gid}' 이(가) 존재하지 않습니다.`, 404);
  return g;
}
function transition(inst, from, to, ms) {
  setTimeout(() => {
    if (inst.State.Name === from) {
      inst.State = { Code: stateCode(to), Name: to };
      if (to === 'running') inst.LaunchTime = inst.LaunchTime || now();
      if (to === 'stopped' || to === 'terminated') { if (!inst.ElasticIp) delete inst.PublicIpAddress; delete inst.PublicDnsName; }
      if (to === 'running' && inst._wantPublic && !inst.PublicIpAddress) assignPublicIp(inst);
      store.record({ time: now(), service: 'ec2', action: 'StateChange', detail: `${inst.InstanceId} → ${to}` });
      store.save();
    }
  }, ms);
}
function stateCode(n) { return { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 }[n]; }
function assignPublicIp(inst) {
  inst.PublicIpAddress = inst.ElasticIp || `${3 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
  inst.PublicDnsName = `ec2-${inst.PublicIpAddress.replace(/\./g, '-')}.${inst.Region}.compute.amazonaws.com`;
}
function pubInstance(i) {
  const { _wantPublic, _userDataLog, ...rest } = i;
  return rest;
}

function parsePermission(p, ctx) {
  // supports both simple (IpProtocol/FromPort/ToPort/CidrIp) and IpPermissions[] forms
  const perms = [];
  if (p.IpPermissions && p.IpPermissions.length) {
    for (const ip of p.IpPermissions) perms.push({ IpProtocol: String(ip.IpProtocol ?? 'tcp'), FromPort: ip.FromPort, ToPort: ip.ToPort, IpRanges: ip.IpRanges || [], UserIdGroupPairs: ip.UserIdGroupPairs || [], Ipv6Ranges: ip.Ipv6Ranges || [], PrefixListIds: [] });
  } else {
    const perm = { IpProtocol: String(p.IpProtocol ?? 'tcp'), FromPort: p.FromPort ?? p.Port, ToPort: p.ToPort ?? p.Port, IpRanges: [], UserIdGroupPairs: [], Ipv6Ranges: [], PrefixListIds: [] };
    if (p.CidrIp) perm.IpRanges.push({ CidrIp: p.CidrIp, Description: p.Description });
    if (p.SourceSecurityGroupName || p.SourceSecurityGroupId) perm.UserIdGroupPairs.push({ GroupId: findSg(p.SourceSecurityGroupId || p.SourceSecurityGroupName).GroupId, UserId: ACCOUNT_ID });
    perms.push(perm);
  }
  for (const perm of perms) {
    if (perm.IpProtocol !== '-1' && perm.IpProtocol !== 'icmp') {
      if (perm.FromPort === undefined || perm.ToPort === undefined) throw new AwsError('MissingParameter', 'FromPort/ToPort 가 필요합니다.');
      perm.FromPort = Number(perm.FromPort); perm.ToPort = Number(perm.ToPort);
      if (perm.FromPort < 0 || perm.ToPort > 65535 || perm.FromPort > perm.ToPort) throw new AwsError('InvalidParameterValue', '포트 범위가 잘못되었습니다.');
    }
    for (const r of perm.IpRanges) parseCidr(r.CidrIp);
    if (!perm.IpRanges.length && !perm.UserIdGroupPairs.length) throw new AwsError('MissingParameter', 'CidrIp 또는 소스 보안 그룹이 필요합니다.');
  }
  return perms;
}
function samePerm(a, b) {
  return a.IpProtocol === b.IpProtocol && a.FromPort === b.FromPort && a.ToPort === b.ToPort;
}

const actions = {
  DescribeImages(p) { return { Images: applyFilters(S().images, p.Filters) }; },
  DescribeInstanceTypes() { return { InstanceTypes: INSTANCE_TYPES }; },
  // ---- Key pairs ----
  CreateKeyPair(p, ctx) {
    const name = requireParam(p, 'KeyName');
    if (S().keyPairs.find((k) => k.KeyName === name && k.Region === ctx.region)) throw new AwsError('InvalidKeyPair.Duplicate', `키 페어 '${name}' 이(가) 이미 존재합니다.`);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    const kp = { KeyPairId: id('key'), KeyName: name, KeyType: p.KeyType || 'rsa', KeyFingerprint: crypto.createHash('sha256').update(publicKey).digest('base64'), CreateTime: now(), Region: ctx.region, Tags: tagsFromSpec(p, 'key-pair') };
    S().keyPairs.push(kp);
    return { ...kp, KeyMaterial: privateKey };
  },
  DescribeKeyPairs(p, ctx) {
    let list = S().keyPairs.filter((k) => k.Region === ctx.region);
    if (p.KeyNames && p.KeyNames.length) list = list.filter((k) => p.KeyNames.includes(k.KeyName));
    return { KeyPairs: list };
  },
  DeleteKeyPair(p, ctx) {
    S().keyPairs = S().keyPairs.filter((k) => !(k.Region === ctx.region && (k.KeyName === p.KeyName || k.KeyPairId === p.KeyPairId)));
    return { Return: true };
  },
  // ---- Security groups ----
  CreateSecurityGroup(p, ctx) {
    const name = requireParam(p, 'GroupName');
    requireParam(p, 'Description');
    const vpcId = p.VpcId || (V().vpcs.find((v) => v.Region === ctx.region && v.IsDefault) || {}).VpcId;
    vpc.findVpc(vpcId);
    if (S().securityGroups.find((g) => g.GroupName === name && g.VpcId === vpcId)) throw new AwsError('InvalidGroup.Duplicate', `보안 그룹 '${name}' 이(가) 이미 VPC에 존재합니다.`);
    const sg = { GroupId: id('sg'), GroupName: name, Description: p.Description, VpcId: vpcId, OwnerId: ACCOUNT_ID, Region: ctx.region, IpPermissions: [], IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }], UserIdGroupPairs: [], Ipv6Ranges: [], PrefixListIds: [] }], Tags: tagsFromSpec(p, 'security-group') };
    S().securityGroups.push(sg);
    return { GroupId: sg.GroupId };
  },
  DescribeSecurityGroups(p, ctx) {
    let list = S().securityGroups.filter((g) => g.Region === ctx.region);
    if (p.GroupIds && p.GroupIds.length) list = list.filter((g) => p.GroupIds.includes(g.GroupId));
    if (p.GroupNames && p.GroupNames.length) list = list.filter((g) => p.GroupNames.includes(g.GroupName));
    return { SecurityGroups: applyFilters(list, p.Filters) };
  },
  AuthorizeSecurityGroupIngress(p, ctx) {
    const sg = findSg(requireParam(p, p.GroupId ? 'GroupId' : 'GroupName'));
    for (const perm of parsePermission(p, ctx)) {
      const existing = sg.IpPermissions.find((x) => samePerm(x, perm));
      if (existing) {
        for (const r of perm.IpRanges) { if (existing.IpRanges.some((e) => e.CidrIp === r.CidrIp)) throw new AwsError('InvalidPermission.Duplicate', '동일한 규칙이 이미 존재합니다.'); existing.IpRanges.push(r); }
        for (const g of perm.UserIdGroupPairs) if (!existing.UserIdGroupPairs.some((e) => e.GroupId === g.GroupId)) existing.UserIdGroupPairs.push(g);
      } else sg.IpPermissions.push(perm);
    }
    return { Return: true };
  },
  RevokeSecurityGroupIngress(p, ctx) {
    const sg = findSg(requireParam(p, p.GroupId ? 'GroupId' : 'GroupName'));
    for (const perm of parsePermission(p, ctx)) {
      const existing = sg.IpPermissions.find((x) => samePerm(x, perm));
      if (!existing) throw new AwsError('InvalidPermission.NotFound', '해당 규칙이 없습니다.', 404);
      existing.IpRanges = existing.IpRanges.filter((r) => !perm.IpRanges.some((x) => x.CidrIp === r.CidrIp));
      existing.UserIdGroupPairs = existing.UserIdGroupPairs.filter((r) => !perm.UserIdGroupPairs.some((x) => x.GroupId === r.GroupId));
      if (!existing.IpRanges.length && !existing.UserIdGroupPairs.length) sg.IpPermissions = sg.IpPermissions.filter((x) => x !== existing);
    }
    return { Return: true };
  },
  AuthorizeSecurityGroupEgress(p, ctx) {
    const sg = findSg(requireParam(p, 'GroupId'));
    sg.IpPermissionsEgress.push(...parsePermission(p, ctx));
    return { Return: true };
  },
  DeleteSecurityGroup(p) {
    const sg = findSg(requireParam(p, p.GroupId ? 'GroupId' : 'GroupName'));
    if (sg.GroupName === 'default') throw new AwsError('CannotDelete', 'default 보안 그룹은 삭제할 수 없습니다.');
    if (S().instances.some((i) => i.State.Name !== 'terminated' && i.SecurityGroups.some((g) => g.GroupId === sg.GroupId))) throw new AwsError('DependencyViolation', '인스턴스가 사용 중인 보안 그룹은 삭제할 수 없습니다.');
    S().securityGroups = S().securityGroups.filter((x) => x !== sg);
    return { Return: true };
  },
  // ---- Instances ----
  RunInstances(p, ctx) {
    const imageId = requireParam(p, 'ImageId');
    const image = S().images.find((i) => i.ImageId === imageId);
    if (!image) throw new AwsError('InvalidAMIID.NotFound', `AMI '${imageId}' 이(가) 존재하지 않습니다. DescribeImages 로 사용 가능한 AMI를 확인하세요.`, 404);
    const type = p.InstanceType || 't2.micro';
    const typeInfo = INSTANCE_TYPES.find((t) => t.InstanceType === type);
    if (!typeInfo) throw new AwsError('InvalidParameterValue', `지원하지 않는 인스턴스 유형입니다: ${type}`);
    const count = Number(p.MinCount || p.Count || 1);
    if (count < 1 || count > 10) throw new AwsError('InvalidParameterValue', '한 번에 1~10개까지 실행할 수 있습니다.');
    let subnet;
    if (p.SubnetId) subnet = vpc.findSubnet(p.SubnetId);
    else {
      const dv = V().vpcs.find((v) => v.Region === ctx.region && v.IsDefault);
      subnet = V().subnets.find((s) => s.VpcId === dv.VpcId);
    }
    const theVpc = vpc.findVpc(subnet.VpcId);
    let sgs = [];
    const sgIds = [].concat(p.SecurityGroupIds || []).concat(p.SecurityGroups || []);
    if (sgIds.length) sgs = sgIds.map((g) => findSg(g));
    else sgs = [S().securityGroups.find((g) => g.VpcId === theVpc.VpcId && g.GroupName === 'default')];
    for (const g of sgs) if (g.VpcId !== theVpc.VpcId) throw new AwsError('InvalidParameterValue', `보안 그룹 ${g.GroupId} 은(는) 서브넷의 VPC(${theVpc.VpcId})에 속하지 않습니다.`);
    if (p.KeyName && !S().keyPairs.find((k) => k.KeyName === p.KeyName && k.Region === ctx.region)) throw new AwsError('InvalidKeyPair.NotFound', `키 페어 '${p.KeyName}' 이(가) 존재하지 않습니다.`, 404);
    const running = S().instances.filter((i) => i.Region === ctx.region && !['terminated', 'shutting-down'].includes(i.State.Name)).length;
    if (running + count > 20) throw new AwsError('InstanceLimitExceeded', '리전당 실행 가능한 인스턴스 한도(20)를 초과했습니다.');
    const wantPublic = p.AssociatePublicIpAddress !== undefined ? !!p.AssociatePublicIpAddress : subnet.MapPublicIpOnLaunch;
    const reservation = { ReservationId: id('r'), OwnerId: ACCOUNT_ID, Instances: [] };
    const userData = p.UserData ? (/^[A-Za-z0-9+/=]+$/.test(p.UserData) && p.UserData.length % 4 === 0 ? Buffer.from(p.UserData, 'base64').toString('utf8') : p.UserData) : '';
    for (let n = 0; n < count; n++) {
      const inst = {
        InstanceId: id('i'), ImageId: imageId, InstanceType: type, State: { Code: 0, Name: 'pending' }, KeyName: p.KeyName, LaunchTime: now(),
        Placement: { AvailabilityZone: subnet.AvailabilityZone, Tenancy: 'default' }, SubnetId: subnet.SubnetId, VpcId: theVpc.VpcId,
        PrivateIpAddress: vpc.allocateIp(subnet), Architecture: 'x86_64', RootDeviceType: 'ebs', Platform: image.Platform === 'Windows' ? 'windows' : undefined, PlatformDetails: image.Platform === 'Windows' ? 'Windows' : 'Linux/UNIX',
        SecurityGroups: sgs.map((g) => ({ GroupId: g.GroupId, GroupName: g.GroupName })), Monitoring: { State: p.Monitoring && p.Monitoring.Enabled ? 'enabled' : 'disabled' },
        IamInstanceProfile: p.IamInstanceProfile ? { Arn: p.IamInstanceProfile.Arn || `arn:aws:iam::${ACCOUNT_ID}:instance-profile/${p.IamInstanceProfile.Name}`, Id: 'AIPA' + hex(17).toUpperCase() } : undefined,
        Tags: tagsFromSpec(p, 'instance'), Region: ctx.region, UserData: userData, _wantPublic: wantPublic, BlockDeviceMappings: [],
      };
      inst.PrivateDnsName = `ip-${inst.PrivateIpAddress.replace(/\./g, '-')}.${ctx.region}.compute.internal`;
      const vol = { VolumeId: id('vol'), Size: Number((p.BlockDeviceMappings && p.BlockDeviceMappings[0] && p.BlockDeviceMappings[0].Ebs && p.BlockDeviceMappings[0].Ebs.VolumeSize) || 8), VolumeType: 'gp3', State: 'in-use', AvailabilityZone: subnet.AvailabilityZone, Region: ctx.region, CreateTime: now(), Encrypted: false, Iops: 3000, Attachments: [{ InstanceId: inst.InstanceId, Device: '/dev/xvda', State: 'attached', DeleteOnTermination: true }], Tags: [] };
      S().volumes.push(vol);
      inst.BlockDeviceMappings.push({ DeviceName: '/dev/xvda', Ebs: { VolumeId: vol.VolumeId, Status: 'attached', DeleteOnTermination: true } });
      S().instances.push(inst);
      reservation.Instances.push(pubInstance(inst));
      transition(inst, 'pending', 'running', 3000 + n * 500);
    }
    return reservation;
  },
  DescribeInstances(p, ctx) {
    let list = S().instances.filter((i) => i.Region === ctx.region);
    if (p.InstanceIds && p.InstanceIds.length) {
      for (const iid of p.InstanceIds) findInstance(iid);
      list = list.filter((i) => p.InstanceIds.includes(i.InstanceId));
    }
    list = applyFilters(list, p.Filters);
    return { Reservations: list.length ? [{ ReservationId: 'r-sim', OwnerId: ACCOUNT_ID, Instances: list.map(pubInstance) }] : [] };
  },
  StartInstances(p) {
    const ids = [].concat(requireParam(p, 'InstanceIds'));
    const out = [];
    for (const iid of ids) {
      const i = findInstance(iid);
      if (i.State.Name !== 'stopped') throw new AwsError('IncorrectInstanceState', `인스턴스 ${iid} 은(는) 'stopped' 상태가 아니므로 시작할 수 없습니다 (현재: ${i.State.Name}).`);
      out.push({ InstanceId: iid, PreviousState: i.State, CurrentState: { Code: 0, Name: 'pending' } });
      i.State = { Code: 0, Name: 'pending' };
      transition(i, 'pending', 'running', 2500);
    }
    return { StartingInstances: out };
  },
  StopInstances(p) {
    const ids = [].concat(requireParam(p, 'InstanceIds'));
    const out = [];
    for (const iid of ids) {
      const i = findInstance(iid);
      if (i.State.Name !== 'running') throw new AwsError('IncorrectInstanceState', `인스턴스 ${iid} 은(는) 'running' 상태가 아니므로 중지할 수 없습니다 (현재: ${i.State.Name}).`);
      out.push({ InstanceId: iid, PreviousState: i.State, CurrentState: { Code: 64, Name: 'stopping' } });
      i.State = { Code: 64, Name: 'stopping' };
      transition(i, 'stopping', 'stopped', 2500);
    }
    return { StoppingInstances: out };
  },
  RebootInstances(p) {
    for (const iid of [].concat(requireParam(p, 'InstanceIds'))) { const i = findInstance(iid); if (i.State.Name !== 'running') throw new AwsError('IncorrectInstanceState', '실행 중인 인스턴스만 재부팅할 수 있습니다.'); }
    return { Return: true };
  },
  TerminateInstances(p) {
    const ids = [].concat(requireParam(p, 'InstanceIds'));
    const out = [];
    for (const iid of ids) {
      const i = findInstance(iid);
      if (i.State.Name === 'terminated') continue;
      if (i.DisableApiTermination) throw new AwsError('OperationNotPermitted', `인스턴스 ${iid} 에 종료 방지가 설정되어 있습니다.`);
      out.push({ InstanceId: iid, PreviousState: i.State, CurrentState: { Code: 32, Name: 'shutting-down' } });
      i.State = { Code: 32, Name: 'shutting-down' };
      for (const a of S().addresses) if (a.InstanceId === iid) { delete a.InstanceId; delete a.AssociationId; delete a.PrivateIpAddress; }
      delete i.ElasticIp;
      S().volumes = S().volumes.filter((v) => !v.Attachments.some((a) => a.InstanceId === iid && a.DeleteOnTermination));
      transition(i, 'shutting-down', 'terminated', 2500);
      setTimeout(() => { S().instances = S().instances.filter((x) => x.InstanceId !== iid); store.save(); }, 60 * 60 * 1000);
    }
    return { TerminatingInstances: out };
  },
  ModifyInstanceAttribute(p) {
    const i = findInstance(requireParam(p, 'InstanceId'));
    if (p.InstanceType) { if (i.State.Name !== 'stopped') throw new AwsError('IncorrectInstanceState', '인스턴스 유형은 중지된 상태에서만 변경할 수 있습니다.'); i.InstanceType = p.InstanceType.Value || p.InstanceType; }
    if (p.DisableApiTermination) i.DisableApiTermination = !!p.DisableApiTermination.Value;
    if (p.Groups) i.SecurityGroups = p.Groups.map((g) => { const sg = findSg(g); return { GroupId: sg.GroupId, GroupName: sg.GroupName }; });
    return { Return: true };
  },
  CreateTags(p) {
    const tags = (p.Tags || []).map((t) => ({ Key: t.Key, Value: String(t.Value ?? '') }));
    const all = [...S().instances, ...S().securityGroups, ...S().keyPairs, ...S().volumes, ...S().addresses, ...V().vpcs, ...V().subnets, ...V().igws, ...V().routeTables, ...V().natGateways];
    for (const rid of [].concat(requireParam(p, 'Resources'))) {
      const r = all.find((x) => Object.values(x).includes(rid));
      if (!r) throw new AwsError('InvalidID', `리소스 ${rid} 을(를) 찾을 수 없습니다.`, 404);
      r.Tags = r.Tags || [];
      for (const t of tags) { r.Tags = r.Tags.filter((x) => x.Key !== t.Key); r.Tags.push(t); }
    }
    return { Return: true };
  },
  GetConsoleOutput(p) {
    const i = findInstance(requireParam(p, 'InstanceId'));
    return { InstanceId: i.InstanceId, Timestamp: now(), Output: Buffer.from(consoleOutput(i)).toString('base64') };
  },
  // ---- Elastic IP ----
  AllocateAddress(p, ctx) {
    const a = { AllocationId: id('eipalloc'), PublicIp: `52.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`, Domain: 'vpc', Region: ctx.region, NetworkBorderGroup: ctx.region, PublicIpv4Pool: 'amazon', Tags: tagsFromSpec(p, 'elastic-ip') };
    S().addresses.push(a);
    return { AllocationId: a.AllocationId, PublicIp: a.PublicIp, Domain: 'vpc' };
  },
  DescribeAddresses(p, ctx) { return { Addresses: S().addresses.filter((a) => a.Region === ctx.region) }; },
  AssociateAddress(p) {
    const a = S().addresses.find((x) => x.AllocationId === p.AllocationId || x.PublicIp === p.PublicIp);
    if (!a) throw new AwsError('InvalidAllocationID.NotFound', '탄력적 IP를 찾을 수 없습니다.', 404);
    const i = findInstance(requireParam(p, 'InstanceId'));
    if (a.AssociationId) throw new AwsError('Resource.AlreadyAssociated', '이미 연결된 탄력적 IP입니다.');
    if (!vpc.subnetIsPublic(vpc.findSubnet(i.SubnetId))) throw new AwsError('InvalidParameterValue', '인스턴스가 속한 VPC에 인터넷 게이트웨이가 없어 탄력적 IP를 연결할 수 없습니다.');
    a.AssociationId = id('eipassoc'); a.InstanceId = i.InstanceId; a.PrivateIpAddress = i.PrivateIpAddress;
    i.ElasticIp = a.PublicIp; i.PublicIpAddress = a.PublicIp; i.PublicDnsName = `ec2-${a.PublicIp.replace(/\./g, '-')}.${i.Region}.compute.amazonaws.com`;
    return { AssociationId: a.AssociationId };
  },
  DisassociateAddress(p) {
    const a = S().addresses.find((x) => x.AssociationId === p.AssociationId || x.PublicIp === p.PublicIp);
    if (!a) throw new AwsError('InvalidAssociationID.NotFound', '연결을 찾을 수 없습니다.', 404);
    const i = S().instances.find((x) => x.InstanceId === a.InstanceId);
    if (i) { delete i.ElasticIp; if (i._wantPublic) assignPublicIp(i); else { delete i.PublicIpAddress; delete i.PublicDnsName; } }
    delete a.AssociationId; delete a.InstanceId; delete a.PrivateIpAddress;
    return {};
  },
  ReleaseAddress(p) {
    const a = S().addresses.find((x) => x.AllocationId === p.AllocationId || x.PublicIp === p.PublicIp);
    if (!a) throw new AwsError('InvalidAllocationID.NotFound', '탄력적 IP를 찾을 수 없습니다.', 404);
    if (a.AssociationId) throw new AwsError('InvalidIPAddress.InUse', '사용 중인 탄력적 IP는 해제할 수 없습니다. 먼저 연결을 해제하세요.');
    S().addresses = S().addresses.filter((x) => x !== a);
    return {};
  },
  // ---- EBS ----
  CreateVolume(p, ctx) {
    const az = requireParam(p, 'AvailabilityZone');
    if (!azs(ctx.region).includes(az)) throw new AwsError('InvalidParameterValue', `잘못된 가용 영역: ${az}`);
    const size = Number(p.Size || 8);
    const v = { VolumeId: id('vol'), Size: size, VolumeType: p.VolumeType || 'gp3', State: 'available', AvailabilityZone: az, Region: ctx.region, CreateTime: now(), Encrypted: !!p.Encrypted, Iops: 3000, Attachments: [], Tags: tagsFromSpec(p, 'volume') };
    S().volumes.push(v);
    return v;
  },
  DescribeVolumes(p, ctx) { return { Volumes: S().volumes.filter((v) => v.Region === ctx.region) }; },
  AttachVolume(p) {
    const v = S().volumes.find((x) => x.VolumeId === p.VolumeId);
    if (!v) throw new AwsError('InvalidVolume.NotFound', '볼륨을 찾을 수 없습니다.', 404);
    const i = findInstance(requireParam(p, 'InstanceId'));
    if (v.State !== 'available') throw new AwsError('VolumeInUse', '이미 연결된 볼륨입니다.');
    if (v.AvailabilityZone !== i.Placement.AvailabilityZone) throw new AwsError('InvalidVolume.ZoneMismatch', `볼륨(${v.AvailabilityZone})과 인스턴스(${i.Placement.AvailabilityZone})의 가용 영역이 다릅니다. EBS는 같은 AZ에서만 연결할 수 있습니다.`);
    const dev = p.Device || '/dev/sdf';
    v.State = 'in-use'; v.Attachments = [{ InstanceId: i.InstanceId, Device: dev, State: 'attached', DeleteOnTermination: false }];
    i.BlockDeviceMappings.push({ DeviceName: dev, Ebs: { VolumeId: v.VolumeId, Status: 'attached', DeleteOnTermination: false } });
    return { VolumeId: v.VolumeId, InstanceId: i.InstanceId, Device: dev, State: 'attached' };
  },
  DetachVolume(p) {
    const v = S().volumes.find((x) => x.VolumeId === p.VolumeId);
    if (!v) throw new AwsError('InvalidVolume.NotFound', '볼륨을 찾을 수 없습니다.', 404);
    const att = v.Attachments[0];
    if (!att) throw new AwsError('IncorrectState', '연결되지 않은 볼륨입니다.');
    if (att.Device === '/dev/xvda') throw new AwsError('OperationNotPermitted', '루트 볼륨은 실행 중에 분리할 수 없습니다.');
    const i = S().instances.find((x) => x.InstanceId === att.InstanceId);
    if (i) i.BlockDeviceMappings = i.BlockDeviceMappings.filter((b) => b.Ebs.VolumeId !== v.VolumeId);
    v.State = 'available'; v.Attachments = [];
    return { VolumeId: v.VolumeId, State: 'detached' };
  },
  DeleteVolume(p) {
    const v = S().volumes.find((x) => x.VolumeId === p.VolumeId);
    if (!v) throw new AwsError('InvalidVolume.NotFound', '볼륨을 찾을 수 없습니다.', 404);
    if (v.State !== 'available') throw new AwsError('VolumeInUse', '사용 중인 볼륨은 삭제할 수 없습니다.');
    S().volumes = S().volumes.filter((x) => x !== v);
    return {};
  },
  CreateSnapshot(p, ctx) {
    const v = S().volumes.find((x) => x.VolumeId === p.VolumeId);
    if (!v) throw new AwsError('InvalidVolume.NotFound', '볼륨을 찾을 수 없습니다.', 404);
    S().snapshots = S().snapshots || [];
    const s = { SnapshotId: id('snap'), VolumeId: v.VolumeId, VolumeSize: v.Size, State: 'completed', StartTime: now(), Description: p.Description || '', Region: ctx.region, OwnerId: ACCOUNT_ID, Progress: '100%', Encrypted: v.Encrypted };
    S().snapshots.push(s);
    return s;
  },
  DescribeSnapshots(p, ctx) { return { Snapshots: (S().snapshots || []).filter((s) => s.Region === ctx.region) }; },
  // ---- Simulated connectivity / shell ----
  CheckReachability(p) {
    const i = findInstance(requireParam(p, 'InstanceId'));
    const port = Number(p.Port || 22);
    return reachability(i, port, p.SourceIp || '0.0.0.0');
  },
  RunShellCommand(p) {
    const i = findInstance(requireParam(p, 'InstanceId'));
    return { Output: shell(i, String(p.Command || '')) };
  },
};

function reachability(i, port, srcIp) {
  const steps = [];
  const ok = (label, pass, hint) => { steps.push({ label, ok: pass, hint: pass ? undefined : hint }); return pass; };
  const subnet = V().subnets.find((s) => s.SubnetId === i.SubnetId);
  let pass = ok('인스턴스 상태가 running', i.State.Name === 'running', `현재 상태: ${i.State.Name}`);
  pass = ok('퍼블릭 IP 주소 존재', !!i.PublicIpAddress, '퍼블릭 IP가 없습니다. 서브넷의 퍼블릭 IP 자동 할당을 켜거나 탄력적 IP를 연결하세요.') && pass;
  const igw = V().igws.find((g) => g.Attachments.some((a) => a.VpcId === i.VpcId));
  pass = ok('VPC에 인터넷 게이트웨이 연결', !!igw, 'VPC에 연결된 인터넷 게이트웨이가 없습니다.') && pass;
  const rtb = subnet && vpc.routeTableForSubnet(subnet);
  const hasRoute = !!(rtb && igw && rtb.Routes.some((r) => r.DestinationCidrBlock === '0.0.0.0/0' && r.GatewayId === igw.InternetGatewayId));
  pass = ok('서브넷 라우팅 테이블에 0.0.0.0/0 → IGW 경로', hasRoute, `라우팅 테이블 ${rtb ? rtb.RouteTableId : '(없음)'} 에 0.0.0.0/0 → igw 경로가 없습니다.`) && pass;
  const sgs = i.SecurityGroups.map((g) => S().securityGroups.find((x) => x.GroupId === g.GroupId)).filter(Boolean);
  const sgAllows = sgs.some((g) => g.IpPermissions.some((perm) => (perm.IpProtocol === '-1' || (perm.IpProtocol === 'tcp' && perm.FromPort <= port && perm.ToPort >= port)) && perm.IpRanges.some((r) => r.CidrIp === '0.0.0.0/0' || cidrHas(r.CidrIp, srcIp))));
  pass = ok(`보안 그룹 인바운드 규칙이 TCP ${port} 허용`, sgAllows, `보안 그룹(${sgs.map((g) => g.GroupId).join(', ')})에 ${srcIp} 로부터의 TCP ${port} 인바운드 규칙이 없습니다.`) && pass;
  return { InstanceId: i.InstanceId, Port: port, Reachable: pass, Steps: steps };
}
function cidrHas(cidr, ip) { try { const c = parseCidr(cidr); const { ipToInt } = require('../util'); return ((ipToInt(ip) & c.mask) >>> 0) === c.base; } catch (e) { return false; } }

function consoleOutput(i) {
  const img = S().images.find((x) => x.ImageId === i.ImageId) || {};
  const lines = [`[    0.000000] Linux version 6.1.0 (${img.Name || 'ami'})`, `[    0.512345] Booting instance ${i.InstanceId} (${i.InstanceType})`, `[    1.203948] eth0: private ip ${i.PrivateIpAddress}`];
  if (i.PublicIpAddress) lines.push(`[    1.300000] eth0: public ip ${i.PublicIpAddress}`);
  lines.push('cloud-init[1234]: Cloud-init v. 22.2 running \'init\'');
  if (i.UserData) { lines.push('cloud-init[1234]: running user-data script:'); lines.push(...i.UserData.split('\n').map((l) => '  + ' + l)); lines.push('cloud-init[1234]: user-data finished'); }
  lines.push(`ec2: #############################################################`, `ec2: -----BEGIN SSH HOST KEY FINGERPRINTS-----`, `ec2: 256 SHA256:${hex(43)} root@ip-${i.PrivateIpAddress.replace(/\./g, '-')} (ED25519)`, `ec2: -----END SSH HOST KEY FINGERPRINTS-----`, `ec2: #############################################################`, `${i.PrivateDnsName} login: `);
  return lines.join('\n');
}

function shell(i, cmd) {
  if (i.State.Name !== 'running') return `ssh: connect to host ${i.PublicIpAddress || i.PrivateIpAddress} port 22: Connection refused (인스턴스 상태: ${i.State.Name})`;
  const img = S().images.find((x) => x.ImageId === i.ImageId) || {};
  const user = img.User || 'ec2-user';
  const host = `ip-${i.PrivateIpAddress.replace(/\./g, '-')}`;
  const c = cmd.trim();
  const meta = {
    'instance-id': i.InstanceId, 'instance-type': i.InstanceType, 'local-ipv4': i.PrivateIpAddress, 'public-ipv4': i.PublicIpAddress || '', 'ami-id': i.ImageId, 'hostname': i.PrivateDnsName, 'placement/availability-zone': i.Placement.AvailabilityZone, 'placement/region': i.Region, 'security-groups': i.SecurityGroups.map((g) => g.GroupName).join('\n'), 'iam/info': i.IamInstanceProfile ? JSON.stringify({ InstanceProfileArn: i.IamInstanceProfile.Arn }, null, 2) : '404 - Not Found',
  };
  if (c === '' ) return '';
  if (c === 'whoami') return user;
  if (c === 'hostname') return host;
  if (c === 'pwd') return `/home/${user}`;
  if (c === 'uname -a') return `Linux ${host} 6.1.0 #1 SMP x86_64 GNU/Linux`;
  if (c === 'id') return `uid=1000(${user}) gid=1000(${user}) groups=1000(${user}),4(adm),10(wheel)`;
  if (c === 'date') return new Date().toString();
  if (c === 'uptime') return ` ${new Date().toTimeString().slice(0, 8)} up ${Math.max(1, Math.round((Date.now() - Date.parse(i.LaunchTime)) / 60000))} min,  1 user,  load average: 0.00, 0.01, 0.05`;
  if (c === 'ls' || c === 'ls -la' || c === 'ls -l') return 'user-data.sh\nREADME.txt';
  if (c === 'cat README.txt') return '이것은 시뮬레이션된 EC2 셸입니다. 지원 명령: whoami, hostname, pwd, uname -a, id, date, uptime, ls, cat /etc/os-release, cat /var/log/cloud-init-output.log, curl http://169.254.169.254/latest/meta-data/<key>, df -h, free -m, nproc, ip addr, sudo yum/apt install <pkg>, exit';
  if (c === 'cat /etc/os-release') return `NAME="${img.Description || 'Linux'}"\nPRETTY_NAME="${img.Description || 'Linux'}"\nID=${/ubuntu/i.test(img.Name) ? 'ubuntu' : 'amzn'}`;
  if (c === 'cat /var/log/cloud-init-output.log' || c === 'cat user-data.sh') return i.UserData ? i.UserData : '(user-data 없음)';
  if (c === 'nproc') return String((INSTANCE_TYPES.find((t) => t.InstanceType === i.InstanceType) || { VCpu: 1 }).VCpu);
  if (c === 'free -m') { const mem = (INSTANCE_TYPES.find((t) => t.InstanceType === i.InstanceType) || { MemoryMiB: 1024 }).MemoryMiB; return `              total        used        free\nMem:          ${mem}         ${Math.round(mem * 0.2)}        ${Math.round(mem * 0.8)}`; }
  if (c === 'df -h') { const v = S().volumes.find((x) => x.Attachments.some((a) => a.InstanceId === i.InstanceId && a.Device === '/dev/xvda')); return `Filesystem      Size  Used Avail Use% Mounted on\n/dev/xvda1      ${v ? v.Size : 8}.0G  1.6G  ${v ? v.Size - 2 : 6}.4G  21% /`; }
  if (c === 'ip addr' || c === 'ifconfig') return `eth0: inet ${i.PrivateIpAddress}/${(V().subnets.find((s) => s.SubnetId === i.SubnetId) || { CidrBlock: '/24' }).CidrBlock.split('/')[1]} brd 255.255.255.255 scope global`;
  if (c === 'exit' || c === 'logout') return 'logout\nConnection closed.';
  let m = /^curl\s+(?:-s\s+)?https?:\/\/169\.254\.169\.254\/latest\/meta-data\/?(.*)$/.exec(c);
  if (m) { const key = m[1].replace(/\/$/, ''); if (!key) return Object.keys(meta).join('\n'); return meta[key] !== undefined ? meta[key] : '404 - Not Found'; }
  m = /^curl\s+(?:-s\s+)?https?:\/\/169\.254\.169\.254\/latest\/user-data\/?$/.exec(c);
  if (m) return i.UserData || '404 - Not Found';
  m = /^curl\s+(?:-sI?\s+)?(https?:\/\/)?([\w.-]+)(:\d+)?(\/\S*)?$/.exec(c);
  if (m) {
    const target = S().instances.find((x) => x.PrivateIpAddress === m[2] || x.PublicIpAddress === m[2]);
    const port = m[3] ? Number(m[3].slice(1)) : 80;
    if (!target) return /google|amazon|example/.test(m[2]) ? `<!doctype html><html><head><title>Example Domain</title></head></html>` : `curl: (6) Could not resolve host: ${m[2]}`;
    const r = reachability(target, port, i.PrivateIpAddress);
    if (!r.Reachable) return `curl: (28) Failed to connect to ${m[2]} port ${port}: Connection timed out`;
    return /nginx|httpd|apache/.test(target.UserData || '') ? `<html><body><h1>Hello from ${target.InstanceId}</h1></body></html>` : `curl: (7) Failed to connect to ${m[2]} port ${port}: Connection refused (웹 서버가 설치되지 않음. user-data 에 httpd/nginx 설치 스크립트를 넣어보세요)`;
  }
  m = /^sudo\s+(yum|dnf|apt|apt-get)\s+(install|update|upgrade)\s*(-y)?\s*(.*)$/.exec(c);
  if (m) { if (m[2] !== 'install') return 'Last metadata expiration check: 0:00:01 ago.\nDependencies resolved.\nNothing to do.\nComplete!'; i.UserData = (i.UserData || '') + `\n# installed: ${m[4]}`; return `Installing ${m[4]}...\nComplete!`; }
  m = /^sudo\s+systemctl\s+(start|enable|status|stop)\s+(\S+)/.exec(c);
  if (m) return m[1] === 'status' ? `● ${m[2]}.service - ${m[2]}\n   Active: active (running)` : '';
  m = /^echo\s+(.*)$/.exec(c);
  if (m) return m[1].replace(/^["']|["']$/g, '');
  if (/^(sudo\s+)?(vi|vim|nano|top|htop)\b/.test(c)) return '시뮬레이터에서는 대화형 프로그램을 지원하지 않습니다.';
  return `-bash: ${c.split(/\s/)[0]}: command not found`;
}

module.exports = { actions, seed, INSTANCE_TYPES, IMAGES, findInstance, reachability, shell };
